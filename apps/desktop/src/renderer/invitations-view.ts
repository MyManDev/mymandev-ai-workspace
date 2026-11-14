import type {
  InvitationActionsBridge,
  InvitationsBridge,
} from "../shared/desktop-bridge.ts";
import type {
  CreateInvitationResult,
  InvitationActionRefusal,
  InvitationLoadResult,
  InvitationsView,
  PersonView,
  RevokeInvitationResult,
  WorkspaceProblem,
} from "../shared/ipc-contract.ts";
import { describeWait, PEOPLE_ACTION_NOT_SENT } from "./people-actions-view.ts";
import type { PeopleScreenView } from "./people-view.ts";

// The invitations part of the people screen (#95; ADR 0014, "Invitations";
// decisions D1 to D3 of 2026-11-06): the selected workspace's live
// invitations for the owner and the admins, "Invite" on each active
// unclaimed person, "Revoke" on each live invitation, and the code of a new
// invitation, shown once. The code (D2) arrives in the answer of a create
// and is held only in the view of the open code dialog: closing the dialog,
// a switch, or a sign-out drops it, nothing logs it, and no status sentence
// holds it. No channel returns it again. A demotion of the account to a
// member drops it from the open dialog as well, which then says that the
// code no longer works (#266).

/** What the screen knows of the selected workspace's live invitations. */
export type InvitationsScreenView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first state. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly state: InvitationsView };

export function initialInvitationsScreenView(
  bridgeAvailable: boolean,
): InvitationsScreenView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

/**
 * Subscribes to the live invitations and reports every state as the view;
 * a refused subscription makes the view unavailable. As the screen opens,
 * it asks the main process to load them once (D3). The main process counts
 * the request also while it refuses it, for example for a member or before
 * a workspace is selected, and loads them once it may, so its answer shows
 * only in the state. Returns the function that ends the subscription.
 */
export function followInvitations(
  invitations: Pick<InvitationsBridge, "subscribeState" | "load">,
  onView: (view: InvitationsScreenView) => void,
): () => void {
  const stop = invitations.subscribeState(
    (state) => onView({ kind: "known", state }),
    () => onView({ kind: "unavailable" }),
  );
  invitations.load().catch(() => undefined);
  return stop;
}

/**
 * The most live invitations that a workspace holds (ADR 0014, "Limits").
 * The API refuses another create with `rate_limited` and the wait until the
 * soonest of them ends; the person's own live invitation, which the new one
 * replaces, does not count. A copy of the protocol's
 * `INVITATION_COUNT_LIMITS.live`, because the renderer cannot import the
 * protocol package; `config/renderer-protocol.test.ts` checks that the two
 * match.
 */
export const MAX_LIVE_INVITATIONS = 50;

/**
 * How many days a new invitation lasts: the screen sends no lifetime, so
 * the API's default of 7 days applies (ADR 0014, "Lifetimes"; the protocol's
 * `INVITATION_LIFETIME_SECONDS.default`).
 */
export const INVITATION_LIFETIME_DAYS = 7;

/** The fixed texts of the invitations part. */
export const INVITATION_MESSAGES = Object.freeze({
  heading: "Open invitations",
  unavailable: "Invitations are not available.",
  pending: "Checking the invitations.",
  loading: "Loading the invitations.",
  empty: "No open invitations.",
  /** An invitation whose person the people do not list. */
  unlisted: "A person who is not shown here",
  /** Before the creator's name. */
  createdBy: "Created by ",
  /** Before the end of the invitation. */
  expires: "Expires ",
  refresh: "Refresh the invitations",
});

/**
 * Why the live invitations are `unavailable`: the failure of the last load.
 * What was loaded before stays shown, and the main process loads again by
 * itself.
 */
export const INVITATION_PROBLEM_MESSAGES: Readonly<
  Record<WorkspaceProblem, string>
> = Object.freeze({
  not_signed_in: "The server did not accept this device's sign-in.",
  not_found: "The server did not find the selected workspace.",
  rate_limited: "The server asked to wait. Trying again in a minute.",
  unavailable: "The server could not be reached. Trying again later.",
  failed: "The invitations could not be loaded. Trying again later.",
});

/** The invitation actions: create one for a person, and revoke one. */
export type InvitationActionKind = "invite" | "revoke";

/**
 * An invitation action that the screen offers, with the selected
 * workspace's ID when the screen showed it. The IDs go only to the bridge;
 * the screen never shows them.
 */
export type InvitationActionRequest =
  | {
      readonly kind: "invite";
      readonly workspaceId: string;
      /** The active unclaimed person to invite. */
      readonly memberId: string;
      readonly name: string;
    }
  | {
      readonly kind: "revoke";
      readonly workspaceId: string;
      readonly invitationId: string;
      /** The invited person's name, or null when the people do not list it. */
      readonly name: string | null;
    };

/** The labels of the invitation actions' buttons. */
export const INVITATION_ACTION_LABELS: Readonly<
  Record<InvitationActionKind, string>
> = Object.freeze({
  invite: "Invite",
  revoke: "Revoke",
});

/** The question before an invitation action. */
export interface InvitationQuestion {
  readonly title: string;
  readonly text: string;
  /** The confirming button. */
  readonly confirm: string;
  /** The person's name, shown as text below the title. */
  readonly name: string;
}

/**
 * The question of each invitation action; both ask first. The question of
 * a create says what ADR 0014 does: one invitation per person, so a new
 * one revokes the earlier one, and the code is shown once.
 */
export function describeInvitationQuestion(
  request: InvitationActionRequest,
): InvitationQuestion {
  switch (request.kind) {
    case "invite":
      return {
        title: "Invite this person?",
        text: `This creates an invitation code with which one person can claim this person, once, within ${String(INVITATION_LIFETIME_DAYS)} days. The code is shown only once, right after it is created. If this person already has an open invitation, that invitation is revoked and its code stops working.`,
        confirm: "Create the invitation",
        name: request.name,
      };
    case "revoke":
      return {
        title: "Revoke this invitation?",
        text: "Its code stops working at once. The person stays listed as not claimed, and you can invite them again.",
        confirm: "Revoke",
        name: request.name ?? INVITATION_MESSAGES.unlisted,
      };
  }
}

/** A live invitation as the screen shows it. */
export interface InvitationRow {
  /** The key of the row only; the screen never shows it. */
  readonly invitationId: string;
  /** The invited person's display name, or null when the people do not list it. */
  readonly personName: string | null;
  readonly creatorName: string;
  readonly expiresAt: string;
  readonly revoke: InvitationActionRequest;
}

/** What the screen shows of the invitations, for the owner and the admins. */
export interface InvitationsModel {
  /** The text of the part's status paragraph; empty when there is none. */
  readonly status: string;
  /** The live invitations, in the main process's order. */
  readonly rows: readonly InvitationRow[];
  /** "Invite" on each active unclaimed person, by member ID. */
  readonly invites: ReadonlyMap<string, InvitationActionRequest>;
}

/**
 * The selected workspace and its people, only while the people are `ready`
 * and the account's own active person is the owner or an admin, who create,
 * revoke, and list invitations (ADR 0014, "People and roles").
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
 * Whether the account's own person is no longer the owner or an admin of
 * `workspaceId`, so that the server revoked the unaccepted invitations that
 * the account created there (ADR 0014, "People and roles": a demotion
 * revokes them in the same transaction). Either the people are `ready` for
 * that workspace and list the account's own active person as a member, or
 * `list`, the latest state of the invitations or of the join requests, says
 * `not_allowed` for that workspace: the main process says so as soon as it
 * applied the demotion, also before the people show it (#262). A state of
 * another workspace says nothing about this one.
 */
export function isDemoted(
  people: PeopleScreenView,
  list:
    | { readonly workspaceId: string | null; readonly status: string }
    | undefined,
  workspaceId: string,
): boolean {
  if (list?.workspaceId === workspaceId && list.status === "not_allowed") {
    return true;
  }
  if (people.kind !== "known" || people.state.status !== "ready") {
    return false;
  }
  const { state } = people;
  return (
    state.workspaceId === workspaceId &&
    state.people.some(
      (person) =>
        !person.former &&
        person.memberId === state.ownMemberId &&
        person.role === "member",
    )
  );
}

/** Whether `expiresAt` is later than the clock `now` in milliseconds. */
function isLive(expiresAt: string, now: number): boolean {
  const end = Date.parse(expiresAt);
  return !Number.isNaN(end) && end > now;
}

/**
 * What the screen shows of the invitations by the clock `now`, or null for
 * no invitations part at all: without the owner's or an admin's role in the
 * selected workspace, and while the people are not `ready`, as for the
 * people actions.
 *
 * - "Invite" on each active unclaimed person.
 * - The live invitations of the selected workspace only, never another
 *   workspace's, each with the invited person's name from the people, the
 *   creator's name, its end, and "Revoke". An invitation past its end by
 *   the clock is left out, as the main process leaves it out at its next
 *   publish.
 * - A fixed status text: before the first state, while the main process
 *   does not list them for this workspace yet, while they load, without
 *   any, and the problem of a failed load, with what was loaded before.
 */
export function describeInvitations(
  people: PeopleScreenView,
  invitations: InvitationsScreenView,
  now: number,
): InvitationsModel | null {
  const managed = managedWorkspace(people);
  if (managed === null) {
    return null;
  }
  const { workspaceId } = managed;
  const invites = new Map<string, InvitationActionRequest>();
  for (const person of managed.people) {
    if (!person.former && !person.claimed) {
      invites.set(person.memberId, {
        kind: "invite",
        workspaceId,
        memberId: person.memberId,
        name: person.displayName,
      });
    }
  }
  const base = { invites, rows: [] as InvitationRow[] };
  switch (invitations.kind) {
    case "unavailable":
      return { ...base, status: INVITATION_MESSAGES.unavailable };
    case "pending":
      return { ...base, status: INVITATION_MESSAGES.pending };
    case "known":
      break;
  }
  const { state } = invitations;
  if (state.workspaceId !== workspaceId) {
    // Another workspace's state, before the main process followed the
    // switch: its invitations never show here.
    return { ...base, status: INVITATION_MESSAGES.loading };
  }
  switch (state.status) {
    case "signed_out":
    case "no_workspace":
    case "not_allowed":
      // The people and the invitations come through their own channels and
      // can differ for a moment, for example right after a promotion.
      return { ...base, status: INVITATION_MESSAGES.pending };
    case "loading":
      return { ...base, status: INVITATION_MESSAGES.loading };
    case "ready":
    case "unavailable":
      break;
  }
  const names = new Map(
    managed.people.map((person) => [person.memberId, person.displayName]),
  );
  const rows = state.invitations
    .filter((invitation) => isLive(invitation.expiresAt, now))
    .map((invitation): InvitationRow => {
      const personName = names.get(invitation.memberId) ?? null;
      return {
        invitationId: invitation.invitationId,
        personName,
        creatorName: invitation.creatorName,
        expiresAt: invitation.expiresAt,
        revoke: {
          kind: "revoke",
          workspaceId,
          invitationId: invitation.invitationId,
          name: personName,
        },
      };
    });
  return {
    invites,
    rows,
    status:
      state.status === "unavailable"
        ? INVITATION_PROBLEM_MESSAGES[state.problem]
        : rows.length === 0
          ? INVITATION_MESSAGES.empty
          : "",
  };
}

/**
 * Whether the screen still offers `request` as it is: the same person with
 * the same name for a create, and the same live invitation with the same
 * person's name for a revocation. A question whose action went away or
 * changed, for example after a claim, a rename, another workspace, or the
 * end of the invitation, closes.
 */
export function isInvitationOffered(
  model: InvitationsModel | null,
  request: InvitationActionRequest,
): boolean {
  if (model === null) {
    return false;
  }
  const fields = Object.entries(request);
  const same = (other: InvitationActionRequest | undefined) =>
    other !== undefined &&
    fields.every(
      ([key, value]) => (other as Record<string, unknown>)[key] === value,
    );
  switch (request.kind) {
    case "invite":
      return same(model.invites.get(request.memberId));
    case "revoke":
      return model.rows.some((row) => same(row.revoke));
  }
}

/**
 * The next time after `now`, in milliseconds, at which the list changes by
 * the clock alone: the end of the soonest live invitation. Undefined when
 * nothing changes.
 */
export function nextInvitationsChange(
  view: InvitationsScreenView,
  now: number,
): number | undefined {
  if (view.kind !== "known") {
    return undefined;
  }
  let next: number | undefined;
  for (const invitation of view.state.invitations) {
    const end = Date.parse(invitation.expiresAt);
    if (!Number.isNaN(end) && end > now && (next === undefined || end < next)) {
      next = end;
    }
  }
  return next;
}

/** The sentence after an invitation action that the API confirmed. */
export const INVITATION_ACTION_DONE_MESSAGES: Readonly<
  Record<InvitationActionKind, string>
> = Object.freeze({
  invite: "The invitation was created.",
  revoke: "The invitation was revoked.",
});

/** The start of the sentence after an invitation action that did not happen. */
export const INVITATION_ACTION_NOT_DONE_MESSAGES: Readonly<
  Record<InvitationActionKind, string>
> = Object.freeze({
  invite: "The invitation could not be created.",
  revoke: "The invitation could not be revoked.",
});

/**
 * The sentence after an answer that does not show whether the API acted
 * (`unknown`). Nothing is sent again on its own: a second create would
 * revoke the first invitation. A code that was not shown never is.
 */
export const INVITATION_ACTION_UNKNOWN_MESSAGES: Readonly<
  Record<InvitationActionKind, string>
> = Object.freeze({
  invite:
    "It is not known whether the invitation was created. Check the open invitations; the request is not sent again on its own. A code that was not shown here cannot be shown later: to get a code, invite the person again, which revokes an earlier invitation.",
  revoke:
    "It is not known whether the invitation was revoked. Check the open invitations; the request is not sent again on its own.",
});

/**
 * The sentence after a create that the API confirmed while another
 * workspace was selected (the Project Manager's decision of 2026-11-10):
 * its code was dropped unseen (D2), so the workspace of the action says so
 * once it is shown again. It never holds the code.
 */
export const INVITATION_CREATED_UNSEEN_MESSAGE =
  "An invitation was created, but its code could not be shown. Invite the person again for a new code.";

/**
 * Why an invitation action was refused, after its start. `too_soon` and
 * `rate_limited` say how long to wait (`describeWait`); a create's
 * `rate_limited` can also mean the limit of live invitations.
 */
export const INVITATION_ACTION_REFUSAL_MESSAGES: Readonly<
  Record<
    Exclude<
      InvitationActionRefusal,
      "too_soon" | "rate_limited" | "not_found" | "conflict"
    >,
    string
  >
> & {
  readonly tooSoon: (wait: string) => string;
  readonly rateLimited: (wait: string) => string;
  readonly liveLimit: (limit: number) => string;
  readonly notFound: Readonly<Record<InvitationActionKind, string>>;
  readonly conflict: Readonly<Record<InvitationActionKind, string>>;
} = Object.freeze({
  invalid: "The request was not valid.",
  not_selected:
    "Another workspace was selected before it was sent. Check the list, then try again.",
  not_signed_in:
    "This device is not signed in, or the server did not accept its sign-in.",
  unavailable:
    "This device cannot send it now. Wait until the sign-in or the current change of the account is finished, then try again.",
  tooSoon: (wait: string) =>
    `This device sent many changes in a short time. Try again in ${wait}.`,
  rateLimited: (wait: string) =>
    `The server asked to wait. Try again in ${wait}.`,
  liveLimit: (limit: number) =>
    `The workspace already has as many open invitations as it allows (${String(limit)}). Revoke one, or wait until one is used or ends, then try again.`,
  not_allowed: "Your role in this workspace does not allow it.",
  notFound: Object.freeze({
    invite:
      "The server does not know this workspace or this person for your account. Check the list.",
    revoke:
      "The server does not know this invitation for your account. Check the open invitations.",
  }),
  conflict: Object.freeze({
    invite:
      "The person was claimed or removed in the meantime. Check the list.",
    revoke:
      "The invitation is no longer open: it was used, revoked, or it ended. Check the open invitations.",
  }),
  failed: "The server refused it.",
});

/**
 * Whether `invitations`, the latest live invitations, show the limit of
 * live invitations reached for a create for `memberId` in `workspaceId` by
 * the clock `now`: as many live invitations of other people as the limit.
 * The person's own live invitation does not count, because the new one
 * replaces it. Without the workspace's list the screen cannot tell.
 */
export function liveLimitReached(
  invitations: InvitationsView | undefined,
  workspaceId: string,
  memberId: string,
  now: number,
): boolean {
  if (
    invitations === undefined ||
    invitations.workspaceId !== workspaceId ||
    (invitations.status !== "ready" && invitations.status !== "unavailable")
  ) {
    return false;
  }
  const others = invitations.invitations.filter(
    (invitation) =>
      invitation.memberId !== memberId && isLive(invitation.expiresAt, now),
  ).length;
  return others >= MAX_LIVE_INVITATIONS;
}

/**
 * The sentence after the result of `request`. It never holds the code. A
 * create's `rate_limited` names the limit of live invitations when the
 * latest invitations show it reached (`liveLimitReached`), and asks to wait
 * otherwise, as for the other refusals with a wait.
 */
export function describeInvitationActionResult(
  request: InvitationActionRequest,
  result: CreateInvitationResult | RevokeInvitationResult,
  invitations: InvitationsView | undefined,
  now: number,
): string {
  const { kind } = request;
  switch (result.outcome) {
    case "ok":
      return INVITATION_ACTION_DONE_MESSAGES[kind];
    case "unknown":
      return INVITATION_ACTION_UNKNOWN_MESSAGES[kind];
    case "refused":
      break;
  }
  const messages = INVITATION_ACTION_REFUSAL_MESSAGES;
  const wait = describeWait(result.retryAfterMs ?? 0);
  let reason: string;
  switch (result.reason) {
    case "too_soon":
      reason = messages.tooSoon(wait);
      break;
    case "rate_limited":
      reason =
        request.kind === "invite" &&
        liveLimitReached(
          invitations,
          request.workspaceId,
          request.memberId,
          now,
        )
          ? messages.liveLimit(MAX_LIVE_INVITATIONS)
          : messages.rateLimited(wait);
      break;
    case "not_found":
      reason = messages.notFound[kind];
      break;
    case "conflict":
      reason = messages.conflict[kind];
      break;
    default:
      reason = messages[result.reason];
  }
  return `${INVITATION_ACTION_NOT_DONE_MESSAGES[kind]} ${reason}`;
}

/** Why the main process refused to load the invitations on a refresh. */
export type InvitationLoadRefusal = Extract<
  InvitationLoadResult,
  { readonly outcome: "refused" }
>["reason"];

/** The sentences after "Refresh the invitations". */
export const INVITATION_REFRESH_MESSAGES: Readonly<
  Record<InvitationLoadRefusal, string>
> & { readonly loading: string; readonly failed: string } = Object.freeze({
  /** Until the next state of the invitations arrives. */
  loading: "Loading the invitations again.",
  not_signed_in: "The invitations appear once this device is signed in.",
  no_workspace: "No workspace is selected.",
  not_allowed: "Only the owner and the admins see the invitations.",
  too_soon:
    "The invitations were loaded a moment ago. Try again in a few seconds.",
  failed: "The invitations could not be loaded again. Try again.",
});

/**
 * The code of a new invitation while its dialog is open (D2): the only
 * place where the renderer holds it. Closing the dialog drops it.
 */
export interface InvitationCodeView {
  /** The invited person's display name. */
  readonly name: string;
  /**
   * The invitation code, shown once. Null once the account was demoted to
   * a member (`isDemoted`, #266): the server revoked the invitation, so the
   * code no longer works, the view drops it at once, and the dialog says so
   * until it closes. A later promotion never brings it back.
   */
  readonly code: string | null;
  /** When the invitation ends; the dialog does not show it without the code. */
  readonly expiresAt: string;
}

/**
 * `view` without its code, for the dialog of an invitation that the server
 * revoked with the account's demotion (#266).
 */
export function withoutCode(view: InvitationCodeView): InvitationCodeView {
  return Object.freeze({ ...view, code: null });
}

/** What the screen shows of its invitation actions. */
export interface InvitationActionsView {
  /**
   * True while an action runs: every action's control stays focusable and
   * does nothing (`aria-disabled`), so that only one runs at a time.
   */
  readonly running: boolean;
  /** A fixed sentence about the last action, or undefined. It never holds a code. */
  readonly message: string | undefined;
  /** The open question, or undefined. */
  readonly question: InvitationActionRequest | undefined;
  /**
   * The code of the invitation just created while its dialog is open, or
   * undefined; without the code itself once the account was demoted.
   */
  readonly code: InvitationCodeView | undefined;
}

export const IDLE_INVITATION_ACTIONS: InvitationActionsView = Object.freeze({
  running: false,
  message: undefined,
  question: undefined,
  code: undefined,
});

export interface InvitationActions {
  /** Opens the question of an action that the screen offers; nothing while one runs. */
  readonly start: (request: InvitationActionRequest) => void;
  /**
   * Runs the action of the open question, once. A confirmed create opens
   * the code's dialog with the code from its answer, or without the code
   * when the account was demoted while the create was on its way (#266).
   * Resolves to true when the action ran and its control leaves the page
   * with the next invitations: a confirmed revocation.
   */
  readonly confirm: () => Promise<boolean>;
  /** Closes the open question without the action. */
  readonly cancel: () => void;
  /** Closes the code's dialog and drops the code. */
  readonly closeCode: () => void;
  /** Asks the main process to load the invitations again; nothing while an action runs. */
  readonly refresh: () => Promise<void>;
  /**
   * Follows the screen's views by the renderer's clock `now`:
   *
   * - the open question ends once the screen no longer offers it as it is
   *   (`isInvitationOffered`), so that it never comes back on its own and a
   *   later `confirm` sends nothing;
   * - the question, the code, and the sentence of the last action belong to
   *   the workspace that they were about, so they go when another workspace
   *   or none is selected, and always with a sign-out;
   * - the workspace of a create whose code was dropped after a switch says
   *   so when it is selected again (`INVITATION_CREATED_UNSEEN_MESSAGE`);
   * - the code of the open dialog goes, and the dialog stays open without
   *   it, once the account is demoted to a member of the workspace
   *   (`isDemoted`), because the server revoked the invitation (#266);
   * - the refresh's sentence ends with the next state of the invitations.
   */
  readonly listChanged: (
    people: PeopleScreenView,
    invitations: InvitationsScreenView,
    now: number,
  ) => void;
}

/**
 * The invitation actions of the screen: one at a time, each sent once and
 * never again on its own (D1). The result is a fixed sentence; the list
 * changes only with the state that the main process sends after it loads
 * the invitations again, never from the answer. The code of a confirmed
 * create goes into the view of its dialog only, and only while the
 * workspace of the action is still selected; otherwise it is dropped, and
 * that workspace says so once it is shown again
 * (`INVITATION_CREATED_UNSEEN_MESSAGE`), unless the session ended. A code
 * whose invitation the server revoked with the account's demotion is never
 * shown: the dialog opens, or stays open, without it (#266).
 */
export function createInvitationActions(
  bridge: Pick<InvitationActionsBridge, "create" | "revoke">,
  list: Pick<InvitationsBridge, "load">,
  onView: (view: InvitationActionsView) => void,
): InvitationActions {
  let running = false;
  let message: string | undefined;
  let question: InvitationActionRequest | undefined;
  let code: InvitationCodeView | undefined;
  /** The latest live invitations, for the limit of live invitations. */
  let latest: InvitationsView | undefined;
  /** The latest reading of the renderer's clock. */
  let latestNow = 0;
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
   * The revision of the invitations when a refresh answered `loading`, while
   * its sentence shows; a later state ends the sentence.
   */
  let refreshedAt: number | undefined;
  /**
   * The workspace whose confirmed create answered while another one was
   * selected, until it is shown again: it then says that the code could not
   * be shown. Only its ID is kept, never the code. The next action, a
   * refresh, and a sign-out end it.
   */
  let unseenIn: string | undefined;
  const show = () =>
    onView(Object.freeze({ running, message, question, code }));

  async function run(
    request: InvitationActionRequest,
    call: () => Promise<CreateInvitationResult | RevokeInvitationResult>,
  ): Promise<boolean> {
    running = true;
    message = undefined;
    question = undefined;
    refreshedAt = undefined;
    unseenIn = undefined;
    show();
    const startSelection = selection;
    const startSession = session;
    const startDemotions = demotions;
    let ok = false;
    let sentence: string;
    let created: InvitationCodeView | undefined;
    try {
      const result = await call();
      ok = result.outcome === "ok";
      sentence = describeInvitationActionResult(
        request,
        result,
        latest,
        latestNow,
      );
      if (
        request.kind === "invite" &&
        result.outcome === "ok" &&
        "code" in result
      ) {
        created = Object.freeze({
          name: request.name,
          code: result.code,
          expiresAt: result.expiresAt,
        });
      }
    } catch {
      sentence = `${INVITATION_ACTION_NOT_DONE_MESSAGES[request.kind]} ${PEOPLE_ACTION_NOT_SENT}`;
    }
    // An answer counts only while the action's workspace stayed selected:
    // after a switch, also one away and back, or a sign-out, it shows no
    // sentence, and the code of a create is dropped unseen.
    const still =
      selection === startSelection && selected === request.workspaceId;
    if (still) {
      message = sentence;
      // A demotion that arrived first revoked the new invitation: its
      // dialog opens without the code.
      code =
        created !== undefined && (demoted || demotions !== startDemotions)
          ? withoutCode(created)
          : created;
    } else if (created !== undefined && session === startSession) {
      // A created invitation whose code was dropped: its workspace says so
      // at once when it is shown again already (a switch away and back), or
      // when it is selected next. A sign-out ends the session, and with it
      // the sentence.
      if (selected === request.workspaceId) {
        message = INVITATION_CREATED_UNSEEN_MESSAGE;
      } else {
        unseenIn = request.workspaceId;
      }
    }
    running = false;
    show();
    return still && ok && request.kind === "revoke";
  }

  function send(
    request: InvitationActionRequest,
  ): Promise<CreateInvitationResult | RevokeInvitationResult> {
    switch (request.kind) {
      case "invite":
        // No lifetime: the API's default applies.
        return bridge.create(request.workspaceId, request.memberId);
      case "revoke":
        return bridge.revoke(request.workspaceId, request.invitationId);
    }
  }

  return Object.freeze({
    start: (request: InvitationActionRequest) => {
      if (running || code !== undefined) {
        return;
      }
      question = request;
      show();
    },
    confirm: () => {
      const open = question;
      if (running || open === undefined) {
        return Promise.resolve(false);
      }
      return run(open, () => send(open));
    },
    cancel: () => {
      if (question !== undefined) {
        question = undefined;
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
      // A refresh ends the sentence of a create whose code was not shown,
      // also before its workspace is shown again.
      unseenIn = undefined;
      const startSelection = selection;
      let sentence: string;
      let loading = false;
      try {
        const result = await list.load();
        loading = result.outcome === "loading";
        sentence =
          result.outcome === "loading"
            ? INVITATION_REFRESH_MESSAGES.loading
            : INVITATION_REFRESH_MESSAGES[result.reason];
      } catch {
        sentence = INVITATION_REFRESH_MESSAGES.failed;
      }
      // An action that started meanwhile has its own sentence.
      if (selection === startSelection && !running) {
        message = sentence;
        refreshedAt = loading ? (latest?.revision ?? -1) : undefined;
        show();
      }
    },
    listChanged: (
      people: PeopleScreenView,
      invitations: InvitationsScreenView,
      now: number,
    ) => {
      latestNow = now;
      let changed = false;
      if (invitations.kind === "known") {
        latest = invitations.state;
        if (
          refreshedAt !== undefined &&
          invitations.state.revision > refreshedAt
        ) {
          refreshedAt = undefined;
          if (message === INVITATION_REFRESH_MESSAGES.loading) {
            message = undefined;
            changed = true;
          }
        }
      }
      if (
        question !== undefined &&
        !isInvitationOffered(
          describeInvitations(people, invitations, now),
          question,
        )
      ) {
        question = undefined;
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
            question !== undefined ||
            message !== undefined ||
            code !== undefined;
          question = undefined;
          message = undefined;
          code = undefined;
          refreshedAt = undefined;
          unseenIn = undefined;
        } else {
          signedOut = false;
          selected = state.workspaceId;
          if (before !== undefined && before !== selected) {
            selection += 1;
            question = undefined;
            message = undefined;
            code = undefined;
            refreshedAt = undefined;
            if (unseenIn !== undefined && unseenIn === selected) {
              // The workspace of a create whose code was dropped is shown
              // again; only it says so.
              message = INVITATION_CREATED_UNSEEN_MESSAGE;
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
          invitations.kind === "known" ? invitations.state : undefined,
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
