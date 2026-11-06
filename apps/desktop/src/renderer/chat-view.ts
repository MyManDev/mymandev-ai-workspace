import type { ChatBridge } from "../shared/desktop-bridge.ts";
import type {
  ChatLoadOlderResultView,
  ChatMessageView,
  ChatNotSentReasonView,
  ChatOlderState,
  ChatPendingView,
  ChatProblem,
  ChatSendRefusal,
  ChatView,
} from "../shared/ipc-contract.ts";

/** What the chat screen knows about the open project's chat. */
export type ChatScreenView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first chat state. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly state: ChatView };

export function initialChatScreenView(
  bridgeAvailable: boolean,
): ChatScreenView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

/** The fixed texts of the chat screen. */
export const CHAT_MESSAGES = Object.freeze({
  unavailable: "The chat is not available.",
  pending: "Checking the chat.",
  noProject:
    "Messages appear once this device is signed in and the project is open.",
  loading: "Loading the messages.",
  empty: "No messages yet.",
  startOfChat: "This is the start of the chat.",
  olderNotShown: "Older messages are not shown.",
  loadOlder: "Load older messages",
  loadingOlder: "Loading older messages…",
  loadOlderFailed: "The older messages could not be loaded.",
  pendingHeading: "Messages waiting to be sent",
  composerHint: "Enter sends the message, and Shift+Enter adds a line.",
  composerDisabled:
    "Messages can be written once this device is signed in and the project is open.",
  sendFailed: "The message could not be sent. Try again.",
});

/**
 * Why the chat is `unavailable`. What was loaded before stays shown, and
 * the main process loads again by itself.
 */
export const CHAT_PROBLEM_MESSAGES: Readonly<Record<ChatProblem, string>> =
  Object.freeze({
    not_signed_in: "The server did not accept this device's sign-in.",
    not_found: "The server did not find this project.",
    rate_limited: "The server asked to wait. Trying again in a minute.",
    unavailable: "The server could not be reached. Trying again later.",
    failed: "The messages could not be loaded. Trying again later.",
  });

/** Why the last page of older messages did not load. */
export const OLDER_PROBLEM_MESSAGES: Readonly<Record<ChatProblem, string>> =
  Object.freeze({
    not_signed_in:
      "The older messages could not be loaded: the server did not accept this device's sign-in.",
    not_found:
      "The older messages could not be loaded: the server did not find this project.",
    rate_limited:
      "The older messages could not be loaded: the server asked to wait a minute.",
    unavailable:
      "The older messages could not be loaded: the server could not be reached.",
    failed: "The older messages could not be loaded.",
  });

/**
 * The text of each answer of `loadOlder`. A started page and one already on
 * its way show in the view, so they need no text.
 */
export const LOAD_OLDER_MESSAGES: Readonly<
  Record<ChatLoadOlderResultView, string | undefined>
> = Object.freeze({
  started: undefined,
  busy: undefined,
  none: "No older messages can be loaded.",
  too_soon: "Wait a moment before loading older messages again.",
});

/**
 * The longest text that `send` takes, in characters (code points): the
 * contract's `CHAT_LIMITS.sendText`, which the bridge enforces. The renderer
 * imports no values from the contract, so a test checks that they match.
 */
export const SEND_TEXT_LIMIT = 64_000;

/**
 * Whether a text is longer than `send` takes, so that it would be refused
 * before the main process sees it. The characters are counted only when the
 * text is longer in UTF-16 code units, which costs nothing for a usual text.
 */
export function isOverSendLimit(text: string): boolean {
  return (
    text.length > SEND_TEXT_LIMIT && Array.from(text).length > SEND_TEXT_LIMIT
  );
}

/** Why a message was not accepted; the text stays in the composer. */
export const SEND_REFUSAL_MESSAGES: Readonly<Record<ChatSendRefusal, string>> =
  Object.freeze({
    blank: "Write a message first.",
    too_long:
      "The message is too long. A message holds at most 16,000 characters.",
    invalid_characters:
      "The message holds a character that cannot be sent, such as a control character.",
    too_many_pending:
      "Too many messages wait to be sent. Wait until they are sent, or discard some.",
    no_project:
      "Messages can be sent once this device is signed in and the project is open.",
  });

/** The text of each state of a waiting message. */
export const PENDING_STATUS_LABELS: Readonly<
  Record<ChatPendingView["status"], string>
> = Object.freeze({
  waiting: "Waiting for the connection",
  sending: "Sending…",
  not_sent: "Not sent",
});

/** Why a message shows as not sent. */
export const NOT_SENT_REASON_MESSAGES: Readonly<
  Record<ChatNotSentReasonView, string>
> = Object.freeze({
  not_found: "The server did not find this project.",
  conflict: "The server refused it, because its ID is already in use.",
  rate_limited: "The server asked to wait, and the automatic retries ran out.",
  not_sendable: "This device could not send it.",
});

/** The text of each author kind. */
export const AUTHOR_KIND_LABELS: Readonly<
  Record<ChatMessageView["authorKind"], string>
> = Object.freeze({
  member: "Person",
  agent: "Agent",
});

/** A waiting message as the screen shows it. */
export interface PendingRow {
  readonly eventId: string;
  readonly body: string;
  readonly status: ChatPendingView["status"];
  readonly statusLabel: string;
  /** Why it was not sent; only with `not_sent`. */
  readonly reason: string | undefined;
  /** Only a message that shows as not sent can be tried again. */
  readonly canRetry: boolean;
  /** A message that is being sent cannot be discarded. */
  readonly canDiscard: boolean;
}

/** What the screen lists, in the order of the main process. */
export interface ChatLists {
  readonly messages: readonly ChatMessageView[];
  /** How many older held messages the view leaves out. */
  readonly moreMessages: number;
  readonly older: ChatOlderState;
  /** Why the last older page did not load, as text, or undefined. */
  readonly olderProblem: string | undefined;
  readonly pending: readonly PendingRow[];
  /** How many later waiting messages the view leaves out. */
  readonly morePending: number;
}

export interface ChatScreenModel {
  /** The text of the screen's status paragraph; empty when there is none. */
  readonly status: string;
  /** The messages and the waiting messages, or null when there is nothing to list. */
  readonly lists: ChatLists | null;
  /** Whether the composer takes a message: the shown project is open in the main process. */
  readonly canWrite: boolean;
}

export function pendingRow(pending: ChatPendingView): PendingRow {
  return {
    eventId: pending.eventId,
    body: pending.body,
    status: pending.status,
    statusLabel: PENDING_STATUS_LABELS[pending.status],
    reason:
      pending.status === "not_sent"
        ? NOT_SENT_REASON_MESSAGES[pending.reason]
        : undefined,
    canRetry: pending.status === "not_sent",
    canDiscard: pending.status !== "sending",
  };
}

function listsOf(state: ChatView): ChatLists {
  return {
    messages: state.messages,
    moreMessages: state.moreMessages,
    older: state.older,
    olderProblem:
      state.olderProblem === undefined
        ? undefined
        : OLDER_PROBLEM_MESSAGES[state.olderProblem],
    pending: state.pending.map(pendingRow),
    morePending: state.morePending,
  };
}

function isEmpty(state: ChatView): boolean {
  return (
    state.messages.length === 0 &&
    state.moreMessages === 0 &&
    state.pending.length === 0 &&
    state.morePending === 0
  );
}

/**
 * What the screen shows for the project that the shell shows:
 *
 * - a fixed text without the bridge, before the first state, and while no
 *   project is open in the main process or no device is signed in
 *   (`no_project`); the composer is disabled;
 * - the loading text while the chat belongs to another project, for example
 *   right after the person opened this one, so that no other project's
 *   messages appear here and nothing is sent to it;
 * - while `loading`, the loading text, with the waiting messages if any;
 * - when `ready`, the messages and the waiting messages;
 * - when `unavailable`, the problem as a fixed text, with what was loaded
 *   before. Without any of it, only the problem shows, because "No
 *   messages yet." would claim what was never loaded.
 */
export function describeChatScreen(
  view: ChatScreenView,
  projectId: string,
): ChatScreenModel {
  switch (view.kind) {
    case "unavailable":
      return {
        status: CHAT_MESSAGES.unavailable,
        lists: null,
        canWrite: false,
      };
    case "pending":
      return { status: CHAT_MESSAGES.pending, lists: null, canWrite: false };
    case "known":
      break;
  }
  const { state } = view;
  if (state.status === "no_project") {
    return { status: CHAT_MESSAGES.noProject, lists: null, canWrite: false };
  }
  if (state.projectId !== projectId) {
    return { status: CHAT_MESSAGES.loading, lists: null, canWrite: false };
  }
  const lists = isEmpty(state) ? null : listsOf(state);
  switch (state.status) {
    case "loading":
      return { status: CHAT_MESSAGES.loading, lists, canWrite: true };
    case "unavailable":
      return {
        status: CHAT_PROBLEM_MESSAGES[state.problem],
        lists,
        canWrite: true,
      };
    case "ready":
      return { status: "", lists: listsOf(state), canWrite: true };
  }
}

/** The note above the messages when older held messages are left out. */
export function describeMoreMessages(count: number): string {
  return count === 1
    ? "1 older message is not shown."
    : `${count} older messages are not shown.`;
}

/** The note below the waiting messages when later ones are left out. */
export function describeMorePending(count: number): string {
  return count === 1
    ? "1 more waiting message is not shown."
    : `${count} more waiting messages are not shown.`;
}

/**
 * The note about older messages, or undefined: `none` marks the start of
 * the chat, and `not_shown` says that older messages exist, unless the
 * count of the left-out messages says so already. `available` and
 * `loading` show the button instead.
 */
export function describeOlder(lists: ChatLists): string | undefined {
  if (lists.moreMessages > 0) {
    return describeMoreMessages(lists.moreMessages);
  }
  switch (lists.older) {
    case "none":
      return lists.messages.length === 0
        ? undefined
        : CHAT_MESSAGES.startOfChat;
    case "not_shown":
      return CHAT_MESSAGES.olderNotShown;
    case "available":
    case "loading":
      return undefined;
  }
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * The time of a message in the person's locale and time zone, for example
 * "Nov 6, 2026, 9:30 AM". A timestamp that is not a date stays as it is.
 */
export function formatChatTime(
  timestamp: string,
  format: Intl.DateTimeFormat = TIME_FORMAT,
): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : format.format(date);
}

/** What a key in the composer does. */
export type ComposerKeyAction = "send" | "none";

/**
 * Enter sends the message; Shift+Enter, and every other key, does what the
 * text area does, so Shift+Enter adds a line. An Enter that ends an input
 * method's composition only ends it.
 */
export function composerKeyAction(key: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
}): ComposerKeyAction {
  return key.key === "Enter" && !key.shiftKey && !key.isComposing
    ? "send"
    : "none";
}

/** The composer's state, which the screen's controller keeps. */
export interface ChatComposer {
  readonly text: string;
  /** A send waits for its answer; the text cannot change meanwhile. */
  readonly sending: boolean;
  /** Why the last send was refused or failed, or undefined. */
  readonly notice: string | undefined;
}

export const EMPTY_COMPOSER: ChatComposer = Object.freeze({
  text: "",
  sending: false,
  notice: undefined,
});

/** The chat part of the screen, apart from React: see `createChatScreen`. */
export interface ChatScreenController {
  /**
   * Subscribes to the chat state. Returns the function that ends the
   * subscription and drops the answers that are still open.
   */
  readonly start: () => () => void;
  /** The person changed the text; ignored while a send waits. */
  readonly textChanged: (text: string) => void;
  /** Sends the text, unless a send already waits for its answer. */
  readonly send: () => void;
  readonly retry: (eventId: string) => void;
  readonly discard: (eventId: string) => void;
  /** Asks for older messages, unless the last ask has not been answered. */
  readonly loadOlder: () => void;
}

/**
 * The logic of the chat screen, which its hook drives from an effect.
 *
 * - Every state becomes the view; a refused subscription makes the view
 *   unavailable.
 * - A send passes the text on as it is: the main process applies the
 *   protocol's rules. A text longer than the bridge takes shows the
 *   `too_long` refusal at once, without a call. The text cannot change
 *   until the answer arrives. It is cleared only when the send is
 *   accepted; a refusal keeps it and shows the refusal as a fixed text,
 *   which the next change of the text clears.
 * - Retry and discard change nothing here: the next state shows what
 *   followed.
 * - Loading older messages shows the text of its answer, if any, until a
 *   newer state arrives.
 */
export function createChatScreen(
  chat: Pick<
    ChatBridge,
    "subscribeState" | "send" | "retry" | "discard" | "loadOlder"
  >,
  onView: (view: ChatScreenView) => void,
  onComposer: (composer: ChatComposer) => void,
  onOlderNotice: (notice: string | undefined) => void,
): ChatScreenController {
  let active = false;
  let composer = EMPTY_COMPOSER;
  /** The revision of the last state, or -1 before the first one. */
  let revision = -1;
  /** The revision at which the older notice was set, or undefined. */
  let noticeRevision: number | undefined;
  let olderAsked = false;

  const setComposer = (next: ChatComposer) => {
    composer = next;
    onComposer(next);
  };
  const setOlderNotice = (notice: string | undefined) => {
    noticeRevision = notice === undefined ? undefined : revision;
    onOlderNotice(notice);
  };

  return Object.freeze({
    start: () => {
      active = true;
      const stop = chat.subscribeState(
        (state) => {
          revision = state.revision;
          onView({ kind: "known", state });
          if (noticeRevision !== undefined && revision > noticeRevision) {
            setOlderNotice(undefined);
          }
        },
        () => onView({ kind: "unavailable" }),
      );
      return () => {
        active = false;
        stop();
      };
    },
    textChanged: (text: string) => {
      if (!composer.sending) {
        setComposer({ text, sending: false, notice: undefined });
      }
    },
    send: () => {
      if (composer.sending) {
        return;
      }
      const { text } = composer;
      if (isOverSendLimit(text)) {
        // The bridge refuses it, and trying again would never help.
        setComposer({
          text,
          sending: false,
          notice: SEND_REFUSAL_MESSAGES.too_long,
        });
        return;
      }
      setComposer({ text, sending: true, notice: undefined });
      chat.send(text).then(
        (result) => {
          if (active) {
            setComposer(
              result.outcome === "accepted"
                ? EMPTY_COMPOSER
                : {
                    text,
                    sending: false,
                    notice: SEND_REFUSAL_MESSAGES[result.reason],
                  },
            );
          }
        },
        () => {
          if (active) {
            setComposer({
              text,
              sending: false,
              notice: CHAT_MESSAGES.sendFailed,
            });
          }
        },
      );
    },
    retry: (eventId: string) => {
      // The next state shows what followed; a refusal changes nothing.
      chat.retry(eventId).catch(() => undefined);
    },
    discard: (eventId: string) => {
      chat.discard(eventId).catch(() => undefined);
    },
    loadOlder: () => {
      if (olderAsked) {
        return;
      }
      olderAsked = true;
      setOlderNotice(undefined);
      chat.loadOlder().then(
        (result) => {
          olderAsked = false;
          if (active) {
            setOlderNotice(LOAD_OLDER_MESSAGES[result]);
          }
        },
        () => {
          olderAsked = false;
          if (active) {
            setOlderNotice(CHAT_MESSAGES.loadOlderFailed);
          }
        },
      );
    },
  });
}
