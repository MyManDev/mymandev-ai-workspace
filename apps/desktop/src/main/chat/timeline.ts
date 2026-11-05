// The chat timeline of one project (#27): the messages that the desktop
// holds, oldest first, and the person's own messages that the server has not
// stored yet. A pure model: no I/O, no timers, and no IPC. A later service
// of the main process loads the history, sends and resends the messages, and
// calls these functions; nothing calls them yet.
//
// Every function returns frozen values and never changes its arguments. A
// function that changes nothing returns the same timeline object, so a
// caller can skip a publish.
//
// A pending copy belongs to its account, device, workspace, and project (the
// Project Manager's decision of 2026-11-05 on #27): the timeline's key holds
// all four, and `keepForIdentity` and `pendingForResend` make sure that a
// copy is never resent under another account or device.
import {
  CHAT_HISTORY_PAGE,
  LIMITS,
  multilineText,
  NOT_BLANK_PATTERN,
  type ChatHistoryResponse,
  type ChatMessage,
  type ChatMessageAuthor,
  type ChatMessageCreatedEvent,
  type DeviceId,
  type EventId,
  type EventRefusalCode,
  type EventRefusedFrame,
  type ProjectId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";

/**
 * How many pending copies one timeline holds at most, refused copies
 * included. Another message is refused with `too_many_pending`.
 */
export const MAX_PENDING_CHAT_MESSAGES = 50;

/** Whose timeline it is, and of which project. */
export interface ChatTimelineKey {
  readonly userId: UserId;
  readonly deviceId: DeviceId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
}

/** The signed-in account and device. */
export interface ChatIdentity {
  readonly userId: UserId;
  readonly deviceId: DeviceId;
}

declare const messageBodyBrand: unique symbol;

/** A message body that `prepareMessageBody` accepted. */
export type MessageBody = string & { readonly [messageBodyBrand]: true };

/** Why `prepareMessageBody` refused a text. */
export type MessageBodyProblem = "blank" | "too_long" | "invalid_characters";

export type PreparedMessageBody =
  | { readonly kind: "ready"; readonly body: MessageBody }
  | { readonly kind: "refused"; readonly reason: MessageBodyProblem };

/**
 * A message that the person wrote and the server has not stored yet.
 * `waiting`: it waits for the connection. `sending`: it was sent and waits
 * for `chat.message.created`. `refused`: the server answered
 * `event.refused` with `code`.
 */
export type PendingChatMessage =
  | {
      readonly eventId: EventId;
      readonly body: MessageBody;
      readonly state: "waiting" | "sending";
    }
  | {
      readonly eventId: EventId;
      readonly body: MessageBody;
      readonly state: "refused";
      readonly code: EventRefusalCode;
    };

export interface ChatTimeline {
  readonly key: ChatTimelineKey;
  /**
   * The held messages, the oldest first: all of `key.projectId`, each
   * message ID and each `seq` once.
   */
  readonly messages: readonly ChatMessage[];
  /** Whether a newest page was applied. */
  readonly loaded: boolean;
  /** Whether the server holds messages older than the held ones. */
  readonly hasOlder: boolean;
  /** The pending copies, in the order they were added. */
  readonly pending: readonly PendingChatMessage[];
}

/** The query of a history request, as the device sent it. */
export interface ChatPageQuery {
  readonly limit: number;
}

/** The query of an older page, as the device sent it. */
export interface OlderChatPageQuery extends ChatPageQuery {
  readonly beforeSeq: number;
}

/**
 * What the device checks in a history page, because the schema cannot see
 * the request (`ChatHistoryResponseSchema`).
 */
export type ChatPageProblem =
  "wrong_project" | "too_many_messages" | "seq_not_below";

/**
 * `stale`: an older page for a range that the timeline no longer ends with,
 * for example one that a newest-page reload overtook. The caller drops it.
 */
export type ChatPageResult =
  | { readonly kind: "applied"; readonly timeline: ChatTimeline }
  | { readonly kind: "stale" }
  | { readonly kind: "invalid"; readonly reason: ChatPageProblem };

export type AddPendingResult =
  | { readonly kind: "added"; readonly timeline: ChatTimeline }
  | {
      readonly kind: "refused";
      readonly reason: "too_many_pending" | "duplicate_event";
    };

const MESSAGE_BODY_SCHEMA = multilineText(LIMITS.messageBody);
// A private copy, so that a change of the exported pattern at runtime cannot
// change this module.
const NOT_BLANK = new RegExp(NOT_BLANK_PATTERN.source, NOT_BLANK_PATTERN.flags);
const LINE_BREAK = /\r\n?/gu;
const NO_PENDING: readonly PendingChatMessage[] = Object.freeze([]);
const NO_MESSAGES: readonly ChatMessage[] = Object.freeze([]);

/** Whether `text` has more than `max` code points, as zod counts them. */
function exceedsCodePoints(text: string, max: number): boolean {
  if (text.length <= max) {
    return false;
  }
  if (text.length > max * 2) {
    return true;
  }
  let count = 0;
  let index = 0;
  while (index < text.length) {
    count += 1;
    if (count > max) {
      return true;
    }
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
  }
  return false;
}

/**
 * Turns the composer's text into a message body. A carriage return, alone
 * or before a line feed, becomes a line feed, because the protocol refuses
 * it. The body then needs at least one character that is not white space, at
 * most `LIMITS.messageBody` (16,000) code points, and no other control,
 * format, or invisible character: the rules of `multilineText`, which also
 * decides.
 */
export function prepareMessageBody(text: string): PreparedMessageBody {
  const body = text.replace(LINE_BREAK, "\n");
  let reason: MessageBodyProblem | undefined;
  if (body.length === 0) {
    reason = "blank";
  } else if (exceedsCodePoints(body, LIMITS.messageBody)) {
    reason = "too_long";
  } else if (!MESSAGE_BODY_SCHEMA.safeParse(body).success) {
    reason = NOT_BLANK.test(body) ? "invalid_characters" : "blank";
  }
  if (reason !== undefined) {
    return Object.freeze({ kind: "refused", reason });
  }
  return Object.freeze({ kind: "ready", body: body as MessageBody });
}

/** Whether two keys name the same account, device, workspace, and project. */
export function sameTimelineKey(
  a: ChatTimelineKey,
  b: ChatTimelineKey,
): boolean {
  return (
    a.userId === b.userId &&
    a.deviceId === b.deviceId &&
    a.workspaceId === b.workspaceId &&
    a.projectId === b.projectId
  );
}

/** An empty timeline: no messages, not loaded, and no pending copy. */
export function createChatTimeline(key: ChatTimelineKey): ChatTimeline {
  return Object.freeze({
    key: Object.freeze({
      userId: key.userId,
      deviceId: key.deviceId,
      workspaceId: key.workspaceId,
      projectId: key.projectId,
    }),
    messages: NO_MESSAGES,
    loaded: false,
    hasOlder: false,
    pending: NO_PENDING,
  });
}

/**
 * The timeline while it belongs to the signed-in account and device, or
 * `null` after a sign-out (`identity` null) or a change of account or device:
 * the caller then drops it with its messages and pending copies. The caller
 * also drops the timelines of a workspace whose membership ended.
 */
export function keepForIdentity(
  timeline: ChatTimeline,
  identity: ChatIdentity | null,
): ChatTimeline | null {
  if (
    identity === null ||
    identity.userId !== timeline.key.userId ||
    identity.deviceId !== timeline.key.deviceId
  ) {
    return null;
  }
  return timeline;
}

function changed(
  timeline: ChatTimeline,
  changes: Partial<Omit<ChatTimeline, "key">>,
): ChatTimeline {
  return Object.freeze({ ...timeline, ...changes });
}

/** A frozen copy with the protocol's fields only. */
function heldMessage(message: ChatMessage): ChatMessage {
  const author: ChatMessageAuthor =
    message.author.kind === "member"
      ? { kind: "member", memberId: message.author.memberId }
      : { kind: "agent", agentId: message.author.agentId };
  return Object.freeze({
    id: message.id,
    projectId: message.projectId,
    seq: message.seq,
    author: Object.freeze(author),
    body: message.body,
    createdAt: message.createdAt,
  });
}

/**
 * The messages of both lists, the oldest first. A message whose ID or `seq`
 * an earlier one already has is left out, so the first list wins.
 */
function merge(
  first: readonly ChatMessage[],
  second: readonly ChatMessage[],
): readonly ChatMessage[] {
  const ids = new Set<string>();
  const seqs = new Set<number>();
  const merged: ChatMessage[] = [];
  for (const message of [...first, ...second]) {
    if (!ids.has(message.id) && !seqs.has(message.seq)) {
      ids.add(message.id);
      seqs.add(message.seq);
      merged.push(message);
    }
  }
  merged.sort((a, b) => a.seq - b.seq);
  return Object.freeze(merged);
}

function checkPage(
  timeline: ChatTimeline,
  query: ChatPageQuery,
  page: ChatHistoryResponse,
): ChatPageProblem | undefined {
  if (
    page.messages.some(
      (message) => message.projectId !== timeline.key.projectId,
    )
  ) {
    return "wrong_project";
  }
  if (page.messages.length > query.limit) {
    return "too_many_messages";
  }
  return undefined;
}

/**
 * Whether the server holds messages older than a page: when the page is
 * full and does not reach `seq` 1. The server numbers a project's messages
 * from 1 without gaps (`packages/database/src/chat.ts`).
 */
function olderExist(
  page: ChatHistoryResponse,
  query: ChatPageQuery,
  lowestSeq: number,
): boolean {
  return page.messages.length >= query.limit && lowestSeq > 1;
}

function lowestSeqOf(messages: readonly ChatMessage[]): number {
  return messages.reduce(
    (lowest, message) => Math.min(lowest, message.seq),
    Number.POSITIVE_INFINITY,
  );
}

/**
 * Applies the newest page: the page replaces the held messages, so a reload
 * never leaves a gap, also after messages were missed while the connection
 * was down. Held messages newer than the page's newest message stay, because
 * they arrived over the connection after the server read the page. The
 * pending copies stay. `hasOlder` becomes true when the page is full and does
 * not reach `seq` 1.
 */
export function applyNewestPage(
  timeline: ChatTimeline,
  query: ChatPageQuery,
  page: ChatHistoryResponse,
): ChatPageResult {
  const problem = checkPage(timeline, query, page);
  if (problem !== undefined) {
    return Object.freeze({ kind: "invalid", reason: problem });
  }
  const newestSeq = page.messages.reduce(
    (newest, message) => Math.max(newest, message.seq),
    0,
  );
  const newer = timeline.messages.filter((message) => message.seq > newestSeq);
  return Object.freeze({
    kind: "applied",
    timeline: changed(timeline, {
      messages: merge(page.messages.map(heldMessage), newer),
      loaded: true,
      hasOlder:
        page.messages.length > 0 &&
        olderExist(page, query, lowestSeqOf(page.messages)),
    }),
  });
}

/**
 * The query of the next older page: the lowest held `seq` as `beforeSeq`,
 * or `null` when the timeline is not loaded or holds the oldest message.
 * Throws a `RangeError` for a limit outside 1 to `CHAT_HISTORY_PAGE.max`.
 */
export function olderPageQuery(
  timeline: ChatTimeline,
  limit: number = CHAT_HISTORY_PAGE.default,
): OlderChatPageQuery | null {
  if (!Number.isInteger(limit) || limit < 1 || limit > CHAT_HISTORY_PAGE.max) {
    throw new RangeError("The page limit is out of range");
  }
  const lowest = timeline.messages[0];
  if (!timeline.loaded || !timeline.hasOlder || lowest === undefined) {
    return null;
  }
  return Object.freeze({ beforeSeq: lowest.seq, limit });
}

/**
 * Applies an older page. It is stale unless the timeline still has older
 * messages and its lowest held `seq` is the `beforeSeq` that was sent: a
 * newest-page reload that answered meanwhile would otherwise leave a gap.
 * Every `seq` must be lower than `beforeSeq`.
 */
export function applyOlderPage(
  timeline: ChatTimeline,
  query: OlderChatPageQuery,
  page: ChatHistoryResponse,
): ChatPageResult {
  const problem = checkPage(timeline, query, page);
  if (problem !== undefined) {
    return Object.freeze({ kind: "invalid", reason: problem });
  }
  if (page.messages.some((message) => message.seq >= query.beforeSeq)) {
    return Object.freeze({ kind: "invalid", reason: "seq_not_below" });
  }
  if (
    !timeline.loaded ||
    !timeline.hasOlder ||
    timeline.messages[0]?.seq !== query.beforeSeq
  ) {
    return Object.freeze({ kind: "stale" });
  }
  return Object.freeze({
    kind: "applied",
    timeline: changed(timeline, {
      messages: merge(timeline.messages, page.messages.map(heldMessage)),
      hasOlder:
        page.messages.length > 0 &&
        olderExist(page, query, lowestSeqOf(page.messages)),
    }),
  });
}

/**
 * Applies `chat.message.created`. The pending copy whose event ID is the
 * event's `causationId` goes away. The message is inserted by `seq`, also
 * when relays arrive out of order, unless the timeline already holds its ID
 * or its `seq`, or it is older than the held messages while older pages
 * exist: inserting it would leave a gap, and an older page brings it. An
 * event of another workspace or project changes nothing.
 */
export function applyCreated(
  timeline: ChatTimeline,
  event: ChatMessageCreatedEvent,
): ChatTimeline {
  const { message } = event.payload;
  if (
    event.workspaceId !== timeline.key.workspaceId ||
    message.projectId !== timeline.key.projectId
  ) {
    return timeline;
  }
  const pending =
    event.causationId === undefined
      ? timeline.pending
      : withoutPending(timeline.pending, event.causationId);
  const lowest = timeline.messages[0];
  const insert =
    !timeline.messages.some(
      (held) => held.id === message.id || held.seq === message.seq,
    ) &&
    !(timeline.hasOlder && lowest !== undefined && message.seq < lowest.seq);
  if (!insert && pending === timeline.pending) {
    return timeline;
  }
  if (!insert) {
    return changed(timeline, { pending });
  }
  const index = timeline.messages.findIndex((held) => held.seq > message.seq);
  const messages = [...timeline.messages];
  messages.splice(
    index === -1 ? messages.length : index,
    0,
    heldMessage(message),
  );
  return changed(timeline, { messages: Object.freeze(messages), pending });
}

function withoutPending(
  pending: readonly PendingChatMessage[],
  eventId: EventId,
): readonly PendingChatMessage[] {
  if (!pending.some((copy) => copy.eventId === eventId)) {
    return pending;
  }
  return Object.freeze(pending.filter((copy) => copy.eventId !== eventId));
}

function replacePending(
  timeline: ChatTimeline,
  eventId: EventId,
  next: (copy: PendingChatMessage) => PendingChatMessage,
): ChatTimeline {
  let replaced = false;
  const pending = timeline.pending.map((copy) => {
    if (copy.eventId !== eventId) {
      return copy;
    }
    const updated = next(copy);
    replaced ||= updated !== copy;
    return updated;
  });
  return replaced
    ? changed(timeline, { pending: Object.freeze(pending) })
    : timeline;
}

/**
 * Marks the pending copy of `event.refused` as refused, with its code. A
 * frame for an event ID that no pending copy has changes nothing.
 */
export function applyRefused(
  timeline: ChatTimeline,
  frame: Pick<EventRefusedFrame, "eventId" | "code">,
): ChatTimeline {
  return replacePending(timeline, frame.eventId, (copy) =>
    copy.state === "refused" && copy.code === frame.code
      ? copy
      : Object.freeze({
          eventId: copy.eventId,
          body: copy.body,
          state: "refused",
          code: frame.code,
        }),
  );
}

/**
 * Adds a pending copy, `waiting` for the connection. Refused when the
 * timeline already holds `MAX_PENDING_CHAT_MESSAGES` copies, or a copy with
 * the same event ID.
 */
export function addPending(
  timeline: ChatTimeline,
  eventId: EventId,
  body: MessageBody,
): AddPendingResult {
  if (timeline.pending.some((copy) => copy.eventId === eventId)) {
    return Object.freeze({ kind: "refused", reason: "duplicate_event" });
  }
  if (timeline.pending.length >= MAX_PENDING_CHAT_MESSAGES) {
    return Object.freeze({ kind: "refused", reason: "too_many_pending" });
  }
  const copy: PendingChatMessage = Object.freeze({
    eventId,
    body,
    state: "waiting",
  });
  return Object.freeze({
    kind: "added",
    timeline: changed(timeline, {
      pending: Object.freeze([...timeline.pending, copy]),
    }),
  });
}

/**
 * Marks a pending copy as `waiting` for the connection or as `sending`, also
 * a refused one that the person sends again.
 */
export function markPending(
  timeline: ChatTimeline,
  eventId: EventId,
  state: "waiting" | "sending",
): ChatTimeline {
  return replacePending(timeline, eventId, (copy) =>
    copy.state === state
      ? copy
      : Object.freeze({ eventId: copy.eventId, body: copy.body, state }),
  );
}

/**
 * The `waiting` copies to send again, in the order they were added, but only
 * for the timeline's own key: for another account, device, workspace, or
 * project the list is empty.
 */
export function pendingForResend(
  timeline: ChatTimeline,
  key: ChatTimelineKey,
): readonly PendingChatMessage[] {
  if (!sameTimelineKey(timeline.key, key)) {
    return NO_PENDING;
  }
  return Object.freeze(
    timeline.pending.filter((copy) => copy.state === "waiting"),
  );
}

/** Removes a pending copy, for example when the person discards it. */
export function discardPending(
  timeline: ChatTimeline,
  eventId: EventId,
): ChatTimeline {
  const pending = withoutPending(timeline.pending, eventId);
  return pending === timeline.pending
    ? timeline
    : changed(timeline, { pending });
}
