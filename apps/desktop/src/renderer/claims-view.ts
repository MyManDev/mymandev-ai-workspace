import type { ClaimsBridge } from "../shared/desktop-bridge.ts";
import type {
  ClaimLoadResult,
  ClaimViaView,
  ClaimsView,
  PersonView,
  WorkspaceProblem,
} from "../shared/ipc-contract.ts";
import type { PeopleActionRequest } from "./people-actions-view.ts";
import type { PeopleScreenView } from "./people-view.ts";
import type { WorkspacePanelView } from "./workspace-view.ts";

// The screen part of the claim notices of #95 (ADR 0014, "Invitations": the
// owner and the admins are notified of every claim, with the claimer's
// GitHub login and the creation date of that GitHub account, and can remove
// the person in one step; the Project Manager's decisions D8 and D9 of
// 2026-11-13, and the update of D8 on the same day). The main process holds
// the selected workspace's recent claims and which of them the account has
// not seen (#270); the screen shows them in a "Recent claims" section of the
// people screen, reports the claims that it showed, and marks the sidebar's
// people item while any is unseen. "Remove" on a claim is the people
// actions' removal of the person, with its own question (D9).

/** What the screen knows of the selected workspace's recent claims. */
export type ClaimsScreenView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first state. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly state: ClaimsView };

export function initialClaimsScreenView(
  bridgeAvailable: boolean,
): ClaimsScreenView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

/**
 * Subscribes to the claims and reports every state as the view; a refused
 * subscription makes the view unavailable. Unlike the join requests, it
 * asks for no load: the main process loads the claims on its own, also
 * while the people screen is closed, so that the sidebar can mark unseen
 * claims (#270). Returns the function that ends the subscription.
 */
export function followClaims(
  claims: Pick<ClaimsBridge, "subscribeState">,
  onView: (view: ClaimsScreenView) => void,
): () => void {
  return claims.subscribeState(
    (state) => onView({ kind: "known", state }),
    () => onView({ kind: "unavailable" }),
  );
}

/** The fixed texts of the recent claims. */
export const CLAIM_MESSAGES = Object.freeze({
  heading: "Recent claims",
  hint: "Accounts that joined this workspace recently, the most recent first. Check each GitHub login and the creation date of its account, not only the name, and remove anyone who should not be here.",
  unavailable: "Recent claims are not available.",
  pending: "Checking the recent claims.",
  loading: "Loading the recent claims.",
  empty: "No recent claims.",
  /** The mark of a claim that the account has not seen before this visit of the screen. */
  new: "New",
  /** After the display name of a person who was removed or left since the claim. */
  former: "(former member)",
  /** Instead of the name of a person whom the people do not list. */
  unlisted: "A person who is not shown here",
  /** Before the claimer's GitHub login. */
  github: "GitHub ",
  /** Before the date on which the login was last verified. */
  verified: ", last verified ",
  /** Before the creation date of the claimer's GitHub account. */
  accountCreated: "GitHub account created ",
  /** A claim whose account's data was erased. */
  noLogin: "No GitHub login",
  /** Between how the person joined and when. */
  on: " on ",
  refresh: "Refresh the recent claims",
  /** The accessible name of the sidebar's people item while a claim is unseen. */
  peopleWithNewClaims: "People, new claims",
});

/** How the person joined, the claim's `via`. */
export const CLAIM_VIA_MESSAGES: Readonly<Record<ClaimViaView, string>> =
  Object.freeze({
    invitation: "Joined with an invitation",
    join_request: "Joined through a join request",
  });

/**
 * Why the claims are `unavailable`: the failure of the last load. What was
 * loaded before stays shown, and the main process loads again by itself.
 */
export const CLAIM_PROBLEM_MESSAGES: Readonly<
  Record<WorkspaceProblem, string>
> = Object.freeze({
  not_signed_in: "The server did not accept this device's sign-in.",
  not_found: "The server did not find the selected workspace.",
  rate_limited: "The server asked to wait. Trying again in a minute.",
  unavailable: "The server could not be reached. Trying again later.",
  failed: "The recent claims could not be loaded. Trying again later.",
});

/** A claim as the screen shows it. */
export interface ClaimRow {
  /** The claimed person's member ID: the key of the row only; the screen never shows it. */
  readonly memberId: string;
  /** The person's display name from the people, or null when they do not list the person. */
  readonly name: string | null;
  /** Whether the person was removed or left since the claim. */
  readonly former: boolean;
  /** Whether this is the account's own person. */
  readonly you: boolean;
  /** Null, with its two times, after the account's data was erased. */
  readonly login: string | null;
  readonly verifiedAt: string | null;
  readonly accountCreatedAt: string | null;
  readonly via: ClaimViaView;
  readonly claimedAt: string;
  /** Whether the latest state of the main process marks the claim unseen. */
  readonly unseen: boolean;
  /**
   * Whether the row shows "New": unseen, or reported as shown during this
   * visit of the screen, so that the mark stays until the screen closes.
   */
  readonly marked: boolean;
  /**
   * "Remove": the people actions' removal of the person, while the screen
   * offers it in the people list; null otherwise.
   */
  readonly remove: PeopleActionRequest | null;
}

/** What the screen shows of the recent claims, for the owner and the admins. */
export interface RecentClaimsModel {
  /** The selected workspace whose claims these are. */
  readonly workspaceId: string;
  /** The workspace and the account's own person in it (`claimScope`). */
  readonly scope: string;
  /** The text of the section's status paragraph; empty when there is none. */
  readonly status: string;
  /** The claims, in the main process's order, the most recent first. */
  readonly rows: readonly ClaimRow[];
}

/**
 * The workspace and the account's own person in it, as one string: the
 * claims that the screen showed belong to them, and so does the "New" mark
 * that stays during a visit. Null while the people do not name both, and
 * after a sign-out.
 */
export function claimScope(people: PeopleScreenView): string | null {
  if (people.kind !== "known" || people.state.status === "signed_out") {
    return null;
  }
  const { workspaceId, ownMemberId } = people.state;
  return workspaceId === null || ownMemberId === null
    ? null
    : `${workspaceId} ${ownMemberId}`;
}

/**
 * The selected workspace, its people, and the account's own member ID, only
 * while the people are `ready` and the account's own active person is the
 * owner or an admin, who see the claims (ADR 0014, "People and roles";
 * D8).
 */
function managedWorkspace(view: PeopleScreenView): {
  readonly workspaceId: string;
  readonly ownMemberId: string;
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
  return {
    workspaceId: state.workspaceId,
    ownMemberId: own.memberId,
    people: state.people,
  };
}

/** The claims that stay marked "New" during a visit of the screen. */
export interface MarkedClaims {
  /** The scope that the claims belong to, or null. */
  readonly scope: string | null;
  /** The member IDs of the claims. */
  readonly memberIds: ReadonlySet<string>;
}

export const NO_MARKED_CLAIMS: MarkedClaims = Object.freeze({
  scope: null,
  memberIds: new Set<string>(),
});

/**
 * What the screen shows of the recent claims, or null for no section at
 * all: without the owner's or an admin's role in the selected workspace,
 * while the people are not `ready`, as for the join requests, and while the
 * claims say `not_allowed`, so that a demotion that the main process applied
 * hides the section before the people show it.
 *
 * - The claims of the selected workspace only, never another workspace's,
 *   in the main process's order, the most recent first. Each shows the
 *   person's display name from the people (a removed person as a former
 *   member, and a fixed text when the people do not list the person), the
 *   claimer's GitHub login with the date it was last verified and the
 *   creation date of that GitHub account (a fixed text after the account's
 *   data was erased), how the person joined, and when.
 * - A claim is marked "New" while the main process says that it is unseen,
 *   and while `marked` holds it for the same workspace and own person.
 * - "Remove" is the removal that `personActions`, the people actions' model,
 *   offers on the person in the people list: only on an active person other
 *   than the account's own, and only as the roles table allows (the owner
 *   removes admins and members, an admin only members).
 * - A fixed status text: before the first state, while the main process
 *   does not list them for this workspace yet, while they load, without a
 *   claim, and the problem of a failed load, with what was loaded before.
 */
export function describeRecentClaims(
  people: PeopleScreenView,
  claims: ClaimsScreenView,
  marked: MarkedClaims = NO_MARKED_CLAIMS,
  personActions?: ReadonlyMap<string, readonly PeopleActionRequest[]>,
): RecentClaimsModel | null {
  const managed = managedWorkspace(people);
  if (
    managed === null ||
    (claims.kind === "known" && claims.state.status === "not_allowed")
  ) {
    return null;
  }
  const { workspaceId, ownMemberId } = managed;
  const scope = `${workspaceId} ${ownMemberId}`;
  const base = { workspaceId, scope, rows: [] };
  switch (claims.kind) {
    case "unavailable":
      return { ...base, status: CLAIM_MESSAGES.unavailable };
    case "pending":
      return { ...base, status: CLAIM_MESSAGES.pending };
    case "known":
      break;
  }
  const { state } = claims;
  if (state.workspaceId !== workspaceId) {
    // Another workspace's state, before the main process followed the
    // switch: its claims never show here.
    return { ...base, status: CLAIM_MESSAGES.loading };
  }
  switch (state.status) {
    case "signed_out":
    case "no_workspace":
      return { ...base, status: CLAIM_MESSAGES.pending };
    case "loading":
      return { ...base, status: CLAIM_MESSAGES.loading };
    case "not_allowed":
    case "ready":
    case "unavailable":
      break;
  }
  const byId = new Map(
    managed.people.map((person) => [person.memberId, person]),
  );
  const kept = marked.scope === scope ? marked.memberIds : undefined;
  const rows = state.claims.map((claim): ClaimRow => {
    const person = byId.get(claim.memberId);
    const remove =
      personActions
        ?.get(claim.memberId)
        ?.find((request) => request.kind === "remove") ?? null;
    return {
      memberId: claim.memberId,
      name: person?.displayName ?? null,
      former: person?.former ?? false,
      you: claim.memberId === ownMemberId,
      login: claim.login,
      verifiedAt: claim.verifiedAt,
      accountCreatedAt: claim.accountCreatedAt,
      via: claim.via,
      claimedAt: claim.claimedAt,
      unseen: claim.unseen,
      marked: claim.unseen || (kept?.has(claim.memberId) ?? false),
      remove,
    };
  });
  return {
    ...base,
    rows,
    status:
      state.status === "unavailable"
        ? CLAIM_PROBLEM_MESSAGES[state.problem]
        : rows.length === 0
          ? CLAIM_MESSAGES.empty
          : "",
  };
}

/** The claims that the screen reports as shown. */
export interface ShownClaims {
  /** The workspace and the account's own person whose screen showed them. */
  readonly scope: string;
  readonly workspaceId: string;
  /** The member IDs of the claimed people, at least one. */
  readonly memberIds: readonly string[];
}

/**
 * The claims to report as shown (D8, and the note of #270 for the screen):
 * the rendered rows that the latest state marks unseen, only while the
 * section is `visible`, which the screen decides: the people screen is
 * open, the section is rendered with its rows, no modal dialog covers it,
 * and the window is not hidden. Null when there is nothing to report. A
 * claim reported as seen is never new again, also after a restart, so a
 * state that the person could not see is never reported.
 */
export function shownClaims(
  model: RecentClaimsModel | null,
  visible: boolean,
): ShownClaims | null {
  if (model === null || !visible) {
    return null;
  }
  const memberIds = model.rows
    .filter((row) => row.unseen)
    .map((row) => row.memberId);
  return memberIds.length === 0
    ? null
    : { scope: model.scope, workspaceId: model.workspaceId, memberIds };
}

/**
 * Whether the sidebar's people item carries the marker: the claims of the
 * workspace that the sidebar shows as selected hold an unseen claim. A
 * state of another workspace, before the main process followed a switch,
 * never marks it, and neither does anything while no device is signed in.
 * Only the selected workspace counts; the other workspaces follow in #271.
 */
export function hasUnseenClaims(
  claims: ClaimsScreenView,
  workspaces: WorkspacePanelView,
): boolean {
  if (claims.kind !== "known" || workspaces.kind !== "known") {
    return false;
  }
  const { state } = claims;
  return (
    (state.status === "ready" || state.status === "unavailable") &&
    workspaces.state.status !== "signed_out" &&
    state.workspaceId !== null &&
    state.workspaceId === workspaces.state.selectedWorkspaceId &&
    state.claims.some((claim) => claim.unseen)
  );
}

/** Why the main process refused to load the claims on a refresh. */
export type ClaimLoadRefusal = Extract<
  ClaimLoadResult,
  { readonly outcome: "refused" }
>["reason"];

/** The sentences after "Refresh the recent claims". */
export const CLAIM_REFRESH_MESSAGES: Readonly<
  Record<ClaimLoadRefusal, string>
> & { readonly loading: string; readonly failed: string } = Object.freeze({
  /** Until the next state of the claims arrives. */
  loading: "Loading the recent claims again.",
  not_signed_in: "The recent claims appear once this device is signed in.",
  no_workspace: "No workspace is selected.",
  not_allowed: "Only the owner and the admins see the recent claims.",
  too_soon:
    "The recent claims were loaded a moment ago. Try again in a few seconds.",
  failed: "The recent claims could not be loaded again. Try again.",
});

/** What the screen shows of its recent claims beyond the main process's state. */
export interface RecentClaimsView {
  /** The sentence of the last refresh, or undefined. */
  readonly message: string | undefined;
  /** The claims reported as shown during this visit, which stay marked "New". */
  readonly marked: MarkedClaims;
}

export const IDLE_RECENT_CLAIMS: RecentClaimsView = Object.freeze({
  message: undefined,
  marked: NO_MARKED_CLAIMS,
});

export interface RecentClaims {
  /** Asks the main process to load the claims again, and says how it went. */
  readonly refresh: () => Promise<void>;
  /**
   * Reports the claims that the screen showed (`shownClaims`) with
   * `claims.markSeen`, each once during the visit, and only for the scope
   * that the latest people name. A reported claim stays marked "New" until
   * the screen closes or the scope changes; a refused or failed report
   * forgets it, so that the claim stays unseen and a later state reports it
   * again.
   */
  readonly shown: (report: ShownClaims | null) => void;
  /**
   * Follows the screen's views:
   *
   * - the refresh's sentence, the claims reported during the visit, and
   *   their "New" marks belong to the workspace and the own person that they
   *   were about, so they go when another workspace, none, or another own
   *   person is shown, and always with a sign-out; an answer that arrives
   *   after any of it is dropped, also after a switch away and back;
   * - the refresh's sentence ends with the next state of the claims.
   */
  readonly listChanged: (
    people: PeopleScreenView,
    claims: ClaimsScreenView,
  ) => void;
}

/**
 * The recent claims of the screen beyond the main process's state: the
 * refresh, and the reports of the claims that the screen showed. The claims
 * change only with the state that the main process sends, never from an
 * answer.
 */
export function createRecentClaims(
  bridge: Pick<ClaimsBridge, "load" | "markSeen">,
  onView: (view: RecentClaimsView) => void,
): RecentClaims {
  let message: string | undefined;
  let marked: MarkedClaims = NO_MARKED_CLAIMS;
  /** The scope of the latest people; undefined before any. */
  let scope: string | null | undefined;
  /**
   * Grows with every change of the scope, so that an answer counts only
   * when nothing of the kind happened while it was on its way, also a
   * switch away and back.
   */
  let generation = 0;
  /** The latest claims' revision, for the refresh's sentence. */
  let latestRevision: number | undefined;
  /**
   * The revision of the claims when a refresh answered `loading`, while its
   * sentence shows; a later state ends the sentence.
   */
  let refreshedAt: number | undefined;
  const show = () => onView(Object.freeze({ message, marked }));

  function markWith(memberIds: ReadonlySet<string>): void {
    marked = Object.freeze({ scope: scope ?? null, memberIds });
  }

  /** Forgets the claims of a report that did not count, while its scope lasts. */
  function forget(memberIds: readonly string[], at: number): void {
    if (generation !== at) {
      return;
    }
    const left = new Set(marked.memberIds);
    for (const memberId of memberIds) {
      left.delete(memberId);
    }
    markWith(left);
    show();
  }

  return Object.freeze({
    refresh: async () => {
      const at = generation;
      let sentence: string;
      let loading = false;
      try {
        const result = await bridge.load();
        loading = result.outcome === "loading";
        sentence =
          result.outcome === "loading"
            ? CLAIM_REFRESH_MESSAGES.loading
            : CLAIM_REFRESH_MESSAGES[result.reason];
      } catch {
        sentence = CLAIM_REFRESH_MESSAGES.failed;
      }
      if (generation === at) {
        message = sentence;
        refreshedAt = loading ? (latestRevision ?? -1) : undefined;
        show();
      }
    },
    shown: (report: ShownClaims | null) => {
      if (report === null || scope === undefined || report.scope !== scope) {
        return;
      }
      const fresh = report.memberIds.filter(
        (memberId) => !marked.memberIds.has(memberId),
      );
      if (fresh.length === 0) {
        return;
      }
      markWith(new Set([...marked.memberIds, ...fresh]));
      show();
      const at = generation;
      bridge.markSeen(report.workspaceId, fresh).then(
        (result) => {
          if (result.outcome !== "ok") {
            forget(fresh, at);
          }
        },
        () => forget(fresh, at),
      );
    },
    listChanged: (people: PeopleScreenView, claims: ClaimsScreenView) => {
      let changed = false;
      if (claims.kind === "known") {
        latestRevision = claims.state.revision;
        if (refreshedAt !== undefined && claims.state.revision > refreshedAt) {
          refreshedAt = undefined;
          if (message === CLAIM_REFRESH_MESSAGES.loading) {
            message = undefined;
            changed = true;
          }
        }
      }
      if (people.kind === "known") {
        const next = claimScope(people);
        if (scope !== undefined && next !== scope) {
          generation += 1;
          changed ||= message !== undefined || marked.memberIds.size > 0;
          message = undefined;
          refreshedAt = undefined;
          marked = NO_MARKED_CLAIMS;
        }
        scope = next;
      }
      if (changed) {
        show();
      }
    },
  });
}
