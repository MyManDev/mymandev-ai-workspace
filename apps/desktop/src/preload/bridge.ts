import type {
  AccountBridge,
  AgentBridge,
  ChatBridge,
  ConnectionBridge,
  DesktopBridge,
  DeviceListBridge,
  InvitationActionsBridge,
  InvitationsBridge,
  PeopleActionsBridge,
  PeopleBridge,
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
  ChatLoadOlderResultView,
  ChatSendResultView,
  ChatView,
  ConnectionStatus,
  CreateInvitationResult,
  DefinePersonResult,
  DeviceListLoadResult,
  DeviceListView,
  ForgetResult,
  InvitationLoadResult,
  InvitationsView,
  LiftRegistrationLockResult,
  MountResult,
  OtherDeviceRevocation,
  PeopleView,
  PersonActionResult,
  PreviewInvitationResult,
  ReconnectResult,
  RemoveDeviceResult,
  RevokeInvitationResult,
  RevokeOtherDeviceResult,
  RepositoryList,
  RuntimeStatus,
  SignOutResult,
  StartSignInOptions,
  StartSignInResult,
  UnlockResult,
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
 * passphrase of `account.unlockDeviceKey`, the IDs of `workspaces.select`
 * and `workspaces.openProject`, the text of `chat.send`, and the event IDs
 * of `chat.retry` and `chat.discard`, which must be strings (or null to
 * close a project) and which the main process validates, the device IDs
 * of `devices.dismissNewDevices`, an array of strings that it copies, the
 * device ID of `devices.revokeDevice`, a string, with one of its own two
 * reasons, the workspace IDs, member IDs, and display names of the
 * `peopleActions`, each a string, and the IDs and pasted codes of the
 * `invitationActions`, each a string, with the lifetime of `create`, a
 * whole number or null.
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

  return Object.freeze({
    electronVersion,
    runtime,
    repositories,
    account,
    connection,
    workspaces,
    people,
    peopleActions,
    invitations,
    invitationActions,
    agents,
    chat,
    devices,
  });
}
