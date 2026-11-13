import {
  EventIdSchema,
  type ChatMessage,
  type ChatMessageAuthor,
} from "@mymandev/protocol";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  CHAT_LIMITS,
  type ChatLoadOlderResultView,
  type ChatMessageView,
  type ChatOlderState,
  type ChatPendingView,
  type ChatSendResultView,
  type ChatStatusView,
  type ChatView,
} from "../shared/ipc-contract.ts";
import type {
  ChatPendingCopy,
  ChatSendResult,
  ChatService,
  ChatServiceStatus,
  ChatState,
} from "./chat/service.ts";
import {
  createEventPublisher,
  createInvokeHandler,
  type IpcRegistry,
} from "./ipc.ts";
import type { ScheduleTimer } from "./runtime.ts";
import {
  workspaceRetryDelayMs,
  type WorkspaceService,
} from "./workspace/service.ts";

/**
 * The shortest time between two publishes of the chat state. A burst of
 * changes, such as a reload that applies many waiting events, sends the
 * latest view once at the end of it.
 */
export const CHAT_PUBLISH_INTERVAL_MS = 50;

/**
 * Each status of the service and its status in the contract. `satisfies`
 * checks the fresh literal, so the record fails to compile when the service
 * gains or loses a status.
 */
const STATUS_VIEWS = {
  no_project: "no_project",
  loading: "loading",
  ready: "ready",
  unavailable: "unavailable",
} satisfies Record<ChatServiceStatus, ChatStatusView>;
Object.freeze(STATUS_VIEWS);

/** `text`, cut to `maxLength` characters (code points), as zod counts them. */
function cut(text: string, maxLength: number): string {
  // A string of at most `maxLength` UTF-16 code units has at most as many
  // code points, so only a longer one is counted.
  if (text.length <= maxLength) {
    return text;
  }
  const characters = Array.from(text);
  return characters.length > maxLength
    ? characters.slice(0, maxLength).join("")
    : text;
}

/**
 * The part of `CHAT_LIMITS.text` that the newest held messages take before
 * the waiting messages, in UTF-16 code units: the longest body, 16,000
 * characters (`CHAT_LIMITS.body`) of two code units each. So the newest
 * held message always shows, also while the waiting messages alone exceed
 * the budget (the Project Manager's decision of 2026-11-13 on #243). The
 * waiting messages keep the rest, at least 468,000 code units, so the first
 * of them always shows too.
 */
export const CHAT_HELD_TEXT_RESERVE = 2 * CHAT_LIMITS.body;

/**
 * What a view of `state` shows: the first `pending` waiting messages, and
 * the held messages from index `firstMessage` on, the newest ones. The
 * counts stay within `CHAT_LIMITS`, and the bodies of both lists together
 * within `CHAT_LIMITS.text`, taken in three steps:
 *
 * 1. the held messages from the newest back, while they fit
 *    `CHAT_HELD_TEXT_RESERVE`;
 * 2. the waiting messages, in order, while each fits what is left of the
 *    budget;
 * 3. the held messages again from where the first step stopped, while each
 *    fits what is left.
 *
 * The reserve is a part of the budget, never added to it, so a view holds
 * at most 500,000 code units of body text, whatever waits. It holds only
 * the held messages that exist: without them, the waiting messages may use
 * the whole budget. Held messages that fit the reserve all show, whatever
 * waits, so while they do, the waiting messages never take the older page
 * away (`olderState`). A body is measured in UTF-16 code units (`length`),
 * which costs nothing to read. Nothing after the first one that does not fit is shown in either
 * list, so the shown messages have no gap, and the waiting messages left
 * out are always the last ones, which `morePending` counts.
 */
function fitView(state: ChatState): {
  readonly pending: number;
  readonly firstMessage: number;
} {
  const { messages } = state;
  let firstMessage = messages.length;
  /** Shows older held messages while each fits `room`; returns the text used. */
  function showHeld(room: number): number {
    let used = 0;
    while (
      firstMessage > 0 &&
      messages.length - firstMessage < CHAT_LIMITS.messages
    ) {
      const length = messages[firstMessage - 1]?.body.length ?? 0;
      if (used + length > room) {
        break;
      }
      used += length;
      firstMessage -= 1;
    }
    return used;
  }

  let budget = CHAT_LIMITS.text - showHeld(CHAT_HELD_TEXT_RESERVE);
  let pending = 0;
  for (const copy of state.pending) {
    if (pending === CHAT_LIMITS.pending || copy.body.length > budget) {
      break;
    }
    budget -= copy.body.length;
    pending += 1;
  }
  showHeld(budget);
  return { pending, firstMessage };
}

/**
 * Whether older messages can be shown. Loading another page is offered only
 * while the view shows every held message and has room for more messages;
 * otherwise the page would be left out of the view.
 */
function olderState(state: ChatState, firstMessage: number): ChatOlderState {
  if (state.loadingOlder) {
    return "loading";
  }
  const shown = state.messages.length - firstMessage;
  if (firstMessage > 0 || (state.hasOlder && shown >= CHAT_LIMITS.messages)) {
    return "not_shown";
  }
  return state.hasOlder ? "available" : "none";
}

function messageView(
  message: ChatMessage,
  authorName: (author: ChatMessageAuthor) => string,
): ChatMessageView {
  return Object.freeze({
    id: message.id,
    seq: message.seq,
    authorKind: message.author.kind,
    authorName: cut(authorName(message.author), CHAT_LIMITS.authorName),
    body: message.body,
    createdAt: message.createdAt,
  });
}

function pendingView(copy: ChatPendingCopy): ChatPendingView {
  return copy.status === "not_sent"
    ? Object.freeze({
        eventId: copy.eventId,
        body: copy.body,
        status: copy.status,
        reason: copy.reason,
      })
    : Object.freeze({
        eventId: copy.eventId,
        body: copy.body,
        status: copy.status,
      });
}

/**
 * The frozen copy of the chat service's state that crosses IPC, with
 * `revision` as its revision. Each author is resolved to a display name
 * with `authorName`, cut to `CHAT_LIMITS.authorName`; no member ID, agent
 * ID, user ID, or device ID crosses. The view holds the newest held
 * messages and the first waiting messages, within the counts and the text
 * budget of `CHAT_LIMITS`, with a reserve of the budget for the newest held
 * messages (see `fitView`), and counts what it leaves out: `moreMessages`
 * the oldest held messages, `morePending` the last waiting ones. The bodies
 * are the service's, which the protocol's rules checked, so none is cut. At
 * every limit at once, a view holds 500,000 code units of body text and
 * less than 200,000 of other strings, about 1.4 MB as V8 serializes it for
 * IPC.
 */
export function chatView(
  state: ChatState,
  revision: number,
  authorName: (author: ChatMessageAuthor) => string,
): ChatView {
  const fit = fitView(state);
  const fields = {
    revision,
    workspaceId: state.workspaceId,
    projectId: state.projectId,
    messages: Object.freeze(
      state.messages
        .slice(fit.firstMessage)
        .map((message) => messageView(message, authorName)),
    ),
    moreMessages: fit.firstMessage,
    older: olderState(state, fit.firstMessage),
    ...(state.olderProblem === undefined
      ? {}
      : { olderProblem: state.olderProblem }),
    pending: Object.freeze(
      state.pending.slice(0, fit.pending).map(pendingView),
    ),
    morePending: state.pending.length - fit.pending,
  };
  const status = STATUS_VIEWS[state.status];
  if (status === "unavailable") {
    return Object.freeze({
      status,
      problem: state.problem ?? "failed",
      ...fields,
    });
  }
  return Object.freeze({ status, ...fields });
}

function sendResultView(result: ChatSendResult): ChatSendResultView {
  return result.kind === "accepted"
    ? Object.freeze({ outcome: "accepted", eventId: result.eventId })
    : Object.freeze({ outcome: "refused", reason: result.reason });
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

export interface ChatIpcOptions {
  readonly chat: Pick<
    ChatService,
    | "state"
    | "onChange"
    | "send"
    | "retry"
    | "discard"
    | "loadOlder"
    | "authorName"
  >;
  /** A change of the workspace service may change an author's name. */
  readonly workspaces: Pick<WorkspaceService, "onChange">;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now?: () => number;
  /** Defaults to `console.error`. */
  readonly onError?: (message: string, error: unknown) => void;
}

export interface ChatIpc {
  /** Stops listening and cancels a publish that waits, for the quit. */
  readonly close: () => void;
}

/**
 * Registers the handlers of the chat channels and sends the chat of the
 * open project to the frames that subscribed. Every handler checks the
 * sender and the arguments first (`createInvokeHandler`) and answers with a
 * value parsed by the contract, so only IDs, names, bodies, times, and
 * fixed codes reach the renderer, never a member ID, a user ID, or a device
 * ID.
 *
 * - `send` takes one string of at most `CHAT_LIMITS.sendText` characters;
 *   the service prepares the body with the protocol's rules.
 * - `retry` and `discard` take one event ID, which the contract checks as a
 *   lowercase UUIDv7 and the main process again with the protocol's
 *   `EventIdSchema`.
 * - `loadOlder` answers `none` without a read while there is nothing older
 *   (`none`) or the view cannot show another page (`not_shown`), and
 *   `too_soon` without a read after an older page did not load, until the
 *   workspace service's backoff has passed (`workspaceRetryDelayMs`:
 *   min(60 s, 2 s x 2^n) for the n-th failure in a row before this one in
 *   the same chat, and 60 s after `rate_limited`), so that a renderer
 *   cannot read the API in a loop.
 *
 * A change of the chat service, and a change of the workspace service,
 * which also reports a new name of a person, raise the view's revision at
 * once and publish the latest view after `CHAT_PUBLISH_INTERVAL_MS`, so at
 * most one view goes out in each interval and the last change of a burst is
 * always sent. Call it before the first window loads.
 */
export function registerChatIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: ChatIpcOptions,
): ChatIpc {
  const { chat, workspaces } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const now = options.now ?? (() => performance.now());
  const onError =
    options.onError ??
    ((message: string, error: unknown) => console.error(message, error));
  const publisher = createEventPublisher(
    EVENT_CHANNELS.chatStateChanged,
    appUrl,
  );

  let closed = false;
  let revision = 0;
  let cancelPublish: (() => void) | null = null;
  /** The chat and whether an older page was on its way, in the last state seen. */
  const initial = chat.state();
  let chatWorkspaceId = initial.workspaceId;
  let chatProjectId = initial.projectId;
  let loadingOlder = initial.loadingOlder;
  /** The older pages that did not load in a row, and when the last one ended. */
  let olderFailures = 0;
  let olderFailedAt = 0;

  function view(): ChatView {
    return chatView(chat.state(), revision, chat.authorName);
  }

  function publish(): void {
    cancelPublish = null;
    if (closed) {
      return;
    }
    try {
      publisher.publish(view());
    } catch (error) {
      onError("Sending the chat state failed.", error);
    }
  }

  function changed(): void {
    if (closed) {
      return;
    }
    revision += 1;
    // A publish that waits sends the latest view when its time comes.
    cancelPublish ??= schedule(publish, CHAT_PUBLISH_INTERVAL_MS);
  }

  /**
   * Counts the older pages of the chat that did not load in a row. The
   * count starts again with another chat: another workspace or project, and
   * a sign-out or another account or device, which leave no chat first. It
   * also starts again whenever no older page failed and none is on its
   * way, for example after a page loaded.
   */
  function chatChanged(state: ChatState): void {
    if (
      state.workspaceId !== chatWorkspaceId ||
      state.projectId !== chatProjectId ||
      (state.olderProblem === undefined && !state.loadingOlder)
    ) {
      olderFailures = 0;
      olderFailedAt = 0;
    } else if (
      loadingOlder &&
      !state.loadingOlder &&
      state.olderProblem !== undefined
    ) {
      olderFailures += 1;
      olderFailedAt = now();
    }
    chatWorkspaceId = state.workspaceId;
    chatProjectId = state.projectId;
    loadingOlder = state.loadingOlder;
    changed();
  }

  function loadOlder(): ChatLoadOlderResultView {
    const state = chat.state();
    const older = olderState(state, fitView(state).firstMessage);
    if (older === "none" || older === "not_shown") {
      return "none";
    }
    if (
      state.olderProblem !== undefined &&
      olderFailures > 0 &&
      now() - olderFailedAt <
        workspaceRetryDelayMs(olderFailures - 1, state.olderProblem)
    ) {
      return "too_soon";
    }
    return chat.loadOlder();
  }

  ipc.handle(
    INVOKE_CHANNELS.getChatState,
    createInvokeHandler(INVOKE_CHANNELS.getChatState, appUrl, () => view()),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribeChatState,
    createInvokeHandler(INVOKE_CHANNELS.subscribeChatState, appUrl, (event) => {
      publisher.add(event.sender);
      return view();
    }),
  );
  ipc.handle(
    INVOKE_CHANNELS.sendChatMessage,
    createInvokeHandler(
      INVOKE_CHANNELS.sendChatMessage,
      appUrl,
      (_event, [text]) => sendResultView(chat.send(text)),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.retryChatMessage,
    createInvokeHandler(
      INVOKE_CHANNELS.retryChatMessage,
      appUrl,
      (_event, [value]) => {
        const eventId = EventIdSchema.safeParse(value);
        return eventId.success && chat.retry(eventId.data);
      },
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.discardChatMessage,
    createInvokeHandler(
      INVOKE_CHANNELS.discardChatMessage,
      appUrl,
      (_event, [value]) => {
        const eventId = EventIdSchema.safeParse(value);
        return eventId.success && chat.discard(eventId.data);
      },
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.loadOlderChatMessages,
    createInvokeHandler(INVOKE_CHANNELS.loadOlderChatMessages, appUrl, () =>
      loadOlder(),
    ),
  );
  const removers = [chat.onChange(chatChanged), workspaces.onChange(changed)];

  return Object.freeze({
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const remove of removers) {
        remove();
      }
      cancelPublish?.();
      cancelPublish = null;
    },
  });
}
