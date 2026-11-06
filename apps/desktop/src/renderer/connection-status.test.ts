import { expect, test } from "vitest";
import {
  CONNECTION_OFFLINE_REASONS,
  CONNECTION_STOP_REASONS,
  CONNECTION_WAITING_REASONS,
  DEVICE_STATES,
  type AccountStatus,
  type ConnectionStatus,
  type RemoveDeviceResult,
} from "../shared/ipc-contract.ts";
import {
  canStartSignIn,
  DEVICE_ACTION_FAILURE_MESSAGES,
  DEVICE_ACTION_MESSAGES,
  DEVICE_STATE_MESSAGES,
  type AccountView,
} from "./account-view.ts";
import {
  CONNECTION_ACTION_LABELS,
  CONNECTION_STATUS_TEXT_ID,
  createDeviceRemoval,
  describeConnectionView,
  deviceRemovalMessage,
  focusesStatus,
  IDLE_DEVICE_REMOVAL,
  initialConnectionView,
  OFFLINE_SIGN_IN_DETAIL,
  REGISTER_AGAIN_MESSAGE,
  type DeviceRemovalView,
} from "./connection-status.ts";

const RETRY_AT = "2026-11-03T10:00:01.000Z";

const SIGNED_OUT: AccountStatus = {
  revision: 1,
  account: { kind: "signed_out" },
  signIn: { kind: "idle" },
  lastOutcome: null,
  deviceKey: "ready",
  replacementPending: false,
  apiOrigin: "set",
  device: "no_device",
};

const SIGNED_IN: AccountStatus = {
  ...SIGNED_OUT,
  account: {
    kind: "signed_in",
    login: "octocat",
    displayName: "The Octocat",
    deviceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
  },
  device: "signed_in",
};

function account(status: AccountStatus): AccountView {
  return { kind: "known", status };
}

const SIGNED_IN_VIEW = account(SIGNED_IN);

/** The neutral sentence of `offline` with `not_signed_in`. */
const NOT_READY_DETAIL = "This device connects once it is signed in and ready.";

function known(
  status: ConnectionStatus,
  accountView: AccountView = SIGNED_IN_VIEW,
) {
  return describeConnectionView({ kind: "known", status }, accountView);
}

const REPLACED_STATUS: ConnectionStatus = {
  state: "stopped",
  reason: "connection_replaced",
  revision: 1,
};

const OFFLINE_STATUS: ConnectionStatus = {
  state: "offline",
  reason: "not_signed_in",
  revision: 1,
};

test("the view starts pending with the bridge and unavailable without it", () => {
  expect(initialConnectionView(true)).toEqual({ kind: "pending" });
  expect(initialConnectionView(false)).toEqual({ kind: "unavailable" });
  for (const accountView of [
    SIGNED_IN_VIEW,
    { kind: "pending" },
    { kind: "unavailable" },
  ] as const) {
    expect(describeConnectionView({ kind: "pending" }, accountView)).toEqual({
      tone: "unknown",
      label: "Cloud: Checking",
      detail: null,
      actions: [],
    });
    expect(
      describeConnectionView({ kind: "unavailable" }, accountView),
    ).toEqual({
      tone: "unknown",
      label: "Cloud: Unavailable",
      detail: null,
      actions: [],
    });
  }
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
    known(OFFLINE_STATUS, account(SIGNED_OUT)).detail,
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
  expect(known(REPLACED_STATUS)).toEqual({
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
    detail: "Sign in with GitHub on the Account screen to connect again.",
    actions: [],
  });
});

test("connection_replaced offers its two actions only while the account status shows this device signed in", () => {
  expect(known(REPLACED_STATUS, SIGNED_IN_VIEW).actions).toEqual([
    "reconnect_here",
    "remove_and_register",
  ]);
  // After a removal (also one that waits for the server), a sign-out, or
  // "This is not me", the account status can show it before the client's
  // `offline` status arrives.
  for (const device of DEVICE_STATES) {
    if (device === "signed_in") {
      continue;
    }
    expect(
      known(REPLACED_STATUS, account({ ...SIGNED_IN, device })).actions,
      device,
    ).toEqual([]);
    expect(
      known(REPLACED_STATUS, account({ ...SIGNED_OUT, device })).actions,
      device,
    ).toEqual([]);
  }
  for (const other of [{ kind: "signed_out" }, { kind: "hidden" }] as const) {
    expect(
      known(REPLACED_STATUS, account({ ...SIGNED_IN, account: other })).actions,
      other.kind,
    ).toEqual([]);
  }
  // Without a known account status, nothing is offered.
  for (const accountView of [
    { kind: "pending" },
    { kind: "unavailable" },
  ] as const) {
    expect(known(REPLACED_STATUS, accountView).actions).toEqual([]);
  }
  // "Retry now" after protocol_violation does not depend on the account.
  for (const accountView of [
    SIGNED_IN_VIEW,
    account(SIGNED_OUT),
    { kind: "unavailable" },
  ] as const) {
    expect(
      known(
        { state: "stopped", reason: "protocol_violation", revision: 1 },
        accountView,
      ).actions,
    ).toEqual(["retry_now"]);
  }
});

test("offline without a signed-in device names the sign-in on the Account screen only while the panel offers one that can start now", () => {
  const cases: readonly [string, AccountView, string][] = [
    ["no device", account(SIGNED_OUT), OFFLINE_SIGN_IN_DETAIL],
    [
      "removed",
      account({ ...SIGNED_OUT, device: "removed" }),
      OFFLINE_SIGN_IN_DETAIL,
    ],
    [
      "signed out",
      account({
        ...SIGNED_OUT,
        account: { kind: "hidden" },
        device: "signed_out",
      }),
      OFFLINE_SIGN_IN_DETAIL,
    ],
    [
      "removal pending",
      account({ ...SIGNED_IN, device: "removal_pending" }),
      NOT_READY_DETAIL,
    ],
    [
      "sign-in starting",
      account({ ...SIGNED_OUT, signIn: { kind: "starting" } }),
      NOT_READY_DETAIL,
    ],
    [
      "sign-in completing",
      account({ ...SIGNED_OUT, signIn: { kind: "completing" } }),
      NOT_READY_DETAIL,
    ],
    [
      "key waits for its passphrase",
      account({ ...SIGNED_OUT, deviceKey: "passphrase_required" }),
      NOT_READY_DETAIL,
    ],
    [
      "key loading on a signed-in device",
      account({ ...SIGNED_IN, deviceKey: "loading" }),
      NOT_READY_DETAIL,
    ],
    [
      "no server address",
      account({ ...SIGNED_OUT, apiOrigin: "unset" }),
      NOT_READY_DETAIL,
    ],
    [
      "invalid server address",
      account({ ...SIGNED_OUT, apiOrigin: "invalid" }),
      NOT_READY_DETAIL,
    ],
    ["account status pending", { kind: "pending" }, NOT_READY_DETAIL],
    ["account status unavailable", { kind: "unavailable" }, NOT_READY_DETAIL],
  ];
  for (const [name, accountView, detail] of cases) {
    expect(known(OFFLINE_STATUS, accountView), name).toEqual({
      tone: "offline",
      label: "Cloud: Offline",
      detail,
      actions: [],
    });
    expect(
      known(
        { state: "offline", reason: "no_api_origin", revision: 1 },
        accountView,
      ).detail,
      name,
    ).toBe("This build has no server address.");
  }
  // The rule is the panel's own: `canStartSignIn`.
  for (const device of DEVICE_STATES) {
    for (const status of [
      { ...SIGNED_OUT, device },
      { ...SIGNED_IN, device },
      { ...SIGNED_OUT, device, signIn: { kind: "starting" } } as const,
      { ...SIGNED_OUT, device, deviceKey: "loading" } as const,
    ]) {
      expect(known(OFFLINE_STATUS, account(status)).detail, device).toBe(
        canStartSignIn(status) ? OFFLINE_SIGN_IN_DETAIL : NOT_READY_DETAIL,
      );
    }
  }
  expect(OFFLINE_SIGN_IN_DETAIL).toBe(
    "Sign in with GitHub on the Account screen to connect.",
  );
});

test("the focus moves to the status paragraph only when an action went away and the focus fell to the page", () => {
  const replaced = known(REPLACED_STATUS).actions;
  // The removal is confirmed: the status becomes offline, and both buttons go.
  const removed = known(
    OFFLINE_STATUS,
    account({ ...SIGNED_OUT, device: "removed" }),
  ).actions;
  expect(focusesStatus(replaced, removed, true)).toBe(true);
  // The account status shows the removal first.
  expect(
    focusesStatus(
      replaced,
      known(
        REPLACED_STATUS,
        account({ ...SIGNED_IN, device: "removal_pending" }),
      ).actions,
      true,
    ),
  ).toBe(true);
  expect(focusesStatus(["retry_now"], [], true)).toBe(true);
  expect(focusesStatus(["retry_now"], replaced, true)).toBe(true);
  // A focus elsewhere stays where it is.
  expect(focusesStatus(replaced, removed, false)).toBe(false);
  // Nothing went away.
  expect(focusesStatus(removed, replaced, true)).toBe(false);
  expect(focusesStatus(replaced, replaced, true)).toBe(false);
  expect(focusesStatus([], [], true)).toBe(false);
  expect(CONNECTION_STATUS_TEXT_ID).toBe("connection-status-text");
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
    [
      { outcome: "failed", reason: "refused" },
      DEVICE_ACTION_FAILURE_MESSAGES.refused,
    ],
  ];
  for (const [result, message] of results) {
    expect(deviceRemovalMessage(result), result.outcome).toBe(message);
  }
  // The person starts the sign-in on the Account screen; the indicator
  // never does.
  expect(REGISTER_AGAIN_MESSAGE).toBe(
    "This device was removed from its account, and its key was deleted. Sign in with GitHub on the Account screen to register this computer again as a new device.",
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

test("a removal's message stays until a sign-in runs or the next removal starts, also when the device is signed in again", async () => {
  const { removal, answers, views } = removalWithFakeAccount();
  const signInRuns = (signIn: AccountStatus["signIn"]) =>
    account({ ...SIGNED_OUT, device: "removed", signIn });
  const starting = signInRuns({ kind: "starting" });
  removal.accountChanged(starting);
  expect(views).toEqual([]);

  // The reviewer's path: the session notes the removal, the API refuses
  // the revoke with a code that does not keep it (for example `conflict`),
  // the session ends the removal, and the device is signed in again with
  // the same ID, so the client connects again.
  removal.remove();
  removal.accountChanged(account({ ...SIGNED_IN, device: "removal_pending" }));
  answers[0]?.({ outcome: "failed", reason: "refused" });
  await settle();
  expect(views.at(-1)).toEqual({
    running: false,
    message: DEVICE_ACTION_FAILURE_MESSAGES.refused,
  });
  const shown = views.length;
  const others: readonly AccountView[] = [
    SIGNED_IN_VIEW,
    account({ ...SIGNED_IN, revision: 2 }),
    account({ ...SIGNED_IN, device: "removal_pending" }),
    account({ ...SIGNED_OUT, device: "removed" }),
    account({
      ...SIGNED_OUT,
      account: { kind: "hidden" },
      device: "signed_out",
    }),
    { kind: "pending" },
    { kind: "unavailable" },
  ];
  for (const view of others) {
    removal.accountChanged(view);
  }
  expect(views).toHaveLength(shown);

  // A sign-in that runs ends the message, whatever its step.
  for (const signIn of [
    { kind: "starting" },
    { kind: "completing" },
    { kind: "waiting", pairingCode: "042137", opened: true },
  ] as const) {
    removal.remove();
    answers.at(-1)?.({ outcome: "failed", reason: "refused" });
    await settle();
    expect(views.at(-1)?.message, signIn.kind).toBe(
      DEVICE_ACTION_FAILURE_MESSAGES.refused,
    );
    removal.accountChanged(signInRuns(signIn));
    expect(views.at(-1), signIn.kind).toEqual(IDLE_DEVICE_REMOVAL);
  }
  const ended = views.length;
  removal.accountChanged(starting);
  expect(views).toHaveLength(ended);

  // While a removal runs, a sign-in does not change what it shows.
  removal.remove();
  removal.accountChanged(starting);
  expect(views.at(-1)).toEqual({ running: true, message: undefined });
});
