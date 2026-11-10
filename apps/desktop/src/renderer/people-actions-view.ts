import type { PeopleActionsBridge } from "../shared/desktop-bridge.ts";
import type {
  DefinePersonResult,
  PeopleView,
  PersonActionRefusal,
  PersonActionResult,
  PersonView,
} from "../shared/ipc-contract.ts";
import { MAX_CLOCK_WAIT_MS } from "./device-view.ts";
import type { PeopleScreenView } from "./people-view.ts";

/**
 * The longest display name in characters (Unicode code points), as the
 * contract and the protocol count it (`PEOPLE_LIMITS.displayName`; zod's
 * `.max` counts a string's code points). The renderer imports no value of
 * the contract, so the tests check that the two match.
 */
export const MAX_PERSON_NAME_LENGTH = 64;

/** The people actions of the people screen (#95), one per bridge function. */
export type PeopleActionKind =
  | "define"
  | "rename"
  | "remove"
  | "promote"
  | "demote"
  | "offer"
  | "withdraw"
  | "accept"
  | "leave";

/**
 * An action that the screen offers, with what it needs: the selected
 * workspace's ID when the screen showed it, and the person's member ID and
 * display name for an action on a person. The IDs go only to the bridge;
 * the screen never shows them.
 */
export type PeopleActionRequest =
  | {
      readonly kind: "rename" | "promote" | "demote" | "offer";
      readonly workspaceId: string;
      readonly memberId: string;
      readonly name: string;
    }
  | {
      readonly kind: "remove";
      readonly workspaceId: string;
      readonly memberId: string;
      readonly name: string;
      /** Whether an account claimed the person; it changes the question. */
      readonly claimed: boolean;
    }
  | {
      readonly kind: "withdraw" | "accept" | "leave";
      readonly workspaceId: string;
      /** The workspace's name, for the question; null without one. */
      readonly workspaceName: string | null;
    };

/**
 * The actions that ask first: every destructive one and every role change
 * except a promotion (remove, make member, offer and accept the ownership,
 * leave), and a rename, which asks for the new name. A promotion, a
 * withdrawal of the offer, and a definition run at once.
 */
export const ASKING_ACTIONS: ReadonlySet<PeopleActionKind> = new Set([
  "rename",
  "remove",
  "demote",
  "offer",
  "accept",
  "leave",
]);

/** The labels of the people actions' buttons. */
export const PEOPLE_ACTION_LABELS: Readonly<Record<PeopleActionKind, string>> =
  Object.freeze({
    define: "Add person",
    rename: "Rename",
    remove: "Remove",
    promote: "Make admin",
    demote: "Make member",
    offer: "Offer ownership",
    withdraw: "Withdraw the offer",
    accept: "Accept the ownership",
    leave: "Leave this workspace",
  });

/** The other fixed texts of the people actions. */
export const PEOPLE_ACTION_MESSAGES = Object.freeze({
  defineTitle: "Add a person",
  defineHint:
    "Add someone by name before they join. They show as not claimed until they accept an invitation for this person.",
  nameLabel: "Name",
  cancel: "Cancel",
  /** Before a definition or a rename without a name. */
  nameMissing: "Enter a name.",
  /** Before a definition or a rename with a longer name. */
  nameTooLong: `A name has at most ${String(MAX_PERSON_NAME_LENGTH)} characters.`,
  /** To the owner, beside the live offer; the target's name follows. */
  offerMade: "Ownership offered to ",
  /** To the owner, when the target is not among the people shown. */
  offerMadeUnlisted: "Ownership offered to a person who is not shown here",
  /** To the target of the live offer. */
  offerReceived: "You are offered the ownership of this workspace",
  /** Before the end of the offer. */
  offerUntil: " until ",
});

/** The question of an action that asks first. */
export interface PeopleActionQuestion {
  readonly title: string;
  readonly text: string;
  /** The confirming button. */
  readonly confirm: string;
  /**
   * The person's or the workspace's name, shown as text below the title, or
   * null.
   */
  readonly name: string | null;
}

/**
 * The question of each action that asks first (`ASKING_ACTIONS`), or
 * undefined for a promotion and a withdrawal, which never ask.
 */
export function describePeopleActionQuestion(
  request: PeopleActionRequest,
): PeopleActionQuestion | undefined {
  switch (request.kind) {
    case "rename":
      return {
        title: "Rename this person",
        text: "Enter the new name. Everyone in the workspace sees it.",
        confirm: "Save",
        name: request.name,
      };
    case "remove":
      return request.claimed
        ? {
            title: "Remove this person?",
            text: "They lose access to the workspace at once. Their agents in its projects are disabled, the permissions on them are revoked, their unfinished runs are cancelled, and the invitations that they created and that are still open are revoked. Their messages stay, and they are listed as a former member. To come back, they need a new invitation or join request.",
            confirm: "Remove",
            name: request.name,
          }
        : {
            title: "Remove this unclaimed person?",
            text: "Their invitation, if there is one, stops working, and nobody can claim this person any more. They are listed as a former member.",
            confirm: "Remove",
            name: request.name,
          };
    case "demote":
      return {
        title: "Make this admin a member?",
        text: "They can no longer manage the workspace's people, and the invitations that they created and that are still open are revoked.",
        confirm: "Make member",
        name: request.name,
      };
    case "offer":
      return {
        title: "Offer the ownership to this person?",
        text: "If they accept within 7 days, they become the owner and you become an admin. You can withdraw the offer until then.",
        confirm: "Offer ownership",
        name: request.name,
      };
    case "accept":
      return {
        title: "Accept the ownership of this workspace?",
        text: "You become the owner, and the current owner becomes an admin.",
        confirm: "Accept the ownership",
        name: request.workspaceName,
      };
    case "leave":
      return {
        title: "Leave this workspace?",
        text: "You lose access to the workspace and its projects at once. Your agents in its projects are disabled, the permissions on them are revoked, your unfinished runs are cancelled, and the invitations that you created and that are still open are revoked. To come back, you need a new invitation or join request.",
        confirm: "Leave",
        name: request.workspaceName,
      };
    case "promote":
    case "withdraw":
      return undefined;
  }
}

/** The live ownership offer as the screen shows it. */
export type OwnershipOfferRow =
  /** To the owner, who made it: the target's name, or null when not shown. */
  | {
      readonly kind: "made";
      readonly targetName: string | null;
      readonly expiresAt: string;
      readonly withdraw: PeopleActionRequest;
    }
  /** To its target, who may accept it. */
  | {
      readonly kind: "received";
      readonly expiresAt: string;
      readonly accept: PeopleActionRequest;
    };

/** What the screen offers of the people actions. */
export interface PeopleActionsModel {
  /** The selected workspace's ID for a definition, or null without one. */
  readonly defineIn: string | null;
  /** The actions on each active person, by member ID, in the order of their buttons. */
  readonly personActions: ReadonlyMap<string, readonly PeopleActionRequest[]>;
  /** The live ownership offer, for the owner and its target only, or null. */
  readonly offer: OwnershipOfferRow | null;
  /** The leave of the account's own person, or null for the owner. */
  readonly leave: PeopleActionRequest | null;
}

const NO_ACTIONS: PeopleActionsModel = Object.freeze({
  defineIn: null,
  personActions: new Map<string, readonly PeopleActionRequest[]>(),
  offer: null,
  leave: null,
});

/**
 * Whether the offer is still live by the clock `now` in milliseconds: its
 * end is later than now. The main process drops an expired offer at the
 * next reload; the screen hides it at once.
 */
export function offerIsLive(expiresAt: string, now: number): boolean {
  const end = Date.parse(expiresAt);
  return !Number.isNaN(end) && end > now;
}

/**
 * The actions on one active person other than the account's own, by the
 * roles table of ADR 0014 ("People and roles"). The owner and the admins
 * rename and remove an unclaimed person; the owner removes any other
 * claimed person, an admin only a claimed member. Only the owner promotes
 * a claimed member, demotes an admin, and offers the ownership to a
 * claimed person, while no offer is live. The server enforces the table;
 * the screen offers only what it allows.
 */
function actionsOn(
  own: PersonView,
  person: PersonView,
  workspaceId: string,
  offerLive: boolean,
): PeopleActionRequest[] {
  const owner = own.role === "owner";
  const manager = owner || own.role === "admin";
  const target = {
    workspaceId,
    memberId: person.memberId,
    name: person.displayName,
  };
  const requests: PeopleActionRequest[] = [];
  if (manager && !person.claimed) {
    requests.push({ kind: "rename", ...target });
  }
  if (owner && person.claimed && person.role === "member") {
    requests.push({ kind: "promote", ...target });
  }
  if (owner && person.role === "admin") {
    requests.push({ kind: "demote", ...target });
  }
  if (owner && person.claimed && !offerLive) {
    requests.push({ kind: "offer", ...target });
  }
  const removable = person.claimed
    ? owner || (manager && person.role === "member")
    : manager;
  if (removable) {
    requests.push({ kind: "remove", ...target, claimed: person.claimed });
  }
  return requests;
}

/**
 * What the screen offers of the people actions by the clock `now`, only
 * while the people are `ready` and the account's own active person is
 * listed:
 *
 * - to the owner and the admins, the definition of a person and the
 *   actions on the other people (`actionsOn`);
 * - to the owner, the live offer with its withdrawal;
 * - to the offer's target, the offer with its acceptance, until it
 *   expires;
 * - to the admins and the members, the leave; the owner cannot leave.
 */
export function describePeopleActions(
  view: PeopleScreenView,
  now: number,
): PeopleActionsModel {
  if (view.kind !== "known" || view.state.status !== "ready") {
    return NO_ACTIONS;
  }
  const { state } = view;
  const { workspaceId, ownershipOffer } = state;
  const active = state.people.filter((person) => !person.former);
  const own = active.find((person) => person.memberId === state.ownMemberId);
  if (workspaceId === null || own === undefined) {
    return NO_ACTIONS;
  }
  const manager = own.role === "owner" || own.role === "admin";
  const offerLive =
    ownershipOffer !== null && offerIsLive(ownershipOffer.expiresAt, now);
  const personActions = new Map<string, readonly PeopleActionRequest[]>();
  for (const person of active) {
    if (person !== own) {
      const requests = actionsOn(own, person, workspaceId, offerLive);
      if (requests.length > 0) {
        personActions.set(person.memberId, requests);
      }
    }
  }
  const workspace = { workspaceId, workspaceName: state.workspaceName };
  let offer: OwnershipOfferRow | null = null;
  if (ownershipOffer !== null && offerLive) {
    if (own.role === "owner") {
      offer = {
        kind: "made",
        targetName:
          active.find((person) => person.memberId === ownershipOffer.memberId)
            ?.displayName ?? null,
        expiresAt: ownershipOffer.expiresAt,
        withdraw: { kind: "withdraw", ...workspace },
      };
    } else if (ownershipOffer.memberId === own.memberId) {
      offer = {
        kind: "received",
        expiresAt: ownershipOffer.expiresAt,
        accept: { kind: "accept", ...workspace },
      };
    }
  }
  return {
    defineIn: manager ? workspaceId : null,
    personActions,
    offer,
    leave: own.role === "owner" ? null : { kind: "leave", ...workspace },
  };
}

/**
 * Whether the screen still offers `request` as it is: the same action on
 * the same person in the same workspace, with the same name, and for a
 * removal the same claim. A question whose action went away or changed,
 * for example with the person, a claim, a new name, or an offer that
 * expired, closes, so that it never shows a text that is no longer true.
 */
export function isOffered(
  model: PeopleActionsModel,
  request: PeopleActionRequest,
): boolean {
  const fields = Object.entries(request);
  const same = (other: PeopleActionRequest | null | undefined) =>
    other !== null &&
    other !== undefined &&
    fields.every(
      ([key, value]) => (other as Record<string, unknown>)[key] === value,
    );
  switch (request.kind) {
    case "leave":
      return same(model.leave);
    case "withdraw":
      return model.offer?.kind === "made" && same(model.offer.withdraw);
    case "accept":
      return model.offer?.kind === "received" && same(model.offer.accept);
    default:
      // The map holds the person's actions by its member ID.
      return (model.personActions.get(request.memberId) ?? []).some(same);
  }
}

/**
 * The next time after `now`, in milliseconds, at which the screen offers
 * something else by the clock alone: the end of the live offer. Undefined
 * when nothing changes.
 */
export function nextPeopleActionsChange(
  view: PeopleScreenView,
  now: number,
): number | undefined {
  if (view.kind !== "known" || view.state.ownershipOffer === null) {
    return undefined;
  }
  const end = Date.parse(view.state.ownershipOffer.expiresAt);
  return Number.isNaN(end) || end <= now ? undefined : end;
}

/**
 * How long to wait, in milliseconds, from `now` until the clock is read
 * again at `at`: never less than 0, and at most `MAX_CLOCK_WAIT_MS`, the
 * longest delay of one timer.
 */
export function clockDelay(at: number, now: number): number {
  return Math.min(Math.max(at - now, 0), MAX_CLOCK_WAIT_MS);
}

/** The part of the window and the document that the clock listens to. */
export type ClockEventTarget = Pick<
  EventTarget,
  "addEventListener" | "removeEventListener"
>;

/**
 * Calls `onRead` when the window gets the focus or the document's
 * visibility changes, because a timer can fire late after the computer
 * slept. Returns the function that stops it.
 */
export function watchClockReads(
  win: ClockEventTarget,
  doc: ClockEventTarget,
  onRead: () => void,
): () => void {
  const read = () => onRead();
  win.addEventListener("focus", read);
  doc.addEventListener("visibilitychange", read);
  return () => {
    win.removeEventListener("focus", read);
    doc.removeEventListener("visibilitychange", read);
  };
}

/**
 * Whether the focus moves to the screen's title as the question ends: it
 * was open, it is closed now, and the button that opened it left the page,
 * so the dialog cannot give the focus back to it.
 */
export function focusesTitleAfterClose(
  wasOpen: boolean,
  isOpen: boolean,
  triggerGone: boolean,
): boolean {
  return wasOpen && !isOpen && triggerGone;
}

/** The sentence after an action that the API confirmed. */
export const PEOPLE_ACTION_DONE_MESSAGES: Readonly<
  Record<PeopleActionKind, string>
> = Object.freeze({
  define: "The person was added.",
  rename: "The name was changed.",
  remove: "The person was removed.",
  promote: "The person is now an admin.",
  demote: "The admin is now a member.",
  offer: "The ownership was offered. The person can accept it within 7 days.",
  withdraw: "The ownership offer was withdrawn.",
  accept: "You are now the owner of this workspace.",
  leave: "You left the workspace.",
});

/** The start of the sentence after an action that did not happen. */
export const PEOPLE_ACTION_NOT_DONE_MESSAGES: Readonly<
  Record<PeopleActionKind, string>
> = Object.freeze({
  define: "The person could not be added.",
  rename: "The name could not be changed.",
  remove: "The person could not be removed.",
  promote: "The person could not be made an admin.",
  demote: "The admin could not be made a member.",
  offer: "The ownership could not be offered.",
  withdraw: "The ownership offer could not be withdrawn.",
  accept: "The ownership could not be accepted.",
  leave: "You could not leave the workspace.",
});

/**
 * The sentence after an answer that does not show whether the API acted
 * (`unknown`). The request is never sent again on its own; the person
 * checks the list.
 */
export const PEOPLE_ACTION_UNKNOWN_MESSAGES: Readonly<
  Record<PeopleActionKind, string>
> = Object.freeze({
  define:
    "It is not known whether the person was added. Check the list of people before you add them again; the request is not sent again on its own.",
  rename:
    "It is not known whether the name was changed. Check the list of people; the request is not sent again on its own.",
  remove:
    "It is not known whether the person was removed. Check the list of people; the request is not sent again on its own.",
  promote:
    "It is not known whether the person was made an admin. Check the list of people; the request is not sent again on its own.",
  demote:
    "It is not known whether the admin was made a member. Check the list of people; the request is not sent again on its own.",
  offer:
    "It is not known whether the ownership was offered. Check the offer on this screen; the request is not sent again on its own.",
  withdraw:
    "It is not known whether the ownership offer was withdrawn. Check the offer on this screen; the request is not sent again on its own.",
  accept:
    "It is not known whether you accepted the ownership. Check your role in the list of people; the request is not sent again on its own.",
  leave:
    "It is not known whether you left the workspace. Check the list of workspaces; the request is not sent again on its own.",
});

/**
 * Why an action was refused, after its start. `invalid` for a definition or
 * a rename says that the name is not allowed; `too_soon` and `rate_limited`
 * say how long to wait (`describeWait`).
 */
export const PEOPLE_ACTION_REFUSAL_MESSAGES: Readonly<
  Record<Exclude<PersonActionRefusal, "too_soon" | "rate_limited">, string>
> & {
  readonly invalidName: string;
  readonly tooSoon: (wait: string) => string;
  readonly rateLimited: (wait: string) => string;
  readonly unclaimedLimit: (limit: number) => string;
} = Object.freeze({
  invalid: "The request was not valid.",
  invalidName:
    "The name is not allowed. Use visible characters, without line breaks.",
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
  unclaimedLimit: (limit: number) =>
    `The workspace already has as many unclaimed people as it allows (${String(limit)}). Remove one, or wait until someone claims one, then try again.`,
  not_allowed: "Your role in this workspace does not allow it.",
  not_found:
    "The server does not know this workspace or this person for your account. Check the list.",
  conflict:
    "The person or the ownership offer has changed in the meantime. Check the list.",
  device_too_new:
    "Promoting an admin and offering the ownership need a device that was registered at least 72 hours ago. Use an older device, or try again later.",
  failed: "The server refused it.",
});

/** The end of the sentence after a call that failed on its way; nothing was sent. */
export const PEOPLE_ACTION_NOT_SENT = "It was not sent. Try again.";

/**
 * A wait of `ms` milliseconds in words, rounded up: seconds below a
 * minute, minutes below an hour, and hours above.
 */
export function describeWait(ms: number): string {
  const count = (value: number, unit: string) =>
    `${String(value)} ${unit}${value === 1 ? "" : "s"}`;
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) {
    return count(seconds, "second");
  }
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return count(minutes, "minute");
  }
  return count(Math.ceil(minutes / 60), "hour");
}

/**
 * Whether the workspace holds as many active unclaimed people as its limit
 * (`maxUnclaimedMembers`, for the owner and the admins). Without a limit
 * the screen cannot tell. With people left out, the count is the least
 * that the workspace holds, so a count at the limit still shows it.
 */
export function unclaimedLimitReached(state: PeopleView | undefined): boolean {
  if (state === undefined || state.maxUnclaimedMembers === null) {
    return false;
  }
  const unclaimed = state.people.filter(
    (person) => !person.former && !person.claimed,
  ).length;
  return unclaimed >= state.maxUnclaimedMembers;
}

/**
 * The sentence after a result of `kind`. A definition's `rate_limited` can
 * also mean the limit of unclaimed people: when `state`, the latest people,
 * shows that the limit is reached, the sentence says so; otherwise it says
 * to wait, as for the other actions.
 */
export function describePeopleActionResult(
  kind: PeopleActionKind,
  result: PersonActionResult | DefinePersonResult,
  state: PeopleView | undefined,
): string {
  switch (result.outcome) {
    case "ok":
      return PEOPLE_ACTION_DONE_MESSAGES[kind];
    case "unknown":
      return PEOPLE_ACTION_UNKNOWN_MESSAGES[kind];
    case "refused":
      return `${PEOPLE_ACTION_NOT_DONE_MESSAGES[kind]} ${refusalText(kind, result.reason, result.retryAfterMs, state)}`;
  }
}

function refusalText(
  kind: PeopleActionKind,
  reason: PersonActionRefusal,
  retryAfterMs: number | null,
  state: PeopleView | undefined,
): string {
  const messages = PEOPLE_ACTION_REFUSAL_MESSAGES;
  const wait = describeWait(retryAfterMs ?? 0);
  switch (reason) {
    case "invalid":
      return kind === "define" || kind === "rename"
        ? messages.invalidName
        : messages.invalid;
    case "too_soon":
      return messages.tooSoon(wait);
    case "rate_limited":
      return kind === "define" &&
        state !== undefined &&
        state.maxUnclaimedMembers !== null &&
        unclaimedLimitReached(state)
        ? messages.unclaimedLimit(state.maxUnclaimedMembers)
        : messages.rateLimited(wait);
    default:
      return messages[reason];
  }
}

/**
 * The problem of a name before it is sent, or undefined: none after
 * trimming, or longer than the limit in characters (code points), as the
 * contract counts it. The main process refuses both, and the call rejects
 * for an empty or a longer one. A character takes one or two UTF-16 code
 * units, so the characters are counted only when the name is longer in
 * code units.
 */
export function namePrompt(name: string): string | undefined {
  if (name === "") {
    return PEOPLE_ACTION_MESSAGES.nameMissing;
  }
  return name.length > MAX_PERSON_NAME_LENGTH &&
    Array.from(name).length > MAX_PERSON_NAME_LENGTH
    ? PEOPLE_ACTION_MESSAGES.nameTooLong
    : undefined;
}

/** The open question of an action that asks first. */
export interface PeopleActionDialog {
  readonly request: PeopleActionRequest;
  /** The name in the field of a rename; empty for the other actions. */
  readonly draft: string;
  /** Why the name of a rename was not sent, or undefined. */
  readonly problem: string | undefined;
}

/** What the screen shows of its people actions. */
export interface PeopleActionsView {
  /**
   * True while an action runs: every action's control stays focusable and
   * does nothing (`aria-disabled`), so that only one runs at a time.
   */
  readonly running: boolean;
  /** A fixed sentence about the last action, or undefined. */
  readonly message: string | undefined;
  /** The open question, or undefined. */
  readonly dialog: PeopleActionDialog | undefined;
  /** The name in the field of a definition. */
  readonly defineDraft: string;
  /**
   * Why the name of the definition was not sent, or undefined. It shows
   * with the field, apart from the results in the status paragraph.
   */
  readonly defineProblem: string | undefined;
}

export const IDLE_PEOPLE_ACTIONS: PeopleActionsView = Object.freeze({
  running: false,
  message: undefined,
  dialog: undefined,
  defineDraft: "",
  defineProblem: undefined,
});

/**
 * The actions after which the action's control leaves the page with the
 * next people, once the API confirmed them: the person, the role's button,
 * or the offer's line goes away. A rename and a definition keep theirs.
 * Only a leave's control also goes with its workspace, so only a leave
 * counts after a switch (`run`); an acceptance's line goes because the
 * offer ends, and after a switch it is not this screen's any more.
 */
const LEAVING_ACTIONS: ReadonlySet<PeopleActionKind> = new Set([
  "remove",
  "promote",
  "demote",
  "offer",
  "withdraw",
  "accept",
  "leave",
]);

export interface PeopleActions {
  /**
   * Starts an action that the screen offers: an action that asks first
   * opens its question, and a promotion or a withdrawal runs at once. While
   * an action runs, nothing starts. Resolves to true when the action ran
   * and its control leaves the page with the next people.
   */
  readonly start: (request: PeopleActionRequest) => Promise<boolean>;
  /**
   * Runs the action of the open question; a rename first checks its name
   * and keeps the question open with the problem. Resolves like `start`.
   */
  readonly confirm: () => Promise<boolean>;
  /** Closes the open question without the action. */
  readonly cancel: () => void;
  /** Changes the name in the field of an open rename, and ends its problem. */
  readonly editDialogDraft: (text: string) => void;
  /** Changes the name in the field of a definition, and ends its problem. */
  readonly editDefineDraft: (text: string) => void;
  /**
   * Defines a person in `workspaceId` with the trimmed name of the field,
   * once it passes `namePrompt`, and keeps the problem otherwise; empties
   * the field once the API confirmed it. Resolves to false.
   */
  readonly define: (workspaceId: string) => Promise<boolean>;
  /**
   * Follows the screen's view by the renderer's clock `now`:
   *
   * - the open question ends once the screen no longer offers it as it is
   *   (`isOffered`), so that it never comes back on its own and a later
   *   `confirm` sends nothing;
   * - the question, the field of a definition, and the sentence of the
   *   last action belong to the workspace that they were about, so they go
   *   when another workspace or none is selected, and always with a
   *   sign-out; the sentence of a confirmed leave stays through the switch
   *   that the leave brings.
   */
  readonly listChanged: (view: PeopleScreenView, now: number) => void;
}

/**
 * The people actions of the screen: one action at a time, each sent once.
 * The result is a fixed sentence; the people change only with the view
 * that the main process sends once the API's event arrives, never from the
 * answer.
 */
export function createPeopleActions(
  bridge: PeopleActionsBridge,
  onView: (view: PeopleActionsView) => void,
): PeopleActions {
  let running = false;
  let message: string | undefined;
  let dialog: PeopleActionDialog | undefined;
  let defineDraft = "";
  let defineProblem: string | undefined;
  /** The latest people, for the limit of unclaimed people. */
  let latest: PeopleView | undefined;
  /** The selected workspace of the latest view; undefined before one. */
  let selected: string | null | undefined;
  /**
   * Grows with every switch of the selected workspace, a drop of it, and a
   * sign-out, so that an answer counts for its workspace only when nothing
   * of the kind happened while it was on its way, also a switch away and
   * back.
   */
  let selection = 0;
  /** Grows with every sign-out, so that nothing outlives the account's session. */
  let session = 0;
  /** Whether the latest view is `signed_out`, so that a session ends once. */
  let signedOut = false;
  /** Whether the sentence of a confirmed leave stays through the next switch. */
  let keepThroughSwitch = false;
  const show = () =>
    onView(
      Object.freeze({ running, message, dialog, defineDraft, defineProblem }),
    );

  /**
   * Runs an action on `workspaceId` and says how it went, but only while
   * that workspace has stayed selected since the action started: an answer
   * that arrives after a switch, also one away and back, or after a
   * sign-out, shows no sentence, moves no focus, and leaves a name typed
   * since then alone.
   *
   * A confirmed leave is apart, because its membership event can switch
   * the workspace before its answer arrives: it keeps its sentence while
   * the same session is signed in, and in that session it resolves to true,
   * because its control goes with its workspace in any case; after a
   * sign-out it moves no focus either. Its sentence stays through
   * the next switch only while nothing switched yet, because that switch is
   * the one that the leave brings.
   */
  async function run(
    kind: PeopleActionKind,
    workspaceId: string,
    call: () => Promise<PersonActionResult | DefinePersonResult>,
  ): Promise<boolean> {
    running = true;
    message = undefined;
    dialog = undefined;
    keepThroughSwitch = false;
    show();
    const startSelection = selection;
    const startSession = session;
    let ok = false;
    let sentence: string;
    try {
      const result = await call();
      ok = result.outcome === "ok";
      // The sentence shows only while the action's workspace is still
      // selected, so the latest people are that workspace's, with its limit
      // of unclaimed people, or none while it is not known.
      sentence = describePeopleActionResult(kind, result, latest);
    } catch {
      sentence = `${PEOPLE_ACTION_NOT_DONE_MESSAGES[kind]} ${PEOPLE_ACTION_NOT_SENT}`;
    }
    const still = selection === startSelection && selected === workspaceId;
    const left =
      // A sign-out starts a new session, so no sentence outlives it.
      ok && kind === "leave" && session === startSession;
    if (still || left) {
      message = sentence;
    }
    if (still && ok && kind === "define") {
      defineDraft = "";
    }
    keepThroughSwitch = still && left;
    running = false;
    show();
    return left || (still && ok && LEAVING_ACTIONS.has(kind));
  }

  function send(
    request: PeopleActionRequest,
    displayName: string,
  ): Promise<PersonActionResult> {
    switch (request.kind) {
      case "rename":
        return bridge.rename(
          request.workspaceId,
          request.memberId,
          displayName,
        );
      case "remove":
        return bridge.remove(request.workspaceId, request.memberId);
      case "promote":
        return bridge.promote(request.workspaceId, request.memberId);
      case "demote":
        return bridge.demote(request.workspaceId, request.memberId);
      case "offer":
        return bridge.offerOwnership(request.workspaceId, request.memberId);
      case "withdraw":
        return bridge.withdrawOwnershipOffer(request.workspaceId);
      case "accept":
        return bridge.acceptOwnershipOffer(request.workspaceId);
      case "leave":
        return bridge.leave(request.workspaceId);
    }
  }

  return Object.freeze({
    start: (request: PeopleActionRequest) => {
      if (running) {
        return Promise.resolve(false);
      }
      if (ASKING_ACTIONS.has(request.kind)) {
        dialog = Object.freeze({
          request,
          draft: request.kind === "rename" ? request.name : "",
          problem: undefined,
        });
        show();
        return Promise.resolve(false);
      }
      return run(request.kind, request.workspaceId, () => send(request, ""));
    },
    confirm: () => {
      const open = dialog;
      if (running || open === undefined) {
        return Promise.resolve(false);
      }
      const name = open.draft.trim();
      if (open.request.kind === "rename") {
        const problem = namePrompt(name);
        if (problem !== undefined) {
          dialog = Object.freeze({ ...open, problem });
          show();
          return Promise.resolve(false);
        }
      }
      return run(open.request.kind, open.request.workspaceId, () =>
        send(open.request, name),
      );
    },
    cancel: () => {
      if (dialog !== undefined) {
        dialog = undefined;
        show();
      }
    },
    editDialogDraft: (text: string) => {
      if (dialog !== undefined) {
        // The problem was about the name as it was.
        dialog = Object.freeze({ ...dialog, draft: text, problem: undefined });
        show();
      }
    },
    editDefineDraft: (text: string) => {
      defineDraft = text;
      defineProblem = undefined;
      show();
    },
    define: async (workspaceId: string) => {
      if (running) {
        return false;
      }
      const name = defineDraft.trim();
      defineProblem = namePrompt(name);
      if (defineProblem !== undefined) {
        show();
        return false;
      }
      await run("define", workspaceId, () => bridge.define(workspaceId, name));
      return false;
    },
    listChanged: (view: PeopleScreenView, now: number) => {
      let changed = false;
      if (
        dialog !== undefined &&
        !isOffered(describePeopleActions(view, now), dialog.request)
      ) {
        dialog = undefined;
        changed = true;
      }
      if (view.kind === "known") {
        const { state } = view;
        latest = state;
        const before = selected;
        if (state.status === "signed_out") {
          // A sign-out ends everything, also after no workspace was selected.
          if (!signedOut) {
            signedOut = true;
            session += 1;
            selection += 1;
          }
          selected = null;
          changed ||=
            dialog !== undefined ||
            message !== undefined ||
            defineDraft !== "" ||
            defineProblem !== undefined;
          dialog = undefined;
          message = undefined;
          keepThroughSwitch = false;
          defineDraft = "";
          defineProblem = undefined;
        } else {
          signedOut = false;
          selected = state.workspaceId;
          if (before !== undefined && before !== selected) {
            selection += 1;
            dialog = undefined;
            defineDraft = "";
            defineProblem = undefined;
            if (!keepThroughSwitch) {
              message = undefined;
            }
            keepThroughSwitch = false;
            changed = true;
          }
        }
      }
      if (changed) {
        show();
      }
    },
  });
}

/** The options of `offerTimeFormat`; the tests fix them. */
export interface OfferTimeFormatOptions {
  /** Defaults to the person's locale. */
  readonly locale?: string;
  /** An IANA time zone such as "Europe/Istanbul"; defaults to the system's. */
  readonly timeZone?: string;
}

/**
 * The format of the end of the ownership offer: the date and the time, for
 * example "Nov 6, 2026, 9:30 AM", in the person's locale and time zone.
 */
export function offerTimeFormat(
  options: OfferTimeFormatOptions = {},
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: options.timeZone,
  });
}
