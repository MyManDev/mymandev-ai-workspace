// The join requests part of the people screen. The components below the
// screen use no hooks except the dialogs' boxes, so the tests render the
// markup and also call the components as functions, walk the returned
// elements, and invoke their event handlers. No DOM is used.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type {
  InvitationActionsBridge,
  InvitationsBridge,
  JoinRequestActionsBridge,
  JoinRequestsBridge,
  PeopleActionsBridge,
  PeopleBridge,
} from "../shared/desktop-bridge.ts";
import type {
  BlockedJoinRequestView,
  JoinRequestsView,
  PeopleView,
  PendingJoinRequestView,
  PersonView,
} from "../shared/ipc-contract.ts";
import type { InvitationActionHandlers } from "./InvitationActions.tsx";
import {
  IDLE_INVITATION_ACTIONS,
  type InvitationActionRequest,
} from "./invitations-view.ts";
import {
  focusOnButtonOrPage,
  JoinRequestQuestionContent,
  syncModal,
  type JoinRequestActionHandlers,
} from "./JoinRequests.tsx";
import {
  IDLE_JOIN_REQUEST_ACTIONS,
  type JoinRequestActionRequest,
  type JoinRequestActionsView,
  type JoinRequestDialog,
  type JoinRequestsScreenView,
} from "./join-requests-view.ts";
import type { PeopleActionHandlers } from "./PeopleActions.tsx";
import { PeopleScreen, PeopleScreenContent } from "./PeopleScreen.tsx";
import {
  IDLE_PEOPLE_ACTIONS,
  offerTimeFormat,
  type PeopleActionRequest,
  type PeopleActionsView,
} from "./people-actions-view.ts";
import { peopleDateFormat, type PeopleScreenView } from "./people-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OWNER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c1";
const ADMIN = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c2";
const MEMBER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c3";
const UNCLAIMED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c4";
const OTHER_UNCLAIMED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c6";
const REQUEST = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d1";
const BLOCKED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d3";
const ERASED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d4";
const IDS = [
  WORKSPACE,
  OWNER,
  ADMIN,
  MEMBER,
  UNCLAIMED,
  OTHER_UNCLAIMED,
  REQUEST,
  BLOCKED,
];

/** A code in the protocol's form (`mmdi_`, 48 characters). */
const CODE = "mmdi_Zx9-_Qw8Zx9-_Qw8Zx9-_Qw8Zx9-_Qw8Zx9-_Qw8Kpw";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const VERIFIED_AT = "2026-11-11T09:00:00.000Z";
const ACCOUNT_CREATED_AT = "2026-10-01T00:00:00.000Z";
const EXPIRES_AT = "2026-11-18T09:00:00.000Z";
const BLOCKED_AT = "2026-11-02T10:00:00.000Z";
const PAUSED_AT = "2026-11-12T08:00:00.000Z";

function person(
  memberId: string,
  displayName: string,
  overrides: Partial<PersonView> = {},
): PersonView {
  return {
    memberId,
    displayName,
    role: "member",
    claimed: true,
    login: "octocat",
    verifiedAt: "2026-11-06T22:30:00.000Z",
    former: false,
    ...overrides,
  };
}

const READY: PeopleView = {
  revision: 4,
  status: "ready",
  workspaceId: WORKSPACE,
  workspaceName: "Team",
  ownMemberId: OWNER,
  people: [
    person(OWNER, "Ada", { role: "owner" }),
    person(ADMIN, "Grace", { role: "admin" }),
    person(MEMBER, "Linus"),
    person(UNCLAIMED, "Margaret", {
      claimed: false,
      login: null,
      verifiedAt: null,
    }),
  ],
  morePeople: 0,
  ownershipOffer: null,
  maxUnclaimedMembers: 50,
};

function known(overrides: Partial<PeopleView> = {}): PeopleScreenView {
  return { kind: "known", state: { ...READY, ...overrides } as PeopleView };
}

const PENDING: PendingJoinRequestView = {
  joinRequestId: REQUEST,
  requestedName: "Katherine",
  login: "kjohnson",
  verifiedAt: VERIFIED_AT,
  accountCreatedAt: ACCOUNT_CREATED_AT,
  createdAt: VERIFIED_AT,
  expiresAt: EXPIRES_AT,
};

const BLOCK: BlockedJoinRequestView = {
  joinRequestId: BLOCKED,
  requestedName: "Mallory",
  login: "mallory",
  verifiedAt: "2026-11-01T09:00:00.000Z",
  accountCreatedAt: "2026-10-30T00:00:00.000Z",
  createdAt: "2026-11-01T09:00:00.000Z",
  blockedAt: BLOCKED_AT,
};

const LISTED: JoinRequestsView = {
  revision: 7,
  status: "ready",
  workspaceId: WORKSPACE,
  pending: [PENDING],
  blocked: [BLOCK],
  pausedAt: null,
};

function listed(
  overrides: Partial<JoinRequestsView> = {},
): JoinRequestsScreenView {
  return {
    kind: "known",
    state: { ...LISTED, ...overrides } as JoinRequestsView,
  };
}

/** A fixed locale and a time zone that is not UTC, whatever the machine's. */
const ISTANBUL = { locale: "en-GB", timeZone: "Europe/Istanbul" };
// The shared formats, made once (#259).
const DATE_FORMAT = peopleDateFormat(ISTANBUL);
const TIME_FORMAT = offerTimeFormat(ISTANBUL);

interface HostProps {
  readonly children?: ReactNode;
  readonly id?: string;
  readonly type?: string;
  readonly name?: string;
  readonly checked?: boolean;
  readonly value?: string;
  readonly "aria-describedby"?: string;
  readonly "aria-disabled"?: string;
  readonly onClick?: (event: { readonly currentTarget: unknown }) => void;
  readonly onChange?: (event: {
    readonly currentTarget: { readonly value: string };
  }) => void;
  readonly onSubmit?: (event: { readonly preventDefault: () => void }) => void;
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
  const people: PeopleActionHandlers = {
    onStart: (request: PeopleActionRequest) =>
      calls.push(`people ${request.kind}`),
    onConfirm: () => calls.push("people confirm"),
    onCancel: () => calls.push("people cancel"),
    onDialogDraft: () => calls.push("people draft"),
    onDefineDraft: () => calls.push("define draft"),
    onDefine: () => calls.push("define"),
  };
  const invitations: InvitationActionHandlers = {
    onStart: (request: InvitationActionRequest) =>
      calls.push(`invitation ${request.kind}`),
    onConfirm: () => calls.push("invitation confirm"),
    onCancel: () => calls.push("invitation cancel"),
    onCloseCode: () => calls.push("invitation close code"),
    onRefresh: () => calls.push("invitation refresh"),
  };
  const joinRequests: JoinRequestActionHandlers = {
    onStart: (request: JoinRequestActionRequest, button: Element | null) => {
      const target =
        "joinRequestId" in request ? ` ${request.joinRequestId}` : "";
      calls.push(
        `${request.kind} ${request.workspaceId}${target} ${String(button)}`,
      );
    },
    onConfirm: () => calls.push("confirm"),
    onCancel: () => calls.push("cancel"),
    onDraft: (text: string) => calls.push(`draft ${text}`),
    onChoose: (memberId: string) => calls.push(`choose ${memberId}`),
    onCloseCode: () => calls.push("close code"),
    onRefresh: () => calls.push("refresh"),
  };
  return { calls, people, invitations, joinRequests };
}

interface Props {
  readonly view?: PeopleScreenView;
  readonly joinRequests?: JoinRequestsScreenView;
  readonly actions?: PeopleActionsView;
  readonly joinRequestActions?: JoinRequestActionsView;
  readonly invitationRunning?: boolean;
  readonly handlers?: ReturnType<typeof recorder>;
  readonly withJoinRequests?: boolean;
}

function screen({
  view = known(),
  joinRequests = listed(),
  actions = IDLE_PEOPLE_ACTIONS,
  joinRequestActions = IDLE_JOIN_REQUEST_ACTIONS,
  invitationRunning = false,
  handlers = recorder(),
  withJoinRequests = true,
}: Props) {
  return (
    <PeopleScreenContent
      view={view}
      now={NOW}
      actions={actions}
      handlers={handlers.people}
      invitations={{ kind: "pending" }}
      invitationActions={{
        ...IDLE_INVITATION_ACTIONS,
        running: invitationRunning,
      }}
      invitationHandlers={handlers.invitations}
      joinRequests={joinRequests}
      joinRequestActions={joinRequestActions}
      joinRequestHandlers={withJoinRequests ? handlers.joinRequests : undefined}
      dateFormat={DATE_FORMAT}
      timeFormat={TIME_FORMAT}
    />
  );
}

function render(props: Props = {}): string {
  return renderToString(screen(props));
}

/** The markup of the join requests part. */
function partOf(html: string): string {
  const start = html.indexOf('<section class="join-requests"');
  return start === -1
    ? ""
    : html.slice(start, html.indexOf("</section>", start));
}

test("the owner and the admins see each pending request with its requested name, its requester's login with the verified date, the creation date of that GitHub account, its end, and its actions, then the blocked accounts", () => {
  const verified = DATE_FORMAT.format(new Date(VERIFIED_AT));
  const created = DATE_FORMAT.format(new Date(ACCOUNT_CREATED_AT));
  const expires = TIME_FORMAT.format(new Date(EXPIRES_AT));
  const blockedAt = TIME_FORMAT.format(new Date(BLOCKED_AT));
  for (const own of [OWNER, ADMIN]) {
    const html = render({ view: known({ ownMemberId: own }) });
    expect(partOf(html)).toBe(
      `<section class="join-requests" aria-labelledby="join-requests-heading"><h3 class="people-heading" id="join-requests-heading">Join requests</h3><p class="people-status" role="status"></p><div class="people-offer"><p id="join-requests-pause-line">New join requests are accepted.</p><div class="account-actions"><button type="button" class="panel-action" aria-describedby="join-requests-pause-line">Pause new requests</button></div></div><ul class="people-list" aria-labelledby="join-requests-heading"><li class="person"><p class="person-name"><span dir="auto" id="join-requests-heading-request-0">Katherine</span></p><p class="person-meta">GitHub <span class="person-login" translate="no">kjohnson</span>, last verified <time dateTime="${VERIFIED_AT}">${verified}</time></p><p class="person-meta">GitHub account created <time dateTime="${ACCOUNT_CREATED_AT}">${created}</time></p><p class="person-meta">Expires <time dateTime="${EXPIRES_AT}">${expires}</time></p><div class="account-actions"><button type="button" class="panel-action" aria-describedby="join-requests-heading-request-0">Approve</button><button type="button" class="panel-action" aria-describedby="join-requests-heading-request-0">Deny and invite instead</button><button type="button" class="panel-action" aria-describedby="join-requests-heading-request-0">Deny</button><button type="button" class="panel-action" aria-describedby="join-requests-heading-request-0">Block</button></div></li></ul><div class="account-actions"><button type="button" class="panel-action">Deny all</button><button type="button" class="panel-action">Refresh the join requests</button></div><h4 class="people-heading" id="blocked-accounts-heading">Blocked accounts</h4><ul class="people-list" aria-labelledby="blocked-accounts-heading"><li class="person"><p class="person-name"><span dir="auto" id="blocked-accounts-heading-request-0">Mallory</span></p><p class="person-meta">GitHub <span class="person-login" translate="no">mallory</span>, last verified <time dateTime="2026-11-01T09:00:00.000Z">1 Nov 2026</time></p><p class="person-meta">GitHub account created <time dateTime="2026-10-30T00:00:00.000Z">30 Oct 2026</time></p><p class="person-meta">Blocked <time dateTime="${BLOCKED_AT}">${blockedAt}</time></p><div class="account-actions"><button type="button" class="panel-action" aria-describedby="blocked-accounts-heading-request-0">Unblock</button></div></li></ul>`,
    );
  }
  // In Istanbul's time, three hours ahead of UTC.
  expect(verified).toBe("11 Nov 2026");
  expect(expires).toBe("18 Nov 2026, 12:00");
  expect(blockedAt).toBe("2 Nov 2026, 13:00");
  // Below the open invitations, before the leave.
  const html = render({ view: known({ ownMemberId: ADMIN }) });
  expect(html.indexOf("join-requests-heading")).toBeGreaterThan(
    html.indexOf("invitations-heading"),
  );
  expect(html.indexOf("join-requests-heading")).toBeLessThan(
    html.indexOf(">Leave this workspace<"),
  );
});

test("the pause shows its time and offers to accept new requests again; a blocked account whose data was erased shows no login", () => {
  const html = partOf(
    render({
      joinRequests: listed({
        pausedAt: PAUSED_AT,
        pending: [],
        blocked: [
          {
            ...BLOCK,
            joinRequestId: ERASED,
            login: null,
            verifiedAt: null,
            accountCreatedAt: null,
          },
        ],
      }),
    }),
  );
  const paused = TIME_FORMAT.format(new Date(PAUSED_AT));
  expect(html).toContain(
    `<p id="join-requests-pause-line">New join requests have been paused since <time dateTime="${PAUSED_AT}">${paused}</time>. Pending requests stay open.</p><div class="account-actions"><button type="button" class="panel-action" aria-describedby="join-requests-pause-line">Accept new requests again</button></div>`,
  );
  expect(paused).toBe("12 Nov 2026, 11:00");
  expect(html).toContain(
    '<span dir="auto" id="blocked-accounts-heading-request-0">Mallory</span></p><p class="person-meta">No GitHub login</p><p class="person-meta">Blocked ',
  );
  // Without a pending request: the empty text, and no Deny all.
  expect(html).toContain(
    '<p class="people-status" role="status">No pending join requests.</p>',
  );
  expect(html).not.toContain(">Deny all<");
  expect(html).not.toContain('aria-labelledby="join-requests-heading"><li');
});

test("a member sees no join requests part, and nobody does without the bridges, before the people are ready, or while the join requests say not_allowed", () => {
  const cases: Props[] = [
    { view: known({ ownMemberId: MEMBER }) },
    { withJoinRequests: false },
    { view: known({ status: "loading" }) },
    {
      joinRequests: listed({ status: "not_allowed", pending: [], blocked: [] }),
    },
  ];
  for (const props of cases) {
    const html = render(props);
    expect(html).not.toContain("join-requests-heading");
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain(">Refresh the join requests<");
    expect(html).not.toContain("Katherine");
  }
  // Without the bridges, no paragraph for their sentence and no dialogs of their own.
  const without = render({ withJoinRequests: false });
  expect(without).not.toContain("join-request-action-message");
  expect(without.match(/<dialog/g)).toHaveLength(3);
  // A member keeps the paragraph and the dialogs, which stay empty.
  const member = render({ view: known({ ownMemberId: MEMBER }) });
  expect(member).toContain(
    '<p class="people-status" id="join-request-action-message" role="status"></p>',
  );
  expect(
    member.match(/<dialog class="people-dialog"><\/dialog>/g),
  ).toHaveLength(5);
});

test("the part shows its state's text: checking, loading, another workspace's state, and a problem with what was loaded before", () => {
  const status = (joinRequests: JoinRequestsScreenView) =>
    /<p class="people-status" role="status">([^<]*)<\/p>/.exec(
      partOf(render({ joinRequests })),
    )?.[1];
  expect(status({ kind: "pending" })).toBe("Checking the join requests.");
  expect(status({ kind: "unavailable" })).toBe(
    "Join requests are not available.",
  );
  expect(status(listed({ status: "loading", pending: [], blocked: [] }))).toBe(
    "Loading the join requests.",
  );
  const elsewhere = listed({
    workspaceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4",
  });
  expect(status(elsewhere)).toBe("Loading the join requests.");
  expect(partOf(render({ joinRequests: elsewhere }))).not.toContain(
    "Katherine",
  );
  const failed = listed({
    status: "unavailable",
    problem: "unavailable",
  } as Partial<JoinRequestsView>);
  expect(status(failed)).toBe(
    "The server could not be reached. Trying again later.",
  );
  expect(partOf(render({ joinRequests: failed }))).toContain("Katherine");
});

test("each button starts its own action with the shown workspace and gets the button; Refresh asks for the list", () => {
  const handlers = recorder();
  for (const element of elementsOf(screen({ handlers }))) {
    if (element.type === "button") {
      element.props.onClick?.({ currentTarget: "button" });
    }
  }
  expect(
    handlers.calls.filter(
      (call) => !call.startsWith("people") && !call.startsWith("invitation"),
    ),
  ).toEqual([
    `pause ${WORKSPACE} button`,
    `approve ${WORKSPACE} ${REQUEST} button`,
    `invite ${WORKSPACE} ${REQUEST} button`,
    `deny ${WORKSPACE} ${REQUEST} button`,
    `block ${WORKSPACE} ${REQUEST} button`,
    `denyAll ${WORKSPACE} button`,
    "refresh",
    `unblock ${WORKSPACE} ${BLOCKED} button`,
  ]);
});

test("while an action of any kind runs, every control of all three kinds stays focusable and does nothing", () => {
  const running: Props[] = [
    { joinRequestActions: { ...IDLE_JOIN_REQUEST_ACTIONS, running: true } },
    { actions: { ...IDLE_PEOPLE_ACTIONS, running: true } },
    { invitationRunning: true },
  ];
  for (const props of running) {
    const handlers = recorder();
    const html = render({ ...props, handlers });
    const buttons = [...html.matchAll(/<button [^>]*>([^<]*)<\/button>/g)];
    const labels = buttons.map(([, label]) => label);
    for (const label of [
      "Approve",
      "Deny",
      "Block",
      "Deny all",
      "Unblock",
      "Pause new requests",
      "Refresh the join requests",
      "Invite",
      "Make admin",
      "Add person",
    ]) {
      expect(labels, label).toContain(label);
    }
    for (const [button] of buttons) {
      expect(button).toContain('aria-disabled="true"');
    }
    expect(html).not.toContain(" disabled");
    for (const element of elementsOf(screen({ ...props, handlers }))) {
      if (element.type === "button" && element.props.type === "button") {
        expect(
          element.props.onClick,
          String(element.props.children),
        ).toBeUndefined();
      }
    }
    expect(handlers.calls).toEqual([]);
  }
  expect(render()).not.toContain("aria-disabled");
});

test("the sentence of the last join request action sits in its own status paragraph, after the invitation actions' one", () => {
  expect(
    render({
      joinRequestActions: {
        ...IDLE_JOIN_REQUEST_ACTIONS,
        message: "The request was denied.",
      },
    }),
  ).toContain(
    '<p class="people-status" id="invitation-action-message" role="status"></p><p class="people-status" id="join-request-action-message" role="status">The request was denied.</p>',
  );
});

const ON_REQUEST = {
  workspaceId: WORKSPACE,
  joinRequestId: REQUEST,
  name: "Katherine",
  login: "kjohnson",
  accountCreatedAt: ACCOUNT_CREATED_AT,
};

function dialogOf(
  request: JoinRequestActionRequest,
  overrides: Partial<JoinRequestDialog> = {},
): JoinRequestDialog {
  return {
    request,
    draft: "",
    invitee: undefined,
    problem: undefined,
    ...overrides,
  };
}

function question(dialog: JoinRequestDialog | undefined) {
  const handlers = recorder();
  const content = (
    <JoinRequestQuestionContent
      dialog={dialog}
      options={[
        { memberId: UNCLAIMED, name: "Margaret" },
        { memberId: OTHER_UNCLAIMED, name: "Katherine" },
      ]}
      dateFormat={DATE_FORMAT}
      onConfirm={handlers.joinRequests.onConfirm}
      onCancel={handlers.joinRequests.onCancel}
      onDraft={handlers.joinRequests.onDraft}
      onChoose={handlers.joinRequests.onChoose}
    />
  );
  return { content, handlers };
}

test("the questions of deny, deny all, block, and unblock are dialogs with the name and the login as text, their sentence, Cancel first, and their confirming button", () => {
  expect(
    renderToString(question(dialogOf({ kind: "deny", ...ON_REQUEST })).content),
  ).toBe(
    '<dialog class="people-dialog" aria-labelledby="join-request-dialog-title" aria-describedby="join-request-dialog-name join-request-dialog-text"><form><h2 id="join-request-dialog-title">Deny this request?</h2><p class="people-dialog-name" id="join-request-dialog-name"><span dir="auto">Katherine</span> <span class="person-login" translate="no">kjohnson</span></p><p id="join-request-dialog-text">The request ends. The account can ask to join this workspace again later.</p><div class="people-dialog-actions"><button type="button" class="panel-action">Cancel</button><button type="submit" class="panel-action">Deny</button></div></form></dialog>',
  );
  expect(
    renderToString(
      question(dialogOf({ kind: "denyAll", workspaceId: WORKSPACE })).content,
    ),
  ).toBe(
    '<dialog class="people-dialog" aria-labelledby="join-request-dialog-title" aria-describedby="join-request-dialog-text"><form><h2 id="join-request-dialog-title">Deny all pending requests?</h2><p id="join-request-dialog-text">Every pending request of this workspace ends, also one that arrived after this list was shown. The accounts can ask to join again later.</p><div class="people-dialog-actions"><button type="button" class="panel-action">Cancel</button><button type="submit" class="panel-action">Deny all</button></div></form></dialog>',
  );
  expect(
    renderToString(
      question(dialogOf({ kind: "block", ...ON_REQUEST })).content,
    ),
  ).toContain('<h2 id="join-request-dialog-title">Block this account?</h2>');
  // An unblock asks too (the decision of 2026-11-13), also for an account
  // whose data was erased, which has no login.
  const unblock = {
    kind: "unblock",
    workspaceId: WORKSPACE,
    joinRequestId: BLOCKED,
    name: "Mallory",
    login: "mallory",
  } as const;
  expect(renderToString(question(dialogOf(unblock)).content)).toBe(
    '<dialog class="people-dialog" aria-labelledby="join-request-dialog-title" aria-describedby="join-request-dialog-name join-request-dialog-text"><form><h2 id="join-request-dialog-title">Unblock this account?</h2><p class="people-dialog-name" id="join-request-dialog-name"><span dir="auto">Mallory</span> <span class="person-login" translate="no">mallory</span></p><p id="join-request-dialog-text">The block ends, and this account can ask to join this workspace again at once.</p><div class="people-dialog-actions"><button type="button" class="panel-action">Cancel</button><button type="submit" class="panel-action">Unblock</button></div></form></dialog>',
  );
  expect(
    renderToString(question(dialogOf({ ...unblock, login: null })).content),
  ).toContain(
    '<p class="people-dialog-name" id="join-request-dialog-name"><span dir="auto">Mallory</span></p>',
  );
  expect(renderToString(question(undefined).content)).toBe(
    '<dialog class="people-dialog"></dialog>',
  );
  // A pause and a resume never ask.
  for (const kind of ["pause", "resume"] as const) {
    expect(
      renderToString(
        question(dialogOf({ kind, workspaceId: WORKSPACE })).content,
      ),
    ).toBe('<dialog class="people-dialog"></dialog>');
  }
});

/** The creation date of the requester's GitHub account in a question. */
const ACCOUNT_LINE = `<p class="person-meta" id="join-request-dialog-account">GitHub account created <time dateTime="${ACCOUNT_CREATED_AT}">1 Oct 2026</time></p>`;

test("the approval's question shows the creation date of the GitHub account and has a name field with the draft and an alert for its problem; editing it reports the text", () => {
  const { content, handlers } = question(
    dialogOf(
      { kind: "approve", ...ON_REQUEST },
      { draft: "Kate", problem: "Enter a name." },
    ),
  );
  const html = renderToString(content);
  // The question asks to check the date, so it shows it and describes the
  // dialog with it, in the people's date format.
  expect(html).toContain(
    `<dialog class="people-dialog" aria-labelledby="join-request-dialog-title" aria-describedby="join-request-dialog-name join-request-dialog-account join-request-dialog-text"><form><h2 id="join-request-dialog-title">Approve this request?</h2><p class="people-dialog-name" id="join-request-dialog-name"><span dir="auto">Katherine</span> <span class="person-login" translate="no">kjohnson</span></p>${ACCOUNT_LINE}<p id="join-request-dialog-text">`,
  );
  expect(DATE_FORMAT.format(new Date(ACCOUNT_CREATED_AT))).toBe("1 Oct 2026");
  expect(html).toContain(
    '<label class="account-label" for="join-request-dialog-field">Name in this workspace</label><input id="join-request-dialog-field" class="account-input" type="text" dir="auto" autoComplete="off" spellCheck="false" aria-invalid="true" aria-describedby="join-request-dialog-problem" value="Kate"/><p class="panel-message" id="join-request-dialog-problem" role="alert">Enter a name.</p>',
  );
  expect(html).not.toContain("maxLength");
  expect(html).toContain(
    '<button type="submit" class="panel-action">Approve</button>',
  );
  elementsOf(content)
    .find((element) => element.type === "input")
    ?.props.onChange?.({ currentTarget: { value: "Kay" } });
  expect(handlers.calls).toEqual(["draft Kay"]);
  // Deny, block, and unblock do not show the date.
  for (const kind of ["deny", "block"] as const) {
    expect(
      renderToString(question(dialogOf({ kind, ...ON_REQUEST })).content),
    ).not.toContain("join-request-dialog-account");
  }
});

test("Deny and invite instead's question shows the creation date of the GitHub account and offers each unclaimed person, nobody checked until one is chosen, with an alert for its problem; it reports the choice", () => {
  const { content, handlers } = question(
    dialogOf({ kind: "invite", ...ON_REQUEST }),
  );
  const html = renderToString(content);
  expect(html).toContain(
    `aria-describedby="join-request-dialog-name join-request-dialog-account join-request-dialog-text"><form><h2 id="join-request-dialog-title">Deny and invite instead?</h2><p class="people-dialog-name" id="join-request-dialog-name"><span dir="auto">Katherine</span> <span class="person-login" translate="no">kjohnson</span></p>${ACCOUNT_LINE}<p id="join-request-dialog-text">`,
  );
  expect(html).toContain(
    '<fieldset class="join-request-choice" aria-describedby="join-request-dialog-problem"><legend>Person to invite</legend><label class="join-request-option"><input type="radio" name="join-request-invite"/><span><span dir="auto">Margaret</span></span></label><label class="join-request-option"><input type="radio" name="join-request-invite"/><span><span dir="auto">Katherine</span></span></label></fieldset><p class="panel-message" id="join-request-dialog-problem" role="alert"></p>',
  );
  // No new person is offered, and nobody is checked.
  expect(html).not.toContain("new person");
  expect(html).not.toContain("checked");
  expect(html).toContain(
    '<button type="submit" class="panel-action">Create the invitation, then deny</button>',
  );
  const radios = elementsOf(content).filter(
    (element) => element.type === "input",
  );
  for (const radio of radios) {
    radio.props.onChange?.({ currentTarget: { value: "on" } });
  }
  expect(handlers.calls).toEqual([
    `choose ${UNCLAIMED}`,
    `choose ${OTHER_UNCLAIMED}`,
  ]);
  // The chosen person is checked, and only that one.
  const chosen = renderToString(
    question(
      dialogOf({ kind: "invite", ...ON_REQUEST }, { invitee: OTHER_UNCLAIMED }),
    ).content,
  );
  expect(chosen).toContain(
    '<input type="radio" name="join-request-invite"/><span><span dir="auto">Margaret</span></span></label><label class="join-request-option"><input type="radio" name="join-request-invite" checked=""/><span><span dir="auto">Katherine</span>',
  );
  // A confirmation without a person shows its problem in the alert.
  expect(
    renderToString(
      question(
        dialogOf(
          { kind: "invite", ...ON_REQUEST },
          { problem: "Choose the person to invite." },
        ),
      ).content,
    ),
  ).toContain(
    '<p class="panel-message" id="join-request-dialog-problem" role="alert">Choose the person to invite.</p>',
  );
});

test("Deny and invite instead shows only while the workspace has an active unclaimed person", () => {
  expect(partOf(render())).toContain(">Deny and invite instead<");
  const html = partOf(
    render({
      view: known({
        people: READY.people.filter((one) => one.memberId !== UNCLAIMED),
      }),
    }),
  );
  expect(html).toContain(">Approve<");
  expect(html).not.toContain(">Deny and invite instead<");
  expect(html).toContain(
    '<button type="button" class="panel-action" aria-describedby="join-requests-heading-request-0">Approve</button><button type="button" class="panel-action" aria-describedby="join-requests-heading-request-0">Deny</button>',
  );
});

test("the question confirms on submit, and cancels on Cancel, on Escape, and when the browser closes it", () => {
  const { content, handlers } = question(
    dialogOf({ kind: "block", ...ON_REQUEST }),
  );
  const elements = elementsOf(content);
  let prevented = 0;
  const event = {
    preventDefault: () => {
      prevented += 1;
    },
  };
  elements.find((element) => element.type === "form")?.props.onSubmit?.(event);
  elements
    .find(
      (element) => element.type === "button" && element.props.type === "button",
    )
    ?.props.onClick?.({ currentTarget: null });
  const dialog = elements.find((element) => element.type === "dialog");
  dialog?.props.onCancel?.(event);
  dialog?.props.onClose?.();
  expect(handlers.calls).toEqual(["confirm", "cancel", "cancel", "cancel"]);
  expect(prevented).toBe(2);
});

test("the screen shows the open question while it offers its action, and closes it once the action goes away", () => {
  const open = {
    ...IDLE_JOIN_REQUEST_ACTIONS,
    dialog: dialogOf({ kind: "deny", ...ON_REQUEST }),
  };
  expect(render({ joinRequestActions: open })).toContain(
    'aria-labelledby="join-request-dialog-title"',
  );
  for (const props of [
    { joinRequests: listed({ pending: [] }) },
    { view: known({ ownMemberId: MEMBER }) },
    {
      joinRequests: listed({
        status: "not_allowed",
        pending: [],
        blocked: [],
      }),
    },
  ]) {
    expect(render({ ...props, joinRequestActions: open })).not.toContain(
      "join-request-dialog-title",
    );
  }
});

test("D2: the code of Deny and invite instead shows in a code dialog of its own, whose markup never holds the code; the status paragraphs never hold it", () => {
  const html = render({
    joinRequestActions: {
      ...IDLE_JOIN_REQUEST_ACTIONS,
      running: true,
      code: { name: "Katherine", code: CODE, expiresAt: EXPIRES_AT },
    },
  });
  expect(html).toContain('<h2 id="invitation-code-title">Invitation code</h2>');
  expect(html).toContain(
    '<p class="people-dialog-name" id="invitation-code-name"><span dir="auto">Katherine</span></p>',
  );
  expect(html).toContain('<input id="invitation-code-field"');
  expect(html).not.toContain(CODE);
  expect(html).not.toContain(CODE.slice(5, 30));
  // Closed, it is empty again.
  const closed = render();
  expect(closed).not.toContain("invitation-code-title");
});

test("names, logins, and choices are rendered as text with their own direction", () => {
  const markup = '<img src="x" onerror="alert(1)">';
  const rtl = "שלום <b>";
  const html = render({
    view: known({
      people: [
        person(OWNER, "Ada", { role: "owner" }),
        person(UNCLAIMED, rtl, {
          claimed: false,
          login: null,
          verifiedAt: null,
        }),
      ],
    }),
    joinRequests: listed({
      pending: [{ ...PENDING, requestedName: markup }],
      blocked: [{ ...BLOCK, requestedName: rtl }],
    }),
    joinRequestActions: {
      ...IDLE_JOIN_REQUEST_ACTIONS,
      dialog: dialogOf({ kind: "invite", ...ON_REQUEST, name: markup }),
    },
  });
  const escapedMarkup =
    "&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;";
  const escapedRtl = "שלום &lt;b&gt;";
  expect(html).toContain(
    `<span dir="auto" id="join-requests-heading-request-0">${escapedMarkup}</span>`,
  );
  expect(html).toContain(
    `<span dir="auto" id="blocked-accounts-heading-request-0">${escapedRtl}</span>`,
  );
  // The question's name, and its choice of an unclaimed person.
  expect(html).toContain(
    `<p class="people-dialog-name" id="join-request-dialog-name"><span dir="auto">${escapedMarkup}</span> <span class="person-login" translate="no">kjohnson</span></p>`,
  );
  expect(html).toContain(
    `<input type="radio" name="join-request-invite"/><span><span dir="auto">${escapedRtl}</span></span>`,
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
});

function attributeValues(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map(
    ([, value]) => value ?? "",
  );
}

test("the screen with the join requests shows no ID, its element IDs are unique, every reference points to one of them, and nothing uses a style attribute", () => {
  const states: JoinRequestActionsView[] = [
    IDLE_JOIN_REQUEST_ACTIONS,
    {
      ...IDLE_JOIN_REQUEST_ACTIONS,
      dialog: dialogOf({ kind: "approve", ...ON_REQUEST }, { draft: "K" }),
    },
    {
      ...IDLE_JOIN_REQUEST_ACTIONS,
      dialog: dialogOf({ kind: "invite", ...ON_REQUEST }),
    },
    {
      ...IDLE_JOIN_REQUEST_ACTIONS,
      dialog: dialogOf(
        { kind: "invite", ...ON_REQUEST },
        { invitee: UNCLAIMED, problem: "Choose the person to invite." },
      ),
    },
    {
      ...IDLE_JOIN_REQUEST_ACTIONS,
      dialog: dialogOf({ kind: "denyAll", workspaceId: WORKSPACE }),
    },
    {
      ...IDLE_JOIN_REQUEST_ACTIONS,
      dialog: dialogOf({
        kind: "unblock",
        workspaceId: WORKSPACE,
        joinRequestId: BLOCKED,
        name: "Mallory",
        login: "mallory",
      }),
    },
    {
      ...IDLE_JOIN_REQUEST_ACTIONS,
      code: { name: "Katherine", code: CODE, expiresAt: EXPIRES_AT },
      message: "The invitation was created, and the request was denied.",
    },
  ];
  for (const own of [OWNER, ADMIN]) {
    for (const joinRequestActions of states) {
      const html = render({
        view: known({ ownMemberId: own }),
        joinRequestActions,
      });
      if (joinRequestActions.dialog !== undefined) {
        expect(html).toContain('id="join-request-dialog-title"');
      }
      for (const id of IDS) {
        expect(html).not.toContain(id);
      }
      const ids = attributeValues(html, "id");
      expect(new Set(ids).size).toBe(ids.length);
      for (const attribute of ["aria-labelledby", "aria-describedby", "for"]) {
        for (const references of attributeValues(html, attribute)) {
          for (const reference of references.split(" ")) {
            expect(ids, `${attribute} ${reference}`).toContain(reference);
          }
        }
      }
      expect(html).not.toMatch(/\sstyle=/);
    }
  }
});

test("the screen has the join request actions only with all four bridges: the people actions, the invitation actions, the join requests, and their actions", () => {
  const call = () => Promise.reject(new Error("not called"));
  const subscribeState = () => () => undefined;
  const bridges = {
    people: { getState: call, subscribeState } satisfies PeopleBridge,
    peopleActions: {
      define: call,
      rename: call,
      remove: call,
      promote: call,
      demote: call,
      leave: call,
      offerOwnership: call,
      withdrawOwnershipOffer: call,
      acceptOwnershipOffer: call,
    } satisfies PeopleActionsBridge,
    invitations: {
      getState: call,
      subscribeState,
      load: call,
    } satisfies InvitationsBridge,
    invitationActions: {
      create: call,
      revoke: call,
      preview: call,
      accept: call,
    } satisfies InvitationActionsBridge,
    joinRequests: {
      getState: call,
      subscribeState,
      load: call,
    } satisfies JoinRequestsBridge,
    joinRequestActions: {
      approve: call,
      deny: call,
      denyAll: call,
      block: call,
      unblock: call,
      pause: call,
      resume: call,
    } satisfies JoinRequestActionsBridge,
  };
  // With the handlers, the paragraph of the actions' sentence is there; the
  // part itself follows the people, which a server render does not load.
  const paragraph =
    '<p class="people-status" id="join-request-action-message" role="status"></p>';
  expect(renderToString(<PeopleScreen {...bridges} />)).toContain(paragraph);
  for (const name of [
    "peopleActions",
    "invitationActions",
    "joinRequests",
    "joinRequestActions",
  ] as const) {
    const html = renderToString(
      <PeopleScreen {...bridges} {...{ [name]: undefined }} />,
    );
    expect(html, name).not.toContain("join-request-action-message");
  }
  // Without the handlers, no part shows, also for the owner with requests.
  expect(render({ withJoinRequests: false })).not.toContain(
    "join-requests-heading",
  );
});

test("the question opens as a modal dialog of the page, never as a non-modal one, and closes with the question", () => {
  const calls: string[] = [];
  const dialog = {
    open: false,
    showModal() {
      calls.push("showModal");
      this.open = true;
    },
    show() {
      calls.push("show");
      this.open = true;
    },
    close() {
      calls.push("close");
      this.open = false;
    },
  };
  syncModal(dialog, true);
  syncModal(dialog, true);
  syncModal(dialog, false);
  syncModal(dialog, false);
  syncModal(null, true);
  expect(calls).toEqual(["showModal", "close"]);
});

test("after a confirmed action, the focus moves on only while it is on the action's button, which a closed question gives it back to, or on the page", () => {
  const button = { name: "button" } as unknown as Element;
  const body = { name: "body" } as unknown as Element;
  const field = { name: "field" } as unknown as Element;
  expect(focusOnButtonOrPage(button, body, button)).toBe(true);
  expect(focusOnButtonOrPage(body, body, button)).toBe(true);
  expect(focusOnButtonOrPage(null, body, button)).toBe(true);
  expect(focusOnButtonOrPage(field, body, button)).toBe(false);
  expect(focusOnButtonOrPage(field, body, null)).toBe(false);
});

// The sources of the join requests part, without the tests, as text.
const SOURCES = import.meta.glob<string>(
  ["./JoinRequests.tsx", "./join-requests-view.ts"],
  { query: "?raw", import: "default", eager: true },
);

test("D2: no source of the join requests part reaches the clipboard, a log, storage, or another window, so the code goes nowhere but its field", () => {
  expect(Object.keys(SOURCES).sort()).toEqual([
    "./JoinRequests.tsx",
    "./join-requests-view.ts",
  ]);
  const forbidden: [string, RegExp][] = [
    ["clipboard", /clipboard/i],
    ["execCommand", /\bexecCommand\b/],
    ["console", /\bconsole\b/],
    ["localStorage", /\blocalStorage\b/],
    ["sessionStorage", /\bsessionStorage\b/],
    ["indexedDB", /\bindexedDB\b/],
    ["postMessage", /\bpostMessage\b/],
    ["window.open", /\bwindow\.open\b/],
    ["history", /\bhistory\.(?:push|replace)State\b/],
    ["location", /\blocation\b/],
    ["document.title", /\bdocument\.title\b/],
  ];
  for (const [file, source] of Object.entries(SOURCES)) {
    // The comments may name what the code must not do.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(code.length, file).toBeGreaterThan(1_000);
    for (const [name, pattern] of forbidden) {
      expect(pattern.test(code), `${file}: ${name}`).toBe(false);
    }
  }
});
