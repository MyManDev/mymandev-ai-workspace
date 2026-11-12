// The names of the IPC channels between the renderer and the main process.
// This module imports nothing, so the preload script can use the names without
// bundling zod. The schemas of every channel are in ipc-contract.ts.

/** Channels the renderer calls with `ipcRenderer.invoke`; the main process answers. */
export const INVOKE_CHANNELS = Object.freeze({
  /** The current status of the local runtime. */
  getRuntimeStatus: "runtime:get-status",
  /**
   * The current status of the local runtime. The calling frame then receives
   * every later status on `EVENT_CHANNELS.runtimeStatusChanged`.
   */
  subscribeRuntimeStatus: "runtime:subscribe-status",
  /** The mounted repositories. */
  listRepositories: "repositories:list",
  /**
   * The mounted repositories. The calling frame then receives every later
   * list on `EVENT_CHANNELS.repositoriesChanged`.
   */
  subscribeRepositories: "repositories:subscribe",
  /**
   * Opens the folder dialog of the main process and mounts the selected
   * repository. The renderer never sends a path.
   */
  mountRepository: "repositories:mount",
  /** Unmounts a repository by its mount ID. Nothing in the folder changes. */
  unmountRepository: "repositories:unmount",
  /**
   * The account status: the account, an open sign-in, the device key, and
   * the state of the device.
   */
  getAccountStatus: "account:get-status",
  /**
   * The account status. The calling frame then receives every later status
   * on `EVENT_CHANNELS.accountStatusChanged`.
   */
  subscribeAccountStatus: "account:subscribe-status",
  /**
   * Starts a GitHub sign-in in the system browser, after the person's
   * action. The renderer sends nothing.
   */
  startSignIn: "account:start-sign-in",
  /** Ends the open sign-in. */
  cancelSignIn: "account:cancel-sign-in",
  /**
   * Loads a device key that a passphrase protects (Linux). The passphrase is
   * the only secret that crosses IPC, from the renderer to the main process,
   * and it is never sent back.
   */
  unlockDeviceKey: "account:unlock-key",
  /**
   * "This is not me": the main process asks the person to confirm in a
   * native dialog, then deletes the device key and the device record of
   * this installation.
   */
  forgetAccount: "account:forget",
  /**
   * Signs out (P-65): the device and its key stay, and the next GitHub
   * sign-in is needed before the key is used again.
   */
  signOut: "account:sign-out",
  /**
   * Removes this device from its account: the main process asks the person
   * to confirm in a native dialog, and deletes the device key only after
   * the API confirmed the removal.
   */
  removeDevice: "account:remove-device",
  /** The status of the connection to the cloud API. */
  getConnectionStatus: "connection:get-status",
  /**
   * The status of the connection to the cloud API. The calling frame then
   * receives every later status on `EVENT_CHANNELS.connectionStatusChanged`.
   */
  subscribeConnectionStatus: "connection:subscribe-status",
  /**
   * Connects again after the person's action: "Retry now" while the
   * connection waits, or "Reconnect here once" after another installation
   * took over the device's connection. The renderer sends nothing.
   */
  reconnect: "connection:reconnect",
  /**
   * What the renderer may know of the workspace service's state: the
   * workspaces, the selected workspace's projects, and the open project.
   */
  getWorkspaceState: "workspaces:get-state",
  /**
   * The workspace state. The calling frame then receives every later state
   * on `EVENT_CHANNELS.workspaceStateChanged`.
   */
  subscribeWorkspaceState: "workspaces:subscribe-state",
  /**
   * Selects a workspace of the list by its ID. While chat messages wait to
   * be sent, it changes nothing and answers how many wait, unless the
   * option says to discard them.
   */
  selectWorkspace: "workspaces:select",
  /**
   * Opens a project of the selected workspace by its ID, or closes it with
   * null. Chat messages that wait hold the switch, as with `selectWorkspace`.
   */
  openProject: "workspaces:open-project",
  /**
   * What the renderer may know of the selected workspace's people: each
   * person's member ID, display name, role, GitHub login, and whether it is
   * claimed or a former member, and the account's own member ID. Read-only.
   */
  getPeopleState: "people:get-state",
  /**
   * The people of the selected workspace. The calling frame then receives
   * every later state on `EVENT_CHANNELS.peopleStateChanged`.
   */
  subscribePeopleState: "people:subscribe-state",
  /**
   * Defines an unclaimed person in the selected workspace, by the
   * workspace ID and a display name.
   */
  definePerson: "people:define",
  /**
   * Renames the account's own person or an unclaimed person, by the
   * workspace ID, the member ID, and a display name.
   */
  renamePerson: "people:rename",
  /** Removes a person, by the workspace ID and the member ID. */
  removePerson: "people:remove",
  /** Makes a claimed member an admin, by the workspace ID and the member ID. */
  promotePerson: "people:promote",
  /** Makes an admin a member again, by the workspace ID and the member ID. */
  demotePerson: "people:demote",
  /** The account's own person leaves the selected workspace, by its ID. */
  leaveWorkspace: "people:leave",
  /**
   * Offers the ownership of the selected workspace to a person, by the
   * workspace ID and the target's member ID.
   */
  offerOwnership: "people:offer-ownership",
  /** Withdraws the live ownership offer, by the workspace ID. */
  withdrawOwnershipOffer: "people:withdraw-offer",
  /** Accepts the live ownership offer to the account's person, by the workspace ID. */
  acceptOwnershipOffer: "people:accept-offer",
  /**
   * What the renderer may know of the selected workspace's live
   * invitations, for its owner and admins only: each invitation's ID, its
   * person's member ID, its creator's display name, and its times. Never an
   * invitation code.
   */
  getInvitationState: "invitations:get-state",
  /**
   * The live invitations. The calling frame then receives every later state
   * on `EVENT_CHANNELS.invitationStateChanged`.
   */
  subscribeInvitationState: "invitations:subscribe-state",
  /**
   * Loads the live invitations again, when the screen opens and on the
   * person's refresh; not within a few seconds of the last time. The
   * renderer sends nothing.
   */
  loadInvitations: "invitations:load",
  /**
   * Creates an invitation for an unclaimed person of the selected
   * workspace, by the workspace ID, the person's member ID, and a lifetime
   * or null. The answer carries the invitation code once.
   */
  createInvitation: "invitations:create",
  /** Revokes a live invitation, by the workspace ID and the invitation ID. */
  revokeInvitation: "invitations:revoke",
  /** Shows what a pasted invitation code claims, without consuming it. */
  previewInvitation: "invitations:preview",
  /** Accepts a pasted invitation code and claims its person. */
  acceptInvitation: "invitations:accept",
  /**
   * What the renderer may know of the account's own join requests: each
   * with its ID, the ID of the workspace that it asks to join, the
   * requested display name, how it ended, and its times. Never a user ID,
   * and nothing about the workspace but its ID.
   */
  getOwnJoinRequestState: "own-join-requests:get-state",
  /**
   * The own join requests. The calling frame then receives every later
   * state on `EVENT_CHANNELS.ownJoinRequestStateChanged`.
   */
  subscribeOwnJoinRequestState: "own-join-requests:subscribe-state",
  /**
   * Loads the own join requests again, when the screen opens and on the
   * person's refresh; not within a few seconds of the last time. The
   * renderer sends nothing.
   */
  loadOwnJoinRequests: "own-join-requests:load",
  /**
   * Asks to join a workspace, by its ID and a requested display name, or
   * null for the account's display name.
   */
  createJoinRequest: "own-join-requests:create",
  /** Withdraws one of the account's own pending join requests, by its ID. */
  withdrawJoinRequest: "own-join-requests:withdraw",
  /**
   * What the renderer may know of the open project's agent activity: its
   * agents with their owners' names, and its newest runs. Read-only.
   */
  getAgentState: "agents:get-state",
  /**
   * The agent activity. The calling frame then receives every later state
   * on `EVENT_CHANNELS.agentStateChanged`.
   */
  subscribeAgentState: "agents:subscribe-state",
  /**
   * What the renderer may know of the open project's chat: the newest
   * messages that fit the view's limits, with their authors' names, and the
   * person's messages that the server has not stored yet.
   */
  getChatState: "chat:get-state",
  /**
   * The chat state. The calling frame then receives every later state on
   * `EVENT_CHANNELS.chatStateChanged`.
   */
  subscribeChatState: "chat:subscribe-state",
  /** Sends the person's message to the open project's chat. */
  sendChatMessage: "chat:send",
  /** Tries a message that shows as not sent again, by its event ID. */
  retryChatMessage: "chat:retry",
  /** Drops a message that waits or shows as not sent, by its event ID. */
  discardChatMessage: "chat:discard",
  /**
   * Loads the page of chat messages older than the held ones, not again
   * within the backoff after a page did not load.
   */
  loadOlderChatMessages: "chat:load-older",
  /**
   * What the renderer may know of the account's devices: the device list,
   * the end of a registration lock in force, and the notices of new devices
   * (#95, D4 and D5b). Never a user ID or a token.
   */
  getDeviceList: "devices:get-state",
  /**
   * The device list state. The calling frame then receives every later state
   * on `EVENT_CHANNELS.deviceListChanged`.
   */
  subscribeDeviceList: "devices:subscribe-state",
  /**
   * Loads the device list again, when the Account screen shows it; not
   * within a few seconds of the last time. The renderer sends nothing.
   */
  loadDeviceList: "devices:load",
  /**
   * Dismisses the notices of new devices that the renderer showed, by the
   * device IDs that they name.
   */
  dismissNewDevices: "devices:dismiss-new-devices",
  /**
   * Revokes another active device of the account's list, by its device ID,
   * as removed or as lost: the main process asks the person to confirm in a
   * native dialog first.
   */
  revokeDevice: "devices:revoke",
  /**
   * Lifts the account's registration lock while the list reports one: the
   * main process asks the person to confirm in a native dialog first. The
   * renderer sends nothing.
   */
  liftRegistrationLock: "devices:lift-lock",
  /**
   * Ends the advice after a revocation as lost, which the device list holds
   * until then. The renderer sends nothing.
   */
  dismissLostDeviceAdvice: "devices:dismiss-advice",
} as const);

/** Channels the main process sends on with `webContents.send`. */
export const EVENT_CHANNELS = Object.freeze({
  /** The new status after every change, to the frames that subscribed. */
  runtimeStatusChanged: "runtime:status-changed",
  /** The mounted repositories after every change, to the frames that subscribed. */
  repositoriesChanged: "repositories:changed",
  /** The account status after every change, to the frames that subscribed. */
  accountStatusChanged: "account:status-changed",
  /** The connection status after every change, to the frames that subscribed. */
  connectionStatusChanged: "connection:status-changed",
  /** The workspace state after every change, to the frames that subscribed. */
  workspaceStateChanged: "workspaces:state-changed",
  /**
   * The people of the selected workspace after changes, at most one every
   * 50 ms, to the frames that subscribed.
   */
  peopleStateChanged: "people:state-changed",
  /**
   * The live invitations of the selected workspace after changes, at most
   * one every 50 ms, to the frames that subscribed.
   */
  invitationStateChanged: "invitations:state-changed",
  /**
   * The account's own join requests after changes, at most one every
   * 50 ms, to the frames that subscribed.
   */
  ownJoinRequestStateChanged: "own-join-requests:state-changed",
  /**
   * The agent activity after changes, at most one every 50 ms, to the
   * frames that subscribed.
   */
  agentStateChanged: "agents:state-changed",
  /**
   * The chat state after changes, at most one every 50 ms, to the frames
   * that subscribed.
   */
  chatStateChanged: "chat:state-changed",
  /**
   * The device list state after changes, at most one every 50 ms, to the
   * frames that subscribed.
   */
  deviceListChanged: "devices:state-changed",
} as const);

export type InvokeChannel =
  (typeof INVOKE_CHANNELS)[keyof typeof INVOKE_CHANNELS];

export type EventChannel = (typeof EVENT_CHANNELS)[keyof typeof EVENT_CHANNELS];
