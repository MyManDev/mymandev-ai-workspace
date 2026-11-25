import {
  ERASURE_NOTIFICATION_CHANNEL,
  type NotificationSession,
  type NotificationSessions,
} from "@mymandev/database";
import type { FastifyBaseLogger } from "fastify";
import { setTimeout as delay } from "node:timers/promises";

/** The wait before the first new attempt after a failed or lost session. */
export const ERASURE_LISTENER_INITIAL_BACKOFF_MS = 1_000;

/** The longest wait between two attempts; the wait doubles up to it. */
export const ERASURE_LISTENER_MAX_BACKOFF_MS = 30_000;

export type ErasureListenerOptions = Readonly<{
  /** Opens the dedicated session (`pgNotificationSessions` in production). */
  sessions: NotificationSessions;
  /** Each notification's payload, in the order of delivery. */
  onPayload: (payload: string) => void;
  log: FastifyBaseLogger;
  /** Default: `ERASURE_LISTENER_INITIAL_BACKOFF_MS`. */
  initialBackoffMs?: number;
  /** Default: `ERASURE_LISTENER_MAX_BACKOFF_MS`. */
  maxBackoffMs?: number;
  /**
   * Waits `ms` or until `signal` aborts, then rejects. Default: a timer that
   * does not keep the process alive. Tests pass one that records the waits.
   */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}>;

const defaultWait = (ms: number, signal: AbortSignal) =>
  delay(ms, undefined, { signal, ref: false });

/** The error's type for a log line, never its message, which can name the host. */
function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * The API instance's one listener for an operator's account erasures (#341;
 * ADR 0014, update of 2026-11-25): it holds one dedicated session
 * (`NotificationSession`) that listens on `ERASURE_NOTIFICATION_CHANNEL` and
 * hands each payload to `onPayload`. A session that cannot connect or
 * listen, or that is lost later, is closed and opened again after a wait
 * that starts at `initialBackoffMs` and doubles up to `maxBackoffMs`; a
 * session that listens starts the wait again at `initialBackoffMs`.
 * Notifications sent while no session listens are lost, which costs no more
 * than before the listener: the sweep closes the erased account's
 * connections within 60 seconds, and the other connections see the rest at
 * their next `workspace.subscribed`. A failure of `onPayload` is logged and
 * the next payload still goes to it. It logs no ID, URL, or error message:
 * only that it listens, that it lost its session or failed with an error's
 * type, and how long it waits.
 */
export class ErasureListener {
  readonly #options: ErasureListenerOptions;
  readonly #abort = new AbortController();
  #closed = false;
  #session: NotificationSession | null = null;
  /** Ends the wait for the current session's loss, at a loss or at `close`. */
  #wake: (() => void) | null = null;
  #running: Promise<void> | null = null;

  constructor(options: ErasureListenerOptions) {
    this.#options = options;
  }

  /**
   * Starts listening, and keeps listening until `close`. Resolves when the
   * first attempt has ended, listening or not, so that a server that starts
   * while the database is unreachable starts anyway; it never rejects.
   */
  start(): Promise<void> {
    if (this.#running !== null) {
      throw new Error("The erasure listener is already started");
    }
    return new Promise((resolve) => {
      this.#running = this.#run(resolve);
    });
  }

  /** Stops listening and closes the session; the listener does not start again. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#abort.abort();
    this.#wake?.();
    const session = this.#session;
    this.#session = null;
    await session?.close();
    await this.#running;
  }

  #deliver(payload: string): void {
    if (this.#closed) {
      return;
    }
    try {
      this.#options.onPayload(payload);
    } catch (error) {
      this.#options.log.error(
        { errorType: errorTypeOf(error) },
        "erasure notification failed",
      );
    }
  }

  async #run(firstAttemptEnded: () => void): Promise<void> {
    const { log } = this.#options;
    const initial =
      this.#options.initialBackoffMs ?? ERASURE_LISTENER_INITIAL_BACKOFF_MS;
    const max = this.#options.maxBackoffMs ?? ERASURE_LISTENER_MAX_BACKOFF_MS;
    const wait = this.#options.wait ?? defaultWait;
    let backoff = initial;
    try {
      while (!this.#closed) {
        try {
          const session = await this.#options.sessions();
          if (this.#closed) {
            await session.close();
            return;
          }
          this.#session = session;
          const lost = new Promise<void>((resolve) => {
            this.#wake = resolve;
          });
          await session.listen(ERASURE_NOTIFICATION_CHANNEL, {
            onPayload: (payload) => this.#deliver(payload),
            onLost: () => this.#wake?.(),
          });
          if (this.#closed) {
            return;
          }
          log.info("erasure listener listening");
          backoff = initial;
          firstAttemptEnded();
          await lost;
          if (this.#closed) {
            return;
          }
          log.warn(
            { retryInMs: backoff },
            "erasure listener lost its database session",
          );
        } catch (error) {
          if (this.#closed) {
            return;
          }
          log.warn(
            { errorType: errorTypeOf(error), retryInMs: backoff },
            "erasure listener could not listen",
          );
        }
        firstAttemptEnded();
        this.#wake = null;
        const failed = this.#session;
        this.#session = null;
        await failed?.close();
        try {
          await wait(backoff, this.#abort.signal);
        } catch {
          return;
        }
        backoff = Math.min(backoff * 2, max);
      }
    } finally {
      firstAttemptEnded();
    }
  }
}
