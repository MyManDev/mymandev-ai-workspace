import { expect, test } from "vitest";
import type {
  AgentActivityView,
  AgentView,
  ChatMessageView,
  ProviderConnectionListView,
  RunRequestOutcome,
  RunRequestResult,
  RunRequestView,
} from "../shared/ipc-contract.ts";
import { RUN_REQUEST_REFUSALS } from "../shared/ipc-contract.ts";
import {
  cancelRunForm,
  canRunWith,
  closeRunForm,
  chooseRunAgent,
  confirmedRunRequest,
  continueRunForm,
  createRunRequestController,
  describeRunForm,
  describeRunResult,
  IDLE_RUN_REQUEST,
  openRunForm,
  RUN_REFUSAL_MESSAGES,
  RUN_REQUEST_MESSAGES,
  runConnections,
  runnableAgents,
  type RunRequestState,
  showKeptRunOutcome,
} from "./run-request-view.ts";

// The "Run with agent" action of the project chat (#35, part A), without a
// DOM: which agents and connections are offered, the form's steps, the
// sentence of every answer, and that a request goes once and never again
// on its own.

const PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b1";
const OTHER_PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b2";
const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const RUNNABLE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192f1";
const SECOND = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192f2";
const ELSEWHERE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192f3";
const THEIRS = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192f4";
const DISABLED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192f5";
const CONNECTION = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819301";
const OTHER_CONNECTION = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819302";
const MINE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d1";
const THEIR_MESSAGE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d2";
const RUN = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819401";
const AT = "2026-11-25T08:00:00.000Z";

function agent(overrides: Partial<AgentView>): AgentView {
  return {
    id: RUNNABLE,
    name: "Builder",
    ownerName: "Ada",
    disabledAt: null,
    ownedByMe: true,
    grantableHere: true,
    hostedElsewhere: false,
    ...overrides,
  };
}

function activity(
  overrides: Partial<AgentActivityView> = {},
): AgentActivityView {
  return {
    revision: 3,
    status: "ready",
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    agents: [
      agent({}),
      agent({ id: SECOND, name: "Reviewer" }),
      agent({ id: ELSEWHERE, grantableHere: false, hostedElsewhere: true }),
      agent({ id: THEIRS, ownedByMe: false, grantableHere: false }),
      agent({ id: DISABLED, disabledAt: AT, grantableHere: false }),
    ],
    unfinishedRuns: [],
    moreUnfinishedRuns: 0,
    finishedRuns: [],
    ...overrides,
  } as AgentActivityView;
}

function connections(
  overrides: Partial<ProviderConnectionListView> = {},
): ProviderConnectionListView {
  return {
    revision: 2,
    status: "ready",
    connections: [
      {
        id: CONNECTION,
        kind: "claude",
        label: "Work laptop",
        createdAt: AT,
        status: "registered",
      },
      {
        id: OTHER_CONNECTION,
        kind: "codex",
        label: "Home",
        createdAt: AT,
        status: "unknown",
      },
    ],
    ...overrides,
  } as ProviderConnectionListView;
}

function message(overrides: Partial<ChatMessageView> = {}): ChatMessageView {
  return {
    id: MINE,
    seq: 1,
    authorKind: "member",
    authorName: "Ada",
    writtenByMe: true,
    body: "Fix the build",
    createdAt: AT,
    ...overrides,
  };
}

const MESSAGES: readonly ChatMessageView[] = [
  message(),
  message({
    id: THEIR_MESSAGE,
    seq: 2,
    authorName: "Grace",
    writtenByMe: false,
  }),
];

function form(
  state: RunRequestState,
  overrides: {
    activity?: AgentActivityView | undefined;
    connections?: ProviderConnectionListView | undefined;
  } = {},
) {
  return describeRunForm(
    state,
    MESSAGES,
    "activity" in overrides ? overrides.activity : activity(),
    "connections" in overrides ? overrides.connections : connections(),
    PROJECT,
  );
}

test("only the person's own messages offer Run with agent", () => {
  expect(canRunWith(message())).toBe(true);
  expect(canRunWith(message({ writtenByMe: false }))).toBe(false);
  // An agent's message is never the person's, whatever its flag says.
  expect(canRunWith(message({ authorKind: "agent", writtenByMe: true }))).toBe(
    false,
  );
});

test("the agents offered are the enabled ones that the account owns and this device hosts, of the project that the chat shows", () => {
  expect(runnableAgents(activity(), PROJECT)).toEqual([
    { id: RUNNABLE, label: "Builder" },
    { id: SECOND, label: "Reviewer" },
  ]);
  // Not known: no activity, another project's, none open, or loading.
  expect(runnableAgents(undefined, PROJECT)).toBeNull();
  expect(
    runnableAgents(activity({ projectId: OTHER_PROJECT }), PROJECT),
  ).toBeNull();
  expect(
    runnableAgents(activity({ status: "no_project" }), PROJECT),
  ).toBeNull();
  expect(runnableAgents(activity({ status: "loading" }), PROJECT)).toBeNull();
  // An agent marked grantable but disabled is still not offered.
  expect(
    runnableAgents(activity({ agents: [agent({ disabledAt: AT })] }), PROJECT),
  ).toEqual([]);
});

test("the connections offered are this device's, each with its provider's name", () => {
  expect(runConnections(connections())).toEqual([
    { id: CONNECTION, label: "Work laptop (Claude)" },
    { id: OTHER_CONNECTION, label: "Home (Codex)" },
  ]);
  expect(runConnections(undefined)).toBeNull();
  expect(runConnections(connections({ status: "loading" }))).toBeNull();
  expect(runConnections(connections({ status: "signed_out" }))).toBeNull();
  // What was read before stays offered while a read fails.
  expect(
    runConnections({
      ...connections(),
      status: "unavailable",
      problem: "unavailable",
    } as ProviderConnectionListView),
  ).toHaveLength(2);
});

test("a form opens on an own message only, with the first agent and connection chosen until the person chooses others", () => {
  expect(form(IDLE_RUN_REQUEST)).toBeNull();
  expect(form(openRunForm(IDLE_RUN_REQUEST, THEIR_MESSAGE))).toBeNull();
  // A message that the chat no longer shows closes the form.
  expect(
    form(openRunForm(IDLE_RUN_REQUEST, "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d9")),
  ).toBeNull();

  const opened = openRunForm(IDLE_RUN_REQUEST, MINE);
  expect(form(opened)).toEqual({
    messageId: MINE,
    step: "choose",
    sending: false,
    agents: [
      { id: RUNNABLE, label: "Builder" },
      { id: SECOND, label: "Reviewer" },
    ],
    connections: [
      { id: CONNECTION, label: "Work laptop (Claude)" },
      { id: OTHER_CONNECTION, label: "Home (Codex)" },
    ],
    agentId: RUNNABLE,
    connectionId: CONNECTION,
    problem: undefined,
    canContinue: true,
    agentLabel: "Builder",
    connectionLabel: "Work laptop (Claude)",
  });
  const chosen = chooseRunAgent(opened, SECOND);
  expect(form(chosen)?.agentId).toBe(SECOND);
  // An agent that is not offered is never chosen.
  expect(form(chooseRunAgent(opened, ELSEWHERE))?.agentId).toBe(RUNNABLE);
});

test("each reason why nothing can be requested shows in the form, and Continue does nothing", () => {
  const opened = openRunForm(IDLE_RUN_REQUEST, MINE);
  const cases: [Parameters<typeof form>[1], string][] = [
    [{ activity: undefined }, RUN_REQUEST_MESSAGES.agentsPending],
    [
      { activity: activity({ status: "loading" }) },
      RUN_REQUEST_MESSAGES.agentsPending,
    ],
    [
      {
        activity: {
          ...activity(),
          agents: [],
          status: "unavailable",
          problem: "unavailable",
        } as AgentActivityView,
      },
      RUN_REQUEST_MESSAGES.agentsUnavailable,
    ],
    [
      { activity: activity({ agents: [agent({ grantableHere: false })] }) },
      RUN_REQUEST_MESSAGES.noAgents,
    ],
    [{ connections: undefined }, RUN_REQUEST_MESSAGES.connectionsPending],
    [
      { connections: connections({ status: "signed_out", connections: [] }) },
      RUN_REQUEST_MESSAGES.connectionsSignedOut,
    ],
    [
      { connections: connections({ connections: [] }) },
      RUN_REQUEST_MESSAGES.noConnections,
    ],
  ];
  for (const [overrides, problem] of cases) {
    const model = form(opened, overrides);
    expect(model?.problem, problem).toBe(problem);
    expect(model?.canContinue).toBe(false);
    expect(continueRunForm(opened, model)).toBe(opened);
  }
});

test("Continue asks for a confirmation that names the agent and the connection, Cancel goes back, and a second Cancel closes the form", () => {
  const opened = chooseRunAgent(openRunForm(IDLE_RUN_REQUEST, MINE), SECOND);
  const confirming = continueRunForm(opened, form(opened));
  const model = form(confirming);
  expect(model?.step).toBe("confirm");
  expect(model?.agentLabel).toBe("Reviewer");
  expect(model?.connectionLabel).toBe("Work laptop (Claude)");

  const back = cancelRunForm(confirming, model);
  expect(form(back)?.step).toBe("choose");
  expect(form(back)?.agentId).toBe(SECOND);
  const closed = cancelRunForm(back, form(back));
  expect(form(closed)).toBeNull();
  // The focus goes back to the message's action.
  expect(closed.returnFocusTo).toBe(MINE);
  expect(closed.focus).toBe("trigger");
});

test("Cancel decides by the shown step: a confirmation that fell back to the choice closes with one Cancel", () => {
  const opened = chooseRunAgent(openRunForm(IDLE_RUN_REQUEST, MINE), SECOND);
  const confirming = continueRunForm(opened, form(opened));
  expect(confirming.step).toBe("confirm");
  // The chosen agent is no longer offered: the choice shows.
  const shown = form(confirming, {
    activity: activity({ agents: [agent({})] }),
  });
  expect(shown?.step).toBe("choose");
  const closed = cancelRunForm(confirming, shown);
  expect(closed.messageId).toBeNull();
  expect(closed.focus).toBe("trigger");
  expect(closed.returnFocusTo).toBe(MINE);
  // Without a shown form, Cancel closes too.
  expect(cancelRunForm(confirming, null).messageId).toBeNull();
  // While a request waits, it changes nothing.
  const sending = { ...confirming, sending: true };
  expect(cancelRunForm(sending, form(sending))).toBe(sending);
});

test("Run with agent on an open form closes it from either step, and keeps the last sentence", () => {
  const opened = openRunForm(
    { ...IDLE_RUN_REQUEST, notice: RUN_REQUEST_MESSAGES.requested },
    MINE,
  );
  const confirming = continueRunForm(opened, form(opened));
  for (const state of [opened, confirming]) {
    const closed = closeRunForm(state);
    expect(form(closed)).toBeNull();
    expect(closed.notice).toBe(RUN_REQUEST_MESSAGES.requested);
    expect(closed.returnFocusTo).toBe(MINE);
    expect(closed.focus).toBe("trigger");
  }
  expect(closeRunForm(IDLE_RUN_REQUEST)).toBe(IDLE_RUN_REQUEST);
  const sending = { ...confirming, sending: true };
  expect(closeRunForm(sending)).toBe(sending);
});

test("the controller's close ends the form from the confirmation, where its Cancel steps back", () => {
  const c = controlled();
  c.controller.open(MINE);
  c.controller.continue(c.form());
  expect(c.form()?.step).toBe("confirm");
  c.controller.cancel(c.form());
  expect(c.form()?.step).toBe("choose");
  c.controller.continue(c.form());
  c.controller.close();
  expect(c.form()).toBeNull();
  expect(c.state().focus).toBe("trigger");
});

test("a confirmation whose agent or connection is no longer offered goes back to the choice, never to another agent", () => {
  const opened = chooseRunAgent(openRunForm(IDLE_RUN_REQUEST, MINE), SECOND);
  const confirming = continueRunForm(opened, form(opened));
  const gone = form(confirming, {
    activity: activity({ agents: [agent({})] }),
  });
  expect(gone?.step).toBe("choose");
  expect(confirmedRunRequest(confirming, gone, PROJECT)).toBeNull();
  const noConnection = form(confirming, {
    connections: connections({
      connections: [connections().connections[1]!],
    }),
  });
  expect(noConnection?.step).toBe("choose");
  expect(confirmedRunRequest(confirming, noConnection, PROJECT)).toBeNull();
});

test("only a shown confirmation yields the request, with the four IDs", () => {
  const opened = openRunForm(IDLE_RUN_REQUEST, MINE);
  expect(confirmedRunRequest(opened, form(opened), PROJECT)).toBeNull();
  const confirming = continueRunForm(opened, form(opened));
  expect(confirmedRunRequest(confirming, form(confirming), PROJECT)).toEqual({
    projectId: PROJECT,
    agentId: RUNNABLE,
    providerConnectionId: CONNECTION,
    inputMessageId: MINE,
  });
  expect(
    confirmedRunRequest(
      { ...confirming, sending: true },
      form(confirming),
      PROJECT,
    ),
  ).toBeNull();
});

test("every answer has one sentence; the waits say how long, and an uncertain answer says that the run may have been created", () => {
  expect(describeRunResult({ outcome: "ok", runId: RUN })).toBe(
    RUN_REQUEST_MESSAGES.requested,
  );
  expect(describeRunResult({ outcome: "unknown" })).toBe(
    RUN_REQUEST_MESSAGES.unknown,
  );
  expect(RUN_REQUEST_MESSAGES.unknown).toContain("may have been");
  // Nothing promises that the run will run.
  for (const text of [
    RUN_REQUEST_MESSAGES.requested,
    RUN_REQUEST_MESSAGES.note,
    RUN_REQUEST_MESSAGES.confirmText,
  ]) {
    expect(text).not.toMatch(/\bwill (run|start|execute)\b/i);
  }
  expect(RUN_REQUEST_MESSAGES.note).toContain("does not start it");
  expect(Object.keys(RUN_REFUSAL_MESSAGES).sort()).toEqual(
    [...RUN_REQUEST_REFUSALS].sort(),
  );
  const sentences = new Set<string>();
  for (const reason of RUN_REQUEST_REFUSALS) {
    const wait =
      reason === "too_soon" ||
      reason === "rate_limited" ||
      reason === "run_daily_limit";
    const text = describeRunResult({
      outcome: "refused",
      reason,
      retryAfterMs: wait ? 3 * 60 * 60 * 1000 : null,
    } as RunRequestResult);
    expect(text.startsWith(`${RUN_REQUEST_MESSAGES.notRequested} `)).toBe(true);
    if (wait) {
      expect(text, reason).toContain("Try again in 3 hours.");
    }
    sentences.add(text);
  }
  // Each refusal has its own sentence.
  expect(sentences.size).toBe(RUN_REQUEST_REFUSALS.length);
  expect(
    describeRunResult({
      outcome: "refused",
      reason: "run_limit",
      retryAfterMs: null,
    }),
  ).toContain("unfinished runs");
  expect(
    describeRunResult({
      outcome: "refused",
      reason: "run_daily_limit",
      retryAfterMs: 90_000,
    }),
  ).toBe(
    `${RUN_REQUEST_MESSAGES.notRequested} The agent got as many new runs in 24 hours as it may get (100). Try again in 2 minutes.`,
  );
  // The server's 404 also answers for the project: an unknown project, or
  // an account that is not or no longer a member of its workspace.
  expect(RUN_REFUSAL_MESSAGES.not_found).toContain(
    "did not find the project for your account",
  );
  expect(RUN_REFUSAL_MESSAGES.not_found).toContain("not or no longer a member");
  // A kept outcome has no run ID and says the same.
  expect(describeRunResult({ outcome: "ok" })).toBe(
    RUN_REQUEST_MESSAGES.requested,
  );
});

/** A bridge whose answers the test gives. */
function fakeAgents() {
  const calls: RunRequestView[] = [];
  const answers: {
    resolve: (result: RunRequestResult) => void;
    reject: (error: unknown) => void;
  }[] = [];
  /** The project of each take, and its answer. */
  const takes: string[] = [];
  const taken: {
    resolve: (outcome: RunRequestOutcome | null) => void;
    reject: (error: unknown) => void;
  }[] = [];
  return {
    calls,
    answers,
    takes,
    taken,
    bridge: {
      requestRun: (request: RunRequestView) => {
        calls.push(request);
        return new Promise<RunRequestResult>((resolve, reject) => {
          answers.push({ resolve, reject });
        });
      },
      takeRunRequestOutcome: (projectId: string) => {
        takes.push(projectId);
        return new Promise<RunRequestOutcome | null>((resolve, reject) => {
          taken.push({ resolve, reject });
        });
      },
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

/**
 * A started controller whose state the test reads, with its form for the
 * project. Nothing is kept for the project.
 */
function controlled() {
  const fake = fakeAgents();
  let state = IDLE_RUN_REQUEST;
  const controller = createRunRequestController(
    fake.bridge,
    PROJECT,
    (next) => {
      state = next;
    },
  );
  const stop = controller.start();
  fake.taken[0]?.resolve(null);
  return {
    fake,
    controller,
    stop,
    state: () => state,
    form: () => form(state),
  };
}

test("the confirmation sends the request once; while it waits, nothing else changes or is sent; the answer closes the form with its sentence", async () => {
  const c = controlled();
  c.controller.open(MINE);
  // Nothing is sent from the choice.
  c.controller.confirm(c.form());
  expect(c.fake.calls).toEqual([]);
  c.controller.continue(c.form());
  const shown = c.form();
  c.controller.confirm(shown);
  // A second press, and every other action, while it waits.
  c.controller.confirm(shown);
  c.controller.cancel(shown);
  c.controller.close();
  c.controller.open(MINE);
  c.controller.chooseAgent(SECOND);
  expect(c.fake.calls).toEqual([
    {
      projectId: PROJECT,
      agentId: RUNNABLE,
      providerConnectionId: CONNECTION,
      inputMessageId: MINE,
    },
  ]);
  expect(c.state().sending).toBe(true);
  expect(c.form()?.canContinue).toBe(false);

  c.fake.answers[0]?.resolve({ outcome: "ok", runId: RUN });
  await settle();
  expect(c.state().notice).toBe(RUN_REQUEST_MESSAGES.requested);
  expect(c.form()).toBeNull();
  expect(c.state().focus).toBe("notice");
  expect(c.fake.calls).toHaveLength(1);
});

test("an uncertain answer and a rejected call say that the run may have been created, and nothing is sent again", async () => {
  for (const settleWith of [
    (answer: { resolve: (r: RunRequestResult) => void }) =>
      answer.resolve({ outcome: "unknown" }),
    (answer: { reject: (error: unknown) => void }) =>
      answer.reject(new Error("lost")),
  ]) {
    const c = controlled();
    c.controller.open(MINE);
    c.controller.continue(c.form());
    c.controller.confirm(c.form());
    settleWith(c.fake.answers[0]!);
    await settle();
    expect(c.state().notice).toBe(RUN_REQUEST_MESSAGES.unknown);
    expect(c.state().sending).toBe(false);
    await settle();
    expect(c.fake.calls).toHaveLength(1);
  }
});

test("a refusal closes the form with its sentence, and only a new confirmation sends again", async () => {
  const c = controlled();
  c.controller.open(MINE);
  c.controller.continue(c.form());
  c.controller.confirm(c.form());
  c.fake.answers[0]?.resolve({
    outcome: "refused",
    reason: "run_limit",
    retryAfterMs: null,
  });
  await settle();
  expect(c.state().notice).toBe(
    `${RUN_REQUEST_MESSAGES.notRequested} ${RUN_REFUSAL_MESSAGES.run_limit}`,
  );
  expect(c.fake.calls).toHaveLength(1);
  // The person asks again: open, continue, and confirm once more.
  c.controller.open(MINE);
  expect(c.state().notice).toBe(
    `${RUN_REQUEST_MESSAGES.notRequested} ${RUN_REFUSAL_MESSAGES.run_limit}`,
  );
  c.controller.continue(c.form());
  c.controller.confirm(c.form());
  expect(c.fake.calls).toHaveLength(2);
});

test("an answer after the screen stopped changes nothing, and stays in the main process for the next screen", async () => {
  const c = controlled();
  c.controller.open(MINE);
  c.controller.continue(c.form());
  c.controller.confirm(c.form());
  const before = c.state();
  c.stop();
  c.fake.answers[0]?.resolve({ outcome: "ok", runId: RUN });
  await settle();
  expect(c.state()).toBe(before);
  // Not taken: the next screen of the project shows it.
  expect(c.fake.takes).toEqual([PROJECT]);
});

test("React's development mode stops and starts the controller again, and an answer still shows (StrictMode)", async () => {
  const fake = fakeAgents();
  let state = IDLE_RUN_REQUEST;
  const controller = createRunRequestController(
    fake.bridge,
    PROJECT,
    (next) => {
      state = next;
    },
  );
  // The effect, its cleanup, and the effect again, with the same controller.
  const stopFirst = controller.start();
  stopFirst();
  const stop = controller.start();
  // The kept outcome is asked for once, and its answer still shows.
  expect(fake.takes).toEqual([PROJECT]);
  fake.taken[0]?.resolve({ outcome: "unknown" });
  await settle();
  expect(state.notice).toBe(RUN_REQUEST_MESSAGES.unknown);

  controller.open(MINE);
  controller.continue(form(state));
  controller.confirm(form(state));
  fake.answers[0]?.resolve({ outcome: "ok", runId: RUN });
  await settle();
  expect(state.notice).toBe(RUN_REQUEST_MESSAGES.requested);
  expect(state.sending).toBe(false);
  expect(form(state)).toBeNull();
  stop();
});

test("the first start shows the outcome that the main process kept for the project once, without moving the focus", async () => {
  const fake = fakeAgents();
  let state = IDLE_RUN_REQUEST;
  const controller = createRunRequestController(
    fake.bridge,
    PROJECT,
    (next) => {
      state = next;
    },
  );
  // Nothing is asked before the screen shows.
  expect(fake.takes).toEqual([]);
  const stop = controller.start();
  expect(fake.takes).toEqual([PROJECT]);
  // The person opened a form and cancelled it meanwhile: the focus went
  // back to the message's action, and the kept outcome does not move it.
  controller.open(MINE);
  controller.cancel(form(state));
  expect(state.focus).toBe("trigger");
  fake.taken[0]?.resolve({
    outcome: "refused",
    reason: "run_daily_limit",
    retryAfterMs: 90_000,
  });
  await settle();
  expect(state.notice).toBe(
    `${RUN_REQUEST_MESSAGES.notRequested} ${RUN_REFUSAL_MESSAGES.run_daily_limit("2 minutes")}`,
  );
  expect(state.focus).toBeNull();
  // Started again, it does not ask again.
  stop();
  controller.start();
  expect(fake.takes).toEqual([PROJECT]);
});

test("a kept outcome that arrives after the screen stopped, nothing kept, or a failed take changes nothing", async () => {
  const cases: [boolean, (fake: ReturnType<typeof fakeAgents>) => void][] = [
    [true, (fake) => fake.taken[0]?.resolve({ outcome: "unknown" })],
    [false, (fake) => fake.taken[0]?.resolve(null)],
    [false, (fake) => fake.taken[0]?.reject(new Error("lost"))],
  ];
  for (const [stopFirst, finish] of cases) {
    const fake = fakeAgents();
    const states: RunRequestState[] = [];
    const controller = createRunRequestController(
      fake.bridge,
      PROJECT,
      (next) => states.push(next),
    );
    const stop = controller.start();
    if (stopFirst) {
      stop();
    }
    finish(fake);
    await settle();
    expect(states).toEqual([]);
  }
});

test("a kept outcome never replaces the wait of a request of the screen itself", () => {
  const sending = { ...IDLE_RUN_REQUEST, messageId: MINE, sending: true };
  expect(showKeptRunOutcome(sending, { outcome: "unknown" })).toBe(sending);
  const open = {
    ...openRunForm(IDLE_RUN_REQUEST, MINE),
    focus: "notice" as const,
  };
  expect(showKeptRunOutcome(open, { outcome: "ok" })).toEqual({
    ...open,
    notice: RUN_REQUEST_MESSAGES.requested,
    focus: null,
  });
});

test("an answer that the screen showed is taken from the main process, except a refusal of the main process's own checks, which it never keeps", async () => {
  const cases: [RunRequestResult, boolean][] = [
    [{ outcome: "ok", runId: RUN }, true],
    [{ outcome: "unknown" }, true],
    [{ outcome: "refused", reason: "run_limit", retryAfterMs: null }, true],
    [{ outcome: "refused", reason: "not_signed_in", retryAfterMs: null }, true],
    [{ outcome: "refused", reason: "busy", retryAfterMs: null }, false],
    [
      { outcome: "refused", reason: "message_not_found", retryAfterMs: null },
      false,
    ],
  ];
  for (const [result, takes] of cases) {
    const c = controlled();
    c.controller.open(MINE);
    c.controller.continue(c.form());
    c.controller.confirm(c.form());
    c.fake.answers[0]?.resolve(result);
    await settle();
    expect(c.state().notice, JSON.stringify(result)).toBe(
      describeRunResult(result),
    );
    // The first take is the start's.
    expect(c.fake.takes, JSON.stringify(result)).toEqual(
      takes ? [PROJECT, PROJECT] : [PROJECT],
    );
    // What that take answers changes nothing on the screen.
    const shown = c.state();
    c.fake.taken[1]?.resolve({ outcome: "unknown" });
    await settle();
    expect(c.state()).toBe(shown);
  }
  // A rejected call is not taken: what the main process kept shows on the
  // next screen.
  const c = controlled();
  c.controller.open(MINE);
  c.controller.continue(c.form());
  c.controller.confirm(c.form());
  c.fake.answers[0]?.reject(new Error("lost"));
  await settle();
  expect(c.fake.takes).toEqual([PROJECT]);
});
