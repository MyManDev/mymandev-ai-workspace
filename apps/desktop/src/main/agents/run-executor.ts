// The executor interface of the host run supervisor (#35, second part): what
// runs a run on this device, one implementation for each provider kind. The
// provider adapters (#30 for Claude, #31 for Codex) implement it; until they
// land, production registers none, so no run executes on any device.
//
// The supervisor (`run-supervisor.ts`) owns the run's lifecycle: it sends
// `queued -> running` and starts the executor only after the server's
// acknowledgement, and it sends the terminal transition from the executor's
// outcome. An executor never sends a transition, never reads the network on
// the run's behalf without a check, and never decides which run comes next.
import type {
  MessageId,
  ProjectId,
  ProviderKind,
  WorkspaceId,
} from "@mymandev/protocol";
import type {
  EnforcementDenialReason,
  HeldRun,
} from "../permissions/enforcement.ts";
import type { PermissionRequest } from "@mymandev/permissions";

/**
 * The outcome of one execution. A `failed` reason must be a code: lowercase
 * letters, digits, and underscores, starting with a letter, at most 64
 * characters (`RUN_EXECUTOR_REASON_PATTERN`). Every member of the workspace
 * reads a run's reason, so an executor never puts a message, a path, a
 * command, or a provider's answer in it. A reason outside the pattern, one
 * that only the server gives, or one of the supervisor's own
 * `HOST_RUN_REASONS`, is sent as `executor_failed`.
 */
export type RunExecutionOutcome =
  | { readonly outcome: "completed" }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * The form of an executor's `failed` reason. A code of `RUN_CANCEL_REASONS`
 * fits it, but only the server gives one, so it is sent as `executor_failed`.
 */
export const RUN_EXECUTOR_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The check of one action, as `RunExecution.check` answers it. An allowed
 * check carries the request that was checked, built from the held run: act
 * only on it. Its `end` tells the supervisor that the action is over.
 */
export type RunActionCheck =
  | {
      readonly allowed: true;
      readonly request: PermissionRequest;
      /** The action ended; the supervisor stops checking it again. Idempotent. */
      readonly end: () => void;
    }
  | { readonly allowed: false; readonly reason: EnforcementDenialReason };

/** What an executor gets for one run. Every value is frozen. */
export interface RunExecution {
  /**
   * The run as the supervisor holds it, for the enforcement point: its
   * agent, this device as the agent's host, its repository, and its
   * provider connection, which the supervisor found in this device's own
   * list of provider connections.
   */
  readonly run: HeldRun;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  /** The chat message that holds the run's instruction, or null without one. */
  readonly inputMessageId: MessageId | null;
  /** The kind of the run's provider connection. */
  readonly providerKind: ProviderKind;
  /**
   * Aborted when the run must stop at once: a grant that the run relies on
   * stopped being active, the device signed out or changed, the connection
   * was lost, the server finished the run (for example a cancellation), the
   * server refused one of the run's transitions, or the app quits (#55,
   * decision of 2026-11-19). See `RunExecutor`.
   */
  readonly signal: AbortSignal;
  /**
   * Checks one request of the run's agent with the enforcement point,
   * immediately before the action or process start, for the held run; the
   * agent and the scope come from the run, never from the request
   * (ADR 0015). An allowed action stays held until its `end`: on every
   * change of the grants, the supervisor checks each held action again and
   * aborts the run at the first denial, reporting it `cancelled`. Every
   * check after the abort, and every check without an enforcement point,
   * denies with `check_failed`. Never throws.
   */
  readonly check: (request: unknown) => RunActionCheck;
}

/**
 * Runs one run of its provider kind.
 *
 * `start` begins the work and settles once it is over: `completed`, or
 * `failed` with a reason code. A rejection counts as `failed` with
 * `executor_failed`. The supervisor starts at most one run of an agent at a
 * time and never starts an agent's next run before the promise of its
 * previous one settled, also after an abort.
 *
 * On abort (`execution.signal`), the executor stops at once (decision of
 * 2026-11-19 on #55): it kills the process tree of every process that it
 * started, aborts the provider calls in flight, starts nothing more, and
 * then settles its promise promptly, with any outcome. The supervisor has
 * already reported the run (or the server already finished it), so the
 * outcome after an abort is ignored. An executor that never settles keeps
 * its agent's next run waiting until the app quits.
 *
 * Before each action and each process start, the executor calls
 * `execution.check`, and acts only when it is allowed.
 */
export interface RunExecutor {
  readonly start: (execution: RunExecution) => Promise<RunExecutionOutcome>;
}

/** The executors of this device, keyed by provider kind. Frozen. */
export interface RunExecutorRegistry {
  /** The executor for `kind`, or null without one. */
  readonly get: (kind: ProviderKind) => RunExecutor | null;
  /** The provider kinds that have an executor. */
  readonly kinds: () => readonly ProviderKind[];
}

export function createRunExecutorRegistry(
  executors: Readonly<Partial<Record<ProviderKind, RunExecutor>>>,
): RunExecutorRegistry {
  const held = new Map<ProviderKind, RunExecutor>();
  for (const [kind, executor] of Object.entries(executors) as [
    ProviderKind,
    RunExecutor | undefined,
  ][]) {
    if (executor !== undefined) {
      held.set(kind, executor);
    }
  }
  const kinds = Object.freeze([...held.keys()]);
  return Object.freeze({
    get: (kind: ProviderKind) => held.get(kind) ?? null,
    kinds: () => kinds,
  });
}

/**
 * The executors of a production build: none, until the adapters of #30 and
 * #31 land. With an empty registry, the supervisor fails every queued run of
 * this device that has a provider connection with `no_executor` or
 * `provider_connection_missing` (default 5 of 2026-11-24 on #35; default
 * until the Project Manager decides), leaves the runs without one (of the
 * development seed) queued, and reports the runs that a restart, a crash,
 * or a lost connection interrupted (see `run-supervisor.ts`).
 */
export const PRODUCTION_RUN_EXECUTORS: RunExecutorRegistry =
  createRunExecutorRegistry({});
