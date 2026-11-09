import type { PeopleBridge } from "../shared/desktop-bridge.ts";
import type {
  PeopleView,
  PersonRoleView,
  PersonView,
  WorkspaceProblem,
} from "../shared/ipc-contract.ts";

/** What the people screen knows about the selected workspace's people. */
export type PeopleScreenView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first people. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly state: PeopleView };

export function initialPeopleScreenView(
  bridgeAvailable: boolean,
): PeopleScreenView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

/**
 * Subscribes to the people and reports every state as the view; a refused
 * subscription makes the view unavailable. Returns the function that ends
 * the subscription.
 */
export function followPeople(
  people: Pick<PeopleBridge, "subscribeState">,
  onView: (view: PeopleScreenView) => void,
): () => void {
  return people.subscribeState(
    (state) => onView({ kind: "known", state }),
    () => onView({ kind: "unavailable" }),
  );
}

/** The fixed texts of the people screen. */
export const PEOPLE_MESSAGES = Object.freeze({
  unavailable: "People are not available.",
  pending: "Checking the people.",
  signedOut: "People appear once this device is signed in and ready.",
  noWorkspace: "Select a workspace to see its people.",
  loading: "Loading the people.",
  noPeople: "No people yet.",
  /** After the display name of the account's own person. */
  you: "(you)",
  /** A person whom no account has claimed yet. */
  unclaimed: "Not claimed yet",
  /** A claimed former member whose account's data was erased. */
  noLogin: "No GitHub login",
  /**
   * To the owner only, while no active person is an admin (#95: "encourage
   * at least one admin besides the owner").
   */
  adminHint:
    "Only you can manage this workspace. Consider making a person you trust an admin, so that someone else can also invite people and answer join requests.",
  /** What the screen does not offer yet. */
  actionsLater:
    "Inviting people, answering join requests, and changing people and roles will be added here.",
});

/**
 * Why the people are `unavailable`: the failure of the last load of the
 * workspaces. What was loaded before stays shown, and the main process
 * loads again by itself.
 */
export const PEOPLE_PROBLEM_MESSAGES: Readonly<
  Record<WorkspaceProblem, string>
> = Object.freeze({
  not_signed_in: "The server did not accept this device's sign-in.",
  not_found: "The server did not find the selected workspace.",
  rate_limited: "The server asked to wait. Trying again in a minute.",
  unavailable: "The server could not be reached. Trying again later.",
  failed: "The people could not be loaded. Trying again later.",
});

/** The text of each role. */
export const ROLE_LABELS: Readonly<Record<PersonRoleView, string>> =
  Object.freeze({
    owner: "Owner",
    admin: "Admin",
    member: "Member",
  });

/** A person as the screen shows it. */
export interface PersonRow {
  readonly memberId: string;
  readonly displayName: string;
  /** The role's text; null for a former member, whose role ended. */
  readonly role: string | null;
  /** Whether this is the account's own person. */
  readonly you: boolean;
  /** The GitHub login and when it was last verified, or null. */
  readonly github: {
    readonly login: string;
    readonly verifiedAt: string;
  } | null;
  /** What shows instead of a login: unclaimed, or no login; null with one. */
  readonly note: string | null;
}

/** What the screen lists, in the order of the main process. */
export interface PeopleLists {
  readonly active: readonly PersonRow[];
  readonly former: readonly PersonRow[];
  /** How many people the main process left out. */
  readonly morePeople: number;
}

export interface PeopleScreenModel {
  /** The text of the screen's status paragraph; empty when there is none. */
  readonly status: string;
  /** The people, or null when there is nothing to list. */
  readonly lists: PeopleLists | null;
  /** Whether the screen shows the hint to make someone an admin. */
  readonly adminHint: boolean;
}

function personRow(person: PersonView, ownMemberId: string | null): PersonRow {
  const github =
    person.login === null || person.verifiedAt === null
      ? null
      : { login: person.login, verifiedAt: person.verifiedAt };
  return {
    memberId: person.memberId,
    displayName: person.displayName,
    role: person.former ? null : ROLE_LABELS[person.role],
    you: person.memberId === ownMemberId,
    github,
    note:
      github !== null
        ? null
        : person.claimed
          ? PEOPLE_MESSAGES.noLogin
          : PEOPLE_MESSAGES.unclaimed,
  };
}

/**
 * Whether the owner sees the hint to make someone an admin: the account's
 * own person is the active owner, and no active person is an admin. With
 * people left out, the screen cannot know, so it shows no hint.
 */
function needsAdmin(state: PeopleView): boolean {
  if (state.morePeople > 0) {
    return false;
  }
  const active = state.people.filter((person) => !person.former);
  const own = active.find((person) => person.memberId === state.ownMemberId);
  return (
    own?.role === "owner" && !active.some((person) => person.role === "admin")
  );
}

function listsOf(state: PeopleView): PeopleLists {
  return {
    active: state.people
      .filter((person) => !person.former)
      .map((person) => personRow(person, state.ownMemberId)),
    former: state.people
      .filter((person) => person.former)
      .map((person) => personRow(person, state.ownMemberId)),
    morePeople: state.morePeople,
  };
}

const NOTHING_LISTED = { lists: null, adminHint: false } as const;

/**
 * What the people screen shows:
 *
 * - a fixed text without the bridge, before the first state, while no
 *   device is signed in and ready, while no workspace is selected, and
 *   while the people load;
 * - when `ready`, the active people and then the former members, in the
 *   main process's order, with "No people yet." when no person is active;
 * - when `unavailable`, the problem as a fixed text, with what was loaded
 *   before. Without any of it, only the problem shows, because an empty
 *   list would claim what was never loaded.
 *
 * The hint to make someone an admin shows with the lists, to the owner
 * only (`needsAdmin`).
 */
export function describePeopleScreen(
  view: PeopleScreenView,
): PeopleScreenModel {
  switch (view.kind) {
    case "unavailable":
      return { status: PEOPLE_MESSAGES.unavailable, ...NOTHING_LISTED };
    case "pending":
      return { status: PEOPLE_MESSAGES.pending, ...NOTHING_LISTED };
    case "known":
      break;
  }
  const { state } = view;
  switch (state.status) {
    case "signed_out":
      return { status: PEOPLE_MESSAGES.signedOut, ...NOTHING_LISTED };
    case "no_workspace":
      return { status: PEOPLE_MESSAGES.noWorkspace, ...NOTHING_LISTED };
    case "loading":
      return { status: PEOPLE_MESSAGES.loading, ...NOTHING_LISTED };
    case "unavailable":
      return state.people.length === 0
        ? { status: PEOPLE_PROBLEM_MESSAGES[state.problem], ...NOTHING_LISTED }
        : {
            status: PEOPLE_PROBLEM_MESSAGES[state.problem],
            lists: listsOf(state),
            adminHint: needsAdmin(state),
          };
    case "ready": {
      const lists = listsOf(state);
      return {
        status: lists.active.length === 0 ? PEOPLE_MESSAGES.noPeople : "",
        lists:
          lists.active.length === 0 && lists.former.length === 0 ? null : lists,
        adminHint: needsAdmin(state),
      };
    }
  }
}

/**
 * The note below the people when the main process left some out, with the
 * count's digits grouped as `format` groups them, by default in the
 * person's locale ("1,200" in English).
 */
export function describeMorePeople(
  count: number,
  format: Intl.NumberFormat = new Intl.NumberFormat(),
): string {
  const shown = format.format(count);
  return count === 1
    ? `${shown} more person is not shown.`
    : `${shown} more people are not shown.`;
}

export interface PeopleDateFormatOptions {
  /** Defaults to the person's locale. */
  readonly locale?: string;
  /** An IANA time zone such as "Europe/Istanbul"; defaults to the system's. */
  readonly timeZone?: string;
}

/**
 * The format of the date on which a login was last verified, for example
 * "Nov 6, 2026". The screen makes a new one for each render, so that a
 * changed time zone of the system shows at the next change.
 */
export function peopleDateFormat(
  options: PeopleDateFormatOptions = {},
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(options.locale, {
    dateStyle: "medium",
    timeZone: options.timeZone,
  });
}

/** A date of the people screen in `format`. A timestamp that is not a date stays as it is. */
export function formatPeopleDate(
  timestamp: string,
  format: Intl.DateTimeFormat,
): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : format.format(date);
}
