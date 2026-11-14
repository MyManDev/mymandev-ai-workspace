import type {
  InvitationActionsBridge,
  JoinRequestActionsBridge,
  JoinRequestsBridge,
} from "../shared/desktop-bridge.ts";
import type {
  ApproveJoinRequestResult,
  CreateInvitationResult,
  JoinRequestActionRefusal,
  JoinRequestActionResult,
  JoinRequestLoadResult,
  JoinRequestsView,
  PersonView,
  WorkspaceProblem,
} from "../shared/ipc-contract.ts";
import {
  describeInvitationActionResult,
  INVITATION_ACTION_NOT_DONE_MESSAGES,
  isDemoted,
  withoutCode,
  type InvitationCodeView,
} from "./invitations-view.ts";
import {
  describeWait,
  namePrompt,
  PEOPLE_ACTION_NOT_SENT,
  PEOPLE_ACTION_REFUSAL_MESSAGES,
} from "./people-actions-view.ts";
import type { PeopleScreenView } from "./people-view.ts";

// The join requests part of the people screen (#95; ADR 0014, "Join
// requests"; decisions D1 to D3 of 2026-11-06): the selected workspace's
// pending join requests and blocked accounts for the owner and the admins,
// the decisions on them, and the pause of new requests. "Deny and invite
// instead" is composed here, the invitation first (the Project Manager's
// decisions of 2026-11-12 and 2026-11-13): it is offered only while the
// workspace has active unclaimed people, the approver chooses one of them,
// an invitation is created for that person and its code shown once (D2),
// and only then is the request denied. When the invitation is not created
// or it is uncertain, the request stays pending. A demotion of the account
// to a member drops the code from the open dialog, which then says that the
// code no longer works, as for the invitations (#266).

/** What the screen knows of the selected workspace's join requests. */
export type JoinRequestsScreenView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first state. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly state: JoinRequestsView };

export function initialJoinRequestsScreenView(
  bridgeAvailable: boolean,
): JoinRequestsScreenView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

/**
 * Subscribes to the join requests and reports every state as the view; a
 * refused subscription makes the view unavailable. As the screen opens, it
 * asks the main process to load them once (D3). The main process counts the
 * request also while it refuses it, for example for a member or before a
 * workspace is selected, and loads them once it may, so its answer shows
 * only in the state. Returns the function that ends the subscription.
 */
export function followJoinRequests(
  joinRequests: Pick<JoinRequestsBridge, "subscribeState" | "load">,
  onView: (view: JoinRequestsScreenView) => void,
): () => void {
  const stop = joinRequests.subscribeState(
    (state) => onView({ kind: "known", state }),
    () => onView({ kind: "unavailable" }),
  );
  joinRequests.load().catch(() => undefined);
  return stop;
}

/** The fixed texts of the join requests part. */
export const JOIN_REQUEST_MESSAGES = Object.freeze({
  heading: "Join requests",
  blockedHeading: "Blocked accounts",
  unavailable: "Join requests are not available.",
  pending: "Checking the join requests.",
  loading: "Loading the join requests.",
  empty: "No pending join requests.",
  /** Before the requester's GitHub login. */
  github: "GitHub ",
  /** Before the date on which the login was last verified. */
  verified: ", last verified ",
  /** Before the creation date of the requester's GitHub account. */
  accountCreated: "GitHub account created ",
  /** Before the end of a pending request. */
  expires: "Expires ",
  /** Before the time of a block. */
  blockedAt: "Blocked ",
  /** A blocked account whose data was erased. */
  noLogin: "No GitHub login",
  /** While new requests are accepted. */
  accepting: "New join requests are accepted.",
  /** Before the time of the pause. */
  pausedSince: "New join requests have been paused since ",
  /** After the time of the pause. */
  pausedAfter: ". Pending requests stay open.",
  refresh: "Refresh the join requests",
});

/**
 * Why the join requests are `unavailable`: the failure of the last load.
 * What was loaded before stays shown, and the main process loads again by
 * itself.
 */
export const JOIN_REQUEST_PROBLEM_MESSAGES: Readonly<
  Record<WorkspaceProblem, string>
> = Object.freeze({
  not_signed_in: "The server did not accept this device's sign-in.",
  not_found: "The server did not find the selected workspace.",
  rate_limited: "The server asked to wait. Trying again in a minute.",
  unavailable: "The server could not be reached. Trying again later.",
  failed: "The join requests could not be loaded. Trying again later.",
});

/** The actions of the join requests part. */
export type JoinRequestActionKind =
  | "approve"
  | "invite"
  | "deny"
  | "denyAll"
  | "block"
  | "unblock"
  | "pause"
  | "resume";

/**
 * An action that the screen offers, with the selected workspace's ID when
 * the screen showed it. The IDs go only to the bridges; the screen never
 * shows them. "invite" is "Deny and invite instead".
 */
export type JoinRequestActionRequest =
  | PendingRequestAction<"approve">
  | PendingRequestAction<"invite">
  | PendingRequestAction<"deny">
  | PendingRequestAction<"block">
  | {
      readonly kind: "unblock";
      readonly workspaceId: string;
      readonly joinRequestId: string;
      readonly name: string;
      /** Null after the account's data was erased. */
      readonly login: string | null;
    }
  | WorkspaceRequestAction<"denyAll">
  | WorkspaceRequestAction<"pause">
  | WorkspaceRequestAction<"resume">;

/** An action on a pending request. */
interface PendingRequestAction<K extends JoinRequestActionKind> {
  readonly kind: K;
  readonly workspaceId: string;
  readonly joinRequestId: string;
  /** The requested display name. */
  readonly name: string;
  /** The requester's GitHub login. */
  readonly login: string;
  /**
   * The creation date of the requester's GitHub account, which the
   * questions of an approval and of "Deny and invite instead" show.
   */
  readonly accountCreatedAt: string;
}

/** An action on the workspace's join requests as a whole. */
interface WorkspaceRequestAction<K extends JoinRequestActionKind> {
  readonly kind: K;
  readonly workspaceId: string;
}

/** The labels of the actions' buttons. */
export const JOIN_REQUEST_ACTION_LABELS: Readonly<
  Record<JoinRequestActionKind, string>
> = Object.freeze({
  approve: "Approve",
  invite: "Deny and invite instead",
  deny: "Deny",
  denyAll: "Deny all",
  block: "Block",
  unblock: "Unblock",
  pause: "Pause new requests",
  resume: "Accept new requests again",
});

/**
 * The actions that ask first: every destructive one (deny, deny all, and
 * block, as a removal asks in #244), the approval, which asks for the name,
 * "Deny and invite instead", which asks for the person, and an unblock,
 * after which the account can ask to join again at once (the Project
 * Manager's decision of 2026-11-13). A pause and a resume run at once; each
 * can be undone at once.
 */
export const ASKING_JOIN_REQUEST_ACTIONS: ReadonlySet<JoinRequestActionKind> =
  new Set(["approve", "invite", "deny", "denyAll", "block", "unblock"]);

/** The question of an action that asks first. */
export interface JoinRequestQuestion {
  readonly title: string;
  readonly text: string;
  /** The confirming button. */
  readonly confirm: string;
}

/** The fixed texts of the questions' fields. */
export const JOIN_REQUEST_QUESTION_MESSAGES = Object.freeze({
  /** The label of the approval's name field. */
  nameLabel: "Name in this workspace",
  /** The legend of the unclaimed people that "Deny and invite instead" may invite. */
  inviteLegend: "Person to invite",
  /** Why "Deny and invite instead" was not sent: no person is chosen. */
  noInvitee: "Choose the person to invite.",
});

/**
 * The question of each action that asks first, or undefined for a pause
 * and a resume, which never ask.
 */
export function describeJoinRequestQuestion(
  request: JoinRequestActionRequest,
): JoinRequestQuestion | undefined {
  switch (request.kind) {
    case "approve":
      return {
        title: "Approve this request?",
        text: "The account joins the workspace as a member with this name. Everyone in the workspace sees the name next to the account's GitHub login. Check the login and the creation date of the GitHub account, not only the name.",
        confirm: "Approve",
      };
    case "invite":
      return {
        title: "Deny and invite instead?",
        text: "Choose the unclaimed person that this account should claim, and check the login and the creation date of the GitHub account, not only the name. First an invitation is created for that person, and its code is shown once. Pass it on privately, only to this account. Only then is the request denied. If the invitation cannot be created, the request stays pending. A person who already has an open invitation gets a new one, and the earlier code stops working.",
        confirm: "Create the invitation, then deny",
      };
    case "deny":
      return {
        title: "Deny this request?",
        text: "The request ends. The account can ask to join this workspace again later.",
        confirm: "Deny",
      };
    case "denyAll":
      return {
        title: "Deny all pending requests?",
        text: "Every pending request of this workspace ends, also one that arrived after this list was shown. The accounts can ask to join again later.",
        confirm: "Deny all",
      };
    case "block":
      return {
        title: "Block this account?",
        text: "The request ends, and this account cannot ask to join this workspace again until it is unblocked.",
        confirm: "Block",
      };
    case "unblock":
      return {
        title: "Unblock this account?",
        text: "The block ends, and this account can ask to join this workspace again at once.",
        confirm: "Unblock",
      };
    case "pause":
    case "resume":
      return undefined;
  }
}

/** A pending request as the screen shows it. */
export interface PendingRequestRow {
  /** The key of the row only; the screen never shows it. */
  readonly joinRequestId: string;
  readonly requestedName: string;
  readonly login: string;
  readonly verifiedAt: string;
  readonly accountCreatedAt: string;
  readonly expiresAt: string;
  /**
   * Approve, Deny and invite instead (only while the workspace has active
   * unclaimed people), Deny, and Block, in this order.
   */
  readonly actions: readonly JoinRequestActionRequest[];
}

/** A block in force as the screen shows it. */
export interface BlockedRequestRow {
  /** The key of the row only; the screen never shows it. */
  readonly joinRequestId: string;
  readonly requestedName: string;
  /** Null, with the times, after the account's data was erased. */
  readonly login: string | null;
  readonly verifiedAt: string | null;
  readonly accountCreatedAt: string | null;
  readonly blockedAt: string;
  readonly unblock: JoinRequestActionRequest;
}

/** An active unclaimed person that "Deny and invite instead" may invite. */
export interface InviteOption {
  readonly memberId: string;
  readonly name: string;
}

/** What the screen shows of the join requests, for the owner and the admins. */
export interface JoinRequestsModel {
  /** The text of the part's status paragraph; empty when there is none. */
  readonly status: string;
  /** The pending requests, in the main process's order. */
  readonly pending: readonly PendingRequestRow[];
  /** The blocks in force, in the main process's order. */
  readonly blocked: readonly BlockedRequestRow[];
  /** "Deny all", while a request is pending; null otherwise. */
  readonly denyAll: JoinRequestActionRequest | null;
  /**
   * The pause of new requests, with its time or null while they are
   * accepted, and the action that changes it; null until the list loaded.
   */
  readonly pause: {
    readonly pausedAt: string | null;
    readonly request: JoinRequestActionRequest;
  } | null;
  /**
   * The active unclaimed people, in the people's order: whom "Deny and
   * invite instead" may invite, and only while there is one.
   */
  readonly unclaimed: readonly InviteOption[];
}

/**
 * The selected workspace and its people, only while the people are `ready`
 * and the account's own active person is the owner or an admin, who list
 * and decide on join requests (ADR 0014, "People and roles").
 */
function managedWorkspace(view: PeopleScreenView): {
  readonly workspaceId: string;
  readonly people: readonly PersonView[];
} | null {
  if (view.kind !== "known" || view.state.status !== "ready") {
    return null;
  }
  const { state } = view;
  const own = state.people.find(
    (person) => !person.former && person.memberId === state.ownMemberId,
  );
  if (
    state.workspaceId === null ||
    own === undefined ||
    (own.role !== "owner" && own.role !== "admin")
  ) {
    return null;
  }
  return { workspaceId: state.workspaceId, people: state.people };
}

/**
 * What the screen shows of the join requests, or null for no join requests
 * part at all: without the owner's or an admin's role in the selected
 * workspace, while the people are not `ready`, as for the invitations, and
 * while the join requests say `not_allowed`, so that a demotion that the
 * main process applied hides the part before the people show it.
 *
 * - The pending requests of the selected workspace only, never another
 *   workspace's, each with its requested name, the requester's GitHub login
 *   with the date it was last verified, the creation date of that GitHub
 *   account, its end, and its actions. The main process drops a request at
 *   its end by the system clock (#257). "Deny and invite instead" is among
 *   the actions only while the workspace has an active unclaimed person
 *   (ADR 0014 and #95: when unclaimed people exist, a request can be denied
 *   with an invitation for one of them instead).
 * - The blocks in force with "Unblock", "Deny all" while a request is
 *   pending, and the pause with its time, once the list loaded.
 * - A fixed status text: before the first state, while the main process
 *   does not list them for this workspace yet, while they load, without a
 *   pending request, and the problem of a failed load, with what was loaded
 *   before.
 */
export function describeJoinRequests(
  people: PeopleScreenView,
  joinRequests: JoinRequestsScreenView,
): JoinRequestsModel | null {
  const managed = managedWorkspace(people);
  if (
    managed === null ||
    (joinRequests.kind === "known" &&
      joinRequests.state.status === "not_allowed")
  ) {
    return null;
  }
  const { workspaceId } = managed;
  const unclaimed = managed.people
    .filter((person) => !person.former && !person.claimed)
    .map((person) => ({ memberId: person.memberId, name: person.displayName }));
  const base = {
    pending: [] as PendingRequestRow[],
    blocked: [] as BlockedRequestRow[],
    denyAll: null,
    pause: null,
    unclaimed,
  };
  switch (joinRequests.kind) {
    case "unavailable":
      return { ...base, status: JOIN_REQUEST_MESSAGES.unavailable };
    case "pending":
      return { ...base, status: JOIN_REQUEST_MESSAGES.pending };
    case "known":
      break;
  }
  const { state } = joinRequests;
  if (state.workspaceId !== workspaceId) {
    // Another workspace's state, before the main process followed the
    // switch: its requests never show here.
    return { ...base, status: JOIN_REQUEST_MESSAGES.loading };
  }
  switch (state.status) {
    case "signed_out":
    case "no_workspace":
      return { ...base, status: JOIN_REQUEST_MESSAGES.pending };
    case "loading":
      return { ...base, status: JOIN_REQUEST_MESSAGES.loading };
    case "not_allowed":
    case "ready":
    case "unavailable":
      break;
  }
  const pending = state.pending.map((request): PendingRequestRow => {
    const target = {
      workspaceId,
      joinRequestId: request.joinRequestId,
      name: request.requestedName,
      login: request.login,
      accountCreatedAt: request.accountCreatedAt,
    };
    const actions: JoinRequestActionRequest[] = [
      { kind: "approve", ...target },
    ];
    if (unclaimed.length > 0) {
      actions.push({ kind: "invite", ...target });
    }
    actions.push({ kind: "deny", ...target }, { kind: "block", ...target });
    return {
      joinRequestId: request.joinRequestId,
      requestedName: request.requestedName,
      login: request.login,
      verifiedAt: request.verifiedAt,
      accountCreatedAt: request.accountCreatedAt,
      expiresAt: request.expiresAt,
      actions,
    };
  });
  const blocked = state.blocked.map((request): BlockedRequestRow => ({
    joinRequestId: request.joinRequestId,
    requestedName: request.requestedName,
    login: request.login,
    verifiedAt: request.verifiedAt,
    accountCreatedAt: request.accountCreatedAt,
    blockedAt: request.blockedAt,
    unblock: {
      kind: "unblock",
      workspaceId,
      joinRequestId: request.joinRequestId,
      name: request.requestedName,
      login: request.login,
    },
  }));
  return {
    pending,
    blocked,
    denyAll: pending.length === 0 ? null : { kind: "denyAll", workspaceId },
    pause: {
      pausedAt: state.pausedAt,
      request: {
        kind: state.pausedAt === null ? "pause" : "resume",
        workspaceId,
      },
    },
    unclaimed,
    status:
      state.status === "unavailable"
        ? JOIN_REQUEST_PROBLEM_MESSAGES[state.problem]
        : pending.length === 0
          ? JOIN_REQUEST_MESSAGES.empty
          : "",
  };
}

/**
 * Whether the screen still offers `request` as it is: the same action on
 * the same request with the same name and login in the same workspace, or
 * the same workspace-wide action. A question whose action went away or
 * changed, for example after a decision on another device, a switch, or
 * the end of the request, closes.
 */
export function isJoinRequestOffered(
  model: JoinRequestsModel | null,
  request: JoinRequestActionRequest,
): boolean {
  if (model === null) {
    return false;
  }
  const fields = Object.entries(request);
  const same = (other: JoinRequestActionRequest | null | undefined) =>
    other !== null &&
    other !== undefined &&
    fields.every(
      ([key, value]) => (other as Record<string, unknown>)[key] === value,
    );
  switch (request.kind) {
    case "denyAll":
      return same(model.denyAll);
    case "pause":
    case "resume":
      return same(model.pause?.request);
    case "unblock":
      return model.blocked.some((row) => same(row.unblock));
    default:
      return model.pending.some((row) => row.actions.some(same));
  }
}

/** The sentence after an action that the API confirmed. */
export const JOIN_REQUEST_ACTION_DONE_MESSAGES: Readonly<
  Record<JoinRequestActionKind, string>
> = Object.freeze({
  approve: "The request was approved. The account is now a member.",
  invite: "The invitation was created, and the request was denied.",
  deny: "The request was denied.",
  denyAll: "The pending requests were denied.",
  block: "The request was denied, and the account is blocked.",
  unblock: "The account is no longer blocked.",
  pause: "New join requests are paused.",
  resume: "New join requests are accepted again.",
});

/** The start of the sentence after an action that did not happen. */
export const JOIN_REQUEST_ACTION_NOT_DONE_MESSAGES: Readonly<
  Record<Exclude<JoinRequestActionKind, "invite">, string>
> = Object.freeze({
  approve: "The request could not be approved.",
  deny: "The request could not be denied.",
  denyAll: "The pending requests could not be denied.",
  block: "The account could not be blocked.",
  unblock: "The account could not be unblocked.",
  pause: "New join requests could not be paused.",
  resume: "New join requests could not be accepted again.",
});

/**
 * The sentence after an answer that does not show whether the API acted
 * (`unknown`). Nothing is sent again on its own.
 */
export const JOIN_REQUEST_ACTION_UNKNOWN_MESSAGES: Readonly<
  Record<Exclude<JoinRequestActionKind, "invite">, string>
> = Object.freeze({
  approve:
    "It is not known whether the request was approved. Check the people and the join requests; the request is not sent again on its own.",
  deny: "It is not known whether the request was denied. Check the join requests; the request is not sent again on its own.",
  denyAll:
    "It is not known whether the pending requests were denied. Check the join requests; the request is not sent again on its own.",
  block:
    "It is not known whether the account was blocked. Check the join requests; the request is not sent again on its own.",
  unblock:
    "It is not known whether the account was unblocked. Check the blocked accounts; the request is not sent again on its own.",
  pause:
    "It is not known whether new join requests were paused. Check the line about new requests; the request is not sent again on its own.",
  resume:
    "It is not known whether new join requests are accepted again. Check the line about new requests; the request is not sent again on its own.",
});

/**
 * Why an action was refused, after its start. `invalid` for an approval
 * says that the name is not allowed; `too_soon` and `rate_limited` say how
 * long to wait (`describeWait`).
 */
export const JOIN_REQUEST_ACTION_REFUSAL_MESSAGES: Readonly<
  Record<
    Exclude<
      JoinRequestActionRefusal,
      "too_soon" | "rate_limited" | "conflict" | "invalid"
    >,
    string
  >
> & {
  readonly invalid: string;
  readonly invalidName: string;
  readonly tooSoon: (wait: string) => string;
  readonly rateLimited: (wait: string) => string;
  readonly conflict: Readonly<
    Record<Exclude<JoinRequestActionKind, "invite">, string>
  >;
} = Object.freeze({
  invalid: PEOPLE_ACTION_REFUSAL_MESSAGES.invalid,
  invalidName: PEOPLE_ACTION_REFUSAL_MESSAGES.invalidName,
  not_selected: PEOPLE_ACTION_REFUSAL_MESSAGES.not_selected,
  not_signed_in: PEOPLE_ACTION_REFUSAL_MESSAGES.not_signed_in,
  unavailable: PEOPLE_ACTION_REFUSAL_MESSAGES.unavailable,
  tooSoon: PEOPLE_ACTION_REFUSAL_MESSAGES.tooSoon,
  rateLimited: PEOPLE_ACTION_REFUSAL_MESSAGES.rateLimited,
  not_allowed: PEOPLE_ACTION_REFUSAL_MESSAGES.not_allowed,
  not_found:
    "The server does not know this workspace or this request for your account. Check the join requests.",
  conflict: Object.freeze({
    approve:
      "The request is no longer pending: it was decided, withdrawn, or it ended. Check the join requests.",
    deny: "The request is no longer pending: it was decided, withdrawn, or it ended. Check the join requests.",
    denyAll: "The join requests changed in the meantime. Check the list.",
    block:
      "The request is no longer pending: it was decided, withdrawn, or it ended. Check the join requests.",
    unblock:
      "The account is no longer blocked: the block was lifted in the meantime. Check the blocked accounts.",
    pause:
      "The workspace changed in the meantime. Check the line about new requests.",
    resume:
      "The workspace changed in the meantime. Check the line about new requests.",
  }),
  already_member:
    "The account is already a member of this workspace, for example after it joined with an invitation. Check the people.",
  failed: "The server refused it.",
});

/** The sentence after the result of an action other than "Deny and invite instead". */
export function describeJoinRequestActionResult(
  kind: Exclude<JoinRequestActionKind, "invite">,
  result: JoinRequestActionResult | ApproveJoinRequestResult,
): string {
  switch (result.outcome) {
    case "ok":
      return JOIN_REQUEST_ACTION_DONE_MESSAGES[kind];
    case "unknown":
      return JOIN_REQUEST_ACTION_UNKNOWN_MESSAGES[kind];
    case "refused":
      break;
  }
  const messages = JOIN_REQUEST_ACTION_REFUSAL_MESSAGES;
  const wait = describeWait(result.retryAfterMs ?? 0);
  let reason: string;
  switch (result.reason) {
    case "invalid":
      reason = kind === "approve" ? messages.invalidName : messages.invalid;
      break;
    case "too_soon":
      reason = messages.tooSoon(wait);
      break;
    case "rate_limited":
      reason = messages.rateLimited(wait);
      break;
    case "conflict":
      reason = messages.conflict[kind];
      break;
    default:
      reason = messages[result.reason];
  }
  return `${JOIN_REQUEST_ACTION_NOT_DONE_MESSAGES[kind]} ${reason}`;
}

/**
 * The starts of the sentences of "Deny and invite instead", which say how
 * far it came: before the denial, the request stays pending.
 */
export const INVITE_INSTEAD_MESSAGES = Object.freeze({
  /** Before the sentence of a create that did not happen. */
  notDenied: "The request was not denied.",
  /** Before the sentence of a denial that did not happen. */
  invited: "The invitation was created.",
  /**
   * A create confirmed while another workspace was selected: its code was
   * dropped unseen (D2), and the denial was not sent. It never holds the
   * code.
   */
  unseen:
    'An invitation was created for the chosen person, but its code could not be shown, and the request was not denied. Use "Deny and invite instead" again for a new code.',
});

/**
 * The active unclaimed person that "Deny and invite instead" chooses at
 * first: the first one, in the people's order, whose display name is the
 * requested name, or none, so that the approver chooses (the Project
 * Manager's decision of 2026-11-13). A person chosen by mistake would get a
 * new invitation, which revokes that person's earlier one.
 */
export function defaultInvitee(
  unclaimed: readonly InviteOption[],
  requestedName: string,
): string | undefined {
  return unclaimed.find((person) => person.name === requestedName)?.memberId;
}

/** The open question of an action that asks first. */
export interface JoinRequestDialog {
  readonly request: JoinRequestActionRequest;
  /** The name in the field of an approval; empty for the other actions. */
  readonly draft: string;
  /**
   * The member ID of the active unclaimed person whom "Deny and invite
   * instead" invites, or undefined while none is chosen and for the other
   * actions.
   */
  readonly invitee: string | undefined;
  /**
   * Why the confirmation sent nothing: the approval's name, or no person
   * chosen for "Deny and invite instead"; undefined otherwise.
   */
  readonly problem: string | undefined;
}

/** What the screen shows of its join request actions. */
export interface JoinRequestActionsView {
  /**
   * True while an action runs, also every step of "Deny and invite
   * instead": every action's control stays focusable and does nothing
   * (`aria-disabled`), so that only one runs at a time.
   */
  readonly running: boolean;
  /** A fixed sentence about the last action, or undefined. It never holds a code. */
  readonly message: string | undefined;
  /** The open question, or undefined. */
  readonly dialog: JoinRequestDialog | undefined;
  /**
   * The code of the invitation that "Deny and invite instead" created,
   * while its dialog is open (D2), or undefined; without the code itself
   * once the account was demoted (#266).
   */
  readonly code: InvitationCodeView | undefined;
}

export const IDLE_JOIN_REQUEST_ACTIONS: JoinRequestActionsView = Object.freeze({
  running: false,
  message: undefined,
  dialog: undefined,
  code: undefined,
});

/**
 * Whether a dialog of the join request actions is open: a question, or the
 * code of "Deny and invite instead". The focus returns to the screen's title
 * when the last of them closes after its button left the page.
 */
export function joinRequestDialogsOpen(view: JoinRequestActionsView): boolean {
  return view.dialog !== undefined || view.code !== undefined;
}

/** Why the main process refused to load the join requests on a refresh. */
export type JoinRequestLoadRefusal = Extract<
  JoinRequestLoadResult,
  { readonly outcome: "refused" }
>["reason"];

/** The sentences after "Refresh the join requests". */
export const JOIN_REQUEST_REFRESH_MESSAGES: Readonly<
  Record<JoinRequestLoadRefusal, string>
> & { readonly loading: string; readonly failed: string } = Object.freeze({
  /** Until the next state of the join requests arrives. */
  loading: "Loading the join requests again.",
  not_signed_in: "The join requests appear once this device is signed in.",
  no_workspace: "No workspace is selected.",
  not_allowed: "Only the owner and the admins see the join requests.",
  too_soon:
    "The join requests were loaded a moment ago. Try again in a few seconds.",
  failed: "The join requests could not be loaded again. Try again.",
});

/**
 * The actions after which the action's control leaves the page with the
 * next list, once the API confirmed them: the request's row, the block's
 * row, or "Deny all" goes away. A pause and a resume are not among them:
 * the pause's button stays and only changes its label, so the focus stays
 * on it (the Project Manager's decision of 2026-11-13).
 */
const LEAVING_JOIN_REQUEST_ACTIONS: ReadonlySet<JoinRequestActionKind> =
  new Set(["approve", "invite", "deny", "denyAll", "block", "unblock"]);

/** The bridges' functions that the join request actions call. */
export interface JoinRequestActionsBridges {
  readonly joinRequestActions: JoinRequestActionsBridge;
  readonly joinRequests: Pick<JoinRequestsBridge, "load">;
  /** For "Deny and invite instead": the create of the invitation. */
  readonly invitationActions: Pick<InvitationActionsBridge, "create">;
}

export interface JoinRequestActions {
  /**
   * Starts an action that the screen offers: an action that asks first
   * opens its question, and a pause and a resume run at once. While an
   * action runs or a code shows, nothing starts. Resolves to true when the
   * action ran and its control leaves the page with the next list.
   */
  readonly start: (request: JoinRequestActionRequest) => Promise<boolean>;
  /**
   * Runs the action of the open question, once; an approval first checks
   * its name, and "Deny and invite instead" that a person is chosen, and
   * each keeps the question open with the problem. Resolves like `start`.
   */
  readonly confirm: () => Promise<boolean>;
  /** Closes the open question without the action. */
  readonly cancel: () => void;
  /** Changes the name in the field of an open approval, and ends its problem. */
  readonly editDraft: (text: string) => void;
  /**
   * Chooses the active unclaimed person, by member ID, whom an open "Deny
   * and invite instead" invites, and ends its problem.
   */
  readonly choose: (memberId: string) => void;
  /** Closes the code's dialog and drops the code. */
  readonly closeCode: () => void;
  /** Asks the main process to load the join requests again; nothing while an action runs. */
  readonly refresh: () => Promise<void>;
  /**
   * Follows the screen's views:
   *
   * - the open question ends once the screen no longer offers it as it is
   *   (`isJoinRequestOffered`), also once the workspace has no active
   *   unclaimed person left for "Deny and invite instead", or once the
   *   person chosen for it is no longer one, so that it never comes back on
   *   its own and a later `confirm` sends nothing;
   * - the question, the code, and the sentence of the last action belong to
   *   the workspace that they were about, so they go when another workspace
   *   or none is selected, and always with a sign-out;
   * - the workspace of an invitation whose code was dropped after a switch
   *   says so when it is selected again (`INVITE_INSTEAD_MESSAGES.unseen`);
   * - the code of the open dialog goes, and the dialog stays open without
   *   it, once the account is demoted to a member of the workspace
   *   (`isDemoted`), because the server revoked the invitation (#266);
   * - the refresh's sentence ends with the next state of the join requests.
   */
  readonly listChanged: (
    people: PeopleScreenView,
    joinRequests: JoinRequestsScreenView,
  ) => void;
}

/**
 * The join request actions of the screen: one at a time, each sent once
 * and never again on its own (D1). The result is a fixed sentence; the
 * lists change only with the state that the main process sends, never from
 * the answer.
 *
 * "Deny and invite instead" sends its two steps in order, each once, and
 * each only while the workspace of the action is still selected: the create
 * of the invitation for the chosen active unclaimed person, whose code goes
 * into the view of its dialog only (D2), and only then the denial. A step
 * that is refused, uncertain, or fails on its way ends it, and the sentence
 * says how far it came; when the create ends it, the request stays pending.
 * A code whose invitation the server revoked with the account's demotion is
 * dropped at once: the dialog opens, or stays open, without it (#266).
 */
export function createJoinRequestActions(
  bridges: JoinRequestActionsBridges,
  onView: (view: JoinRequestActionsView) => void,
): JoinRequestActions {
  const { joinRequestActions: bridge } = bridges;
  let running = false;
  let message: string | undefined;
  let dialog: JoinRequestDialog | undefined;
  let code: InvitationCodeView | undefined;
  /** The latest model, for the people whom "Deny and invite instead" may invite. */
  let model: JoinRequestsModel | null = null;
  /** The latest join requests' revision, for the refresh's sentence. */
  let latestRevision: number | undefined;
  /** The selected workspace of the latest people; undefined before any. */
  let selected: string | null | undefined;
  /**
   * Whether the latest views show the account demoted to a member of the
   * selected workspace (`isDemoted`).
   */
  let demoted = false;
  /**
   * Grows with every demotion that the views show, so that the code of a
   * create counts only when none arrived while the create was on its way,
   * also none that a promotion followed: the demotion revoked the
   * invitation, and a promotion does not bring it back.
   */
  let demotions = 0;
  /**
   * Grows with every switch of the selected workspace, a drop of it, and a
   * sign-out, so that an answer counts only when nothing of the kind
   * happened while it was on its way, also a switch away and back.
   */
  let selection = 0;
  /** Grows with every sign-out, so that nothing outlives the account's session. */
  let session = 0;
  /** Whether the latest people are `signed_out`, so that a session ends once. */
  let signedOut = false;
  /**
   * The revision of the join requests when a refresh answered `loading`,
   * while its sentence shows; a later state ends the sentence.
   */
  let refreshedAt: number | undefined;
  /**
   * The workspace whose invitation of "Deny and invite instead" was created
   * while another one was selected, until it is shown again. Only its ID is
   * kept, never the code. The next action, a refresh, and a sign-out end it.
   */
  let unseenIn: string | undefined;
  const show = () => onView(Object.freeze({ running, message, dialog, code }));

  /** Whether the action's workspace has stayed selected since `startSelection`. */
  const stillOn = (workspaceId: string, startSelection: number) =>
    selection === startSelection && selected === workspaceId;

  function begin(): void {
    running = true;
    message = undefined;
    dialog = undefined;
    refreshedAt = undefined;
    unseenIn = undefined;
    show();
  }

  function end(sentence: string | undefined): void {
    if (sentence !== undefined) {
      message = sentence;
    }
    running = false;
    show();
  }

  async function run(
    request: Exclude<JoinRequestActionRequest, { readonly kind: "invite" }>,
    displayName: string | null,
  ): Promise<boolean> {
    begin();
    const startSelection = selection;
    let ok = false;
    let sentence: string;
    try {
      const result = await send(request, displayName);
      ok = result.outcome === "ok";
      sentence = describeJoinRequestActionResult(request.kind, result);
    } catch {
      sentence = `${JOIN_REQUEST_ACTION_NOT_DONE_MESSAGES[request.kind]} ${PEOPLE_ACTION_NOT_SENT}`;
    }
    // An answer counts only while the action's workspace stayed selected.
    const still = stillOn(request.workspaceId, startSelection);
    end(still ? sentence : undefined);
    return still && ok && LEAVING_JOIN_REQUEST_ACTIONS.has(request.kind);
  }

  function send(
    request: Exclude<JoinRequestActionRequest, { readonly kind: "invite" }>,
    displayName: string | null,
  ): Promise<JoinRequestActionResult | ApproveJoinRequestResult> {
    switch (request.kind) {
      case "approve":
        return bridge.approve(
          request.workspaceId,
          request.joinRequestId,
          displayName,
        );
      case "deny":
        return bridge.deny(request.workspaceId, request.joinRequestId);
      case "block":
        return bridge.block(request.workspaceId, request.joinRequestId);
      case "unblock":
        return bridge.unblock(request.workspaceId, request.joinRequestId);
      case "denyAll":
        return bridge.denyAll(request.workspaceId);
      case "pause":
        return bridge.pause(request.workspaceId);
      case "resume":
        return bridge.resume(request.workspaceId);
    }
  }

  /**
   * "Deny and invite instead": the create for the chosen person, and only
   * then the denial, each once, and each only while the action's workspace
   * stays selected. A step's answer after a switch or a sign-out shows no
   * sentence and ends it; a created invitation's code is then dropped
   * unseen, and its workspace says so once it is shown again.
   */
  async function inviteInstead(
    request: Extract<JoinRequestActionRequest, { readonly kind: "invite" }>,
    invitee: InviteOption,
  ): Promise<boolean> {
    begin();
    const { workspaceId } = request;
    const startSelection = selection;
    const startSession = session;
    const startDemotions = demotions;
    const { memberId, name } = invitee;
    const invite = { kind: "invite", workspaceId, memberId, name } as const;
    let created: CreateInvitationResult | undefined;
    try {
      created = await bridges.invitationActions.create(workspaceId, memberId);
    } catch {
      created = undefined;
    }
    if (!stillOn(workspaceId, startSelection)) {
      // A created invitation whose code was dropped unseen: its workspace
      // says so at once when it is shown again already (a switch away and
      // back), or when it is selected next. A sign-out ends it.
      if (created?.outcome === "ok" && session === startSession) {
        if (selected === workspaceId) {
          message = INVITE_INSTEAD_MESSAGES.unseen;
        } else {
          unseenIn = workspaceId;
        }
      }
      end(undefined);
      return false;
    }
    if (created?.outcome !== "ok") {
      const reason =
        created === undefined
          ? `${INVITATION_ACTION_NOT_DONE_MESSAGES.invite} ${PEOPLE_ACTION_NOT_SENT}`
          : describeInvitationActionResult(invite, created, undefined, 0);
      end(`${INVITE_INSTEAD_MESSAGES.notDenied} ${reason}`);
      return false;
    }
    // The code shows at once, before the denial goes. A demotion that
    // arrived first revoked the new invitation: its dialog opens without
    // the code.
    code = Object.freeze({
      name,
      code: demoted || demotions !== startDemotions ? null : created.code,
      expiresAt: created.expiresAt,
    });
    show();
    let denied: JoinRequestActionResult | undefined;
    try {
      denied = await bridge.deny(workspaceId, request.joinRequestId);
    } catch {
      denied = undefined;
    }
    if (!stillOn(workspaceId, startSelection)) {
      end(undefined);
      return false;
    }
    if (denied?.outcome === "ok") {
      end(JOIN_REQUEST_ACTION_DONE_MESSAGES.invite);
      return true;
    }
    const reason =
      denied === undefined
        ? `${JOIN_REQUEST_ACTION_NOT_DONE_MESSAGES.deny} ${PEOPLE_ACTION_NOT_SENT}`
        : describeJoinRequestActionResult("deny", denied);
    end(`${INVITE_INSTEAD_MESSAGES.invited} ${reason}`);
    return false;
  }

  /** The active unclaimed person with `memberId`, while the screen still offers it. */
  function unclaimedPerson(memberId: string): InviteOption | undefined {
    return model?.unclaimed.find((person) => person.memberId === memberId);
  }

  return Object.freeze({
    start: (request: JoinRequestActionRequest) => {
      if (running || code !== undefined) {
        return Promise.resolve(false);
      }
      if (ASKING_JOIN_REQUEST_ACTIONS.has(request.kind)) {
        dialog = Object.freeze({
          request,
          draft: request.kind === "approve" ? request.name : "",
          invitee:
            request.kind === "invite"
              ? defaultInvitee(model?.unclaimed ?? [], request.name)
              : undefined,
          problem: undefined,
        });
        show();
        return Promise.resolve(false);
      }
      if (request.kind === "invite") {
        return Promise.resolve(false);
      }
      return run(request, null);
    },
    confirm: () => {
      const open = dialog;
      if (running || open === undefined) {
        return Promise.resolve(false);
      }
      const { request } = open;
      if (request.kind === "invite") {
        if (open.invitee === undefined) {
          dialog = Object.freeze({
            ...open,
            problem: JOIN_REQUEST_QUESTION_MESSAGES.noInvitee,
          });
          show();
          return Promise.resolve(false);
        }
        const invitee = unclaimedPerson(open.invitee);
        if (invitee === undefined) {
          return Promise.resolve(false);
        }
        return inviteInstead(request, invitee);
      }
      if (request.kind === "approve") {
        const name = open.draft.trim();
        const problem = namePrompt(name);
        if (problem !== undefined) {
          dialog = Object.freeze({ ...open, problem });
          show();
          return Promise.resolve(false);
        }
        // The requested name is the default: unchanged, none is sent.
        return run(request, name === request.name ? null : name);
      }
      return run(request, null);
    },
    cancel: () => {
      if (dialog !== undefined) {
        dialog = undefined;
        show();
      }
    },
    editDraft: (text: string) => {
      if (dialog !== undefined) {
        // The problem was about the name as it was.
        dialog = Object.freeze({ ...dialog, draft: text, problem: undefined });
        show();
      }
    },
    choose: (memberId: string) => {
      if (
        dialog?.request.kind === "invite" &&
        unclaimedPerson(memberId) !== undefined
      ) {
        // The problem was about no person being chosen.
        dialog = Object.freeze({
          ...dialog,
          invitee: memberId,
          problem: undefined,
        });
        show();
      }
    },
    closeCode: () => {
      if (code !== undefined) {
        code = undefined;
        show();
      }
    },
    refresh: async () => {
      if (running) {
        return;
      }
      unseenIn = undefined;
      const startSelection = selection;
      let sentence: string;
      let loading = false;
      try {
        const result = await bridges.joinRequests.load();
        loading = result.outcome === "loading";
        sentence =
          result.outcome === "loading"
            ? JOIN_REQUEST_REFRESH_MESSAGES.loading
            : JOIN_REQUEST_REFRESH_MESSAGES[result.reason];
      } catch {
        sentence = JOIN_REQUEST_REFRESH_MESSAGES.failed;
      }
      // An action that started meanwhile has its own sentence.
      if (selection === startSelection && !running) {
        message = sentence;
        refreshedAt = loading ? (latestRevision ?? -1) : undefined;
        show();
      }
    },
    listChanged: (
      people: PeopleScreenView,
      joinRequests: JoinRequestsScreenView,
    ) => {
      let changed = false;
      model = describeJoinRequests(people, joinRequests);
      if (joinRequests.kind === "known") {
        latestRevision = joinRequests.state.revision;
        if (
          refreshedAt !== undefined &&
          joinRequests.state.revision > refreshedAt
        ) {
          refreshedAt = undefined;
          if (message === JOIN_REQUEST_REFRESH_MESSAGES.loading) {
            message = undefined;
            changed = true;
          }
        }
      }
      if (
        dialog !== undefined &&
        (!isJoinRequestOffered(model, dialog.request) ||
          (dialog.invitee !== undefined &&
            unclaimedPerson(dialog.invitee) === undefined))
      ) {
        dialog = undefined;
        changed = true;
      }
      if (people.kind === "known") {
        const { state } = people;
        const before = selected;
        if (state.status === "signed_out") {
          // A sign-out ends everything, also the code of an open dialog.
          if (!signedOut) {
            signedOut = true;
            selection += 1;
            session += 1;
          }
          selected = null;
          changed ||=
            dialog !== undefined || message !== undefined || code !== undefined;
          dialog = undefined;
          message = undefined;
          code = undefined;
          refreshedAt = undefined;
          unseenIn = undefined;
        } else {
          signedOut = false;
          selected = state.workspaceId;
          if (before !== undefined && before !== selected) {
            selection += 1;
            dialog = undefined;
            message = undefined;
            code = undefined;
            refreshedAt = undefined;
            if (unseenIn !== undefined && unseenIn === selected) {
              message = INVITE_INSTEAD_MESSAGES.unseen;
              unseenIn = undefined;
            }
            changed = true;
          }
        }
      }
      const wasDemoted = demoted;
      demoted =
        typeof selected === "string" &&
        isDemoted(
          people,
          joinRequests.kind === "known" ? joinRequests.state : undefined,
          selected,
        );
      if (demoted && !wasDemoted) {
        demotions += 1;
      }
      if (demoted && code !== undefined && code.code !== null) {
        // The server revoked the invitation with the demotion: the code
        // goes at once, and the open dialog says that it no longer works.
        code = withoutCode(code);
        changed = true;
      }
      if (changed) {
        show();
      }
    },
  });
}
