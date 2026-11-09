// The workspace service (#27, #28): the account's workspaces, the selected
// workspace with its people and projects, and the open project, in the main
// process. It reads them over HTTP with the account service's
// `readWorkspaceData` and keeps them current with the workspace's events.
// Read-only: creating workspaces and projects stays with #95.
//
// - The list (`GET /workspaces`) loads whenever a signed-in device's
//   connection reaches `connected`, because account frames sent while it was
//   offline are lost. One load at a time; a trigger during a load makes its
//   answer stale and loads again. A failed load is retried with a backoff.
// - The selection is kept in memory only. It defaults to the first workspace
//   of the list, the most recently claimed (decided on #27 on 2026-11-05).
//   Only the selected workspace is subscribed.
// - After each `workspace.subscribed` of the selected workspace, its view and
//   its projects are reloaded through the service's own resync gate, and
//   the events that arrived meanwhile are applied after the reload.
// - The selected workspace's people come from its view and follow the
//   membership events (#95, decision D3): each person's display name, role,
//   whether it is claimed, the GitHub login with the time it was last
//   verified, and whether it was removed. The user IDs are never kept.
// - The selected workspace's live ownership offer and its limit of unclaimed
//   people come from its view (#95, D3). No workspace event reports an
//   offer or its end, so the account frames of an offer, and the people
//   actions after an offer or its withdrawal, reload the view.
// - When the membership ends or the subscription is refused, the
//   subscription is dropped from the connection client, which would
//   otherwise send it again after every `auth.ok`, the list is reloaded, and
//   the first remaining workspace is selected.
//
// Presence frames are ignored: no issue owns showing presence yet. Nothing
// secret, no user ID, and no name reaches the state or a log; the logs are
// fixed text with a failure code at most.
import type {
  MemberId,
  MemberRole,
  ProjectId,
  ProjectListResponse,
  ReceivedServerEvent,
  WorkspaceId,
  WorkspaceListResponse,
  WorkspaceMember,
  WorkspaceViewResponse,
} from "@mymandev/protocol";
import type { AccountStatus } from "../../shared/ipc-contract.ts";
import type { AccountService } from "../account.ts";
import type {
  WorkspaceReadFailure,
  WorkspaceReadResult,
} from "../api-reads.ts";
import type { ConnectionClient, ServerMessage } from "../connection/client.ts";
import type { ScheduleTimer } from "../runtime.ts";
import { createResyncGate } from "./resync.ts";

/** The first delay after a failed load; it doubles with each failure. */
export const WORKSPACE_RETRY_BASE_MS = 2_000;
/** The longest delay after a failed load. */
export const WORKSPACE_RETRY_MAX_MS = 60_000;
/**
 * The delay after `rate_limited`. The reads do not read `Retry-After`, so
 * the wait is fixed (the API reads, decided on 2026-11-05).
 */
export const RATE_LIMITED_RETRY_MS = 60_000;

/** The name shown for a person that the selected workspace does not hold. */
export const UNKNOWN_MEMBER_NAME = "Unknown person";

/**
 * The delay before the retry after `attempt` failures in a row (from 0):
 * `RATE_LIMITED_RETRY_MS` after `rate_limited`, otherwise
 * min(`WORKSPACE_RETRY_MAX_MS`, `WORKSPACE_RETRY_BASE_MS` x 2^attempt).
 */
export function workspaceRetryDelayMs(
  attempt: number,
  reason: WorkspaceReadFailure,
): number {
  if (reason === "rate_limited") {
    return RATE_LIMITED_RETRY_MS;
  }
  return Math.min(
    WORKSPACE_RETRY_MAX_MS,
    WORKSPACE_RETRY_BASE_MS * 2 ** Math.min(attempt, 30),
  );
}

/**
 * - `signed_out`: no signed-in device with a ready key; the state is empty.
 * - `loading`: the list, or the selected workspace's people and projects,
 *   have not loaded yet for this device.
 * - `ready`: the list loaded, and so did the selected workspace, if any.
 *   It stays `ready` during later reloads, which `gateLive` reports.
 * - `unavailable`: the last load of the list or of the selected workspace
 *   failed; a retry waits, or, after a failure while offline, the next
 *   connection loads again. `problem` holds the failure. What was loaded
 *   before stays.
 */
export type WorkspaceServiceStatus =
  "signed_out" | "loading" | "ready" | "unavailable";

export interface WorkspaceSummary {
  readonly id: WorkspaceId;
  readonly name: string;
}

export interface ProjectSummary {
  readonly id: ProjectId;
  readonly name: string;
  readonly createdByMemberId: MemberId;
}

/** The GitHub account that claimed a person, as the service keeps it. */
export interface PersonIdentity {
  readonly login: string;
  /** When the login was last verified, an ISO 8601 time in UTC. */
  readonly verifiedAt: string;
}

/**
 * A person of the selected workspace (ADR 0014, "People and roles"), as the
 * service keeps it: never the user ID of the account that claimed it.
 */
export interface PersonState {
  readonly id: MemberId;
  readonly displayName: string;
  readonly role: MemberRole;
  /** Whether an account claimed the person. */
  readonly claimed: boolean;
  /**
   * The GitHub login of the account that claimed the person; null while it
   * is unclaimed, and for a former member whose account's data was erased.
   */
  readonly identity: PersonIdentity | null;
  /** When the person was removed or left; null while it is active. */
  readonly removedAt: string | null;
}

/**
 * The live ownership offer of the selected workspace (ADR 0014, "Removal
 * and ownership"), as the service keeps it: the target and when the offer
 * expires. An offer past `expiresAt` is no offer.
 */
export interface OwnershipOfferState {
  readonly memberId: MemberId;
  /** An ISO 8601 time in UTC. */
  readonly expiresAt: string;
}

/** The service's state. Every value is frozen. */
export interface WorkspaceState {
  /**
   * Grows by one with every change, also when only `gateLive`,
   * `memberName`, or `people` would answer differently.
   */
  readonly revision: number;
  readonly status: WorkspaceServiceStatus;
  /** Only with `unavailable`. */
  readonly problem?: WorkspaceReadFailure;
  /** In the server's order, the most recently claimed first. */
  readonly workspaces: readonly WorkspaceSummary[];
  readonly selectedWorkspaceId: WorkspaceId | null;
  /** The selected workspace's projects, the oldest first. */
  readonly projects: readonly ProjectSummary[];
  readonly openProjectId: ProjectId | null;
}

/** The part of the account service that the workspace service uses. */
export type WorkspaceAccount = Pick<
  AccountService,
  "status" | "onStatusChange" | "readWorkspaceData"
>;

/** The part of the connection client that the workspace service uses. */
export type WorkspaceConnection = Pick<
  ConnectionClient,
  | "status"
  | "onStatusChange"
  | "onMessage"
  | "subscribeWorkspace"
  | "unsubscribeWorkspace"
>;

export interface WorkspaceServiceOptions {
  readonly account: WorkspaceAccount;
  readonly connection: WorkspaceConnection;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /**
   * Receives fixed messages with a failure code at most, never a name or an
   * ID. An error that it throws is ignored.
   */
  readonly log?: (message: string) => void;
}

export interface WorkspaceService {
  /** The current state. */
  readonly state: () => WorkspaceState;
  /** Calls `listener` after every change. The result removes the listener. */
  readonly onChange: (listener: (state: WorkspaceState) => void) => () => void;
  /**
   * Selects a workspace of the list and subscribes to it instead of the
   * previous one; the open project closes. False for a workspace that the
   * list does not hold. Selecting the selected workspace changes nothing.
   */
  readonly select: (workspaceId: WorkspaceId) => boolean;
  /**
   * Opens a project of the selected workspace, or closes the open one with
   * null. False for a project that the selected workspace does not hold.
   */
  readonly openProject: (projectId: ProjectId | null) => boolean;
  /**
   * The display name of a person of the selected workspace, also of a former
   * member, for a chat message's author; `UNKNOWN_MEMBER_NAME` for a person
   * that it does not hold.
   */
  readonly memberName: (memberId: MemberId) => string;
  /**
   * The people of the selected workspace, former members included, as a
   * frozen list: in the order of the last reload, which is the server's,
   * with the people that events added since at the end. Empty until the
   * selected workspace's view has loaded. The people screen reads it.
   */
  readonly people: () => readonly PersonState[];
  /**
   * The selected workspace's live ownership offer from its last reload, or
   * null: none, or not loaded yet. A transfer to its target and the
   * target's removal end it at once; an offer, its withdrawal, and its
   * expiry show after the next reload, which the account frames of the
   * offer's target and `reload` begin. It may be past its `expiresAt`.
   */
  readonly ownershipOffer: () => OwnershipOfferState | null;
  /**
   * How many active unclaimed people the selected workspace may hold, from
   * its last reload, or null until it loaded.
   */
  readonly unclaimedMemberLimit: () => number | null;
  /**
   * Reloads the selected workspace's view and projects through the resync
   * gate, for a change that no workspace event reports, such as an
   * ownership offer or its withdrawal. False, with nothing read, for
   * another workspace, and while it is not subscribed, because the next
   * `workspace.subscribed` reloads it anyway.
   */
  readonly reload: (workspaceId: WorkspaceId) => boolean;
  /**
   * Whether `workspaceId` is the selected workspace, subscribed, and
   * reloaded since its last `workspace.subscribed`, with no reload open. The
   * chat and agent services and the development switch send events for a
   * workspace only while this holds.
   */
  readonly gateLive: (workspaceId: WorkspaceId) => boolean;
  /** The selected workspace, or null. */
  readonly selectedWorkspaceId: () => WorkspaceId | null;
  /**
   * The account's own person in a workspace of the list, from the list's
   * answer, or null for a workspace that the list does not hold. The
   * development switch checks an agent's owner with it, and the people
   * screen marks the account's own person.
   */
  readonly ownMemberId: (workspaceId: WorkspaceId) => MemberId | null;
  /** Stops listening and cancels the timers, for the quit. */
  readonly close: () => void;
}

const WORKSPACE_EVENT_TYPES = Object.freeze([
  "workspace.member.defined",
  "workspace.member.claimed",
  "workspace.member.renamed",
  "workspace.member.removed",
  "workspace.member.role_changed",
  "workspace.ownership.transferred",
  "workspace.project.created",
  "workspace.project.renamed",
] as const);
type WorkspaceEventType = (typeof WORKSPACE_EVENT_TYPES)[number];
const workspaceEventTypes: ReadonlySet<string> = new Set(WORKSPACE_EVENT_TYPES);

/** The events that this service applies. */
export type WorkspaceEvent = Extract<
  ReceivedServerEvent,
  { type: WorkspaceEventType }
>;

function isWorkspaceEvent(event: ReceivedServerEvent): event is WorkspaceEvent {
  return workspaceEventTypes.has(event.type);
}

function projectSummary(project: {
  readonly id: ProjectId;
  readonly name: string;
  readonly createdByMemberId: MemberId;
}): ProjectSummary {
  return Object.freeze({
    id: project.id,
    name: project.name,
    createdByMemberId: project.createdByMemberId,
  });
}

/** A person of the protocol as the service keeps it, without the user ID. */
function personState(member: WorkspaceMember): PersonState {
  return Object.freeze({
    id: member.id,
    displayName: member.displayName,
    role: member.role,
    claimed: member.userId !== null,
    identity:
      member.identity === null
        ? null
        : Object.freeze({
            login: member.identity.login,
            verifiedAt: member.identity.verifiedAt,
          }),
    removedAt: member.removedAt,
  });
}

function samePerson(held: PersonState, next: PersonState): boolean {
  return (
    held.displayName === next.displayName &&
    held.role === next.role &&
    held.claimed === next.claimed &&
    held.removedAt === next.removedAt &&
    held.identity?.login === next.identity?.login &&
    held.identity?.verifiedAt === next.identity?.verifiedAt
  );
}

/**
 * The signed-in device, or null: the same condition under which the
 * connection client connects. The device ID is kept only to notice a change
 * of the device; it never reaches the state or a log.
 */
function signedInDevice(status: AccountStatus): string | null {
  if (
    status.apiOrigin === "set" &&
    status.device === "signed_in" &&
    status.deviceKey === "ready" &&
    status.account.kind === "signed_in"
  ) {
    return status.account.deviceId;
  }
  return null;
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

const NO_WORKSPACES: readonly WorkspaceSummary[] = Object.freeze([]);
const NO_PROJECTS: readonly ProjectSummary[] = Object.freeze([]);
const NO_PEOPLE: readonly PersonState[] = Object.freeze([]);

export function createWorkspaceService(
  options: WorkspaceServiceOptions,
): WorkspaceService {
  const { account, connection } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;

  function log(message: string): void {
    try {
      options.log?.(message);
    } catch {
      // A failing log changes nothing.
    }
  }

  let closed = false;
  /** The signed-in device, compared only; see `signedInDevice`. */
  let device: string | null = null;
  /** Changes with every reset, so that an answer for an earlier device is dropped. */
  let epoch = 0;
  let connected = false;

  let workspaces = NO_WORKSPACES;
  /** The account's own person in each listed workspace. */
  let ownMembers = new Map<WorkspaceId, MemberId>();
  let listLoaded = false;
  let listProblem: WorkspaceReadFailure | null = null;
  let listInFlight = false;
  /** A trigger arrived during the load: its answer is stale. */
  let listAgain = false;
  let listAttempt = 0;
  let cancelListRetry: (() => void) | null = null;
  /**
   * Workspaces that refused the subscription. They are never selected by
   * default, so that a list that still holds one does not subscribe to it
   * again and again; the person can still select it. A list without one
   * drops it, so that a later listing, a new membership, counts again.
   */
  const refused = new Set<WorkspaceId>();

  let selected: WorkspaceId | null = null;
  const gate = createResyncGate<WorkspaceEvent>({
    sizeOf: (event) => Buffer.byteLength(JSON.stringify(event), "utf8"),
  });
  let viewLoaded = false;
  let viewProblem: WorkspaceReadFailure | null = null;
  let viewAttempt = 0;
  let cancelViewRetry: (() => void) | null = null;
  /**
   * Each person of the selected workspace, former members included, in the
   * order of the last reload, with the people that events added since at
   * the end. Never a user ID.
   */
  let members = new Map<MemberId, PersonState>();
  /** The frozen list of `members` for `people`, or null after a change. */
  let peopleList: readonly PersonState[] | null = NO_PEOPLE;
  let ownershipOffer: OwnershipOfferState | null = null;
  let unclaimedMemberLimit: number | null = null;
  let projects = NO_PROJECTS;
  let openProjectId: ProjectId | null = null;

  let revision = 0;
  let dirty = false;
  let current = buildState();
  const listeners = new Set<(state: WorkspaceState) => void>();

  function buildState(): WorkspaceState {
    const base = {
      revision,
      workspaces,
      selectedWorkspaceId: selected,
      projects,
      openProjectId,
    };
    if (device === null) {
      return Object.freeze({ ...base, status: "signed_out" });
    }
    const problem = listProblem ?? viewProblem;
    if (problem !== null) {
      return Object.freeze({ ...base, status: "unavailable", problem });
    }
    const loading = !listLoaded || (selected !== null && !viewLoaded);
    return Object.freeze({ ...base, status: loading ? "loading" : "ready" });
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
        log("A workspace state listener failed.");
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

  function stopListRetry(): void {
    cancelListRetry?.();
    cancelListRetry = null;
  }

  function stopViewRetry(): void {
    cancelViewRetry?.();
    cancelViewRetry = null;
  }

  function endSubscription(): void {
    gate.end();
    stopViewRetry();
    touch();
  }

  /** Forgets everything: a sign-out, or another device. */
  function reset(): void {
    epoch += 1;
    stopListRetry();
    stopViewRetry();
    if (selected !== null) {
      connection.unsubscribeWorkspace(selected);
    }
    gate.end();
    workspaces = NO_WORKSPACES;
    ownMembers = new Map();
    listLoaded = false;
    listProblem = null;
    listInFlight = false;
    listAgain = false;
    listAttempt = 0;
    refused.clear();
    selected = null;
    clearWorkspaceData();
    touch();
  }

  function clearWorkspaceData(): void {
    viewLoaded = false;
    viewProblem = null;
    viewAttempt = 0;
    members = new Map();
    peopleList = NO_PEOPLE;
    ownershipOffer = null;
    unclaimedMemberLimit = null;
    projects = NO_PROJECTS;
    openProjectId = null;
  }

  function listed(workspaceId: WorkspaceId): boolean {
    return workspaces.some((workspace) => workspace.id === workspaceId);
  }

  function defaultWorkspace(): WorkspaceId | null {
    return (
      workspaces.find((workspace) => !refused.has(workspace.id))?.id ?? null
    );
  }

  /** Subscribes to `workspaceId` instead of the selected workspace. */
  function selectWorkspace(workspaceId: WorkspaceId | null): void {
    if (workspaceId === selected) {
      return;
    }
    if (selected !== null) {
      connection.unsubscribeWorkspace(selected);
    }
    gate.end();
    stopViewRetry();
    clearWorkspaceData();
    selected = workspaceId;
    if (workspaceId !== null) {
      // Sent at once while connected, otherwise after the next `auth.ok`.
      connection.subscribeWorkspace(workspaceId);
    }
    touch();
  }

  // The list.

  function loadList(): void {
    if (closed || device === null) {
      return;
    }
    stopListRetry();
    if (listInFlight) {
      listAgain = true;
      return;
    }
    listInFlight = true;
    const at = epoch;
    account.readWorkspaceData("listWorkspaces", {}).then(
      (result) => run(() => listAnswered(at, result)),
      () => run(() => listAnswered(at, { ok: false, reason: "unavailable" })),
    );
  }

  function listAnswered(
    at: number,
    result: WorkspaceReadResult<WorkspaceListResponse>,
  ): void {
    if (closed || at !== epoch) {
      return;
    }
    listInFlight = false;
    if (listAgain) {
      listAgain = false;
      loadList();
      return;
    }
    if (!result.ok) {
      listProblem = result.reason;
      touch();
      log(`The workspace list did not load (${result.reason}).`);
      const delay = workspaceRetryDelayMs(listAttempt, result.reason);
      listAttempt += 1;
      if (connected) {
        // Offline, the next `connected` loads anyway.
        cancelListRetry = schedule(() => {
          run(() => {
            cancelListRetry = null;
            loadList();
          });
        }, delay);
      }
      return;
    }
    listAttempt = 0;
    listProblem = null;
    listLoaded = true;
    workspaces = Object.freeze(
      result.value.workspaces.map(({ workspace }) =>
        Object.freeze({ id: workspace.id, name: workspace.name }),
      ),
    );
    ownMembers = new Map(
      result.value.workspaces.map(({ workspace, member }) => [
        workspace.id,
        member.id,
      ]),
    );
    // A refused workspace that the list no longer holds is forgotten, so
    // that a later listing, a new membership, is selected by default again.
    // One that the list still holds stays refused, so that it is not
    // subscribed to in a loop.
    for (const workspaceId of [...refused]) {
      if (!listed(workspaceId)) {
        refused.delete(workspaceId);
      }
    }
    touch();
    if (selected === null || !listed(selected)) {
      selectWorkspace(defaultWorkspace());
    }
  }

  // The selected workspace's people and projects.

  function startReload(generation: number): void {
    const workspaceId = selected;
    if (workspaceId === null) {
      return;
    }
    stopViewRetry();
    touch();
    const at = epoch;
    Promise.all([
      account.readWorkspaceData("getWorkspace", { workspaceId }),
      account.readWorkspaceData("listProjects", { workspaceId }),
    ]).then(
      ([view, list]) =>
        run(() => reloadAnswered(at, workspaceId, generation, view, list)),
      () =>
        run(() =>
          reloadAnswered(
            at,
            workspaceId,
            generation,
            { ok: false, reason: "unavailable" },
            { ok: false, reason: "unavailable" },
          ),
        ),
    );
  }

  function reloadAnswered(
    at: number,
    workspaceId: WorkspaceId,
    generation: number,
    view: WorkspaceReadResult<WorkspaceViewResponse>,
    list: WorkspaceReadResult<ProjectListResponse>,
  ): void {
    if (closed || at !== epoch || workspaceId !== selected) {
      return;
    }
    if (
      !view.ok ||
      !list.ok ||
      view.value.workspace.id !== workspaceId ||
      list.value.projects.some((project) => project.workspaceId !== workspaceId)
    ) {
      const reason = !view.ok ? view.reason : !list.ok ? list.reason : "failed";
      if (!gate.reloadFailed(generation)) {
        return;
      }
      viewProblem = reason;
      touch();
      log(`The selected workspace did not load (${reason}).`);
      if (reason === "not_found") {
        // Most likely the membership ended; the list tells.
        loadList();
      }
      scheduleReload(workspaceRetryDelayMs(viewAttempt, reason));
      viewAttempt += 1;
      return;
    }
    const events = gate.reloaded(generation);
    if (events === null) {
      return;
    }
    members = new Map(
      view.value.members.map((member) => [member.id, personState(member)]),
    );
    peopleList = null;
    const offer = view.value.ownershipOffer;
    ownershipOffer =
      offer === null
        ? null
        : Object.freeze({
            memberId: offer.memberId,
            expiresAt: offer.expiresAt,
          });
    unclaimedMemberLimit = view.value.maxUnclaimedMembers;
    projects = Object.freeze(list.value.projects.map(projectSummary));
    for (const event of events) {
      // The reload is newer than an event that it already holds, and an
      // event that names something unknown here cannot be resolved by
      // another reload, so it is skipped.
      applyEvent(event);
    }
    viewLoaded = true;
    viewProblem = null;
    viewAttempt = 0;
    closeVanishedProject();
    touch();
  }

  /** Begins a reload after `delayMs`, unless the workspace changed. */
  function scheduleReload(delayMs: number): void {
    stopViewRetry();
    const workspaceId = selected;
    cancelViewRetry = schedule(() => {
      run(() => {
        cancelViewRetry = null;
        const state = gate.state();
        if (
          workspaceId === selected &&
          (state === "failed" || state === "overflowed")
        ) {
          startReload(gate.begin("all").generation);
        }
      });
    }, delayMs);
  }

  function closeVanishedProject(): void {
    if (
      openProjectId !== null &&
      !projects.some((project) => project.id === openProjectId)
    ) {
      openProjectId = null;
    }
  }

  // The events.

  /**
   * Keeps `person`, in its place when it is held and at the end otherwise,
   * and touches the state only when it changes.
   */
  function setPerson(person: PersonState): void {
    const held = members.get(person.id);
    if (held !== undefined && samePerson(held, person)) {
      return;
    }
    members.set(person.id, person);
    peopleList = null;
    touch();
  }

  /** Changes a held person; false when the workspace does not hold it. */
  function changePerson(
    memberId: MemberId,
    change: Partial<Pick<PersonState, "displayName" | "role" | "removedAt">>,
  ): boolean {
    const held = members.get(memberId);
    if (held === undefined) {
      return false;
    }
    setPerson(Object.freeze({ ...held, ...change }));
    return true;
  }

  /** Ends the held ownership offer when it names `memberId`. */
  function endOfferTo(memberId: MemberId): void {
    if (ownershipOffer?.memberId === memberId) {
      ownershipOffer = null;
      touch();
    }
  }

  /**
   * Applies one event. Every event sets the state that it reports, so
   * applying one again changes nothing. False, with nothing changed, when it
   * names a person or a project that the workspace does not hold. A removed
   * person stays as a former member with their name and role.
   *
   * The removal of an offer's target and the transfer to it end the held
   * offer: an offer names an active person who is not the owner, and a
   * removed person never becomes active again, so a replay never ends a
   * newer offer either.
   *
   * The replay rule: `defined` is the first event of a person's life, and a
   * claim happens once, so `defined` for a person that the service holds,
   * and `claimed` for a person held as claimed, can only be replays, for
   * example events that waited during a reload whose answer is newer. They
   * change nothing, so a replay never undoes a removal, a role change, a
   * rename, a newer verification of the login, or the erasure of a former
   * member's account. A claim of a held unclaimed person, or of a person
   * that the service does not hold, sets the whole person from the event.
   */
  function applyEvent(event: WorkspaceEvent): boolean {
    switch (event.type) {
      case "workspace.member.defined":
        if (!members.has(event.payload.member.id)) {
          setPerson(personState(event.payload.member));
        }
        return true;
      case "workspace.member.claimed":
        if (members.get(event.payload.member.id)?.claimed !== true) {
          setPerson(personState(event.payload.member));
        }
        return true;
      case "workspace.member.renamed":
        return changePerson(event.payload.memberId, {
          displayName: event.payload.displayName,
        });
      case "workspace.member.removed":
        if (!members.has(event.payload.memberId)) {
          return false;
        }
        endOfferTo(event.payload.memberId);
        return changePerson(event.payload.memberId, {
          removedAt: event.payload.removedAt,
        });
      case "workspace.member.role_changed":
        return changePerson(event.payload.memberId, {
          role: event.payload.role,
        });
      case "workspace.ownership.transferred": {
        const { previousOwnerMemberId, ownerMemberId } = event.payload;
        if (
          !members.has(previousOwnerMemberId) ||
          !members.has(ownerMemberId)
        ) {
          return false;
        }
        // The transfer demotes the owner to admin and promotes the target.
        changePerson(previousOwnerMemberId, { role: "admin" });
        changePerson(ownerMemberId, { role: "owner" });
        endOfferTo(ownerMemberId);
        return true;
      }
      case "workspace.project.created": {
        const project = projectSummary(event.payload.project);
        const held = projects.find((entry) => entry.id === project.id);
        if (
          held?.name === project.name &&
          held.createdByMemberId === project.createdByMemberId
        ) {
          return true;
        }
        touch();
        projects = Object.freeze(
          projects.some((held) => held.id === project.id)
            ? projects.map((held) => (held.id === project.id ? project : held))
            : [...projects, project],
        );
        return true;
      }
      case "workspace.project.renamed": {
        const { projectId, name } = event.payload;
        const held = projects.find((entry) => entry.id === projectId);
        if (held === undefined) {
          return false;
        }
        if (held.name === name) {
          return true;
        }
        projects = Object.freeze(
          projects.map((held) =>
            held.id === projectId ? Object.freeze({ ...held, name }) : held,
          ),
        );
        touch();
        return true;
      }
    }
  }

  function eventReceived(event: ReceivedServerEvent): void {
    if (!isWorkspaceEvent(event) || event.workspaceId !== selected) {
      return;
    }
    switch (gate.push(event)) {
      case "apply":
        if (!applyEvent(event)) {
          // Something was missed: the workspace reloads.
          startReload(gate.begin("all").generation);
        }
        return;
      case "overflowed":
        log("Too many workspace events waited; the workspace reloads.");
        scheduleReload(workspaceRetryDelayMs(viewAttempt, "unavailable"));
        viewAttempt += 1;
        return;
      case "buffered":
      case "dropped":
      case "ignored":
        return;
    }
  }

  // The frames.

  /** Reloads the selected workspace while it is subscribed; see `reload`. */
  function reloadSelected(workspaceId: WorkspaceId): boolean {
    if (workspaceId !== selected || gate.state() === "inactive") {
      return false;
    }
    startReload(gate.begin("all").generation);
    return true;
  }

  /**
   * The membership ended or the subscription was refused: the subscription
   * leaves the connection client's set, so that it is not sent again after
   * the next `auth.ok`. For the selected workspace, the first remaining one
   * is selected. The list then reloads.
   */
  function membershipLost(workspaceId: WorkspaceId): void {
    connection.unsubscribeWorkspace(workspaceId);
    ownMembers.delete(workspaceId);
    if (listed(workspaceId)) {
      workspaces = Object.freeze(
        workspaces.filter((workspace) => workspace.id !== workspaceId),
      );
      touch();
    }
    if (workspaceId === selected) {
      selectWorkspace(defaultWorkspace());
    }
    loadList();
  }

  function messageReceived(message: ServerMessage): void {
    if (device === null) {
      return;
    }
    if (message.kind === "event") {
      eventReceived(message.event);
      return;
    }
    const frame = message.frame;
    switch (frame.type) {
      case "workspace.subscribed":
        // `onlineMemberIds` is presence, which this service ignores.
        if (frame.workspaceId === selected) {
          startReload(gate.subscribed());
        }
        return;
      case "workspace.subscribe_refused":
        if (frame.workspaceId === selected) {
          log(`The workspace subscription was refused (${frame.code}).`);
          refused.add(frame.workspaceId);
          membershipLost(frame.workspaceId);
        } else {
          // A late answer for an earlier selection.
          connection.unsubscribeWorkspace(frame.workspaceId);
        }
        return;
      case "workspace.unsubscribed":
        if (frame.reason === "membership_ended") {
          membershipLost(frame.workspaceId);
        } else if (frame.workspaceId === selected) {
          // The answer to an earlier unsubscribe of a workspace that was
          // selected again; its `workspace.subscribed` follows.
          endSubscription();
        }
        return;
      case "account.removed_from_workspace":
        membershipLost(frame.workspaceId);
        return;
      case "account.join_request_decided":
        if (frame.decision === "approved") {
          refused.delete(frame.workspaceId);
          loadList();
        }
        return;
      case "account.ownership_offered":
      case "account.ownership_offer_ended":
        // Only the target's account gets them, and no workspace event
        // follows. The view is read again rather than set from the frame,
        // so that an older reload answer can never undo it.
        reloadSelected(frame.workspaceId);
        return;
      default:
        // Presence (no issue owns it yet), event refusals (the chat and
        // agent services), and the other account frames.
        return;
    }
  }

  // The account and the connection.

  function accountChanged(status: AccountStatus): void {
    const next = signedInDevice(status);
    if (next === device) {
      return;
    }
    if (device !== null) {
      reset();
    }
    device = next;
    touch();
    if (device !== null && connected) {
      loadList();
    }
  }

  function connectionChanged(state: string): void {
    const now = state === "connected";
    if (now === connected) {
      return;
    }
    connected = now;
    if (!now) {
      // A lost connection ends the subscription; the next
      // `workspace.subscribed` reloads.
      stopListRetry();
      endSubscription();
      return;
    }
    // Account frames sent while offline are lost: the list reloads.
    loadList();
  }

  const removers = [
    account.onStatusChange((status) => run(() => accountChanged(status))),
    connection.onStatusChange((status) =>
      run(() => connectionChanged(status.state)),
    ),
    connection.onMessage((message) => run(() => messageReceived(message))),
  ];
  accountChanged(account.status());
  connectionChanged(connection.status().state);
  // The first state is revision 0.
  current = buildState();
  dirty = false;

  return Object.freeze({
    state: () => current,
    onChange: (listener: (state: WorkspaceState) => void) => {
      const entry = (state: WorkspaceState) => listener(state);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    select: (workspaceId: WorkspaceId) =>
      run(() => {
        if (closed || device === null || !listed(workspaceId)) {
          return false;
        }
        refused.delete(workspaceId);
        selectWorkspace(workspaceId);
        return true;
      }),
    openProject: (projectId: ProjectId | null) =>
      run(() => {
        if (closed || device === null) {
          return false;
        }
        if (
          projectId !== null &&
          !projects.some((project) => project.id === projectId)
        ) {
          return false;
        }
        if (projectId !== openProjectId) {
          openProjectId = projectId;
          touch();
        }
        return true;
      }),
    ownershipOffer: () => ownershipOffer,
    unclaimedMemberLimit: () => unclaimedMemberLimit,
    reload: (workspaceId: WorkspaceId) =>
      run(() => !closed && device !== null && reloadSelected(workspaceId)),
    memberName: (memberId: MemberId) =>
      members.get(memberId)?.displayName ?? UNKNOWN_MEMBER_NAME,
    people: () => {
      peopleList ??= Object.freeze([...members.values()]);
      return peopleList;
    },
    gateLive: (workspaceId: WorkspaceId) =>
      !closed && workspaceId === selected && gate.state() === "live",
    selectedWorkspaceId: () => selected,
    ownMemberId: (workspaceId: WorkspaceId) =>
      closed ? null : (ownMembers.get(workspaceId) ?? null),
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const remove of removers) {
        remove();
      }
      listeners.clear();
      stopListRetry();
      stopViewRetry();
      gate.end();
    },
  });
}
