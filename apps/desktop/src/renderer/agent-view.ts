import type { AgentBridge } from "../shared/desktop-bridge.ts";
import type {
  AgentActivityProblem,
  AgentActivityView,
  AgentRunStateView,
  AgentRunView,
  AgentView,
} from "../shared/ipc-contract.ts";

/** What the agent panel knows about the open project's agent activity. */
export type AgentPanelView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first agent activity. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly state: AgentActivityView };

export function initialAgentPanelView(
  bridgeAvailable: boolean,
): AgentPanelView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

/**
 * Subscribes to the agent activity and reports every one as the view; a
 * refused subscription makes the view unavailable. Returns the function
 * that ends the subscription.
 */
export function followAgentActivity(
  agents: Pick<AgentBridge, "subscribeState">,
  onView: (view: AgentPanelView) => void,
): () => void {
  return agents.subscribeState(
    (state) => onView({ kind: "known", state }),
    () => onView({ kind: "unavailable" }),
  );
}

/** The fixed texts of the agent panel. */
export const AGENT_MESSAGES = Object.freeze({
  unavailable: "Agents are not available.",
  pending: "Checking the agents.",
  noProject:
    "Agents appear once this device is signed in and the project is open.",
  loading: "Loading the agents.",
  noAgents: "No agents yet.",
  noUnfinishedRuns: "No runs in progress.",
  noFinishedRuns: "No finished runs yet.",
  /** The name of a run's agent that the agent list does not hold. */
  unknownAgent: "Unknown agent",
});

/**
 * Why the agent activity is `unavailable`. What was loaded before stays
 * shown, and the main process loads again by itself.
 */
export const AGENT_PROBLEM_MESSAGES: Readonly<
  Record<AgentActivityProblem, string>
> = Object.freeze({
  not_signed_in: "The server did not accept this device's sign-in.",
  not_found: "The server did not find this project.",
  rate_limited: "The server asked to wait. Trying again in a minute.",
  unavailable: "The server could not be reached. Trying again later.",
  failed: "The agents could not be loaded. Trying again later.",
});

/**
 * The text of each run state. The panel also sets the state as the run's
 * `data-state`, and the stylesheet gives its dot the status color.
 */
export const RUN_STATE_LABELS: Readonly<Record<AgentRunStateView, string>> =
  Object.freeze({
    queued: "Queued",
    running: "Running",
    awaiting_input: "Waiting for input",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  });

/**
 * The texts of the codes that the server writes as the reason of a run that
 * it cancels itself (the protocol's `RUN_CANCEL_REASONS`): the person who
 * owns the agent or asked for the run was removed from the workspace, or
 * the device that hosts the agent was removed.
 */
export const RUN_CANCEL_MESSAGES = Object.freeze({
  member_removed: "Cancelled because a person was removed from the workspace.",
  device_revoked: "Cancelled because the agent's device was removed.",
});
export type RunCancelCode = keyof typeof RUN_CANCEL_MESSAGES;

/** A run's reason: a known cancellation code with its own text, or text. */
export type RunReason =
  | {
      readonly kind: "cancel_code";
      readonly code: RunCancelCode;
      readonly text: string;
    }
  | { readonly kind: "text"; readonly text: string };

/** A run as the panel shows it, with its agent's name. */
export interface RunRow {
  readonly id: string;
  readonly agentName: string;
  readonly state: AgentRunStateView;
  readonly stateLabel: string;
  readonly reason: RunReason | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** What the panel lists, in the order of the main process. */
export interface AgentPanelLists {
  readonly agents: readonly AgentView[];
  readonly unfinishedRuns: readonly RunRow[];
  /** How many older unfinished runs are not listed. */
  readonly moreUnfinishedRuns: number;
  readonly finishedRuns: readonly RunRow[];
}

export interface AgentPanelModel {
  /** The text of the panel's status paragraph; empty when there is none. */
  readonly status: string;
  /** The agents and runs, or null when there is nothing to list. */
  readonly lists: AgentPanelLists | null;
}

function isRunCancelCode(reason: string): reason is RunCancelCode {
  return Object.hasOwn(RUN_CANCEL_MESSAGES, reason);
}

/**
 * The reason of a run: a known cancellation code of a cancelled run as its
 * own text, any other reason as the text it is, or null without one.
 */
export function describeRunReason(run: AgentRunView): RunReason | null {
  if (run.reason === null) {
    return null;
  }
  if (run.state === "cancelled" && isRunCancelCode(run.reason)) {
    return {
      kind: "cancel_code",
      code: run.reason,
      text: RUN_CANCEL_MESSAGES[run.reason],
    };
  }
  return { kind: "text", text: run.reason };
}

function runRows(
  runs: readonly AgentRunView[],
  agentNames: ReadonlyMap<string, string>,
): RunRow[] {
  return runs.map((run) => ({
    id: run.id,
    agentName: agentNames.get(run.agentId) ?? AGENT_MESSAGES.unknownAgent,
    state: run.state,
    stateLabel: RUN_STATE_LABELS[run.state],
    reason: describeRunReason(run),
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  }));
}

function listsOf(state: AgentActivityView): AgentPanelLists {
  const agentNames = new Map(
    state.agents.map((agent) => [agent.id, agent.name] as const),
  );
  return {
    agents: state.agents,
    unfinishedRuns: runRows(state.unfinishedRuns, agentNames),
    moreUnfinishedRuns: state.moreUnfinishedRuns,
    finishedRuns: runRows(state.finishedRuns, agentNames),
  };
}

function isEmpty(state: AgentActivityView): boolean {
  return (
    state.agents.length === 0 &&
    state.unfinishedRuns.length === 0 &&
    state.moreUnfinishedRuns === 0 &&
    state.finishedRuns.length === 0
  );
}

/**
 * What the panel shows for the project that the shell shows:
 *
 * - a fixed text without the bridge, before the first agent activity, while
 *   no project is open in the main process or no device is signed in, and
 *   while the activity loads;
 * - the same loading text while the activity belongs to another project,
 *   for example right after the person opened this one, so that no other
 *   project's agents appear here;
 * - when `ready`, the agents and runs, in the main process's order;
 * - when `unavailable`, the problem as a fixed text, with what was loaded
 *   before. Without any of it, only the problem shows, because an empty
 *   list would claim what was never loaded.
 */
export function describeAgentPanel(
  view: AgentPanelView,
  projectId: string,
): AgentPanelModel {
  switch (view.kind) {
    case "unavailable":
      return { status: AGENT_MESSAGES.unavailable, lists: null };
    case "pending":
      return { status: AGENT_MESSAGES.pending, lists: null };
    case "known":
      break;
  }
  const { state } = view;
  if (state.status === "no_project") {
    return { status: AGENT_MESSAGES.noProject, lists: null };
  }
  if (state.projectId !== projectId || state.status === "loading") {
    return { status: AGENT_MESSAGES.loading, lists: null };
  }
  if (state.status === "unavailable") {
    return {
      status: AGENT_PROBLEM_MESSAGES[state.problem],
      lists: isEmpty(state) ? null : listsOf(state),
    };
  }
  return { status: "", lists: listsOf(state) };
}

/** The note below the unfinished runs when older ones are not listed. */
export function describeMoreUnfinishedRuns(count: number): string {
  return count === 1
    ? "1 more run in progress is not shown."
    : `${count} more runs in progress are not shown.`;
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * A time of the agent activity in the person's locale and time zone, for
 * example "Nov 6, 2026, 9:30 AM". A timestamp that is not a date stays as
 * it is.
 */
export function formatAgentTime(
  timestamp: string,
  format: Intl.DateTimeFormat = TIME_FORMAT,
): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : format.format(date);
}
