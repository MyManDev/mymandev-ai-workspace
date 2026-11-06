import { type Database, recordRunTransition } from "@mymandev/database";
import {
  type EventRefusalCode,
  PROTOCOL_VERSION,
  runReasonAllowed,
} from "@mymandev/protocol";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { VerifiedEventOf } from "../device-events.ts";
import {
  type AuthenticatedConnectionContext,
  type ConnectionRegistry,
  type EventRejection,
  lockConnection,
} from "../gateway.ts";
import { type SendLimitValues, sweptSendLimit } from "./send-limit.ts";

/**
 * The run transition limit of an account (#28; settled with the API part
 * under the Project Manager's rule of 2026-11-02): at most `burst.max`
 * `agent.run.state_changed` in any `burst.windowMs`, and at most
 * `window.max` in an hour, counted as `CHAT_SEND_LIMIT` counts, but with
 * its own values and its own counts, so that an agent that reports
 * transitions never takes a person's room to chat, and chat never holds up
 * an agent. Every device of the account counts together, and so does every
 * workspace. A transition above it gets `event.refused` with
 * `rate_limited`, and the connection stays open.
 *
 * - The burst bounds what one account's agents can queue for a subscriber
 *   at once. The largest relayed `agent.run.state_changed`, with a reason of
 *   500 code points of 4 bytes each and every optional field, is about
 *   2,600 bytes, so 30 are about 78,500 bytes: under the about 79,000 bytes
 *   that 15 of the largest chat messages leave below `MAX_BUFFERED_BYTES`
 *   (1 MiB). One account's chat burst and transition burst, as the limits
 *   count them, fit together under the limit. The limits count an event
 *   when it arrives, before its transaction, and the relay follows the
 *   commit, so when transactions wait for locks, the relays of two bursts
 *   can reach a subscriber close together; a subscriber that reads nothing
 *   then closes with `backpressure` and reloads, the accepted worst case,
 *   as for several accounts together. A run moves a few times in its
 *   life, so 30 in 10 seconds lets the development switch of #28 walk
 *   several runs at once, and lets real agents report every step of their
 *   runs.
 * - The window bounds the sustained rate and the storage: 1,800 an hour is
 *   a transition every 2 seconds for a whole hour, at most about 4.7 MB of
 *   run events an hour for each subscriber, and 1,800 rows of the
 *   transition log.
 */
export const RUN_TRANSITION_LIMIT: SendLimitValues = Object.freeze({
  burst: Object.freeze({ max: 30, windowMs: 10_000 }),
  window: Object.freeze({ max: 1_800, windowMs: 60 * 60_000 }),
});

export type RunTransitionOptions = Readonly<{
  database: Database;
  now: () => number;
  connections: ConnectionRegistry;
  log: FastifyBaseLogger;
}>;

/**
 * The handler of `agent.run.state_changed` from a device (#28, the Project
 * Manager's decisions of 2026-11-02), after identity binding:
 *
 * 1. The account's run transition limit (`RUN_TRANSITION_LIMIT`): above it,
 *    `event.refused` with `rate_limited`, and nothing is read or stored.
 * 2. A `reason` that only the server gives, a code of `RUN_CANCEL_REASONS`
 *    (`runReasonAllowed`, #201): `event.refused` with `conflict`, and
 *    nothing is read or stored. Like the limit, it comes before the agent
 *    and the run are checked, so it also answers an event ID that the device
 *    already recorded, and an agent that another device hosts or another
 *    account owns, without the audit of step 6. The decoders leave this rule
 *    to the server, so that the connection stays open.
 * 3. One transaction locks the account and the device (`lockConnection`) and
 *    records the transition with `recordRunTransition` in the event's
 *    workspace, which identity binding verified: the agent must be an agent
 *    of that workspace, hosted by the sending device and owned by its
 *    account, and the run must be the agent's, before anything is stored
 *    (ADR 0006, reference binding).
 * 4. A new transition is relayed as the database returns it: the same event
 *    ID, `occurredAt`, agent actor, `correlationId`, `causationId`, and
 *    payload, with `deviceId: null`. It goes to the workspace's subscribed
 *    connections and to the sending connection, also when it is not
 *    subscribed, as its acknowledgement. A transition whose device and event
 *    ID are already recorded gets the stored relayed event, sent only to the
 *    sending connection, unless step 1 or 2 refused it.
 * 5. `not_found` (an agent or a run that the workspace does not have, a run
 *    of another agent, a repository that is not the run's) and `conflict` (a
 *    disabled agent, an archived project or workspace, a run that is no
 *    longer in `previousState`, or an event ID that the device used in
 *    another workspace) get `event.refused`, sent only to the sending
 *    connection, which stays open.
 * 6. An agent of the workspace that another device hosts or another account
 *    owns is `identity_mismatch`, unless step 1 or 2 refused the transition:
 *    the gateway audits it and closes the connection, as for a mismatch that
 *    identity binding finds. An account
 *    that stopped being an active member, and a device or an account that
 *    may no longer act, since identity binding, close the connection as
 *    identity binding does.
 *
 * The gateway awaits the handler before it handles the connection's next
 * message, so one connection's transitions are recorded and relayed in the
 * order they arrived, as `recordRunTransition` requires.
 */
export function runTransitionHandler(
  app: FastifyInstance,
  options: RunTransitionOptions,
): (
  event: VerifiedEventOf<"agent.run.state_changed">,
  context: AuthenticatedConnectionContext,
) => Promise<EventRejection | undefined> {
  const { database, connections, log } = options;
  const accounts = sweptSendLimit(app, options.now, RUN_TRANSITION_LIMIT);

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
    const { payload } = event;
    // `decodeClientMessage` refuses a run's creation from a device.
    if (payload.previousState === null) {
      throw new Error("A device sent a run transition without previousState");
    }
    const { previousState } = payload;
    const { userId, deviceId } = context.identity;
    if (!accounts.take(userId)) {
      refuse("rate_limited");
      return undefined;
    }
    if (!runReasonAllowed(event)) {
      refuse("conflict");
      return undefined;
    }
    const now = new Date(options.now());
    const result = await database.transaction(async (tx) => {
      const refusal = await lockConnection(tx, context);
      if (refusal !== null) {
        return { recorded: false, refusal } as const;
      }
      return recordRunTransition(tx, {
        actor: { workspaceId: event.workspaceId, userId, deviceId },
        agentId: payload.agentId,
        runId: payload.runId,
        repositoryId: payload.repositoryId,
        eventId: event.id,
        previousState,
        state: payload.state,
        reason: payload.reason,
        occurredAt: new Date(event.occurredAt),
        correlationId: event.correlationId,
        causationId: event.causationId,
        now,
      });
    });
    if (!result.recorded) {
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
    if (result.duplicate) {
      connections.sendEvent(context, result.event);
    } else {
      const sent = connections.sendToWorkspace(result.event, context);
      log.debug(
        { eventId: event.id, connectionId: context.connectionId, sent },
        "run transition relayed",
      );
    }
    return undefined;
  };
}
