import type { WorkspaceBridge } from "../shared/desktop-bridge.ts";
import type {
  CreateProjectRefusal,
  CreateProjectResult,
  CreateWorkspaceRefusal,
  CreateWorkspaceResult,
} from "../shared/ipc-contract.ts";
import { describeWait } from "./people-actions-view.ts";
import type { ShellAction } from "./screens.ts";
import type { WorkspacePanelView } from "./workspace-view.ts";

/**
 * The longest name of a workspace or a project in characters (Unicode code
 * points), as the contract and the protocol count it (`WORKSPACE_LIMITS.name`
 * and `LIMITS.name`; zod's `.max` counts a string's code points). The
 * renderer imports no value of the contract, so the tests check that the
 * two match.
 */
export const MAX_NEW_NAME_LENGTH = 100;

/** What a create makes (#95, D7). */
export type CreateKind = "workspace" | "project";

/**
 * Where a create starts, and where its sentence shows: the home screen's
 * form and the sidebar's "New workspace" make a workspace, and the
 * sidebar's "New project" a project in the selected workspace.
 */
export type CreatePlace = "home" | "workspaces" | "projects";

function kindOf(place: CreatePlace): CreateKind {
  return place === "projects" ? "project" : "workspace";
}

/** The labels and the other fixed texts of the creates. */
export const CREATE_MESSAGES = Object.freeze({
  homeTitle: "Create a workspace",
  homeIntro:
    "You are not in a workspace yet. Create one here, or join one on the Join screen.",
  newWorkspace: "New workspace",
  newProject: "New project",
  workspaceTitle: "Create a workspace",
  projectTitle: "Create a project",
  /**
   * What creating a workspace does (ADR 0014, "People and roles"): the
   * creator's person is its owner, under the account's display name, and
   * the owner cannot leave without handing the ownership over first.
   */
  workspaceHint:
    "You become its owner, and its people see you under your account's display name. An owner cannot leave the workspace without handing the ownership to someone else first.",
  /** What creating a project does (ADR 0005, #155). */
  projectHint:
    "Everyone in the workspace sees the project. Two projects of a workspace cannot have the same name, whatever the case.",
  /** Before the workspace's name in the project dialog. */
  projectIn: "In the workspace ",
  nameLabel: "Name",
  create: "Create",
  cancel: "Cancel",
  /** Before a create without a name. */
  nameMissing: "Enter a name.",
  /** Before a create with a longer name. */
  nameTooLong: `A name has at most ${String(MAX_NEW_NAME_LENGTH)} characters.`,
  /** After the sentence of a new workspace that the create did not select. */
  openWorkspace: "Open this workspace",
  /** After the sentence of a new project, once the list of projects holds it. */
  openProject: "Open this project",
});

/**
 * The name as the renderer sends it: trimmed of white space at the start
 * and the end, and a project's name normalized to Unicode NFC first, as the
 * protocol normalizes it (`normalizeProjectName`), so that the renderer
 * counts the characters that the protocol counts. A workspace's name is not
 * normalized, as in the protocol; trimming it only drops white space that
 * nobody sees.
 */
export function nameToSend(kind: CreateKind, text: string): string {
  return kind === "project" ? text.normalize("NFC").trim() : text.trim();
}

/**
 * The problem of a name before it is sent, or undefined: none after
 * `nameToSend`, or longer than the limit in characters (code points), as
 * the contract and the protocol count it. The main process refuses both,
 * and the call rejects for an empty or a longer one. A character takes one
 * or two UTF-16 code units, so the characters are counted only when the
 * name is longer in code units.
 */
export function newNamePrompt(name: string): string | undefined {
  if (name === "") {
    return CREATE_MESSAGES.nameMissing;
  }
  return name.length > MAX_NEW_NAME_LENGTH &&
    Array.from(name).length > MAX_NEW_NAME_LENGTH
    ? CREATE_MESSAGES.nameTooLong
    : undefined;
}

/** What the shell offers of the creates. */
export interface CreationOffer {
  /**
   * The home screen's form: a device is signed in, the list loaded, and the
   * account has no workspace.
   */
  readonly home: boolean;
  /**
   * The sidebar's "New workspace": whenever a device is signed in and
   * ready, also while the list loads or a retry waits, so that the button
   * does not leave the page with every switch.
   */
  readonly workspace: boolean;
  /**
   * The sidebar's "New project": the selected workspace's ID and its name
   * from the list, or null for a workspace that the list does not hold;
   * null without a selected workspace. Any active member of a workspace may
   * create a project in it (ADR 0005, #155), and the list holds only the
   * workspaces of which the account is an active member, so every role is
   * offered it.
   */
  readonly projectIn: {
    readonly workspaceId: string;
    readonly workspaceName: string | null;
  } | null;
}

const NO_OFFER: CreationOffer = Object.freeze({
  home: false,
  workspace: false,
  projectIn: null,
});

/** What the shell offers of the creates for the workspace state `view`. */
export function describeCreation(view: WorkspacePanelView): CreationOffer {
  if (view.kind !== "known" || view.state.status === "signed_out") {
    return NO_OFFER;
  }
  const { status, workspaces, selectedWorkspaceId } = view.state;
  return {
    home: status === "ready" && workspaces.length === 0,
    workspace: true,
    projectIn:
      selectedWorkspaceId === null
        ? null
        : {
            workspaceId: selectedWorkspaceId,
            workspaceName:
              workspaces.find(
                (workspace) => workspace.id === selectedWorkspaceId,
              )?.name ?? null,
          },
  };
}

/** The sentence after a create that the API confirmed. */
export const CREATE_DONE_MESSAGES = Object.freeze({
  workspaceSelected: "The workspace was created and selected.",
  workspaceNotSelected:
    "The workspace was created. Select it in the list of workspaces to open it.",
  project:
    "The project was created. It shows in the list of projects once the server reports it.",
});

/** The start of the sentence after a create that did not happen. */
export const CREATE_NOT_DONE_MESSAGES: Readonly<Record<CreateKind, string>> =
  Object.freeze({
    workspace: "The workspace could not be created.",
    project: "The project could not be created.",
  });

/**
 * The sentence after an answer that does not show whether the API acted
 * (`unknown`). The request is never sent again on its own; the person
 * checks the list.
 */
export const CREATE_UNKNOWN_MESSAGES: Readonly<Record<CreateKind, string>> =
  Object.freeze({
    workspace:
      "It is not known whether the workspace was created. Check the list of workspaces before you create it again; the request is not sent again on its own.",
    project:
      "It is not known whether the project was created. Check the list of projects before you create it again; the request is not sent again on its own.",
  });

/**
 * Why a create was refused, after its start. `too_soon` and `rate_limited`
 * say how long to wait (`describeWait`); `rate_limited` also names the
 * API's limits of the kind, because the API answers them with it (ADR 0014,
 * "Limits"; ADR 0005, #155; #255).
 */
export const CREATE_REFUSAL_MESSAGES: Readonly<
  Record<
    Exclude<
      CreateWorkspaceRefusal | CreateProjectRefusal,
      "too_soon" | "rate_limited"
    >,
    string
  >
> & {
  readonly tooSoon: (wait: string) => string;
  readonly rateLimited: Readonly<Record<CreateKind, (wait: string) => string>>;
} = Object.freeze({
  invalid:
    "The name is not allowed. Use visible characters, without line breaks.",
  not_selected:
    "Another workspace was selected before it was sent. Check the list, then try again.",
  not_signed_in:
    "This device is not signed in, or the server did not accept its sign-in.",
  unavailable:
    "This device cannot send it now. Wait until the sign-in or the current change of the account is finished, then try again.",
  tooSoon: (wait: string) =>
    `This device sent many changes in a short time. Try again in ${wait}.`,
  rateLimited: Object.freeze({
    workspace: (wait: string) =>
      `The server asked to wait. Try again in ${wait}. An account creates at most 10 workspaces in 24 hours.`,
    project: (wait: string) =>
      `The server asked to wait. Try again in ${wait}. A workspace holds at most 100 projects, and an account creates at most 20 projects in 24 hours.`,
  }),
  not_found:
    "The server does not know this workspace for your account. Check the list of workspaces.",
  conflict:
    "A project of this workspace already has this name, perhaps in other capitals. Choose another name.",
  failed: "The server refused it.",
});

/** The end of the sentence after a call that failed on its way; nothing was sent. */
export const CREATE_NOT_SENT = "It was not sent. Try again.";

/** The sentence after a result of a create of `kind`. */
export function describeCreateResult(
  kind: CreateKind,
  result: CreateWorkspaceResult | CreateProjectResult,
): string {
  switch (result.outcome) {
    case "ok":
      if (kind === "project") {
        return CREATE_DONE_MESSAGES.project;
      }
      return "selected" in result && result.selected
        ? CREATE_DONE_MESSAGES.workspaceSelected
        : CREATE_DONE_MESSAGES.workspaceNotSelected;
    case "unknown":
      return CREATE_UNKNOWN_MESSAGES[kind];
    case "refused": {
      const messages = CREATE_REFUSAL_MESSAGES;
      const wait = describeWait(result.retryAfterMs ?? 0);
      const reason =
        result.reason === "too_soon"
          ? messages.tooSoon(wait)
          : result.reason === "rate_limited"
            ? messages.rateLimited[kind](wait)
            : messages[result.reason];
      return `${CREATE_NOT_DONE_MESSAGES[kind]} ${reason}`;
    }
  }
}

/** The open dialog of the sidebar, which asks for the name. */
export interface CreateDialog {
  readonly place: "workspaces" | "projects";
  /**
   * For a project, the selected workspace's ID when the button was shown,
   * and its name, or null; null for a workspace.
   */
  readonly workspaceId: string | null;
  readonly workspaceName: string | null;
  /** The name in the field. */
  readonly draft: string;
  /** Why the name was not sent, or undefined. */
  readonly problem: string | undefined;
}

/**
 * What a confirmed create made that its sentence may offer to open (the
 * Project Manager's decision of 2026-11-12 on #95): a new workspace that
 * the create did not select, or a new project with the workspace that it
 * was created in.
 */
export type CreatedItem =
  | { readonly kind: "workspace"; readonly workspaceId: string }
  | {
      readonly kind: "project";
      readonly workspaceId: string;
      readonly projectId: string;
    };

/** The sentence of the last create and where it shows. */
export interface CreateMessage {
  readonly place: CreatePlace;
  readonly text: string;
  /** What the create made that the sentence may offer to open, or undefined. */
  readonly created?: CreatedItem | undefined;
}

/** The button that a create's sentence offers, at the sentence's place. */
export type CreatedOffer =
  | {
      readonly kind: "workspace";
      readonly place: CreatePlace;
      readonly workspaceId: string;
    }
  | {
      readonly kind: "project";
      readonly place: CreatePlace;
      readonly projectId: string;
    };

/**
 * The button that the sentence `message` offers by the workspace state
 * `workspaces`, or undefined:
 *
 * - "Open this workspace" for a new workspace that the create did not
 *   select, because chat messages wait to be sent or the selection changed
 *   while the create was on its way, while the list holds it and it is not
 *   the selected workspace, like the join screen's button (#249);
 * - "Open this project" for a new project once the list of projects holds
 *   it, which its `workspace.project.created` event brings, only while its
 *   workspace is still the selected one, and not while it is the open
 *   project. A new project never opens by itself.
 *
 * Nothing while no device is signed in and ready.
 */
export function describeCreatedOffer(
  message: CreateMessage | undefined,
  workspaces: WorkspacePanelView | undefined,
): CreatedOffer | undefined {
  const created = message?.created;
  if (
    message === undefined ||
    created === undefined ||
    workspaces?.kind !== "known" ||
    workspaces.state.status === "signed_out"
  ) {
    return undefined;
  }
  const { state } = workspaces;
  if (created.kind === "workspace") {
    return state.selectedWorkspaceId !== created.workspaceId &&
      state.workspaces.some((workspace) => workspace.id === created.workspaceId)
      ? Object.freeze({
          kind: "workspace",
          place: message.place,
          workspaceId: created.workspaceId,
        })
      : undefined;
  }
  return state.selectedWorkspaceId === created.workspaceId &&
    state.openProjectId !== created.projectId &&
    state.projects.some((project) => project.id === created.projectId)
    ? Object.freeze({
        kind: "project",
        place: message.place,
        projectId: created.projectId,
      })
    : undefined;
}

/** The existing paths that "Open this workspace" and "Open this project" take. */
export interface CreatedOpenPaths {
  /**
   * The sidebar's switch (`WorkspaceSidebar.onSelect`), which asks before
   * it drops chat messages that wait to be sent.
   */
  readonly selectWorkspace: (workspaceId: string) => void;
  /**
   * Opens a project as the sidebar's list of projects does: the main
   * process then opens it through the chat service's switch, which asks
   * first while chat messages wait to be sent.
   */
  readonly openProject: (projectId: string) => void;
}

/**
 * The paths of the buttons: the sidebar's switch `selectWorkspace` as it
 * is, and the shell's `open-project`, which `App` reports to the main
 * process as for a click in the list of projects. Neither drops a waiting
 * chat message: only the answer to the switch question does.
 */
export function createdOpenPaths(
  selectWorkspace: (workspaceId: string) => void,
  dispatch: (action: ShellAction) => void,
): CreatedOpenPaths {
  return Object.freeze({
    selectWorkspace: (workspaceId: string) => selectWorkspace(workspaceId),
    openProject: (projectId: string) =>
      dispatch({ type: "open-project", projectId }),
  });
}

/** What a create's result makes that its sentence may offer to open. */
function createdItem(
  workspaceId: string | null,
  result: CreateWorkspaceResult | CreateProjectResult | undefined,
): CreatedItem | undefined {
  if (result?.outcome !== "ok") {
    return undefined;
  }
  if ("selected" in result) {
    return result.selected
      ? undefined
      : Object.freeze({ kind: "workspace", workspaceId: result.workspaceId });
  }
  return workspaceId === null
    ? undefined
    : Object.freeze({
        kind: "project",
        workspaceId,
        projectId: result.projectId,
      });
}

/** What the shell shows of its creates. */
export interface CreationView {
  /**
   * True while a create runs: every create control stays focusable and
   * does nothing (`aria-disabled`), so that only one runs at a time.
   */
  readonly running: boolean;
  /** The open dialog of the sidebar, or undefined. */
  readonly dialog: CreateDialog | undefined;
  /** The name in the home screen's field. */
  readonly homeDraft: string;
  /**
   * Why the home screen's name was not sent, or undefined. It shows with
   * the field, apart from the results in the status paragraph.
   */
  readonly homeProblem: string | undefined;
  /** The sentence of the last create, or undefined. */
  readonly message: CreateMessage | undefined;
}

export const IDLE_CREATION: CreationView = Object.freeze({
  running: false,
  dialog: undefined,
  homeDraft: "",
  homeProblem: undefined,
  message: undefined,
});

export interface Creation {
  /**
   * Opens the sidebar's dialog for a workspace, or for a project in
   * `workspaceId`, the selected workspace that the button was shown for,
   * with the name that was left in it: after a cancel or a refusal it
   * comes back, and after a confirmed create it is empty. While a create
   * runs, nothing opens.
   */
  readonly open: (
    place: "workspaces" | "projects",
    workspaceId?: string,
    workspaceName?: string | null,
  ) => void;
  /** Changes the name in the dialog's field, and ends its problem. */
  readonly editDialogDraft: (text: string) => void;
  /** Closes the dialog without a create; the name stays for the next one. */
  readonly cancel: () => void;
  /**
   * Checks the dialog's name and keeps the dialog open with the problem;
   * otherwise closes it and creates. Resolves to true when the API
   * confirmed the create and its sentence shows.
   */
  readonly confirm: () => Promise<boolean>;
  /** Changes the name in the home screen's field, and ends its problem. */
  readonly editHomeDraft: (text: string) => void;
  /**
   * Creates a workspace with the home screen's name, once it passes
   * `newNamePrompt`, and keeps the problem otherwise. Resolves like
   * `confirm`.
   */
  readonly createFromHome: () => Promise<boolean>;
  /**
   * Follows the workspace state:
   *
   * - a sign-out ends everything: the dialog, the names, the problems, and
   *   the sentence, and no answer of a create that was on its way counts;
   * - a switch of the selected workspace ends a project's dialog, its name,
   *   and its sentence, which belong to the workspace that they were about;
   *   the sentence of a workspace's create stays through the switch to the
   *   workspace that it selected, and ends with any other switch.
   */
  readonly viewChanged: (view: WorkspacePanelView) => void;
  /**
   * Passes on whether the shell shows the home screen. Leaving it ends the
   * home screen's sentence and problem, which are about its form only; the
   * name stays.
   */
  readonly homeShown: (shown: boolean) => void;
  /**
   * "Open this workspace" or "Open this project": opens what the sentence
   * offers by the latest workspace state (`describeCreatedOffer`) through
   * its existing path, once per call. Nothing while a create runs or when
   * the sentence offers nothing. It never drops a waiting chat message:
   * the path asks the switch question. Returns whether it went.
   */
  readonly openCreated: (paths: CreatedOpenPaths) => boolean;
}

/**
 * The creates of the shell (#95, D7): one at a time, each sent once. The
 * result is a fixed sentence; the lists change only with the states that
 * the main process sends, never from the answer here.
 */
export function createCreation(
  bridge: Pick<WorkspaceBridge, "create" | "createProject">,
  onView: (view: CreationView) => void,
): Creation {
  let running = false;
  let dialog: CreateDialog | undefined;
  let homeDraft = "";
  let homeProblem: string | undefined;
  let message: CreateMessage | undefined;
  /** The names left in the dialog, by place; a project's for its workspace. */
  let workspaceDraft = "";
  let projectDraft = "";
  let projectDraftIn: string | null = null;
  /** The workspace that the last workspace create selected, or undefined. */
  let createdSelected: string | undefined;
  /** The selected workspace of the latest state; undefined before one. */
  let selected: string | null | undefined;
  /** The latest workspace state, for the sentence's button; undefined before one. */
  let latest: WorkspacePanelView | undefined;
  /**
   * Grows with every switch of the selected workspace and every sign-out,
   * so that a project's answer counts only when nothing of the kind
   * happened while it was on its way, also a switch away and back.
   */
  let selection = 0;
  /** Grows with every sign-out, so that nothing outlives the account's session. */
  let session = 0;
  let signedOut = false;
  let home = false;

  const show = () =>
    onView(Object.freeze({ running, dialog, homeDraft, homeProblem, message }));

  /**
   * Runs one create from `place` and says how it went there. A project's
   * answer counts only while its workspace has stayed selected since the
   * create started; a workspace's while the same session is signed in. An
   * answer that does not count shows no sentence and leaves a name typed
   * since alone. Resolves to true when the API confirmed a create that
   * counts, also when the home screen that started it is no longer shown.
   */
  async function run(
    place: CreatePlace,
    workspaceId: string | null,
    call: () => Promise<CreateWorkspaceResult | CreateProjectResult>,
  ): Promise<boolean> {
    const kind = kindOf(place);
    running = true;
    message = undefined;
    dialog = undefined;
    createdSelected = undefined;
    show();
    const startSelection = selection;
    const startSession = session;
    let result: CreateWorkspaceResult | CreateProjectResult | undefined;
    let sentence: string;
    try {
      result = await call();
      sentence = describeCreateResult(kind, result);
    } catch {
      sentence = `${CREATE_NOT_DONE_MESSAGES[kind]} ${CREATE_NOT_SENT}`;
    }
    const counts =
      session === startSession &&
      (kind === "workspace" ||
        (selection === startSelection && selected === workspaceId));
    const ok = counts && result?.outcome === "ok";
    // The home screen's sentence shows only on the home screen that
    // started it, never when the shell shows it again later.
    if (counts && (place !== "home" || home)) {
      message = Object.freeze({
        place,
        text: sentence,
        created: createdItem(workspaceId, result),
      });
    }
    if (ok && result !== undefined && "selected" in result) {
      createdSelected = result.selected ? result.workspaceId : undefined;
    }
    if (ok) {
      if (place === "home") {
        homeDraft = "";
      } else if (place === "workspaces") {
        workspaceDraft = "";
      } else {
        projectDraft = "";
      }
    }
    running = false;
    show();
    return ok;
  }

  function send(
    place: CreatePlace,
    workspaceId: string | null,
    name: string,
  ): Promise<CreateWorkspaceResult | CreateProjectResult> {
    return place === "projects" && workspaceId !== null
      ? bridge.createProject(workspaceId, name)
      : bridge.create(name);
  }

  /** Ends everything that belongs to the signed-in account. */
  function endSession(): boolean {
    const changed =
      dialog !== undefined ||
      message !== undefined ||
      homeDraft !== "" ||
      homeProblem !== undefined;
    dialog = undefined;
    message = undefined;
    homeDraft = "";
    homeProblem = undefined;
    workspaceDraft = "";
    projectDraft = "";
    projectDraftIn = null;
    createdSelected = undefined;
    return changed;
  }

  return Object.freeze({
    open: (
      place: "workspaces" | "projects",
      workspaceId?: string,
      workspaceName: string | null = null,
    ) => {
      if (running) {
        return;
      }
      if (place === "projects") {
        if (workspaceId === undefined) {
          return;
        }
        if (projectDraftIn !== workspaceId) {
          projectDraft = "";
          projectDraftIn = workspaceId;
        }
        dialog = Object.freeze({
          place,
          workspaceId,
          workspaceName,
          draft: projectDraft,
          problem: undefined,
        });
      } else {
        dialog = Object.freeze({
          place,
          workspaceId: null,
          workspaceName: null,
          draft: workspaceDraft,
          problem: undefined,
        });
      }
      show();
    },
    editDialogDraft: (text: string) => {
      if (dialog === undefined) {
        return;
      }
      if (dialog.place === "projects") {
        projectDraft = text;
      } else {
        workspaceDraft = text;
      }
      // The problem was about the name as it was.
      dialog = Object.freeze({ ...dialog, draft: text, problem: undefined });
      show();
    },
    cancel: () => {
      if (dialog !== undefined) {
        dialog = undefined;
        show();
      }
    },
    confirm: () => {
      const open = dialog;
      if (running || open === undefined) {
        return Promise.resolve(false);
      }
      const name = nameToSend(kindOf(open.place), open.draft);
      const problem = newNamePrompt(name);
      if (problem !== undefined) {
        dialog = Object.freeze({ ...open, problem });
        show();
        return Promise.resolve(false);
      }
      return run(open.place, open.workspaceId, () =>
        send(open.place, open.workspaceId, name),
      );
    },
    editHomeDraft: (text: string) => {
      homeDraft = text;
      homeProblem = undefined;
      show();
    },
    createFromHome: () => {
      if (running) {
        return Promise.resolve(false);
      }
      const name = nameToSend("workspace", homeDraft);
      homeProblem = newNamePrompt(name);
      if (homeProblem !== undefined) {
        show();
        return Promise.resolve(false);
      }
      return run("home", null, () => send("home", null, name));
    },
    viewChanged: (view: WorkspacePanelView) => {
      latest = view;
      if (view.kind !== "known") {
        return;
      }
      const { state } = view;
      if (state.status === "signed_out") {
        // A sign-out ends everything, also before any workspace was selected.
        let changed = false;
        if (!signedOut) {
          signedOut = true;
          session += 1;
          selection += 1;
          changed = endSession();
        }
        selected = null;
        if (changed) {
          show();
        }
        return;
      }
      signedOut = false;
      const before = selected;
      selected = state.selectedWorkspaceId;
      if (before === undefined || before === selected) {
        return;
      }
      selection += 1;
      let changed = false;
      if (dialog?.place === "projects") {
        dialog = undefined;
        changed = true;
      }
      projectDraft = "";
      projectDraftIn = null;
      if (
        message !== undefined &&
        (message.place === "projects" || createdSelected !== selected)
      ) {
        message = undefined;
        changed = true;
      }
      if (createdSelected !== selected) {
        createdSelected = undefined;
      }
      if (changed) {
        show();
      }
    },
    homeShown: (shown: boolean) => {
      if (shown === home) {
        return;
      }
      home = shown;
      if (!shown && (message?.place === "home" || homeProblem !== undefined)) {
        if (message?.place === "home") {
          message = undefined;
        }
        homeProblem = undefined;
        show();
      }
    },
    openCreated: (paths: CreatedOpenPaths) => {
      const offer = running ? undefined : describeCreatedOffer(message, latest);
      if (offer === undefined) {
        return false;
      }
      if (offer.kind === "workspace") {
        paths.selectWorkspace(offer.workspaceId);
      } else {
        paths.openProject(offer.projectId);
      }
      return true;
    },
  });
}
