import type {
  AccountBridge,
  AgentBridge,
  ChatBridge,
  ClaimMarksBridge,
  ClaimsBridge,
  ConnectionBridge,
  DesktopBridge,
  DeviceListBridge,
  GrantBridge,
  ProviderConnectionsBridge,
  InvitationActionsBridge,
  InvitationsBridge,
  JoinRequestActionsBridge,
  JoinRequestsBridge,
  OwnJoinRequestActionsBridge,
  OwnJoinRequestsBridge,
  PeopleActionsBridge,
  PeopleBridge,
  ProjectRepositoriesBridge,
  RepositoryBridge,
  RuntimeBridge,
  WorkspaceBridge,
} from "../shared/desktop-bridge.ts";
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type EventChannel,
  type InvokeChannel,
} from "../shared/ipc-channels.ts";
import type {
  AcceptInvitationResult,
  AccountStatus,
  AgentActivityView,
  AgentGrantsResult,
  ApproveJoinRequestResult,
  ChatLoadOlderResultView,
  ChatSendResultView,
  ChatView,
  ClaimLoadResult,
  ClaimMarkSeenResult,
  ClaimMarksView,
  ClaimsView,
  ConnectionStatus,
  CopyWorkspaceIdResult,
  CreateInvitationResult,
  CreateJoinRequestResult,
  CreateProjectResult,
  CreateWorkspaceResult,
  DefinePersonResult,
  DeviceListLoadResult,
  DeviceListView,
  ForgetResult,
  GrantCapabilityResult,
  GrantRequestView,
  GrantsView,
  InvitationLoadResult,
  InvitationsView,
  JoinRequestActionResult,
  JoinRequestLoadResult,
  JoinRequestsView,
  LiftRegistrationLockResult,
  LinkRepositoryResult,
  MountResult,
  OtherDeviceRevocation,
  OwnJoinRequestLoadResult,
  OwnJoinRequestsView,
  PeopleView,
  PersonActionResult,
  PreviewInvitationResult,
  ProjectRepositoriesView,
  ProviderConnectionListView,
  ProviderConnectionsResult,
  ReconnectResult,
  RegisterProviderConnectionResult,
  RegisterRepositoryResult,
  RemoveDeviceResult,
  RemoveProviderConnectionResult,
  RemoveProviderKeyResult,
  SaveProviderKeyResult,
  RemoveRepositoryResult,
  RevokeGrantResult,
  RevokeInvitationResult,
  RevokeOtherDeviceResult,
  RepositoryList,
  RunRequestOutcome,
  RunRequestResult,
  RunRequestView,
  RuntimeStatus,
  SignOutResult,
  StartSignInOptions,
  StartSignInResult,
  UnlinkRepositoryResult,
  UnlockResult,
  WithdrawJoinRequestResult,
  WorkspaceActionResult,
  WorkspaceSwitchOptions,
  WorkspaceView,
} from "../shared/ipc-contract.ts";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

/**
 * The reason of a revocation that the bridge passes on: one of its own two
 * strings, never another value of the renderer.
 */
function revocationOf(reason: unknown): OtherDeviceRevocation | null {
  switch (reason) {
    case "removed":
      return "removed";
    case "lost":
      return "lost";
    default:
      return null;
  }
}

/**
 * The only start option that the bridge passes on (#175): a fixed object of
 * its own, never the renderer's.
 */
const OTHER_BROWSER_START: StartSignInOptions = Object.freeze({
  browser: "other",
});

/**
 * The only switch option that the bridge passes on: a fixed object of its
 * own, never the renderer's.
 */
const DISCARD_WAITING: WorkspaceSwitchOptions = Object.freeze({
  discardWaiting: true,
});

/** Whether the renderer asked to discard the chat messages that wait. */
function discardsWaiting(options: unknown): boolean {
  return (
    typeof options === "object" &&
    options !== null &&
    (options as { readonly discardWaiting?: unknown }).discardWaiting === true
  );
}

/** Whether the renderer asked for a sign-in in another browser. */
function asksForOtherBrowser(options: unknown): boolean {
  return (
    typeof options === "object" &&
    options !== null &&
    (options as { readonly browser?: unknown }).browser === "other"
  );
}

/** The part of Electron's `ipcRenderer` that the bridge uses. */
export interface BridgeIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
}

type ReportError = (message: string, error: unknown) => void;

/**
 * A subscription to a value with a revision: `invokeChannel` answers with
 * the current value and subscribes the frame, and `eventChannel` carries
 * every later one. A value with a revision not above the last one delivered
 * is dropped, because the answer and an event can arrive in either order.
 */
function subscribeRevisions<T extends { readonly revision: number }>(
  ipc: BridgeIpc,
  invokeChannel: InvokeChannel,
  eventChannel: EventChannel,
  callbackFailure: string,
  reportError: ReportError,
  listener: (value: T) => void,
  onError: (() => void) | undefined,
): () => void {
  if (typeof listener !== "function") {
    throw new TypeError("A subscription needs a listener function.");
  }
  if (onError !== undefined && typeof onError !== "function") {
    throw new TypeError("onError must be a function.");
  }
  const call = (callback: () => void): void => {
    try {
      callback();
    } catch (error) {
      reportError(callbackFailure, error);
    }
  };
  let active = true;
  let lastRevision = -1;
  const deliver = (value: T) => {
    if (active && value.revision > lastRevision) {
      lastRevision = value.revision;
      call(() => listener(value));
    }
  };
  // The event object holds ipcRenderer and never reaches the renderer.
  const onChanged: IpcListener = (_event, value) => deliver(value as T);
  ipc.on(eventChannel, onChanged);
  ipc.invoke(invokeChannel).then(
    (value) => deliver(value as T),
    () => {
      if (active && onError !== undefined) {
        call(onError);
      }
    },
  );
  return () => {
    active = false;
    ipc.removeListener(eventChannel, onChanged);
  };
}

/**
 * The object the preload script exposes as `window.desktop`. Every function
 * calls one fixed channel of the IPC contract and passes no argument from
 * the renderer on to it, except the mount ID of `repositories.unmount`, the
 * project IDs, repository IDs, mount IDs, and names of the
 * `projectRepositories`, each a string, the passphrase of
 * `account.unlockDeviceKey`, the IDs of `workspaces.select`
 * and `workspaces.openProject`, the name of `workspaces.create`, the ID and
 * the name of `workspaces.createProject`, the ID of `workspaces.copyId`,
 * the text of `chat.send`, and the event IDs
 * of `chat.retry` and `chat.discard`, which must be strings (or null to
 * close a project) and which the main process validates, the device IDs
 * of `devices.dismissNewDevices`, an array of strings that it copies, the
 * device ID of `devices.revokeDevice`, a string, with one of its own two
 * reasons, the workspace IDs, member IDs, and display names of the
 * `peopleActions`, each a string, and the IDs and pasted codes of the
 * `invitationActions`, each a string, with the lifetime of `create`, a
 * whole number or null, the IDs of the `joinRequestActions`, each a
 * string, with the display name of `approve`, a string or null, and the
 * workspace ID and request ID of the `ownJoinRequestActions`, each a
 * string, with the display name of `create`, a string or null, and the
 * workspace ID of `claims.markSeen`, a string, with its member IDs, an array
 * of strings that it copies, and the kind and the label of
 * `providerConnections.register`, two strings in a new object of its own,
 * the ID of `providerConnections.remove`, a string, the ID and the API key
 * of `providerConnections.saveKey`, two strings in a new object of its own,
 * the ID of `providerConnections.removeKey`, a string, the four IDs of
 * `agents.requestRun`, each a string, and its repository ID, a string or
 * null, in a new object of its own, and the project ID of `agents.takeRunRequestOutcome`, a string.
 * `account.startSignIn` passes on a fixed option of its own when the
 * renderer asks for another browser, and `workspaces.select` and
 * `workspaces.openProject` when it asks to discard the chat messages that
 * wait. Event objects, which hold `ipcRenderer`, never reach the renderer.
 * The object and its parts are frozen. An error that a renderer callback
 * throws goes to `reportError` and stops nothing else.
 */
export function createDesktopBridge(
  electronVersion: string,
  ipc: BridgeIpc,
  reportError: ReportError = (message, error) => console.error(message, error),
): DesktopBridge {
  // The main process parses every value it sends with the contract.
  const runtime: RuntimeBridge = Object.freeze({
    getStatus: () =>
      ipc.invoke(INVOKE_CHANNELS.getRuntimeStatus) as Promise<RuntimeStatus>,
    subscribeStatus: (
      listener: (status: RuntimeStatus) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeRuntimeStatus,
        EVENT_CHANNELS.runtimeStatusChanged,
        "A runtime status callback failed.",
        reportError,
        listener,
        onError,
      ),
  });

  const repositories: RepositoryBridge = Object.freeze({
    list: () =>
      ipc.invoke(INVOKE_CHANNELS.listRepositories) as Promise<RepositoryList>,
    subscribe: (
      listener: (list: RepositoryList) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeRepositories,
        EVENT_CHANNELS.repositoriesChanged,
        "A repository list callback failed.",
        reportError,
        listener,
        onError,
      ),
    mount: () =>
      ipc.invoke(INVOKE_CHANNELS.mountRepository) as Promise<MountResult>,
    unmount: (mountId: string) =>
      typeof mountId === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.unmountRepository,
            mountId,
          ) as Promise<boolean>)
        : Promise.reject(new TypeError("unmount needs a mount ID string.")),
  });

  // The IDs and the name go to the main process only, never a path; the
  // errors name no value.
  const projectRepositories: ProjectRepositoriesBridge = Object.freeze({
    getState: () =>
      ipc.invoke(
        INVOKE_CHANNELS.getProjectRepositoryState,
      ) as Promise<ProjectRepositoriesView>,
    subscribeState: (
      listener: (state: ProjectRepositoriesView) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeProjectRepositoryState,
        EVENT_CHANNELS.projectRepositoriesChanged,
        "A project repository callback failed.",
        reportError,
        listener,
        onError,
      ),
    register: (projectId: string, name: string) =>
      typeof projectId === "string" && typeof name === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.registerRepository,
            projectId,
            name,
          ) as Promise<RegisterRepositoryResult>)
        : Promise.reject(
            new TypeError("register needs a project ID and a name string."),
          ),
    remove: (projectId: string, repositoryId: string) =>
      typeof projectId === "string" && typeof repositoryId === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.removeRepository,
            projectId,
            repositoryId,
          ) as Promise<RemoveRepositoryResult>)
        : Promise.reject(
            new TypeError("remove needs a project ID and a repository ID."),
          ),
    link: (repositoryId: string, mountId: string) =>
      typeof repositoryId === "string" && typeof mountId === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.linkRepository,
            repositoryId,
            mountId,
          ) as Promise<LinkRepositoryResult>)
        : Promise.reject(
            new TypeError("link needs a repository ID and a mount ID string."),
          ),
    unlink: (repositoryId: string) =>
      typeof repositoryId === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.unlinkRepository,
            repositoryId,
          ) as Promise<UnlinkRepositoryResult>)
        : Promise.reject(new TypeError("unlink needs a repository ID string.")),
  });

  const account: AccountBridge = Object.freeze({
    getStatus: () =>
      ipc.invoke(INVOKE_CHANNELS.getAccountStatus) as Promise<AccountStatus>,
    subscribeStatus: (
      listener: (status: AccountStatus) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeAccountStatus,
        EVENT_CHANNELS.accountStatusChanged,
        "An account status callback failed.",
        reportError,
        listener,
        onError,
      ),
    // Any other value starts the sign-in in the default browser; the main
    // process validates the option again.
    startSignIn: (options?: StartSignInOptions) =>
      (asksForOtherBrowser(options)
        ? ipc.invoke(INVOKE_CHANNELS.startSignIn, OTHER_BROWSER_START)
        : ipc.invoke(
            INVOKE_CHANNELS.startSignIn,
          )) as Promise<StartSignInResult>,
    cancelSignIn: () =>
      ipc.invoke(INVOKE_CHANNELS.cancelSignIn) as Promise<boolean>,
    // The passphrase goes to the main process only; the error names no value.
    unlockDeviceKey: (passphrase: string) =>
      typeof passphrase === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.unlockDeviceKey,
            passphrase,
          ) as Promise<UnlockResult>)
        : Promise.reject(
            new TypeError("unlockDeviceKey needs a passphrase string."),
          ),
    forgetAccount: () =>
      ipc.invoke(INVOKE_CHANNELS.forgetAccount) as Promise<ForgetResult>,
    signOut: () =>
      ipc.invoke(INVOKE_CHANNELS.signOut) as Promise<SignOutResult>,
    removeDevice: () =>
      ipc.invoke(INVOKE_CHANNELS.removeDevice) as Promise<RemoveDeviceResult>,
  });

  const connection: ConnectionBridge = Object.freeze({
    getStatus: () =>
      ipc.invoke(
        INVOKE_CHANNELS.getConnectionStatus,
      ) as Promise<ConnectionStatus>,
    subscribeStatus: (
      listener: (status: ConnectionStatus) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeConnectionStatus,
        EVENT_CHANNELS.connectionStatusChanged,
        "A connection status callback failed.",
        reportError,
        listener,
        onError,
      ),
    reconnect: () =>
      ipc.invoke(INVOKE_CHANNELS.reconnect) as Promise<ReconnectResult>,
  });

  const workspaces: WorkspaceBridge = Object.freeze({
    getState: () =>
      ipc.invoke(INVOKE_CHANNELS.getWorkspaceState) as Promise<WorkspaceView>,
    subscribeState: (
      listener: (state: WorkspaceView) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeWorkspaceState,
        EVENT_CHANNELS.workspaceStateChanged,
        "A workspace state callback failed.",
        reportError,
        listener,
        onError,
      ),
    // Any other option keeps the waiting chat messages; the main process
    // validates the option again.
    select: (workspaceId: string, options?: WorkspaceSwitchOptions) =>
      typeof workspaceId === "string"
        ? ((discardsWaiting(options)
            ? ipc.invoke(
                INVOKE_CHANNELS.selectWorkspace,
                workspaceId,
                DISCARD_WAITING,
              )
            : ipc.invoke(
                INVOKE_CHANNELS.selectWorkspace,
                workspaceId,
              )) as Promise<WorkspaceActionResult>)
        : Promise.reject(new TypeError("select needs a workspace ID string.")),
    openProject: (
      projectId: string | null,
      options?: WorkspaceSwitchOptions,
    ) =>
      typeof projectId === "string" || projectId === null
        ? ((discardsWaiting(options)
            ? ipc.invoke(
                INVOKE_CHANNELS.openProject,
                projectId,
                DISCARD_WAITING,
              )
            : ipc.invoke(
                INVOKE_CHANNELS.openProject,
                projectId,
              )) as Promise<WorkspaceActionResult>)
        : Promise.reject(
            new TypeError("openProject needs a project ID string or null."),
          ),
    // Only strings go on; the main process checks the ID and the name.
    create: (name: string) =>
      typeof name === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.createWorkspace,
            name,
          ) as Promise<CreateWorkspaceResult>)
        : Promise.reject(new TypeError("create needs a name string.")),
    createProject: (workspaceId: string, name: string) =>
      typeof workspaceId === "string" && typeof name === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.createProject,
            workspaceId,
            name,
          ) as Promise<CreateProjectResult>)
        : Promise.reject(
            new TypeError(
              "createProject needs a workspace ID and a name string.",
            ),
          ),
    // Only a string goes on; the main process checks the ID against the
    // account's workspace list.
    copyId: (workspaceId: string) =>
      typeof workspaceId === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.copyWorkspaceId,
            workspaceId,
          ) as Promise<CopyWorkspaceIdResult>)
        : Promise.reject(new TypeError("copyId needs a workspace ID string.")),
  });

  const people: PeopleBridge = Object.freeze({
    getState: () =>
      ipc.invoke(INVOKE_CHANNELS.getPeopleState) as Promise<PeopleView>,
    subscribeState: (
      listener: (state: PeopleView) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribePeopleState,
        EVENT_CHANNELS.peopleStateChanged,
        "A people state callback failed.",
        reportError,
        listener,
        onError,
      ),
  });

  // Only strings go on; the main process checks each ID and name. Another
  // value is refused here without naming it.
  const strings = (...values: readonly unknown[]) =>
    values.every((value) => typeof value === "string");
  const ofPerson =
    (channel: InvokeChannel, name: string) =>
    (workspaceId: string, memberId: string) =>
      strings(workspaceId, memberId)
        ? (ipc.invoke(
            channel,
            workspaceId,
            memberId,
          ) as Promise<PersonActionResult>)
        : Promise.reject(
            new TypeError(
              `${name} needs a workspace ID and a member ID string.`,
            ),
          );
  const ofWorkspace =
    (channel: InvokeChannel, name: string) => (workspaceId: string) =>
      strings(workspaceId)
        ? (ipc.invoke(channel, workspaceId) as Promise<PersonActionResult>)
        : Promise.reject(new TypeError(`${name} needs a workspace ID string.`));
  const peopleActions: PeopleActionsBridge = Object.freeze({
    define: (workspaceId: string, displayName: string) =>
      strings(workspaceId, displayName)
        ? (ipc.invoke(
            INVOKE_CHANNELS.definePerson,
            workspaceId,
            displayName,
          ) as Promise<DefinePersonResult>)
        : Promise.reject(
            new TypeError("define needs a workspace ID and a name string."),
          ),
    rename: (workspaceId: string, memberId: string, displayName: string) =>
      strings(workspaceId, memberId, displayName)
        ? (ipc.invoke(
            INVOKE_CHANNELS.renamePerson,
            workspaceId,
            memberId,
            displayName,
          ) as Promise<PersonActionResult>)
        : Promise.reject(
            new TypeError(
              "rename needs a workspace ID, a member ID, and a name string.",
            ),
          ),
    remove: ofPerson(INVOKE_CHANNELS.removePerson, "remove"),
    promote: ofPerson(INVOKE_CHANNELS.promotePerson, "promote"),
    demote: ofPerson(INVOKE_CHANNELS.demotePerson, "demote"),
    leave: ofWorkspace(INVOKE_CHANNELS.leaveWorkspace, "leave"),
    offerOwnership: ofPerson(INVOKE_CHANNELS.offerOwnership, "offerOwnership"),
    withdrawOwnershipOffer: ofWorkspace(
      INVOKE_CHANNELS.withdrawOwnershipOffer,
      "withdrawOwnershipOffer",
    ),
    acceptOwnershipOffer: ofWorkspace(
      INVOKE_CHANNELS.acceptOwnershipOffer,
      "acceptOwnershipOffer",
    ),
  });

  const invitations: InvitationsBridge = Object.freeze({
    getState: () =>
      ipc.invoke(
        INVOKE_CHANNELS.getInvitationState,
      ) as Promise<InvitationsView>,
    subscribeState: (
      listener: (state: InvitationsView) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeInvitationState,
        EVENT_CHANNELS.invitationStateChanged,
        "An invitation state callback failed.",
        reportError,
        listener,
        onError,
      ),
    load: () =>
      ipc.invoke(
        INVOKE_CHANNELS.loadInvitations,
      ) as Promise<InvitationLoadResult>,
  });

  // Only strings, and a lifetime that is a whole number or null, go on; the
  // main process checks each ID, the lifetime, and the code. Another value
  // is refused here without naming it, and a pasted code never appears in
  // an error.
  const invitationActions: InvitationActionsBridge = Object.freeze({
    create: (
      workspaceId: string,
      memberId: string,
      lifetimeSeconds?: number | null,
    ) => {
      const lifetime =
        lifetimeSeconds === undefined || lifetimeSeconds === null
          ? null
          : Number.isInteger(lifetimeSeconds)
            ? lifetimeSeconds
            : undefined;
      return strings(workspaceId, memberId) && lifetime !== undefined
        ? (ipc.invoke(
            INVOKE_CHANNELS.createInvitation,
            workspaceId,
            memberId,
            lifetime,
          ) as Promise<CreateInvitationResult>)
        : Promise.reject(
            new TypeError(
              "create needs a workspace ID and a member ID string, and a whole number or null.",
            ),
          );
    },
    revoke: (workspaceId: string, invitationId: string) =>
      strings(workspaceId, invitationId)
        ? (ipc.invoke(
            INVOKE_CHANNELS.revokeInvitation,
            workspaceId,
            invitationId,
          ) as Promise<RevokeInvitationResult>)
        : Promise.reject(
            new TypeError(
              "revoke needs a workspace ID and an invitation ID string.",
            ),
          ),
    preview: (code: string) =>
      strings(code)
        ? (ipc.invoke(
            INVOKE_CHANNELS.previewInvitation,
            code,
          ) as Promise<PreviewInvitationResult>)
        : Promise.reject(new TypeError("preview needs a code string.")),
    accept: (code: string) =>
      strings(code)
        ? (ipc.invoke(
            INVOKE_CHANNELS.acceptInvitation,
            code,
          ) as Promise<AcceptInvitationResult>)
        : Promise.reject(new TypeError("accept needs a code string.")),
  });

  const joinRequests: JoinRequestsBridge = Object.freeze({
    getState: () =>
      ipc.invoke(
        INVOKE_CHANNELS.getJoinRequestState,
      ) as Promise<JoinRequestsView>,
    subscribeState: (
      listener: (state: JoinRequestsView) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeJoinRequestState,
        EVENT_CHANNELS.joinRequestStateChanged,
        "A join request state callback failed.",
        reportError,
        listener,
        onError,
      ),
    load: () =>
      ipc.invoke(
        INVOKE_CHANNELS.loadJoinRequests,
      ) as Promise<JoinRequestLoadResult>,
  });

  // Only strings, and for an approval a name or null, go on; the main
  // process checks each ID and the name. Another value is refused here
  // without naming it.
  const ofRequest =
    (channel: InvokeChannel, name: string) =>
    (workspaceId: string, joinRequestId: string) =>
      strings(workspaceId, joinRequestId)
        ? (ipc.invoke(
            channel,
            workspaceId,
            joinRequestId,
          ) as Promise<JoinRequestActionResult>)
        : Promise.reject(
            new TypeError(
              `${name} needs a workspace ID and a join request ID string.`,
            ),
          );
  const ofJoinWorkspace =
    (channel: InvokeChannel, name: string) => (workspaceId: string) =>
      strings(workspaceId)
        ? (ipc.invoke(channel, workspaceId) as Promise<JoinRequestActionResult>)
        : Promise.reject(new TypeError(`${name} needs a workspace ID string.`));
  const joinRequestActions: JoinRequestActionsBridge = Object.freeze({
    approve: (
      workspaceId: string,
      joinRequestId: string,
      displayName?: string | null,
    ) => {
      const name =
        displayName === undefined || displayName === null
          ? null
          : typeof displayName === "string"
            ? displayName
            : undefined;
      return strings(workspaceId, joinRequestId) && name !== undefined
        ? (ipc.invoke(
            INVOKE_CHANNELS.approveJoinRequest,
            workspaceId,
            joinRequestId,
            name,
          ) as Promise<ApproveJoinRequestResult>)
        : Promise.reject(
            new TypeError(
              "approve needs a workspace ID and a join request ID string, and a name string or null.",
            ),
          );
    },
    deny: ofRequest(INVOKE_CHANNELS.denyJoinRequest, "deny"),
    denyAll: ofJoinWorkspace(INVOKE_CHANNELS.denyAllJoinRequests, "denyAll"),
    block: ofRequest(INVOKE_CHANNELS.blockJoinRequest, "block"),
    unblock: ofRequest(INVOKE_CHANNELS.unblockJoinRequest, "unblock"),
    pause: ofJoinWorkspace(INVOKE_CHANNELS.pauseJoinRequests, "pause"),
    resume: ofJoinWorkspace(INVOKE_CHANNELS.resumeJoinRequests, "resume"),
  });

  const ownJoinRequests: OwnJoinRequestsBridge = Object.freeze({
    getState: () =>
      ipc.invoke(
        INVOKE_CHANNELS.getOwnJoinRequestState,
      ) as Promise<OwnJoinRequestsView>,
    subscribeState: (
      listener: (state: OwnJoinRequestsView) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeOwnJoinRequestState,
        EVENT_CHANNELS.ownJoinRequestStateChanged,
        "An own join request state callback failed.",
        reportError,
        listener,
        onError,
      ),
    load: () =>
      ipc.invoke(
        INVOKE_CHANNELS.loadOwnJoinRequests,
      ) as Promise<OwnJoinRequestLoadResult>,
  });

  // Only strings, and for a create a name or null, go on; the main process
  // checks each ID and the name. Another value is refused here without
  // naming it.
  const ownJoinRequestActions: OwnJoinRequestActionsBridge = Object.freeze({
    create: (workspaceId: string, displayName?: string | null) => {
      const name =
        displayName === undefined || displayName === null
          ? null
          : typeof displayName === "string"
            ? displayName
            : undefined;
      return strings(workspaceId) && name !== undefined
        ? (ipc.invoke(
            INVOKE_CHANNELS.createJoinRequest,
            workspaceId,
            name,
          ) as Promise<CreateJoinRequestResult>)
        : Promise.reject(
            new TypeError(
              "create needs a workspace ID string, and a name string or null.",
            ),
          );
    },
    withdraw: (joinRequestId: string) =>
      strings(joinRequestId)
        ? (ipc.invoke(
            INVOKE_CHANNELS.withdrawJoinRequest,
            joinRequestId,
          ) as Promise<WithdrawJoinRequestResult>)
        : Promise.reject(
            new TypeError("withdraw needs a join request ID string."),
          ),
  });

  const claims: ClaimsBridge = Object.freeze({
    getState: () =>
      ipc.invoke(INVOKE_CHANNELS.getClaimState) as Promise<ClaimsView>,
    subscribeState: (
      listener: (state: ClaimsView) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeClaimState,
        EVENT_CHANNELS.claimStateChanged,
        "A claim state callback failed.",
        reportError,
        listener,
        onError,
      ),
    load: () =>
      ipc.invoke(INVOKE_CHANNELS.loadClaims) as Promise<ClaimLoadResult>,
    // Only a string and a new array of strings go on; the main process
    // checks each ID and counts only the claims that it holds. Another value
    // is refused here without naming it.
    markSeen: (workspaceId: string, memberIds: readonly string[]) =>
      strings(workspaceId) &&
      Array.isArray(memberIds) &&
      memberIds.every((memberId) => typeof memberId === "string")
        ? (ipc.invoke(INVOKE_CHANNELS.markClaimsSeen, workspaceId, [
            ...memberIds,
          ]) as Promise<ClaimMarkSeenResult>)
        : Promise.reject(
            new TypeError(
              "markSeen needs a workspace ID string and an array of member ID strings.",
            ),
          ),
  });

  const claimMarks: ClaimMarksBridge = Object.freeze({
    getState: () =>
      ipc.invoke(INVOKE_CHANNELS.getClaimMarks) as Promise<ClaimMarksView>,
    subscribeState: (
      listener: (state: ClaimMarksView) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeClaimMarks,
        EVENT_CHANNELS.claimMarksChanged,
        "A claim mark callback failed.",
        reportError,
        listener,
        onError,
      ),
  });

  // Only a new object with the four IDs of a run request goes on, each a
  // string, and a project ID string for a kept outcome; the main process
  // checks each value. Another value is refused here without naming it.
  const agents: AgentBridge = Object.freeze({
    getState: () =>
      ipc.invoke(INVOKE_CHANNELS.getAgentState) as Promise<AgentActivityView>,
    subscribeState: (
      listener: (state: AgentActivityView) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeAgentState,
        EVENT_CHANNELS.agentStateChanged,
        "An agent activity callback failed.",
        reportError,
        listener,
        onError,
      ),
    requestRun: (request: RunRequestView) => {
      const copy = runRequestOf(request);
      return copy !== null
        ? (ipc.invoke(
            INVOKE_CHANNELS.requestRun,
            copy,
          ) as Promise<RunRequestResult>)
        : Promise.reject(
            new TypeError(
              "requestRun needs a project ID, an agent ID, a provider connection ID, and a message ID string, and a repository ID string or null.",
            ),
          );
    },
    takeRunRequestOutcome: (projectId: string) =>
      typeof projectId === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.takeRunRequestOutcome,
            projectId,
          ) as Promise<RunRequestOutcome | null>)
        : Promise.reject(
            new TypeError("takeRunRequestOutcome needs a project ID string."),
          ),
  });

  // Only the IDs and a new object with the fields of a grant go on;
  // the main process checks each value. Another value is refused here
  // without naming it.
  const grants: GrantBridge = Object.freeze({
    getState: () =>
      ipc.invoke(INVOKE_CHANNELS.getGrantState) as Promise<GrantsView>,
    subscribeState: (
      listener: (state: GrantsView) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeGrantState,
        EVENT_CHANNELS.grantStateChanged,
        "A grant state callback failed.",
        reportError,
        listener,
        onError,
      ),
    listProviderConnections: () =>
      ipc.invoke(
        INVOKE_CHANNELS.listProviderConnections,
      ) as Promise<ProviderConnectionsResult>,
    grant: (agentId: string, request: GrantRequestView) => {
      const copy = grantRequestOf(request);
      return typeof agentId === "string" && copy !== null
        ? (ipc.invoke(
            INVOKE_CHANNELS.grantCapability,
            agentId,
            copy,
          ) as Promise<GrantCapabilityResult>)
        : Promise.reject(
            new TypeError(
              "grant needs an agent ID string and a capability, a scope ID string, a lifetime number or null, and no confirmation other than true.",
            ),
          );
    },
    revoke: (agentId: string, grantId: string) =>
      typeof agentId === "string" && typeof grantId === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.revokeGrant,
            agentId,
            grantId,
          ) as Promise<RevokeGrantResult>)
        : Promise.reject(
            new TypeError("revoke needs an agent ID and a grant ID string."),
          ),
    listAgentGrants: (agentId: string) =>
      typeof agentId === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.listAgentGrants,
            agentId,
          ) as Promise<AgentGrantsResult>)
        : Promise.reject(
            new TypeError("listAgentGrants needs an agent ID string."),
          ),
  });

  // The text and the event IDs go to the main process only; the errors
  // name no value.
  const chat: ChatBridge = Object.freeze({
    getState: () =>
      ipc.invoke(INVOKE_CHANNELS.getChatState) as Promise<ChatView>,
    subscribeState: (
      listener: (state: ChatView) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeChatState,
        EVENT_CHANNELS.chatStateChanged,
        "A chat state callback failed.",
        reportError,
        listener,
        onError,
      ),
    send: (text: string) =>
      typeof text === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.sendChatMessage,
            text,
          ) as Promise<ChatSendResultView>)
        : Promise.reject(new TypeError("send needs a text string.")),
    retry: (eventId: string) =>
      typeof eventId === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.retryChatMessage,
            eventId,
          ) as Promise<boolean>)
        : Promise.reject(new TypeError("retry needs an event ID string.")),
    discard: (eventId: string) =>
      typeof eventId === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.discardChatMessage,
            eventId,
          ) as Promise<boolean>)
        : Promise.reject(new TypeError("discard needs an event ID string.")),
    loadOlder: () =>
      ipc.invoke(
        INVOKE_CHANNELS.loadOlderChatMessages,
      ) as Promise<ChatLoadOlderResultView>,
  });

  const devices: DeviceListBridge = Object.freeze({
    getState: () =>
      ipc.invoke(INVOKE_CHANNELS.getDeviceList) as Promise<DeviceListView>,
    subscribeState: (
      listener: (state: DeviceListView) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeDeviceList,
        EVENT_CHANNELS.deviceListChanged,
        "A device list callback failed.",
        reportError,
        listener,
        onError,
      ),
    load: () =>
      ipc.invoke(
        INVOKE_CHANNELS.loadDeviceList,
      ) as Promise<DeviceListLoadResult>,
    // Only a new array of the strings goes on; the main process checks each
    // ID. Another value is refused here without naming it.
    dismissNewDevices: (deviceIds: readonly string[]) =>
      Array.isArray(deviceIds) &&
      deviceIds.every((deviceId) => typeof deviceId === "string")
        ? (ipc.invoke(INVOKE_CHANNELS.dismissNewDevices, [
            ...deviceIds,
          ]) as Promise<boolean>)
        : Promise.reject(
            new TypeError("dismissNewDevices needs an array of ID strings."),
          ),
    // Only a string and one of the two reasons go on; the main process
    // checks the ID and accepts only an active device of its list.
    revokeDevice: (deviceId: string, reason: OtherDeviceRevocation) => {
      const revocation = revocationOf(reason);
      return typeof deviceId === "string" && revocation !== null
        ? (ipc.invoke(
            INVOKE_CHANNELS.revokeDevice,
            deviceId,
            revocation,
          ) as Promise<RevokeOtherDeviceResult>)
        : Promise.reject(
            new TypeError(
              "revokeDevice needs a device ID string and a revocation reason.",
            ),
          );
    },
    liftRegistrationLock: () =>
      ipc.invoke(
        INVOKE_CHANNELS.liftRegistrationLock,
      ) as Promise<LiftRegistrationLockResult>,
    dismissLostDeviceAdvice: () =>
      ipc.invoke(INVOKE_CHANNELS.dismissLostDeviceAdvice) as Promise<boolean>,
  });

  // Only a new object with the kind and the label, a new object with the ID
  // and the API key, and the ID, go on, each a string; the main process
  // checks each value. The key goes to the main process once, and nothing
  // returns it. Another value is refused here without naming it.
  const providerConnections: ProviderConnectionsBridge = Object.freeze({
    getState: () =>
      ipc.invoke(
        INVOKE_CHANNELS.getProviderConnections,
      ) as Promise<ProviderConnectionListView>,
    subscribeState: (
      listener: (state: ProviderConnectionListView) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeProviderConnections,
        EVENT_CHANNELS.providerConnectionsChanged,
        "A provider connection callback failed.",
        reportError,
        listener,
        onError,
      ),
    register: (kind: string, label: string) =>
      typeof kind === "string" && typeof label === "string"
        ? (ipc.invoke(INVOKE_CHANNELS.registerProviderConnection, {
            kind,
            label,
          }) as Promise<RegisterProviderConnectionResult>)
        : Promise.reject(
            new TypeError("register needs a kind and a label string."),
          ),
    remove: (providerConnectionId: string) =>
      typeof providerConnectionId === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.removeProviderConnection,
            providerConnectionId,
          ) as Promise<RemoveProviderConnectionResult>)
        : Promise.reject(
            new TypeError("remove needs a provider connection ID string."),
          ),
    saveKey: (providerConnectionId: string, key: string) =>
      typeof providerConnectionId === "string" && typeof key === "string"
        ? (ipc.invoke(INVOKE_CHANNELS.saveProviderKey, {
            providerConnectionId,
            key,
          }) as Promise<SaveProviderKeyResult>)
        : Promise.reject(
            new TypeError(
              "saveKey needs a provider connection ID and a key string.",
            ),
          ),
    removeKey: (providerConnectionId: string) =>
      typeof providerConnectionId === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.removeProviderKey,
            providerConnectionId,
          ) as Promise<RemoveProviderKeyResult>)
        : Promise.reject(
            new TypeError("removeKey needs a provider connection ID string."),
          ),
  });

  return Object.freeze({
    electronVersion,
    runtime,
    repositories,
    projectRepositories,
    account,
    connection,
    workspaces,
    people,
    peopleActions,
    invitations,
    invitationActions,
    joinRequests,
    joinRequestActions,
    ownJoinRequests,
    ownJoinRequestActions,
    claims,
    claimMarks,
    agents,
    grants,
    chat,
    devices,
    providerConnections,
  });
}

/**
 * A new object with only the four IDs of a run request (#35) and the
 * chosen repository's ID or null (#362), or null when an ID is not a
 * string or the repository is neither. A getter is read once, so the main
 * process gets the values that were checked, and another key never goes
 * on.
 */
function runRequestOf(request: unknown): RunRequestView | null {
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const {
    projectId,
    agentId,
    providerConnectionId,
    inputMessageId,
    repositoryId,
  } = request as Record<string, unknown>;
  if (
    typeof projectId !== "string" ||
    typeof agentId !== "string" ||
    typeof providerConnectionId !== "string" ||
    typeof inputMessageId !== "string" ||
    (typeof repositoryId !== "string" && repositoryId !== null)
  ) {
    return null;
  }
  return {
    projectId,
    agentId,
    providerConnectionId,
    inputMessageId,
    repositoryId,
  };
}

/**
 * A new object with only the fields of a grant request, or null when one
 * has another type: the three fields, and `confirmedHighestRisk` only when
 * it is `true` (#77). A getter is read once, so the main process gets the
 * values that were checked.
 */
function grantRequestOf(request: unknown): GrantRequestView | null {
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const { capability, scopeId, lifetimeSeconds, confirmedHighestRisk } =
    request as Record<string, unknown>;
  if (
    typeof capability !== "string" ||
    typeof scopeId !== "string" ||
    (lifetimeSeconds !== null && typeof lifetimeSeconds !== "number") ||
    (confirmedHighestRisk !== undefined && confirmedHighestRisk !== true)
  ) {
    return null;
  }
  return (
    confirmedHighestRisk === true
      ? { capability, scopeId, lifetimeSeconds, confirmedHighestRisk }
      : { capability, scopeId, lifetimeSeconds }
  ) as GrantRequestView;
}
