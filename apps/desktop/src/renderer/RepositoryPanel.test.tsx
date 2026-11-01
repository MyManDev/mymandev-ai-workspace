import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type {
  MountedRepository,
  RepositoryList,
} from "../shared/ipc-contract.ts";
import {
  RepositoryPanelContent,
  type RepositoryPanelContentProps,
} from "./RepositoryPanel.tsx";

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

  expect(html).toContain('<h2 id="panel-title">Repositories</h2>');
  expect(html).toContain(
    '<button type="button" class="panel-action">Add a repository</button>',
  );
  expect(html).toContain("<p>No repositories yet.</p>");
  expect(html).toContain("nothing in their folders is changed");
  expect(html).not.toContain('role="alert"');
});

test("a mounted repository shows its path, branch, upstream, changes, and remotes", () => {
  const html = render({ view: { kind: "known", list: listOf(READY) } });

  expect(html).toContain(
    '<ul class="repository-list" aria-labelledby="panel-title">',
  );
  expect(html).toContain('<h3 class="repository-name">project</h3>');
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
