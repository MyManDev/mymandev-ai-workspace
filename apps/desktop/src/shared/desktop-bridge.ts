import type {
  AcceptInvitationResult,
  AccountStatus,
  AgentActivityView,
  ChatLoadOlderResultView,
  ChatSendResultView,
  ChatView,
  ConnectionStatus,
  CreateInvitationResult,
  CreateJoinRequestResult,
  CreateProjectResult,
  CreateWorkspaceResult,
  DefinePersonResult,
  DeviceListLoadResult,
  DeviceListView,
  ForgetResult,
  InvitationLoadResult,
  InvitationsView,
  LiftRegistrationLockResult,
  MountResult,
  OtherDeviceRevocation,
  OwnJoinRequestLoadResult,
  OwnJoinRequestsView,
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
  WithdrawJoinRequestResult,
  WorkspaceSwitchOptions,
  WorkspaceView,
} from "./ipc-contract.ts";

/**
 * What the preload script exposes to the renderer as `window.desktop`.
 *
 * The renderer runs sandboxed, with context isolation and without Node.js. It
 * reaches the main process only through this object, whose functions call the
 * channels of the IPC contract (`ipc-contract.ts`). It holds no `ipcRenderer`
 * and no function that takes a channel name. The preload script freezes it.
 */
export interface DesktopBridge {
  /** The Electron version the application runs on, for example "45.0.0". */
  readonly electronVersion: string;
  /** The local runtime in the main process. */
  readonly runtime: RuntimeBridge;
  /** The repositories mounted on this device, read-only. */
  readonly repositories: RepositoryBridge;
  /** The sign-in of this installation. */
  readonly account: AccountBridge;
  /** The status of the connection to the cloud API. */
  readonly connection: ConnectionBridge;
  /** The account's workspaces, the selected one's projects, and the open project. */
  readonly workspaces: WorkspaceBridge;
  /** The people of the selected workspace, read-only. */
  readonly people: PeopleBridge;
  /** The actions on the people of the selected workspace. */
  readonly peopleActions: PeopleActionsBridge;
  /** The live invitations of the selected workspace, read-only. */
  readonly invitations: InvitationsBridge;
  /** Creating and revoking invitations, and joining with a pasted code. */
  readonly invitationActions: InvitationActionsBridge;
  /** The account's own join requests, read-only. */
  readonly ownJoinRequests: OwnJoinRequestsBridge;
  /** Asking to join a workspace by its ID, and withdrawing a request. */
  readonly ownJoinRequestActions: OwnJoinRequestActionsBridge;
  /** The agent activity of the open project, read-only. */
  readonly agents: AgentBridge;
  /** The chat of the open project. */
  readonly chat: ChatBridge;
  /** The account's devices, the registration lock, and new devices. */
  readonly devices: DeviceListBridge;
}

export interface RuntimeBridge {
  /** The current status of the local runtime. */
  readonly getStatus: () => Promise<RuntimeStatus>;
  /**
   * Calls `listener` with the current status and then after every change. A
   * status older than the last one delivered is dropped. `onError` is called
   * when the main process refuses the subscription. Returns a function that
   * ends the subscription.
   */
  readonly subscribeStatus: (
    listener: (status: RuntimeStatus) => void,
    onError?: () => void,
  ) => () => void;
}

export interface RepositoryBridge {
  /** The mounted repositories. */
  readonly list: () => Promise<RepositoryList>;
  /**
   * Calls `listener` with the mounted repositories and then after every
   * change, including a new status after a file change. A list older than
   * the last one delivered is dropped. `onError` is called when the main
   * process refuses the subscription. Returns a function that ends the
   * subscription.
   */
  readonly subscribe: (
    listener: (list: RepositoryList) => void,
    onError?: () => void,
  ) => () => void;
  /**
   * Opens the folder dialog of the main process and mounts the selected
   * repository. The renderer never passes a path.
   */
  readonly mount: () => Promise<MountResult>;
  /**
   * Unmounts a repository: it leaves the list and is no longer watched.
   * Nothing in the folder changes. Resolves to false when it was not mounted.
   */
  readonly unmount: (mountId: string) => Promise<boolean>;
}

/**
 * The sign-in and the device of this installation. The main process runs
 * them: the renderer gets the account, the pairing code, and fixed codes,
 * never a sign-in code, a verifier, a signature, a key, or a token
 * (ADR 0014). The account's devices come through `DeviceListBridge`.
 */
export interface AccountBridge {
  /** The current account status. */
  readonly getStatus: () => Promise<AccountStatus>;
  /**
   * Calls `listener` with the current status and then after every change. A
   * status older than the last one delivered is dropped. `onError` is called
   * when the main process refuses the subscription. Returns a function that
   * ends the subscription.
   */
  readonly subscribeStatus: (
    listener: (status: AccountStatus) => void,
    onError?: () => void,
  ) => () => void;
  /**
   * Starts a GitHub sign-in in the system browser. Call it only after the
   * person's action. With `{ browser: "other" }` the main process opens no
   * browser and offers the start address for copying into another one
   * (#175); the bridge passes on only that fixed choice, nothing else from
   * the renderer. The main process refuses a start within a few seconds of
   * the last one that opened the browser or offered its address
   * (`too_soon`).
   */
  readonly startSignIn: (
    options?: StartSignInOptions,
  ) => Promise<StartSignInResult>;
  /** Ends the open sign-in. Resolves to false when none was open. */
  readonly cancelSignIn: () => Promise<boolean>;
  /**
   * Loads a device key that a passphrase protects (Linux). The passphrase
   * goes to the main process and is never sent back.
   */
  readonly unlockDeviceKey: (passphrase: string) => Promise<UnlockResult>;
  /**
   * "This is not me": the main process asks the person to confirm in a
   * native dialog, removes the device at the API where it can, then deletes
   * the device key and the device record of this installation. Resolves to
   * `cancelled` when the person kept them.
   */
  readonly forgetAccount: () => Promise<ForgetResult>;
  /**
   * Signs out (P-65): the device and its key stay, and the next GitHub
   * sign-in is needed. Resolves to `pending` when the API learns it later.
   */
  readonly signOut: () => Promise<SignOutResult>;
  /**
   * Removes this device from its account: the main process asks the person
   * to confirm in a native dialog, and deletes the device key only after
   * the API confirmed. Resolves to `pending` while the API has not answered.
   */
  readonly removeDevice: () => Promise<RemoveDeviceResult>;
}

/**
 * The connection to the cloud API, which the main process keeps. The
 * renderer gets its status as fixed codes and can ask to connect again; it
 * never sees a frame, a nonce, a signature, or a key (ADR 0014).
 */
export interface ConnectionBridge {
  /** The current connection status. */
  readonly getStatus: () => Promise<ConnectionStatus>;
  /**
   * Calls `listener` with the current status and then after every change. A
   * status older than the last one delivered is dropped. `onError` is called
   * when the main process refuses the subscription. Returns a function that
   * ends the subscription.
   */
  readonly subscribeStatus: (
    listener: (status: ConnectionStatus) => void,
    onError?: () => void,
  ) => () => void;
  /**
   * Connects again at once, after the person's action: "Retry now" while
   * the connection waits, and "Reconnect here once" after another
   * installation took over the device's connection. It passes nothing from
   * the renderer on.
   */
  readonly reconnect: () => Promise<ReconnectResult>;
}

/**
 * The workspaces of the account, which the workspace service in the main
 * process holds. The renderer gets IDs, names, and fixed codes, and can
 * select a workspace or open a project; it never sees a member ID, a user
 * ID, or anything secret.
 */
export interface WorkspaceBridge {
  /** The current workspace state. */
  readonly getState: () => Promise<WorkspaceView>;
  /**
   * Calls `listener` with the current state and then after every change. A
   * state older than the last one delivered is dropped. `onError` is called
   * when the main process refuses the subscription. Returns a function that
   * ends the subscription.
   */
  readonly subscribeState: (
    listener: (state: WorkspaceView) => void,
    onError?: () => void,
  ) => () => void;
  /**
   * Selects a workspace of the list; the open project closes. Resolves to
   * `refused` with `not_found` for a workspace that the list does not hold,
   * and with `too_soon` beyond the main process's budget of switches to
   * another workspace (`WORKSPACE_SWITCH_BUDGET` per minute); selecting the
   * selected workspace is not counted. The main process accepts only a
   * lowercase UUIDv7.
   *
   * While chat messages wait to be sent, nothing changes and it resolves to
   * `waiting` with their count: the renderer asks the person, and repeats
   * the switch with `{ discardWaiting: true }` to drop them. The bridge
   * passes on only that fixed option of its own, nothing else from the
   * renderer.
   */
  readonly select: (
    workspaceId: string,
    options?: WorkspaceSwitchOptions,
  ) => Promise<WorkspaceActionResult>;
  /**
   * Opens a project of the selected workspace, or closes the open one with
   * null. Resolves to `refused` with `not_found` for a project that the
   * selected workspace does not hold, and to `waiting` while chat messages
   * wait to be sent, like `select`. The main process closes the open
   * project itself when a new page commits, also on a reload, when the page
   * fails to load, when the render process is gone, and when the window
   * closes.
   */
  readonly openProject: (
    projectId: string | null,
    options?: WorkspaceSwitchOptions,
  ) => Promise<WorkspaceActionResult>;
  /**
   * Creates a workspace with `name` (#95, D7); the account's own person in
   * it is the owner and has the account's display name. Resolves to `ok`
   * with the new workspace's ID and whether the main process selected it:
   * the new workspace joins the list at once, and it is selected unless
   * chat messages wait to be sent or another workspace was selected while
   * the create was on its way. An empty name, or one of more than 100
   * characters, is refused by the contract, and the call rejects; the main
   * process then refuses a blank name and control, format, and invisible
   * characters with `invalid`. It is sent once: `unknown` says that the
   * answer does not show whether the API acted, and nothing sends it again.
   * `too_soon` and `rate_limited` come with `retryAfterMs`. The bridge
   * passes on only a string.
   */
  readonly create: (name: string) => Promise<CreateWorkspaceResult>;
  /**
   * Creates a project with `name` in the selected workspace, by its ID; any
   * active member may. Another workspace is refused as `not_selected`, and
   * `conflict` means that a project of the workspace has the name, compared
   * without regard to case. The project list shows the new project once its
   * server event arrives. The name is checked as for `create`, after the
   * renderer normalized it to NFC and trimmed it, as the protocol does. It
   * is sent once, as `create` is. The bridge passes on only strings.
   */
  readonly createProject: (
    workspaceId: string,
    name: string,
  ) => Promise<CreateProjectResult>;
}

/**
 * The people of the selected workspace, which the workspace service in the
 * main process holds and keeps current with the membership events. The
 * renderer reads them and changes nothing: each person comes with its
 * member ID, display name, role, GitHub login, and whether it is claimed or
 * a former member, and the account's own person is named by its member ID.
 * No user ID crosses.
 */
export interface PeopleBridge {
  /** The current people of the selected workspace. */
  readonly getState: () => Promise<PeopleView>;
  /**
   * Calls `listener` with the current people and then after changes, at
   * most once every 50 ms with the latest ones. A state older than the last
   * one delivered is dropped. `onError` is called when the main process
   * refuses the subscription. Returns a function that ends the
   * subscription.
   */
  readonly subscribeState: (
    listener: (state: PeopleView) => void,
    onError?: () => void,
  ) => () => void;
}

/**
 * The actions on the people of the selected workspace (#95, D1), each
 * through its own channel. Every function takes the selected workspace's ID
 * and, where it names a person, the member ID from the people view, and the
 * main process refuses another workspace as `not_selected`. An empty name,
 * a name of more than 64 characters, or an ID that is not a lowercase
 * UUIDv7 is refused by the contract, and the call rejects; the main process
 * then refuses a blank name and control, format, and invisible characters
 * with the result `invalid`. Each action is
 * sent once: `unknown` says that the answer does not show whether the API
 * acted, and nothing sends it again, so the screen asks the person to check
 * the list. `too_soon` and `rate_limited` come with `retryAfterMs`. The
 * people view shows a confirmed change once its event arrives. The bridge
 * passes on only strings and refuses any other value without a call.
 */
export interface PeopleActionsBridge {
  /**
   * Defines an unclaimed person. Resolves to `ok` with the new person's
   * member ID. `unclaimed_limit`, without a wait, means that the workspace
   * holds as many active unclaimed people as its limit.
   */
  readonly define: (
    workspaceId: string,
    displayName: string,
  ) => Promise<DefinePersonResult>;
  /** Renames the account's own person or an unclaimed person. */
  readonly rename: (
    workspaceId: string,
    memberId: string,
    displayName: string,
  ) => Promise<PersonActionResult>;
  /** Removes a person; the API decides who may remove whom. */
  readonly remove: (
    workspaceId: string,
    memberId: string,
  ) => Promise<PersonActionResult>;
  /** Makes a claimed member an admin; the owner only. */
  readonly promote: (
    workspaceId: string,
    memberId: string,
  ) => Promise<PersonActionResult>;
  /** Makes an admin a member again; the owner only. */
  readonly demote: (
    workspaceId: string,
    memberId: string,
  ) => Promise<PersonActionResult>;
  /**
   * The account's own person leaves the workspace; the owner cannot. Once
   * the API confirmed it, the workspace leaves the workspace list.
   */
  readonly leave: (workspaceId: string) => Promise<PersonActionResult>;
  /** Offers the ownership to an active, claimed person; the owner only. */
  readonly offerOwnership: (
    workspaceId: string,
    memberId: string,
  ) => Promise<PersonActionResult>;
  /** Withdraws the live ownership offer; the owner only. */
  readonly withdrawOwnershipOffer: (
    workspaceId: string,
  ) => Promise<PersonActionResult>;
  /** Accepts the live ownership offer to the account's own person. */
  readonly acceptOwnershipOffer: (
    workspaceId: string,
  ) => Promise<PersonActionResult>;
}

/**
 * The live invitations of the selected workspace, which the main process
 * holds for its owner and admins (#95, D3): each invitation's ID, the
 * member ID of the unclaimed person that it claims, its creator's display
 * name, and its times. No invitation code and no user ID cross.
 */
export interface InvitationsBridge {
  /** The current live invitations. */
  readonly getState: () => Promise<InvitationsView>;
  /**
   * Calls `listener` with the current live invitations and then after
   * changes, at most once every 50 ms with the latest ones. A state older
   * than the last one delivered is dropped. `onError` is called when the
   * main process refuses the subscription. Returns a function that ends the
   * subscription.
   */
  readonly subscribeState: (
    listener: (state: InvitationsView) => void,
    onError?: () => void,
  ) => () => void;
  /**
   * Asks the main process to load the live invitations, when the screen
   * opens and on the person's refresh. From then on the main process loads
   * them again on its own after `workspace.subscribed`, a claim, and an
   * invitation action. Resolves to `refused` without a signed-in device, a
   * selected workspace, or the role of the owner or an admin, and with
   * `too_soon` within a few seconds of the last request. It passes nothing
   * from the renderer on.
   */
  readonly load: () => Promise<InvitationLoadResult>;
}

/**
 * The invitation actions (#95, D1 and D2), each through its own channel.
 * `create` and `revoke` take the selected workspace's ID, and the main
 * process refuses another workspace as `not_selected`. `preview` and
 * `accept` take the text that the person pasted, which must be an
 * invitation code exactly: the contract refuses any other text, and the
 * call rejects without repeating it. Each action is sent once: `unknown`
 * says that the answer does not show whether the API acted, and nothing
 * sends it again. `too_soon` and `rate_limited` come with `retryAfterMs`.
 * The bridge passes on only strings, and for `create` a whole number or
 * null, and refuses any other value without a call.
 */
export interface InvitationActionsBridge {
  /**
   * Creates an invitation for an unclaimed person, by its member ID, with a
   * lifetime of 1 hour to 7 days in seconds, or the API's 7 days when it is
   * left out or null. It revokes the person's previous live invitation.
   * Resolves to `ok` with the invitation's ID, its code, and when it
   * expires: the only time that the code is shown. Keep it only in the open
   * dialog; no channel returns it again.
   */
  readonly create: (
    workspaceId: string,
    memberId: string,
    lifetimeSeconds?: number | null,
  ) => Promise<CreateInvitationResult>;
  /** Revokes a live invitation, by its ID. */
  readonly revoke: (
    workspaceId: string,
    invitationId: string,
  ) => Promise<RevokeInvitationResult>;
  /**
   * Shows what a pasted code claims, without consuming it: the workspace's
   * name, the person's display name, the inviter's name and GitHub login,
   * and the expiry.
   */
  readonly preview: (code: string) => Promise<PreviewInvitationResult>;
  /**
   * Accepts a pasted code and claims its person. Resolves to `ok` with the
   * joined workspace's ID and name; the workspace list then loads again.
   */
  readonly accept: (code: string) => Promise<AcceptInvitationResult>;
}

/**
 * The account's own join requests, which the main process holds (#95, D3):
 * each with its ID, the ID of the workspace that it asks to join, the
 * requested display name, its times, and how it ended, a block shown as a
 * denial. The API shows the requester nothing else about the workspace, so
 * no workspace name comes. A pending request past its expiry comes as
 * `expired`. No user ID crosses.
 */
export interface OwnJoinRequestsBridge {
  /** The current own join requests. */
  readonly getState: () => Promise<OwnJoinRequestsView>;
  /**
   * Calls `listener` with the current own join requests and then after
   * changes, at most once every 50 ms with the latest ones. A state older
   * than the last one delivered is dropped. `onError` is called when the
   * main process refuses the subscription. Returns a function that ends the
   * subscription.
   */
  readonly subscribeState: (
    listener: (state: OwnJoinRequestsView) => void,
    onError?: () => void,
  ) => () => void;
  /**
   * Asks the main process to load the own join requests, when the screen
   * opens and on the person's refresh. From then on the main process loads
   * them again on its own after a sign-in, a reconnect, a decision on one of
   * them (`account.join_request_decided`), and an action. Resolves to
   * `refused` without a signed-in device, and with `too_soon` within a few
   * seconds of the last request. It passes nothing from the renderer on.
   */
  readonly load: () => Promise<OwnJoinRequestLoadResult>;
}

/**
 * The requester's actions (#95, D1), each through its own channel. An ID
 * that is not a lowercase UUIDv7, or a display name that is empty or longer
 * than 64 characters, is refused by the contract, and the call rejects; the
 * main process then refuses a blank name and control, format, and
 * invisible characters with the result `invalid`. Each action is sent
 * once: `unknown` says that the answer does not show whether the API
 * acted, and nothing sends it again, so the screen asks the person to
 * check the list. `too_soon` and `rate_limited` come with `retryAfterMs`.
 * The bridge passes on only strings, and for `create` a name string or
 * null, and refuses any other value without a call.
 */
export interface OwnJoinRequestActionsBridge {
  /**
   * Asks to join the workspace with the ID that the person typed, as a new
   * person with `displayName`, or with the account's display name when it
   * is left out or null; while no account is signed in, which would give
   * that name, it resolves to `refused` with `not_signed_in`. Resolves to
   * `ok` with the pending request: while one is pending for the workspace,
   * the API answers with it instead of creating another.
   */
  readonly create: (
    workspaceId: string,
    displayName?: string | null,
  ) => Promise<CreateJoinRequestResult>;
  /** Withdraws one of the account's own pending requests, by its ID. */
  readonly withdraw: (
    joinRequestId: string,
  ) => Promise<WithdrawJoinRequestResult>;
}

/**
 * The agents and runs of the open project, which the main process holds.
 * The renderer reads them and changes nothing: an agent's owner comes as a
 * display name, never as a member ID, and nothing names a device. The
 * newest runs come, with a count of the unfinished ones left out.
 */
export interface AgentBridge {
  /** The current agent activity. */
  readonly getState: () => Promise<AgentActivityView>;
  /**
   * Calls `listener` with the current agent activity and then after
   * changes, at most once every 50 ms with the latest one. An activity
   * older than the last one delivered is dropped. `onError` is called when
   * the main process refuses the subscription. Returns a function that ends
   * the subscription.
   */
  readonly subscribeState: (
    listener: (state: AgentActivityView) => void,
    onError?: () => void,
  ) => () => void;
}

/**
 * The chat of the open project, which the main process holds. The renderer
 * gets the newest messages that fit the view's limits, each author as a
 * display name, never as a member ID, and the person's messages that the
 * server has not stored yet, by their event IDs. It can send a message,
 * retry or discard one that waits, and load older messages.
 */
export interface ChatBridge {
  /** The current chat state. */
  readonly getState: () => Promise<ChatView>;
  /**
   * Calls `listener` with the current chat state and then after changes,
   * at most once every 50 ms with the latest one. A state older than the
   * last one delivered is dropped. `onError` is called when the main
   * process refuses the subscription. Returns a function that ends the
   * subscription.
   */
  readonly subscribeState: (
    listener: (state: ChatView) => void,
    onError?: () => void,
  ) => () => void;
  /**
   * Sends a message to the open project's chat. Resolves to `accepted`
   * with its event ID, after which it shows in `pending` until the server
   * stores it, or to `refused` with a reason. The main process applies the
   * protocol's rules to the text: a carriage return becomes a line feed,
   * and a blank text, a body of more than 16,000 characters (code points;
   * `too_long`), or a control, format, or invisible character is refused.
   * A text of more than 64,000 characters is refused by the contract
   * before that, and the call rejects. The bridge passes on only a string.
   */
  readonly send: (text: string) => Promise<ChatSendResultView>;
  /**
   * Tries a message that shows as not sent again, by its event ID.
   * Resolves to false for any other message.
   */
  readonly retry: (eventId: string) => Promise<boolean>;
  /**
   * Drops a message that waits or shows as not sent, by its event ID.
   * Resolves to false for a message that is being sent and for an unknown
   * one.
   */
  readonly discard: (eventId: string) => Promise<boolean>;
  /**
   * Loads the page of messages older than the held ones. Resolves to
   * `none` when there is nothing older to load or the view cannot show
   * more, to `busy` while a page is on its way, and to `too_soon` within
   * the backoff after an older page did not load: 2 s after the first
   * failure, doubling with each failure in a row up to 60 s, and 60 s after
   * the server asked to wait.
   */
  readonly loadOlder: () => Promise<ChatLoadOlderResultView>;
}

/**
 * The account's devices, which the main process holds (#95, D4 and D5b):
 * each device with its ID, label, platform, and times, the device of this
 * installation marked, the end of a registration lock in force, and the
 * notices of new devices. It never holds a user ID or a token.
 */
export interface DeviceListBridge {
  /** The current device list state. */
  readonly getState: () => Promise<DeviceListView>;
  /**
   * Calls `listener` with the current device list state and then after
   * changes, at most once every 50 ms with the latest one. A state older
   * than the last one delivered is dropped. `onError` is called when the
   * main process refuses the subscription. Returns a function that ends the
   * subscription.
   */
  readonly subscribeState: (
    listener: (state: DeviceListView) => void,
    onError?: () => void,
  ) => () => void;
  /**
   * Asks the main process to load the list, when the Account screen shows
   * it. From then on the main process loads it again on its own after the
   * account's device frames, a reconnect, and a device action. Resolves to
   * `refused` without a signed-in device, and with `too_soon` within a few
   * seconds of the last request. It passes nothing from the renderer on.
   */
  readonly load: () => Promise<DeviceListLoadResult>;
  /**
   * Dismisses the notices of new devices that the renderer showed, by the
   * device IDs that they name; a notice that arrived since stays. The
   * bridge passes on only a new array of the strings, and the main process
   * accepts 1 to 10 lowercase UUIDv7s. Resolves to false when none of them
   * was held.
   */
  readonly dismissNewDevices: (
    deviceIds: readonly string[],
  ) => Promise<boolean>;
  /**
   * Revokes another active device of the list, by its device ID, as
   * `removed` or as `lost`, which starts the account's 7-day registration
   * lock. The main process asks the person to confirm in a native dialog,
   * accepts only a lowercase UUIDv7 of an active device that its list holds
   * and that is not this one, and sends the request once; `unknown` says
   * that the answer does not show whether the server revoked it. The bridge
   * passes on only a string and one of the two reasons.
   */
  readonly revokeDevice: (
    deviceId: string,
    reason: OtherDeviceRevocation,
  ) => Promise<RevokeOtherDeviceResult>;
  /**
   * Lifts the account's registration lock while the list reports one. The
   * main process asks the person to confirm in a native dialog, which names
   * the end of the lock. It passes nothing from the renderer on.
   */
  readonly liftRegistrationLock: () => Promise<LiftRegistrationLockResult>;
  /**
   * Ends the advice after a revocation as lost, which the device list
   * holds until then (`lostDeviceAdvice`). Resolves to false when it did
   * not show. It passes nothing from the renderer on.
   */
  readonly dismissLostDeviceAdvice: () => Promise<boolean>;
}
