import { expect, test } from "vitest";
import type { AgentBridge } from "../shared/desktop-bridge.ts";
import {
  AGENT_ACTIVITY_PROBLEMS,
  AGENT_RUN_STATES,
  type AgentActivityView,
  type AgentRunStateView,
  type AgentRunView,
} from "../shared/ipc-contract.ts";
import {
  AGENT_MESSAGES,
  AGENT_PROBLEM_MESSAGES,
  agentTimeFormat,
  describeAgentPanel,
  describeMoreUnfinishedRuns,
  describeRunReason,
  followAgentActivity,
  formatAgentTime,
  initialAgentPanelView,
  RUN_CANCEL_MESSAGES,
  RUN_STATE_LABELS,
  type AgentPanelView,
} from "./agent-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b1";
const OTHER_PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b2";
const BUILDER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c1";
const REVIEWER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c2";
const UNLISTED_AGENT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c3";

const CREATED_AT = "2026-11-06T08:00:00.000Z";
const FINISHED_AT = "2026-11-06T09:30:00.000Z";

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
      disabledAt: "2026-11-05T12:00:00.000Z",
    },
  ],
  // The main process's order, which is not the order of the IDs.
  unfinishedRuns: [
    run("d102", BUILDER, "running"),
    run("d101", REVIEWER, "awaiting_input", "Which branch?"),
    run("d103", BUILDER, "queued"),
  ],
  moreUnfinishedRuns: 0,
  finishedRuns: [
    run("e102", REVIEWER, "cancelled", "member_removed"),
    run("e101", BUILDER, "failed", "The tests failed."),
    run("e103", BUILDER, "completed"),
  ],
};

function known(overrides: Partial<AgentActivityView> = {}): AgentPanelView {
  return {
    kind: "known",
    state: { ...READY, ...overrides } as AgentActivityView,
  };
}

const EMPTY_LISTS: Partial<AgentActivityView> = {
  agents: [],
  unfinishedRuns: [],
  moreUnfinishedRuns: 0,
  finishedRuns: [],
};

test("the view starts pending with the bridge and unavailable without it", () => {
  expect(initialAgentPanelView(true)).toEqual({ kind: "pending" });
  expect(initialAgentPanelView(false)).toEqual({ kind: "unavailable" });
});

test("following the agent activity reports every activity, a refused subscription, and ends the subscription", () => {
  const fake = {
    listener: undefined as ((state: AgentActivityView) => void) | undefined,
    onError: undefined as (() => void) | undefined,
    ended: 0,
  };
  const bridge: Pick<AgentBridge, "subscribeState"> = {
    subscribeState: (listener, onError) => {
      fake.listener = listener;
      fake.onError = onError;
      return () => {
        fake.ended += 1;
      };
    },
  };
  const views: AgentPanelView[] = [];

  const stop = followAgentActivity(bridge, (view) => views.push(view));
  const loading: AgentActivityView = {
    ...READY,
    revision: 1,
    status: "loading",
  };
  fake.listener?.(loading);
  fake.listener?.(READY);
  fake.onError?.();

  expect(views).toEqual([
    { kind: "known", state: loading },
    { kind: "known", state: READY },
    { kind: "unavailable" },
  ]);
  expect(fake.ended).toBe(0);
  stop();
  expect(fake.ended).toBe(1);
});

test("each state without lists has its own fixed text", () => {
  const cases: [AgentPanelView, string][] = [
    [{ kind: "unavailable" }, "Agents are not available."],
    [{ kind: "pending" }, "Checking the agents."],
    [
      known({
        status: "no_project",
        workspaceId: null,
        projectId: null,
        ...EMPTY_LISTS,
      }),
      "Agents appear once this device is signed in and the project is open.",
    ],
    [known({ status: "loading", ...EMPTY_LISTS }), "Loading the agents."],
  ];

  for (const [view, status] of cases) {
    expect(describeAgentPanel(view, PROJECT)).toEqual({ status, lists: null });
  }
});

test("the activity of another project shows the loading text and none of its agents or runs", () => {
  const unavailable = known({
    status: "unavailable",
    problem: "failed",
  } as Partial<AgentActivityView>);

  for (const view of [known(), unavailable]) {
    expect(describeAgentPanel(view, OTHER_PROJECT)).toEqual({
      status: AGENT_MESSAGES.loading,
      lists: null,
    });
  }
});

test("a ready activity lists the agents and runs in the main process's order, each run with its agent's name", () => {
  expect(describeAgentPanel(known(), PROJECT)).toEqual({
    status: "",
    lists: {
      agents: READY.agents,
      unfinishedRuns: [
        {
          id: READY.unfinishedRuns[0]?.id,
          agentName: "Builder",
          state: "running",
          stateLabel: "Running",
          reason: null,
          createdAt: CREATED_AT,
          finishedAt: null,
        },
        {
          id: READY.unfinishedRuns[1]?.id,
          agentName: "Reviewer",
          state: "awaiting_input",
          stateLabel: "Waiting for input",
          reason: { kind: "text", text: "Which branch?" },
          createdAt: CREATED_AT,
          finishedAt: null,
        },
        {
          id: READY.unfinishedRuns[2]?.id,
          agentName: "Builder",
          state: "queued",
          stateLabel: "Queued",
          reason: null,
          createdAt: CREATED_AT,
          finishedAt: null,
        },
      ],
      moreUnfinishedRuns: 0,
      finishedRuns: [
        {
          id: READY.finishedRuns[0]?.id,
          agentName: "Reviewer",
          state: "cancelled",
          stateLabel: "Cancelled",
          reason: {
            kind: "cancel_code",
            code: "member_removed",
            text: "Cancelled because a person was removed from the workspace.",
          },
          createdAt: CREATED_AT,
          finishedAt: FINISHED_AT,
        },
        {
          id: READY.finishedRuns[1]?.id,
          agentName: "Builder",
          state: "failed",
          stateLabel: "Failed",
          reason: { kind: "text", text: "The tests failed." },
          createdAt: CREATED_AT,
          finishedAt: FINISHED_AT,
        },
        {
          id: READY.finishedRuns[2]?.id,
          agentName: "Builder",
          state: "completed",
          stateLabel: "Completed",
          reason: null,
          createdAt: CREATED_AT,
          finishedAt: FINISHED_AT,
        },
      ],
    },
  });
});

test("a run of an agent that the list does not hold shows a fixed name, and the count of older runs passes through", () => {
  const model = describeAgentPanel(
    known({
      unfinishedRuns: [run("d104", UNLISTED_AGENT, "running")],
      moreUnfinishedRuns: 7,
      finishedRuns: [run("e104", UNLISTED_AGENT, "completed")],
    }),
    PROJECT,
  );

  expect(model.lists?.unfinishedRuns.map((row) => row.agentName)).toEqual([
    "Unknown agent",
  ]);
  expect(model.lists?.finishedRuns.map((row) => row.agentName)).toEqual([
    "Unknown agent",
  ]);
  expect(model.lists?.moreUnfinishedRuns).toBe(7);
});

test("a ready activity without agents or runs has empty lists and no status text", () => {
  expect(describeAgentPanel(known(EMPTY_LISTS), PROJECT)).toEqual({
    status: "",
    lists: {
      agents: [],
      unfinishedRuns: [],
      moreUnfinishedRuns: 0,
      finishedRuns: [],
    },
  });
});

test("each problem has its own fixed text, and what was loaded before stays", () => {
  const texts = AGENT_ACTIVITY_PROBLEMS.map(
    (problem) => AGENT_PROBLEM_MESSAGES[problem],
  );
  expect(new Set(texts).size).toBe(AGENT_ACTIVITY_PROBLEMS.length);
  expect(AGENT_PROBLEM_MESSAGES).toEqual({
    not_signed_in: "The server did not accept this device's sign-in.",
    not_found: "The server did not find this project.",
    rate_limited: "The server asked to wait. Trying again in a minute.",
    unavailable: "The server could not be reached. Trying again later.",
    failed: "The agents could not be loaded. Trying again later.",
  });

  const ready = describeAgentPanel(known(), PROJECT);
  for (const problem of AGENT_ACTIVITY_PROBLEMS) {
    const view = known({
      status: "unavailable",
      problem,
    } as Partial<AgentActivityView>);
    expect(describeAgentPanel(view, PROJECT)).toEqual({
      status: AGENT_PROBLEM_MESSAGES[problem],
      lists: ready.lists,
    });
  }
});

test("an unavailable activity with nothing loaded shows only the problem, so no empty list claims what was never loaded", () => {
  const empty = known({
    status: "unavailable",
    problem: "unavailable",
    ...EMPTY_LISTS,
  } as Partial<AgentActivityView>);
  expect(describeAgentPanel(empty, PROJECT)).toEqual({
    status: AGENT_PROBLEM_MESSAGES.unavailable,
    lists: null,
  });

  // A count of older runs alone is something that was loaded.
  const onlyCount = known({
    status: "unavailable",
    problem: "unavailable",
    ...EMPTY_LISTS,
    moreUnfinishedRuns: 3,
  } as Partial<AgentActivityView>);
  expect(describeAgentPanel(onlyCount, PROJECT).lists).not.toBeNull();
});

test("every run state has its own label", () => {
  expect(Object.keys(RUN_STATE_LABELS).sort()).toEqual(
    [...AGENT_RUN_STATES].sort(),
  );
  const labels = AGENT_RUN_STATES.map((state) => RUN_STATE_LABELS[state]);
  expect(new Set(labels).size).toBe(AGENT_RUN_STATES.length);
});

// The renderer cannot import the protocol package, so the codes of its
// RUN_CANCEL_REASONS are written out here; config/renderer-protocol.test.ts
// checks them against the protocol.
test("each known cancellation code has its own text", () => {
  expect(RUN_CANCEL_MESSAGES).toEqual({
    member_removed:
      "Cancelled because a person was removed from the workspace.",
    device_revoked: "Cancelled because the agent's device was removed.",
  });
});

test("a known cancellation code of a cancelled run is its own text, and every other reason is the text it is", () => {
  const reason = (state: AgentRunStateView, text: string | null) =>
    describeRunReason(run("f101", BUILDER, state, text));

  expect(reason("cancelled", "device_revoked")).toEqual({
    kind: "cancel_code",
    code: "device_revoked",
    text: "Cancelled because the agent's device was removed.",
  });
  expect(reason("cancelled", "member_removed")).toEqual({
    kind: "cancel_code",
    code: "member_removed",
    text: "Cancelled because a person was removed from the workspace.",
  });
  expect(reason("cancelled", null)).toBeNull();
  // A code in another state, an unknown code, another case, and the names
  // of the object's prototype are text.
  for (const [state, text] of [
    ["failed", "member_removed"],
    ["awaiting_input", "device_revoked"],
    ["cancelled", "account_erased"],
    ["cancelled", "MEMBER_REMOVED"],
    ["cancelled", " member_removed"],
    ["cancelled", "toString"],
    ["cancelled", "constructor"],
    ["cancelled", "__proto__"],
    ["cancelled", "Stopped by its owner."],
  ] as const) {
    expect(reason(state, text)).toEqual({ kind: "text", text });
  }
});

test("the note about older runs in progress counts them, with the digits grouped in the locale", () => {
  const english = new Intl.NumberFormat("en-US");

  expect(describeMoreUnfinishedRuns(1, english)).toBe(
    "1 more run in progress is not shown.",
  );
  expect(describeMoreUnfinishedRuns(2, english)).toBe(
    "2 more runs in progress are not shown.",
  );
  expect(describeMoreUnfinishedRuns(1200, english)).toBe(
    "1,200 more runs in progress are not shown.",
  );
  expect(describeMoreUnfinishedRuns(1200, new Intl.NumberFormat("de-DE"))).toBe(
    "1.200 more runs in progress are not shown.",
  );
  // Without a format, the person's locale groups the digits.
  expect(describeMoreUnfinishedRuns(1200)).toBe(
    `${new Intl.NumberFormat().format(1200)} more runs in progress are not shown.`,
  );
});

test("a time is shown in the time zone of the format, by default the system's, and a timestamp that is not a date stays as it is", () => {
  const at = (timeZone: string) =>
    formatAgentTime(
      FINISHED_AT,
      agentTimeFormat({ locale: "en-GB", timeZone }),
    );

  // 09:30 UTC; two zones that are not UTC, so a fixed UTC zone fails here
  // also on a machine whose zone is UTC.
  expect(at("UTC")).toBe("6 Nov 2026, 09:30");
  expect(at("Asia/Tokyo")).toBe("6 Nov 2026, 18:30");
  expect(at("America/New_York")).toBe("6 Nov 2026, 04:30");
  expect(
    formatAgentTime("not a time", agentTimeFormat({ timeZone: "Asia/Tokyo" })),
  ).toBe("not a time");

  // The defaults are the system's time zone and the person's locale.
  const system = new Intl.DateTimeFormat().resolvedOptions();
  const defaults = agentTimeFormat().resolvedOptions();
  expect(defaults.timeZone).toBe(system.timeZone);
  expect(defaults.locale).toBe(system.locale);
  expect(defaults.dateStyle).toBe("medium");
  expect(defaults.timeStyle).toBe("short");
  // Each call makes a new format, so a changed system zone is used.
  expect(agentTimeFormat()).not.toBe(agentTimeFormat());
});
