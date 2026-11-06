import { useEffect, useState } from "react";
import type { AgentBridge } from "../shared/desktop-bridge.ts";
import type { AgentView } from "../shared/ipc-contract.ts";
import {
  AGENT_MESSAGES,
  agentTimeFormat,
  describeAgentPanel,
  describeMoreUnfinishedRuns,
  followAgentActivity,
  formatAgentTime,
  initialAgentPanelView,
  type AgentPanelView,
  type RunRow,
} from "./agent-view.ts";

/**
 * The agents of the side panel: the open project's agents with their
 * owners, its runs in progress, and its recently finished runs, read-only.
 * The main process keeps them current with the run events of the
 * workspace.
 */
export function AgentPanel({
  agents,
  projectId,
}: {
  /** The agent functions from the preload script; undefined outside Electron. */
  readonly agents: AgentBridge | undefined;
  readonly projectId: string;
}) {
  return (
    <AgentPanelContent view={useAgentPanel(agents)} projectId={projectId} />
  );
}

export interface AgentPanelContentProps {
  readonly view: AgentPanelView;
  /** The project that the shell shows; another project's activity is not shown. */
  readonly projectId: string;
  /**
   * The format of the times, for tests. By default, a new `agentTimeFormat`
   * for each render, in the person's locale and the system's time zone.
   */
  readonly timeFormat?: Intl.DateTimeFormat | undefined;
}

/**
 * The panel for a view, without state. The status paragraph is always
 * rendered, empty when there is nothing to say, so that a screen reader
 * announces a new text. Names and reasons are text that people and agents
 * entered, so each one takes its direction from its own content
 * (`dir="auto"`). A run's state is text; its dot only repeats it in color.
 */
export function AgentPanelContent({
  view,
  projectId,
  timeFormat,
}: AgentPanelContentProps) {
  const { status, lists } = describeAgentPanel(view, projectId);
  const format = timeFormat ?? agentTimeFormat();
  return (
    <>
      <h2 id="panel-title">Agents</h2>
      <p className="agent-status" role="status">
        {status}
      </p>
      {lists === null ? null : (
        <>
          <AgentList agents={lists.agents} format={format} />
          <h3 className="agent-runs-heading" id="unfinished-runs-heading">
            Runs in progress
          </h3>
          <RunList
            runs={lists.unfinishedRuns}
            labelledBy="unfinished-runs-heading"
            empty={AGENT_MESSAGES.noUnfinishedRuns}
            format={format}
          />
          {lists.moreUnfinishedRuns === 0 ? null : (
            <p className="agent-note">
              {describeMoreUnfinishedRuns(lists.moreUnfinishedRuns)}
            </p>
          )}
          <h3 className="agent-runs-heading" id="finished-runs-heading">
            Recently finished runs
          </h3>
          <RunList
            runs={lists.finishedRuns}
            labelledBy="finished-runs-heading"
            empty={AGENT_MESSAGES.noFinishedRuns}
            format={format}
          />
        </>
      )}
    </>
  );
}

function AgentList({
  agents,
  format,
}: {
  readonly agents: readonly AgentView[];
  readonly format: Intl.DateTimeFormat;
}) {
  if (agents.length === 0) {
    return <p>{AGENT_MESSAGES.noAgents}</p>;
  }
  return (
    <ul className="agent-list" aria-labelledby="panel-title">
      {agents.map((agent) => (
        <li
          className="agent"
          key={agent.id}
          data-state={agent.disabledAt === null ? "enabled" : "disabled"}
        >
          <p className="agent-name" dir="auto">
            {agent.name}
          </p>
          <p className="agent-meta">
            Owner: <span dir="auto">{agent.ownerName}</span>
          </p>
          {agent.disabledAt === null ? null : (
            <p className="agent-meta">
              {"Disabled since "}
              <Time timestamp={agent.disabledAt} format={format} />
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function RunList({
  runs,
  labelledBy,
  empty,
  format,
}: {
  readonly runs: readonly RunRow[];
  readonly labelledBy: string;
  /** The text without runs. */
  readonly empty: string;
  readonly format: Intl.DateTimeFormat;
}) {
  if (runs.length === 0) {
    return <p>{empty}</p>;
  }
  return (
    <ul className="agent-run-list" aria-labelledby={labelledBy}>
      {runs.map((run) => (
        <RunItem key={run.id} run={run} format={format} />
      ))}
    </ul>
  );
}

function RunItem({
  run,
  format,
}: {
  readonly run: RunRow;
  readonly format: Intl.DateTimeFormat;
}) {
  const { reason } = run;
  return (
    <li className="agent-run" data-state={run.state}>
      <p className="agent-run-agent" dir="auto">
        {run.agentName}
      </p>
      <p className="agent-run-state">
        <span className="agent-run-dot" aria-hidden="true" />
        {run.stateLabel}
      </p>
      {reason === null ? null : reason.kind === "cancel_code" ? (
        <p className="agent-run-reason" data-cancel-code={reason.code}>
          {reason.text}
        </p>
      ) : (
        <p className="agent-run-reason" dir="auto">
          {reason.text}
        </p>
      )}
      <p className="agent-run-time">
        Created <Time timestamp={run.createdAt} format={format} />
      </p>
      {run.finishedAt === null ? null : (
        <p className="agent-run-time">
          Finished <Time timestamp={run.finishedAt} format={format} />
        </p>
      )}
    </li>
  );
}

function Time({
  timestamp,
  format,
}: {
  readonly timestamp: string;
  readonly format: Intl.DateTimeFormat;
}) {
  return <time dateTime={timestamp}>{formatAgentTime(timestamp, format)}</time>;
}

/** Follows the agent activity while the panel is shown. */
function useAgentPanel(bridge: AgentBridge | undefined): AgentPanelView {
  const [view, setView] = useState(() =>
    initialAgentPanelView(bridge !== undefined),
  );
  useEffect(
    () =>
      bridge === undefined ? undefined : followAgentActivity(bridge, setView),
    [bridge],
  );
  return view;
}
