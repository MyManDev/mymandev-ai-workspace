// The chat service (#27): the chat of the open project in the main process.
// It holds the project's chat timeline (timeline.ts), loads the history with
// the account service's `readWorkspaceData`, applies the project's
// `chat.message.created` events, and sends the person's messages with the
// connection client's `sendAs`, the only way to send an event.
//
// - The newest page loads when a project opens and after every
//   `workspace.subscribed` of the selected workspace, through the service's
//   own resync gate; the events that arrive meanwhile apply after it. A
//   failed load is retried with the workspace service's backoff. Older pages
//   load on request.
// - A message that cannot be sent at once waits in memory, and is sent again
//   automatically with the same event ID while the workspace service's
//   `gateLive` holds for its workspace, at most one per second. After
//   `rate_limited` a message is tried again 10 seconds later, up to 3 tries
//   in all; it then shows as not sent, like a message refused with
//   `not_found` or `conflict`, and the person can retry it (the Project
//   Manager's decisions of 2026-11-05 on #27).
// - The messages that wait belong to the account, the device, the workspace,
//   and the project. They are dropped without asking on a sign-out, on a
//   change of the account or the device, when the membership ends, and
//   whenever the workspace service selects another workspace or opens
//   another project. A switch that the person asks for goes through
//   `switchProject` and `selectWorkspace`, which ask first.
//
// Nothing is written to disk, and nothing goes to the renderer: the IPC of
// part 14 reads `state()`. The logs are fixed text with a failure code at
// most, never a name, an ID, or a message body.
import {
  newId,
  PROTOCOL_VERSION,
  type ChatHistoryResponse,
  type ChatMessage,
  type ChatMessageAuthor,
  type ChatMessageCreatedEvent,
  type EventId,
  type EventRefusalCode,
  type EventRefusedFrame,
  type ProjectId,
  type ReceivedServerEvent,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { AccountStatus } from "../../shared/ipc-contract.ts";
import type { AccountService } from "../account.ts";
import {
  MESSAGE_PAGE_LIMIT,
  type WorkspaceReadFailure,
  type WorkspaceReadResult,
} from "../api-reads.ts";
import type {
  ConnectionClient,
  ConnectionIdentity,
  ServerMessage,
} from "../connection/client.ts";
import type { ScheduleTimer } from "../runtime.ts";
import { createResyncGate } from "../workspace/resync.ts";
import {
  workspaceRetryDelayMs,
  type WorkspaceService,
} from "../workspace/service.ts";
import {
  addPending,
  applyCreated,
  applyNewestPage,
  applyOlderPage,
  applyRefused,
  createChatTimeline,
  discardPending,
  markPending,
  olderPageQuery,
  pendingForResend,
  prepareMessageBody,
  sameTimelineKey,
  type ChatPageQuery,
  type ChatTimeline,
  type ChatTimelineKey,
  type MessageBodyProblem,
  type OlderChatPageQuery,
  type PendingChatMessage,
} from "./timeline.ts";

/**
 * How many times a message is tried while the server answers
 * `rate_limited`, the first send included; after the last refusal it shows
 * as not sent.
 */
export const CHAT_RATE_LIMITED_TRIES = 3;
/** The wait before a message is tried again after `rate_limited`. */
export const CHAT_RATE_LIMITED_RETRY_MS = 10_000;
/** The shortest time between two automatic sends of waiting messages. */
export const CHAT_RESEND_INTERVAL_MS = 1_000;

/**
 * The name shown for an agent that wrote a message. Agent names come with
 * the agent service (#28); until then every agent shows this text.
 */
export const UNKNOWN_AGENT_NAME = "Unknown agent";

/**
 * - `no_project`: no open project, or no signed-in device; the state is
 *   empty.
 * - `loading`: the newest page has not loaded yet for the open project.
 * - `ready`: the newest page loaded. It stays `ready` during later reloads.
 * - `unavailable`: the last load of the newest page failed; `problem` holds
 *   the failure. What was loaded before stays.
 */
export type ChatServiceStatus =
  "no_project" | "loading" | "ready" | "unavailable";

/**
 * Why a message shows as not sent: the code of `event.refused`, or
 * `not_sendable` when the connection client refused to send it
 * (`too_large` or `invalid`).
 */
export type ChatNotSentReason = EventRefusalCode | "not_sendable";

/**
 * One of the person's messages that the server has not stored yet.
 * `waiting`: it waits for the connection, or for its next try after
 * `rate_limited`. `sending`: it was sent and waits for the server.
 * `not_sent`: it is sent again only through `retry`.
 */
export type ChatPendingCopy =
  | {
      readonly eventId: EventId;
      readonly body: string;
      readonly status: "waiting" | "sending";
    }
  | {
      readonly eventId: EventId;
      readonly body: string;
      readonly status: "not_sent";
      readonly reason: ChatNotSentReason;
    };

/** The service's state. Every value is frozen. */
export interface ChatState {
  /** Grows by one with every change. */
  readonly revision: number;
  readonly status: ChatServiceStatus;
  /** Only with `unavailable`. */
  readonly problem?: WorkspaceReadFailure;
  /** The workspace and the project of the chat, or null with `no_project`. */
  readonly workspaceId: WorkspaceId | null;
  readonly projectId: ProjectId | null;
  /** The held messages, the oldest first, each once. */
  readonly messages: readonly ChatMessage[];
  /** Whether `loadOlder` can load messages older than the held ones. */
  readonly hasOlder: boolean;
  /** Whether an older page is on its way. */
  readonly loadingOlder: boolean;
  /** Why the last older page did not load, until the next one is asked for. */
  readonly olderProblem?: WorkspaceReadFailure;
  /** The person's messages that the server has not stored, in order. */
  readonly pending: readonly ChatPendingCopy[];
}

export type ChatSendResult =
  | { readonly kind: "accepted"; readonly eventId: EventId }
  | {
      readonly kind: "refused";
      readonly reason: MessageBodyProblem | "too_many_pending" | "no_project";
    };

/**
 * `started`: an older page is on its way. `busy`: one already is. `none`:
 * there is nothing older to load, or the newest page has not loaded.
 */
export type ChatLoadOlderResult = "started" | "busy" | "none";

/**
 * `switched`: the workspace service took the switch, or nothing had to
 * change. `waiting`: `count` messages have not been stored yet, and nothing
 * changed; the caller asks the person and calls again with
 * `discardWaiting`. `refused`: the workspace service does not hold the
 * project or the workspace, or no device is signed in.
 */
export type ChatSwitchResult =
  | { readonly kind: "switched" }
  | { readonly kind: "waiting"; readonly count: number }
  | { readonly kind: "refused" };

export interface ChatSwitchOptions {
  /** Drop the messages that have not been stored, without asking. */
  readonly discardWaiting: boolean;
}

/** The part of the account service that the chat service uses. */
export type ChatAccount = Pick<
  AccountService,
  "status" | "onStatusChange" | "readWorkspaceData"
>;

/** The part of the connection client that the chat service uses. */
export type ChatConnection = Pick<
  ConnectionClient,
  "status" | "onStatusChange" | "onMessage" | "sendAs" | "identity"
>;

/** The part of the workspace service that the chat service uses. */
export type ChatWorkspaces = Pick<
  WorkspaceService,
  | "state"
  | "onChange"
  | "select"
  | "openProject"
  | "selectedWorkspaceId"
  | "gateLive"
  | "memberName"
>;

export interface ChatServiceOptions {
  readonly account: ChatAccount;
  readonly connection: ChatConnection;
  readonly workspaces: ChatWorkspaces;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now?: () => number;
  /** The wall clock in milliseconds, for `occurredAt`; defaults to `Date.now`. */
  readonly wallClock?: () => number;
  /**
   * Receives fixed messages with a failure code at most, never a name, an
   * ID, or a message body. An error that it throws is ignored.
   */
  readonly log?: (message: string) => void;
}

export interface ChatService {
  /** The current state. */
  readonly state: () => ChatState;
  /** Calls `listener` after every change. The result removes the listener. */
  readonly onChange: (listener: (state: ChatState) => void) => () => void;
  /**
   * Sends a message to the open project's chat. The text becomes a body
   * with `prepareMessageBody`. An accepted message is sent at once when it
   * can be, and otherwise waits. Refused, and nothing is kept, without an
   * open project, for a body that the protocol refuses, and while
   * `MAX_PENDING_CHAT_MESSAGES` (50) messages have not been stored.
   */
  readonly send: (text: string) => ChatSendResult;
  /**
   * Tries a message that shows as not sent again, with the same event ID
   * and three new tries after `rate_limited`. False for any other message.
   */
  readonly retry: (eventId: EventId) => boolean;
  /**
   * Drops a message that waits or shows as not sent. False for a message
   * that is being sent, and for an unknown one.
   */
  readonly discard: (eventId: EventId) => boolean;
  /** Loads the page of messages older than the held ones. */
  readonly loadOlder: () => ChatLoadOlderResult;
  /**
   * The name shown for a message's author: the person's display name from
   * the workspace service, or `UNKNOWN_AGENT_NAME` for an agent.
   */
  readonly authorName: (author: ChatMessageAuthor) => string;
  /**
   * Opens a project of the selected workspace, or closes the open one with
   * null. Every switch that the person asks for goes through this wrapper,
   * never through the workspace service's `openProject`, so that the person
   * is asked before waiting messages are dropped.
   */
  readonly switchProject: (
    projectId: ProjectId | null,
    options: ChatSwitchOptions,
  ) => ChatSwitchResult;
  /**
   * Selects a workspace of the list, as `switchProject` does for a
   * project; never call the workspace service's `select` for the person.
   */
  readonly selectWorkspace: (
    workspaceId: WorkspaceId,
    options: ChatSwitchOptions,
  ) => ChatSwitchResult;
  /** Stops listening and cancels the timers, for the quit. */
  readonly close: () => void;
}

/** What the service keeps for each pending copy, besides the timeline. */
interface CopyEntry {
  /** The time of the person's send, kept for every try. */
  readonly occurredAt: string;
  /** How many tries the server refused with `rate_limited`. */
  rateLimited: number;
  /** The monotonic time before which it is not tried again, or null. */
  retryAt: number | null;
  /** The connection client refused to send it. */
  notSendable: boolean;
}

/** An older page on its way. */
interface OlderRequest {
  readonly epoch: number;
  readonly generation: number;
  readonly projectId: ProjectId;
  readonly query: OlderChatPageQuery;
}

/**
 * The signed-in device, or null: the same condition under which the
 * connection client connects. Compared only; it never reaches the state or
 * a log.
 */
function signedInDevice(status: AccountStatus): string | null {
  if (
    status.apiOrigin === "set" &&
    status.device === "signed_in" &&
    status.deviceKey === "ready" &&
    status.account.kind === "signed_in"
  ) {
    return status.account.deviceId;
  }
  return null;
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

const NO_MESSAGES: readonly ChatMessage[] = Object.freeze([]);
const NO_PENDING: readonly ChatPendingCopy[] = Object.freeze([]);
const PAGE_QUERY: ChatPageQuery = Object.freeze({ limit: MESSAGE_PAGE_LIMIT });
const SWITCHED: ChatSwitchResult = Object.freeze({ kind: "switched" });
const SWITCH_REFUSED: ChatSwitchResult = Object.freeze({ kind: "refused" });

export function createChatService(options: ChatServiceOptions): ChatService {
  const { account, connection, workspaces } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const now = options.now ?? (() => performance.now());
  const wallClock = options.wallClock ?? (() => Date.now());

  function log(message: string): void {
    try {
      options.log?.(message);
    } catch {
      // A failing log changes nothing.
    }
  }

  let closed = false;
  /** The signed-in device, compared only; see `signedInDevice`. */
  let device: string | null = null;
  /**
   * The account and device of the connection's last `auth.ok` for that
   * device. Kept while the connection is down, so that messages can wait
   * under their key; never logged and never in the state.
   */
  let identity: ConnectionIdentity | null = null;
  /** Changes with every reset, so that an answer for an earlier device is dropped. */
  let epoch = 0;
  let connected = false;
  /** The workspace whose subscription the gate follows. */
  let selected: WorkspaceId | null = null;

  const gate = createResyncGate<ChatMessageCreatedEvent>({
    sizeOf: (event) => Buffer.byteLength(JSON.stringify(event), "utf8"),
  });
  let timeline: ChatTimeline | null = null;
  const copies = new Map<EventId, CopyEntry>();
  let problem: WorkspaceReadFailure | null = null;
  let reloadAttempt = 0;
  let cancelReloadRetry: (() => void) | null = null;
  /** Events were dropped after an overflow, `chat.message.created` included. */
  let eventsLost = false;
  let older: OlderRequest | null = null;
  let olderProblem: WorkspaceReadFailure | null = null;
  let lastSendAt: number | null = null;
  let cancelPump: (() => void) | null = null;

  let revision = 0;
  let dirty = false;
  let current = buildState();
  const listeners = new Set<(state: ChatState) => void>();

  function pendingCopy(copy: PendingChatMessage): ChatPendingCopy {
    if (copy.state === "refused") {
      return Object.freeze({
        eventId: copy.eventId,
        body: copy.body,
        status: "not_sent",
        reason: copy.code,
      });
    }
    if (copies.get(copy.eventId)?.notSendable === true) {
      return Object.freeze({
        eventId: copy.eventId,
        body: copy.body,
        status: "not_sent",
        reason: "not_sendable",
      });
    }
    return Object.freeze({
      eventId: copy.eventId,
      body: copy.body,
      status: copy.state,
    });
  }

  function buildState(): ChatState {
    if (timeline === null) {
      return Object.freeze({
        revision,
        status: "no_project",
        workspaceId: null,
        projectId: null,
        messages: NO_MESSAGES,
        hasOlder: false,
        loadingOlder: false,
        pending: NO_PENDING,
      });
    }
    const status: ChatServiceStatus =
      problem !== null ? "unavailable" : timeline.loaded ? "ready" : "loading";
    return Object.freeze({
      revision,
      status,
      ...(problem === null ? {} : { problem }),
      workspaceId: timeline.key.workspaceId,
      projectId: timeline.key.projectId,
      messages: timeline.messages,
      hasOlder: timeline.hasOlder,
      loadingOlder: older !== null,
      ...(olderProblem === null ? {} : { olderProblem }),
      pending: Object.freeze(timeline.pending.map(pendingCopy)),
    });
  }

  function touch(): void {
    dirty = true;
  }

  function flush(): void {
    if (!dirty || closed) {
      return;
    }
    dirty = false;
    revision += 1;
    const state = buildState();
    current = state;
    for (const listener of [...listeners]) {
      // A listener that changed the state again has notified everyone of
      // the newer state already.
      if (current !== state) {
        return;
      }
      try {
        listener(state);
      } catch {
        log("A chat state listener failed.");
      }
    }
  }

  /** Runs one entry point and then publishes what it changed. */
  function run<T>(action: () => T): T {
    try {
      return action();
    } finally {
      flush();
    }
  }

  /** Replaces the timeline and forgets the entries of copies that left it. */
  function setTimeline(next: ChatTimeline): void {
    if (next === timeline) {
      return;
    }
    timeline = next;
    for (const eventId of [...copies.keys()]) {
      if (!next.pending.some((copy) => copy.eventId === eventId)) {
        copies.delete(eventId);
      }
    }
    touch();
  }

  function stopReloadRetry(): void {
    cancelReloadRetry?.();
    cancelReloadRetry = null;
  }

  function stopPump(): void {
    cancelPump?.();
    cancelPump = null;
  }

  /** Drops the timeline with its messages and pending copies. */
  function dropTimeline(): void {
    stopReloadRetry();
    stopPump();
    timeline = null;
    copies.clear();
    problem = null;
    reloadAttempt = 0;
    eventsLost = false;
    older = null;
    olderProblem = null;
    touch();
  }

  /** Drops the pending copies and keeps the messages. */
  function dropPending(): void {
    if (timeline === null || timeline.pending.length === 0) {
      return;
    }
    let next = timeline;
    for (const copy of timeline.pending) {
      next = discardPending(next, copy.eventId);
    }
    stopPump();
    setTimeline(next);
  }

  /** The key of the chat that the service should hold now, or null. */
  function targetKey(): ChatTimelineKey | null {
    if (device === null || identity === null || identity.deviceId !== device) {
      return null;
    }
    const state = workspaces.state();
    if (state.selectedWorkspaceId === null || state.openProjectId === null) {
      return null;
    }
    return {
      userId: identity.userId,
      deviceId: identity.deviceId,
      workspaceId: state.selectedWorkspaceId,
      projectId: state.openProjectId,
    };
  }

  /**
   * Follows the workspace service: another selected workspace ends the
   * gate, and another key replaces the timeline, without asking, and loads
   * the newest page of the new one.
   */
  function sync(): void {
    if (closed) {
      return;
    }
    const workspaceId = workspaces.selectedWorkspaceId();
    if (workspaceId !== selected) {
      selected = workspaceId;
      gate.end();
      stopReloadRetry();
    }
    const key = targetKey();
    if (timeline === null && key === null) {
      return;
    }
    if (
      timeline !== null &&
      key !== null &&
      sameTimelineKey(timeline.key, key)
    ) {
      return;
    }
    dropTimeline();
    if (key !== null) {
      timeline = createChatTimeline(key);
      startReload(gate.begin("all").generation);
    }
  }

  /** Reads the connection's identity once it is authenticated for `device`. */
  function learnIdentity(): void {
    const next = connection.identity();
    if (next === null || device === null || next.deviceId !== device) {
      return;
    }
    identity = next;
  }

  // The newest page.

  function startReload(generation: number): void {
    if (timeline === null) {
      return;
    }
    stopReloadRetry();
    const at = epoch;
    const { projectId } = timeline.key;
    account.readWorkspaceData("listMessages", { projectId }, PAGE_QUERY).then(
      (result) => run(() => reloadAnswered(at, projectId, generation, result)),
      () =>
        run(() =>
          reloadAnswered(at, projectId, generation, {
            ok: false,
            reason: "unavailable",
          }),
        ),
    );
  }

  function reloadAnswered(
    at: number,
    projectId: ProjectId,
    generation: number,
    result: WorkspaceReadResult<ChatHistoryResponse>,
  ): void {
    if (
      closed ||
      at !== epoch ||
      timeline === null ||
      timeline.key.projectId !== projectId
    ) {
      return;
    }
    const outcome = result.ok
      ? applyNewestPage(timeline, PAGE_QUERY, result.value)
      : null;
    if (outcome === null || outcome.kind !== "applied") {
      const reason = result.ok ? "failed" : result.reason;
      if (!gate.reloadFailed(generation)) {
        return;
      }
      problem = reason;
      touch();
      log(`The chat history did not load (${reason}).`);
      scheduleReload(workspaceRetryDelayMs(reloadAttempt, reason));
      reloadAttempt += 1;
      return;
    }
    const events = gate.reloaded(generation);
    if (events === null) {
      return;
    }
    let next = outcome.timeline;
    for (const event of events) {
      next = applyCreated(next, event);
    }
    if (eventsLost) {
      // The `chat.message.created` of a message that was sent may have been
      // dropped: it is sent again with its event ID, and the server answers
      // a repeat with the stored message.
      eventsLost = false;
      for (const copy of next.pending) {
        if (copy.state === "sending") {
          next = markPending(next, copy.eventId, "waiting");
        }
      }
    }
    setTimeline(next);
    problem = null;
    reloadAttempt = 0;
    touch();
    pump();
  }

  /** Begins a reload after `delayMs`, unless the project changed. */
  function scheduleReload(delayMs: number): void {
    stopReloadRetry();
    const projectId = timeline?.key.projectId;
    cancelReloadRetry = schedule(() => {
      run(() => {
        cancelReloadRetry = null;
        const state = gate.state();
        if (
          timeline !== null &&
          timeline.key.projectId === projectId &&
          (state === "failed" || state === "overflowed")
        ) {
          startReload(gate.begin("all").generation);
        }
      });
    }, delayMs);
  }

  // Older pages.

  function loadOlder(): ChatLoadOlderResult {
    if (closed || timeline === null) {
      return "none";
    }
    if (older !== null) {
      return "busy";
    }
    const query = olderPageQuery(timeline, MESSAGE_PAGE_LIMIT);
    if (query === null) {
      return "none";
    }
    const request: OlderRequest = Object.freeze({
      epoch,
      generation: gate.generation(),
      projectId: timeline.key.projectId,
      query,
    });
    older = request;
    olderProblem = null;
    touch();
    account
      .readWorkspaceData(
        "listMessages",
        { projectId: request.projectId },
        { beforeSeq: query.beforeSeq, limit: query.limit },
      )
      .then(
        (result) => run(() => olderAnswered(request, result)),
        () =>
          run(() =>
            olderAnswered(request, { ok: false, reason: "unavailable" }),
          ),
      );
    return "started";
  }

  function olderAnswered(
    request: OlderRequest,
    result: WorkspaceReadResult<ChatHistoryResponse>,
  ): void {
    if (closed || older !== request) {
      return;
    }
    older = null;
    touch();
    if (
      request.epoch !== epoch ||
      timeline === null ||
      timeline.key.projectId !== request.projectId ||
      gate.generation() !== request.generation
    ) {
      // A reload began, or the project changed, after it was asked for.
      return;
    }
    if (!result.ok) {
      olderProblem = result.reason;
      log(`An older chat page did not load (${result.reason}).`);
      return;
    }
    const outcome = applyOlderPage(timeline, request.query, result.value);
    if (outcome.kind === "applied") {
      setTimeline(outcome.timeline);
    } else if (outcome.kind === "invalid") {
      olderProblem = "failed";
      log("An older chat page did not load (failed).");
    }
  }

  // Sending.

  /** Whether a message can go out now. */
  function canSend(): boolean {
    return (
      !closed &&
      timeline !== null &&
      identity !== null &&
      workspaces.gateLive(timeline.key.workspaceId)
    );
  }

  /** The waiting copies that a try may send, in order. */
  function sendable(): readonly PendingChatMessage[] {
    if (timeline === null) {
      return [];
    }
    return pendingForResend(timeline, timeline.key).filter(
      (copy) => copies.get(copy.eventId)?.notSendable !== true,
    );
  }

  /**
   * Sends one copy with `sendAs`. False when the identity of the connection
   * is not the timeline's, so that nothing more is sent until it changes.
   */
  function sendCopy(copy: PendingChatMessage): boolean {
    const held = timeline;
    const entry = copies.get(copy.eventId);
    if (held === null || entry === undefined) {
      return false;
    }
    const { key } = held;
    let mismatch = false;
    const outcome = connection.sendAs((who) => {
      if (who.userId !== key.userId || who.deviceId !== key.deviceId) {
        mismatch = true;
        throw new Error("The connection belongs to another account or device.");
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        id: copy.eventId,
        occurredAt: entry.occurredAt,
        workspaceId: key.workspaceId,
        actor: { kind: "user", userId: who.userId },
        deviceId: who.deviceId,
        type: "chat.message.send",
        payload: { projectId: key.projectId, body: copy.body },
      };
    });
    lastSendAt = now();
    if (mismatch) {
      // Another account or device: its messages never go out under it.
      learnIdentity();
      sync();
      return false;
    }
    switch (outcome) {
      case "sent":
        entry.retryAt = null;
        if (timeline !== null) {
          setTimeline(markPending(timeline, copy.eventId, "sending"));
        }
        return true;
      case "not_connected":
      case "backpressure":
        // It keeps waiting, for the next try.
        return true;
      case "too_large":
      case "invalid":
        entry.notSendable = true;
        touch();
        log(`A chat message could not be sent (${outcome}).`);
        return true;
    }
  }

  /**
   * Sends the next waiting copy whose time has come, at most one each
   * `CHAT_RESEND_INTERVAL_MS`, and schedules the next try.
   */
  function pump(): void {
    stopPump();
    if (!canSend()) {
      return;
    }
    const ready = sendable();
    if (ready.length === 0) {
      return;
    }
    const at = now();
    const due = ready.find(
      (copy) => (copies.get(copy.eventId)?.retryAt ?? at) <= at,
    );
    if (due === undefined) {
      const next = Math.min(
        ...ready.map((copy) => copies.get(copy.eventId)?.retryAt ?? at),
      );
      schedulePump(next - at);
      return;
    }
    const wait =
      lastSendAt === null ? 0 : lastSendAt + CHAT_RESEND_INTERVAL_MS - at;
    if (wait > 0) {
      schedulePump(wait);
      return;
    }
    if (sendCopy(due)) {
      scheduleNext();
    }
  }

  /** Tries again after the interval while a message still waits. */
  function scheduleNext(): void {
    if (sendable().length > 0) {
      schedulePump(CHAT_RESEND_INTERVAL_MS);
    }
  }

  function schedulePump(delayMs: number): void {
    stopPump();
    cancelPump = schedule(() => {
      run(() => {
        cancelPump = null;
        pump();
      });
    }, delayMs);
  }

  function send(text: string): ChatSendResult {
    if (closed || timeline === null) {
      return Object.freeze({ kind: "refused", reason: "no_project" });
    }
    const prepared = prepareMessageBody(text);
    if (prepared.kind === "refused") {
      return Object.freeze({ kind: "refused", reason: prepared.reason });
    }
    // A new message goes out at once unless others wait before it.
    const first = sendable().length === 0;
    const eventId = newId<EventId>();
    const added = addPending(timeline, eventId, prepared.body);
    if (added.kind === "refused") {
      // A new event ID repeats none, so only the limit refuses it.
      return Object.freeze({ kind: "refused", reason: "too_many_pending" });
    }
    copies.set(eventId, {
      occurredAt: new Date(wallClock()).toISOString(),
      rateLimited: 0,
      retryAt: null,
      notSendable: false,
    });
    setTimeline(added.timeline);
    const copy = added.timeline.pending.at(-1);
    if (first && copy !== undefined && canSend()) {
      if (sendCopy(copy)) {
        scheduleNext();
      }
    } else {
      pump();
    }
    return Object.freeze({ kind: "accepted", eventId });
  }

  function retry(eventId: EventId): boolean {
    const copy = timeline?.pending.find((held) => held.eventId === eventId);
    const entry = copies.get(eventId);
    if (
      closed ||
      timeline === null ||
      copy === undefined ||
      entry === undefined ||
      (copy.state !== "refused" && !entry.notSendable)
    ) {
      return false;
    }
    entry.rateLimited = 0;
    entry.retryAt = null;
    entry.notSendable = false;
    setTimeline(markPending(timeline, eventId, "waiting"));
    touch();
    pump();
    return true;
  }

  function discard(eventId: EventId): boolean {
    const copy = timeline?.pending.find((held) => held.eventId === eventId);
    if (
      closed ||
      timeline === null ||
      copy === undefined ||
      copy.state === "sending"
    ) {
      return false;
    }
    setTimeline(discardPending(timeline, eventId));
    return true;
  }

  // The frames and events.

  function refused(frame: EventRefusedFrame): void {
    const entry = copies.get(frame.eventId);
    if (
      timeline === null ||
      entry === undefined ||
      !timeline.pending.some((copy) => copy.eventId === frame.eventId)
    ) {
      // Another service's event, or a copy that is gone.
      return;
    }
    log(`A chat message was refused (${frame.code}).`);
    if (frame.code === "rate_limited") {
      entry.rateLimited += 1;
      if (entry.rateLimited < CHAT_RATE_LIMITED_TRIES) {
        entry.retryAt = now() + CHAT_RATE_LIMITED_RETRY_MS;
        setTimeline(markPending(timeline, frame.eventId, "waiting"));
        pump();
        return;
      }
    }
    setTimeline(applyRefused(timeline, frame));
  }

  function eventReceived(event: ReceivedServerEvent): void {
    if (
      event.type !== "chat.message.created" ||
      timeline === null ||
      event.workspaceId !== timeline.key.workspaceId ||
      event.payload.message.projectId !== timeline.key.projectId
    ) {
      return;
    }
    switch (gate.push(event)) {
      case "apply":
        setTimeline(applyCreated(timeline, event));
        return;
      case "overflowed":
        eventsLost = true;
        log("Too many chat events waited; the chat reloads.");
        scheduleReload(workspaceRetryDelayMs(reloadAttempt, "unavailable"));
        reloadAttempt += 1;
        return;
      case "dropped":
      case "buffered":
      case "ignored":
        return;
    }
  }

  /** The membership of `workspaceId` ended: its messages are dropped. */
  function membershipEnded(workspaceId: WorkspaceId): void {
    if (timeline !== null && timeline.key.workspaceId === workspaceId) {
      dropPending();
    }
  }

  function messageReceived(message: ServerMessage): void {
    sync();
    if (device === null) {
      return;
    }
    if (message.kind === "event") {
      eventReceived(message.event);
      return;
    }
    const frame = message.frame;
    switch (frame.type) {
      case "workspace.subscribed":
        if (frame.workspaceId === selected) {
          // `startReload` loads only while a project is open.
          startReload(gate.subscribed());
        }
        return;
      case "workspace.unsubscribed":
        if (frame.reason === "membership_ended") {
          membershipEnded(frame.workspaceId);
        } else if (frame.workspaceId === selected) {
          gate.end();
          stopReloadRetry();
        }
        return;
      case "workspace.subscribe_refused":
      case "account.removed_from_workspace":
        membershipEnded(frame.workspaceId);
        return;
      case "event.refused":
        refused(frame);
        return;
      default:
        return;
    }
  }

  // The account and the connection.

  /** Forgets everything: a sign-out, or another device. */
  function reset(): void {
    epoch += 1;
    identity = null;
    lastSendAt = null;
    gate.end();
    dropTimeline();
  }

  function accountChanged(status: AccountStatus): void {
    const next = signedInDevice(status);
    if (next === device) {
      return;
    }
    if (device !== null) {
      reset();
    }
    device = next;
    if (connected) {
      learnIdentity();
    }
    sync();
  }

  function connectionChanged(state: string): void {
    const isConnected = state === "connected";
    if (isConnected === connected) {
      return;
    }
    connected = isConnected;
    if (!isConnected) {
      // A lost connection ends the subscription, and a message that was
      // sent waits again: its answer may never come.
      gate.end();
      stopReloadRetry();
      stopPump();
      if (timeline !== null) {
        let next = timeline;
        for (const copy of timeline.pending) {
          if (copy.state === "sending") {
            next = markPending(next, copy.eventId, "waiting");
          }
        }
        setTimeline(next);
      }
      return;
    }
    learnIdentity();
    sync();
  }

  function switchTo(
    unchanged: boolean,
    known: boolean,
    discardWaiting: boolean,
    apply: () => boolean,
  ): ChatSwitchResult {
    if (closed) {
      return SWITCH_REFUSED;
    }
    if (unchanged) {
      return apply() ? SWITCHED : SWITCH_REFUSED;
    }
    if (!known) {
      return SWITCH_REFUSED;
    }
    const count = timeline?.pending.length ?? 0;
    if (count > 0 && !discardWaiting) {
      return Object.freeze({ kind: "waiting", count });
    }
    dropPending();
    return apply() ? SWITCHED : SWITCH_REFUSED;
  }

  const removers = [
    account.onStatusChange((status) => run(() => accountChanged(status))),
    connection.onStatusChange((status) =>
      run(() => connectionChanged(status.state)),
    ),
    connection.onMessage((message) =>
      run(() => {
        messageReceived(message);
        pump();
      }),
    ),
    // `gateLive` and the open project change with the workspace state.
    workspaces.onChange(() =>
      run(() => {
        sync();
        pump();
      }),
    ),
  ];
  accountChanged(account.status());
  connectionChanged(connection.status().state);
  // The first state is revision 0.
  current = buildState();
  dirty = false;

  return Object.freeze({
    state: () => current,
    onChange: (listener: (state: ChatState) => void) => {
      const entry = (state: ChatState) => listener(state);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    send: (text: string) => run(() => send(text)),
    retry: (eventId: EventId) => run(() => retry(eventId)),
    discard: (eventId: EventId) => run(() => discard(eventId)),
    loadOlder: () => run(loadOlder),
    authorName: (author: ChatMessageAuthor) =>
      author.kind === "member"
        ? workspaces.memberName(author.memberId)
        : UNKNOWN_AGENT_NAME,
    switchProject: (
      projectId: ProjectId | null,
      switchOptions: ChatSwitchOptions,
    ) =>
      run(() => {
        const state = workspaces.state();
        return switchTo(
          projectId === state.openProjectId,
          projectId === null ||
            state.projects.some((project) => project.id === projectId),
          switchOptions.discardWaiting,
          () => workspaces.openProject(projectId),
        );
      }),
    selectWorkspace: (
      workspaceId: WorkspaceId,
      switchOptions: ChatSwitchOptions,
    ) =>
      run(() => {
        const state = workspaces.state();
        return switchTo(
          workspaceId === state.selectedWorkspaceId,
          state.workspaces.some((workspace) => workspace.id === workspaceId),
          switchOptions.discardWaiting,
          () => workspaces.select(workspaceId),
        );
      }),
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const remove of removers) {
        remove();
      }
      listeners.clear();
      stopReloadRetry();
      stopPump();
      gate.end();
    },
  });
}
