import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type {
  MountedRepository,
  ProjectRepositoriesView,
  RepositoryList,
} from "../shared/ipc-contract.ts";
import type {
  ProjectRepositoriesControls,
  ProjectRepositoryHandlers,
} from "./ProjectRepositories.tsx";
import {
  describeProjectRepositories,
  IDLE_PROJECT_REPOSITORY_ACTIONS,
  PROJECT_REPOSITORY_DONE_MESSAGES,
  PROJECT_REPOSITORY_MESSAGES,
} from "./project-repositories-view.ts";
import {
  RepositoryPanel,
  RepositoryPanelContent,
  type RepositoryPanelContentProps,
} from "./RepositoryPanel.tsx";
import type { RepositoryPanelView } from "./repository-view.ts";

const COMMIT = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

const READY: MountedRepository = {
  mountId: "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b70",
  name: "project",
  path: "/home/user/project",
  watching: true,
  state: {
    kind: "ready",
    branch: {
      name: "main",
      commit: COMMIT,
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
    },
    changes: { staged: 1, unstaged: 2, untracked: 3, conflicted: 0 },
    remotes: [
      {
        name: "origin",
        fetchUrl: "https://example.com/project.git",
        pushUrl: "git@example.com:project.git",
      },
      { name: "mirror", fetchUrl: "/srv/mirror.git", pushUrl: null },
    ],
  },
};

function listOf(...repositories: MountedRepository[]): RepositoryList {
  return { revision: 1, repositories };
}

function render(props: Partial<RepositoryPanelContentProps> = {}): string {
  return renderToString(
    <RepositoryPanelContent
      view={{ kind: "known", list: listOf() }}
      busy={false}
      message={undefined}
      onMount={() => undefined}
      onUnmount={() => undefined}
      {...props}
    />,
  );
}

test("an empty list says so and offers to add a repository", () => {
  const html = render();

  expect(html).toContain(
    '<h2 id="panel-title">Repositories</h2><section class="repository-section" aria-labelledby="device-repositories-title"><h3 class="repository-section-title" id="device-repositories-title">On this device</h3><button type="button" class="panel-action">Add a repository</button>',
  );
  expect(html).toContain("<p>No repositories yet.</p>");
  expect(html).toContain("nothing in their folders is changed");
  expect(html).not.toContain('role="alert"');
});

test("a mounted repository shows its path, branch, upstream, changes, and remotes", () => {
  const html = render({ view: { kind: "known", list: listOf(READY) } });

  expect(html).toContain(
    '<ul class="repository-list" aria-labelledby="device-repositories-title">',
  );
  expect(html).toContain('<h4 class="repository-name">project</h4>');
  expect(html).toContain("<code>/home/user/project</code>");
  expect(html).toContain("<dt>Branch</dt><dd>main</dd>");
  expect(html).toContain(
    "<dt>Upstream</dt><dd>2 ahead of and 1 behind origin/main</dd>",
  );
  expect(html).toContain(
    "<dt>Changes</dt><dd>1 staged, 2 not staged, 3 untracked</dd>",
  );
  expect(html).toContain(
    '<span class="remote-name">origin</span><code class="remote-url">https://example.com/project.git</code><code class="remote-url">push: <!-- -->git@example.com:project.git</code>',
  );
  expect(html).toContain(
    '<span class="remote-name">mirror</span><code class="remote-url">/srv/mirror.git</code></li>',
  );
  expect(html).toContain(
    'aria-label="Remove project from the list">Remove</button>',
  );
  expect(html).not.toContain("Not watching for file changes.");
  expect(html).not.toMatch(/\sstyle=/);
});

test("a detached HEAD, a repository without commits, and one without upstream or remotes", () => {
  const ready = READY.state;
  if (ready.kind !== "ready") {
    throw new Error("expected a ready state");
  }
  const detached: MountedRepository = {
    ...READY,
    state: {
      ...ready,
      branch: {
        name: null,
        commit: COMMIT,
        upstream: null,
        ahead: null,
        behind: null,
      },
      changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
      remotes: [],
    },
  };
  const unborn: MountedRepository = {
    ...READY,
    mountId: "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b71",
    state: {
      ...ready,
      branch: {
        name: "main",
        commit: null,
        upstream: "origin/main",
        ahead: null,
        behind: null,
      },
      changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 2 },
    },
  };
  const html = render({
    view: { kind: "known", list: listOf(detached, unborn) },
  });

  expect(html).toContain("<dd>Detached at 1a2b3c4</dd>");
  expect(html).toContain("<dt>Changes</dt><dd>No changes</dd>");
  expect(html).toContain("<dt>Remotes</dt><dd>None</dd>");
  expect(html).toContain("<dd>main, no commits yet</dd>");
  expect(html).toContain("<dt>Upstream</dt><dd>Tracks origin/main</dd>");
  expect(html).toContain("<dd>2 conflicted</dd>");
  expect(html.match(/<dt>Upstream<\/dt>/g)).toHaveLength(1);
});

test("a repository that is loading, unavailable, or not watched says so", () => {
  const html = render({
    view: {
      kind: "known",
      list: listOf(
        { ...READY, state: { kind: "loading" } },
        {
          ...READY,
          mountId: "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b71",
          watching: false,
          state: { kind: "unavailable", problem: "missing" },
        },
      ),
    },
  });

  expect(html).toContain(
    '<p class="repository-state">Reading the repository.</p>',
  );
  expect(html).toContain(
    '<p class="repository-state" data-problem="missing">The repository is no longer at this path.</p>',
  );
  expect(html.match(/Not watching for file changes\./g)).toHaveLength(1);
});

test("a refusal message is announced, and the button is disabled while busy", () => {
  const html = render({
    busy: true,
    message: "The selected folder is not a Git repository.",
  });

  expect(html).toContain(
    '<button type="button" class="panel-action" disabled="">Add a repository</button>',
  );
  expect(html).toContain(
    '<p class="panel-message" role="alert">The selected folder is not a Git repository.</p>',
  );
});

test("without the bridge, the panel says repositories are not available and offers nothing", () => {
  const html = render({ view: { kind: "unavailable" } });

  expect(html).toContain("<p>Repositories are not available.</p>");
  expect(html).not.toContain("Add a repository");
});

test("the open project's repositories come first, between the panel's title and this device's repositories", () => {
  const html = render({
    project: <p id="project-part">The project's part</p>,
  });

  expect(html).toContain(
    '<h2 id="panel-title">Repositories</h2><p id="project-part">The project&#x27;s part</p><section class="repository-section" aria-labelledby="device-repositories-title">',
  );
  // Without it, the panel goes on with this device's repositories.
  expect(render()).toContain(
    '<h2 id="panel-title">Repositories</h2><section class="repository-section"',
  );
});

// The project's repositories that the project panel holds (#310).

const PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a2";

/** Handlers that do nothing; the panel only renders here. */
const HANDLERS: ProjectRepositoryHandlers = {
  onStart: () => undefined,
  onChoose: () => undefined,
  onConfirm: () => undefined,
  onCancel: () => undefined,
  onRegisterDraft: () => undefined,
  onRegister: () => undefined,
};

/** The controls of a ready project with one repository and `actions`. */
function controls(
  mounts: RepositoryPanelView,
  actions: Partial<ProjectRepositoriesControls["actions"]>,
): ProjectRepositoriesControls {
  const state = {
    revision: 1,
    status: "ready",
    workspaceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a1",
    projectId: PROJECT,
    links: "ready",
    repositories: [
      {
        repositoryId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b1",
        name: "app",
        linked: false,
        mountId: null,
        // Who may remove a repository (#309); a required field once it
        // merges.
        removable: true,
      },
    ],
  } as ProjectRepositoriesView;
  return {
    model: describeProjectRepositories(
      { kind: "known", state },
      mounts,
      PROJECT,
    ),
    actions: { ...IDLE_PROJECT_REPOSITORY_ACTIONS, ...actions },
    handlers: HANDLERS,
  };
}

test("after a switch back to the repositories tab, the panel shows what the project panel kept: the action that runs holds every button, with its sentence and the name typed, and an answer that came meanwhile shows its sentence (#310)", () => {
  const mounts: RepositoryPanelView = { kind: "known", list: listOf(READY) };
  const running = renderToString(
    <RepositoryPanel
      repositories={undefined}
      mounts={mounts}
      project={controls(mounts, {
        running: true,
        message: PROJECT_REPOSITORY_MESSAGES.linkWaiting,
        registerDraft: "docs",
      })}
    />,
  );
  expect(running).toContain(
    `<p class="repository-status" id="project-repository-message" role="status">${PROJECT_REPOSITORY_MESSAGES.linkWaiting}</p>`,
  );
  expect(running).toContain('spellCheck="false" readOnly=""');
  expect(running).toContain('value="docs"');
  expect(running).toContain(
    '<button type="submit" class="panel-action" aria-disabled="true">Register</button>',
  );
  expect(running).toContain(
    '<button type="button" class="panel-action" aria-describedby="project-repository-name-0" aria-disabled="true">Link to a folder</button>',
  );
  // The mount list that the project panel follows shows below.
  expect(running).toContain("<code>/home/user/project</code>");

  const answered = renderToString(
    <RepositoryPanel
      repositories={undefined}
      mounts={mounts}
      project={controls(mounts, {
        message: PROJECT_REPOSITORY_DONE_MESSAGES.register,
      })}
    />,
  );
  expect(answered).toContain(
    `<p class="repository-status" id="project-repository-message" role="status">${PROJECT_REPOSITORY_DONE_MESSAGES.register}</p>`,
  );
  expect(answered).toContain('value=""');
  expect(answered).not.toContain('aria-disabled="true"');
});

// The panel's wiring, which needs a DOM to run.

const SOURCES = import.meta.glob<string>("./RepositoryPanel.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});

test("the panel shows the mount list and the project's repositories that the project panel passes in, with their part above this device's repositories, and follows neither itself (#310)", () => {
  const code = (SOURCES["./RepositoryPanel.tsx"] ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/,? \)/g, ")");
  const start = code.indexOf("export function RepositoryPanel(");
  const end = code.indexOf("export interface RepositoryPanelContentProps");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const panel = code.slice(start, end);
  expect(panel).toContain(
    "const actions = useMountActions(repositories); return (<RepositoryPanelContent view={mounts} {...actions} project={<ProjectRepositoriesPart {...project} />} />); }",
  );
  // Neither the project's repositories nor the mount list is followed here.
  expect(panel).not.toMatch(/useProjectRepositories|useMountList|subscribe/);
  expect(code).not.toContain("useProjectRepositories");
  // The mount list's subscription passes each list on, and a refusal.
  expect(code).toContain(
    'useEffect(() => { if (bridge === undefined) { return undefined; } return bridge.subscribe((list) => setView({ kind: "known", list }), () => setView({ kind: "unavailable" })); }, [bridge]); return view; }',
  );
});

test("names, paths, branches, and URLs are rendered as text, not as markup", () => {
  const ready = READY.state;
  if (ready.kind !== "ready") {
    throw new Error("expected a ready state");
  }
  const html = render({
    view: {
      kind: "known",
      list: listOf({
        ...READY,
        name: "<b>name</b>",
        path: '/tmp/<img src="x">',
        state: {
          ...ready,
          branch: { ...ready.branch, name: "<script>x</script>" },
          remotes: [
            { name: "<i>origin</i>", fetchUrl: "<a href=x>", pushUrl: null },
          ],
        },
      }),
    },
  });

  expect(html).not.toMatch(/<(?:b|img|script|i|a)[\s>]/);
  expect(html).toContain("&lt;b&gt;name&lt;/b&gt;");
  expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
});
