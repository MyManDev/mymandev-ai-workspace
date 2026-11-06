import { expect, test } from "vitest";
import {
  CONNECTION_OFFLINE_REASONS,
  CONNECTION_STOP_REASONS,
  CONNECTION_WAITING_REASONS,
  type ConnectionStatus,
  type RemoveDeviceResult,
} from "../shared/ipc-contract.ts";
import {
  DEVICE_ACTION_FAILURE_MESSAGES,
  DEVICE_ACTION_MESSAGES,
  DEVICE_STATE_MESSAGES,
} from "./account-view.ts";
import {
  CONNECTION_ACTION_LABELS,
  createDeviceRemoval,
  describeConnectionView,
  deviceRemovalMessage,
  IDLE_DEVICE_REMOVAL,
  initialConnectionView,
  REGISTER_AGAIN_MESSAGE,
  type ConnectionView,
  type DeviceRemovalView,
} from "./connection-status.ts";

const RETRY_AT = "2026-11-03T10:00:01.000Z";

function known(status: ConnectionStatus) {
  return describeConnectionView({ kind: "known", status });
}

test("the view starts pending with the bridge and unavailable without it", () => {
  expect(initialConnectionView(true)).toEqual({ kind: "pending" });
  expect(initialConnectionView(false)).toEqual({ kind: "unavailable" });
  expect(describeConnectionView({ kind: "pending" })).toEqual({
    tone: "unknown",
    label: "Cloud: Checking",
    detail: null,
    actions: [],
  });
  expect(describeConnectionView({ kind: "unavailable" })).toEqual({
    tone: "unknown",
    label: "Cloud: Unavailable",
    detail: null,
    actions: [],
  });
});

test("the states without a reason have their own label and no action", () => {
  expect(
    (["connecting", "authenticating", "connected"] as const).map((state) =>
      known({ state, revision: 1 }),
    ),
  ).toEqual([
    {
      tone: "connecting",
      label: "Cloud: Connecting",
      detail: null,
      actions: [],
    },
    {
      tone: "authenticating",
      label: "Cloud: Authenticating",
      detail: null,
      actions: [],
    },
    {
      tone: "connected",
      label: "Cloud: Connected",
      detail: null,
      actions: [],
    },
  ]);
  expect(known({ state: "offline", revision: 1 })).toEqual({
    tone: "offline",
    label: "Cloud: Offline",
    detail: null,
    actions: [],
  });
});

test("every reason has its own fixed sentence", () => {
  const details = [
    ...CONNECTION_OFFLINE_REASONS.map(
      (reason) => known({ state: "offline", reason, revision: 1 }).detail,
    ),
    ...CONNECTION_WAITING_REASONS.map(
      (reason) =>
        known({ state: "waiting", reason, retryAt: RETRY_AT, revision: 1 })
          .detail,
    ),
    ...CONNECTION_STOP_REASONS.map(
      (reason) => known({ state: "stopped", reason, revision: 1 }).detail,
    ),
  ];
  for (const detail of details) {
    expect(detail).toMatch(/^[A-Z].*\.$/);
  }
  expect(new Set(details).size).toBe(details.length);
});

test("waiting offers Retry now, and only connection_replaced offers Reconnect here once and the removal", () => {
  for (const reason of CONNECTION_WAITING_REASONS) {
    expect(
      known({ state: "waiting", reason, retryAt: RETRY_AT, revision: 1 }),
    ).toMatchObject({
      tone: "waiting",
      label: "Cloud: Waiting to reconnect",
      actions: ["retry_now"],
    });
  }
  for (const reason of CONNECTION_OFFLINE_REASONS) {
    expect(known({ state: "offline", reason, revision: 1 }).actions).toEqual(
      [],
    );
  }
  const actions = Object.fromEntries(
    CONNECTION_STOP_REASONS.map((reason) => [
      reason,
      known({ state: "stopped", reason, revision: 1 }).actions,
    ]),
  );
  expect(actions).toEqual({
    auth_failed: [],
    device_revoked: [],
    sign_in_required: [],
    connection_replaced: ["reconnect_here", "remove_and_register"],
    protocol_violation: ["retry_now"],
    update_required: [],
  });
  expect(
    known({ state: "stopped", reason: "connection_replaced", revision: 1 }),
  ).toEqual({
    tone: "stopped",
    label: "Cloud: Stopped",
    detail:
      "Another installation connected with this device's key. The key is in use there. Reconnect here once, or remove this device and register this computer again as a new device.",
    actions: ["reconnect_here", "remove_and_register"],
  });
  expect(CONNECTION_ACTION_LABELS).toEqual({
    retry_now: "Retry now",
    reconnect_here: "Reconnect here once",
    remove_and_register: "Remove this device and register again",
  });
  expect(
    known({ state: "stopped", reason: "sign_in_required", revision: 1 }),
  ).toEqual({
    tone: "stopped",
    label: "Cloud: Stopped",
    detail: "Sign in with GitHub on the home screen to connect again.",
    actions: [],
  });
});

test("every removal result has its message: the way to register again, the waiting removal, the panel's messages, and none after a cancel", () => {
  const results: readonly [RemoveDeviceResult, string | undefined][] = [
    [{ outcome: "removed" }, REGISTER_AGAIN_MESSAGE],
    [{ outcome: "pending" }, DEVICE_STATE_MESSAGES.removal_pending],
    [{ outcome: "cancelled" }, undefined],
    [{ outcome: "refused", reason: "busy" }, DEVICE_ACTION_MESSAGES.busy],
    [
      { outcome: "refused", reason: "not_signed_in" },
      DEVICE_ACTION_MESSAGES.notSignedIn,
    ],
    [
      { outcome: "failed", reason: "no_answer" },
      DEVICE_ACTION_FAILURE_MESSAGES.no_answer,
    ],
    [
      { outcome: "failed", reason: "device_revoked" },
      DEVICE_ACTION_FAILURE_MESSAGES.device_revoked,
    ],
  ];
  for (const [result, message] of results) {
    expect(deviceRemovalMessage(result), result.outcome).toBe(message);
  }
  // The person starts the sign-in; the indicator never does.
  expect(REGISTER_AGAIN_MESSAGE).toBe(
    'This device was removed from its account, and its key was deleted. Choose "Sign in with GitHub" to register this computer again as a new device.',
  );
});

/** A removal whose `removeDevice` calls wait until the test answers them. */
function removalWithFakeAccount() {
  const answers: ((result: RemoveDeviceResult) => void)[] = [];
  const failures: ((error: Error) => void)[] = [];
  const views: DeviceRemovalView[] = [];
  const removal = createDeviceRemoval(
    {
      removeDevice: () =>
        new Promise<RemoveDeviceResult>((resolve, reject) => {
          answers.push(resolve);
          failures.push(reject);
        }),
    },
    (view) => views.push(view),
  );
  return { removal, answers, failures, views };
}

/** Lets the removal's promise handlers run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

test("the removal calls removeDevice once, ignores clicks while it runs, and shows the result's message", async () => {
  const { removal, answers, views } = removalWithFakeAccount();
  removal.remove();
  removal.remove();
  expect(answers).toHaveLength(1);
  expect(views).toEqual([{ running: true, message: undefined }]);

  answers[0]?.({ outcome: "removed" });
  await settle();
  expect(views.at(-1)).toEqual({
    running: false,
    message: REGISTER_AGAIN_MESSAGE,
  });

  // A new removal clears the last message while it runs.
  removal.remove();
  expect(answers).toHaveLength(2);
  expect(views.at(-1)).toEqual({ running: true, message: undefined });
  answers[1]?.({ outcome: "refused", reason: "busy" });
  await settle();
  expect(views.at(-1)).toEqual({
    running: false,
    message: DEVICE_ACTION_MESSAGES.busy,
  });

  removal.remove();
  answers[2]?.({ outcome: "cancelled" });
  await settle();
  expect(views.at(-1)).toEqual(IDLE_DEVICE_REMOVAL);
});

test("a removal that the main process rejects shows that it failed, and the button works again", async () => {
  const { removal, answers, failures, views } = removalWithFakeAccount();
  removal.remove();
  failures[0]?.(new Error("refused by the IPC contract"));
  await settle();
  expect(views.at(-1)).toEqual({
    running: false,
    message: DEVICE_ACTION_MESSAGES.removeFailed,
  });
  removal.remove();
  expect(answers).toHaveLength(2);
});

test("the removal's message goes once the connection is connected again, and not before", async () => {
  const { removal, answers, views } = removalWithFakeAccount();
  const connected: ConnectionView = {
    kind: "known",
    status: { state: "connected", revision: 9 },
  };
  removal.connectionChanged(connected);
  expect(views).toEqual([]);

  removal.remove();
  answers[0]?.({ outcome: "removed" });
  await settle();
  const shown = views.length;
  const others: readonly ConnectionView[] = [
    { kind: "pending" },
    { kind: "unavailable" },
    {
      kind: "known",
      status: { state: "offline", reason: "not_signed_in", revision: 2 },
    },
    { kind: "known", status: { state: "connecting", revision: 3 } },
    { kind: "known", status: { state: "authenticating", revision: 4 } },
  ];
  for (const view of others) {
    removal.connectionChanged(view);
  }
  expect(views).toHaveLength(shown);

  removal.connectionChanged(connected);
  expect(views.at(-1)).toEqual(IDLE_DEVICE_REMOVAL);
  removal.connectionChanged(connected);
  expect(views).toHaveLength(shown + 1);

  // While a removal runs, a connection does not change what it shows.
  removal.remove();
  removal.connectionChanged(connected);
  expect(views.at(-1)).toEqual({ running: true, message: undefined });
});
