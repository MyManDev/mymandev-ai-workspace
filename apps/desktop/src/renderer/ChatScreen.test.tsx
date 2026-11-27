// The content component uses no hooks, so the tests render it with
// react-dom/server for the markup, and call it as a function to walk the
// returned elements and invoke their event handlers.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type {
  AgentActivityView,
  ChatPendingView,
  ChatView,
  ProjectRepositoriesView,
  ProviderConnectionListView,
} from "../shared/ipc-contract.ts";
import {
  ChatScreenContent,
  type ChatRunProps,
  type ChatScreenActions,
  type ChatScreenContentProps,
} from "./ChatScreen.tsx";
import {
  IDLE_RUN_REQUEST,
  NO_REPOSITORY,
  RUN_REQUEST_MESSAGES,
  type RunRequestController,
  type RunRequestState,
} from "./run-request-view.ts";
import {
  CHAT_MESSAGES,
  CHAT_PROBLEM_MESSAGES,
  EMPTY_COMPOSER,
  formatChatTime,
  LOAD_OLDER_MESSAGES,
  NOT_SENT_REASON_MESSAGES,
  OLDER_PROBLEM_MESSAGES,
  SEND_REFUSAL_MESSAGES,
  type ChatScreenView,
} from "./chat-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b1";
const OTHER_PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b2";
const WAITING = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e1";
const SENDING = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e2";
const NOT_SENT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e3";
const CREATED_AT = "2026-11-06T08:00:00.000Z";

const READY: ChatView = {
  revision: 2,
  status: "ready",
  workspaceId: WORKSPACE,
  projectId: PROJECT,
  messages: [
    {
      id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d1",
      seq: 1,
      authorKind: "member",
      authorName: "Ada",
      writtenByMe: true,
      body: "Hello",
      createdAt: CREATED_AT,
    },
    {
      id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d2",
      seq: 2,
      authorKind: "agent",
      authorName: "Unknown agent",
      writtenByMe: false,
      body: "Done.",
      createdAt: CREATED_AT,
    },
  ],
  moreMessages: 0,
  older: "none",
  pending: [],
  morePending: 0,
};

const PENDING: readonly ChatPendingView[] = [
  { eventId: WAITING, body: "First", status: "waiting" },
  { eventId: SENDING, body: "Second", status: "sending" },
  { eventId: NOT_SENT, body: "Third", status: "not_sent", reason: "conflict" },
];

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

/** Actions that record every call as "name argument". */
function recorder() {
  const calls: string[] = [];
  const actions: ChatScreenActions = {
    textChanged: (text) => calls.push(`textChanged ${text}`),
    send: () => calls.push("send"),
    retry: (eventId) => calls.push(`retry ${eventId}`),
    discard: (eventId) => calls.push(`discard ${eventId}`),
    loadOlder: () => calls.push("loadOlder"),
  };
  return { calls, actions };
}

function props(
  overrides: Partial<ChatScreenContentProps> = {},
): ChatScreenContentProps {
  return {
    view: known(),
    projectId: PROJECT,
    composer: EMPTY_COMPOSER,
    olderNotice: undefined,
    actions: recorder().actions,
    ...overrides,
  };
}

function render(overrides: Partial<ChatScreenContentProps> = {}): string {
  return renderToString(<ChatScreenContent {...props(overrides)} />);
}

interface HostProps {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly type?: string;
  readonly onClick?: () => void;
  readonly onChange?: (event: { target: { value: string } }) => void;
  readonly onKeyDown?: (event: FakeKeyEvent) => void;
  readonly onSubmit?: (event: { preventDefault: () => void }) => void;
}

interface FakeKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly nativeEvent: { readonly isComposing: boolean };
  readonly preventDefault: () => void;
}

/** The element and every element below it, with function components called. */
function elementsOf(node: ReactNode): ReactElement<HostProps>[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => elementsOf(child));
  }
  if (!isValidElement<HostProps>(node)) {
    return [];
  }
  if (typeof node.type === "function") {
    return elementsOf(
      (node.type as (props: HostProps) => ReactNode)(node.props),
    );
  }
  return [node, ...elementsOf(node.props.children)];
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child: ReactNode) => textOf(child)).join("");
  }
  return isValidElement<HostProps>(node) ? textOf(node.props.children) : "";
}

function elements(overrides: Partial<ChatScreenContentProps>) {
  return elementsOf(ChatScreenContent(props(overrides)));
}

function attributeValues(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map(
    ([, value]) => value ?? "",
  );
}

/** The status paragraph with `text`, escaped as React escapes text. */
function status(text: string): string {
  return `<p class="chat-status" role="status">${text.replaceAll("'", "&#x27;")}</p>`;
}

const DISABLED_COMPOSER =
  '<form class="composer" aria-label="New message">' +
  '<label class="composer-label" for="composer-text">Message</label>' +
  '<textarea id="composer-text" class="composer-text" rows="3" dir="auto" disabled="" aria-describedby="composer-hint composer-status"></textarea>' +
  `<p class="composer-hint" id="composer-hint">${CHAT_MESSAGES.composerDisabled}</p>` +
  '<p class="composer-status" id="composer-status" role="status"></p>' +
  '<button type="submit" class="composer-send" disabled="">Send</button>' +
  "</form>";

test("each state without anything to list shows its text in the status paragraph, no list, and a disabled composer", () => {
  const cases: [Partial<ChatScreenContentProps>, string][] = [
    [
      { view: { kind: "unavailable" }, actions: undefined },
      CHAT_MESSAGES.unavailable,
    ],
    [{ view: { kind: "pending" } }, CHAT_MESSAGES.pending],
    [
      {
        view: known({
          status: "no_project",
          workspaceId: null,
          projectId: null,
          ...EMPTY,
        }),
      },
      "Messages appear once this device is signed in and the project is open.",
    ],
    // Another project's messages never appear.
    [{ projectId: OTHER_PROJECT }, CHAT_MESSAGES.loading],
    // With the project open, the bridge's absence alone disables it.
    [
      { actions: undefined, view: known({ status: "loading", ...EMPTY }) },
      CHAT_MESSAGES.loading,
    ],
  ];

  for (const [overrides, text] of cases) {
    expect(render(overrides)).toBe(
      '<section class="chat" aria-labelledby="chat-title"><h2 id="chat-title">Chat</h2>' +
        status(text) +
        DISABLED_COMPOSER +
        "</section>",
    );
  }
});

test("a loading or unavailable chat without messages shows only its text, and the composer takes a message", () => {
  for (const view of [
    known({ status: "loading", ...EMPTY }),
    known({ status: "unavailable", problem: "rate_limited", ...EMPTY }),
  ]) {
    const html = render({ view });
    expect(html).not.toContain("<ol");
    expect(html).not.toContain(CHAT_MESSAGES.empty);
    expect(html).toContain(
      '<textarea id="composer-text" class="composer-text" rows="3" dir="auto" aria-describedby="composer-hint composer-status"></textarea>',
    );
    expect(html).toContain(CHAT_MESSAGES.composerHint);
    expect(html).toContain(
      '<button type="submit" class="composer-send">Send</button>',
    );
  }
  expect(
    render({
      view: known({ status: "unavailable", problem: "rate_limited", ...EMPTY }),
    }),
  ).toContain(status(CHAT_PROBLEM_MESSAGES.rate_limited));
});

test("a ready chat without messages says so, with an empty status paragraph", () => {
  const html = render({ view: known(EMPTY) });

  expect(html).toContain(
    status("") +
      `<div class="chat-older"><p class="chat-older-status" role="status"></p></div><p class="chat-empty">No messages yet.</p>`,
  );
});

test("each message shows its author's name and kind, its time, and its body as text", () => {
  const html = render();

  expect(html).toContain('<ol class="message-list" aria-label="Messages">');
  expect(html).toContain(
    '<li class="message" data-author-kind="member"><p class="message-meta">' +
      '<span class="message-author" dir="auto">Ada</span>' +
      '<span class="message-kind">Person</span>' +
      `<time class="message-time" dateTime="${CREATED_AT}">${formatChatTime(CREATED_AT)}</time>` +
      '</p><p class="message-body" id="message-body-0192f2a0-7c3e-7a1b-8c4d-5e6f708192d1" dir="auto">Hello</p></li>',
  );
  expect(html).toContain(
    '<li class="message" data-author-kind="agent"><p class="message-meta"><span class="message-author" dir="auto">Unknown agent</span><span class="message-kind">Agent</span>',
  );
  // The oldest first, in the main process's order.
  expect(html.indexOf("Hello")).toBeLessThan(html.indexOf("Done."));
});

test("markup in a name or a body is text, and a body keeps its line breaks", () => {
  const html = render({
    view: known({
      messages: [
        {
          ...READY.messages[0]!,
          authorName: '<img src="x">',
          body: "<b>bold</b>\nnext lineא",
        },
      ],
    }),
  });

  expect(html).not.toContain("<b>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;\nnext lineא");
  expect(html).toContain("&lt;img src=&quot;x&quot;&gt;");
});

test("waiting messages show their state, why they were not sent, and Retry and Discard where they apply", () => {
  const html = render({ view: known({ pending: PENDING }) });

  expect(html).toContain(
    '<h3 class="pending-heading" id="pending-heading">Messages waiting to be sent</h3><ol class="pending-list" aria-labelledby="pending-heading">',
  );
  expect(html).toContain(
    `<li class="pending" data-status="waiting"><p class="message-body" id="pending-body-${WAITING}" dir="auto">First</p>` +
      '<p class="pending-status">Waiting for the connection</p>' +
      `<div class="pending-actions"><button type="button" class="pending-action" aria-describedby="pending-body-${WAITING}">Discard</button></div></li>`,
  );
  expect(html).toContain(
    `<li class="pending" data-status="sending"><p class="message-body" id="pending-body-${SENDING}" dir="auto">Second</p>` +
      '<p class="pending-status">Sending…</p></li>',
  );
  expect(html).toContain(
    `<li class="pending" data-status="not_sent"><p class="message-body" id="pending-body-${NOT_SENT}" dir="auto">Third</p>` +
      `<p class="pending-status">Not sent<span class="pending-reason">${NOT_SENT_REASON_MESSAGES.conflict}</span></p>` +
      `<div class="pending-actions"><button type="button" class="pending-action" aria-describedby="pending-body-${NOT_SENT}">Retry</button>` +
      `<button type="button" class="pending-action" aria-describedby="pending-body-${NOT_SENT}">Discard</button></div></li>`,
  );
  // The waiting messages come after the stored ones, in the order written.
  expect(html.indexOf("Done.")).toBeLessThan(html.indexOf("First"));
  expect(html.indexOf("First")).toBeLessThan(html.indexOf("Third"));
});

test("Retry and Discard act on their own message only", () => {
  const { calls, actions } = recorder();
  const buttons = elements({
    view: known({ pending: PENDING }),
    actions,
  }).filter((element) => element.props.className === "pending-action");

  for (const button of buttons) {
    button.props.onClick?.();
  }
  expect(buttons.map((button) => textOf(button.props.children))).toEqual([
    "Discard",
    "Retry",
    "Discard",
  ]);
  expect(calls).toEqual([
    `discard ${WAITING}`,
    `retry ${NOT_SENT}`,
    `discard ${NOT_SENT}`,
  ]);
});

test("waiting messages without stored ones show no empty text, and the left-out ones are counted", () => {
  const html = render({
    view: known({ ...EMPTY, pending: PENDING.slice(0, 1), morePending: 2 }),
  });

  expect(html).not.toContain(CHAT_MESSAGES.empty);
  expect(html).toContain(
    '</ol><p class="chat-note">2 more waiting messages are not shown.</p>',
  );
});

test("Load older messages is offered while available, does nothing while loading, and is replaced by a note otherwise", () => {
  const { calls, actions } = recorder();
  const button = (older: ChatView["older"]) =>
    elements({ view: known({ older }), actions }).find(
      (element) => element.props.className === "chat-load-older",
    );

  button("available")?.props.onClick?.();
  expect(calls).toEqual(["loadOlder"]);
  expect(button("loading")?.props.onClick).toBeUndefined();
  expect(button("none")).toBeUndefined();
  expect(button("not_shown")).toBeUndefined();

  expect(render({ view: known({ older: "available" }) })).toContain(
    '<div class="chat-older"><button type="button" class="chat-load-older">Load older messages</button><p class="chat-older-status" role="status"></p></div>',
  );
  expect(render({ view: known({ older: "loading" }) })).toContain(
    '<button type="button" class="chat-load-older" aria-disabled="true">Loading older messages…</button>',
  );
  expect(render({ view: known({ older: "none" }) })).toContain(
    '<div class="chat-older"><p class="chat-note">This is the start of the chat.</p>',
  );
  expect(render({ view: known({ older: "not_shown" }) })).toContain(
    '<p class="chat-note">Older messages are not shown.</p>',
  );
  expect(
    render({ view: known({ older: "not_shown", moreMessages: 1 }) }),
  ).toContain('<p class="chat-note">1 older message is not shown.</p>');
});

test("why the last older page did not load and the answer to Load older messages share one status paragraph", () => {
  const html = render({
    view: known({ older: "available", olderProblem: "unavailable" }),
    olderNotice: LOAD_OLDER_MESSAGES.too_soon,
  });

  expect(html).toContain(
    `<p class="chat-older-status" role="status">${OLDER_PROBLEM_MESSAGES.unavailable} ${LOAD_OLDER_MESSAGES.too_soon ?? ""}</p>`,
  );
});

function keyEvent(
  key: string,
  shiftKey = false,
  isComposing = false,
): FakeKeyEvent & { readonly prevented: () => boolean } {
  let prevented = false;
  return {
    key,
    shiftKey,
    nativeEvent: { isComposing },
    preventDefault: () => {
      prevented = true;
    },
    prevented: () => prevented,
  };
}

function textarea(overrides: Partial<ChatScreenContentProps>) {
  const found = elements(overrides).find(
    (element) => element.type === "textarea",
  );
  expect(found).toBeDefined();
  return found as ReactElement<HostProps>;
}

test("Enter sends the message, and Shift+Enter and Enter during a composition add to the text", () => {
  const { calls, actions } = recorder();
  const area = textarea({ actions });

  const enter = keyEvent("Enter");
  area.props.onKeyDown?.(enter);
  expect(enter.prevented()).toBe(true);
  expect(calls).toEqual(["send"]);

  for (const event of [
    keyEvent("Enter", true),
    keyEvent("Enter", false, true),
    keyEvent("a"),
  ]) {
    area.props.onKeyDown?.(event);
    expect(event.prevented()).toBe(false);
  }
  expect(calls).toEqual(["send"]);

  area.props.onChange?.({ target: { value: "Hi\nthere" } });
  expect(calls).toEqual(["send", "textChanged Hi\nthere"]);
});

test("the form's submit sends instead of reloading the page, and a disabled composer sends nothing", () => {
  const { calls, actions } = recorder();
  const submit = (overrides: Partial<ChatScreenContentProps>) => {
    let prevented = false;
    elements({ ...overrides, actions })
      .find((element) => element.type === "form")
      ?.props.onSubmit?.({
        preventDefault: () => {
          prevented = true;
        },
      });
    return prevented;
  };

  expect(submit({})).toBe(true);
  expect(calls).toEqual(["send"]);

  // Another project's chat, or none open: neither the form nor Enter sends.
  expect(submit({ projectId: OTHER_PROJECT })).toBe(true);
  textarea({ projectId: OTHER_PROJECT, actions }).props.onKeyDown?.(
    keyEvent("Enter"),
  );
  expect(calls).toEqual(["send"]);
});

test("the composer shows its text, is read-only while a send waits, and shows a refusal as a fixed text", () => {
  expect(
    render({ composer: { text: "Draft", sending: true, notice: undefined } }),
  ).toContain(
    '<textarea id="composer-text" class="composer-text" rows="3" dir="auto" readOnly="" aria-describedby="composer-hint composer-status">Draft</textarea>',
  );
  expect(
    render({
      composer: {
        text: " ",
        sending: false,
        notice: SEND_REFUSAL_MESSAGES.blank,
      },
    }),
  ).toContain(
    '<p class="composer-status" id="composer-status" role="status">Write a message first.</p>',
  );
});

test("every id is unique, every reference points to one, and nothing uses a style attribute", () => {
  for (const html of [
    render({ view: known({ pending: PENDING, older: "available" }) }),
    render({ view: { kind: "pending" } }),
  ]) {
    const ids = attributeValues(html, "id");
    expect(new Set(ids).size).toBe(ids.length);
    for (const reference of [
      ...attributeValues(html, "aria-labelledby"),
      ...attributeValues(html, "aria-describedby"),
      ...attributeValues(html, "for"),
    ].flatMap((value) => value.split(" "))) {
      expect(ids).toContain(reference);
    }
    expect(html).not.toMatch(/\sstyle=/);
  }
});

// "Run with agent" on the person's own messages (#35, part A).

const OWN_MESSAGE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d1";
const RUN_AGENT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192f1";
const RUN_CONNECTION = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819301";
const RUN_REPOSITORY = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819501";
const UNLINKED_REPOSITORY = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819502";

const RUN_ACTIVITY: AgentActivityView = {
  revision: 1,
  status: "ready",
  workspaceId: WORKSPACE,
  projectId: PROJECT,
  agents: [
    {
      id: RUN_AGENT,
      name: "Builder",
      ownerName: "Ada",
      disabledAt: null,
      ownedByMe: true,
      grantableHere: true,
      hostedElsewhere: false,
    },
  ],
  unfinishedRuns: [],
  moreUnfinishedRuns: 0,
  finishedRuns: [],
};

const RUN_CONNECTIONS: ProviderConnectionListView = {
  revision: 1,
  status: "ready",
  connections: [
    {
      id: RUN_CONNECTION,
      kind: "claude",
      label: "Work laptop",
      createdAt: CREATED_AT,
      status: "ready",
    },
  ],
};

/**
 * The open project's repositories: one linked on this device, which is
 * preselected, and one that is not, which is not offered (#362).
 */
const RUN_REPOSITORIES: ProjectRepositoriesView = {
  revision: 1,
  status: "ready",
  workspaceId: WORKSPACE,
  projectId: PROJECT,
  links: "ready",
  repositories: [
    {
      repositoryId: RUN_REPOSITORY,
      name: "web",
      linked: true,
      mountId: null,
      removable: true,
    },
    {
      repositoryId: UNLINKED_REPOSITORY,
      name: "api",
      linked: false,
      mountId: null,
      removable: true,
    },
  ],
};

/** A text as react-dom/server writes it, with its apostrophes escaped. */
function escaped(text: string): string {
  return text.replaceAll("'", "&#x27;");
}

/** A run request controller that records every call as "name argument". */
function runRecorder() {
  const calls: string[] = [];
  const actions: RunRequestController = {
    open: (messageId) => calls.push(`open ${messageId}`),
    chooseAgent: (agentId) => calls.push(`chooseAgent ${agentId}`),
    chooseConnection: (connectionId) =>
      calls.push(`chooseConnection ${connectionId}`),
    chooseRepository: (repositoryChoice) =>
      calls.push(`chooseRepository ${repositoryChoice}`),
    continue: (model) => calls.push(`continue ${model?.messageId ?? ""}`),
    cancel: (model) => calls.push(`cancel ${model?.step ?? ""}`),
    close: () => calls.push("close"),
    confirm: (model) => calls.push(`confirm ${model?.agentId ?? ""}`),
    start: () => {
      calls.push("start");
      return () => calls.push("stop");
    },
  };
  return { calls, actions };
}

function runProps(
  state: RunRequestState = IDLE_RUN_REQUEST,
  actions: RunRequestController = runRecorder().actions,
): ChatRunProps {
  return {
    state,
    activity: RUN_ACTIVITY,
    connections: RUN_CONNECTIONS,
    repositories: RUN_REPOSITORIES,
    actions,
  };
}

const OPEN: RunRequestState = {
  ...IDLE_RUN_REQUEST,
  messageId: OWN_MESSAGE,
};
const CONFIRMING: RunRequestState = {
  ...OPEN,
  agentId: RUN_AGENT,
  connectionId: RUN_CONNECTION,
  repositoryChoice: RUN_REPOSITORY,
  confirmedRepositoryLabel: "web",
  step: "confirm",
};

test("only the person's own messages offer Run with agent, described by their body, and only with the agent bridge and the open project", () => {
  const html = render({ run: runProps() });
  expect(html).toContain(
    `<button type="button" class="message-action" aria-describedby="message-body-${OWN_MESSAGE}" aria-expanded="false">${RUN_REQUEST_MESSAGES.open}</button>`,
  );
  // The agent's message offers nothing.
  expect(html.split(RUN_REQUEST_MESSAGES.open)).toHaveLength(2);
  // The status paragraph of the run request is always rendered.
  expect(html).toContain(
    '<p class="run-request-status" role="status" tabindex="-1"></p>',
  );
  // Without the bridge, or while the project is not open in the main
  // process, no message offers it.
  expect(render()).not.toContain(RUN_REQUEST_MESSAGES.open);
  expect(
    render({
      run: runProps(),
      view: known({ projectId: OTHER_PROJECT }),
    }),
  ).not.toContain(RUN_REQUEST_MESSAGES.open);
  expect(
    render({
      run: runProps(),
      view: known({ status: "no_project" } as Partial<ChatView>),
    }),
  ).not.toContain(RUN_REQUEST_MESSAGES.open);
  // Another person's message offers nothing either.
  expect(
    render({
      run: runProps(),
      view: known({
        messages: [{ ...READY.messages[0]!, writtenByMe: false }],
      }),
    }),
  ).not.toContain(RUN_REQUEST_MESSAGES.open);
});

test("the open form labels the agent and the connection, offers the runnable agents and this device's connections, and says that a request does not start the run", () => {
  const html = render({ run: runProps(OPEN) });
  const form = `run-form-${OWN_MESSAGE}`;
  expect(html).toContain(
    `aria-expanded="true" aria-controls="${form}">${RUN_REQUEST_MESSAGES.open}</button>`,
  );
  expect(html).toContain(
    `<form class="run-form" id="${form}" aria-labelledby="${form}-title" aria-describedby="${form}-note message-body-${OWN_MESSAGE}">`,
  );
  expect(html).toContain(
    `<label for="${form}-agent">${RUN_REQUEST_MESSAGES.agentLabel}</label>`,
  );
  expect(html).toContain(
    `<label for="${form}-connection">${RUN_REQUEST_MESSAGES.connectionLabel}</label>`,
  );
  expect(html).toContain(
    `<option value="${RUN_AGENT}" selected="">Builder</option>`,
  );
  expect(html).toContain(
    `<option value="${RUN_CONNECTION}" selected="">Work laptop (Claude)</option>`,
  );
  expect(html).toContain(
    `<p class="run-note" id="${form}-note">${RUN_REQUEST_MESSAGES.note}</p>`,
  );
  expect(html).toContain(
    `<button type="submit">${RUN_REQUEST_MESSAGES.continue}</button>`,
  );
});

test("the repository list is labelled and described, offers No repository first and then the repositories linked on this device by name, with the one linked repository preselected (#362)", () => {
  const html = render({ run: runProps(OPEN) });
  const form = `run-form-${OWN_MESSAGE}`;
  expect(html).toContain(
    `<label for="${form}-repository">${RUN_REQUEST_MESSAGES.repositoryLabel}</label><select id="${form}-repository" aria-describedby="${form}-repository-hint ${form}-repository-files">`,
  );
  expect(html).toContain(
    `<option value="${NO_REPOSITORY}">${RUN_REQUEST_MESSAGES.noRepository}</option><option value="${RUN_REPOSITORY}" selected="">web</option></select>`,
  );
  // The hint, and with a repository chosen, what of it is sent.
  expect(html).toContain(
    `<p class="run-hint" id="${form}-repository-hint">${escaped(RUN_REQUEST_MESSAGES.repositoryHint)}</p><p class="run-hint" id="${form}-repository-files">${escaped(RUN_REQUEST_MESSAGES.repositoryFiles)}</p>`,
  );
  // A repository that is not linked on this device is not offered.
  expect(html).not.toContain(UNLINKED_REPOSITORY);
  expect(html).not.toContain(">api<");
  // No repository chosen: "No repository" is selected, and the
  // confirmation says so; neither says that files are sent.
  const none = { ...OPEN, repositoryChoice: NO_REPOSITORY };
  const noneHtml = render({ run: runProps(none) });
  expect(noneHtml).toContain(
    `<option value="${NO_REPOSITORY}" selected="">${RUN_REQUEST_MESSAGES.noRepository}</option>`,
  );
  expect(noneHtml).toContain(
    `<select id="${form}-repository" aria-describedby="${form}-repository-hint">`,
  );
  expect(noneHtml).not.toContain(escaped(RUN_REQUEST_MESSAGES.repositoryFiles));
  expect(noneHtml).not.toContain(`id="${form}-repository-files"`);
  const noneConfirmation = render({
    run: runProps({
      ...CONFIRMING,
      repositoryChoice: NO_REPOSITORY,
      confirmedRepositoryLabel: RUN_REQUEST_MESSAGES.noRepository,
    }),
  });
  expect(noneConfirmation).toContain(
    `<dt>${RUN_REQUEST_MESSAGES.repositoryLabel}</dt><dd dir="auto">${RUN_REQUEST_MESSAGES.noRepository}</dd>`,
  );
  expect(noneConfirmation).toContain(
    `aria-describedby="${form}-confirm-text ${form}-confirm-summary ${form}-note message-body-${OWN_MESSAGE}"`,
  );
  expect(noneConfirmation).not.toContain(
    escaped(RUN_REQUEST_MESSAGES.repositoryFiles),
  );
  expect(noneConfirmation).not.toContain(`id="${form}-confirm-files"`);
});

test("repositories that cannot be read say so in place of the hint, and Continue stays enabled for a run without a repository (#362)", () => {
  const form = `run-form-${OWN_MESSAGE}`;
  for (const repositories of [
    {
      ...RUN_REPOSITORIES,
      status: "unavailable",
      problem: "unavailable",
      repositories: [],
    } as ProjectRepositoriesView,
    "unavailable" as const,
  ]) {
    const html = render({ run: { ...runProps(OPEN), repositories } });
    expect(html).toContain(
      `<option value="${NO_REPOSITORY}" selected="">${RUN_REQUEST_MESSAGES.noRepository}</option></select>`,
    );
    expect(html).toContain(
      `<p class="run-hint" id="${form}-repository-hint">${escaped(RUN_REQUEST_MESSAGES.repositoriesUnavailable)}</p>`,
    );
    expect(html).not.toContain(escaped(RUN_REQUEST_MESSAGES.repositoryHint));
    expect(html).not.toContain(RUN_REQUEST_MESSAGES.repositoriesPending);
    expect(html).toContain(
      `<button type="submit">${RUN_REQUEST_MESSAGES.continue}</button>`,
    );
  }
});

test("choosing a repository passes its value to the controller (#362)", () => {
  const { calls, actions } = runRecorder();
  const select = elements({ run: runProps(OPEN, actions) }).find(
    (element) =>
      element.type === "select" &&
      (element.props as { id?: string }).id ===
        `run-form-${OWN_MESSAGE}-repository`,
  );
  select?.props.onChange?.({ target: { value: NO_REPOSITORY } });
  select?.props.onChange?.({ target: { value: RUN_REPOSITORY } });
  expect(calls).toEqual([
    `chooseRepository ${NO_REPOSITORY}`,
    `chooseRepository ${RUN_REPOSITORY}`,
  ]);
});

test("while the repositories are not known, the form says so, and Continue is disabled (#362)", () => {
  const html = render({
    run: { ...runProps(OPEN), repositories: undefined },
  });
  expect(html).toContain(
    `<p class="run-problem">${escaped(RUN_REQUEST_MESSAGES.repositoriesPending)}</p>`,
  );
  expect(html).toContain(
    `<button type="submit" disabled="">${RUN_REQUEST_MESSAGES.continue}</button>`,
  );
});

test("without a runnable agent or a connection the form says why, and Continue is disabled", () => {
  const html = render({
    run: {
      ...runProps(OPEN),
      connections: { ...RUN_CONNECTIONS, connections: [] },
    },
  });
  expect(html).toContain(
    `<p class="run-problem">${RUN_REQUEST_MESSAGES.noConnections}</p>`,
  );
  expect(html).not.toContain("<select");
  expect(html).toContain(
    `<button type="submit" disabled="">${RUN_REQUEST_MESSAGES.continue}</button>`,
  );
});

test("the confirmation names the agent and the connection, with Cancel first, and its buttons act on the shown form", () => {
  const { calls, actions } = runRecorder();
  const html = render({ run: runProps(CONFIRMING, actions) });
  const form = `run-form-${OWN_MESSAGE}`;
  expect(html).toContain(
    `<div class="run-form run-confirmation" id="${form}" role="group" aria-labelledby="${form}-title" aria-describedby="${form}-confirm-text ${form}-confirm-summary ${form}-confirm-files ${form}-note message-body-${OWN_MESSAGE}">`,
  );
  expect(html).toContain(`<dd dir="auto">Builder</dd>`);
  expect(html).toContain(`<dd dir="auto">Work laptop (Claude)</dd>`);
  expect(html).toContain(
    `<dt>${RUN_REQUEST_MESSAGES.repositoryLabel}</dt><dd dir="auto">web</dd></dl><p class="run-hint" id="${form}-confirm-files">${escaped(RUN_REQUEST_MESSAGES.repositoryFiles)}</p>`,
  );
  expect(html.indexOf(`>${RUN_REQUEST_MESSAGES.cancel}</button>`)).toBeLessThan(
    html.indexOf(`>${RUN_REQUEST_MESSAGES.confirm}</button>`),
  );
  const buttons = elements({ run: runProps(CONFIRMING, actions) }).filter(
    (element) =>
      element.type === "button" &&
      (
        [RUN_REQUEST_MESSAGES.cancel, RUN_REQUEST_MESSAGES.confirm] as string[]
      ).includes(textOf(element.props.children)),
  );
  for (const button of buttons) {
    button.props.onClick?.();
  }
  // Each gets the shown form, so Cancel decides by the shown step.
  expect(calls).toEqual(["cancel confirm", `confirm ${RUN_AGENT}`]);
});

test("while a request waits, its buttons are disabled and say so", () => {
  const html = render({ run: runProps({ ...CONFIRMING, sending: true }) });
  expect(html).toContain(
    `<p class="run-sending">${RUN_REQUEST_MESSAGES.sending}</p>`,
  );
  expect(html).toContain(
    `<button type="button" disabled="">${RUN_REQUEST_MESSAGES.confirm}</button>`,
  );
  expect(html).toContain(
    `aria-expanded="true" aria-controls="run-form-${OWN_MESSAGE}" disabled="">`,
  );
});

test("Run with agent opens its message's form, and on an open form closes it; the answer shows in the status paragraph", () => {
  const { calls, actions } = runRecorder();
  const open = (state: RunRequestState) =>
    elements({ run: runProps(state, actions) })
      .find((element) => element.props.className === "message-action")
      ?.props.onClick?.();
  open(IDLE_RUN_REQUEST);
  open(OPEN);
  // On a confirmation too, it closes the form rather than step back.
  open(CONFIRMING);
  expect(calls).toEqual([`open ${OWN_MESSAGE}`, "close", "close"]);
  const html = render({
    run: runProps({
      ...IDLE_RUN_REQUEST,
      notice: RUN_REQUEST_MESSAGES.requested,
    }),
  });
  expect(html).toContain(
    `<p class="run-request-status" role="status" tabindex="-1">${RUN_REQUEST_MESSAGES.requested}</p>`,
  );
});

test("with the run request, every id is unique and every reference points to one", () => {
  for (const html of [
    render({ run: runProps() }),
    render({ run: runProps(OPEN) }),
    render({ run: runProps(CONFIRMING) }),
  ]) {
    const ids = attributeValues(html, "id");
    expect(new Set(ids).size).toBe(ids.length);
    for (const reference of [
      ...attributeValues(html, "aria-labelledby"),
      ...attributeValues(html, "aria-describedby"),
      ...attributeValues(html, "aria-controls"),
      ...attributeValues(html, "for"),
    ].flatMap((value) => value.split(" "))) {
      expect(ids).toContain(reference);
    }
  }
});
