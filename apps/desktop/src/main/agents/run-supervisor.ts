// The host run supervisor (#35, second part; the defaults of 2026-11-24 on
// #35, and the decision of 2026-11-19 on #55): it picks up the runs that
// this device hosts and runs them with the executor of their provider kind
// (`run-executor.ts`), sending each run's transitions as its agent through
// the model of a hosted run (`host-run.ts`).
//
// - Adoption. Only the unfinished runs of the open project whose agent this
//   signed-in device hosts (`hostDeviceId`, which only the owner's account
//   reads, #342) and that is not disabled, while the agent activity is live
//   (`gateLive`) and the connection is open. A run of a closed project waits
//   until the project is opened. The agents in `reservedAgentIds` are left
//   alone: the development agent switch of an unpackaged build moves their
//   runs, and the supervisor never sends for them.
// - Order. One run of an agent at a time, the oldest `createdAt` first. An
//   agent is busy while the supervisor holds one of its runs, while an
//   executor of one of its runs has not settled (also after an abort), while
//   one of its runs waits for the next reload after a refusal, and while the
//   activity shows one of its runs in `running` or `awaiting_input`.
// - A queued run is decided only once a reload of the runs listed it
//   (`reloadedRuns`): a run that an event created carries neither its
//   provider connection nor its input message, so its agent waits for the
//   reload that the creation asks for. The run's provider connection and
//   input message are taken from that reload only.
// - A queued run that the reload lists without a provider connection is
//   skipped and stays queued: only the development seed creates such runs
//   (default 5 of 2026-11-24, as narrowed on the review of #348; default
//   until the Project Manager decides). For every other queued run, the
//   supervisor reads this device's provider connections
//   (`GET /provider-connections`), also with an empty executor registry. A
//   run whose provider connection is not in the list fails at once
//   (`queued -> failed`, `provider_connection_missing`); so does one whose
//   provider kind has no executor (`no_executor`), so that it does not hold
//   one of the agent's 10 unfinished places. Otherwise the start is due:
//   when the pace lets it go, `beforeStart` is asked immediately before
//   `queued -> running` is sent, every time, also after a wait behind
//   another run or a `rate_limited`; once the server acknowledged it, the
//   executor starts with the held run and an `AbortSignal`, and its outcome
//   becomes `running -> completed` or `running -> failed`.
// - `beforeStart` is the seam for a check of `provider.use` with the
//   enforcement point before `queued -> running`. Whether the supervisor
//   makes that check waits for the Project Manager (#35, scope of
//   2026-11-24, and #55), so it defaults to allowing every start, and the
//   enforcement point is never called before a start. Its answer is read
//   defensively: an answer that is not an object, a hook that throws, or a
//   reason that is not a code (`RUN_EXECUTOR_REASON_PATTERN`) or that only
//   the server gives makes the run wait for the next reload, which the
//   supervisor asks for.
// - Stops (#55, decision of 2026-11-19). An executor's action that it
//   checked with `RunExecution.check` stays held until it ends. On every
//   `onGrantsChanged`, each held action is checked again with the
//   enforcement point's `recheck` for the run that the supervisor holds,
//   which records denials but no shell start; at the first denial the run
//   is aborted and reported. While connected, a denial maps as follows
//   (default until the Project Manager decides, #55): `no_grant` is
//   `cancelled` with `grant_inactive`; a denial of the sign-in
//   (`signed_out`, `sign_in_invalid`, `device_unknown`, `not_this_device`)
//   is `cancelled` with `signed_out`; every other denial (`store_unusable`,
//   `clock_invalid`, `record_failed`, `check_failed`, and the malformed
//   inputs `run_invalid`, `request_invalid`, `no_scope`,
//   `request_mismatch`) is `failed` with `grant_check_unavailable`, because
//   the grant could not be checked, not shown inactive. A sign-out, or the
//   connection's close for the account (`offline`), aborts every run and
//   reports it `cancelled` with `signed_out`. `offline` also covers a
//   device key that is not ready and an API origin that is not set, so
//   those are reported `cancelled` with `signed_out` too. Another device
//   aborts every run and reports nothing, because only the host device may
//   send.
// - The end of the sign-in (#55, decision of 2026-11-19). The account's
//   `signInExpiresAt` ends the sign-in on this device, while the server
//   keeps the connection open for `SIGN_IN_GRACE_MS` more, so no change of
//   the account or the connection tells it. The supervisor keeps a timer for
//   it (in steps of at most `SIGN_IN_TIMER_STEP_MS`), set again on every
//   change of the account and cancelled at close. At the end, every run
//   that executes is aborted and reported `cancelled` with `signed_out`, a
//   start that is acknowledged afterwards is reported the same way instead
//   of starting, and no queued run is adopted until a new sign-in moves the
//   end. An end that cannot be read counts as passed.
// - Interrupted runs (default 6 of 2026-11-24). A lost connection aborts
//   every run, which is reported `failed` with `host_interrupted`. After
//   each reload of the runs, a run of an adopted agent in `running` or
//   `awaiting_input` that this process does not hold (a restart, a crash, a
//   connection lost mid-run, a run dropped after a refusal) is reported
//   `failed` with `host_interrupted`. There is no resume in v0.
// - Refusals. `rate_limited` is transient: the supervisor keeps the
//   transition and sends it again with a new event after a backoff
//   (`RUN_SUPERVISOR_RETRY_DELAY_MS`, doubling up to
//   `RUN_SUPERVISOR_RETRY_MAX_MS`), only when the run is then still in the
//   state that it starts from in the activity (the end of an execution, which
//   needs no activity, is checked only while its project is open, and is
//   otherwise sent from its known state); a reload meanwhile does not
//   report the run as interrupted. At `conflict` or `not_found`, the
//   supervisor drops the run and never retries it; the run and its agent
//   wait for the next reload, which brings the truth.
// - Reload requests. While the connection stays open, nothing else reloads
//   the runs, so a run that waits for a reload (a dropped run, a transient
//   refusal, or a transition owed after `no_acknowledgement` or a send that
//   went out nowhere) makes the supervisor ask the agent activity for one
//   (`requestReload`), after `RUN_SUPERVISOR_RELOAD_DELAY_MS`, doubling up
//   to `RUN_SUPERVISOR_RELOAD_MAX_MS` until a transition is acknowledged.
//   At most one request waits at a time, and any reload cancels it, so the
//   reloads stay bounded.
// - Owed transitions. A transition that could not be sent, or whose
//   acknowledgement did not come, because the connection closed or the
//   device signed out, stays in memory. After the next reload of its
//   project on the same device, it is sent with a new model, only when the
//   reloaded run is still in the state that it starts from; otherwise it is
//   dropped. Another device drops every owed transition. The owed
//   transitions of a project that is never opened again stay in memory
//   until the app quits, at most one for each of its unfinished runs.
// - Sends. One transition in flight at a time, at most one send every
//   `RUN_SUPERVISOR_SEND_INTERVAL_MS`, resends included. The host run model
//   checks every transition against `RUN_TRANSITIONS` and every reason
//   against `runReasonAllowed` and the protocol's limits before it sends.
//
// The host reasons are codes of this desktop, sent as plain `reason` text
// (`HOST_RUN_REASONS`), not a protocol list. The logs are fixed text with a
// code at most, never an ID.
import {
  isTerminalRunState,
  newId,
  RUN_CANCEL_REASONS,
  type AgentId,
  type AgentListItem,
  type AgentRunListItem,
  type DeviceId,
  type EventId,
  type ProjectId,
  type ProviderConnection,
  type RunId,
  type RunState,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { AccountStatus } from "../../shared/ipc-contract.ts";
import type { AccountService } from "../account.ts";
import type { ConnectionClient } from "../connection/client.ts";
import type {
  EnforcementDenialReason,
  HeldRun,
  PermissionEnforcement,
} from "../permissions/enforcement.ts";
import type { GrantStoreService } from "../permissions/grant-store.ts";
import type { ScheduleTimer } from "../runtime.ts";
import { workspaceRetryDelayMs } from "../workspace/service.ts";
import {
  createHostRun,
  HOST_RUN_ACK_TIMEOUT_MS,
  type HostRun,
  type HostRunState,
} from "./host-run.ts";
import {
  RUN_EXECUTOR_REASON_PATTERN,
  type RunActionCheck,
  type RunExecution,
  type RunExecutionOutcome,
  type RunExecutor,
  type RunExecutorRegistry,
} from "./run-executor.ts";
import type { AgentActivityService, AgentActivityState } from "./service.ts";

/**
 * The reasons that this device gives with a run's `failed` or `cancelled`:
 * codes of the desktop, sent as plain `reason` text. None of them is a code
 * of `RUN_CANCEL_REASONS`, which only the server gives.
 */
export const HOST_RUN_REASONS = Object.freeze({
  /** No executor for the provider kind of the run's connection. */
  noExecutor: "no_executor",
  /** The run has no provider connection, or it is not one of this device. */
  providerConnectionMissing: "provider_connection_missing",
  /** A restart, a crash, or a lost connection interrupted the run. */
  hostInterrupted: "host_interrupted",
  /** A grant that the run relies on is no longer active (#55). */
  grantInactive: "grant_inactive",
  /** The device signed out, or its sign-in is no longer valid (#55). */
  signedOut: "signed_out",
  /**
   * A held action could not be checked again: the grant store was not
   * usable, the clock or the check failed, or an input was malformed.
   * Default until the Project Manager decides (#55).
   */
  grantCheckUnavailable: "grant_check_unavailable",
  /** The executor failed without a reason code that may be shown. */
  executorFailed: "executor_failed",
} as const);
export type HostRunReason =
  (typeof HOST_RUN_REASONS)[keyof typeof HOST_RUN_REASONS];

/**
 * The shortest time between two sends, resends included: at most 20 sends
 * in any 10 seconds, against the account's 30 transitions (decision of
 * 2026-11-05).
 */
export const RUN_SUPERVISOR_SEND_INTERVAL_MS = 500;

/**
 * How long a transition that the server refused with `rate_limited` waits
 * before it is sent again, the first time; it doubles with every further
 * `rate_limited` until an acknowledgement, up to
 * `RUN_SUPERVISOR_RETRY_MAX_MS`.
 */
export const RUN_SUPERVISOR_RETRY_DELAY_MS = 10_000;
export const RUN_SUPERVISOR_RETRY_MAX_MS = 60_000;

/**
 * How long the supervisor waits before it asks the agent activity for a
 * reload, the first time; it doubles with every request until a transition
 * is acknowledged, up to `RUN_SUPERVISOR_RELOAD_MAX_MS`.
 */
export const RUN_SUPERVISOR_RELOAD_DELAY_MS = 30_000;
export const RUN_SUPERVISOR_RELOAD_MAX_MS = 300_000;

/**
 * What `beforeStart` decides for a run that may start: start it, or end it
 * with `failed` or `cancelled` and a reason instead.
 */
export type RunStartDecision =
  | { readonly start: true }
  | {
      readonly start: false;
      readonly state: "failed" | "cancelled";
      readonly reason: string;
    };

/**
 * The longest wait of the timer for the end of the sign-in; a longer wait
 * is made of steps, each of which reads the account again. It stays far
 * below the 2^31 - 1 ms that a timer can wait.
 */
export const SIGN_IN_TIMER_STEP_MS = 24 * 60 * 60_000;

/**
 * How long an aborted executor may take to settle before the supervisor logs
 * it, once. Its agent stays busy until it settles: an adapter must settle
 * promptly after an abort (`RunExecutor`).
 */
export const RUN_SUPERVISOR_ABORT_WATCHDOG_MS = 30_000;

/** The default of `beforeStart`: every start is allowed. */
export const ALLOW_RUN_START: RunStartDecision = Object.freeze({
  start: true,
});

/** The part of the account service that the supervisor uses. */
export type RunSupervisorAccount = Pick<
  AccountService,
  "status" | "onStatusChange" | "readWorkspaceData"
>;
/** The part of the connection client that the supervisor uses. */
export type RunSupervisorConnection = Pick<
  ConnectionClient,
  "sendAs" | "onMessage" | "status" | "onStatusChange"
>;
/** The part of the agent activity service that the supervisor uses. */
export type RunSupervisorAgents = Pick<
  AgentActivityService,
  | "state"
  | "onChange"
  | "gateLive"
  | "runsReloaded"
  | "reloadedRuns"
  | "requestReload"
>;
/** The part of the grant store that the supervisor uses. */
export type RunSupervisorGrants = Pick<GrantStoreService, "onGrantsChanged">;

export interface RunSupervisorOptions {
  readonly account: RunSupervisorAccount;
  readonly connection: RunSupervisorConnection;
  readonly agents: RunSupervisorAgents;
  readonly grants: RunSupervisorGrants;
  readonly executors: RunExecutorRegistry;
  /**
   * The enforcement point: `check` for `RunExecution.check`, and `recheck`
   * for the checks of held actions after a change of the grants. Without
   * one, every check of an executor denies.
   */
  readonly enforcement?: Pick<PermissionEnforcement, "check" | "recheck">;
  /**
   * Asked immediately before each send of `queued -> running`, for a run
   * that has an executor and a provider connection of this device. Waits
   * for the Project Manager's decision on a check of `provider.use` (#35,
   * #55); defaults to `ALLOW_RUN_START`. A hook that throws, or answers
   * outside `RunStartDecision` (not an object, or a reason that is not a
   * code of `RUN_EXECUTOR_REASON_PATTERN`, or one that only the server
   * gives), sends nothing, and the run waits for the next reload. A host
   * reason such as `grant_inactive` may be given.
   */
  readonly beforeStart?: (run: HeldRun) => RunStartDecision;
  /** Agents whose runs another sender moves; the supervisor leaves them alone. */
  readonly reservedAgentIds?: readonly AgentId[];
  /** Defaults to `HOST_RUN_ACK_TIMEOUT_MS`. */
  readonly ackTimeoutMs?: number;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now?: () => number;
  /** The wall clock in milliseconds, for `occurredAt`; defaults to `Date.now`. */
  readonly wallClock?: () => number;
  /** Defaults to a new UUIDv7. */
  readonly newEventId?: () => EventId;
  /**
   * Receives fixed messages with a code at most, never an ID. An error that
   * it throws is ignored.
   */
  readonly log?: (message: string) => void;
}

export interface RunSupervisor {
  /**
   * Stops listening, cancels the timers, and aborts every execution without
   * a report: after the next start, the runs are reported as interrupted.
   */
  readonly close: () => void;
}

interface Transition {
  readonly from: RunState;
  readonly to: RunState;
  readonly reason?: string;
}

/** What a start needs once `queued -> running` is acknowledged. */
interface StartPlan {
  readonly held: HeldRun;
  readonly executor: RunExecutor;
  readonly providerKind: ProviderConnection["kind"];
  readonly inputMessageId: NonNullable<
    AgentRunListItem["inputMessageId"]
  > | null;
}

/** A queued run that may be decided, with the reload that listed it. */
interface Candidate {
  readonly run: AgentRunListItem;
  /** The run as the last reload of the runs listed it. */
  readonly listed: AgentRunListItem;
}

/** An action that an executor checked and that has not ended. */
interface Lease {
  readonly request: unknown;
  /** How many allowed checks of this request have not ended. */
  open: number;
}

interface Execution {
  readonly runId: RunId;
  readonly agentId: AgentId;
  readonly held: HeldRun;
  readonly controller: AbortController;
  /**
   * The held actions by their canonical request (`leaseKey`): the same
   * request checked many times is held once, so an executor that never
   * calls `end()` cannot grow it beyond the run's few requests.
   */
  readonly leases: Map<string, Lease>;
  aborted: boolean;
  /** Cancels the watchdog of an abort; see `RUN_SUPERVISOR_ABORT_WATCHDOG_MS`. */
  cancelWatchdog: (() => void) | null;
}

/**
 * Why a transition is due: `start` and `refuse` for a queued run, `orphan`
 * for an interrupted one, `owed` for a transition held over a reload, and
 * `finish` for the end of an execution or of an abort.
 */
type Purpose = "start" | "refuse" | "orphan" | "owed" | "finish";

type Stage =
  | {
      readonly kind: "due";
      readonly transition: Transition;
      readonly purpose: Purpose;
      readonly start: StartPlan | null;
      /** The monotonic time before which it is not sent, after `rate_limited`. */
      readonly notBefore?: number;
    }
  | {
      readonly kind: "sending";
      readonly transition: Transition;
      readonly purpose: Purpose;
      readonly model: HostRun;
      readonly start: StartPlan | null;
    }
  | { readonly kind: "executing"; readonly execution: Execution }
  | { readonly kind: "owed"; readonly transition: Transition };

interface Entry {
  readonly runId: RunId;
  readonly agentId: AgentId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  /** The device that adopted the run; only it sends for the run. */
  readonly deviceId: DeviceId;
  stage: Stage;
}

/** Why every run is interrupted at once. */
type Interruption = "signed_out" | "connection_lost" | "device_changed";

/** The live activity of the open project, when every guard holds. */
interface Live {
  readonly device: DeviceId;
  readonly state: AgentActivityState;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
}

/** The denials of the enforcement point that concern the sign-in. */
const SIGN_IN_DENIALS: ReadonlySet<EnforcementDenialReason> = new Set([
  "signed_out",
  "sign_in_invalid",
  "device_unknown",
  "not_this_device",
]);

const CHECK_FAILED: RunActionCheck = Object.freeze({
  allowed: false,
  reason: "check_failed",
});

/**
 * The end of the signed-in device's sign-in in wall-clock milliseconds, or
 * null without a signed-in device. An end that cannot be read is 0, so it
 * counts as passed.
 */
function signInEndOf(status: AccountStatus): number | null {
  if (signedInDevice(status) === null || status.account.kind !== "signed_in") {
    return null;
  }
  const end = Date.parse(status.account.signInExpiresAt);
  return Number.isFinite(end) ? end : 0;
}

/** The signed-in device, or null, under the same condition as the services. */
function signedInDevice(status: AccountStatus): DeviceId | null {
  if (
    status.apiOrigin === "set" &&
    status.device === "signed_in" &&
    status.deviceKey === "ready" &&
    status.account.kind === "signed_in"
  ) {
    return status.account.deviceId as DeviceId;
  }
  return null;
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

/** Older first: the creation time, then the ID, which is a UUIDv7. */
function olderFirst(a: AgentRunListItem, b: AgentRunListItem): number {
  const at = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (at !== 0) {
    return at;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The canonical form of an allowed request, built from the run by the
 * enforcement point: its capability, its agent, and its scope.
 */
function leaseKey(request: unknown): string {
  const value = request as {
    capability?: unknown;
    agentId?: unknown;
    repositoryId?: unknown;
    providerConnectionId?: unknown;
  };
  return JSON.stringify([
    value.capability ?? null,
    value.agentId ?? null,
    value.repositoryId ?? null,
    value.providerConnectionId ?? null,
  ]);
}

/** The reasons that only the server gives. */
const SERVER_REASONS: readonly string[] = RUN_CANCEL_REASONS;

/** The reasons that only the supervisor gives. */
const HOST_REASONS: readonly string[] = Object.values(HOST_RUN_REASONS);

/**
 * Whether `reason` may end a run as `beforeStart` gives it: a code of
 * `RUN_EXECUTOR_REASON_PATTERN` that only the server does not give. A host
 * reason is allowed, so that a check before the start can report, for
 * example, `grant_inactive`.
 */
function startReasonAllowed(reason: unknown): reason is string {
  return (
    typeof reason === "string" &&
    RUN_EXECUTOR_REASON_PATTERN.test(reason) &&
    !SERVER_REASONS.includes(reason)
  );
}

/**
 * Whether `reason` may end a run as an executor's `failed` gives it: as
 * `startReasonAllowed`, and none of the host's own reasons, which only the
 * supervisor gives.
 */
function executorReasonAllowed(reason: unknown): reason is string {
  return startReasonAllowed(reason) && !HOST_REASONS.includes(reason);
}

/** The terminal transition of an executor's outcome. */
function finishOf(outcome: unknown): Transition {
  if (typeof outcome === "object" && outcome !== null) {
    const value = outcome as { outcome?: unknown; reason?: unknown };
    if (value.outcome === "completed") {
      return { from: "running", to: "completed" };
    }
    const reason = value.reason;
    if (value.outcome === "failed" && executorReasonAllowed(reason)) {
      return { from: "running", to: "failed", reason };
    }
  }
  return {
    from: "running",
    to: "failed",
    reason: HOST_RUN_REASONS.executorFailed,
  };
}

/**
 * How a denial of a held action while connected ends its run; see "Stops".
 * Default until the Project Manager decides (#55).
 */
function stopOfDenial(reason: EnforcementDenialReason): Transition {
  if (reason === "no_grant") {
    return {
      from: "running",
      to: "cancelled",
      reason: HOST_RUN_REASONS.grantInactive,
    };
  }
  if (SIGN_IN_DENIALS.has(reason)) {
    return {
      from: "running",
      to: "cancelled",
      reason: HOST_RUN_REASONS.signedOut,
    };
  }
  return {
    from: "running",
    to: "failed",
    reason: HOST_RUN_REASONS.grantCheckUnavailable,
  };
}

/** The transition that reports a run that an interruption stopped. */
function interruptedTransition(
  cause: Exclude<Interruption, "device_changed">,
): Transition {
  return cause === "signed_out"
    ? { from: "running", to: "cancelled", reason: HOST_RUN_REASONS.signedOut }
    : {
        from: "running",
        to: "failed",
        reason: HOST_RUN_REASONS.hostInterrupted,
      };
}

export function createRunSupervisor(
  options: RunSupervisorOptions,
): RunSupervisor {
  const { account, connection, agents, grants, executors } = options;
  const enforcement = options.enforcement ?? null;
  const beforeStart = options.beforeStart ?? (() => ALLOW_RUN_START);
  const reserved: ReadonlySet<AgentId> = new Set(
    options.reservedAgentIds ?? [],
  );
  const ackTimeoutMs = options.ackTimeoutMs ?? HOST_RUN_ACK_TIMEOUT_MS;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const now = options.now ?? (() => performance.now());
  const wallClock = options.wallClock ?? (() => Date.now());
  const newEventId = options.newEventId ?? (() => newId<EventId>());

  function log(message: string): void {
    try {
      options.log?.(message);
    } catch {
      // A failing log changes nothing.
    }
  }

  let closed = false;
  let device: DeviceId | null = signedInDevice(account.status());
  let connected = connection.status().state === "connected";
  /** The runs that the supervisor holds, in the order they were adopted. */
  const entries = new Map<RunId, Entry>();
  /** Executions whose executor has not settled, aborted ones included. */
  const executions = new Set<Execution>();
  /** Runs dropped after a refusal, with their agent, until the next reload. */
  const dropped = new Map<RunId, AgentId>();
  /** The entry whose transition is in flight. */
  let inFlight: Entry | null = null;
  /** The monotonic time of the last send, or null before the first. */
  let lastSend: number | null = null;
  let cancelPace: (() => void) | null = null;
  /** The value of `runsReloaded` that the last scan saw. */
  let scannedReload: number | null = null;
  /**
   * The unfinished runs of the last reload of the runs that the supervisor
   * saw, by ID: a queued run is decided only once it is here.
   */
  let listedRuns = new Map<RunId, AgentRunListItem>();
  /** Changes with every change of the device, so that a read for an earlier one is dropped. */
  let epoch = 0;
  let providerReadInFlight = false;
  let cancelProviderRetry: (() => void) | null = null;
  let providerAttempt = 0;
  /** How many `rate_limited` refusals came since the last acknowledgement. */
  let retryAttempt = 0;
  let cancelWake: (() => void) | null = null;
  /** When the wake-up of `cancelWake` comes, on the monotonic clock. */
  let wakeAt: number | null = null;
  /** How many reloads the supervisor asked for since the last acknowledgement. */
  let reloadAttempt = 0;
  let cancelReloadRequest: (() => void) | null = null;

  // The guards.

  function liveActivity(): Live | null {
    if (closed || device === null || !connected) {
      return null;
    }
    const state = agents.state();
    if (
      state.status !== "ready" ||
      state.workspaceId === null ||
      state.projectId === null ||
      !agents.gateLive()
    ) {
      return null;
    }
    return {
      device,
      state,
      workspaceId: state.workspaceId,
      projectId: state.projectId,
    };
  }

  /** Whether the supervisor adopts the runs of `agent` on `live`. */
  function adoptable(agent: AgentListItem | undefined, live: Live): boolean {
    return (
      agent !== undefined &&
      agent.projectId === live.projectId &&
      agent.hostDeviceId !== undefined &&
      agent.hostDeviceId === live.device &&
      agent.disabledAt === null &&
      !reserved.has(agent.id)
    );
  }

  function agentOf(live: Live, agentId: AgentId): AgentListItem | undefined {
    return live.state.agents.find((agent) => agent.id === agentId);
  }

  /** Whether `agentId` may not start another run now; see "Order". */
  function agentBusy(agentId: AgentId, live: Live): boolean {
    for (const entry of entries.values()) {
      if (entry.agentId === agentId) {
        return true;
      }
    }
    for (const execution of executions) {
      if (execution.agentId === agentId) {
        return true;
      }
    }
    for (const agent of dropped.values()) {
      if (agent === agentId) {
        return true;
      }
    }
    return live.state.unfinishedRuns.some(
      (run) => run.agentId === agentId && run.state !== "queued",
    );
  }

  /**
   * The oldest queued run of each adoptable agent that is not busy, once a
   * reload listed it; see "A queued run". A run that the reload listed
   * without a provider connection is skipped; a run that no reload listed
   * yet makes its agent wait.
   */
  function candidates(live: Live): Candidate[] {
    const found: Candidate[] = [];
    if (signInOver()) {
      // Nothing starts after the end of the sign-in.
      return found;
    }
    for (const agent of live.state.agents) {
      if (!adoptable(agent, live) || agentBusy(agent.id, live)) {
        continue;
      }
      const queued = live.state.unfinishedRuns
        .filter((run) => run.agentId === agent.id && run.state === "queued")
        .sort(olderFirst);
      for (const run of queued) {
        const listed = listedRuns.get(run.id);
        if (listed === undefined) {
          // Created by an event: the reload that it asked for tells more.
          break;
        }
        if (listed.providerConnectionId === undefined) {
          // A run of the development seed: it stays queued.
          continue;
        }
        found.push({ run, listed });
        break;
      }
    }
    return found;
  }

  // The executions.

  function releaseLeases(execution: Execution): void {
    execution.leases.clear();
  }

  /**
   * Aborts the execution of `entry`, and then reports `next` (`due` now,
   * or `owed` after the next reload), or nothing when `next` is null.
   */
  function abortExecution(
    entry: Entry,
    next: Transition | null,
    mode: "due" | "owed",
  ): void {
    if (entry.stage.kind !== "executing") {
      return;
    }
    const { execution } = entry.stage;
    execution.aborted = true;
    releaseLeases(execution);
    if (!closed && execution.cancelWatchdog === null) {
      execution.cancelWatchdog = schedule(() => {
        execution.cancelWatchdog = null;
        if (executions.has(execution)) {
          log(
            "An aborted run executor did not settle within 30 seconds; its agent waits.",
          );
        }
      }, RUN_SUPERVISOR_ABORT_WATCHDOG_MS);
    }
    if (next === null) {
      entries.delete(entry.runId);
    } else {
      entry.stage =
        mode === "owed"
          ? { kind: "owed", transition: next }
          : { kind: "due", transition: next, purpose: "finish", start: null };
    }
    try {
      execution.controller.abort();
    } catch {
      // A listener of the signal that throws changes nothing.
    }
  }

  function checkAction(execution: Execution, request: unknown): RunActionCheck {
    if (closed || execution.aborted || enforcement === null) {
      return CHECK_FAILED;
    }
    let decision;
    let key: string;
    try {
      decision = enforcement.check(execution.held, request);
      if (!decision.allowed) {
        return Object.freeze({ allowed: false, reason: decision.reason });
      }
      key = leaseKey(decision.request);
    } catch {
      return CHECK_FAILED;
    }
    let lease = execution.leases.get(key);
    if (lease === undefined) {
      lease = { request: decision.request, open: 0 };
      execution.leases.set(key, lease);
    }
    lease.open += 1;
    const held = lease;
    let ended = false;
    return Object.freeze({
      allowed: true,
      request: decision.request,
      end: () => {
        if (ended) {
          return;
        }
        ended = true;
        held.open -= 1;
        if (held.open <= 0 && execution.leases.get(key) === held) {
          execution.leases.delete(key);
        }
      },
    });
  }

  function startExecution(entry: Entry, plan: StartPlan): void {
    const execution: Execution = {
      runId: entry.runId,
      agentId: entry.agentId,
      held: plan.held,
      controller: new AbortController(),
      leases: new Map(),
      aborted: false,
      cancelWatchdog: null,
    };
    executions.add(execution);
    entry.stage = { kind: "executing", execution };
    const context: RunExecution = Object.freeze({
      run: plan.held,
      workspaceId: entry.workspaceId,
      projectId: entry.projectId,
      inputMessageId: plan.inputMessageId ?? null,
      providerKind: plan.providerKind,
      signal: execution.controller.signal,
      check: (request: unknown) => checkAction(execution, request),
    });
    log("The host run supervisor started a run.");
    let outcome: Promise<RunExecutionOutcome>;
    try {
      outcome = Promise.resolve(plan.executor.start(context));
    } catch (error: unknown) {
      outcome = Promise.reject(error);
    }
    outcome.then(
      (value) => settled(entry, execution, value),
      () => settled(entry, execution, null),
    );
  }

  function settled(entry: Entry, execution: Execution, outcome: unknown): void {
    executions.delete(execution);
    releaseLeases(execution);
    execution.cancelWatchdog?.();
    execution.cancelWatchdog = null;
    if (closed) {
      return;
    }
    if (
      !execution.aborted &&
      entries.get(entry.runId) === entry &&
      entry.stage.kind === "executing" &&
      entry.stage.execution === execution
    ) {
      execution.aborted = true;
      const transition = finishOf(outcome);
      entry.stage = {
        kind: "due",
        transition,
        purpose: "finish",
        start: null,
      };
      log(
        `A run ended on this device (${transition.reason ?? transition.to}).`,
      );
    }
    evaluate();
  }

  // The interruptions.

  /** Reports every run that an interruption stopped, or drops them all. */
  function interruptAll(cause: Interruption): void {
    if (cause !== "device_changed" && entries.size > 0) {
      log(
        `The host run supervisor holds its runs' transitions until the next reload (${cause}).`,
      );
    }
    for (const entry of [...entries.values()]) {
      const stage = entry.stage;
      if (cause === "device_changed") {
        if (stage.kind === "sending") {
          stage.model.close();
        }
        if (stage.kind === "executing") {
          abortExecution(entry, null, "owed");
        }
        entries.delete(entry.runId);
        continue;
      }
      switch (stage.kind) {
        case "sending":
          stage.model.close();
          entry.stage = {
            kind: "owed",
            transition:
              stage.start === null
                ? stage.transition
                : interruptedTransition(cause),
          };
          break;
        case "executing":
          abortExecution(entry, interruptedTransition(cause), "owed");
          break;
        case "due":
          if (stage.purpose === "finish" || stage.purpose === "owed") {
            entry.stage = { kind: "owed", transition: stage.transition };
          } else {
            // Computed from the activity: the next reload computes it again.
            entries.delete(entry.runId);
          }
          break;
        case "owed":
          break;
      }
    }
    inFlight = null;
    if (cause === "device_changed") {
      dropped.clear();
    }
  }

  // The end of the sign-in.

  /** The end of the sign-in of `device`; see `signInEndOf`. */
  let signInEnd: number | null = null;
  let cancelSignInTimer: (() => void) | null = null;

  function signInOver(): boolean {
    return signInEnd !== null && wallClock() >= signInEnd;
  }

  /** Follows the account's end of the sign-in, and stops the runs at it. */
  function followSignIn(status: AccountStatus): void {
    cancelSignInTimer?.();
    cancelSignInTimer = null;
    signInEnd = closed ? null : signInEndOf(status);
    if (signInEnd === null) {
      return;
    }
    const wait = signInEnd - wallClock();
    if (wait <= 0) {
      signInEnded();
      return;
    }
    cancelSignInTimer = schedule(
      () => {
        cancelSignInTimer = null;
        followSignIn(account.status());
        evaluate();
      },
      Math.min(wait, SIGN_IN_TIMER_STEP_MS),
    );
  }

  /** The sign-in ended: every execution stops and is reported cancelled. */
  function signInEnded(): void {
    for (const entry of [...entries.values()]) {
      if (entry.stage.kind === "executing") {
        log(
          `A run was stopped on this device (${HOST_RUN_REASONS.signedOut}).`,
        );
        abortExecution(entry, signInEndedTransition(), "due");
      }
    }
  }

  function signInEndedTransition(): Transition {
    return {
      from: "running",
      to: "cancelled",
      reason: HOST_RUN_REASONS.signedOut,
    };
  }

  function accountChanged(status: AccountStatus): void {
    const next = signedInDevice(status);
    if (next === device) {
      followSignIn(status);
      return;
    }
    const previous = device;
    device = next;
    epoch += 1;
    providerReadInFlight = false;
    if (previous !== null) {
      interruptAll(next === null ? "signed_out" : "device_changed");
    }
    listedRuns = new Map();
    if (next !== null) {
      // Only the device that adopted a run sends for it.
      for (const entry of [...entries.values()]) {
        if (entry.deviceId !== next) {
          entries.delete(entry.runId);
        }
      }
    }
    followSignIn(status);
  }

  function connectionChanged(state: string): void {
    const was = connected;
    connected = state === "connected";
    if (was && !connected) {
      interruptAll(state === "offline" ? "signed_out" : "connection_lost");
    }
  }

  /** Checks every held action again; the first denial stops its run. */
  function grantsChanged(): void {
    accountChanged(account.status());
    connectionChanged(connection.status().state);
    for (const entry of [...entries.values()]) {
      if (entry.stage.kind !== "executing") {
        continue;
      }
      const { execution } = entry.stage;
      for (const lease of [...execution.leases.values()]) {
        let reason: EnforcementDenialReason | null;
        if (enforcement === null) {
          reason = "check_failed";
        } else {
          try {
            const decision = enforcement.recheck(execution.held, lease.request);
            reason = decision.allowed ? null : decision.reason;
          } catch {
            reason = "check_failed";
          }
        }
        if (reason === null) {
          continue;
        }
        const stop = stopOfDenial(reason);
        log(`A run was stopped on this device (${stop.reason ?? stop.to}).`);
        abortExecution(entry, stop, "due");
        break;
      }
    }
  }

  // The reloads and the adoption.

  // The reload requests.

  /**
   * A run waits for a reload: unless a request already waits, ask the agent
   * activity for one after the backoff. See "Reload requests".
   */
  function wantReload(): void {
    if (closed || cancelReloadRequest !== null) {
      return;
    }
    const delay = Math.min(
      RUN_SUPERVISOR_RELOAD_DELAY_MS * 2 ** reloadAttempt,
      RUN_SUPERVISOR_RELOAD_MAX_MS,
    );
    cancelReloadRequest = schedule(() => {
      cancelReloadRequest = null;
      if (closed) {
        return;
      }
      reloadAttempt = Math.min(reloadAttempt + 1, 16);
      log("The host run supervisor asks for a reload of the runs.");
      try {
        agents.requestReload();
      } catch {
        // A failing request changes nothing; the next one may go.
      }
    }, delay);
  }

  function stopReloadRequest(): void {
    cancelReloadRequest?.();
    cancelReloadRequest = null;
  }

  /** Drops `entry` until the next reload, and asks for one. */
  function dropUntilReload(entry: Pick<Entry, "runId" | "agentId">): void {
    entries.delete(entry.runId);
    dropped.set(entry.runId, entry.agentId);
    wantReload();
  }

  /** After a reload of the runs: owed transitions, then interrupted runs. */
  function afterReload(live: Live): void {
    // The reload came: a request that waits is not needed any more.
    stopReloadRequest();
    dropped.clear();
    listedRuns = new Map(
      agents.reloadedRuns().map((item) => [item.id, item] as const),
    );
    for (const entry of [...entries.values()]) {
      if (
        entry.stage.kind !== "owed" ||
        entry.workspaceId !== live.workspaceId ||
        entry.projectId !== live.projectId
      ) {
        continue;
      }
      const { transition } = entry.stage;
      const run = live.state.unfinishedRuns.find(
        (item) => item.id === entry.runId,
      );
      if (run === undefined || run.state !== transition.from) {
        // The run moved on without it, or ended.
        entries.delete(entry.runId);
        continue;
      }
      entry.stage = { kind: "due", transition, purpose: "owed", start: null };
    }
    // An aborted execution that has not settled yet holds no run: its run
    // is reported, while its agent stays busy until it settles.
    for (const run of [...live.state.unfinishedRuns].sort(olderFirst)) {
      if (
        (run.state !== "running" && run.state !== "awaiting_input") ||
        entries.has(run.id) ||
        !adoptable(agentOf(live, run.agentId), live)
      ) {
        continue;
      }
      log("The host run supervisor reports an interrupted run.");
      entries.set(run.id, {
        runId: run.id,
        agentId: run.agentId,
        workspaceId: live.workspaceId,
        projectId: live.projectId,
        deviceId: live.device,
        stage: {
          kind: "due",
          transition: {
            from: run.state,
            to: "failed",
            reason: HOST_RUN_REASONS.hostInterrupted,
          },
          purpose: "orphan",
          start: null,
        },
      });
    }
  }

  /** Drops what the server already finished in the open project. */
  function followFinished(live: Live): void {
    for (const entry of [...entries.values()]) {
      if (
        entry.workspaceId !== live.workspaceId ||
        entry.projectId !== live.projectId ||
        entry.stage.kind === "sending" ||
        !live.state.finishedRuns.some((run) => run.id === entry.runId)
      ) {
        continue;
      }
      if (entry.stage.kind === "executing") {
        log("The server finished a run that ran on this device.");
        abortExecution(entry, null, "due");
      } else {
        entries.delete(entry.runId);
      }
    }
  }

  function readProviderConnections(): void {
    providerReadInFlight = true;
    const asked = epoch;
    void account
      .readWorkspaceData("listProviderConnections", {})
      .catch(() => ({ ok: false, reason: "unavailable" }) as const)
      .then((result) => {
        if (closed || asked !== epoch) {
          return;
        }
        providerReadInFlight = false;
        if (!result.ok) {
          log(`The provider connections could not be read (${result.reason}).`);
          cancelProviderRetry = schedule(
            () => {
              cancelProviderRetry = null;
              evaluate();
            },
            workspaceRetryDelayMs(providerAttempt, result.reason),
          );
          providerAttempt += 1;
          return;
        }
        providerAttempt = 0;
        decideStarts(result.value.providerConnections);
        evaluate();
      });
  }

  /** Decides each candidate with this device's provider connections. */
  function decideStarts(connections: readonly ProviderConnection[]): void {
    const live = liveActivity();
    if (live === null) {
      return;
    }
    for (const { run, listed } of candidates(live)) {
      const due = (
        transition: Transition,
        purpose: Purpose,
        start: StartPlan | null,
      ) => {
        entries.set(run.id, {
          runId: run.id,
          agentId: run.agentId,
          workspaceId: live.workspaceId,
          projectId: live.projectId,
          deviceId: live.device,
          stage: { kind: "due", transition, purpose, start },
        });
      };
      const found = connections.find(
        (item) => item.id === listed.providerConnectionId,
      );
      if (found === undefined) {
        log(
          `A run cannot run on this device (${HOST_RUN_REASONS.providerConnectionMissing}).`,
        );
        due(
          {
            from: "queued",
            to: "failed",
            reason: HOST_RUN_REASONS.providerConnectionMissing,
          },
          "refuse",
          null,
        );
        continue;
      }
      const executor = executors.get(found.kind);
      if (executor === null) {
        log(
          `A run cannot run on this device (${HOST_RUN_REASONS.noExecutor}).`,
        );
        due(
          {
            from: "queued",
            to: "failed",
            reason: HOST_RUN_REASONS.noExecutor,
          },
          "refuse",
          null,
        );
        continue;
      }
      const held: HeldRun = Object.freeze({
        runId: run.id,
        agentId: run.agentId,
        hostDeviceId: live.device,
        repositoryId: run.repositoryId,
        providerConnectionId: found.id,
      });
      // `beforeStart` is asked when the start is sent; see `pump`.
      due({ from: "queued", to: "running" }, "start", {
        held,
        executor,
        providerKind: found.kind,
        inputMessageId: listed.inputMessageId ?? null,
      });
    }
  }

  /**
   * Asks `beforeStart` for `held`, immediately before its start is sent:
   * the transition to send instead of `queued -> running`, or null when the
   * run waits (a hook that throws, or any answer outside
   * `RunStartDecision`, a reason that `startReasonAllowed` refuses
   * included).
   */
  function askBeforeStart(held: HeldRun): Transition | null {
    try {
      const decision: unknown = beforeStart(held);
      if (typeof decision !== "object" || decision === null) {
        return null;
      }
      const value = decision as {
        start?: unknown;
        state?: unknown;
        reason?: unknown;
      };
      const start = value.start;
      if (start === true) {
        return { from: "queued", to: "running" };
      }
      const state = value.state;
      const reason = value.reason;
      if (
        start === false &&
        (state === "failed" || state === "cancelled") &&
        startReasonAllowed(reason)
      ) {
        return { from: "queued", to: state, reason };
      }
      return null;
    } catch {
      return null;
    }
  }

  // The sends.

  /** Whether the pace allows a send now; otherwise the pump is scheduled. */
  function paceAllows(): boolean {
    if (lastSend === null) {
      return true;
    }
    const delay = lastSend + RUN_SUPERVISOR_SEND_INTERVAL_MS - now();
    if (delay <= 0) {
      return true;
    }
    cancelPace ??= schedule(() => {
      cancelPace = null;
      evaluate();
    }, delay);
    return false;
  }

  /** Evaluates again at the monotonic time `at`, unless a wake-up comes first. */
  function wakeUpAt(at: number): void {
    if (wakeAt !== null && wakeAt <= at) {
      return;
    }
    cancelWake?.();
    wakeAt = at;
    cancelWake = schedule(
      () => {
        cancelWake = null;
        wakeAt = null;
        evaluate();
      },
      Math.max(0, at - now()),
    );
  }

  /** The next due entry that may go now, or null. */
  function nextDue(): Entry | null {
    const live = liveActivity();
    for (const entry of [...entries.values()]) {
      const stage = entry.stage;
      if (stage.kind !== "due" || entry.deviceId !== device) {
        continue;
      }
      if (stage.notBefore !== undefined && stage.notBefore > now()) {
        // Sent again after the backoff of a `rate_limited`.
        wakeUpAt(stage.notBefore);
        continue;
      }
      if (stage.purpose === "finish") {
        const open =
          live !== null &&
          live.workspaceId === entry.workspaceId &&
          live.projectId === entry.projectId;
        if (stage.notBefore !== undefined && open) {
          // Sent again after a `rate_limited`, while its project is open:
          // only when the activity still shows the state that it starts from.
          const run = live.state.unfinishedRuns.find(
            (item) => item.id === entry.runId,
          );
          if (run === undefined || run.state !== stage.transition.from) {
            entries.delete(entry.runId);
            continue;
          }
        }
        // Otherwise from the run's known state: it needs no activity, and the
        // server checks the state that it starts from.
        return entry;
      }
      if (stage.purpose === "start" && signInOver()) {
        // Nothing starts after the end of the sign-in.
        entries.delete(entry.runId);
        continue;
      }
      if (
        live === null ||
        live.workspaceId !== entry.workspaceId ||
        live.projectId !== entry.projectId
      ) {
        if (live !== null || agents.state().projectId !== entry.projectId) {
          // Another project is open, or none: an owed transition waits for
          // its project's next reload, the others are computed again then.
          if (stage.purpose === "owed") {
            entry.stage = { kind: "owed", transition: stage.transition };
          } else {
            entries.delete(entry.runId);
          }
        }
        continue;
      }
      const run = live.state.unfinishedRuns.find(
        (item) => item.id === entry.runId,
      );
      if (run === undefined || run.state !== stage.transition.from) {
        // The run moved on meanwhile.
        entries.delete(entry.runId);
        continue;
      }
      return entry;
    }
    return null;
  }

  function pump(): void {
    if (closed || device === null || !connected) {
      return;
    }
    if (inFlight !== null) {
      const stage = inFlight.stage;
      if (
        stage.kind === "sending" &&
        stage.model.state().phase === "resend_due" &&
        paceAllows()
      ) {
        lastSend = now();
        stage.model.resend();
      }
      return;
    }
    for (;;) {
      const entry = nextDue();
      if (entry === null || entry.stage.kind !== "due" || !paceAllows()) {
        return;
      }
      const { transition, purpose, start } = entry.stage;
      if (purpose !== "start" || start === null) {
        send(entry, transition, purpose, start);
        return;
      }
      // Asked immediately before each start (ADR 0015), also after a wait
      // behind another run or a `rate_limited`.
      const decided = askBeforeStart(start.held);
      if (decided === null) {
        log("The check before a run start failed; the run waits.");
        dropUntilReload(entry);
        continue;
      }
      if (decided.to === "running") {
        send(entry, transition, purpose, start);
      } else {
        send(entry, decided, "refuse", null);
      }
      return;
    }
  }

  function send(
    entry: Entry,
    transition: Transition,
    purpose: Purpose,
    start: StartPlan | null,
  ): void {
    const model: HostRun = createHostRun({
      workspaceId: entry.workspaceId,
      agentId: entry.agentId,
      hostDeviceId: entry.deviceId,
      runId: entry.runId,
      runState: transition.from,
      connection,
      ackTimeoutMs,
      scheduleTimer: schedule,
      wallClock,
      newEventId,
      onChange: (state) => modelChanged(entry, model, state),
    });
    entry.stage = { kind: "sending", transition, purpose, model, start };
    inFlight = entry;
    lastSend = now();
    const result = model.transition(transition.to, transition.reason);
    if (result === "sent" || result === "stopped") {
      // A stop has been handled by `modelChanged`.
      return;
    }
    // The model refused the transition before a send: never retried.
    log(`A run transition was not sent (${result}); the run waits.`);
    model.close();
    inFlight = null;
    dropUntilReload(entry);
  }

  function modelChanged(
    entry: Entry,
    model: HostRun,
    state: HostRunState,
  ): void {
    if (
      closed ||
      inFlight !== entry ||
      entry.stage.kind !== "sending" ||
      entry.stage.model !== model
    ) {
      return;
    }
    switch (state.phase) {
      case "idle":
        acknowledged(entry, entry.stage, state.runState);
        return;
      case "stopped":
        stopped(entry, entry.stage, state);
        return;
      case "resend_due":
        log("A run transition got no acknowledgement; it is sent once more.");
        pump();
        return;
      case "awaiting_ack":
      case "closed":
        return;
    }
  }

  function acknowledged(
    entry: Entry,
    stage: Extract<Stage, { kind: "sending" }>,
    runState: RunState,
  ): void {
    stage.model.close();
    inFlight = null;
    retryAttempt = 0;
    reloadAttempt = 0;
    if (stage.start !== null && runState === "running" && signInOver()) {
      // The sign-in ended while the start was on its way.
      log(`A run was stopped on this device (${HOST_RUN_REASONS.signedOut}).`);
      entry.stage = {
        kind: "due",
        transition: signInEndedTransition(),
        purpose: "finish",
        start: null,
      };
    } else if (stage.start !== null && runState === "running") {
      startExecution(entry, stage.start);
    } else if (isTerminalRunState(runState)) {
      entries.delete(entry.runId);
    } else {
      // Another state than the one sent: the next reload tells.
      dropUntilReload(entry);
    }
    evaluate();
  }

  function stopped(
    entry: Entry,
    stage: Extract<Stage, { kind: "sending" }>,
    state: HostRunState,
  ): void {
    inFlight = null;
    const stop = state.stop;
    if (stop?.cause === "refused" && stop.code === "rate_limited") {
      // Transient: the same transition again, with a new event, after the
      // backoff, once the activity still shows the state that it starts
      // from. The end of an execution keeps its purpose: it is checked
      // against the activity while its project is open, and otherwise sent
      // from its known state, as before the refusal.
      const delay = Math.min(
        RUN_SUPERVISOR_RETRY_DELAY_MS * 2 ** retryAttempt,
        RUN_SUPERVISOR_RETRY_MAX_MS,
      );
      retryAttempt = Math.min(retryAttempt + 1, 16);
      log(
        "The server limited a run transition (rate_limited); it is sent again later.",
      );
      entry.stage = {
        kind: "due",
        transition: stage.transition,
        purpose: stage.purpose,
        start: stage.start,
        notBefore: now() + delay,
      };
      wantReload();
    } else if (stop === null || stop.cause === "refused") {
      log(
        `The server refused a run transition (${stop?.cause === "refused" ? stop.code : "unknown"}); the run waits for the next reload.`,
      );
      dropUntilReload(entry);
    } else {
      const cause =
        stop.cause === "signed_out" ? "signed_out" : "connection_lost";
      log(`A run transition is held until the next reload (${stop.cause}).`);
      entry.stage = {
        kind: "owed",
        transition:
          stage.start === null
            ? stage.transition
            : interruptedTransition(cause),
      };
      if (stop.cause === "no_acknowledgement" || stop.cause === "not_sent") {
        // The connection may stay open: nothing else reloads.
        wantReload();
      }
    }
    evaluate();
  }

  // The evaluation.

  let evaluating = false;
  let again = false;

  /** Applies what changed and sends what is due. Never re-entered. */
  function evaluate(): void {
    if (closed) {
      return;
    }
    if (evaluating) {
      again = true;
      return;
    }
    evaluating = true;
    try {
      do {
        again = false;
        const live = liveActivity();
        if (live !== null) {
          followFinished(live);
          const reloads = agents.runsReloaded();
          if (reloads !== scannedReload) {
            scannedReload = reloads;
            afterReload(live);
          }
          if (
            !providerReadInFlight &&
            cancelProviderRetry === null &&
            candidates(live).length > 0
          ) {
            readProviderConnections();
          }
        }
        pump();
      } while (again && !closed);
    } finally {
      evaluating = false;
    }
  }

  const removers = [
    account.onStatusChange((status) => {
      accountChanged(status);
      evaluate();
    }),
    connection.onStatusChange((status) => {
      connectionChanged(status.state);
      evaluate();
    }),
    agents.onChange(() => evaluate()),
    grants.onGrantsChanged(() => {
      grantsChanged();
      evaluate();
    }),
  ];

  followSignIn(account.status());
  evaluate();

  return Object.freeze({
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const remove of removers.splice(0)) {
        remove();
      }
      cancelPace?.();
      cancelPace = null;
      cancelProviderRetry?.();
      cancelProviderRetry = null;
      cancelWake?.();
      cancelWake = null;
      cancelSignInTimer?.();
      cancelSignInTimer = null;
      stopReloadRequest();
      if (inFlight?.stage.kind === "sending") {
        inFlight.stage.model.close();
      }
      inFlight = null;
      for (const entry of [...entries.values()]) {
        if (entry.stage.kind === "executing") {
          abortExecution(entry, null, "due");
        }
      }
      for (const execution of executions) {
        execution.cancelWatchdog?.();
        execution.cancelWatchdog = null;
      }
      entries.clear();
      dropped.clear();
    },
  });
}
