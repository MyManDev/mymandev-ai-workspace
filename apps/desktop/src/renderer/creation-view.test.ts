import { expect, test } from "vitest";
import type { WorkspaceBridge } from "../shared/desktop-bridge.ts";
import {
  CREATE_PROJECT_REFUSALS,
  CREATE_WORKSPACE_REFUSALS,
  NewNameSchema,
  WORKSPACE_LIMITS,
  type CreateProjectResult,
  type CreateWorkspaceResult,
  type WorkspaceView,
} from "../shared/ipc-contract.ts";
import {
  CREATE_DONE_MESSAGES,
  CREATE_DONE_SHORT_MESSAGES,
  CREATE_MESSAGES,
  CREATE_NOT_DONE_MESSAGES,
  CREATE_NOT_SENT,
  CREATE_REFUSAL_MESSAGES,
  CREATE_UNKNOWN_MESSAGES,
  createCreation,
  createdOpenPaths,
  describeCreatedOffer,
  describeCreateResult,
  describeCreateSentence,
  describeCreation,
  IDLE_CREATION,
  MAX_NEW_NAME_LENGTH,
  nameToSend,
  newNamePrompt,
  type CreateMessage,
  type CreationView,
} from "./creation-view.ts";
import {
  createShellState,
  HOME_VIEW,
  isProjectView,
  shellReducer,
  type ShellAction,
} from "./screens.ts";
import {
  createWorkspaceSidebar,
  type SwitchQuestion,
  type WorkspacePanelView,
} from "./workspace-view.ts";

const WORKSPACE_A = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a1";
const WORKSPACE_B = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a2";
const NEW_WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e1";

function workspaceState(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    revision: 3,
    status: "ready",
    workspaces: [
      { id: WORKSPACE_A, name: "Team Alpha" },
      { id: WORKSPACE_B, name: "Team Beta" },
    ],
    selectedWorkspaceId: WORKSPACE_A,
    projects: [],
    openProjectId: null,
    ...overrides,
  } as WorkspaceView;
}

function known(overrides: Partial<WorkspaceView> = {}): WorkspacePanelView {
  return { kind: "known", state: workspaceState(overrides) };
}

const SIGNED_OUT = known({
  status: "signed_out",
  workspaces: [],
  selectedWorkspaceId: null,
});

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A bridge whose calls wait until the test answers them, in order. */
function fakeBridge() {
  const calls: string[] = [];
  const workspaces: ReturnType<typeof deferred<CreateWorkspaceResult>>[] = [];
  const projects: ReturnType<typeof deferred<CreateProjectResult>>[] = [];
  const bridge: Pick<WorkspaceBridge, "create" | "createProject"> = {
    create: (name) => {
      calls.push(`create ${name}`);
      const next = deferred<CreateWorkspaceResult>();
      workspaces.push(next);
      return next.promise;
    },
    createProject: (workspaceId, name) => {
      calls.push(`project ${workspaceId} ${name}`);
      const next = deferred<CreateProjectResult>();
      projects.push(next);
      return next.promise;
    },
  };
  return { bridge, calls, workspaces, projects };
}

/** A controller over a fake bridge, with every view it shows. */
function controller(view: WorkspacePanelView = known()) {
  const fake = fakeBridge();
  const views: CreationView[] = [];
  const creation = createCreation(fake.bridge, (next) => views.push(next));
  creation.viewChanged(view);
  return {
    ...fake,
    creation,
    views,
    last: (): CreationView => views.at(-1) ?? IDLE_CREATION,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await Promise.resolve();
  }
}

const OK_SELECTED: CreateWorkspaceResult = {
  outcome: "ok",
  workspaceId: NEW_WORKSPACE,
  selected: true,
};

test("the longest name matches the contract's, and the contract accepts what the screen sends", () => {
  expect(MAX_NEW_NAME_LENGTH).toBe(WORKSPACE_LIMITS.name);
  const longest = "\u{1F600}".repeat(MAX_NEW_NAME_LENGTH);
  expect(newNamePrompt(longest)).toBeUndefined();
  expect(NewNameSchema.safeParse(longest).success).toBe(true);
  const longer = `${longest}a`;
  expect(newNamePrompt(longer)).toBe(CREATE_MESSAGES.nameTooLong);
  expect(NewNameSchema.safeParse(longer).success).toBe(false);
});

test("a name is counted in characters, not in UTF-16 code units, and an empty one is missing", () => {
  expect(newNamePrompt("")).toBe(CREATE_MESSAGES.nameMissing);
  expect(newNamePrompt("a".repeat(100))).toBeUndefined();
  expect(newNamePrompt("a".repeat(101))).toBe(CREATE_MESSAGES.nameTooLong);
  // 60 emoji are 120 code units but 60 characters.
  expect(newNamePrompt("\u{1F600}".repeat(60))).toBeUndefined();
  expect(newNamePrompt("\u{1F600}".repeat(101))).toBe(
    CREATE_MESSAGES.nameTooLong,
  );
  expect(CREATE_MESSAGES.nameTooLong).toBe(
    "A name has at most 100 characters.",
  );
});

test("a name is trimmed before it is sent, and a project's is normalized to NFC first, as the protocol does", () => {
  expect(nameToSend("workspace", "  Team \t")).toBe("Team");
  expect(nameToSend("project", "  Team \t")).toBe("Team");
  // "e" with a combining acute accent becomes one character for a project.
  const decomposed = "Cafe\u0301";
  expect(nameToSend("project", ` ${decomposed} `)).toBe("Caf\u00e9");
  // A workspace's name is not normalized, as in the protocol.
  expect(nameToSend("workspace", decomposed)).toBe(decomposed);
  // 100 decomposed characters fit a project once they are composed.
  const composedLength = nameToSend(
    "project",
    "e\u0301".repeat(MAX_NEW_NAME_LENGTH),
  );
  expect(newNamePrompt(composedLength)).toBeUndefined();
  expect(newNamePrompt("e\u0301".repeat(MAX_NEW_NAME_LENGTH))).toBe(
    CREATE_MESSAGES.nameTooLong,
  );
});

test("the shell offers the home form only while a ready account has no workspace, New workspace while a device is signed in, and New project for the selected workspace to every role", () => {
  expect(describeCreation({ kind: "pending" })).toEqual({
    home: false,
    workspace: false,
    projectIn: null,
  });
  expect(describeCreation({ kind: "unavailable" }).workspace).toBe(false);
  expect(describeCreation(SIGNED_OUT)).toEqual({
    home: false,
    workspace: false,
    projectIn: null,
  });
  expect(
    describeCreation(known({ workspaces: [], selectedWorkspaceId: null })),
  ).toEqual({ home: true, workspace: true, projectIn: null });
  // While the list loads or a retry waits, the home form waits too, and New
  // workspace stays, so that it does not leave the page with every switch.
  for (const status of ["loading", "unavailable"] as const) {
    const view = known({
      status,
      workspaces: [],
      selectedWorkspaceId: null,
      ...(status === "unavailable" ? { problem: "unavailable" } : {}),
    } as Partial<WorkspaceView>);
    expect(describeCreation(view), status).toEqual({
      home: false,
      workspace: true,
      projectIn: null,
    });
  }
  expect(describeCreation(known())).toEqual({
    home: false,
    workspace: true,
    projectIn: { workspaceId: WORKSPACE_A, workspaceName: "Team Alpha" },
  });
  expect(
    describeCreation(
      known({ status: "loading", selectedWorkspaceId: WORKSPACE_B }),
    ).projectIn,
  ).toEqual({ workspaceId: WORKSPACE_B, workspaceName: "Team Beta" });
  // A selection that the list does not hold has no name.
  expect(
    describeCreation(known({ selectedWorkspaceId: NEW_WORKSPACE })).projectIn,
  ).toEqual({ workspaceId: NEW_WORKSPACE, workspaceName: null });
  // Nothing depends on a role: the workspace view carries none.
  expect(Object.keys(workspaceState())).not.toContain("role");
});

test("every result of each create has one fixed sentence, with the wait and the API's limits for a limit", () => {
  expect(describeCreateResult("workspace", OK_SELECTED)).toBe(
    CREATE_DONE_MESSAGES.workspaceSelected,
  );
  expect(
    describeCreateResult("workspace", { ...OK_SELECTED, selected: false }),
  ).toBe(CREATE_DONE_MESSAGES.workspaceNotSelected);
  expect(
    describeCreateResult("project", { outcome: "ok", projectId: PROJECT }),
  ).toBe(CREATE_DONE_MESSAGES.project);
  for (const kind of ["workspace", "project"] as const) {
    expect(describeCreateResult(kind, { outcome: "unknown" })).toBe(
      CREATE_UNKNOWN_MESSAGES[kind],
    );
    expect(CREATE_UNKNOWN_MESSAGES[kind]).toContain(
      "not sent again on its own",
    );
    const refusals =
      kind === "workspace"
        ? CREATE_WORKSPACE_REFUSALS
        : CREATE_PROJECT_REFUSALS;
    for (const reason of refusals) {
      const wait = reason === "too_soon" || reason === "rate_limited";
      const text = describeCreateResult(kind, {
        outcome: "refused",
        reason,
        retryAfterMs: wait ? 90_000 : null,
      } as CreateProjectResult);
      expect(text, `${kind} ${reason}`).toMatch(
        new RegExp(`^${CREATE_NOT_DONE_MESSAGES[kind]} `),
      );
      if (wait) {
        expect(text).toContain("Try again in 2 minutes.");
      } else {
        expect(text).toBe(
          `${CREATE_NOT_DONE_MESSAGES[kind]} ${CREATE_REFUSAL_MESSAGES[reason]}`,
        );
      }
    }
  }
  const limited = (kind: "workspace" | "project") =>
    describeCreateResult(kind, {
      outcome: "refused",
      reason: "rate_limited",
      retryAfterMs: 86_400_000,
    });
  expect(limited("workspace")).toBe(
    "The workspace could not be created. The server asked to wait. Try again in 24 hours. An account creates at most 10 workspaces in 24 hours.",
  );
  expect(limited("project")).toBe(
    "The project could not be created. The server asked to wait. Try again in 24 hours. A workspace holds at most 100 projects, and an account creates at most 20 projects in 24 hours.",
  );
  expect(
    describeCreateResult("project", {
      outcome: "refused",
      reason: "conflict",
      retryAfterMs: null,
    }),
  ).toBe(
    "The project could not be created. A project of this workspace already has this name, perhaps in other capitals. Choose another name.",
  );
});

test("the home form refuses an empty or too long name with a problem and sends nothing, and an edit ends the problem", () => {
  const c = controller(known({ workspaces: [], selectedWorkspaceId: null }));
  c.creation.homeShown(true);
  for (const [text, problem] of [
    ["   ", CREATE_MESSAGES.nameMissing],
    ["a".repeat(101), CREATE_MESSAGES.nameTooLong],
  ] as const) {
    c.creation.editHomeDraft(text);
    void c.creation.createFromHome();
    expect(c.last().homeProblem).toBe(problem);
    expect(c.last().running).toBe(false);
    c.creation.editHomeDraft(`${text}x`);
    expect(c.last().homeProblem).toBeUndefined();
  }
  expect(c.calls).toEqual([]);
});

test("the home form sends the trimmed name once, keeps the field while it runs, and empties it with the sentence after a confirmed create", async () => {
  const c = controller(known({ workspaces: [], selectedWorkspaceId: null }));
  c.creation.homeShown(true);
  c.creation.editHomeDraft("  Team Gamma ");
  const done = c.creation.createFromHome();
  expect(c.calls).toEqual(["create Team Gamma"]);
  expect(c.last()).toMatchObject({
    running: true,
    homeDraft: "  Team Gamma ",
    message: undefined,
  });
  // One create at a time: nothing else starts.
  await expect(c.creation.createFromHome()).resolves.toBe(false);
  c.creation.open("workspaces");
  c.creation.open("projects", WORKSPACE_A, "Team Alpha");
  expect(c.last().dialog).toBeUndefined();
  expect(c.calls).toHaveLength(1);

  c.workspaces[0]?.resolve(OK_SELECTED);
  await expect(done).resolves.toBe(true);
  expect(c.last()).toEqual({
    running: false,
    dialog: undefined,
    homeDraft: "",
    homeProblem: undefined,
    message: { place: "home", text: CREATE_DONE_MESSAGES.workspaceSelected },
  });
});

test("an unknown answer is never sent again and keeps the name, and a call that fails says that it was not sent", async () => {
  const c = controller(known({ workspaces: [], selectedWorkspaceId: null }));
  c.creation.homeShown(true);
  c.creation.editHomeDraft("Team Gamma");
  const first = c.creation.createFromHome();
  c.workspaces[0]?.resolve({ outcome: "unknown" });
  await expect(first).resolves.toBe(false);
  await settle();
  expect(c.calls).toHaveLength(1);
  expect(c.last()).toMatchObject({
    homeDraft: "Team Gamma",
    message: { place: "home", text: CREATE_UNKNOWN_MESSAGES.workspace },
  });

  const second = c.creation.createFromHome();
  c.workspaces[1]?.reject(new Error("no bridge"));
  await expect(second).resolves.toBe(false);
  expect(c.last().message).toEqual({
    place: "home",
    text: `${CREATE_NOT_DONE_MESSAGES.workspace} ${CREATE_NOT_SENT}`,
  });
  expect(c.calls).toHaveLength(2);
});

test("the home screen's sentence shows only there: leaving it ends the sentence and the problem, and an answer that comes after it left shows nothing", async () => {
  const c = controller(known({ workspaces: [], selectedWorkspaceId: null }));
  c.creation.homeShown(true);
  c.creation.editHomeDraft("");
  void c.creation.createFromHome();
  expect(c.last().homeProblem).toBe(CREATE_MESSAGES.nameMissing);
  c.creation.homeShown(false);
  expect(c.last().homeProblem).toBeUndefined();

  c.creation.homeShown(true);
  c.creation.editHomeDraft("Team Gamma");
  const first = c.creation.createFromHome();
  c.workspaces[0]?.resolve({ outcome: "unknown" });
  await first;
  expect(c.last().message?.place).toBe("home");
  c.creation.homeShown(false);
  expect(c.last().message).toBeUndefined();

  c.creation.homeShown(true);
  const second = c.creation.createFromHome();
  c.creation.homeShown(false);
  c.workspaces[1]?.resolve(OK_SELECTED);
  await second;
  expect(c.last().message).toBeUndefined();
  // The confirmed create still empties the name.
  expect(c.last().homeDraft).toBe("");
});

test("the dialog of a workspace checks its name and stays open with the problem, then closes as the create starts, and says how it went below New workspace", async () => {
  const c = controller();
  c.creation.open("workspaces");
  expect(c.last().dialog).toEqual({
    place: "workspaces",
    workspaceId: null,
    workspaceName: null,
    draft: "",
    problem: undefined,
  });
  await expect(c.creation.confirm()).resolves.toBe(false);
  expect(c.last().dialog?.problem).toBe(CREATE_MESSAGES.nameMissing);
  c.creation.editDialogDraft(" Team Gamma ");
  expect(c.last().dialog).toMatchObject({
    draft: " Team Gamma ",
    problem: undefined,
  });
  expect(c.calls).toEqual([]);

  const done = c.creation.confirm();
  expect(c.calls).toEqual(["create Team Gamma"]);
  expect(c.last()).toMatchObject({ running: true, dialog: undefined });
  // A second confirmation sends nothing.
  await expect(c.creation.confirm()).resolves.toBe(false);
  c.workspaces[0]?.resolve({ ...OK_SELECTED, selected: false });
  await expect(done).resolves.toBe(true);
  expect(c.last().message).toEqual({
    place: "workspaces",
    text: CREATE_DONE_MESSAGES.workspaceNotSelected,
    created: { kind: "workspace", workspaceId: NEW_WORKSPACE },
  });
  // A confirmed create empties the name for the next dialog.
  c.creation.open("workspaces");
  expect(c.last().dialog?.draft).toBe("");
  expect(c.calls).toHaveLength(1);
});

test("a refused or cancelled dialog keeps its name for the next time it opens", async () => {
  const c = controller();
  c.creation.open("workspaces");
  c.creation.editDialogDraft("Team Gamma");
  c.creation.cancel();
  expect(c.last().dialog).toBeUndefined();
  c.creation.open("workspaces");
  expect(c.last().dialog?.draft).toBe("Team Gamma");
  const done = c.creation.confirm();
  c.workspaces[0]?.resolve({
    outcome: "refused",
    reason: "rate_limited",
    retryAfterMs: 3_600_000,
  });
  await expect(done).resolves.toBe(false);
  expect(c.last().message?.text).toContain("Try again in 1 hour.");
  c.creation.open("workspaces");
  expect(c.last().dialog?.draft).toBe("Team Gamma");
});

test("the dialog of a project sends the workspace that the button was shown for and the NFC name, and its answer counts only while that workspace stays selected", async () => {
  const c = controller();
  c.creation.open("projects", WORKSPACE_A, "Team Alpha");
  expect(c.last().dialog).toMatchObject({
    place: "projects",
    workspaceId: WORKSPACE_A,
    workspaceName: "Team Alpha",
  });
  c.creation.editDialogDraft(" Cafe\u0301 ");
  const done = c.creation.confirm();
  expect(c.calls).toEqual([`project ${WORKSPACE_A} Caf\u00e9`]);
  c.projects[0]?.resolve({ outcome: "ok", projectId: PROJECT });
  await expect(done).resolves.toBe(true);
  expect(c.last().message).toEqual({
    place: "projects",
    text: CREATE_DONE_MESSAGES.project,
    created: { kind: "project", workspaceId: WORKSPACE_A, projectId: PROJECT },
  });

  // A switch away and back while it is on its way drops its answer.
  c.creation.open("projects", WORKSPACE_A, "Team Alpha");
  c.creation.editDialogDraft("Second");
  const later = c.creation.confirm();
  expect(c.last().message).toBeUndefined();
  c.creation.viewChanged(known({ selectedWorkspaceId: WORKSPACE_B }));
  c.creation.viewChanged(known({ selectedWorkspaceId: WORKSPACE_A }));
  c.projects[1]?.resolve({
    outcome: "refused",
    reason: "conflict",
    retryAfterMs: null,
  });
  await expect(later).resolves.toBe(false);
  expect(c.last().message).toBeUndefined();
  expect(c.last().running).toBe(false);
});

test("a switch of the selected workspace ends a project's dialog, its name, and its sentence", async () => {
  const c = controller();
  c.creation.open("projects", WORKSPACE_A, "Team Alpha");
  c.creation.editDialogDraft("Roadmap");
  c.creation.viewChanged(known({ selectedWorkspaceId: WORKSPACE_B }));
  expect(c.last().dialog).toBeUndefined();
  c.creation.open("projects", WORKSPACE_B, "Team Beta");
  expect(c.last().dialog?.draft).toBe("");
  c.creation.editDialogDraft("Roadmap");
  const done = c.creation.confirm();
  c.projects[0]?.resolve({ outcome: "unknown" });
  await done;
  expect(c.last().message?.place).toBe("projects");
  // A reload of the same selection changes nothing.
  c.creation.viewChanged(
    known({ status: "loading", selectedWorkspaceId: WORKSPACE_B }),
  );
  expect(c.last().message?.place).toBe("projects");
  c.creation.viewChanged(known({ selectedWorkspaceId: WORKSPACE_A }));
  expect(c.last().message).toBeUndefined();
});

test("a workspace's sentence stays through the switch to the workspace that it selected, in either order, and ends with any later switch", async () => {
  for (const stateFirst of [true, false]) {
    const c = controller();
    c.creation.open("workspaces");
    c.creation.editDialogDraft("Team Gamma");
    const done = c.creation.confirm();
    const created: Partial<WorkspaceView> = {
      workspaces: [
        { id: NEW_WORKSPACE, name: "Team Gamma" },
        { id: WORKSPACE_A, name: "Team Alpha" },
      ],
      selectedWorkspaceId: NEW_WORKSPACE,
    };
    const selectedNew = known({ ...created, status: "loading" });
    if (stateFirst) {
      c.creation.viewChanged(selectedNew);
    }
    c.workspaces[0]?.resolve(OK_SELECTED);
    await expect(done).resolves.toBe(true);
    if (!stateFirst) {
      c.creation.viewChanged(selectedNew);
    }
    expect(c.last().message, String(stateFirst)).toEqual({
      place: "workspaces",
      text: CREATE_DONE_MESSAGES.workspaceSelected,
    });
    c.creation.viewChanged(known({ ...created, status: "ready" }));
    expect(c.last().message).toBeDefined();
    c.creation.viewChanged(known({ selectedWorkspaceId: WORKSPACE_A }));
    expect(c.last().message).toBeUndefined();
  }
  // A workspace that was not selected keeps its sentence until a switch.
  const c = controller();
  c.creation.open("workspaces");
  c.creation.editDialogDraft("Team Gamma");
  const done = c.creation.confirm();
  c.workspaces[0]?.resolve({ ...OK_SELECTED, selected: false });
  await done;
  expect(c.last().message?.text).toBe(
    CREATE_DONE_MESSAGES.workspaceNotSelected,
  );
  c.creation.viewChanged(known({ selectedWorkspaceId: NEW_WORKSPACE }));
  expect(c.last().message).toBeUndefined();
});

test("a sign-out ends the dialog, the names, the problems, and the sentence, and an answer that comes after it shows nothing", async () => {
  const c = controller(known({ workspaces: [], selectedWorkspaceId: null }));
  c.creation.homeShown(true);
  c.creation.editHomeDraft("Team Gamma");
  const done = c.creation.createFromHome();
  c.creation.viewChanged(SIGNED_OUT);
  c.workspaces[0]?.resolve(OK_SELECTED);
  await expect(done).resolves.toBe(false);
  expect(c.last()).toEqual(IDLE_CREATION);

  // Signed in again: the dialog's name was dropped too.
  c.creation.viewChanged(known());
  c.creation.open("workspaces");
  c.creation.editDialogDraft("Team Delta");
  c.creation.cancel();
  c.creation.viewChanged(SIGNED_OUT);
  c.creation.viewChanged(known());
  c.creation.open("workspaces");
  expect(c.last().dialog?.draft).toBe("");
  c.creation.viewChanged(SIGNED_OUT);
  expect(c.last().dialog).toBeUndefined();
});

// Opening a new workspace or project (the Project Manager's decision of
// 2026-11-12 on #95).

const NEW_PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e2";
const OTHER_PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e3";

/** The list after the main process added the new workspace. */
const WITH_NEW_WORKSPACE: Partial<WorkspaceView> = {
  workspaces: [
    { id: NEW_WORKSPACE, name: "Team Gamma" },
    { id: WORKSPACE_A, name: "Team Alpha" },
    { id: WORKSPACE_B, name: "Team Beta" },
  ],
};

/** The projects after `workspace.project.created` listed the new one. */
const WITH_NEW_PROJECT: Partial<WorkspaceView> = {
  projects: [
    { id: PROJECT, name: "Launch Plan" },
    { id: NEW_PROJECT, name: "Roadmap" },
  ],
};

/** Paths that record each call as text. */
function recordingPaths() {
  const calls: string[] = [];
  const paths = {
    selectWorkspace: (...args: unknown[]) =>
      calls.push(`select ${JSON.stringify(args)}`),
    openProject: (...args: unknown[]) =>
      calls.push(`open ${JSON.stringify(args)}`),
  };
  return { calls, paths };
}

/** Creates a workspace from the sidebar's dialog and answers it with `result`. */
async function createWorkspace(
  c: ReturnType<typeof controller>,
  result: CreateWorkspaceResult,
): Promise<void> {
  c.creation.open("workspaces");
  c.creation.editDialogDraft("Team Gamma");
  const done = c.creation.confirm();
  c.workspaces.at(-1)?.resolve(result);
  await done;
}

/** Creates a project in Team Alpha and answers it with `result`. */
async function createProject(
  c: ReturnType<typeof controller>,
  result: CreateProjectResult,
): Promise<void> {
  c.creation.open("projects", WORKSPACE_A, "Team Alpha");
  c.creation.editDialogDraft("Roadmap");
  const done = c.creation.confirm();
  c.projects.at(-1)?.resolve(result);
  await done;
}

test("a sentence keeps what it may offer to open: a new workspace only when the create did not select it, a new project with its workspace, and nothing after any other answer", async () => {
  const c = controller();
  await createWorkspace(c, { ...OK_SELECTED, selected: false });
  expect(c.last().message).toEqual({
    place: "workspaces",
    text: CREATE_DONE_MESSAGES.workspaceNotSelected,
    created: { kind: "workspace", workspaceId: NEW_WORKSPACE },
  });
  await createWorkspace(c, OK_SELECTED);
  expect(c.last().message?.text).toBe(CREATE_DONE_MESSAGES.workspaceSelected);
  expect(c.last().message?.created).toBeUndefined();
  for (const result of [
    { outcome: "unknown" },
    { outcome: "refused", reason: "rate_limited", retryAfterMs: 1000 },
  ] as const) {
    await createWorkspace(c, result);
    expect(c.last().message?.created).toBeUndefined();
    await createProject(c, result);
    expect(c.last().message?.created).toBeUndefined();
  }
  await createProject(c, { outcome: "ok", projectId: NEW_PROJECT });
  expect(c.last().message?.created).toEqual({
    kind: "project",
    workspaceId: WORKSPACE_A,
    projectId: NEW_PROJECT,
  });
  // The home screen's create keeps it too.
  c.creation.homeShown(true);
  c.creation.editHomeDraft("Team Delta");
  const home = c.creation.createFromHome();
  c.workspaces.at(-1)?.resolve({ ...OK_SELECTED, selected: false });
  await home;
  expect(c.last().message).toMatchObject({
    place: "home",
    created: { kind: "workspace", workspaceId: NEW_WORKSPACE },
  });
});

test("Open this workspace is offered for a new workspace that was not selected, only while the list holds it and it is not the selected workspace", () => {
  const message = {
    place: "workspaces",
    text: CREATE_DONE_MESSAGES.workspaceNotSelected,
    created: { kind: "workspace", workspaceId: NEW_WORKSPACE },
  } as const;
  expect(describeCreatedOffer(message, known(WITH_NEW_WORKSPACE))).toEqual({
    kind: "workspace",
    place: "workspaces",
    workspaceId: NEW_WORKSPACE,
  });
  // At the home screen's sentence, at its place.
  expect(
    describeCreatedOffer(
      { ...message, place: "home" },
      known({ ...WITH_NEW_WORKSPACE, status: "loading" }),
    ),
  ).toMatchObject({ kind: "workspace", place: "home" });
  // Not before the list holds it, not once it is selected, not while no
  // device is signed in, and not without a known state.
  for (const view of [
    known(),
    known({ ...WITH_NEW_WORKSPACE, selectedWorkspaceId: NEW_WORKSPACE }),
    known({ ...WITH_NEW_WORKSPACE, status: "signed_out" }),
    { kind: "pending" } as const,
    { kind: "unavailable" } as const,
    undefined,
  ]) {
    expect(describeCreatedOffer(message, view)).toBeUndefined();
  }
  // Not for a sentence without it: a selected workspace, or another answer.
  for (const other of [
    { place: "workspaces", text: CREATE_DONE_MESSAGES.workspaceSelected },
    { place: "workspaces", text: CREATE_UNKNOWN_MESSAGES.workspace },
    undefined,
  ] as const) {
    expect(
      describeCreatedOffer(other, known(WITH_NEW_WORKSPACE)),
    ).toBeUndefined();
  }
});

test("Open this project is offered once the list of projects holds the new project, only while its workspace is still selected and it is not the open project", () => {
  const message = {
    place: "projects",
    text: CREATE_DONE_MESSAGES.project,
    created: {
      kind: "project",
      workspaceId: WORKSPACE_A,
      projectId: NEW_PROJECT,
    },
  } as const;
  expect(describeCreatedOffer(message, known(WITH_NEW_PROJECT))).toEqual({
    kind: "project",
    place: "projects",
    projectId: NEW_PROJECT,
  });
  for (const view of [
    // Before its `workspace.project.created` event lists it.
    known({ projects: [{ id: PROJECT, name: "Launch Plan" }] }),
    // Another workspace is selected, even with the project in the list.
    known({ ...WITH_NEW_PROJECT, selectedWorkspaceId: WORKSPACE_B }),
    known({ ...WITH_NEW_PROJECT, selectedWorkspaceId: null }),
    // It is the open project.
    known({ ...WITH_NEW_PROJECT, openProjectId: NEW_PROJECT }),
    known({ ...WITH_NEW_PROJECT, status: "signed_out" }),
    { kind: "pending" } as const,
  ]) {
    expect(describeCreatedOffer(message, view)).toBeUndefined();
  }
  // Another project open still offers it.
  expect(
    describeCreatedOffer(
      message,
      known({ ...WITH_NEW_PROJECT, openProjectId: PROJECT }),
    ),
  ).toBeDefined();
});

test("next to its button, the sentence of a new workspace or project is the short one, the start of the long one, which shows before the button and never after it showed; every other sentence has one part", () => {
  expect(CREATE_DONE_SHORT_MESSAGES).toEqual({
    workspace: "The workspace was created.",
    project: "The project was created.",
  });
  expect(CREATE_DONE_MESSAGES.workspaceSelected).toBe(
    "The workspace was created and selected.",
  );
  const workspace: CreateMessage = {
    place: "workspaces",
    text: CREATE_DONE_MESSAGES.workspaceNotSelected,
    created: { kind: "workspace", workspaceId: NEW_WORKSPACE },
  };
  const project: CreateMessage = {
    place: "projects",
    text: CREATE_DONE_MESSAGES.project,
    created: {
      kind: "project",
      workspaceId: WORKSPACE_A,
      projectId: NEW_PROJECT,
    },
  };
  // Before the button shows: the long sentence, whose start is the short one.
  expect(describeCreateSentence(workspace, undefined)).toEqual({
    start: "The workspace was created.",
    rest: " Select it in the list of workspaces to open it.",
  });
  expect(describeCreateSentence(project, undefined)).toEqual({
    start: "The project was created.",
    rest: " It shows in the list of projects once the server reports it.",
  });
  // While the button follows it: the short one alone.
  expect(
    describeCreateSentence(
      workspace,
      describeCreatedOffer(workspace, known(WITH_NEW_WORKSPACE)),
    ),
  ).toEqual({ start: CREATE_DONE_SHORT_MESSAGES.workspace, rest: "" });
  expect(
    describeCreateSentence(
      project,
      describeCreatedOffer(project, known(WITH_NEW_PROJECT)),
    ),
  ).toEqual({ start: CREATE_DONE_SHORT_MESSAGES.project, rest: "" });
  // Once it showed, also after it left.
  expect(
    describeCreateSentence({ ...workspace, offered: true }, undefined),
  ).toEqual({ start: CREATE_DONE_SHORT_MESSAGES.workspace, rest: "" });
  expect(
    describeCreateSentence({ ...project, offered: true }, undefined),
  ).toEqual({
    start: CREATE_DONE_SHORT_MESSAGES.project,
    rest: "",
  });
  for (const text of [
    CREATE_DONE_MESSAGES.workspaceSelected,
    CREATE_UNKNOWN_MESSAGES.workspace,
    CREATE_UNKNOWN_MESSAGES.project,
    `${CREATE_NOT_DONE_MESSAGES.project} ${CREATE_NOT_SENT}`,
  ]) {
    for (const offered of [undefined, true]) {
      expect(
        describeCreateSentence(
          { place: "workspaces", text, offered },
          undefined,
        ),
      ).toEqual({ start: text, rest: "" });
    }
  }
});

/** The sentence that `c` shows by the workspace state `view`. */
function sentenceOf(
  c: ReturnType<typeof controller>,
  view: WorkspacePanelView,
) {
  const message = c.last().message;
  return message === undefined
    ? undefined
    : describeCreateSentence(message, describeCreatedOffer(message, view));
}

test("a sentence is marked once a state offers its button, also when the state came before the answer, and stays marked after the button leaves; a new create starts unmarked", async () => {
  // A project whose event lists it after the answer.
  const p = controller();
  await createProject(p, { outcome: "ok", projectId: NEW_PROJECT });
  expect(p.last().message?.offered).toBeUndefined();
  expect(sentenceOf(p, known())).toEqual({
    start: CREATE_DONE_SHORT_MESSAGES.project,
    rest: " It shows in the list of projects once the server reports it.",
  });
  const shown = p.views.length;
  const listed = known(WITH_NEW_PROJECT);
  p.creation.viewChanged(listed);
  expect(p.views).toHaveLength(shown + 1);
  expect(p.last().message).toMatchObject({
    text: CREATE_DONE_MESSAGES.project,
    offered: true,
  });
  expect(sentenceOf(p, listed)).toEqual({
    start: CREATE_DONE_SHORT_MESSAGES.project,
    rest: "",
  });
  // The same state again shows nothing new.
  p.creation.viewChanged(known(WITH_NEW_PROJECT));
  expect(p.views).toHaveLength(shown + 1);
  // Once it is open, the button leaves, and the sentence stays short.
  const open = known({ ...WITH_NEW_PROJECT, openProjectId: NEW_PROJECT });
  p.creation.viewChanged(open);
  expect(describeCreatedOffer(p.last().message, open)).toBeUndefined();
  expect(sentenceOf(p, open)).toEqual({
    start: CREATE_DONE_SHORT_MESSAGES.project,
    rest: "",
  });
  // A new create starts with the long sentence again.
  await createProject(p, { outcome: "ok", projectId: OTHER_PROJECT });
  expect(p.last().message?.offered).toBeUndefined();
  expect(sentenceOf(p, open)?.rest).not.toBe("");

  // A workspace that the list holds before the answer comes.
  const c = controller();
  c.creation.open("workspaces");
  c.creation.editDialogDraft("Team Gamma");
  const done = c.creation.confirm();
  c.creation.viewChanged(known(WITH_NEW_WORKSPACE));
  c.workspaces[0]?.resolve({ ...OK_SELECTED, selected: false });
  await done;
  expect(c.last().message).toMatchObject({
    text: CREATE_DONE_MESSAGES.workspaceNotSelected,
    offered: true,
  });
  // It leaves the list without a switch: the sentence stays short.
  c.creation.viewChanged(known());
  expect(sentenceOf(c, known())).toEqual({
    start: CREATE_DONE_SHORT_MESSAGES.workspace,
    rest: "",
  });
});

test("Open this workspace goes through the sidebar's switch with the ID alone, and Open this project through the shell's open-project, once per click", async () => {
  const c = controller();
  const { calls, paths } = recordingPaths();
  await createWorkspace(c, { ...OK_SELECTED, selected: false });
  // Before the list holds it, nothing is offered and nothing goes.
  expect(c.creation.openCreated(paths)).toBe(false);
  c.creation.viewChanged(known(WITH_NEW_WORKSPACE));
  expect(c.creation.openCreated(paths)).toBe(true);
  expect(c.creation.openCreated(paths)).toBe(true);
  expect(calls).toEqual([
    `select ["${NEW_WORKSPACE}"]`,
    `select ["${NEW_WORKSPACE}"]`,
  ]);
  // Once the switch selected it, its sentence ends, and nothing is offered.
  c.creation.viewChanged(
    known({ ...WITH_NEW_WORKSPACE, selectedWorkspaceId: NEW_WORKSPACE }),
  );
  expect(c.last().message).toBeUndefined();
  expect(c.creation.openCreated(paths)).toBe(false);

  // A new project in the selected workspace.
  const p = controller();
  const project = recordingPaths();
  await createProject(p, { outcome: "ok", projectId: NEW_PROJECT });
  expect(p.creation.openCreated(project.paths)).toBe(false);
  p.creation.viewChanged(known(WITH_NEW_PROJECT));
  expect(p.creation.openCreated(project.paths)).toBe(true);
  expect(project.calls).toEqual([`open ["${NEW_PROJECT}"]`]);
  // Once it is the open project, nothing is offered.
  p.creation.viewChanged(
    known({ ...WITH_NEW_PROJECT, openProjectId: NEW_PROJECT }),
  );
  expect(p.creation.openCreated(project.paths)).toBe(false);
  expect(project.calls).toHaveLength(1);
});

test("one action at a time: a create that starts ends the offer, and nothing opens while it runs", async () => {
  const c = controller();
  const { calls, paths } = recordingPaths();
  await createWorkspace(c, { ...OK_SELECTED, selected: false });
  c.creation.viewChanged(known(WITH_NEW_WORKSPACE));
  c.creation.open("workspaces");
  c.creation.editDialogDraft("Team Delta");
  const done = c.creation.confirm();
  expect(c.last().running).toBe(true);
  expect(c.creation.openCreated(paths)).toBe(false);
  c.workspaces.at(-1)?.resolve({ ...OK_SELECTED, selected: false });
  await done;
  // The new answer offers its own workspace again.
  expect(c.creation.openCreated(paths)).toBe(true);
  expect(calls).toEqual([`select ["${NEW_WORKSPACE}"]`]);
});

test("the paths are the sidebar's switch as it is and the shell's open-project, the action of the list of projects", () => {
  const calls: unknown[] = [];
  const paths = createdOpenPaths(
    (...args: unknown[]) => calls.push(["select", ...args]),
    (action) => calls.push(action),
  );
  paths.selectWorkspace(NEW_WORKSPACE);
  paths.openProject(NEW_PROJECT);
  expect(calls).toEqual([
    ["select", NEW_WORKSPACE],
    { type: "open-project", projectId: NEW_PROJECT },
  ]);
});

/**
 * The shell's paths as `App` wires them: the sidebar's controller over a
 * bridge whose switches answer `waiting`, and a dispatch that applies the
 * shell's reducer and reports a changed open project, as `App`'s effect
 * does.
 */
function shellWithWaitingMessages() {
  const calls: string[] = [];
  const questions: (SwitchQuestion | undefined)[] = [];
  const bridge: Pick<
    WorkspaceBridge,
    "subscribeState" | "openProject" | "select"
  > = {
    subscribeState: () => () => undefined,
    select: (...args: unknown[]) => {
      calls.push(`select ${JSON.stringify(args)}`);
      return Promise.resolve({ outcome: "waiting" as const, count: 2 });
    },
    openProject: (...args: unknown[]) => {
      calls.push(`openProject ${JSON.stringify(args)}`);
      return Promise.resolve({ outcome: "waiting" as const, count: 1 });
    },
  };
  let shell = createShellState(
    workspaceState(WITH_NEW_PROJECT).projects,
    HOME_VIEW,
  );
  const openProjectId = () =>
    isProjectView(shell.view) ? shell.view.projectId : null;
  let reported: string | null = null;
  const dispatch = (action: ShellAction) => {
    shell = shellReducer(shell, action);
    if (openProjectId() !== reported) {
      reported = openProjectId();
      sidebar.openProjectChanged(reported);
    }
  };
  const sidebar = createWorkspaceSidebar(
    bridge,
    dispatch,
    () => undefined,
    () => undefined,
    (question) => questions.push(question),
  );
  return {
    calls,
    questions,
    sidebar,
    paths: createdOpenPaths(sidebar.select, dispatch),
    openProjectId,
  };
}

test("neither button discards waiting chat messages: each asks the switch question, and only its answer discards them", async () => {
  const shell = shellWithWaitingMessages();
  const c = controller();
  await createWorkspace(c, { ...OK_SELECTED, selected: false });
  c.creation.viewChanged(known(WITH_NEW_WORKSPACE));
  expect(c.creation.openCreated(shell.paths)).toBe(true);
  await settle();
  expect(shell.calls).toEqual([`select ["${NEW_WORKSPACE}"]`]);
  expect(shell.questions.at(-1)).toEqual({ kind: "workspace", count: 2 });
  // Keeping the messages sends nothing more.
  shell.sidebar.keepWaiting();
  await settle();
  expect(shell.calls).toHaveLength(1);

  const p = controller();
  await createProject(p, { outcome: "ok", projectId: NEW_PROJECT });
  p.creation.viewChanged(known(WITH_NEW_PROJECT));
  expect(p.creation.openCreated(shell.paths)).toBe(true);
  expect(shell.openProjectId()).toBe(NEW_PROJECT);
  await settle();
  expect(shell.calls.slice(1)).toEqual([`openProject ["${NEW_PROJECT}"]`]);
  expect(shell.questions.at(-1)).toEqual({ kind: "project", count: 1 });
  // Only the person's answer repeats the switch with the messages dropped.
  shell.sidebar.discardWaiting();
  await settle();
  expect(shell.calls.slice(2)).toEqual([
    `openProject ["${NEW_PROJECT}",{"discardWaiting":true}]`,
  ]);
});
