import type { InvitationActionsBridge } from "../shared/desktop-bridge.ts";
import type {
  AcceptInvitationResult,
  JoinInvitationRefusal,
  PreviewInvitationResult,
} from "../shared/ipc-contract.ts";
import { describeWait } from "./people-actions-view.ts";
import type { WorkspacePanelView } from "./workspace-view.ts";

/**
 * An invitation code: `mmdi_` and 32 random bytes as canonical base64url,
 * 48 characters, like the protocol's `INVITATION_CODE_PATTERN` and the
 * contract's `InvitationCodeTextSchema`. The renderer imports no value of
 * either, so the tests check that they match.
 */
export const INVITATION_CODE_PATTERN =
  /^mmdi_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

/** The fixed texts of the join screen's invitation code. */
export const JOIN_MESSAGES = Object.freeze({
  title: "Join with an invitation code",
  hint: "If a workspace already added you as a person, its owner or an admin can give you an invitation code for that person. Paste the code here: you see the workspace and the person before you join. The application takes a code only when you paste it here, never from a link.",
  /** Without the bridge, outside Electron. */
  unavailable: "Joining with an invitation code is not available.",
  /** While the workspace state is `signed_out`. */
  signedOut:
    "You can join a workspace once this device is signed in and ready.",
  codeLabel: "Invitation code",
  preview: "Preview",
  cancel: "Cancel",
  join: "Join the workspace",
  /** Before a preview with nothing in the field. */
  codeMissing: "Paste an invitation code.",
  /** Before a preview with a text that is not a code once trimmed. */
  notACode:
    "This is not an invitation code. A code starts with mmdi_ and has 48 characters. Paste all of it.",
  /** The labels of the preview's facts. */
  workspace: "Workspace",
  person: "You join as",
  inviter: "Invited by",
  inviterLogin: ", GitHub ",
  inviterVerified: ", last verified ",
  expires: "Valid until",
  /** Below the preview: a name can be chosen freely, a login cannot. */
  loginCheck:
    "Check the inviter's GitHub login, not only the name: anyone can choose a name.",
  /** Before the joined workspace's name. */
  joinedWorkspace: "Joined: ",
  open: "Open this workspace",
  /** The joined workspace is the selected one. */
  joinedSelected:
    "It is the selected workspace now. Its projects are in the sidebar.",
  /** The workspace list does not hold the joined workspace yet. */
  joinedNotListed:
    "It appears in your list of workspaces once the list has loaded.",
  /** The parts of the screen that come later (#95). */
  later:
    "Asking to join a workspace by its ID, and your own join requests with a way to withdraw them, will be added here.",
});

/**
 * The question before an accept. Joining has effects that ADR 0014 asks
 * to tell the person about ("People and roles", "Invitations"): the
 * account claims the person and becomes a member; every member sees the
 * account's GitHub login next to the person's name; the owner and the
 * admins are told of the claim with the login and the creation date of the
 * GitHub account; and the code works once.
 */
export const JOIN_QUESTION = Object.freeze({
  title: "Join this workspace?",
  /** Before the person's name. */
  person: "You join as ",
  text: "You claim the person that the workspace added for you and become a member. Everyone in the workspace sees your GitHub login next to the person's name, and the owner and the admins are told that you joined, with your GitHub login and the creation date of your GitHub account. The code stops working once you join.",
  back: "Back",
  confirm: "Join",
});

/** The sentences after a preview or an accept. */
export const JOIN_RESULT_MESSAGES = Object.freeze({
  previewShown: "The invitation is shown below. Check it before you join.",
  joined: "You joined the workspace.",
  previewUnknown:
    "The preview got no clear answer from the server. Nothing was joined. Try again.",
  acceptUnknown:
    "It is not known whether you joined the workspace. Check the list of workspaces; the request is not sent again on its own.",
  /** The start of the sentence after a preview that did not happen. */
  previewNotDone: "The invitation could not be shown.",
  /** The start of the sentence after an accept that did not happen. */
  acceptNotDone: "You did not join the workspace.",
  /** The end of the sentence after a preview whose call failed on its way. */
  previewNotSent: "It was not sent. Try again.",
  /** The end of the sentence after an accept whose call failed on its way. */
  acceptNotSent: "It was not sent. Paste the code again to try again.",
  /** Once the clock passes the shown invitation's expiry. */
  previewExpired:
    "The invitation has expired. Ask the person who sent it for a new one.",
});

/**
 * Why a preview or an accept was refused, after its start. `too_soon` and
 * `rate_limited` say how long to wait (`describeWait`).
 */
export const JOIN_REFUSAL_MESSAGES: Readonly<
  Record<Exclude<JoinInvitationRefusal, "too_soon" | "rate_limited">, string>
> & {
  readonly tooSoon: (wait: string) => string;
  readonly rateLimited: (wait: string) => string;
} = Object.freeze({
  invalid: "The text is not an invitation code. Nothing was sent.",
  not_signed_in:
    "This device is not signed in, or the server did not accept its sign-in. Sign in on the Account screen, then try again.",
  unavailable:
    "This device cannot send it now. Wait until the sign-in or the current change of the account is finished, then try again.",
  tooSoon: (wait: string) =>
    `This device sent many requests in a short time. Try again in ${wait}.`,
  rateLimited: (wait: string) =>
    `The server asked to wait, for example after several codes that did not work. Try again in ${wait}.`,
  invitation_invalid:
    "The code does not work: it may be mistyped, expired, revoked, or already used, or its person may have been removed. Ask the person who sent it for a new invitation.",
  already_member:
    "You are already a member of this workspace, so the code was not used. Tell the person who sent it, so that they can revoke it.",
  failed: "The server refused it.",
});

/**
 * A character that a paste may carry around a code: white space and line
 * ends as `trim` removes them, the next line character U+0085, and the
 * format characters (`\p{Cf}`), such as a zero-width space or joiner, a
 * word joiner, a byte order mark, and the marks of the text's direction,
 * which chat applications add.
 */
const EDGE_CHARACTER = /^[\s\p{Cf}\u0085]$/u;

function isEdge(character: string | undefined): boolean {
  return character !== undefined && EDGE_CHARACTER.test(character);
}

/**
 * The pasted text without the characters that a paste may carry at its
 * ends (`EDGE_CHARACTER`), as the screen sends it. Only the ends change, so
 * a text that is not a code never becomes one: the pattern is anchored and
 * accepts ASCII only, and a character inside the text stays where it is.
 * It walks the characters from both ends, so a long paste costs one pass.
 */
export function pastedCode(text: string): string {
  const characters = Array.from(text);
  let start = 0;
  let end = characters.length;
  while (start < end && isEdge(characters[start])) {
    start += 1;
  }
  while (end > start && isEdge(characters[end - 1])) {
    end -= 1;
  }
  return characters.slice(start, end).join("");
}

/**
 * The problem of the pasted text before a preview, or undefined: nothing
 * once trimmed (`pastedCode`), or not an invitation code. The main process
 * refuses both, and the call rejects for them.
 */
export function codeProblem(text: string): string | undefined {
  const code = pastedCode(text);
  if (code === "") {
    return JOIN_MESSAGES.codeMissing;
  }
  return INVITATION_CODE_PATTERN.test(code)
    ? undefined
    : JOIN_MESSAGES.notACode;
}

/** What a preview shows: names, a login, and times, never the code. */
export interface InvitationPreview {
  readonly workspaceName: string;
  /** The display name of the person that the code claims. */
  readonly displayName: string;
  readonly inviterName: string;
  readonly inviterLogin: string;
  readonly inviterVerifiedAt: string;
  readonly expiresAt: string;
}

/**
 * Whether the invitation of `preview` has expired by the clock `now` in
 * milliseconds: its `expiresAt` is not later than now. The API refuses an
 * expired code in any case (`invitation_invalid`).
 */
export function previewExpired(
  preview: InvitationPreview,
  now: number,
): boolean {
  const end = Date.parse(preview.expiresAt);
  return !Number.isNaN(end) && end <= now;
}

/**
 * The time, in milliseconds, at which the screen reads the clock again
 * because it may offer something else: the expiry of the shown invitation,
 * while it is not marked expired and no request runs. It stays the same
 * once that time has passed, so that the timer fires at once and the
 * controller marks the invitation expired. Undefined when nothing changes.
 */
export function nextJoinClockChange(
  view: JoinInvitationView,
): number | undefined {
  if (view.preview === undefined || view.expired || view.running) {
    return undefined;
  }
  const end = Date.parse(view.preview.expiresAt);
  return Number.isNaN(end) ? undefined : end;
}

/** The workspace that an accept joined: its ID, to select it, and its name. */
export interface JoinedWorkspace {
  readonly workspaceId: string;
  readonly workspaceName: string;
}

/** The sentence after a preview's answer that shows no invitation. */
export function describePreviewFailure(
  result: Exclude<PreviewInvitationResult, { outcome: "ok" }>,
): string {
  return result.outcome === "unknown"
    ? JOIN_RESULT_MESSAGES.previewUnknown
    : `${JOIN_RESULT_MESSAGES.previewNotDone} ${refusalText(result.reason, result.retryAfterMs)}`;
}

/** The sentence after an accept's answer. */
export function describeAcceptResult(result: AcceptInvitationResult): string {
  switch (result.outcome) {
    case "ok":
      return JOIN_RESULT_MESSAGES.joined;
    case "unknown":
      return JOIN_RESULT_MESSAGES.acceptUnknown;
    case "refused":
      return `${JOIN_RESULT_MESSAGES.acceptNotDone} ${refusalText(result.reason, result.retryAfterMs)}`;
  }
}

function refusalText(
  reason: JoinInvitationRefusal,
  retryAfterMs: number | null,
): string {
  const wait = describeWait(retryAfterMs ?? 0);
  switch (reason) {
    case "too_soon":
      return JOIN_REFUSAL_MESSAGES.tooSoon(wait);
    case "rate_limited":
      return JOIN_REFUSAL_MESSAGES.rateLimited(wait);
    default:
      return JOIN_REFUSAL_MESSAGES[reason];
  }
}

/**
 * What the screen offers for the joined workspace, by the latest workspace
 * state: `selected` once it is the selected workspace, `open` while the
 * list holds it and another one or none is selected, and `not_listed`
 * until the list holds it. The workspace service loads the list again
 * after an accept and selects the joined workspace only when none was
 * selected.
 */
export function describeJoined(
  joined: JoinedWorkspace,
  workspaces: WorkspacePanelView,
): "selected" | "open" | "not_listed" {
  if (workspaces.kind !== "known") {
    return "not_listed";
  }
  const { state } = workspaces;
  if (state.selectedWorkspaceId === joined.workspaceId) {
    return "selected";
  }
  return state.workspaces.some(
    (workspace) => workspace.id === joined.workspaceId,
  )
    ? "open"
    : "not_listed";
}

/**
 * Whether the join screen offers its form: with the bridge, and unless the
 * workspace state says that no device is signed in and ready.
 */
export function joinAvailability(
  bridgeAvailable: boolean,
  workspaces: WorkspacePanelView,
): "form" | "unavailable" | "signed_out" {
  if (!bridgeAvailable) {
    return "unavailable";
  }
  return workspaces.kind === "known" && workspaces.state.status === "signed_out"
    ? "signed_out"
    : "form";
}

/** What the join screen shows of its invitation code. */
export interface JoinInvitationView {
  /**
   * True while a preview or an accept runs: the field is read-only, and
   * every button stays focusable and does nothing (`aria-disabled`), so
   * that one request runs at a time.
   */
  readonly running: boolean;
  /**
   * The text of the field, as pasted. It is the only place of the code in
   * the renderer, apart from a request on its way; it is empty again after
   * an accept, "Cancel", a workspace switch, and a sign-out.
   */
  readonly code: string;
  /**
   * Why the text was not sent, or undefined. It shows with the field,
   * apart from the results in the status paragraph.
   */
  readonly problem: string | undefined;
  /** The invitation of the code in the field, or undefined. */
  readonly preview: InvitationPreview | undefined;
  /**
   * Whether the shown invitation has expired by the clock: the screen then
   * offers no "Join the workspace", and the question is closed.
   */
  readonly expired: boolean;
  /** Whether the question before an accept is open. */
  readonly asking: boolean;
  /** A fixed sentence about the last preview or accept, or undefined. */
  readonly message: string | undefined;
  /** The workspace that the last accept joined, or undefined. */
  readonly joined: JoinedWorkspace | undefined;
}

export const IDLE_JOIN_INVITATION: JoinInvitationView = Object.freeze({
  running: false,
  code: "",
  problem: undefined,
  preview: undefined,
  expired: false,
  asking: false,
  message: undefined,
  joined: undefined,
});

export interface JoinInvitation {
  /**
   * Changes the text of the field, and ends its problem, its preview, and
   * the question, which were about the text as it was. Nothing while a
   * request runs, when the field is read-only.
   */
  readonly editCode: (text: string) => void;
  /**
   * Previews the trimmed text of the field, once it is an invitation code
   * (`codeProblem`), and keeps the problem otherwise; nothing is sent then.
   * A preview that goes ends the sentence and the joined workspace of the
   * last accept, because the screen is then about another code. Nothing
   * while a request runs. Resolves when the answer counted or was dropped.
   */
  readonly preview: () => Promise<void>;
  /**
   * Opens the question before an accept, while a preview shows that has
   * not expired by the clock.
   */
  readonly ask: () => void;
  /** Closes the question and keeps the code and its preview. */
  readonly back: () => void;
  /**
   * Accepts the previewed code, once the question is open and the
   * invitation has not expired by the clock. The field and
   * the controller drop the code before the request goes, so that it lives
   * only in the request; the preview goes with the answer. Resolves to true
   * when the answer counted, because "Join the workspace" then leaves the
   * page.
   */
  readonly confirm: () => Promise<boolean>;
  /**
   * Drops the code, its problem, and its preview, with the sentence of the
   * last preview or accept, while there is one of the three; the joined
   * workspace stays. Nothing while a request runs. Returns true when it
   * dropped something, because "Cancel", which shows only then, leaves the
   * page.
   */
  readonly cancel: () => boolean;
  /**
   * Follows the workspace state. A switch of the selected workspace drops
   * the code, its problem, its preview, the question, and the sentence of
   * a preview; a preview's answer that was on its way is dropped. The
   * sentence of an accept and the joined workspace stay, because they are
   * not about the selected workspace, and the service may select the
   * joined one by itself. A sign-out drops everything, also an accept's
   * answer that is still on its way.
   */
  readonly workspacesChanged: (workspaces: WorkspacePanelView) => void;
  /**
   * Reads the clock again, at the shown invitation's expiry and when the
   * window gets the focus or becomes visible: once it has expired, the
   * question closes, "Join the workspace" goes, and the sentence says so.
   */
  readonly clockChanged: () => void;
}

/**
 * The invitation code of the join screen (#95, decision D2): a preview,
 * then an accept after a question, one request at a time, each sent once.
 * The pasted text is trimmed and checked against `INVITATION_CODE_PATTERN`
 * before it is sent, because the main process trims nothing (the Project
 * Manager's decision of 2026-11-06). The code lives only in the field's
 * text and in a request on its way: no sentence, problem, preview, or log
 * holds it. Only the joined workspace's ID and name are kept of an
 * accept's answer. `now` is the renderer's clock in milliseconds.
 */
export function createJoinInvitation(
  bridge: Pick<InvitationActionsBridge, "preview" | "accept">,
  onView: (view: JoinInvitationView) => void,
  now: () => number = Date.now,
): JoinInvitation {
  let running = false;
  let code = "";
  let problem: string | undefined;
  let preview: InvitationPreview | undefined;
  /** Whether `preview` has expired by the clock. */
  let expired = false;
  let asking = false;
  let message: string | undefined;
  /** Whether the sentence is about an accept, which a switch keeps. */
  let messageOfAccept = false;
  let joined: JoinedWorkspace | undefined;
  /** The selected workspace of the latest state; undefined before one. */
  let selected: string | null | undefined;
  /** Whether the latest state is `signed_out`, so that a session ends once. */
  let signedOut = false;
  /**
   * Grows whenever the code goes: "Cancel", a switch, and a sign-out, so
   * that a preview's answer counts only for the code that it was asked
   * for.
   */
  let generation = 0;
  /** Grows with every sign-out, so that no answer outlives the session. */
  let session = 0;
  const show = () =>
    onView(
      Object.freeze({
        running,
        code,
        problem,
        preview,
        expired,
        asking,
        message,
        joined,
      }),
    );

  /**
   * Whether the shown invitation has expired by the clock now. The first
   * time, outside a request, the question closes and the sentence of the
   * preview says so; an accept's sentence stays.
   */
  function expiredNow(): boolean {
    if (preview === undefined || expired || running) {
      return expired;
    }
    if (!previewExpired(preview, now())) {
      return false;
    }
    expired = true;
    asking = false;
    if (!messageOfAccept) {
      setMessage(JOIN_RESULT_MESSAGES.previewExpired, false);
    }
    show();
    return true;
  }

  /** Drops the code with everything that is about it. */
  function dropCode(): void {
    code = "";
    problem = undefined;
    preview = undefined;
    expired = false;
    asking = false;
  }

  function setMessage(text: string | undefined, ofAccept: boolean): void {
    message = text;
    messageOfAccept = ofAccept;
  }

  return Object.freeze({
    editCode: (text: string) => {
      if (running) {
        return;
      }
      code = text;
      problem = undefined;
      preview = undefined;
      expired = false;
      asking = false;
      show();
    },
    preview: async () => {
      if (running) {
        return;
      }
      const sent = pastedCode(code);
      problem = codeProblem(code);
      if (problem !== undefined) {
        show();
        return;
      }
      running = true;
      preview = undefined;
      expired = false;
      asking = false;
      joined = undefined;
      setMessage(undefined, false);
      show();
      const startGeneration = generation;
      let shown: InvitationPreview | undefined;
      let sentence: string;
      try {
        const result = await bridge.preview(sent);
        if (result.outcome === "ok") {
          // Field by field: nothing else of the answer is kept.
          shown = Object.freeze({
            workspaceName: result.workspaceName,
            displayName: result.displayName,
            inviterName: result.inviterName,
            inviterLogin: result.inviterLogin,
            inviterVerifiedAt: result.inviterVerifiedAt,
            expiresAt: result.expiresAt,
          });
          sentence = JOIN_RESULT_MESSAGES.previewShown;
        } else {
          sentence = describePreviewFailure(result);
        }
      } catch {
        // A fixed text: never the error, which might name the call.
        sentence = `${JOIN_RESULT_MESSAGES.previewNotDone} ${JOIN_RESULT_MESSAGES.previewNotSent}`;
      }
      running = false;
      if (generation === startGeneration) {
        preview = shown;
        // An invitation that has expired by the clock offers no join.
        expired = shown !== undefined && previewExpired(shown, now());
        setMessage(
          expired ? JOIN_RESULT_MESSAGES.previewExpired : sentence,
          false,
        );
      }
      show();
    },
    ask: () => {
      if (!running && preview !== undefined && !asking && !expiredNow()) {
        asking = true;
        show();
      }
    },
    back: () => {
      if (asking) {
        asking = false;
        show();
      }
    },
    confirm: async () => {
      const sent = pastedCode(code);
      if (
        running ||
        !asking ||
        preview === undefined ||
        expiredNow() ||
        !INVITATION_CODE_PATTERN.test(sent)
      ) {
        return false;
      }
      // The code leaves the field before the request goes; the preview
      // stays until the answer, so that the screen does not jump.
      code = "";
      problem = undefined;
      asking = false;
      running = true;
      joined = undefined;
      setMessage(undefined, false);
      show();
      const startSession = session;
      let sentence: string;
      let joinedNow: JoinedWorkspace | undefined;
      try {
        const result = await bridge.accept(sent);
        if (result.outcome === "ok") {
          // Only the workspace: never anything else of the answer.
          joinedNow = Object.freeze({
            workspaceId: result.workspaceId,
            workspaceName: result.workspaceName,
          });
        }
        sentence = describeAcceptResult(result);
      } catch {
        sentence = `${JOIN_RESULT_MESSAGES.acceptNotDone} ${JOIN_RESULT_MESSAGES.acceptNotSent}`;
      }
      running = false;
      const counts = session === startSession;
      if (counts) {
        preview = undefined;
        expired = false;
        joined = joinedNow;
        setMessage(sentence, true);
      }
      show();
      return counts;
    },
    cancel: () => {
      if (running) {
        return false;
      }
      const changed =
        code !== "" || problem !== undefined || preview !== undefined;
      if (changed) {
        generation += 1;
        dropCode();
        setMessage(undefined, false);
        show();
      }
      return changed;
    },
    workspacesChanged: (workspaces: WorkspacePanelView) => {
      if (workspaces.kind !== "known") {
        return;
      }
      const { state } = workspaces;
      if (state.status === "signed_out") {
        if (!signedOut) {
          signedOut = true;
          session += 1;
          generation += 1;
        }
        selected = null;
        const changed =
          code !== "" ||
          problem !== undefined ||
          preview !== undefined ||
          asking ||
          message !== undefined ||
          joined !== undefined;
        dropCode();
        setMessage(undefined, false);
        joined = undefined;
        if (changed) {
          show();
        }
        return;
      }
      signedOut = false;
      const before = selected;
      selected = state.selectedWorkspaceId;
      // The first selection after none, such as the default workspace that
      // the service selects once the list loads, is no switch: a preview
      // and an accept are not tied to the selected workspace.
      if (before !== undefined && before !== null && before !== selected) {
        generation += 1;
        dropCode();
        if (!messageOfAccept) {
          setMessage(undefined, false);
        }
        show();
      }
    },
    clockChanged: () => {
      expiredNow();
    },
  });
}

/**
 * Whether the focus moves to the screen's title as a control leaves the
 * page without the person's click on it, such as "Join the workspace"
 * after a switch that closed the question, or "Open this workspace" once
 * the joined workspace is selected: it was shown, it is gone now, and the
 * focus fell to the page.
 */
export function focusesTitleAfterLeave(
  wasShown: boolean,
  isShown: boolean,
  focusOnPage: boolean,
): boolean {
  return wasShown && !isShown && focusOnPage;
}
