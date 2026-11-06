import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { AccountBridge } from "../shared/desktop-bridge.ts";
import type {
  AccountStatus,
  DeviceView,
  SignInState,
  UnlockResult,
} from "../shared/ipc-contract.ts";
import {
  ACTION_MESSAGES,
  ANOTHER_BROWSER_DELAY_MS,
  apiOriginProblem,
  createIdleWaits,
  DEVICE_ACTION_MESSAGES,
  DEVICE_KEY_PROBLEM_MESSAGES,
  describeDeviceState,
  describeOutcome,
  deviceDetail,
  followAccountStatus,
  forgetMessage,
  initialAccountView,
  listDevicesMessage,
  offersForget,
  offersSignIn,
  removeDeviceMessage,
  signOutMessage,
  startInAnotherBrowser,
  startMessage,
  waitingPairingCode,
  type AccountView,
} from "./account-view.ts";

/**
 * The account of this installation: sign in with GitHub, in the default
 * browser or in another one (#175), the pairing code while the browser is
 * open, the GitHub login after a sign-in with "This is not me" (#149) and no
 * account while the device is signed out (#195), the passphrase of a device
 * key that needs one, the state of the device with sign-out, removing this
 * device, and a simple device list. The main process runs the sign-in and
 * the device session; the panel never sees a sign-in code, a key, or a
 * token. The screens of #95 replace it.
 */
export function AccountPanel({
  account,
}: {
  readonly account: AccountBridge | undefined;
}) {
  return <AccountPanelContent {...useAccountPanel(account)} />;
}

export interface AccountPanelContentProps {
  readonly view: AccountView;
  /** True while an action waits for the main process. */
  readonly busy: boolean;
  /** Why the last action was refused or failed. */
  readonly message: string | undefined;
  readonly onStartSignIn: () => void;
  /**
   * "Use another browser" (#175): a sign-in that waits in the browser is
   * cancelled first, then one starts that offers its address for copying.
   */
  readonly onUseAnotherBrowser: () => void;
  /**
   * Whether the last start that the panel asked for was in another browser,
   * which words the text while it starts. The address of a waiting sign-in
   * is worded from the status, which stays when the panel is shown again.
   */
  readonly anotherBrowser: boolean;
  /**
   * Whether "Use another browser" can replace the sign-in that waits in the
   * browser: only `ANOTHER_BROWSER_DELAY_MS` after the panel saw it wait.
   */
  readonly anotherBrowserReady: boolean;
  readonly onCancelSignIn: () => void;
  readonly onUnlock: (passphrase: string) => void;
  /**
   * "This is not me": the main process asks for confirmation in a native
   * dialog, the only confirmation, which the renderer cannot answer.
   */
  readonly onForget: () => void;
  /** The account's devices after "Show devices", or undefined before. */
  readonly devices: readonly DeviceView[] | undefined;
  readonly onSignOut: () => void;
  /** The main process confirms the removal in a native dialog. */
  readonly onRemoveDevice: () => void;
  readonly onListDevices: () => void;
}

export function AccountPanelContent(props: AccountPanelContentProps) {
  return (
    <section className="account-panel" aria-labelledby="account-title">
      <h3 id="account-title">Account</h3>
      <AccountBody {...props} />
    </section>
  );
}

function AccountBody(props: AccountPanelContentProps) {
  const { view, message } = props;
  switch (view.kind) {
    case "unavailable":
      return <p>Sign-in is not available.</p>;
    case "pending":
      return <p>Checking the sign-in.</p>;
    case "known":
      break;
  }
  const { status } = view;
  if (status.deviceKey === "loading") {
    return <p role="status">Reading the device key.</p>;
  }
  const outcome =
    status.lastOutcome === null || status.signIn.kind !== "idle"
      ? undefined
      : describeOutcome(status.lastOutcome);
  const deviceState =
    status.signIn.kind === "idle"
      ? describeDeviceState(status.device)
      : undefined;
  return (
    <>
      <AccountSummary status={status} />
      {deviceState === undefined ? null : (
        <p
          className={
            deviceState.role === "alert" ? "panel-message" : "account-message"
          }
          role={deviceState.role}
        >
          {deviceState.text}
        </p>
      )}
      <DeviceKeyNotice {...props} status={status} />
      <SignInActions {...props} status={status} />
      {props.devices === undefined ||
      status.device !== "signed_in" ||
      status.signIn.kind !== "idle" ? null : (
        <DeviceList devices={props.devices} />
      )}
      {outcome === undefined ? null : (
        <p
          className={
            outcome.role === "alert" ? "panel-message" : "account-message"
          }
          role={outcome.role}
        >
          {status.lastOutcome?.code === "signed_in" &&
          status.account.kind === "signed_in" ? (
            <>
              This device is now signed in to GitHub as{" "}
              <strong>{status.account.login}</strong>. If this is not your
              account, choose "This is not me".
            </>
          ) : (
            outcome.text
          )}
        </p>
      )}
      {message === undefined ? null : (
        <p className="panel-message" role="alert">
          {message}
        </p>
      )}
      {status.replacementPending ? (
        <p className="placeholder-note">
          The device key of the last sign-in is not confirmed yet.
        </p>
      ) : null}
    </>
  );
}

function AccountSummary({ status }: { readonly status: AccountStatus }) {
  // Also while the device is signed out: the main process then names no
  // account (`hidden`, #195).
  if (status.account.kind !== "signed_in") {
    return <p>Not signed in.</p>;
  }
  return (
    <dl className="account-facts">
      <dt>GitHub login</dt>
      <dd>{status.account.login}</dd>
      <dt>Name</dt>
      <dd>{status.account.displayName}</dd>
    </dl>
  );
}

function DeviceKeyNotice({
  status,
  busy,
  onUnlock,
}: AccountPanelContentProps & { readonly status: AccountStatus }) {
  switch (status.deviceKey) {
    case "loading":
    case "ready":
      return null;
    case "passphrase_required":
      return <UnlockForm busy={busy} onUnlock={onUnlock} />;
    default:
      return (
        <p className="panel-message" role="alert">
          {DEVICE_KEY_PROBLEM_MESSAGES[status.deviceKey]}
        </p>
      );
  }
}

/**
 * The passphrase of a device key (Linux). The field is cleared after every
 * attempt; the passphrase leaves the renderer only to the main process.
 */
function UnlockForm({
  busy,
  onUnlock,
}: {
  readonly busy: boolean;
  readonly onUnlock: (passphrase: string) => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (passphrase === "" || busy) {
      return;
    }
    onUnlock(passphrase);
    setPassphrase("");
  };
  return (
    <form
      className="account-form"
      aria-labelledby="unlock-title"
      onSubmit={submit}
    >
      <p id="unlock-title">
        The device key is protected by a passphrase. Enter it to use this
        device.
      </p>
      <label className="account-label" htmlFor="account-passphrase">
        Passphrase
      </label>
      <input
        id="account-passphrase"
        className="account-input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={passphrase}
        disabled={busy}
        onChange={(event) => setPassphrase(event.currentTarget.value)}
      />
      <div className="account-actions">
        <button
          type="submit"
          className="panel-action"
          disabled={busy || passphrase === ""}
        >
          Unlock
        </button>
      </div>
    </form>
  );
}

function SignInActions(
  props: AccountPanelContentProps & { readonly status: AccountStatus },
) {
  const { status, busy } = props;
  const { signIn } = status;
  if (signIn.kind !== "idle") {
    return (
      <SignInProgress
        signIn={signIn}
        busy={busy}
        anotherBrowser={props.anotherBrowser}
        anotherBrowserReady={props.anotherBrowserReady}
        onCancel={props.onCancelSignIn}
        onUseAnotherBrowser={props.onUseAnotherBrowser}
      />
    );
  }
  const signedIn = status.account.kind === "signed_in";
  const usable = signedIn && status.device === "signed_in";
  const canSignIn = offersSignIn(status);
  const originProblem = canSignIn
    ? apiOriginProblem(status.apiOrigin)
    : undefined;
  const signInDisabled =
    busy || status.deviceKey !== "ready" || originProblem !== undefined;
  const signInDescription =
    originProblem === undefined ? undefined : "sign-in-unavailable";
  return (
    <>
      <div className="account-actions">
        {canSignIn ? (
          <>
            <button
              type="button"
              className="panel-action"
              disabled={signInDisabled}
              aria-describedby={signInDescription}
              onClick={props.onStartSignIn}
            >
              Sign in with GitHub
            </button>
            <button
              type="button"
              className="panel-action"
              disabled={signInDisabled}
              aria-describedby={signInDescription}
              onClick={props.onUseAnotherBrowser}
            >
              Use another browser
            </button>
          </>
        ) : null}
        {usable ? (
          <>
            <button
              type="button"
              className="panel-action"
              disabled={busy}
              onClick={props.onListDevices}
            >
              Show devices
            </button>
            <button
              type="button"
              className="panel-action"
              disabled={busy}
              onClick={props.onSignOut}
            >
              Sign out
            </button>
          </>
        ) : null}
        {usable || (signedIn && status.device === "removal_pending") ? (
          <button
            type="button"
            className="panel-action"
            disabled={busy}
            onClick={props.onRemoveDevice}
          >
            Remove this device
          </button>
        ) : null}
        {offersForget(status) ? (
          <button
            type="button"
            className="panel-action"
            disabled={busy}
            onClick={props.onForget}
          >
            This is not me
          </button>
        ) : null}
      </div>
      {originProblem === undefined ? null : (
        <p className="placeholder-note" id="sign-in-unavailable">
          {originProblem}
        </p>
      )}
    </>
  );
}

function SignInProgress({
  signIn,
  busy,
  anotherBrowser,
  anotherBrowserReady,
  onCancel,
  onUseAnotherBrowser,
}: {
  readonly signIn: Exclude<SignInState, { readonly kind: "idle" }>;
  readonly busy: boolean;
  readonly anotherBrowser: boolean;
  readonly anotherBrowserReady: boolean;
  readonly onCancel: () => void;
  readonly onUseAnotherBrowser: () => void;
}) {
  // Offered while the sign-in waits in the browser that opened, which may
  // hold another GitHub account. The address of this attempt is bound to
  // that browser, so a new attempt starts, once the main process accepts
  // a new start.
  const offersAnotherBrowser = signIn.kind === "waiting" && signIn.opened;
  const cancel = (
    <div className="account-actions">
      {offersAnotherBrowser ? (
        <button
          type="button"
          className="panel-action"
          disabled={busy || !anotherBrowserReady}
          onClick={onUseAnotherBrowser}
        >
          Use another browser
        </button>
      ) : null}
      <button
        type="button"
        className="panel-action"
        disabled={busy}
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
  if (signIn.kind === "starting") {
    return (
      <>
        <p role="status">
          {anotherBrowser
            ? "Preparing the sign-in address."
            : "Opening the browser."}
        </p>
        {cancel}
      </>
    );
  }
  if (signIn.kind === "completing") {
    // The browser's part is done and the device is being registered; a
    // cancel now would leave the server's answer unknown.
    return <p role="status">Completing the sign-in.</p>;
  }
  return (
    <>
      <p role="status">
        Continue in your browser, and only if it shows this pairing code:
      </p>
      <p className="pairing-code">{signIn.pairingCode}</p>
      {signIn.opened ? null : (
        <AuthorizeUrl
          url={signIn.authorizeUrl}
          warning={signIn.warning}
          anotherBrowser={signIn.browser === "other"}
        />
      )}
      {cancel}
    </>
  );
}

/**
 * The authorize URL when the browser did not open, or when the person asked
 * for it to use another browser (#175). The session denies the clipboard
 * permission, so the button selects the text for the person to copy; the
 * warning from the main process says not to share it (#149).
 */
function AuthorizeUrl({
  url,
  warning,
  anotherBrowser,
}: {
  readonly url: string;
  readonly warning: string;
  readonly anotherBrowser: boolean;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const select = () => {
    field.current?.focus();
    field.current?.select();
  };
  return (
    <div className="account-url">
      <p>
        {anotherBrowser
          ? "Copy this address into the browser that you want to sign in with."
          : "The browser did not open."}
      </p>
      <label className="account-label" htmlFor="sign-in-url">
        Sign-in address
      </label>
      <textarea
        id="sign-in-url"
        ref={field}
        className="account-input account-url-text"
        rows={4}
        readOnly
        spellCheck={false}
        value={url}
        aria-describedby="sign-in-url-warning"
      />
      <p className="account-warning" id="sign-in-url-warning">
        {warning}
      </p>
      <div className="account-actions">
        <button type="button" className="panel-action" onClick={select}>
          Select the address
        </button>
      </div>
      <p className="placeholder-note">
        Then copy it, for example with Ctrl+C, or Command+C on a Mac.
      </p>
    </div>
  );
}

/** The account's devices, with the device of this installation marked. */
function DeviceList({ devices }: { readonly devices: readonly DeviceView[] }) {
  return (
    <section aria-labelledby="devices-title">
      <h4 id="devices-title">Devices</h4>
      {devices.length === 0 ? (
        <p className="placeholder-note">No devices are listed.</p>
      ) : (
        <ul className="device-list">
          {devices.map((device) => (
            <li
              key={device.id}
              aria-current={device.current ? "true" : undefined}
            >
              {device.label}
              {device.current ? " (this device)" : ""}
              <span className="device-detail">{deviceDetail(device)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Follows the account status while the panel is shown. */
function useAccountPanel(
  bridge: AccountBridge | undefined,
): AccountPanelContentProps {
  const [view, setView] = useState(() =>
    initialAccountView(bridge !== undefined),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [devices, setDevices] = useState<readonly DeviceView[] | undefined>(
    undefined,
  );
  const [anotherBrowser, setAnotherBrowser] = useState(false);
  const [idleWaits] = useState(createIdleWaits);
  /** The pairing code of a waiting sign-in that can be replaced now. */
  const [replaceable, setReplaceable] = useState<string | undefined>(undefined);

  useEffect(
    () =>
      bridge === undefined
        ? undefined
        : followAccountStatus(bridge, idleWaits, setView),
    [bridge, idleWaits],
  );

  const waitingCode = waitingPairingCode(view);
  useEffect(() => {
    if (waitingCode === undefined) {
      return undefined;
    }
    const timer = setTimeout(
      () => setReplaceable(waitingCode),
      ANOTHER_BROWSER_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [waitingCode]);
  const anotherBrowserReady =
    waitingCode !== undefined && replaceable === waitingCode;

  /** Runs one action at a time and shows the message that its result names. */
  const run = useCallback(
    <T,>(
      action: (bridge: AccountBridge) => Promise<T>,
      messageFor: (result: T) => string | undefined,
      failure: string,
    ) => {
      if (bridge === undefined) {
        return;
      }
      setBusy(true);
      setMessage(undefined);
      action(bridge)
        .then(
          (result) => setMessage(messageFor(result)),
          () => setMessage(failure),
        )
        .finally(() => setBusy(false));
    },
    [bridge],
  );

  const onStartSignIn = useCallback(() => {
    setAnotherBrowser(false);
    run(
      (account) => account.startSignIn(),
      startMessage,
      ACTION_MESSAGES.startFailed,
    );
  }, [run]);

  const onUseAnotherBrowser = useCallback(() => {
    const waiting = waitingCode !== undefined;
    setAnotherBrowser(true);
    run(
      (account) => startInAnotherBrowser(account, waiting, idleWaits.wait),
      startMessage,
      ACTION_MESSAGES.startFailed,
    );
  }, [run, waitingCode, idleWaits]);

  const onCancelSignIn = useCallback(
    () =>
      run(
        (account) => account.cancelSignIn(),
        () => undefined,
        ACTION_MESSAGES.cancelFailed,
      ),
    [run],
  );

  const onUnlock = useCallback(
    (passphrase: string) =>
      run(
        (account) => account.unlockDeviceKey(passphrase),
        unlockMessage,
        ACTION_MESSAGES.unlockFailed,
      ),
    [run],
  );

  const onForget = useCallback(() => {
    run(
      (account) => account.forgetAccount(),
      (result) => {
        if (result.outcome === "forgotten") {
          setDevices(undefined);
        }
        return forgetMessage(result);
      },
      ACTION_MESSAGES.forgetFailed,
    );
  }, [run]);

  const onSignOut = useCallback(() => {
    run(
      (account) => account.signOut(),
      (result) => {
        setDevices(undefined);
        return signOutMessage(result);
      },
      DEVICE_ACTION_MESSAGES.signOutFailed,
    );
  }, [run]);

  const onRemoveDevice = useCallback(() => {
    run(
      (account) => account.removeDevice(),
      (result) => {
        if (result.outcome === "removed") {
          setDevices(undefined);
        }
        return removeDeviceMessage(result);
      },
      DEVICE_ACTION_MESSAGES.removeFailed,
    );
  }, [run]);

  const onListDevices = useCallback(() => {
    run(
      (account) => account.listDevices(),
      (result) => {
        setDevices(result.outcome === "listed" ? result.devices : undefined);
        return listDevicesMessage(result);
      },
      DEVICE_ACTION_MESSAGES.listFailed,
    );
  }, [run]);

  return {
    view,
    busy,
    message,
    onStartSignIn,
    onUseAnotherBrowser,
    anotherBrowser,
    anotherBrowserReady,
    onCancelSignIn,
    onUnlock,
    onForget,
    devices,
    onSignOut,
    onRemoveDevice,
    onListDevices,
  };
}

/** The message for an unlock that did not succeed. */
export function unlockMessage(result: UnlockResult): string | undefined {
  switch (result.outcome) {
    case "unlocked":
      return undefined;
    case "failed":
      // The status shows why the key cannot be used.
      return undefined;
    case "refused":
      switch (result.reason) {
        case "not_required":
          return ACTION_MESSAGES.unlockNotRequired;
        case "busy":
          return ACTION_MESSAGES.unlockBusy;
        case "too_soon":
          return ACTION_MESSAGES.unlockTooSoon;
        case "wrong_passphrase":
          return ACTION_MESSAGES.wrongPassphrase;
        case "passphrase_invalid":
          return ACTION_MESSAGES.passphraseInvalid;
      }
  }
}
