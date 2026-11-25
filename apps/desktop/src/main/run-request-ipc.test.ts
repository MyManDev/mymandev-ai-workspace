import { expect, test } from "vitest";
import { INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type {
  RunRequestOutcome,
  RunRequestResult,
  RunRequestView,
} from "../shared/ipc-contract.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import { registerRunRequestIpc } from "./run-request-ipc.ts";

// The run request channel of #35: the renderer asks for a run of an agent
// of the open project through the main process, which checks the sender and
// the argument first. The request carries four IDs only, and the result is
// parsed by the contract.

const DEV_URL = "http://localhost:5173/";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const REQUEST: RunRequestView = Object.freeze({
  projectId: id(0xe1),
  agentId: id(0xf1),
  providerConnectionId: id(0x3001),
  inputMessageId: id(0x1001),
});

function frame(url: string, parent: IpcFrame | null = null): IpcFrame {
  return { url, parent, detached: false, isDestroyed: () => false };
}

function receiver(url: string = DEV_URL): StatusReceiver {
  return {
    mainFrame: frame(url),
    isDestroyed: () => false,
    send: () => undefined,
    once: () => undefined,
  };
}

function event(senderFrame: IpcFrame | null): IpcInvokeEvent {
  return { senderFrame, sender: receiver() };
}

function register(
  answer: () => Promise<RunRequestResult> = () =>
    Promise.resolve({ outcome: "ok", runId: id(0x5001) }),
  appUrl: string = DEV_URL,
  kept: () => Promise<RunRequestOutcome | null> = () => Promise.resolve(null),
) {
  const calls: RunRequestView[] = [];
  const takes: string[] = [];
  const handlers = new Map<string, IpcInvokeListener>();
  registerRunRequestIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    {
      service: {
        request: (request) => {
          calls.push(request);
          return answer();
        },
        takeOutcome: (projectId) => {
          takes.push(projectId);
          return kept();
        },
      },
    },
  );
  const call = (args: unknown[]) => {
    const handler = handlers.get(INVOKE_CHANNELS.requestRun);
    if (handler === undefined) {
      throw new Error("No handler for the run request.");
    }
    return handler(event(frame(appUrl)), ...args);
  };
  const take = (args: unknown[]) => {
    const handler = handlers.get(INVOKE_CHANNELS.takeRunRequestOutcome);
    if (handler === undefined) {
      throw new Error("No handler for the kept outcome.");
    }
    return handler(event(frame(appUrl)), ...args);
  };
  return { handlers, calls, call, takes, take };
}

test("the run request channels are registered, and nothing else", () => {
  const { handlers } = register();
  expect([...handlers.keys()]).toEqual([
    INVOKE_CHANNELS.requestRun,
    INVOKE_CHANNELS.takeRunRequestOutcome,
  ]);
  expect(INVOKE_CHANNELS.requestRun).toBe("agents:request-run");
  expect(INVOKE_CHANNELS.takeRunRequestOutcome).toBe(
    "agents:take-run-request-outcome",
  );
});

test("the kept outcome handler takes exactly one project ID from the application, and its result crosses without an ID", async () => {
  const { handlers, takes } = register(undefined, APP_ENTRY_URL);
  const handler = handlers.get(INVOKE_CHANNELS.takeRunRequestOutcome)!;
  expect(() => handler(event(null), REQUEST.projectId)).toThrow(
    `The call on ${INVOKE_CHANNELS.takeRunRequestOutcome} was refused: the sender is not the application.`,
  );
  for (const args of [
    [],
    [REQUEST.projectId, REQUEST.projectId],
    [REQUEST.projectId.toUpperCase()],
    ["project"],
    [{ projectId: REQUEST.projectId }],
    [7],
  ] as unknown[][]) {
    expect(
      () => handler(event(frame(APP_ENTRY_URL)), ...args),
      JSON.stringify(args),
    ).toThrow(
      `The call on ${INVOKE_CHANNELS.takeRunRequestOutcome} was refused: the arguments do not match the contract.`,
    );
  }
  expect(takes).toEqual([]);

  const kept: (RunRequestOutcome | null)[] = [
    null,
    { outcome: "unknown" },
    { outcome: "refused", reason: "run_daily_limit", retryAfterMs: 60_000 },
  ];
  for (const outcome of kept) {
    const { take, takes: asked } = register(undefined, DEV_URL, () =>
      Promise.resolve(outcome),
    );
    expect(await take([REQUEST.projectId])).toEqual(outcome);
    expect(asked).toEqual([REQUEST.projectId]);
  }
  // A run ID beside an `ok` is dropped by the contract, and a refusal out
  // of the contract is refused.
  const { take: withId } = register(undefined, DEV_URL, () =>
    Promise.resolve({ outcome: "ok", runId: id(0x5001) } as RunRequestOutcome),
  );
  expect(await withId([REQUEST.projectId])).toEqual({ outcome: "ok" });
  const { take: outOfContract } = register(undefined, DEV_URL, () =>
    Promise.resolve({
      outcome: "refused",
      reason: "run_limit",
      retryAfterMs: 1_000,
    } as RunRequestOutcome),
  );
  await expect(outOfContract([REQUEST.projectId])).rejects.toThrow();
});

test("the handler refuses a foreign sender, and an argument outside the strict contract, before the service is asked", () => {
  const { handlers, calls } = register(undefined, APP_ENTRY_URL);
  const handler = handlers.get(INVOKE_CHANNELS.requestRun)!;
  for (const sender of [
    null,
    frame("https://example.invalid/"),
    frame(APP_ENTRY_URL, frame(APP_ENTRY_URL)),
  ]) {
    expect(() => handler(event(sender), REQUEST)).toThrow(
      `The call on ${INVOKE_CHANNELS.requestRun} was refused: the sender is not the application.`,
    );
  }
  const refused: unknown[][] = [
    [],
    [REQUEST, REQUEST],
    [REQUEST.projectId, REQUEST.agentId],
    [{ ...REQUEST, projectId: undefined }],
    [{ ...REQUEST, agentId: "agent" }],
    [{ ...REQUEST, providerConnectionId: REQUEST.agentId.toUpperCase() }],
    [{ ...REQUEST, inputMessageId: 7 }],
    // An extra key is refused, not dropped: no text, repository, state,
    // device, or retry key travels beside the four IDs.
    [{ ...REQUEST, body: "Fix the build" }],
    [{ ...REQUEST, repositoryId: id(0x2001) }],
    [{ ...REQUEST, state: "running" }],
    [{ ...REQUEST, hostDeviceId: id(0xd1) }],
    [{ ...REQUEST, idempotencyKey: id(0x6001) }],
  ];
  for (const args of refused) {
    expect(
      () => handler(event(frame(APP_ENTRY_URL)), ...args),
      JSON.stringify(args),
    ).toThrow(
      `The call on ${INVOKE_CHANNELS.requestRun} was refused: the arguments do not match the contract.`,
    );
  }
  expect(calls).toEqual([]);
});

test("a request reaches the service once with its four IDs, and its result is parsed", async () => {
  const { call, calls } = register(() =>
    Promise.resolve({
      outcome: "refused",
      reason: "run_daily_limit",
      retryAfterMs: 3_600_000,
    }),
  );
  expect(await call([REQUEST])).toEqual({
    outcome: "refused",
    reason: "run_daily_limit",
    retryAfterMs: 3_600_000,
  });
  expect(calls).toEqual([REQUEST]);
});

test("an uncertain answer goes to the renderer as unknown and is never asked for again", async () => {
  const { call, calls } = register(() =>
    Promise.resolve({ outcome: "unknown" }),
  );
  expect(await call([REQUEST])).toEqual({ outcome: "unknown" });
  expect(calls).toHaveLength(1);
});

test("a result outside the contract is refused, not passed on", async () => {
  const { call } = register(() =>
    Promise.resolve({
      outcome: "ok",
      runId: id(0x5001),
      providerConnectionId: id(0x3001),
    } as unknown as RunRequestResult),
  );
  // The contract's objects drop unknown keys: the connection never crosses
  // in a result.
  expect(await call([REQUEST])).toEqual({
    outcome: "ok",
    runId: id(0x5001),
  });
  const { call: refusedCall } = register(() =>
    Promise.resolve({
      outcome: "refused",
      reason: "run_limit",
      retryAfterMs: 1_000,
    } as RunRequestResult),
  );
  await expect(refusedCall([REQUEST])).rejects.toThrow();
});
