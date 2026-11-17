import type { ProjectRepositoriesBridge } from "../shared/desktop-bridge.ts";
import type {
  LinkRepositoryRefusal,
  LinkRepositoryResult,
  ProjectRepositoriesView,
  ProjectRepositoryProblem,
  RegisterRepositoryRefusal,
  RegisterRepositoryResult,
  RemoveRepositoryRefusal,
  RemoveRepositoryResult,
  UnlinkRepositoryRefusal,
  UnlinkRepositoryResult,
} from "../shared/ipc-contract.ts";
import type { RepositoryPanelView } from "./repository-view.ts";
import { describeWait } from "./wait-text.ts";

// The open project's registered repositories in the repository side panel
// (#286): their names, whether each is linked to a folder on this device,
// registering one, linking and unlinking one, and removing one from the
// project. The main process holds them (`window.desktop.projectRepositories`)
// and confirms every link in a native dialog of its own; the panel shows
// what it sends and passes the person's actions on.

/**
 * The longest name of a repository in characters (Unicode code points), as
 * the contract and the protocol count it (`PROJECT_REPOSITORY_LIMITS.name`
 * and `LIMITS.name`). The renderer imports no value of the contract, so the
 * tests check that the values match.
 */
export const MAX_REPOSITORY_NAME_LENGTH = 100;

/**
 * The most new repositories of one account in 24 hours (the protocol's
 * `REPOSITORY_COUNT_LIMITS.perDay`), which the sentence of a registration's
 * `rate_limited` names. The tests check it against the protocol.
 */
export const MAX_NEW_REPOSITORIES_PER_DAY = 20;

/** What the panel knows about the open project's registered repositories. */
export type ProjectRepositoriesPanelView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first state. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly state: ProjectRepositoriesView };

export function initialProjectRepositoriesView(
  bridgeAvailable: boolean,
): ProjectRepositoriesPanelView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

/**
 * Subscribes to the open project's registered repositories and reports
 * every state as the view; a refused subscription makes the view
 * unavailable. Returns the function that ends the subscription.
 */
export function followProjectRepositories(
  bridge: Pick<ProjectRepositoriesBridge, "subscribeState">,
  onView: (view: ProjectRepositoriesPanelView) => void,
): () => void {
  return bridge.subscribeState(
    (state) => onView({ kind: "known", state }),
    () => onView({ kind: "unavailable" }),
  );
}

/** The fixed texts of the project's repositories in the panel. */
export const PROJECT_REPOSITORY_MESSAGES = Object.freeze({
  title: "In this project",
  hint: "The repositories that this project works with. Everyone in the workspace sees their names. Each person links them to folders on their own device, and a folder's path never leaves the device.",
  unavailable: "The project's repositories are not available.",
  pending: "Checking the project's repositories.",
  noProject:
    "The project's repositories appear once this device is signed in and the project is open.",
  loading: "Loading the project's repositories.",
  empty: "No repositories are registered in this project yet.",
  linksLoading: "Reading the links to folders on this device.",
  linksUnavailable:
    "The links to folders on this device cannot be read, so no repository can be linked here now.",
  notLinked: "Not linked to a folder on this device.",
  /** Before the name of the mounted folder that a repository is linked to. */
  linkedTo: "Linked to the folder ",
  /** A linked folder that is mounted, before the mount list names it. */
  linkedFolder: "Linked to a folder on this device.",
  linkedNotMounted:
    'Linked to a folder on this device that is not in the list of this device\'s repositories. Add it with "Add a repository" to use the link.',
  link: "Link to a folder",
  unlink: "Unlink",
  remove: "Remove from the project",
  registerTitle: "Register a repository",
  nameLabel: "Name",
  nameHint:
    "Everyone in the workspace sees this name. It cannot contain a slash or a backslash, so that no folder's path or address is sent as a name.",
  register: "Register",
  nameMissing: "Enter a name.",
  nameTooLong: `A name has at most ${String(MAX_REPOSITORY_NAME_LENGTH)} characters.`,
  nameSlash: "A name cannot contain a slash (/) or a backslash (\\).",
  cancel: "Cancel",
  /**
   * While a link waits for the person's answer in the main process's own
   * dialog, which names the repository and shows the folder's full path.
   */
  linkWaiting:
    "This device asks you to confirm the link in a dialog of its own.",
});

/** The texts of the questions that the panel asks first. */
export const PROJECT_REPOSITORY_QUESTION_MESSAGES = Object.freeze({
  removeTitle: "Remove this repository from the project?",
  /**
   * What a removal does (ADR 0005, update of 2026-11-14): the server keeps
   * the repository as removed and revokes the grants on it, and every
   * device drops its links when it learns of the removal. A removed
   * repository never comes back. Who may remove one is the decision of
   * 2026-11-14: the view does not say who registered a repository, so the
   * question says it before the server decides.
   */
  removeText:
    "It is removed for everyone in the workspace, the permissions granted on it end, and every device drops its link to a folder. Nothing in any folder changes. A removed repository does not come back: registering the same name again makes a new repository, which each person links again. Only the person who registered it, the workspace's owner, and its admins can remove it.",
  removeConfirm: "Remove from the project",
  linkTitle: "Link this repository to a folder?",
  /**
   * What a link does (the Project Manager's decision of 2026-11-17): the
   * main process asks again in a dialog of its own, which shows the path.
   */
  linkText:
    "Choose the folder on this device that holds this repository. After you choose Continue, this device asks you to confirm in a dialog of its own, which shows the folder's full path. The link stays on this device, for your account only, and the path is never sent to the server.",
  linkLegend: "Folder",
  linkNone:
    'No folder can be linked now. Add the repository\'s folder with "Add a repository" first. A folder that is linked to another repository of this project is not listed until that repository is unlinked.',
  linkConfirm: "Continue",
  chooseFolder: "Choose a folder.",
});

/**
 * Why the open project's repositories are `unavailable`. What was loaded
 * before stays shown, and the main process loads again by itself.
 */
export const PROJECT_REPOSITORY_PROBLEM_MESSAGES: Readonly<
  Record<ProjectRepositoryProblem, string>
> = Object.freeze({
  not_signed_in: "The server did not accept this device's sign-in.",
  not_found: "The server did not find this project.",
  rate_limited: "The server asked to wait. Trying again later.",
  unavailable: "The server could not be reached. Trying again later.",
  failed: "The project's repositories could not be loaded. Trying again later.",
});

/** The panel's actions, one per bridge function that changes something. */
export type ProjectRepositoryActionKind =
  "register" | "remove" | "link" | "unlink";

/** The sentence after an action that happened. */
export const PROJECT_REPOSITORY_DONE_MESSAGES: Readonly<
  Record<ProjectRepositoryActionKind, string>
> = Object.freeze({
  register:
    "The repository was registered. It shows in the list once the server reports it.",
  remove: "The repository was removed from the project.",
  link: "The repository was linked to the folder on this device.",
  unlink: "The repository was unlinked. Its folder stays as it is.",
});

/** The start of the sentence after an action that did not happen. */
export const PROJECT_REPOSITORY_NOT_DONE_MESSAGES: Readonly<
  Record<ProjectRepositoryActionKind, string>
> = Object.freeze({
  register: "The repository could not be registered.",
  remove: "The repository could not be removed.",
  link: "The repository was not linked.",
  unlink: "The repository could not be unlinked.",
});

/**
 * The sentence after an answer that does not show whether the API acted
 * (`unknown`). The request is never sent again on its own; the person
 * checks the list.
 */
export const PROJECT_REPOSITORY_UNKNOWN_MESSAGES = Object.freeze({
  register:
    "It is not known whether the repository was registered. Check the list before you register it again; the request is not sent again on its own.",
  remove:
    "It is not known whether the repository was removed. Check the list; the request is not sent again on its own.",
});

/** The end of the sentence after a call that failed on its way; nothing was sent. */
export const PROJECT_REPOSITORY_NOT_SENT = "It was not sent. Try again.";

const SIGNED_OUT =
  "This device is not signed in, or the server did not accept its sign-in.";
const CANNOT_SEND =
  "This device cannot send it now. Wait until the sign-in or the current change of the account is finished, then try again.";
const NOT_OPEN =
  "The project was closed before it was sent. Open the project, then try again.";
const TOO_SOON = (wait: string) =>
  `This device sent many changes in a short time. Try again in ${wait}.`;

/**
 * Why a registration was refused, after its start. `too_soon` and
 * `rate_limited` say how long to wait (`describeWait`); `rate_limited` also
 * names the API's limit of new repositories of an account in 24 hours.
 * `repository_limit` names no wait, because none helps: only a removal
 * frees a place (the Project Manager's decision of 2026-11-14 on #286); it
 * names no number either.
 */
export const REGISTER_REPOSITORY_REFUSAL_MESSAGES: Readonly<
  Record<
    Exclude<RegisterRepositoryRefusal, "too_soon" | "rate_limited">,
    string
  >
> & {
  readonly tooSoon: (wait: string) => string;
  readonly rateLimited: (wait: string) => string;
} = Object.freeze({
  invalid:
    "The name is not allowed. Use visible characters, without line breaks, a slash, or a backslash.",
  not_open: NOT_OPEN,
  not_signed_in: SIGNED_OUT,
  unavailable: CANNOT_SEND,
  tooSoon: TOO_SOON,
  rateLimited: (wait: string) =>
    `The server asked to wait. Try again in ${wait}. An account registers at most ${String(MAX_NEW_REPOSITORIES_PER_DAY)} repositories in 24 hours.`,
  repository_limit:
    "This project already has as many repositories as it allows. A repository has to be removed first.",
  not_found: "The server does not know this project for your account.",
  conflict:
    "The project is archived, so no repository can be registered in it.",
  failed: "The server refused it.",
});

/**
 * Why a removal was refused, after its start. `forbidden` says who may
 * remove a repository (the decision of 2026-11-14): the panel offers the
 * removal only where the main process said that the account may
 * (`removable`, #309), but the server decides, so a role that changed
 * meanwhile answers `forbidden`. After `not_found` and `conflict`, the main
 * process reads the list again.
 */
export const REMOVE_REPOSITORY_REFUSAL_MESSAGES: Readonly<
  Record<Exclude<RemoveRepositoryRefusal, "too_soon" | "rate_limited">, string>
> & {
  readonly tooSoon: (wait: string) => string;
  readonly rateLimited: (wait: string) => string;
} = Object.freeze({
  invalid: "The request was not valid.",
  not_open: NOT_OPEN,
  not_signed_in: SIGNED_OUT,
  unavailable: CANNOT_SEND,
  tooSoon: TOO_SOON,
  rateLimited: (wait: string) =>
    `The server asked to wait. Try again in ${wait}.`,
  forbidden:
    "Only the person who registered it, the workspace's owner, and its admins can remove it.",
  not_found:
    "The server does not know this repository in this project. The list is read again.",
  conflict:
    "The repository is already removed, or the project is archived. The list is read again.",
  failed: "The server refused it.",
});

/**
 * Why a link was refused. `cancelled` is the main process's dialog that
 * was cancelled or closed, and `busy` another link's dialog that is open or
 * was cancelled a moment ago (the main process waits a few seconds after a
 * cancel). Nothing changed after any of them.
 */
export const LINK_REPOSITORY_REFUSAL_MESSAGES: Readonly<
  Record<LinkRepositoryRefusal, string>
> = Object.freeze({
  invalid: "The request was not valid.",
  not_registered: "The repository is no longer registered in this project.",
  not_mounted:
    "The folder is no longer in the list of this device's repositories. Add it again, then link it.",
  folder_linked:
    "You linked this folder to another repository already, perhaps of another project. Unlink that repository first.",
  symbolic_link:
    "The folder or its Git folder is a symbolic link or a junction, which cannot be linked. Add the repository from its real folder instead.",
  folder_missing:
    "The folder or its Git folder could not be read. Check that it still exists.",
  busy: "A confirmation of another link is open, or one was cancelled a moment ago. Answer that dialog or wait a few seconds, then try again.",
  cancelled:
    "The confirmation dialog was cancelled or closed. Nothing changed.",
  limit:
    "This device keeps no more links, and all of them are yours. Unlink a repository first.",
  unavailable:
    "Links are not available now: this device is not signed in, your person in the workspace is not known yet, or the links on this device cannot be read.",
  failed:
    "The confirmation could not be shown, the folder changed while it was open, or the link could not be saved. Nothing changed. Try again.",
});

/** Why an unlink was refused. */
export const UNLINK_REPOSITORY_REFUSAL_MESSAGES: Readonly<
  Record<UnlinkRepositoryRefusal, string>
> = Object.freeze({
  invalid: "The request was not valid.",
  not_linked: "The repository is not linked on this device.",
  unavailable: LINK_REPOSITORY_REFUSAL_MESSAGES.unavailable,
});

/** The sentence after the answer of a registration. */
export function describeRegisterResult(
  result: RegisterRepositoryResult,
): string {
  switch (result.outcome) {
    case "ok":
      return PROJECT_REPOSITORY_DONE_MESSAGES.register;
    case "unknown":
      return PROJECT_REPOSITORY_UNKNOWN_MESSAGES.register;
    case "refused": {
      const messages = REGISTER_REPOSITORY_REFUSAL_MESSAGES;
      const wait = describeWait(result.retryAfterMs ?? 0);
      const reason =
        result.reason === "too_soon"
          ? messages.tooSoon(wait)
          : result.reason === "rate_limited"
            ? messages.rateLimited(wait)
            : messages[result.reason];
      return `${PROJECT_REPOSITORY_NOT_DONE_MESSAGES.register} ${reason}`;
    }
  }
}

/** The sentence after the answer of a removal. */
export function describeRemoveResult(result: RemoveRepositoryResult): string {
  switch (result.outcome) {
    case "ok":
      return PROJECT_REPOSITORY_DONE_MESSAGES.remove;
    case "unknown":
      return PROJECT_REPOSITORY_UNKNOWN_MESSAGES.remove;
    case "refused": {
      const messages = REMOVE_REPOSITORY_REFUSAL_MESSAGES;
      const wait = describeWait(result.retryAfterMs ?? 0);
      const reason =
        result.reason === "too_soon"
          ? messages.tooSoon(wait)
          : result.reason === "rate_limited"
            ? messages.rateLimited(wait)
            : messages[result.reason];
      return `${PROJECT_REPOSITORY_NOT_DONE_MESSAGES.remove} ${reason}`;
    }
  }
}

/** The sentence after the answer of a link. */
export function describeLinkResult(result: LinkRepositoryResult): string {
  return result.outcome === "linked"
    ? PROJECT_REPOSITORY_DONE_MESSAGES.link
    : `${PROJECT_REPOSITORY_NOT_DONE_MESSAGES.link} ${LINK_REPOSITORY_REFUSAL_MESSAGES[result.reason]}`;
}

/** The sentence after the answer of an unlink. */
export function describeUnlinkResult(result: UnlinkRepositoryResult): string {
  return result.outcome === "unlinked"
    ? PROJECT_REPOSITORY_DONE_MESSAGES.unlink
    : `${PROJECT_REPOSITORY_NOT_DONE_MESSAGES.unlink} ${UNLINK_REPOSITORY_REFUSAL_MESSAGES[result.reason]}`;
}

/**
 * The name as the renderer sends it: trimmed of white space at the start
 * and the end. It is not normalized, because the protocol stores a
 * repository's name as sent.
 */
export function repositoryNameToSend(text: string): string {
  return text.trim();
}

const SLASH = /[/\\]/u;

/**
 * The problem of a name before it is sent, or undefined: none after
 * `repositoryNameToSend`, longer than the limit in characters (code
 * points), as the contract and the protocol count it, or with a slash or a
 * backslash, which the protocol refuses so that no folder's path or remote
 * address travels as a name. The main process refuses all three, and the
 * call rejects for an empty or a longer one. A character takes one or two
 * UTF-16 code units, so the characters are counted only when the name is
 * longer in code units. Other characters that the protocol refuses, such
 * as control characters, are left to the main process (`invalid`).
 */
export function repositoryNamePrompt(name: string): string | undefined {
  if (name === "") {
    return PROJECT_REPOSITORY_MESSAGES.nameMissing;
  }
  if (
    name.length > MAX_REPOSITORY_NAME_LENGTH &&
    Array.from(name).length > MAX_REPOSITORY_NAME_LENGTH
  ) {
    return PROJECT_REPOSITORY_MESSAGES.nameTooLong;
  }
  return SLASH.test(name) ? PROJECT_REPOSITORY_MESSAGES.nameSlash : undefined;
}

/** A folder of the mount list that a repository can be linked to. */
export interface FolderChoice {
  readonly mountId: string;
  /** The folder's name, as the mount list shows it. */
  readonly name: string;
  /** The folder's path, as the mount list shows it; it never leaves the renderer. */
  readonly path: string;
}

/** Where a registered repository is linked on this device. */
export type RepositoryLinkRow =
  | { readonly kind: "not_linked" }
  /** Linked to a folder that is mounted and that the mount list shows. */
  | { readonly kind: "folder"; readonly folder: FolderChoice }
  /** Linked to a mounted folder that the mount list does not show yet. */
  | { readonly kind: "mounted" }
  /** Linked to a folder that is not mounted now. */
  | { readonly kind: "not_mounted" };

/** A registered repository as the panel shows it. */
export interface RepositoryRow {
  readonly repositoryId: string;
  readonly name: string;
  readonly linked: boolean;
  /** The mount of its linked folder while it is mounted, else null. */
  readonly mountId: string | null;
  /** Where it is linked, or null while this device's links are not `ready`. */
  readonly link: RepositoryLinkRow | null;
  /**
   * Whether the account may remove it, as the main process worked it out:
   * the account registered it, or is the workspace's owner or an admin.
   */
  readonly removable: boolean;
}

/** What the panel shows of the open project's registered repositories. */
export interface ProjectRepositoriesModel {
  /**
   * The project and workspace that the panel's actions and answers belong
   * to, as one key: set while the main process's state is about the
   * project that the shell shows, null otherwise. Every change of it, also
   * to null and back, ends what belonged to the earlier one.
   */
  readonly scope: string | null;
  /** The text of the status paragraph; empty when there is nothing to say. */
  readonly status: string;
  /** A note about this device's links, or empty. */
  readonly linksNote: string;
  /** The repositories, in the main process's order, or null when none are known. */
  readonly rows: readonly RepositoryRow[] | null;
  /**
   * The project that the list's actions act on, registering, linking, and
   * removing: the shown project while its repositories are `ready`; null
   * otherwise, and then none of them is offered.
   */
  readonly projectId: string | null;
  /**
   * The project whose linked repositories offer "Unlink": the shown
   * project while this device's links are `ready`, whatever the state of
   * its list, because the main process's unlink needs only the links; null
   * otherwise.
   */
  readonly linksProjectId: string | null;
  /**
   * The mounted folders, in the mount list's order, or null while the
   * mount list is not known. "Link to a folder" is offered while
   * `projectId` and `linksProjectId` are set and the folders are known.
   */
  readonly folders: readonly FolderChoice[] | null;
}

function foldersOf(
  mounts: RepositoryPanelView,
): readonly FolderChoice[] | null {
  return mounts.kind === "known"
    ? mounts.list.repositories.map((repository) => ({
        mountId: repository.mountId,
        name: repository.name,
        path: repository.path,
      }))
    : null;
}

function linkRow(
  linked: boolean,
  mountId: string | null,
  folders: readonly FolderChoice[] | null,
): RepositoryLinkRow {
  if (!linked) {
    return { kind: "not_linked" };
  }
  if (mountId === null) {
    return { kind: "not_mounted" };
  }
  const folder = folders?.find((choice) => choice.mountId === mountId);
  return folder === undefined
    ? { kind: "mounted" }
    : { kind: "folder", folder };
}

function rowsOf(
  state: ProjectRepositoriesView,
  folders: readonly FolderChoice[] | null,
): readonly RepositoryRow[] {
  const linksReady = state.links === "ready";
  return state.repositories.map((repository) => ({
    repositoryId: repository.repositoryId,
    name: repository.name,
    linked: repository.linked,
    mountId: repository.mountId,
    link: linksReady
      ? linkRow(repository.linked, repository.mountId, folders)
      : null,
    removable: repository.removable,
  }));
}

/** A model with a status text alone, nothing listed, and no action. */
function statusOnly(
  scope: string | null,
  status: string,
  folders: readonly FolderChoice[] | null,
): ProjectRepositoriesModel {
  return {
    scope,
    status,
    linksNote: "",
    rows: null,
    projectId: null,
    linksProjectId: null,
    folders,
  };
}

/**
 * What the panel shows for the project that the shell shows (`projectId`),
 * with the mount list `mounts`:
 *
 * - a fixed text without the bridge, before the first state, while no
 *   project is open in the main process or no device is signed in, and
 *   while the repositories load;
 * - the same loading text while the state belongs to another project, so
 *   that no other project's repositories appear here;
 * - when `ready`, the repositories with their links, and the actions;
 * - when `unavailable`, the problem as a fixed text, with what was loaded
 *   before and no action but "Unlink". Without any of it, only the problem
 *   shows.
 *
 * Where a repository is linked, and "Unlink", show only while this
 * device's links are `ready`; otherwise a note says why not.
 */
export function describeProjectRepositories(
  view: ProjectRepositoriesPanelView,
  mounts: RepositoryPanelView,
  projectId: string,
): ProjectRepositoriesModel {
  const folders = foldersOf(mounts);
  switch (view.kind) {
    case "unavailable":
      return statusOnly(null, PROJECT_REPOSITORY_MESSAGES.unavailable, folders);
    case "pending":
      return statusOnly(null, PROJECT_REPOSITORY_MESSAGES.pending, folders);
    case "known":
      break;
  }
  const { state } = view;
  if (state.status === "no_project") {
    return statusOnly(null, PROJECT_REPOSITORY_MESSAGES.noProject, folders);
  }
  if (state.projectId !== projectId) {
    return statusOnly(null, PROJECT_REPOSITORY_MESSAGES.loading, folders);
  }
  const scope = `${state.workspaceId ?? ""}/${projectId}`;
  if (state.status === "loading") {
    return statusOnly(scope, PROJECT_REPOSITORY_MESSAGES.loading, folders);
  }
  const linksNote =
    state.links === "loading"
      ? PROJECT_REPOSITORY_MESSAGES.linksLoading
      : state.links === "unavailable"
        ? PROJECT_REPOSITORY_MESSAGES.linksUnavailable
        : "";
  const linksProjectId = state.links === "ready" ? projectId : null;
  if (state.status === "unavailable") {
    return {
      scope,
      status: PROJECT_REPOSITORY_PROBLEM_MESSAGES[state.problem],
      linksNote,
      rows: state.repositories.length === 0 ? null : rowsOf(state, folders),
      projectId: null,
      linksProjectId,
      folders,
    };
  }
  return {
    scope,
    status:
      state.repositories.length === 0 ? PROJECT_REPOSITORY_MESSAGES.empty : "",
    linksNote,
    rows: rowsOf(state, folders),
    projectId,
    linksProjectId,
    folders,
  };
}

/**
 * Whether "Link to a folder" is offered: the list is `ready`, this
 * device's links are `ready`, and the folders are known.
 */
export function linkOffered(model: ProjectRepositoriesModel): boolean {
  return (
    model.projectId !== null &&
    model.linksProjectId !== null &&
    model.folders !== null
  );
}

/**
 * The actions that a repository's row offers, in their order: "Link to a
 * folder" while it is offered (`linkOffered`), "Unlink" on a linked
 * repository while this device's links are `ready` for the shown project,
 * whatever the state of its list, and "Remove from the project" while the
 * list is `ready` on a repository that the account may remove
 * (`removable`, #309). Each carries the project, the repository's ID, and
 * its name.
 */
export function repositoryActions(
  model: ProjectRepositoriesModel,
  row: RepositoryRow,
): readonly RepositoryActionRequest[] {
  const { projectId, linksProjectId } = model;
  const action = (
    kind: RepositoryActionRequest["kind"],
    target: string,
  ): RepositoryActionRequest => ({
    kind,
    projectId: target,
    repositoryId: row.repositoryId,
    name: row.name,
  });
  return [
    ...(projectId !== null && linkOffered(model)
      ? [action("link", projectId)]
      : []),
    ...(linksProjectId !== null && row.linked
      ? [action("unlink", linksProjectId)]
      : []),
    ...(projectId !== null && row.removable
      ? [action("remove", projectId)]
      : []),
  ];
}

/**
 * The folders that `repositoryId` can be linked to: the mounted folders in
 * the mount list's order, without one that a link of another repository of
 * this project names, which the main process would refuse
 * (`folder_linked`). The repository's own folder stays, so that the person
 * can link it again, for example after it was replaced.
 */
export function folderChoices(
  model: ProjectRepositoriesModel,
  repositoryId: string,
): readonly FolderChoice[] {
  const taken = new Set(
    (model.rows ?? []).flatMap((row) =>
      row.repositoryId === repositoryId || row.mountId === null
        ? []
        : [row.mountId],
    ),
  );
  return (model.folders ?? []).filter((folder) => !taken.has(folder.mountId));
}

/**
 * The folder chosen at first when a link's question opens: the only one
 * among `choices` whose name is the repository's name exactly; none when no
 * folder or more than one has that name, so that the person chooses. The
 * main process's own dialog shows the full path before anything is linked.
 */
export function initialFolderChoice(
  name: string,
  choices: readonly FolderChoice[],
): string | null {
  const named = choices.filter((choice) => choice.name === name);
  return named.length === 1 ? (named[0]?.mountId ?? null) : null;
}

/**
 * An action that the panel offers on a repository, with what it needs: the
 * project's ID when the panel showed it, and the repository's ID and name.
 * The IDs go only to the bridge; the panel never shows them.
 */
export interface RepositoryActionRequest {
  readonly kind: "remove" | "link" | "unlink";
  readonly projectId: string;
  readonly repositoryId: string;
  readonly name: string;
}

/** The open question of the panel. */
export type ProjectRepositoryDialog =
  | {
      readonly kind: "remove";
      readonly request: RepositoryActionRequest;
    }
  | {
      readonly kind: "link";
      readonly request: RepositoryActionRequest;
      /** The folders that can be chosen now (`folderChoices`). */
      readonly choices: readonly FolderChoice[];
      /** The chosen folder's mount ID, or null. */
      readonly mountId: string | null;
      /** Why nothing was sent, or undefined. */
      readonly problem: string | undefined;
    };

/** What the panel shows of its actions. */
export interface ProjectRepositoryActionsView {
  /**
   * True while an action runs: every action's control stays focusable and
   * does nothing (`aria-disabled`), so that only one runs at a time.
   */
  readonly running: boolean;
  /** A fixed sentence about the last action, or undefined. */
  readonly message: string | undefined;
  /** The open question, or undefined. */
  readonly dialog: ProjectRepositoryDialog | undefined;
  /** The name in the field of a registration. */
  readonly registerDraft: string;
  /** Why the name of the registration was not sent, or undefined. */
  readonly registerProblem: string | undefined;
}

export const IDLE_PROJECT_REPOSITORY_ACTIONS: ProjectRepositoryActionsView =
  Object.freeze({
    running: false,
    message: undefined,
    dialog: undefined,
    registerDraft: "",
    registerProblem: undefined,
  });

/**
 * Whether the panel still offers the question of `dialog` as it was asked:
 * the same project with its repositories `ready`, the repository listed
 * under the same name, for a removal, still one that the account may
 * remove, and for a link, "Link to a folder" offered.
 */
function isOffered(
  model: ProjectRepositoriesModel,
  dialog: ProjectRepositoryDialog,
): boolean {
  const { request } = dialog;
  if (model.projectId !== request.projectId) {
    return false;
  }
  const row = model.rows?.find(
    (entry) =>
      entry.repositoryId === request.repositoryId &&
      entry.name === request.name,
  );
  if (row === undefined) {
    return false;
  }
  return dialog.kind === "remove" ? row.removable : linkOffered(model);
}

function sameChoices(
  left: readonly FolderChoice[],
  right: readonly FolderChoice[],
): boolean {
  return (
    left.length === right.length &&
    left.every((choice, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        other.mountId === choice.mountId &&
        other.name === choice.name &&
        other.path === choice.path
      );
    })
  );
}

export interface ProjectRepositoryActions {
  /**
   * Starts an action that the panel offers: a removal and a link open
   * their question, a link with the folders of the latest model and the
   * one of `initialFolderChoice` chosen, and an unlink runs at once. While
   * an action runs, nothing starts. Resolves once the view shows how the
   * action ended; it never rejects.
   */
  readonly start: (request: RepositoryActionRequest) => Promise<void>;
  /** Chooses a folder of the open link's question, and ends its problem. */
  readonly choose: (mountId: string) => void;
  /**
   * Runs the action of the open question; a link without a chosen folder
   * keeps the question open with its problem. Resolves like `start`.
   */
  readonly confirm: () => Promise<void>;
  /** Closes the open question without the action. */
  readonly cancel: () => void;
  /** Changes the name in the field of a registration, and ends its problem. */
  readonly editRegisterDraft: (text: string) => void;
  /**
   * Registers a repository in `projectId` with the name of the field
   * (`repositoryNameToSend`), once it passes `repositoryNamePrompt`, and
   * keeps the problem otherwise; empties the field once the API confirmed
   * it. Resolves like `start`.
   */
  readonly register: (projectId: string) => Promise<void>;
  /**
   * Follows the panel's model, which the panel passes after every render:
   *
   * - the question, the field of a registration, and the sentence of the
   *   last action belong to the scope that they were about, so they go
   *   with every change of it: another project, a sign-out, or a state of
   *   another project, also when the same project comes back;
   * - the open question ends once the panel no longer offers it as it was
   *   asked, so that it never comes back on its own and a later `confirm`
   *   sends nothing;
   * - a link's choices follow the mounted folders, and a chosen folder
   *   that is no longer among them is no longer chosen.
   */
  readonly follow: (model: ProjectRepositoriesModel) => void;
}

/**
 * The actions of the panel: one at a time, each sent once and never again
 * on its own. The result is a fixed sentence; the list changes only with
 * the state that the main process sends, never from an answer. An answer
 * counts only while the scope that it started in has stayed (a scope
 * generation): after another project, a sign-out, or a switch away and
 * back, it shows no sentence, moves no focus, and leaves a name typed since
 * alone.
 */
export function createProjectRepositoryActions(
  bridge: Pick<
    ProjectRepositoriesBridge,
    "register" | "remove" | "link" | "unlink"
  >,
  onView: (view: ProjectRepositoryActionsView) => void,
): ProjectRepositoryActions {
  let running = false;
  let message: string | undefined;
  let dialog: ProjectRepositoryDialog | undefined;
  let registerDraft = "";
  let registerProblem: string | undefined;
  /** The latest model; undefined before the first one. */
  let model: ProjectRepositoriesModel | undefined;
  /** Grows with every change of the scope, also to null and back. */
  let generation = 0;
  const show = () =>
    onView(
      Object.freeze({
        running,
        message,
        dialog,
        registerDraft,
        registerProblem,
      }),
    );

  /**
   * Runs an action and says how it went, but only while the scope that it
   * started in has stayed. A link says meanwhile that the main process's
   * dialog waits for the person.
   */
  async function run<T>(
    kind: ProjectRepositoryActionKind,
    call: () => Promise<T>,
    describe: (result: T) => string,
    happened: (result: T) => boolean,
  ): Promise<void> {
    running = true;
    message =
      kind === "link" ? PROJECT_REPOSITORY_MESSAGES.linkWaiting : undefined;
    dialog = undefined;
    show();
    const started = generation;
    let sentence: string;
    let ok = false;
    try {
      // A bridge that throws at once counts as a call that failed too.
      const result = await call();
      ok = happened(result);
      sentence = describe(result);
    } catch {
      sentence = `${PROJECT_REPOSITORY_NOT_DONE_MESSAGES[kind]} ${PROJECT_REPOSITORY_NOT_SENT}`;
    }
    running = false;
    const still = generation === started;
    message = still ? sentence : undefined;
    if (still && ok && kind === "register") {
      registerDraft = "";
    }
    show();
  }

  function send(
    request: RepositoryActionRequest,
    mountId: string,
  ): Promise<void> {
    switch (request.kind) {
      case "remove":
        return run(
          "remove",
          () => bridge.remove(request.projectId, request.repositoryId),
          describeRemoveResult,
          (result) => result.outcome === "ok",
        );
      case "link":
        return run(
          "link",
          () => bridge.link(request.repositoryId, mountId),
          describeLinkResult,
          (result) => result.outcome === "linked",
        );
      case "unlink":
        return run(
          "unlink",
          () => bridge.unlink(request.repositoryId),
          describeUnlinkResult,
          (result) => result.outcome === "unlinked",
        );
    }
  }

  return Object.freeze({
    start: (request: RepositoryActionRequest) => {
      if (running) {
        return Promise.resolve();
      }
      switch (request.kind) {
        case "remove":
          dialog = Object.freeze({ kind: "remove", request });
          show();
          return Promise.resolve();
        case "link": {
          const choices =
            model === undefined
              ? []
              : folderChoices(model, request.repositoryId);
          dialog = Object.freeze({
            kind: "link",
            request,
            choices,
            mountId: initialFolderChoice(request.name, choices),
            problem: undefined,
          });
          show();
          return Promise.resolve();
        }
        case "unlink":
          return send(request, "");
      }
    },
    choose: (mountId: string) => {
      if (
        dialog?.kind === "link" &&
        dialog.choices.some((choice) => choice.mountId === mountId)
      ) {
        dialog = Object.freeze({ ...dialog, mountId, problem: undefined });
        show();
      }
    },
    confirm: () => {
      const open = dialog;
      if (running || open === undefined) {
        return Promise.resolve();
      }
      if (open.kind === "remove") {
        return send(open.request, "");
      }
      if (open.mountId === null) {
        dialog = Object.freeze({
          ...open,
          problem: PROJECT_REPOSITORY_QUESTION_MESSAGES.chooseFolder,
        });
        show();
        return Promise.resolve();
      }
      return send(open.request, open.mountId);
    },
    cancel: () => {
      if (dialog !== undefined) {
        dialog = undefined;
        show();
      }
    },
    editRegisterDraft: (text: string) => {
      registerDraft = text;
      // The problem was about the name as it was.
      registerProblem = undefined;
      show();
    },
    register: (projectId: string) => {
      if (running) {
        return Promise.resolve();
      }
      const name = repositoryNameToSend(registerDraft);
      registerProblem = repositoryNamePrompt(name);
      if (registerProblem !== undefined) {
        show();
        return Promise.resolve();
      }
      return run(
        "register",
        () => bridge.register(projectId, name),
        describeRegisterResult,
        (result) => result.outcome === "ok",
      );
    },
    follow: (next: ProjectRepositoriesModel) => {
      let changed = false;
      if (model !== undefined && next.scope !== model.scope) {
        generation += 1;
        changed =
          dialog !== undefined ||
          message !== undefined ||
          registerDraft !== "" ||
          registerProblem !== undefined;
        dialog = undefined;
        message = undefined;
        registerDraft = "";
        registerProblem = undefined;
      }
      model = next;
      if (dialog !== undefined && !isOffered(next, dialog)) {
        dialog = undefined;
        changed = true;
      }
      if (dialog?.kind === "link") {
        const choices = folderChoices(next, dialog.request.repositoryId);
        if (!sameChoices(choices, dialog.choices)) {
          const chosen = dialog.mountId;
          dialog = Object.freeze({
            ...dialog,
            choices,
            mountId: choices.some((choice) => choice.mountId === chosen)
              ? chosen
              : null,
          });
          changed = true;
        }
      }
      if (changed) {
        show();
      }
    },
  });
}
