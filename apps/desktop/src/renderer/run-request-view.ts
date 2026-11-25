// Requesting a run of an agent from the project chat (#35, part A): the
// "Run with agent" action on the person's own messages, apart from React.
// The person picks one of the agents that this device can run and one of
// this device's AI provider connections, confirms, and the request goes to
// the main process once. The new run shows through the agent activity, the
// one list of runs; nothing here keeps it. The main process keeps the
// outcome of the project's last request, which the screen takes once when
// it opens, so that an answer that came while it was closed still shows.
import type { AgentBridge } from "../shared/desktop-bridge.ts";
import type {
  AgentActivityView,
  ChatMessageView,
  ProviderConnectionListView,
  RunRequestOutcome,
  RunRequestRefusal,
  RunRequestResult,
  RunRequestView,
} from "../shared/ipc-contract.ts";
import { RUN_REQUEST_LOCAL_REFUSALS } from "../shared/run-request-refusals.ts";
import { PROVIDER_KIND_NAMES } from "./provider-connection-view.ts";
import { describeWait } from "./wait-text.ts";

/** The fixed texts of the run request. */
export const RUN_REQUEST_MESSAGES = Object.freeze({
  open: "Run with agent",
  formTitle: "Run with agent",
  agentLabel: "Agent",
  connectionLabel: "AI provider connection",
  /**
   * Requesting a run does not start it, and nothing here says that it
   * will run: until this device can carry out runs of a provider (#30,
   * #31), the host device fails the run with a reason.
   */
  note: "Requesting a run does not start it. The run waits in the queue until this device picks it up, and a run that this device cannot carry out, for example because it does not support the AI provider yet, fails with a reason in the agent activity.",
  continue: "Continue",
  cancel: "Cancel",
  confirmTitle: "Confirm the run request",
  confirmText:
    "This message becomes the run's instruction. The run is requested once; asking again creates another run.",
  confirm: "Request run",
  sending: "Waiting for the server.",
  agentsPending: "Reading this project's agents.",
  agentsUnavailable: "This project's agents cannot be read now.",
  noAgents:
    "None of this project's agents can run on this device. An agent runs only for its owner, on the device that hosts it, while it is enabled.",
  connectionsPending: "Reading the AI provider connections of this device.",
  connectionsSignedOut:
    "The AI provider connections of this device are known once it is signed in.",
  noConnections:
    "This device has no AI provider connection. Add one in the AI providers section of the Account screen.",
  requested:
    "The run was requested and waits in the queue. Its state shows in the agent activity.",
  notRequested: "The run was not requested.",
  unknown:
    "Whether the run was created is not known: it may have been. Check the agent activity before you request it again.",
});

/** The refusals whose sentence names a wait. */
type Wait = "too_soon" | "rate_limited" | "run_daily_limit";

/** Why a run request was refused, one sentence for each refusal. */
export const RUN_REFUSAL_MESSAGES: Readonly<
  Record<Exclude<RunRequestRefusal, Wait>, string>
> &
  Readonly<Record<Wait, (wait: string) => string>> = Object.freeze({
  invalid: "The request is not one that can be sent.",
  not_open:
    "The agent is not one of this project's agents anymore, or the project is no longer open.",
  not_owner: "Only the agent's owner can request its runs.",
  not_hosted_here:
    "Runs of this agent can only be requested on the device that hosts it.",
  disabled: "This agent is disabled.",
  message_not_found:
    "This message is not in the chat that this device holds for the project.",
  not_own_message: "Only your own messages can be a run's instruction.",
  connection_not_here:
    "The AI provider connection is no longer one of this device's connections.",
  busy: "Another run request is still waiting for the server's answer.",
  not_signed_in:
    "This device is not signed in, or the server did not accept its sign-in.",
  unavailable:
    "The server could not be reached, or this device is busy with the account. Try again later.",
  too_soon: (wait: string) =>
    `This device sent too many changes. Try again in ${wait}.`,
  rate_limited: (wait: string) =>
    `The server asked to wait: too many requests. Try again in ${wait}.`,
  forbidden:
    "The server refused: only the agent's owner requests its runs, and only from the device that hosts the agent.",
  not_found:
    "The server did not find the project for your account, for example because you are not or no longer a member of its workspace, or it did not find the agent, the AI provider connection on this device, or this message as yours.",
  conflict:
    "The agent is disabled, the project or its workspace is archived, or the AI provider connection was removed.",
  run_limit:
    "The agent already has as many unfinished runs as it may have (10). Request another once one of them finishes.",
  run_daily_limit: (wait: string) =>
    `The agent got as many new runs in 24 hours as it may get (100). Try again in ${wait}.`,
  failed: "The server refused the request.",
});

/**
 * The sentence after the answer of a run request, also for the outcome
 * that the main process kept, which has no run ID.
 */
export function describeRunResult(
  result: RunRequestResult | RunRequestOutcome,
): string {
  switch (result.outcome) {
    case "ok":
      return RUN_REQUEST_MESSAGES.requested;
    case "unknown":
      return RUN_REQUEST_MESSAGES.unknown;
    case "refused": {
      const entry = (
        RUN_REFUSAL_MESSAGES as Readonly<
          Record<string, string | ((wait: string) => string)>
        >
      )[result.reason];
      const text =
        typeof entry === "function"
          ? entry(describeWait(result.retryAfterMs ?? 0))
          : (entry ?? RUN_REFUSAL_MESSAGES.failed);
      return `${RUN_REQUEST_MESSAGES.notRequested} ${text}`;
    }
  }
}

/** One choice of a list: its value and its text. */
export interface RunChoice {
  readonly id: string;
  readonly label: string;
}

/**
 * The agents that this device can run for the project that the chat shows:
 * the enabled agents that the account owns and that this device hosts,
 * which the agent activity marks `grantableHere`, in the server's order.
 * null while the activity is not known for that project.
 */
export function runnableAgents(
  activity: AgentActivityView | undefined,
  projectId: string,
): readonly RunChoice[] | null {
  if (
    activity === undefined ||
    activity.projectId !== projectId ||
    activity.status === "no_project" ||
    activity.status === "loading"
  ) {
    return null;
  }
  return activity.agents
    .filter((agent) => agent.grantableHere && agent.disabledAt === null)
    .map((agent) => ({ id: agent.id, label: agent.name }));
}

/**
 * This device's provider connections as choices, "label (provider)", in
 * the list's order. An agent has no provider of its own, so every
 * connection of this device is offered; the agent still needs
 * `provider.use` on it before the run starts. null while the list is not
 * known.
 */
export function runConnections(
  list: ProviderConnectionListView | undefined,
): readonly RunChoice[] | null {
  if (
    list === undefined ||
    list.status === "loading" ||
    list.status === "signed_out"
  ) {
    return null;
  }
  return list.connections.map((connection) => ({
    id: connection.id,
    label: `${connection.label} (${PROVIDER_KIND_NAMES[connection.kind]})`,
  }));
}

/** What the person did so far; the screen's controller keeps it. */
export interface RunRequestState {
  /** The message whose form is open, or null. */
  readonly messageId: string | null;
  /** The agent and the connection chosen; null for the first offered. */
  readonly agentId: string | null;
  readonly connectionId: string | null;
  /** The choice, then the separate confirmation. */
  readonly step: "choose" | "confirm";
  /** A request waits for its answer; nothing else can be sent. */
  readonly sending: boolean;
  /** The sentence after the last answer, or undefined. */
  readonly notice: string | undefined;
  /** The message whose "Run with agent" the focus goes back to, or null. */
  readonly returnFocusTo: string | null;
  /**
   * Where the focus goes after this state: the message's "Run with agent"
   * after a cancel, the sentence after an answer, or nowhere.
   */
  readonly focus: "trigger" | "notice" | null;
}

export const IDLE_RUN_REQUEST: RunRequestState = Object.freeze({
  messageId: null,
  agentId: null,
  connectionId: null,
  step: "choose",
  sending: false,
  notice: undefined,
  returnFocusTo: null,
  focus: null,
});

/** What the open form shows. */
export interface RunFormModel {
  readonly messageId: string;
  readonly step: "choose" | "confirm";
  readonly sending: boolean;
  readonly agents: readonly RunChoice[];
  readonly connections: readonly RunChoice[];
  /** The chosen agent and connection, or null while there is none. */
  readonly agentId: string | null;
  readonly connectionId: string | null;
  /** Why nothing can be requested now, or undefined. */
  readonly problem: string | undefined;
  /** Whether "Continue" goes on to the confirmation. */
  readonly canContinue: boolean;
  /** The chosen agent's and connection's texts, for the confirmation. */
  readonly agentLabel: string;
  readonly connectionLabel: string;
}

/** The chosen ID, if it is still offered, else the first offered one. */
function chosen(
  choices: readonly RunChoice[] | null,
  id: string | null,
): RunChoice | null {
  if (choices === null || choices.length === 0) {
    return null;
  }
  return choices.find((choice) => choice.id === id) ?? choices[0] ?? null;
}

/**
 * The open form for `state`, or null when none is open or its message is
 * no longer one of the person's own shown messages. The first agent and
 * the first connection are chosen until the person chooses another.
 */
export function describeRunForm(
  state: RunRequestState,
  messages: readonly ChatMessageView[],
  activity: AgentActivityView | undefined,
  connectionList: ProviderConnectionListView | undefined,
  projectId: string,
): RunFormModel | null {
  const { messageId } = state;
  if (
    messageId === null ||
    !messages.some((message) => message.id === messageId && canRunWith(message))
  ) {
    return null;
  }
  const agents = runnableAgents(activity, projectId);
  const connections = runConnections(connectionList);
  const agent = chosen(agents, state.agentId);
  const connection = chosen(connections, state.connectionId);
  let problem: string | undefined;
  if (agents === null) {
    problem = RUN_REQUEST_MESSAGES.agentsPending;
  } else if (agents.length === 0) {
    // An activity that could not be read offers what it read before; with
    // nothing read, it says so rather than that no agent can run.
    problem =
      activity?.status === "unavailable" && activity.agents.length === 0
        ? RUN_REQUEST_MESSAGES.agentsUnavailable
        : RUN_REQUEST_MESSAGES.noAgents;
  } else if (connections === null) {
    problem =
      connectionList?.status === "signed_out"
        ? RUN_REQUEST_MESSAGES.connectionsSignedOut
        : RUN_REQUEST_MESSAGES.connectionsPending;
  } else if (connections.length === 0) {
    problem = RUN_REQUEST_MESSAGES.noConnections;
  }
  const ready = problem === undefined && agent !== null && connection !== null;
  // A confirmation shows only the agent and the connection that the person
  // chose: when either is no longer offered, it goes back to the choice
  // rather than confirm another one.
  const confirmable =
    ready &&
    state.step === "confirm" &&
    agent.id === state.agentId &&
    connection.id === state.connectionId;
  return {
    messageId,
    step: confirmable ? "confirm" : "choose",
    sending: state.sending,
    agents: agents ?? [],
    connections: connections ?? [],
    agentId: agent?.id ?? null,
    connectionId: connection?.id ?? null,
    problem,
    canContinue: ready && !state.sending,
    agentLabel: agent?.label ?? "",
    connectionLabel: connection?.label ?? "",
  };
}

/**
 * Whether a message offers "Run with agent": only the person's own
 * message, which the main process marks `writtenByMe`.
 */
export function canRunWith(message: ChatMessageView): boolean {
  return message.writtenByMe && message.authorKind === "member";
}

/** Opens the form of a message; another open form closes. */
export function openRunForm(
  state: RunRequestState,
  messageId: string,
): RunRequestState {
  if (state.sending) {
    return state;
  }
  return {
    ...IDLE_RUN_REQUEST,
    messageId,
    notice: state.notice,
  };
}

export function chooseRunAgent(
  state: RunRequestState,
  agentId: string,
): RunRequestState {
  return state.sending ? state : { ...state, agentId, step: "choose" };
}

export function chooseRunConnection(
  state: RunRequestState,
  connectionId: string,
): RunRequestState {
  return state.sending ? state : { ...state, connectionId, step: "choose" };
}

/** Goes on to the confirmation when the form is ready. */
export function continueRunForm(
  state: RunRequestState,
  model: RunFormModel | null,
): RunRequestState {
  if (model === null || !model.canContinue || state.sending) {
    return state;
  }
  return {
    ...state,
    agentId: model.agentId,
    connectionId: model.connectionId,
    step: "confirm",
  };
}

/**
 * Cancel, decided by the step that `model` shows: from a shown
 * confirmation back to the choice, and from the choice, also one that a
 * confirmation fell back to, the form closes.
 */
export function cancelRunForm(
  state: RunRequestState,
  model: RunFormModel | null,
): RunRequestState {
  if (state.sending || state.messageId === null) {
    return state;
  }
  if (model?.step === "confirm") {
    return { ...state, step: "choose" };
  }
  return closeRunForm(state);
}

/**
 * The message's "Run with agent" on an open form: the form closes from
 * either step, and the focus goes back to that action.
 */
export function closeRunForm(state: RunRequestState): RunRequestState {
  if (state.sending || state.messageId === null) {
    return state;
  }
  return {
    ...IDLE_RUN_REQUEST,
    notice: state.notice,
    returnFocusTo: state.messageId,
    focus: "trigger",
  };
}

/**
 * The request that the confirmation of `model` sends, or null when it
 * sends nothing: no confirmation shown, a request waiting, or a choice
 * missing.
 */
export function confirmedRunRequest(
  state: RunRequestState,
  model: RunFormModel | null,
  projectId: string,
): RunRequestView | null {
  if (
    model === null ||
    state.sending ||
    model.step !== "confirm" ||
    model.agentId === null ||
    model.connectionId === null
  ) {
    return null;
  }
  return {
    projectId,
    agentId: model.agentId,
    providerConnectionId: model.connectionId,
    inputMessageId: model.messageId,
  };
}

/**
 * The state after the main process's kept outcome arrived as the screen
 * opened: its sentence shows, and the focus stays where it is. While a
 * request of this screen waits, its own answer will say more.
 */
export function showKeptRunOutcome(
  state: RunRequestState,
  outcome: RunRequestOutcome,
): RunRequestState {
  return state.sending
    ? state
    : { ...state, notice: describeRunResult(outcome), focus: null };
}

/** The state after an answer: the form closes and the sentence shows. */
export function finishRunRequest(
  state: RunRequestState,
  notice: string,
): RunRequestState {
  return {
    ...IDLE_RUN_REQUEST,
    notice,
    returnFocusTo: state.messageId,
    focus: "notice",
  };
}

/** The run request part of the chat screen, apart from React. */
export interface RunRequestController {
  readonly open: (messageId: string) => void;
  readonly chooseAgent: (agentId: string) => void;
  readonly chooseConnection: (connectionId: string) => void;
  readonly continue: (model: RunFormModel | null) => void;
  /** Cancel of the shown step (`cancelRunForm`). */
  readonly cancel: (model: RunFormModel | null) => void;
  /** The message's "Run with agent" on an open form (`closeRunForm`). */
  readonly close: () => void;
  /** Sends the confirmed request once; nothing while one waits. */
  readonly confirm: (model: RunFormModel | null) => void;
  /**
   * Starts applying answers, and the first time takes the outcome that the
   * main process kept for the project. The result stops it: answers that
   * arrive while it is stopped change nothing. It can start again, as
   * React's development mode does with an effect.
   */
  readonly start: () => () => void;
}

/**
 * The logic of the run request of the project `projectId`, which the chat
 * screen's hook drives.
 *
 * - The request goes to the main process only from the confirmation, once:
 *   while it waits, every other action changes nothing, and nothing is
 *   ever sent again on its own, also not after `unknown` or a rejected
 *   call, which may have reached the server too.
 * - Every answer closes the form and shows one sentence; the focus goes
 *   back to the message's action. An answer that the screen showed is
 *   then taken from the main process, so that it does not show again when
 *   the screen opens later; an answer that came while the controller was
 *   stopped stays there for the next screen.
 * - The first start takes the outcome that the main process kept for the
 *   project, and shows its sentence once.
 */
export function createRunRequestController(
  agents: Pick<AgentBridge, "requestRun" | "takeRunRequestOutcome">,
  projectId: string,
  onState: (state: RunRequestState) => void,
  initial: RunRequestState = IDLE_RUN_REQUEST,
): RunRequestController {
  let state = initial;
  let active = false;
  let taken = false;
  const set = (next: RunRequestState) => {
    if (next !== state) {
      state = next;
      onState(next);
    }
  };
  /** Takes the kept outcome; `show` decides what becomes of it. */
  const take = (show: (outcome: RunRequestOutcome) => void) => {
    agents.takeRunRequestOutcome(projectId).then(
      (outcome) => {
        if (outcome !== null) {
          show(outcome);
        }
      },
      () => {
        // Nothing kept can be shown; the screen stays as it is.
      },
    );
  };
  return Object.freeze({
    open: (messageId: string) => set(openRunForm(state, messageId)),
    chooseAgent: (agentId: string) => set(chooseRunAgent(state, agentId)),
    chooseConnection: (connectionId: string) =>
      set(chooseRunConnection(state, connectionId)),
    continue: (model: RunFormModel | null) =>
      set(continueRunForm(state, model)),
    cancel: (model: RunFormModel | null) => set(cancelRunForm(state, model)),
    close: () => set(closeRunForm(state)),
    confirm: (model: RunFormModel | null) => {
      const request = confirmedRunRequest(state, model, projectId);
      if (request === null) {
        return;
      }
      set({ ...state, sending: true, notice: undefined, focus: null });
      agents.requestRun(request).then(
        (result) => {
          if (!active) {
            return;
          }
          set(finishRunRequest(state, describeRunResult(result)));
          // The main process kept what passed its checks; the screen
          // showed it, so it is taken and dropped.
          if (
            result.outcome !== "refused" ||
            !RUN_REQUEST_LOCAL_REFUSALS.has(result.reason)
          ) {
            take(() => undefined);
          }
        },
        () => {
          // A rejected call may have reached the main process and the
          // server: whether the run was created is not known.
          if (active) {
            set(finishRunRequest(state, RUN_REQUEST_MESSAGES.unknown));
          }
        },
      );
    },
    start: () => {
      active = true;
      if (!taken) {
        taken = true;
        take((outcome) => {
          if (active) {
            set(showKeptRunOutcome(state, outcome));
          }
        });
      }
      return () => {
        active = false;
      };
    },
  });
}
