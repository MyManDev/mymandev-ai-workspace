import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type { RuntimeBridge } from "../shared/desktop-bridge.ts";
import { App, RuntimeStatusIndicator, type AppProps } from "./App.tsx";
import { PLACEHOLDER_PROJECTS } from "./placeholder-projects.ts";
import type { ProjectSummary, ShellView } from "./screens.ts";

const runtime: RuntimeBridge = {
  getStatus: () => Promise.resolve({ state: "running", revision: 2 }),
  subscribeStatus: () => () => undefined,
};

const PROJECTS: readonly ProjectSummary[] = [
  { id: "project-a", name: "Project A" },
  { id: "project-b", name: "Project B" },
];

function render(props: Partial<AppProps> = {}): string {
  return renderToString(<App projects={PROJECTS} {...props} />);
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
    title: '<h2 id="home-title">Home</h2>',
    placeholder: "Open a project to see its chat",
    current: ["Home (page)"],
  },
  {
    view: { screen: "about" },
    title: '<h2 id="about-title">About</h2>',
    placeholder: "Electron 44.9.0",
    current: ["About (page)"],
  },
  {
    view: { screen: "chat", projectId: "project-b", panel: "agents" },
    title: '<h2 id="chat-title">Chat</h2>',
    placeholder: "This is a placeholder message.",
    current: ["Project B (true)", "Chat (page)"],
  },
  {
    view: { screen: "tasks", projectId: "project-a", panel: "agents" },
    title: '<h2 id="tasks-title">Tasks</h2>',
    placeholder: "No tasks yet.",
    current: ["Project A (true)", "Tasks (page)"],
  },
  {
    view: { screen: "decisions", projectId: "project-a", panel: "agents" },
    title: '<h2 id="decisions-title">Decisions</h2>',
    placeholder: "No decisions yet.",
    current: ["Project A (true)", "Decisions (page)"],
  },
  {
    view: { screen: "permissions", projectId: "project-b", panel: "agents" },
    title: '<h2 id="permissions-title">Permissions</h2>',
    placeholder: "Not available yet.",
    current: ["Project B (true)", "Permissions (page)"],
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
    ]) {
      expect(ids).toContain(reference);
    }

    // The Content Security Policy allows no inline styles.
    expect(html).not.toMatch(/\sstyle=/);
  },
);

test("the sidebar lists the workspace screens and every project", () => {
  const html = render();

  expect(html).toMatch(
    /<button type="button" class="nav-item">About<\/button>/,
  );
  expect(html).toContain('<h2 class="nav-heading" id="projects-heading">');
  expect(html).toContain(
    '<ul class="nav-list" aria-labelledby="projects-heading">',
  );
  for (const project of PROJECTS) {
    expect(html).toContain(
      `<button type="button" class="nav-item">${project.name}</button>`,
    );
  }
});

test("the project navigation names the open project and reaches tasks and decisions", () => {
  const html = render({
    initialView: { screen: "chat", projectId: "project-a", panel: "agents" },
  });

  expect(html).toContain('<p class="project-nav-name">Project A</p>');
  for (const label of ["Tasks", "Decisions", "Permissions"]) {
    expect(html).toContain(
      `<button type="button" class="nav-item">${label}</button>`,
    );
  }
});

test("the chat shows a message list and a disabled composer", () => {
  const html = render({
    initialView: { screen: "chat", projectId: "project-a", panel: "agents" },
  });

  expect(html).toContain('<ol class="message-list" aria-label="Messages">');
  expect(html.match(/<li class="message">/g)).toHaveLength(2);
  expect(html).toContain('<form class="composer" aria-label="New message">');
  expect(html).toContain(
    '<label class="composer-label" for="composer-text">Message</label>',
  );
  expect(html).toMatch(
    /<textarea id="composer-text" class="composer-text" rows="3" disabled="" aria-describedby="composer-note"><\/textarea>/,
  );
  expect(html).toContain(
    '<button type="submit" class="composer-send" disabled="">Send</button>',
  );
  expect(html).toContain("Sending messages is not available yet.");
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
      '</div><div class="panel-content" role="tabpanel" id="panel-content" aria-labelledby="panel-tab-agents" tabindex="0"><h2 id="panel-title">Agents</h2><p>No agents yet.</p>',
  );
  expect(repositories).toContain(
    '<div class="panel-tabs" role="tablist" aria-label="Side panel">' +
      tab("Agents", false) +
      tab("Repositories", true) +
      '</div><div class="panel-content" role="tabpanel" id="panel-content" aria-labelledby="panel-tab-repositories" tabindex="0"><h2 id="panel-title">Repositories</h2><p>No repositories yet.</p>',
  );
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

test("project names are rendered as text, not as markup", () => {
  const html = renderToString(
    <App
      projects={[{ id: "x", name: '<img src="x">' }]}
      initialView={{ screen: "chat", projectId: "x", panel: "agents" }}
    />,
  );

  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img src=&quot;x&quot;&gt;");
});

test("without projects, the sidebar says so and the shell shows the home screen", () => {
  const html = renderToString(
    <App
      projects={[]}
      initialView={{ screen: "chat", projectId: "project-a", panel: "agents" }}
    />,
  );

  expect(html).toContain('<p class="nav-empty">No projects yet.</p>');
  expect(html).not.toContain('aria-labelledby="projects-heading"');
  expect(html).toContain('<h2 id="home-title">Home</h2>');
  expect(currentItems(html)).toEqual(["Home (page)"]);
});

test("the shell renders the placeholder projects", () => {
  const html = renderToString(<App projects={PLACEHOLDER_PROJECTS} />);

  expect(PLACEHOLDER_PROJECTS.length).toBeGreaterThan(0);
  for (const project of PLACEHOLDER_PROJECTS) {
    expect(html).toContain(`>${project.name}</button>`);
  }
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
