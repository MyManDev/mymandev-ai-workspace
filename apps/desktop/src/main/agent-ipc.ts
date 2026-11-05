import type {
  AgentListItem,
  AgentRunListItem,
  MemberId,
} from "@mymandev/protocol";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  AGENT_LIMITS,
  type AgentActivityStatusView,
  type AgentActivityView,
  type AgentRunView,
  type AgentView,
} from "../shared/ipc-contract.ts";
import type {
  AgentActivityService,
  AgentActivityState,
  AgentActivityStatus,
} from "./agents/service.ts";
import {
  createEventPublisher,
  createInvokeHandler,
  type IpcRegistry,
} from "./ipc.ts";
import type { ScheduleTimer } from "./runtime.ts";
import type { WorkspaceService } from "./workspace/service.ts";

/**
 * The shortest time between two publishes of the agent activity. A burst of
 * changes, such as a reload that applies many waiting events, sends the
 * latest view once at the end of it.
 */
export const AGENT_PUBLISH_INTERVAL_MS = 50;

/**
 * Each status of the service and its status in the contract. `satisfies`
 * checks the fresh literal, so the record fails to compile when the service
 * gains or loses a status.
 */
const STATUS_VIEWS = {
  no_project: "no_project",
  loading: "loading",
  ready: "ready",
  unavailable: "unavailable",
} satisfies Record<AgentActivityStatus, AgentActivityStatusView>;
Object.freeze(STATUS_VIEWS);

/** `text`, cut to `maxLength` characters (code points), as zod counts them. */
function cut(text: string, maxLength: number): string {
  const characters = Array.from(text);
  return characters.length > maxLength
    ? characters.slice(0, maxLength).join("")
    : text;
}

function agentView(
  agent: AgentListItem,
  memberName: (memberId: MemberId) => string,
): AgentView {
  return Object.freeze({
    id: agent.id,
    name: cut(agent.name, AGENT_LIMITS.agentName),
    ownerName: cut(memberName(agent.ownerMemberId), AGENT_LIMITS.ownerName),
    disabledAt: agent.disabledAt,
  });
}

function runView(run: AgentRunListItem): AgentRunView {
  return Object.freeze({
    id: run.id,
    agentId: run.agentId,
    state: run.state,
    reason:
      run.reason === null ? null : cut(run.reason, AGENT_LIMITS.runReason),
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  });
}

/**
 * The frozen copy of the service's state that crosses IPC, with `revision`
 * as its revision. Each agent's owner is resolved to a display name with
 * `memberName`; no member ID, device ID, project ID of a run, or repository
 * ID crosses. The lists keep the model's order and are cut to
 * `AGENT_LIMITS`: the model holds the unfinished runs the most recently
 * created first, so the first ones are the newest, and `moreUnfinishedRuns`
 * counts the older ones that are left out; the finished runs are the most
 * recently finished first, and those beyond the limit are dropped without a
 * count. Names and reasons are cut to their limits.
 */
export function agentActivityView(
  state: AgentActivityState,
  revision: number,
  memberName: (memberId: MemberId) => string,
): AgentActivityView {
  const unfinished = state.unfinishedRuns.slice(0, AGENT_LIMITS.unfinishedRuns);
  const fields = {
    revision,
    workspaceId: state.workspaceId,
    projectId: state.projectId,
    agents: Object.freeze(
      state.agents
        .slice(0, AGENT_LIMITS.agents)
        .map((agent) => agentView(agent, memberName)),
    ),
    unfinishedRuns: Object.freeze(unfinished.map(runView)),
    moreUnfinishedRuns: state.unfinishedRuns.length - unfinished.length,
    finishedRuns: Object.freeze(
      state.finishedRuns.slice(0, AGENT_LIMITS.finishedRuns).map(runView),
    ),
  };
  const status = STATUS_VIEWS[state.status];
  if (status === "unavailable") {
    return Object.freeze({
      status,
      problem: state.problem ?? "failed",
      ...fields,
    });
  }
  return Object.freeze({ status, ...fields });
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

export interface AgentIpcOptions {
  readonly agents: Pick<AgentActivityService, "state" | "onChange">;
  readonly workspaces: Pick<WorkspaceService, "memberName" | "onChange">;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** Defaults to `console.error`. */
  readonly onError?: (message: string, error: unknown) => void;
}

export interface AgentIpc {
  /** Stops listening and cancels a publish that waits, for the quit. */
  readonly close: () => void;
}

/**
 * Registers the handlers of the agent channels and sends the agent activity
 * of the open project to the frames that subscribed. The channels are
 * read-only and take no argument. Every handler checks the sender and the
 * arguments first (`createInvokeHandler`) and answers with a view parsed by
 * the contract (`agentActivityView`), so only IDs, names, states, reasons,
 * and times reach the renderer, never a member ID or a device ID.
 *
 * A change of the agent service, and a change of the workspace service,
 * which also reports a new name of a person, raise the view's revision at
 * once and publish the latest view after `AGENT_PUBLISH_INTERVAL_MS`, so at
 * most one view goes out in each interval and the last change of a burst is
 * always sent. Call it before the first window loads.
 */
export function registerAgentIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: AgentIpcOptions,
): AgentIpc {
  const { agents, workspaces } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const onError =
    options.onError ??
    ((message: string, error: unknown) => console.error(message, error));
  const publisher = createEventPublisher(
    EVENT_CHANNELS.agentStateChanged,
    appUrl,
  );

  let closed = false;
  let revision = 0;
  let cancelPublish: (() => void) | null = null;

  function view(): AgentActivityView {
    return agentActivityView(agents.state(), revision, workspaces.memberName);
  }

  function publish(): void {
    cancelPublish = null;
    if (closed) {
      return;
    }
    try {
      publisher.publish(view());
    } catch (error) {
      onError("Sending the agent activity failed.", error);
    }
  }

  function changed(): void {
    if (closed) {
      return;
    }
    revision += 1;
    // A publish that waits sends the latest view when its time comes.
    cancelPublish ??= schedule(publish, AGENT_PUBLISH_INTERVAL_MS);
  }

  ipc.handle(
    INVOKE_CHANNELS.getAgentState,
    createInvokeHandler(INVOKE_CHANNELS.getAgentState, appUrl, () => view()),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribeAgentState,
    createInvokeHandler(
      INVOKE_CHANNELS.subscribeAgentState,
      appUrl,
      (event) => {
        publisher.add(event.sender);
        return view();
      },
    ),
  );
  const removers = [agents.onChange(changed), workspaces.onChange(changed)];

  return Object.freeze({
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const remove of removers) {
        remove();
      }
      cancelPublish?.();
      cancelPublish = null;
    },
  });
}
