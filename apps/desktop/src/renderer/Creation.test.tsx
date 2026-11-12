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
  HomeCreateWorkspace,
  type CreationControls,
} from "./Creation.tsx";
import {
  CREATE_DONE_MESSAGES,
  CREATE_MESSAGES,
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
    `</ul><p class="nav-empty nav-status" role="status"></p><div class="nav-create"><button type="button" class="panel-action">New workspace</button></div><p class="nav-empty nav-status" role="status"></p><h2 class="nav-heading" id="projects-heading">Projects</h2>`,
  );
  expect(html).toContain(
    `</ul><div class="nav-create"><button type="button" class="panel-action">New project</button></div><p class="nav-empty nav-status" role="status"></p></nav>`,
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
    `<div class="nav-create"><button type="button" class="panel-action">New workspace</button></div><p class="nav-empty nav-status" role="status">${CREATE_DONE_MESSAGES.project}</p>`,
  );
  expect(sidebar("projects")).toContain(
    `New project</button></div><p class="nav-empty nav-status" role="status">${CREATE_DONE_MESSAGES.project}</p></nav>`,
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
    /<\/form><p class="account-message" role="status"><\/p><\/section>$/,
  );
  const listed = home(workspaceState(), {
    ...IDLE_CREATION,
    message: { place: "home", text: CREATE_DONE_MESSAGES.workspaceSelected },
  });
  expect(listed).not.toContain("<form");
  expect(listed).toMatch(
    new RegExp(
      `<p class="account-message" role="status">${CREATE_DONE_MESSAGES.workspaceSelected}</p></section>$`,
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
