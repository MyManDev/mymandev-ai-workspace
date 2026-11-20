import { expect, test } from "vitest";
import type { ProjectRepositoriesBridge } from "../shared/desktop-bridge.ts";
import {
  LINK_REPOSITORY_REFUSALS,
  PROJECT_REPOSITORY_LIMITS,
  PROJECT_REPOSITORY_PROBLEMS,
  REGISTER_REPOSITORY_REFUSALS,
  REMOVE_REPOSITORY_REFUSALS,
  UNLINK_REPOSITORY_REFUSALS,
  type LinkRepositoryResult,
  type MountedRepository,
  type ProjectRepositoriesView,
  type ProjectRepositoryView,
  type RegisterRepositoryResult,
  type RemoveRepositoryResult,
  type UnlinkRepositoryResult,
} from "../shared/ipc-contract.ts";
import {
  createProjectRepositoryActions,
  describeLinkResult,
  describeProjectRepositories,
  describeRegisterResult,
  describeRemoveResult,
  describeUnlinkResult,
  folderChoices,
  followProjectRepositories,
  IDLE_PROJECT_REPOSITORY_ACTIONS,
  initialFolderChoice,
  initialProjectRepositoriesView,
  LINK_REPOSITORY_REFUSAL_MESSAGES,
  linkOffered,
  MAX_REPOSITORY_NAME_LENGTH,
  PROJECT_REPOSITORY_DONE_MESSAGES,
  PROJECT_REPOSITORY_MESSAGES,
  PROJECT_REPOSITORY_PROBLEM_MESSAGES,
  PROJECT_REPOSITORY_QUESTION_MESSAGES,
  PROJECT_REPOSITORY_UNKNOWN_MESSAGES,
  REGISTER_REPOSITORY_REFUSAL_MESSAGES,
  REMOVE_REPOSITORY_REFUSAL_MESSAGES,
  repositoryActions,
  repositoryNamePrompt,
  repositoryNameToSend,
  UNLINK_REPOSITORY_REFUSAL_MESSAGES,
  type ProjectRepositoriesModel,
  type ProjectRepositoriesPanelView,
  type ProjectRepositoryActionsView,
  type RepositoryActionRequest,
} from "./project-repositories-view.ts";
import type { RepositoryPanelView } from "./repository-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a1";
const PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a2";
const OTHER_PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const REPOSITORY_A = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b1";
const REPOSITORY_B = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b2";
const MOUNT_1 = "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b71";
const MOUNT_2 = "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b72";
const MOUNT_3 = "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b73";

function repository(
  repositoryId: string,
  name: string,
  mountId: string | null = null,
  linked = mountId !== null,
  removable = true,
): ProjectRepositoryView {
  return { repositoryId, name, linked, mountId, removable };
}

const A = repository(REPOSITORY_A, "app");
const B = repository(REPOSITORY_B, "docs");

function state(
  overrides: Partial<ProjectRepositoriesView> = {},
): ProjectRepositoriesView {
  return {
    revision: 1,
    status: "ready",
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    links: "ready",
    repositories: [A, B],
    ...overrides,
  } as ProjectRepositoriesView;
}

function known(
  overrides: Partial<ProjectRepositoriesView> = {},
): ProjectRepositoriesPanelView {
  return { kind: "known", state: state(overrides) };
}

function mount(mountId: string, name: string, path: string): MountedRepository {
  return { mountId, name, path, watching: true, state: { kind: "loading" } };
}

function mounts(...repositories: MountedRepository[]): RepositoryPanelView {
  return { kind: "known", list: { revision: 1, repositories } };
}

const MOUNTS = mounts(
  mount(MOUNT_1, "app", "/home/ada/app"),
  mount(MOUNT_2, "docs", "/home/ada/docs"),
  mount(MOUNT_3, "app", "/home/ada/old/app"),
);

function model(
  view: ProjectRepositoriesPanelView = known(),
  mountView: RepositoryPanelView = MOUNTS,
  projectId: string = PROJECT,
): ProjectRepositoriesModel {
  return describeProjectRepositories(view, mountView, projectId);
}

function request(
  kind: RepositoryActionRequest["kind"],
  target: ProjectRepositoryView = A,
): RepositoryActionRequest {
  return {
    kind,
    projectId: PROJECT,
    repositoryId: target.repositoryId,
    name: target.name,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A bridge whose answers the test settles, recording every call as text. */
function fakeBridge() {
  const calls: string[] = [];
  const answers = {
    register: deferred<RegisterRepositoryResult>(),
    remove: deferred<RemoveRepositoryResult>(),
    link: deferred<LinkRepositoryResult>(),
    unlink: deferred<UnlinkRepositoryResult>(),
  };
  const bridge: Pick<
    ProjectRepositoriesBridge,
    "register" | "remove" | "link" | "unlink"
  > = {
    register: (projectId, name) => {
      calls.push(`register ${projectId} ${name}`);
      return answers.register.promise;
    },
    remove: (projectId, repositoryId) => {
      calls.push(`remove ${projectId} ${repositoryId}`);
      return answers.remove.promise;
    },
    link: (repositoryId, mountId) => {
      calls.push(`link ${repositoryId} ${mountId}`);
      return answers.link.promise;
    },
    unlink: (repositoryId) => {
      calls.push(`unlink ${repositoryId}`);
      return answers.unlink.promise;
    },
  };
  return { bridge, calls, answers };
}

/** A controller on a fake bridge that follows `start` at once. */
function controllerWith(start: ProjectRepositoriesModel = model()) {
  const fake = fakeBridge();
  const views: ProjectRepositoryActionsView[] = [];
  const actions = createProjectRepositoryActions(fake.bridge, (view) =>
    views.push(view),
  );
  actions.follow(start);
  const last = () => views.at(-1) ?? IDLE_PROJECT_REPOSITORY_ACTIONS;
  return { ...fake, actions, views, last };
}

// The texts.

test("the longest name matches the contract's", () => {
  expect(MAX_REPOSITORY_NAME_LENGTH).toBe(PROJECT_REPOSITORY_LIMITS.name);
});

test("every problem of the contract has a fixed text, and no other", () => {
  expect(Object.keys(PROJECT_REPOSITORY_PROBLEM_MESSAGES).sort()).toEqual(
    [...PROJECT_REPOSITORY_PROBLEMS].sort(),
  );
});

test("every refusal of the contract has a fixed text, the waits included, and no other", () => {
  const withWaits = (keys: string[]) =>
    keys
      .map((key) =>
        key === "tooSoon"
          ? "too_soon"
          : key === "rateLimited"
            ? "rate_limited"
            : key,
      )
      .sort();
  expect(withWaits(Object.keys(REGISTER_REPOSITORY_REFUSAL_MESSAGES))).toEqual(
    [...REGISTER_REPOSITORY_REFUSALS].sort(),
  );
  expect(withWaits(Object.keys(REMOVE_REPOSITORY_REFUSAL_MESSAGES))).toEqual(
    [...REMOVE_REPOSITORY_REFUSALS].sort(),
  );
  expect(Object.keys(LINK_REPOSITORY_REFUSAL_MESSAGES).sort()).toEqual(
    [...LINK_REPOSITORY_REFUSALS].sort(),
  );
  expect(Object.keys(UNLINK_REPOSITORY_REFUSAL_MESSAGES).sort()).toEqual(
    [...UNLINK_REPOSITORY_REFUSALS].sort(),
  );
});

test("a registration's answer: done, unknown, and each refusal after the start, with the waits and the limits", () => {
  expect(
    describeRegisterResult({ outcome: "ok", repositoryId: REPOSITORY_A }),
  ).toBe(
    "The repository was registered. It shows in the list once the server reports it.",
  );
  expect(describeRegisterResult({ outcome: "unknown" })).toBe(
    PROJECT_REPOSITORY_UNKNOWN_MESSAGES.register,
  );
  expect(PROJECT_REPOSITORY_UNKNOWN_MESSAGES.register).toContain(
    "the request is not sent again on its own",
  );
  for (const reason of REGISTER_REPOSITORY_REFUSALS) {
    const retryAfterMs =
      reason === "too_soon"
        ? 1_500
        : reason === "rate_limited"
          ? 7_200_000
          : null;
    const sentence = describeRegisterResult({
      outcome: "refused",
      reason,
      retryAfterMs,
    });
    expect(
      sentence.startsWith("The repository could not be registered. "),
      reason,
    ).toBe(true);
  }
  expect(
    describeRegisterResult({
      outcome: "refused",
      reason: "too_soon",
      retryAfterMs: 1_500,
    }),
  ).toBe(
    "The repository could not be registered. This device sent many changes in a short time. Try again in 2 seconds.",
  );
  expect(
    describeRegisterResult({
      outcome: "refused",
      reason: "rate_limited",
      retryAfterMs: 7_200_000,
    }),
  ).toBe(
    "The repository could not be registered. The server asked to wait. Try again in 2 hours. An account registers at most 20 repositories in 24 hours.",
  );
  // A full project names no wait, because only a removal helps, and no number.
  expect(
    describeRegisterResult({
      outcome: "refused",
      reason: "repository_limit",
      retryAfterMs: null,
    }),
  ).toBe(
    "The repository could not be registered. This project already has as many repositories as it allows. A repository has to be removed first.",
  );
  expect(
    describeRegisterResult({
      outcome: "refused",
      reason: "invalid",
      retryAfterMs: null,
    }),
  ).toContain("without line breaks, a slash, or a backslash");
});

test("a removal's answer: done, unknown, and each refusal, with who may remove a repository", () => {
  expect(describeRemoveResult({ outcome: "ok" })).toBe(
    "The repository was removed from the project.",
  );
  expect(describeRemoveResult({ outcome: "unknown" })).toBe(
    PROJECT_REPOSITORY_UNKNOWN_MESSAGES.remove,
  );
  for (const reason of REMOVE_REPOSITORY_REFUSALS) {
    const retryAfterMs =
      reason === "too_soon" || reason === "rate_limited" ? 90_000 : null;
    expect(
      describeRemoveResult({
        outcome: "refused",
        reason,
        retryAfterMs,
      }).startsWith("The repository could not be removed. "),
      reason,
    ).toBe(true);
  }
  expect(
    describeRemoveResult({
      outcome: "refused",
      reason: "forbidden",
      retryAfterMs: null,
    }),
  ).toBe(
    "The repository could not be removed. Only the person who registered it, the workspace's owner, and its admins can remove it.",
  );
  expect(
    describeRemoveResult({
      outcome: "refused",
      reason: "rate_limited",
      retryAfterMs: 90_000,
    }),
  ).toBe(
    "The repository could not be removed. The server asked to wait. Try again in 2 minutes.",
  );
  expect(
    describeRemoveResult({
      outcome: "refused",
      reason: "conflict",
      retryAfterMs: null,
    }),
  ).toContain("The list is read again.");
});

test("a link's answer reads naturally after the confirmation dialog was cancelled or closed and while another confirmation is open", () => {
  expect(describeLinkResult({ outcome: "linked" })).toBe(
    PROJECT_REPOSITORY_DONE_MESSAGES.link,
  );
  expect(describeLinkResult({ outcome: "refused", reason: "cancelled" })).toBe(
    "The repository was not linked. The confirmation dialog was cancelled or closed. Nothing changed.",
  );
  expect(describeLinkResult({ outcome: "refused", reason: "busy" })).toBe(
    "The repository was not linked. A confirmation of another link is open, or one was cancelled a moment ago. Answer that dialog or wait a few seconds, then try again.",
  );
  // A folder inside, or around, another linked folder (#302) says which
  // link to undo.
  expect(
    describeLinkResult({ outcome: "refused", reason: "nested_link" }),
  ).toBe(
    "The repository was not linked. This folder is inside, or contains, a folder that you linked to another repository, perhaps of another project. Unlink that repository first.",
  );
  for (const reason of LINK_REPOSITORY_REFUSALS) {
    expect(describeLinkResult({ outcome: "refused", reason })).toBe(
      `The repository was not linked. ${LINK_REPOSITORY_REFUSAL_MESSAGES[reason]}`,
    );
  }
});

test("an unlink's answer", () => {
  expect(describeUnlinkResult({ outcome: "unlinked" })).toBe(
    "The repository was unlinked. Its folder stays as it is.",
  );
  expect(
    describeUnlinkResult({ outcome: "refused", reason: "not_linked" }),
  ).toBe(
    "The repository could not be unlinked. The repository is not linked on this device.",
  );
});

// The name.

test("a name is trimmed, and checked for emptiness, its length in characters, and a slash or a backslash before it is sent", () => {
  expect(repositoryNameToSend("  app \t")).toBe("app");
  // Not normalized: the protocol stores a repository's name as sent.
  expect(repositoryNameToSend("Cafe\u0301")).toBe("Cafe\u0301");
  expect(repositoryNamePrompt("")).toBe(
    PROJECT_REPOSITORY_MESSAGES.nameMissing,
  );
  expect(repositoryNamePrompt("a".repeat(100))).toBeUndefined();
  expect(repositoryNamePrompt("a".repeat(101))).toBe(
    PROJECT_REPOSITORY_MESSAGES.nameTooLong,
  );
  // 100 emoji are 200 code units but 100 characters.
  expect(repositoryNamePrompt("\u{1F600}".repeat(100))).toBeUndefined();
  expect(repositoryNamePrompt("\u{1F600}".repeat(101))).toBe(
    PROJECT_REPOSITORY_MESSAGES.nameTooLong,
  );
  expect(PROJECT_REPOSITORY_MESSAGES.nameTooLong).toBe(
    "A name has at most 100 characters.",
  );
  for (const name of ["C:\\work\\app", "/home/ada/app", "team/app", "a\\b"]) {
    expect(repositoryNamePrompt(name), name).toBe(
      PROJECT_REPOSITORY_MESSAGES.nameSlash,
    );
  }
  expect(repositoryNamePrompt("app-2 (main)")).toBeUndefined();
});

// What the panel shows.

test("without the bridge, before the first state, without a project, and for another project's state, only a fixed text shows and nothing is offered", () => {
  const cases: [ProjectRepositoriesPanelView, string][] = [
    [
      initialProjectRepositoriesView(false),
      PROJECT_REPOSITORY_MESSAGES.unavailable,
    ],
    [initialProjectRepositoriesView(true), PROJECT_REPOSITORY_MESSAGES.pending],
    [
      known({
        status: "no_project",
        workspaceId: null,
        projectId: null,
        repositories: [],
      }),
      PROJECT_REPOSITORY_MESSAGES.noProject,
    ],
    // Another project's repositories never show here.
    [known({ projectId: OTHER_PROJECT }), PROJECT_REPOSITORY_MESSAGES.loading],
  ];
  for (const [view, status] of cases) {
    const shown = model(view);
    expect(shown, status).toEqual({
      scope: null,
      status,
      linksNote: "",
      rows: null,
      projectId: null,
      linksProjectId: null,
      folders: shown.folders,
    });
  }
  // The project's own first load has its scope already.
  const loading = model(known({ status: "loading", repositories: [] }));
  expect(loading.status).toBe(PROJECT_REPOSITORY_MESSAGES.loading);
  expect(loading.scope).toBe(`${WORKSPACE}/${PROJECT}`);
  expect(loading.rows).toBeNull();
  expect(loading.projectId).toBeNull();
});

test("a ready list shows each repository and where it is linked, and offers the actions", () => {
  const linkedHere = repository(REPOSITORY_A, "app", MOUNT_1);
  const linkedNotListed = repository(
    REPOSITORY_B,
    "docs",
    "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b7f",
  );
  const linkedElsewhere = repository(
    "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b3",
    "site",
    null,
    true,
  );
  const plain = repository("0192f2a0-7c3e-7a1b-8c4d-5e6f708192b4", "tools");
  const shown = model(
    known({
      repositories: [linkedHere, linkedNotListed, linkedElsewhere, plain],
    }),
  );

  expect(shown.status).toBe("");
  expect(shown.linksNote).toBe("");
  expect(shown.projectId).toBe(PROJECT);
  expect(shown.linksProjectId).toBe(PROJECT);
  expect(linkOffered(shown)).toBe(true);
  expect(shown.rows?.map((row) => [row.name, row.link])).toEqual([
    [
      "app",
      {
        kind: "folder",
        folder: { mountId: MOUNT_1, name: "app", path: "/home/ada/app" },
      },
    ],
    // A mount that the mount list does not hold yet.
    ["docs", { kind: "mounted" }],
    ["site", { kind: "not_mounted" }],
    ["tools", { kind: "not_linked" }],
  ]);
  // The main process's order.
  expect(shown.folders?.map((folder) => folder.mountId)).toEqual([
    MOUNT_1,
    MOUNT_2,
    MOUNT_3,
  ]);
});

test("each row offers its actions: Link and Remove while the list is ready, Unlink on a linked repository while the links are ready, whatever the list's state", () => {
  const linked = repository(REPOSITORY_A, "app", MOUNT_1);
  const kindsOf = (shown: ProjectRepositoriesModel) =>
    (shown.rows ?? []).map((row) =>
      repositoryActions(shown, row).map(
        (action) => `${action.kind} ${action.projectId} ${action.name}`,
      ),
    );
  const repositories = [linked, B];
  expect(kindsOf(model(known({ repositories })))).toEqual([
    [`link ${PROJECT} app`, `unlink ${PROJECT} app`, `remove ${PROJECT} app`],
    [`link ${PROJECT} docs`, `remove ${PROJECT} docs`],
  ]);
  // The repository's ID goes with each request.
  const [first] = model(known({ repositories })).rows ?? [];
  expect(
    first === undefined
      ? []
      : repositoryActions(model(known({ repositories })), first).map(
          (action) => action.repositoryId,
        ),
  ).toEqual([REPOSITORY_A, REPOSITORY_A, REPOSITORY_A]);
  // Each row carries whether the account may remove it, as the main
  // process said (#309).
  expect(
    model(
      known({ repositories: [linked, { ...B, removable: false }] }),
    ).rows?.map((row) => row.removable),
  ).toEqual([true, false]);
  // Without the mount list, no link.
  expect(kindsOf(model(known({ repositories }), { kind: "pending" }))).toEqual([
    [`unlink ${PROJECT} app`, `remove ${PROJECT} app`],
    [`remove ${PROJECT} docs`],
  ]);
  // An unavailable list keeps Unlink while the links are ready: the main
  // process's unlink needs only the links.
  for (const problem of PROJECT_REPOSITORY_PROBLEMS) {
    const shown = model(
      known({ status: "unavailable", problem, repositories }),
    );
    expect(shown.linksProjectId, problem).toBe(PROJECT);
    expect(kindsOf(shown), problem).toEqual([[`unlink ${PROJECT} app`], []]);
  }
  // Without ready links, an unavailable list offers nothing.
  for (const links of ["loading", "unavailable"] as const) {
    const shown = model(
      known({ status: "unavailable", problem: "failed", links, repositories }),
    );
    expect(shown.linksProjectId, links).toBeNull();
    expect(kindsOf(shown), links).toEqual([[], []]);
  }
});

test("Remove from the project only on a repository that the account may remove, which the main process said (#309); the other actions stay", () => {
  const kindsOf = (shown: ProjectRepositoriesModel) =>
    (shown.rows ?? []).map((row) =>
      repositoryActions(shown, row).map((action) => action.kind),
    );
  const linked = repository(REPOSITORY_A, "app", MOUNT_1, true, false);
  const plain = repository(REPOSITORY_B, "docs", null, false, false);
  expect(kindsOf(model(known({ repositories: [linked, plain] })))).toEqual([
    ["link", "unlink"],
    ["link"],
  ]);
  expect(
    kindsOf(
      model(known({ repositories: [linked, { ...plain, removable: true }] })),
    ),
  ).toEqual([
    ["link", "unlink"],
    ["link", "remove"],
  ]);
  // A removable repository of a list that is not ready offers no removal
  // either.
  expect(
    kindsOf(
      model(
        known({
          status: "unavailable",
          problem: "failed",
          repositories: [{ ...linked, removable: true }],
        }),
      ),
    ),
  ).toEqual([["unlink"]]);
});

test("an empty ready list says so and still offers the registration", () => {
  const shown = model(known({ repositories: [] }));
  expect(shown.status).toBe(
    "No repositories are registered in this project yet.",
  );
  expect(shown.rows).toEqual([]);
  expect(shown.projectId).toBe(PROJECT);
});

test("while this device's links load or cannot be read, no link shows, a note says why, and neither linking nor unlinking is offered", () => {
  for (const [links, note] of [
    ["loading", PROJECT_REPOSITORY_MESSAGES.linksLoading],
    ["unavailable", PROJECT_REPOSITORY_MESSAGES.linksUnavailable],
  ] as const) {
    const shown = model(
      known({
        links,
        repositories: [repository(REPOSITORY_A, "app", MOUNT_1)],
      }),
    );
    expect(shown.linksNote, links).toBe(note);
    expect(shown.rows?.[0]?.link, links).toBeNull();
    expect(shown.linksProjectId, links).toBeNull();
    expect(linkOffered(shown), links).toBe(false);
    // Removing and registering stay offered.
    expect(shown.projectId, links).toBe(PROJECT);
    const [row] = shown.rows ?? [];
    expect(
      row === undefined
        ? []
        : repositoryActions(shown, row).map((action) => action.kind),
      links,
    ).toEqual(["remove"]);
  }
});

test("without the mount list, linking is not offered, but unlinking is", () => {
  for (const mountView of [
    { kind: "pending" },
    { kind: "unavailable" },
  ] as const) {
    const shown = model(known(), mountView);
    expect(shown.folders).toBeNull();
    expect(shown.linksProjectId).toBe(PROJECT);
    expect(linkOffered(shown)).toBe(false);
  }
});

test("an unavailable list shows its problem with what was loaded before and offers nothing but Unlink", () => {
  for (const problem of PROJECT_REPOSITORY_PROBLEMS) {
    const shown = model(known({ status: "unavailable", problem }));
    expect(shown.status, problem).toBe(
      PROJECT_REPOSITORY_PROBLEM_MESSAGES[problem],
    );
    expect(
      shown.rows?.map((row) => row.name),
      problem,
    ).toEqual(["app", "docs"]);
    expect(shown.projectId, problem).toBeNull();
    expect(linkOffered(shown), problem).toBe(false);
  }
  // Without anything loaded, only the problem shows.
  expect(
    model(known({ status: "unavailable", problem: "failed", repositories: [] }))
      .rows,
  ).toBeNull();
});

test("the folders to link: the mount list's, without one that another repository of this project is linked to, and with the repository's own", () => {
  const shown = model(
    known({
      repositories: [
        repository(REPOSITORY_A, "app", MOUNT_1),
        repository(REPOSITORY_B, "docs", MOUNT_2),
      ],
    }),
  );
  expect(
    folderChoices(shown, REPOSITORY_A).map((folder) => folder.mountId),
  ).toEqual([MOUNT_1, MOUNT_3]);
  expect(
    folderChoices(shown, REPOSITORY_B).map((folder) => folder.mountId),
  ).toEqual([MOUNT_2, MOUNT_3]);
  expect(
    folderChoices(model(known(), { kind: "pending" }), REPOSITORY_A),
  ).toEqual([]);
});

test("the folder chosen at first is the only one with the repository's exact name, else none", () => {
  const choices = folderChoices(model(), REPOSITORY_A);
  expect(initialFolderChoice("docs", choices)).toBe(MOUNT_2);
  // Two folders are named "app": the person chooses.
  expect(initialFolderChoice("app", choices)).toBeNull();
  expect(initialFolderChoice("app", choices.slice(0, 2))).toBe(MOUNT_1);
  // Only the exact name.
  expect(initialFolderChoice("Docs", choices)).toBeNull();
  expect(initialFolderChoice("site", choices)).toBeNull();
  expect(initialFolderChoice("app", [])).toBeNull();
});

test("the subscription reports every state and a refusal", () => {
  const views: ProjectRepositoriesPanelView[] = [];
  let listener: ((value: ProjectRepositoriesView) => void) | undefined;
  let refuse: (() => void) | undefined;
  const stop = followProjectRepositories(
    {
      subscribeState: (onState, onError) => {
        listener = onState;
        refuse = onError;
        return () => views.push({ kind: "pending" });
      },
    },
    (view) => views.push(view),
  );
  listener?.(state());
  refuse?.();
  stop();
  expect(views).toEqual([
    { kind: "known", state: state() },
    { kind: "unavailable" },
    { kind: "pending" },
  ]);
});

// The actions.

test("a removal asks first and sends once after the confirmation", async () => {
  const { actions, calls, answers, last } = controllerWith();
  await actions.start(request("remove"));
  expect(calls).toEqual([]);
  expect(last().dialog).toEqual({ kind: "remove", request: request("remove") });

  const done = actions.confirm();
  expect(last().dialog).toBeUndefined();
  expect(last().running).toBe(true);
  expect(calls).toEqual([`remove ${PROJECT} ${REPOSITORY_A}`]);
  answers.remove.resolve({ outcome: "ok" });
  await done;
  expect(last()).toEqual({
    ...IDLE_PROJECT_REPOSITORY_ACTIONS,
    message: "The repository was removed from the project.",
  });
  // A confirmation without a question sends nothing.
  await actions.confirm();
  expect(calls).toHaveLength(1);
});

test("a cancelled question sends nothing", async () => {
  const { actions, calls, last } = controllerWith();
  await actions.start(request("remove"));
  actions.cancel();
  expect(last().dialog).toBeUndefined();
  await actions.confirm();
  expect(calls).toEqual([]);
});

test("a refused removal says why", async () => {
  const { actions, answers, last } = controllerWith();
  await actions.start(request("remove"));
  const done = actions.confirm();
  answers.remove.resolve({
    outcome: "refused",
    reason: "forbidden",
    retryAfterMs: null,
  });
  await done;
  expect(last().message).toBe(
    "The repository could not be removed. Only the person who registered it, the workspace's owner, and its admins can remove it.",
  );
});

test("a link asks for the folder first, among the folders of the latest model, with the only one of the repository's name chosen", async () => {
  const { actions, calls, last } = controllerWith();
  await actions.start(request("link", B));
  expect(calls).toEqual([]);
  const dialog = last().dialog;
  expect(dialog?.kind).toBe("link");
  if (dialog?.kind !== "link") {
    return;
  }
  expect(dialog.choices.map((choice) => choice.mountId)).toEqual([
    MOUNT_1,
    MOUNT_2,
    MOUNT_3,
  ]);
  expect(dialog.mountId).toBe(MOUNT_2);
  expect(dialog.problem).toBeUndefined();
  // Two folders are named "app", so none is chosen for "app".
  const twice = controllerWith();
  await twice.actions.start(request("link"));
  const asked = twice.last().dialog;
  expect(asked?.kind === "link" ? asked.mountId : undefined).toBeNull();
});

test("the folder chosen at first is among the folders offered: a folder with the repository's name that another repository is linked to is not chosen", async () => {
  const chosenFor = async (shown: ProjectRepositoriesModel) => {
    const { actions, last } = controllerWith(shown);
    await actions.start(request("link"));
    const dialog = last().dialog;
    return dialog?.kind === "link" ? dialog.mountId : undefined;
  };
  // "docs" is linked to the first "app" folder: the other one is the only
  // one offered with the name.
  const linkedToFirst = known({
    repositories: [A, repository(REPOSITORY_B, "docs", MOUNT_1)],
  });
  expect(await chosenFor(model(linkedToFirst))).toBe(MOUNT_3);
  // With one "app" folder, linked to "docs", none is chosen.
  expect(
    await chosenFor(
      model(
        linkedToFirst,
        mounts(
          mount(MOUNT_1, "app", "/home/ada/app"),
          mount(MOUNT_2, "docs", "/home/ada/docs"),
        ),
      ),
    ),
  ).toBeNull();
});

test("a link without a chosen folder sends nothing and says to choose one, until a folder is chosen", async () => {
  const { actions, calls, last } = controllerWith();
  await actions.start(request("link", repository(REPOSITORY_B, "site")));
  const opened = last().dialog;
  expect(opened?.kind === "link" ? opened.mountId : "no dialog").toBeNull();

  await actions.confirm();
  expect(calls).toEqual([]);
  const asked = last().dialog;
  expect(asked?.kind === "link" ? asked.problem : undefined).toBe(
    "Choose a folder.",
  );
  // A mount that is not among the choices is not chosen.
  actions.choose("0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b7f");
  expect(last().dialog).toBe(asked);
  actions.choose(MOUNT_3);
  const chosen = last().dialog;
  expect(
    chosen?.kind === "link" ? [chosen.mountId, chosen.problem] : [],
  ).toEqual([MOUNT_3, undefined]);
});

test("a confirmed link asks the main process, which asks the person in its own dialog meanwhile, and says how it ended", async () => {
  const { actions, calls, answers, last } = controllerWith();
  await actions.start(request("link"));
  actions.choose(MOUNT_3);
  const done = actions.confirm();
  expect(calls).toEqual([`link ${REPOSITORY_A} ${MOUNT_3}`]);
  expect(last()).toEqual({
    ...IDLE_PROJECT_REPOSITORY_ACTIONS,
    running: true,
    message: "This device asks you to confirm the link in a dialog of its own.",
  });
  answers.link.resolve({ outcome: "refused", reason: "cancelled" });
  await done;
  expect(last().message).toBe(
    "The repository was not linked. The confirmation dialog was cancelled or closed. Nothing changed.",
  );
  expect(last().running).toBe(false);
});

test("a linked answer says so", async () => {
  const { actions, answers, last } = controllerWith();
  await actions.start(request("link"));
  actions.choose(MOUNT_1);
  const done = actions.confirm();
  answers.link.resolve({ outcome: "linked" });
  await done;
  expect(last().message).toBe(
    "The repository was linked to the folder on this device.",
  );
});

test("an unlink runs at once and says how it ended", async () => {
  const { actions, calls, answers, last } = controllerWith();
  const done = actions.start(request("unlink"));
  expect(calls).toEqual([`unlink ${REPOSITORY_A}`]);
  expect(last().running).toBe(true);
  expect(last().message).toBeUndefined();
  answers.unlink.resolve({ outcome: "unlinked" });
  await done;
  expect(last().message).toBe(PROJECT_REPOSITORY_DONE_MESSAGES.unlink);

  const refused = controllerWith();
  const kept = refused.actions.start(request("unlink"));
  refused.answers.unlink.resolve({ outcome: "refused", reason: "not_linked" });
  await kept;
  expect(refused.last().message).toBe(
    "The repository could not be unlinked. The repository is not linked on this device.",
  );
});

test("a new action ends the sentence of the last one, and a link says meanwhile that this device asks in its own dialog", async () => {
  const { actions, answers, last } = controllerWith();
  const unlinking = actions.start(request("unlink"));
  answers.unlink.resolve({ outcome: "unlinked" });
  await unlinking;
  expect(last().message).toBe(PROJECT_REPOSITORY_DONE_MESSAGES.unlink);
  actions.editRegisterDraft("site");
  const registering = actions.register(PROJECT);
  expect(last().running).toBe(true);
  expect(last().message).toBeUndefined();
  answers.register.resolve({ outcome: "unknown" });
  await registering;
  expect(last().message).toBe(PROJECT_REPOSITORY_UNKNOWN_MESSAGES.register);
  await actions.start(request("link"));
  actions.choose(MOUNT_1);
  const linking = actions.confirm();
  expect(last().message).toBe(PROJECT_REPOSITORY_MESSAGES.linkWaiting);
  answers.link.resolve({ outcome: "linked" });
  await linking;
});

test("a registration sends the trimmed name once, and empties the field only once the API confirmed it", async () => {
  const { actions, calls, answers, last } = controllerWith();
  actions.editRegisterDraft("  app  ");
  const done = actions.register(PROJECT);
  expect(calls).toEqual([`register ${PROJECT} app`]);
  expect(last().running).toBe(true);
  expect(last().registerDraft).toBe("  app  ");
  answers.register.resolve({ outcome: "ok", repositoryId: REPOSITORY_A });
  await done;
  expect(last().registerDraft).toBe("");
  expect(last().message).toBe(PROJECT_REPOSITORY_DONE_MESSAGES.register);
});

test("a refused or uncertain registration keeps the name", async () => {
  for (const answer of [
    { outcome: "refused", reason: "conflict", retryAfterMs: null },
    { outcome: "unknown" },
  ] as const) {
    const { actions, answers, last } = controllerWith();
    actions.editRegisterDraft("app");
    const done = actions.register(PROJECT);
    answers.register.resolve(answer);
    await done;
    expect(last().registerDraft, answer.outcome).toBe("app");
    expect(last().message, answer.outcome).toBe(describeRegisterResult(answer));
  }
});

test("a name that is empty, too long, or holds a slash or a backslash is not sent, and its problem shows until the name is edited", async () => {
  for (const [typed, problem] of [
    ["   ", PROJECT_REPOSITORY_MESSAGES.nameMissing],
    ["a".repeat(101), PROJECT_REPOSITORY_MESSAGES.nameTooLong],
    ["C:\\work\\app", PROJECT_REPOSITORY_MESSAGES.nameSlash],
  ] as const) {
    const { actions, calls, last } = controllerWith();
    actions.editRegisterDraft(typed);
    await actions.register(PROJECT);
    expect(calls, typed).toEqual([]);
    expect(last().registerProblem, typed).toBe(problem);
    actions.editRegisterDraft(`${typed}x`);
    expect(last().registerProblem, typed).toBeUndefined();
  }
});

test("one action at a time: while one runs, nothing else starts, opens, or is sent", async () => {
  const { actions, calls, answers, last } = controllerWith();
  const first = actions.start(request("unlink"));
  await actions.start(request("remove"));
  await actions.start(request("link"));
  await actions.start(request("unlink", B));
  actions.editRegisterDraft("docs");
  await actions.register(PROJECT);
  expect(last().dialog).toBeUndefined();
  expect(calls).toEqual([`unlink ${REPOSITORY_A}`]);
  answers.unlink.resolve({ outcome: "unlinked" });
  await first;
  // Once it ended, the next one starts.
  await actions.start(request("remove", B));
  expect(last().dialog?.kind).toBe("remove");
});

test("an action that starts while a question is open ends the question, which then sends nothing", async () => {
  const { actions, calls, answers, last } = controllerWith();
  await actions.start(request("remove"));
  actions.editRegisterDraft("docs");
  const registering = actions.register(PROJECT);
  expect(last().running).toBe(true);
  expect(last().dialog).toBeUndefined();
  await actions.confirm();
  expect(calls).toEqual([`register ${PROJECT} docs`]);
  answers.register.resolve({ outcome: "unknown" });
  await registering;
});

test("a call that fails on its way, also one that throws at once, says that nothing was sent", async () => {
  const { actions, answers, last } = controllerWith();
  const done = actions.start(request("unlink"));
  answers.unlink.reject(new Error("lost"));
  await done;
  expect(last().message).toBe(
    "The repository could not be unlinked. It was not sent. Try again.",
  );
  expect(last().running).toBe(false);

  const views: ProjectRepositoryActionsView[] = [];
  const throwing = createProjectRepositoryActions(
    {
      register: () => {
        throw new Error("at once");
      },
      remove: () => Promise.reject(new Error("unused")),
      link: () => Promise.reject(new Error("unused")),
      unlink: () => Promise.reject(new Error("unused")),
    },
    (view) => views.push(view),
  );
  throwing.follow(model());
  throwing.editRegisterDraft("app");
  await throwing.register(PROJECT);
  expect(views.at(-1)?.message).toBe(
    "The repository could not be registered. It was not sent. Try again.",
  );
  expect(views.at(-1)?.running).toBe(false);
});

test("the controller keeps a running action through every model of the same project, as the project panel follows them on either tab: no second registration starts, and the answer shows its sentence and empties the field (#310)", async () => {
  const { actions, calls, answers, last } = controllerWith();
  actions.editRegisterDraft("app");
  const done = actions.register(PROJECT);
  // A switch to the agents tab and back: the project panel renders again
  // and follows a new model of the same project each time.
  actions.follow(model());
  actions.follow(model(known(), { kind: "pending" }));
  actions.follow(model());
  expect(last().running).toBe(true);
  expect(last().registerDraft).toBe("app");
  await actions.register(PROJECT);
  await actions.start(request("remove"));
  expect(last().dialog).toBeUndefined();
  expect(calls).toEqual([`register ${PROJECT} app`]);
  answers.register.resolve({ outcome: "ok", repositoryId: REPOSITORY_A });
  await done;
  expect(last().running).toBe(false);
  expect(last().message).toBe(PROJECT_REPOSITORY_DONE_MESSAGES.register);
  expect(last().registerDraft).toBe("");
});

test("an action that runs holds the buttons through another project and back: while a registration of the project runs, opening another project and this one again lets no second registration start (#310)", async () => {
  const { actions, calls, answers, last } = controllerWith();
  actions.editRegisterDraft("app");
  const done = actions.register(PROJECT);
  // The shell shows another project, then this one again, before the
  // answer arrives; the project panel stays mounted and follows each.
  actions.follow(
    model(known({ projectId: OTHER_PROJECT }), MOUNTS, OTHER_PROJECT),
  );
  expect(last().running).toBe(true);
  actions.follow(model());
  expect(last().running).toBe(true);
  actions.editRegisterDraft("app");
  await actions.register(PROJECT);
  await actions.start(request("unlink"));
  await actions.start(request("remove"));
  expect(last().dialog).toBeUndefined();
  expect(calls).toEqual([`register ${PROJECT} app`]);
  answers.register.resolve({ outcome: "ok", repositoryId: REPOSITORY_A });
  await done;
  // The answer belongs to the earlier visit, so it shows no sentence and
  // leaves the name typed since alone; the action ended all the same.
  expect(last().running).toBe(false);
  expect(last().message).toBeUndefined();
  expect(last().registerDraft).toBe("app");
});

test("an answer that arrives after the shell showed another project shows no sentence, moves no focus, and leaves a name typed since alone", async () => {
  const { actions, answers, last } = controllerWith();
  actions.editRegisterDraft("app");
  const done = actions.register(PROJECT);
  // The shell shows another project; the main process still has this one.
  actions.follow(model(known(), MOUNTS, OTHER_PROJECT));
  actions.editRegisterDraft("docs");
  answers.register.resolve({ outcome: "ok", repositoryId: REPOSITORY_A });
  await done;
  expect(last().message).toBeUndefined();
  expect(last().registerDraft).toBe("docs");
  // The action ended all the same.
  expect(last().running).toBe(false);
});

test("an answer after a switch away and back, or after a sign-out and a sign-in, counts for nothing", async () => {
  const away: ProjectRepositoriesPanelView[] = [
    known({ projectId: OTHER_PROJECT }),
    known({
      status: "no_project",
      workspaceId: null,
      projectId: null,
      repositories: [],
    }),
    { kind: "pending" },
  ];
  for (const between of away) {
    const { actions, answers, last } = controllerWith();
    const done = actions.start(request("unlink"));
    actions.follow(model(between));
    actions.follow(model());
    answers.unlink.resolve({ outcome: "unlinked" });
    await done;
    expect(last().message, between.kind).toBeUndefined();
    expect(last().running, between.kind).toBe(false);
  }
});

test("a new scope ends the question, the name, its problem, and the sentence of the last action", async () => {
  const { actions, answers, last } = controllerWith();
  const done = actions.start(request("unlink"));
  answers.unlink.resolve({ outcome: "unlinked" });
  await done;
  actions.editRegisterDraft("C:\\app");
  await actions.register(PROJECT);
  await actions.start(request("remove"));
  expect(last().message).toBe(PROJECT_REPOSITORY_DONE_MESSAGES.unlink);
  expect(last().registerProblem).toBe(PROJECT_REPOSITORY_MESSAGES.nameSlash);
  expect(last().dialog?.kind).toBe("remove");

  // Another workspace with the same project ID is another scope as well.
  actions.follow(
    model(known({ workspaceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a9" })),
  );
  expect(last()).toEqual(IDLE_PROJECT_REPOSITORY_ACTIONS);
});

test("a new scope reports the end of a name's problem alone", async () => {
  const { actions, calls, last } = controllerWith();
  // An empty field: its problem is all there is.
  await actions.register(PROJECT);
  expect(calls).toEqual([]);
  expect(last()).toEqual({
    ...IDLE_PROJECT_REPOSITORY_ACTIONS,
    registerProblem: PROJECT_REPOSITORY_MESSAGES.nameMissing,
  });
  actions.follow(model(known(), MOUNTS, OTHER_PROJECT));
  expect(last()).toEqual(IDLE_PROJECT_REPOSITORY_ACTIONS);
});

test("a new state of the same project keeps the question, the name, and the sentence", async () => {
  const { actions, answers, last, views } = controllerWith();
  const done = actions.start(request("unlink"));
  answers.unlink.resolve({ outcome: "unlinked" });
  await done;
  actions.editRegisterDraft("docs");
  await actions.start(request("remove", B));
  const before = views.length;
  actions.follow(model(known({ revision: 2, repositories: [A, B] })));
  actions.follow(
    model(
      known({ revision: 3, status: "unavailable", problem: "unavailable" }),
    ),
  );
  actions.follow(model(known({ revision: 4 })));
  // An unavailable list ends the question (below), but not the rest.
  expect(last().message).toBe(PROJECT_REPOSITORY_DONE_MESSAGES.unlink);
  expect(last().registerDraft).toBe("docs");
  expect(views.length).toBe(before + 1);
});

test("nothing is reported when a model changes nothing of the actions", () => {
  const { actions, views } = controllerWith();
  const before = views.length;
  actions.follow(model(known({ revision: 2 })));
  actions.follow(model(known({ revision: 3 }), mounts()));
  expect(views.length).toBe(before);
});

test("a question ends once the panel no longer offers it as it was asked, and a later confirmation sends nothing", async () => {
  const ends: [
    string,
    RepositoryActionRequest["kind"],
    ProjectRepositoriesModel,
  ][] = [
    [
      "the repository left the list",
      "remove",
      model(known({ repositories: [B] })),
    ],
    [
      "the repository left the list",
      "link",
      model(known({ repositories: [B] })),
    ],
    [
      "the list is unavailable",
      "remove",
      model(known({ status: "unavailable", problem: "unavailable" })),
    ],
    [
      "the account may no longer remove the repository (#309)",
      "remove",
      model(known({ repositories: [{ ...A, removable: false }, B] })),
    ],
    ["the links are not ready", "link", model(known({ links: "loading" }))],
    [
      "the mount list is not known",
      "link",
      model(known(), { kind: "unavailable" }),
    ],
  ];
  for (const [why, kind, next] of ends) {
    const { actions, calls, last } = controllerWith();
    await actions.start(request(kind));
    expect(last().dialog?.kind, why).toBe(kind);
    actions.follow(next);
    expect(last().dialog, `${kind}: ${why}`).toBeUndefined();
    actions.follow(model());
    expect(last().dialog, `${kind}: ${why}`).toBeUndefined();
    await actions.confirm();
    expect(calls, why).toEqual([]);
  }
  // A removal's question stays while the links are not ready.
  const { actions, last } = controllerWith();
  await actions.start(request("remove"));
  actions.follow(model(known({ links: "unavailable" })));
  expect(last().dialog?.kind).toBe("remove");
  // A link's question stays when the account may no longer remove the
  // repository.
  const linking = controllerWith();
  await linking.actions.start(request("link"));
  linking.actions.follow(
    model(known({ repositories: [{ ...A, removable: false }, B] })),
  );
  expect(linking.last().dialog?.kind).toBe("link");
});

test("a removal's question does not open for a repository that the account may no longer remove, as a button of an earlier render asks, and a confirmation then sends nothing (#309)", async () => {
  const { actions, calls, last } = controllerWith(
    model(known({ repositories: [{ ...A, removable: false }, B] })),
  );
  await actions.start(request("remove"));
  expect(last().dialog).toBeUndefined();
  await actions.confirm();
  expect(calls).toEqual([]);
  // Another repository that the account may remove still asks.
  await actions.start(request("remove", B));
  expect(last().dialog?.kind).toBe("remove");
});

test("a link's folders follow the mount list: a new folder is offered, and a chosen folder that goes is no longer chosen", async () => {
  const { actions, calls, last } = controllerWith();
  await actions.start(request("link"));
  actions.choose(MOUNT_3);
  // A folder is added, and the chosen one stays chosen.
  const added = mounts(
    mount(MOUNT_1, "app", "/home/ada/app"),
    mount(MOUNT_2, "docs", "/home/ada/docs"),
    mount(MOUNT_3, "app", "/home/ada/old/app"),
    mount("0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b74", "site", "/home/ada/site"),
  );
  actions.follow(model(known(), added));
  let dialog = last().dialog;
  expect(dialog?.kind === "link" ? dialog.choices.length : 0).toBe(4);
  expect(dialog?.kind === "link" ? dialog.mountId : undefined).toBe(MOUNT_3);
  // Another repository is linked to the chosen folder meanwhile.
  actions.follow(
    model(
      known({ repositories: [A, repository(REPOSITORY_B, "docs", MOUNT_3)] }),
      added,
    ),
  );
  dialog = last().dialog;
  expect(dialog?.kind === "link" ? dialog.mountId : undefined).toBeNull();
  expect(
    dialog?.kind === "link"
      ? dialog.choices.map((choice) => choice.mountId)
      : [],
  ).not.toContain(MOUNT_3);
  // The chosen folder is unmounted: nothing is chosen, and nothing is sent.
  actions.choose(MOUNT_1);
  actions.follow(
    model(known(), mounts(mount(MOUNT_2, "docs", "/home/ada/docs"))),
  );
  dialog = last().dialog;
  expect(dialog?.kind === "link" ? dialog.mountId : undefined).toBeNull();
  await actions.confirm();
  expect(calls).toEqual([]);
});

test("a link's question with no folder to choose stays open and sends nothing", async () => {
  const { actions, calls, last } = controllerWith(model(known(), mounts()));
  await actions.start(request("link"));
  const dialog = last().dialog;
  expect(dialog?.kind === "link" ? dialog.choices : undefined).toEqual([]);
  await actions.confirm();
  expect(calls).toEqual([]);
});

test("the question's text says that the main process asks again in its own dialog with the path, and that a removal does not come back", () => {
  expect(PROJECT_REPOSITORY_QUESTION_MESSAGES.linkText).toContain(
    "this device asks you to confirm in a dialog of its own, which shows the folder's full path",
  );
  expect(PROJECT_REPOSITORY_QUESTION_MESSAGES.linkText).toContain(
    "the path is never sent to the server",
  );
  expect(PROJECT_REPOSITORY_QUESTION_MESSAGES.removeText).toContain(
    "A removed repository does not come back",
  );
  expect(PROJECT_REPOSITORY_QUESTION_MESSAGES.removeText).toContain(
    "the permissions granted on it end",
  );
  // The view does not say who registered a repository, so the question
  // says who may remove one.
  expect(PROJECT_REPOSITORY_QUESTION_MESSAGES.removeText).toContain(
    "Only the person who registered it, the workspace's owner, and its admins can remove it.",
  );
});
