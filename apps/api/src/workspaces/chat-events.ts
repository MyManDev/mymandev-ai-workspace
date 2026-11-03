import { type Database, postChatMessage } from "@mymandev/database";
import {
  type ChatMessage,
  type ChatMessageCreatedEvent,
  type EventId,
  type EventRefusalCode,
  newId,
  PROTOCOL_VERSION,
  type UserId,
} from "@mymandev/protocol";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { VerifiedEventOf } from "../device-events.ts";
import {
  type AuthenticatedConnectionContext,
  type ConnectionRegistry,
  type EventRejection,
  lockConnection,
} from "../gateway.ts";

/**
 * The chat send limit of an account (#27; values settled with the API part
 * under the Project Manager's rule of 2026-11-02): at most `burst.max`
 * messages in any `burst.windowMs`, and at most `window.max` messages in a
 * window of `window.windowMs` that starts with the account's first message
 * after the previous window ended. Every device of the account counts
 * together, and so does every workspace. A `chat.message.send` above it gets
 * `event.refused` with `rate_limited`, and the connection stays open.
 *
 * - The burst bounds what one account can queue for the other members at
 *   once. The largest `chat.message.created` is about 64,600 bytes, just
 *   under `MAX_FRAME_BYTES` (64 KiB), and a connection with more than
 *   `MAX_BUFFERED_BYTES` (1 MiB) waiting closes with `backpressure`. 15 of
 *   the largest messages are about 969,000 bytes, so one account alone can
 *   never push a subscriber that reads nothing for 10 seconds over the
 *   limit, with about 79,000 bytes left for presence and the messages of
 *   others; 16 would leave about 15,000 bytes. A person who types
 *   short messages sends far fewer than 15 in 10 seconds.
 * - The window bounds the sustained rate and the storage: 600 an hour is a
 *   message every 6 seconds for a whole hour, beyond a person who chats, and
 *   at most about 39 MB of message events an hour for each subscriber, about
 *   11 KB a second. A pasted log split into many messages still fits.
 *
 * The limit lives in the memory of one API instance, as the request limits
 * do (ADR 0014 assumes one instance), and starts empty after a restart.
 */
export const CHAT_SEND_LIMIT = Object.freeze({
  burst: Object.freeze({ max: 15, windowMs: 10_000 }),
  window: Object.freeze({ max: 600, windowMs: 60 * 60_000 }),
});

/** How often the send limit forgets the accounts whose counts ended. */
export const CHAT_SEND_LIMIT_SWEEP_MS = 60_000;

type SendCount = {
  /** The times of the accepted sends of the last `burst.windowMs`, oldest first. */
  readonly recent: number[];
  /** When the account's current window started. */
  windowStart: number;
  /** The accepted sends of the current window. */
  sent: number;
};

/**
 * Counts the accepted chat sends of each account (`CHAT_SEND_LIMIT`). The
 * burst slides, so no 10 seconds ever hold more than `burst.max` sends; the
 * longer window is fixed, which needs one counter per account. A send that
 * the limit refuses is not counted. It keeps at most `burst.max` times and a
 * counter per account that sent within the window.
 */
export class ChatSendLimit {
  readonly #accounts = new Map<UserId, SendCount>();
  readonly #now: () => number;
  readonly #limit: typeof CHAT_SEND_LIMIT;

  constructor(now: () => number, limit = CHAT_SEND_LIMIT) {
    this.#now = now;
    this.#limit = limit;
  }

  /** Accounts that the limit holds a count for. */
  get size(): number {
    return this.#accounts.size;
  }

  /** Counts one send of the account and returns true, or returns false when it is over the limit. */
  take(userId: UserId): boolean {
    const now = this.#now();
    const { burst, window } = this.#limit;
    let count = this.#accounts.get(userId);
    if (count === undefined || now - count.windowStart >= window.windowMs) {
      count = { recent: count?.recent ?? [], windowStart: now, sent: 0 };
      this.#accounts.set(userId, count);
    }
    const { recent } = count;
    while (recent.length > 0 && now - (recent[0] ?? now) >= burst.windowMs) {
      recent.shift();
    }
    if (recent.length >= burst.max || count.sent >= window.max) {
      return false;
    }
    recent.push(now);
    count.sent += 1;
    return true;
  }

  /** Forgets the accounts whose window ended. */
  sweep(): void {
    const now = this.#now();
    for (const [userId, count] of this.#accounts) {
      if (now - count.windowStart >= this.#limit.window.windowMs) {
        this.#accounts.delete(userId);
      }
    }
  }
}

/**
 * The `chat.message.created` of a stored message: from the server, with a
 * `system` actor and `deviceId: null`, so that other members never see the
 * sending device, and with `causationId` set to the ID of the
 * `chat.message.send` that stored it. It occurred when the message was
 * stored, also when it is sent again for a resent `chat.message.send`.
 */
export function chatMessageCreatedEvent(
  send: VerifiedEventOf<"chat.message.send">,
  message: ChatMessage,
): ChatMessageCreatedEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: newId<EventId>(),
    occurredAt: message.createdAt,
    workspaceId: send.workspaceId,
    actor: { kind: "system" },
    deviceId: null,
    causationId: send.id,
    type: "chat.message.created",
    payload: { message },
  };
}

export type ChatSendOptions = Readonly<{
  database: Database;
  now: () => number;
  connections: ConnectionRegistry;
  log: FastifyBaseLogger;
}>;

/**
 * The handler of `chat.message.send` (#27, the Project Manager's decisions
 * of 2026-11-02), after identity binding:
 *
 * 1. The account's send limit (`CHAT_SEND_LIMIT`): above it, `event.refused`
 *    with `rate_limited`, and nothing is read or stored.
 * 2. One transaction locks the account and the device (`lockConnection`) and
 *    posts the message with `postChatMessage` in the event's workspace,
 *    which identity binding verified: the project must be a project of that
 *    workspace before anything is stored (ADR 0006, reference binding).
 * 3. A new message goes as `chat.message.created` to the workspace's
 *    subscribed connections and to the sending connection, also when it is
 *    not subscribed. A resent event ID gets the stored message in a new
 *    `chat.message.created`, sent only to the sending connection.
 * 4. `not_found` (a project that the workspace does not have, also one of
 *    another workspace) and `conflict` (an archived project or workspace, or
 *    the device's event ID stored in another workspace) get `event.refused`,
 *    sent only to the sending connection, which stays open.
 * 5. An account that stopped being an active member, and a device or an
 *    account that may no longer act, since identity binding, close the
 *    connection as identity binding does.
 *
 * The send limit is one `ChatSendLimit` per call, swept every minute until
 * `app` closes.
 */
export function chatSendHandler(
  app: FastifyInstance,
  options: ChatSendOptions,
): (
  event: VerifiedEventOf<"chat.message.send">,
  context: AuthenticatedConnectionContext,
) => Promise<EventRejection | undefined> {
  const { database, connections, log } = options;
  const accounts = new ChatSendLimit(options.now);
  const sweeper = setInterval(() => {
    accounts.sweep();
  }, CHAT_SEND_LIMIT_SWEEP_MS);
  sweeper.unref();
  app.addHook("onClose", async () => {
    clearInterval(sweeper);
  });

  return async (event, context) => {
    const refuse = (code: EventRefusalCode) => {
      log.debug(
        { eventId: event.id, connectionId: context.connectionId, code },
        "event refused",
      );
      connections.sendFrame(context, {
        protocolVersion: PROTOCOL_VERSION,
        type: "event.refused",
        eventId: event.id,
        code,
      });
    };
    const { userId, deviceId } = context.identity;
    if (!accounts.take(userId)) {
      refuse("rate_limited");
      return undefined;
    }
    const now = new Date(options.now());
    const result = await database.transaction(async (tx) => {
      const refusal = await lockConnection(tx, context);
      if (refusal !== null) {
        return { posted: false, refusal } as const;
      }
      return postChatMessage(tx, {
        actor: { workspaceId: event.workspaceId, userId, deviceId },
        projectId: event.payload.projectId,
        eventId: event.id,
        body: event.payload.body,
        now,
      });
    });
    if (!result.posted) {
      switch (result.refusal) {
        case "not_found":
        case "conflict":
          refuse(result.refusal);
          return undefined;
        case "not_member":
          return { rejected: "not_a_member" };
        default:
          return { rejected: result.refusal };
      }
    }
    const created = chatMessageCreatedEvent(event, result.message);
    if (result.duplicate) {
      connections.sendEvent(context, created);
    } else {
      const sent = connections.sendToWorkspace(created, context);
      log.debug(
        { eventId: event.id, connectionId: context.connectionId, sent },
        "chat message posted",
      );
    }
    return undefined;
  };
}
