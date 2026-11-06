import { expect, test } from "vitest";
import type { ChatBridge } from "../shared/desktop-bridge.ts";
import {
  CHAT_LIMITS,
  CHAT_LOAD_OLDER_RESULTS,
  CHAT_NOT_SENT_REASONS,
  CHAT_PROBLEMS,
  CHAT_SEND_REFUSALS,
  ChatSendTextSchema,
  type ChatLoadOlderResultView,
  type ChatSendResultView,
  type ChatView,
} from "../shared/ipc-contract.ts";
import {
  CHAT_MESSAGES,
  CHAT_PROBLEM_MESSAGES,
  composerKeyAction,
  createChatScreen,
  describeChatScreen,
  describeMoreMessages,
  describeMorePending,
  describeOlder,
  EMPTY_COMPOSER,
  formatChatTime,
  initialChatScreenView,
  isOverSendLimit,
  LOAD_OLDER_MESSAGES,
  NOT_SENT_REASON_MESSAGES,
  OLDER_PROBLEM_MESSAGES,
  pendingRow,
  SEND_REFUSAL_MESSAGES,
  SEND_TEXT_LIMIT,
  type ChatComposer,
  type ChatLists,
  type ChatScreenView,
} from "./chat-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b1";
const OTHER_PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b2";
const EVENT_A = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e1";
const EVENT_B = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e2";

const MESSAGE = Object.freeze({
  id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d1",
  seq: 1,
  authorKind: "member",
  authorName: "Ada",
  body: "Hello",
  createdAt: "2026-11-06T08:00:00.000Z",
} as const);

const READY: ChatView = {
  revision: 5,
  status: "ready",
  workspaceId: WORKSPACE,
  projectId: PROJECT,
  messages: [MESSAGE],
  moreMessages: 0,
  older: "none",
  pending: [],
  morePending: 0,
};

const EMPTY: Partial<ChatView> = {
  messages: [],
  moreMessages: 0,
  older: "none",
  pending: [],
  morePending: 0,
};

function known(overrides: Partial<ChatView> = {}): ChatScreenView {
  return { kind: "known", state: { ...READY, ...overrides } as ChatView };
}

test("before the first state, the view waits with the bridge and is unavailable without it", () => {
  expect(initialChatScreenView(true)).toEqual({ kind: "pending" });
  expect(initialChatScreenView(false)).toEqual({ kind: "unavailable" });
});

test("each state without anything to list has its own text, and only the shown project open in the main process takes a message", () => {
  const cases: [ChatScreenView, string, string, boolean][] = [
    [{ kind: "unavailable" }, PROJECT, CHAT_MESSAGES.unavailable, false],
    [{ kind: "pending" }, PROJECT, CHAT_MESSAGES.pending, false],
    // No project open in the main process, or no signed-in device.
    [
      known({
        status: "no_project",
        workspaceId: null,
        projectId: null,
        ...EMPTY,
      }),
      PROJECT,
      CHAT_MESSAGES.noProject,
      false,
    ],
    // Another project's chat is never shown, and nothing is sent to it.
    [known(), OTHER_PROJECT, CHAT_MESSAGES.loading, false],
    [
      known({ status: "loading", ...EMPTY }),
      PROJECT,
      CHAT_MESSAGES.loading,
      true,
    ],
    [
      known({ status: "unavailable", problem: "failed", ...EMPTY }),
      PROJECT,
      CHAT_PROBLEM_MESSAGES.failed,
      true,
    ],
  ];

  for (const [view, projectId, status, canWrite] of cases) {
    expect(describeChatScreen(view, projectId)).toEqual({
      status,
      lists: null,
      canWrite,
    });
  }
  expect(CHAT_MESSAGES.noProject).toContain("signed in");
});

test("a ready chat lists its messages with an empty status, also when it holds none", () => {
  expect(describeChatScreen(known(), PROJECT)).toEqual({
    status: "",
    lists: {
      messages: [MESSAGE],
      moreMessages: 0,
      older: "none",
      olderProblem: undefined,
      pending: [],
      morePending: 0,
    },
    canWrite: true,
  });
  expect(describeChatScreen(known(EMPTY), PROJECT).lists).toEqual({
    messages: [],
    moreMessages: 0,
    older: "none",
    olderProblem: undefined,
    pending: [],
    morePending: 0,
  });
});

test("a loading or unavailable chat keeps what it holds, with its text", () => {
  const pending = [
    { eventId: EVENT_A, body: "Hi", status: "waiting" },
  ] as const;
  const loading = describeChatScreen(
    known({ status: "loading", ...EMPTY, pending }),
    PROJECT,
  );
  expect(loading.status).toBe(CHAT_MESSAGES.loading);
  expect(loading.lists?.pending.map((row) => row.eventId)).toEqual([EVENT_A]);

  for (const problem of CHAT_PROBLEMS) {
    const model = describeChatScreen(
      known({ status: "unavailable", problem, olderProblem: "rate_limited" }),
      PROJECT,
    );
    expect(model.status).toBe(CHAT_PROBLEM_MESSAGES[problem]);
    expect(model.lists?.messages).toEqual([MESSAGE]);
    expect(model.lists?.olderProblem).toBe(OLDER_PROBLEM_MESSAGES.rate_limited);
    expect(model.canWrite).toBe(true);
  }
});

test("a waiting message can be discarded, one that is not sent tried again too, and one being sent neither", () => {
  expect(
    pendingRow({ eventId: EVENT_A, body: "a", status: "waiting" }),
  ).toEqual({
    eventId: EVENT_A,
    body: "a",
    status: "waiting",
    statusLabel: "Waiting for the connection",
    reason: undefined,
    canRetry: false,
    canDiscard: true,
  });
  expect(
    pendingRow({ eventId: EVENT_A, body: "a", status: "sending" }),
  ).toMatchObject({
    statusLabel: "Sending…",
    reason: undefined,
    canRetry: false,
    canDiscard: false,
  });
  for (const reason of CHAT_NOT_SENT_REASONS) {
    expect(
      pendingRow({ eventId: EVENT_B, body: "b", status: "not_sent", reason }),
    ).toMatchObject({
      statusLabel: "Not sent",
      reason: NOT_SENT_REASON_MESSAGES[reason],
      canRetry: true,
      canDiscard: true,
    });
  }
});

test("every closed list of the contract has its text", () => {
  expect(Object.keys(CHAT_PROBLEM_MESSAGES).sort()).toEqual(
    [...CHAT_PROBLEMS].sort(),
  );
  expect(Object.keys(OLDER_PROBLEM_MESSAGES).sort()).toEqual(
    [...CHAT_PROBLEMS].sort(),
  );
  expect(Object.keys(SEND_REFUSAL_MESSAGES).sort()).toEqual(
    [...CHAT_SEND_REFUSALS].sort(),
  );
  expect(Object.keys(NOT_SENT_REASON_MESSAGES).sort()).toEqual(
    [...CHAT_NOT_SENT_REASONS].sort(),
  );
  expect(Object.keys(LOAD_OLDER_MESSAGES).sort()).toEqual(
    [...CHAT_LOAD_OLDER_RESULTS].sort(),
  );
  // The limit in the text is the contract's.
  expect(SEND_REFUSAL_MESSAGES.too_long).toContain(
    `${CHAT_LIMITS.body.toLocaleString("en-US")} characters`,
  );
});

function lists(overrides: Partial<ChatLists> = {}): ChatLists {
  return {
    messages: [MESSAGE],
    moreMessages: 0,
    older: "none",
    olderProblem: undefined,
    pending: [],
    morePending: 0,
    ...overrides,
  };
}

test("the note about older messages follows the older state and the left-out count", () => {
  expect(describeOlder(lists())).toBe(CHAT_MESSAGES.startOfChat);
  expect(describeOlder(lists({ messages: [] }))).toBeUndefined();
  expect(describeOlder(lists({ older: "available" }))).toBeUndefined();
  expect(describeOlder(lists({ older: "loading" }))).toBeUndefined();
  expect(describeOlder(lists({ older: "not_shown" }))).toBe(
    CHAT_MESSAGES.olderNotShown,
  );
  expect(describeOlder(lists({ older: "not_shown", moreMessages: 3 }))).toBe(
    "3 older messages are not shown.",
  );
  expect(describeMoreMessages(1)).toBe("1 older message is not shown.");
  expect(describeMorePending(1)).toBe("1 more waiting message is not shown.");
  expect(describeMorePending(2)).toBe("2 more waiting messages are not shown.");
});

test("a time is shown in the given format, and a value that is not a date stays as it is", () => {
  const format = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
  expect(formatChatTime(MESSAGE.createdAt, format)).toBe(
    format.format(new Date(MESSAGE.createdAt)),
  );
  expect(formatChatTime("not a date", format)).toBe("not a date");
});

test("Enter sends; Shift+Enter, Enter during a composition, and other keys do not", () => {
  const key = (key: string, shiftKey = false, isComposing = false) =>
    composerKeyAction({ key, shiftKey, isComposing });

  expect(key("Enter")).toBe("send");
  expect(key("Enter", true)).toBe("none");
  expect(key("Enter", false, true)).toBe("none");
  expect(key("a")).toBe("none");
  expect(key("Tab")).toBe("none");
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** A chat bridge that the test drives, and a screen controller on it. */
function harness() {
  const fake = {
    listener: undefined as ((state: ChatView) => void) | undefined,
    onError: undefined as (() => void) | undefined,
    ended: 0,
    sends: [] as { text: string; answer: Deferred<ChatSendResultView> }[],
    retries: [] as string[],
    discards: [] as string[],
    olderAsks: [] as Deferred<ChatLoadOlderResultView>[],
    failActions: false,
  };
  const bridge = {
    subscribeState: (
      listener: (state: ChatView) => void,
      onError?: () => void,
    ) => {
      fake.listener = listener;
      fake.onError = onError;
      return () => {
        fake.ended += 1;
      };
    },
    send: (text: string) => {
      const answer = deferred<ChatSendResultView>();
      fake.sends.push({ text, answer });
      return answer.promise;
    },
    retry: (eventId: string) => {
      fake.retries.push(eventId);
      return fake.failActions
        ? Promise.reject(new Error("refused"))
        : Promise.resolve(true);
    },
    discard: (eventId: string) => {
      fake.discards.push(eventId);
      return fake.failActions
        ? Promise.reject(new Error("refused"))
        : Promise.resolve(false);
    },
    loadOlder: () => {
      const answer = deferred<ChatLoadOlderResultView>();
      fake.olderAsks.push(answer);
      return answer.promise;
    },
  } satisfies Pick<
    ChatBridge,
    "subscribeState" | "send" | "retry" | "discard" | "loadOlder"
  >;
  const screen = {
    views: [] as ChatScreenView[],
    composers: [] as ChatComposer[],
    notices: [] as (string | undefined)[],
  };
  const controller = createChatScreen(
    bridge,
    (view) => screen.views.push(view),
    (composer) => screen.composers.push(composer),
    (notice) => screen.notices.push(notice),
  );
  return { fake, screen, controller };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("every state becomes the view, a refused subscription makes it unavailable, and the function from start ends the subscription", () => {
  const { fake, screen, controller } = harness();
  const stop = controller.start();

  fake.listener?.(READY);
  fake.onError?.();
  expect(screen.views).toEqual([
    { kind: "known", state: READY },
    { kind: "unavailable" },
  ]);
  expect(fake.ended).toBe(0);
  stop();
  expect(fake.ended).toBe(1);
});

test("a send passes the text on as it is, keeps it unchangeable until the answer, and clears it only when accepted", async () => {
  const { fake, screen, controller } = harness();
  controller.start();
  const text = "  First line\r\nSecond line  ";

  controller.textChanged(text);
  controller.send();
  expect(fake.sends.map((call) => call.text)).toEqual([text]);
  expect(screen.composers.at(-1)).toEqual({
    text,
    sending: true,
    notice: undefined,
  });

  // While the answer waits, the text stays and no second send goes out.
  controller.textChanged("changed");
  controller.send();
  expect(fake.sends).toHaveLength(1);
  expect(screen.composers.at(-1)?.text).toBe(text);

  fake.sends[0]?.answer.resolve({ outcome: "accepted", eventId: EVENT_A });
  await settle();
  expect(screen.composers.at(-1)).toBe(EMPTY_COMPOSER);
});

test("a refused send keeps the text and shows the refusal's fixed text until the text changes", async () => {
  for (const reason of CHAT_SEND_REFUSALS) {
    const { fake, screen, controller } = harness();
    controller.start();

    controller.textChanged("Hello");
    controller.send();
    fake.sends[0]?.answer.resolve({ outcome: "refused", reason });
    await settle();
    expect(screen.composers.at(-1)).toEqual({
      text: "Hello",
      sending: false,
      notice: SEND_REFUSAL_MESSAGES[reason],
    });

    controller.textChanged("Hello!");
    expect(screen.composers.at(-1)).toEqual({
      text: "Hello!",
      sending: false,
      notice: undefined,
    });
  }
});

test("a failed send keeps the text, and an answer after the end of the subscription changes nothing", async () => {
  const { fake, screen, controller } = harness();
  const stop = controller.start();

  controller.textChanged("Hello");
  controller.send();
  fake.sends[0]?.answer.reject(new Error("The main process did not answer."));
  await settle();
  expect(screen.composers.at(-1)).toEqual({
    text: "Hello",
    sending: false,
    notice: CHAT_MESSAGES.sendFailed,
  });

  controller.send();
  const count = screen.composers.length;
  stop();
  fake.sends[1]?.answer.resolve({ outcome: "accepted", eventId: EVENT_A });
  await settle();
  expect(screen.composers).toHaveLength(count);
});

test("retry and discard pass the event ID on, and a refused call is swallowed", async () => {
  const { fake, screen, controller } = harness();
  controller.start();

  controller.retry(EVENT_A);
  controller.discard(EVENT_B);
  fake.failActions = true;
  controller.retry(EVENT_B);
  controller.discard(EVENT_A);
  await settle();

  expect(fake.retries).toEqual([EVENT_A, EVENT_B]);
  expect(fake.discards).toEqual([EVENT_B, EVENT_A]);
  expect(screen.composers).toEqual([]);
  expect(screen.notices).toEqual([]);
});

test("loading older messages asks one at a time and shows the text of its answer until a newer state", async () => {
  const { fake, screen, controller } = harness();
  controller.start();
  fake.listener?.(READY);

  controller.loadOlder();
  controller.loadOlder();
  expect(fake.olderAsks).toHaveLength(1);
  fake.olderAsks[0]?.resolve("too_soon");
  await settle();
  expect(screen.notices).toEqual([undefined, LOAD_OLDER_MESSAGES.too_soon]);

  // The same revision again keeps it; a newer one clears it.
  fake.listener?.(READY);
  expect(screen.notices.at(-1)).toBe(LOAD_OLDER_MESSAGES.too_soon);
  fake.listener?.({ ...READY, revision: READY.revision + 1 });
  expect(screen.notices.at(-1)).toBeUndefined();

  controller.loadOlder();
  expect(fake.olderAsks).toHaveLength(2);
  fake.olderAsks[1]?.resolve("started");
  await settle();
  expect(screen.notices.at(-1)).toBeUndefined();

  controller.loadOlder();
  fake.olderAsks[2]?.reject(new Error("The main process did not answer."));
  await settle();
  expect(screen.notices.at(-1)).toBe(CHAT_MESSAGES.loadOlderFailed);
  expect(LOAD_OLDER_MESSAGES.started).toBeUndefined();
  expect(LOAD_OLDER_MESSAGES.busy).toBeUndefined();
});

test("the send limit is the contract's, counted in characters as the bridge counts them", () => {
  expect(SEND_TEXT_LIMIT).toBe(CHAT_LIMITS.sendText);
  for (const text of [
    "",
    "x".repeat(SEND_TEXT_LIMIT),
    "x".repeat(SEND_TEXT_LIMIT + 1),
    "😀".repeat(SEND_TEXT_LIMIT),
    "😀".repeat(SEND_TEXT_LIMIT + 1),
    `${"😀".repeat(SEND_TEXT_LIMIT - 1)}xy`,
  ]) {
    expect(isOverSendLimit(text)).toBe(
      !ChatSendTextSchema.safeParse(text).success,
    );
  }
});

test("a text longer than the bridge takes shows the too-long refusal without a call, and keeps the text", async () => {
  const { fake, screen, controller } = harness();
  controller.start();
  const text = "x".repeat(SEND_TEXT_LIMIT + 1);

  controller.textChanged(text);
  controller.send();
  await settle();
  expect(fake.sends).toEqual([]);
  expect(screen.composers.at(-1)).toEqual({
    text,
    sending: false,
    notice: SEND_REFUSAL_MESSAGES.too_long,
  });

  // A text at the limit goes to the main process, which decides.
  controller.textChanged("😀".repeat(SEND_TEXT_LIMIT));
  controller.send();
  expect(fake.sends).toHaveLength(1);
});
