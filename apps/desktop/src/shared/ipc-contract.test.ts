import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "./ipc-channels.ts";
import {
  ACCOUNT_LIMITS,
  AccountStatusSchema,
  AGENT_ACTIVITY_PROBLEMS,
  AGENT_ACTIVITY_STATUSES,
  AGENT_LIMITS,
  AGENT_RUN_STATES,
  AgentActivityViewSchema,
  API_ORIGIN_STATES,
  CONNECTION_OFFLINE_REASONS,
  CONNECTION_STATES,
  CONNECTION_STOP_REASONS,
  CONNECTION_WAITING_REASONS,
  ConnectionStatusSchema,
  DEVICE_ACTION_FAILURES,
  DEVICE_ACTION_REFUSALS,
  DEVICE_KEY_STATES,
  DEVICE_STATES,
  EVENT_CONTRACT,
  FORGET_REFUSALS,
  ForgetResultSchema,
  INVOKE_CONTRACT,
  ListDevicesResultSchema,
  MOUNT_REFUSALS,
  MountResultSchema,
  ProtocolIdSchema,
  RECONNECT_REFUSALS,
  ReconnectResultSchema,
  REPOSITORY_LIMITS,
  REPOSITORY_PROBLEMS,
  RemoveDeviceResultSchema,
  RepositoryListSchema,
  RUNTIME_STATES,
  RuntimeStatusSchema,
  SIGN_IN_OUTCOME_CODES,
  SignOutResultSchema,
  SIGN_IN_BROWSERS,
  START_SIGN_IN_REFUSALS,
  StartSignInOptionsSchema,
  StartSignInResultSchema,
  UNLOCK_REFUSALS,
  UnlockResultSchema,
  WORKSPACE_ACTION_REFUSALS,
  WORKSPACE_LIMITS,
  WORKSPACE_PROBLEMS,
  WORKSPACE_STATUSES,
  WorkspaceActionResultSchema,
  WorkspaceViewSchema,
  type AccountStatus,
  type MountedRepository,
  type RepositoryList,
} from "./ipc-contract.ts";

test("every channel has exactly one schema entry, and no name is used twice", () => {
  const invokeChannels = Object.values(INVOKE_CHANNELS);
  const eventChannels = Object.values(EVENT_CHANNELS);

  expect(Object.keys(INVOKE_CONTRACT).sort()).toEqual(
    [...invokeChannels].sort(),
  );
  expect(Object.keys(EVENT_CONTRACT).sort()).toEqual([...eventChannels].sort());
  expect(new Set([...invokeChannels, ...eventChannels]).size).toBe(
    invokeChannels.length + eventChannels.length,
  );
});

test("the channel names and the contract cannot be changed at runtime", () => {
  expect(Object.isFrozen(INVOKE_CHANNELS)).toBe(true);
  expect(Object.isFrozen(EVENT_CHANNELS)).toBe(true);
  expect(Object.isFrozen(INVOKE_CONTRACT)).toBe(true);
  expect(Object.isFrozen(EVENT_CONTRACT)).toBe(true);
  expect(Object.isFrozen(RUNTIME_STATES)).toBe(true);
  expect(Object.isFrozen(REPOSITORY_LIMITS)).toBe(true);
  expect(Object.isFrozen(REPOSITORY_PROBLEMS)).toBe(true);
  expect(Object.isFrozen(MOUNT_REFUSALS)).toBe(true);
  for (const list of [
    ACCOUNT_LIMITS,
    SIGN_IN_OUTCOME_CODES,
    DEVICE_KEY_STATES,
    API_ORIGIN_STATES,
    START_SIGN_IN_REFUSALS,
    UNLOCK_REFUSALS,
    FORGET_REFUSALS,
    CONNECTION_STATES,
    CONNECTION_OFFLINE_REASONS,
    CONNECTION_WAITING_REASONS,
    CONNECTION_STOP_REASONS,
    RECONNECT_REFUSALS,
    WORKSPACE_LIMITS,
    WORKSPACE_STATUSES,
    WORKSPACE_PROBLEMS,
    WORKSPACE_ACTION_REFUSALS,
    AGENT_LIMITS,
    AGENT_ACTIVITY_STATUSES,
    AGENT_ACTIVITY_PROBLEMS,
    AGENT_RUN_STATES,
  ]) {
    expect(Object.isFrozen(list)).toBe(true);
  }
  for (const entry of Object.values(INVOKE_CONTRACT)) {
    expect(Object.isFrozen(entry)).toBe(true);
  }
});

test("a runtime status with every state is accepted", () => {
  for (const state of RUNTIME_STATES) {
    expect(RuntimeStatusSchema.parse({ state, revision: 3 })).toEqual({
      state,
      revision: 3,
    });
  }
});

test("a runtime status drops unknown keys, also __proto__ and constructor", () => {
  const parsed = RuntimeStatusSchema.parse(
    JSON.parse(
      '{"state":"running","revision":1,"token":"secret","__proto__":{"polluted":true},"constructor":{"x":1}}',
    ),
  );

  expect(parsed).toEqual({ state: "running", revision: 1 });
  expect(Object.keys(parsed).sort()).toEqual(["revision", "state"]);
  expect(Object.hasOwn(parsed, "__proto__")).toBe(false);
  expect(Object.hasOwn(parsed, "constructor")).toBe(false);
  expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
});

test("a runtime status with a wrong state or revision is refused", () => {
  for (const value of [
    undefined,
    null,
    "running",
    {},
    { state: "running" },
    { revision: 0 },
    { state: "paused", revision: 0 },
    { state: "RUNNING", revision: 0 },
    { state: "running", revision: -1 },
    { state: "running", revision: 1.5 },
    { state: "running", revision: "1" },
    { state: "running", revision: Number.MAX_SAFE_INTEGER + 1 },
    { state: "running", revision: Number.NaN },
  ]) {
    expect(RuntimeStatusSchema.safeParse(value).success).toBe(false);
  }
});

test("the invoke channels except unmount, unlock, the sign-in start, select, and open take no arguments and refuse any", () => {
  const channels = Object.entries(INVOKE_CONTRACT).filter(
    ([channel]) =>
      channel !== INVOKE_CHANNELS.unmountRepository &&
      channel !== INVOKE_CHANNELS.unlockDeviceKey &&
      channel !== INVOKE_CHANNELS.startSignIn &&
      channel !== INVOKE_CHANNELS.selectWorkspace &&
      channel !== INVOKE_CHANNELS.openProject,
  );
  expect(channels).toHaveLength(Object.keys(INVOKE_CONTRACT).length - 5);
  for (const [, { args }] of channels) {
    expect(args.parse([])).toEqual([]);
    for (const value of [
      [undefined],
      [null],
      ["runtime:get-status"],
      [{ state: "running" }],
      [1, 2],
      undefined,
      {},
      "",
    ]) {
      expect(args.safeParse(value).success).toBe(false);
    }
  }
});

test("an error message of the contract never contains the input", () => {
  const result = RuntimeStatusSchema.safeParse({
    state: "secret-value",
    revision: "secret-number",
  });

  expect(result.success).toBe(false);
  expect(JSON.stringify(result.error?.issues)).not.toContain("secret");
});

const MOUNT_ID = "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b70";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function repository(
  overrides: Partial<MountedRepository> = {},
): MountedRepository {
  return {
    mountId: MOUNT_ID,
    name: "project",
    path: "/home/user/project",
    watching: true,
    state: {
      kind: "ready",
      branch: {
        name: "main",
        commit: COMMIT,
        upstream: "origin/main",
        ahead: 1,
        behind: 0,
      },
      changes: { staged: 1, unstaged: 2, untracked: 3, conflicted: 0 },
      remotes: [
        {
          name: "origin",
          fetchUrl: "https://example.com/project.git",
          pushUrl: null,
        },
      ],
    },
    ...overrides,
  };
}

function list(repositories: MountedRepository[]): RepositoryList {
  return { revision: 4, repositories };
}

test("the sign-in start takes no argument or one option with a known browser and no other key", () => {
  const { args } = INVOKE_CONTRACT[INVOKE_CHANNELS.startSignIn];

  expect(SIGN_IN_BROWSERS).toEqual(["default", "other"]);
  expect(args.parse([])).toEqual([]);
  for (const browser of SIGN_IN_BROWSERS) {
    expect(args.parse([{ browser }])).toEqual([{ browser }]);
  }
  for (const value of [
    [undefined],
    [null],
    [{}],
    ["other"],
    [{ browser: "chrome" }],
    [{ browser: "Other" }],
    [{ browser: "other " }],
    [{ browser: true }],
    [{ browser: ["other"] }],
    [{ browser: "other", login: "octocat" }],
    [{ browser: "other", url: "https://evil.example" }],
    [{ browser: "other" }, { browser: "other" }],
    [{ browser: "other" }, "extra"],
    { browser: "other" },
    undefined,
    "",
  ]) {
    expect(args.safeParse(value).success).toBe(false);
  }
  // An unknown key is refused rather than stripped, also one of the prototype.
  expect(
    StartSignInOptionsSchema.safeParse(
      JSON.parse('{"browser":"other","__proto__":{"browser":"default"}}'),
    ).success,
  ).toBe(false);
});

test("unmount takes exactly one mount ID", () => {
  const { args } = INVOKE_CONTRACT[INVOKE_CHANNELS.unmountRepository];

  expect(args.parse([MOUNT_ID])).toEqual([MOUNT_ID]);
  for (const value of [
    [],
    [MOUNT_ID, MOUNT_ID],
    ["not-a-uuid"],
    ["/home/user/project"],
    [1],
    [null],
    [{ mountId: MOUNT_ID }],
    [`${MOUNT_ID} `],
    MOUNT_ID,
  ]) {
    expect(args.safeParse(value).success).toBe(false);
  }
});

test("a repository list with every state is accepted", () => {
  const value = list([
    repository(),
    repository({ state: { kind: "loading" }, watching: false }),
    ...REPOSITORY_PROBLEMS.map((problem) =>
      repository({ state: { kind: "unavailable", problem } }),
    ),
    repository({
      state: {
        kind: "ready",
        branch: {
          name: null,
          commit: "a".repeat(64),
          upstream: null,
          ahead: null,
          behind: null,
        },
        changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 1 },
        remotes: [],
      },
    }),
  ]);

  expect(RepositoryListSchema.parse(value)).toEqual(value);
});

test("a repository list drops unknown keys at every level", () => {
  const parsed = RepositoryListSchema.parse({
    revision: 1,
    secret: "x",
    repositories: [
      {
        ...repository(),
        gitDir: "/home/user/project/.git",
        state: {
          ...(repository().state as object),
          index: "raw",
          remotes: [
            { name: "origin", fetchUrl: null, pushUrl: null, token: "x" },
          ],
        },
      },
    ],
  });

  expect(JSON.stringify(parsed)).not.toMatch(/secret|gitDir|raw|token/);
});

test("a repository list over the limits or with wrong values is refused", () => {
  const many = Array.from({ length: REPOSITORY_LIMITS.mounted + 1 }, () =>
    repository(),
  );
  const ready = repository().state;
  if (ready.kind !== "ready") {
    throw new Error("expected a ready state");
  }
  for (const value of [
    list(many),
    list([repository({ mountId: "1" })]),
    list([repository({ name: "" })]),
    list([repository({ name: "x".repeat(REPOSITORY_LIMITS.name + 1) })]),
    list([repository({ path: "x".repeat(REPOSITORY_LIMITS.path + 1) })]),
    list([
      repository({ state: { kind: "unavailable", problem: "other" } as never }),
    ]),
    list([repository({ state: { kind: "paused" } as never })]),
    list([
      repository({
        state: { ...ready, branch: { ...ready.branch, commit: "ABC" } },
      }),
    ]),
    list([
      repository({
        state: { ...ready, branch: { ...ready.branch, ahead: -1 } },
      }),
    ]),
    list([
      repository({
        state: {
          ...ready,
          branch: {
            ...ready.branch,
            name: "x".repeat(REPOSITORY_LIMITS.ref + 1),
          },
        },
      }),
    ]),
    list([
      repository({
        state: {
          ...ready,
          remotes: Array.from(
            { length: REPOSITORY_LIMITS.remotes + 1 },
            () => ({
              name: "origin",
              fetchUrl: null,
              pushUrl: null,
            }),
          ),
        },
      }),
    ]),
    list([
      repository({
        state: {
          ...ready,
          remotes: [
            {
              name: "origin",
              fetchUrl: "x".repeat(REPOSITORY_LIMITS.url + 1),
              pushUrl: null,
            },
          ],
        },
      }),
    ]),
    { revision: -1, repositories: [] },
  ]) {
    expect(RepositoryListSchema.safeParse(value).success).toBe(false);
  }
});

test("a mount result is mounted with an ID, cancelled, or refused with a known reason", () => {
  expect(
    MountResultSchema.parse({ outcome: "mounted", mountId: MOUNT_ID }),
  ).toEqual({ outcome: "mounted", mountId: MOUNT_ID });
  expect(MountResultSchema.parse({ outcome: "cancelled", path: "/x" })).toEqual(
    { outcome: "cancelled" },
  );
  for (const reason of MOUNT_REFUSALS) {
    expect(MountResultSchema.parse({ outcome: "refused", reason })).toEqual({
      outcome: "refused",
      reason,
    });
  }
  for (const value of [
    { outcome: "mounted" },
    { outcome: "mounted", mountId: "x" },
    { outcome: "refused", reason: "fatal: not a git repository" },
    { outcome: "refused" },
    { outcome: "done" },
  ]) {
    expect(MountResultSchema.safeParse(value).success).toBe(false);
  }
});

const DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const AUTHORIZE_URL =
  "https://api.mymandev.example/auth/github/authorize?code_challenge=x&state=y";

function accountStatus(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return {
    revision: 3,
    account: {
      kind: "signed_in",
      login: "octocat",
      displayName: "The Octocat",
      deviceId: DEVICE_ID,
    },
    signIn: { kind: "idle" },
    lastOutcome: null,
    deviceKey: "ready",
    replacementPending: false,
    apiOrigin: "set",
    device: "signed_in",
    ...overrides,
  };
}

test("an account status with every sign-in state, outcome, and key state is accepted", () => {
  const values: AccountStatus[] = [
    accountStatus(),
    accountStatus({ account: { kind: "signed_out" } }),
    accountStatus({ signIn: { kind: "starting" } }),
    accountStatus({ signIn: { kind: "completing" } }),
    accountStatus({
      signIn: { kind: "waiting", pairingCode: "012345", opened: true },
    }),
    accountStatus({
      signIn: {
        kind: "waiting",
        pairingCode: "999999",
        opened: false,
        authorizeUrl: AUTHORIZE_URL,
        warning: "Do not share this address.",
        browser: "default",
      },
    }),
    accountStatus({
      signIn: {
        kind: "waiting",
        pairingCode: "999999",
        opened: false,
        authorizeUrl: AUTHORIZE_URL,
        warning: "Do not share this address.",
        browser: "other",
      },
    }),
    accountStatus({
      lastOutcome: { code: "device_account_mismatch", deviceLogin: "hubot" },
    }),
    ...SIGN_IN_OUTCOME_CODES.map((code) =>
      accountStatus({ lastOutcome: { code } }),
    ),
    ...DEVICE_KEY_STATES.map((deviceKey) => accountStatus({ deviceKey })),
    ...API_ORIGIN_STATES.map((apiOrigin) => accountStatus({ apiOrigin })),
    accountStatus({ replacementPending: true }),
    ...DEVICE_STATES.map((device) => accountStatus({ device })),
  ];

  for (const value of values) {
    expect(AccountStatusSchema.parse(value)).toEqual(value);
  }
});

test("an account status keeps only the narrow fields", () => {
  const parsed = AccountStatusSchema.parse({
    ...accountStatus({
      signIn: {
        kind: "waiting",
        pairingCode: "123456",
        opened: false,
        authorizeUrl: AUTHORIZE_URL,
        warning: "Do not share this address.",
        browser: "other",
      },
    }),
    account: {
      kind: "signed_in",
      login: "octocat",
      displayName: "The Octocat",
      deviceId: DEVICE_ID,
      userId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4",
      publicKey: "ab".repeat(32),
      signInExpiresAt: "2026-12-02T10:00:00.000Z",
    },
    lastOutcome: { code: "signed_in", account: { login: "octocat" } },
    code: "mmdc_secret",
    codeVerifier: "verifier",
    accessToken: "mmda_secret",
  });

  expect(Object.keys(parsed.account).sort()).toEqual([
    "deviceId",
    "displayName",
    "kind",
    "login",
  ]);
  expect(JSON.stringify(parsed)).not.toMatch(
    /userId|publicKey|signInExpiresAt|mmdc_|verifier|mmda_|accessToken/,
  );
});

test("an account status with a wrong value is refused", () => {
  const waiting = {
    kind: "waiting",
    pairingCode: "123456",
    opened: false,
    authorizeUrl: AUTHORIZE_URL,
    warning: "Do not share this address.",
    browser: "other",
  } as const;
  for (const value of [
    accountStatus({ revision: -1 }),
    accountStatus({ deviceKey: "lost" as never }),
    accountStatus({ apiOrigin: "maybe" as never }),
    accountStatus({ device: "lost" as never }),
    accountStatus({ device: undefined as never }),
    accountStatus({ lastOutcome: { code: "fatal: no answer" as never } }),
    accountStatus({
      lastOutcome: { code: "device_account_mismatch", deviceLogin: "a b" },
    }),
    accountStatus({
      account: {
        kind: "signed_in",
        login: "-".repeat(40),
        displayName: "x",
        deviceId: DEVICE_ID,
      },
    }),
    accountStatus({
      account: {
        kind: "signed_in",
        login: "octocat",
        displayName: "",
        deviceId: DEVICE_ID,
      },
    }),
    accountStatus({
      account: {
        kind: "signed_in",
        login: "octocat",
        displayName: "x".repeat(ACCOUNT_LIMITS.displayName + 1),
        deviceId: DEVICE_ID,
      },
    }),
    accountStatus({
      account: {
        kind: "signed_in",
        login: "octocat",
        displayName: "x",
        deviceId: "not-a-uuid",
      },
    }),
    accountStatus({ signIn: { ...waiting, pairingCode: "12345" } }),
    accountStatus({ signIn: { ...waiting, pairingCode: "abcdef" } }),
    accountStatus({
      signIn: { kind: "waiting", pairingCode: "123456" } as never,
    }),
    accountStatus({
      signIn: {
        kind: "waiting",
        pairingCode: "123456",
        opened: false,
      } as never,
    }),
    accountStatus({
      signIn: { ...waiting, authorizeUrl: "javascript:alert(1)" },
    }),
    accountStatus({
      signIn: { ...waiting, authorizeUrl: "file:///etc/passwd" },
    }),
    accountStatus({
      signIn: {
        ...waiting,
        authorizeUrl: `${AUTHORIZE_URL}${"x".repeat(ACCOUNT_LIMITS.authorizeUrl)}`,
      },
    }),
    accountStatus({
      signIn: { ...waiting, warning: "x".repeat(ACCOUNT_LIMITS.warning + 1) },
    }),
    accountStatus({ signIn: { ...waiting, browser: "Other" as never } }),
    accountStatus({ signIn: { ...waiting, browser: undefined as never } }),
    accountStatus({ signIn: { kind: "open" } as never }),
  ]) {
    expect(AccountStatusSchema.safeParse(value).success).toBe(false);
  }
});

test("unlock takes exactly one passphrase string within the limit", () => {
  const { args } = INVOKE_CONTRACT[INVOKE_CHANNELS.unlockDeviceKey];

  expect(args.parse(["correct horse"])).toEqual(["correct horse"]);
  expect(args.parse(["x".repeat(ACCOUNT_LIMITS.passphrase)])).toHaveLength(1);
  for (const value of [
    [],
    [""],
    ["x".repeat(ACCOUNT_LIMITS.passphrase + 1)],
    ["a", "b"],
    [1],
    [null],
    [{ passphrase: "x" }],
    "correct horse",
  ]) {
    expect(args.safeParse(value).success).toBe(false);
  }
});

test("a refused passphrase is not repeated in the error", () => {
  const { args } = INVOKE_CONTRACT[INVOKE_CHANNELS.unlockDeviceKey];
  const result = args.safeParse([`secret-passphrase${"x".repeat(5000)}`]);

  expect(result.success).toBe(false);
  expect(JSON.stringify(result.error?.issues)).not.toContain(
    "secret-passphrase",
  );
});

test("the results of start, unlock, and forget hold only fixed values", () => {
  for (const value of [
    { outcome: "started" },
    ...START_SIGN_IN_REFUSALS.map((reason) => ({ outcome: "refused", reason })),
    ...SIGN_IN_OUTCOME_CODES.map((code) => ({ outcome: "failed", code })),
  ]) {
    expect(StartSignInResultSchema.parse(value)).toEqual(value);
  }
  for (const value of [
    { outcome: "unlocked" },
    { outcome: "failed" },
    ...UNLOCK_REFUSALS.map((reason) => ({ outcome: "refused", reason })),
  ]) {
    expect(UnlockResultSchema.parse(value)).toEqual(value);
  }
  for (const value of [
    { outcome: "forgotten", removedAtServer: true },
    { outcome: "forgotten", removedAtServer: false },
    { outcome: "cancelled" },
    { outcome: "failed" },
    ...FORGET_REFUSALS.map((reason) => ({ outcome: "refused", reason })),
  ]) {
    expect(ForgetResultSchema.parse(value)).toEqual(value);
  }
  expect(
    UnlockResultSchema.parse({ outcome: "unlocked", passphrase: "secret" }),
  ).toEqual({ outcome: "unlocked" });
  for (const [schema, value] of [
    [StartSignInResultSchema, { outcome: "refused", reason: "other" }],
    [StartSignInResultSchema, { outcome: "failed", code: "other" }],
    [UnlockResultSchema, { outcome: "refused", reason: "other" }],
    [ForgetResultSchema, { outcome: "refused", reason: "other" }],
    [ForgetResultSchema, { outcome: "deleted" }],
    [ForgetResultSchema, { outcome: "forgotten" }],
  ] as const) {
    expect(schema.safeParse(value).success).toBe(false);
  }
});

const DEVICE_VIEW = Object.freeze({
  id: DEVICE_ID,
  label: "Mac",
  platform: "macos",
  lastSeenAt: "2026-11-02T09:00:00.000Z",
  signInExpiresAt: "2026-12-02T10:00:00.000Z",
  revokedAt: null,
  current: true,
});

test("the results of sign-out, removal, and the device list hold only fixed values and the device fields", () => {
  const refusals = DEVICE_ACTION_REFUSALS.map((reason) => ({
    outcome: "refused",
    reason,
  }));
  const failures = DEVICE_ACTION_FAILURES.map((reason) => ({
    outcome: "failed",
    reason,
  }));
  for (const value of [
    { outcome: "signed_out" },
    { outcome: "pending" },
    ...refusals,
    ...failures,
  ]) {
    expect(SignOutResultSchema.parse(value)).toEqual(value);
  }
  for (const value of [
    { outcome: "removed" },
    { outcome: "pending" },
    { outcome: "cancelled" },
    ...refusals,
    ...failures,
  ]) {
    expect(RemoveDeviceResultSchema.parse(value)).toEqual(value);
  }
  for (const value of [
    { outcome: "listed", devices: [] },
    {
      outcome: "listed",
      devices: [
        DEVICE_VIEW,
        {
          ...DEVICE_VIEW,
          platform: "windows",
          lastSeenAt: null,
          revokedAt: "2026-11-02T10:00:00.000Z",
          current: false,
        },
      ],
    },
    ...refusals,
    ...failures,
  ]) {
    expect(ListDevicesResultSchema.parse(value)).toEqual(value);
  }

  // Unknown fields are dropped, also inside a device.
  const parsed = ListDevicesResultSchema.parse({
    outcome: "listed",
    devices: [{ ...DEVICE_VIEW, publicKey: "ab".repeat(32), userId: "x" }],
    accessToken: "mmda_secret",
  });
  expect(JSON.stringify(parsed)).not.toMatch(/publicKey|userId|mmda_/);
  expect(
    SignOutResultSchema.parse({ outcome: "pending", accessToken: "mmda_x" }),
  ).toEqual({ outcome: "pending" });

  for (const [schema, value] of [
    [SignOutResultSchema, { outcome: "failed", reason: "other" }],
    [SignOutResultSchema, { outcome: "refused", reason: "other" }],
    [SignOutResultSchema, { outcome: "removed" }],
    [RemoveDeviceResultSchema, { outcome: "signed_out" }],
    [RemoveDeviceResultSchema, { outcome: "failed" }],
    [ListDevicesResultSchema, { outcome: "listed" }],
    [
      ListDevicesResultSchema,
      {
        outcome: "listed",
        devices: Array.from(
          { length: ACCOUNT_LIMITS.devices + 1 },
          () => DEVICE_VIEW,
        ),
      },
    ],
    [
      ListDevicesResultSchema,
      { outcome: "listed", devices: [{ ...DEVICE_VIEW, id: "x" }] },
    ],
    [
      ListDevicesResultSchema,
      { outcome: "listed", devices: [{ ...DEVICE_VIEW, label: "" }] },
    ],
    [
      ListDevicesResultSchema,
      {
        outcome: "listed",
        devices: [
          { ...DEVICE_VIEW, label: "x".repeat(ACCOUNT_LIMITS.deviceLabel + 1) },
        ],
      },
    ],
    [
      ListDevicesResultSchema,
      { outcome: "listed", devices: [{ ...DEVICE_VIEW, platform: "android" }] },
    ],
    [
      ListDevicesResultSchema,
      {
        outcome: "listed",
        devices: [{ ...DEVICE_VIEW, lastSeenAt: "yesterday" }],
      },
    ],
    [
      ListDevicesResultSchema,
      { outcome: "listed", devices: [{ ...DEVICE_VIEW, current: "yes" }] },
    ],
  ] as const) {
    expect(schema.safeParse(value).success).toBe(false);
  }
});

test("sign-out, removal, and the device list take no argument", () => {
  for (const channel of [
    INVOKE_CHANNELS.signOut,
    INVOKE_CHANNELS.removeDevice,
    INVOKE_CHANNELS.listDevices,
  ]) {
    const { args } = INVOKE_CONTRACT[channel];
    expect(args.parse([])).toEqual([]);
    for (const value of [[undefined], [true], [{ deviceId: DEVICE_ID }]]) {
      expect(args.safeParse(value).success).toBe(false);
    }
  }
});

test("a connection status holds a reason and a retry time only where its state has them", () => {
  const accepted: unknown[] = [
    { state: "offline", revision: 0 },
    ...CONNECTION_OFFLINE_REASONS.map((reason) => ({
      state: "offline",
      reason,
      revision: 1,
    })),
    { state: "connecting", revision: 2 },
    { state: "authenticating", revision: 3 },
    { state: "connected", revision: 4 },
    ...CONNECTION_WAITING_REASONS.map((reason) => ({
      state: "waiting",
      reason,
      retryAt: "2026-11-03T10:00:01.000Z",
      revision: 5,
    })),
    ...CONNECTION_STOP_REASONS.map((reason) => ({
      state: "stopped",
      reason,
      revision: 6,
    })),
  ];
  for (const value of accepted) {
    expect(ConnectionStatusSchema.parse(value)).toEqual(value);
  }
  expect(
    new Set(accepted.map((value) => (value as { state: string }).state)),
  ).toEqual(new Set(CONNECTION_STATES));

  // Unknown keys are dropped, also a reason or a time where the state has none.
  expect(
    ConnectionStatusSchema.parse({
      state: "connected",
      reason: "connection_lost",
      retryAt: "2026-11-03T10:00:01.000Z",
      nonce: "secret",
      revision: 7,
    }),
  ).toEqual({ state: "connected", revision: 7 });

  for (const value of [
    { state: "waiting", reason: "connection_lost", revision: 1 },
    { state: "waiting", retryAt: "2026-11-03T10:00:01.000Z", revision: 1 },
    {
      state: "waiting",
      reason: "auth_failed",
      retryAt: "2026-11-03T10:00:01.000Z",
      revision: 1,
    },
    {
      state: "waiting",
      reason: "timeout",
      retryAt: "tomorrow",
      revision: 1,
    },
    { state: "stopped", revision: 1 },
    { state: "stopped", reason: "timeout", revision: 1 },
    { state: "offline", reason: "auth_failed", revision: 1 },
    { state: "online", revision: 1 },
    { state: "connected", revision: -1 },
    { state: "connected", revision: 1.5 },
    { state: "connected" },
  ]) {
    expect(ConnectionStatusSchema.safeParse(value).success).toBe(false);
  }
});

test("a reconnect result is reconnecting or refused with a known reason", () => {
  expect(ReconnectResultSchema.parse({ outcome: "reconnecting" })).toEqual({
    outcome: "reconnecting",
  });
  for (const reason of RECONNECT_REFUSALS) {
    expect(
      ReconnectResultSchema.parse({ outcome: "refused", reason, extra: 1 }),
    ).toEqual({ outcome: "refused", reason });
  }
  for (const value of [
    { outcome: "refused" },
    { outcome: "refused", reason: "busy" },
    { outcome: "connected" },
    true,
  ]) {
    expect(ReconnectResultSchema.safeParse(value).success).toBe(false);
  }
});

const WORKSPACE_ID = "019a5b2c-3d4e-7f60-8a1b-2c3d4e5f6a7b";
const PROJECT_ID = "019a5b2c-3d4e-7f60-9a1b-2c3d4e5f6a7c";

function workspaceView(overrides: Record<string, unknown> = {}) {
  return {
    revision: 3,
    status: "ready",
    workspaces: [{ id: WORKSPACE_ID, name: "Team" }],
    selectedWorkspaceId: WORKSPACE_ID,
    projects: [{ id: PROJECT_ID, name: "Desktop" }],
    openProjectId: PROJECT_ID,
    ...overrides,
  };
}

/** IDs that are not a lowercase UUIDv7, and values that are not strings. */
const NOT_PROTOCOL_IDS: readonly unknown[] = [
  "",
  "workspace",
  // A UUID of version 4, and of version 7 with a wrong variant.
  "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b70",
  "019a5b2c-3d4e-7f60-ca1b-2c3d4e5f6a7b",
  WORKSPACE_ID.toUpperCase(),
  `${WORKSPACE_ID} `,
  ` ${WORKSPACE_ID}`,
  `{${WORKSPACE_ID}}`,
  WORKSPACE_ID.replaceAll("-", ""),
  `${WORKSPACE_ID}${"0".repeat(10_000)}`,
  "x".repeat(1_000_000),
  1,
  true,
  {},
  { id: WORKSPACE_ID },
  [WORKSPACE_ID],
  undefined,
];

test("select takes exactly one lowercase UUIDv7 and refuses anything else", () => {
  const { args } = INVOKE_CONTRACT[INVOKE_CHANNELS.selectWorkspace];

  expect(args.parse([WORKSPACE_ID])).toEqual([WORKSPACE_ID]);
  for (const value of NOT_PROTOCOL_IDS) {
    expect(args.safeParse([value]).success, String(value)).toBe(false);
  }
  for (const value of [
    [],
    [null],
    [WORKSPACE_ID, WORKSPACE_ID],
    [WORKSPACE_ID, undefined],
    [WORKSPACE_ID, { force: true }],
    WORKSPACE_ID,
    undefined,
  ]) {
    expect(args.safeParse(value).success).toBe(false);
  }
});

test("open takes exactly one lowercase UUIDv7 or null and refuses anything else", () => {
  const { args } = INVOKE_CONTRACT[INVOKE_CHANNELS.openProject];

  expect(args.parse([PROJECT_ID])).toEqual([PROJECT_ID]);
  expect(args.parse([null])).toEqual([null]);
  for (const value of NOT_PROTOCOL_IDS) {
    expect(args.safeParse([value]).success, String(value)).toBe(false);
  }
  for (const value of [
    [],
    [PROJECT_ID, PROJECT_ID],
    [null, null],
    [PROJECT_ID, "extra"],
    PROJECT_ID,
    null,
  ]) {
    expect(args.safeParse(value).success).toBe(false);
  }
});

test("a refused ID is not repeated in the error", () => {
  const { args } = INVOKE_CONTRACT[INVOKE_CHANNELS.selectWorkspace];
  const result = args.safeParse(["secret-workspace"]);

  expect(result.success).toBe(false);
  expect(JSON.stringify(result.error?.issues)).not.toContain("secret");
});

test("a workspace view with every status is accepted, with a problem only while unavailable", () => {
  for (const status of ["signed_out", "loading", "ready"]) {
    expect(WorkspaceViewSchema.parse(workspaceView({ status }))).toEqual(
      workspaceView({ status }),
    );
  }
  for (const problem of WORKSPACE_PROBLEMS) {
    const value = workspaceView({ status: "unavailable", problem });
    expect(WorkspaceViewSchema.parse(value)).toEqual(value);
  }
  expect(WORKSPACE_STATUSES).toEqual([
    "signed_out",
    "loading",
    "ready",
    "unavailable",
  ]);
  const empty = workspaceView({
    status: "signed_out",
    workspaces: [],
    selectedWorkspaceId: null,
    projects: [],
    openProjectId: null,
  });
  expect(WorkspaceViewSchema.parse(empty)).toEqual(empty);

  // A problem where the status has none is dropped.
  expect(
    WorkspaceViewSchema.parse(workspaceView({ problem: "failed" })),
  ).toEqual(workspaceView());
});

test("a workspace view keeps only IDs and names, also of each workspace and project", () => {
  const parsed = WorkspaceViewSchema.parse(
    workspaceView({
      workspaces: [{ id: WORKSPACE_ID, name: "Team", role: "owner" }],
      projects: [
        {
          id: PROJECT_ID,
          name: "Desktop",
          createdByMemberId: WORKSPACE_ID,
          workspaceId: WORKSPACE_ID,
        },
      ],
      members: [{ displayName: "Someone" }],
      token: "secret",
    }),
  );

  expect(parsed).toEqual(workspaceView());
  expect(Object.keys(parsed).sort()).toEqual([
    "openProjectId",
    "projects",
    "revision",
    "selectedWorkspaceId",
    "status",
    "workspaces",
  ]);
});

test("a workspace view over the limits or with wrong values is refused", () => {
  const workspace = { id: WORKSPACE_ID, name: "Team" };
  const project = { id: PROJECT_ID, name: "Desktop" };
  expect(
    WorkspaceViewSchema.safeParse(
      workspaceView({
        workspaces: Array.from(
          { length: WORKSPACE_LIMITS.workspaces },
          () => workspace,
        ),
        projects: Array.from(
          { length: WORKSPACE_LIMITS.projects },
          () => project,
        ),
      }),
    ).success,
  ).toBe(true);
  // At the name limit in characters, also outside the Basic Multilingual Plane.
  expect(
    WorkspaceViewSchema.safeParse(
      workspaceView({
        workspaces: [
          { id: WORKSPACE_ID, name: "\u{1F600}".repeat(WORKSPACE_LIMITS.name) },
        ],
      }),
    ).success,
  ).toBe(true);

  for (const overrides of [
    {
      workspaces: Array.from(
        { length: WORKSPACE_LIMITS.workspaces + 1 },
        () => workspace,
      ),
    },
    {
      projects: Array.from(
        { length: WORKSPACE_LIMITS.projects + 1 },
        () => project,
      ),
    },
    {
      workspaces: [
        { id: WORKSPACE_ID, name: "x".repeat(WORKSPACE_LIMITS.name + 1) },
      ],
    },
    {
      projects: [
        { id: PROJECT_ID, name: "x".repeat(WORKSPACE_LIMITS.name + 1) },
      ],
    },
    { workspaces: [{ id: WORKSPACE_ID, name: "" }] },
    { workspaces: [{ id: WORKSPACE_ID.toUpperCase(), name: "Team" }] },
    { projects: [{ id: "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b70", name: "A" }] },
    { workspaces: [{ id: WORKSPACE_ID }] },
    { workspaces: {} },
    { selectedWorkspaceId: "workspace" },
    { selectedWorkspaceId: undefined },
    { openProjectId: 1 },
    { status: "unavailable" },
    { status: "unavailable", problem: "busy" },
    { status: "offline" },
    { revision: -1 },
    { revision: 1.5 },
  ]) {
    expect(
      WorkspaceViewSchema.safeParse(workspaceView(overrides)).success,
    ).toBe(false);
  }
});

test("a workspace action result is ok or refused with a known reason, without anything else", () => {
  expect(WorkspaceActionResultSchema.parse({ outcome: "ok", id: 1 })).toEqual({
    outcome: "ok",
  });
  expect(WORKSPACE_ACTION_REFUSALS).toEqual(["not_found", "too_soon"]);
  for (const reason of WORKSPACE_ACTION_REFUSALS) {
    expect(
      WorkspaceActionResultSchema.parse({
        outcome: "refused",
        reason,
        workspaceId: WORKSPACE_ID,
      }),
    ).toEqual({ outcome: "refused", reason });
  }
  for (const value of [
    { outcome: "refused" },
    { outcome: "refused", reason: "busy" },
    { outcome: "cancelled" },
    {},
    true,
    "ok",
  ]) {
    expect(WorkspaceActionResultSchema.safeParse(value).success).toBe(false);
  }
});

const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000f1";
const RUN_ID = "0192f0a0-7b3c-7d4e-8f50-000000001001";
const AGENT_PROJECT_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000e1";
const AGENT_WORKSPACE_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000a1";
const MEMBER_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000c1";
const AGENT_DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000d1";
const RUN_AT = "2026-11-05T10:00:00.000Z";

function agentRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    agentId: AGENT_ID,
    state: "running",
    reason: null,
    createdAt: RUN_AT,
    finishedAt: null,
    ...overrides,
  };
}

function agentActivity(overrides: Record<string, unknown> = {}) {
  return {
    status: "ready",
    revision: 3,
    workspaceId: AGENT_WORKSPACE_ID,
    projectId: AGENT_PROJECT_ID,
    agents: [
      {
        id: AGENT_ID,
        name: "Agent Alpha",
        ownerName: "Ada Lovelace",
        disabledAt: null,
      },
    ],
    unfinishedRuns: [agentRun()],
    moreUnfinishedRuns: 0,
    finishedRuns: [
      agentRun({
        state: "failed",
        reason: "Out of memory",
        finishedAt: RUN_AT,
      }),
    ],
    ...overrides,
  };
}

test("a protocol ID that is too long is refused with one issue, before the pattern runs", () => {
  const result = ProtocolIdSchema.safeParse("x".repeat(10_000));

  expect(result.success).toBe(false);
  expect(result.error?.issues).toHaveLength(1);
  expect(result.error?.issues[0]?.code).toBe("too_big");
});

test("an agent activity with every status, problem, and run state is accepted and frozen", () => {
  for (const status of AGENT_ACTIVITY_STATUSES) {
    if (status === "unavailable") {
      for (const problem of AGENT_ACTIVITY_PROBLEMS) {
        const value = agentActivity({ status, problem });
        expect(AgentActivityViewSchema.parse(value)).toEqual(value);
      }
      continue;
    }
    const value = agentActivity({ status });
    expect(AgentActivityViewSchema.parse(value)).toEqual(value);
  }
  const value = agentActivity({
    workspaceId: null,
    projectId: null,
    unfinishedRuns: AGENT_RUN_STATES.map((state) => agentRun({ state })),
    moreUnfinishedRuns: 12,
  });
  const parsed = AgentActivityViewSchema.parse(value);
  expect(parsed).toEqual(value);
  expect(Object.isFrozen(parsed.agents)).toBe(true);
  expect(Object.isFrozen(parsed.unfinishedRuns)).toBe(true);
  expect(Object.isFrozen(parsed.finishedRuns)).toBe(true);
});

test("an agent activity drops unknown keys at every level, so no member ID or device ID crosses", () => {
  const parsed = AgentActivityViewSchema.parse(
    agentActivity({
      problem: "failed",
      hostDeviceId: AGENT_DEVICE_ID,
      agents: [
        {
          id: AGENT_ID,
          name: "Agent Alpha",
          ownerName: "Ada Lovelace",
          ownerMemberId: MEMBER_ID,
          hostDeviceId: AGENT_DEVICE_ID,
          disabledAt: null,
        },
      ],
      unfinishedRuns: [
        agentRun({ projectId: AGENT_PROJECT_ID, repositoryId: MEMBER_ID }),
      ],
    }),
  );

  expect(parsed).toEqual(agentActivity());
  expect(JSON.stringify(parsed)).not.toContain(MEMBER_ID);
  expect(JSON.stringify(parsed)).not.toContain(AGENT_DEVICE_ID);
});

test("an agent activity over the limits or with wrong values is refused", () => {
  const agent = (overrides: Record<string, unknown>) => ({
    id: AGENT_ID,
    name: "Agent Alpha",
    ownerName: "Ada Lovelace",
    disabledAt: null,
    ...overrides,
  });
  const many = <T>(item: T, count: number) =>
    Array.from({ length: count }, () => item);
  for (const value of [
    agentActivity({ status: "unavailable" }),
    agentActivity({ status: "unavailable", problem: "busy" }),
    agentActivity({ status: "paused" }),
    agentActivity({ revision: -1 }),
    agentActivity({ revision: 1.5 }),
    agentActivity({ moreUnfinishedRuns: -1 }),
    agentActivity({ moreUnfinishedRuns: 0.5 }),
    agentActivity({ moreUnfinishedRuns: undefined }),
    agentActivity({ workspaceId: "workspace" }),
    agentActivity({ projectId: AGENT_PROJECT_ID.toUpperCase() }),
    agentActivity({
      agents: many(agent({}), AGENT_LIMITS.agents + 1),
    }),
    agentActivity({
      unfinishedRuns: many(agentRun(), AGENT_LIMITS.unfinishedRuns + 1),
    }),
    agentActivity({
      finishedRuns: many(
        agentRun({ state: "completed", finishedAt: RUN_AT }),
        AGENT_LIMITS.finishedRuns + 1,
      ),
    }),
    agentActivity({ agents: [agent({ name: "" })] }),
    agentActivity({
      agents: [agent({ name: "a".repeat(AGENT_LIMITS.agentName + 1) })],
    }),
    agentActivity({ agents: [agent({ ownerName: "" })] }),
    agentActivity({
      agents: [agent({ ownerName: "a".repeat(AGENT_LIMITS.ownerName + 1) })],
    }),
    agentActivity({ agents: [agent({ ownerName: undefined })] }),
    agentActivity({ agents: [agent({ disabledAt: "yesterday" })] }),
    agentActivity({ agents: [agent({ id: MOUNT_ID })] }),
    agentActivity({ unfinishedRuns: [agentRun({ state: "paused" })] }),
    agentActivity({ unfinishedRuns: [agentRun({ reason: "" })] }),
    agentActivity({
      unfinishedRuns: [
        agentRun({ reason: "a".repeat(AGENT_LIMITS.runReason + 1) }),
      ],
    }),
    agentActivity({ unfinishedRuns: [agentRun({ agentId: null })] }),
    agentActivity({ unfinishedRuns: [agentRun({ createdAt: "now" })] }),
  ]) {
    expect(AgentActivityViewSchema.safeParse(value).success).toBe(false);
  }

  // At the limits, everything is accepted.
  expect(
    AgentActivityViewSchema.safeParse(
      agentActivity({
        agents: [
          agent({
            name: "\u{1F600}".repeat(AGENT_LIMITS.agentName),
            ownerName: "a".repeat(AGENT_LIMITS.ownerName),
          }),
        ],
        unfinishedRuns: many(
          agentRun({ reason: "a".repeat(AGENT_LIMITS.runReason) }),
          AGENT_LIMITS.unfinishedRuns,
        ),
      }),
    ).success,
  ).toBe(true);
});
