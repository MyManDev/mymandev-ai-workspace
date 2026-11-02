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
  SignInState,
  UnlockResult,
} from "../shared/ipc-contract.ts";
import {
  ACTION_MESSAGES,
  apiOriginProblem,
  DEVICE_KEY_PROBLEM_MESSAGES,
  describeOutcome,
  initialAccountView,
  type AccountView,
} from "./account-view.ts";

/**
 * The account of this installation: sign in with GitHub, the pairing code
 * while the browser is open, the GitHub login after a sign-in with "This is
 * not me" (#149), and the passphrase of a device key that needs one. The
 * main process runs the sign-in; the panel never sees a sign-in code, a
 * key, or a token. The screens of #95 replace it.
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
  /** True while "This is not me" asks for confirmation. */
  readonly confirmingForget: boolean;
  readonly onStartSignIn: () => void;
  readonly onCancelSignIn: () => void;
  readonly onUnlock: (passphrase: string) => void;
  /** "This is not me": asks for confirmation. */
  readonly onForget: () => void;
  readonly onConfirmForget: () => void;
  readonly onKeepAccount: () => void;
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
  return (
    <>
      <AccountSummary status={status} />
      <DeviceKeyNotice {...props} status={status} />
      <SignInActions {...props} status={status} />
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
  if (status.account.kind === "signed_out") {
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
        onCancel={props.onCancelSignIn}
      />
    );
  }
  if (status.account.kind === "signed_in") {
    return props.confirmingForget ? (
      <div className="account-confirm">
        <p id="forget-question">
          Remove the GitHub account <strong>{status.account.login}</strong> and
          the device key from this installation? You can then sign in with your
          own account.
        </p>
        <div
          className="account-actions"
          role="group"
          aria-labelledby="forget-question"
        >
          <button
            type="button"
            className="panel-action"
            disabled={busy}
            onClick={props.onConfirmForget}
          >
            Remove from this installation
          </button>
          <button
            type="button"
            className="panel-action"
            disabled={busy}
            autoFocus
            onClick={props.onKeepAccount}
          >
            Keep
          </button>
        </div>
      </div>
    ) : (
      <div className="account-actions">
        <button
          type="button"
          className="panel-action"
          disabled={busy}
          onClick={props.onForget}
        >
          This is not me
        </button>
      </div>
    );
  }
  const originProblem = apiOriginProblem(status.apiOrigin);
  return (
    <>
      <div className="account-actions">
        <button
          type="button"
          className="panel-action"
          disabled={
            busy || status.deviceKey !== "ready" || originProblem !== undefined
          }
          aria-describedby={
            originProblem === undefined ? undefined : "sign-in-unavailable"
          }
          onClick={props.onStartSignIn}
        >
          Sign in with GitHub
        </button>
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
  onCancel,
}: {
  readonly signIn: Exclude<SignInState, { readonly kind: "idle" }>;
  readonly busy: boolean;
  readonly onCancel: () => void;
}) {
  const cancel = (
    <div className="account-actions">
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
        <p role="status">Opening the browser.</p>
        {cancel}
      </>
    );
  }
  return (
    <>
      <p role="status">
        Continue in your browser, and only if it shows this pairing code:
      </p>
      <p className="pairing-code">{signIn.pairingCode}</p>
      {signIn.opened ? null : (
        <AuthorizeUrl url={signIn.authorizeUrl} warning={signIn.warning} />
      )}
      {cancel}
    </>
  );
}

/**
 * The authorize URL when the browser did not open. The session denies the
 * clipboard permission, so the button selects the text for the person to
 * copy; the warning from the main process says not to share it (#149).
 */
function AuthorizeUrl({
  url,
  warning,
}: {
  readonly url: string;
  readonly warning: string;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const select = () => {
    field.current?.focus();
    field.current?.select();
  };
  return (
    <div className="account-url">
      <p>The browser did not open.</p>
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

/** Follows the account status while the panel is shown. */
function useAccountPanel(
  bridge: AccountBridge | undefined,
): AccountPanelContentProps {
  const [view, setView] = useState(() =>
    initialAccountView(bridge !== undefined),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [confirmingForget, setConfirmingForget] = useState(false);

  useEffect(() => {
    if (bridge === undefined) {
      return undefined;
    }
    return bridge.subscribeStatus(
      (status) => setView({ kind: "known", status }),
      () => setView({ kind: "unavailable" }),
    );
  }, [bridge]);

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

  const onStartSignIn = useCallback(
    () =>
      run(
        (account) => account.startSignIn(),
        (result) =>
          result.outcome !== "refused"
            ? undefined
            : result.reason === "busy"
              ? ACTION_MESSAGES.startBusy
              : ACTION_MESSAGES.keyNotReady,
        ACTION_MESSAGES.startFailed,
      ),
    [run],
  );

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

  const onConfirmForget = useCallback(() => {
    setConfirmingForget(false);
    run(
      (account) => account.forgetAccount(),
      (result) => {
        switch (result.outcome) {
          case "forgotten":
            return undefined;
          case "refused":
            return result.reason === "busy"
              ? ACTION_MESSAGES.forgetBusy
              : ACTION_MESSAGES.notSignedIn;
          case "failed":
            return ACTION_MESSAGES.forgetFailed;
        }
      },
      ACTION_MESSAGES.forgetFailed,
    );
  }, [run]);

  return {
    view,
    busy,
    message,
    confirmingForget,
    onStartSignIn,
    onCancelSignIn,
    onUnlock,
    onForget: () => {
      setMessage(undefined);
      setConfirmingForget(true);
    },
    onConfirmForget,
    onKeepAccount: () => setConfirmingForget(false),
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
        case "wrong_passphrase":
          return ACTION_MESSAGES.wrongPassphrase;
        case "passphrase_invalid":
          return ACTION_MESSAGES.passphraseInvalid;
      }
  }
}
