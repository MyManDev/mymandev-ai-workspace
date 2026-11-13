// The invitation service (#95; decisions D1 to D3 of 2026-11-06): the live
// invitations of the workspace service's selected workspace, in the main
// process, read with the account service's `readWorkspaceData`
// (`GET /workspaces/:workspaceId/invitations`).
//
// - Only the owner and the admins of a workspace may list its invitations,
//   so nothing loads, and nothing is held, while the account's own person
//   in the selected workspace is a member, or while its role is not known
//   yet because the workspace's people have not loaded. A demotion drops
//   what was held at once, also when its `workspace.member.role_changed`
//   arrives before the workspace service shows it, for example while that
//   service's resync gate holds the event during a reload; a promotion, or
//   the role once it is known, loads. A load waits until the workspace
//   service's gate is live (`gateLive`), so that it never reads with a role
//   that a reload of the workspace is about to change.
// - Nothing loads until the screen asked (`load`), when it opens and on the
//   person's refresh. From then on, while the application runs, the
//   invitations load again after each `workspace.subscribed` of the
//   selected workspace, on each `workspace.member.claimed` of it (a claim
//   consumes an invitation), and after an invitation action (`reload`), as
//   D3 asks. The Project Manager's decision of 2026-11-10 adds the events
//   of the selected workspace that revoke invitations on the server (ADR
//   0014): `workspace.member.removed`, which a removal and a leave send,
//   and `workspace.member.role_changed` to `member`, a demotion; never
//   those of the account's own person, whose demotion drops the list as it
//   arrives and whose removal ends the membership. The screen's request is
//   refused within `INVITATION_LOAD_COOLDOWN_MS` of the last one that
//   loaded, so that a renderer that misbehaves cannot read the API in a
//   loop.
// - Reloads are merged like the workspace service's `reload`: while a load
//   is on its way, one more follows its answer, which is dropped, however
//   many triggers came; while a retry waits out its backoff, the retry
//   reads the change. A failed load is retried with the workspace service's
//   backoff while connected; offline, the next `workspace.subscribed`
//   loads.
// - Another selected workspace, a sign-out, or another device drops the
//   invitations and the answers on their way.
//
// The list of the API holds no invitation code (`InvitationSchema`), and
// the service never sees one: the code of a new invitation goes from the
// create's answer to the renderer once (`invitation-actions-ipc.ts`). The
// state holds IDs and times only, never a name or a user ID; the logs are
// fixed text with a failure code at most.
import type {
  InvitationId,
  InvitationListResponse,
  MemberId,
  ReceivedServerEvent,
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

/**
 * How long after the screen's last request for the invitations the next
 * one is refused (`too_soon`).
 */
export const INVITATION_LOAD_COOLDOWN_MS = 2_000;

/**
 * - `signed_out`: no signed-in device; the state is empty.
 * - `no_workspace`: no workspace is selected.
 * - `not_allowed`: the account's own person in the selected workspace is
 *   not the owner or an admin; the state is empty.
 * - `loading`: the invitations have not loaded yet for the selected
 *   workspace, also while the role is not known.
 * - `ready`: they loaded. It stays `ready` during later loads.
 * - `unavailable`: the last load failed; `problem` holds the failure until
 *   a load succeeds. What was loaded before stays.
 */
export type InvitationListStatus =
  | "signed_out"
  | "no_workspace"
  | "not_allowed"
  | "loading"
  | "ready"
  | "unavailable";

/** A live invitation as the service keeps it: never a code. */
export interface InvitationState {
  readonly id: InvitationId;
  /** The unclaimed person that the invitation claims. */
  readonly memberId: MemberId;
  readonly createdByMemberId: MemberId;
  /** An ISO 8601 time in UTC. */
  readonly createdAt: string;
  /** An ISO 8601 time in UTC. */
  readonly expiresAt: string;
}

/** The service's state. Every value is frozen. */
export interface InvitationListState {
  /** Grows by one with every change. */
  readonly revision: number;
  readonly status: InvitationListStatus;
  /** Only with `unavailable`. */
  readonly problem?: WorkspaceReadFailure;
  /** The selected workspace, or null. */
  readonly workspaceId: WorkspaceId | null;
  /** The API's list, in its order. */
  readonly invitations: readonly InvitationState[];
}

/** The answer to the screen's request for the invitations. */
export type InvitationLoadOutcome =
  | { readonly outcome: "loading" }
  | {
      readonly outcome: "refused";
      readonly reason:
        "not_signed_in" | "no_workspace" | "not_allowed" | "too_soon";
    };

/** The part of the connection client that the service uses: no way to send. */
export type InvitationConnection = Pick<
  ConnectionClient,
  "status" | "onStatusChange" | "onMessage"
>;

export interface InvitationServiceOptions {
  readonly account: Pick<WorkspaceAccount, "readWorkspaceData">;
  readonly connection: InvitationConnection;
  readonly workspaces: Pick<
    WorkspaceService,
    "state" | "onChange" | "people" | "ownMemberId" | "gateLive"
  >;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now?: () => number;
  /**
   * Receives fixed messages with a failure code at most, never a name, an
   * ID, or a code. An error that it throws is ignored.
   */
  readonly log?: (message: string) => void;
}

export interface InvitationService {
  /** The current state. */
  readonly state: () => InvitationListState;
  /** Calls `listener` after every change. The result removes the listener. */
  readonly onChange: (
    listener: (state: InvitationListState) => void,
  ) => () => void;
  /**
   * The screen asks for the invitations: they load now, and from then on
   * after every trigger. It still counts as the screen's request when it
   * is refused as `not_signed_in`, `no_workspace`, or `not_allowed`, which
   * start no cooldown, so the invitations load once they may. While the
   * role is not known yet, it answers `loading`, and they load once it is;
   * while the workspace service's gate is not live, it answers `loading`,
   * and they load once the gate is live. It is refused as `too_soon` within
   * `INVITATION_LOAD_COOLDOWN_MS` of the last request that was not refused.
   */
  readonly load: () => InvitationLoadOutcome;
  /**
   * Loads the invitations of `workspaceId` again after an invitation
   * action, merged with the other triggers. True when they are read again,
   * or a load or a retry on its way reads them, or a load waits for the
   * workspace service's gate; false, with nothing read,
   * for a workspace that is not the selected one, without the owner's or
   * an admin's role, or before the screen asked.
   */
  readonly reload: (workspaceId: WorkspaceId) => boolean;
  /** Stops listening and cancels the retry, for the quit. */
  readonly close: () => void;
}

const LOADING: InvitationLoadOutcome = Object.freeze({ outcome: "loading" });

function refusedLoad(
  reason: "not_signed_in" | "no_workspace" | "not_allowed" | "too_soon",
): InvitationLoadOutcome {
  return Object.freeze({ outcome: "refused", reason });
}

const NO_INVITATIONS: readonly InvitationState[] = Object.freeze([]);

/**
 * Whether the account's own person may list the selected workspace's
 * invitations: `allowed` for the owner and an admin, `not_allowed` for a
 * member, and `unknown` while the workspace's people have not loaded.
 */
type Access = "allowed" | "not_allowed" | "unknown";

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

function invitationState(
  invitation: InvitationListResponse["invitations"][number],
): InvitationState {
  return Object.freeze({
    id: invitation.id,
    memberId: invitation.memberId,
    createdByMemberId: invitation.createdByMemberId,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
  });
}

export function createInvitationService(
  options: InvitationServiceOptions,
): InvitationService {
  const { account, connection, workspaces } = options;
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
   * a sign-out, another device, or a role without access. An answer for an
   * earlier epoch is dropped.
   */
  let epoch = 0;
  /**
   * Whether the screen asked for the invitations since the application
   * started. Until then nothing loads.
   */
  let requested = false;
  /** When the screen's last request was accepted, or null. */
  let lastRequest: number | null = null;

  let invitations = NO_INVITATIONS;
  let loaded = false;
  let problem: WorkspaceReadFailure | null = null;
  let inFlight = false;
  /** A trigger came while a load was on its way: its answer is dropped. */
  let again = false;
  /** The failed loads in a row, for the backoff. */
  let attempt = 0;
  let cancelRetry: (() => void) | null = null;

  let revision = 0;
  let dirty = false;
  let current = buildState();
  const listeners = new Set<(state: InvitationListState) => void>();

  function status(): InvitationListStatus {
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

  function buildState(): InvitationListState {
    const base = { revision, workspaceId: selected, invitations };
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
        log("An invitation state listener failed.");
      }
    }
  }

  /** Runs one entry point and then publishes what it changed. */
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
    invitations = NO_INVITATIONS;
    loaded = false;
    problem = null;
    touch();
  }

  /** The access of the account's own person in `workspaceId`. */
  function accessIn(workspaceId: WorkspaceId): Access {
    const own = workspaces.ownMemberId(workspaceId);
    const person =
      own === null
        ? undefined
        : workspaces.people().find((entry) => entry.id === own);
    if (person === undefined) {
      // The selected workspace's people have not loaded yet.
      return "unknown";
    }
    return person.removedAt === null &&
      (person.role === "owner" || person.role === "admin")
      ? "allowed"
      : "not_allowed";
  }

  /**
   * Loads the selected workspace's invitations, once the screen asked and
   * while the role allows it. While a load is on its way, its answer is
   * dropped and they load again after it; while a retry waits, the retry
   * reads them.
   */
  function reloadSelected(): boolean {
    if (closed || !requested || selected === null || access !== "allowed") {
      return false;
    }
    if (inFlight) {
      again = true;
      return true;
    }
    if (cancelRetry !== null) {
      // A failed load waits out its backoff, also the wait after
      // `rate_limited`; the retry reads everything.
      return true;
    }
    if (!workspaces.gateLive(selected)) {
      // The workspace reloads, and its people may change the role: the
      // load follows once the gate is live (`follow`).
      gateWait = true;
      return true;
    }
    send();
    return true;
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
      .readWorkspaceData("listInvitations", { workspaceId })
      .catch((): WorkspaceReadResult<never> => ({
        ok: false,
        reason: "unavailable",
      }))
      .then((result) => run(() => answered(sent, workspaceId, result)));
  }

  function answered(
    sent: number,
    workspaceId: WorkspaceId,
    result: WorkspaceReadResult<InvitationListResponse>,
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
      result.value.invitations.some(
        (invitation) => invitation.workspaceId !== workspaceId,
      )
    ) {
      loadFailed(result.ok ? "failed" : result.reason);
      return;
    }
    invitations = Object.freeze(result.value.invitations.map(invitationState));
    loaded = true;
    problem = null;
    attempt = 0;
    touch();
  }

  function loadFailed(reason: WorkspaceReadFailure): void {
    problem = reason;
    touch();
    log(`The invitations did not load (${reason}).`);
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
   * Follows the workspace service: the device, the selection, and the
   * role of the account's own person in the selected workspace.
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
    if (nextAccess === access) {
      return;
    }
    access = nextAccess;
    touch();
    if (access === "allowed") {
      reloadSelected();
    } else if (access === "not_allowed") {
      // A demotion: what was loaded is no longer the person's to see.
      drop();
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

  /**
   * Whether an event of the selected workspace revokes or consumes some of
   * its live invitations, so that they load again. An event about the
   * account's own person counts for nothing: its demotion drops the list as
   * it arrives (`ownRoleChanged`), and its removal ends the membership, so
   * nothing is read for it, also before the workspace service applied the
   * event.
   */
  function changesInvitations(event: ReceivedServerEvent): boolean {
    switch (event.type) {
      case "workspace.member.claimed":
        // A claim consumes the person's invitation.
        return true;
      case "workspace.member.removed":
        // A removal or a leave revokes the person's invitation and the
        // invitations that the person created.
        return !isOwnPerson(event.payload.memberId);
      case "workspace.member.role_changed":
        // A demotion revokes the invitations that the admin created; a
        // promotion revokes nothing. The account's own role change does not
        // come here (`ownRoleChanged`).
        return event.payload.role === "member";
      default:
        return false;
    }
  }

  function isOwnPerson(memberId: MemberId): boolean {
    return selected !== null && workspaces.ownMemberId(selected) === memberId;
  }

  function messageReceived(message: ServerMessage): void {
    if (selected === null) {
      return;
    }
    if (message.kind === "event") {
      const event = message.event;
      if (event.workspaceId !== selected) {
        return;
      }
      if (
        event.type === "workspace.member.role_changed" &&
        isOwnPerson(event.payload.memberId)
      ) {
        ownRoleChanged(event.payload.role);
        return;
      }
      if (changesInvitations(event)) {
        reloadSelected();
      }
      return;
    }
    if (
      message.frame.type === "workspace.subscribed" &&
      message.frame.workspaceId === selected
    ) {
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

  function load(): InvitationLoadOutcome {
    if (closed) {
      return refusedLoad("not_signed_in");
    }
    // The screen asked, also when it opened before it may see the
    // invitations: they then load once it may. A refusal sends nothing and
    // starts no cooldown.
    requested = true;
    if (!signedIn) {
      return refusedLoad("not_signed_in");
    }
    if (selected === null) {
      return refusedLoad("no_workspace");
    }
    if (access === "not_allowed") {
      return refusedLoad("not_allowed");
    }
    const at = now();
    if (
      lastRequest !== null &&
      at - lastRequest < INVITATION_LOAD_COOLDOWN_MS
    ) {
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

  return Object.freeze({
    state: () => current,
    onChange: (listener: (state: InvitationListState) => void) => {
      const entry = (state: InvitationListState) => listener(state);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    load: () => run(load),
    reload: (workspaceId: WorkspaceId) =>
      run(() => workspaceId === selected && reloadSelected()),
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
