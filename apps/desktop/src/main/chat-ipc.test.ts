import {
  ChatMessageSchema,
  EVENT_REFUSAL_CODES,
  LIMITS,
  type ChatMessage,
  type ChatMessageAuthor,
  type EventId,
  type MemberId,
  type ProjectId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { serialize } from "node:v8";
import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  CHAT_LIMITS,
  CHAT_NOT_SENT_REASONS,
  CHAT_PROBLEMS,
  CHAT_SEND_REFUSALS,
  CHAT_STATUSES,
  ChatViewSchema,
  type ChatSendRefusal,
  type ChatView,
} from "../shared/ipc-contract.ts";
import { MESSAGE_PAGE_LIMIT, WORKSPACE_READ_FAILURES } from "./api-reads.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import {
  CHAT_HELD_TEXT_RESERVE,
  CHAT_PUBLISH_INTERVAL_MS,
  chatView,
  registerChatIpc,
} from "./chat-ipc.ts";
import {
  UNKNOWN_AGENT_NAME,
  type ChatLoadOlderResult,
  type ChatPendingCopy,
  type ChatSendResult,
  type ChatServiceStatus,
  type ChatState,
} from "./chat/service.ts";
import { MAX_PENDING_CHAT_MESSAGES } from "./chat/timeline.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import {
  UNKNOWN_MEMBER_NAME,
  type WorkspaceState,
} from "./workspace/service.ts";

const DEV_URL = "http://localhost:5173/";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const PROJECT = id(0xe1) as ProjectId;
const OTHER_PROJECT = id(0xe2) as ProjectId;
const AUTHOR = id(0xc1) as MemberId;
const OTHER_AUTHOR = id(0xc2) as MemberId;
const AGENT = id(0xf1);
const USER = id(0xb1);
const DEVICE = id(0xd1);
const AT = "2026-11-05T10:00:00.000Z";
const EVENT_1 = id(0x3001) as EventId;
const EVENT_2 = id(0x3002) as EventId;
const EVENT_3 = id(0x3003) as EventId;

/** A message checked by the protocol's schema, as the service holds it. */
function message(
  seq: number,
  body = `Message ${seq}`,
  author: ChatMessageAuthor = { kind: "member", memberId: AUTHOR },
): ChatMessage {
  return Object.freeze(
    ChatMessageSchema.parse({
      id: id(0x1000 + seq),
      projectId: PROJECT,
      seq,
      author,
      body,
      createdAt: AT,
    }),
  );
}

/**
 * A message with a long body of `units` UTF-16 code units, built without
 * the protocol's pattern, which would only slow the test down.
 */
function bigMessage(seq: number, units: number, unit = "x"): ChatMessage {
  return Object.freeze({
    id: id(0x1000 + seq),
    projectId: PROJECT,
    seq,
    author: Object.freeze({ kind: "member", memberId: AUTHOR }),
    body: unit.repeat(units / unit.length),
    createdAt: AT,
  }) as ChatMessage;
}

function messages(count: number, from = 1): readonly ChatMessage[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) => message(from + index)),
  );
}

function copy(
  eventId: string,
  body: string,
  status: "waiting" | "sending" = "waiting",
): ChatPendingCopy {
  return Object.freeze({ eventId: eventId as EventId, body, status });
}

function notSent(
  eventId: string,
  body: string,
  reason: Extract<ChatPendingCopy, { status: "not_sent" }>["reason"],
): ChatPendingCopy {
  return Object.freeze({
    eventId: eventId as EventId,
    body,
    status: "not_sent",
    reason,
  });
}

function chatState(overrides: Partial<ChatState> = {}): ChatState {
  return Object.freeze({
    revision: 3,
    status: "ready",
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    messages: Object.freeze([
      message(1, "Hello"),
      message(2, "From an agent", {
        kind: "agent",
        agentId: AGENT,
      } as ChatMessageAuthor),
      message(3, "From a former member", {
        kind: "member",
        memberId: OTHER_AUTHOR,
      }),
    ]),
    hasOlder: false,
    loadingOlder: false,
    pending: Object.freeze([
      copy(EVENT_1, "Waiting"),
      copy(EVENT_2, "Sending", "sending"),
      notSent(EVENT_3, "Refused", "rate_limited"),
    ]),
    ...overrides,
  } as ChatState);
}

const NO_PROJECT: ChatState = Object.freeze({
  revision: 0,
  status: "no_project",
  workspaceId: null,
  projectId: null,
  messages: Object.freeze([]),
  hasOlder: false,
  loadingOlder: false,
  pending: Object.freeze([]),
});

interface Timer {
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
  fired: boolean;
}

/** The chat and workspace services, with listeners the test calls. */
function fakeServices(initial: ChatState = chatState()) {
  let state = initial;
  const names = new Map<string, string>([
    [AUTHOR, "Ada Lovelace"],
    [OTHER_AUTHOR, "Grace Hopper"],
  ]);
  const chatListeners = new Set<(state: ChatState) => void>();
  const workspaceListeners = new Set<(state: WorkspaceState) => void>();
  const timers: Timer[] = [];
  const errors: string[] = [];
  const calls: { method: string; args: unknown[] }[] = [];
  let sendResult: ChatSendResult = Object.freeze({
    kind: "accepted",
    eventId: EVENT_1,
  });
  let loadOlderResult: ChatLoadOlderResult = "started";
  let workspaceRevision = 0;
  let clock = 0;
  return {
    timers,
    errors,
    calls,
    chatListeners,
    workspaceListeners,
    /** The timers that were neither cancelled nor fired. */
    waiting: () => timers.filter((timer) => !timer.cancelled && !timer.fired),
    setState(next: ChatState) {
      state = next;
      for (const listener of [...chatListeners]) {
        listener(next);
      }
    },
    answerSend(result: ChatSendResult) {
      sendResult = result;
    },
    answerLoadOlder(result: ChatLoadOlderResult) {
      loadOlderResult = result;
    },
    setClock(ms: number) {
      clock = ms;
    },
    rename(memberId: string, name: string | null) {
      if (name === null) {
        names.delete(memberId);
      } else {
        names.set(memberId, name);
      }
      // The IPC reads only the chat service's `authorName`.
      workspaceRevision += 1;
      const workspaceState = { revision: workspaceRevision } as WorkspaceState;
      for (const listener of [...workspaceListeners]) {
        listener(workspaceState);
      }
    },
    /** Fires every waiting timer once. */
    fire() {
      for (const timer of [...timers]) {
        if (!timer.cancelled && !timer.fired) {
          timer.fired = true;
          timer.callback();
        }
      }
    },
    options: {
      chat: {
        state: () => {
          calls.push({ method: "state", args: [] });
          return state;
        },
        onChange: (listener: (state: ChatState) => void) => {
          chatListeners.add(listener);
          return () => {
            chatListeners.delete(listener);
          };
        },
        send: (text: string) => {
          calls.push({ method: "send", args: [text] });
          return sendResult;
        },
        retry: (eventId: EventId) => {
          calls.push({ method: "retry", args: [eventId] });
          return eventId === EVENT_3;
        },
        discard: (eventId: EventId) => {
          calls.push({ method: "discard", args: [eventId] });
          return eventId !== EVENT_2;
        },
        loadOlder: () => {
          calls.push({ method: "loadOlder", args: [] });
          return loadOlderResult;
        },
        authorName: (author: ChatMessageAuthor) =>
          author.kind === "member"
            ? (names.get(author.memberId) ?? UNKNOWN_MEMBER_NAME)
            : UNKNOWN_AGENT_NAME,
      },
      workspaces: {
        onChange: (listener: (state: WorkspaceState) => void) => {
          workspaceListeners.add(listener);
          return () => {
            workspaceListeners.delete(listener);
          };
        },
      },
      scheduleTimer: (callback: () => void, delayMs: number) => {
        const timer: Timer = {
          callback,
          delayMs,
          cancelled: false,
          fired: false,
        };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      now: () => clock,
      onError: (message: string) => {
        errors.push(message);
      },
    },
  };
}

function frame(url: string, parent: IpcFrame | null = null): IpcFrame {
  return { url, parent, detached: false, isDestroyed: () => false };
}

function receiver(url: string = DEV_URL) {
  const sent: unknown[][] = [];
  const value: StatusReceiver & { sent: unknown[][] } = {
    mainFrame: frame(url),
    sent,
    isDestroyed: () => false,
    send: (channel, ...args) => {
      sent.push([channel, ...args]);
    },
    once: () => undefined,
  };
  return value;
}

function event(
  senderFrame: IpcFrame | null,
  sender: StatusReceiver = receiver(),
): IpcInvokeEvent {
  return { senderFrame, sender };
}

function register(
  fake: ReturnType<typeof fakeServices>,
  appUrl: string = DEV_URL,
) {
  const handlers = new Map<string, IpcInvokeListener>();
  const chatIpc = registerChatIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    fake.options,
  );
  // The registration reads the state once; the tests count later calls.
  fake.calls.length = 0;
  const invoke = (
    channel: string,
    args: unknown[] = [],
    sender: StatusReceiver = receiver(appUrl),
  ): unknown => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`No handler for ${channel}.`);
    }
    return handler(event(frame(appUrl), sender), ...args);
  };
  const getState = () => invoke(INVOKE_CHANNELS.getChatState) as ChatView;
  /** Subscribes a frame and returns the payloads that it receives. */
  const subscribe = () => {
    const subscriber = receiver(appUrl);
    const first = invoke(
      INVOKE_CHANNELS.subscribeChatState,
      [],
      subscriber,
    ) as ChatView;
    return {
      first,
      payloads: () =>
        subscriber.sent.map(([channel, payload]) => {
          expect(channel).toBe(EVENT_CHANNELS.chatStateChanged);
          return payload as ChatView;
        }),
    };
  };
  return { handlers, chatIpc, invoke, getState, subscribe };
}

const CHAT_CHANNELS = Object.values(INVOKE_CHANNELS).filter((channel) =>
  channel.startsWith("chat:"),
);

/** IDs that are not a lowercase UUIDv7, and values that are not strings. */
const NOT_EVENT_IDS: readonly unknown[] = [
  "",
  "event",
  "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b70",
  EVENT_1.toUpperCase(),
  `${EVENT_1} `,
  `${EVENT_1}${"0".repeat(100_000)}`,
  1,
  null,
  true,
  {},
  [EVENT_1],
  undefined,
];

test("the chat channels are registered, and nothing else", () => {
  const { handlers } = register(fakeServices());

  expect(CHAT_CHANNELS).toHaveLength(6);
  expect([...handlers.keys()].sort()).toEqual([...CHAT_CHANNELS].sort());
});

test("every handler refuses a foreign sender, before the service is asked", () => {
  const fake = fakeServices();
  const { handlers } = register(fake, APP_ENTRY_URL);
  const valid: Record<string, unknown[]> = {
    [INVOKE_CHANNELS.sendChatMessage]: ["Hello"],
    [INVOKE_CHANNELS.retryChatMessage]: [EVENT_3],
    [INVOKE_CHANNELS.discardChatMessage]: [EVENT_1],
  };
  for (const [channel, handler] of handlers) {
    for (const sender of [
      null,
      frame("https://example.invalid/"),
      frame(APP_ENTRY_URL, frame(APP_ENTRY_URL)),
      frame(DEV_URL),
    ]) {
      expect(
        () => handler(event(sender), ...(valid[channel] ?? [])),
        channel,
      ).toThrow(
        `The call on ${channel} was refused: the sender is not the application.`,
      );
    }
  }
  expect(fake.calls).toEqual([]);
});

test("every handler refuses arguments that do not match the contract, before the service is asked", () => {
  const fake = fakeServices();
  const { invoke } = register(fake);
  const refused = (channel: string) =>
    `The call on ${channel} was refused: the arguments do not match the contract.`;

  for (const channel of [
    INVOKE_CHANNELS.getChatState,
    INVOKE_CHANNELS.subscribeChatState,
    INVOKE_CHANNELS.loadOlderChatMessages,
  ]) {
    expect(() => invoke(channel, [EVENT_1]), channel).toThrow(refused(channel));
  }
  const send = INVOKE_CHANNELS.sendChatMessage;
  for (const args of [
    [],
    [null],
    [1],
    [{ text: "Hello" }],
    [["Hello"]],
    ["Hello", "again"],
    ["Hello", undefined],
    // One character over the limit, also counted in code points.
    ["x".repeat(CHAT_LIMITS.sendText + 1)],
    ["\u{1F600}".repeat(CHAT_LIMITS.sendText + 1)],
  ]) {
    expect(() => invoke(send, args)).toThrow(refused(send));
  }
  for (const channel of [
    INVOKE_CHANNELS.retryChatMessage,
    INVOKE_CHANNELS.discardChatMessage,
  ]) {
    for (const value of NOT_EVENT_IDS) {
      expect(() => invoke(channel, [value]), String(value)).toThrow(
        refused(channel),
      );
    }
    expect(() => invoke(channel, [])).toThrow(refused(channel));
    expect(() => invoke(channel, [EVENT_1, EVENT_2])).toThrow(refused(channel));
  }
  expect(fake.calls).toEqual([]);
});

test("a refused text or event ID is not repeated in the error", () => {
  const { invoke } = register(fakeServices());

  for (const [channel, value] of [
    [INVOKE_CHANNELS.sendChatMessage, "secret-".repeat(10_000)],
    [INVOKE_CHANNELS.retryChatMessage, "secret-event"],
  ] as const) {
    let text = "";
    try {
      invoke(channel, [value]);
    } catch (error) {
      text = String(error);
    }
    expect(text).toContain("refused");
    expect(text).not.toContain("secret");
  }
});

test("send passes the text on as it came and answers the service's result", () => {
  const fake = fakeServices();
  const { invoke } = register(fake);
  const send = INVOKE_CHANNELS.sendChatMessage;
  const text = "Line one\r\nLine two\u{1F600}";

  expect(invoke(send, [text])).toEqual({
    outcome: "accepted",
    eventId: EVENT_1,
  });
  // A text at the contract's limit reaches the service, which answers
  // `too_long` for a body over the protocol's limit.
  const longest = "\u{1F600}".repeat(CHAT_LIMITS.sendText);
  fake.answerSend({ kind: "refused", reason: "too_long" });
  expect(invoke(send, [longest])).toEqual({
    outcome: "refused",
    reason: "too_long",
  });
  for (const reason of CHAT_SEND_REFUSALS) {
    fake.answerSend({ kind: "refused", reason });
    expect(invoke(send, ["Hello"])).toEqual({ outcome: "refused", reason });
  }
  expect(fake.calls.slice(0, 2)).toEqual([
    { method: "send", args: [text] },
    { method: "send", args: [longest] },
  ]);
});

test("retry and discard pass a valid event ID to the service and answer its result", () => {
  const fake = fakeServices();
  const { invoke } = register(fake);

  expect(invoke(INVOKE_CHANNELS.retryChatMessage, [EVENT_3])).toBe(true);
  expect(invoke(INVOKE_CHANNELS.retryChatMessage, [EVENT_1])).toBe(false);
  expect(invoke(INVOKE_CHANNELS.discardChatMessage, [EVENT_1])).toBe(true);
  expect(invoke(INVOKE_CHANNELS.discardChatMessage, [EVENT_2])).toBe(false);
  expect(fake.calls).toEqual([
    { method: "retry", args: [EVENT_3] },
    { method: "retry", args: [EVENT_1] },
    { method: "discard", args: [EVENT_1] },
    { method: "discard", args: [EVENT_2] },
  ]);
});

test("the view holds the authors' names, an unknown person's and an agent's included, and the waiting messages", () => {
  const fake = fakeServices();
  fake.rename(OTHER_AUTHOR, null);
  const { getState } = register(fake);

  expect(getState()).toEqual({
    status: "ready",
    revision: 0,
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    messages: [
      {
        id: id(0x1001),
        seq: 1,
        authorKind: "member",
        authorName: "Ada Lovelace",
        body: "Hello",
        createdAt: AT,
      },
      {
        id: id(0x1002),
        seq: 2,
        authorKind: "agent",
        authorName: UNKNOWN_AGENT_NAME,
        body: "From an agent",
        createdAt: AT,
      },
      {
        id: id(0x1003),
        seq: 3,
        authorKind: "member",
        authorName: UNKNOWN_MEMBER_NAME,
        body: "From a former member",
        createdAt: AT,
      },
    ],
    moreMessages: 0,
    older: "none",
    pending: [
      { eventId: EVENT_1, body: "Waiting", status: "waiting" },
      { eventId: EVENT_2, body: "Sending", status: "sending" },
      {
        eventId: EVENT_3,
        body: "Refused",
        status: "not_sent",
        reason: "rate_limited",
      },
    ],
    morePending: 0,
  });
});

test("no member ID, agent ID, user ID, device ID, or other key of the service crosses", () => {
  const leakyMessage = {
    ...message(1),
    userId: USER,
    deviceId: DEVICE,
  } as ChatMessage;
  const leakyCopy = {
    ...copy(EVENT_1, "Waiting"),
    userId: USER,
    deviceId: DEVICE,
  } as unknown as ChatPendingCopy;
  const fake = fakeServices(
    chatState({
      messages: Object.freeze([
        leakyMessage,
        message(2, "Agent", {
          kind: "agent",
          agentId: AGENT,
        } as ChatMessageAuthor),
      ]),
      pending: Object.freeze([leakyCopy]),
      // The service never holds these; a leak would cross here.
      ...({ key: { userId: USER, deviceId: DEVICE } } as object),
    }),
  );
  const { getState, subscribe } = register(fake);
  const { payloads } = subscribe();
  fake.rename(AUTHOR, "Ada King");
  fake.fire();

  const views = [
    chatView(fake.options.chat.state(), 0, fake.options.chat.authorName),
    getState(),
    ...payloads(),
  ];
  expect(views).toHaveLength(3);
  for (const view of views) {
    const text = JSON.stringify(view);
    for (const hidden of [AUTHOR, AGENT, USER, DEVICE]) {
      expect(text).not.toContain(hidden);
    }
    expect(Object.keys(view).sort()).toEqual([
      "messages",
      "moreMessages",
      "morePending",
      "older",
      "pending",
      "projectId",
      "revision",
      "status",
      "workspaceId",
    ]);
    for (const item of view.messages) {
      expect(Object.keys(item).sort()).toEqual([
        "authorKind",
        "authorName",
        "body",
        "createdAt",
        "id",
        "seq",
      ]);
    }
    expect(Object.keys(view.pending[0] ?? {}).sort()).toEqual([
      "body",
      "eventId",
      "status",
    ]);
  }
});

test("the view keeps the newest 1,000 held messages, the oldest first, with a count of the rest", () => {
  const held = messages(CHAT_LIMITS.messages + 30);
  const fake = fakeServices(chatState({ messages: held, hasOlder: true }));
  const { getState } = register(fake);
  const view = getState();

  expect(view.messages).toHaveLength(CHAT_LIMITS.messages);
  expect(view.messages[0]?.seq).toBe(31);
  expect(view.messages.at(-1)?.seq).toBe(CHAT_LIMITS.messages + 30);
  expect(view.moreMessages).toBe(30);
  expect(view.older).toBe("not_shown");

  // At the limit, nothing is left out, but no further page would show.
  fake.setState(chatState({ messages: messages(CHAT_LIMITS.messages) }));
  const atLimit = getState();
  expect(atLimit.moreMessages).toBe(0);
  expect(atLimit.older).toBe("none");
  fake.setState(
    chatState({ messages: messages(CHAT_LIMITS.messages), hasOlder: true }),
  );
  expect(getState().older).toBe("not_shown");
});

/** The body text of a view's held and waiting messages, in code units. */
function bodyText(view: ChatView): number {
  return [...view.messages, ...view.pending].reduce(
    (sum, item) => sum + item.body.length,
    0,
  );
}

test("the text budget holds the newest held messages within half of it, then the waiting messages, then more held messages, in UTF-16 code units", () => {
  const units = 16_000;
  const fit = Math.floor(CHAT_LIMITS.text / units);
  const half = CHAT_LIMITS.text / 2;
  const held = Object.freeze(
    Array.from({ length: fit + 5 }, (_, index) => bigMessage(index + 1, units)),
  );
  const fake = fakeServices(chatState({ messages: held, pending: [] }));
  const { getState } = register(fake);

  const view = getState();
  expect(view.messages).toHaveLength(fit);
  expect(view.messages[0]?.seq).toBe(6);
  expect(view.moreMessages).toBe(5);
  expect(view.older).toBe("not_shown");

  // An astral character is two code units, so half as many messages fit.
  const astral = Object.freeze(
    Array.from({ length: fit }, (_, index) =>
      bigMessage(index + 1, 2 * units, "\u{1F600}"),
    ),
  );
  fake.setState(chatState({ messages: astral, pending: [] }));
  expect(getState().messages).toHaveLength(Math.floor(fit / 2));

  // Waiting messages take their share before the held messages beyond their
  // half, so fewer held messages fit.
  fake.setState(
    chatState({
      messages: held,
      pending: Object.freeze([
        copy(EVENT_1, "y".repeat(units)),
        copy(EVENT_2, "z".repeat(units)),
      ]),
    }),
  );
  const withPending = getState();
  expect(withPending.pending).toHaveLength(2);
  expect(withPending.morePending).toBe(0);
  expect(withPending.messages).toHaveLength(fit - 2);
  expect(withPending.moreMessages).toBe(7);

  // A body that fits neither what the newer held messages left of their
  // half nor what the waiting messages left ends the list: no older message
  // skips it.
  const inHalf = Math.floor(half / units);
  const newer = (from: number) =>
    Array.from({ length: inHalf }, (_, index) =>
      bigMessage(from + index, units),
    );
  const waiting = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      copy(id(0x4000 + index), "w".repeat(units)),
    );
  fake.setState(
    chatState({
      messages: Object.freeze([
        message(1, "Small and old"),
        bigMessage(2, 2 * LIMITS.messageBody, "\u{1F600}"),
        ...newer(3),
      ]),
      pending: Object.freeze(waiting(fit)),
    }),
  );
  const crowded = getState();
  expect(crowded.pending).toHaveLength(
    Math.floor((CHAT_LIMITS.text - inHalf * units) / units),
  );
  expect(crowded.messages.map((item) => item.seq)).toEqual(
    newer(3).map((item) => item.seq),
  );
  expect(crowded.moreMessages).toBe(2);

  // The held messages after the waiting messages fill the budget exactly,
  // and no further: the waiting messages leave exactly the length of the
  // next held message, and the oldest, of one code unit, no longer fits.
  fake.setState(
    chatState({
      messages: Object.freeze([
        message(1, "a"),
        bigMessage(2, units),
        ...newer(3),
      ]),
      pending: Object.freeze([
        ...waiting(inHalf),
        copy(
          id(0x4100),
          "v".repeat(CHAT_LIMITS.text - (2 * inHalf + 1) * units),
        ),
      ]),
    }),
  );
  const exact = getState();
  expect(exact.messages.map((item) => item.seq)).toEqual([
    2,
    ...newer(3).map((item) => item.seq),
  ]);
  expect(exact.moreMessages).toBe(1);
  expect(exact.pending).toHaveLength(inHalf + 1);
  expect(bodyText(exact)).toBe(CHAT_LIMITS.text);
});

test("waiting messages beyond the budget or the count are left out from the end and counted", () => {
  const units = 16_000;
  const fit = Math.floor(CHAT_LIMITS.text / units);
  const pending = Object.freeze(
    Array.from({ length: MAX_PENDING_CHAT_MESSAGES }, (_, index) =>
      copy(id(0x4000 + index), "p".repeat(units)),
    ),
  );
  const fake = fakeServices(chatState({ pending }));
  const { getState } = register(fake);

  const view = getState();
  expect(view.pending.map((item) => item.eventId)).toEqual(
    pending.slice(0, fit).map((item) => item.eventId),
  );
  expect(view.morePending).toBe(MAX_PENDING_CHAT_MESSAGES - fit);
  // The held messages still show; they take only their own length of their
  // half.
  expect(view.messages).toHaveLength(3);
  expect(view.moreMessages).toBe(0);

  // A waiting message that fills the budget exactly shows.
  const exact = CHAT_LIMITS.text - fit * units;
  fake.setState(
    chatState({
      messages: Object.freeze([]),
      pending: Object.freeze([
        ...pending.slice(0, fit),
        copy(id(0x4100), "e".repeat(exact)),
        copy(id(0x4101), "Hi"),
      ]),
    }),
  );
  const filled = getState();
  expect(filled.pending).toHaveLength(fit + 1);
  expect(filled.morePending).toBe(1);
  expect(bodyText(filled)).toBe(CHAT_LIMITS.text);

  // The first waiting message that does not fit ends the list, also before
  // a shorter one that would fit.
  fake.setState(
    chatState({
      messages: Object.freeze([]),
      pending: Object.freeze([
        ...pending.slice(0, fit + 1),
        copy(id(0x4101), "Hi"),
      ]),
    }),
  );
  const blocked = getState();
  expect(blocked.pending.map((item) => item.eventId)).toEqual(
    pending.slice(0, fit).map((item) => item.eventId),
  );
  expect(blocked.morePending).toBe(2);

  // Small messages are capped by the count, which the service never
  // exceeds.
  const many = Object.freeze(
    Array.from({ length: CHAT_LIMITS.pending + 2 }, (_, index) =>
      copy(id(0x4000 + index), "Hi"),
    ),
  );
  fake.setState(chatState({ pending: many }));
  const capped = getState();
  expect(capped.pending).toHaveLength(CHAT_LIMITS.pending);
  expect(capped.morePending).toBe(2);
});

test("while the waiting messages alone exceed the budget, the held messages keep half of it, so the newest held message and the older page still show", () => {
  const units = 16_000;
  const half = CHAT_LIMITS.text / 2;
  const pending = Object.freeze(
    Array.from({ length: MAX_PENDING_CHAT_MESSAGES }, (_, index) =>
      copy(id(0x4000 + index), "p".repeat(units)),
    ),
  );
  expect(pending.length * units).toBeGreaterThan(CHAT_LIMITS.text);
  // The waiting messages keep what the held messages left, at least half,
  // the first ones in order; the later ones are counted, like those beyond
  // the budget.
  const expectKept = (view: ChatView, held: number) => {
    const kept = Math.floor((CHAT_LIMITS.text - held) / units);
    expect(view.pending.map((item) => item.eventId)).toEqual(
      pending.slice(0, kept).map((item) => item.eventId),
    );
    expect(view.morePending).toBe(MAX_PENDING_CHAT_MESSAGES - kept);
    expect(bodyText(view)).toBe(held + kept * units);
  };

  // Held messages beyond their half: the newest ones that fit it show, the
  // newest at its longest, astral characters; the older ones are counted,
  // and no older page is offered.
  const longestBody = 2 * LIMITS.messageBody;
  const inHalf = Math.floor(half / longestBody);
  const long = Object.freeze(
    Array.from({ length: 20 }, (_, index) =>
      bigMessage(index + 1, longestBody, "\u{1F600}"),
    ),
  );
  const fake = fakeServices(
    chatState({ messages: long, pending, hasOlder: true }),
  );
  const { getState, invoke } = register(fake);
  const loadOlder = () => invoke(INVOKE_CHANNELS.loadOlderChatMessages);
  const beyond = getState();
  expect(beyond.messages.map((item) => item.seq)).toEqual(
    long.slice(-inHalf).map((item) => item.seq),
  );
  expect(beyond.moreMessages).toBe(long.length - inHalf);
  expect(beyond.older).toBe("not_shown");
  expect(loadOlder()).toBe("none");
  expectKept(beyond, inHalf * longestBody);

  // While all held messages fit their half, here a full page that fills it,
  // they all show, and the older page stays on offer and loads.
  const page = Object.freeze(
    Array.from({ length: MESSAGE_PAGE_LIMIT }, (_, index) =>
      bigMessage(index + 1, half / MESSAGE_PAGE_LIMIT),
    ),
  );
  fake.setState(chatState({ messages: page, pending, hasOlder: true }));
  const fitting = getState();
  expect(fitting.messages.map((item) => item.seq)).toEqual(
    page.map((item) => item.seq),
  );
  expect(fitting.moreMessages).toBe(0);
  expect(fitting.older).toBe("available");
  expectKept(fitting, half);
  expect(loadOlder()).toBe("started");

  // The reserve holds only held messages: without any, the waiting messages
  // use the whole budget.
  fake.setState(chatState({ messages: Object.freeze([]), pending }));
  const alone = getState();
  expect(alone.messages).toHaveLength(0);
  expectKept(alone, 0);

  // So a new held message can push out waiting messages that were shown;
  // they are counted.
  fake.setState(
    chatState({
      messages: Object.freeze([long[0] as ChatMessage]),
      pending,
    }),
  );
  const pushed = getState();
  expect(pushed.messages).toHaveLength(1);
  expect(pushed.pending.length).toBeLessThan(alone.pending.length);
  expectKept(pushed, longestBody);
});

test("a worst-case chat crosses within the budget and passes the contract", () => {
  // Every body at the protocol's limit, of astral characters: two code
  // units each. The strings are shared, so the test stays small.
  const body = "\u{1F600}".repeat(LIMITS.messageBody);
  const held = Object.freeze(
    Array.from(
      { length: 2_000 },
      (_, index) =>
        Object.freeze({
          ...message(1),
          id: id(0x5000 + index),
          seq: index + 1,
          body,
        }) as ChatMessage,
    ),
  );
  const pending = Object.freeze(
    Array.from({ length: MAX_PENDING_CHAT_MESSAGES }, (_, index) =>
      copy(id(0x4000 + index), body),
    ),
  );
  const view = chatView(
    chatState({ messages: held, pending, hasOlder: true }),
    0,
    () => "Ada Lovelace",
  );

  const text = [...view.messages, ...view.pending].reduce(
    (sum, item) => sum + item.body.length,
    0,
  );
  expect(text).toBeLessThanOrEqual(CHAT_LIMITS.text);
  expect(view.pending.length + view.morePending).toBe(
    MAX_PENDING_CHAT_MESSAGES,
  );
  expect(view.messages.length + view.moreMessages).toBe(2_000);
  expect(ChatViewSchema.parse(view)).toEqual(view);
});

test("a view at every limit at once holds 500,000 code units of body text and less than 1.5 MB in all", () => {
  // 1,000 held and 50 waiting messages, with bodies of a two-byte character
  // that fill the budget: 1,000 held messages of 50 code units within their
  // half, and 50 waiting messages of 9,000. Every other string is at its
  // longest: names of 64 astral characters, the longest status, problem,
  // older state, and reason; and every number is beyond the small integers
  // that V8 writes in fewer bytes: the revision and each `seq` up to the
  // largest safe integer.
  const count = CHAT_LIMITS.messages + 200;
  const held = Object.freeze(
    Array.from(
      { length: count },
      (_, index) =>
        Object.freeze({
          ...bigMessage(index + 1, 50, "\u4e00"),
          seq: Number.MAX_SAFE_INTEGER - count + 1 + index,
        }) as ChatMessage,
    ),
  );
  const pending = Object.freeze(
    Array.from({ length: MAX_PENDING_CHAT_MESSAGES }, (_, index) =>
      notSent(id(0x4000 + index), "\u4e00".repeat(9_000), "not_sendable"),
    ),
  );
  const view = chatView(
    chatState({
      status: "unavailable",
      problem: "not_signed_in",
      messages: held,
      hasOlder: true,
      olderProblem: "not_signed_in",
      pending,
    }),
    Number.MAX_SAFE_INTEGER,
    () => "\u{1F600}".repeat(CHAT_LIMITS.authorName),
  );
  expect(view.messages).toHaveLength(CHAT_LIMITS.messages);
  expect(view.messages.at(-1)?.seq).toBe(Number.MAX_SAFE_INTEGER);
  expect(view.pending).toHaveLength(CHAT_LIMITS.pending);
  expect(ChatViewSchema.parse(view)).toEqual(view);

  const strings = (value: unknown): number =>
    typeof value === "string"
      ? value.length
      : typeof value === "object" && value !== null
        ? Object.values(value).reduce<number>(
            (sum, item) => sum + strings(item),
            0,
          )
        : 0;
  const body = [...view.messages, ...view.pending].reduce(
    (sum, item) => sum + item.body.length,
    0,
  );
  expect(body).toBe(CHAT_LIMITS.text);
  expect(strings(view) - body).toBeLessThanOrEqual(200_000);
  // IPC carries the view with the structured clone algorithm, as V8
  // serializes it.
  expect(serialize(view).length).toBeLessThan(1_500_000);
});

test("older pages are offered only while the view can show them, and load-older asks the service only then", () => {
  const fake = fakeServices(chatState({ hasOlder: true }));
  const { getState, invoke } = register(fake);
  const loadOlder = () => invoke(INVOKE_CHANNELS.loadOlderChatMessages);

  expect(getState().older).toBe("available");
  expect(loadOlder()).toBe("started");
  fake.answerLoadOlder("busy");
  fake.setState(chatState({ hasOlder: true, loadingOlder: true }));
  expect(getState().older).toBe("loading");
  expect(loadOlder()).toBe("busy");
  fake.setState(chatState({ hasOlder: true, olderProblem: "rate_limited" }));
  const failed = getState();
  expect(failed.older).toBe("available");
  expect(failed.olderProblem).toBe("rate_limited");
  // Nothing older loads nothing, without a read.
  fake.setState(chatState({ hasOlder: false }));
  expect(getState().older).toBe("none");
  expect(loadOlder()).toBe("none");
  expect(
    fake.calls.filter(({ method }) => method === "loadOlder"),
  ).toHaveLength(2);

  // A full view loads nothing more, without a read.
  fake.setState(
    chatState({ messages: messages(CHAT_LIMITS.messages + 1), hasOlder: true }),
  );
  fake.answerLoadOlder("started");
  expect(getState().older).toBe("not_shown");
  expect(loadOlder()).toBe("none");
  expect(
    fake.calls.filter(({ method }) => method === "loadOlder"),
  ).toHaveLength(2);
});

test("after an older page did not load, load-older answers too_soon without a read until the backoff has passed", () => {
  const fake = fakeServices(chatState({ hasOlder: true }));
  const { invoke } = register(fake);
  const loadOlder = () => invoke(INVOKE_CHANNELS.loadOlderChatMessages);
  const reads = () =>
    fake.calls.filter(({ method }) => method === "loadOlder").length;
  /** An older page on its way, which then ends with `problem`, or loads. */
  const olderPage = (problem?: ChatState["olderProblem"]) => {
    fake.setState(chatState({ hasOlder: true, loadingOlder: true }));
    fake.setState(
      chatState(
        problem === undefined
          ? { hasOlder: true }
          : { hasOlder: true, olderProblem: problem },
      ),
    );
  };

  fake.setClock(1_000);
  olderPage("unavailable");
  fake.setClock(2_999);
  expect(loadOlder()).toBe("too_soon");
  expect(reads()).toBe(0);
  fake.setClock(3_000);
  expect(loadOlder()).toBe("started");
  expect(reads()).toBe(1);

  // The second failure in a row waits twice as long.
  olderPage("failed");
  fake.setClock(6_999);
  expect(loadOlder()).toBe("too_soon");
  fake.setClock(7_000);
  expect(loadOlder()).toBe("started");

  // After rate_limited, a minute.
  olderPage("rate_limited");
  fake.setClock(66_999);
  expect(loadOlder()).toBe("too_soon");
  fake.setClock(67_000);
  expect(loadOlder()).toBe("started");
  expect(reads()).toBe(3);

  // A page that loads starts the count again, and without a problem there
  // is no wait.
  olderPage();
  expect(loadOlder()).toBe("started");
  olderPage("unavailable");
  fake.setClock(68_999);
  expect(loadOlder()).toBe("too_soon");
  fake.setClock(69_000);
  expect(loadOlder()).toBe("started");
  expect(reads()).toBe(5);
});

test("the count of failed older pages starts again in another project and after a sign-out", () => {
  const fake = fakeServices(chatState({ hasOlder: true }));
  const { invoke } = register(fake);
  const loadOlder = () => invoke(INVOKE_CHANNELS.loadOlderChatMessages);
  /** An older page of `projectId` on its way, which then fails. */
  const failedPage = (projectId: ProjectId, at: number) => {
    fake.setClock(at);
    fake.setState(chatState({ projectId, hasOlder: true, loadingOlder: true }));
    fake.setState(
      chatState({ projectId, hasOlder: true, olderProblem: "unavailable" }),
    );
  };

  // Five failures in a row in one project: the fifth waits 32 s, and a
  // sixth would wait 60 s.
  for (let index = 0; index < 5; index += 1) {
    failedPage(PROJECT, index * 100_000);
  }
  fake.setClock(400_000 + 31_999);
  expect(loadOlder()).toBe("too_soon");
  fake.setClock(400_000 + 32_000);
  expect(loadOlder()).toBe("started");

  // The first failure in another project waits 2 s, not 60 s.
  fake.setState(chatState({ projectId: OTHER_PROJECT, hasOlder: true }));
  failedPage(OTHER_PROJECT, 500_000);
  fake.setClock(502_000);
  expect(loadOlder()).toBe("started");

  // Again after a sign-out and a sign-in to the same project.
  for (let index = 0; index < 5; index += 1) {
    failedPage(PROJECT, 600_000 + index * 100_000);
  }
  fake.setState(NO_PROJECT);
  fake.setState(chatState({ hasOlder: true }));
  failedPage(PROJECT, 1_200_000);
  fake.setClock(1_201_999);
  expect(loadOlder()).toBe("too_soon");
  fake.setClock(1_202_000);
  expect(loadOlder()).toBe("started");
});

test("author names are cut to their limit in characters", () => {
  const face = "\u{1F600}";
  const fake = fakeServices(chatState({ pending: [] }));
  fake.rename(AUTHOR, face.repeat(CHAT_LIMITS.authorName + 3));
  const { getState } = register(fake);

  expect(getState().messages[0]?.authorName).toBe(
    face.repeat(CHAT_LIMITS.authorName),
  );
});

test("the view is a frozen copy that shares no object with the service's state", () => {
  const state = chatState();
  const view = chatView(state, 7, () => "Ada Lovelace");

  expect(view.revision).toBe(7);
  expect(Object.isFrozen(view)).toBe(true);
  for (const list of [view.messages, view.pending]) {
    expect(Object.isFrozen(list)).toBe(true);
    for (const item of list) {
      expect(Object.isFrozen(item)).toBe(true);
    }
  }
  expect(view.messages).not.toBe(state.messages);
  expect(view.messages[0]).not.toBe(state.messages[0]);
  expect(view.pending).not.toBe(state.pending);
  expect(view.pending[0]).not.toBe(state.pending[0]);
});

test("a burst of changes publishes once, after the interval, with the last state", () => {
  const fake = fakeServices(NO_PROJECT);
  const { subscribe, getState } = register(fake);
  const { first, payloads } = subscribe();
  expect(first.status).toBe("no_project");
  expect(first.revision).toBe(0);

  fake.setState(chatState({ status: "loading", messages: [] }));
  expect(fake.timers).toHaveLength(1);
  const [timer] = fake.timers;
  expect(timer?.delayMs).toBe(CHAT_PUBLISH_INTERVAL_MS);
  // The later changes of the burst neither cancel the timer nor add one:
  // the first change sets when the view goes out.
  fake.setState(chatState({ messages: messages(2) }));
  fake.rename(AUTHOR, "Ada King");
  fake.setState(chatState({ messages: messages(5) }));
  expect(payloads()).toEqual([]);
  expect(fake.timers).toEqual([timer]);
  expect(timer?.cancelled).toBe(false);
  // A call meanwhile already answers with the latest view.
  expect(getState().revision).toBe(4);

  fake.fire();
  expect(payloads()).toHaveLength(1);
  const [sent] = payloads();
  expect(sent?.revision).toBe(4);
  expect(sent?.messages).toHaveLength(5);
  expect(sent?.messages[0]?.authorName).toBe("Ada King");

  // The next change waits for its own interval.
  fake.setState(chatState({ messages: messages(1) }));
  expect(fake.waiting()).toHaveLength(1);
  fake.fire();
  expect(payloads().map((view) => view.revision)).toEqual([4, 5]);
  expect(payloads()[1]?.messages).toHaveLength(1);
  expect(fake.errors).toEqual([]);
});

test("close cancels the waiting publish and stops listening", () => {
  const fake = fakeServices();
  const { subscribe, chatIpc } = register(fake);
  const { payloads } = subscribe();
  fake.setState(chatState({ messages: messages(2) }));
  const [timer] = fake.waiting();

  chatIpc.close();
  expect(timer?.cancelled).toBe(true);
  expect(fake.chatListeners.size).toBe(0);
  expect(fake.workspaceListeners.size).toBe(0);
  timer?.callback();
  fake.fire();
  expect(payloads()).toEqual([]);
  chatIpc.close();
});

test("a view that the contract refuses is reported, not sent, and later views go out", () => {
  const fake = fakeServices();
  const { subscribe } = register(fake);
  const { payloads } = subscribe();
  fake.setState(
    chatState({
      messages: Object.freeze([
        { ...message(1), id: "not-an-id" },
      ]) as unknown as readonly ChatMessage[],
    }),
  );
  fake.fire();

  expect(payloads()).toEqual([]);
  expect(fake.errors).toEqual(["Sending the chat state failed."]);

  fake.setState(chatState());
  expect(fake.waiting()).toHaveLength(1);
  fake.fire();
  expect(payloads().map((view) => view.revision)).toEqual([2]);
  expect(fake.errors).toHaveLength(1);
});

test("getState answers without subscribing the caller", () => {
  const fake = fakeServices();
  const { invoke } = register(fake);
  const caller = receiver();

  expect(
    (invoke(INVOKE_CHANNELS.getChatState, [], caller) as ChatView).revision,
  ).toBe(0);
  fake.setState(chatState({ messages: messages(2) }));
  fake.fire();

  expect(caller.sent).toEqual([]);
});

test("an unavailable chat crosses with its problem, and every status crosses", () => {
  const fake = fakeServices(
    chatState({ status: "unavailable", problem: "rate_limited" }),
  );
  const { getState } = register(fake);
  const view = getState();
  expect(view.status).toBe("unavailable");
  expect(view.status === "unavailable" && view.problem).toBe("rate_limited");

  // The record fails to compile when the service's statuses change.
  const statuses: Readonly<Record<ChatServiceStatus, true>> = {
    no_project: true,
    loading: true,
    ready: true,
    unavailable: true,
  };
  expect(Object.keys(statuses).sort()).toEqual([...CHAT_STATUSES].sort());
  for (const status of CHAT_STATUSES) {
    const problem = status === "unavailable" ? { problem: "failed" } : {};
    const crossed = chatView(
      chatState({ status, ...problem } as Partial<ChatState>),
      0,
      () => "Ada Lovelace",
    );
    expect(crossed.status).toBe(status);
    expect(ChatViewSchema.parse(crossed)).toEqual(crossed);
  }
});

test("the contract's limits, problems, and reasons match the service and the protocol", () => {
  expect(CHAT_LIMITS.body).toBe(LIMITS.messageBody);
  expect(CHAT_LIMITS.authorName).toBe(LIMITS.displayName);
  expect(CHAT_LIMITS.authorName).toBeGreaterThanOrEqual(
    UNKNOWN_MEMBER_NAME.length,
  );
  expect(CHAT_LIMITS.authorName).toBeGreaterThanOrEqual(
    UNKNOWN_AGENT_NAME.length,
  );
  expect(CHAT_LIMITS.pending).toBe(MAX_PENDING_CHAT_MESSAGES);
  // A full page of the history always fits the count.
  expect(CHAT_LIMITS.messages).toBeGreaterThanOrEqual(MESSAGE_PAGE_LIMIT);
  // A body at the limit whose line breaks came as CR LF still crosses.
  expect(CHAT_LIMITS.sendText).toBeGreaterThanOrEqual(2 * LIMITS.messageBody);
  // Held and waiting messages may each use at least half the budget, and
  // one body at the limit, even of astral characters, fits half.
  expect(CHAT_HELD_TEXT_RESERVE).toBe(CHAT_LIMITS.text / 2);
  expect(CHAT_LIMITS.text / 2).toBeGreaterThanOrEqual(2 * LIMITS.messageBody);
  expect([...CHAT_PROBLEMS]).toEqual([...WORKSPACE_READ_FAILURES]);
  expect([...CHAT_NOT_SENT_REASONS]).toEqual([
    ...EVENT_REFUSAL_CODES,
    "not_sendable",
  ]);
  // The record fails to compile when the service's refusals change, and
  // the comparison fails when the contract's differ.
  const refusals = {
    blank: true,
    too_long: true,
    invalid_characters: true,
    too_many_pending: true,
    no_project: true,
  } satisfies Record<
    Extract<ChatSendResult, { kind: "refused" }>["reason"],
    true
  > &
    Record<ChatSendRefusal, true>;
  expect(Object.keys(refusals).sort()).toEqual([...CHAT_SEND_REFUSALS].sort());
});
