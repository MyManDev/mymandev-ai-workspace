import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import {
  AGENT_ACTIVITY_PROBLEMS,
  AGENT_RUN_STATES,
  type AgentActivityView,
  type AgentRunStateView,
  type AgentRunView,
} from "../shared/ipc-contract.ts";
import { AgentPanelContent } from "./AgentPanel.tsx";
import {
  AGENT_PROBLEM_MESSAGES,
  agentTimeFormat,
  formatAgentTime,
  RUN_STATE_LABELS,
  type AgentPanelView,
} from "./agent-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b1";
const OTHER_PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b2";
const BUILDER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c1";
const REVIEWER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c2";

const CREATED_AT = "2026-11-06T08:00:00.000Z";
const FINISHED_AT = "2026-11-06T09:30:00.000Z";
const DISABLED_AT = "2026-11-05T12:00:00.000Z";

function run(
  suffix: string,
  agentId: string,
  state: AgentRunStateView,
  reason: string | null = null,
): AgentRunView {
  const finished =
    state === "completed" || state === "failed" || state === "cancelled";
  return {
    id: `0192f2a0-7c3e-7a1b-8c4d-5e6f7081${suffix}`,
    agentId,
    state,
    reason,
    createdAt: CREATED_AT,
    finishedAt: finished ? FINISHED_AT : null,
  };
}

const READY: AgentActivityView = {
  revision: 4,
  status: "ready",
  workspaceId: WORKSPACE,
  projectId: PROJECT,
  agents: [
    { id: BUILDER, name: "Builder", ownerName: "Ada", disabledAt: null },
    {
      id: REVIEWER,
      name: "Reviewer",
      ownerName: "Grace",
      disabledAt: DISABLED_AT,
    },
  ],
  unfinishedRuns: [
    run("d101", BUILDER, "running"),
    run("d102", REVIEWER, "awaiting_input", "Which branch?"),
    run("d103", BUILDER, "queued"),
  ],
  moreUnfinishedRuns: 0,
  finishedRuns: [
    run("e101", REVIEWER, "cancelled", "device_revoked"),
    run("e102", BUILDER, "failed", "The tests failed."),
    run("e103", BUILDER, "completed"),
  ],
};

const EMPTY_LISTS: Partial<AgentActivityView> = {
  agents: [],
  unfinishedRuns: [],
  moreUnfinishedRuns: 0,
  finishedRuns: [],
};

function known(overrides: Partial<AgentActivityView> = {}): AgentPanelView {
  return {
    kind: "known",
    state: { ...READY, ...overrides } as AgentActivityView,
  };
}

/** A fixed locale and a time zone that is not UTC, whatever the machine's. */
const TOKYO_TIMES = agentTimeFormat({
  locale: "en-GB",
  timeZone: "Asia/Tokyo",
});

/** The times of the fixtures as `TOKYO_TIMES` shows them. */
const SHOWN_TIMES: Readonly<Record<string, string>> = {
  [CREATED_AT]: "6 Nov 2026, 17:00",
  [FINISHED_AT]: "6 Nov 2026, 18:30",
  [DISABLED_AT]: "5 Nov 2026, 21:00",
};

function render(view: AgentPanelView, projectId = PROJECT): string {
  return renderToString(
    <AgentPanelContent
      view={view}
      projectId={projectId}
      timeFormat={TOKYO_TIMES}
    />,
  );
}

/** The status paragraph with `text`, escaped as React escapes text. */
function status(text: string): string {
  return `<p class="agent-status" role="status">${text.replaceAll("'", "&#x27;")}</p>`;
}

function time(timestamp: string): string {
  return `<time dateTime="${timestamp}">${SHOWN_TIMES[timestamp] ?? ""}</time>`;
}

function attributeValues(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map(
    ([, value]) => value ?? "",
  );
}

test("each state without lists shows its text in the status paragraph and no list", () => {
  const cases: [AgentPanelView, string, string][] = [
    [{ kind: "unavailable" }, PROJECT, "Agents are not available."],
    [{ kind: "pending" }, PROJECT, "Checking the agents."],
    [
      known({
        status: "no_project",
        workspaceId: null,
        projectId: null,
        ...EMPTY_LISTS,
      }),
      PROJECT,
      "Agents appear once this device is signed in and the project is open.",
    ],
    [
      known({ status: "loading", ...EMPTY_LISTS }),
      PROJECT,
      "Loading the agents.",
    ],
    // Another project's agents never appear.
    [known(), OTHER_PROJECT, "Loading the agents."],
  ];

  for (const [view, projectId, text] of cases) {
    const html = render(view, projectId);
    expect(html).toBe(`<h2 id="panel-title">Agents</h2>${status(text)}`);
  }
});

test("a ready activity without agents or runs says so for each list, with an empty status paragraph", () => {
  const html = render(known(EMPTY_LISTS));

  expect(html).toBe(
    '<h2 id="panel-title">Agents</h2>' +
      status("") +
      "<p>No agents yet.</p>" +
      '<h3 class="agent-runs-heading" id="unfinished-runs-heading">Runs in progress</h3>' +
      "<p>No runs in progress.</p>" +
      '<h3 class="agent-runs-heading" id="finished-runs-heading">Recently finished runs</h3>' +
      "<p>No finished runs yet.</p>",
  );
});

test("each agent shows its name, its owner's name, and whether it is disabled", () => {
  const html = render(known());

  expect(html).toContain(
    '<ul class="agent-list" aria-labelledby="panel-title">' +
      '<li class="agent" data-state="enabled">' +
      '<p class="agent-name" dir="auto">Builder</p>' +
      '<p class="agent-meta">Owner: <span dir="auto">Ada</span></p>' +
      "</li>" +
      '<li class="agent" data-state="disabled">' +
      '<p class="agent-name" dir="auto">Reviewer</p>' +
      '<p class="agent-meta">Owner: <span dir="auto">Grace</span></p>' +
      `<p class="agent-meta">Disabled since ${time(DISABLED_AT)}</p>` +
      "</li></ul>",
  );
});

test("each run shows its agent, its state as text and as data-state, its reason, and its times", () => {
  const html = render(known());

  expect(html).toContain(
    '<ul class="agent-run-list" aria-labelledby="unfinished-runs-heading">' +
      '<li class="agent-run" data-state="running">' +
      '<p class="agent-run-agent" dir="auto">Builder</p>' +
      '<p class="agent-run-state"><span class="agent-run-dot" aria-hidden="true"></span>Running</p>' +
      `<p class="agent-run-time">Created ${time(CREATED_AT)}</p>` +
      "</li>" +
      '<li class="agent-run" data-state="awaiting_input">' +
      '<p class="agent-run-agent" dir="auto">Reviewer</p>' +
      '<p class="agent-run-state"><span class="agent-run-dot" aria-hidden="true"></span>Waiting for input</p>' +
      '<p class="agent-run-reason" dir="auto">Which branch?</p>' +
      `<p class="agent-run-time">Created ${time(CREATED_AT)}</p>` +
      "</li>",
  );
  expect(html).toContain(
    '<ul class="agent-run-list" aria-labelledby="finished-runs-heading">' +
      '<li class="agent-run" data-state="cancelled">' +
      '<p class="agent-run-agent" dir="auto">Reviewer</p>' +
      '<p class="agent-run-state"><span class="agent-run-dot" aria-hidden="true"></span>Cancelled</p>' +
      '<p class="agent-run-reason" data-cancel-code="device_revoked">Cancelled because the agent&#x27;s device was removed.</p>' +
      `<p class="agent-run-time">Created ${time(CREATED_AT)}</p>` +
      `<p class="agent-run-time">Finished ${time(FINISHED_AT)}</p>` +
      "</li>",
  );
  // The main process's order is kept in both lists.
  expect(attributeValues(html, "data-state").slice(2)).toEqual([
    "running",
    "awaiting_input",
    "queued",
    "cancelled",
    "failed",
    "completed",
  ]);
});

test("without a time format, the times are in the person's locale and the system's time zone", () => {
  const html = renderToString(
    <AgentPanelContent view={known()} projectId={PROJECT} />,
  );
  const system = agentTimeFormat();

  for (const timestamp of [CREATED_AT, FINISHED_AT, DISABLED_AT]) {
    expect(html).toContain(
      `<time dateTime="${timestamp}">${formatAgentTime(timestamp, system)}</time>`,
    );
  }
});

test("every one of the six run states is set as data-state with its own label", () => {
  const html = render(
    known({
      unfinishedRuns: AGENT_RUN_STATES.slice(0, 3).map((state, index) =>
        run(`d20${index}`, BUILDER, state),
      ),
      finishedRuns: AGENT_RUN_STATES.slice(3).map((state, index) =>
        run(`e20${index}`, BUILDER, state),
      ),
    }),
  );

  expect(AGENT_RUN_STATES).toHaveLength(6);
  for (const state of AGENT_RUN_STATES) {
    expect(html).toContain(
      `<li class="agent-run" data-state="${state}"><p class="agent-run-agent" dir="auto">Builder</p><p class="agent-run-state"><span class="agent-run-dot" aria-hidden="true"></span>${RUN_STATE_LABELS[state]}</p>`,
    );
  }
});

test("only a known cancellation code of a cancelled run is replaced by its own text", () => {
  const html = render(
    known({
      unfinishedRuns: [],
      finishedRuns: [
        run("e301", BUILDER, "cancelled", "member_removed"),
        run("e302", BUILDER, "failed", "member_removed"),
        run("e303", BUILDER, "cancelled", "account_erased"),
      ],
    }),
  );

  expect(attributeValues(html, "data-cancel-code")).toEqual(["member_removed"]);
  expect(html).toContain(
    '<p class="agent-run-reason" data-cancel-code="member_removed">Cancelled because a person was removed from the workspace.</p>',
  );
  expect(html).toContain(
    '<p class="agent-run-reason" dir="auto">member_removed</p>',
  );
  expect(html).toContain(
    '<p class="agent-run-reason" dir="auto">account_erased</p>',
  );
});

test("names and reasons are rendered as text, never as markup", () => {
  const html = render(
    known({
      agents: [
        {
          id: BUILDER,
          name: "<b>Builder</b>",
          ownerName: '<img src="x" onerror="alert(1)">',
          disabledAt: null,
        },
      ],
      unfinishedRuns: [
        run("d301", BUILDER, "running", "<script>alert(1)</script>"),
      ],
      finishedRuns: [],
    }),
  );

  expect(html).not.toMatch(/<b>|<img|<script/);
  expect(html).toContain(
    '<p class="agent-name" dir="auto">&lt;b&gt;Builder&lt;/b&gt;</p>',
  );
  expect(html).toContain(
    '<span dir="auto">&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;</span>',
  );
  expect(html).toContain(
    '<p class="agent-run-reason" dir="auto">&lt;script&gt;alert(1)&lt;/script&gt;</p>',
  );
});

test("a run of an agent that the list does not hold shows a fixed name, and older runs in progress are counted", () => {
  const unlisted = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c9";
  const html = render(
    known({
      unfinishedRuns: [run("d401", unlisted, "queued")],
      moreUnfinishedRuns: 12,
    }),
  );

  expect(html).toContain(
    '<p class="agent-run-agent" dir="auto">Unknown agent</p>',
  );
  expect(html).toContain(
    '</ul><p class="agent-note">12 more runs in progress are not shown.</p><h3 class="agent-runs-heading" id="finished-runs-heading">',
  );
  expect(render(known())).not.toContain("agent-note");
});

test("an unavailable activity shows its problem and keeps what was loaded before, or shows only the problem", () => {
  for (const problem of AGENT_ACTIVITY_PROBLEMS) {
    const withData = render(
      known({ status: "unavailable", problem } as Partial<AgentActivityView>),
    );
    expect(withData).toContain(status(AGENT_PROBLEM_MESSAGES[problem]));
    expect(withData).toContain('<p class="agent-name" dir="auto">Builder</p>');

    const withoutData = render(
      known({
        status: "unavailable",
        problem,
        ...EMPTY_LISTS,
      } as Partial<AgentActivityView>),
    );
    expect(withoutData).toBe(
      `<h2 id="panel-title">Agents</h2>${status(AGENT_PROBLEM_MESSAGES[problem])}`,
    );
  }
});

test("the panel's ids are unique, every reference points to one of them, and nothing uses a style attribute", () => {
  const html = render(known({ moreUnfinishedRuns: 2 }));

  const ids = attributeValues(html, "id");
  expect(ids).toEqual([
    "panel-title",
    "unfinished-runs-heading",
    "finished-runs-heading",
  ]);
  for (const reference of attributeValues(html, "aria-labelledby")) {
    expect(ids).toContain(reference);
  }
  // The Content Security Policy allows no inline styles.
  expect(html).not.toMatch(/\sstyle=/);
  // No ID of an agent or a run is shown.
  for (const id of [
    BUILDER,
    REVIEWER,
    ...READY.unfinishedRuns.map((item) => item.id),
    ...READY.finishedRuns.map((item) => item.id),
  ]) {
    expect(html).not.toContain(id);
  }
});
