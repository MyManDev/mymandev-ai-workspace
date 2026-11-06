import { useEffect, useMemo, useState } from "react";
import type { ChatBridge } from "../shared/desktop-bridge.ts";
import type { ChatMessageView } from "../shared/ipc-contract.ts";
import {
  AUTHOR_KIND_LABELS,
  CHAT_MESSAGES,
  composerKeyAction,
  createChatScreen,
  describeChatScreen,
  describeMorePending,
  describeOlder,
  EMPTY_COMPOSER,
  formatChatTime,
  initialChatScreenView,
  type ChatComposer,
  type ChatLists,
  type ChatScreenController,
  type ChatScreenView,
  type PendingRow,
} from "./chat-view.ts";

/**
 * The chat of the open project: its messages, the person's messages that
 * wait to be sent, and the composer. The main process holds the chat and
 * sends it; this screen shows its state and passes the person's actions on.
 */
export function ChatScreen({
  chat,
  projectId,
}: {
  /** The chat functions from the preload script; undefined outside Electron. */
  readonly chat: ChatBridge | undefined;
  /** The project that the shell shows. */
  readonly projectId: string;
}) {
  return <ChatScreenContent {...useChatScreen(chat)} projectId={projectId} />;
}

/** The person's actions, which the screen's controller carries out. */
export type ChatScreenActions = Omit<ChatScreenController, "start">;

export interface ChatScreenContentProps {
  readonly view: ChatScreenView;
  /** The project that the shell shows; another project's chat is not shown. */
  readonly projectId: string;
  readonly composer: ChatComposer;
  /** The text of the last answer to loading older messages, or undefined. */
  readonly olderNotice: string | undefined;
  /** Undefined without the bridge, when nothing can be done. */
  readonly actions: ChatScreenActions | undefined;
}

/**
 * The screen for a view, without state. The status paragraphs are always
 * rendered, empty when there is nothing to say, so that a screen reader
 * announces a new text. Names and bodies are text that people and agents
 * entered: each one takes its direction from its own content
 * (`dir="auto"`), and a body keeps its line breaks.
 */
export function ChatScreenContent({
  view,
  projectId,
  composer,
  olderNotice,
  actions,
}: ChatScreenContentProps) {
  const { status, lists, canWrite } = describeChatScreen(view, projectId);
  return (
    <section className="chat" aria-labelledby="chat-title">
      <h2 id="chat-title">Chat</h2>
      <p className="chat-status" role="status">
        {status}
      </p>
      {lists === null ? null : (
        <Timeline lists={lists} olderNotice={olderNotice} actions={actions} />
      )}
      <Composer
        composer={composer}
        canWrite={canWrite && actions !== undefined}
        actions={actions}
      />
    </section>
  );
}

function Timeline({
  lists,
  olderNotice,
  actions,
}: {
  readonly lists: ChatLists;
  readonly olderNotice: string | undefined;
  readonly actions: ChatScreenActions | undefined;
}) {
  const olderNote = describeOlder(lists);
  const olderStatus = [lists.olderProblem, olderNotice].filter(
    (text) => text !== undefined,
  );
  return (
    <>
      <div className="chat-older">
        {olderNote === undefined ? null : (
          <p className="chat-note">{olderNote}</p>
        )}
        {lists.older === "available" || lists.older === "loading" ? (
          <LoadOlderButton
            loading={lists.older === "loading"}
            onLoadOlder={actions?.loadOlder}
          />
        ) : null}
        <p className="chat-older-status" role="status">
          {olderStatus.join(" ")}
        </p>
      </div>
      {lists.messages.length > 0 ? (
        <ol className="message-list" aria-label="Messages">
          {lists.messages.map((message) => (
            <MessageItem key={message.id} message={message} />
          ))}
        </ol>
      ) : lists.pending.length === 0 && lists.morePending === 0 ? (
        <p className="chat-empty">{CHAT_MESSAGES.empty}</p>
      ) : null}
      {lists.pending.length === 0 ? null : (
        <>
          <h3 className="pending-heading" id="pending-heading">
            {CHAT_MESSAGES.pendingHeading}
          </h3>
          <ol className="pending-list" aria-labelledby="pending-heading">
            {lists.pending.map((row) => (
              <PendingItem key={row.eventId} row={row} actions={actions} />
            ))}
          </ol>
        </>
      )}
      {lists.morePending === 0 ? null : (
        <p className="chat-note">{describeMorePending(lists.morePending)}</p>
      )}
    </>
  );
}

/**
 * "Load older messages", or while a page is on its way a button that does
 * nothing (`aria-disabled`), so that the focus stays on it.
 */
function LoadOlderButton({
  loading,
  onLoadOlder,
}: {
  readonly loading: boolean;
  readonly onLoadOlder: (() => void) | undefined;
}) {
  return (
    <button
      type="button"
      className="chat-load-older"
      aria-disabled={loading ? "true" : undefined}
      onClick={loading ? undefined : onLoadOlder}
    >
      {loading ? CHAT_MESSAGES.loadingOlder : CHAT_MESSAGES.loadOlder}
    </button>
  );
}

function MessageItem({ message }: { readonly message: ChatMessageView }) {
  return (
    <li className="message" data-author-kind={message.authorKind}>
      <p className="message-meta">
        <span className="message-author" dir="auto">
          {message.authorName}
        </span>
        <span className="message-kind">
          {AUTHOR_KIND_LABELS[message.authorKind]}
        </span>
        <time className="message-time" dateTime={message.createdAt}>
          {formatChatTime(message.createdAt)}
        </time>
      </p>
      <p className="message-body" dir="auto">
        {message.body}
      </p>
    </li>
  );
}

/**
 * A waiting message: its body, its state, why it was not sent, and Retry
 * and Discard where they apply. Each button names the message through the
 * body (`aria-describedby`), because every row has the same labels.
 */
function PendingItem({
  row,
  actions,
}: {
  readonly row: PendingRow;
  readonly actions: ChatScreenActions | undefined;
}) {
  const bodyId = `pending-body-${row.eventId}`;
  return (
    <li className="pending" data-status={row.status}>
      <p className="message-body" id={bodyId} dir="auto">
        {row.body}
      </p>
      <p className="pending-status">
        {row.statusLabel}
        {row.reason === undefined ? null : (
          <span className="pending-reason">{row.reason}</span>
        )}
      </p>
      {row.canRetry || row.canDiscard ? (
        <div className="pending-actions">
          {row.canRetry ? (
            <button
              type="button"
              className="pending-action"
              aria-describedby={bodyId}
              onClick={() => actions?.retry(row.eventId)}
            >
              Retry
            </button>
          ) : null}
          {row.canDiscard ? (
            <button
              type="button"
              className="pending-action"
              aria-describedby={bodyId}
              onClick={() => actions?.discard(row.eventId)}
            >
              Discard
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The composer: a labelled text area and Send. Enter sends, and Shift+Enter
 * adds a line (`composerKeyAction`). It is disabled while the shown project
 * is not open in the main process, which is also the case without a
 * signed-in device, and read-only while a send waits for its answer.
 */
function Composer({
  composer,
  canWrite,
  actions,
}: {
  readonly composer: ChatComposer;
  readonly canWrite: boolean;
  readonly actions: ChatScreenActions | undefined;
}) {
  const send = () => {
    if (canWrite) {
      actions?.send();
    }
  };
  return (
    <form
      className="composer"
      aria-label="New message"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label className="composer-label" htmlFor="composer-text">
        Message
      </label>
      <textarea
        id="composer-text"
        className="composer-text"
        rows={3}
        dir="auto"
        value={composer.text}
        disabled={!canWrite}
        readOnly={composer.sending}
        aria-describedby="composer-hint composer-status"
        onChange={(event) => actions?.textChanged(event.target.value)}
        onKeyDown={(event) => {
          if (
            composerKeyAction({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
            }) === "send"
          ) {
            event.preventDefault();
            send();
          }
        }}
      />
      <p className="composer-hint" id="composer-hint">
        {canWrite ? CHAT_MESSAGES.composerHint : CHAT_MESSAGES.composerDisabled}
      </p>
      <p className="composer-status" id="composer-status" role="status">
        {composer.notice}
      </p>
      <button type="submit" className="composer-send" disabled={!canWrite}>
        Send
      </button>
    </form>
  );
}

/** Follows the chat while the screen is shown, and carries out the person's actions. */
function useChatScreen(
  chat: ChatBridge | undefined,
): Omit<ChatScreenContentProps, "projectId"> {
  const [view, setView] = useState(() =>
    initialChatScreenView(chat !== undefined),
  );
  const [composer, setComposer] = useState(EMPTY_COMPOSER);
  const [olderNotice, setOlderNotice] = useState<string | undefined>(undefined);
  const controller = useMemo(
    () =>
      chat === undefined
        ? undefined
        : createChatScreen(chat, setView, setComposer, setOlderNotice),
    [chat],
  );
  useEffect(() => controller?.start(), [controller]);
  return { view, composer, olderNotice, actions: controller };
}
