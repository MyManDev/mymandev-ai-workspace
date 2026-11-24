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
} from "../shared/ipc-contract.ts";
import { describeWait } from "./wait-text.ts";

// This device's AI provider connections on the Account screen (#32): each
// connection's kind, label, and status, registering one by its kind and
// label, and removing one after a question. The main process holds the
// list (`window.desktop.providerConnections`) and computes each status; the
// section shows what it sends and passes the person's actions on. No
// credential is asked for, shown, or sent: storing one waits for #33.

/** A provider kind, as the contract names it. */
export type ProviderKindView = ProviderConnectionItemView["kind"];

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
  hint: "The AI provider connections of this device. Only a connection's kind and label reach the server: no API key, token, or password is asked for or sent.",
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
});

/** The names of the providers. */
export const PROVIDER_KIND_NAMES: Readonly<Record<ProviderKindView, string>> =
  Object.freeze({
    claude: "Claude",
    codex: "Codex",
  });

/**
 * The name and the sentence of each status (a default until the Project
 * Manager decides, 2026-11-24). No status says that a provider works: this
 * device does not check a credential yet (#33).
 */
export const PROVIDER_CONNECTION_STATUS_TEXTS: Readonly<
  Record<
    ProviderConnectionStatusView,
    { readonly name: string; readonly text: string }
  >
> = Object.freeze({
  registered: Object.freeze({
    name: "Registered",
    text: "The server knows this connection. This device does not check the provider's sign-in yet.",
  }),
  unknown: Object.freeze({
    name: "Unknown",
    text: "This device is offline, or the list could not be read, so the connection is shown as it was last read.",
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

/** The sentence after an action that the server confirmed. */
export const PROVIDER_CONNECTION_DONE_MESSAGES = Object.freeze({
  register: "The connection was added.",
  remove:
    "The connection was removed, and the permissions that named it were revoked.",
});

/** The start of the sentence after an action that was refused. */
export const PROVIDER_CONNECTION_NOT_DONE_MESSAGES = Object.freeze({
  register: "The connection was not added.",
  remove: "The connection was not removed.",
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
  return {
    id: item.id,
    kind: item.kind,
    kindName: PROVIDER_KIND_NAMES[item.kind],
    label: item.label,
    createdAt: item.createdAt,
    status: item.status,
    statusName: texts.name,
    statusText: texts.text,
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

/** The question before a removal: the connection as it was shown. */
export interface ProviderConnectionQuestion {
  readonly id: string;
  readonly label: string;
  readonly kindName: string;
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
}

export const IDLE_PROVIDER_CONNECTION_ACTIONS: ProviderConnectionActionsView =
  Object.freeze({
    running: false,
    message: undefined,
    question: undefined,
    draftKind: "claude",
    draftLabel: "",
    labelProblem: undefined,
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
   * Removes the connection of the open question. Resolves to true when the
   * main process removed it, so that the focus can leave its button.
   */
  readonly confirm: () => Promise<boolean>;
  /** Closes the open question without the removal. */
  readonly cancel: () => void;
  /**
   * Follows the section's model, which the section passes after every
   * render: a sign-out drops the question, the field, and the last
   * sentence, which belonged to the device that left, and the question
   * ends once its connection is no longer listed.
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
  bridge: Pick<ProviderConnectionsBridge, "register" | "remove">,
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
      if (
        view.running ||
        model?.rows?.some((listed) => listed.id === row.id) !== true
      ) {
        return;
      }
      show({
        question: Object.freeze({
          id: row.id,
          label: row.label,
          kindName: row.kindName,
        }),
      });
    },
    confirm: () => {
      const question = view.question;
      if (view.running || question === undefined) {
        return Promise.resolve(false);
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
    },
  });
}
