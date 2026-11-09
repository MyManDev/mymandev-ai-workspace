import type { MemberId } from "@mymandev/protocol";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  PEOPLE_LIMITS,
  WORKSPACE_LIMITS,
  type PeopleStatusView,
  type PeopleView,
  type PersonView,
} from "../shared/ipc-contract.ts";
import {
  createEventPublisher,
  createInvokeHandler,
  type IpcRegistry,
} from "./ipc.ts";
import type { ScheduleTimer } from "./runtime.ts";
import type {
  OwnershipOfferState,
  PersonState,
  WorkspaceService,
  WorkspaceState,
} from "./workspace/service.ts";

/**
 * The shortest time between two publishes of the people. A burst of
 * changes, such as a reload that applies many waiting membership events,
 * sends the latest people once at the end of it.
 */
export const PEOPLE_PUBLISH_INTERVAL_MS = 50;

/** `text`, cut to `maxLength` characters (code points), as zod counts them. */
function cut(text: string, maxLength: number): string {
  const characters = Array.from(text);
  return characters.length > maxLength
    ? characters.slice(0, maxLength).join("")
    : text;
}

function personView(person: PersonState): PersonView {
  return Object.freeze({
    memberId: person.id,
    displayName: cut(person.displayName, PEOPLE_LIMITS.displayName),
    role: person.role,
    claimed: person.claimed,
    login: person.identity?.login ?? null,
    verifiedAt: person.identity?.verifiedAt ?? null,
    former: person.removedAt !== null,
  });
}

/**
 * What the people view shows besides the people: the selected workspace's
 * live ownership offer and its limit of unclaimed people, as the workspace
 * service holds them, and the current time in milliseconds since the epoch.
 */
export interface PeopleViewSettings {
  readonly ownershipOffer: OwnershipOfferState | null;
  readonly unclaimedMemberLimit: number | null;
  readonly now: number;
}

const NO_SETTINGS: PeopleViewSettings = Object.freeze({
  ownershipOffer: null,
  unclaimedMemberLimit: null,
  now: 0,
});

/**
 * The frozen copy of the selected workspace's people that crosses IPC, with
 * the workspace state's revision. Each person crosses with its member ID,
 * display name, role, whether it is claimed, its GitHub login with the time
 * it was last verified, and whether it is a former member; the user ID
 * stays in the main process (the workspace service never keeps it). The
 * active people come first, in the service's order, then the former
 * members; at most `PEOPLE_LIMITS.people` cross, and `morePeople` counts
 * the rest. Names are cut to their limit. `workspaceName` is the selected
 * workspace's name from the workspace list, the same as the sidebar's, and
 * `ownMemberId` names the account's own person in it. The status is the workspace
 * service's, except that a `ready` state without a selected workspace is
 * `no_workspace`.
 *
 * The rest is as narrow as the actions need (D3), by the role of the
 * account's own active person: the live ownership offer crosses only to the
 * owner and to its target, and only before its `expiresAt`, and the limit
 * of unclaimed people only to the owner and the admins, who define them.
 */
export function peopleView(
  state: WorkspaceState,
  people: readonly PersonState[],
  ownMemberId: MemberId | null,
  settings: PeopleViewSettings = NO_SETTINGS,
): PeopleView {
  const ordered = [
    ...people.filter((person) => person.removedAt === null),
    ...people.filter((person) => person.removedAt !== null),
  ];
  const shown = ordered.slice(0, PEOPLE_LIMITS.people);
  const selected = state.workspaces.find(
    (workspace) => workspace.id === state.selectedWorkspaceId,
  );
  const own =
    state.selectedWorkspaceId === null || ownMemberId === null
      ? undefined
      : people.find(
          (person) => person.id === ownMemberId && person.removedAt === null,
        );
  const offer = settings.ownershipOffer;
  const offerShown =
    own !== undefined &&
    offer !== null &&
    (own.role === "owner" || offer.memberId === own.id) &&
    Date.parse(offer.expiresAt) > settings.now;
  const fields = {
    revision: state.revision,
    workspaceId: state.selectedWorkspaceId,
    workspaceName:
      selected === undefined ? null : cut(selected.name, WORKSPACE_LIMITS.name),
    ownMemberId: state.selectedWorkspaceId === null ? null : ownMemberId,
    people: Object.freeze(shown.map(personView)),
    morePeople: ordered.length - shown.length,
    ownershipOffer:
      offerShown && offer !== null
        ? Object.freeze({
            memberId: offer.memberId,
            expiresAt: offer.expiresAt,
          })
        : null,
    maxUnclaimedMembers:
      own?.role === "owner" || own?.role === "admin"
        ? settings.unclaimedMemberLimit
        : null,
  };
  if (state.status === "unavailable") {
    return Object.freeze({
      status: "unavailable",
      problem: state.problem ?? "failed",
      ...fields,
    });
  }
  const status: Exclude<PeopleStatusView, "unavailable"> =
    state.status === "ready" && state.selectedWorkspaceId === null
      ? "no_workspace"
      : state.status;
  return Object.freeze({ status, ...fields });
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

export interface PeopleIpcOptions {
  readonly workspaces: Pick<
    WorkspaceService,
    | "state"
    | "onChange"
    | "people"
    | "ownMemberId"
    | "ownershipOffer"
    | "unclaimedMemberLimit"
  >;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /**
   * The current time in milliseconds since the epoch, for the expiry of an
   * ownership offer. Defaults to `Date.now`.
   */
  readonly now?: () => number;
  /** Defaults to `console.error`. */
  readonly onError?: (message: string, error: unknown) => void;
}

export interface PeopleIpc {
  /** Stops listening and cancels a publish that waits, for the quit. */
  readonly close: () => void;
}

/**
 * Registers the handlers of the people channels and sends the people of
 * the selected workspace to the frames that subscribed (#95, decision D3).
 * The channels are read-only and take no argument; the actions have their
 * own channels (`people-actions-ipc.ts`). Every handler checks the sender
 * and the arguments first (`createInvokeHandler`) and answers with a view
 * parsed by the contract (`peopleView`), so only member IDs, names, roles,
 * logins, times, a count, and fixed codes reach the renderer, never a user
 * ID.
 *
 * A change of the workspace service, which also reports every change of its
 * people, publishes the latest people after `PEOPLE_PUBLISH_INTERVAL_MS`,
 * so at most one view goes out in each interval and the last change of a
 * burst is always sent. Call it before the first window loads.
 */
export function registerPeopleIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: PeopleIpcOptions,
): PeopleIpc {
  const { workspaces } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const now = options.now ?? Date.now;
  const onError =
    options.onError ??
    ((message: string, error: unknown) => console.error(message, error));
  const publisher = createEventPublisher(
    EVENT_CHANNELS.peopleStateChanged,
    appUrl,
  );

  let closed = false;
  let cancelPublish: (() => void) | null = null;

  function view(): PeopleView {
    const state = workspaces.state();
    const selected = state.selectedWorkspaceId;
    return peopleView(
      state,
      workspaces.people(),
      selected === null ? null : workspaces.ownMemberId(selected),
      {
        ownershipOffer: workspaces.ownershipOffer(),
        unclaimedMemberLimit: workspaces.unclaimedMemberLimit(),
        now: now(),
      },
    );
  }

  function publish(): void {
    cancelPublish = null;
    if (closed) {
      return;
    }
    try {
      publisher.publish(view());
    } catch (error) {
      onError("Sending the people failed.", error);
    }
  }

  function changed(): void {
    if (closed) {
      return;
    }
    // A publish that waits sends the latest view when its time comes.
    cancelPublish ??= schedule(publish, PEOPLE_PUBLISH_INTERVAL_MS);
  }

  ipc.handle(
    INVOKE_CHANNELS.getPeopleState,
    createInvokeHandler(INVOKE_CHANNELS.getPeopleState, appUrl, () => view()),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribePeopleState,
    createInvokeHandler(
      INVOKE_CHANNELS.subscribePeopleState,
      appUrl,
      (event) => {
        publisher.add(event.sender);
        return view();
      },
    ),
  );
  const removeListener = workspaces.onChange(changed);

  return Object.freeze({
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      removeListener();
      cancelPublish?.();
      cancelPublish = null;
    },
  });
}
