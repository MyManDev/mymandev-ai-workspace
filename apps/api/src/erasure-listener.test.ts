import type {
  NotificationHandlers,
  NotificationSession,
  NotificationSessions,
} from "@mymandev/database";
import { ERASURE_NOTIFICATION_CHANNEL } from "@mymandev/database";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ErasureListener } from "./erasure-listener.ts";
import { until } from "./gateway-test-support.ts";

// The listener's own behavior (#341), with sessions that the test controls:
// it reconnects with a bounded backoff after a failed or a lost session,
// closes its session at shutdown, keeps going when a payload fails, and
// logs no ID, URL, or error message.

type FakeSession = Readonly<{
  /** The handlers that `listen` got, once it listened. */
  handlers: () => NotificationHandlers | null;
  closed: () => boolean;
}>;

/**
 * Sessions whose outcomes follow `plan`: "fail" rejects the connection,
 * "listen" connects and listens. Every session opened is kept in `opened`.
 */
function fakeSessions(plan: ("fail" | "listen")[]) {
  const opened: FakeSession[] = [];
  let attempts = 0;
  const sessions: NotificationSessions = async () => {
    attempts += 1;
    const step = plan.shift() ?? "listen";
    if (step === "fail") {
      throw new Error("connect ECONNREFUSED 10.0.0.1:5432 for user mymandev");
    }
    let handlers: NotificationHandlers | null = null;
    let closed = false;
    const session: NotificationSession = {
      listen: async (channel, given) => {
        assert.equal(channel, ERASURE_NOTIFICATION_CHANNEL);
        handlers = given;
      },
      close: async () => {
        closed = true;
      },
    };
    opened.push({ handlers: () => handlers, closed: () => closed });
    return session;
  };
  return { sessions, opened, attempts: () => attempts };
}

/** A logger that keeps its JSON lines. */
function logger() {
  const lines: string[] = [];
  const app = Fastify({
    logger: { level: "debug", stream: { write: (line) => lines.push(line) } },
  });
  return { log: app.log, lines };
}

/** A wait that records each wait and resolves at once, or rejects once aborted. */
function recordedWaits() {
  const waits: number[] = [];
  const wait = async (ms: number, signal: AbortSignal) => {
    waits.push(ms);
    await new Promise((resolve) => setImmediate(resolve));
    if (signal.aborted) {
      throw new Error("aborted");
    }
  };
  return { waits, wait };
}

test("a listener that cannot connect starts anyway and tries again after waits that double up to the bound; once it listens the waits start over", async () => {
  const { sessions, opened, attempts } = fakeSessions([
    "fail",
    "fail",
    "fail",
    "fail",
    "fail",
    "listen",
  ]);
  const { log, lines } = logger();
  const { waits, wait } = recordedWaits();
  const received: string[] = [];
  const listener = new ErasureListener({
    sessions,
    onPayload: (payload) => received.push(payload),
    log,
    initialBackoffMs: 100,
    maxBackoffMs: 400,
    wait,
  });
  // `start` resolves after the first attempt, which failed.
  await listener.start();
  assert.ok(attempts() >= 1);
  await until(() => opened.length === 1, "the sixth attempt");
  await until(() => opened[0]?.handlers() !== null, "the listen");
  assert.deepEqual(waits, [100, 200, 400, 400, 400]);

  opened[0]?.handlers()?.onPayload("first");
  assert.deepEqual(received, ["first"]);

  // A lost session is closed, and the next one is opened after the initial
  // wait again.
  opened[0]?.handlers()?.onLost();
  await until(() => opened.length === 2, "the new session");
  await until(() => opened[1]?.handlers() !== null, "the new listen");
  assert.equal(opened[0]?.closed(), true);
  assert.deepEqual(waits, [100, 200, 400, 400, 400, 100]);
  opened[1]?.handlers()?.onPayload("second");
  assert.deepEqual(received, ["first", "second"]);

  // At shutdown the session closes, nothing more is delivered, and no new
  // session is opened.
  await listener.close();
  assert.equal(opened[1]?.closed(), true);
  opened[1]?.handlers()?.onPayload("late");
  assert.deepEqual(received, ["first", "second"]);
  assert.equal(opened.length, 2);

  const entries = lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  assert.deepEqual(
    entries.map((entry) => entry["msg"]),
    [
      ...Array<string>(5).fill("erasure listener could not listen"),
      "erasure listener listening",
      "erasure listener lost its database session",
      "erasure listener listening",
    ],
  );
  assert.deepEqual(entries[0]?.["errorType"], "Error");
  for (const line of lines) {
    for (const secret of ["10.0.0.1", "5432", "mymandev", "ECONNREFUSED"]) {
      assert.equal(line.includes(secret), false, line);
    }
  }
});

test("closing while the listener waits to reconnect stops it, and closing while it connects closes the new session", async () => {
  const waiting = fakeSessions(["fail"]);
  let abortedWait: Promise<void> | null = null;
  const listener = new ErasureListener({
    sessions: waiting.sessions,
    onPayload: () => undefined,
    log: logger().log,
    wait: (_ms, signal) => {
      abortedWait = new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return abortedWait;
    },
  });
  await listener.start();
  await until(() => abortedWait !== null, "the wait");
  await listener.close();
  assert.equal(waiting.attempts(), 1);

  let connect: (session: NotificationSession) => void = () => undefined;
  let closed = false;
  const slow = new ErasureListener({
    sessions: () =>
      new Promise((resolve) => {
        connect = resolve;
      }),
    onPayload: () => undefined,
    log: logger().log,
  });
  const started = slow.start();
  const closing = slow.close();
  connect({
    listen: async () => assert.fail("a closed listener does not listen"),
    close: async () => {
      closed = true;
    },
  });
  await closing;
  await started;
  assert.equal(closed, true);
});

test("a payload whose replay fails is logged with the error's type only, and the next payload is still replayed", async () => {
  const { sessions, opened } = fakeSessions(["listen"]);
  const { log, lines } = logger();
  const received: string[] = [];
  const listener = new ErasureListener({
    sessions,
    onPayload: (payload) => {
      if (payload === "bad") {
        throw new TypeError("cannot replay user 0192f2a0-7c3e-7a1b");
      }
      received.push(payload);
    },
    log,
  });
  await listener.start();
  opened[0]?.handlers()?.onPayload("bad");
  opened[0]?.handlers()?.onPayload("good");
  assert.deepEqual(received, ["good"]);
  const failed = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["msg"] === "erasure notification failed");
  assert.deepEqual(
    failed.map((entry) => entry["errorType"]),
    ["TypeError"],
  );
  assert.equal(
    lines.some((line) => line.includes("0192f2a0")),
    false,
  );
  await listener.close();
});
