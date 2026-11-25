import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

// One PostgreSQL session that listens for notifications (#341; ADR 0014,
// update of 2026-11-25). It is a dedicated connection outside the pool: a
// pooled connection goes back to the pool after each query, and a
// transaction-mode pooler would hand the `LISTEN` to whichever server
// session runs it, so the listener never connects through one. The API
// holds one per instance (`apps/api`, `ErasureListener`), which reconnects
// after a lost session; the tests use PGlite's `listen` in its place
// (`src/testing.ts`).

/** What a listening session reports. */
export type NotificationHandlers = Readonly<{
  /** Each notification's payload on the channel, in the order of delivery. */
  onPayload: (payload: string) => void;
  /** Once, when the session ends without `close`, for example when the server ends it. */
  onLost: () => void;
}>;

/** A connected session that can listen on one channel. */
export type NotificationSession = Readonly<{
  /**
   * Starts listening on `channel`, a lowercase SQL identifier; resolves once
   * the server listens. A session that ended before rejects.
   */
  listen: (channel: string, handlers: NotificationHandlers) => Promise<void>;
  /** Ends the session; it never rejects, and `onLost` is not called. */
  close: () => Promise<void>;
}>;

/** Opens a new session; rejects when it cannot connect. */
export type NotificationSessions = () => Promise<NotificationSession>;

/** The `application_name` of a listener session, so that an operator can tell it from the pool's. */
export const LISTENER_APPLICATION_NAME = "mymandev_listener";

/** How long `close` waits for the server's goodbye before it gives up. */
const CLOSE_TIMEOUT_MS = 5_000;

const CHANNEL_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;

/** Throws unless `channel` can stand unquoted in `LISTEN`. */
export function checkChannel(channel: string): void {
  if (!CHANNEL_NAME.test(channel)) {
    throw new Error("A notification channel is a lowercase SQL identifier");
  }
}

/**
 * Sessions to the PostgreSQL server of `connectionString` (checked with
 * `checkDatabaseUrl`), each one node-postgres client of its own, outside any
 * pool, with a connection timeout of 5 seconds and TCP keepalive, so that a
 * connection that died without a close is found. A failure of the session
 * calls `onLost` once and is never thrown: the error's message, which can
 * name the host, is dropped.
 */
export function pgNotificationSessions(
  connectionString: string,
): NotificationSessions {
  return async () => {
    const client = new pg.Client({
      connectionString,
      connectionTimeoutMillis: 5_000,
      keepAlive: true,
      application_name: LISTENER_APPLICATION_NAME,
    });
    let ended = false;
    let handlers: NotificationHandlers | null = null;
    const lost = () => {
      if (!ended) {
        ended = true;
        handlers?.onLost();
      }
    };
    // Without a listener, Node throws the client's "error" event.
    client.on("error", lost);
    client.on("end", lost);
    const close = async () => {
      ended = true;
      await Promise.race([
        client.end().catch(() => undefined),
        delay(CLOSE_TIMEOUT_MS, undefined, { ref: false }),
      ]);
    };
    try {
      await client.connect();
    } catch (error) {
      await close();
      throw error;
    }
    return {
      listen: async (channel, given) => {
        checkChannel(channel);
        if (ended) {
          throw new Error("The session ended");
        }
        client.on("notification", (message) => {
          if (message.channel === channel && message.payload !== undefined) {
            given.onPayload(message.payload);
          }
        });
        handlers = given;
        await client.query(`listen ${channel}`);
      },
      close,
    };
  };
}
