import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type {
  AccountBridge,
  AgentBridge,
  ChatBridge,
  ConnectionBridge,
  DeviceListBridge,
  InvitationActionsBridge,
  InvitationsBridge,
  PeopleActionsBridge,
  PeopleBridge,
  RepositoryBridge,
  RuntimeBridge,
  WorkspaceBridge,
} from "../shared/desktop-bridge.ts";
import {
  API_ORIGIN_STATES,
  DEVICE_KEY_STATES,
  DEVICE_STATES,
  type AccountStatus,
  type RemoveDeviceResult,
  type WorkspaceView,
} from "../shared/ipc-contract.ts";
import {
  App,
  ConnectionStatusIndicator,
  RuntimeStatusIndicator,
  type AppProps,
} from "./App.tsx";
import { AccountPanelContent } from "./AccountPanel.tsx";
import {
  ACTION_MESSAGES,
  canStartSignIn,
  DEVICE_ACTION_FAILURE_MESSAGES,
  DEVICE_ACTION_MESSAGES,
  signInEndFormat,
  signInTimeFormat,
  START_REFUSAL_MESSAGES,
  type AccountView,
} from "./account-view.ts";
import {
  createDeviceRemoval,
  describeConnectionView,
  focusesStatus,
  IDLE_DEVICE_REMOVAL,
  OFFLINE_SIGN_IN_DETAIL,
  REGISTER_AGAIN_MESSAGE,
  REMOVAL_NOT_DONE,
  REMOVAL_PENDING_MESSAGE,
  type ConnectionAction,
  type ConnectionView,
  type DeviceRemovalView,
} from "./connection-status.ts";
import { WorkspaceNav } from "./Navigation.tsx";
import {
  createShellState,
  type ProjectSummary,
  type ShellView,
} from "./screens.ts";
import {
  HOME_SIGN_IN_MESSAGES,
  homeSignIn,
  IDLE_HOME_SIGN_IN_START,
  SELECT_REFUSAL_MESSAGES,
  WORKSPACE_MESSAGES,
  WORKSPACE_PROBLEM_MESSAGES,
  type HomeSignIn,
  type HomeSignInStartView,
} from "./workspace-view.ts";
import { HomeScreen } from "./WorkspaceScreens.tsx";

const runtime: RuntimeBridge = {
  getStatus: () => Promise.resolve({ state: "running", revision: 2 }),
  subscribeStatus: () => () => undefined,
};

const PROJECTS: readonly ProjectSummary[] = [
  { id: "project-a", name: "Project A" },
  { id: "project-b", name: "Project B" },
];

const WORKSPACES: WorkspaceView["workspaces"] = [
  { id: "workspace-a", name: "Workspace A" },
  { id: "workspace-b", name: "Workspace B" },
];

/** A ready workspace state with workspace B selected and these projects. */
function workspaceState(
  projects: readonly ProjectSummary[],
  overrides: Partial<WorkspaceView> = {},
): WorkspaceView {
  return {
    revision: 1,
    status: "ready",
    workspaces: WORKSPACES,
    selectedWorkspaceId: "workspace-b",
    projects,
    openProjectId: null,
    ...overrides,
  } as WorkspaceView;
}

function render(props: Partial<AppProps> = {}): string {
  return renderToString(
    <App initialWorkspaceState={workspaceState(PROJECTS)} {...props} />,
  );
}

/** The buttons marked with aria-current, as "label (value)". */
function currentItems(html: string): string[] {
  return [
    ...html.matchAll(
      /<button[^>]*\saria-current="([^"]+)"[^>]*>([^<]*)<\/button>/g,
    ),
  ].map(([, value, label]) => `${label} (${value})`);
}

function attributeValues(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map(
    ([, value]) => value ?? "",
  );
}

interface ScreenCase {
  readonly view: ShellView;
  readonly title: string;
  readonly placeholder: string;
  readonly current: readonly string[];
}

const SCREEN_CASES: readonly ScreenCase[] = [
  {
    view: { screen: "home" },
    title: '<h2 id="home-title" tabindex="-1">Home</h2>',
    placeholder: "Open a project to see its chat",
    current: ["Home (page)", "Workspace B (true)"],
  },
  {
    view: { screen: "account" },
    title: '<h2 id="account-screen-title" tabindex="-1">Account</h2>',
    placeholder: "<p>Sign-in is not available.</p>",
    current: ["Account (page)", "Workspace B (true)"],
  },
  {
    view: { screen: "people" },
    title: '<h2 id="people-title" tabindex="-1">People</h2>',
    placeholder: "People are not available.",
    current: ["People (page)", "Workspace B (true)"],
  },
  {
    view: { screen: "join" },
    title: '<h2 id="join-title" tabindex="-1">Join a workspace</h2>',
    placeholder: "Joining with an invitation code is not available.",
    current: ["Join (page)", "Workspace B (true)"],
  },
  {
    view: { screen: "about" },
    title: '<h2 id="about-title">About</h2>',
    placeholder: "Electron 44.9.0",
    current: ["About (page)", "Workspace B (true)"],
  },
  {
    view: { screen: "chat", projectId: "project-b", panel: "agents" },
    title: '<h2 id="chat-title">Chat</h2>',
    placeholder: "The chat is not available.",
    current: ["Workspace B (true)", "Project B (true)", "Chat (page)"],
  },
  {
    view: { screen: "tasks", projectId: "project-a", panel: "agents" },
    title: '<h2 id="tasks-title">Tasks</h2>',
    placeholder: "No tasks yet.",
    current: ["Workspace B (true)", "Project A (true)", "Tasks (page)"],
  },
  {
    view: { screen: "decisions", projectId: "project-a", panel: "agents" },
    title: '<h2 id="decisions-title">Decisions</h2>',
    placeholder: "No decisions yet.",
    current: ["Workspace B (true)", "Project A (true)", "Decisions (page)"],
  },
  {
    view: { screen: "permissions", projectId: "project-b", panel: "agents" },
    title: '<h2 id="permissions-title">Permissions</h2>',
    placeholder: "Not available yet.",
    current: ["Workspace B (true)", "Project B (true)", "Permissions (page)"],
  },
];

test.each(SCREEN_CASES)(
  "the $view.screen screen renders its placeholder, the landmarks, and the marked navigation item",
  ({ view, title, placeholder, current }) => {
    const html = render({ initialView: view, electronVersion: "44.9.0" });

    expect(html).toContain(title);
    expect(html).toContain(placeholder);
    expect(currentItems(html)).toEqual(current);

    expect(html).toContain("<h1>MyManDev AI Workspace</h1>");
    expect(html).toContain('<header class="shell-header">');
    expect(html).toContain('<nav class="shell-nav" aria-label="Workspace">');
    expect(html.match(/<main class="shell-main">/g)).toHaveLength(1);
    expect(html).toContain("Local runtime: Unavailable");

    const isProject = "projectId" in view;
    expect(
      html.includes('<nav class="project-nav" aria-label="Project">'),
    ).toBe(isProject);
    expect(html.includes("<aside")).toBe(isProject);
    expect(html.includes('class="shell shell-project"')).toBe(isProject);

    // Every id is unique, and every reference points to one of them.
    const ids = attributeValues(html, "id");
    expect(new Set(ids).size).toBe(ids.length);
    for (const reference of [
      ...attributeValues(html, "aria-labelledby"),
      ...attributeValues(html, "aria-describedby"),
      ...attributeValues(html, "aria-controls"),
      ...attributeValues(html, "for"),
    ].flatMap((value) => value.split(" "))) {
      expect(ids).toContain(reference);
    }

    // The question before a switch waits in the page, closed and empty.
    expect(html).toContain('<dialog class="switch-question"></dialog>');

    // The Content Security Policy allows no inline styles.
    expect(html).not.toMatch(/\sstyle=/);
  },
);

test("the sidebar lists the workspace screens, every workspace with the selected one marked, and every project", () => {
  const html = render();

  expect(html).toMatch(
    /<button type="button" class="nav-item">About<\/button>/,
  );
  expect(html).toContain(
    '<h2 class="nav-heading" id="workspaces-heading" tabindex="-1">',
  );
  expect(html).toContain(
    '<ul class="nav-list" aria-labelledby="workspaces-heading"><li><button type="button" class="nav-item" dir="auto">Workspace A</button></li><li><button type="button" class="nav-item" dir="auto" aria-current="true">Workspace B</button></li></ul>',
  );
  expect(html).toContain(
    '<h2 class="nav-heading" id="projects-heading" tabindex="-1">',
  );
  expect(html).toContain(
    '<ul class="nav-list" aria-labelledby="projects-heading">',
  );
  for (const project of PROJECTS) {
    expect(html).toContain(
      `<button type="button" class="nav-item" dir="auto">${project.name}</button>`,
    );
  }
});

test("the project navigation names the open project and reaches tasks and decisions", () => {
  const html = render({
    initialView: { screen: "chat", projectId: "project-a", panel: "agents" },
  });

  expect(html).toContain(
    '<p class="project-nav-name" dir="auto">Project A</p>',
  );
  for (const label of ["Tasks", "Decisions", "Permissions"]) {
    expect(html).toContain(
      `<button type="button" class="nav-item">${label}</button>`,
    );
  }
});

test("without the bridge, the chat is not available and its composer is disabled", () => {
  const html = render({
    initialView: { screen: "chat", projectId: "project-a", panel: "agents" },
  });

  expect(html).toContain(
    '<section class="chat" aria-labelledby="chat-title"><h2 id="chat-title">Chat</h2><p class="chat-status" role="status">The chat is not available.</p>',
  );
  expect(html).not.toContain("<ol");
  expect(html).toContain('<form class="composer" aria-label="New message">');
  expect(html).toContain(
    '<label class="composer-label" for="composer-text">Message</label>',
  );
  expect(html).toContain(
    '<textarea id="composer-text" class="composer-text" rows="3" dir="auto" disabled="" aria-describedby="composer-hint composer-status"></textarea>',
  );
  expect(html).toContain(
    '<button type="submit" class="composer-send" disabled="">Send</button>',
  );
});

test("with the bridge, the chat waits for the first state", () => {
  const chat: ChatBridge = {
    getState: () => new Promise(() => undefined),
    subscribeState: () => () => undefined,
    send: () => new Promise(() => undefined),
    retry: () => Promise.resolve(false),
    discard: () => Promise.resolve(false),
    loadOlder: () => Promise.resolve("none"),
  };
  const html = render({
    chat,
    initialView: { screen: "chat", projectId: "project-a", panel: "agents" },
  });

  expect(html).toContain(
    '<p class="chat-status" role="status">Checking the chat.</p>',
  );
  expect(html).toContain('disabled=""');
});

function tab(label: string, selected: boolean): string {
  return `<button type="button" role="tab" id="panel-tab-${label.toLowerCase()}" class="panel-tab" aria-selected="${selected}" aria-controls="panel-content" tabindex="${selected ? 0 : -1}">${label}</button>`;
}

test("the side panel shows the agents or the repositories, chosen with tabs of which only the selected one is in the tab order", () => {
  const agents = render({
    initialView: { screen: "chat", projectId: "project-a", panel: "agents" },
  });
  const repositories = render({
    initialView: {
      screen: "tasks",
      projectId: "project-a",
      panel: "repositories",
    },
  });

  expect(agents).toContain(
    '<aside class="project-panel" aria-labelledby="panel-title"><div class="panel-tabs" role="tablist" aria-label="Side panel">' +
      tab("Agents", true) +
      tab("Repositories", false) +
      '</div><div class="panel-content" role="tabpanel" id="panel-content" aria-labelledby="panel-tab-agents" tabindex="0"><h2 id="panel-title">Agents</h2><p class="agent-status" role="status">Agents are not available.</p></div>',
  );
  expect(repositories).toContain(
    '<div class="panel-tabs" role="tablist" aria-label="Side panel">' +
      tab("Agents", false) +
      tab("Repositories", true) +
      '</div><div class="panel-content" role="tabpanel" id="panel-content" aria-labelledby="panel-tab-repositories" tabindex="0"><h2 id="panel-title">Repositories</h2><p>Repositories are not available.</p>',
  );
});

test("with the bridge, the agent panel waits for the first agent activity", () => {
  const agents: AgentBridge = {
    getState: () => Promise.reject(new Error("not called")),
    subscribeState: () => () => undefined,
  };
  const html = render({
    agents,
    initialView: { screen: "chat", projectId: "project-a", panel: "agents" },
  });

  // The agent panel is the content of the agents tab.
  expect(html).toContain(
    '<div class="panel-content" role="tabpanel" id="panel-content" aria-labelledby="panel-tab-agents" tabindex="0"><h2 id="panel-title">Agents</h2><p class="agent-status" role="status">Checking the agents.</p></div>',
  );
  expect(html).not.toContain("Agents are not available.");
});

test("with the bridge, the people screen waits for the first people", () => {
  const people: PeopleBridge = {
    getState: () => Promise.reject(new Error("not called")),
    subscribeState: () => () => undefined,
  };
  const html = render({ people, initialView: { screen: "people" } });

  expect(html).toContain(
    '<main class="shell-main"><section aria-labelledby="people-title"><h2 id="people-title" tabindex="-1">People</h2><p class="people-status" role="status">Checking the people.</p>',
  );
  expect(html).not.toContain("People are not available.");
  // Only the people screen follows the people.
  expect(render({ people })).not.toContain("people-status");
});

test("the people screen gets the people actions: with them, it has the paragraph of their sentence and the dialog", () => {
  const people: PeopleBridge = {
    getState: () => Promise.reject(new Error("not called")),
    subscribeState: () => () => undefined,
  };
  const call = () => Promise.reject(new Error("not called"));
  const peopleActions: PeopleActionsBridge = {
    define: call,
    rename: call,
    remove: call,
    promote: call,
    demote: call,
    leave: call,
    offerOwnership: call,
    withdrawOwnershipOffer: call,
    acceptOwnershipOffer: call,
  };
  const html = render({
    people,
    peopleActions,
    initialView: { screen: "people" },
  });
  expect(html).toContain(
    '<p class="people-status" id="people-action-message" role="status"></p>',
  );
  expect(html).toContain('<dialog class="people-dialog"></dialog>');
  expect(render({ people, initialView: { screen: "people" } })).not.toContain(
    "people-action-message",
  );
});

test("the join screen gets the invitation actions and the workspace state: with them, it offers the code field, its status paragraph, and the dialog", () => {
  const call = () => Promise.reject(new Error("not called"));
  const invitationActions: InvitationActionsBridge = {
    create: call,
    revoke: call,
    preview: call,
    accept: call,
  };
  const html = render({ invitationActions, initialView: { screen: "join" } });
  expect(html).toContain(
    '<label class="account-label" for="join-code">Invitation code</label>',
  );
  expect(html).toContain(
    '<p class="people-status" id="join-message" role="status"></p>',
  );
  expect(html).toContain('<dialog class="people-dialog"></dialog>');
  expect(html).not.toContain(
    "Joining with an invitation code is not available.",
  );
  // While the workspace state is signed_out, the screen asks for a sign-in.
  expect(
    render({
      invitationActions,
      initialView: { screen: "join" },
      initialWorkspaceState: workspaceState([], {
        status: "signed_out",
        workspaces: [],
        selectedWorkspaceId: null,
      }),
    }),
  ).toContain(
    "<p>You can join a workspace once this device is signed in and ready.</p>",
  );
  // Only the join screen uses them.
  expect(render({ invitationActions })).not.toContain("join-code");
});

test("the people screen gets the invitations: with both bridges, it has the paragraph of their sentence and the two dialogs, and reads nothing while rendered", () => {
  const people: PeopleBridge = {
    getState: () => Promise.reject(new Error("not called")),
    subscribeState: () => () => undefined,
  };
  const calls: string[] = [];
  const call = (name: string) => () => {
    calls.push(name);
    return Promise.reject(new Error("not called"));
  };
  const invitations: InvitationsBridge = {
    getState: call("getState"),
    subscribeState: () => {
      calls.push("subscribeState");
      return () => undefined;
    },
    load: call("load"),
  };
  const invitationActions: InvitationActionsBridge = {
    create: call("create"),
    revoke: call("revoke"),
    preview: call("preview"),
    accept: call("accept"),
  };
  const html = render({
    people,
    invitations,
    invitationActions,
    initialView: { screen: "people" },
  });
  expect(html).toContain(
    '<p class="people-status" id="invitation-action-message" role="status"></p>',
  );
  expect(html.match(/<dialog class="people-dialog"><\/dialog>/g)).toHaveLength(
    2,
  );
  // The subscription and the load run in an effect, which a server render
  // does not run; nothing else is called.
  expect(calls).toEqual([]);
  // Without the actions, or on another screen, nothing of it shows.
  expect(
    render({ people, invitations, initialView: { screen: "people" } }),
  ).not.toContain("invitation-action-message");
  expect(render({ people, invitations, invitationActions })).not.toContain(
    "invitation-action-message",
  );
});

test("with the bridge, the repository panel waits for the first list and offers to add a repository", () => {
  const repositories: RepositoryBridge = {
    list: () => Promise.resolve({ revision: 0, repositories: [] }),
    subscribe: () => () => undefined,
    mount: () => Promise.resolve({ outcome: "cancelled" }),
    unmount: () => Promise.resolve(false),
  };
  const html = render({
    repositories,
    initialView: {
      screen: "chat",
      projectId: "project-a",
      panel: "repositories",
    },
  });

  // The repository panel is the content of the repositories tab.
  expect(html).toContain(
    '<div class="panel-content" role="tabpanel" id="panel-content" aria-labelledby="panel-tab-repositories" tabindex="0"><h2 id="panel-title">Repositories</h2><button type="button" class="panel-action" disabled="">Add a repository</button><p>Reading the repositories.</p>',
  );
  expect(html).not.toContain("Repositories are not available.");
});

test("the permission screen shell has a placeholder section for every capability of ADR 0015", () => {
  const html = render({
    initialView: {
      screen: "permissions",
      projectId: "project-a",
      panel: "agents",
    },
  });

  for (const title of [
    "Agent",
    "Repository files",
    "Git",
    "Terminal",
    "AI provider",
    "Granted permissions",
  ]) {
    expect(html).toContain(
      `<section class="permission-section"><h3>${title}</h3>`,
    );
  }
  for (const capability of [
    "repo.read",
    "repo.write",
    "terminal.execute",
    "git.commit",
    "git.push",
    "provider.use",
  ]) {
    expect(
      html.match(new RegExp(`<code>${capability}</code>`, "g")),
    ).toHaveLength(1);
  }
  // One labelled region for the screen; the subsections add none.
  expect(html.match(/<section class="permission-section">/g)).toHaveLength(6);
  expect(html.match(/<section [^>]*aria-label/g)).toEqual([
    "<section aria-label",
  ]);
  expect(html).toContain('<section aria-labelledby="permissions-title">');
});

test("workspace and project names are rendered as text, not as markup", () => {
  const html = renderToString(
    <App
      initialWorkspaceState={workspaceState(
        [{ id: "x", name: '<img src="x">' }],
        {
          workspaces: [{ id: "w", name: "<b>Workspace</b>" }],
          selectedWorkspaceId: "w",
        },
      )}
      initialView={{ screen: "chat", projectId: "x", panel: "agents" }}
    />,
  );

  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
  expect(html).toContain(
    '<button type="button" class="nav-item" dir="auto" aria-current="true">&lt;b&gt;Workspace&lt;/b&gt;</button>',
  );
  expect(html).toContain(
    '<button type="button" class="nav-item" dir="auto" aria-current="true">&lt;img src=&quot;x&quot;&gt;</button>',
  );
  expect(html).toContain(
    '<p class="project-nav-name" dir="auto">&lt;img src=&quot;x&quot;&gt;</p>',
  );
});

test("a workspace without projects says so, and the shell shows the home screen", () => {
  const html = render({
    initialWorkspaceState: workspaceState([]),
    initialView: { screen: "chat", projectId: "project-a", panel: "agents" },
  });

  expect(html).toContain(
    `<h2 class="nav-heading" id="projects-heading" tabindex="-1">Projects</h2><p class="nav-empty">${WORKSPACE_MESSAGES.noProjects}</p></nav>`,
  );
  expect(html).not.toContain('aria-labelledby="projects-heading"');
  expect(html).toContain('<h2 id="home-title" tabindex="-1">Home</h2>');
  expect(currentItems(html)).toEqual(["Home (page)", "Workspace B (true)"]);
});

/** The text as `renderToString` escapes it. */
function escaped(text: string): string {
  return text.replaceAll("'", "&#x27;");
}

/** The sidebar after the workspace screens. */
function workspacePart(props: Partial<AppProps>): string {
  const html = render(props);
  const start = html.indexOf(
    '<h2 class="nav-heading" id="workspaces-heading" tabindex="-1">',
  );
  return html.slice(start, html.indexOf("</nav>", start));
}

const WORKSPACES_HEADING =
  '<h2 class="nav-heading" id="workspaces-heading" tabindex="-1">Workspaces</h2>';

const pendingBridge: WorkspaceBridge = {
  getState: () => new Promise(() => undefined),
  subscribeState: () => () => undefined,
  select: () => Promise.resolve({ outcome: "ok" }),
  openProject: () => Promise.resolve({ outcome: "ok" }),
  create: () => new Promise(() => undefined),
  createProject: () => new Promise(() => undefined),
};

/** The always present live region of the workspaces, with this text. */
function statusParagraph(text = ""): string {
  return `<p class="nav-empty nav-status" role="status">${escaped(text)}</p>`;
}

test("each workspace state has its own fixed text in the sidebar, and no ID is shown", () => {
  const cases: [Partial<AppProps>, string][] = [
    [
      { initialWorkspaceState: undefined },
      `<p class="nav-empty">${WORKSPACE_MESSAGES.unavailable}</p>`,
    ],
    [
      { initialWorkspaceState: undefined, workspaces: pendingBridge },
      `<p class="nav-empty">${WORKSPACE_MESSAGES.pending}</p>`,
    ],
    [
      {
        initialWorkspaceState: workspaceState([], {
          status: "signed_out",
          workspaces: [],
          selectedWorkspaceId: null,
        }),
      },
      `<p class="nav-empty">${WORKSPACE_MESSAGES.signedOut}</p>`,
    ],
    [
      {
        initialWorkspaceState: workspaceState([], {
          status: "loading",
          workspaces: [],
          selectedWorkspaceId: null,
        }),
      },
      `<p class="nav-empty">${WORKSPACE_MESSAGES.loadingWorkspaces}</p>`,
    ],
    [
      {
        initialWorkspaceState: workspaceState([], {
          workspaces: [],
          selectedWorkspaceId: null,
        }),
      },
      `<p class="nav-empty">${WORKSPACE_MESSAGES.noWorkspaces}</p>`,
    ],
  ];
  for (const [props, text] of cases) {
    // With the bridge, the creates' own status paragraph follows; before
    // the first state, no create is offered.
    expect(workspacePart(props)).toBe(
      `${WORKSPACES_HEADING}${text}${statusParagraph()}${props.workspaces === undefined ? "" : '<p class="nav-empty nav-status" id="create-status-workspaces" role="status"></p>'}`,
    );
  }

  // While the selected workspace loads, on the first load or after a switch.
  const loading = workspacePart({
    initialWorkspaceState: workspaceState([], { status: "loading" }),
  });
  expect(loading).toContain('aria-current="true">Workspace B</button>');
  expect(loading).toContain(
    `<h2 class="nav-heading" id="projects-heading" tabindex="-1">Projects</h2><p class="nav-empty">${WORKSPACE_MESSAGES.loadingProjects}</p>`,
  );

  // Workspaces are listed, but none is selected.
  const noneSelected = workspacePart({
    initialWorkspaceState: workspaceState([], { selectedWorkspaceId: null }),
  });
  expect(noneSelected).toContain(
    `</ul>${statusParagraph()}<p class="nav-empty">${WORKSPACE_MESSAGES.noneSelected}</p>`,
  );
  expect(noneSelected).not.toContain("aria-current");
  expect(noneSelected).not.toContain("projects-heading");

  for (const html of [loading, noneSelected, workspacePart({})]) {
    expect(html).not.toContain("workspace-a");
    expect(html).not.toContain("workspace-b");
    expect(html).not.toContain("project-a");
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain(statusParagraph());
  }
});

/** The sidebar for this workspace state with this switch message. */
function navWith(state: WorkspaceView, message: string | undefined): string {
  return renderToString(
    <WorkspaceNav
      state={createShellState(state.projects)}
      dispatch={() => undefined}
      workspaces={{
        view: { kind: "known", state },
        message,
        onSelect: () => undefined,
      }}
    />,
  );
}

test("a refused switch shows a calm fixed text below the workspaces and keeps the selection", () => {
  const html = navWith(
    workspaceState(PROJECTS),
    SELECT_REFUSAL_MESSAGES.too_soon,
  );

  expect(html).toContain(
    `aria-current="true">Workspace B</button></li></ul>${statusParagraph("Wait a moment before switching again.")}`,
  );
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain("panel-message");
});

test("a switch message is not shown while the device is not ready", () => {
  const html = navWith(
    workspaceState([], {
      status: "signed_out",
      workspaces: [],
      selectedWorkspaceId: null,
    }),
    SELECT_REFUSAL_MESSAGES.too_soon,
  );

  expect(html).toContain(
    `<p class="nav-empty">${WORKSPACE_MESSAGES.signedOut}</p>${statusParagraph()}`,
  );
  expect(html).not.toContain(SELECT_REFUSAL_MESSAGES.too_soon);
});

test("unavailable workspaces keep what was loaded and show the problem as a fixed text", () => {
  for (const problem of [
    "not_signed_in",
    "not_found",
    "rate_limited",
    "unavailable",
    "failed",
  ] as const) {
    const kept = workspacePart({
      initialWorkspaceState: workspaceState(PROJECTS, {
        status: "unavailable",
        problem,
      }),
    });
    expect(kept).toContain(
      `</ul>${statusParagraph(WORKSPACE_PROBLEM_MESSAGES[problem])}<h2 class="nav-heading" id="projects-heading" tabindex="-1">Projects</h2>`,
    );
    expect(kept).toContain('dir="auto">Project A</button>');

    // The problem says why no project is listed, not "No projects yet."
    const noProjects = workspacePart({
      initialWorkspaceState: workspaceState([], {
        status: "unavailable",
        problem,
      }),
    });
    expect(noProjects).toMatch(
      /<h2 class="nav-heading" id="projects-heading" tabindex="-1">Projects<\/h2>$/,
    );
    expect(noProjects).not.toContain(WORKSPACE_MESSAGES.noProjects);

    const empty = workspacePart({
      initialWorkspaceState: workspaceState([], {
        status: "unavailable",
        problem,
        workspaces: [],
        selectedWorkspaceId: null,
      }),
    });
    expect(empty).toBe(
      `${WORKSPACES_HEADING}${statusParagraph(WORKSPACE_PROBLEM_MESSAGES[problem])}`,
    );
  }
});

test("the problem and a switch message share the one status paragraph", () => {
  const html = navWith(
    workspaceState(PROJECTS, { status: "unavailable", problem: "failed" }),
    SELECT_REFUSAL_MESSAGES.too_soon,
  );

  expect(html.match(/role="status"/g)).toHaveLength(1);
  expect(html).toContain(
    statusParagraph(
      `${WORKSPACE_PROBLEM_MESSAGES.failed} ${SELECT_REFUSAL_MESSAGES.too_soon}`,
    ),
  );
});

test("the about screen shows the Electron version from the preload script", () => {
  expect(
    render({ electronVersion: "44.9.0", initialView: { screen: "about" } }),
  ).toContain("Electron 44.9.0");
  expect(render({ initialView: { screen: "about" } })).toContain(
    "Electron version unknown",
  );
  expect(render({ electronVersion: "44.9.0" })).not.toContain(
    "Electron 44.9.0",
  );
});

test("the header shows the runtime status indicator until the first status arrives", () => {
  expect(render({ runtime })).toContain(
    '<p class="runtime-status" role="status" data-state="unknown"><span class="runtime-status-dot" aria-hidden="true"></span>Local runtime: Checking</p>',
  );
  expect(render()).toContain("Local runtime: Unavailable");
});

test("the indicator shows the state of the runtime", () => {
  expect(
    renderToString(
      <RuntimeStatusIndicator
        view={{ kind: "known", status: { state: "running", revision: 2 } }}
      />,
    ),
  ).toBe(
    '<p class="runtime-status" role="status" data-state="running"><span class="runtime-status-dot" aria-hidden="true"></span>Local runtime: Running</p>',
  );
  expect(
    renderToString(
      <RuntimeStatusIndicator
        view={{ kind: "known", status: { state: "failed", revision: 5 } }}
      />,
    ),
  ).toContain('data-state="failed"');
});

/** The start of the connection indicator's status paragraph. */
const CONNECTION_STATUS_TEXT =
  '<p class="connection-status-text" id="connection-status-text" role="status" tabindex="-1">';

test("the header shows the connection status until the first status arrives", () => {
  const connection: ConnectionBridge = {
    getStatus: () => new Promise(() => undefined),
    subscribeStatus: () => () => undefined,
    reconnect: () => Promise.resolve({ outcome: "reconnecting" }),
  };
  expect(render({ connection })).toContain(
    `<div class="connection-status" data-state="unknown">${CONNECTION_STATUS_TEXT}<span class="connection-status-dot" aria-hidden="true"></span>Cloud: Checking</p></div>`,
  );
  expect(render()).toContain("Cloud: Unavailable");
});

const SIGNED_OUT_STATUS: AccountStatus = {
  revision: 1,
  account: { kind: "signed_out" },
  signIn: { kind: "idle" },
  lastOutcome: null,
  deviceKey: "ready",
  replacementPending: false,
  apiOrigin: "set",
  device: "no_device",
};

const SIGNED_IN_STATUS: AccountStatus = {
  ...SIGNED_OUT_STATUS,
  account: {
    kind: "signed_in",
    login: "octocat",
    displayName: "The Octocat",
    deviceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
    signInExpiresAt: "2026-12-02T10:00:00.000Z",
  },
  device: "signed_in",
};

function knownAccount(status: AccountStatus): AccountView {
  return { kind: "known", status };
}

const SIGNED_IN_ACCOUNT = knownAccount(SIGNED_IN_STATUS);

test("the connection indicator shows the state, the reason, and the action of the status", () => {
  expect(
    renderToString(
      <ConnectionStatusIndicator
        view={{ kind: "known", status: { state: "connected", revision: 2 } }}
        account={SIGNED_IN_ACCOUNT}
        onReconnect={() => undefined}
      />,
    ),
  ).toBe(
    `<div class="connection-status" data-state="connected">${CONNECTION_STATUS_TEXT}<span class="connection-status-dot" aria-hidden="true"></span>Cloud: Connected</p></div>`,
  );
  expect(
    renderToString(
      <ConnectionStatusIndicator
        view={REPLACED}
        account={SIGNED_IN_ACCOUNT}
        onReconnect={() => undefined}
        onRemoveDevice={() => undefined}
      />,
    ),
  ).toBe(
    `<div class="connection-status" data-state="stopped">${CONNECTION_STATUS_TEXT}<span class="connection-status-dot" aria-hidden="true"></span>Cloud: Stopped<span class="connection-status-detail">${REPLACED_DETAIL}</span></p><button type="button">Reconnect here once</button><button type="button">Remove this device and register again</button></div>`,
  );
  // Without the bridge, no action is offered.
  expect(
    renderToString(
      <ConnectionStatusIndicator
        view={{
          kind: "known",
          status: {
            state: "waiting",
            reason: "connection_lost",
            retryAt: "2026-11-03T10:00:01.000Z",
            revision: 4,
          },
        }}
        account={SIGNED_IN_ACCOUNT}
      />,
    ),
  ).not.toContain("<button");
});

const REPLACED: ConnectionView = {
  kind: "known",
  status: { state: "stopped", reason: "connection_replaced", revision: 3 },
};

const REPLACED_DETAIL =
  "Another installation connected with this device&#x27;s key. The key is in use there. Reconnect here once, or remove this device and register this computer again as a new device.";

/** The status after the client ended connection_replaced (#216). */
const OFFLINE: ConnectionView = {
  kind: "known",
  status: { state: "offline", reason: "not_signed_in", revision: 4 },
};

/** The labels of the indicator's buttons, with "(inert)" for aria-disabled. */
function buttonsOf(html: string): string[] {
  return [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map(
    ([, attributes = "", label = ""]) =>
      attributes.includes('aria-disabled="true"') ? `${label} (inert)` : label,
  );
}

/** The indicator's status paragraph with these sentences after the label. */
function offlineIndicator(...sentences: readonly string[]): string {
  const details = sentences
    .map(
      (sentence) =>
        `<span class="connection-status-detail">${escaped(sentence).replaceAll('"', "&quot;")}</span>`,
    )
    .join("");
  return `<div class="connection-status" data-state="offline">${CONNECTION_STATUS_TEXT}<span class="connection-status-dot" aria-hidden="true"></span>Cloud: Offline${details}</p></div>`;
}

test("connection_replaced offers no removal without its handler, and no action without a signed-in device or without both bridges", () => {
  expect(
    renderToString(
      <ConnectionStatusIndicator
        view={REPLACED}
        account={SIGNED_IN_ACCOUNT}
        onReconnect={() => undefined}
      />,
    ),
  ).toBe(
    `<div class="connection-status" data-state="stopped">${CONNECTION_STATUS_TEXT}<span class="connection-status-dot" aria-hidden="true"></span>Cloud: Stopped<span class="connection-status-detail">${REPLACED_DETAIL}</span></p><button type="button">Reconnect here once</button></div>`,
  );
  expect(
    renderToString(
      <ConnectionStatusIndicator view={REPLACED} account={SIGNED_IN_ACCOUNT} />,
    ),
  ).not.toContain("<button");
  // Without the account bridge, or before its first status, the shell does
  // not know that the device is signed in.
  for (const unknownAccount of [
    { kind: "unavailable" },
    { kind: "pending" },
  ] as const) {
    expect(
      renderToString(
        <ConnectionStatusIndicator
          view={REPLACED}
          account={unknownAccount}
          onReconnect={() => undefined}
          onRemoveDevice={() => undefined}
        />,
      ),
      unknownAccount.kind,
    ).not.toContain("<button");
  }
  expect(render()).not.toContain("Remove this device and register again");
});

test("while a removal runs, both buttons stay focusable and do nothing (the Project Manager's decision of 2026-11-06)", () => {
  let reconnects = 0;
  let removals = 0;
  const props = {
    view: REPLACED,
    account: SIGNED_IN_ACCOUNT,
    onReconnect: () => {
      reconnects += 1;
    },
    onRemoveDevice: () => {
      removals += 1;
    },
  };
  const running: DeviceRemovalView = { running: true, message: undefined };
  const html = renderToString(
    <ConnectionStatusIndicator {...props} removal={running} />,
  );
  expect(html).toBe(
    `<div class="connection-status" data-state="stopped">${CONNECTION_STATUS_TEXT}<span class="connection-status-dot" aria-hidden="true"></span>Cloud: Stopped<span class="connection-status-detail">${REPLACED_DETAIL}</span></p><button type="button" aria-disabled="true">Reconnect here once</button><button type="button" aria-disabled="true">Remove this device and register again</button></div>`,
  );
  // Not `disabled`, so the native dialog gives the focus back to a button.
  expect(html).not.toMatch(/\sdisabled=/);
  const inert = elementsOf(
    ConnectionStatusIndicator({ ...props, removal: running }),
  ).filter((element) => element.type === "button");
  expect(inert).toHaveLength(2);
  for (const button of inert) {
    expect(button.props.onClick).toBeUndefined();
    button.props.onClick?.();
  }
  expect([reconnects, removals]).toEqual([0, 0]);

  // Once the removal ended, both work again.
  const idle = elementsOf(
    ConnectionStatusIndicator({ ...props, removal: IDLE_DEVICE_REMOVAL }),
  ).filter((element) => element.type === "button");
  for (const button of idle) {
    button.props.onClick?.();
  }
  expect([reconnects, removals]).toEqual([1, 1]);
  expect(
    renderToString(<ConnectionStatusIndicator {...props} />),
  ).not.toContain("aria-disabled");
});

/** Lets the removal's promise handlers run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

/**
 * The connection indicator as the shell shows it, with "Remove this device
 * and register again" through a fake account bridge whose `removeDevice`
 * waits until the test answers it. Each call passes the account status on,
 * as the shell's effect does, and renders the indicator. The indicator gets
 * the removal's `reconnecting`, as in the shell, so a reconnect from the
 * header ends the removal's message only when the indicator calls it.
 */
function removalSequence() {
  const answers: ((result: RemoveDeviceResult) => void)[] = [];
  let reconnects = 0;
  let removalView: DeviceRemovalView = IDLE_DEVICE_REMOVAL;
  const removal = createDeviceRemoval(
    {
      removeDevice: () =>
        new Promise<RemoveDeviceResult>((resolve) => {
          answers.push(resolve);
        }),
    },
    (view) => {
      removalView = view;
    },
  );
  const indicator = (view: ConnectionView, account: AccountView) => {
    removal.accountChanged(account);
    return ConnectionStatusIndicator({
      view,
      account,
      onReconnect: () => {
        reconnects += 1;
      },
      onReconnecting: removal.reconnecting,
      onRemoveDevice: removal.remove,
      removal: removalView,
    });
  };
  return {
    answers,
    reconnects: () => reconnects,
    show: (view: ConnectionView, account: AccountView) =>
      renderToString(indicator(view, account)),
    click: (view: ConnectionView, account: AccountView, label: string) => {
      const button = elementsOf(indicator(view, account)).find(
        (element) =>
          element.type === "button" && element.props.children === label,
      );
      expect(button, label).toBeDefined();
      button?.props.onClick?.();
    },
  };
}

const REMOVE_LABEL = "Remove this device and register again";
const RECONNECT_LABEL = "Reconnect here once";
const NOT_READY_DETAIL = "This device connects once it is signed in and ready.";
const REMOVAL_PENDING_ACCOUNT = knownAccount({
  ...SIGNED_IN_STATUS,
  device: "removal_pending",
});
const REMOVED_ACCOUNT = knownAccount({
  ...SIGNED_OUT_STATUS,
  device: "removed",
});

test("after connection_replaced, a confirmed removal ends offline with the way to register again on the Account screen, once, and no button", async () => {
  const { answers, show, click } = removalSequence();
  expect(buttonsOf(show(REPLACED, SIGNED_IN_ACCOUNT))).toEqual([
    RECONNECT_LABEL,
    REMOVE_LABEL,
  ]);
  click(REPLACED, SIGNED_IN_ACCOUNT, REMOVE_LABEL);
  expect(answers).toHaveLength(1);
  // While the main process asks in its native dialog, both buttons stay.
  expect(buttonsOf(show(REPLACED, SIGNED_IN_ACCOUNT))).toEqual([
    `${RECONNECT_LABEL} (inert)`,
    `${REMOVE_LABEL} (inert)`,
  ]);
  // The session notes the removal; the account status may arrive first.
  expect(buttonsOf(show(REPLACED, REMOVAL_PENDING_ACCOUNT))).toEqual([]);
  // The client ends connection_replaced (#216), and the panel offers no
  // sign-in while the removal waits for the server.
  expect(show(OFFLINE, REMOVAL_PENDING_ACCOUNT)).toBe(
    offlineIndicator(NOT_READY_DETAIL),
  );
  // The server confirms: the key is deleted, and the panel offers a
  // sign-in. The register-again message asks for it, so the offline
  // sentence does not ask a second time.
  answers[0]?.({ outcome: "removed" });
  await settle();
  const html = show(OFFLINE, REMOVED_ACCOUNT);
  expect(html).toBe(offlineIndicator(NOT_READY_DETAIL, REGISTER_AGAIN_MESSAGE));
  expect(html.split("Sign in with GitHub")).toHaveLength(2);
  expect(REGISTER_AGAIN_MESSAGE).toContain("on the Account screen");
  // A sign-in on the Account screen ends the message.
  expect(
    show(
      OFFLINE,
      knownAccount({
        ...SIGNED_OUT_STATUS,
        device: "removed",
        signIn: { kind: "starting" },
      }),
    ),
  ).toBe(offlineIndicator(NOT_READY_DETAIL));
  // Once it ended without a sign-in, the offline sentence asks for one again.
  expect(show(OFFLINE, REMOVED_ACCOUNT)).toBe(
    offlineIndicator(OFFLINE_SIGN_IN_DETAIL),
  );
});

test("a removal that waits for the server names the Account screen, and becomes the way to register again once Remove this device succeeds there", async () => {
  const { answers, show, click } = removalSequence();
  click(REPLACED, SIGNED_IN_ACCOUNT, REMOVE_LABEL);
  expect(buttonsOf(show(REPLACED, REMOVAL_PENDING_ACCOUNT))).toEqual([]);
  answers[0]?.({ outcome: "pending" });
  await settle();
  expect(show(OFFLINE, REMOVAL_PENDING_ACCOUNT)).toBe(
    offlineIndicator(NOT_READY_DETAIL, REMOVAL_PENDING_MESSAGE),
  );
  expect(REMOVAL_PENDING_MESSAGE).toContain(
    'choose "Remove this device" on the Account screen',
  );
  // "Remove this device" on the Account screen: the server confirms.
  expect(show(OFFLINE, REMOVED_ACCOUNT)).toBe(
    offlineIndicator(NOT_READY_DETAIL, REGISTER_AGAIN_MESSAGE),
  );
});

test("a removal that the server refused names the removal and keeps its message next to connection_replaced and both buttons once the device is signed in again", async () => {
  const { answers, reconnects, show, click } = removalSequence();
  click(REPLACED, SIGNED_IN_ACCOUNT, REMOVE_LABEL);
  expect(buttonsOf(show(REPLACED, REMOVAL_PENDING_ACCOUNT))).toEqual([]);
  expect(show(OFFLINE, REMOVAL_PENDING_ACCOUNT)).toBe(
    offlineIndicator(NOT_READY_DETAIL),
  );
  // For example `conflict`: the session ends the removal, and the device is
  // signed in again with the same ID. The client brings connection_replaced
  // back instead of connecting (#217).
  answers[0]?.({ outcome: "failed", reason: "refused" });
  await settle();
  const refused =
    "This device could not be removed. The server refused the request.";
  expect(`${REMOVAL_NOT_DONE} ${DEVICE_ACTION_FAILURE_MESSAGES.refused}`).toBe(
    refused,
  );
  const restored = show(REPLACED, SIGNED_IN_ACCOUNT);
  expect(buttonsOf(restored)).toEqual([RECONNECT_LABEL, REMOVE_LABEL]);
  expect(restored).toContain(
    `<span class="connection-status-detail">${refused}</span></p>`,
  );

  // A connection alone does not end the message either.
  for (const [state, label] of [
    ["connecting", "Connecting"],
    ["authenticating", "Authenticating"],
    ["connected", "Connected"],
  ] as const) {
    const html = show(
      { kind: "known", status: { state, revision: 6 } },
      SIGNED_IN_ACCOUNT,
    );
    expect(html, state).toContain(
      `Cloud: ${label}<span class="connection-status-detail">${refused}</span></p></div>`,
    );
  }

  // "Reconnect here once" ends it.
  click(REPLACED, SIGNED_IN_ACCOUNT, RECONNECT_LABEL);
  expect(reconnects()).toBe(1);
  expect(
    show(
      { kind: "known", status: { state: "connected", revision: 7 } },
      SIGNED_IN_ACCOUNT,
    ),
  ).not.toContain(refused);
});

test("a removal that the main process refused leaves both buttons usable, and Reconnect here once ends its message", async () => {
  const { answers, reconnects, show, click } = removalSequence();
  for (const result of [
    { outcome: "refused", reason: "busy" },
    { outcome: "failed", reason: "rate_limited" },
  ] as const) {
    click(REPLACED, SIGNED_IN_ACCOUNT, REMOVE_LABEL);
    answers.at(-1)?.(result);
    await settle();
    const html = show(REPLACED, SIGNED_IN_ACCOUNT);
    expect(buttonsOf(html), result.reason).toEqual([
      RECONNECT_LABEL,
      REMOVE_LABEL,
    ]);
    expect(html, result.reason).toContain(
      `<span class="connection-status-detail">${REMOVAL_NOT_DONE} `,
    );
    // The person reconnects here; the connection then says what follows.
    click(REPLACED, SIGNED_IN_ACCOUNT, RECONNECT_LABEL);
    const connected = show(
      { kind: "known", status: { state: "connected", revision: 7 } },
      SIGNED_IN_ACCOUNT,
    );
    expect(connected, result.reason).toBe(
      `<div class="connection-status" data-state="connected">${CONNECTION_STATUS_TEXT}<span class="connection-status-dot" aria-hidden="true"></span>Cloud: Connected</p></div>`,
    );
  }
  expect(reconnects()).toBe(2);
  expect(
    `${REMOVAL_NOT_DONE} ${DEVICE_ACTION_MESSAGES.busy}`.startsWith(
      "This device could not be removed. Wait until",
    ),
  ).toBe(true);

  // The next removal clears a message; a cancel shows none.
  click(REPLACED, SIGNED_IN_ACCOUNT, REMOVE_LABEL);
  answers.at(-1)?.({ outcome: "refused", reason: "busy" });
  await settle();
  click(REPLACED, SIGNED_IN_ACCOUNT, REMOVE_LABEL);
  answers.at(-1)?.({ outcome: "cancelled" });
  await settle();
  const cancelled = show(REPLACED, SIGNED_IN_ACCOUNT);
  expect(buttonsOf(cancelled)).toEqual([RECONNECT_LABEL, REMOVE_LABEL]);
  expect(cancelled).toContain(
    `<span class="connection-status-detail">${REPLACED_DETAIL}</span></p>`,
  );
});

test("no button is offered once the device is no longer signed in, as after a sign-out or This is not me", () => {
  const { show } = removalSequence();
  const signedOut: readonly AccountStatus[] = [
    // A sign-out: the main process names no account (#195).
    { ...SIGNED_IN_STATUS, account: { kind: "hidden" }, device: "signed_out" },
    {
      ...SIGNED_IN_STATUS,
      account: { kind: "hidden" },
      device: "sign_out_report_pending",
    },
    // "This is not me": no account and no device.
    SIGNED_OUT_STATUS,
    { ...SIGNED_OUT_STATUS, device: "removed" },
  ];
  for (const status of signedOut) {
    const signedOutAccount = knownAccount(status);
    // Also before the client's offline status arrives.
    expect(buttonsOf(show(REPLACED, signedOutAccount)), status.device).toEqual(
      [],
    );
    expect(show(OFFLINE, signedOutAccount), status.device).toBe(
      offlineIndicator(OFFLINE_SIGN_IN_DETAIL),
    );
  }
});

/** The props of an element that the tests read or call. */
interface TestProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
  readonly onFocus?: () => void;
  readonly onBlur?: (event: TestBlurEvent) => void;
}

/** What a header button's blur handler reads of its event. */
interface TestBlurEvent {
  readonly currentTarget: {
    readonly isConnected: boolean;
    readonly ownerDocument: { readonly hasFocus: () => boolean };
  };
}

/**
 * A blur of a header button that is still in the page or not, while the
 * window has the focus or not.
 */
function blurEvent(isConnected: boolean, windowFocused = true): TestBlurEvent {
  return {
    currentTarget: {
      isConnected,
      ownerDocument: { hasFocus: () => windowFocused },
    },
  };
}

/** The element and every element below it, without rendering components. */
function elementsOf(node: ReactNode): ReactElement<TestProps>[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => elementsOf(child));
  }
  if (!isValidElement<TestProps>(node)) {
    return [];
  }
  return [node, ...elementsOf(node.props.children)];
}

test("each header button reports when it takes the focus, and when it loses it while it is still in the page and the window has the focus", () => {
  const reports: (string | undefined)[] = [];
  const indicator = (view: ConnectionView) =>
    ConnectionStatusIndicator({
      view,
      account: SIGNED_IN_ACCOUNT,
      onReconnect: () => undefined,
      onRemoveDevice: () => undefined,
      onActionFocus: (action) => reports.push(action),
    });
  const buttons = (view: ConnectionView) =>
    elementsOf(indicator(view)).filter((element) => element.type === "button");

  const [reconnect, remove] = buttons(REPLACED);
  reconnect?.props.onFocus?.();
  reconnect?.props.onBlur?.(blurEvent(true));
  remove?.props.onFocus?.();
  // Chromium fires no blur when it removes the focused button; a blur of a
  // button that already left the page is not the person's, so the note
  // keeps naming it until the shell checks the new actions.
  remove?.props.onBlur?.(blurEvent(false));
  const [retry] = buttons({
    kind: "known",
    status: {
      state: "waiting",
      reason: "timeout",
      retryAt: "2026-11-03T10:00:01.000Z",
      revision: 1,
    },
  });
  retry?.props.onFocus?.();
  expect(reports).toEqual([
    "reconnect_here",
    undefined,
    "remove_and_register",
    "retry_now",
  ]);
  // Without the callback, focus and blur do nothing.
  const [plain] = elementsOf(
    ConnectionStatusIndicator({
      view: REPLACED,
      account: SIGNED_IN_ACCOUNT,
      onReconnect: () => undefined,
    }),
  ).filter((element) => element.type === "button");
  plain?.props.onFocus?.();
  plain?.props.onBlur?.(blurEvent(true));
  expect(reports).toHaveLength(4);
});

test("a blur while the window has no focus, as when the removal's native dialog opens, keeps the note, so the status paragraph takes the focus once the buttons go", () => {
  let note: ConnectionAction | undefined;
  const removeButton = (removal: DeviceRemovalView) =>
    elementsOf(
      ConnectionStatusIndicator({
        view: REPLACED,
        account: SIGNED_IN_ACCOUNT,
        onReconnect: () => undefined,
        onRemoveDevice: () => undefined,
        onActionFocus: (action) => {
          note = action;
        },
        removal,
      }),
    ).find(
      (element) =>
        element.type === "button" && element.props.children === REMOVE_LABEL,
    );
  const running: DeviceRemovalView = { running: true, message: undefined };
  // Once the removal is confirmed, the account status removes both buttons.
  const confirmed = describeConnectionView(
    REPLACED,
    REMOVAL_PENDING_ACCOUNT,
  ).actions;
  expect(confirmed).toEqual([]);

  // The person moves the focus to the removal and chooses it.
  removeButton(IDLE_DEVICE_REMOVAL)?.props.onFocus?.();
  expect(note).toBe("remove_and_register");
  // The main process opens its native dialog, which deactivates the
  // window: the button, inert now, blurs while it is still in the page.
  removeButton(running)?.props.onBlur?.(blurEvent(true, false));
  expect(note).toBe("remove_and_register");
  // When the status removes the buttons before the window comes back, the
  // focus fell to the page, and the status paragraph takes it.
  expect(focusesStatus(note, confirmed, true)).toBe(true);
  // When the window comes back first, Chromium focuses the button again.
  removeButton(running)?.props.onFocus?.();
  expect(note).toBe("remove_and_register");
  expect(focusesStatus(note, confirmed, true)).toBe(true);

  // A blur while the window has the focus is the person's: the focus moved
  // to another element of the page, and stays there.
  removeButton(running)?.props.onBlur?.(blurEvent(true));
  expect(note).toBeUndefined();
  expect(focusesStatus(note, confirmed, true)).toBe(false);
});

test("Retry now and Reconnect here once call the removal's reconnecting and then the reconnect, the removal calls its own handler, and nothing else does", () => {
  const calls: string[] = [];
  const onReconnect = () => {
    calls.push("reconnect");
  };
  const onReconnecting = () => {
    calls.push("reconnecting");
  };
  const waiting = ConnectionStatusIndicator({
    view: {
      kind: "known",
      status: {
        state: "waiting",
        reason: "timeout",
        retryAt: "2026-11-03T10:00:01.000Z",
        revision: 1,
      },
    },
    account: SIGNED_IN_ACCOUNT,
    onReconnect,
    onReconnecting,
  });
  const buttons = elementsOf(waiting).filter(
    (element) => element.type === "button",
  );
  expect(buttons.map((button) => button.props.children)).toEqual(["Retry now"]);
  buttons[0]?.props.onClick?.();
  expect(calls).toEqual(["reconnecting", "reconnect"]);

  const replaced = ConnectionStatusIndicator({
    view: REPLACED,
    account: SIGNED_IN_ACCOUNT,
    onReconnect,
    onReconnecting,
    onRemoveDevice: () => {
      calls.push("remove");
    },
  });
  const replacedButtons = elementsOf(replaced).filter(
    (element) => element.type === "button",
  );
  expect(replacedButtons.map((button) => button.props.children)).toEqual([
    "Reconnect here once",
    "Remove this device and register again",
  ]);
  calls.length = 0;
  replacedButtons[0]?.props.onClick?.();
  expect(calls).toEqual(["reconnecting", "reconnect"]);
  replacedButtons[1]?.props.onClick?.();
  expect(calls).toEqual(["reconnecting", "reconnect", "remove"]);

  for (const reason of [
    "auth_failed",
    "device_revoked",
    "sign_in_required",
    "update_required",
  ] as const) {
    const stopped = ConnectionStatusIndicator({
      view: {
        kind: "known",
        status: { state: "stopped", reason, revision: 1 },
      },
      account: SIGNED_IN_ACCOUNT,
      onReconnect,
    });
    expect(
      elementsOf(stopped).filter((element) => element.type === "button"),
      reason,
    ).toEqual([]);
  }
});

/** An account bridge whose first status does not arrive. */
const pendingAccount: AccountBridge = {
  getStatus: () => new Promise(() => undefined),
  subscribeStatus: () => () => undefined,
  startSignIn: () => Promise.resolve({ outcome: "started" }),
  cancelSignIn: () => Promise.resolve(false),
  unlockDeviceKey: () => Promise.resolve({ outcome: "unlocked" }),
  forgetAccount: () =>
    Promise.resolve({ outcome: "forgotten", removedAtServer: true }),
  signOut: () => Promise.resolve({ outcome: "signed_out" }),
  removeDevice: () => Promise.resolve({ outcome: "removed" }),
};

/** A device list bridge whose first state does not arrive. */
const pendingDevices: DeviceListBridge = {
  getState: () => new Promise(() => undefined),
  subscribeState: () => () => undefined,
  load: () => Promise.resolve({ outcome: "loading" }),
  dismissNewDevices: () => Promise.resolve(false),
  revokeDevice: () => Promise.resolve({ outcome: "cancelled" }),
  liftRegistrationLock: () => Promise.resolve({ outcome: "cancelled" }),
  dismissLostDeviceAdvice: () => Promise.resolve(false),
};

test("the account screen holds the account panel under This device and the account's devices beside it, which wait for their first states with the bridges", () => {
  const accountView = { screen: "account" } as const;
  expect(
    render({
      account: pendingAccount,
      devices: pendingDevices,
      initialView: accountView,
    }),
  ).toContain(
    '<section aria-labelledby="account-screen-title"><h2 id="account-screen-title" tabindex="-1">Account</h2><p>Sign in this device with GitHub, manage the device and its sign-in, and see every device of the account.</p><section class="account-panel" aria-labelledby="account-title"><h3 id="account-title">This device</h3><p>Checking the sign-in.</p></section><section class="account-panel" aria-labelledby="devices-title"><h3 id="devices-title" tabindex="-1">Devices</h3><p class="account-message" role="status">Checking the devices.</p><p class="account-message" id="device-action-message" role="status"></p></section></section>',
  );
  const without = render({ initialView: accountView });
  expect(without).toContain("<p>Sign-in is not available.</p>");
  expect(without).toContain(
    '<p class="account-message" role="status">Devices are not available.</p>',
  );
  // The panel moved from the home screen to the account screen, and the
  // devices show there only.
  for (const screen of ["home", "people", "join", "about"] as const) {
    const html = render({
      account: pendingAccount,
      devices: pendingDevices,
      initialView: { screen },
    });
    expect(html, screen).not.toContain("account-panel");
    expect(html, screen).not.toContain("devices-title");
  }
});

const HOME_HINT =
  '<section aria-labelledby="home-title"><h2 id="home-title" tabindex="-1">Home</h2><p>Open a project to see its chat, tasks, decisions, and permissions, and its agents and repositories.</p>';

/** The end of the home screen with this sentence, its buttons, and a message. */
function homeEnd(
  sentence: string,
  { signIn = "", message = "" }: { signIn?: string; message?: string } = {},
): string {
  return `<p>${sentence}</p><div class="account-actions">${signIn}<button type="button" class="panel-action">Go to Account</button></div>${message}</section>`;
}

/** The end of the home screen with this sentence and "Go to Account" alone. */
function goToAccount(sentence: string): string {
  return homeEnd(sentence);
}

const HOME_SIGN_IN_BUTTON =
  '<button type="button" class="panel-action">Sign in with GitHub</button>';

function renderHome(
  signIn: HomeSignIn,
  start: HomeSignInStartView = IDLE_HOME_SIGN_IN_START,
): string {
  return renderToString(
    <HomeScreen
      signIn={signIn}
      start={start}
      onStartSignIn={() => undefined}
      dispatch={() => undefined}
      focusAfterShow={() => undefined}
    />,
  );
}

test("the home screen says the sentence of its case, with Go to Account whenever it says one and Sign in with GitHub while a sign-in can start", () => {
  expect(renderHome("sign_in")).toBe(
    HOME_HINT +
      homeEnd(
        "Sign in with GitHub to see your workspaces. The sign-in continues on the Account screen.",
        { signIn: HOME_SIGN_IN_BUTTON },
      ),
  );
  expect(renderHome("not_ready")).toBe(
    HOME_HINT +
      goToAccount("Workspaces appear once this device is signed in and ready."),
  );
  expect(renderHome("none")).toBe(`${HOME_HINT}</section>`);
});

test("the home screen's Sign in with GitHub stays focusable and inert while its start runs, and the message of a refused or failed start shows as an alert", () => {
  expect(renderHome("sign_in", { running: true, message: undefined })).toBe(
    HOME_HINT +
      homeEnd(HOME_SIGN_IN_MESSAGES.sign_in, {
        signIn:
          '<button type="button" class="panel-action" aria-disabled="true">Sign in with GitHub</button>',
      }),
  );
  const alert = `<p class="panel-message" role="alert">${escaped(START_REFUSAL_MESSAGES.too_soon)}</p>`;
  expect(
    renderHome("sign_in", {
      running: false,
      message: START_REFUSAL_MESSAGES.too_soon,
    }),
  ).toBe(
    HOME_HINT +
      homeEnd(HOME_SIGN_IN_MESSAGES.sign_in, {
        signIn: HOME_SIGN_IN_BUTTON,
        message: alert,
      }),
  );
  // Also where the refusal's reason took the sign-in away, for example a
  // key that is no longer ready.
  const keyNotReady = `<p class="panel-message" role="alert">${START_REFUSAL_MESSAGES.key_not_ready}</p>`;
  expect(
    renderHome("not_ready", {
      running: false,
      message: START_REFUSAL_MESSAGES.key_not_ready,
    }),
  ).toBe(
    HOME_HINT +
      homeEnd(HOME_SIGN_IN_MESSAGES.not_ready, { message: keyNotReady }),
  );
  // Nothing while a device is signed in and ready.
  expect(
    renderHome("none", { running: true, message: ACTION_MESSAGES.startFailed }),
  ).toBe(`${HOME_HINT}</section>`);
});

/** The panel's and the home screen's "Sign in with GitHub" buttons, and whether each is enabled. */
function signInButtons(html: string): boolean[] {
  return [
    ...html.matchAll(/<button([^>]*)>Sign in with GitHub<\/button>/g),
  ].map(([, attributes]) => !(attributes ?? "").includes("disabled"));
}

/** The workspaces while no device is signed in. */
const SIGNED_OUT_WORKSPACES = {
  kind: "known",
  state: workspaceState([], {
    status: "signed_out",
    workspaces: [],
    selectedWorkspaceId: null,
  }),
} as const;

const SIGN_IN_RULE_ACCOUNTS: readonly AccountStatus["account"][] = [
  { kind: "signed_out" },
  { kind: "hidden" },
  {
    kind: "signed_in",
    login: "octocat",
    displayName: "The Octocat",
    deviceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
    signInExpiresAt: "2026-12-02T10:00:00.000Z",
  },
];

const SIGN_IN_RULE_SIGN_INS: readonly AccountStatus["signIn"][] = [
  { kind: "idle" },
  { kind: "starting" },
  { kind: "waiting", pairingCode: "042137", opened: true },
  { kind: "completing" },
];

/**
 * The account statuses that the home screen's sign-in rule is checked in,
 * one case for each account and sign-in, with every device key, API origin,
 * and device state in each, so that no case comes near the test timeout
 * (#254).
 */
const SIGN_IN_RULE_CASES = SIGN_IN_RULE_ACCOUNTS.flatMap((account) =>
  SIGN_IN_RULE_SIGN_INS.map((signIn) => ({
    account,
    signIn,
    statuses: DEVICE_KEY_STATES.flatMap((deviceKey) =>
      API_ORIGIN_STATES.flatMap((apiOrigin) =>
        DEVICE_STATES.map((device): AccountStatus => ({
          revision: 1,
          account,
          signIn,
          lastOutcome: null,
          deviceKey,
          replacementPending: false,
          apiOrigin,
          device,
        })),
      ),
    ),
  })),
);

// The panel makes its two time formats again for each render, which took
// most of this check's time. Made once here, they give the same HTML.
const SIGN_IN_RULE_TIME_FORMAT = signInTimeFormat();
const SIGN_IN_RULE_END_FORMAT = signInEndFormat();

test("the home screen's sign-in rule is checked in every signed-out state, with and without a sign-in that can start now", () => {
  const statuses = SIGN_IN_RULE_CASES.flatMap(({ statuses }) => statuses);
  expect(SIGN_IN_RULE_CASES).toHaveLength(3 * 4);
  expect(statuses).toHaveLength(3 * 4 * 8 * 3 * 14);
  const offered = statuses.filter(canStartSignIn).length;
  expect(offered).toBeGreaterThan(0);
  expect(offered).toBeLessThan(statuses.length);
});

test.each(SIGN_IN_RULE_CASES)(
  "the home screen offers Sign in with GitHub exactly when the account panel offers one that can start now, by one rule, while the account is $account.kind and the sign-in is $signIn.kind",
  ({ statuses }) => {
    for (const status of statuses) {
      const view: AccountView = { kind: "known", status };
      const name = JSON.stringify(status);
      const panel = signInButtons(
        renderToString(
          <AccountPanelContent
            view={view}
            busy={false}
            message={undefined}
            onStartSignIn={() => undefined}
            onUseAnotherBrowser={() => undefined}
            anotherBrowser={false}
            anotherBrowserReady
            onCancelSignIn={() => undefined}
            onUnlock={() => undefined}
            onForget={() => undefined}
            onSignOut={() => undefined}
            onRemoveDevice={() => undefined}
            now={Date.parse("2026-11-09T10:00:00.000Z")}
            timeFormat={SIGN_IN_RULE_TIME_FORMAT}
            endFormat={SIGN_IN_RULE_END_FORMAT}
          />,
        ),
      );
      const panelOffers = panel.includes(true);
      const home = signInButtons(
        renderHome(homeSignIn(SIGNED_OUT_WORKSPACES, view)),
      );
      // The home screen's button is never disabled while it is idle.
      expect(home, name).toEqual(panelOffers ? [true] : []);
      expect(panelOffers, name).toBe(canStartSignIn(status));
    }
  },
);

// Without a known account status, the panel offers nothing, and neither
// does the home screen.
test.each([{ kind: "pending" }, { kind: "unavailable" }] as const)(
  "the home screen offers no Sign in with GitHub while the account status is $kind",
  (view) => {
    expect(renderHome(homeSignIn(SIGNED_OUT_WORKSPACES, view))).not.toContain(
      "Sign in with GitHub</button>",
    );
  },
);

test("the home screen offers Go to Account only while no device is signed in, with the neutral sentence until the account status is known", () => {
  const signedOut = workspaceState([], {
    status: "signed_out",
    workspaces: [],
    selectedWorkspaceId: null,
  });
  // Without the account bridge and before its first status, the panel
  // offers no sign-in yet.
  for (const account of [undefined, pendingAccount]) {
    const html = render({ account, initialWorkspaceState: signedOut });
    expect(html).toContain(
      HOME_HINT + goToAccount(HOME_SIGN_IN_MESSAGES.not_ready),
    );
    expect(html).not.toContain(HOME_SIGN_IN_MESSAGES.sign_in);
  }
  // Only the home screen offers it.
  expect(
    render({
      initialWorkspaceState: signedOut,
      initialView: { screen: "about" },
    }),
  ).not.toContain("Go to Account");
  for (const state of [
    workspaceState(PROJECTS),
    workspaceState([], { status: "loading" }),
    workspaceState(PROJECTS, { status: "unavailable", problem: "unavailable" }),
  ]) {
    expect(
      render({ account: pendingAccount, initialWorkspaceState: state }),
      state.status,
    ).toContain(`${HOME_HINT}</section>`);
  }
  // Before the first workspace state and without the bridge, it says nothing.
  expect(
    render({ workspaces: pendingBridge, initialWorkspaceState: undefined }),
  ).not.toContain("Go to Account");
  expect(render({ initialWorkspaceState: undefined })).not.toContain(
    "Go to Account",
  );
});
