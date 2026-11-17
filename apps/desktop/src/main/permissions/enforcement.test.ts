import {
  CAPABILITIES,
  type Capability,
  type RepositoryId,
} from "@mymandev/protocol";
import {
  CAPABILITY_SCOPE,
  type GrantRecord,
  GrantRecordSchema,
} from "@mymandev/permissions";
import { expect, test } from "vitest";
import type { DeviceSessionState } from "../session/session.ts";
import {
  createPermissionEnforcement,
  ENFORCEMENT_DENIAL_REASONS,
  type EnforcementDenialReason,
  type EnforcementRecord,
  type EnforcementRecorder,
  type HeldRun,
  type PermissionEnforcementDependencies,
} from "./enforcement.ts";

const RUN_ID = "0192f0a0-7b3c-7d4e-8f50-000000000001";
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000002";
const OTHER_AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000003";
const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const OTHER_DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000005";
const PROJECT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000006";
const WORKSPACE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000007";
const USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000008";
const REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009";
const OTHER_REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000a";
const PROVIDER_CONNECTION_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000b";
const OTHER_PROVIDER_CONNECTION_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000c";
const GRANT_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000d";
const OTHER_GRANT_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000e";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const CREATED_AT = "2026-11-14T10:00:00.000Z";
const SIGN_IN_EXPIRES_AT = "2026-12-14T12:00:00.000Z";

/** Text that a requester could send, which no record may hold. */
const PATH = "../../etc/passwd";
const COMMAND = "git push --force origin main";
const FORBIDDEN_TEXT = [PATH, COMMAND, "etc/passwd", "git push"];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const RUN: HeldRun = Object.freeze({
  runId: RUN_ID,
  agentId: AGENT_ID,
  hostDeviceId: DEVICE_ID,
  repositoryId: REPOSITORY_ID,
  providerConnectionId: PROVIDER_CONNECTION_ID,
}) as HeldRun;

function run(overrides: Record<string, unknown> = {}): HeldRun {
  return Object.freeze({ ...RUN, ...overrides }) as HeldRun;
}

function scopeOf(capability: Capability): Record<string, string> {
  return CAPABILITY_SCOPE[capability] === "repository"
    ? { repositoryId: REPOSITORY_ID }
    : { providerConnectionId: PROVIDER_CONNECTION_ID };
}

/** A request of the run's agent on the run's scope. */
function request(
  capability: Capability,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    agentId: AGENT_ID,
    capability,
    ...scopeOf(capability),
    ...overrides,
  };
}

interface GrantOptions {
  agentId?: string;
  scopeId?: string;
  expiresAt?: string | null;
  revoked?: boolean;
  id?: string;
  /** The agent's host device in the facts; this device by default. */
  hostDeviceId?: string;
  /** The provider connection's host device; the agent's by default. */
  connectionHostDeviceId?: string;
}

/** An active grant of `capability` on the run's scope, with its facts. */
function grant(
  capability: Capability,
  options: GrantOptions = {},
): GrantRecord {
  const agentId = options.agentId ?? AGENT_ID;
  const hostDeviceId = options.hostDeviceId ?? DEVICE_ID;
  const isRepository = CAPABILITY_SCOPE[capability] === "repository";
  const scopeId =
    options.scopeId ?? (isRepository ? REPOSITORY_ID : PROVIDER_CONNECTION_ID);
  return GrantRecordSchema.parse({
    grant: {
      id: options.id ?? GRANT_ID,
      projectId: PROJECT_ID,
      granteeAgentId: agentId,
      capability,
      [isRepository ? "repositoryId" : "providerConnectionId"]: scopeId,
      grantedByUserId: USER_ID,
      createdAt: CREATED_AT,
      expiresAt: options.expiresAt ?? null,
      revokedAt: options.revoked === true ? CREATED_AT : null,
      revokedByUserId: options.revoked === true ? USER_ID : null,
    },
    facts: {
      agent: { id: agentId, hostDeviceId, disabledAt: null },
      hostDevice: { id: hostDeviceId, revokedAt: null },
      project: { id: PROJECT_ID, workspaceId: WORKSPACE_ID },
      grantorMembership: {
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        removedAt: null,
      },
      providerConnection: isRepository
        ? null
        : {
            id: scopeId,
            hostDeviceId: options.connectionHostDeviceId ?? hostDeviceId,
            removedAt: null,
          },
    },
  });
}

const ACCOUNT = Object.freeze({
  deviceId: DEVICE_ID,
  userId: USER_ID,
  login: "octocat",
  displayName: "The Octocat",
  signInExpiresAt: SIGN_IN_EXPIRES_AT,
});

function signedIn(overrides: Record<string, unknown> = {}): DeviceSessionState {
  return Object.freeze({
    kind: "signed_in",
    account: Object.freeze({ ...ACCOUNT, ...overrides }),
  }) as DeviceSessionState;
}

/** The fakes and what they saw. Each test changes `state` between calls. */
function setup(
  initial: {
    records?: readonly GrantRecord[];
    usable?: boolean;
  } = {},
) {
  const state = {
    nowMs: NOW,
    clock: null as null | (() => Date),
    usable: initial.usable ?? true,
    records: initial.records ?? ([] as readonly GrantRecord[]),
    read: null as null | (() => unknown),
    session: signedIn() as DeviceSessionState,
    sessionThrows: false,
    device: DEVICE_ID as unknown,
    deviceThrows: false,
    recorderThrows: false,
    /** What the recorder returns after it kept the record. */
    recorderResult: null as null | (() => unknown),
  };
  const calls = { clock: 0, store: 0, storeArgs: [] as unknown[][] };
  const records: EnforcementRecord[] = [];
  const dependencies: PermissionEnforcementDependencies = {
    now: () => {
      calls.clock += 1;
      return state.clock === null ? new Date(state.nowMs) : state.clock();
    },
    grantStore: {
      read: (...args: unknown[]) => {
        calls.store += 1;
        calls.storeArgs.push(args);
        if (state.read !== null) {
          return state.read() as never;
        }
        return { usable: state.usable, records: state.records };
      },
    },
    sessionState: () => {
      if (state.sessionThrows) {
        throw new Error("session failed");
      }
      return state.session;
    },
    thisDevice: () => {
      if (state.deviceThrows) {
        throw new Error("device failed");
      }
      return state.device as never;
    },
    recorder: {
      record: (entry) => {
        if (state.recorderThrows) {
          throw new Error("recorder failed");
        }
        records.push(entry);
        if (state.recorderResult !== null) {
          return state.recorderResult() as never;
        }
        return undefined;
      },
    },
  };
  const enforcement = createPermissionEnforcement(dependencies);
  return { enforcement, state, calls, records, dependencies };
}

/** The denial record of the run for `reason`, at `at`. */
function denial(
  reason: EnforcementDenialReason,
  capability: Capability | null,
  at: string | null = iso(NOW),
  heldRun: HeldRun | null = RUN,
): EnforcementRecord {
  return {
    kind: "denied",
    reason,
    capability,
    runId: heldRun?.runId ?? null,
    agentId: heldRun?.agentId ?? null,
    repositoryId: heldRun?.repositoryId ?? null,
    providerConnectionId: heldRun?.providerConnectionId ?? null,
    at,
  };
}

function expectDenied(
  harness: ReturnType<typeof setup>,
  heldRun: HeldRun,
  raw: unknown,
  reason: EnforcementDenialReason,
): void {
  const before = harness.records.length;
  const decision = harness.enforcement.check(heldRun, raw);
  expect(decision).toEqual({ allowed: false, reason });
  expect(Object.isFrozen(decision)).toBe(true);
  // Exactly one record, the denial.
  expect(harness.records.length).toBe(before + 1);
  const entry = harness.records.at(-1);
  expect(entry?.kind).toBe("denied");
  expect(entry && "reason" in entry ? entry.reason : null).toBe(reason);
}

test("the denial reasons are a closed list", () => {
  expect(ENFORCEMENT_DENIAL_REASONS).toEqual([
    "run_invalid",
    "request_invalid",
    "no_scope",
    "request_mismatch",
    "device_unknown",
    "not_this_device",
    "signed_out",
    "sign_in_invalid",
    "store_unusable",
    "clock_invalid",
    "no_grant",
    "record_failed",
    "check_failed",
  ]);
  expect(Object.isFrozen(ENFORCEMENT_DENIAL_REASONS)).toBe(true);
});

test("allows a request with an active grant and acts on the run's request", () => {
  const harness = setup({ records: [grant("repo.read")] });
  const decision = harness.enforcement.check(RUN, request("repo.read"));
  expect(decision).toEqual({
    allowed: true,
    request: {
      agentId: AGENT_ID,
      capability: "repo.read",
      repositoryId: REPOSITORY_ID,
    },
  });
  expect(Object.isFrozen(decision)).toBe(true);
  expect(decision.allowed && Object.isFrozen(decision.request)).toBe(true);
  // Only denials and shell starts are recorded.
  expect(harness.records).toEqual([]);
  expect(harness.calls.store).toBe(1);
  expect(harness.calls.clock).toBe(1);
});

test("allows `provider.use` on the run's provider connection only", () => {
  const harness = setup({ records: [grant("provider.use")] });
  expect(harness.enforcement.check(RUN, request("provider.use"))).toEqual({
    allowed: true,
    request: {
      agentId: AGENT_ID,
      capability: "provider.use",
      providerConnectionId: PROVIDER_CONNECTION_ID,
    },
  });
  expectDenied(
    harness,
    run({ providerConnectionId: null }),
    request("provider.use"),
    "no_scope",
  );
});

test("records an allowed start of `terminal.execute` with the agent, the repository, and the time", () => {
  const harness = setup({ records: [grant("terminal.execute")] });
  const decision = harness.enforcement.check(RUN, request("terminal.execute"));
  expect(decision.allowed).toBe(true);
  expect(harness.records).toEqual([
    {
      kind: "shell_start_allowed",
      runId: RUN_ID,
      agentId: AGENT_ID,
      repositoryId: REPOSITORY_ID,
      at: iso(NOW),
    },
  ]);
  expect(Object.isFrozen(harness.records[0])).toBe(true);
  expect(harness.calls.clock).toBe(1);
});

test("denies an allowed shell start that cannot be recorded", () => {
  const harness = setup({ records: [grant("terminal.execute")] });
  harness.state.recorderThrows = true;
  expect(harness.enforcement.check(RUN, request("terminal.execute"))).toEqual({
    allowed: false,
    reason: "record_failed",
  });
  // Another capability does not need a record to be allowed.
  const read = setup({ records: [grant("repo.read")] });
  read.state.recorderThrows = true;
  expect(read.enforcement.check(RUN, request("repo.read")).allowed).toBe(true);
  // A denial that cannot be recorded still denies, without throwing.
  read.state.usable = false;
  expect(read.enforcement.check(RUN, request("repo.read"))).toEqual({
    allowed: false,
    reason: "store_unusable",
  });
});

test("denies a malformed run, without its IDs in the record", () => {
  const harness = setup({ records: [grant("repo.read")] });
  const malformed: unknown[] = [
    null,
    undefined,
    "run",
    {},
    { ...RUN, runId: "not-an-id" },
    { ...RUN, hostDeviceId: undefined },
    { ...RUN, repositoryId: PATH },
    { ...RUN, providerConnectionId: undefined },
    {
      ...RUN,
      get agentId(): string {
        throw new Error("getter");
      },
    },
  ];
  for (const value of malformed) {
    expectDenied(
      harness,
      value as HeldRun,
      request("repo.read"),
      "run_invalid",
    );
    expect(harness.records.at(-1)).toEqual(
      denial("run_invalid", null, iso(NOW), null),
    );
  }
  expect(harness.calls.store).toBe(0);
});

test("denies a malformed request and records no part of it", () => {
  const harness = setup({ records: CAPABILITIES.map((c) => grant(c)) });
  const inherited = Object.create({ agentId: AGENT_ID });
  Object.assign(inherited, {
    capability: "repo.read",
    repositoryId: REPOSITORY_ID,
  });
  const malformed: unknown[] = [
    null,
    undefined,
    COMMAND,
    [request("repo.read")],
    {},
    { capability: "repo.read" },
    request("repo.read", { capability: "terminal.*" }),
    request("repo.read", { capability: "*" }),
    request("repo.read", { capability: "REPO.READ" }),
    request("repo.read", { capability: COMMAND }),
    request("repo.read", { agentId: "not-an-id" }),
    request("repo.read", { repositoryId: PATH }),
    { agentId: AGENT_ID, capability: "repo.read" },
    // The scope of the other kind.
    {
      agentId: AGENT_ID,
      capability: "provider.use",
      repositoryId: REPOSITORY_ID,
    },
    // A missing field is never taken from a prototype.
    inherited,
    // An accessor is not plain data, also when it answers the right value.
    Object.defineProperty(
      { capability: "repo.read", repositoryId: REPOSITORY_ID },
      "agentId",
      { enumerable: true, get: () => AGENT_ID },
    ),
    Object.defineProperty({}, "capability", {
      enumerable: true,
      get: () => {
        throw new Error("getter");
      },
    }),
  ];
  for (const value of malformed) {
    expectDenied(harness, RUN, value, "request_invalid");
    expect(harness.records.at(-1)).toEqual(denial("request_invalid", null));
  }
  expect(harness.calls.store).toBe(0);
});

test("denies `terminal.execute` and every repository capability in a run without a repository", () => {
  const harness = setup({ records: CAPABILITIES.map((c) => grant(c)) });
  const noRepository = run({ repositoryId: null });
  for (const capability of CAPABILITIES) {
    if (CAPABILITY_SCOPE[capability] !== "repository") continue;
    expectDenied(harness, noRepository, request(capability), "no_scope");
    expect(harness.records.at(-1)).toEqual(
      denial("no_scope", capability, iso(NOW), noRepository),
    );
  }
  expect(harness.calls.store).toBe(0);
});

test("denies a request for another agent or another scope than the run's", () => {
  // The other agent and the other scopes hold active grants: the requester
  // still cannot move the check to them.
  const harness = setup({
    records: [
      grant("repo.read"),
      grant("repo.read", { agentId: OTHER_AGENT_ID, id: OTHER_GRANT_ID }),
      grant("repo.read", { scopeId: OTHER_REPOSITORY_ID, id: OTHER_GRANT_ID }),
      grant("provider.use", {
        scopeId: OTHER_PROVIDER_CONNECTION_ID,
        id: OTHER_GRANT_ID,
      }),
    ],
  });
  const cases: [unknown, Capability][] = [
    [request("repo.read", { agentId: OTHER_AGENT_ID }), "repo.read"],
    [request("repo.read", { repositoryId: OTHER_REPOSITORY_ID }), "repo.read"],
    [
      request("provider.use", {
        providerConnectionId: OTHER_PROVIDER_CONNECTION_ID,
      }),
      "provider.use",
    ],
  ];
  for (const [raw, capability] of cases) {
    expectDenied(harness, RUN, raw, "request_mismatch");
    expect(harness.records.at(-1)).toEqual(
      denial("request_mismatch", capability),
    );
  }
  expect(harness.calls.store).toBe(0);
});

test("denies while this device is not known", () => {
  const harness = setup({ records: [grant("repo.read")] });
  for (const device of [null, undefined, "", "not-an-id", 42, {}]) {
    harness.state.device = device;
    expectDenied(harness, RUN, request("repo.read"), "device_unknown");
  }
  harness.state.device = DEVICE_ID;
  harness.state.deviceThrows = true;
  expectDenied(harness, RUN, request("repo.read"), "device_unknown");
  expect(harness.records.at(-1)).toEqual(denial("device_unknown", "repo.read"));
  expect(harness.calls.store).toBe(0);
});

test("denies an agent that is hosted on another device", () => {
  const harness = setup({ records: [grant("repo.read")] });
  const elsewhere = run({ hostDeviceId: OTHER_DEVICE_ID });
  expectDenied(harness, elsewhere, request("repo.read"), "not_this_device");
  expect(harness.records.at(-1)).toEqual(
    denial("not_this_device", "repo.read", iso(NOW), elsewhere),
  );
  // Nor does this device pass when it is the other device.
  harness.state.device = OTHER_DEVICE_ID;
  harness.state.session = signedIn({ deviceId: OTHER_DEVICE_ID });
  expectDenied(harness, RUN, request("repo.read"), "not_this_device");
  expect(harness.calls.store).toBe(0);
});

test("denies while the device is signed out, whatever the other state", () => {
  const harness = setup({ records: [grant("repo.read")] });
  const states: DeviceSessionState[] = [
    { kind: "signed_out", account: ACCOUNT, reportPending: false },
    { kind: "signed_out", account: ACCOUNT, reportPending: true },
    { kind: "key_not_loaded", account: ACCOUNT, signedOut: true },
    { kind: "key_lost", account: ACCOUNT, signedOut: true },
    { kind: "account_mismatch", account: ACCOUNT, signedOut: true },
    { kind: "unavailable", reason: "record_unreadable", signedOut: true },
  ] as DeviceSessionState[];
  for (const session of states) {
    harness.state.session = session;
    expectDenied(harness, RUN, request("repo.read"), "signed_out");
  }
  expect(harness.records.at(-1)).toEqual(denial("signed_out", "repo.read"));
  expect(harness.calls.store).toBe(0);
});

test("denies while the sign-in is not valid", () => {
  const harness = setup({ records: [grant("repo.read")] });
  const states: DeviceSessionState[] = [
    { kind: "starting" },
    { kind: "no_device" },
    { kind: "key_lost", account: ACCOUNT },
    { kind: "unavailable", reason: "key_store_failed" },
    { kind: "key_not_loaded", account: ACCOUNT },
    { kind: "sign_in_required", account: ACCOUNT },
    { kind: "auth_failed", account: ACCOUNT },
    { kind: "account_mismatch", account: ACCOUNT },
    { kind: "removal_pending", account: ACCOUNT },
    { kind: "removed" },
    { kind: "revoked" },
    // Signed in, but for another device.
    signedIn({ deviceId: OTHER_DEVICE_ID }),
    // Signed in, but the sign-in has ended, or its end cannot be read.
    signedIn({ signInExpiresAt: iso(NOW) }),
    signedIn({ signInExpiresAt: iso(NOW - 1) }),
    signedIn({ signInExpiresAt: "2026-12-14" }),
    signedIn({ signInExpiresAt: undefined }),
    { kind: "signed_in" },
    { kind: "unknown", account: ACCOUNT },
  ] as DeviceSessionState[];
  for (const session of states) {
    harness.state.session = session;
    expectDenied(harness, RUN, request("repo.read"), "sign_in_invalid");
    expect(harness.records.at(-1)).toEqual(
      denial("sign_in_invalid", "repo.read"),
    );
  }
  harness.state.session = signedIn();
  harness.state.sessionThrows = true;
  expectDenied(harness, RUN, request("repo.read"), "sign_in_invalid");
  // One millisecond before its end, the sign-in is valid.
  harness.state.sessionThrows = false;
  harness.state.session = signedIn({ signInExpiresAt: iso(NOW + 1) });
  expect(harness.enforcement.check(RUN, request("repo.read")).allowed).toBe(
    true,
  );
});

test("denies when the grant store is not usable, also with an active grant in it", () => {
  const harness = setup({ records: [grant("repo.read")], usable: false });
  expectDenied(harness, RUN, request("repo.read"), "store_unusable");
  expect(harness.records.at(-1)).toEqual(denial("store_unusable", "repo.read"));
  const answers: (() => unknown)[] = [
    () => ({ usable: "true", records: [grant("repo.read")] }),
    () => ({ usable: 1, records: [grant("repo.read")] }),
    () => ({ records: [grant("repo.read")] }),
    () => null,
    () => {
      throw new Error("store failed");
    },
  ];
  for (const answer of answers) {
    harness.state.read = answer;
    expectDenied(harness, RUN, request("repo.read"), "store_unusable");
  }
});

test("denies when the clock gives no valid time", () => {
  const harness = setup({ records: [grant("repo.read")] });
  const clocks: (() => Date)[] = [
    () => new Date(Number.NaN),
    () => ({ getTime: () => NOW }) as unknown as Date,
    () => Object.create(Date.prototype) as Date,
    () => NOW as unknown as Date,
    () => {
      throw new Error("clock failed");
    },
  ];
  for (const clock of clocks) {
    harness.state.clock = clock;
    const before = harness.calls.clock;
    expectDenied(harness, RUN, request("repo.read"), "clock_invalid");
    expect(harness.records.at(-1)).toEqual(
      denial("clock_invalid", "repo.read", null),
    );
    // The clock is not read again for the record.
    expect(harness.calls.clock).toBe(before + 1);
  }
});

test("denies without an active grant of exactly this capability on exactly this scope", () => {
  const cases: (readonly GrantRecord[])[] = [
    [],
    [grant("repo.read", { revoked: true })],
    [grant("repo.read", { expiresAt: iso(NOW) })],
    [grant("repo.read", { agentId: OTHER_AGENT_ID })],
    [grant("repo.read", { scopeId: OTHER_REPOSITORY_ID })],
    // No capability grants another.
    CAPABILITIES.filter((c) => c !== "repo.read").map((c) => grant(c)),
  ];
  for (const records of cases) {
    const harness = setup({ records });
    expectDenied(harness, RUN, request("repo.read"), "no_grant");
    expect(harness.records).toEqual([denial("no_grant", "repo.read")]);
    expect(harness.calls.store).toBe(1);
    expect(harness.calls.clock).toBe(1);
  }
  // `terminal.execute` grants nothing else, and nothing grants it.
  const shell = setup({ records: [grant("terminal.execute")] });
  for (const capability of CAPABILITIES) {
    if (capability === "terminal.execute") continue;
    expectDenied(shell, RUN, request(capability), "no_grant");
  }
  const others = setup({
    records: CAPABILITIES.filter((c) => c !== "terminal.execute").map((c) =>
      grant(c),
    ),
  });
  expectDenied(others, RUN, request("terminal.execute"), "no_grant");
  expect(others.records).toEqual([denial("no_grant", "terminal.execute")]);
});

test("reads the clock on every call, so a grant that expires between two calls denies the second", () => {
  const expiresAt = NOW + 1_000;
  const harness = setup({
    records: [grant("terminal.execute", { expiresAt: iso(expiresAt) })],
  });
  expect(
    harness.enforcement.check(RUN, request("terminal.execute")).allowed,
  ).toBe(true);
  expect(harness.calls.clock).toBe(1);

  harness.state.nowMs = expiresAt - 1;
  expect(
    harness.enforcement.check(RUN, request("terminal.execute")).allowed,
  ).toBe(true);
  expect(harness.calls.clock).toBe(2);

  harness.state.nowMs = expiresAt;
  expect(harness.enforcement.check(RUN, request("terminal.execute"))).toEqual({
    allowed: false,
    reason: "no_grant",
  });
  expect(harness.calls.clock).toBe(3);

  expect(harness.records).toEqual([
    {
      kind: "shell_start_allowed",
      runId: RUN_ID,
      agentId: AGENT_ID,
      repositoryId: REPOSITORY_ID,
      at: iso(NOW),
    },
    {
      kind: "shell_start_allowed",
      runId: RUN_ID,
      agentId: AGENT_ID,
      repositoryId: REPOSITORY_ID,
      at: iso(expiresAt - 1),
    },
    denial("no_grant", "terminal.execute", iso(expiresAt)),
  ]);
});

test("reads the clock once on every path", () => {
  const harness = setup({ records: [grant("repo.read")] });
  harness.enforcement.check(RUN, request("repo.read"));
  harness.enforcement.check(RUN, null);
  harness.enforcement.check(null as unknown as HeldRun, request("repo.read"));
  harness.state.usable = false;
  harness.enforcement.check(RUN, request("repo.read"));
  expect(harness.calls.clock).toBe(4);
});

test("never caches a decision", () => {
  const harness = setup({ records: [grant("repo.read")] });
  const check = () => harness.enforcement.check(RUN, request("repo.read"));
  expect(check().allowed).toBe(true);
  harness.state.records = [grant("repo.read", { revoked: true })];
  expect(check()).toEqual({ allowed: false, reason: "no_grant" });
  harness.state.records = [grant("repo.read")];
  expect(check().allowed).toBe(true);
  harness.state.session = {
    kind: "signed_out",
    account: ACCOUNT,
    reportPending: false,
  } as DeviceSessionState;
  expect(check()).toEqual({ allowed: false, reason: "signed_out" });
  harness.state.session = signedIn();
  expect(check().allowed).toBe(true);
  harness.state.device = OTHER_DEVICE_ID;
  expect(check()).toEqual({ allowed: false, reason: "not_this_device" });
});

test("reads the grant store once per check, with no input from the request", () => {
  const harness = setup({ records: [grant("repo.read")] });
  // A store whose second read would grant something else.
  let reads = 0;
  harness.state.read = () => {
    reads += 1;
    return reads % 2 === 1
      ? { usable: true, records: [grant("repo.read", { revoked: true })] }
      : { usable: true, records: [grant("repo.read")] };
  };
  expect(harness.enforcement.check(RUN, request("repo.read"))).toEqual({
    allowed: false,
    reason: "no_grant",
  });
  expect(harness.calls.store).toBe(1);
  harness.state.read = null;
  harness.enforcement.check(RUN, request("repo.read"));
  harness.enforcement.check(RUN, request("terminal.execute"));
  expect(harness.calls.store).toBe(3);
  expect(harness.calls.storeArgs).toEqual([[], [], []]);
});

test("ignores every field of the request beyond the capability, its agent, and its scope", () => {
  const harness = setup({ records: [grant("repo.read")] });
  const raw = request("repo.read", {
    providerConnectionId: OTHER_PROVIDER_CONNECTION_ID,
    hostDeviceId: OTHER_DEVICE_ID,
    runId: OTHER_GRANT_ID,
    now: "2020-01-01T00:00:00.000Z",
    usable: true,
    records: [grant("repo.write")],
    allowed: true,
    path: PATH,
    command: COMMAND,
    cwd: PATH,
  });
  expect(harness.enforcement.check(RUN, raw)).toEqual({
    allowed: true,
    request: {
      agentId: AGENT_ID,
      capability: "repo.read",
      repositoryId: REPOSITORY_ID,
    },
  });
  // A requester's records and time never grant.
  const empty = setup();
  expectDenied(
    empty,
    RUN,
    request("repo.write", {
      records: [grant("repo.write")],
      now: CREATED_AT,
      usable: true,
    }),
    "no_grant",
  );
  // Nor does a requester's device move the check to its agent.
  expectDenied(
    harness,
    run({ hostDeviceId: OTHER_DEVICE_ID }),
    request("repo.read", { hostDeviceId: DEVICE_ID }),
    "not_this_device",
  );
  // The raw request is not changed.
  expect(raw).toMatchObject({ path: PATH, command: COMMAND });
});

test("records only IDs, closed vocabularies, and times, never a path or a command", () => {
  const harness = setup({ records: [grant("terminal.execute")] });
  harness.enforcement.check(
    RUN,
    request("terminal.execute", { cwd: PATH, command: COMMAND }),
  );
  harness.enforcement.check(RUN, { capability: COMMAND, repositoryId: PATH });
  harness.enforcement.check(
    RUN,
    request("terminal.execute", { repositoryId: PATH, command: COMMAND }),
  );
  harness.enforcement.check(
    RUN,
    request("terminal.execute", {
      repositoryId: OTHER_REPOSITORY_ID,
      command: COMMAND,
    }),
  );
  harness.enforcement.check(
    { ...RUN, repositoryId: PATH } as unknown as HeldRun,
    request("terminal.execute", { command: COMMAND }),
  );
  harness.enforcement.check(RUN, request("repo.write", { path: PATH }));
  expect(harness.records).toEqual([
    {
      kind: "shell_start_allowed",
      runId: RUN_ID,
      agentId: AGENT_ID,
      repositoryId: REPOSITORY_ID,
      at: iso(NOW),
    },
    denial("request_invalid", null),
    denial("request_invalid", null),
    denial("request_mismatch", "terminal.execute"),
    denial("run_invalid", null, iso(NOW), null),
    denial("no_grant", "repo.write"),
  ]);
  const allowedKeys = new Set([
    "kind",
    "reason",
    "capability",
    "runId",
    "agentId",
    "repositoryId",
    "providerConnectionId",
    "at",
  ]);
  for (const entry of harness.records) {
    expect(Object.isFrozen(entry)).toBe(true);
    for (const key of Object.keys(entry)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    const text = JSON.stringify(entry);
    for (const forbidden of FORBIDDEN_TEXT) {
      expect(text).not.toContain(forbidden);
    }
  }
});

test("takes the dependencies once, when it is created", () => {
  const harness = setup({ records: [grant("repo.read")] });
  const mutable = harness.dependencies as {
    -readonly [
      K in keyof PermissionEnforcementDependencies
    ]: PermissionEnforcementDependencies[K];
  };
  mutable.grantStore = {
    read: () => ({ usable: true, records: [] }),
  };
  mutable.thisDevice = () => OTHER_DEVICE_ID as never;
  expect(harness.enforcement.check(RUN, request("repo.read")).allowed).toBe(
    true,
  );
  expect(Object.isFrozen(harness.enforcement)).toBe(true);
});

/** The record of an allowed shell start of the run at `at`. */
function shellStart(at: string = iso(NOW)): EnforcementRecord {
  return {
    kind: "shell_start_allowed",
    runId: RUN.runId,
    agentId: RUN.agentId,
    repositoryId: RUN.repositoryId as RepositoryId,
    at,
  };
}

/** A copy of `value` without `key`. */
function without(value: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
}

/**
 * A proxy whose own data property `key` answers the next of `own` on every
 * read of its descriptor (`Object.keys` reads it too), and `get` on every
 * plain read. `gets` counts the plain reads.
 */
function changing(
  target: object,
  key: string,
  values: { own: readonly unknown[]; get: unknown },
) {
  let ownReads = 0;
  let gets = 0;
  const proxy = new Proxy<Record<string, unknown>>(
    { ...target },
    {
      get: (object, property, receiver) => {
        if (property !== key) {
          return Reflect.get(object, property, receiver);
        }
        gets += 1;
        return values.get;
      },
      getOwnPropertyDescriptor: (object, property) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(object, property);
        if (property !== key || descriptor === undefined) {
          return descriptor;
        }
        const value = values.own[Math.min(ownReads, values.own.length - 1)];
        ownReads += 1;
        return { ...descriptor, value };
      },
    },
  );
  return { proxy, gets: () => gets };
}

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

function throwingKeys(target: object): object {
  return new Proxy(
    { ...target },
    {
      ownKeys: () => {
        throw new Error("keys");
      },
    },
  );
}

/** Runs `body` with `Object.prototype` polluted, and always cleans it up. */
function withPollution(fields: Record<string, unknown>, body: () => void) {
  const prototype = Object.prototype as Record<string, unknown>;
  try {
    for (const [key, value] of Object.entries(fields)) {
      prototype[key] = value;
    }
    body();
  } finally {
    for (const key of Object.keys(fields)) {
      delete prototype[key];
    }
  }
}

test("a recorder is synchronous", () => {
  const recorder: EnforcementRecorder = {
    // @ts-expect-error An async recorder is not a recorder.
    async record() {},
  };
  expect(typeof recorder.record).toBe("function");
});

test("denies a shell start when the recorder answers with anything but undefined, and leaves no unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const results: (() => unknown)[] = [
      () => Promise.resolve(),
      () => Promise.resolve(undefined),
      () => Promise.reject(new Error("disk full")),
      () => ({
        then: (_: unknown, reject: (e: Error) => void) =>
          reject(new Error("disk full")),
      }),
      () => true,
      () => null,
      () => 0,
      // Stores the record, then fails.
      () => {
        throw new Error("disk full");
      },
    ];
    for (const result of results) {
      const harness = setup({ records: [grant("terminal.execute")] });
      harness.state.recorderResult = result;
      expect(
        harness.enforcement.check(RUN, request("terminal.execute")),
      ).toEqual({
        allowed: false,
        reason: "record_failed",
      });
      // The recorder kept both: the start, and the denial that followed it.
      expect(harness.records).toEqual([
        shellStart(),
        denial("record_failed", "terminal.execute"),
      ]);
    }
    // An async recorder, as the reviews tried it.
    for (const record of [
      async () => {
        throw new Error("disk full");
      },
      async () => undefined,
    ]) {
      const harness = setup({ records: [grant("terminal.execute")] });
      const enforcement = createPermissionEnforcement({
        ...harness.dependencies,
        recorder: { record } as unknown as EnforcementRecorder,
      });
      expect(enforcement.check(RUN, request("terminal.execute"))).toEqual({
        allowed: false,
        reason: "record_failed",
      });
      // A denial answered with a rejected promise still denies.
      harness.state.usable = false;
      expect(enforcement.check(RUN, request("terminal.execute"))).toEqual({
        allowed: false,
        reason: "store_unusable",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("reads the run as plain own data, also with a polluted Object.prototype", () => {
  const harness = setup({
    records: [
      grant("repo.read", { scopeId: OTHER_REPOSITORY_ID }),
      grant("provider.use", {
        scopeId: OTHER_PROVIDER_CONNECTION_ID,
        id: OTHER_GRANT_ID,
      }),
    ],
  });
  withPollution(
    {
      repositoryId: OTHER_REPOSITORY_ID,
      providerConnectionId: OTHER_PROVIDER_CONNECTION_ID,
    },
    () => {
      expectDenied(
        harness,
        without(RUN, "repositoryId") as unknown as HeldRun,
        request("repo.read", { repositoryId: OTHER_REPOSITORY_ID }),
        "run_invalid",
      );
      expectDenied(
        harness,
        without(RUN, "providerConnectionId") as unknown as HeldRun,
        request("provider.use", {
          providerConnectionId: OTHER_PROVIDER_CONNECTION_ID,
        }),
        "run_invalid",
      );
    },
  );
  const malformed: unknown[] = [
    Object.create(RUN),
    Object.assign(
      Object.create({ repositoryId: REPOSITORY_ID }),
      without(RUN, "repositoryId"),
    ),
    revokedProxy(),
    throwingKeys(RUN),
  ];
  for (const value of malformed) {
    expectDenied(
      harness,
      value as HeldRun,
      request("repo.read"),
      "run_invalid",
    );
    expect(harness.records.at(-1)).toEqual(
      denial("run_invalid", null, iso(NOW), null),
    );
  }
  expect(harness.calls.store).toBe(0);
});

test("uses only the parsed copy of the run", () => {
  const harness = setup({ records: [grant("repo.read")] });
  // Its own data names the run's repository; a plain read names another.
  const { proxy, gets } = changing(RUN, "repositoryId", {
    own: [REPOSITORY_ID],
    get: OTHER_REPOSITORY_ID,
  });
  expect(
    harness.enforcement.check(
      proxy as unknown as HeldRun,
      request("repo.read"),
    ),
  ).toEqual({
    allowed: true,
    request: {
      agentId: AGENT_ID,
      capability: "repo.read",
      repositoryId: REPOSITORY_ID,
    },
  });
  expect(gets()).toBe(0);
});

test("denies a request that cannot be read with one frozen denial", () => {
  const harness = setup({ records: [grant("repo.read")] });
  for (const value of [revokedProxy(), throwingKeys(request("repo.read"))]) {
    expectDenied(harness, RUN, value, "request_invalid");
    expect(harness.records.at(-1)).toEqual(denial("request_invalid", null));
  }
  expect(harness.records).toHaveLength(2);
});

test("reads the store's answer as plain own data, also with a polluted Object.prototype", () => {
  const harness = setup();
  const answers: (() => unknown)[] = [
    () => Object.create({ usable: true, records: [grant("repo.read")] }),
    () =>
      Object.assign(Object.create({ usable: true }), {
        records: [grant("repo.read")],
      }),
    () =>
      Object.defineProperty({ records: [grant("repo.read")] }, "usable", {
        enumerable: true,
        get: () => true,
      }),
    () => ({ usable: true, records: Object.create([grant("repo.read")]) }),
    () => ({ usable: true, records: { 0: grant("repo.read"), length: 1 } }),
    () => revokedProxy(),
    () => throwingKeys({ usable: true, records: [grant("repo.read")] }),
  ];
  for (const answer of answers) {
    harness.state.read = answer;
    expectDenied(harness, RUN, request("repo.read"), "store_unusable");
  }
  withPollution({ usable: true }, () => {
    harness.state.read = () => ({ records: [grant("repo.read")] });
    expectDenied(harness, RUN, request("repo.read"), "store_unusable");
  });
  expect(harness.records.at(-1)).toEqual(denial("store_unusable", "repo.read"));
});

test("reads the session state and its account once, as plain own data", () => {
  const harness = setup({ records: [grant("repo.read")] });
  const states: unknown[] = [
    Object.create(signedIn()),
    { kind: "signed_in", account: Object.create(ACCOUNT) },
    {
      kind: "signed_in",
      account: Object.assign(
        Object.create({ signInExpiresAt: SIGN_IN_EXPIRES_AT }),
        without(ACCOUNT, "signInExpiresAt"),
      ),
    },
    {
      kind: "signed_in",
      account: Object.defineProperty(without(ACCOUNT, "deviceId"), "deviceId", {
        enumerable: true,
        get: () => DEVICE_ID,
      }),
    },
    { kind: "signed_in", account: revokedProxy() },
    signedIn({ signInExpiresAt: revokedProxy() }),
    revokedProxy(),
    throwingKeys(signedIn()),
  ];
  for (const session of states) {
    harness.state.session = session as DeviceSessionState;
    expectDenied(harness, RUN, request("repo.read"), "sign_in_invalid");
  }
  withPollution({ signInExpiresAt: SIGN_IN_EXPIRES_AT }, () => {
    harness.state.session = {
      kind: "signed_in",
      account: without(ACCOUNT, "signInExpiresAt"),
    } as unknown as DeviceSessionState;
    expectDenied(harness, RUN, request("repo.read"), "sign_in_invalid");
  });
  withPollution({ kind: "signed_in" }, () => {
    harness.state.session = {
      account: ACCOUNT,
    } as unknown as DeviceSessionState;
    expectDenied(harness, RUN, request("repo.read"), "sign_in_invalid");
  });
  // The account is read once: an ended sign-in is not replaced by a later
  // read of a valid one.
  const { proxy, gets } = changing(signedIn(), "account", {
    own: [{ ...ACCOUNT, signInExpiresAt: iso(NOW) }],
    get: ACCOUNT,
  });
  harness.state.session = proxy as unknown as DeviceSessionState;
  expectDenied(harness, RUN, request("repo.read"), "sign_in_invalid");
  expect(gets()).toBe(0);
});

test("counts only records whose facts put the agent and its provider connection on this device", () => {
  const cases: [readonly GrantRecord[], Capability][] = [
    [[grant("repo.read", { hostDeviceId: OTHER_DEVICE_ID })], "repo.read"],
    [
      [grant("terminal.execute", { hostDeviceId: OTHER_DEVICE_ID })],
      "terminal.execute",
    ],
    [
      [grant("provider.use", { hostDeviceId: OTHER_DEVICE_ID })],
      "provider.use",
    ],
    [
      [grant("provider.use", { connectionHostDeviceId: OTHER_DEVICE_ID })],
      "provider.use",
    ],
  ];
  for (const [records, capability] of cases) {
    const harness = setup({ records });
    expectDenied(harness, RUN, request(capability), "no_grant");
    expect(harness.records).toEqual([denial("no_grant", capability)]);
  }
  // A record of another device is left out; another record still grants.
  const mixed = setup({
    records: [
      grant("repo.read", { hostDeviceId: OTHER_DEVICE_ID }),
      {} as GrantRecord,
      // Plain, but its fields are only inherited: it never counts.
      Object.create(grant("repo.read")) as GrantRecord,
      grant("repo.read", { id: OTHER_GRANT_ID }),
    ],
  });
  expect(mixed.enforcement.check(RUN, request("repo.read")).allowed).toBe(true);
});

test("denies the whole check when a record is not plain data", () => {
  const plain = grant("repo.read");
  const getter = {
    ...plain,
    facts: {
      ...plain.facts,
      agent: Object.defineProperty(
        without(plain.facts.agent, "hostDeviceId"),
        "hostDeviceId",
        { enumerable: true, get: () => DEVICE_ID },
      ),
    },
  };
  const tooDeep = {
    ...plain,
    facts: {
      ...plain.facts,
      agent: { ...plain.facts.agent, extra: { nested: true } },
    },
  };
  const lists: unknown[] = [
    [getter, plain],
    // A hole.
    Object.assign(new Array(2), { 1: plain }),
    [plain, revokedProxy()],
    [plain, tooDeep],
    Object.assign(Object.create(Array.prototype), { 0: plain, length: 1 }),
    throwingKeys([plain]),
  ];
  const harness = setup();
  for (const records of lists) {
    harness.state.read = () => ({ usable: true, records });
    expectDenied(harness, RUN, request("repo.read"), "store_unusable");
  }
});

test("passes the plain copies of the records to the check, not the store's objects", () => {
  const plain = grant("repo.read");
  // The agent fact names this device while the enforcement point copies it
  // (`Object.keys`, then the descriptor), and another device on every later
  // read.
  const { proxy } = changing(plain.facts.agent, "hostDeviceId", {
    own: [DEVICE_ID, DEVICE_ID, OTHER_DEVICE_ID],
    get: OTHER_DEVICE_ID,
  });
  const record = { ...plain, facts: { ...plain.facts, agent: proxy } };
  const harness = setup({ records: [record as unknown as GrantRecord] });
  expect(harness.enforcement.check(RUN, request("repo.read")).allowed).toBe(
    true,
  );
});
