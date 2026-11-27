import type { ProviderConnectionsBridge } from "../shared/desktop-bridge.ts";
import type {
  ProviderConnectionItemView,
  ProviderConnectionListProblem,
  ProviderConnectionListView,
  ProviderConnectionStatusView,
  RegisterProviderConnectionRefusal,
  RegisterProviderConnectionResult,
  RemoveProviderConnectionRefusal,
  RemoveProviderConnectionResult,
  RemoveProviderKeyRefusal,
  RemoveProviderKeyResult,
  SaveProviderKeyRefusal,
  SaveProviderKeyResult,
  SetProviderModelRefusal,
  SetProviderModelResult,
} from "../shared/ipc-contract.ts";
import { describeWait } from "./wait-text.ts";

// This device's AI provider connections on the Account screen (#32): each
// connection's kind, label, and status, registering one by its kind and
// label, and removing one after a question. The main process holds the
// list (`window.desktop.providerConnections`) and computes each status; the
// section shows what it sends and passes the person's actions on.
//
// A connection's API key (#33) is entered in a password field that is
// never prefilled, sent to the main process once, and cleared as it is
// sent; the main process stores it encrypted on this device. No answer of
// the main process ever holds a key, so it is never shown again: the
// status says only whether one is stored (`ready`) or not
// (`credential_missing`).
//
// A Claude connection's key is entered with the model that the person
// chooses for it (#30, the Project Manager's decision of 2026-11-26): a
// required select of the closed list, with no model chosen in advance for a
// connection without one. The model is not secret, so the main process
// sends it back, and it is shown with the connection; "Change the model"
// changes it without the key, and "Choose the model" asks for it when a key
// is stored without one (`model_missing`).

/** A provider kind, as the contract names it. */
export type ProviderKindView = ProviderConnectionItemView["kind"];

/** A model of a Claude connection, as the contract names it. */
export type ClaudeModelView = NonNullable<ProviderConnectionItemView["model"]>;

/**
 * The models that the key form offers for a Claude connection, in order,
 * with their names, as the contract's `CLAUDE_MODEL_VIEWS` lists them. The
 * renderer imports no value of the contract, so the tests check that the
 * IDs match.
 */
export const CLAUDE_MODELS_OFFERED: readonly {
  readonly id: ClaudeModelView;
  readonly name: string;
}[] = Object.freeze([
  Object.freeze({ id: "claude-fable-5-2", name: "Claude Fable 5.2" }),
  Object.freeze({ id: "claude-opus-5-5", name: "Claude Opus 5.5" }),
  Object.freeze({ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }),
  Object.freeze({ id: "claude-haiku-5-5", name: "Claude Haiku 5.5" }),
] as const);

/** The name of a model of the list, or undefined for any other value. */
export function claudeModelName(model: string): string | undefined {
  return CLAUDE_MODELS_OFFERED.find((offered) => offered.id === model)?.name;
}

/** Whether a connection of `kind` needs a model chosen with its key. */
export function kindNeedsModel(kind: ProviderKindView): boolean {
  return kind === "claude";
}

/**
 * The kinds that the form offers, in order, as the protocol's
 * `PROVIDER_KINDS` lists them. The renderer imports no value of the
 * contract or the protocol, so the tests check that the values match.
 */
export const PROVIDER_KINDS_OFFERED: readonly ProviderKindView[] =
  Object.freeze(["claude", "codex"]);

/**
 * The longest label in characters (Unicode code points), the protocol's
 * `LIMITS.providerConnectionLabel`. The tests check that the values match.
 */
export const MAX_PROVIDER_CONNECTION_LABEL_LENGTH = 64;

/**
 * The most connections of one device and the most registrations of one
 * account in 24 hours (the protocol's `PROVIDER_CONNECTION_COUNT_LIMITS`),
 * which the sentences of `provider_connection_limit` and `rate_limited`
 * name. The tests check them against the protocol.
 */
export const MAX_PROVIDER_CONNECTIONS_PER_DEVICE = 10;
export const MAX_NEW_PROVIDER_CONNECTIONS_PER_DAY = 20;

/**
 * The protocol's `SAFE_TEXT_PATTERN`, which a label must match: no
 * control, format, surrogate, private use, separator, or default-ignorable
 * character, except the joiners and the variation selectors. The tests
 * check that it is the same pattern.
 */
export const LABEL_SAFE_PATTERN =
  /^(?:[^\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{DI}]|\u200C|\u200D|\uFE0E|\uFE0F)*$/u;

/**
 * The longest API key in UTF-16 code units, the contract's
 * `PROVIDER_KEY_LIMITS.key`. The tests check that the values match.
 */
export const MAX_PROVIDER_KEY_LENGTH = 512;

/**
 * A character that an API key never holds, as the main process checks it:
 * white space, control characters, and format characters such as a
 * zero-width space.
 */
const KEY_FORBIDDEN_CHARACTER = /[\s\p{Cc}\p{Cf}]/u;

/** What the section knows about the connections. */
export type ProviderConnectionSectionView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first state. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly state: ProviderConnectionListView };

export function initialProviderConnectionSectionView(
  bridgeAvailable: boolean,
): ProviderConnectionSectionView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

/**
 * Subscribes to the connections and reports every state as the view; a
 * refused subscription makes the view unavailable. Returns the function
 * that ends the subscription.
 */
export function followProviderConnections(
  bridge: Pick<ProviderConnectionsBridge, "subscribeState">,
  onView: (view: ProviderConnectionSectionView) => void,
): () => void {
  return bridge.subscribeState(
    (state) => onView({ kind: "known", state }),
    () => onView({ kind: "unavailable" }),
  );
}

/** The fixed texts of the section. */
export const PROVIDER_CONNECTION_MESSAGES = Object.freeze({
  title: "AI providers",
  hint: "The AI provider connections of this device. Only a connection's kind and label reach the server. An API key that you enter stays on this device, encrypted by the system, and is never shown again.",
  unavailable: "AI provider connections are not available.",
  pending: "Checking the AI provider connections.",
  signedOut:
    "The AI provider connections appear once this device is signed in.",
  loading: "Loading the AI provider connections.",
  empty: "This device has no AI provider connection yet.",
  kindLabel: "Provider",
  label: "Label",
  labelHint: `A name that helps you tell the connection apart, such as "Work account". Up to ${String(MAX_PROVIDER_CONNECTION_LABEL_LENGTH)} characters on one line.`,
  register: "Add the connection",
  registerTitle: "Add an AI provider connection",
  remove: "Remove",
  cancel: "Cancel",
  labelMissing: "Enter a label.",
  labelTooLong: `The label is longer than ${String(MAX_PROVIDER_CONNECTION_LABEL_LENGTH)} characters.`,
  labelUnsafe:
    "The label holds a line break or an invisible character. Use visible characters on one line.",
  /** The term before a connection's registration time. */
  added: "Added",
  /** The term before a connection's status. */
  status: "Status",
  enterKey: "Enter an API key",
  replaceKey: "Replace the API key",
  removeKey: "Remove the API key",
  keyLabel: "API key",
  keyHint: `The provider's API key for this connection, up to ${String(MAX_PROVIDER_KEY_LENGTH)} characters. It is encrypted and kept on this device only, never sent to the server, and never shown again. This device does not check it with the provider.`,
  saveKey: "Store the key",
  keyMissing: "Enter the key.",
  keyTooLong: `The key is longer than ${String(MAX_PROVIDER_KEY_LENGTH)} characters.`,
  keyUnsafe:
    "The key holds a space, a line break, or an invisible character. Paste the key alone.",
  /** The term before a Claude connection's model, and the select's label. */
  model: "Model",
  modelNone: "None chosen",
  modelChoose: "Choose a model",
  modelHint:
    "The Claude model that agents use with this connection on this device. It is kept on this device with the key.",
  modelMissing: "Choose a model.",
  changeModel: "Change the model",
  chooseModel: "Choose the model",
  saveModel: "Store the model",
});

/** The names of the providers. */
export const PROVIDER_KIND_NAMES: Readonly<Record<ProviderKindView, string>> =
  Object.freeze({
    claude: "Claude",
    codex: "Codex",
  });

/**
 * The name and the sentence of each status (#33). No status says that a
 * provider works: `ready` says only that a key is stored here and decrypts.
 */
export const PROVIDER_CONNECTION_STATUS_TEXTS: Readonly<
  Record<
    ProviderConnectionStatusView,
    { readonly name: string; readonly text: string }
  >
> = Object.freeze({
  credential_missing: Object.freeze({
    name: "No API key",
    text: "This device holds no usable API key for this connection. Enter one to use the connection here.",
  }),
  model_missing: Object.freeze({
    name: "No model chosen",
    text: "An API key for this connection is stored on this device, but no model is chosen for it. Choose one to use the connection here.",
  }),
  ready: Object.freeze({
    name: "Ready",
    text: "An API key for this connection is stored on this device. Whether the provider accepts it shows when an agent uses it.",
  }),
  unknown: Object.freeze({
    name: "Unknown",
    text: "This device is offline, the list could not be read, or the stored key could not be checked, so the connection is shown as it was last read.",
  }),
});

/** Why the list is `unavailable`. What was read before stays shown. */
export const PROVIDER_CONNECTION_PROBLEM_MESSAGES: Readonly<
  Record<ProviderConnectionListProblem, string>
> = Object.freeze({
  not_signed_in: "The server did not accept this device's sign-in.",
  rate_limited: "The server asked to wait. The list is read again in a minute.",
  unavailable:
    "The AI provider connections cannot be read right now. Trying again later.",
  failed: "The AI provider connections could not be read. Trying again later.",
});

/** The sentence after an action that the server or this device confirmed. */
export const PROVIDER_CONNECTION_DONE_MESSAGES = Object.freeze({
  register: "The connection was added.",
  remove:
    "The connection was removed, and the permissions that named it were revoked.",
  saveKey: "The API key was stored on this device.",
  setModel: "The model was stored on this device.",
  removeKey: "The API key was deleted from this device.",
});

/** The start of the sentence after an action that was refused. */
export const PROVIDER_CONNECTION_NOT_DONE_MESSAGES = Object.freeze({
  register: "The connection was not added.",
  remove: "The connection was not removed.",
  saveKey: "The API key was not stored.",
  setModel: "The model was not stored.",
  removeKey: "The API key was not deleted.",
});

/** The sentence after an action whose answer did not show what happened. */
export const PROVIDER_CONNECTION_UNKNOWN_MESSAGES = Object.freeze({
  register:
    "It is not known whether the connection was added. Check the list before you add it again; the request is not sent again on its own.",
  remove:
    "It is not known whether the connection was removed. Check the list; the request is not sent again on its own.",
});

/** The end of the sentence after a call that failed on its way; nothing was sent. */
export const PROVIDER_CONNECTION_NOT_SENT = "It was not sent. Try again.";

const SIGNED_OUT =
  "This device is not signed in, or the server did not accept its sign-in.";
const CANNOT_SEND =
  "This device cannot send it now. Wait until the sign-in or the current change of the account is finished, then try again.";
const BUSY =
  "Another change of the AI provider connections is still waiting for the server's answer. Wait a moment, then try again.";
const KEY_BUSY =
  "Another change of the AI provider connections or their API keys is still running. Wait a moment, then try again.";
const MODEL_NOT_OFFERED =
  "Choose one of the models of the list. A Claude connection needs one; a connection of another kind takes none.";
const PROTECTION_UNAVAILABLE =
  "This device cannot protect it: the system's secure storage is not available. On Linux, a secret service such as GNOME Keyring or KWallet must be running.";
const TOO_SOON = (wait: string) =>
  `This device sent many changes in a short time. Try again in ${wait}.`;

type WaitMessages = {
  readonly tooSoon: (wait: string) => string;
  readonly rateLimited: (wait: string) => string;
};

/** Why a registration was refused, one sentence for each refusal. */
export const REGISTER_PROVIDER_CONNECTION_REFUSAL_MESSAGES: Readonly<
  Record<
    Exclude<RegisterProviderConnectionRefusal, "too_soon" | "rate_limited">,
    string
  >
> &
  WaitMessages = Object.freeze({
  invalid:
    "The label is not allowed. Use visible characters on one line, up to 64.",
  busy: BUSY,
  not_signed_in: SIGNED_OUT,
  unavailable: CANNOT_SEND,
  tooSoon: TOO_SOON,
  rateLimited: (wait: string) =>
    `The server asked to wait. Try again in ${wait}. An account adds at most ${String(MAX_NEW_PROVIDER_CONNECTIONS_PER_DAY)} AI provider connections in 24 hours.`,
  provider_connection_limit: `This device already has ${String(MAX_PROVIDER_CONNECTIONS_PER_DEVICE)} AI provider connections, the most it may have. Remove one first.`,
  failed: "The server refused it.",
});

/** Why a removal was refused, one sentence for each refusal. */
export const REMOVE_PROVIDER_CONNECTION_REFUSAL_MESSAGES: Readonly<
  Record<
    Exclude<RemoveProviderConnectionRefusal, "too_soon" | "rate_limited">,
    string
  >
> &
  WaitMessages = Object.freeze({
  invalid: "The request was not valid.",
  busy: BUSY,
  not_listed:
    "The connection is no longer in the list. Wait until the list has loaded, then try again.",
  not_signed_in: SIGNED_OUT,
  unavailable: CANNOT_SEND,
  tooSoon: TOO_SOON,
  rateLimited: (wait: string) =>
    `The server asked to wait. Try again in ${wait}.`,
  not_found:
    "The server does not know this connection on this device. The list is read again.",
  conflict: "The connection was removed already. The list is read again.",
  failed: "The server refused it.",
});

/** Why storing a key was refused, one sentence for each refusal. */
export const SAVE_PROVIDER_KEY_REFUSAL_MESSAGES: Readonly<
  Record<SaveProviderKeyRefusal, string>
> = Object.freeze({
  invalid:
    "It holds a space, a line break, or an invisible character, or it is too long.",
  invalid_model: MODEL_NOT_OFFERED,
  not_signed_in: SIGNED_OUT,
  not_listed:
    "The connection is no longer in the list. Wait until the list has loaded, then try again.",
  busy: KEY_BUSY,
  protection_unavailable: PROTECTION_UNAVAILABLE,
  failed: "This device could not store it. Try again.",
});

/** Why changing the model was refused, one sentence for each refusal. */
export const SET_PROVIDER_MODEL_REFUSAL_MESSAGES: Readonly<
  Record<SetProviderModelRefusal, string>
> = Object.freeze({
  invalid: "The request was not valid.",
  invalid_model: MODEL_NOT_OFFERED,
  not_signed_in: SIGNED_OUT,
  not_listed:
    "The connection is no longer in the list. Wait until the list has loaded, then try again.",
  busy: KEY_BUSY,
  credential_missing:
    "This device holds no usable API key for this connection. Enter the key and choose the model with it.",
  protection_unavailable: PROTECTION_UNAVAILABLE,
  failed: "This device could not store it. Try again.",
});

/** The sentence after the answer of changing the model. */
export function describeSetProviderModel(
  result: SetProviderModelResult,
): string {
  return result.outcome === "ok"
    ? PROVIDER_CONNECTION_DONE_MESSAGES.setModel
    : `${PROVIDER_CONNECTION_NOT_DONE_MESSAGES.setModel} ${SET_PROVIDER_MODEL_REFUSAL_MESSAGES[result.reason]}`;
}

/**
 * The problem of a model before it is sent, or undefined: a Claude
 * connection needs one of `CLAUDE_MODELS_OFFERED`, and nothing is chosen
 * for the person.
 */
export function providerModelPrompt(model: string): string | undefined {
  return claudeModelName(model) === undefined
    ? PROVIDER_CONNECTION_MESSAGES.modelMissing
    : undefined;
}

/** Why removing a key was refused, one sentence for each refusal. */
export const REMOVE_PROVIDER_KEY_REFUSAL_MESSAGES: Readonly<
  Record<RemoveProviderKeyRefusal, string>
> = Object.freeze({
  invalid: "The request was not valid.",
  not_signed_in: SIGNED_OUT,
  not_listed:
    "The connection is no longer in the list. Wait until the list has loaded, then try again.",
  busy: KEY_BUSY,
  failed: "This device could not delete it. Try again.",
});

/** The sentence after the answer of storing a key. */
export function describeSaveProviderKey(result: SaveProviderKeyResult): string {
  return result.outcome === "ok"
    ? PROVIDER_CONNECTION_DONE_MESSAGES.saveKey
    : `${PROVIDER_CONNECTION_NOT_DONE_MESSAGES.saveKey} ${SAVE_PROVIDER_KEY_REFUSAL_MESSAGES[result.reason]}`;
}

/** The sentence after the answer of removing a key. */
export function describeRemoveProviderKey(
  result: RemoveProviderKeyResult,
): string {
  return result.outcome === "ok"
    ? PROVIDER_CONNECTION_DONE_MESSAGES.removeKey
    : `${PROVIDER_CONNECTION_NOT_DONE_MESSAGES.removeKey} ${REMOVE_PROVIDER_KEY_REFUSAL_MESSAGES[result.reason]}`;
}

/**
 * The key as the section sends it: without white space at its start and
 * its end, which a copy often adds and which no key holds.
 */
export function providerKeyToSend(text: string): string {
  return text.trim();
}

/**
 * The problem of a key before it is sent, or undefined, as the main process
 * checks it: none, longer than the limit, or a white space, control, or
 * format character, or text that is not well-formed. It never names the
 * key.
 */
export function providerKeyPrompt(key: string): string | undefined {
  if (key === "") {
    return PROVIDER_CONNECTION_MESSAGES.keyMissing;
  }
  if (key.length > MAX_PROVIDER_KEY_LENGTH) {
    return PROVIDER_CONNECTION_MESSAGES.keyTooLong;
  }
  return key.isWellFormed() && !KEY_FORBIDDEN_CHARACTER.test(key)
    ? undefined
    : PROVIDER_CONNECTION_MESSAGES.keyUnsafe;
}

function refusalSentence<R extends string>(
  messages: Readonly<Record<Exclude<R, "too_soon" | "rate_limited">, string>> &
    WaitMessages,
  reason: R,
  retryAfterMs: number | null,
): string {
  const wait = describeWait(retryAfterMs ?? 0);
  if (reason === "too_soon") {
    return messages.tooSoon(wait);
  }
  if (reason === "rate_limited") {
    return messages.rateLimited(wait);
  }
  return messages[reason as Exclude<R, "too_soon" | "rate_limited">];
}

/** The sentence after the answer of a registration. */
export function describeRegisterProviderConnection(
  result: RegisterProviderConnectionResult,
): string {
  switch (result.outcome) {
    case "ok":
      return PROVIDER_CONNECTION_DONE_MESSAGES.register;
    case "unknown":
      return PROVIDER_CONNECTION_UNKNOWN_MESSAGES.register;
    case "refused":
      return `${PROVIDER_CONNECTION_NOT_DONE_MESSAGES.register} ${refusalSentence(
        REGISTER_PROVIDER_CONNECTION_REFUSAL_MESSAGES,
        result.reason,
        result.retryAfterMs,
      )}`;
  }
}

/** The sentence after the answer of a removal. */
export function describeRemoveProviderConnection(
  result: RemoveProviderConnectionResult,
): string {
  switch (result.outcome) {
    case "ok":
      return PROVIDER_CONNECTION_DONE_MESSAGES.remove;
    case "unknown":
      return PROVIDER_CONNECTION_UNKNOWN_MESSAGES.remove;
    case "refused":
      return `${PROVIDER_CONNECTION_NOT_DONE_MESSAGES.remove} ${refusalSentence(
        REMOVE_PROVIDER_CONNECTION_REFUSAL_MESSAGES,
        result.reason,
        result.retryAfterMs,
      )}`;
  }
}

/**
 * The label as the section sends it: trimmed of white space at the start
 * and the end. The protocol stores a label as sent, so the trim happens
 * here.
 */
export function providerConnectionLabelToSend(text: string): string {
  return text.trim();
}

/**
 * The problem of a label before it is sent, or undefined, by the
 * protocol's rules for a label (`displayText`): none after the trim, longer
 * than the limit in characters (code points), or a character outside
 * `LABEL_SAFE_PATTERN`, such as a line break. The length is checked first,
 * as the protocol does, so the pattern never runs over a long text.
 */
export function providerConnectionLabelPrompt(
  label: string,
): string | undefined {
  if (label === "") {
    return PROVIDER_CONNECTION_MESSAGES.labelMissing;
  }
  if (
    label.length > MAX_PROVIDER_CONNECTION_LABEL_LENGTH &&
    Array.from(label).length > MAX_PROVIDER_CONNECTION_LABEL_LENGTH
  ) {
    return PROVIDER_CONNECTION_MESSAGES.labelTooLong;
  }
  return LABEL_SAFE_PATTERN.test(label)
    ? undefined
    : PROVIDER_CONNECTION_MESSAGES.labelUnsafe;
}

/** A connection as the section shows it. */
export interface ProviderConnectionRow {
  readonly id: string;
  readonly kind: ProviderKindView;
  readonly kindName: string;
  readonly label: string;
  readonly createdAt: string;
  readonly status: ProviderConnectionStatusView;
  readonly statusName: string;
  readonly statusText: string;
  /**
   * "Replace" once a key is stored (`ready`, `model_missing`), "Enter"
   * otherwise.
   */
  readonly keyAction: "enter" | "replace";
  /** Whether a key may be stored, so that "Remove the API key" is offered. */
  readonly keyMayExist: boolean;
  /** Whether the connection needs a model with its key: a Claude connection. */
  readonly needsModel: boolean;
  /** The model chosen for the connection on this device, or null. */
  readonly model: ClaudeModelView | null;
  /**
   * The name of the model for a connection that needs one: the model's
   * name, or "None chosen"; null for a connection of another kind.
   */
  readonly modelName: string | null;
  /**
   * The model action without the key, for a Claude connection whose key is
   * stored: "Change the model" (`ready`), "Choose the model"
   * (`model_missing`), or none.
   */
  readonly modelAction: "change" | "choose" | null;
}

export interface ProviderConnectionsModel {
  /** The text of the status paragraph; empty when there is none. */
  readonly status: string;
  /** The connections, or null when there is nothing to list. */
  readonly rows: readonly ProviderConnectionRow[] | null;
  /** Whether a device is signed in, so that the form is offered. */
  readonly signedIn: boolean;
}

function rowOf(item: ProviderConnectionItemView): ProviderConnectionRow {
  const texts = PROVIDER_CONNECTION_STATUS_TEXTS[item.status];
  const needsModel = kindNeedsModel(item.kind);
  const model = needsModel ? item.model : null;
  const keyStored = item.status === "ready" || item.status === "model_missing";
  let modelAction: ProviderConnectionRow["modelAction"] = null;
  if (needsModel && item.status === "ready") {
    modelAction = "change";
  } else if (needsModel && item.status === "model_missing") {
    modelAction = "choose";
  }
  return {
    id: item.id,
    kind: item.kind,
    kindName: PROVIDER_KIND_NAMES[item.kind],
    label: item.label,
    createdAt: item.createdAt,
    status: item.status,
    statusName: texts.name,
    statusText: texts.text,
    keyAction: keyStored ? "replace" : "enter",
    keyMayExist: item.status !== "credential_missing",
    needsModel,
    model,
    modelName: needsModel
      ? model === null
        ? PROVIDER_CONNECTION_MESSAGES.modelNone
        : (claudeModelName(model) ?? PROVIDER_CONNECTION_MESSAGES.modelNone)
      : null,
    modelAction,
  };
}

/**
 * What the section shows: a fixed text without the bridge, before the
 * first state, without a signed-in device, and while the list loads; the
 * connections when `ready`, or a fixed text when there is none; and when
 * `unavailable`, the problem with what was read before, or only the
 * problem, because an empty list would claim what was never read.
 */
export function describeProviderConnections(
  view: ProviderConnectionSectionView,
): ProviderConnectionsModel {
  switch (view.kind) {
    case "unavailable":
      return {
        status: PROVIDER_CONNECTION_MESSAGES.unavailable,
        rows: null,
        signedIn: false,
      };
    case "pending":
      return {
        status: PROVIDER_CONNECTION_MESSAGES.pending,
        rows: null,
        signedIn: false,
      };
    case "known":
      break;
  }
  const { state } = view;
  if (state.status === "signed_out") {
    return {
      status: PROVIDER_CONNECTION_MESSAGES.signedOut,
      rows: null,
      signedIn: false,
    };
  }
  const rows =
    state.connections.length === 0 ? null : state.connections.map(rowOf);
  let status: string;
  switch (state.status) {
    case "loading":
      status = PROVIDER_CONNECTION_MESSAGES.loading;
      break;
    case "unavailable":
      status = PROVIDER_CONNECTION_PROBLEM_MESSAGES[state.problem];
      break;
    case "ready":
      status = rows === null ? PROVIDER_CONNECTION_MESSAGES.empty : "";
      break;
  }
  return { status, rows, signedIn: true };
}

/** A connection as it was shown, for a question, the key form, or the model form. */
export interface ProviderConnectionTarget {
  readonly id: string;
  readonly label: string;
  readonly kindName: string;
  /** Whether the key form asks for a model: a Claude connection. */
  readonly needsModel: boolean;
}

/**
 * The question before a removal: of the connection (`remove`), or of its
 * API key only (`removeKey`).
 */
export interface ProviderConnectionQuestion extends ProviderConnectionTarget {
  readonly action: "remove" | "removeKey";
}

/** What the section shows of its actions. */
export interface ProviderConnectionActionsView {
  /**
   * True while an action runs: every control stays focusable and does
   * nothing (`aria-disabled`), so that only one runs at a time.
   */
  readonly running: boolean;
  /** A fixed sentence about the last action, or undefined. */
  readonly message: string | undefined;
  /** The open question before a removal, or undefined. */
  readonly question: ProviderConnectionQuestion | undefined;
  /** The kind chosen in the form. */
  readonly draftKind: ProviderKindView;
  /** The label in the form's field. */
  readonly draftLabel: string;
  /** Why the label was not sent, or undefined. */
  readonly labelProblem: string | undefined;
  /** The connection whose key form is open, or undefined. */
  readonly keyFor: ProviderConnectionTarget | undefined;
  /**
   * The text of the key field. It starts empty whenever the form opens and
   * is emptied as the key is sent, refused before sending, or the form
   * closes.
   */
  readonly draftKey: string;
  /** Why the key was not sent, or undefined. */
  readonly keyProblem: string | undefined;
  /**
   * The connection whose model form is open (a model without the key), or
   * undefined. At most one of `keyFor` and `modelFor` is open.
   */
  readonly modelFor: ProviderConnectionTarget | undefined;
  /**
   * The model chosen in the open key form or model form: the connection's
   * model when it has one, "" (none chosen) otherwise. Nothing is chosen
   * for the person.
   */
  readonly draftModel: string;
  /** Why the model was not sent, or undefined. */
  readonly modelProblem: string | undefined;
}

export const IDLE_PROVIDER_CONNECTION_ACTIONS: ProviderConnectionActionsView =
  Object.freeze({
    running: false,
    message: undefined,
    question: undefined,
    draftKind: "claude",
    draftLabel: "",
    labelProblem: undefined,
    keyFor: undefined,
    draftKey: "",
    keyProblem: undefined,
    modelFor: undefined,
    draftModel: "",
    modelProblem: undefined,
  });

/** What closes the key form and the model form, and empties their fields. */
const CLOSED_FORMS = Object.freeze({
  keyFor: undefined,
  draftKey: "",
  keyProblem: undefined,
  modelFor: undefined,
  draftModel: "",
  modelProblem: undefined,
});

export interface ProviderConnectionActions {
  /** Chooses a kind of the form; another value changes nothing. */
  readonly editKind: (kind: string) => void;
  /** Changes the label of the form, and ends its problem. */
  readonly editLabel: (text: string) => void;
  /**
   * Registers a connection with the form's kind and its label, trimmed
   * (`providerConnectionLabelToSend`), once the label passes
   * `providerConnectionLabelPrompt`, and keeps the problem otherwise;
   * empties the field once the main process confirmed it. While an action
   * runs, nothing happens. Resolves once the view shows how it ended; never
   * rejects.
   */
  readonly register: () => Promise<void>;
  /** Opens the question before removing a connection that the model lists. */
  readonly askRemove: (row: ProviderConnectionRow) => void;
  /**
   * Opens the empty key form of a connection that the model lists, with
   * its model chosen in the select when it has one, and none otherwise.
   */
  readonly askKey: (row: ProviderConnectionRow) => void;
  /** Changes the key field, and ends its problem. */
  readonly editKey: (text: string) => void;
  /**
   * Chooses a model in the open key form or model form, and ends its
   * problem; any value is kept, and checked when it is sent.
   */
  readonly editModel: (model: string) => void;
  /**
   * Sends the key of the form, trimmed (`providerKeyToSend`), once it passes
   * `providerKeyPrompt`, with the chosen model for a Claude connection once
   * it passes `providerModelPrompt` (null for another kind); the key field
   * is emptied first in every case, so the key is held no longer than this
   * call. Closes the form once the main process stored it. While an action
   * runs, nothing happens. Never rejects.
   */
  readonly saveKey: () => Promise<void>;
  /** Closes the key form and empties its fields. */
  readonly cancelKey: () => void;
  /**
   * Opens the model form of a listed Claude connection whose key is stored
   * (`modelAction`), to change its model without the key.
   */
  readonly askModel: (row: ProviderConnectionRow) => void;
  /**
   * Sends the model of the model form once it passes `providerModelPrompt`,
   * and closes the form once the main process stored it. While an action
   * runs, nothing happens. Never rejects.
   */
  readonly saveModel: () => Promise<void>;
  /** Closes the model form. */
  readonly cancelModel: () => void;
  /** Opens the question before removing a listed connection's API key. */
  readonly askRemoveKey: (row: ProviderConnectionRow) => void;
  /**
   * Runs the open question: removes the connection, or its key. Resolves to
   * true when the main process removed the connection, so that the focus
   * can leave its button.
   */
  readonly confirm: () => Promise<boolean>;
  /** Closes the open question without the removal. */
  readonly cancel: () => void;
  /**
   * Follows the section's model, which the section passes after every
   * render: a sign-out drops the question, the fields, the key form, and
   * the last sentence, which belonged to the device that left, and the
   * question and the key form end once their connection is no longer
   * listed.
   */
  readonly follow: (model: ProviderConnectionsModel) => void;
}

/**
 * The actions of the section: one at a time, each sent once and never again
 * on its own. The list changes only with the states that the main process
 * sends, never from an answer. An answer that comes after a sign-out shows
 * no sentence.
 */
export function createProviderConnectionActions(
  bridge: Pick<
    ProviderConnectionsBridge,
    "register" | "remove" | "saveKey" | "setModel" | "removeKey"
  >,
  onView: (view: ProviderConnectionActionsView) => void,
): ProviderConnectionActions {
  let view = IDLE_PROVIDER_CONNECTION_ACTIONS;
  let model: ProviderConnectionsModel | undefined;
  /** Grows with every sign-out. */
  let generation = 0;
  const show = (change: Partial<ProviderConnectionActionsView>) => {
    view = Object.freeze({ ...view, ...change });
    onView(view);
  };

  const listed = (row: ProviderConnectionRow): boolean =>
    model?.rows?.some((shown) => shown.id === row.id) === true;
  const targetOf = (row: ProviderConnectionRow): ProviderConnectionTarget =>
    Object.freeze({
      id: row.id,
      label: row.label,
      kindName: row.kindName,
      needsModel: row.needsModel,
    });
  const questionOf = (
    row: ProviderConnectionRow,
    action: ProviderConnectionQuestion["action"],
  ): ProviderConnectionQuestion => Object.freeze({ ...targetOf(row), action });

  async function run<T>(
    call: () => Promise<T>,
    describe: (result: T) => string,
    failed: string,
    happened: (result: T) => boolean,
  ): Promise<boolean> {
    show({ running: true, message: undefined, question: undefined });
    const started = generation;
    let sentence: string;
    let ok = false;
    try {
      const result = await call();
      ok = happened(result);
      sentence = describe(result);
    } catch {
      sentence = `${failed} ${PROVIDER_CONNECTION_NOT_SENT}`;
    }
    const still = generation === started;
    show({ running: false, message: still ? sentence : undefined });
    return still && ok;
  }

  return Object.freeze({
    editKind: (kind: string) => {
      const chosen = PROVIDER_KINDS_OFFERED.find((offered) => offered === kind);
      if (chosen !== undefined && chosen !== view.draftKind) {
        show({ draftKind: chosen });
      }
    },
    editLabel: (text: string) => {
      show({ draftLabel: text, labelProblem: undefined });
    },
    register: async () => {
      if (view.running) {
        return;
      }
      const label = providerConnectionLabelToSend(view.draftLabel);
      const problem = providerConnectionLabelPrompt(label);
      if (problem !== undefined) {
        show({ labelProblem: problem });
        return;
      }
      const kind = view.draftKind;
      const done = await run(
        () => bridge.register(kind, label),
        describeRegisterProviderConnection,
        PROVIDER_CONNECTION_NOT_DONE_MESSAGES.register,
        (result) => result.outcome === "ok",
      );
      if (done) {
        show({ draftLabel: "" });
      }
    },
    askRemove: (row: ProviderConnectionRow) => {
      if (!view.running && listed(row)) {
        show({ question: questionOf(row, "remove") });
      }
    },
    askKey: (row: ProviderConnectionRow) => {
      if (!view.running && listed(row)) {
        show({
          ...CLOSED_FORMS,
          keyFor: targetOf(row),
          // The person's own earlier choice, never a default.
          draftModel: row.needsModel ? (row.model ?? "") : "",
          question: undefined,
        });
      }
    },
    editKey: (text: string) => {
      if (view.keyFor !== undefined) {
        show({ draftKey: text, keyProblem: undefined });
      }
    },
    editModel: (model: string) => {
      if (view.keyFor !== undefined || view.modelFor !== undefined) {
        show({ draftModel: model, modelProblem: undefined });
      }
    },
    saveKey: async () => {
      const target = view.keyFor;
      if (view.running || target === undefined) {
        return;
      }
      const key = providerKeyToSend(view.draftKey);
      const problem = providerKeyPrompt(key);
      const model = target.needsModel ? view.draftModel : null;
      const modelProblem =
        model === null ? undefined : providerModelPrompt(model);
      // The field is emptied before anything is sent, also when the key is
      // not sent: the person pastes it again.
      show({ draftKey: "", keyProblem: problem, modelProblem });
      if (problem !== undefined || modelProblem !== undefined) {
        return;
      }
      const done = await run(
        () => bridge.saveKey(target.id, key, model),
        describeSaveProviderKey,
        PROVIDER_CONNECTION_NOT_DONE_MESSAGES.saveKey,
        (result) => result.outcome === "ok",
      );
      if (done && view.keyFor?.id === target.id) {
        show(CLOSED_FORMS);
      }
    },
    cancelKey: () => {
      if (view.keyFor !== undefined || view.draftKey !== "") {
        show(CLOSED_FORMS);
      }
    },
    askModel: (row: ProviderConnectionRow) => {
      if (!view.running && listed(row) && row.modelAction !== null) {
        show({
          ...CLOSED_FORMS,
          modelFor: targetOf(row),
          draftModel: row.model ?? "",
          question: undefined,
        });
      }
    },
    saveModel: async () => {
      const target = view.modelFor;
      if (view.running || target === undefined) {
        return;
      }
      const model = view.draftModel;
      const modelProblem = providerModelPrompt(model);
      if (modelProblem !== undefined) {
        show({ modelProblem });
        return;
      }
      const done = await run(
        () => bridge.setModel(target.id, model),
        describeSetProviderModel,
        PROVIDER_CONNECTION_NOT_DONE_MESSAGES.setModel,
        (result) => result.outcome === "ok",
      );
      if (done && view.modelFor?.id === target.id) {
        show(CLOSED_FORMS);
      }
    },
    cancelModel: () => {
      if (view.modelFor !== undefined) {
        show(CLOSED_FORMS);
      }
    },
    askRemoveKey: (row: ProviderConnectionRow) => {
      if (!view.running && listed(row)) {
        show({ question: questionOf(row, "removeKey") });
      }
    },
    confirm: async () => {
      const question = view.question;
      if (view.running || question === undefined) {
        return false;
      }
      if (question.action === "removeKey") {
        await run(
          () => bridge.removeKey(question.id),
          describeRemoveProviderKey,
          PROVIDER_CONNECTION_NOT_DONE_MESSAGES.removeKey,
          (result) => result.outcome === "ok",
        );
        return false;
      }
      return run(
        () => bridge.remove(question.id),
        describeRemoveProviderConnection,
        PROVIDER_CONNECTION_NOT_DONE_MESSAGES.remove,
        (result) => result.outcome === "ok",
      );
    },
    cancel: () => {
      if (view.question !== undefined) {
        show({ question: undefined });
      }
    },
    follow: (next: ProviderConnectionsModel) => {
      const left = model?.signedIn === true && !next.signedIn;
      model = next;
      if (left) {
        generation += 1;
        show({
          ...CLOSED_FORMS,
          message: undefined,
          question: undefined,
          draftLabel: "",
          labelProblem: undefined,
        });
        return;
      }
      const question = view.question;
      if (
        question !== undefined &&
        next.rows?.some((row) => row.id === question.id) !== true
      ) {
        show({ question: undefined });
      }
      const keyFor = view.keyFor;
      if (
        keyFor !== undefined &&
        next.rows?.some((row) => row.id === keyFor.id) !== true
      ) {
        show(CLOSED_FORMS);
      }
      // The model form ends once its connection is gone or no longer has a
      // stored key whose model can change.
      const modelFor = view.modelFor;
      if (
        modelFor !== undefined &&
        next.rows?.some(
          (row) => row.id === modelFor.id && row.modelAction !== null,
        ) !== true
      ) {
        show(CLOSED_FORMS);
      }
    },
  });
}
