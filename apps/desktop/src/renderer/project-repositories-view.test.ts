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
): ProjectRepositoryView {
  return { repositoryId, name, linked, mountId };
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
  // A full project names its limit and no wait: only a removal helps.
  expect(
    describeRegisterResult({
      outcome: "refused",
      reason: "repository_limit",
      retryAfterMs: null,
    }),
  ).toBe(
    "The repository could not be registered. This project already has 20 repositories, as many as it allows. Remove one first.",
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

test("a link's answer reads naturally after the person cancelled it and while another confirmation is open", () => {
  expect(describeLinkResult({ outcome: "linked" })).toBe(
    PROJECT_REPOSITORY_DONE_MESSAGES.link,
  );
  expect(describeLinkResult({ outcome: "refused", reason: "cancelled" })).toBe(
    "The repository was not linked. You cancelled it in the confirmation dialog. Nothing changed.",
  );
  expect(describeLinkResult({ outcome: "refused", reason: "busy" })).toBe(
    "The repository was not linked. A confirmation of another link is open, or one was cancelled a moment ago. Answer that dialog or wait a few seconds, then try again.",
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
      linking: false,
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
  expect(shown.linking).toBe(true);
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
    expect(shown.linking, links).toBe(false);
    expect(linkOffered(shown), links).toBe(false);
    // Removing and registering stay offered.
    expect(shown.projectId, links).toBe(PROJECT);
  }
});

test("without the mount list, linking is not offered, but unlinking is", () => {
  for (const mountView of [
    { kind: "pending" },
    { kind: "unavailable" },
  ] as const) {
    const shown = model(known(), mountView);
    expect(shown.folders).toBeNull();
    expect(shown.linking).toBe(true);
    expect(linkOffered(shown)).toBe(false);
  }
});

test("an unavailable list shows its problem with what was loaded before and offers nothing", () => {
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
    expect(shown.linking, problem).toBe(false);
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

test("the folder chosen at first is the first one with the repository's name, else none", () => {
  const choices = folderChoices(model(), REPOSITORY_A);
  expect(initialFolderChoice("app", choices)).toBe(MOUNT_1);
  expect(initialFolderChoice("docs", choices)).toBe(MOUNT_2);
  // Only the exact name.
  expect(initialFolderChoice("App", choices)).toBeNull();
  expect(initialFolderChoice("site", choices)).toBeNull();
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

test("a removal asks first, sends once after the confirmation, and its button leaves the page", async () => {
  const { actions, calls, answers, last } = controllerWith();
  expect(await actions.start(request("remove"))).toBe(false);
  expect(calls).toEqual([]);
  expect(last().dialog).toEqual({ kind: "remove", request: request("remove") });

  const done = actions.confirm();
  expect(last().dialog).toBeUndefined();
  expect(last().running).toBe(true);
  expect(calls).toEqual([`remove ${PROJECT} ${REPOSITORY_A}`]);
  answers.remove.resolve({ outcome: "ok" });
  expect(await done).toBe(true);
  expect(last()).toEqual({
    ...IDLE_PROJECT_REPOSITORY_ACTIONS,
    message: "The repository was removed from the project.",
  });
  // A confirmation without a question sends nothing.
  expect(await actions.confirm()).toBe(false);
  expect(calls).toHaveLength(1);
});

test("a cancelled question sends nothing", async () => {
  const { actions, calls, last } = controllerWith();
  await actions.start(request("remove"));
  actions.cancel();
  expect(last().dialog).toBeUndefined();
  expect(await actions.confirm()).toBe(false);
  expect(calls).toEqual([]);
});

test("a refused removal keeps its button: it resolves to false with its sentence", async () => {
  const { actions, answers, last } = controllerWith();
  await actions.start(request("remove"));
  const done = actions.confirm();
  answers.remove.resolve({
    outcome: "refused",
    reason: "forbidden",
    retryAfterMs: null,
  });
  expect(await done).toBe(false);
  expect(last().message).toBe(
    "The repository could not be removed. Only the person who registered it, the workspace's owner, and its admins can remove it.",
  );
});

test("a link asks for the folder first, among the folders of the latest model, with the one of the repository's name chosen", async () => {
  const { actions, calls, last } = controllerWith();
  await actions.start(request("link"));
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
  expect(dialog.mountId).toBe(MOUNT_1);
  expect(dialog.problem).toBeUndefined();
});

test("a link without a chosen folder sends nothing and says to choose one, until a folder is chosen", async () => {
  const { actions, calls, last } = controllerWith();
  await actions.start(request("link", repository(REPOSITORY_B, "site")));
  const opened = last().dialog;
  expect(opened?.kind === "link" ? opened.mountId : "no dialog").toBeNull();

  expect(await actions.confirm()).toBe(false);
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

test("a confirmed link asks the main process, which asks the person in its own dialog meanwhile, and says how it ended; its button stays", async () => {
  const { actions, calls, answers, last } = controllerWith();
  await actions.start(request("link"));
  actions.choose(MOUNT_3);
  const done = actions.confirm();
  expect(calls).toEqual([`link ${REPOSITORY_A} ${MOUNT_3}`]);
  expect(last()).toEqual({
    ...IDLE_PROJECT_REPOSITORY_ACTIONS,
    running: true,
    message:
      "Confirm or cancel the link in the dialog that this device opened.",
  });
  answers.link.resolve({ outcome: "refused", reason: "cancelled" });
  expect(await done).toBe(false);
  expect(last().message).toBe(
    "The repository was not linked. You cancelled it in the confirmation dialog. Nothing changed.",
  );
  expect(last().running).toBe(false);
});

test("a linked answer says so", async () => {
  const { actions, answers, last } = controllerWith();
  await actions.start(request("link"));
  const done = actions.confirm();
  answers.link.resolve({ outcome: "linked" });
  expect(await done).toBe(false);
  expect(last().message).toBe(
    "The repository was linked to the folder on this device.",
  );
});

test("an unlink runs at once, and its button leaves the page once it happened", async () => {
  const { actions, calls, answers, last } = controllerWith();
  const done = actions.start(request("unlink"));
  expect(calls).toEqual([`unlink ${REPOSITORY_A}`]);
  expect(last().running).toBe(true);
  expect(last().message).toBeUndefined();
  answers.unlink.resolve({ outcome: "unlinked" });
  expect(await done).toBe(true);
  expect(last().message).toBe(PROJECT_REPOSITORY_DONE_MESSAGES.unlink);

  const refused = controllerWith();
  const kept = refused.actions.start(request("unlink"));
  refused.answers.unlink.resolve({ outcome: "refused", reason: "not_linked" });
  expect(await kept).toBe(false);
});

test("a registration sends the trimmed name once, and empties the field only once the API confirmed it", async () => {
  const { actions, calls, answers, last } = controllerWith();
  actions.editRegisterDraft("  app  ");
  const done = actions.register(PROJECT);
  expect(calls).toEqual([`register ${PROJECT} app`]);
  expect(last().running).toBe(true);
  expect(last().registerDraft).toBe("  app  ");
  answers.register.resolve({ outcome: "ok", repositoryId: REPOSITORY_A });
  expect(await done).toBe(false);
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
    expect(await actions.register(PROJECT)).toBe(false);
    expect(calls, typed).toEqual([]);
    expect(last().registerProblem, typed).toBe(problem);
    actions.editRegisterDraft(`${typed}x`);
    expect(last().registerProblem, typed).toBeUndefined();
  }
});

test("one action at a time: while one runs, nothing else starts, opens, or is sent", async () => {
  const { actions, calls, answers, last } = controllerWith();
  const first = actions.start(request("unlink"));
  expect(await actions.start(request("remove"))).toBe(false);
  expect(await actions.start(request("link"))).toBe(false);
  expect(await actions.start(request("unlink", B))).toBe(false);
  actions.editRegisterDraft("docs");
  expect(await actions.register(PROJECT)).toBe(false);
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
  expect(await actions.confirm()).toBe(false);
  expect(calls).toEqual([`register ${PROJECT} docs`]);
  answers.register.resolve({ outcome: "unknown" });
  await registering;
});

test("a call that fails on its way, also one that throws at once, says that nothing was sent", async () => {
  const { actions, answers, last } = controllerWith();
  const done = actions.start(request("unlink"));
  answers.unlink.reject(new Error("lost"));
  expect(await done).toBe(false);
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

test("an answer that arrives after the shell showed another project shows no sentence, moves no focus, and leaves a name typed since alone", async () => {
  const { actions, answers, last } = controllerWith();
  actions.editRegisterDraft("app");
  const done = actions.register(PROJECT);
  // The shell shows another project; the main process still has this one.
  actions.follow(model(known(), MOUNTS, OTHER_PROJECT));
  actions.editRegisterDraft("docs");
  answers.register.resolve({ outcome: "ok", repositoryId: REPOSITORY_A });
  expect(await done).toBe(false);
  expect(last().message).toBeUndefined();
  expect(last().registerDraft).toBe("docs");
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
    expect(await done, between.kind).toBe(false);
    expect(last().message, between.kind).toBeUndefined();
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
    expect(await actions.confirm(), why).toBe(false);
    expect(calls, why).toEqual([]);
  }
  // A removal's question stays while the links are not ready.
  const { actions, last } = controllerWith();
  await actions.start(request("remove"));
  actions.follow(model(known({ links: "unavailable" })));
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
  expect(await actions.confirm()).toBe(false);
  expect(calls).toEqual([]);
});

test("a link's question with no folder to choose stays open and sends nothing", async () => {
  const { actions, calls, last } = controllerWith(model(known(), mounts()));
  await actions.start(request("link"));
  const dialog = last().dialog;
  expect(dialog?.kind === "link" ? dialog.choices : undefined).toEqual([]);
  expect(await actions.confirm()).toBe(false);
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
});
