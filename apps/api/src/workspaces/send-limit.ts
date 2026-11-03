import type { UserId } from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";

/**
 * The values of an account's send limit over the connection: at most
 * `burst.max` accepted events in any `burst.windowMs`, and at most
 * `window.max` in a window of `window.windowMs` that starts with the
 * account's first accepted event after the previous window ended. The chat
 * sends (`CHAT_SEND_LIMIT`, #27) and the run transitions
 * (`RUN_TRANSITION_LIMIT`, #28) each have their own values and their own
 * counts.
 */
export type SendLimitValues = Readonly<{
  burst: Readonly<{ max: number; windowMs: number }>;
  window: Readonly<{ max: number; windowMs: number }>;
}>;

/** How often a send limit forgets the accounts whose counts ended. */
export const SEND_LIMIT_SWEEP_MS = 60_000;

type SendCount = {
  /** The times of the accepted events of the last `burst.windowMs`, oldest first. */
  readonly recent: number[];
  /** When the account's current window started. */
  windowStart: number;
  /** The accepted events of the current window. */
  sent: number;
};

/**
 * Counts the accepted events of each account under one `SendLimitValues`.
 * Every device of the account counts together, and so does every workspace.
 * The burst slides, so no `burst.windowMs` ever holds more than `burst.max`
 * events; the longer window is fixed, which needs one counter per account.
 * An event that the limit refuses is not counted. It keeps at most
 * `burst.max` times and a counter per account that sent within the window.
 *
 * The counts live in the memory of one API instance, as the request limits
 * do (ADR 0014 assumes one instance), and start empty after a restart.
 */
export class AccountSendLimit {
  readonly #accounts = new Map<UserId, SendCount>();
  readonly #now: () => number;
  readonly #limit: SendLimitValues;

  constructor(now: () => number, limit: SendLimitValues) {
    this.#now = now;
    this.#limit = limit;
  }

  /** Accounts that the limit holds a count for. */
  get size(): number {
    return this.#accounts.size;
  }

  /** Counts one event of the account and returns true, or returns false when it is over the limit. */
  take(userId: UserId): boolean {
    const now = this.#now();
    const { burst, window } = this.#limit;
    const count = this.#accounts.get(userId);
    if (count === undefined) {
      this.#accounts.set(userId, { recent: [now], windowStart: now, sent: 1 });
      return true;
    }
    const { recent } = count;
    while (recent.length > 0 && now - (recent[0] ?? now) >= burst.windowMs) {
      recent.shift();
    }
    // The window ended: the next accepted event starts a new one. An event
    // that the burst refuses starts none.
    const ended = now - count.windowStart >= window.windowMs;
    if (recent.length >= burst.max || (!ended && count.sent >= window.max)) {
      return false;
    }
    if (ended) {
      count.windowStart = now;
      count.sent = 0;
    }
    recent.push(now);
    count.sent += 1;
    return true;
  }

  /**
   * Forgets the accounts whose window ended and whose last accepted event
   * left the burst.
   */
  sweep(): void {
    const now = this.#now();
    const { burst, window } = this.#limit;
    for (const [userId, count] of this.#accounts) {
      const last = count.recent.at(-1);
      if (
        now - count.windowStart >= window.windowMs &&
        (last === undefined || now - last >= burst.windowMs)
      ) {
        this.#accounts.delete(userId);
      }
    }
  }
}

/**
 * A new `AccountSendLimit`, swept every `SEND_LIMIT_SWEEP_MS` until `app`
 * closes.
 */
export function sweptSendLimit(
  app: FastifyInstance,
  now: () => number,
  limit: SendLimitValues,
): AccountSendLimit {
  const accounts = new AccountSendLimit(now, limit);
  const sweeper = setInterval(() => {
    accounts.sweep();
  }, SEND_LIMIT_SWEEP_MS);
  sweeper.unref();
  app.addHook("onClose", async () => {
    clearInterval(sweeper);
  });
  return accounts;
}
