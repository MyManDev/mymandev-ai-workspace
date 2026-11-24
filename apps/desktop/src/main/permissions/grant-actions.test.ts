import {
  type AgentListItem,
  AgentListItemSchema,
  CAPABILITIES,
  GRANT_LIFETIME_SECONDS,
  GRANT_ROUTE_ERRORS,
  GrantCapabilityResponseSchema,
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
  PROVIDER_KINDS,
  type MemberId,
  type ProjectId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { CAPABILITY_RISK, type GrantRecord } from "@mymandev/permissions";
import { expect, test } from "vitest";
import {
  GRANT_CAPABILITIES,
  GRANT_CAPABILITY_REFUSALS,
  GRANT_LIMITS,
  GrantCapabilityResultSchema,
  GrantsViewSchema,
  PROVIDER_KIND_VIEWS,
  ProviderConnectionsResultSchema,
  REVOKE_GRANT_REFUSALS,
  RevokeGrantResultSchema,
  type AccountStatus,
  type GrantRequestView,
} from "../../shared/ipc-contract.ts";
import {
  WORKSPACE_ACTION_FAILURES,
  type WorkspaceActionFailure,
  type WorkspaceActionResult,
  workspaceActionFailed,
  workspaceActionFailedFor,
  workspaceActionSent,
} from "../api-actions.ts";
import type { WorkspaceReadResult } from "../api-reads.ts";
import type { AgentActivityState } from "../agents/service.ts";
import { createGrantActions } from "./grant-actions.ts";

// The grant and revoke actions of #342 in the main process: who may grant,
// what is sent, what each answer becomes, and that the grant store reads its
// records again after every grant request, whatever its outcome.

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const PROJECT = id(0xe1) as ProjectId;
const OTHER_PROJECT = id(0xe2) as ProjectId;
const ME = id(0xc1);
const SOMEONE = id(0xc2);
const USER = id(0xb1);
const DEVICE = id(0xd1);
const OTHER_DEVICE = id(0xd2);
const AGENT = id(0xf1);
const ELSEWHERE = id(0xf2);
const THEIRS = id(0xf3);
const DISABLED = id(0xf4);
const REPOSITORY = id(0x2001);
const CONNECTION = id(0x3001);
const GRANT = id(0x4001);
const AT = "2026-11-24T10:00:00.000Z";
const NOW_MS = Date.parse("2026-11-24T12:00:00.000Z");

function agent(
  agentId: string,
  ownerMemberId: string,
  hostDeviceId: string | null,
  disabledAt: string | null = null,
): AgentListItem {
  return AgentListItemSchema.parse({
    id: agentId,
    projectId: PROJECT,
    name: "Builder",
    ownerMemberId,
    disabledAt,
    ...(hostDeviceId === null ? {} : { hostDeviceId }),
  });
}

function signedIn(deviceId: string = DEVICE): AccountStatus {
  return {
    apiOrigin: "set",
    device: "signed_in",
    deviceKey: "ready",
    account: { kind: "signed_in", deviceId, login: "octocat" },
  } as unknown as AccountStatus;
}

function record(
  grantId: string,
  fields: {
    readonly projectId?: string;
    readonly capability?: string;
    readonly expiresAt?: string | null;
  } = {},
): GrantRecord {
  const capability = fields.capability ?? "repo.read";
  const projectId = fields.projectId ?? PROJECT;
  const connection = capability === "provider.use";
  return {
    grant: {
      id: grantId,
      projectId,
      granteeAgentId: AGENT,
      grantedByUserId: USER,
      capability,
      ...(connection
        ? { providerConnectionId: CONNECTION }
        : { repositoryId: REPOSITORY }),
      createdAt: AT,
      expiresAt: fields.expiresAt ?? null,
      revokedAt: null,
      revokedByUserId: null,
    },
    facts: {
      agent: { id: AGENT, hostDeviceId: DEVICE, disabledAt: null },
      hostDevice: { id: DEVICE, revokedAt: null },
      project: { id: projectId, workspaceId: WORKSPACE },
      grantorMembership: {
        workspaceId: WORKSPACE,
        userId: USER,
        removedAt: null,
      },
      providerConnection: connection
        ? { id: CONNECTION, hostDeviceId: DEVICE, removedAt: null }
        : null,
    },
  } as unknown as GrantRecord;
}

/** The answer of a grant of `capability` on `agentId`. */
function granted(capability = "repo.read", agentId = AGENT) {
  return GrantCapabilityResponseSchema.parse({
    grant: {
      id: GRANT,
      projectId: PROJECT,
      granteeAgentId: agentId,
      grantedByUserId: USER,
      capability,
      ...(capability === "provider.use"
        ? { providerConnectionId: CONNECTION }
        : { repositoryId: REPOSITORY }),
      createdAt: AT,
      expiresAt: null,
      revokedAt: null,
      revokedByUserId: null,
    },
  });
}

interface Sent {
  readonly name: string;
  readonly params: unknown;
  readonly body: unknown;
  readonly resolve: (result: WorkspaceActionResult<unknown>) => void;
  readonly reject: (error: unknown) => void;
}

function setup() {
  let status = signedIn();
  let state: AgentActivityState = {
    revision: 1,
    status: "ready",
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    agents: [
      agent(AGENT, ME, DEVICE),
      agent(ELSEWHERE, ME, OTHER_DEVICE),
      agent(THEIRS, SOMEONE, null),
      agent(DISABLED, ME, DEVICE, AT),
    ],
    unfinishedRuns: [],
    finishedRuns: [],
  };
  let read: { usable: boolean; records: readonly GrantRecord[] } = {
    usable: true,
    records: [],
  };
  let connections: WorkspaceReadResult<unknown> = {
    ok: true,
    value: { providerConnections: [] },
  };
  const sent: Sent[] = [];
  const reads: string[] = [];
  const logs: string[] = [];
  let answeredCount = 0;
  // Each listener gets no value here: the service reads the state itself.
  type Listener = (value: never) => void;
  const listeners = {
    account: new Set<Listener>(),
    agents: new Set<Listener>(),
    workspaces: new Set<Listener>(),
    grants: new Set<Listener>(),
  };
  const subscribe = (set: Set<Listener>) => (listener: Listener) => {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  const service = createGrantActions({
    account: {
      status: () => status,
      onStatusChange: subscribe(listeners.account),
      sendWorkspaceAction: ((name: string, params: unknown, body?: unknown) =>
        new Promise((resolve, reject) => {
          sent.push({ name, params, body, resolve, reject });
        })) as never,
      readWorkspaceData: ((name: string) => {
        reads.push(name);
        return Promise.resolve(connections);
      }) as never,
    },
    agents: {
      state: () => state,
      onChange: subscribe(listeners.agents),
    },
    workspaces: {
      ownMemberId: (workspaceId: WorkspaceId) =>
        workspaceId === WORKSPACE ? (ME as MemberId) : null,
      onChange: subscribe(listeners.workspaces),
    },
    grants: {
      read: () => read,
      onGrantsChanged: subscribe(listeners.grants),
      ownGrantAnswered: () => {
        answeredCount += 1;
      },
    },
    wallClock: () => NOW_MS,
    log: (message) => logs.push(message),
  });
  return {
    service,
    sent,
    reads,
    logs,
    listeners,
    answered: () => answeredCount,
    setStatus: (next: AccountStatus) => {
      status = next;
    },
    setState: (next: Partial<AgentActivityState>) => {
      state = { ...state, ...next };
    },
    setRead: (next: typeof read) => {
      read = next;
    },
    setConnections: (next: WorkspaceReadResult<unknown>) => {
      connections = next;
    },
  };
}

const READ_GRANT: GrantRequestView = {
  capability: "repo.read",
  scopeId: REPOSITORY,
  lifetimeSeconds: null,
};

/** Lets the promises that wait settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

test("the contract's capability names, provider kinds, and limits are the protocol's", () => {
  expect([...GRANT_CAPABILITIES]).toEqual([...CAPABILITIES]);
  expect([...GRANT_CAPABILITIES].sort()).toEqual(
    Object.keys(CAPABILITY_RISK).sort(),
  );
  expect([...PROVIDER_KIND_VIEWS]).toEqual([...PROVIDER_KINDS]);
  expect(GRANT_LIMITS).toEqual({
    grants: MAX_ANSWER_LIST_ITEMS,
    providerConnections: MAX_ANSWER_LIST_ITEMS,
    providerConnectionLabel: LIMITS.providerConnectionLabel,
  });
});

test("the owner grants on the agent's host device: the protocol's request is sent, and the grant store reads its records again once", async () => {
  const harness = setup();
  const pending = harness.service.grant(AGENT, {
    capability: "provider.use",
    scopeId: CONNECTION,
    lifetimeSeconds: 3_600,
  });
  await settle();
  expect(harness.sent).toHaveLength(1);
  const [request] = harness.sent;
  expect(request?.name).toBe("grantCapability");
  expect(request?.params).toEqual({ agentId: AGENT });
  expect(request?.body).toEqual({
    capability: "provider.use",
    providerConnectionId: CONNECTION,
    lifetimeSeconds: 3_600,
  });
  expect(harness.answered()).toBe(0);
  request?.resolve({ ok: true, value: granted("provider.use") });
  const result = await pending;
  expect(GrantCapabilityResultSchema.parse(result)).toEqual({
    outcome: "ok",
    grantId: GRANT,
  });
  expect(harness.answered()).toBe(1);

  // A repository grant without an expiry.
  const second = harness.service.grant(AGENT, READ_GRANT);
  await settle();
  expect(harness.sent[1]?.body).toEqual({
    capability: "repo.read",
    repositoryId: REPOSITORY,
    lifetimeSeconds: null,
  });
  harness.sent[1]?.resolve({ ok: true, value: granted() });
  expect(await second).toEqual({ outcome: "ok", grantId: GRANT });
  expect(harness.answered()).toBe(2);
});

/**
 * Every failure of a write as the account service answers it once the write
 * was handed to the session (`sent: true`): it may have reached the API.
 */
function sentFailures(): WorkspaceActionResult<unknown>[] {
  return WORKSPACE_ACTION_FAILURES.map((reason) =>
    workspaceActionSent(
      reason === "too_soon" || reason === "rate_limited"
        ? workspaceActionFailed(reason, 5_000)
        : workspaceActionFailed(reason),
    ),
  );
}

/**
 * The account service's own refusals, which send nothing: a request outside
 * its format, a spent write budget, and an `unavailable` or a
 * `not_signed_in` found before the request.
 */
const LOCAL_REFUSALS = [
  "invalid",
  "too_soon",
  "unavailable",
  "not_signed_in",
] as const;

test("every outcome of a grant that may have reached the API, also a failure, a lost answer, and a thrown error, reads the grant records again exactly once", async () => {
  const harness = setup();
  let expected = 0;
  for (const outcome of sentFailures()) {
    const pending = harness.service.grant(AGENT, READ_GRANT);
    await settle();
    harness.sent.at(-1)?.resolve(outcome);
    const result = await pending;
    expected += 1;
    expect(harness.answered(), JSON.stringify(outcome)).toBe(expected);
    expect(GrantCapabilityResultSchema.safeParse(result).success).toBe(true);
  }
  // A timeout or a network failure is the session's `no_answer`.
  const timedOut = harness.service.grant(AGENT, READ_GRANT);
  await settle();
  harness.sent
    .at(-1)
    ?.resolve(
      workspaceActionSent(
        workspaceActionFailedFor({ ok: false, reason: "no_answer" }),
      ),
    );
  expect(await timedOut).toEqual({ outcome: "unknown" });
  expect(harness.answered()).toBe(expected + 1);
  // A send that throws.
  const thrown = harness.service.grant(AGENT, READ_GRANT);
  await settle();
  harness.sent.at(-1)?.reject(new Error("socket hang up"));
  expect(await thrown).toEqual({ outcome: "unknown" });
  expect(harness.answered()).toBe(expected + 2);
  // An answer for another agent is not this grant's.
  const other = harness.service.grant(AGENT, READ_GRANT);
  await settle();
  harness.sent
    .at(-1)
    ?.resolve({ ok: true, value: granted("repo.read", THEIRS) });
  expect(await other).toEqual({ outcome: "unknown" });
  expect(harness.answered()).toBe(expected + 3);
  expect(harness.logs).toEqual(["A grant could not be sent."]);
});

test("a grant or a revocation that the account service refused without a request does not read the grant records again", async () => {
  const harness = setup();
  for (const reason of LOCAL_REFUSALS) {
    const outcome =
      reason === "too_soon"
        ? workspaceActionFailed(reason, 5_000)
        : workspaceActionFailed(reason);
    const granting = harness.service.grant(AGENT, READ_GRANT);
    await settle();
    harness.sent.at(-1)?.resolve(outcome);
    expect(
      GrantCapabilityResultSchema.parse(await granting),
      reason,
    ).toMatchObject({ outcome: "refused", reason });
    const revoking = harness.service.revoke(AGENT, GRANT);
    await settle();
    harness.sent.at(-1)?.resolve(outcome);
    expect(RevokeGrantResultSchema.parse(await revoking), reason).toMatchObject(
      { outcome: "refused", reason },
    );
    expect(harness.answered(), reason).toBe(0);
  }
  expect(harness.sent).toHaveLength(LOCAL_REFUSALS.length * 2);
});

test("every code that the grant and revoke routes answer becomes its own refusal, rate_limited with the server's Retry-After", async () => {
  const harness = setup();
  const common = new Set(["bad_request", "unauthorized", "internal_error"]);
  const expectedGrant: Record<string, unknown> = {
    bad_request: { outcome: "refused", reason: "failed", retryAfterMs: null },
    unauthorized: {
      outcome: "refused",
      reason: "not_signed_in",
      retryAfterMs: null,
    },
    internal_error: { outcome: "unknown" },
    rate_limited: {
      outcome: "refused",
      reason: "rate_limited",
      retryAfterMs: 90_000,
    },
  };
  for (const [action, codes, schema] of [
    ["grant", GRANT_ROUTE_ERRORS.grantCapability, GrantCapabilityResultSchema],
    ["revoke", GRANT_ROUTE_ERRORS.revokeGrant, RevokeGrantResultSchema],
  ] as const) {
    for (const code of codes) {
      const pending =
        action === "grant"
          ? harness.service.grant(AGENT, READ_GRANT)
          : harness.service.revoke(AGENT, GRANT);
      await settle();
      harness.sent.at(-1)?.resolve(
        workspaceActionFailedFor({
          ok: false,
          reason: "refused",
          code,
          retryAfterSeconds: 90,
        }),
      );
      const result = schema.parse(await pending);
      const label = `${action} ${code}`;
      if (code in expectedGrant) {
        expect(result, label).toEqual(expectedGrant[code]);
      } else {
        // `not_found`, `forbidden`, `conflict`, and `grant_limit` keep
        // their own code, without a wait.
        expect(common.has(code), label).toBe(false);
        expect(result, label).toEqual({
          outcome: "refused",
          reason: code,
          retryAfterMs: null,
        });
      }
    }
  }
  // Every failure of a write maps into the refusals, or to unknown.
  const reasons: readonly string[] = GRANT_CAPABILITY_REFUSALS;
  const revokeReasons: readonly string[] = REVOKE_GRANT_REFUSALS;
  for (const reason of WORKSPACE_ACTION_FAILURES) {
    for (const action of ["grant", "revoke"] as const) {
      const pending =
        action === "grant"
          ? harness.service.grant(AGENT, READ_GRANT)
          : harness.service.revoke(AGENT, GRANT);
      await settle();
      harness.sent
        .at(-1)
        ?.resolve(
          reason === "too_soon" || reason === "rate_limited"
            ? workspaceActionFailed(reason, 1_000)
            : workspaceActionFailed(
                reason as Exclude<
                  WorkspaceActionFailure,
                  "too_soon" | "rate_limited"
                >,
              ),
        );
      const result = await pending;
      if (result.outcome === "refused") {
        expect(
          (action === "grant" ? reasons : revokeReasons).includes(
            result.reason,
          ),
          `${action} ${reason}`,
        ).toBe(true);
      } else {
        expect(result, `${action} ${reason}`).toEqual({ outcome: "unknown" });
      }
    }
  }
});

test("a grant is refused without a request when the account may not grant the agent here, the agent is not open, the capability is not offered, or the lifetime is out of bounds", async () => {
  const harness = setup();
  const cases: [string, string, GrantRequestView, string][] = [
    [
      "another device of the owner hosts it",
      ELSEWHERE,
      READ_GRANT,
      "not_grantable",
    ],
    ["another member owns it", THEIRS, READ_GRANT, "not_grantable"],
    ["it is disabled", DISABLED, READ_GRANT, "not_grantable"],
    ["it is not in the open project", id(0xf9), READ_GRANT, "not_open"],
    ["the agent ID is malformed", "not-an-id", READ_GRANT, "invalid"],
    [
      // Not offered until the presentation rules of #77.
      "the shell",
      AGENT,
      {
        capability: "terminal.execute",
        scopeId: REPOSITORY,
        lifetimeSeconds: 3_600,
      },
      "invalid",
    ],
    [
      "a lifetime under a minute",
      AGENT,
      { ...READ_GRANT, lifetimeSeconds: GRANT_LIFETIME_SECONDS.min - 1 },
      "invalid",
    ],
    [
      "a lifetime over a year",
      AGENT,
      { ...READ_GRANT, lifetimeSeconds: GRANT_LIFETIME_SECONDS.max + 1 },
      "invalid",
    ],
  ];
  for (const [label, agentId, request, reason] of cases) {
    expect(await harness.service.grant(agentId, request), label).toEqual({
      outcome: "refused",
      reason,
      retryAfterMs: null,
    });
  }
  // Signed in as another device: the owner's agent is not grantable here.
  harness.setStatus(signedIn(OTHER_DEVICE));
  expect(await harness.service.grant(AGENT, READ_GRANT)).toEqual({
    outcome: "refused",
    reason: "not_grantable",
    retryAfterMs: null,
  });
  // No open project.
  harness.setStatus(signedIn());
  harness.setState({ projectId: null, workspaceId: null, agents: [] });
  expect(await harness.service.grant(AGENT, READ_GRANT)).toEqual({
    outcome: "refused",
    reason: "not_open",
    retryAfterMs: null,
  });
  expect(harness.sent).toEqual([]);
  expect(harness.answered()).toBe(0);
});

test("one grant at a time: a second one while the first waits is refused as busy and never sent", async () => {
  const harness = setup();
  const first = harness.service.grant(AGENT, READ_GRANT);
  await settle();
  expect(await harness.service.grant(AGENT, READ_GRANT)).toEqual({
    outcome: "refused",
    reason: "busy",
    retryAfterMs: null,
  });
  expect(harness.sent).toHaveLength(1);
  harness.sent[0]?.resolve({ ok: true, value: granted() });
  expect(await first).toEqual({ outcome: "ok", grantId: GRANT });
  expect(harness.answered()).toBe(1);
  // Once it answered, the next grant goes.
  const next = harness.service.grant(AGENT, READ_GRANT);
  await settle();
  expect(harness.sent).toHaveLength(2);
  harness.sent[1]?.resolve(workspaceActionFailed("conflict"));
  expect(await next).toEqual({
    outcome: "refused",
    reason: "conflict",
    retryAfterMs: null,
  });
});

test("the owner revokes from any of its devices; another member's agent is refused without a request", async () => {
  const harness = setup();
  // From a device that does not host the agent.
  harness.setStatus(signedIn(OTHER_DEVICE));
  const pending = harness.service.revoke(AGENT, GRANT);
  await settle();
  expect(
    harness.sent.map(({ name, params, body }) => [name, params, body]),
  ).toEqual([["revokeGrant", { agentId: AGENT, grantId: GRANT }, undefined]]);
  harness.sent[0]?.resolve({ ok: true, value: null });
  expect(await pending).toEqual({ outcome: "ok" });
  expect(harness.answered()).toBe(1);

  expect(await harness.service.revoke(THEIRS, GRANT)).toEqual({
    outcome: "refused",
    reason: "not_owner",
    retryAfterMs: null,
  });
  expect(await harness.service.revoke(AGENT, "not-an-id")).toEqual({
    outcome: "refused",
    reason: "invalid",
    retryAfterMs: null,
  });
  expect(await harness.service.revoke(id(0xf9), GRANT)).toEqual({
    outcome: "refused",
    reason: "not_open",
    retryAfterMs: null,
  });
  expect(harness.sent).toHaveLength(1);
});

test("the grants view holds the open project's grants from the store's records, with their scope and expiry, and never an account or a device", () => {
  const harness = setup();
  harness.setRead({
    usable: true,
    records: [
      record(id(0x4001)),
      record(id(0x4002), {
        capability: "provider.use",
        expiresAt: "2026-11-24T13:00:00.000Z",
      }),
      record(id(0x4003), { expiresAt: "2026-11-24T12:00:00.000Z" }),
      record(id(0x4004), { projectId: OTHER_PROJECT }),
    ],
  });
  const state = harness.service.state();
  expect(GrantsViewSchema.parse({ revision: 0, ...state })).toEqual({
    revision: 0,
    projectId: PROJECT,
    usable: true,
    grants: [
      {
        id: id(0x4001),
        agentId: AGENT,
        capability: "repo.read",
        repositoryId: REPOSITORY,
        providerConnectionId: null,
        createdAt: AT,
        expiresAt: null,
        expired: false,
      },
      {
        id: id(0x4002),
        agentId: AGENT,
        capability: "provider.use",
        repositoryId: null,
        providerConnectionId: CONNECTION,
        createdAt: AT,
        expiresAt: "2026-11-24T13:00:00.000Z",
        expired: false,
      },
      {
        // Expiry is half-open: at its time, the grant has expired.
        id: id(0x4003),
        agentId: AGENT,
        capability: "repo.read",
        repositoryId: REPOSITORY,
        providerConnectionId: null,
        createdAt: AT,
        expiresAt: "2026-11-24T12:00:00.000Z",
        expired: true,
      },
    ],
  });
  const text = JSON.stringify(state);
  for (const hidden of [USER, DEVICE, WORKSPACE]) {
    expect(text).not.toContain(hidden);
  }
  // An unusable store shows nothing, and says so.
  harness.setRead({ usable: false, records: [record(id(0x4001))] });
  expect(harness.service.state()).toEqual({
    projectId: PROJECT,
    usable: false,
    grants: [],
  });
  harness.setRead({ usable: true, records: [record(id(0x4001))] });
  harness.setState({ projectId: null, workspaceId: null });
  expect(harness.service.state()).toEqual({
    projectId: null,
    usable: false,
    grants: [],
  });
});

test("the service tells its listeners about every change of the account, the agents, the workspaces, and the grants, until it closes", () => {
  const harness = setup();
  let calls = 0;
  harness.service.onChange(() => {
    calls += 1;
  });
  for (const set of Object.values(harness.listeners)) {
    for (const listener of set) {
      listener(undefined as never);
    }
  }
  expect(calls).toBe(4);
  harness.service.close();
  for (const set of Object.values(harness.listeners)) {
    expect(set.size).toBe(0);
  }
});

test("this device's provider connections cross with an ID, a kind, and a label, and a failed read with its problem", async () => {
  const harness = setup();
  harness.setConnections({
    ok: true,
    value: {
      providerConnections: [
        { id: CONNECTION, kind: "claude", label: "Work", createdAt: AT },
      ],
    },
  });
  const result = await harness.service.listProviderConnections();
  expect(ProviderConnectionsResultSchema.parse(result)).toEqual({
    outcome: "ok",
    connections: [{ id: CONNECTION, kind: "claude", label: "Work" }],
  });
  expect(harness.reads).toEqual(["listProviderConnections"]);
  for (const [reason, problem] of [
    ["not_signed_in", "not_signed_in"],
    ["not_found", "failed"],
    ["rate_limited", "rate_limited"],
    ["unavailable", "unavailable"],
    ["failed", "failed"],
  ] as const) {
    harness.setConnections({ ok: false, reason });
    expect(await harness.service.listProviderConnections(), reason).toEqual({
      outcome: "refused",
      reason: problem,
    });
  }
  // Nothing is sent for a grant read.
  expect(harness.sent).toEqual([]);
});
