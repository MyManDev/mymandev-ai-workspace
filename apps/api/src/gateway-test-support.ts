// Test support for the WebSocket gateway: a client on injectWS that answers
// the server's challenge with the device key, as the desktop does, and a
// database whose next query can wait for a change.
import type { Database } from "@mymandev/database";
import {
  type AuthChallengeFrame,
  decodeServerMessage,
  WS_CLOSE_CODES,
} from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import type { Socket } from "node:net";
import type { TestContext } from "node:test";
import type { WebSocket } from "ws";
import { type Key, ORIGIN, signInput } from "./auth/device-test-support.ts";

export type Closed = Readonly<{ code: number; reason: string }>;

/** Waits until the check passes; fails after two seconds. */
export async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
) {
  const deadline = Date.now() + 2_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Lets pending I/O between the test client and the server run. */
export async function settle() {
  for (let round = 0; round < 10; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export type Client = Readonly<{
  ws: WebSocket;
  /** The next message from the server, parsed; rejects when the connection closes first. */
  next: () => Promise<unknown>;
  /** How many messages arrived that `next` has not returned yet. */
  unread: () => number;
  closed: Promise<Closed>;
  send: (frame: unknown) => void;
}>;

/**
 * Opens a WebSocket on the app. The listeners are attached before the
 * connection opens, so the server's first frame is never missed.
 */
export async function connect(
  t: TestContext,
  app: FastifyInstance,
  options: Readonly<{
    headers?: Record<string, string>;
    path?: string;
    /** The remote address that the per-address limit counts; injectWS has none otherwise. */
    remoteAddress?: string;
  }> = {},
): Promise<Client> {
  const messages: unknown[] = [];
  const waiting: Array<{
    resolve: (message: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  const closed = Promise.withResolvers<Closed>();
  let closeResult: Closed | null = null;
  const ws = await app.injectWS(
    options.path ?? "/ws",
    {
      headers: options.headers ?? {},
      ...(options.remoteAddress === undefined
        ? {}
        : { socket: { remoteAddress: options.remoteAddress } as Socket }),
    },
    {
      onInit: (socket) => {
        socket.on("message", (data) => {
          const message: unknown = JSON.parse(String(data));
          const waiter = waiting.shift();
          if (waiter === undefined) {
            messages.push(message);
          } else {
            waiter.resolve(message);
          }
        });
        socket.on("close", (code, reason) => {
          closeResult = { code, reason: reason.toString() };
          closed.resolve(closeResult);
          for (const waiter of waiting.splice(0)) {
            waiter.reject(new Error(`closed with ${code}`));
          }
        });
      },
    },
  );
  t.after(() => ws.terminate());
  return {
    ws,
    next: () => {
      if (messages.length > 0) {
        return Promise.resolve(messages.shift());
      }
      if (closeResult !== null) {
        return Promise.reject(new Error(`closed with ${closeResult.code}`));
      }
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
      });
    },
    unread: () => messages.length,
    closed: closed.promise,
    send: (frame) => {
      ws.send(
        typeof frame === "string" || Buffer.isBuffer(frame)
          ? frame
          : JSON.stringify(frame),
      );
    },
  };
}

/** Reads the server's auth.challenge, checking it with the device's decoder. */
export async function challengeOf(client: Client): Promise<AuthChallengeFrame> {
  const decoded = decodeServerMessage(await client.next());
  assert.ok(
    decoded.ok &&
      decoded.kind === "frame" &&
      decoded.frame.type === "auth.challenge",
    JSON.stringify(decoded),
  );
  return decoded.frame;
}

export type DeviceKey = Readonly<{ deviceId: string; key: Key }>;

/** The `ws` input that the device signs for a challenge. */
export function wsInput(deviceId: string, challenge: AuthChallengeFrame) {
  return {
    purpose: "ws",
    audience: ORIGIN,
    nonce: challenge.nonce,
    deviceId,
    connectionId: challenge.connectionId,
  } as const;
}

export function authResponse(
  deviceId: string,
  signature: string,
): Record<string, unknown> {
  return { protocolVersion: 0, type: "auth.response", deviceId, signature };
}

/** The correctly signed auth.response for a challenge. */
export function signedResponse(
  device: DeviceKey,
  challenge: AuthChallengeFrame,
) {
  return authResponse(
    device.deviceId,
    signInput(device.key, wsInput(device.deviceId, challenge)),
  );
}

/** Answers the challenge as the desktop does and returns auth.ok. */
export async function authenticate(client: Client, device: DeviceKey) {
  const challenge = await challengeOf(client);
  client.send(signedResponse(device, challenge));
  const decoded = decodeServerMessage(await client.next());
  assert.ok(
    decoded.ok && decoded.kind === "frame" && decoded.frame.type === "auth.ok",
    JSON.stringify(decoded),
  );
  return { challenge, ok: decoded.frame };
}

/** Opens a connection and authenticates it. */
export async function connected(
  t: TestContext,
  app: FastifyInstance,
  device: DeviceKey,
) {
  const client = await connect(t, app);
  const { challenge } = await authenticate(client, device);
  return { client, connectionId: challenge.connectionId };
}

/** The next message, which must be a frame that the device's decoder accepts. */
export async function nextFrame(client: Client) {
  const decoded = decodeServerMessage(await client.next());
  assert.ok(decoded.ok && decoded.kind === "frame", JSON.stringify(decoded));
  return decoded.frame;
}

export function closedWith(reason: keyof typeof WS_CLOSE_CODES): Closed {
  return { code: WS_CLOSE_CODES[reason], reason };
}

/** The connections that a route or the sweep closed, as the log reports them. */
export function loggedCloses(logLines: readonly string[]) {
  return logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.msg === "connection closed")
    .map((entry) => ({ connectionId: entry.connectionId, code: entry.code }));
}

type AnyFunction = (...args: unknown[]) => unknown;

/** A query builder whose result waits for `before` first. */
function delayed<T extends object>(
  builder: T,
  before: () => Promise<unknown>,
): T {
  return new Proxy(builder, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      const method = value as AnyFunction;
      if (property === "then") {
        return (onFulfilled?: AnyFunction, onRejected?: AnyFunction) =>
          before().then(
            () => method.call(target, onFulfilled, onRejected),
            onRejected,
          );
      }
      return (...args: unknown[]) => {
        const result = method.apply(target, args);
        return typeof result === "object" && result !== null
          ? delayed(result, before)
          : result;
      };
    },
  });
}

export type QueryKind = "select" | "update";

/**
 * Wraps the test database. After `interceptNext(kind, table, before)`, the
 * next query that starts with `update(table)` or `select(...).from(table)`,
 * as `kind` says, waits for `before` first: a change that commits while the
 * gateway is between two of its steps. `started(kind, table)` counts the
 * queries that started so far, subqueries included.
 */
export function interceptingDatabase(target: Database) {
  let hook: Readonly<{
    kind: QueryKind;
    table: unknown;
    before: () => Promise<unknown>;
  }> | null = null;
  const queries: Array<Readonly<{ kind: QueryKind; table: unknown }>> = [];
  const take = (kind: QueryKind, table: unknown) => {
    queries.push({ kind, table });
    if (hook === null || hook.kind !== kind || hook.table !== table) {
      return null;
    }
    const { before } = hook;
    hook = null;
    return before;
  };
  const wrap = <T extends object>(
    kind: QueryKind,
    query: T,
    table: unknown,
  ): T => {
    const before = take(kind, table);
    return before === null ? query : delayed(query, before);
  };
  const proxy = new Proxy(target, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property, object);
      if (typeof value !== "function") {
        return value;
      }
      const method = value as AnyFunction;
      if (property === "update") {
        return (table: unknown) =>
          wrap("update", method.call(object, table) as object, table);
      }
      if (property === "select") {
        return (...args: unknown[]) => {
          const builder = method.apply(object, args) as object;
          return new Proxy(builder, {
            get(inner, key) {
              const field: unknown = Reflect.get(inner, key, inner);
              if (typeof field !== "function") {
                return field;
              }
              const call = field as AnyFunction;
              return key === "from"
                ? (table: unknown) =>
                    wrap("select", call.call(inner, table) as object, table)
                : call.bind(inner);
            },
          });
        };
      }
      return method.bind(object);
    },
  });
  return {
    database: proxy,
    interceptNext: (
      kind: QueryKind,
      table: unknown,
      before: () => Promise<unknown>,
    ) => {
      hook = { kind, table, before };
    },
    started: (kind: QueryKind, table: unknown) =>
      queries.filter((query) => query.kind === kind && query.table === table)
        .length,
  };
}
