// The creates of a workspace and a project (#95, D7) in the shell. The
// components use no hooks except the dialog's box, so the tests render the
// markup and also call the components as functions, walk the returned
// elements, and invoke their event handlers.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type { WorkspaceView } from "../shared/ipc-contract.ts";
import {
  CreateButton,
  CreateDialogContent,
  CreatedOpenButton,
  focusAfterOpenLeaves,
  HOME_TITLE_ID,
  HomeCreateWorkspace,
  PROJECTS_HEADING_ID,
  WORKSPACES_HEADING_ID,
  type CreationControls,
} from "./Creation.tsx";
import {
  CREATE_DONE_MESSAGES,
  CREATE_DONE_SHORT_MESSAGES,
  CREATE_MESSAGES,
  describeCreatedOffer,
  describeCreation,
  IDLE_CREATION,
  type CreateDialog,
  type CreationView,
} from "./creation-view.ts";
import { WorkspaceNav } from "./Navigation.tsx";
import { createShellState } from "./screens.ts";
import { HomeScreen } from "./WorkspaceScreens.tsx";

const WORKSPACE_A = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a1";
const WORKSPACE_B = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a2";
const PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e1";

/** A name that would be markup, if it were rendered as markup. */
const MARKUP_NAME = '<img src="x" onerror="alert(1)">';
const ESCAPED_MARKUP_NAME =
  "&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;";

function workspaceState(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    revision: 3,
    status: "ready",
    workspaces: [
      { id: WORKSPACE_A, name: MARKUP_NAME },
      { id: WORKSPACE_B, name: "Team Beta" },
    ],
    selectedWorkspaceId: WORKSPACE_A,
    projects: [{ id: PROJECT, name: "Launch Plan" }],
    openProjectId: null,
    ...overrides,
  } as WorkspaceView;
}

interface HostProps {
  readonly children?: ReactNode;
  readonly id?: string;
  readonly type?: string;
  readonly "aria-disabled"?: string;
  readonly onClick?: (event: { readonly currentTarget: unknown }) => void;
  readonly onSubmit?: (event: { readonly preventDefault: () => void }) => void;
  readonly onChange?: (event: {
    readonly currentTarget: { readonly value: string };
  }) => void;
  readonly onCancel?: (event: { readonly preventDefault: () => void }) => void;
  readonly onClose?: () => void;
}

/**
 * The element and every element below it. A component without hooks is
 * called to reach its elements; one with hooks stays a leaf.
 */
function elementsOf(node: ReactNode): ReactElement<HostProps>[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => elementsOf(child));
  }
  if (!isValidElement<HostProps>(node)) {
    return [];
  }
  if (typeof node.type === "function") {
    try {
      return elementsOf(
        (node.type as (props: HostProps) => ReactNode)(node.props),
      );
    } catch {
      return [node];
    }
  }
  return [node, ...elementsOf(node.props.children)];
}

/** Controls that record each call as text. */
function controls(
  view: CreationView = IDLE_CREATION,
  state: WorkspaceView = workspaceState(),
) {
  const calls: string[] = [];
  const value: CreationControls = {
    view,
    offer: describeCreation({ kind: "known", state }),
    created: describeCreatedOffer(view.message, { kind: "known", state }),
    onOpenCreated: () => calls.push("open created"),
    onOpen: (place, button) => calls.push(`open ${place} ${String(button)}`),
    onHomeDraft: (text) => calls.push(`home draft ${text}`),
    onCreateFromHome: () => calls.push("create from home"),
    onConfirm: () => calls.push("confirm"),
    onCancel: () => calls.push("cancel"),
    onDialogDraft: (text) => calls.push(`dialog draft ${text}`),
  };
  return { calls, value };
}

function nav(creation: CreationControls | undefined, state = workspaceState()) {
  return (
    <WorkspaceNav
      state={createShellState(state.projects)}
      dispatch={() => undefined}
      workspaces={{
        view: { kind: "known", state },
        message: undefined,
        onSelect: () => undefined,
      }}
      creation={creation}
    />
  );
}

/** The labels of the buttons in `html`. */
function buttonLabels(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(
    ([, label]) => label ?? "",
  );
}

test("the sidebar offers New workspace below the workspaces and New project below the selected workspace's projects, each followed by its status paragraph", () => {
  const html = renderToString(nav(controls().value));
  expect(buttonLabels(html)).toEqual([
    "Home",
    "Account",
    "People",
    "Join",
    "About",
    ESCAPED_MARKUP_NAME,
    "Team Beta",
    CREATE_MESSAGES.newWorkspace,
    "Launch Plan",
    CREATE_MESSAGES.newProject,
  ]);
  expect(html).toContain(
    `</ul><p class="nav-empty nav-status" role="status"></p><div class="nav-create"><button type="button" class="panel-action">New workspace</button></div><p class="nav-empty nav-status" id="create-status-workspaces" role="status"></p><h2 class="nav-heading" id="projects-heading" tabindex="-1">Projects</h2>`,
  );
  expect(html).toContain(
    `</ul><div class="nav-create"><button type="button" class="panel-action">New project</button></div><p class="nav-empty nav-status" id="create-status-projects" role="status"></p></nav>`,
  );
  // The names are text, with their own direction.
  expect(html).toContain(
    `dir="auto" aria-current="true">${ESCAPED_MARKUP_NAME}</button>`,
  );
  expect(html).not.toContain("<img");
  // No ID appears in the markup.
  for (const id of [WORKSPACE_A, WORKSPACE_B, PROJECT]) {
    expect(html).not.toContain(id);
  }
});

test("each sentence shows in the status paragraph of its own place only", () => {
  const sidebar = (place: "workspaces" | "projects" | "home") =>
    renderToString(
      nav(
        controls({
          ...IDLE_CREATION,
          message: { place, text: CREATE_DONE_MESSAGES.project },
        }).value,
      ),
    );
  expect(sidebar("workspaces")).toContain(
    `<div class="nav-create"><button type="button" class="panel-action">New workspace</button></div><p class="nav-empty nav-status" id="create-status-workspaces" role="status">${CREATE_DONE_MESSAGES.project}</p>`,
  );
  expect(sidebar("projects")).toContain(
    `New project</button></div><p class="nav-empty nav-status" id="create-status-projects" role="status">${CREATE_DONE_MESSAGES.project}</p></nav>`,
  );
  expect(sidebar("home")).not.toContain(CREATE_DONE_MESSAGES.project);
  expect(
    sidebar("workspaces").split(CREATE_DONE_MESSAGES.project),
  ).toHaveLength(2);
});

test("without a selected workspace there is no New project, and without a signed-in device and without the bridge nothing is offered", () => {
  const none = renderToString(
    nav(
      controls(IDLE_CREATION, workspaceState({ selectedWorkspaceId: null }))
        .value,
      workspaceState({ selectedWorkspaceId: null }),
    ),
  );
  expect(buttonLabels(none)).toContain(CREATE_MESSAGES.newWorkspace);
  expect(buttonLabels(none)).not.toContain(CREATE_MESSAGES.newProject);

  const signedOut = workspaceState({
    status: "signed_out",
    workspaces: [],
    selectedWorkspaceId: null,
    projects: [],
  });
  const html = renderToString(
    nav(controls(IDLE_CREATION, signedOut).value, signedOut),
  );
  expect(buttonLabels(html)).not.toContain(CREATE_MESSAGES.newWorkspace);
  expect(buttonLabels(html)).not.toContain(CREATE_MESSAGES.newProject);

  const without = renderToString(nav(undefined));
  expect(buttonLabels(without)).not.toContain(CREATE_MESSAGES.newWorkspace);
  expect(buttonLabels(without)).not.toContain(CREATE_MESSAGES.newProject);
  expect(without.match(/role="status"/g)).toHaveLength(1);
});

test("New workspace and New project open their dialog with the clicked button, and stay focusable and inert while a create runs", () => {
  for (const running of [false, true]) {
    const { calls, value } = controls({ ...IDLE_CREATION, running });
    const buttons = elementsOf(nav(value)).filter(
      (element) =>
        element.type === "button" &&
        (element.props.children === CREATE_MESSAGES.newWorkspace ||
          element.props.children === CREATE_MESSAGES.newProject),
    );
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.props["aria-disabled"]).toBe(running ? "true" : undefined);
      button.props.onClick?.({ currentTarget: "the button" });
    }
    expect(calls).toEqual(
      running ? [] : ["open workspaces the button", "open projects the button"],
    );
  }
  expect(
    renderToString(
      <CreateButton place="projects" running onOpen={() => undefined} />,
    ),
  ).toBe(
    '<div class="nav-create"><button type="button" class="panel-action" aria-disabled="true">New project</button></div>',
  );
});

test("the home screen's form has a name field with its hint and problem, no maxLength, and Create, which does nothing while a create runs", () => {
  const html = renderToString(
    <HomeCreateWorkspace
      draft={MARKUP_NAME}
      problem={CREATE_MESSAGES.nameMissing}
      running={false}
      onDraft={() => undefined}
      onCreate={() => undefined}
    />,
  );
  expect(html).toBe(
    `<form id="home-create" class="people-form" aria-labelledby="home-create-title"><h3 id="home-create-title">Create a workspace</h3><p>${CREATE_MESSAGES.homeIntro}</p><p class="person-meta" id="home-create-hint">${CREATE_MESSAGES.workspaceHint.replaceAll("'", "&#x27;")}</p><label class="account-label" for="home-create-name">Name</label><input id="home-create-name" class="account-input" type="text" dir="auto" autoComplete="off" spellCheck="false" aria-invalid="true" aria-describedby="home-create-hint home-create-problem" value="${ESCAPED_MARKUP_NAME}"/><p class="panel-message" id="home-create-problem" role="alert">Enter a name.</p><div class="account-actions"><button type="submit" class="panel-action">Create</button></div></form>`,
  );
  expect(html.toLowerCase()).not.toContain("maxlength");
  for (const running of [false, true]) {
    const calls: string[] = [];
    const elements = elementsOf(
      HomeCreateWorkspace({
        draft: "Team",
        problem: undefined,
        running,
        onDraft: (text) => calls.push(`draft ${text}`),
        onCreate: () => calls.push("create"),
      }),
    );
    const form = elements.find((element) => element.type === "form");
    const input = elements.find((element) => element.type === "input");
    const submit = elements.find((element) => element.type === "button");
    expect(submit?.props["aria-disabled"]).toBe(running ? "true" : undefined);
    let prevented = false;
    form?.props.onSubmit?.({
      preventDefault: () => {
        prevented = true;
      },
    });
    input?.props.onChange?.({ currentTarget: { value: "Team G" } });
    expect(prevented).toBe(true);
    expect(calls).toEqual(
      running ? ["draft Team G"] : ["create", "draft Team G"],
    );
  }
});

test("the home screen shows the form only while the account has no workspace, and its status paragraph whenever it has the bridge", () => {
  const home = (state: WorkspaceView, view: CreationView = IDLE_CREATION) =>
    renderToString(
      <HomeScreen
        signIn="none"
        start={{ running: false, message: undefined }}
        onStartSignIn={() => undefined}
        dispatch={() => undefined}
        focusAfterShow={() => undefined}
        creation={controls(view, state).value}
      />,
    );
  const empty = workspaceState({
    workspaces: [],
    selectedWorkspaceId: null,
    projects: [],
  });
  expect(home(empty)).toContain('<form id="home-create"');
  expect(home(empty)).toContain('<h2 id="home-title" tabindex="-1">Home</h2>');
  expect(home(empty)).toMatch(
    /<\/form><p class="account-message" id="create-status-home" role="status"><\/p><\/section>$/,
  );
  const listed = home(workspaceState(), {
    ...IDLE_CREATION,
    message: { place: "home", text: CREATE_DONE_MESSAGES.workspaceSelected },
  });
  expect(listed).not.toContain("<form");
  expect(listed).toMatch(
    new RegExp(
      `<p class="account-message" id="create-status-home" role="status">${CREATE_DONE_MESSAGES.workspaceSelected}</p></section>$`,
    ),
  );
  // Another place's sentence does not show here.
  expect(
    home(empty, {
      ...IDLE_CREATION,
      message: { place: "workspaces", text: CREATE_DONE_MESSAGES.project },
    }),
  ).not.toContain(CREATE_DONE_MESSAGES.project);
  for (const status of ["loading", "signed_out"] as const) {
    expect(home({ ...empty, status } as WorkspaceView), status).not.toContain(
      "<form",
    );
  }
});

function dialog(overrides: Partial<CreateDialog> = {}): CreateDialog {
  return {
    place: "workspaces",
    workspaceId: null,
    workspaceName: null,
    draft: "",
    problem: undefined,
    ...overrides,
  };
}

test("the dialog stays in the page empty and closed while none is open", () => {
  expect(
    renderToString(
      <CreateDialogContent
        dialog={undefined}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        onDraft={() => undefined}
      />,
    ),
  ).toBe('<dialog class="people-dialog"></dialog>');
});

test("the dialog of a workspace asks for the name with the hint of what a create does, the field first, without maxLength, and Cancel before Create", () => {
  const html = renderToString(
    <CreateDialogContent
      dialog={dialog({ draft: MARKUP_NAME, problem: "Enter a name." })}
      onConfirm={() => undefined}
      onCancel={() => undefined}
      onDraft={() => undefined}
    />,
  );
  expect(html).toBe(
    `<dialog class="people-dialog" aria-labelledby="create-dialog-title" aria-describedby="create-dialog-hint"><form><h2 id="create-dialog-title">Create a workspace</h2><p id="create-dialog-hint">${CREATE_MESSAGES.workspaceHint.replaceAll("'", "&#x27;")}</p><label class="account-label" for="create-dialog-field">Name</label><input id="create-dialog-field" class="account-input" type="text" dir="auto" autoComplete="off" spellCheck="false" aria-invalid="true" aria-describedby="create-dialog-problem" value="${ESCAPED_MARKUP_NAME}"/><p class="panel-message" id="create-dialog-problem" role="alert">Enter a name.</p><div class="people-dialog-actions"><button type="button" class="panel-action">Cancel</button><button type="submit" class="panel-action">Create</button></div></form></dialog>`,
  );
  expect(html.toLowerCase()).not.toContain("maxlength");
  // What a create of a workspace does (ADR 0014): the creator owns it.
  expect(CREATE_MESSAGES.workspaceHint).toContain("You become its owner");
});

test("the dialog of a project names its workspace as text with its own direction, and says that names are unique whatever the case", () => {
  const html = renderToString(
    <CreateDialogContent
      dialog={dialog({
        place: "projects",
        workspaceId: WORKSPACE_A,
        workspaceName: MARKUP_NAME,
      })}
      onConfirm={() => undefined}
      onCancel={() => undefined}
      onDraft={() => undefined}
    />,
  );
  expect(html).toContain(
    `aria-describedby="create-dialog-in create-dialog-hint"><form><h2 id="create-dialog-title">Create a project</h2><p class="people-dialog-name" id="create-dialog-in">In the workspace <span dir="auto">${ESCAPED_MARKUP_NAME}</span></p><p id="create-dialog-hint">${CREATE_MESSAGES.projectHint}</p>`,
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain(WORKSPACE_A);
  // Without the workspace's name, the dialog names none.
  const unnamed = renderToString(
    <CreateDialogContent
      dialog={dialog({ place: "projects", workspaceId: WORKSPACE_A })}
      onConfirm={() => undefined}
      onCancel={() => undefined}
      onDraft={() => undefined}
    />,
  );
  expect(unnamed).toContain('aria-describedby="create-dialog-hint"');
  expect(unnamed).not.toContain("create-dialog-in");
});

test("the dialog's field, Create, Cancel, and Escape reach their handlers", () => {
  const calls: string[] = [];
  const elements = elementsOf(
    CreateDialogContent({
      dialog: dialog({ draft: "Team" }),
      onConfirm: () => calls.push("confirm"),
      onCancel: () => calls.push("cancel"),
      onDraft: (text) => calls.push(`draft ${text}`),
    }),
  );
  const root = elements.find((element) => element.type === "dialog");
  const form = elements.find((element) => element.type === "form");
  const input = elements.find((element) => element.type === "input");
  const cancel = elements.find(
    (element) =>
      element.type === "button" && element.props.children === "Cancel",
  );
  input?.props.onChange?.({ currentTarget: { value: "Team G" } });
  form?.props.onSubmit?.({ preventDefault: () => undefined });
  cancel?.props.onClick?.({ currentTarget: null });
  let prevented = false;
  root?.props.onCancel?.({
    preventDefault: () => {
      prevented = true;
    },
  });
  root?.props.onClose?.();
  expect(prevented).toBe(true);
  expect(calls).toEqual([
    "draft Team G",
    "confirm",
    "cancel",
    "cancel",
    "cancel",
  ]);
});

// Opening a new workspace or project from its sentence (the Project
// Manager's decision of 2026-11-12 on #95).

const NEW_WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const NEW_PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e2";

/** The list after the main process added the new workspace, not selected. */
const WITH_NEW_WORKSPACE = workspaceState({
  workspaces: [
    { id: NEW_WORKSPACE, name: "Team Gamma" },
    { id: WORKSPACE_A, name: MARKUP_NAME },
    { id: WORKSPACE_B, name: "Team Beta" },
  ],
});

/** The projects once `workspace.project.created` listed the new one. */
const WITH_NEW_PROJECT = workspaceState({
  projects: [
    { id: PROJECT, name: "Launch Plan" },
    { id: NEW_PROJECT, name: "Roadmap" },
  ],
});

/** The sentence of a new workspace that the create did not select. */
function notSelected(place: "home" | "workspaces"): CreationView {
  return {
    ...IDLE_CREATION,
    message: {
      place,
      text: CREATE_DONE_MESSAGES.workspaceNotSelected,
      created: { kind: "workspace", workspaceId: NEW_WORKSPACE },
    },
  };
}

/** The sentence of a new project in the selected workspace. */
const NEW_PROJECT_SENTENCE: CreationView = {
  ...IDLE_CREATION,
  message: {
    place: "projects",
    text: CREATE_DONE_MESSAGES.project,
    created: {
      kind: "project",
      workspaceId: WORKSPACE_A,
      projectId: NEW_PROJECT,
    },
  },
};

function homeWith(creation: CreationControls): string {
  return renderToString(
    <HomeScreen
      signIn="none"
      start={{ running: false, message: undefined }}
      onStartSignIn={() => undefined}
      dispatch={() => undefined}
      focusAfterShow={() => undefined}
      creation={creation}
    />,
  );
}

test("Open this workspace follows the sentence of a new workspace that was not selected, described by it, in the sidebar and on the home screen", () => {
  const sidebar = renderToString(
    nav(
      controls(notSelected("workspaces"), WITH_NEW_WORKSPACE).value,
      WITH_NEW_WORKSPACE,
    ),
  );
  expect(sidebar).toContain(
    `<p class="nav-empty nav-status" id="create-status-workspaces" role="status">${CREATE_DONE_SHORT_MESSAGES.workspace}</p><div class="nav-create"><button type="button" class="panel-action" aria-describedby="create-status-workspaces">${CREATE_MESSAGES.openWorkspace}</button></div><h2 class="nav-heading" id="projects-heading" tabindex="-1">`,
  );
  expect(buttonLabels(sidebar)).not.toContain(CREATE_MESSAGES.openProject);
  expect(sidebar.split(CREATE_MESSAGES.openWorkspace)).toHaveLength(2);
  // No ID appears in the markup.
  for (const id of [NEW_WORKSPACE, WORKSPACE_A, WORKSPACE_B, PROJECT]) {
    expect(sidebar).not.toContain(id);
  }

  const home = homeWith(
    controls(notSelected("home"), WITH_NEW_WORKSPACE).value,
  );
  expect(home).toMatch(
    new RegExp(
      `<p class="account-message" id="create-status-home" role="status">${CREATE_DONE_SHORT_MESSAGES.workspace}</p><div class="account-actions"><button type="button" class="panel-action" aria-describedby="create-status-home">${CREATE_MESSAGES.openWorkspace}</button></div></section>$`,
    ),
  );
  expect(home).not.toContain(NEW_WORKSPACE);
  // Each place shows only its own sentence's button.
  expect(
    renderToString(
      nav(
        controls(notSelected("home"), WITH_NEW_WORKSPACE).value,
        WITH_NEW_WORKSPACE,
      ),
    ),
  ).not.toContain(CREATE_MESSAGES.openWorkspace);
  expect(
    homeWith(controls(notSelected("workspaces"), WITH_NEW_WORKSPACE).value),
  ).not.toContain(CREATE_MESSAGES.openWorkspace);
});

test("no Open this workspace before the list holds it, once it is selected, or after a create that selected it", () => {
  const cases: [CreationView, WorkspaceView][] = [
    [notSelected("workspaces"), workspaceState()],
    [
      notSelected("workspaces"),
      { ...WITH_NEW_WORKSPACE, selectedWorkspaceId: NEW_WORKSPACE },
    ],
    [
      {
        ...IDLE_CREATION,
        message: {
          place: "workspaces",
          text: CREATE_DONE_MESSAGES.workspaceSelected,
        },
      },
      WITH_NEW_WORKSPACE,
    ],
  ];
  for (const [view, state] of cases) {
    const html = renderToString(nav(controls(view, state).value, state));
    expect(buttonLabels(html)).not.toContain(CREATE_MESSAGES.openWorkspace);
  }
});

test("Open this project follows the sentence of a new project once the list of projects holds it, while its workspace is selected and it is not open", () => {
  const html = renderToString(
    nav(
      controls(NEW_PROJECT_SENTENCE, WITH_NEW_PROJECT).value,
      WITH_NEW_PROJECT,
    ),
  );
  expect(html).toContain(
    `New project</button></div><p class="nav-empty nav-status" id="create-status-projects" role="status">${CREATE_DONE_SHORT_MESSAGES.project}</p><div class="nav-create"><button type="button" class="panel-action" aria-describedby="create-status-projects">${CREATE_MESSAGES.openProject}</button></div></nav>`,
  );
  expect(buttonLabels(html)).not.toContain(CREATE_MESSAGES.openWorkspace);
  for (const id of [NEW_PROJECT, PROJECT, WORKSPACE_A]) {
    expect(html).not.toContain(id);
  }
  for (const state of [
    workspaceState(),
    { ...WITH_NEW_PROJECT, selectedWorkspaceId: WORKSPACE_B },
    { ...WITH_NEW_PROJECT, openProjectId: NEW_PROJECT },
  ]) {
    const other = renderToString(
      nav(controls(NEW_PROJECT_SENTENCE, state).value, state),
    );
    expect(buttonLabels(other)).not.toContain(CREATE_MESSAGES.openProject);
  }
});

test("the sentence is the long one before its button shows, the short one while the button follows it, and stays short once the button showed, with the rest of the long one as a text node of its own", () => {
  /** The status paragraph's content at `place`, rendered. */
  const status = (html: string, place: "workspaces" | "projects") =>
    new RegExp(`id="create-status-${place}" role="status">(.*?)</p>`).exec(
      html,
    )?.[1];
  const cases = [
    {
      place: "workspaces",
      view: notSelected("workspaces"),
      before: workspaceState(),
      offered: WITH_NEW_WORKSPACE,
      // The workspace leaves the list without a switch.
      after: workspaceState(),
      short: CREATE_DONE_SHORT_MESSAGES.workspace,
      long: CREATE_DONE_MESSAGES.workspaceNotSelected,
      rest: " Select it in the list of workspaces to open it.",
      label: CREATE_MESSAGES.openWorkspace,
    },
    {
      place: "projects",
      view: NEW_PROJECT_SENTENCE,
      before: workspaceState(),
      offered: WITH_NEW_PROJECT,
      // The new project is open.
      after: { ...WITH_NEW_PROJECT, openProjectId: NEW_PROJECT },
      short: CREATE_DONE_SHORT_MESSAGES.project,
      long: CREATE_DONE_MESSAGES.project,
      rest: " It shows in the list of projects once the server reports it.",
      label: CREATE_MESSAGES.openProject,
    },
  ] as const;
  for (const c of cases) {
    // The short sentence is the start of the long one.
    expect(c.long).toBe(`${c.short}${c.rest}`);
    const render = (view: CreationView, state: WorkspaceView) =>
      renderToString(nav(controls(view, state).value, state));

    const before = render(c.view, c.before);
    expect(status(before, c.place), c.place).toBe(
      `${c.short}<!-- -->${c.rest}`,
    );
    expect(buttonLabels(before)).not.toContain(c.label);

    const offered = render(c.view, c.offered);
    expect(status(offered, c.place), c.place).toBe(c.short);
    expect(buttonLabels(offered)).toContain(c.label);

    // Once the button showed, the sentence stays short after it left.
    const message = c.view.message;
    const after = render(
      {
        ...c.view,
        message:
          message === undefined ? undefined : { ...message, offered: true },
      },
      c.after,
    );
    expect(status(after, c.place), c.place).toBe(c.short);
    expect(buttonLabels(after)).not.toContain(c.label);
  }
  // The other sentences have one part, also with the mark.
  for (const text of [
    CREATE_DONE_MESSAGES.workspaceSelected,
    CREATE_DONE_MESSAGES.project,
  ]) {
    const html = renderToString(
      nav(
        controls({
          ...IDLE_CREATION,
          message: { place: "workspaces", text, offered: true },
        }).value,
      ),
    );
    expect(status(html, "workspaces")).toBe(text);
  }
});

test("each button reaches its handler, and stays focusable and does nothing while a create runs", () => {
  const cases: [CreationView, WorkspaceView, string][] = [
    [
      notSelected("workspaces"),
      WITH_NEW_WORKSPACE,
      CREATE_MESSAGES.openWorkspace,
    ],
    [NEW_PROJECT_SENTENCE, WITH_NEW_PROJECT, CREATE_MESSAGES.openProject],
  ];
  for (const [view, state, label] of cases) {
    for (const running of [false, true]) {
      const { calls, value } = controls({ ...view, running }, state);
      const buttons = elementsOf(nav(value, state)).filter(
        (element) =>
          element.type === "button" && element.props.children === label,
      );
      expect(buttons, label).toHaveLength(1);
      expect(buttons[0]?.props["aria-disabled"]).toBe(
        running ? "true" : undefined,
      );
      buttons[0]?.props.onClick?.({ currentTarget: "the button" });
      expect(calls).toEqual(running ? [] : ["open created"]);
    }
  }
  expect(
    renderToString(
      <CreatedOpenButton
        place="home"
        created={{
          kind: "workspace",
          place: "home",
          workspaceId: NEW_WORKSPACE,
        }}
        running
        onOpen={() => undefined}
        className="account-actions"
      />,
    ),
  ).toBe(
    `<div class="account-actions"><button type="button" class="panel-action" aria-describedby="create-status-home" aria-disabled="true">${CREATE_MESSAGES.openWorkspace}</button></div>`,
  );
});

test("when a button leaves its place while the focus fell to the page, the focus moves to the heading above it: the home screen's title, the Workspaces heading, or the Projects heading for Open this project", () => {
  for (const projectsHeadingShown of [true, false]) {
    expect(
      focusAfterOpenLeaves("workspaces", undefined, true, projectsHeadingShown),
    ).toBe(WORKSPACES_HEADING_ID);
    expect(
      focusAfterOpenLeaves("home", undefined, true, projectsHeadingShown),
    ).toBe(HOME_TITLE_ID);
    expect(
      focusAfterOpenLeaves("home", "workspaces", true, projectsHeadingShown),
    ).toBe(HOME_TITLE_ID);
  }
  // Open this project: the Projects heading, and the Workspaces heading
  // while the Projects heading is not on the page.
  expect(focusAfterOpenLeaves("projects", undefined, true, true)).toBe(
    PROJECTS_HEADING_ID,
  );
  expect(focusAfterOpenLeaves("projects", undefined, true, false)).toBe(
    WORKSPACES_HEADING_ID,
  );
  // Not while it stays, before it showed, or when the person moved on.
  expect(
    focusAfterOpenLeaves("workspaces", "workspaces", true, true),
  ).toBeUndefined();
  expect(
    focusAfterOpenLeaves("projects", "projects", true, true),
  ).toBeUndefined();
  expect(
    focusAfterOpenLeaves(undefined, "projects", true, true),
  ).toBeUndefined();
  expect(
    focusAfterOpenLeaves(undefined, undefined, true, true),
  ).toBeUndefined();
  expect(
    focusAfterOpenLeaves("projects", undefined, false, true),
  ).toBeUndefined();
  // Every target takes the focus without a tab stop.
  const sidebar = renderToString(nav(controls().value));
  expect(sidebar).toContain(
    `<h2 class="nav-heading" id="${WORKSPACES_HEADING_ID}" tabindex="-1">Workspaces</h2>`,
  );
  expect(sidebar).toContain(
    `<h2 class="nav-heading" id="${PROJECTS_HEADING_ID}" tabindex="-1">Projects</h2>`,
  );
  expect(sidebar).toContain(
    `<ul class="nav-list" aria-labelledby="${PROJECTS_HEADING_ID}">`,
  );
  expect(homeWith(controls().value)).toContain(
    `<h2 id="${HOME_TITLE_ID}" tabindex="-1">`,
  );
});
