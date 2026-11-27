import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import type {
  AgentBridge,
  ChatBridge,
  ProjectRepositoriesBridge,
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
  followRunRepositories,
  IDLE_RUN_REQUEST,
  NO_REPOSITORY,
  RUN_REQUEST_MESSAGES,
  type RunFormModel,
  type RunRequestController,
  type RunRepositoriesSource,
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
  projectRepositories,
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
  /**
   * The open project's repositories and this device's links, whose linked
   * repositories a run can name (#362).
   */
  readonly projectRepositories?: ProjectRepositoriesBridge | undefined;
}) {
  return (
    <ChatScreenContent
      {...useChatScreen(chat)}
      run={useRunRequest(
        agents,
        providerConnections,
        projectRepositories,
        projectId,
      )}
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
  /**
   * The open project's repositories with this device's links (#362), or
   * `"unavailable"` when the main process refused the subscription.
   */
  readonly repositories: RunRepositoriesSource;
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
            run.repositories,
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
            // On an open form, from either step, it closes the form.
            if (form === null) {
              runs.actions.open(message.id);
            } else {
              runs.actions.close();
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
 * The run form of one message: the agent, the AI provider connection, and
 * the repository, labelled, then a separate confirmation that names all
 * three, with "Cancel" first, which takes the focus. The repository list
 * offers "No repository" first, then the project's repositories that the
 * account linked on this device, by name; its hint says which ones it
 * offers, or that they cannot be read, and while a repository is chosen,
 * the list and the confirmation say that the names of its files and
 * folders are sent to the provider if the agent may read it. Why nothing
 * can be requested shows in its place. While a request waits, nothing can
 * change or be sent again.
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
  const repositoryId = `${id}-repository`;
  const repositoryHintId = `${id}-repository-hint`;
  const repositoryFilesId = `${id}-repository-files`;
  if (form.step === "confirm") {
    const textId = `${id}-confirm-text`;
    const summaryId = `${id}-confirm-summary`;
    const filesId = `${id}-confirm-files`;
    const describedBy = [
      textId,
      summaryId,
      ...(form.repositoryFiles === undefined ? [] : [filesId]),
      noteId,
      bodyId,
    ].join(" ");
    return (
      <div
        className="run-form run-confirmation"
        id={id}
        role="group"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
      >
        <h3 id={titleId}>{RUN_REQUEST_MESSAGES.confirmTitle}</h3>
        <p id={textId}>{RUN_REQUEST_MESSAGES.confirmText}</p>
        <dl id={summaryId} className="run-confirmation-summary">
          <dt>{RUN_REQUEST_MESSAGES.agentLabel}</dt>
          <dd dir="auto">{form.agentLabel}</dd>
          <dt>{RUN_REQUEST_MESSAGES.connectionLabel}</dt>
          <dd dir="auto">{form.connectionLabel}</dd>
          <dt>{RUN_REQUEST_MESSAGES.repositoryLabel}</dt>
          <dd dir="auto">{form.repositoryLabel}</dd>
        </dl>
        {form.repositoryFiles === undefined ? null : (
          <p className="run-hint" id={filesId}>
            {form.repositoryFiles}
          </p>
        )}
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
          onClick={() => runs.actions.cancel(form)}
        >
          {RUN_REQUEST_MESSAGES.cancel}
        </button>{" "}
        <button
          type="button"
          disabled={form.sending}
          onClick={() => runs.actions.confirm(form)}
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
          <label htmlFor={repositoryId}>
            {RUN_REQUEST_MESSAGES.repositoryLabel}
          </label>
          <select
            id={repositoryId}
            aria-describedby={
              form.repositoryFiles === undefined
                ? repositoryHintId
                : `${repositoryHintId} ${repositoryFilesId}`
            }
            value={form.repositoryId ?? NO_REPOSITORY}
            onChange={(event) =>
              runs.actions.chooseRepository(event.target.value)
            }
          >
            <option value={NO_REPOSITORY}>
              {RUN_REQUEST_MESSAGES.noRepository}
            </option>
            {form.repositories.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
          <p className="run-hint" id={repositoryHintId}>
            {form.repositoryHint}
          </p>
          {form.repositoryFiles === undefined ? null : (
            <p className="run-hint" id={repositoryFilesId}>
              {form.repositoryFiles}
            </p>
          )}
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
        onClick={() => runs.actions.cancel(form)}
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
 * Follows the agent activity, this device's provider connections, and the
 * open project's repositories with this device's links (#362) while the
 * screen is shown, and carries out the run request (#35) of the project. The focus goes back to a message's "Run with agent" after a
 * cancel, and to the sentence after an answer. The controller starts with
 * the effect and stops with its cleanup, so that it applies answers again
 * when React's development mode runs the effect a second time. Undefined
 * without the agent bridge.
 */
function useRunRequest(
  agents: AgentBridge | undefined,
  providerConnections: ProviderConnectionsBridge | undefined,
  projectRepositories: ProjectRepositoriesBridge | undefined,
  projectId: string,
): ChatRunProps | undefined {
  const [state, setState] = useState<RunRequestState>(IDLE_RUN_REQUEST);
  const [activity, setActivity] = useState<AgentActivityView | undefined>(
    undefined,
  );
  const [connections, setConnections] = useState<
    ProviderConnectionListView | undefined
  >(undefined);
  const [repositories, setRepositories] =
    useState<RunRepositoriesSource>(undefined);
  const controller = useMemo(
    () =>
      agents === undefined
        ? undefined
        : createRunRequestController(agents, projectId, setState),
    [agents, projectId],
  );
  useEffect(() => controller?.start(), [controller]);
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
  useEffect(
    () =>
      projectRepositories === undefined
        ? undefined
        : followRunRepositories(projectRepositories, setRepositories),
    [projectRepositories],
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
        repositories,
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
