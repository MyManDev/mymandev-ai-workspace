import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import type {
  AgentBridge,
  ChatBridge,
  ProviderConnectionsBridge,
} from "../shared/desktop-bridge.ts";
import type {
  AgentActivityView,
  ChatMessageView,
  ProviderConnectionListView,
} from "../shared/ipc-contract.ts";
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
import {
  canRunWith,
  createRunRequestController,
  describeRunForm,
  IDLE_RUN_REQUEST,
  RUN_REQUEST_MESSAGES,
  type RunFormModel,
  type RunRequestController,
  type RunRequestState,
} from "./run-request-view.ts";

/**
 * The chat of the open project: its messages, the person's messages that
 * wait to be sent, and the composer. The main process holds the chat and
 * sends it; this screen shows its state and passes the person's actions on.
 */
export function ChatScreen({
  chat,
  projectId,
  agents,
  providerConnections,
}: {
  /** The chat functions from the preload script; undefined outside Electron. */
  readonly chat: ChatBridge | undefined;
  /** The project that the shell shows. */
  readonly projectId: string;
  /**
   * The agent activity and the run request (#35); without it, no message
   * offers "Run with agent".
   */
  readonly agents?: AgentBridge | undefined;
  /** This device's AI provider connections, the choices of a run. */
  readonly providerConnections?: ProviderConnectionsBridge | undefined;
}) {
  return (
    <ChatScreenContent
      {...useChatScreen(chat)}
      run={useRunRequest(agents, providerConnections)}
      projectId={projectId}
    />
  );
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
  /**
   * "Run with agent" on the person's own messages (#35); undefined without
   * the agent bridge, when no message offers it.
   */
  readonly run?: ChatRunProps | undefined;
}

/** What the screen needs to offer "Run with agent" (#35). */
export interface ChatRunProps {
  readonly state: RunRequestState;
  /** The agent activity, for the agents that this device can run. */
  readonly activity: AgentActivityView | undefined;
  /** This device's provider connections. */
  readonly connections: ProviderConnectionListView | undefined;
  readonly actions: RunRequestController;
  /** Where the hook puts the focus after a cancel and after an answer. */
  readonly focus?: RunFocus;
}

/**
 * The elements that take the focus: the "Run with agent" of the message
 * whose form closed, and the sentence after an answer.
 */
export interface RunFocus {
  readonly trigger: Ref<HTMLButtonElement>;
  readonly notice: Ref<HTMLParagraphElement>;
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
  run,
}: ChatScreenContentProps) {
  const { status, lists, canWrite } = describeChatScreen(view, projectId);
  // A run is requested only in the project that the main process has open,
  // as a message is sent there.
  const runs =
    run === undefined || !canWrite || lists === null
      ? undefined
      : {
          ...run,
          projectId,
          form: describeRunForm(
            run.state,
            lists.messages,
            run.activity,
            run.connections,
            projectId,
          ),
        };
  return (
    <section className="chat" aria-labelledby="chat-title">
      <h2 id="chat-title">Chat</h2>
      <p className="chat-status" role="status">
        {status}
      </p>
      {lists === null ? null : (
        <Timeline
          lists={lists}
          olderNotice={olderNotice}
          actions={actions}
          runs={runs}
        />
      )}
      {run === undefined ? null : (
        <p
          className="run-request-status"
          role="status"
          tabIndex={-1}
          ref={run.focus?.notice}
        >
          {run.state.notice}
        </p>
      )}
      <Composer
        composer={composer}
        canWrite={canWrite && actions !== undefined}
        actions={actions}
      />
    </section>
  );
}

/** The run request as the timeline shows it: the props and the open form. */
type TimelineRuns = ChatRunProps & {
  readonly projectId: string;
  readonly form: RunFormModel | null;
};

function Timeline({
  lists,
  olderNotice,
  actions,
  runs,
}: {
  readonly lists: ChatLists;
  readonly olderNotice: string | undefined;
  readonly actions: ChatScreenActions | undefined;
  readonly runs: TimelineRuns | undefined;
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
            <MessageItem key={message.id} message={message} runs={runs} />
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

/** The ID of a message's body, which describes its "Run with agent". */
export function messageBodyId(messageId: string): string {
  return `message-body-${messageId}`;
}

/** The ID of a message's run form. */
export function runFormId(messageId: string): string {
  return `run-form-${messageId}`;
}

function MessageItem({
  message,
  runs,
}: {
  readonly message: ChatMessageView;
  readonly runs: TimelineRuns | undefined;
}) {
  const bodyId = messageBodyId(message.id);
  const offered = runs !== undefined && canRunWith(message);
  const form =
    offered && runs.form?.messageId === message.id ? runs.form : null;
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
      <p className="message-body" id={bodyId} dir="auto">
        {message.body}
      </p>
      {offered ? (
        <button
          type="button"
          className="message-action"
          aria-describedby={bodyId}
          aria-expanded={form !== null}
          aria-controls={form === null ? undefined : runFormId(message.id)}
          disabled={runs.state.sending}
          ref={
            runs.state.returnFocusTo === message.id
              ? runs.focus?.trigger
              : undefined
          }
          onClick={() => {
            if (form === null) {
              runs.actions.open(message.id);
            } else {
              runs.actions.cancel();
            }
          }}
        >
          {RUN_REQUEST_MESSAGES.open}
        </button>
      ) : null}
      {form === null || runs === undefined ? null : (
        <RunForm form={form} runs={runs} bodyId={bodyId} />
      )}
    </li>
  );
}

/**
 * The run form of one message: the agent and the AI provider connection,
 * labelled, then a separate confirmation that names both, with "Cancel"
 * first, which takes the focus. Why nothing can be requested shows in its
 * place. While a request waits, nothing can change or be sent again.
 */
function RunForm({
  form,
  runs,
  bodyId,
}: {
  readonly form: RunFormModel;
  readonly runs: TimelineRuns;
  readonly bodyId: string;
}) {
  const id = runFormId(form.messageId);
  const titleId = `${id}-title`;
  const noteId = `${id}-note`;
  const agentId = `${id}-agent`;
  const connectionId = `${id}-connection`;
  if (form.step === "confirm") {
    const textId = `${id}-confirm-text`;
    const summaryId = `${id}-confirm-summary`;
    return (
      <div
        className="run-form run-confirmation"
        id={id}
        role="group"
        aria-labelledby={titleId}
        aria-describedby={`${textId} ${summaryId} ${noteId} ${bodyId}`}
      >
        <h3 id={titleId}>{RUN_REQUEST_MESSAGES.confirmTitle}</h3>
        <p id={textId}>{RUN_REQUEST_MESSAGES.confirmText}</p>
        <dl id={summaryId} className="run-confirmation-summary">
          <dt>{RUN_REQUEST_MESSAGES.agentLabel}</dt>
          <dd dir="auto">{form.agentLabel}</dd>
          <dt>{RUN_REQUEST_MESSAGES.connectionLabel}</dt>
          <dd dir="auto">{form.connectionLabel}</dd>
        </dl>
        <p className="run-note" id={noteId}>
          {RUN_REQUEST_MESSAGES.note}
        </p>
        {form.sending ? (
          <p className="run-sending">{RUN_REQUEST_MESSAGES.sending}</p>
        ) : null}
        <button
          type="button"
          autoFocus
          disabled={form.sending}
          onClick={() => runs.actions.cancel()}
        >
          {RUN_REQUEST_MESSAGES.cancel}
        </button>{" "}
        <button
          type="button"
          disabled={form.sending}
          onClick={() => runs.actions.confirm(form, runs.projectId)}
        >
          {RUN_REQUEST_MESSAGES.confirm}
        </button>
      </div>
    );
  }
  return (
    <form
      className="run-form"
      id={id}
      aria-labelledby={titleId}
      aria-describedby={`${noteId} ${bodyId}`}
      onSubmit={(event) => {
        event.preventDefault();
        runs.actions.continue(form);
      }}
    >
      <h3 id={titleId}>{RUN_REQUEST_MESSAGES.formTitle}</h3>
      {form.problem === undefined ? (
        <>
          <label htmlFor={agentId}>{RUN_REQUEST_MESSAGES.agentLabel}</label>
          <select
            id={agentId}
            autoFocus
            value={form.agentId ?? ""}
            onChange={(event) => runs.actions.chooseAgent(event.target.value)}
          >
            {form.agents.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
          <label htmlFor={connectionId}>
            {RUN_REQUEST_MESSAGES.connectionLabel}
          </label>
          <select
            id={connectionId}
            value={form.connectionId ?? ""}
            onChange={(event) =>
              runs.actions.chooseConnection(event.target.value)
            }
          >
            {form.connections.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </>
      ) : (
        <p className="run-problem">{form.problem}</p>
      )}
      <p className="run-note" id={noteId}>
        {RUN_REQUEST_MESSAGES.note}
      </p>
      <button type="submit" disabled={!form.canContinue}>
        {RUN_REQUEST_MESSAGES.continue}
      </button>{" "}
      <button
        type="button"
        autoFocus={form.problem !== undefined}
        onClick={() => runs.actions.cancel()}
      >
        {RUN_REQUEST_MESSAGES.cancel}
      </button>
    </form>
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

/**
 * Follows the agent activity and this device's provider connections while
 * the screen is shown, and carries out the run request (#35). The focus
 * goes back to a message's "Run with agent" after a cancel, and to the
 * sentence after an answer. Undefined without the agent bridge.
 */
function useRunRequest(
  agents: AgentBridge | undefined,
  providerConnections: ProviderConnectionsBridge | undefined,
): ChatRunProps | undefined {
  const [state, setState] = useState<RunRequestState>(IDLE_RUN_REQUEST);
  const [activity, setActivity] = useState<AgentActivityView | undefined>(
    undefined,
  );
  const [connections, setConnections] = useState<
    ProviderConnectionListView | undefined
  >(undefined);
  const controller = useMemo(
    () =>
      agents === undefined
        ? undefined
        : createRunRequestController(agents, setState),
    [agents],
  );
  useEffect(() => () => controller?.stop(), [controller]);
  useEffect(
    () => agents?.subscribeState(setActivity, () => setActivity(undefined)),
    [agents],
  );
  useEffect(
    () =>
      providerConnections?.subscribeState(setConnections, () =>
        setConnections(undefined),
      ),
    [providerConnections],
  );
  const trigger = useRef<HTMLButtonElement>(null);
  const notice = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.focus === "trigger") {
      trigger.current?.focus();
    } else if (state.focus === "notice") {
      notice.current?.focus();
    }
  }, [state]);
  return controller === undefined
    ? undefined
    : {
        state,
        activity,
        connections,
        actions: controller,
        focus: { trigger, notice },
      };
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
