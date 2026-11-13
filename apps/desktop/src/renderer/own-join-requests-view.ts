import type {
  OwnJoinRequestActionsBridge,
  OwnJoinRequestsBridge,
} from "../shared/desktop-bridge.ts";
import type {
  CreateJoinRequestResult,
  OwnJoinRequestActionRefusal,
  OwnJoinRequestLoadResult,
  OwnJoinRequestOutcomeView,
  OwnJoinRequestsView,
  WithdrawJoinRequestResult,
  WorkspaceProblem,
} from "../shared/ipc-contract.ts";
import type { AccountView } from "./account-view.ts";
import { pastedCode } from "./join-invitation-view.ts";
import {
  describeWait,
  namePrompt,
  PEOPLE_ACTION_NOT_SENT,
  PEOPLE_ACTION_REFUSAL_MESSAGES,
} from "./people-actions-view.ts";
import type { WorkspacePanelView } from "./workspace-view.ts";

// The requester's side of the join requests on the join screen (#95; ADR
// 0014, "Join requests" and "What a workspace ID allows"; decisions D1 and
// D3 of 2026-11-06): asking to join a workspace by its ID as a new person
// with a requested display name, the account's own join requests, and the
// withdrawal of a pending one. The main process holds the requests (#260);
// the screen shows them and passes the person's actions on. It reads no
// clock: the main process marks a pending request past its expiry as
// `expired`.

/** What the screen knows of the account's own join requests. */
export type OwnJoinRequestsScreenView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first state. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly state: OwnJoinRequestsView };

export function initialOwnJoinRequestsScreenView(
  bridgeAvailable: boolean,
): OwnJoinRequestsScreenView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

/**
 * Subscribes to the account's own join requests and reports every state as
 * the view; a refused subscription makes the view unavailable. As the
 * screen opens, it asks the main process to load them once (D3). The main
 * process counts the request also while no device is signed in, and loads
 * them once one is, so its answer shows only in the state. Returns the
 * function that ends the subscription.
 */
export function followOwnJoinRequests(
  ownJoinRequests: Pick<OwnJoinRequestsBridge, "subscribeState" | "load">,
  onView: (view: OwnJoinRequestsScreenView) => void,
): () => void {
  const stop = ownJoinRequests.subscribeState(
    (state) => onView({ kind: "known", state }),
    () => onView({ kind: "unavailable" }),
  );
  ownJoinRequests.load().catch(() => undefined);
  return stop;
}

/**
 * A workspace ID: a UUIDv7 in canonical lowercase form, like the contract's
 * `ProtocolIdSchema` and the protocol's `UUIDV7_PATTERN`. The renderer
 * imports no value of either, so the tests check that they match.
 */
export const WORKSPACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** The length of a workspace ID in characters. */
const WORKSPACE_ID_LENGTH = 36;

/** The fixed texts of the request to join by a workspace ID. */
export const JOIN_REQUEST_FORM_MESSAGES = Object.freeze({
  title: "Ask to join with a workspace ID",
  hint: "Ask to join a workspace by its ID, as a new person with the name below. Its owner and admins see that name with your GitHub login and the creation date of your GitHub account, and decide. Until they approve, you see nothing of the workspace; then it appears in your list of workspaces.",
  /**
   * ADR 0014, "Join requests": a joiner who is one of the predefined
   * people claims that person with an invitation, and the join screen says
   * so, next to both ways of joining.
   */
  claimHint:
    "If the workspace already added you as a person, do not ask here: ask its owner or an admin for an invitation code for that person, and join with the code above. A request by ID adds you as a new person.",
  /** Without the two bridges, outside Electron. */
  unavailable: "Asking to join with a workspace ID is not available.",
  /** While the workspace state is `signed_out`. */
  signedOut:
    "You can ask to join a workspace once this device is signed in and ready.",
  workspaceLabel: "Workspace ID",
  nameLabel: "Your name in the workspace",
  submit: "Ask to join",
  /** Before a request with nothing in the ID field. */
  workspaceMissing: "Paste the ID of the workspace.",
  /** Before a request with a text that is not a workspace ID once trimmed. */
  notAnId:
    "This is not a workspace ID. Check that you pasted all of the ID that a member of the workspace gave you.",
});

/**
 * The workspace ID that the screen sends for the text of the field, or
 * undefined when the text is not one: the text without the characters that
 * a paste may carry at its ends, as for an invitation code (`pastedCode`),
 * with the capital letters A to F written small, because a UUID's digits do
 * not depend on case and the contract takes the lowercase form only. Only
 * the ends and those six letters change, so a text that is not an ID never
 * becomes one: the pattern is anchored and accepts ASCII only.
 */
export function workspaceIdToSend(text: string): string | undefined {
  const trimmed = pastedCode(text);
  if (trimmed.length !== WORKSPACE_ID_LENGTH) {
    return undefined;
  }
  const id = trimmed.replace(/[A-F]/gu, (letter) => letter.toLowerCase());
  return WORKSPACE_ID_PATTERN.test(id) ? id : undefined;
}

/**
 * The problem of the ID field's text before a request, or undefined:
 * nothing once trimmed, or not a workspace ID. The contract refuses both,
 * and the call rejects for them.
 */
export function workspaceIdProblem(text: string): string | undefined {
  if (pastedCode(text) === "") {
    return JOIN_REQUEST_FORM_MESSAGES.workspaceMissing;
  }
  return workspaceIdToSend(text) === undefined
    ? JOIN_REQUEST_FORM_MESSAGES.notAnId
    : undefined;
}

/**
 * The account's display name (`users.display_name`) while the account
 * status names a signed-in account, as the account panel shows it; the
 * request's name field starts with it (ADR 0014, "People and roles").
 */
export function accountDisplayName(account: AccountView): string | undefined {
  return account.kind === "known" && account.status.account.kind === "signed_in"
    ? account.status.account.displayName
    : undefined;
}

/**
 * The account and the device that the account status names, or null while
 * it names none; undefined before the first status. A change from one
 * account and device to anything else ends the session of the requests.
 */
function accountIdentity(account: AccountView): string | null | undefined {
  if (account.kind !== "known") {
    return undefined;
  }
  const { account: named } = account.status;
  return named.kind === "signed_in" ? `${named.login} ${named.deviceId}` : null;
}

/** The fixed texts of the account's own join requests. */
export const OWN_JOIN_REQUEST_MESSAGES = Object.freeze({
  heading: "Your join requests",
  pendingHeading: "Pending",
  endedHeading: "Earlier requests",
  unavailable: "Your join requests are not available.",
  pending: "Checking your join requests.",
  signedOut:
    "Your join requests appear once this device is signed in and ready.",
  loading: "Loading your join requests.",
  empty: "You have not asked to join a workspace.",
  /** Before the ID of the workspace that a request asks to join. */
  workspaceId: "Workspace ID ",
  /** Before the name of that workspace, once the workspace list holds it. */
  workspaceName: "Workspace ",
  /** Before the time a request was sent. */
  sent: "Sent ",
  /** Before the end of a pending request. */
  expires: "Expires ",
  withdraw: "Withdraw",
  refresh: "Refresh your join requests",
});

/**
 * How a request ended, before its time: the outcomes of the main process,
 * a block shown as a denial (#92), and a request past its expiry as
 * expired (the Project Manager's decision of 2026-11-12).
 */
export const OWN_JOIN_REQUEST_OUTCOME_LABELS: Readonly<
  Record<OwnJoinRequestOutcomeView, string>
> = Object.freeze({
  approved: "Approved ",
  denied: "Denied ",
  withdrawn: "Withdrawn ",
  expired: "Expired ",
});

/**
 * Why the own join requests are `unavailable`: the failure of the last
 * load. What was loaded before stays shown, and the main process loads
 * again by itself.
 */
export const OWN_JOIN_REQUEST_PROBLEM_MESSAGES: Readonly<
  Record<WorkspaceProblem, string>
> = Object.freeze({
  not_signed_in: "The server did not accept this device's sign-in.",
  not_found: "Your join requests could not be loaded. Trying again later.",
  rate_limited: "The server asked to wait. Trying again in a minute.",
  unavailable: "The server could not be reached. Trying again later.",
  failed: "Your join requests could not be loaded. Trying again later.",
});

/**
 * A pending request that the screen offers to withdraw: its ID, which goes
 * only to the bridge, and what the question shows.
 */
export interface WithdrawRequest {
  readonly joinRequestId: string;
  readonly workspaceId: string;
  readonly requestedName: string;
}

/** A request as the screen shows it. */
export interface OwnJoinRequestRow {
  /** The key of the row only; the screen never shows it. */
  readonly joinRequestId: string;
  /**
   * The ID of the workspace that the request asks to join. The API shows
   * the requester nothing else about the workspace before an approval
   * (ADR 0014), so the screen shows the ID.
   */
  readonly workspaceId: string;
  /** The workspace's name once the account's workspace list holds it, or undefined. */
  readonly workspaceName: string | undefined;
  readonly requestedName: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** How it ended, or null while it is pending. */
  readonly outcome: OwnJoinRequestOutcomeView | null;
  /** When it ended, or null while it is pending. */
  readonly decidedAt: string | null;
  /** Withdraw, for a pending request only. */
  readonly withdraw: WithdrawRequest | null;
}

/** What the screen shows of the account's own join requests. */
export interface OwnJoinRequestsModel {
  /** The text of the part's status paragraph; empty when there is none. */
  readonly status: string;
  /** The pending requests, in the main process's order. */
  readonly pending: readonly OwnJoinRequestRow[];
  /** The requests that ended, in the main process's order. */
  readonly ended: readonly OwnJoinRequestRow[];
}

/** The workspaces that the account's workspace list holds, by ID. */
function listedWorkspaces(
  workspaces: WorkspacePanelView,
): ReadonlyMap<string, string> {
  if (workspaces.kind !== "known" || workspaces.state.status === "signed_out") {
    return new Map();
  }
  return new Map(
    workspaces.state.workspaces.map((workspace) => [
      workspace.id,
      workspace.name,
    ]),
  );
}

/**
 * What the screen shows of the account's own join requests:
 *
 * - the pending requests, each with the workspace's ID, its requested name,
 *   when it was sent, its end, and Withdraw, and then the requests that
 *   ended, each with how and when, both in the main process's order (the
 *   most recently created first). A pending request past its expiry comes
 *   from the main process as `expired`, so the screen reads no clock;
 * - the workspace's name next to its ID once the account's workspace list
 *   holds it, for example after an approval;
 * - a fixed status text: before the first state, without a signed-in
 *   device, while they load, without a request, and the problem of a
 *   failed load, with what was loaded before.
 */
export function describeOwnJoinRequests(
  view: OwnJoinRequestsScreenView,
  workspaces: WorkspacePanelView,
): OwnJoinRequestsModel {
  const none = { pending: [], ended: [] };
  switch (view.kind) {
    case "unavailable":
      return { ...none, status: OWN_JOIN_REQUEST_MESSAGES.unavailable };
    case "pending":
      return { ...none, status: OWN_JOIN_REQUEST_MESSAGES.pending };
    case "known":
      break;
  }
  const { state } = view;
  switch (state.status) {
    case "signed_out":
      return { ...none, status: OWN_JOIN_REQUEST_MESSAGES.signedOut };
    case "loading":
      return { ...none, status: OWN_JOIN_REQUEST_MESSAGES.loading };
    case "ready":
    case "unavailable":
      break;
  }
  const names = listedWorkspaces(workspaces);
  const rows = state.requests.map((request): OwnJoinRequestRow => ({
    joinRequestId: request.joinRequestId,
    workspaceId: request.workspaceId,
    workspaceName: names.get(request.workspaceId),
    requestedName: request.requestedName,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    outcome: request.decision,
    decidedAt: request.decidedAt,
    withdraw:
      request.decision === null
        ? {
            joinRequestId: request.joinRequestId,
            workspaceId: request.workspaceId,
            requestedName: request.requestedName,
          }
        : null,
  }));
  return {
    pending: rows.filter((row) => row.outcome === null),
    ended: rows.filter((row) => row.outcome !== null),
    status:
      state.status === "unavailable"
        ? OWN_JOIN_REQUEST_PROBLEM_MESSAGES[state.problem]
        : rows.length === 0
          ? OWN_JOIN_REQUEST_MESSAGES.empty
          : "",
  };
}

/**
 * Whether the screen still offers to withdraw `request` as it was asked:
 * the latest state lists it as pending, with the same workspace and name.
 * A request that ended meanwhile, for example by a decision, a withdrawal
 * on another device, or its expiry, is no longer offered.
 */
export function isWithdrawalOffered(
  view: OwnJoinRequestsScreenView,
  request: WithdrawRequest,
): boolean {
  if (
    view.kind !== "known" ||
    (view.state.status !== "ready" && view.state.status !== "unavailable")
  ) {
    return false;
  }
  return view.state.requests.some(
    (held) =>
      held.decision === null &&
      held.joinRequestId === request.joinRequestId &&
      held.workspaceId === request.workspaceId &&
      held.requestedName === request.requestedName,
  );
}

/** The IDs of the pending requests that `view` lists. */
function pendingIds(view: OwnJoinRequestsScreenView): ReadonlySet<string> {
  return view.kind === "known"
    ? new Set(
        view.state.requests
          .filter((request) => request.decision === null)
          .map((request) => request.joinRequestId),
      )
    : new Set();
}

/**
 * The limits of join requests of ADR 0014 ("Limits"), which the sentences
 * name: no protocol constant holds them, so they live here once, for the
 * sentence of a refused request and the question before a withdrawal.
 */
export const JOIN_REQUEST_POLICY_LIMITS = Object.freeze({
  /** Pending requests per account. */
  pendingPerAccount: 5,
  /** New requests per account within `newRequestWindowHours`. */
  newRequestsPerAccount: 10,
  newRequestWindowHours: 24,
  /** Pending requests per workspace. */
  pendingPerWorkspace: 50,
  /** The wait before an account asks a workspace again after a denial. */
  hoursAfterDenial: 24,
});

const LIMITS = JOIN_REQUEST_POLICY_LIMITS;

/**
 * The question before a withdrawal. A withdrawn request cannot come back:
 * a new request is refused while the workspace pauses new requests, which
 * leaves the pending ones open, and it counts toward the account's new
 * requests within a day (ADR 0014, "Limits").
 */
export const WITHDRAW_QUESTION = Object.freeze({
  title: "Withdraw this request?",
  text: `The request ends, and the owner and the admins of the workspace can no longer approve it. You can ask again with the workspace ID, but a new request is refused while the workspace pauses new requests, and it counts toward the ${String(LIMITS.newRequestsPerAccount)} requests that an account can make in ${String(LIMITS.newRequestWindowHours)} hours.`,
  confirm: "Withdraw",
});

/** The actions of the join request part. */
export type OwnJoinRequestActionKind = "create" | "withdraw";

/** The sentences after an action that the API confirmed. */
export const OWN_JOIN_REQUEST_DONE_MESSAGES = Object.freeze({
  create:
    "Your request to join was sent. The owner and the admins of the workspace decide on it; it shows under Your join requests.",
  /**
   * The API answers with the account's pending request for the workspace
   * instead of creating another, so its name may differ from the one sent.
   * The screen tells it apart on a best-effort basis
   * (`describeCreateResult`); the list of own join requests is
   * authoritative.
   */
  createPending:
    "You already have a pending request for this workspace, so no new one was made. It shows under Your join requests, with the name it was sent with.",
  withdraw: "The request was withdrawn.",
});

/** The start of the sentence after an action that did not happen. */
export const OWN_JOIN_REQUEST_NOT_DONE_MESSAGES: Readonly<
  Record<OwnJoinRequestActionKind, string>
> = Object.freeze({
  create: "No request to join was made.",
  withdraw: "The request could not be withdrawn.",
});

/**
 * The sentence after an answer that does not show whether the API acted
 * (`unknown`). Nothing is sent again on its own. Asking again is safe:
 * while a request is pending, the API answers with it instead of creating
 * another.
 */
export const OWN_JOIN_REQUEST_UNKNOWN_MESSAGES: Readonly<
  Record<OwnJoinRequestActionKind, string>
> = Object.freeze({
  create:
    "It is not known whether your request to join was made. Check your join requests; the request is not sent again on its own. Asking again does not make a second request while one is pending.",
  withdraw:
    "It is not known whether the request was withdrawn. Check your join requests; the request is not sent again on its own.",
});

/**
 * Why an action was refused, after its start. `too_soon` and
 * `rate_limited` say how long to wait (`describeWait`); a create's
 * `rate_limited` also names the limits of join requests of ADR 0014
 * ("Limits") as possible causes, because the API does not tell them apart,
 * and its own limit of requests per minute answers `rate_limited` too.
 */
export const OWN_JOIN_REQUEST_REFUSAL_MESSAGES = Object.freeze({
  /** A create's `invalid`: the ID passed the screen's check, so the name. */
  invalidName: PEOPLE_ACTION_REFUSAL_MESSAGES.invalidName,
  invalid: PEOPLE_ACTION_REFUSAL_MESSAGES.invalid,
  not_signed_in:
    "This device is not signed in, or the server did not accept its sign-in. Sign in on the Account screen, then try again.",
  unavailable: PEOPLE_ACTION_REFUSAL_MESSAGES.unavailable,
  tooSoon: (wait: string) =>
    `This device sent many requests in a short time. Try again in ${wait}.`,
  createRateLimited: (wait: string) =>
    `The server asked to wait. Join requests have limits: an account can have at most ${String(LIMITS.pendingPerAccount)} pending requests and make ${String(LIMITS.newRequestsPerAccount)} in ${String(LIMITS.newRequestWindowHours)} hours, a workspace takes at most ${String(LIMITS.pendingPerWorkspace)} pending requests, and after a denial the same workspace can be asked again after ${String(LIMITS.hoursAfterDenial)} hours. Try again in ${wait}.`,
  rateLimited: (wait: string) =>
    `The server asked to wait. Try again in ${wait}.`,
  already_member:
    "You are already a member of this workspace. It is in your list of workspaces.",
  workspace_not_found:
    "No workspace has this ID, or the workspace was archived. Check the ID with the person who gave it to you.",
  join_requests_closed:
    "The workspace does not take your request: it has paused new requests, or it has blocked your account. Ask its owner or an admin.",
  not_found:
    "The server does not know this request for your account. Check your join requests.",
  conflict:
    "The request is no longer pending: it was decided, or it ended. Check your join requests.",
  failed: "The server refused it.",
});

/**
 * The refusals that each action can get. Any other refusal, which the main
 * process never answers for that action, says that the server refused it
 * (`failed`), as the main process maps the codes that a route never
 * answers (the Project Manager's decision of 2026-11-12 on #260).
 */
const EXPECTED_REFUSALS: Readonly<
  Record<OwnJoinRequestActionKind, ReadonlySet<OwnJoinRequestActionRefusal>>
> = Object.freeze({
  create: new Set<OwnJoinRequestActionRefusal>([
    "invalid",
    "not_signed_in",
    "unavailable",
    "too_soon",
    "rate_limited",
    "already_member",
    "workspace_not_found",
    "join_requests_closed",
    "failed",
  ]),
  withdraw: new Set<OwnJoinRequestActionRefusal>([
    "invalid",
    "not_signed_in",
    "unavailable",
    "too_soon",
    "rate_limited",
    "not_found",
    "conflict",
    "failed",
  ]),
});

/** The reason of a refusal of `kind` after the action's start. */
function refusalText(
  kind: OwnJoinRequestActionKind,
  reason: OwnJoinRequestActionRefusal,
  retryAfterMs: number | null,
): string {
  const messages = OWN_JOIN_REQUEST_REFUSAL_MESSAGES;
  if (!EXPECTED_REFUSALS[kind].has(reason)) {
    return messages.failed;
  }
  const wait = describeWait(retryAfterMs ?? 0);
  switch (reason) {
    case "invalid":
      return kind === "create" ? messages.invalidName : messages.invalid;
    case "too_soon":
      return messages.tooSoon(wait);
    case "rate_limited":
      return kind === "create"
        ? messages.createRateLimited(wait)
        : messages.rateLimited(wait);
    default:
      return messages[reason];
  }
}

/**
 * The sentence after a create's answer. `sentName` is the name that went,
 * and `heldPending` the IDs of the pending requests that the screen listed
 * before it: an answer with one of them, or with another name, is the
 * pending request that the account already had for the workspace. This is
 * best effort: a pending request with the same name that the list did not
 * show yet reads as a new one. The list of own join requests, which the
 * main process loads again after the answer, is authoritative.
 */
export function describeCreateResult(
  result: CreateJoinRequestResult,
  sentName: string,
  heldPending: ReadonlySet<string>,
): string {
  switch (result.outcome) {
    case "ok":
      return heldPending.has(result.joinRequestId) ||
        result.requestedName !== sentName
        ? OWN_JOIN_REQUEST_DONE_MESSAGES.createPending
        : OWN_JOIN_REQUEST_DONE_MESSAGES.create;
    case "unknown":
      return OWN_JOIN_REQUEST_UNKNOWN_MESSAGES.create;
    case "refused":
      return `${OWN_JOIN_REQUEST_NOT_DONE_MESSAGES.create} ${refusalText("create", result.reason, result.retryAfterMs)}`;
  }
}

/**
 * How a withdrawal ended, for the focus of the screen:
 *
 * - `withdrawn`: the API confirmed it in the same session, so its row and
 *   its button leave the pending requests with the next list;
 * - `may_leave`: `unknown`, `not_found`, or `conflict` in the same session,
 *   after which the main process loads the list again, so the row leaves
 *   with that list when the request ended meanwhile;
 * - `stays`: any other refusal, or a call that failed on its way, after
 *   which nothing loads the list, so the row stays;
 * - `none`: nothing was sent, or the answer came after its session ended.
 */
export type WithdrawOutcome = "withdrawn" | "may_leave" | "stays" | "none";

/**
 * The refusals of a withdrawal after which the main process loads the own
 * join requests again (#260), as after `ok` and `unknown`.
 */
const RELOADING_WITHDRAW_REFUSALS: ReadonlySet<OwnJoinRequestActionRefusal> =
  new Set(["not_found", "conflict"]);

/**
 * The outcome of a withdrawal's answer in its own session, or of a call
 * that failed on its way (`undefined`).
 */
export function withdrawOutcome(
  result: WithdrawJoinRequestResult | undefined,
): Exclude<WithdrawOutcome, "none"> {
  if (result === undefined) {
    return "stays";
  }
  switch (result.outcome) {
    case "ok":
      return "withdrawn";
    case "unknown":
      return "may_leave";
    case "refused":
      return RELOADING_WITHDRAW_REFUSALS.has(result.reason)
        ? "may_leave"
        : "stays";
  }
}

/** The sentence after a withdrawal's answer. */
export function describeWithdrawResult(
  result: WithdrawJoinRequestResult,
): string {
  switch (result.outcome) {
    case "ok":
      return OWN_JOIN_REQUEST_DONE_MESSAGES.withdraw;
    case "unknown":
      return OWN_JOIN_REQUEST_UNKNOWN_MESSAGES.withdraw;
    case "refused":
      return `${OWN_JOIN_REQUEST_NOT_DONE_MESSAGES.withdraw} ${refusalText("withdraw", result.reason, result.retryAfterMs)}`;
  }
}

/** Why the main process refused to load the own join requests on a refresh. */
export type OwnJoinRequestLoadRefusal = Extract<
  OwnJoinRequestLoadResult,
  { readonly outcome: "refused" }
>["reason"];

/** The sentences after "Refresh your join requests". */
export const OWN_JOIN_REQUEST_REFRESH_MESSAGES: Readonly<
  Record<OwnJoinRequestLoadRefusal, string>
> & { readonly loading: string; readonly failed: string } = Object.freeze({
  /** Until the next state of the own join requests arrives. */
  loading: "Loading your join requests again.",
  not_signed_in: "Your join requests appear once this device is signed in.",
  too_soon:
    "Your join requests were loaded a moment ago. Try again in a few seconds.",
  failed: "Your join requests could not be loaded again. Try again.",
});

/** What the screen shows of its join request actions. */
export interface OwnJoinRequestActionsView {
  /**
   * True while a create or a withdrawal runs: the fields are read-only, and
   * every control of the part stays focusable and does nothing
   * (`aria-disabled`), so that one action runs at a time.
   */
  readonly running: boolean;
  /** The text of the workspace ID field, as typed or pasted. */
  readonly workspaceId: string;
  /**
   * The text of the name field: as the person edited it, or the account's
   * display name until they do.
   */
  readonly name: string;
  /** Why the ID field's text was not sent, or undefined. */
  readonly workspaceProblem: string | undefined;
  /** Why the name was not sent, or undefined. */
  readonly nameProblem: string | undefined;
  /** The sentence of the last create, below the form, or undefined. */
  readonly formMessage: string | undefined;
  /** The sentence of the last withdrawal or refresh, below the list, or undefined. */
  readonly listMessage: string | undefined;
  /** The request of the open question before a withdrawal, or undefined. */
  readonly withdrawal: WithdrawRequest | undefined;
}

export const IDLE_OWN_JOIN_REQUEST_ACTIONS: OwnJoinRequestActionsView =
  Object.freeze({
    running: false,
    workspaceId: "",
    name: "",
    workspaceProblem: undefined,
    nameProblem: undefined,
    formMessage: undefined,
    listMessage: undefined,
    withdrawal: undefined,
  });

/** The bridges' functions that the join request actions call. */
export interface OwnJoinRequestActionsBridges {
  readonly ownJoinRequestActions: Pick<
    OwnJoinRequestActionsBridge,
    "create" | "withdraw"
  >;
  readonly ownJoinRequests: Pick<OwnJoinRequestsBridge, "load">;
}

export interface OwnJoinRequestActions {
  /** Changes the text of the ID field and ends its problem; nothing while an action runs. */
  readonly editWorkspaceId: (text: string) => void;
  /** Changes the text of the name field and ends its problem; nothing while an action runs. */
  readonly editName: (text: string) => void;
  /**
   * Asks to join the workspace of the ID field with the trimmed name, once
   * both pass their checks, and keeps their problems otherwise; nothing is
   * sent then. A confirmed request empties the ID field and gives the name
   * field the account's display name again. Nothing while an action runs.
   * Resolves when the answer counted or was dropped.
   */
  readonly submit: () => Promise<void>;
  /** Opens the question before withdrawing a request that the screen offers. */
  readonly startWithdraw: (request: WithdrawRequest) => void;
  /**
   * Closes the question without the withdrawal. Returns true when a
   * question was open, so that the screen tells the person's cancel apart
   * from the close of a dialog whose question had already ended.
   */
  readonly cancelWithdraw: () => boolean;
  /**
   * Withdraws the request of the open question, once. Resolves to how it
   * ended (`WithdrawOutcome`), so that the screen knows whether its button
   * leaves the page at once, may leave with the next list, or stays.
   */
  readonly confirmWithdraw: () => Promise<WithdrawOutcome>;
  /** Asks the main process to load the own join requests again; nothing while an action runs. */
  readonly refresh: () => Promise<void>;
  /**
   * Follows the account status: the name field shows the account's display
   * name until the person edits it, and a sign-out or another account or
   * device ends the session, which drops both fields' texts and problems,
   * the question, the sentence, and the answers on their way, and ends the
   * running state at once, so that the new session can act before the
   * answer of the old one arrives.
   */
  readonly accountChanged: (account: AccountView) => void;
  /**
   * Follows the own join requests: the question ends once its request is
   * no longer pending as it was asked (`isWithdrawalOffered`), so a later
   * confirmation sends nothing, and the refresh's sentence ends with the
   * next state.
   */
  readonly listChanged: (view: OwnJoinRequestsScreenView) => void;
}

/**
 * The requester's join request actions (#95, D1): a create and a
 * withdrawal, one at a time, each sent once and never again on its own.
 * The result is a fixed sentence; the list changes only with the state
 * that the main process sends, never from an answer. A create is not tied
 * to the selected workspace, because the account is not a member of the
 * workspace that it names, so a switch of the selected workspace changes
 * nothing here; the session is the signed-in account and device.
 */
export function createOwnJoinRequestActions(
  bridges: OwnJoinRequestActionsBridges,
  onView: (view: OwnJoinRequestActionsView) => void,
): OwnJoinRequestActions {
  let running = false;
  let workspaceText = "";
  /** The name as the person edited it; undefined until they do. */
  let draft: string | undefined;
  /** The account's display name, from the latest account status. */
  let accountName: string | undefined;
  let workspaceProblem: string | undefined;
  let nameProblem: string | undefined;
  /** The sentence of the last action, and where it shows. */
  let message:
    { readonly text: string; readonly place: "form" | "list" } | undefined;
  let withdrawal: WithdrawRequest | undefined;
  /** The signed-in account and device; undefined before the first status. */
  let identity: string | null | undefined;
  /**
   * Grows when a session ends, so that no answer outlives it: an answer of
   * an earlier session neither shows nor ends the running state, which the
   * end of its session already ended.
   */
  let session = 0;
  /**
   * Grows with every create and withdrawal that starts, so that a refresh's
   * answer shows only when no action started after the refresh.
   */
  let actionCount = 0;
  /** The latest own join requests. */
  let latest: OwnJoinRequestsScreenView = { kind: "pending" };
  /**
   * The revision of the own join requests when a refresh answered
   * `loading`, while its sentence shows; a later state ends the sentence.
   */
  let refreshedAt: number | undefined;
  const show = () =>
    onView(
      Object.freeze({
        running,
        workspaceId: workspaceText,
        name: draft ?? accountName ?? "",
        workspaceProblem,
        nameProblem,
        formMessage: message?.place === "form" ? message.text : undefined,
        listMessage: message?.place === "list" ? message.text : undefined,
        withdrawal,
      }),
    );

  /** Starts an action: the last sentence and a refresh's wait end. */
  function begin(): void {
    running = true;
    actionCount += 1;
    message = undefined;
    refreshedAt = undefined;
  }

  return Object.freeze({
    editWorkspaceId: (text: string) => {
      if (running) {
        return;
      }
      workspaceText = text;
      workspaceProblem = undefined;
      show();
    },
    editName: (text: string) => {
      if (running) {
        return;
      }
      draft = text;
      nameProblem = undefined;
      show();
    },
    submit: async () => {
      if (running) {
        return;
      }
      const workspaceId = workspaceIdToSend(workspaceText);
      const name = (draft ?? accountName ?? "").trim();
      workspaceProblem = workspaceIdProblem(workspaceText);
      nameProblem = namePrompt(name);
      if (
        workspaceId === undefined ||
        workspaceProblem !== undefined ||
        nameProblem !== undefined
      ) {
        show();
        return;
      }
      begin();
      show();
      const startSession = session;
      const heldPending = pendingIds(latest);
      let ok = false;
      let sentence: string;
      try {
        const result = await bridges.ownJoinRequestActions.create(
          workspaceId,
          name,
        );
        ok = result.outcome === "ok";
        sentence = describeCreateResult(result, name, heldPending);
      } catch {
        // A fixed text: never the error, which might name the call.
        sentence = `${OWN_JOIN_REQUEST_NOT_DONE_MESSAGES.create} ${PEOPLE_ACTION_NOT_SENT}`;
      }
      // The end of its session already ended it, and an action of the new
      // session may run now.
      if (session !== startSession) {
        return;
      }
      running = false;
      message = { text: sentence, place: "form" };
      if (ok) {
        workspaceText = "";
        draft = undefined;
      }
      show();
    },
    startWithdraw: (request: WithdrawRequest) => {
      if (running || !isWithdrawalOffered(latest, request)) {
        return;
      }
      withdrawal = Object.freeze({ ...request });
      show();
    },
    cancelWithdraw: () => {
      if (withdrawal === undefined) {
        return false;
      }
      withdrawal = undefined;
      show();
      return true;
    },
    confirmWithdraw: async () => {
      const request = withdrawal;
      if (running || request === undefined) {
        return "none";
      }
      withdrawal = undefined;
      begin();
      show();
      const startSession = session;
      let answer: WithdrawJoinRequestResult | undefined;
      let sentence: string;
      try {
        answer = await bridges.ownJoinRequestActions.withdraw(
          request.joinRequestId,
        );
        sentence = describeWithdrawResult(answer);
      } catch {
        sentence = `${OWN_JOIN_REQUEST_NOT_DONE_MESSAGES.withdraw} ${PEOPLE_ACTION_NOT_SENT}`;
      }
      // As for a create: an answer of an earlier session changes nothing.
      if (session !== startSession) {
        return "none";
      }
      running = false;
      message = { text: sentence, place: "list" };
      show();
      return withdrawOutcome(answer);
    },
    refresh: async () => {
      if (running) {
        return;
      }
      const startSession = session;
      const startAction = actionCount;
      let loading = false;
      let sentence: string;
      try {
        const result = await bridges.ownJoinRequests.load();
        loading = result.outcome === "loading";
        sentence =
          result.outcome === "loading"
            ? OWN_JOIN_REQUEST_REFRESH_MESSAGES.loading
            : OWN_JOIN_REQUEST_REFRESH_MESSAGES[result.reason];
      } catch {
        sentence = OWN_JOIN_REQUEST_REFRESH_MESSAGES.failed;
      }
      // An action that started meanwhile, also one that has ended since,
      // has its own sentence.
      if (session === startSession && actionCount === startAction) {
        message = { text: sentence, place: "list" };
        refreshedAt = loading
          ? latest.kind === "known"
            ? latest.state.revision
            : -1
          : undefined;
        show();
      }
    },
    accountChanged: (account: AccountView) => {
      const next = accountIdentity(account);
      if (next === undefined) {
        return;
      }
      const name = accountDisplayName(account);
      let changed = draft === undefined && name !== accountName;
      accountName = name;
      const ended =
        identity !== undefined && identity !== null && next !== identity;
      identity = next;
      if (ended) {
        session += 1;
        changed ||=
          running ||
          workspaceText !== "" ||
          draft !== undefined ||
          workspaceProblem !== undefined ||
          nameProblem !== undefined ||
          message !== undefined ||
          withdrawal !== undefined;
        workspaceText = "";
        draft = undefined;
        workspaceProblem = undefined;
        nameProblem = undefined;
        message = undefined;
        withdrawal = undefined;
        refreshedAt = undefined;
        // The new session is not locked until the old answer arrives.
        running = false;
      }
      if (changed) {
        show();
      }
    },
    listChanged: (view: OwnJoinRequestsScreenView) => {
      latest = view;
      let changed = false;
      if (
        view.kind === "known" &&
        refreshedAt !== undefined &&
        view.state.revision > refreshedAt
      ) {
        refreshedAt = undefined;
        if (message?.text === OWN_JOIN_REQUEST_REFRESH_MESSAGES.loading) {
          message = undefined;
          changed = true;
        }
      }
      if (withdrawal !== undefined && !isWithdrawalOffered(view, withdrawal)) {
        withdrawal = undefined;
        changed = true;
      }
      if (changed) {
        show();
      }
    },
  });
}
