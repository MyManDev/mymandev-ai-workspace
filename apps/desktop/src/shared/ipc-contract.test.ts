import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "./ipc-channels.ts";
import {
  ACCOUNT_LIMITS,
  AccountStatusSchema,
  API_ORIGIN_STATES,
  DEVICE_KEY_STATES,
  EVENT_CONTRACT,
  FORGET_REFUSALS,
  ForgetResultSchema,
  INVOKE_CONTRACT,
  MOUNT_REFUSALS,
  MountResultSchema,
  REPOSITORY_LIMITS,
  REPOSITORY_PROBLEMS,
  RepositoryListSchema,
  RUNTIME_STATES,
  RuntimeStatusSchema,
  SIGN_IN_OUTCOME_CODES,
  START_SIGN_IN_REFUSALS,
  StartSignInResultSchema,
  UNLOCK_REFUSALS,
  UnlockResultSchema,
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

test("the invoke channels except unmount and unlock take no arguments and refuse any", () => {
  const channels = Object.entries(INVOKE_CONTRACT).filter(
    ([channel]) =>
      channel !== INVOKE_CHANNELS.unmountRepository &&
      channel !== INVOKE_CHANNELS.unlockDeviceKey,
  );
  expect(channels).toHaveLength(Object.keys(INVOKE_CONTRACT).length - 2);
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
  } as const;
  for (const value of [
    accountStatus({ revision: -1 }),
    accountStatus({ deviceKey: "lost" as never }),
    accountStatus({ apiOrigin: "maybe" as never }),
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
    { outcome: "forgotten" },
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
  ] as const) {
    expect(schema.safeParse(value).success).toBe(false);
  }
});
