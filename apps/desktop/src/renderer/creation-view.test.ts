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
  CREATE_MESSAGES,
  CREATE_NOT_DONE_MESSAGES,
  CREATE_NOT_SENT,
  CREATE_REFUSAL_MESSAGES,
  CREATE_UNKNOWN_MESSAGES,
  createCreation,
  describeCreateResult,
  describeCreation,
  IDLE_CREATION,
  MAX_NEW_NAME_LENGTH,
  nameToSend,
  newNamePrompt,
  type CreationView,
} from "./creation-view.ts";
import type { WorkspacePanelView } from "./workspace-view.ts";

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
    "The project could not be created. The server asked to wait. Try again in 24 hours. An account creates at most 20 projects in 24 hours.",
  );
  // The limit of projects in a workspace has its own code and names no wait,
  // because none helps (#255).
  const full = describeCreateResult("project", {
    outcome: "refused",
    reason: "project_limit",
    retryAfterMs: null,
  });
  expect(full).toBe(
    "The project could not be created. This workspace already holds as many projects as it can, and projects cannot be removed yet. Create the project in another workspace.",
  );
  expect(full).not.toMatch(/Try again|wait/iu);
  expect(
    describeCreateResult("project", {
      outcome: "refused",
      reason: "rate_limited",
      retryAfterMs: 3_600_000,
    }),
  ).not.toContain("holds");
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

test("a project create at the workspace's limit of projects says so below New project, names no wait, and keeps the name (#255)", async () => {
  const c = controller();
  c.creation.open("projects", WORKSPACE_A, "Team Alpha");
  c.creation.editDialogDraft("Roadmap");
  const done = c.creation.confirm();
  c.projects[0]?.resolve({
    outcome: "refused",
    reason: "project_limit",
    retryAfterMs: null,
  });
  await expect(done).resolves.toBe(false);
  expect(c.last().message).toEqual({
    place: "projects",
    text: `${CREATE_NOT_DONE_MESSAGES.project} ${CREATE_REFUSAL_MESSAGES.project_limit}`,
  });
  expect(c.last().message?.text).not.toMatch(/Try again|wait/iu);
  expect(c.calls).toEqual([`project ${WORKSPACE_A} Roadmap`]);
  c.creation.open("projects", WORKSPACE_A, "Team Alpha");
  expect(c.last().dialog?.draft).toBe("Roadmap");
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
