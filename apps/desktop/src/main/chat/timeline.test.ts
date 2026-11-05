import {
  ChatMessageCreatedEventSchema,
  ChatMessageSchema,
  DeviceIdSchema,
  EventIdSchema,
  PROTOCOL_VERSION,
  ProjectIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  type ChatHistoryResponse,
  type ChatMessage,
  type ChatMessageCreatedEvent,
  type EventId,
} from "@mymandev/protocol";
import { describe, expect, test } from "vitest";
import {
  addPending,
  applyCreated,
  applyNewestPage,
  applyOlderPage,
  applyRefused,
  createChatTimeline,
  discardPending,
  keepForIdentity,
  markPending,
  MAX_PENDING_CHAT_MESSAGES,
  olderPageQuery,
  pendingForResend,
  prepareMessageBody,
  sameTimelineKey,
  type ChatPageResult,
  type ChatTimeline,
  type ChatTimelineKey,
  type MessageBody,
} from "./timeline.ts";

/** A UUIDv7 string that ends with `n` in hexadecimal. */
function uuid(prefix: string, n: number): string {
  return `${prefix}-7c3e-7a1b-8c4d-${n.toString(16).padStart(12, "0")}`;
}

const KEY: ChatTimelineKey = {
  userId: UserIdSchema.parse(uuid("0192f2a0", 1)),
  deviceId: DeviceIdSchema.parse(uuid("0192f2a0", 2)),
  workspaceId: WorkspaceIdSchema.parse(uuid("0192f2a0", 3)),
  projectId: ProjectIdSchema.parse(uuid("0192f2a0", 4)),
};
const OTHER_PROJECT = ProjectIdSchema.parse(uuid("0192f2a0", 5));
const OTHER_WORKSPACE = WorkspaceIdSchema.parse(uuid("0192f2a0", 6));
const MEMBER_ID = uuid("0192f2a1", 1);
const AT = "2026-11-05T10:00:00.000Z";

function message(
  seq: number,
  options: { readonly projectId?: string; readonly id?: string } = {},
): ChatMessage {
  return ChatMessageSchema.parse({
    id: options.id ?? uuid("0192f2b0", seq),
    projectId: options.projectId ?? KEY.projectId,
    seq,
    author: { kind: "member", memberId: MEMBER_ID },
    body: `message ${seq}`,
    createdAt: AT,
  });
}

/** A page of the given `seq` numbers, the newest first, as the API sends it. */
function page(...seqs: readonly number[]): ChatHistoryResponse {
  return { messages: [...seqs].sort((a, b) => b - a).map((s) => message(s)) };
}

function eventId(n: number): EventId {
  return EventIdSchema.parse(uuid("0192f2c0", n));
}

function created(
  chatMessage: ChatMessage,
  options: {
    readonly causationId?: EventId;
    readonly workspaceId?: string;
  } = {},
): ChatMessageCreatedEvent {
  return ChatMessageCreatedEventSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    type: "chat.message.created",
    id: uuid("0192f2d0", chatMessage.seq),
    occurredAt: AT,
    workspaceId: options.workspaceId ?? KEY.workspaceId,
    actor: { kind: "system" },
    deviceId: null,
    ...(options.causationId === undefined
      ? {}
      : { causationId: options.causationId }),
    payload: { message: chatMessage },
  });
}

function body(text: string): MessageBody {
  const prepared = prepareMessageBody(text);
  if (prepared.kind !== "ready") {
    throw new Error(`Not a valid body: ${prepared.reason}`);
  }
  return prepared.body;
}

function applied(result: ChatPageResult): ChatTimeline {
  if (result.kind !== "applied") {
    throw new Error(`The page was not applied: ${result.kind}`);
  }
  return result.timeline;
}

function seqs(timeline: ChatTimeline): readonly number[] {
  return timeline.messages.map((held) => held.seq);
}

/** A timeline with pending copies of the given event numbers, all waiting. */
function withPending(timeline: ChatTimeline, ...ids: number[]): ChatTimeline {
  let current = timeline;
  for (const n of ids) {
    const result = addPending(current, eventId(n), body(`pending ${n}`));
    if (result.kind !== "added") {
      throw new Error(result.reason);
    }
    current = result.timeline;
  }
  return current;
}

function loaded(...pageSeqs: readonly number[]): ChatTimeline {
  return applied(
    applyNewestPage(createChatTimeline(KEY), { limit: 50 }, page(...pageSeqs)),
  );
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/** Fails unless every object reachable from `value` is frozen. */
function expectDeepFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) {
    expectDeepFrozen(nested);
  }
}

describe("prepareMessageBody", () => {
  test("turns CRLF and a lone CR into LF", () => {
    expect(prepareMessageBody("a\r\nb\rc\nd")).toEqual({
      kind: "ready",
      body: "a\nb\nc\nd",
    });
    expect(prepareMessageBody("a\r\r\nb")).toEqual({
      kind: "ready",
      body: "a\n\nb",
    });
  });

  test("keeps tabs, white space around the text, and joiners", () => {
    for (const text of [
      "\ta\tb ",
      "  a  ",
      "\u{1F469}\u200D\u{1F4BB}",
      "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645",
    ]) {
      expect(prepareMessageBody(text)).toEqual({ kind: "ready", body: text });
    }
  });

  test("refuses a blank text", () => {
    for (const text of ["", " ", "\n\t\n", "\r\n", "\r", "\u00A0\u3000"]) {
      expect(prepareMessageBody(text)).toEqual({
        kind: "refused",
        reason: "blank",
      });
    }
  });

  test("counts the limit in code points", () => {
    const astral = "\u{1F600}";
    expect(astral.length).toBe(2);
    expect(prepareMessageBody(astral.repeat(16_000)).kind).toBe("ready");
    expect(prepareMessageBody(astral.repeat(16_001))).toEqual({
      kind: "refused",
      reason: "too_long",
    });
    expect(prepareMessageBody("a".repeat(16_000)).kind).toBe("ready");
    expect(prepareMessageBody("a".repeat(16_001))).toEqual({
      kind: "refused",
      reason: "too_long",
    });
    // 16,001 UTF-16 code units, but 16,000 code points.
    expect(prepareMessageBody(`${"a".repeat(15_999)}${astral}`).kind).toBe(
      "ready",
    );
    expect(prepareMessageBody(`${"a".repeat(16_000)}${astral}`)).toEqual({
      kind: "refused",
      reason: "too_long",
    });
  });

  test("counts the limit after the line breaks were converted", () => {
    // 16,002 code points as typed, 10,668 after CRLF became LF.
    const text = "a\r\n".repeat(5_334);
    const prepared = prepareMessageBody(text);
    expect(prepared.kind).toBe("ready");
    expect(prepared.kind === "ready" && prepared.body.length).toBe(10_668);
    // 16,000 line feeds and one letter after the conversion.
    expect(prepareMessageBody(`a${"\r\n".repeat(16_000)}`)).toEqual({
      kind: "refused",
      reason: "too_long",
    });
  });

  test("refuses control, format, and invisible characters", () => {
    for (const character of [
      "\u0000",
      "\u0007",
      "\u000B",
      "\u000C",
      "\u001B",
      "\u007F",
      "\u0085",
      "\u00AD",
      "\u200B",
      "\u2028",
      "\u2029",
      "\u202E",
      "\u2066",
      "\uFEFF",
      "\uD800",
      "\uE000",
    ]) {
      expect(prepareMessageBody(`a${character}b`)).toEqual({
        kind: "refused",
        reason: "invalid_characters",
      });
    }
  });

  test("returns frozen results", () => {
    expect(Object.isFrozen(prepareMessageBody("a"))).toBe(true);
    expect(Object.isFrozen(prepareMessageBody(""))).toBe(true);
  });
});

describe("the key and the identity", () => {
  test("an empty timeline holds a frozen copy of its key", () => {
    const key = { ...KEY };
    const timeline = createChatTimeline(key);
    expect(timeline).toEqual({
      key: KEY,
      messages: [],
      loaded: false,
      hasOlder: false,
      pending: [],
    });
    expect(timeline.key).not.toBe(key);
    expect(Object.isFrozen(key)).toBe(false);
    expectDeepFrozen(timeline);
  });

  test("sameTimelineKey compares all four IDs", () => {
    expect(sameTimelineKey(KEY, { ...KEY })).toBe(true);
    for (const other of [
      { ...KEY, userId: UserIdSchema.parse(uuid("0192f2a0", 7)) },
      { ...KEY, deviceId: DeviceIdSchema.parse(uuid("0192f2a0", 7)) },
      { ...KEY, workspaceId: OTHER_WORKSPACE },
      { ...KEY, projectId: OTHER_PROJECT },
    ]) {
      expect(sameTimelineKey(KEY, other)).toBe(false);
    }
  });

  test("keepForIdentity drops the timeline on sign-out and on another account or device", () => {
    const timeline = withPending(loaded(1, 2), 1);
    expect(
      keepForIdentity(timeline, { userId: KEY.userId, deviceId: KEY.deviceId }),
    ).toBe(timeline);
    expect(keepForIdentity(timeline, null)).toBeNull();
    expect(
      keepForIdentity(timeline, {
        userId: UserIdSchema.parse(uuid("0192f2a0", 7)),
        deviceId: KEY.deviceId,
      }),
    ).toBeNull();
    expect(
      keepForIdentity(timeline, {
        userId: KEY.userId,
        deviceId: DeviceIdSchema.parse(uuid("0192f2a0", 7)),
      }),
    ).toBeNull();
  });
});

describe("the newest page", () => {
  test("holds the messages oldest first and marks the timeline loaded", () => {
    const timeline = loaded(1, 2, 3);
    expect(seqs(timeline)).toEqual([1, 2, 3]);
    expect(timeline.loaded).toBe(true);
    expect(timeline.hasOlder).toBe(false);
    expectDeepFrozen(timeline);
  });

  test("hasOlder is true only for a full page that does not reach seq 1", () => {
    const empty = createChatTimeline(KEY);
    const full = applied(applyNewestPage(empty, { limit: 3 }, page(4, 5, 6)));
    expect(full.hasOlder).toBe(true);
    const fromOne = applied(
      applyNewestPage(empty, { limit: 3 }, page(1, 2, 3)),
    );
    expect(fromOne.hasOlder).toBe(false);
    const short = applied(applyNewestPage(empty, { limit: 3 }, page(5, 6)));
    expect(short.hasOlder).toBe(false);
    const none = applied(applyNewestPage(empty, { limit: 3 }, page()));
    expect(none.hasOlder).toBe(false);
    expect(none.messages).toEqual([]);
    expect(none.loaded).toBe(true);
  });

  test("a reload replaces the held messages, so no gap remains", () => {
    let timeline = applied(
      applyNewestPage(createChatTimeline(KEY), { limit: 3 }, page(8, 9, 10)),
    );
    timeline = applied(
      applyOlderPage(timeline, { beforeSeq: 8, limit: 3 }, page(5, 6, 7)),
    );
    expect(seqs(timeline)).toEqual([5, 6, 7, 8, 9, 10]);
    // Messages 11 to 19 were missed while the connection was down.
    const reloaded = applied(
      applyNewestPage(timeline, { limit: 3 }, page(18, 19, 20)),
    );
    expect(seqs(reloaded)).toEqual([18, 19, 20]);
    expect(reloaded.hasOlder).toBe(true);
  });

  test("a reload keeps the held messages newer than the page", () => {
    let timeline = loaded(1, 2);
    timeline = applyCreated(timeline, created(message(4)));
    timeline = applyCreated(timeline, created(message(3)));
    const reloaded = applied(
      applyNewestPage(timeline, { limit: 50 }, page(1, 2)),
    );
    expect(seqs(reloaded)).toEqual([1, 2, 3, 4]);
    const empty = applied(
      applyNewestPage(
        applyCreated(createChatTimeline(KEY), created(message(1))),
        { limit: 50 },
        page(),
      ),
    );
    expect(seqs(empty)).toEqual([1]);
  });

  test("a reload keeps the pending copies", () => {
    let timeline = withPending(loaded(1, 2), 1, 2);
    timeline = applyRefused(timeline, {
      eventId: eventId(2),
      code: "conflict",
    });
    const reloaded = applied(applyNewestPage(timeline, { limit: 50 }, page(3)));
    expect(reloaded.pending).toBe(timeline.pending);
    expect(reloaded.pending.map((copy) => copy.state)).toEqual([
      "waiting",
      "refused",
    ]);
  });

  test("a message that the page and a relay both hold is held once", () => {
    let timeline = applyCreated(createChatTimeline(KEY), created(message(2)));
    timeline = applied(applyNewestPage(timeline, { limit: 50 }, page(1, 2)));
    expect(seqs(timeline)).toEqual([1, 2]);
    expect(applyCreated(timeline, created(message(2)))).toBe(timeline);
  });

  test("refuses a message of another project", () => {
    const wrong: ChatHistoryResponse = {
      messages: [message(2), message(1, { projectId: OTHER_PROJECT })],
    };
    const timeline = loaded(1);
    expect(applyNewestPage(timeline, { limit: 50 }, wrong)).toEqual({
      kind: "invalid",
      reason: "wrong_project",
    });
  });

  test("refuses more messages than the limit that was sent", () => {
    const result = applyNewestPage(
      createChatTimeline(KEY),
      { limit: 2 },
      page(1, 2, 3),
    );
    expect(result).toEqual({ kind: "invalid", reason: "too_many_messages" });
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("copies the messages and leaves the page unchanged", () => {
    const answer = page(1);
    const extra = { ...answer.messages[0], extra: "not held" } as ChatMessage;
    const timeline = applied(
      applyNewestPage(
        createChatTimeline(KEY),
        { limit: 50 },
        {
          messages: [extra],
        },
      ),
    );
    expect(timeline.messages[0]).toEqual(answer.messages[0]);
    expect(timeline.messages[0]).not.toHaveProperty("extra");
    expect(Object.isFrozen(extra)).toBe(false);
    expect(Object.isFrozen(extra.author)).toBe(false);
    expectDeepFrozen(timeline);
  });
});

describe("older pages", () => {
  test("load older messages until seq 1", () => {
    let timeline = applied(
      applyNewestPage(createChatTimeline(KEY), { limit: 2 }, page(4, 5)),
    );
    expect(olderPageQuery(timeline, 2)).toEqual({ beforeSeq: 4, limit: 2 });
    timeline = applied(
      applyOlderPage(timeline, { beforeSeq: 4, limit: 2 }, page(2, 3)),
    );
    expect(seqs(timeline)).toEqual([2, 3, 4, 5]);
    expect(timeline.hasOlder).toBe(true);
    expect(olderPageQuery(timeline, 2)).toEqual({ beforeSeq: 2, limit: 2 });
    timeline = applied(
      applyOlderPage(timeline, { beforeSeq: 2, limit: 2 }, page(1)),
    );
    expect(seqs(timeline)).toEqual([1, 2, 3, 4, 5]);
    expect(timeline.hasOlder).toBe(false);
    expect(olderPageQuery(timeline)).toBeNull();
    expectDeepFrozen(timeline);
  });

  test("a full older page that reaches seq 1 has nothing older", () => {
    const timeline = applied(
      applyNewestPage(createChatTimeline(KEY), { limit: 2 }, page(3, 4)),
    );
    const oldest = applied(
      applyOlderPage(timeline, { beforeSeq: 3, limit: 2 }, page(1, 2)),
    );
    expect(oldest.hasOlder).toBe(false);
  });

  test("an empty older page has nothing older", () => {
    const timeline = applied(
      applyNewestPage(createChatTimeline(KEY), { limit: 2 }, page(3, 4)),
    );
    const oldest = applied(
      applyOlderPage(timeline, { beforeSeq: 3, limit: 2 }, page()),
    );
    expect(oldest.hasOlder).toBe(false);
    expect(seqs(oldest)).toEqual([3, 4]);
  });

  test("olderPageQuery needs a loaded timeline with older messages", () => {
    expect(olderPageQuery(createChatTimeline(KEY))).toBeNull();
    const relayed = applyCreated(createChatTimeline(KEY), created(message(7)));
    expect(olderPageQuery(relayed)).toBeNull();
    const full = applied(
      applyNewestPage(createChatTimeline(KEY), { limit: 2 }, page(4, 5)),
    );
    expect(olderPageQuery(full)).toEqual({ beforeSeq: 4, limit: 50 });
    expect(Object.isFrozen(olderPageQuery(full))).toBe(true);
    for (const limit of [0, 101, 1.5, Number.NaN]) {
      expect(() => olderPageQuery(full, limit)).toThrow(RangeError);
    }
    expect(olderPageQuery(full, 100)).toEqual({ beforeSeq: 4, limit: 100 });
  });

  test("refuses a seq that is not below beforeSeq", () => {
    const timeline = applied(
      applyNewestPage(createChatTimeline(KEY), { limit: 2 }, page(4, 5)),
    );
    for (const answer of [page(3, 4), page(2, 5)]) {
      expect(
        applyOlderPage(timeline, { beforeSeq: 4, limit: 2 }, answer),
      ).toEqual({ kind: "invalid", reason: "seq_not_below" });
    }
  });

  test("refuses another project and more messages than the limit", () => {
    const timeline = applied(
      applyNewestPage(createChatTimeline(KEY), { limit: 2 }, page(4, 5)),
    );
    expect(
      applyOlderPage(
        timeline,
        { beforeSeq: 4, limit: 2 },
        {
          messages: [message(3, { projectId: OTHER_PROJECT })],
        },
      ),
    ).toEqual({ kind: "invalid", reason: "wrong_project" });
    expect(
      applyOlderPage(timeline, { beforeSeq: 4, limit: 2 }, page(1, 2, 3)),
    ).toEqual({ kind: "invalid", reason: "too_many_messages" });
  });

  test("drops an older page that a reload overtook", () => {
    let timeline = applied(
      applyNewestPage(createChatTimeline(KEY), { limit: 2 }, page(4, 5)),
    );
    const query = olderPageQuery(timeline, 2);
    timeline = applied(applyNewestPage(timeline, { limit: 2 }, page(8, 9)));
    expect(query).not.toBeNull();
    if (query !== null) {
      expect(applyOlderPage(timeline, query, page(2, 3))).toEqual({
        kind: "stale",
      });
    }
  });

  test("drops an older page while there is nothing older", () => {
    const notLoaded = applyCreated(
      createChatTimeline(KEY),
      created(message(4)),
    );
    expect(
      applyOlderPage(notLoaded, { beforeSeq: 4, limit: 2 }, page(2, 3)),
    ).toEqual({ kind: "stale" });
    const complete = loaded(1, 2);
    expect(
      applyOlderPage(complete, { beforeSeq: 1, limit: 2 }, page()),
    ).toEqual({ kind: "stale" });
  });
});

describe("chat.message.created", () => {
  test("inserts relays that arrive out of seq order", () => {
    let timeline = loaded(1);
    for (const seq of [4, 2, 3]) {
      timeline = applyCreated(timeline, created(message(seq)));
    }
    expect(seqs(timeline)).toEqual([1, 2, 3, 4]);
    expectDeepFrozen(timeline);
  });

  test("inserts relays before the first page", () => {
    let timeline = createChatTimeline(KEY);
    timeline = applyCreated(timeline, created(message(9)));
    timeline = applyCreated(timeline, created(message(8)));
    expect(seqs(timeline)).toEqual([8, 9]);
    expect(timeline.loaded).toBe(false);
  });

  test("replaces the pending copy through causationId", () => {
    let timeline = withPending(loaded(1, 2), 1, 2);
    timeline = markPending(timeline, eventId(1), "sending");
    timeline = applyCreated(
      timeline,
      created(message(3), { causationId: eventId(1) }),
    );
    expect(seqs(timeline)).toEqual([1, 2, 3]);
    expect(timeline.pending.map((copy) => copy.eventId)).toEqual([eventId(2)]);
    expectDeepFrozen(timeline);
  });

  test("a duplicate created event changes nothing", () => {
    let timeline = withPending(loaded(1, 2), 1);
    const event = created(message(3), { causationId: eventId(1) });
    timeline = applyCreated(timeline, event);
    expect(applyCreated(timeline, event)).toBe(timeline);
    // The stored message again, after a resend with the same event ID.
    expect(
      applyCreated(timeline, created(message(2), { causationId: eventId(1) })),
    ).toBe(timeline);
  });

  test("the answer to a resent copy clears it also when its message is held", () => {
    // The reload after a reconnect already holds the stored message.
    let timeline = withPending(loaded(1), 1);
    timeline = applied(applyNewestPage(timeline, { limit: 50 }, page(1, 2)));
    expect(timeline.pending).toHaveLength(1);
    timeline = applyCreated(
      timeline,
      created(message(2), { causationId: eventId(1) }),
    );
    expect(seqs(timeline)).toEqual([1, 2]);
    expect(timeline.pending).toEqual([]);
  });

  test("a message below the held range is not inserted while older pages exist", () => {
    let timeline = withPending(
      applied(
        applyNewestPage(createChatTimeline(KEY), { limit: 2 }, page(4, 5)),
      ),
      1,
    );
    timeline = applyCreated(
      timeline,
      created(message(2), { causationId: eventId(1) }),
    );
    expect(seqs(timeline)).toEqual([4, 5]);
    expect(timeline.pending).toEqual([]);
    expect(applyCreated(timeline, created(message(3)))).toBe(timeline);
  });

  test("a message with a held seq but another ID is not inserted", () => {
    const timeline = loaded(1, 2);
    expect(
      applyCreated(timeline, created(message(2, { id: uuid("0192f2b1", 2) }))),
    ).toBe(timeline);
  });

  test("an event of another project or workspace changes nothing", () => {
    const timeline = withPending(loaded(1), 1);
    expect(
      applyCreated(
        timeline,
        created(message(2, { projectId: OTHER_PROJECT }), {
          causationId: eventId(1),
        }),
      ),
    ).toBe(timeline);
    expect(
      applyCreated(
        timeline,
        created(message(2), {
          causationId: eventId(1),
          workspaceId: OTHER_WORKSPACE,
        }),
      ),
    ).toBe(timeline);
  });
});

describe("pending copies", () => {
  test("a new copy waits for the connection", () => {
    const timeline = withPending(loaded(1), 1);
    expect(timeline.pending).toEqual([
      { eventId: eventId(1), body: "pending 1", state: "waiting" },
    ]);
    expectDeepFrozen(timeline);
  });

  test("refuses a duplicate event ID and more than the maximum", () => {
    const one = withPending(loaded(1), 1);
    expect(addPending(one, eventId(1), body("again"))).toEqual({
      kind: "refused",
      reason: "duplicate_event",
    });
    const full = withPending(
      createChatTimeline(KEY),
      ...range(1, MAX_PENDING_CHAT_MESSAGES),
    );
    expect(full.pending).toHaveLength(50);
    const result = addPending(
      full,
      eventId(MAX_PENDING_CHAT_MESSAGES + 1),
      body("one more"),
    );
    expect(result).toEqual({ kind: "refused", reason: "too_many_pending" });
    expect(Object.isFrozen(result)).toBe(true);
    // A refused copy still counts; discarding one makes room.
    const refused = applyRefused(full, {
      eventId: eventId(1),
      code: "not_found",
    });
    expect(addPending(refused, eventId(51), body("one more")).kind).toBe(
      "refused",
    );
    expect(
      addPending(discardPending(refused, eventId(1)), eventId(51), body("x"))
        .kind,
    ).toBe("added");
  });

  test("a refusal marks the copy with its code", () => {
    let timeline = withPending(loaded(1), 1, 2);
    timeline = markPending(timeline, eventId(1), "sending");
    timeline = applyRefused(timeline, {
      eventId: eventId(1),
      code: "rate_limited",
    });
    expect(timeline.pending).toEqual([
      {
        eventId: eventId(1),
        body: "pending 1",
        state: "refused",
        code: "rate_limited",
      },
      { eventId: eventId(2), body: "pending 2", state: "waiting" },
    ]);
    expectDeepFrozen(timeline);
    expect(
      applyRefused(timeline, { eventId: eventId(1), code: "rate_limited" }),
    ).toBe(timeline);
    expect(
      applyRefused(timeline, { eventId: eventId(9), code: "conflict" }),
    ).toBe(timeline);
    const conflict = applyRefused(timeline, {
      eventId: eventId(1),
      code: "conflict",
    });
    expect(conflict.pending[0]).toMatchObject({
      state: "refused",
      code: "conflict",
    });
  });

  test("markPending moves a copy between waiting and sending, also after a refusal", () => {
    let timeline = withPending(loaded(1), 1);
    timeline = markPending(timeline, eventId(1), "sending");
    expect(timeline.pending[0]?.state).toBe("sending");
    expect(markPending(timeline, eventId(1), "sending")).toBe(timeline);
    expect(markPending(timeline, eventId(9), "waiting")).toBe(timeline);
    timeline = markPending(timeline, eventId(1), "waiting");
    expect(timeline.pending[0]?.state).toBe("waiting");
    timeline = applyRefused(timeline, {
      eventId: eventId(1),
      code: "rate_limited",
    });
    timeline = markPending(timeline, eventId(1), "sending");
    expect(timeline.pending[0]).toEqual({
      eventId: eventId(1),
      body: "pending 1",
      state: "sending",
    });
    expectDeepFrozen(timeline);
  });

  test("pendingForResend lists the waiting copies for the timeline's own key", () => {
    let timeline = withPending(loaded(1), 1, 2, 3, 4);
    timeline = markPending(timeline, eventId(2), "sending");
    timeline = applyRefused(timeline, {
      eventId: eventId(3),
      code: "not_found",
    });
    const resend = pendingForResend(timeline, { ...KEY });
    expect(resend.map((copy) => copy.eventId)).toEqual([
      eventId(1),
      eventId(4),
    ]);
    expectDeepFrozen(resend);
    for (const other of [
      { ...KEY, userId: UserIdSchema.parse(uuid("0192f2a0", 7)) },
      { ...KEY, deviceId: DeviceIdSchema.parse(uuid("0192f2a0", 7)) },
      { ...KEY, workspaceId: OTHER_WORKSPACE },
      { ...KEY, projectId: OTHER_PROJECT },
    ]) {
      expect(pendingForResend(timeline, other)).toEqual([]);
    }
  });

  test("discardPending removes one copy", () => {
    const timeline = withPending(loaded(1), 1, 2);
    const discarded = discardPending(timeline, eventId(1));
    expect(discarded.pending.map((copy) => copy.eventId)).toEqual([eventId(2)]);
    expect(discarded.messages).toBe(timeline.messages);
    expect(discardPending(discarded, eventId(1))).toBe(discarded);
    expectDeepFrozen(discarded);
  });

  test("no function changes the timeline it gets", () => {
    const timeline = withPending(loaded(1, 2), 1);
    const before = structuredClone(timeline);
    applyNewestPage(timeline, { limit: 50 }, page(3));
    applyCreated(timeline, created(message(3), { causationId: eventId(1) }));
    applyRefused(timeline, { eventId: eventId(1), code: "conflict" });
    markPending(timeline, eventId(1), "sending");
    addPending(timeline, eventId(2), body("b"));
    discardPending(timeline, eventId(1));
    expect(timeline).toEqual(before);
  });
});
