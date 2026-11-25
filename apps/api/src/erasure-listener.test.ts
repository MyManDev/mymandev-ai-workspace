import type {
  NotificationHandlers,
  NotificationSession,
  NotificationSessions,
} from "@mymandev/database";
import { ERASURE_NOTIFICATION_CHANNEL } from "@mymandev/database";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ERASURE_LISTENER_CHECK_INTERVAL_MS,
  ERASURE_LISTENER_CHECK_TIMEOUT_MS,
  ERASURE_LISTENER_LISTEN_TIMEOUT_MS,
  ErasureListener,
} from "./erasure-listener.ts";
import { settle, until } from "./gateway-test-support.ts";

// The listener's own behavior (#341), with sessions that the test controls:
// it reconnects with a bounded backoff after a failed or a lost session,
// counts a `LISTEN` that is not confirmed in time as a failed attempt,
// checks a listening session periodically and counts a failed or hanging
// check as a lost session, closes its session at shutdown, keeps going when
// a payload fails, and logs no ID, URL, or error message.

type FakeSession = Readonly<{
  /** The handlers that `listen` got, once it listened. */
  handlers: () => NotificationHandlers | null;
  closed: () => boolean;
  /** How many checks the session ran. */
  checks: () => number;
}>;

type CheckOutcome = "ok" | "fail" | "hang";

/**
 * Sessions whose outcomes follow `plan`: "fail" rejects the connection,
 * "listen" connects and listens, "stall" connects and never confirms the
 * `LISTEN`. Each check takes the next outcome of `checkPlan`, "ok" when it
 * is empty. Every session opened is kept in `opened`.
 */
function fakeSessions(
  plan: ("fail" | "listen" | "stall")[],
  checkPlan: CheckOutcome[] = [],
) {
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
    let checks = 0;
    const session: NotificationSession = {
      listen: async (channel, given) => {
        assert.equal(channel, ERASURE_NOTIFICATION_CHANNEL);
        if (step === "stall") {
          await new Promise<never>(() => undefined);
        }
        handlers = given;
      },
      check: async () => {
        checks += 1;
        const outcome = checkPlan.shift() ?? "ok";
        if (outcome === "fail") {
          throw new Error("read ECONNRESET 10.0.0.1:5432");
        }
        if (outcome === "hang") {
          await new Promise<never>(() => undefined);
        }
      },
      close: async () => {
        closed = true;
      },
    };
    opened.push({
      handlers: () => handlers,
      closed: () => closed,
      checks: () => checks,
    });
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
    check: async () => assert.fail("a closed listener does not check"),
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

test("a LISTEN that the server does not confirm in time is a failed attempt: the app's start goes on, the session is closed, and the next attempt listens", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sessions, opened } = fakeSessions(["stall", "listen"]);
  const { log, lines } = logger();
  const { waits, wait } = recordedWaits();
  const listener = new ErasureListener({
    sessions,
    onPayload: () => undefined,
    log,
    initialBackoffMs: 100,
    wait,
  });
  let started = false;
  void listener.start().then(() => {
    started = true;
  });
  await settle();
  assert.equal(opened.length, 1);
  t.mock.timers.tick(ERASURE_LISTENER_LISTEN_TIMEOUT_MS - 1);
  await settle();
  assert.equal(started, false, "the first attempt has not ended yet");
  assert.equal(opened[0]?.closed(), false);

  t.mock.timers.tick(1);
  await settle();
  assert.equal(started, true, "the timed-out LISTEN ended the first attempt");
  assert.equal(opened[0]?.closed(), true);
  assert.equal(opened.length, 2);
  assert.notEqual(opened[1]?.handlers(), null);
  assert.deepEqual(waits, [100]);
  const entries = lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  assert.deepEqual(
    entries.map((entry) => [entry["msg"], entry["errorType"]]),
    [
      ["erasure listener could not listen", "TimeoutError"],
      ["erasure listener listening", undefined],
    ],
  );
  await listener.close();
});

test("a listening session is checked every minute, one check at a time; a check that fails or does not answer in time counts as a lost session, and the listener connects again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { sessions, opened } = fakeSessions(
    ["listen", "listen", "listen"],
    ["ok", "fail", "hang"],
  );
  const { log, lines } = logger();
  const { waits, wait } = recordedWaits();
  const listener = new ErasureListener({
    sessions,
    onPayload: () => undefined,
    log,
    initialBackoffMs: 100,
    wait,
  });
  await listener.start();
  assert.equal(opened.length, 1);

  // No check before the interval; the first one answers.
  t.mock.timers.tick(ERASURE_LISTENER_CHECK_INTERVAL_MS - 1);
  await settle();
  assert.equal(opened[0]?.checks(), 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(opened[0]?.checks(), 1);
  assert.equal(opened[0]?.closed(), false);

  // The second check fails: the session is lost and replaced.
  t.mock.timers.tick(ERASURE_LISTENER_CHECK_INTERVAL_MS);
  await settle();
  assert.equal(opened[0]?.checks(), 2);
  assert.equal(opened[0]?.closed(), true);
  assert.equal(opened.length, 2);
  assert.deepEqual(waits, [100]);

  // The new session's first check hangs: no second check starts while it
  // waits, and it counts as lost once its timeout passes.
  t.mock.timers.tick(ERASURE_LISTENER_CHECK_INTERVAL_MS);
  await settle();
  assert.equal(opened[1]?.checks(), 1);
  t.mock.timers.tick(ERASURE_LISTENER_CHECK_TIMEOUT_MS - 1);
  await settle();
  assert.equal(opened[1]?.closed(), false);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(opened[1]?.checks(), 1);
  assert.equal(opened[1]?.closed(), true);
  assert.equal(opened.length, 3);
  assert.deepEqual(waits, [100, 100]);

  // A closed listener checks no more.
  await listener.close();
  t.mock.timers.tick(ERASURE_LISTENER_CHECK_INTERVAL_MS * 3);
  await settle();
  assert.equal(opened[2]?.checks(), 0);

  const entries = lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  assert.deepEqual(
    entries.map((entry) => [entry["msg"], entry["errorType"]]),
    [
      ["erasure listener listening", undefined],
      ["erasure listener check failed", "Error"],
      ["erasure listener lost its database session", undefined],
      ["erasure listener listening", undefined],
      ["erasure listener check failed", "TimeoutError"],
      ["erasure listener lost its database session", undefined],
      ["erasure listener listening", undefined],
    ],
  );
  for (const line of lines) {
    assert.equal(line.includes("10.0.0.1"), false, line);
  }
});
