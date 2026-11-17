import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type {
  MountedRepository,
  ProjectRepositoriesView,
  ProjectRepositoryView,
} from "../shared/ipc-contract.ts";
import {
  PROJECT_REPOSITORIES_TITLE_ID,
  ProjectRepositoriesContent,
  ProjectRepositoryDialogContent,
  repositoryNameId,
  type ProjectRepositoryHandlers,
} from "./ProjectRepositories.tsx";
import {
  describeProjectRepositories,
  folderChoices,
  IDLE_PROJECT_REPOSITORY_ACTIONS,
  PROJECT_REPOSITORY_MESSAGES,
  PROJECT_REPOSITORY_QUESTION_MESSAGES,
  type ProjectRepositoriesModel,
  type ProjectRepositoriesPanelView,
  type ProjectRepositoryActionsView,
  type ProjectRepositoryDialog,
  type RepositoryActionRequest,
} from "./project-repositories-view.ts";
import type { RepositoryPanelView } from "./repository-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a1";
const PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a2";
const REPOSITORY_A = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b1";
const REPOSITORY_B = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b2";
const MOUNT_1 = "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b71";
const MOUNT_2 = "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b72";

const LINKED: ProjectRepositoryView = {
  repositoryId: REPOSITORY_A,
  name: "app",
  linked: true,
  mountId: MOUNT_1,
};
const PLAIN: ProjectRepositoryView = {
  repositoryId: REPOSITORY_B,
  name: "docs",
  linked: false,
  mountId: null,
};

function known(
  overrides: Partial<ProjectRepositoriesView> = {},
): ProjectRepositoriesPanelView {
  return {
    kind: "known",
    state: {
      revision: 1,
      status: "ready",
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      links: "ready",
      repositories: [LINKED, PLAIN],
      ...overrides,
    } as ProjectRepositoriesView,
  };
}

function mount(mountId: string, name: string, path: string): MountedRepository {
  return { mountId, name, path, watching: true, state: { kind: "loading" } };
}

const MOUNTS: RepositoryPanelView = {
  kind: "known",
  list: {
    revision: 1,
    repositories: [
      mount(MOUNT_1, "app", "/home/ada/app"),
      mount(MOUNT_2, "docs", "/home/ada/docs"),
    ],
  },
};

function model(
  view: ProjectRepositoriesPanelView = known(),
  mounts: RepositoryPanelView = MOUNTS,
): ProjectRepositoriesModel {
  return describeProjectRepositories(view, mounts, PROJECT);
}

/** Handlers that record each call as text. */
function recorder() {
  const calls: string[] = [];
  const handlers: ProjectRepositoryHandlers = {
    onStart: (request: RepositoryActionRequest, button: Element | null) =>
      calls.push(
        `${request.kind} ${request.projectId} ${request.repositoryId} ${request.name} ${String(button)}`,
      ),
    onChoose: (mountId) => calls.push(`choose ${mountId}`),
    onConfirm: () => calls.push("confirm"),
    onCancel: () => calls.push("cancel"),
    onRegisterDraft: (text) => calls.push(`draft ${text}`),
    onRegister: (projectId) => calls.push(`register ${projectId}`),
  };
  return { calls, handlers };
}

function render(
  shown: ProjectRepositoriesModel = model(),
  actions: ProjectRepositoryActionsView = IDLE_PROJECT_REPOSITORY_ACTIONS,
  handlers: ProjectRepositoryHandlers | undefined = recorder().handlers,
): string {
  return renderToString(
    <ProjectRepositoriesContent
      model={shown}
      actions={actions}
      handlers={handlers}
    />,
  );
}

interface HostProps {
  readonly children?: ReactNode;
  readonly id?: string;
  readonly type?: string;
  readonly checked?: boolean;
  readonly "aria-disabled"?: string;
  readonly onClick?: (event: { readonly currentTarget: unknown }) => void;
  readonly onChange?: (event: {
    readonly currentTarget: { readonly value: string };
  }) => void;
  readonly onSubmit?: (event: { readonly preventDefault: () => void }) => void;
  readonly onCancel?: (event: { readonly preventDefault: () => void }) => void;
  readonly onClose?: () => void;
}

/** The element and every element below it, with each component called. */
function elementsOf(node: ReactNode): ReactElement<HostProps>[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => elementsOf(child));
  }
  if (!isValidElement<HostProps>(node)) {
    return [];
  }
  if (typeof node.type === "function") {
    return elementsOf(
      (node.type as (props: HostProps) => ReactNode)(node.props),
    );
  }
  return [node, ...elementsOf(node.props.children)];
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child: ReactNode) => textOf(child)).join("");
  }
  return isValidElement<HostProps>(node) ? textOf(node.props.children) : "";
}

function buttons(node: ReactNode): ReactElement<HostProps>[] {
  return elementsOf(node).filter((element) => element.type === "button");
}

function content(
  shown: ProjectRepositoriesModel,
  actions: ProjectRepositoryActionsView,
  handlers: ProjectRepositoryHandlers | undefined,
): ReactNode {
  return ProjectRepositoriesContent({ model: shown, actions, handlers });
}

test("the part has its title, which takes the focus without a tab stop, its hint, and its two status paragraphs", () => {
  const html = render();
  expect(html).toContain(
    `<section class="repository-section" aria-labelledby="${PROJECT_REPOSITORIES_TITLE_ID}"><h3 class="repository-section-title" id="${PROJECT_REPOSITORIES_TITLE_ID}" tabindex="-1">In this project</h3><p class="repository-note">The repositories that this project works with.`,
  );
  expect(html).toContain(
    '<p class="repository-status" role="status"></p><p class="repository-status" id="project-repository-message" role="status"></p>',
  );
  expect(html).not.toMatch(/\sstyle=/);
});

test("each repository shows its name as text, never translated, and where it is linked on this device", () => {
  const html = render(
    model(
      known({
        repositories: [
          LINKED,
          PLAIN,
          {
            repositoryId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b3",
            name: "site",
            linked: true,
            mountId: null,
          },
          {
            repositoryId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b4",
            name: "tools",
            linked: true,
            mountId: "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b7f",
          },
        ],
      }),
    ),
  );
  expect(html).toContain(
    '<ul class="repository-list" aria-labelledby="project-repositories-title">',
  );
  expect(html).toContain(
    '<h4 class="repository-name" id="project-repository-name-0" dir="auto" translate="no">app</h4><p class="repository-state">Linked to the folder <span dir="auto" translate="no">app</span></p>',
  );
  expect(html).toContain(
    '<h4 class="repository-name" id="project-repository-name-1" dir="auto" translate="no">docs</h4><p class="repository-state">Not linked to a folder on this device.</p>',
  );
  expect(html).toContain(
    `<p class="repository-state">${PROJECT_REPOSITORY_MESSAGES.linkedNotMounted.replaceAll('"', "&quot;").replaceAll("'", "&#x27;")}</p>`,
  );
  expect(html).toContain(
    '<p class="repository-state">Linked to a folder on this device.</p>',
  );
  // The path shows only in the mount list, never in this part.
  expect(html).not.toContain("/home/ada");
  // No ID shows.
  expect(html).not.toContain(REPOSITORY_A);
  expect(html).not.toContain(MOUNT_1);
});

test("a ready list offers Link to a folder, Unlink on a linked repository, and Remove from the project, each described by the repository's name", () => {
  const html = render();
  expect(html).toContain(
    '<div class="account-actions"><button type="button" class="panel-action" aria-describedby="project-repository-name-0">Link to a folder</button><button type="button" class="panel-action" aria-describedby="project-repository-name-0">Unlink</button><button type="button" class="panel-action" aria-describedby="project-repository-name-0">Remove from the project</button></div>',
  );
  expect(html).toContain(
    '<div class="account-actions"><button type="button" class="panel-action" aria-describedby="project-repository-name-1">Link to a folder</button><button type="button" class="panel-action" aria-describedby="project-repository-name-1">Remove from the project</button></div>',
  );
  expect(repositoryNameId(3)).toBe("project-repository-name-3");
});

test("each button starts its action with the shown project, the repository, and the button", () => {
  const { calls, handlers } = recorder();
  const found = buttons(
    content(model(), IDLE_PROJECT_REPOSITORY_ACTIONS, handlers),
  );
  for (const button of found) {
    button.props.onClick?.({
      currentTarget: `[${textOf(button.props.children)}]`,
    });
  }
  expect(calls).toEqual([
    `link ${PROJECT} ${REPOSITORY_A} app [Link to a folder]`,
    `unlink ${PROJECT} ${REPOSITORY_A} app [Unlink]`,
    `remove ${PROJECT} ${REPOSITORY_A} app [Remove from the project]`,
    `link ${PROJECT} ${REPOSITORY_B} docs [Link to a folder]`,
    `remove ${PROJECT} ${REPOSITORY_B} docs [Remove from the project]`,
  ]);
});

test("while an action runs, every button stays focusable and does nothing, and the field is read-only", () => {
  const running = { ...IDLE_PROJECT_REPOSITORY_ACTIONS, running: true };
  const { calls, handlers } = recorder();
  const tree = content(model(), running, handlers);
  const found = buttons(tree);
  expect(found.length).toBe(6);
  for (const button of found) {
    expect(button.props["aria-disabled"]).toBe("true");
    expect(button.props.onClick).toBeUndefined();
  }
  const form = elementsOf(tree).find((element) => element.type === "form");
  form?.props.onSubmit?.({ preventDefault: () => undefined });
  expect(calls).toEqual([]);
  const html = render(model(), running, handlers);
  expect(html).not.toMatch(/\sdisabled=/);
  expect(html).toContain('spellCheck="false" readOnly=""');
});

test("the registration form: its title, the labelled field with its hint and its alert, and Register", () => {
  const html = render();
  expect(html).toContain(
    '<form class="repository-register" aria-labelledby="project-repository-register-title"><h4 id="project-repository-register-title">Register a repository</h4><label class="account-label" for="project-repository-field">Name</label><input id="project-repository-field" class="account-input" type="text" dir="auto" autoComplete="off" spellCheck="false" aria-describedby="project-repository-hint project-repository-problem" value=""/><p class="repository-note" id="project-repository-hint">Everyone in the workspace sees this name. It cannot contain a slash or a backslash, so that no folder&#x27;s path or address is sent as a name.</p><p class="panel-message" id="project-repository-problem" role="alert"></p><div class="account-actions"><button type="submit" class="panel-action">Register</button></div></form>',
  );
  // A name that was not sent shows its problem in the alert.
  const problem = render(model(), {
    ...IDLE_PROJECT_REPOSITORY_ACTIONS,
    registerDraft: "C:\\app",
    registerProblem: PROJECT_REPOSITORY_MESSAGES.nameSlash,
  });
  expect(problem).toContain('aria-invalid="true"');
  expect(problem).toContain('value="C:\\app"');
  expect(problem).toContain(
    '<p class="panel-message" id="project-repository-problem" role="alert">A name cannot contain a slash (/) or a backslash (\\).</p>',
  );
});

test("the form sends the draft's edits and registers in the shown project", () => {
  const { calls, handlers } = recorder();
  const tree = content(model(), IDLE_PROJECT_REPOSITORY_ACTIONS, handlers);
  const elements = elementsOf(tree);
  elements
    .find((element) => element.props.id === "project-repository-field")
    ?.props.onChange?.({ currentTarget: { value: "site" } });
  let prevented = false;
  elements
    .find((element) => element.type === "form")
    ?.props.onSubmit?.({
      preventDefault: () => {
        prevented = true;
      },
    });
  expect(prevented).toBe(true);
  expect(calls).toEqual(["draft site", `register ${PROJECT}`]);
});

test("the sentence of the last action shows in its own status paragraph", () => {
  const html = render(model(), {
    ...IDLE_PROJECT_REPOSITORY_ACTIONS,
    message: "The repository was removed from the project.",
  });
  expect(html).toContain(
    '<p class="repository-status" id="project-repository-message" role="status">The repository was removed from the project.</p>',
  );
});

test("while the links are not ready, a note says why, no link shows, and only removing and registering are offered", () => {
  const html = render(model(known({ links: "loading" })));
  expect(html).toContain(
    '<p class="repository-note">Reading the links to folders on this device.</p>',
  );
  expect(html).not.toContain("Linked to");
  expect(html).not.toContain("Not linked");
  expect(html).not.toContain("Link to a folder");
  expect(html).not.toContain(">Unlink<");
  expect(html.match(/Remove from the project/g)).toHaveLength(2);
  expect(html).toContain("Register a repository");
});

test("without the mount list, Link to a folder is not offered", () => {
  const html = render(model(known(), { kind: "pending" }));
  expect(html).not.toContain("Link to a folder");
  expect(html).toContain(">Unlink<");
  // A linked folder that the mount list does not name yet.
  expect(html).toContain("Linked to a folder on this device.");
});

test("an unavailable list shows its problem and what was loaded, without actions or the form", () => {
  const html = render(
    model(known({ status: "unavailable", problem: "unavailable" })),
  );
  expect(html).toContain(
    '<p class="repository-status" role="status">The server could not be reached. Trying again later.</p>',
  );
  expect(html).toContain(">app</h4>");
  expect(html).not.toContain("<button");
  expect(html).not.toContain("<form");
});

test("each fixed state shows its text alone", () => {
  for (const [view, text] of [
    [
      { kind: "unavailable" },
      "The project&#x27;s repositories are not available.",
    ],
    [{ kind: "pending" }, "Checking the project&#x27;s repositories."],
    [
      known({ status: "loading", repositories: [] }),
      "Loading the project&#x27;s repositories.",
    ],
    [
      known({ repositories: [] }),
      "No repositories are registered in this project yet.",
    ],
  ] as const) {
    const html = render(model(view));
    expect(html, text).toContain(
      `<p class="repository-status" role="status">${text}</p>`,
    );
    expect(html, text).not.toContain("<ul");
  }
});

test("without the bridge, nothing is offered and the action's paragraph is missing", () => {
  const html = renderToString(
    <ProjectRepositoriesContent
      model={model()}
      actions={IDLE_PROJECT_REPOSITORY_ACTIONS}
      handlers={undefined}
    />,
  );
  expect(html).toContain(">app</h4>");
  expect(html).not.toContain("<button");
  expect(html).not.toContain("<form");
  expect(html).not.toContain("project-repository-message");
});

test("names are rendered as text, not as markup", () => {
  const html = render(
    model(
      known({
        repositories: [{ ...PLAIN, name: '<img src="x"><script>x</script>' }],
      }),
    ),
  );
  expect(html).not.toMatch(/<(?:img|script)[\s>]/);
  expect(html).toContain(
    "&lt;img src=&quot;x&quot;&gt;&lt;script&gt;x&lt;/script&gt;",
  );
});

test("the element IDs of the part are unique", () => {
  const ids = [...render().matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id);
  expect(new Set(ids).size).toBe(ids.length);
});

// The dialog.

function dialogHtml(dialog: ProjectRepositoryDialog | undefined): string {
  return renderToString(
    <ProjectRepositoryDialogContent
      dialog={dialog}
      onChoose={() => undefined}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />,
  );
}

const REMOVE: ProjectRepositoryDialog = {
  kind: "remove",
  request: {
    kind: "remove",
    projectId: PROJECT,
    repositoryId: REPOSITORY_A,
    name: "app",
  },
};

function linkDialog(
  overrides: Partial<Extract<ProjectRepositoryDialog, { kind: "link" }>> = {},
): ProjectRepositoryDialog {
  return {
    kind: "link",
    request: {
      kind: "link",
      projectId: PROJECT,
      repositoryId: REPOSITORY_A,
      name: "app",
    },
    choices: folderChoices(model(), REPOSITORY_A),
    mountId: MOUNT_1,
    problem: undefined,
    ...overrides,
  };
}

test("without a question, the dialog stays in the page, empty", () => {
  expect(dialogHtml(undefined)).toBe('<dialog class="people-dialog"></dialog>');
});

test("a removal asks first: its title, the repository's name as text that describes the dialog, what follows, Cancel first", () => {
  expect(dialogHtml(REMOVE)).toBe(
    `<dialog class="people-dialog" aria-labelledby="project-repository-dialog-title" aria-describedby="project-repository-dialog-name project-repository-dialog-text"><form><h2 id="project-repository-dialog-title">Remove this repository from the project?</h2><p class="people-dialog-name" id="project-repository-dialog-name" dir="auto" translate="no">app</p><p id="project-repository-dialog-text">${PROJECT_REPOSITORY_QUESTION_MESSAGES.removeText}</p><div class="people-dialog-actions"><button type="button" class="panel-action">Cancel</button><button type="submit" class="panel-action">Remove from the project</button></div></form></dialog>`,
  );
});

test("a link offers the folders with their names and paths, never translated, the chosen one checked, and says that the main process asks again", () => {
  const html = dialogHtml(linkDialog());
  expect(html).toContain(
    '<h2 id="project-repository-dialog-title">Link this repository to a folder?</h2>',
  );
  expect(html).toContain(
    `<p id="project-repository-dialog-text">${PROJECT_REPOSITORY_QUESTION_MESSAGES.linkText.replaceAll("'", "&#x27;")}</p>`,
  );
  expect(html).toContain(
    '<fieldset class="repository-choice" aria-describedby="project-repository-dialog-problem"><legend>Folder</legend><label class="repository-option"><input type="radio" name="project-repository-folder" checked=""/><span><span dir="auto" translate="no">app</span><code class="repository-option-path" dir="ltr" translate="no">/home/ada/app</code></span></label><label class="repository-option"><input type="radio" name="project-repository-folder"/><span><span dir="auto" translate="no">docs</span><code class="repository-option-path" dir="ltr" translate="no">/home/ada/docs</code></span></label></fieldset><p class="panel-message" id="project-repository-dialog-problem" role="alert"></p><div class="people-dialog-actions"><button type="button" class="panel-action">Cancel</button><button type="submit" class="panel-action">Continue</button></div>',
  );
  expect(
    dialogHtml(linkDialog({ mountId: null, problem: "Choose a folder." })),
  ).toContain(
    '<p class="panel-message" id="project-repository-dialog-problem" role="alert">Choose a folder.</p>',
  );
});

test("a link with no folder to choose says why and offers only Cancel", () => {
  const html = dialogHtml(linkDialog({ choices: [], mountId: null }));
  expect(html).toContain(
    `<p>${PROJECT_REPOSITORY_QUESTION_MESSAGES.linkNone.replaceAll('"', "&quot;").replaceAll("'", "&#x27;")}</p><div class="people-dialog-actions"><button type="button" class="panel-action">Cancel</button></div>`,
  );
  expect(html).not.toContain("<fieldset");
  expect(html).not.toContain(">Continue<");
});

test("the dialog's controls: a choice chooses, the form confirms, Cancel, Escape, and a close by the browser cancel", () => {
  const calls: string[] = [];
  const tree = ProjectRepositoryDialogContent({
    dialog: linkDialog(),
    onChoose: (mountId) => calls.push(`choose ${mountId}`),
    onConfirm: () => calls.push("confirm"),
    onCancel: () => calls.push("cancel"),
  });
  const elements = elementsOf(tree);
  const radios = elements.filter((element) => element.type === "input");
  radios[1]?.props.onChange?.({ currentTarget: { value: "" } });
  elements
    .find((element) => element.type === "form")
    ?.props.onSubmit?.({ preventDefault: () => undefined });
  buttons(tree)[0]?.props.onClick?.({ currentTarget: null });
  let prevented = false;
  const dialog = elements.find((element) => element.type === "dialog");
  dialog?.props.onCancel?.({
    preventDefault: () => {
      prevented = true;
    },
  });
  dialog?.props.onClose?.();
  expect(calls).toEqual([
    `choose ${MOUNT_2}`,
    "confirm",
    "cancel",
    "cancel",
    "cancel",
  ]);
  expect(prevented).toBe(true);
});

test("the dialog renders the repository's name and the folders as text, not as markup", () => {
  const html = dialogHtml(
    linkDialog({
      request: { ...REMOVE.request, kind: "link", name: "<b>app</b>" },
      choices: [{ mountId: MOUNT_1, name: "<i>x</i>", path: "/tmp/<script>" }],
    }),
  );
  expect(html).not.toMatch(/<(?:b|i|script)>/);
  expect(html).toContain("&lt;b&gt;app&lt;/b&gt;");
  expect(html).toContain("/tmp/&lt;script&gt;");
});

// The hook's wiring, which needs a DOM to run.

const SOURCES = import.meta.glob<string>(["./ProjectRepositories.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** `source` without its comments, with every run of white space as one space and no space or comma inside a call's brackets. */
function wiringOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/,? \)/g, ")");
}

test("the hook follows every model, keeps the focus after a question and after an action whose button left (#274), and remembers no button for a registration", () => {
  const code = wiringOf(SOURCES["./ProjectRepositories.tsx"] ?? "");
  expect(code).toContain(
    "useEffect(() => controller?.follow(model), [controller, model]);",
  );
  expect(code).toContain(
    "const model = useMemo(() => describeProjectRepositories(view, mounts, projectId), [view, mounts, projectId]);",
  );
  expect(code).toContain(
    "if (focusesTitleAfterClose(wasOpen.current, open, button !== null && !button.isConnected)) { focusTitle(); } wasOpen.current = open; }, [open]);",
  );
  expect(code).toContain(
    "useEffect(() => rememberRunningButton(acted, running, trigger.current), [running]);",
  );
  expect(code).toContain(
    "useEffect(() => { if (decideFocusAfterLeave(acted, open, running, document.activeElement, document.body)) { focusTitle(); } }, [model, running, open]);",
  );
  expect(code).toContain(
    "onStart: (request, button) => { trigger.current = button; void controller.start(request); },",
  );
  expect(code).toContain(
    "onRegister: (projectId) => { trigger.current = null; void controller.register(projectId); },",
  );
  expect(code).toContain(
    "useEffect(() => syncModal(dialogRef.current, open), [open]);",
  );
});
