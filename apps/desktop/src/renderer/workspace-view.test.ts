import { expect, test } from "vitest";
import type {
  AccountBridge,
  WorkspaceBridge,
} from "../shared/desktop-bridge.ts";
import {
  START_SIGN_IN_REFUSALS,
  WORKSPACE_STATUSES,
  type AccountStatus,
  type StartSignInResult,
  type WorkspaceActionResult,
  type WorkspaceSwitchOptions,
  type WorkspaceView,
} from "../shared/ipc-contract.ts";
import {
  ACTION_MESSAGES,
  START_REFUSAL_MESSAGES,
  type AccountView,
} from "./account-view.ts";
import {
  createShellState,
  PROJECT_SCREEN_IDS,
  shellReducer,
  WORKSPACE_SCREEN_IDS,
  type ShellAction,
  type ShellState,
  type ShellView,
} from "./screens.ts";
import {
  createHomeSignInStart,
  createWorkspaceSidebar,
  homeCaseForView,
  describeSwitchQuestion,
  HOME_SIGN_IN_MESSAGES,
  homeSignIn,
  initialWorkspacePanelView,
  noDeviceSignedIn,
  SELECT_REFUSAL_MESSAGES,
  switchWorkspace,
  WORKSPACE_MESSAGES,
  type HomeSignInStartView,
  type SwitchQuestion,
  type WorkspacePanelView,
} from "./workspace-view.ts";

const WORKSPACE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const PROJECT_A = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b1";
const PROJECT_B = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b2";

const READY: WorkspaceView = {
  revision: 3,
  status: "ready",
  workspaces: [{ id: WORKSPACE_ID, name: "Workspace" }],
  selectedWorkspaceId: WORKSPACE_ID,
  projects: [
    { id: PROJECT_A, name: "Project A" },
    { id: PROJECT_B, name: "Project B" },
  ],
  openProjectId: null,
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

interface Call<Argument> {
  readonly argument: Argument;
  /** The switch option, or undefined when the call passed none. */
  readonly options: WorkspaceSwitchOptions | undefined;
  /** How many arguments the call passed. */
  readonly arity: number;
  readonly answer: Deferred<WorkspaceActionResult>;
}

/**
 * A workspace bridge that the test drives: it feeds the subscription, counts
 * the ended ones, and answers each report and switch when the test says so.
 */
function fakeBridge() {
  const fake = {
    listener: undefined as ((state: WorkspaceView) => void) | undefined,
    onError: undefined as (() => void) | undefined,
    ended: 0,
    reports: [] as Call<string | null>[],
    selects: [] as Call<string>[],
    bridge: {
      subscribeState: (
        listener: (state: WorkspaceView) => void,
        onError?: () => void,
      ) => {
        fake.listener = listener;
        fake.onError = onError;
        return () => {
          fake.ended += 1;
        };
      },
      openProject: (
        ...args: [projectId: string | null, options?: WorkspaceSwitchOptions]
      ) => {
        const answer = deferred<WorkspaceActionResult>();
        fake.reports.push({
          argument: args[0],
          options: args[1],
          arity: args.length,
          answer,
        });
        return answer.promise;
      },
      select: (
        ...args: [workspaceId: string, options?: WorkspaceSwitchOptions]
      ) => {
        const answer = deferred<WorkspaceActionResult>();
        fake.selects.push({
          argument: args[0],
          options: args[1],
          arity: args.length,
          answer,
        });
        return answer.promise;
      },
    } satisfies Pick<
      WorkspaceBridge,
      "subscribeState" | "openProject" | "select"
    >,
  };
  return fake;
}

/**
 * A controller on a fake bridge and a shell that runs every dispatched
 * action through the reducer, with the views and messages it reported.
 */
function harness(initial: ShellState = createShellState(READY.projects)) {
  const fake = fakeBridge();
  const app = {
    state: initial,
    actions: [] as ShellAction[],
    views: [] as WorkspacePanelView[],
    messages: [] as (string | undefined)[],
    questions: [] as (SwitchQuestion | undefined)[],
  };
  const controller = createWorkspaceSidebar(
    fake.bridge,
    (action) => {
      app.actions.push(action);
      app.state = shellReducer(app.state, action);
    },
    (view) => app.views.push(view),
    (message) => app.messages.push(message),
    (question) => app.questions.push(question),
  );
  return { fake, app, controller };
}

/** Waits until every pending promise callback has run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const NOT_FOUND = { outcome: "refused", reason: "not_found" } as const;
const TOO_SOON = { outcome: "refused", reason: "too_soon" } as const;

test("before the first state, the view waits with the bridge and is unavailable without it", () => {
  expect(initialWorkspacePanelView(true)).toEqual({ kind: "pending" });
  expect(initialWorkspacePanelView(false)).toEqual({ kind: "unavailable" });
});

test("every state becomes the view and replaces the shell's projects, also when the view stays", () => {
  const { fake, app, controller } = harness(createShellState([]));
  controller.start();

  fake.listener?.(READY);
  expect(app.state.projects).toBe(READY.projects);
  app.state = shellReducer(app.state, {
    type: "open-project",
    projectId: PROJECT_B,
  });
  const openView = app.state.view;

  // A rename changes only the projects; the open project stays shown.
  const renamed: WorkspaceView = {
    ...READY,
    revision: 4,
    projects: [
      { id: PROJECT_A, name: "Project A" },
      { id: PROJECT_B, name: "Project B, renamed" },
    ],
  };
  fake.listener?.(renamed);
  expect(app.state.projects).toBe(renamed.projects);
  expect(app.state.view).toBe(openView);

  // A state that no longer lists the open project shows the home screen.
  const removed: WorkspaceView = {
    ...renamed,
    revision: 5,
    projects: [{ id: PROJECT_A, name: "Project A" }],
  };
  fake.listener?.(removed);
  expect(app.state).toEqual({
    projects: removed.projects,
    view: { screen: "home" },
  });

  expect(app.views).toEqual([
    { kind: "known", state: READY },
    { kind: "known", state: renamed },
    { kind: "known", state: removed },
  ]);
  expect(app.actions).toEqual([
    { type: "replace-projects", projects: READY.projects },
    { type: "replace-projects", projects: renamed.projects },
    { type: "replace-projects", projects: removed.projects },
  ]);
});

test("a refused subscription makes the view unavailable, and the function from start ends the subscription", () => {
  const { fake, app, controller } = harness();
  const stop = controller.start();

  fake.onError?.();
  expect(app.views).toEqual([{ kind: "unavailable" }]);
  expect(fake.ended).toBe(0);
  stop();
  expect(fake.ended).toBe(1);
});

test("the open project is reported at the start, as null, and again on each change", async () => {
  const { fake, app, controller } = harness();
  controller.start();

  controller.openProjectChanged(null);
  controller.openProjectChanged(PROJECT_A);
  controller.openProjectChanged(PROJECT_B);
  controller.openProjectChanged(null);
  for (const report of fake.reports) {
    report.answer.resolve({ outcome: "ok" });
  }
  await settle();

  expect(fake.reports.map((report) => report.argument)).toEqual([
    null,
    PROJECT_A,
    PROJECT_B,
    null,
  ]);
  expect(app.actions).toEqual([]);
});

test("a project that the main process does not hold closes in the shell", async () => {
  const { fake, app, controller } = harness(
    createShellState(READY.projects, {
      screen: "tasks",
      projectId: PROJECT_A,
      panel: "agents",
    }),
  );

  controller.openProjectChanged(PROJECT_A);
  fake.reports[0]?.answer.resolve(NOT_FOUND);
  await settle();

  expect(app.state.view).toEqual({ screen: "home" });
});

test("a stale answer, a refused null, and a failed call keep the shown project", async () => {
  const { fake, app, controller } = harness();
  const stop = controller.start();

  // The answer for A arrives after B was reported.
  controller.openProjectChanged(PROJECT_A);
  controller.openProjectChanged(PROJECT_B);
  fake.reports[0]?.answer.resolve(NOT_FOUND);
  await settle();
  expect(app.actions).toEqual([]);

  // No signed-in device: null is refused, and nothing is open anyway.
  controller.openProjectChanged(null);
  fake.reports[2]?.answer.resolve(NOT_FOUND);
  await settle();
  expect(app.actions).toEqual([]);
  controller.openProjectChanged(PROJECT_A);
  fake.reports[3]?.answer.reject(new Error("The main process did not answer."));
  await settle();
  expect(app.actions).toEqual([]);

  // The end of the subscription drops the open answer.
  controller.openProjectChanged(PROJECT_B);
  stop();
  fake.reports[4]?.answer.resolve(NOT_FOUND);
  await settle();
  expect(app.actions).toEqual([]);
});

test("a switch clears the message first and then shows the text of its answer; ok leaves it cleared", async () => {
  const { fake, app, controller } = harness();

  controller.select(WORKSPACE_ID);
  expect(fake.selects.map((call) => call.argument)).toEqual([WORKSPACE_ID]);
  expect(app.messages).toEqual([undefined]);
  fake.selects[0]?.answer.resolve(TOO_SOON);
  await settle();
  expect(app.messages).toEqual([undefined, SELECT_REFUSAL_MESSAGES.too_soon]);

  controller.select(WORKSPACE_ID);
  expect(app.messages.at(-1)).toBeUndefined();
  fake.selects[1]?.answer.resolve({ outcome: "ok" });
  await settle();
  expect(app.messages.slice(2)).toEqual([undefined, undefined]);
});

test("only the answer of the latest switch counts", async () => {
  const { fake, app, controller } = harness();

  controller.select(WORKSPACE_ID);
  controller.select(WORKSPACE_ID);
  fake.selects[1]?.answer.resolve({ outcome: "ok" });
  fake.selects[0]?.answer.resolve(TOO_SOON);
  await settle();

  expect(app.messages).not.toContain(SELECT_REFUSAL_MESSAGES.too_soon);
  expect(app.messages.at(-1)).toBeUndefined();
});

test("a newer workspace state clears the message of a switch", async () => {
  const { fake, app, controller } = harness();
  controller.start();
  fake.listener?.(READY);

  controller.select(WORKSPACE_ID);
  fake.selects[0]?.answer.resolve(TOO_SOON);
  await settle();
  expect(app.messages.at(-1)).toBe(SELECT_REFUSAL_MESSAGES.too_soon);

  // The same revision again, for example after a new subscription, keeps it.
  fake.listener?.(READY);
  expect(app.messages.at(-1)).toBe(SELECT_REFUSAL_MESSAGES.too_soon);

  fake.listener?.({ ...READY, revision: READY.revision + 1 });
  expect(app.messages.at(-1)).toBeUndefined();
});

test("a switch resolves to no message, or to a calm fixed text when refused or failed", async () => {
  const answers: (() => Promise<WorkspaceActionResult>)[] = [
    () => Promise.resolve({ outcome: "ok" }),
    () => Promise.resolve(TOO_SOON),
    () => Promise.resolve(NOT_FOUND),
    () => Promise.reject(new Error("The main process did not answer.")),
  ];
  const results: unknown[] = [];
  for (const answer of answers) {
    results.push(await switchWorkspace({ select: answer }, WORKSPACE_ID));
  }

  expect(results).toEqual([
    { kind: "done", message: undefined },
    { kind: "done", message: "Wait a moment before switching again." },
    { kind: "done", message: SELECT_REFUSAL_MESSAGES.not_found },
    { kind: "done", message: WORKSPACE_MESSAGES.switchFailed },
  ]);
});

const DISCARD = { discardWaiting: true };

test("a workspace switch that answers waiting asks with the count and changes nothing; keeping the messages ends it", async () => {
  const { fake, app, controller } = harness();
  controller.start();
  fake.listener?.({ ...READY, openProjectId: PROJECT_A });
  app.state = shellReducer(app.state, {
    type: "open-project",
    projectId: PROJECT_A,
  });
  const shown = app.state;
  app.actions.length = 0;

  controller.select(WORKSPACE_ID);
  fake.selects[0]?.answer.resolve({ outcome: "waiting", count: 3 });
  await settle();
  expect(app.questions).toEqual([{ kind: "workspace", count: 3 }]);
  expect(app.messages).toEqual([undefined]);

  controller.keepWaiting();
  await settle();
  expect(app.questions).toEqual([{ kind: "workspace", count: 3 }, undefined]);
  // The shell never left the open project, and nothing is repeated.
  expect(app.state).toBe(shown);
  expect(app.actions).toEqual([]);
  expect(fake.selects).toHaveLength(1);
  expect(fake.reports).toHaveLength(0);

  // A second answer changes nothing once the question is closed.
  controller.keepWaiting();
  controller.discardWaiting();
  expect(app.questions).toHaveLength(2);
  expect(fake.selects).toHaveLength(1);
});

test("discarding the messages repeats the workspace switch with the discard option, and its answer counts", async () => {
  const { fake, app, controller } = harness();

  controller.select(WORKSPACE_ID);
  expect(fake.selects[0]?.arity).toBe(1);
  fake.selects[0]?.answer.resolve({ outcome: "waiting", count: 1 });
  await settle();

  controller.discardWaiting();
  expect(app.questions).toEqual([{ kind: "workspace", count: 1 }, undefined]);
  expect(fake.selects.map((call) => [call.argument, call.options])).toEqual([
    [WORKSPACE_ID, undefined],
    [WORKSPACE_ID, DISCARD],
  ]);
  fake.selects[1]?.answer.resolve(TOO_SOON);
  await settle();
  expect(app.messages.at(-1)).toBe(SELECT_REFUSAL_MESSAGES.too_soon);
  expect(fake.reports).toHaveLength(0);
});

test("opening another project that answers waiting asks, and keeping the messages puts the shell back on the main process's open project", async () => {
  const { fake, app, controller } = harness();
  controller.start();
  fake.listener?.({ ...READY, openProjectId: PROJECT_A });
  app.state = shellReducer(app.state, {
    type: "open-project",
    projectId: PROJECT_B,
  });
  app.actions.length = 0;

  controller.openProjectChanged(PROJECT_B);
  fake.reports[0]?.answer.resolve({ outcome: "waiting", count: 2 });
  await settle();
  expect(app.questions).toEqual([{ kind: "project", count: 2 }]);
  expect(app.state.view).toMatchObject({ projectId: PROJECT_B });

  controller.keepWaiting();
  expect(app.questions.at(-1)).toBeUndefined();
  expect(app.actions).toEqual([{ type: "open-project", projectId: PROJECT_A }]);
  expect(app.state.view).toEqual({
    screen: "chat",
    projectId: PROJECT_A,
    panel: "agents",
  });
  // Nothing is repeated with the discard option.
  expect(fake.reports.map((call) => call.options)).toEqual([undefined]);
});

test("closing the project that answers waiting asks too, and keeping the messages opens the main process's project again", async () => {
  const { fake, app, controller } = harness();
  controller.start();
  fake.listener?.({ ...READY, openProjectId: PROJECT_B });
  app.state = shellReducer(app.state, {
    type: "show-screen",
    screen: "about",
  });
  app.actions.length = 0;

  controller.openProjectChanged(null);
  fake.reports[0]?.answer.resolve({ outcome: "waiting", count: 50 });
  await settle();
  expect(app.questions).toEqual([{ kind: "close", count: 50 }]);

  controller.keepWaiting();
  expect(app.actions).toEqual([{ type: "open-project", projectId: PROJECT_B }]);
  expect(app.state.view).toMatchObject({
    screen: "chat",
    projectId: PROJECT_B,
  });
});

test("keeping the messages shows the home screen when the last state has no open project", async () => {
  const { fake, app, controller } = harness(
    createShellState(READY.projects, {
      screen: "chat",
      projectId: PROJECT_B,
      panel: "repositories",
    }),
  );
  controller.start();
  fake.listener?.(READY);
  app.actions.length = 0;

  controller.openProjectChanged(PROJECT_B);
  fake.reports[0]?.answer.resolve({ outcome: "waiting", count: 1 });
  await settle();
  controller.keepWaiting();

  expect(app.actions).toEqual([{ type: "show-screen", screen: "home" }]);
  expect(app.state.view).toEqual({ screen: "home" });
});

test("discarding the messages repeats the project switch with the discard option; a second waiting answer asks again", async () => {
  const { fake, app, controller } = harness();
  controller.start();
  fake.listener?.({ ...READY, openProjectId: PROJECT_A });
  app.actions.length = 0;

  controller.openProjectChanged(PROJECT_B);
  expect(fake.reports[0]?.arity).toBe(1);
  fake.reports[0]?.answer.resolve({ outcome: "waiting", count: 2 });
  await settle();

  controller.discardWaiting();
  expect(fake.reports.map((call) => [call.argument, call.options])).toEqual([
    [PROJECT_B, undefined],
    [PROJECT_B, DISCARD],
  ]);
  // A message was written meanwhile; the person is asked again.
  fake.reports[1]?.answer.resolve({ outcome: "waiting", count: 1 });
  await settle();
  expect(app.questions).toEqual([
    { kind: "project", count: 2 },
    undefined,
    { kind: "project", count: 1 },
  ]);
  controller.discardWaiting();
  fake.reports[2]?.answer.resolve({ outcome: "ok" });
  await settle();
  expect(fake.reports.map((call) => call.options)).toEqual([
    undefined,
    DISCARD,
    DISCARD,
  ]);
  expect(app.questions.at(-1)).toBeUndefined();
  expect(app.actions).toEqual([]);

  // Closing the project is repeated with null.
  controller.openProjectChanged(null);
  fake.reports[3]?.answer.resolve({ outcome: "waiting", count: 1 });
  await settle();
  controller.discardWaiting();
  expect(fake.reports[4]?.argument).toBeNull();
  expect(fake.reports[4]?.options).toEqual(DISCARD);
});

test("a newer report or switch replaces the question, and a stale waiting answer asks nothing", async () => {
  const { fake, app, controller } = harness();
  controller.start();
  fake.listener?.({ ...READY, openProjectId: PROJECT_A });

  controller.openProjectChanged(PROJECT_B);
  fake.reports[0]?.answer.resolve({ outcome: "waiting", count: 2 });
  await settle();
  expect(app.questions).toEqual([{ kind: "project", count: 2 }]);

  // A newer report closes the question; its answers do nothing.
  controller.openProjectChanged(PROJECT_A);
  expect(app.questions).toEqual([{ kind: "project", count: 2 }, undefined]);
  app.actions.length = 0;
  controller.keepWaiting();
  controller.discardWaiting();
  expect(app.actions).toEqual([]);
  expect(fake.reports).toHaveLength(2);

  // The waiting answer of a replaced report asks nothing.
  controller.openProjectChanged(PROJECT_B);
  controller.openProjectChanged(PROJECT_A);
  fake.reports[2]?.answer.resolve({ outcome: "waiting", count: 1 });
  await settle();
  expect(app.questions).toHaveLength(2);

  // A switch replaces a project question too, and the other way round.
  controller.openProjectChanged(PROJECT_B);
  fake.reports[4]?.answer.resolve({ outcome: "waiting", count: 1 });
  await settle();
  controller.select(WORKSPACE_ID);
  expect(app.questions.slice(2)).toEqual([
    { kind: "project", count: 1 },
    undefined,
  ]);
  fake.selects[0]?.answer.resolve({ outcome: "waiting", count: 4 });
  await settle();
  controller.openProjectChanged(null);
  expect(app.questions.slice(4)).toEqual([
    { kind: "workspace", count: 4 },
    undefined,
  ]);
  controller.discardWaiting();
  expect(fake.selects).toHaveLength(1);
});

test("the end of the subscription closes the question and drops a waiting answer", async () => {
  const { fake, app, controller } = harness();
  const stop = controller.start();

  controller.openProjectChanged(PROJECT_A);
  controller.select(WORKSPACE_ID);
  fake.selects[0]?.answer.resolve({ outcome: "waiting", count: 1 });
  await settle();
  stop();
  fake.reports[0]?.answer.resolve({ outcome: "waiting", count: 1 });
  await settle();

  expect(app.questions).toEqual([{ kind: "workspace", count: 1 }, undefined]);
});

test("a switch that answers waiting passes on its count", async () => {
  expect(
    await switchWorkspace(
      { select: () => Promise.resolve({ outcome: "waiting", count: 7 }) },
      WORKSPACE_ID,
    ),
  ).toEqual({ kind: "waiting", count: 7 });
});

test("the question names the count, what the switch does, and both answers", () => {
  expect(describeSwitchQuestion({ kind: "workspace", count: 1 })).toEqual({
    title: "Discard the message that was not sent?",
    text: "1 message has not been sent yet. Selecting another workspace discards it.",
    keep: "Keep the message",
    discard: "Discard and switch workspace",
  });
  expect(describeSwitchQuestion({ kind: "project", count: 2 })).toEqual({
    title: "Discard the messages that were not sent?",
    text: "2 messages have not been sent yet. Opening another project discards them.",
    keep: "Keep the messages",
    discard: "Discard and open project",
  });
  expect(describeSwitchQuestion({ kind: "close", count: 50 })).toEqual({
    title: "Discard the messages that were not sent?",
    text: "50 messages have not been sent yet. Closing the project discards them.",
    keep: "Keep the messages",
    discard: "Discard and close project",
  });
});

test("no device is signed in only while the workspace state is signed_out", () => {
  const states = WORKSPACE_STATUSES.map((status) => [
    status,
    noDeviceSignedIn({
      kind: "known",
      state:
        status === "unavailable"
          ? { ...READY, status, problem: "unavailable" }
          : { ...READY, status },
    }),
  ]);
  expect(Object.fromEntries(states)).toEqual({
    signed_out: true,
    loading: false,
    ready: false,
    unavailable: false,
  });
  // Before the first state and without the bridge, the shell does not know.
  expect(noDeviceSignedIn({ kind: "pending" })).toBe(false);
  expect(noDeviceSignedIn({ kind: "unavailable" })).toBe(false);
});

/** An account status in which the account panel offers a sign-in that can start now. */
const SIGN_IN_OFFERED: AccountStatus = {
  revision: 1,
  account: { kind: "signed_out" },
  signIn: { kind: "idle" },
  lastOutcome: null,
  deviceKey: "ready",
  replacementPending: false,
  apiOrigin: "set",
  device: "no_device",
};

function knownAccount(status: Partial<AccountStatus>): AccountView {
  return { kind: "known", status: { ...SIGN_IN_OFFERED, ...status } };
}

const SIGNED_OUT_WORKSPACES: WorkspacePanelView = {
  kind: "known",
  state: {
    ...READY,
    status: "signed_out",
    workspaces: [],
    selectedWorkspaceId: null,
    projects: [],
  },
};

test("the home screen offers a sign-in only while the account panel offers one that can start now", () => {
  const signedInAccount = {
    kind: "signed_in",
    login: "octocat",
    displayName: "The Octocat",
    deviceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
    signInExpiresAt: "2026-12-02T10:00:00.000Z",
  } as const;
  const cases: [string, AccountView, string][] = [
    ["idle sign-in offered", knownAccount({}), "sign_in"],
    [
      "signed out on this device",
      knownAccount({ account: { kind: "hidden" }, device: "signed_out" }),
      "sign_in",
    ],
    [
      "device revoked",
      knownAccount({ account: signedInAccount, device: "revoked" }),
      "sign_in",
    ],
    ["no account status yet", { kind: "pending" }, "not_ready"],
    ["no account bridge", { kind: "unavailable" }, "not_ready"],
    [
      "starting",
      knownAccount({ account: { kind: "hidden" }, device: "starting" }),
      "not_ready",
    ],
    ["key loading", knownAccount({ deviceKey: "loading" }), "not_ready"],
    [
      "passphrase required",
      knownAccount({
        account: { kind: "hidden" },
        deviceKey: "passphrase_required",
        device: "key_not_loaded",
      }),
      "not_ready",
    ],
    ["key unusable", knownAccount({ deviceKey: "corrupt" }), "not_ready"],
    ["api origin unset", knownAccount({ apiOrigin: "unset" }), "not_ready"],
    ["api origin invalid", knownAccount({ apiOrigin: "invalid" }), "not_ready"],
    [
      "removal pending",
      knownAccount({ account: signedInAccount, device: "removal_pending" }),
      "not_ready",
    ],
    [
      "sign-in starting",
      knownAccount({ signIn: { kind: "starting" } }),
      "not_ready",
    ],
    [
      "sign-in waiting",
      knownAccount({
        signIn: { kind: "waiting", pairingCode: "042137", opened: true },
      }),
      "not_ready",
    ],
    [
      "sign-in completing",
      knownAccount({ signIn: { kind: "completing" } }),
      "not_ready",
    ],
  ];
  for (const [name, account, expected] of cases) {
    expect(homeSignIn(SIGNED_OUT_WORKSPACES, account), name).toBe(expected);
  }

  // Nothing unless no device is signed in and ready, whatever the account says.
  const otherWorkspaces: WorkspacePanelView[] = [
    { kind: "pending" },
    { kind: "unavailable" },
    { kind: "known", state: READY },
    { kind: "known", state: { ...READY, status: "loading" } },
    {
      kind: "known",
      state: { ...READY, status: "unavailable", problem: "unavailable" },
    },
  ];
  for (const workspaces of otherWorkspaces) {
    for (const [name, account] of cases) {
      expect(homeSignIn(workspaces, account), name).toBe("none");
    }
  }
});

test("the home screen's sentences are fixed, and the one without a sign-in is the sidebar's for signed_out", () => {
  expect(HOME_SIGN_IN_MESSAGES).toEqual({
    sign_in:
      "Sign in with GitHub to see your workspaces. The sign-in continues on the Account screen.",
    not_ready: "Workspaces appear once this device is signed in and ready.",
  });
  expect(HOME_SIGN_IN_MESSAGES.not_ready).toBe(WORKSPACE_MESSAGES.signedOut);
});

/** A fake account bridge whose starts the test answers, and what the start shows. */
function homeStartHarness() {
  const starts: Deferred<StartSignInResult>[] = [];
  const calls: unknown[][] = [];
  const steps: string[] = [];
  const views: HomeSignInStartView[] = [];
  const account: Pick<AccountBridge, "startSignIn"> = {
    startSignIn: (...args: unknown[]) => {
      calls.push(args);
      const start = deferred<StartSignInResult>();
      starts.push(start);
      return start.promise;
    },
  };
  const start = createHomeSignInStart(
    account,
    () => steps.push("show account"),
    (view) => {
      views.push(view);
      steps.push(`view ${JSON.stringify(view)}`);
    },
  );
  // The shell shows the home screen with a sign-in, as `App` reports it
  // once it is mounted.
  start.homeChanged("sign_in");
  return { start, starts, calls, steps, views };
}

const RUNNING = '{"running":true}';
const IDLE = '{"running":false}';

test("Sign in with GitHub on the home screen calls the account panel's startSignIn once, without options, and shows the account screen once the status shows the sign-in running", async () => {
  const { start, starts, calls, steps } = homeStartHarness();
  start.start();
  // A second click while the start runs changes nothing.
  start.start();
  expect(calls).toEqual([[]]);
  expect(steps).toEqual([`view ${RUNNING}`]);
  // Before the answer, an idle status or none known shows nothing.
  start.accountChanged(knownAccount({}));
  start.accountChanged({ kind: "pending" });
  start.accountChanged({ kind: "unavailable" });
  expect(steps).toEqual([`view ${RUNNING}`]);
  // The main process publishes the running sign-in before it opens the
  // browser and answers.
  start.accountChanged(knownAccount({ signIn: { kind: "starting" } }));
  expect(steps).toEqual([`view ${RUNNING}`, "show account"]);
  start.accountChanged(
    knownAccount({
      signIn: { kind: "waiting", pairingCode: "042137", opened: true },
    }),
  );
  starts[0]?.resolve({ outcome: "started" });
  await settle();
  // Once per start: neither the next status nor the answer shows it again,
  // also when the person went back to the home screen meanwhile.
  expect(steps).toEqual([`view ${RUNNING}`, "show account", `view ${IDLE}`]);
  // After the start, a status of a running sign-in shows nothing.
  start.accountChanged(knownAccount({ signIn: { kind: "completing" } }));
  expect(steps).toEqual([`view ${RUNNING}`, "show account", `view ${IDLE}`]);
});

test("a start of the home screen shows the account screen with its answer when no status showed the sign-in running, also after a failure, whose outcome the account panel shows", async () => {
  for (const result of [
    { outcome: "started" },
    { outcome: "failed", code: "no_answer" },
  ] as const) {
    const { start, starts, steps } = homeStartHarness();
    start.start();
    starts[0]?.resolve(result);
    await settle();
    expect(steps, result.outcome).toEqual([
      `view ${RUNNING}`,
      "show account",
      `view ${IDLE}`,
    ]);
  }
});

test("a refused or failed start of the home screen keeps the home screen and shows the account panel's sentence until the next start or a sign-in that runs", async () => {
  const cases: [
    string,
    (start: Deferred<StartSignInResult>) => void,
    string,
  ][] = [
    ...START_SIGN_IN_REFUSALS.map(
      (
        reason,
      ): [string, (start: Deferred<StartSignInResult>) => void, string] => [
        reason,
        (start) => start.resolve({ outcome: "refused", reason }),
        START_REFUSAL_MESSAGES[reason],
      ],
    ),
    [
      "rejected",
      (start) => start.reject(new Error("The IPC call failed.")),
      ACTION_MESSAGES.startFailed,
    ],
  ];
  for (const [name, answer, message] of cases) {
    const { start, starts, calls, steps, views } = homeStartHarness();
    start.start();
    const first = starts[0];
    if (first === undefined) {
      throw new Error("The start did not call the bridge.");
    }
    answer(first);
    await settle();
    expect(steps, name).toEqual([
      `view ${RUNNING}`,
      `view ${JSON.stringify({ running: false, message })}`,
    ]);
    // An idle status keeps the message.
    start.accountChanged(knownAccount({}));
    expect(views.at(-1), name).toEqual({ running: false, message });
    // The next start ends it at once.
    start.start();
    expect(calls, name).toEqual([[], []]);
    expect(views.at(-1), name).toEqual({ running: true, message: undefined });
    starts[1]?.resolve({ outcome: "refused", reason: "too_soon" });
    await settle();
    // A sign-in that runs, for example one started on the account screen,
    // ends it too, without a switch.
    start.accountChanged(knownAccount({ signIn: { kind: "starting" } }));
    expect(views.at(-1), name).toEqual({ running: false, message: undefined });
    expect(steps, name).not.toContain("show account");
  }
});

/** The account status of a sign-in that runs, for each kind but `starting`. */
const OTHER_RUNNING_SIGN_INS: [string, AccountView][] = [
  [
    "waiting",
    knownAccount({
      signIn: { kind: "waiting", pairingCode: "042137", opened: true },
    }),
  ],
  ["completing", knownAccount({ signIn: { kind: "completing" } })],
];

test.each(OTHER_RUNNING_SIGN_INS)(
  "a %s sign-in as the first status of a running home screen start shows the account screen",
  (_kind, running) => {
    const { start, steps } = homeStartHarness();
    start.start();
    start.accountChanged(running);
    expect(steps).toEqual([`view ${RUNNING}`, "show account"]);
  },
);

test.each(OTHER_RUNNING_SIGN_INS)(
  "a %s sign-in ends the message of a refused home screen start",
  async (_kind, running) => {
    const { start, starts, views } = homeStartHarness();
    start.start();
    starts[0]?.resolve({ outcome: "refused", reason: "too_soon" });
    await settle();
    expect(views.at(-1)).toEqual({
      running: false,
      message: START_REFUSAL_MESSAGES.too_soon,
    });
    start.accountChanged(running);
    expect(views.at(-1)).toEqual({ running: false, message: undefined });
  },
);

test("each start of the home screen shows the account screen once, by the status or by the answer", async () => {
  const { start, starts, steps } = homeStartHarness();
  start.start();
  start.accountChanged(knownAccount({ signIn: { kind: "starting" } }));
  starts[0]?.resolve({ outcome: "failed", code: "cancelled" });
  await settle();
  start.accountChanged(knownAccount({}));
  // The second start gets no running status before its answer.
  start.start();
  starts[1]?.resolve({ outcome: "started" });
  await settle();
  expect(steps).toEqual([
    `view ${RUNNING}`,
    "show account",
    `view ${IDLE}`,
    `view ${RUNNING}`,
    "show account",
    `view ${IDLE}`,
  ]);
});

test("the message of a refused home screen start shows only while the shell shows the home screen with the same case", async () => {
  const refused = async () => {
    const harness = homeStartHarness();
    // The shell shows the home screen with a sign-in before the click.
    harness.start.homeChanged("sign_in");
    harness.start.start();
    harness.starts[0]?.resolve({ outcome: "refused", reason: "key_not_ready" });
    await settle();
    const message = START_REFUSAL_MESSAGES.key_not_ready;
    expect(harness.views.at(-1)).toEqual({ running: false, message });
    // The same case keeps it.
    harness.start.homeChanged("sign_in");
    expect(harness.views.at(-1)).toEqual({ running: false, message });
    return harness;
  };
  // Leaving the home screen ends it, so it is not announced again when the
  // home screen is shown again.
  const left = await refused();
  left.start.homeChanged(undefined);
  expect(left.views.at(-1)).toEqual({ running: false, message: undefined });
  left.start.homeChanged("sign_in");
  expect(left.views.at(-1)).toEqual({ running: false, message: undefined });
  // Another answer of the account panel's rule ends it.
  for (const next of ["not_ready", "none"] as const) {
    const changed = await refused();
    changed.start.homeChanged(next);
    expect(changed.views.at(-1), next).toEqual({
      running: false,
      message: undefined,
    });
  }
  // Also when the key becomes ready again and the button is enabled: the
  // case became `not_ready` while the start ran, and its refusal came then.
  const ready = homeStartHarness();
  ready.start.start();
  ready.start.homeChanged("not_ready");
  ready.starts[0]?.resolve({ outcome: "refused", reason: "key_not_ready" });
  await settle();
  expect(ready.views.at(-1)).toEqual({
    running: false,
    message: START_REFUSAL_MESSAGES.key_not_ready,
  });
  ready.start.homeChanged("sign_in");
  expect(ready.views.at(-1)).toEqual({ running: false, message: undefined });
});

test("the answer of a home screen start that comes while the shell shows another screen shows no message there or after the return", async () => {
  const answers: [string, (start: Deferred<StartSignInResult>) => void][] = [
    [
      "refused",
      (start) => start.resolve({ outcome: "refused", reason: "too_soon" }),
    ],
    ["rejected", (start) => start.reject(new Error("The IPC call failed."))],
  ];
  for (const [name, answer] of answers) {
    const { start, starts, views } = homeStartHarness();
    start.start();
    // The status showed the account screen, or the person left the home
    // screen, before the answer.
    start.accountChanged(knownAccount({ signIn: { kind: "starting" } }));
    start.homeChanged(undefined);
    const first = starts[0];
    if (first === undefined) {
      throw new Error("The start did not call the bridge.");
    }
    answer(first);
    await settle();
    expect(views.at(-1), name).toEqual({ running: false, message: undefined });
    const count = views.length;
    start.homeChanged("sign_in");
    expect(views.length, name).toBe(count);
  }
});

test("the start of the home screen sees the home screen's case only while the shell shows the home screen", () => {
  const projectView = (screen: (typeof PROJECT_SCREEN_IDS)[number]) =>
    ({ screen, projectId: PROJECT_A, panel: "agents" }) as const;
  const views: ShellView[] = [
    ...WORKSPACE_SCREEN_IDS.map((screen) => ({ screen })),
    ...PROJECT_SCREEN_IDS.map(projectView),
  ];
  for (const home of ["none", "sign_in", "not_ready"] as const) {
    for (const view of views) {
      expect(homeCaseForView(view, home), `${view.screen} ${home}`).toBe(
        view.screen === "home" ? home : undefined,
      );
    }
  }
  expect(homeCaseForView({ screen: "home" }, "sign_in")).toBe("sign_in");
  expect(homeCaseForView({ screen: "account" }, "sign_in")).toBeUndefined();
});
