// Granting and revoking an agent's capabilities from this device (#342; the
// Project Manager's decisions of 2026-11-24), in the main process: the
// grants of the open project's agents from the grant store's records, this
// device's provider connections, and the two writes, `POST
// /agents/:agentId/grants` and `POST /agents/:agentId/grants/:grantId/revoke`,
// sent with the account service's `sendWorkspaceAction`.
//
// - Who may grant. Only the agent's owner grants, and only from the agent's
//   host device (ADR 0015, update of 2026-11-23). The agent list gives the
//   host device to the agent's own account only (#342, `hostDeviceId`); it
//   is compared here with this device's ID and never leaves the main
//   process: the renderer gets `ownedByMe` and `grantableHere` alone
//   (`agentAccess`). The owner revokes from any of its devices.
// - What is offered. Every capability but `terminal.execute`, which waits
//   for the presentation rules of ADR 0015 (#77). A grant names one scope,
//   a repository or, for `provider.use`, a provider connection of this
//   device, and an optional lifetime, checked with the protocol's
//   `GrantCapabilityRequestSchema` before anything is sent.
// - The grant store. After every grant request that may have reached the
//   API, whatever the outcome, also a failure, a timeout, or a thrown
//   error, the grant action calls the store's `ownGrantAnswered()` once:
//   the grant may be stored even when its answer is lost, and without the
//   call a first grant of an agent waits for the 5-minute read (#335). A
//   revocation calls it as well, so that a revocation whose event is lost
//   leaves the records at once. A write that the account service refused
//   without a request (`workspaceActionMayHaveSent`) does not call it: a
//   read that fails leaves the store unusable until one succeeds, and every
//   check meanwhile denies.
// - One grant at a time: a second one while the first waits is refused as
//   `busy` and never sent.
//
// The logs are fixed text, never an ID, a name, or a label.
import {
  type AgentId,
  AgentIdSchema,
  type AgentListItem,
  CAPABILITY_SCOPE,
  type GrantCapabilityRequest,
  GrantCapabilityRequestSchema,
  type GrantCapabilityResponse,
  type MemberId,
  PermissionGrantIdSchema,
} from "@mymandev/protocol";
import type { GrantRecord } from "@mymandev/permissions";
import {
  GRANT_LIMITS,
  type AccountStatus,
  type GrantCapabilityRefusal,
  type GrantCapabilityResult,
  type GrantRequestView,
  type GrantView,
  type ProviderConnectionReadProblem,
  type ProviderConnectionsResult,
  type RevokeGrantRefusal,
  type RevokeGrantResult,
} from "../../shared/ipc-contract.ts";
import type { AccountService } from "../account.ts";
import {
  type WorkspaceActionFailure,
  type WorkspaceActionResult,
  workspaceActionMayHaveSent,
} from "../api-actions.ts";
import type { WorkspaceReadFailure } from "../api-reads.ts";
import type {
  AgentActivityService,
  AgentActivityState,
} from "../agents/service.ts";
import type { WorkspaceService } from "../workspace/service.ts";
import type { GrantStoreService } from "./grant-store.ts";

/** Who reads an agent: the account's own person and this device. */
export interface GrantViewer {
  /** The account's own person in the agent's workspace, or null. */
  readonly ownMemberId: MemberId | null;
  /** The signed-in device with a ready key, or null. */
  readonly deviceId: string | null;
}

/** What the signed-in account may do with an agent (#342). */
export interface AgentAccess {
  /** The account's own person owns the agent: it may revoke its grants. */
  readonly ownedByMe: boolean;
  /**
   * The agent is enabled, the account owns it, and this device is its host
   * device: it may grant. A server that does not send `hostDeviceId` makes
   * every agent not grantable here.
   */
  readonly grantableHere: boolean;
}

/** What `viewer` may do with `agent`; the host device is only compared. */
export function agentAccess(
  agent: AgentListItem,
  viewer: GrantViewer,
): AgentAccess {
  const ownedByMe =
    viewer.ownMemberId !== null && agent.ownerMemberId === viewer.ownMemberId;
  const grantableHere =
    ownedByMe &&
    agent.disabledAt === null &&
    viewer.deviceId !== null &&
    agent.hostDeviceId !== undefined &&
    agent.hostDeviceId === viewer.deviceId;
  return Object.freeze({ ownedByMe, grantableHere });
}

/**
 * The ID of the signed-in device with a ready key, or null, as the grant
 * store and the agent service find it.
 */
export function signedInDeviceId(status: AccountStatus): string | null {
  return status.apiOrigin === "set" &&
    status.device === "signed_in" &&
    status.deviceKey === "ready" &&
    status.account.kind === "signed_in"
    ? status.account.deviceId
    : null;
}

/** The viewer of the open project's agents. */
export function grantViewer(
  status: AccountStatus,
  state: Pick<AgentActivityState, "workspaceId">,
  ownMemberId: (
    workspaceId: NonNullable<AgentActivityState["workspaceId"]>,
  ) => MemberId | null,
): GrantViewer {
  return Object.freeze({
    ownMemberId:
      state.workspaceId === null ? null : ownMemberId(state.workspaceId),
    deviceId: signedInDeviceId(status),
  });
}

/**
 * Each failure of a write and what a grant answers: every code of
 * `GRANT_ROUTE_ERRORS.grantCapability` beyond the common ones has its own
 * refusal; `bad_request` is `failed`, `unauthorized` `not_signed_in`, and
 * `internal_error` `unknown`, as for every write.
 */
const GRANT_OUTCOMES = {
  invalid: "invalid",
  too_soon: "too_soon",
  not_signed_in: "not_signed_in",
  unavailable: "unavailable",
  forbidden: "forbidden",
  not_found: "not_found",
  conflict: "conflict",
  already_member: "failed",
  invitation_invalid: "failed",
  join_requests_closed: "failed",
  workspace_not_found: "failed",
  device_too_new: "failed",
  unclaimed_limit: "failed",
  project_limit: "failed",
  repository_limit: "failed",
  grant_limit: "grant_limit",
  rate_limited: "rate_limited",
  unknown: "unknown",
  failed: "failed",
} satisfies Record<WorkspaceActionFailure, GrantCapabilityRefusal | "unknown">;
Object.freeze(GRANT_OUTCOMES);

/**
 * Each failure of a write and what a revocation answers, after
 * `GRANT_ROUTE_ERRORS.revokeGrant`.
 */
const REVOKE_OUTCOMES = {
  ...GRANT_OUTCOMES,
  grant_limit: "failed",
} satisfies Record<WorkspaceActionFailure, RevokeGrantRefusal | "unknown">;
Object.freeze(REVOKE_OUTCOMES);

/** Each failure of a read and the problem of the provider connections. */
const READ_PROBLEMS = {
  not_signed_in: "not_signed_in",
  not_found: "failed",
  rate_limited: "rate_limited",
  unavailable: "unavailable",
  failed: "failed",
} satisfies Record<WorkspaceReadFailure, ProviderConnectionReadProblem>;
Object.freeze(READ_PROBLEMS);

const UNKNOWN = Object.freeze({ outcome: "unknown" } as const);

type Refused<R extends string> = {
  readonly outcome: "refused";
  readonly reason: R;
  readonly retryAfterMs: number | null;
};

function refused<R extends string>(
  reason: R,
  retryAfterMs: number | null = null,
): Refused<R> {
  return Object.freeze({ outcome: "refused", reason, retryAfterMs });
}

/** The result of a failed write, with its wait for `too_soon` and `rate_limited`. */
function failedResult<R extends string>(
  outcomes: Readonly<Record<WorkspaceActionFailure, R | "unknown">>,
  result: Extract<WorkspaceActionResult<unknown>, { ok: false }>,
): Refused<R> | typeof UNKNOWN {
  const outcome = outcomes[result.reason];
  if (outcome === "unknown") {
    return UNKNOWN;
  }
  return "retryAfterMs" in result
    ? refused(outcome, result.retryAfterMs)
    : refused(outcome);
}

/** Whether a grant has expired at `nowMs`; expiry is half-open, as `isGrantActive` judges it. */
function hasExpired(expiresAt: string | null, nowMs: number): boolean {
  return expiresAt !== null && nowMs >= Date.parse(expiresAt);
}

/** A record as the screen may know it: no account, no device, no fact. */
function grantView(record: GrantRecord, nowMs: number): GrantView {
  const { grant } = record;
  return Object.freeze({
    id: grant.id,
    agentId: grant.granteeAgentId,
    capability: grant.capability,
    repositoryId: "repositoryId" in grant ? grant.repositoryId : null,
    providerConnectionId:
      "providerConnectionId" in grant ? grant.providerConnectionId : null,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    expired: hasExpired(grant.expiresAt, nowMs),
  });
}

/** The grants of the open project's agents, without a revision. */
export interface GrantsState {
  readonly projectId: string | null;
  readonly usable: boolean;
  readonly grants: readonly GrantView[];
}

export interface GrantActionsOptions {
  readonly account: Pick<
    AccountService,
    "status" | "onStatusChange" | "sendWorkspaceAction" | "readWorkspaceData"
  >;
  readonly agents: Pick<AgentActivityService, "state" | "onChange">;
  readonly workspaces: Pick<WorkspaceService, "ownMemberId" | "onChange">;
  readonly grants: Pick<
    GrantStoreService,
    "read" | "onGrantsChanged" | "ownGrantAnswered"
  >;
  /** The wall clock in milliseconds, for expiry; defaults to `Date.now`. */
  readonly wallClock?: () => number;
  /**
   * Receives fixed messages, never an ID, a name, or a label. An error that
   * it throws is ignored.
   */
  readonly log?: (message: string) => void;
}

export interface GrantActionsService {
  /** The grants of the open project's agents, from the grant store. */
  readonly state: () => GrantsState;
  /**
   * Calls `listener` after a change of the grant records, the agents, the
   * workspaces, or the account. The result removes the listener.
   */
  readonly onChange: (listener: () => void) => () => void;
  /** Reads this device's provider connections. Never rejects. */
  readonly listProviderConnections: () => Promise<ProviderConnectionsResult>;
  /** Grants one capability on one scope to an agent. Never rejects. */
  readonly grant: (
    agentId: string,
    request: GrantRequestView,
  ) => Promise<GrantCapabilityResult>;
  /** Revokes a grant of an agent. Never rejects. */
  readonly revoke: (
    agentId: string,
    grantId: string,
  ) => Promise<RevokeGrantResult>;
  /** Stops listening, for the quit. */
  readonly close: () => void;
}

/** The capabilities that the desktop does not offer yet (#77). */
const NOT_OFFERED: ReadonlySet<string> = new Set(["terminal.execute"]);

export function createGrantActions(
  options: GrantActionsOptions,
): GrantActionsService {
  const { account, agents, workspaces, grants } = options;
  const wallClock = options.wallClock ?? (() => Date.now());

  function log(message: string): void {
    try {
      options.log?.(message);
    } catch {
      // A failing log changes nothing.
    }
  }

  let closed = false;
  /** A grant is waiting for its answer. */
  let granting = false;
  const listeners = new Set<() => void>();

  function changed(): void {
    if (closed) {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        log("A grant listener failed.");
      }
    }
  }

  /** The agent of the open project with this ID, and what the account may do. */
  function openAgent(
    agentId: AgentId,
  ): { readonly agent: AgentListItem; readonly access: AgentAccess } | null {
    const state = agents.state();
    if (state.projectId === null) {
      return null;
    }
    const agent = state.agents.find((item) => item.id === agentId);
    if (agent === undefined) {
      return null;
    }
    const viewer = grantViewer(account.status(), state, workspaces.ownMemberId);
    return { agent, access: agentAccess(agent, viewer) };
  }

  function state(): GrantsState {
    const { projectId } = agents.state();
    const read = grants.read();
    if (projectId === null || !read.usable) {
      return Object.freeze({
        projectId,
        usable: projectId !== null && read.usable,
        grants: Object.freeze([]),
      });
    }
    const nowMs = wallClock();
    return Object.freeze({
      projectId,
      usable: true,
      grants: Object.freeze(
        read.records
          .filter((record) => record.facts.project.id === projectId)
          .slice(0, GRANT_LIMITS.grants)
          .map((record) => grantView(record, nowMs)),
      ),
    });
  }

  /**
   * Tells the grant store that a grant request that may have reached the
   * API ended; never throws.
   */
  function answered(): void {
    try {
      grants.ownGrantAnswered();
    } catch {
      log("The grant records could not be read again.");
    }
  }

  async function listProviderConnections(): Promise<ProviderConnectionsResult> {
    if (closed) {
      return Object.freeze({ outcome: "refused", reason: "unavailable" });
    }
    let result;
    try {
      result = await account.readWorkspaceData("listProviderConnections", {});
    } catch {
      log("The provider connections could not be read.");
      return Object.freeze({ outcome: "refused", reason: "unavailable" });
    }
    if (!result.ok) {
      return Object.freeze({
        outcome: "refused",
        reason: READ_PROBLEMS[result.reason],
      });
    }
    return Object.freeze({
      outcome: "ok",
      connections: Object.freeze(
        result.value.providerConnections
          .slice(0, GRANT_LIMITS.providerConnections)
          .map((connection) =>
            Object.freeze({
              id: connection.id,
              kind: connection.kind,
              label: connection.label,
            }),
          ),
      ),
    });
  }

  /** The protocol's request for `request`, or null outside its format. */
  function grantRequest(
    request: GrantRequestView,
  ): GrantCapabilityRequest | null {
    if (NOT_OFFERED.has(request.capability)) {
      return null;
    }
    const scope =
      CAPABILITY_SCOPE[request.capability] === "provider_connection"
        ? { providerConnectionId: request.scopeId }
        : { repositoryId: request.scopeId };
    const parsed = GrantCapabilityRequestSchema.safeParse({
      capability: request.capability,
      ...scope,
      lifetimeSeconds: request.lifetimeSeconds,
    });
    return parsed.success ? parsed.data : null;
  }

  async function grant(
    agentValue: string,
    request: GrantRequestView,
  ): Promise<GrantCapabilityResult> {
    const agentId = AgentIdSchema.safeParse(agentValue);
    const body = grantRequest(request);
    if (!agentId.success || body === null) {
      return refused("invalid");
    }
    if (closed) {
      return refused("unavailable");
    }
    const found = openAgent(agentId.data);
    if (found === null) {
      return refused("not_open");
    }
    if (!found.access.grantableHere) {
      return refused("not_grantable");
    }
    // One at a time: a second press while the first waits is refused, never
    // queued, because a queued one would still reach the server.
    if (granting) {
      return refused("busy");
    }
    granting = true;
    let answer: WorkspaceActionResult<GrantCapabilityResponse>;
    try {
      answer = await account.sendWorkspaceAction(
        "grantCapability",
        { agentId: agentId.data },
        body,
      );
    } catch {
      log("A grant could not be sent.");
      // It may have reached the API.
      answered();
      return UNKNOWN;
    } finally {
      granting = false;
    }
    // Whatever the outcome of a request that may have reached the API: the
    // grant may be stored although its answer was lost (#335). Never after
    // a refusal of the account service, which sent nothing.
    if (workspaceActionMayHaveSent(answer)) {
      answered();
    }
    if (!answer.ok) {
      return failedResult(GRANT_OUTCOMES, answer);
    }
    const { grant: granted } = answer.value;
    // A grant of another agent or capability is not this write's answer.
    return granted.granteeAgentId === agentId.data &&
      granted.capability === body.capability
      ? Object.freeze({ outcome: "ok", grantId: granted.id })
      : UNKNOWN;
  }

  async function revoke(
    agentValue: string,
    grantValue: string,
  ): Promise<RevokeGrantResult> {
    const agentId = AgentIdSchema.safeParse(agentValue);
    const grantId = PermissionGrantIdSchema.safeParse(grantValue);
    if (!agentId.success || !grantId.success) {
      return refused("invalid");
    }
    if (closed) {
      return refused("unavailable");
    }
    const found = openAgent(agentId.data);
    if (found === null) {
      return refused("not_open");
    }
    if (!found.access.ownedByMe) {
      return refused("not_owner");
    }
    let answer: WorkspaceActionResult<null>;
    try {
      answer = await account.sendWorkspaceAction("revokeGrant", {
        agentId: agentId.data,
        grantId: grantId.data,
      });
    } catch {
      log("A revocation could not be sent.");
      answered();
      return UNKNOWN;
    }
    // `agent.grant.revoked` leaves the grant out at once; the read covers
    // an event that was lost. Never after a refusal without a request.
    if (workspaceActionMayHaveSent(answer)) {
      answered();
    }
    return answer.ok
      ? Object.freeze({ outcome: "ok" })
      : failedResult(REVOKE_OUTCOMES, answer);
  }

  const removers = [
    account.onStatusChange(changed),
    agents.onChange(changed),
    workspaces.onChange(changed),
    grants.onGrantsChanged(changed),
  ];

  return Object.freeze({
    state,
    onChange: (listener: () => void) => {
      const entry = () => listener();
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    listProviderConnections,
    grant,
    revoke,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const remove of removers) {
        remove();
      }
      listeners.clear();
    },
  });
}
