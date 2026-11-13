// The requester's side of the join requests on the join screen. The
// components below the screen use no hooks except the question's box, so
// the tests render the markup and also call the components as functions,
// walk the returned elements, and invoke their event handlers.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type {
  InvitationActionsBridge,
  OwnJoinRequestActionsBridge,
  OwnJoinRequestsBridge,
} from "../shared/desktop-bridge.ts";
import type {
  OwnJoinRequestView,
  OwnJoinRequestsView,
  WorkspaceView,
} from "../shared/ipc-contract.ts";
import { deviceTimeFormat } from "./device-view.ts";
import {
  followedOwnJoinRequests,
  JoinScreen,
  JoinScreenContent,
  joinRequestPart,
} from "./JoinScreen.tsx";
import {
  IDLE_OWN_JOIN_REQUEST_ACTIONS,
  describeOwnJoinRequests,
  type OwnJoinRequestActionsView,
  type OwnJoinRequestsScreenView,
  type WithdrawRequest,
} from "./own-join-requests-view.ts";
import {
  focusesTitleAfterRowLeft,
  WithdrawQuestionContent,
  type OwnJoinRequestHandlers,
} from "./OwnJoinRequests.tsx";
import { peopleDateFormat } from "./people-view.ts";
import type { WorkspacePanelView } from "./workspace-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const JOINED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a5";
const REQUEST = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d1";
const SECOND_REQUEST = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d2";

/** A fixed locale and a time zone that is not UTC, whatever the machine's. */
const ISTANBUL = { locale: "en-GB", timeZone: "Europe/Istanbul" };

function known(overrides: Partial<WorkspaceView> = {}): WorkspacePanelView {
  return {
    kind: "known",
    state: {
      revision: 1,
      status: "ready",
      workspaces: [],
      selectedWorkspaceId: null,
      projects: [],
      openProjectId: null,
      ...overrides,
    } as WorkspaceView,
  };
}

function request(
  joinRequestId: string,
  overrides: Partial<OwnJoinRequestView> = {},
): OwnJoinRequestView {
  return {
    joinRequestId,
    workspaceId: WORKSPACE,
    requestedName: "Katherine",
    createdAt: "2026-11-11T09:00:00.000Z",
    expiresAt: "2026-11-18T09:00:00.000Z",
    decision: null,
    decidedAt: null,
    ...overrides,
  };
}

function listed(
  requests: readonly OwnJoinRequestView[],
): OwnJoinRequestsScreenView {
  return {
    kind: "known",
    state: { revision: 4, status: "ready", requests } as OwnJoinRequestsView,
  };
}

const PENDING = request(REQUEST);
const APPROVED = request(SECOND_REQUEST, {
  workspaceId: JOINED,
  requestedName: "Kathy",
  decision: "approved",
  decidedAt: "2026-11-12T10:00:00.000Z",
});

const WITHDRAW: WithdrawRequest = {
  joinRequestId: REQUEST,
  workspaceId: WORKSPACE,
  requestedName: "Katherine",
};

interface HostProps {
  readonly children?: ReactNode;
  readonly id?: string;
  readonly type?: string;
  readonly value?: string;
  readonly readOnly?: boolean;
  readonly "aria-disabled"?: string;
  readonly onClick?: (event: { readonly currentTarget: unknown }) => void;
  readonly onSubmit?: (event: { readonly preventDefault: () => void }) => void;
  readonly onChange?: (event: {
    readonly currentTarget: { readonly value: string };
  }) => void;
  readonly onCancel?: (event: { readonly preventDefault: () => void }) => void;
  readonly onClose?: () => void;
}

/**
 * The element and every element below it. A component without hooks is
 * called to reach its elements; one with hooks stays a leaf.
 */
function elementsOf(node: ReactNode): ReactElement<HostProps>[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => elementsOf(child));
  }
  if (!isValidElement<HostProps>(node)) {
    return [];
  }
  if (typeof node.type === "function") {
    try {
      return elementsOf(
        (node.type as (props: HostProps) => ReactNode)(node.props),
      );
    } catch {
      return [node];
    }
  }
  return [node, ...elementsOf(node.props.children)];
}

/** Handlers that record each call as text. */
function recorder() {
  const calls: string[] = [];
  const handlers: OwnJoinRequestHandlers = {
    onWorkspaceId: (text) => calls.push(`workspace ${text}`),
    onName: (text) => calls.push(`name ${text}`),
    onSubmit: () => calls.push("submit"),
    onWithdraw: (withdraw, button) =>
      calls.push(`withdraw ${withdraw.joinRequestId} ${String(button)}`),
    onConfirmWithdraw: () => calls.push("confirm"),
    onCancelWithdraw: () => calls.push("cancel"),
    onRefresh: () => calls.push("refresh"),
  };
  return { calls, handlers };
}

interface Props {
  readonly workspaces?: WorkspacePanelView;
  readonly list?: OwnJoinRequestsScreenView;
  readonly view?: Partial<OwnJoinRequestActionsView>;
  readonly handlers?: OwnJoinRequestHandlers;
  /** False for no request part, as without its two bridges. */
  readonly withRequests?: boolean;
}

function screen({
  workspaces = known(),
  list = listed([PENDING, APPROVED]),
  view = {},
  handlers = recorder().handlers,
  withRequests = true,
}: Props) {
  return (
    <JoinScreenContent
      workspaces={workspaces}
      requests={
        withRequests
          ? {
              model: describeOwnJoinRequests(list, workspaces),
              view: {
                ...IDLE_OWN_JOIN_REQUEST_ACTIONS,
                name: "The Octocat",
                ...view,
              },
              handlers,
            }
          : undefined
      }
      dateFormat={peopleDateFormat(ISTANBUL)}
      timeFormat={deviceTimeFormat(ISTANBUL)}
    />
  );
}

function render(props: Props = {}): string {
  return renderToString(screen(props));
}

function elements(props: Props): ReactElement<HostProps>[] {
  return elementsOf(screen(props));
}

/** The part of `html` from the section labelled `id` to its end. */
function section(html: string, id: string): string {
  const start = html.indexOf(`<section aria-labelledby="${id}">`);
  expect(start, id).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf("</section>", start) + 10);
}

function attributeValues(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map(
    ([, value]) => value ?? "",
  );
}

const HEADING =
  '<section aria-labelledby="join-request-title"><h3 class="people-heading" id="join-request-title">Ask to join with a workspace ID</h3>';
const HINTS =
  '<p id="join-request-hint">Ask to join a workspace by its ID, as a new person with the name below. Its owner and admins see that name with your GitHub login and the creation date of your GitHub account, and decide. Until they approve, you see nothing of the workspace; then it appears in your list of workspaces.</p><p id="join-request-claim-hint">If the workspace already added you as a person, do not ask here: ask its owner or an admin for an invitation code for that person, and join with the code above. A request by ID adds you as a new person.</p>';

test("the form is a labelled workspace ID field without spelling, completion, or translation, the name field with the account's name, an alert for each, Ask to join, and the status paragraph", () => {
  expect(section(render(), "join-request-title")).toBe(
    `${HEADING}${HINTS}<form class="account-form" aria-labelledby="join-request-title"><label class="account-label" for="join-request-workspace">Workspace ID</label><input id="join-request-workspace" class="account-input" type="text" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck="false" translate="no" aria-describedby="join-request-hint join-request-claim-hint join-request-workspace-problem" value=""/><p class="panel-message" id="join-request-workspace-problem" role="alert"></p><label class="account-label" for="join-request-name">Your name in the workspace</label><input id="join-request-name" class="account-input" type="text" dir="auto" autoComplete="off" spellCheck="false" aria-describedby="join-request-name-problem" value="The Octocat"/><p class="panel-message" id="join-request-name-problem" role="alert"></p><div class="account-actions"><button type="submit" class="panel-action">Ask to join</button></div></form><p class="people-status" id="join-request-message" role="status"></p></section>`,
  );
  // Each field's problem is its own alert, and marks the field.
  const problems = render({
    view: {
      workspaceId: "x",
      workspaceProblem: "Paste the ID of the workspace.",
      nameProblem: "Enter a name.",
      formMessage: "The server refused it.",
    },
  });
  expect(problems).toContain(
    'aria-invalid="true" aria-describedby="join-request-hint join-request-claim-hint join-request-workspace-problem" value="x"/><p class="panel-message" id="join-request-workspace-problem" role="alert">Paste the ID of the workspace.</p>',
  );
  expect(problems).toContain(
    'aria-invalid="true" aria-describedby="join-request-name-problem" value="The Octocat"/><p class="panel-message" id="join-request-name-problem" role="alert">Enter a name.</p>',
  );
  expect(problems).toContain(
    '<p class="people-status" id="join-request-message" role="status">The server refused it.</p>',
  );
  // No maxLength, which HTML counts in UTF-16 code units, and no note field.
  expect(problems).not.toMatch(/maxLength|maxlength|<textarea/);
});

test("without its two bridges, the request part says that it is not available, with no list or dialog; while no device is signed in, it keeps its hints and asks for a sign-in", () => {
  const html = render({ withRequests: false });
  expect(section(html, "join-request-title")).toBe(
    `${HEADING}<p>Asking to join with a workspace ID is not available.</p></section>`,
  );
  expect(html).not.toContain("own-join-requests-heading");
  expect(html).not.toContain("withdraw-dialog");
  const signedOut = render({
    workspaces: known({ status: "signed_out" }),
    list: {
      kind: "known",
      state: { revision: 1, status: "signed_out", requests: [] },
    },
  });
  expect(section(signedOut, "join-request-title")).toBe(
    `${HEADING}${HINTS}<p>You can ask to join a workspace once this device is signed in and ready.</p><p class="people-status" id="join-request-message" role="status"></p></section>`,
  );
  expect(signedOut).toContain(
    '<p class="people-status" role="status">Your join requests appear once this device is signed in and ready.</p>',
  );
});

test("both ways of joining say that a person whom the workspace already added joins with an invitation code", () => {
  const withBridge = renderToString(
    <JoinScreenContent
      workspaces={known()}
      handlers={{
        onCode: () => undefined,
        onPreview: () => undefined,
        onAsk: () => undefined,
        onConfirm: () => undefined,
        onBack: () => undefined,
        onCancel: () => undefined,
        onOpen: () => undefined,
      }}
      requests={{
        model: describeOwnJoinRequests(listed([]), known()),
        view: IDLE_OWN_JOIN_REQUEST_ACTIONS,
        handlers: recorder().handlers,
      }}
    />,
  );
  expect(section(withBridge, "join-code-title")).toContain(
    "If a workspace already added you as a person, its owner or an admin can give you an invitation code for that person.",
  );
  expect(section(withBridge, "join-request-title")).toContain(
    "If the workspace already added you as a person, do not ask here: ask its owner or an admin for an invitation code for that person, and join with the code above.",
  );
  // The note that this part comes later is gone.
  expect(withBridge).not.toContain("will be added here");
});

test("the fields report their text, the form asks to join, and while an action runs the fields are read-only and Ask to join does nothing", () => {
  const { calls, handlers } = recorder();
  const found = elements({ handlers });
  found
    .find((element) => element.props.id === "join-request-workspace")
    ?.props.onChange?.({ currentTarget: { value: ` ${WORKSPACE}` } });
  found
    .find((element) => element.props.id === "join-request-name")
    ?.props.onChange?.({ currentTarget: { value: "Katherine" } });
  let prevented = 0;
  const event = {
    preventDefault: () => {
      prevented += 1;
    },
  };
  const form = (props: Props) =>
    elements(props).find(
      (element) =>
        element.type === "form" &&
        (element.props as { "aria-labelledby"?: string })["aria-labelledby"] ===
          "join-request-title",
    );
  form({ handlers })?.props.onSubmit?.(event);
  expect(calls).toEqual([
    `workspace  ${WORKSPACE}`,
    "name Katherine",
    "submit",
  ]);
  // While an action runs.
  const running = recorder();
  form({
    handlers: running.handlers,
    view: { running: true },
  })?.props.onSubmit?.(event);
  expect(running.calls).toEqual([]);
  expect(prevented).toBe(2);
  const html = render({ view: { running: true } });
  expect(html).toContain('translate="no" readOnly=""');
  expect(html).toContain(
    'dir="auto" autoComplete="off" spellCheck="false" readOnly=""',
  );
  expect(html).toContain(
    '<button type="submit" class="panel-action" aria-disabled="true">Ask to join</button>',
  );
});

test("the own join requests list the pending ones with Withdraw, then the ended ones with how and when, in a given time zone, with Refresh and the status paragraph of their actions", () => {
  const html = render({
    workspaces: known({ workspaces: [{ id: JOINED, name: "Team" }] }),
  });
  expect(section(html, "own-join-requests-heading")).toBe(
    '<section aria-labelledby="own-join-requests-heading"><h3 class="people-heading" id="own-join-requests-heading">Your join requests</h3><p class="people-status" role="status"></p>' +
      '<h4 class="people-heading" id="own-join-requests-pending">Pending</h4><ul class="people-list" aria-labelledby="own-join-requests-pending"><li class="person"><p class="person-name"><span dir="auto" id="own-join-requests-pending-0-name">Katherine</span></p><p class="person-meta">Workspace ID <span class="workspace-id" translate="no" id="own-join-requests-pending-0-workspace">0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3</span></p><p class="person-meta">Sent <time dateTime="2026-11-11T09:00:00.000Z">11 Nov 2026, 12:00</time></p><p class="person-meta">Expires <time dateTime="2026-11-18T09:00:00.000Z">18 Nov 2026, 12:00</time></p><div class="account-actions"><button type="button" class="panel-action" aria-describedby="own-join-requests-pending-0-name own-join-requests-pending-0-workspace">Withdraw</button></div></li></ul>' +
      '<h4 class="people-heading" id="own-join-requests-ended">Earlier requests</h4><ul class="people-list" aria-labelledby="own-join-requests-ended"><li class="person"><p class="person-name"><span dir="auto" id="own-join-requests-ended-0-name">Kathy</span></p><p class="person-meta">Workspace ID <span class="workspace-id" translate="no" id="own-join-requests-ended-0-workspace">0192f2a0-7c3e-7a1b-8c4d-5e6f708192a5</span></p><p class="person-meta">Workspace <span dir="auto">Team</span></p><p class="person-meta">Sent <time dateTime="2026-11-11T09:00:00.000Z">11 Nov 2026, 12:00</time></p><p class="person-meta">Approved <time dateTime="2026-11-12T10:00:00.000Z">12 Nov 2026, 13:00</time></p></li></ul>' +
      '<div class="account-actions"><button type="button" class="panel-action">Refresh your join requests</button></div><p class="people-status" id="own-join-request-action-message" role="status"></p></section>',
  );
});

test("every way a request ended shows with its time, an expired one as expired, and none has Withdraw", () => {
  const ended = (["approved", "denied", "withdrawn", "expired"] as const).map(
    (decision, index) =>
      request(`0192f2a0-7c3e-7a1b-8c4d-5e6f70819${String(300 + index)}`, {
        decision,
        decidedAt: "2026-11-18T09:00:00.000Z",
      }),
  );
  const html = render({ list: listed(ended) });
  for (const label of ["Approved", "Denied", "Withdrawn", "Expired"]) {
    expect(html).toContain(
      `<p class="person-meta">${label} <time dateTime="2026-11-18T09:00:00.000Z">18 Nov 2026, 12:00</time></p>`,
    );
  }
  expect(html).not.toContain(">Withdraw<");
  expect(html).not.toContain("Expires");
  expect(html).not.toContain("own-join-requests-pending");
});

test("the list shows its state's text without a list: checking, loading, none, and a problem with what was loaded before", () => {
  const status = (list: OwnJoinRequestsScreenView) =>
    /<section aria-labelledby="own-join-requests-heading"><h3[^>]*>Your join requests<\/h3><p class="people-status" role="status">([^<]*)<\/p>/.exec(
      render({ list }),
    )?.[1];
  expect(status({ kind: "pending" })).toBe("Checking your join requests.");
  expect(status({ kind: "unavailable" })).toBe(
    "Your join requests are not available.",
  );
  expect(
    status({
      kind: "known",
      state: { revision: 1, status: "loading", requests: [] },
    }),
  ).toBe("Loading your join requests.");
  expect(status(listed([]))).toBe("You have not asked to join a workspace.");
  const failed = render({
    list: {
      kind: "known",
      state: {
        revision: 2,
        status: "unavailable",
        problem: "unavailable",
        requests: [PENDING],
      },
    },
  });
  expect(failed).toContain(
    '<p class="people-status" role="status">The server could not be reached. Trying again later.</p>',
  );
  expect(failed).toContain(">Withdraw</button>");
});

test("Withdraw starts the question with its request and gets its button; Refresh asks for the list; while an action runs every control of the part stays focusable and does nothing", () => {
  const { calls, handlers } = recorder();
  const found = elements({ handlers });
  const button = (label: string, within = found) =>
    within.find(
      (element) =>
        element.type === "button" && element.props.children === label,
    );
  button("Withdraw")?.props.onClick?.({ currentTarget: "the button" });
  button("Refresh your join requests")?.props.onClick?.({
    currentTarget: "refresh",
  });
  expect(calls).toEqual([`withdraw ${REQUEST} the button`, "refresh"]);
  const inert = elements({ handlers, view: { running: true } });
  for (const label of [
    "Withdraw",
    "Refresh your join requests",
    "Ask to join",
  ]) {
    expect(button(label, inert)?.props["aria-disabled"], label).toBe("true");
    expect(button(label, inert)?.props.onClick, label).toBeUndefined();
  }
});

test("the sentence of a create shows below the form, and the one of a withdrawal or a refresh below the list", () => {
  const html = render({
    view: {
      formMessage: "Your request to join was sent.",
      listMessage: "The request was withdrawn.",
    },
  });
  expect(section(html, "join-request-title")).toContain(
    '<p class="people-status" id="join-request-message" role="status">Your request to join was sent.</p></section>',
  );
  expect(section(html, "own-join-requests-heading")).toContain(
    '<p class="people-status" id="own-join-request-action-message" role="status">The request was withdrawn.</p></section>',
  );
});

test("the question before a withdrawal is a dialog with the requested name as text and the workspace ID, its sentence, Cancel first, and Withdraw", () => {
  const closed = render();
  expect(closed).toContain('<dialog class="people-dialog"></dialog>');
  expect(closed).not.toContain("withdraw-dialog-title");
  const html = renderToString(
    <WithdrawQuestionContent
      request={{ ...WITHDRAW, requestedName: "<b>Katherine</b>" }}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />,
  );
  expect(html).toBe(
    '<dialog class="people-dialog" aria-labelledby="withdraw-dialog-title" aria-describedby="withdraw-dialog-name withdraw-dialog-workspace withdraw-dialog-text"><form><h2 id="withdraw-dialog-title">Withdraw this request?</h2><p class="people-dialog-name" id="withdraw-dialog-name"><span dir="auto">&lt;b&gt;Katherine&lt;/b&gt;</span></p><p id="withdraw-dialog-workspace">Workspace ID <span class="workspace-id" translate="no">0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3</span></p><p id="withdraw-dialog-text">The request ends, and the owner and the admins of the workspace can no longer approve it. You can ask again with the workspace ID, but a new request is refused while the workspace pauses new requests, and it counts toward the 10 requests that an account can make in 24 hours.</p><div class="people-dialog-actions"><button type="button" class="panel-action">Cancel</button><button type="submit" class="panel-action">Withdraw</button></div></form></dialog>',
  );
  // The screen holds it open while the controller has its request.
  expect(render({ view: { withdrawal: WITHDRAW } })).toContain(
    '<h2 id="withdraw-dialog-title">Withdraw this request?</h2>',
  );
});

test("the question confirms on submit, and cancels on Cancel, on Escape, and when the browser closes it", () => {
  const calls: string[] = [];
  const found = elementsOf(
    <WithdrawQuestionContent
      request={WITHDRAW}
      onConfirm={() => calls.push("confirm")}
      onCancel={() => calls.push("cancel")}
    />,
  );
  let prevented = 0;
  const event = {
    preventDefault: () => {
      prevented += 1;
    },
  };
  found.find((element) => element.type === "form")?.props.onSubmit?.(event);
  found
    .find(
      (element) =>
        element.type === "button" && element.props.children === "Cancel",
    )
    ?.props.onClick?.({ currentTarget: "cancel" });
  const dialog = found.find((element) => element.type === "dialog");
  dialog?.props.onCancel?.(event);
  dialog?.props.onClose?.();
  expect(calls).toEqual(["confirm", "cancel", "cancel", "cancel"]);
  expect(prevented).toBe(2);
});

test("names, workspace names, and the fields' texts are rendered as text with their own direction, never as markup", () => {
  const markup = "<img src=x onerror=alert(1)>";
  const html = render({
    workspaces: known({ workspaces: [{ id: JOINED, name: markup }] }),
    list: listed([
      request(REQUEST, { requestedName: markup }),
      { ...APPROVED, requestedName: markup },
    ]),
    view: { workspaceId: markup, name: markup },
  });
  expect(html).not.toContain("<img");
  expect(html).toContain(
    '<span dir="auto" id="own-join-requests-pending-0-name">&lt;img src=x onerror=alert(1)&gt;</span>',
  );
  expect(html).toContain(
    '<p class="person-meta">Workspace <span dir="auto">&lt;img src=x onerror=alert(1)&gt;</span></p>',
  );
  expect(html).toContain('value="&lt;img src=x onerror=alert(1)&gt;"');
});

test("every ID is unique, every reference points to one of them, no join request ID shows, and no style attribute is used", () => {
  const html = render({
    workspaces: known({ workspaces: [{ id: JOINED, name: "Team" }] }),
    list: listed([
      PENDING,
      request("0192f2a0-7c3e-7a1b-8c4d-5e6f708192d4"),
      APPROVED,
      { ...APPROVED, joinRequestId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d5" },
    ]),
    view: {
      workspaceProblem: "Paste the ID of the workspace.",
      nameProblem: "Enter a name.",
      formMessage: "The server refused it.",
      listMessage: "The request was withdrawn.",
      withdrawal: WITHDRAW,
    },
  });
  const ids = attributeValues(html, "id");
  expect(new Set(ids).size).toBe(ids.length);
  for (const reference of [
    ...attributeValues(html, "aria-labelledby"),
    ...attributeValues(html, "aria-describedby"),
    ...attributeValues(html, "for"),
  ].flatMap((value) => value.split(" "))) {
    expect(ids).toContain(reference);
  }
  for (const id of [REQUEST, SECOND_REQUEST, "8192d4", "8192d5"]) {
    expect(html).not.toContain(id);
  }
  expect(html).not.toMatch(/\sstyle=/);
});

test("the join screen has the request part only with both bridges that it uses, and reads nothing while it is rendered", () => {
  const calls: string[] = [];
  const call = (name: string) => () => {
    calls.push(name);
    return Promise.reject(new Error("not called"));
  };
  const ownJoinRequests: OwnJoinRequestsBridge = {
    getState: call("getState"),
    subscribeState: () => {
      calls.push("subscribeState");
      return () => undefined;
    },
    load: call("load"),
  };
  const ownJoinRequestActions: OwnJoinRequestActionsBridge = {
    create: call("create"),
    withdraw: call("withdraw"),
  };
  const invitationActions: InvitationActionsBridge = {
    create: call("invitation create"),
    revoke: call("revoke"),
    preview: call("preview"),
    accept: call("accept"),
  };
  const props = {
    invitationActions,
    ownJoinRequests,
    ownJoinRequestActions,
    account: { kind: "pending" } as const,
    workspaces: known(),
    onOpenWorkspace: () => undefined,
  };
  const html = renderToString(<JoinScreen {...props} />);
  expect(html).toContain('<input id="join-request-workspace"');
  expect(html).toContain(
    '<p class="people-status" role="status">Checking your join requests.</p>',
  );
  expect(html).toContain(
    '<p class="people-status" id="own-join-request-action-message" role="status"></p>',
  );
  // The invitation's question and the withdrawal's.
  expect(html.match(/<dialog class="people-dialog"><\/dialog>/g)).toHaveLength(
    2,
  );
  // The subscription and the load run in an effect, which a server render
  // does not run; nothing else is called.
  expect(calls).toEqual([]);
  for (const name of ["ownJoinRequests", "ownJoinRequestActions"] as const) {
    const without = renderToString(
      <JoinScreen {...props} {...{ [name]: undefined }} />,
    );
    expect(without, name).toContain(
      "<p>Asking to join with a workspace ID is not available.</p>",
    );
    expect(without, name).not.toContain("own-join-requests-heading");
  }
  // The invitation code does not need them, nor they it.
  const codeOnly = renderToString(
    <JoinScreen
      {...props}
      ownJoinRequests={undefined}
      ownJoinRequestActions={undefined}
    />,
  );
  expect(codeOnly).toContain('<input id="join-code"');
  expect(
    renderToString(<JoinScreen {...props} invitationActions={undefined} />),
  ).toContain('<input id="join-request-workspace"');
});

// The sources of the requester's part, without the tests, as text.
const SOURCES = import.meta.glob<string>(
  ["./OwnJoinRequests.tsx", "./own-join-requests-view.ts"],
  { query: "?raw", import: "default", eager: true },
);

test("the requester's part reads no clock: the main process marks a request past its expiry", () => {
  expect(Object.keys(SOURCES).sort()).toEqual([
    "./OwnJoinRequests.tsx",
    "./own-join-requests-view.ts",
  ]);
  for (const [file, source] of Object.entries(SOURCES)) {
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code, file).not.toMatch(
      /Date\.now|new Date\(|performance\.now|setTimeout|setInterval/,
    );
  }
});

test("after a refused or uncertain withdrawal whose request ended, the focus moves to the title once the next list no longer shows Withdraw, while no question is open and the focus fell to the page", () => {
  const gone = { isConnected: false };
  const shown = { isConnected: true };
  expect(focusesTitleAfterRowLeft(false, gone, true)).toBe(true);
  // The button is still there, the focus is elsewhere, no button was used,
  // or a question is open, which gives the focus back as it closes.
  expect(focusesTitleAfterRowLeft(false, shown, true)).toBe(false);
  expect(focusesTitleAfterRowLeft(false, gone, false)).toBe(false);
  expect(focusesTitleAfterRowLeft(false, null, true)).toBe(false);
  expect(focusesTitleAfterRowLeft(true, gone, true)).toBe(false);
});

test("the join screen subscribes to the own join requests only with both bridges", () => {
  const ownJoinRequests: OwnJoinRequestsBridge = {
    getState: () => Promise.reject(new Error("not called")),
    subscribeState: () => () => undefined,
    load: () => Promise.reject(new Error("not called")),
  };
  const ownJoinRequestActions: OwnJoinRequestActionsBridge = {
    create: () => Promise.reject(new Error("not called")),
    withdraw: () => Promise.reject(new Error("not called")),
  };
  expect(followedOwnJoinRequests(ownJoinRequests, ownJoinRequestActions)).toBe(
    ownJoinRequests,
  );
  expect(followedOwnJoinRequests(ownJoinRequests, undefined)).toBeUndefined();
  expect(
    followedOwnJoinRequests(undefined, ownJoinRequestActions),
  ).toBeUndefined();
});

test("the join screen gives the part the workspace state, so that a request shows the name of a workspace that the account's list holds, and no part without the handlers", () => {
  const { handlers } = recorder();
  const list = listed([PENDING, APPROVED]);
  const holding = known({ workspaces: [{ id: JOINED, name: "Team" }] });
  const part = joinRequestPart(list, holding, {
    view: IDLE_OWN_JOIN_REQUEST_ACTIONS,
    handlers,
  });
  expect(part?.model.ended[0]?.workspaceName).toBe("Team");
  expect(part?.model).toEqual(describeOwnJoinRequests(list, holding));
  expect(part?.view).toBe(IDLE_OWN_JOIN_REQUEST_ACTIONS);
  expect(part?.handlers).toBe(handlers);
  expect(
    joinRequestPart(list, holding, {
      view: IDLE_OWN_JOIN_REQUEST_ACTIONS,
      handlers: undefined,
    }),
  ).toBeUndefined();
});
