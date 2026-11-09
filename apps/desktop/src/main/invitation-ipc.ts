import type { MemberId } from "@mymandev/protocol";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  INVITATION_LIMITS,
  type InvitationLoadResult,
  type InvitationStatusView,
  type InvitationsView,
  type InvitationView,
} from "../shared/ipc-contract.ts";
import {
  createEventPublisher,
  createInvokeHandler,
  type IpcRegistry,
} from "./ipc.ts";
import type {
  InvitationListState,
  InvitationListStatus,
  InvitationService,
  InvitationState,
} from "./invitations/service.ts";
import type { ScheduleTimer } from "./runtime.ts";
import type { WorkspaceService } from "./workspace/service.ts";

/**
 * The shortest time between two publishes of the invitations. A burst of
 * changes sends the latest view once at the end of it.
 */
export const INVITATION_PUBLISH_INTERVAL_MS = 50;

/**
 * Each status of the service and its status in the contract. `satisfies`
 * checks the fresh literal, so the record fails to compile when the service
 * gains or loses a status.
 */
const STATUS_VIEWS = {
  signed_out: "signed_out",
  no_workspace: "no_workspace",
  not_allowed: "not_allowed",
  loading: "loading",
  ready: "ready",
  unavailable: "unavailable",
} satisfies Record<InvitationListStatus, InvitationStatusView>;
Object.freeze(STATUS_VIEWS);

/** `text`, cut to `maxLength` characters (code points), as zod counts them. */
function cut(text: string, maxLength: number): string {
  const characters = Array.from(text);
  return characters.length > maxLength
    ? characters.slice(0, maxLength).join("")
    : text;
}

function invitationView(
  invitation: InvitationState,
  memberName: (memberId: MemberId) => string,
): InvitationView {
  return Object.freeze({
    invitationId: invitation.id,
    memberId: invitation.memberId,
    creatorName: cut(
      memberName(invitation.createdByMemberId),
      INVITATION_LIMITS.displayName,
    ),
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
  });
}

/**
 * The frozen copy of the service's state that crosses IPC, with `revision`
 * as its revision. Each invitation crosses with its ID, the member ID of
 * the person that it claims, its creator's display name, resolved with
 * `memberName` (the creator is an active member, because a removal or a
 * demotion revokes the invitations that the person created), and its
 * times; the creator's member ID stays in the main process. An invitation
 * past its `expiresAt` at `now` (milliseconds since the epoch) is left out.
 * The service holds the invitations only while the account's own person is
 * the owner or an admin of the selected workspace, so for anyone else the
 * list is empty. The API's list holds no invitation code, so none can
 * cross here.
 */
export function invitationsView(
  state: InvitationListState,
  revision: number,
  memberName: (memberId: MemberId) => string,
  now: number,
): InvitationsView {
  const fields = {
    revision,
    workspaceId: state.workspaceId,
    invitations: Object.freeze(
      state.invitations
        .filter((invitation) => Date.parse(invitation.expiresAt) > now)
        .slice(0, INVITATION_LIMITS.invitations)
        .map((invitation) => invitationView(invitation, memberName)),
    ),
  };
  const status = STATUS_VIEWS[state.status];
  if (status === "unavailable") {
    return Object.freeze({
      status,
      problem: state.problem ?? "failed",
      ...fields,
    });
  }
  return Object.freeze({ status, ...fields });
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

export interface InvitationIpcOptions {
  readonly invitations: Pick<InvitationService, "state" | "onChange" | "load">;
  readonly workspaces: Pick<WorkspaceService, "memberName" | "onChange">;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /**
   * The current time in milliseconds since the epoch, for the expiry of an
   * invitation. Defaults to `Date.now`.
   */
  readonly now?: () => number;
  /**
   * Receives a fixed message when a publish fails, never the error, so that
   * nothing that the error holds reaches a log. Defaults to
   * `console.error`.
   */
  readonly onError?: (message: string) => void;
}

export interface InvitationIpc {
  /** Stops listening and cancels a publish that waits, for the quit. */
  readonly close: () => void;
}

/**
 * Registers the handlers of the invitation state channels and sends the
 * live invitations of the selected workspace to the frames that subscribed
 * (#95, decision D3). The channels take no argument; the actions have their
 * own channels (`invitation-actions-ipc.ts`). Every handler checks the
 * sender and the arguments first (`createInvokeHandler`) and answers with a
 * value parsed by the contract, so only IDs, names, times, and fixed codes
 * reach the renderer, never a code or a user ID.
 *
 * A change of the invitation service, and a change of the workspace
 * service, which also reports a new name of a person, raise the view's
 * revision at once and publish the latest view after
 * `INVITATION_PUBLISH_INTERVAL_MS`, so at most one view goes out in each
 * interval and the last change of a burst is always sent. Call it before
 * the first window loads.
 */
export function registerInvitationIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: InvitationIpcOptions,
): InvitationIpc {
  const { invitations, workspaces } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const now = options.now ?? Date.now;
  const onError =
    options.onError ?? ((message: string) => console.error(message));
  const publisher = createEventPublisher(
    EVENT_CHANNELS.invitationStateChanged,
    appUrl,
  );

  let closed = false;
  let revision = 0;
  let cancelPublish: (() => void) | null = null;

  function view(): InvitationsView {
    return invitationsView(
      invitations.state(),
      revision,
      workspaces.memberName,
      now(),
    );
  }

  function publish(): void {
    cancelPublish = null;
    if (closed) {
      return;
    }
    try {
      publisher.publish(view());
    } catch {
      // A fixed message: the view holds no code, and the error is not
      // logged either, whatever it holds.
      onError("Sending the invitations failed.");
    }
  }

  function changed(): void {
    if (closed) {
      return;
    }
    revision += 1;
    // A publish that waits sends the latest view when its time comes.
    cancelPublish ??= schedule(publish, INVITATION_PUBLISH_INTERVAL_MS);
  }

  ipc.handle(
    INVOKE_CHANNELS.getInvitationState,
    createInvokeHandler(INVOKE_CHANNELS.getInvitationState, appUrl, () =>
      view(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribeInvitationState,
    createInvokeHandler(
      INVOKE_CHANNELS.subscribeInvitationState,
      appUrl,
      (event) => {
        publisher.add(event.sender);
        return view();
      },
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.loadInvitations,
    createInvokeHandler(
      INVOKE_CHANNELS.loadInvitations,
      appUrl,
      (): InvitationLoadResult => invitations.load(),
    ),
  );
  const removers = [
    invitations.onChange(changed),
    workspaces.onChange(changed),
  ];

  return Object.freeze({
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const remove of removers) {
        remove();
      }
      cancelPublish?.();
      cancelPublish = null;
    },
  });
}
