// The claim service (#95; ADR 0014, "Invitations": the owner and admins are
// notified of every claim; decision D8 of 2026-11-13): the most recent claims
// of the workspace service's selected workspace, as its owner and admins see
// them, in the main process, read with the account service's
// `readWorkspaceData` (`GET /workspaces/:workspaceId/claims`), and which of
// them the account has not seen yet.
//
// - Only the owner and the admins of a workspace may list its claims, so
//   nothing loads, nothing is held, and the claim events are ignored while
//   the account's own person in the selected workspace is a member, or while
//   its role is not known yet because the workspace's people have not
//   loaded. A demotion drops what was held at once, also when its
//   `workspace.member.role_changed` arrives before the workspace service
//   shows it, for example while that service's resync gate holds the event
//   during a reload; a promotion, or the role once it is known, loads. A
//   load waits until the workspace service's gate is live (`gateLive`), so
//   that it never reads with a role that a reload of the workspace is about
//   to change. This follows the join request service.
// - Unlike the join requests, the claims load without the screen asking,
//   because the sidebar marks unseen claims while the people screen is
//   closed: once the role allows it, again after each `workspace.subscribed`
//   of the selected workspace, which also catches up on the claims missed
//   while offline, and on each `workspace.member.claimed` of it. The event
//   carries no `via` and no creation date of the GitHub account, so it loads
//   the list again rather than adding to it. The screen may ask for a load as
//   well (`load`), which is refused within `CLAIM_LOAD_COOLDOWN_MS` of the
//   last one that it asked for, so that a renderer that misbehaves cannot
//   read the API in a loop.
// - Reloads are merged like the join request service's: while a load is on
//   its way, one more follows its answer, which is dropped, however many
//   triggers came; while a retry waits out its backoff, the retry reads the
//   change. A failed load is retried with the workspace service's backoff
//   while connected; offline, the next `workspace.subscribed` loads.
// - Another selected workspace, a sign-out, another device, an access that
//   is no longer `allowed` for any reason, and another own person in the
//   same workspace drop the claims and the answers on their way.
//
// The seen claims (D8, and the Project Manager's decision of 2026-11-13 on
// #270): the member IDs of the claims that the account has seen in a
// workspace, kept on this device in the seen claims file (`seen-store.ts`),
// by the workspace and the account's own person in it. A held claim is
// unseen while its member ID is not among them, so without an entry every
// claim is; the account's own claim, which a list shows to an admin who
// joined with an invitation or a join request, never is. Only the screen
// adds to them (`markSeen`), with the member IDs of the claims that it
// showed, of which only held ones count; a write keeps only the claims of
// the latest list, so a claim that left the list, which never comes back,
// leaves them as well. A time would not do: `claimedAt` is the API's clock
// at the start of its request, so claims can commit out of time order, and
// a claim that commits late with an earlier time would count as seen
// without ever being shown. Nothing loads until the file was read; a
// missing, unreadable, or invalid file counts as no entry.
//
// The state holds member IDs, logins, and times only, never a user ID; the
// logs are fixed text with a failure code at most.
import type {
  ClaimListResponse,
  ClaimVia,
  MemberId,
  WorkspaceId,
} from "@mymandev/protocol";
import type {
  WorkspaceReadFailure,
  WorkspaceReadResult,
} from "../api-reads.ts";
import type { ConnectionClient, ServerMessage } from "../connection/client.ts";
import type { ScheduleTimer } from "../runtime.ts";
import {
  workspaceRetryDelayMs,
  type WorkspaceAccount,
  type WorkspaceService,
} from "../workspace/service.ts";
import {
  type ClaimSeenEntry,
  type ClaimSeenRead,
  type ClaimSeenStore,
  MAX_CLAIM_SEEN_ENTRIES,
  MAX_SEEN_CLAIMS_PER_ENTRY,
} from "./seen-store.ts";

/**
 * How long after the screen's last request for the claims the next one is
 * refused (`too_soon`).
 */
export const CLAIM_LOAD_COOLDOWN_MS = 2_000;

/**
 * - `signed_out`: no signed-in device; the state is empty.
 * - `no_workspace`: no workspace is selected.
 * - `not_allowed`: the account's own person in the selected workspace is
 *   not the owner or an admin; the state is empty.
 * - `loading`: the claims have not loaded yet for the selected workspace,
 *   also while the role is not known and while the seen claims file is read.
 * - `ready`: they loaded. It stays `ready` during later loads.
 * - `unavailable`: the last load failed; `problem` holds the failure until a
 *   load succeeds. What was loaded before stays.
 */
export type ClaimListStatus =
  | "signed_out"
  | "no_workspace"
  | "not_allowed"
  | "loading"
  | "ready"
  | "unavailable";

/** The GitHub account behind a claim, as the service keeps it. */
export interface ClaimerState {
  readonly login: string;
  /** When the login was last verified, an ISO 8601 time in UTC. */
  readonly verifiedAt: string;
  /** When the GitHub account was created, an ISO 8601 time in UTC. */
  readonly accountCreatedAt: string;
}

/** A claim as the service keeps it: never a user ID. */
export interface ClaimState {
  /** The person that was claimed. */
  readonly memberId: MemberId;
  /** Null only after the account's data was erased. */
  readonly claimer: ClaimerState | null;
  readonly via: ClaimVia;
  /** An ISO 8601 time in UTC, in the protocol's form. */
  readonly claimedAt: string;
  /**
   * Whether the account has not seen it yet: the screen never reported it
   * as shown, it is not the claim of the account's own person, and it is
   * one of the `MAX_SEEN_CLAIMS_PER_ENTRY` most recent claims of the list.
   */
  readonly unseen: boolean;
}

/** The service's state. Every value is frozen. */
export interface ClaimListState {
  /** Grows by one with every change. */
  readonly revision: number;
  readonly status: ClaimListStatus;
  /** Only with `unavailable`. */
  readonly problem?: WorkspaceReadFailure;
  /** The selected workspace, or null. */
  readonly workspaceId: WorkspaceId | null;
  /** The claims of the last load, in the API's order, the most recent first. */
  readonly claims: readonly ClaimState[];
}

/** The answer to the screen's request for the claims. */
export type ClaimLoadOutcome =
  | { readonly outcome: "loading" }
  | {
      readonly outcome: "refused";
      readonly reason:
        "not_signed_in" | "no_workspace" | "not_allowed" | "too_soon";
    };

/**
 * The answer to the screen's report of the claims that it showed: `ok` when
 * at least one of them is held, also when all of them were seen already, or
 * `refused`: `not_selected` for a workspace that is not the selected one,
 * `not_allowed` without the owner's or an admin's role, and `not_listed`
 * when no held claim has any of the member IDs.
 */
export type ClaimMarkSeenOutcome =
  | { readonly outcome: "ok" }
  | {
      readonly outcome: "refused";
      readonly reason: "not_selected" | "not_allowed" | "not_listed";
    };

/** The part of the connection client that the service uses: no way to send. */
export type ClaimConnection = Pick<
  ConnectionClient,
  "status" | "onStatusChange" | "onMessage"
>;

export interface ClaimServiceOptions {
  readonly account: Pick<WorkspaceAccount, "readWorkspaceData">;
  readonly connection: ClaimConnection;
  readonly workspaces: Pick<
    WorkspaceService,
    "state" | "onChange" | "people" | "ownMemberId" | "gateLive"
  >;
  /** The seen claims file. */
  readonly seen: ClaimSeenStore;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now?: () => number;
  /**
   * Receives fixed messages with a failure code at most, never a login or
   * an ID. An error that it throws is ignored.
   */
  readonly log?: (message: string) => void;
}

export interface ClaimService {
  /** The current state. */
  readonly state: () => ClaimListState;
  /** Calls `listener` after every change. The result removes the listener. */
  readonly onChange: (listener: (state: ClaimListState) => void) => () => void;
  /**
   * The screen asks for the claims again, on the person's refresh. Refused
   * as `not_signed_in`, `no_workspace`, or `not_allowed` without a read or
   * a cooldown, and as `too_soon` within `CLAIM_LOAD_COOLDOWN_MS` of the
   * last request that was not refused. While the role is not known yet, or
   * the seen claims file is read, it answers `loading`, and the claims load
   * once they may.
   */
  readonly load: () => ClaimLoadOutcome;
  /**
   * The screen showed the claims of `workspaceId` with `memberIds`: they
   * count as seen from then on, and the change is written to the seen
   * claims file. Only the selected workspace is accepted, and only the
   * member IDs of held claims count; the others are ignored. A claim does
   * not become unseen again while the list holds it, unless its entry is
   * evicted, a write failed before the application quit, or an older
   * roamed file replaces the file.
   */
  readonly markSeen: (
    workspaceId: WorkspaceId,
    memberIds: readonly MemberId[],
  ) => ClaimMarkSeenOutcome;
  /** Stops listening and cancels the timers, for the quit. */
  readonly close: () => void;
}

/**
 * A claim as the last answer holds it; whether it is unseen follows from the
 * seen claims when the state is built.
 */
interface HeldClaim {
  readonly memberId: MemberId;
  readonly claimer: ClaimerState | null;
  readonly via: ClaimVia;
  readonly claimedAt: string;
}

/**
 * Whether the account's own person may list the selected workspace's
 * claims: `allowed` for the owner and an admin, `not_allowed` for a member,
 * and `unknown` while the workspace's people have not loaded.
 */
type Access = "allowed" | "not_allowed" | "unknown";

const LOADING: ClaimLoadOutcome = Object.freeze({ outcome: "loading" });
const MARKED: ClaimMarkSeenOutcome = Object.freeze({ outcome: "ok" });

function refusedLoad(
  reason: "not_signed_in" | "no_workspace" | "not_allowed" | "too_soon",
): ClaimLoadOutcome {
  return Object.freeze({ outcome: "refused", reason });
}

function refusedMark(
  reason: "not_selected" | "not_allowed" | "not_listed",
): ClaimMarkSeenOutcome {
  return Object.freeze({ outcome: "refused", reason });
}

const NO_CLAIMS: readonly HeldClaim[] = Object.freeze([]);

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

/** The key of an entry: the workspace and the account's own person in it. */
function entryKey(workspaceId: WorkspaceId, ownMemberId: MemberId): string {
  return `${workspaceId} ${ownMemberId}`;
}

function heldClaim(claim: ClaimListResponse["claims"][number]): HeldClaim {
  return Object.freeze({
    memberId: claim.memberId,
    claimer:
      claim.claimer === null
        ? null
        : Object.freeze({
            login: claim.claimer.login,
            verifiedAt: claim.claimer.verifiedAt,
            accountCreatedAt: claim.claimer.accountCreatedAt,
          }),
    via: claim.via,
    claimedAt: claim.claimedAt,
  });
}

export function createClaimService(options: ClaimServiceOptions): ClaimService {
  const { account, connection, workspaces, seen } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const now = options.now ?? (() => performance.now());

  function log(message: string): void {
    try {
      options.log?.(message);
    } catch {
      // A failing log changes nothing.
    }
  }

  let closed = false;
  let connected = false;
  let signedIn = false;
  let selected: WorkspaceId | null = null;
  /** The account's own person in the selected workspace, or null. */
  let own: MemberId | null = null;
  let access: Access = "unknown";
  /**
   * The account's own person in the selected workspace was demoted to
   * `member` by an event that the workspace service's people do not show
   * yet: its access stays `not_allowed` until they show it, the workspace
   * service's gate is live again, or an event promotes the person again.
   */
  let demoted = false;
  /**
   * A load waits until the workspace service's gate of the selected
   * workspace is live, so that the role it reads with is current.
   */
  let gateWait = false;
  /**
   * Changes whenever what was loaded no longer applies: another workspace,
   * a sign-out, another device, another own person, or an access that is no
   * longer `allowed`. An answer for an earlier epoch is dropped.
   */
  let epoch = 0;
  /** When the screen's last request was accepted, or null. */
  let lastRequest: number | null = null;

  /** The claims of the last answer, in its order. */
  let claims: readonly HeldClaim[] = NO_CLAIMS;
  let loaded = false;
  let problem: WorkspaceReadFailure | null = null;
  let inFlight = false;
  /** A trigger came while a load was on its way: its answer is dropped. */
  let again = false;
  /** The failed loads in a row, for the backoff. */
  let attempt = 0;
  let cancelRetry: (() => void) | null = null;

  /**
   * The seen claims by `entryKey`, the entry that changed longest ago
   * first; null until the seen claims file was read.
   */
  let entries: Map<string, ClaimSeenEntry> | null = null;
  /** A write of the entries is on its way. */
  let writing = false;
  /** The entries changed during that write: one more follows it. */
  let writeAgain = false;

  let revision = 0;
  let dirty = false;
  let current = buildState();
  const listeners = new Set<(state: ClaimListState) => void>();

  function status(): ClaimListStatus {
    if (!signedIn) {
      return "signed_out";
    }
    if (selected === null) {
      return "no_workspace";
    }
    if (access === "not_allowed") {
      return "not_allowed";
    }
    if (problem !== null) {
      return "unavailable";
    }
    return loaded ? "ready" : "loading";
  }

  /** The claims seen in the selected workspace, as the account's own person. */
  function seenIds(): ReadonlySet<MemberId> {
    if (entries === null || selected === null || own === null) {
      return new Set();
    }
    return new Set(entries.get(entryKey(selected, own))?.seenMemberIds ?? []);
  }

  function buildState(): ClaimListState {
    const seenNow = seenIds();
    const list = Object.freeze(
      claims.map((claim, index): ClaimState =>
        Object.freeze({
          ...claim,
          // A claim behind the `MAX_SEEN_CLAIMS_PER_ENTRY` most recent
          // ones has as many newer claims, so it did not commit late,
          // and an entry could not hold it: it is never unseen. A server
          // that lists more claims, which the protocol allows, then never
          // leaves one new for good.
          unseen:
            index < MAX_SEEN_CLAIMS_PER_ENTRY &&
            claim.memberId !== own &&
            !seenNow.has(claim.memberId),
        }),
      ),
    );
    const base = { revision, workspaceId: selected, claims: list };
    const shown = status();
    return shown === "unavailable" && problem !== null
      ? Object.freeze({ ...base, status: shown, problem })
      : Object.freeze({ ...base, status: shown });
  }

  function touch(): void {
    dirty = true;
  }

  function flush(): void {
    if (!dirty || closed) {
      return;
    }
    dirty = false;
    revision += 1;
    const state = buildState();
    current = state;
    for (const listener of [...listeners]) {
      // A listener that changed the state again has notified everyone of
      // the newer state already.
      if (current !== state) {
        return;
      }
      try {
        listener(state);
      } catch {
        log("A claim state listener failed.");
      }
    }
  }

  /** Runs one entry point and publishes the change. */
  function run<T>(action: () => T): T {
    try {
      return action();
    } finally {
      flush();
    }
  }

  function stopRetry(): void {
    cancelRetry?.();
    cancelRetry = null;
  }

  /** Drops what was loaded and the answers on their way. */
  function drop(): void {
    epoch += 1;
    inFlight = false;
    again = false;
    gateWait = false;
    stopRetry();
    attempt = 0;
    claims = NO_CLAIMS;
    loaded = false;
    problem = null;
    touch();
  }

  // The seen claims.

  function seenRead(read: ClaimSeenRead | null): void {
    if (closed) {
      return;
    }
    entries = new Map();
    if (read === null) {
      log("The seen claims could not be read; every claim counts as unseen.");
    } else if (read.kind === "corrupt") {
      log("The seen claims were not valid; every claim counts as unseen.");
    } else if (read.kind === "entries") {
      for (const entry of read.entries.slice(-MAX_CLAIM_SEEN_ENTRIES)) {
        entries.set(entryKey(entry.workspaceId, entry.ownMemberId), entry);
      }
    }
    touch();
    // The claims load once the seen claims are known.
    reloadSelected();
  }

  /** Writes the entries, one write at a time, the latest entries last. */
  function persist(): void {
    if (entries === null) {
      return;
    }
    if (writing) {
      writeAgain = true;
      return;
    }
    writing = true;
    writeAgain = false;
    const snapshot = Object.freeze([...entries.values()]);
    const written = () => {
      writing = false;
      if (writeAgain) {
        persist();
      }
    };
    void Promise.resolve()
      .then(() => seen.write(snapshot))
      .then(written, () => {
        log("The seen claims were not saved.");
        written();
      });
  }

  function markSeen(
    workspaceId: WorkspaceId,
    memberIds: readonly MemberId[],
  ): ClaimMarkSeenOutcome {
    if (closed || selected === null || workspaceId !== selected) {
      return refusedMark("not_selected");
    }
    if (access !== "allowed" || own === null) {
      return refusedMark("not_allowed");
    }
    const shown = new Set(memberIds);
    if (
      entries === null ||
      !claims.some((claim) => shown.has(claim.memberId))
    ) {
      return refusedMark("not_listed");
    }
    const key = entryKey(selected, own);
    const before = entries.get(key)?.seenMemberIds ?? [];
    const seenBefore = new Set(before);
    // Only the claims of the latest list stay, in its order, the most
    // recent first: a claim that left the list never comes back.
    const after = claims
      .map((claim) => claim.memberId)
      .filter((memberId) => seenBefore.has(memberId) || shown.has(memberId))
      .slice(0, MAX_SEEN_CLAIMS_PER_ENTRY);
    if (
      after.length === before.length &&
      after.every((memberId, index) => memberId === before[index])
    ) {
      return MARKED;
    }
    entries.delete(key);
    entries.set(
      key,
      Object.freeze({
        workspaceId: selected,
        ownMemberId: own,
        seenMemberIds: Object.freeze(after),
      }),
    );
    for (const oldest of entries.keys()) {
      if (entries.size <= MAX_CLAIM_SEEN_ENTRIES) {
        break;
      }
      entries.delete(oldest);
    }
    touch();
    persist();
    return MARKED;
  }

  // The loads.

  /** The access of the account's own person in `workspaceId`. */
  function accessIn(workspaceId: WorkspaceId): Access {
    const ownId = workspaces.ownMemberId(workspaceId);
    const person =
      ownId === null
        ? undefined
        : workspaces.people().find((entry) => entry.id === ownId);
    if (person === undefined) {
      // The selected workspace's people have not loaded yet.
      return "unknown";
    }
    return person.removedAt === null &&
      (person.role === "owner" || person.role === "admin")
      ? "allowed"
      : "not_allowed";
  }

  /** Whether the claim events and the triggers count now. */
  function live(): boolean {
    return (
      !closed && entries !== null && selected !== null && access === "allowed"
    );
  }

  /**
   * Loads the selected workspace's claims, while the role allows it. While a
   * load is on its way, its answer is dropped and they load again after it;
   * while a retry waits, the retry reads them.
   */
  function reloadSelected(): void {
    if (!live()) {
      return;
    }
    if (inFlight) {
      again = true;
      return;
    }
    if (cancelRetry !== null) {
      // A failed load waits out its backoff, also the wait after
      // `rate_limited`; the retry reads everything.
      return;
    }
    if (selected !== null && !workspaces.gateLive(selected)) {
      // The workspace reloads, and its people may change the role: the
      // load follows once the gate is live (`follow`).
      gateWait = true;
      return;
    }
    send();
  }

  function send(): void {
    const workspaceId = selected;
    if (workspaceId === null) {
      return;
    }
    inFlight = true;
    again = false;
    const sent = epoch;
    void account
      .readWorkspaceData("listClaims", { workspaceId })
      .catch((): WorkspaceReadResult<never> => ({
        ok: false,
        reason: "unavailable",
      }))
      .then((result) => run(() => answered(sent, workspaceId, result)));
  }

  function answered(
    sent: number,
    workspaceId: WorkspaceId,
    result: WorkspaceReadResult<ClaimListResponse>,
  ): void {
    if (closed || sent !== epoch || workspaceId !== selected) {
      return;
    }
    inFlight = false;
    if (again && (result.ok || result.reason !== "rate_limited")) {
      // A trigger came after this load was sent: only a newer answer
      // counts. After `rate_limited`, the retry at the end of the wait
      // reads it instead.
      reloadSelected();
      return;
    }
    again = false;
    if (
      !result.ok ||
      result.value.claims.some((claim) => claim.workspaceId !== workspaceId)
    ) {
      loadFailed(result.ok ? "failed" : result.reason);
      return;
    }
    claims = Object.freeze(result.value.claims.map(heldClaim));
    loaded = true;
    problem = null;
    attempt = 0;
    touch();
  }

  function loadFailed(reason: WorkspaceReadFailure): void {
    problem = reason;
    touch();
    log(`The claims did not load (${reason}).`);
    if (connected) {
      // Offline, the next `workspace.subscribed` loads anyway.
      const delayMs = workspaceRetryDelayMs(attempt, reason);
      cancelRetry = schedule(() => {
        run(() => {
          cancelRetry = null;
          reloadSelected();
        });
      }, delayMs);
    }
    attempt += 1;
  }

  /**
   * Follows the workspace service: the device, the selection, the account's
   * own person, and its role in the selected workspace.
   */
  function follow(): void {
    const state = workspaces.state();
    const nextSignedIn = state.status !== "signed_out";
    const nextSelected = nextSignedIn ? state.selectedWorkspaceId : null;
    if (nextSignedIn !== signedIn || nextSelected !== selected) {
      signedIn = nextSignedIn;
      selected = nextSelected;
      access = "unknown";
      demoted = false;
      drop();
    }
    const nextOwn = selected === null ? null : workspaces.ownMemberId(selected);
    if (nextOwn !== own) {
      // Another own person in the same workspace, for example after a
      // removal and a new claim while offline: what was held, and its seen
      // claims, belong to the other person.
      own = nextOwn;
      access = "unknown";
      demoted = false;
      drop();
    }
    let nextAccess: Access = selected === null ? "unknown" : accessIn(selected);
    if (
      demoted &&
      (nextAccess !== "allowed" ||
        (selected !== null && workspaces.gateLive(selected)))
    ) {
      // The people show the demotion, or the workspace reloaded with every
      // event applied, so they hold the current role.
      demoted = false;
    }
    if (demoted) {
      // The people do not show the demotion yet.
      nextAccess = "not_allowed";
    }
    changeAccess(nextAccess);
    if (gateWait && selected !== null && workspaces.gateLive(selected)) {
      gateWait = false;
      reloadSelected();
    }
  }

  function changeAccess(nextAccess: Access): void {
    if (nextAccess !== access) {
      access = nextAccess;
      touch();
      if (access === "allowed") {
        reloadSelected();
      } else {
        // A demotion, or a role that is no longer known: what was loaded
        // may no longer be the person's to see.
        drop();
      }
    }
  }

  /**
   * A role change of the account's own person in the selected workspace,
   * at once, also while the workspace service's gate holds the event: a
   * demotion to `member` drops what was held, and a promotion after it
   * lets the people decide again.
   */
  function ownRoleChanged(role: string): void {
    if (role === "member") {
      // `follow` ends it once the people show the role or the workspace
      // service's gate is live, when they show every event.
      demoted = true;
      changeAccess("not_allowed");
    } else if (demoted) {
      demoted = false;
      follow();
    }
  }

  function messageReceived(message: ServerMessage): void {
    if (selected === null) {
      return;
    }
    if (message.kind === "frame") {
      if (
        message.frame.type === "workspace.subscribed" &&
        message.frame.workspaceId === selected
      ) {
        reloadSelected();
      }
      return;
    }
    const event = message.event;
    if (
      event.workspaceId === selected &&
      event.type === "workspace.member.role_changed" &&
      own !== null &&
      event.payload.memberId === own
    ) {
      ownRoleChanged(event.payload.role);
      return;
    }
    if (
      event.workspaceId === selected &&
      event.type === "workspace.member.claimed"
    ) {
      // The role filter: a member's device ignores it, and so does a
      // device whose role is not known yet (`live`). The event carries no
      // `via` and no creation date of the GitHub account, so the list
      // loads again.
      reloadSelected();
    }
  }

  function connectionChanged(state: string): void {
    const isConnected = state === "connected";
    if (isConnected === connected) {
      return;
    }
    connected = isConnected;
    if (!isConnected) {
      // The next `workspace.subscribed` loads; a retry offline would fail.
      stopRetry();
    }
  }

  function load(): ClaimLoadOutcome {
    if (closed || !signedIn) {
      return refusedLoad("not_signed_in");
    }
    if (selected === null) {
      return refusedLoad("no_workspace");
    }
    if (access === "not_allowed") {
      return refusedLoad("not_allowed");
    }
    const at = now();
    if (lastRequest !== null && at - lastRequest < CLAIM_LOAD_COOLDOWN_MS) {
      return refusedLoad("too_soon");
    }
    lastRequest = at;
    reloadSelected();
    return LOADING;
  }

  const removers = [
    connection.onStatusChange((next) =>
      run(() => connectionChanged(next.state)),
    ),
    connection.onMessage((message) => run(() => messageReceived(message))),
    workspaces.onChange(() => run(() => follow())),
  ];
  connectionChanged(connection.status().state);
  follow();
  // The first state is revision 0.
  current = buildState();
  dirty = false;
  void Promise.resolve()
    .then(() => seen.read())
    .then(
      (read) => run(() => seenRead(read)),
      () => run(() => seenRead(null)),
    );

  return Object.freeze({
    state: () => current,
    onChange: (listener: (state: ClaimListState) => void) => {
      const entry = (state: ClaimListState) => listener(state);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    load: () => run(load),
    markSeen: (workspaceId: WorkspaceId, memberIds: readonly MemberId[]) =>
      run(() => markSeen(workspaceId, memberIds)),
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const remove of removers) {
        remove();
      }
      listeners.clear();
      stopRetry();
    },
  });
}
