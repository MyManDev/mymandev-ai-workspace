import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
} from "react";
import type {
  AccountBridge,
  AgentBridge,
  ChatBridge,
  ConnectionBridge,
  DeviceListBridge,
  InvitationActionsBridge,
  InvitationsBridge,
  PeopleActionsBridge,
  PeopleBridge,
  RepositoryBridge,
  RuntimeBridge,
  WorkspaceBridge,
} from "../shared/desktop-bridge.ts";
import type { WorkspaceView } from "../shared/ipc-contract.ts";
import { PRODUCT_NAME } from "../shared/product.ts";
import { AccountScreen } from "./AccountScreen.tsx";
import { initialAccountView, type AccountView } from "./account-view.ts";
import { ChatScreen } from "./ChatScreen.tsx";
import {
  CreateDialogBox,
  useCreation,
  type CreationControls,
} from "./Creation.tsx";
import { createdOpenPaths } from "./creation-view.ts";
import {
  CONNECTION_ACTION_LABELS,
  CONNECTION_STATUS_TEXT_ID,
  createDeviceRemoval,
  describeConnectionView,
  focusesStatus,
  IDLE_DEVICE_REMOVAL,
  initialConnectionView,
  type ConnectionAction,
  type ConnectionView,
  type DeviceRemovalView,
} from "./connection-status.ts";
import { JoinScreen } from "./JoinScreen.tsx";
import {
  ProjectNav,
  WorkspaceNav,
  type WorkspaceSidebar,
} from "./Navigation.tsx";
import { PeopleScreen } from "./PeopleScreen.tsx";
import { ProjectPanel } from "./ProjectPanel.tsx";
import {
  DecisionsScreen,
  PermissionsScreen,
  TasksScreen,
} from "./ProjectScreens.tsx";
import {
  describeRuntimeView,
  initialRuntimeView,
  type RuntimeView,
} from "./runtime-status.ts";
import {
  createShellState,
  HOME_VIEW,
  isProjectView,
  openProject,
  shellReducer,
  type ShellAction,
  type ShellView,
} from "./screens.ts";
import { SwitchQuestionDialog } from "./SwitchQuestion.tsx";
import {
  createHomeSignInStart,
  createWorkspaceSidebar,
  homeCaseForView,
  homeSignIn,
  IDLE_HOME_SIGN_IN_START,
  initialWorkspacePanelView,
  type HomeSignIn,
  type HomeSignInStartView,
  type SwitchQuestion,
} from "./workspace-view.ts";
import {
  AboutScreen,
  HomeScreen,
  showAccountScreen,
} from "./WorkspaceScreens.tsx";

export interface AppProps {
  /** The Electron version from the preload script; undefined outside Electron. */
  readonly electronVersion?: string | undefined;
  /** The local runtime from the preload script; undefined outside Electron. */
  readonly runtime?: RuntimeBridge | undefined;
  /** The mounted repositories from the preload script; undefined outside Electron. */
  readonly repositories?: RepositoryBridge | undefined;
  /** The sign-in of this installation from the preload script; undefined outside Electron. */
  readonly account?: AccountBridge | undefined;
  /** The connection to the cloud API from the preload script; undefined outside Electron. */
  readonly connection?: ConnectionBridge | undefined;
  /** The account's workspaces from the preload script; undefined outside Electron. */
  readonly workspaces?: WorkspaceBridge | undefined;
  /** The selected workspace's people from the preload script; undefined outside Electron. */
  readonly people?: PeopleBridge | undefined;
  /** The people actions from the preload script; undefined outside Electron. */
  readonly peopleActions?: PeopleActionsBridge | undefined;
  /** The selected workspace's live invitations from the preload script; undefined outside Electron. */
  readonly invitations?: InvitationsBridge | undefined;
  /** The invitation actions from the preload script; undefined outside Electron. */
  readonly invitationActions?: InvitationActionsBridge | undefined;
  /** The open project's agent activity from the preload script; undefined outside Electron. */
  readonly agents?: AgentBridge | undefined;
  /** The open project's chat from the preload script; undefined outside Electron. */
  readonly chat?: ChatBridge | undefined;
  /** The account's devices from the preload script; undefined outside Electron. */
  readonly devices?: DeviceListBridge | undefined;
  /**
   * The workspace state shown until the bridge delivers one, for tests and
   * previews. Without it, the shell starts without projects.
   */
  readonly initialWorkspaceState?: WorkspaceView | undefined;
  /** The view shown first. An invalid view shows the home screen. */
  readonly initialView?: ShellView;
}

export function App({
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
  initialWorkspaceState,
  initialView = HOME_VIEW,
}: AppProps) {
  const [state, dispatch] = useReducer(shellReducer, initialView, (view) =>
    createShellState(initialWorkspaceState?.projects ?? [], view),
  );
  const { sidebar: workspaceSidebar, question } = useWorkspaces(
    workspaces,
    initialWorkspaceState,
    dispatch,
    isProjectView(state.view) ? state.view.projectId : null,
  );
  const runtimeView = useRuntimeView(runtime);
  const connectionView = useConnectionView(connection);
  const accountView = useAccountView(account);
  const removal = useDeviceRemoval(account, accountView);
  const onActionFocus = useConnectionStatusFocus(
    describeConnectionView(connectionView, accountView).actions,
  );
  const focusAfterShow = useFocusAfterShow(state.view);
  const homeCase = homeSignIn(workspaceSidebar.view, accountView);
  const homeStart = useHomeSignInStart(
    account,
    accountView,
    homeCaseForView(state.view, homeCase),
    dispatch,
    focusAfterShow,
  );
  const open = openProject(state);
  // "Open this workspace" and "Open this project" take the sidebar's own
  // paths, which ask before a switch drops waiting chat messages.
  const selectWorkspace = workspaceSidebar.onSelect;
  const openPaths = useMemo(
    () => createdOpenPaths(selectWorkspace, dispatch),
    [selectWorkspace],
  );
  const creation = useCreation(
    workspaces,
    workspaceSidebar.view,
    state.view.screen === "home",
    openPaths,
  );

  return (
    <div className={open === undefined ? "shell" : "shell shell-project"}>
      <header className="shell-header">
        <h1>{PRODUCT_NAME}</h1>
        <div className="shell-status">
          <ConnectionStatusIndicator
            view={connectionView}
            account={accountView}
            onReconnect={
              connection === undefined
                ? undefined
                : () => {
                    // The status shows what follows; a refusal changes nothing.
                    connection.reconnect().catch(() => undefined);
                  }
            }
            onReconnecting={removal.onReconnecting}
            onRemoveDevice={removal.onRemove}
            onActionFocus={onActionFocus}
            removal={removal.view}
          />
          <RuntimeStatusIndicator view={runtimeView} />
        </div>
      </header>
      <WorkspaceNav
        state={state}
        dispatch={dispatch}
        workspaces={workspaceSidebar}
        creation={creation}
      />
      {open === undefined ? null : (
        <ProjectNav
          project={open.project}
          screen={open.view.screen}
          dispatch={dispatch}
        />
      )}
      <main className="shell-main">
        <ScreenContent
          view={state.view}
          electronVersion={electronVersion}
          people={people}
          peopleActions={peopleActions}
          invitations={invitations}
          invitationActions={invitationActions}
          workspaces={workspaceSidebar}
          account={account}
          chat={chat}
          devices={devices}
          homeSignIn={homeCase}
          homeStart={homeStart.view}
          onStartSignIn={homeStart.onStart}
          dispatch={dispatch}
          focusAfterShow={focusAfterShow}
          creation={creation}
        />
      </main>
      {open === undefined ? null : (
        <ProjectPanel
          panel={open.view.panel}
          projectId={open.project.id}
          dispatch={dispatch}
          agents={agents}
          repositories={repositories}
        />
      )}
      <SwitchQuestionDialog {...question} />
      {creation === undefined ? null : (
        <CreateDialogBox
          dialog={creation.view.dialog}
          onConfirm={creation.onConfirm}
          onCancel={creation.onCancel}
          onDraft={creation.onDialogDraft}
        />
      )}
    </div>
  );
}

function ScreenContent({
  view,
  electronVersion,
  people,
  peopleActions,
  invitations,
  invitationActions,
  workspaces,
  account,
  chat,
  devices,
  homeSignIn,
  homeStart,
  onStartSignIn,
  dispatch,
  focusAfterShow,
  creation,
}: {
  readonly view: ShellView;
  readonly electronVersion: string | undefined;
  readonly people: PeopleBridge | undefined;
  readonly peopleActions: PeopleActionsBridge | undefined;
  readonly invitations: InvitationsBridge | undefined;
  readonly invitationActions: InvitationActionsBridge | undefined;
  /** The workspace part of the sidebar, for the join screen. */
  readonly workspaces: WorkspaceSidebar;
  readonly account: AccountBridge | undefined;
  readonly chat: ChatBridge | undefined;
  readonly devices: DeviceListBridge | undefined;
  /** What the home screen says about the sign-in. */
  readonly homeSignIn: HomeSignIn;
  /** The sign-in that the home screen started. */
  readonly homeStart: HomeSignInStartView;
  readonly onStartSignIn: () => void;
  readonly dispatch: Dispatch<ShellAction>;
  readonly focusAfterShow: (id: string) => void;
  /** The creates, for the home screen's form; undefined without the bridge. */
  readonly creation: CreationControls | undefined;
}) {
  switch (view.screen) {
    case "home":
      return (
        <HomeScreen
          signIn={homeSignIn}
          start={homeStart}
          onStartSignIn={onStartSignIn}
          dispatch={dispatch}
          focusAfterShow={focusAfterShow}
          creation={creation}
        />
      );
    case "account":
      return <AccountScreen account={account} devices={devices} />;
    case "people":
      return (
        <PeopleScreen
          people={people}
          peopleActions={peopleActions}
          invitations={invitations}
          invitationActions={invitationActions}
        />
      );
    case "join":
      return (
        <JoinScreen
          invitationActions={invitationActions}
          workspaces={workspaces.view}
          onOpenWorkspace={workspaces.onSelect}
        />
      );
    case "about":
      return <AboutScreen electronVersion={electronVersion} />;
    case "chat":
      // Each project gets its own screen, so no draft moves to another one.
      return (
        <ChatScreen
          key={view.projectId}
          chat={chat}
          projectId={view.projectId}
        />
      );
    case "tasks":
      return <TasksScreen />;
    case "decisions":
      return <DecisionsScreen />;
    case "permissions":
      return <PermissionsScreen />;
  }
}

/**
 * Follows the workspace state while the shell is mounted, reports the open
 * project to the main process at the start and after every change,
 * switches workspaces, and asks the person before a switch while chat
 * messages wait to be sent. The logic is in `createWorkspaceSidebar`.
 */
function useWorkspaces(
  workspaces: WorkspaceBridge | undefined,
  initialState: WorkspaceView | undefined,
  dispatch: Dispatch<ShellAction>,
  openProjectId: string | null,
): {
  readonly sidebar: WorkspaceSidebar;
  readonly question: {
    readonly question: SwitchQuestion | undefined;
    readonly onKeep: () => void;
    readonly onDiscard: () => void;
  };
} {
  const [view, setView] = useState(() =>
    initialState === undefined
      ? initialWorkspacePanelView(workspaces !== undefined)
      : { kind: "known" as const, state: initialState },
  );
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [question, setQuestion] = useState<SwitchQuestion | undefined>(
    undefined,
  );
  const controller = useMemo(
    () =>
      workspaces === undefined
        ? undefined
        : createWorkspaceSidebar(
            workspaces,
            dispatch,
            setView,
            setMessage,
            setQuestion,
          ),
    [workspaces, dispatch],
  );

  useEffect(() => controller?.start(), [controller]);
  useEffect(
    () => controller?.openProjectChanged(openProjectId),
    [controller, openProjectId],
  );
  const onSelect = useCallback(
    (workspaceId: string) => controller?.select(workspaceId),
    [controller],
  );

  const onKeep = useCallback(() => controller?.keepWaiting(), [controller]);
  const onDiscard = useCallback(
    () => controller?.discardWaiting(),
    [controller],
  );

  return {
    sidebar: { view, message, onSelect },
    question: { question, onKeep, onDiscard },
  };
}

/**
 * Moves the focus to an element of the next view once the shell shows it,
 * for a button that leaves the page with its own screen, where the focus
 * would drop to the page. The returned function names the element by its
 * ID before the button changes the view; each change of the view takes the
 * request, also when the element is not there.
 */
function useFocusAfterShow(view: ShellView): (id: string) => void {
  const pending = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = pending.current;
    pending.current = undefined;
    if (id !== undefined) {
      document.getElementById(id)?.focus();
    }
  }, [view]);
  return useCallback((id: string) => {
    pending.current = id;
  }, []);
}

/**
 * "Sign in with GitHub" on the home screen (#219), through the account
 * bridge, while the shell is mounted. The logic is in
 * `createHomeSignInStart`; the account status shows the account screen
 * once the sign-in runs, and the start's message ends when the shell
 * leaves the home screen or the home screen's case changes (`home`,
 * undefined on another screen).
 */
function useHomeSignInStart(
  account: AccountBridge | undefined,
  accountView: AccountView,
  home: HomeSignIn | undefined,
  dispatch: Dispatch<ShellAction>,
  focusAfterShow: (id: string) => void,
): {
  readonly view: HomeSignInStartView;
  readonly onStart: () => void;
} {
  const [view, setView] = useState(IDLE_HOME_SIGN_IN_START);
  const start = useMemo(
    () =>
      account === undefined
        ? undefined
        : createHomeSignInStart(
            account,
            () => showAccountScreen(dispatch, focusAfterShow),
            setView,
          ),
    [account, dispatch, focusAfterShow],
  );
  useEffect(() => start?.accountChanged(accountView), [start, accountView]);
  useEffect(() => start?.homeChanged(home), [start, home]);
  const onStart = useCallback(() => start?.start(), [start]);
  return { view, onStart };
}

/**
 * Follows the account status while the shell is mounted, for the home
 * screen and the connection indicator. The account panel follows it on its
 * own while it is shown.
 */
function useAccountView(account: AccountBridge | undefined): AccountView {
  const [view, setView] = useState(() =>
    initialAccountView(account !== undefined),
  );
  useEffect(() => {
    if (account === undefined) {
      return undefined;
    }
    return account.subscribeStatus(
      (status) => setView({ kind: "known", status }),
      () => setView({ kind: "unavailable" }),
    );
  }, [account]);
  return view;
}

/** Follows the status of the local runtime while the shell is mounted. */
function useRuntimeView(runtime: RuntimeBridge | undefined): RuntimeView {
  const [view, setView] = useState(() =>
    initialRuntimeView(runtime !== undefined),
  );
  useEffect(() => {
    if (runtime === undefined) {
      return undefined;
    }
    return runtime.subscribeStatus(
      (status) => setView({ kind: "known", status }),
      () => setView({ kind: "unavailable" }),
    );
  }, [runtime]);
  return view;
}

export function RuntimeStatusIndicator({
  view,
}: {
  readonly view: RuntimeView;
}) {
  const { tone, label } = describeRuntimeView(view);
  return (
    <p className="runtime-status" role="status" data-state={tone}>
      <span className="runtime-status-dot" aria-hidden="true" />
      {label}
    </p>
  );
}

/** Follows the status of the connection to the cloud API while the shell is mounted. */
function useConnectionView(
  connection: ConnectionBridge | undefined,
): ConnectionView {
  const [view, setView] = useState(() =>
    initialConnectionView(connection !== undefined),
  );
  useEffect(() => {
    if (connection === undefined) {
      return undefined;
    }
    return connection.subscribeStatus(
      (status) => setView({ kind: "known", status }),
      () => setView({ kind: "unavailable" }),
    );
  }, [connection]);
  return view;
}

/**
 * "Remove this device and register again" for the connection indicator,
 * through the account bridge, while the shell is mounted. The logic is in
 * `createDeviceRemoval`; the account status and a reconnect from the
 * header end the message of the last removal.
 */
function useDeviceRemoval(
  account: AccountBridge | undefined,
  accountView: AccountView,
): {
  readonly view: DeviceRemovalView;
  readonly onRemove: (() => void) | undefined;
  readonly onReconnecting: (() => void) | undefined;
} {
  const [view, setView] = useState(IDLE_DEVICE_REMOVAL);
  const removal = useMemo(
    () =>
      account === undefined ? undefined : createDeviceRemoval(account, setView),
    [account],
  );
  useEffect(() => removal?.accountChanged(accountView), [removal, accountView]);
  return {
    view,
    onRemove: removal?.remove,
    onReconnecting: removal?.reconnecting,
  };
}

/**
 * Moves the focus to the connection indicator's status paragraph, without
 * scrolling, when the header button that had the focus went away with its
 * action (`focusesStatus`), for example once a removal is confirmed and
 * the status becomes `offline`, so that the focus does not drop to the
 * page. The returned function notes which button has the focus. Chromium
 * fires no blur when it removes the focused element, so the note still
 * names the button when its action goes. A blur while the window has no
 * focus, as when the main process opens its native dialog, keeps the note
 * too: the button stays the page's focused element, whether the status
 * removes it before the window comes back or Chromium focuses it again
 * first. The actions are the frozen lists of `describeConnectionView`, so
 * only a change runs the check.
 */
function useConnectionStatusFocus(
  actions: readonly ConnectionAction[],
): (action: ConnectionAction | undefined) => void {
  const focused = useRef<ConnectionAction | undefined>(undefined);
  useEffect(() => {
    const action = focused.current;
    const active = document.activeElement;
    if (
      focusesStatus(
        action,
        actions,
        active === null || active === document.body,
      )
    ) {
      document
        .getElementById(CONNECTION_STATUS_TEXT_ID)
        ?.focus({ preventScroll: true });
    }
    if (action !== undefined && !actions.includes(action)) {
      // The focused button went away with its action.
      focused.current = undefined;
    }
  }, [actions]);
  return useCallback((action: ConnectionAction | undefined) => {
    focused.current = action;
  }, []);
}

/**
 * The connection status in the header: the state, a fixed sentence about
 * the reason, and "Retry now", or "Reconnect here once" and "Remove this
 * device and register again", where the person can act. An action shows
 * only with its handler. The main process confirms a removal in a native
 * dialog; the result's message joins the status. While a removal runs, the
 * buttons stay focusable and do nothing (`aria-disabled`), so the dialog
 * gives the focus back to the button (the Project Manager's decision of
 * 2026-11-06). A sign-in starts only from the account panel or the home
 * screen, on the person's click.
 */
export function ConnectionStatusIndicator({
  view,
  account,
  onReconnect,
  onReconnecting,
  onRemoveDevice,
  onActionFocus,
  removal = IDLE_DEVICE_REMOVAL,
}: {
  readonly view: ConnectionView;
  /** The account status: it decides the sign-in sentence and the actions after `connection_replaced`. */
  readonly account: AccountView;
  readonly onReconnect?: (() => void) | undefined;
  /**
   * The removal's `reconnecting`: "Retry now" and "Reconnect here once"
   * call it before `onReconnect`, so the message of the last removal ends.
   */
  readonly onReconnecting?: (() => void) | undefined;
  readonly onRemoveDevice?: (() => void) | undefined;
  /**
   * Gets the action of the button that takes the focus, and undefined when
   * a button that is still in the page loses it while the window has the
   * focus.
   */
  readonly onActionFocus?:
    ((action: ConnectionAction | undefined) => void) | undefined;
  readonly removal?: DeviceRemovalView | undefined;
}) {
  const { tone, label, detail, actions } = describeConnectionView(
    view,
    account,
    removal.message,
  );
  const reconnect =
    onReconnect === undefined
      ? undefined
      : () => {
          onReconnecting?.();
          onReconnect();
        };
  const handlers: Readonly<Record<ConnectionAction, (() => void) | undefined>> =
    {
      retry_now: reconnect,
      reconnect_here: reconnect,
      remove_and_register: onRemoveDevice,
    };
  return (
    <div className="connection-status" data-state={tone}>
      <p
        className="connection-status-text"
        id={CONNECTION_STATUS_TEXT_ID}
        role="status"
        tabIndex={-1}
      >
        <span className="connection-status-dot" aria-hidden="true" />
        {label}
        {detail === null ? null : (
          <span className="connection-status-detail">{detail}</span>
        )}
        {removal.message === undefined ? null : (
          <span className="connection-status-detail">{removal.message}</span>
        )}
      </p>
      {actions.map((action) => {
        const handler = handlers[action];
        return handler === undefined ? null : (
          <button
            key={action}
            type="button"
            aria-disabled={removal.running ? "true" : undefined}
            onClick={removal.running ? undefined : handler}
            onFocus={() => onActionFocus?.(action)}
            onBlur={(event) => {
              // A blur of a button that left the page is not the person's,
              // and neither is one while the window has no focus, as when
              // the removal's native dialog opens: the button stays the
              // page's focused element.
              const button = event.currentTarget;
              if (button.isConnected && button.ownerDocument.hasFocus()) {
                onActionFocus?.(undefined);
              }
            }}
          >
            {CONNECTION_ACTION_LABELS[action]}
          </button>
        );
      })}
    </div>
  );
}
