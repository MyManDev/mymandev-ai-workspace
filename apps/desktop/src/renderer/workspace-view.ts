import type {
  AccountBridge,
  WorkspaceBridge,
} from "../shared/desktop-bridge.ts";
import type {
  WorkspaceActionRefusal,
  WorkspaceProblem,
  WorkspaceSwitchOptions,
  WorkspaceView,
} from "../shared/ipc-contract.ts";
import {
  ACTION_MESSAGES,
  canStartSignIn,
  startMessage,
  type AccountView,
} from "./account-view.ts";
import type { ShellAction } from "./screens.ts";

/** What the sidebar knows about the account's workspaces. */
export type WorkspacePanelView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first state. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly state: WorkspaceView };

export function initialWorkspacePanelView(
  bridgeAvailable: boolean,
): WorkspacePanelView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

/** The fixed texts of the sidebar for each workspace state. */
export const WORKSPACE_MESSAGES = Object.freeze({
  unavailable: "Workspaces are not available.",
  pending: "Checking the workspaces.",
  signedOut: "Workspaces appear once this device is signed in and ready.",
  loadingWorkspaces: "Loading the workspaces.",
  noWorkspaces: "No workspaces yet.",
  noneSelected: "Select a workspace to see its projects.",
  loadingProjects: "Loading the projects.",
  noProjects: "No projects yet.",
  switchFailed: "The workspace could not be switched.",
});

/**
 * Whether no device is signed in and ready: the workspace state is
 * `signed_out`. Before the first state and without the bridge, the shell
 * does not know, so it says nothing.
 */
export function noDeviceSignedIn(view: WorkspacePanelView): boolean {
  return view.kind === "known" && view.state.status === "signed_out";
}

/**
 * What the home screen says about the sign-in, with "Go to Account" in both
 * cases that say something (the Project Manager's decision of 2026-11-06),
 * and "Sign in with GitHub" in the first (#219).
 */
export type HomeSignIn =
  /** A device is signed in and ready, or the shell does not know. */
  | "none"
  /**
   * No device is signed in and ready, and the account panel offers a
   * sign-in that can start now: the home screen offers it too.
   */
  | "sign_in"
  /**
   * No device is signed in and ready, and something else comes first: the
   * first account status, the device key, a sign-in that runs, a removal
   * that waits for the server, or a build without a server address.
   */
  | "not_ready";

/** The fixed sentence of the home screen for each case that says something. */
export const HOME_SIGN_IN_MESSAGES: Readonly<
  Record<Exclude<HomeSignIn, "none">, string>
> = Object.freeze({
  sign_in:
    "Sign in with GitHub to see your workspaces. The sign-in continues on the Account screen.",
  // True in every case, like the sidebar's text for `signed_out`.
  not_ready: WORKSPACE_MESSAGES.signedOut,
});

/**
 * The home screen's case: nothing unless no device is signed in and ready
 * (`noDeviceSignedIn`); then "sign_in" only while the account panel offers
 * a sign-in that can start now (`canStartSignIn`), and "not_ready" in every
 * other case, also before the first account status and without the bridge.
 */
export function homeSignIn(
  workspaces: WorkspacePanelView,
  account: AccountView,
): HomeSignIn {
  if (!noDeviceSignedIn(workspaces)) {
    return "none";
  }
  return account.kind === "known" && canStartSignIn(account.status)
    ? "sign_in"
    : "not_ready";
}

/** What the home screen shows of the sign-in that it started (#219). */
export interface HomeSignInStartView {
  /** True while the main process answers the start. */
  readonly running: boolean;
  /** Why the last start was refused or failed, or undefined. */
  readonly message: string | undefined;
}

export const IDLE_HOME_SIGN_IN_START: HomeSignInStartView = Object.freeze({
  running: false,
  message: undefined,
});

export interface HomeSignInStart {
  /**
   * "Sign in with GitHub" on the home screen: the account panel's
   * `startSignIn()`, once; a click while a start runs changes nothing. The
   * home screen offers it under the panel's rule (`homeSignIn`), and the
   * main process applies its own rules to the start as to any other.
   */
  readonly start: () => void;
  /**
   * Passes the account status on. While a start runs, the first status
   * whose sign-in runs shows the account screen, so that the person sees
   * the progress and the pairing code there. Otherwise a sign-in that runs
   * ends the message of the last start, which then no longer applies.
   */
  readonly accountChanged: (view: AccountView) => void;
  /**
   * Passes on what the home screen says about the sign-in (`homeSignIn`),
   * or undefined while the shell shows another screen. Any change ends the
   * message of the last start: it shows only on the home screen that
   * refused the start, and only while the account panel's rule still gives
   * the same answer, so it is never announced again when the home screen is
   * shown again, nor left next to a button that a changed status enabled.
   */
  readonly homeChanged: (home: HomeSignIn | undefined) => void;
}

/**
 * The start of the sign-in from the home screen (#219), through the
 * account bridge's existing `startSignIn`. The main process publishes the
 * running sign-in before it opens the browser and answers the start only
 * afterwards, so `showAccount` follows the account status, and the answer
 * itself only when no such status came: once per start, for a start that
 * began or failed. A failure shows on the account screen with the status's
 * outcome. A refusal and a call that failed keep the home screen and show
 * the account panel's sentence there, until the next start, a sign-in that
 * runs, or a change of the home screen (`homeChanged`); `onView` gets every
 * change.
 */
export function createHomeSignInStart(
  account: Pick<AccountBridge, "startSignIn">,
  showAccount: () => void,
  onView: (view: HomeSignInStartView) => void,
): HomeSignInStart {
  let running = false;
  let shown = false;
  let message: string | undefined;
  let home: HomeSignIn | undefined;
  const show = () => onView(Object.freeze({ running, message }));
  const endMessage = () => {
    if (message !== undefined) {
      message = undefined;
      show();
    }
  };
  const showAccountOnce = () => {
    if (!shown) {
      shown = true;
      showAccount();
    }
  };
  return Object.freeze({
    start: () => {
      if (running) {
        return;
      }
      running = true;
      shown = false;
      message = undefined;
      show();
      void account
        .startSignIn()
        .then(
          (result) => {
            if (result.outcome !== "refused") {
              showAccountOnce();
            }
            return startMessage(result);
          },
          () => ACTION_MESSAGES.startFailed,
        )
        .then((next) => {
          running = false;
          message = next;
          show();
        });
    },
    accountChanged: (view: AccountView) => {
      if (view.kind !== "known" || view.status.signIn.kind === "idle") {
        return;
      }
      if (running) {
        showAccountOnce();
      } else {
        endMessage();
      }
    },
    homeChanged: (next: HomeSignIn | undefined) => {
      if (next !== home) {
        home = next;
        endMessage();
      }
    },
  });
}

/**
 * Why the workspaces are `unavailable`. What was loaded before stays shown,
 * and the main process loads again by itself.
 */
export const WORKSPACE_PROBLEM_MESSAGES: Readonly<
  Record<WorkspaceProblem, string>
> = Object.freeze({
  not_signed_in: "The server did not accept this device's sign-in.",
  not_found: "The server did not find the selected workspace.",
  rate_limited: "The server asked to wait. Trying again in a minute.",
  unavailable: "The server could not be reached. Trying again later.",
  failed: "The workspaces could not be loaded. Trying again later.",
});

/** Why a switch to another workspace was refused. */
export const SELECT_REFUSAL_MESSAGES: Readonly<
  Record<WorkspaceActionRefusal, string>
> = Object.freeze({
  not_found: "This workspace is no longer in the list.",
  too_soon: "Wait a moment before switching again.",
});

/**
 * A switch that waits for the person's answer, because chat messages wait
 * to be sent (the Project Manager's decision of 2026-11-05 on #27).
 */
export interface SwitchQuestion {
  /** Selecting another workspace, opening another project, or closing the project. */
  readonly kind: "workspace" | "project" | "close";
  /** How many chat messages wait to be sent, from 1. */
  readonly count: number;
}

/** The texts of the question before a switch. */
export interface SwitchQuestionTexts {
  readonly title: string;
  readonly text: string;
  readonly keep: string;
  readonly discard: string;
}

const SWITCH_ACTIONS = Object.freeze({
  workspace: {
    text: "Selecting another workspace discards",
    discard: "Discard and switch workspace",
  },
  project: {
    text: "Opening another project discards",
    discard: "Discard and open project",
  },
  close: {
    text: "Closing the project discards",
    discard: "Discard and close project",
  },
});

/** The texts of a question: what waits, what the switch does, and the two answers. */
export function describeSwitchQuestion(
  question: SwitchQuestion,
): SwitchQuestionTexts {
  const one = question.count === 1;
  const action = SWITCH_ACTIONS[question.kind];
  return {
    title: one
      ? "Discard the message that was not sent?"
      : "Discard the messages that were not sent?",
    text: one
      ? `1 message has not been sent yet. ${action.text} it.`
      : `${question.count} messages have not been sent yet. ${action.text} them.`,
    keep: one ? "Keep the message" : "Keep the messages",
    discard: action.discard,
  };
}

/** The option that repeats a switch and drops the waiting chat messages. */
const DISCARD_WAITING: WorkspaceSwitchOptions = Object.freeze({
  discardWaiting: true,
});

/** The answer of a switch to another workspace. */
export type SwitchAnswer =
  /** Done or refused, with the message to show, or undefined. */
  | { readonly kind: "done"; readonly message: string | undefined }
  /** Nothing changed, because `count` chat messages wait to be sent. */
  | { readonly kind: "waiting"; readonly count: number };

/**
 * Switches to another workspace and resolves to its answer. Every switch of
 * the shell goes through here. The main process closes the open project,
 * and its next state brings the new workspace's projects. While chat
 * messages wait to be sent, nothing changes and the answer is `waiting`
 * with their count; `{ discardWaiting: true }` repeats the switch and
 * drops them.
 */
export async function switchWorkspace(
  workspaces: Pick<WorkspaceBridge, "select">,
  workspaceId: string,
  options?: WorkspaceSwitchOptions,
): Promise<SwitchAnswer> {
  try {
    const result =
      options === undefined
        ? await workspaces.select(workspaceId)
        : await workspaces.select(workspaceId, options);
    switch (result.outcome) {
      case "ok":
        return { kind: "done", message: undefined };
      case "waiting":
        return { kind: "waiting", count: result.count };
      case "refused":
        return {
          kind: "done",
          message: SELECT_REFUSAL_MESSAGES[result.reason],
        };
    }
  } catch {
    return { kind: "done", message: WORKSPACE_MESSAGES.switchFailed };
  }
}

/** The workspace part of the shell, apart from React: see `createWorkspaceSidebar`. */
export interface WorkspaceSidebarController {
  /**
   * Subscribes to the workspace state. Returns the function that ends the
   * subscription and drops the answers that are still open.
   */
  readonly start: () => () => void;
  /**
   * Tells the main process which project is open, or null for none, and
   * drops the answer of the previous report.
   */
  readonly openProjectChanged: (projectId: string | null) => void;
  /** Switches to another workspace through `switchWorkspace`. */
  readonly select: (workspaceId: string) => void;
  /**
   * The person keeps the waiting chat messages: the switch does not happen,
   * and the shell shows the main process's open project again.
   */
  readonly keepWaiting: () => void;
  /** The person discards the waiting chat messages: the switch is repeated with them dropped. */
  readonly discardWaiting: () => void;
}

/** The switch that the open question belongs to. */
type WaitingSwitch =
  | { readonly kind: "select"; readonly workspaceId: string }
  | { readonly kind: "open"; readonly projectId: string | null };

/**
 * The workspace logic of the shell, which `App` drives from its effects.
 *
 * - Every state becomes the view and replaces the shell's projects, also
 *   when the shown view stays the same. A refused subscription makes the
 *   view unavailable.
 * - The main process closes its open project when the page reloads, so the
 *   shell reports its own, or null, at the start and after every change. A
 *   project that the main process does not hold (`not_found`) closes in the
 *   shell too; a failed call changes nothing.
 * - A switch clears the message first and then shows the text of its
 *   answer, if any. Only the answer of the latest switch counts. A newer
 *   workspace state clears the message.
 * - When a switch or a report answers `waiting`, nothing changed in the
 *   main process, and the person is asked (`onQuestion`). Keeping the
 *   messages puts the shell back on the main process's open project, from
 *   the last state, or on the home screen without one; a workspace switch
 *   had not changed the shell. Discarding them repeats the switch with
 *   `{ discardWaiting: true }`. A newer switch or report replaces the
 *   question.
 */
export function createWorkspaceSidebar(
  workspaces: Pick<
    WorkspaceBridge,
    "subscribeState" | "openProject" | "select"
  >,
  dispatch: (action: ShellAction) => void,
  onView: (view: WorkspacePanelView) => void,
  onMessage: (message: string | undefined) => void,
  onQuestion: (question: SwitchQuestion | undefined) => void,
): WorkspaceSidebarController {
  /** The revision of the last state, or -1 before the first one. */
  let revision = -1;
  /** The main process's open project, from the last state. */
  let mainOpenProjectId: string | null = null;
  /** The revision at which the shown message was set, or undefined. */
  let messageRevision: number | undefined;
  /** Each report and switch gets a new token; an older answer is dropped. */
  let reportToken = 0;
  let selectToken = 0;
  /** The switch that the shown question belongs to, or undefined. */
  let waiting: WaitingSwitch | undefined;

  const setMessage = (message: string | undefined) => {
    messageRevision = message === undefined ? undefined : revision;
    onMessage(message);
  };

  const ask = (next: WaitingSwitch, count: number) => {
    waiting = next;
    onQuestion({
      kind:
        next.kind === "select"
          ? "workspace"
          : next.projectId === null
            ? "close"
            : "project",
      count,
    });
  };

  const closeQuestion = () => {
    if (waiting !== undefined) {
      waiting = undefined;
      onQuestion(undefined);
    }
  };

  const report = (
    projectId: string | null,
    options?: WorkspaceSwitchOptions,
  ) => {
    reportToken += 1;
    const token = reportToken;
    const call =
      options === undefined
        ? workspaces.openProject(projectId)
        : workspaces.openProject(projectId, options);
    call.then(
      (result) => {
        if (token !== reportToken) {
          return;
        }
        if (result.outcome === "waiting") {
          ask({ kind: "open", projectId }, result.count);
        } else if (
          projectId !== null &&
          result.outcome === "refused" &&
          result.reason === "not_found"
        ) {
          dispatch({ type: "show-screen", screen: "home" });
        }
      },
      () => undefined,
    );
  };

  const switchTo = (workspaceId: string, options?: WorkspaceSwitchOptions) => {
    selectToken += 1;
    const token = selectToken;
    setMessage(undefined);
    void switchWorkspace(workspaces, workspaceId, options).then((answer) => {
      if (token !== selectToken) {
        return;
      }
      if (answer.kind === "waiting") {
        ask({ kind: "select", workspaceId }, answer.count);
      } else {
        setMessage(answer.message);
      }
    });
  };

  return Object.freeze({
    start: () => {
      const stop = workspaces.subscribeState(
        (state) => {
          revision = state.revision;
          mainOpenProjectId = state.openProjectId;
          onView({ kind: "known", state });
          dispatch({ type: "replace-projects", projects: state.projects });
          if (messageRevision !== undefined && revision > messageRevision) {
            setMessage(undefined);
          }
        },
        () => onView({ kind: "unavailable" }),
      );
      return () => {
        stop();
        reportToken += 1;
        selectToken += 1;
        closeQuestion();
      };
    },
    openProjectChanged: (projectId: string | null) => {
      closeQuestion();
      report(projectId);
    },
    select: (workspaceId: string) => {
      closeQuestion();
      switchTo(workspaceId);
    },
    keepWaiting: () => {
      const kept = waiting;
      closeQuestion();
      if (kept?.kind === "open") {
        dispatch(
          mainOpenProjectId === null
            ? { type: "show-screen", screen: "home" }
            : { type: "open-project", projectId: mainOpenProjectId },
        );
      }
    },
    discardWaiting: () => {
      const discarded = waiting;
      closeQuestion();
      if (discarded?.kind === "open") {
        report(discarded.projectId, DISCARD_WAITING);
      } else if (discarded?.kind === "select") {
        switchTo(discarded.workspaceId, DISCARD_WAITING);
      }
    },
  });
}
