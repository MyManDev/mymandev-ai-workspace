// The invitations part of the people screen. The components below the
// screen use no hooks except the dialogs' boxes, so the tests render the
// markup and also call the components as functions, walk the returned
// elements, and invoke their event handlers. No DOM is used: the code's
// secrecy (D2) is checked on the controller's views, on the markup that
// they render, and on the sources.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type {
  InvitationActionsBridge,
  InvitationsBridge,
} from "../shared/desktop-bridge.ts";
import type {
  CreateInvitationResult,
  InvitationsView,
  InvitationView,
  PeopleView,
  PersonView,
} from "../shared/ipc-contract.ts";
import {
  INVITATION_CODE_MESSAGES,
  InvitationCodeContent,
  InvitationQuestionContent,
  selectCode,
  showCodeInField,
  type InvitationActionHandlers,
} from "./InvitationActions.tsx";
import {
  createInvitationActions,
  IDLE_INVITATION_ACTIONS,
  type InvitationActionRequest,
  type InvitationActionsView,
  type InvitationCodeView,
  type InvitationsScreenView,
} from "./invitations-view.ts";
import type { PeopleActionHandlers } from "./PeopleActions.tsx";
import { PeopleScreenContent } from "./PeopleScreen.tsx";
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
const FORMER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c5";
const UNLISTED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c8";
const INVITATION = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e1";
const SECOND_INVITATION = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e2";
const NEW_INVITATION = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e3";
const IDS = [
  WORKSPACE,
  OWNER,
  ADMIN,
  MEMBER,
  UNCLAIMED,
  FORMER,
  UNLISTED,
  INVITATION,
  SECOND_INVITATION,
  NEW_INVITATION,
];

/** A code in the protocol's form (`mmdi_`, 48 characters). */
const CODE = "mmdi_Zx9-_Qw8Zx9-_Qw8Zx9-_Qw8Zx9-_Qw8Zx9-_Qw8Kpw";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const ENDS_AT = "2026-11-16T10:00:00.000Z";
const CREATED_ENDS_AT = "2026-11-16T12:00:00.000Z";

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
    person(FORMER, "Alan", { former: true }),
  ],
  morePeople: 0,
  ownershipOffer: null,
  maxUnclaimedMembers: 50,
};

function known(overrides: Partial<PeopleView> = {}): PeopleScreenView {
  return { kind: "known", state: { ...READY, ...overrides } as PeopleView };
}

function invitation(
  invitationId: string,
  memberId: string,
  overrides: Partial<InvitationView> = {},
): InvitationView {
  return {
    invitationId,
    memberId,
    creatorName: "Grace",
    createdAt: "2026-11-09T10:00:00.000Z",
    expiresAt: ENDS_AT,
    ...overrides,
  };
}

const LIVE: InvitationsView = {
  revision: 3,
  status: "ready",
  workspaceId: WORKSPACE,
  invitations: [
    invitation(INVITATION, UNCLAIMED),
    invitation(SECOND_INVITATION, UNLISTED, { creatorName: "Ada" }),
  ],
};

function listed(
  overrides: Partial<InvitationsView> = {},
): InvitationsScreenView {
  return { kind: "known", state: { ...LIVE, ...overrides } as InvitationsView };
}

/** A fixed locale and a time zone that is not UTC, whatever the machine's. */
const ISTANBUL = { locale: "en-GB", timeZone: "Europe/Istanbul" };
const TIME_FORMAT = offerTimeFormat(ISTANBUL);

interface HostProps {
  readonly children?: ReactNode;
  readonly id?: string;
  readonly type?: string;
  readonly value?: string;
  readonly readOnly?: boolean;
  readonly "aria-describedby"?: string;
  readonly "aria-disabled"?: string;
  readonly onClick?: (event: { readonly currentTarget: unknown }) => void;
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
    onStart: (request: InvitationActionRequest, button: Element | null) => {
      const target =
        request.kind === "invite" ? request.memberId : request.invitationId;
      calls.push(
        `${request.kind} ${request.workspaceId} ${target} ${String(button)}`,
      );
    },
    onConfirm: () => calls.push("confirm"),
    onCancel: () => calls.push("cancel"),
    onCloseCode: () => calls.push("close code"),
    onRefresh: () => calls.push("refresh"),
  };
  return { calls, people, invitations };
}

interface Props {
  readonly view?: PeopleScreenView;
  readonly invitations?: InvitationsScreenView;
  readonly actions?: PeopleActionsView;
  readonly invitationActions?: InvitationActionsView;
  readonly handlers?: ReturnType<typeof recorder> | undefined;
  readonly withInvitations?: boolean;
  readonly now?: number;
}

function screen({
  view = known(),
  invitations = listed(),
  actions = IDLE_PEOPLE_ACTIONS,
  invitationActions = IDLE_INVITATION_ACTIONS,
  handlers = recorder(),
  withInvitations = true,
  now = NOW,
}: Props) {
  return (
    <PeopleScreenContent
      view={view}
      now={now}
      actions={actions}
      handlers={handlers?.people}
      invitations={invitations}
      invitationActions={invitationActions}
      invitationHandlers={withInvitations ? handlers?.invitations : undefined}
      dateFormat={peopleDateFormat(ISTANBUL)}
      timeFormat={TIME_FORMAT}
    />
  );
}

function render(props: Props = {}): string {
  return renderToString(screen(props));
}

function buttonsOf(props: Props): ReactElement<HostProps>[] {
  return elementsOf(screen(props)).filter(
    (element) => element.type === "button",
  );
}

/** The labels of the buttons in a person's row, after the row's name. */
function rowButtons(html: string, name: string): string[] {
  const start = html.indexOf(`>${name}</span>`);
  const end = html.indexOf("</li>", start);
  return [
    ...html.slice(start, end).matchAll(/<button[^>]*>([^<]*)<\/button>/g),
  ].map(([, label]) => label ?? "");
}

/** The markup of the invitations part. */
function partOf(html: string): string {
  const start = html.indexOf('<section class="invitations"');
  return start === -1
    ? ""
    : html.slice(start, html.indexOf("</section>", start));
}

test("the owner and the admins get Invite first on each unclaimed person's row", () => {
  for (const own of [OWNER, ADMIN]) {
    const html = render({ view: known({ ownMemberId: own }) });
    expect(rowButtons(html, "Margaret")).toEqual([
      "Invite",
      "Rename",
      "Remove",
    ]);
    for (const name of ["Ada", "Grace", "Linus", "Alan"]) {
      expect(rowButtons(html, name)).not.toContain("Invite");
    }
  }
});

test("Invite is described by the person's name, whose ID is the row's place, never the member ID", () => {
  const html = render();
  expect(html).toContain(
    '<p class="person-name"><span dir="auto" id="people-title-person-3">Margaret</span></p>',
  );
  expect(html).toContain(
    '<div class="account-actions"><button type="button" class="panel-action" aria-describedby="people-title-person-3">Invite</button><button type="button" class="panel-action" aria-describedby="people-title-person-3">Rename</button>',
  );
  // Without the people actions, Invite still has its row and its name.
  const alone = renderToString(
    <PeopleScreenContent
      view={known()}
      now={NOW}
      invitations={listed()}
      invitationHandlers={recorder().invitations}
      dateFormat={peopleDateFormat(ISTANBUL)}
      timeFormat={TIME_FORMAT}
    />,
  );
  expect(alone).toContain(
    '<span dir="auto" id="people-title-person-3">Margaret</span></p><p class="person-meta">Member</p><p class="person-meta">Not claimed yet</p><div class="account-actions"><button type="button" class="panel-action" aria-describedby="people-title-person-3">Invite</button></div>',
  );
});

test("the open invitations show each invited person and creator as text, the end in the person's time zone, and Revoke described by the name", () => {
  const html = render();
  const end = TIME_FORMAT.format(new Date(ENDS_AT));
  expect(partOf(html)).toBe(
    `<section class="invitations" aria-labelledby="invitations-heading"><h3 class="people-heading" id="invitations-heading">Open invitations</h3><p class="people-status" role="status"></p><ul class="people-list" aria-labelledby="invitations-heading"><li class="person"><p class="person-name"><span dir="auto" id="invitations-heading-invitation-0">Margaret</span></p><p class="person-meta">Created by <span dir="auto">Grace</span></p><p class="person-meta">Expires <time dateTime="${ENDS_AT}">${end}</time></p><div class="account-actions"><button type="button" class="panel-action" aria-describedby="invitations-heading-invitation-0">Revoke</button></div></li><li class="person"><p class="person-name"><span id="invitations-heading-invitation-1">A person who is not shown here</span></p><p class="person-meta">Created by <span dir="auto">Ada</span></p><p class="person-meta">Expires <time dateTime="${ENDS_AT}">${end}</time></p><div class="account-actions"><button type="button" class="panel-action" aria-describedby="invitations-heading-invitation-1">Revoke</button></div></li></ul><div class="account-actions"><button type="button" class="panel-action">Refresh the invitations</button></div>`,
  );
  // In Istanbul's time, three hours ahead of UTC.
  expect(end).toBe("16 Nov 2026, 13:00");
  // Below the people, before the leave and the note.
  expect(html.indexOf("invitations-heading")).toBeGreaterThan(
    html.indexOf("former-people-heading"),
  );
});

test("the part shows its state's text: loading, empty, unavailable with what was loaded, and not available", () => {
  const status = (invitations: InvitationsScreenView) =>
    /<p class="people-status" role="status">([^<]*)<\/p>/.exec(
      partOf(render({ invitations })),
    )?.[1];
  expect(status(listed({ status: "loading", invitations: [] }))).toBe(
    "Loading the invitations.",
  );
  expect(status(listed({ invitations: [] }))).toBe("No open invitations.");
  expect(status({ kind: "pending" })).toBe("Checking the invitations.");
  expect(status({ kind: "unavailable" })).toBe(
    "Invitations are not available.",
  );
  const failed = listed({
    status: "unavailable",
    problem: "unavailable",
  } as Partial<InvitationsView>);
  expect(status(failed)).toBe(
    "The server could not be reached. Trying again later.",
  );
  expect(partOf(render({ invitations: failed }))).toContain("Revoke");
  expect(
    partOf(render({ invitations: listed({ invitations: [] }) })),
  ).not.toContain("<ul");
});

test("members see no invitations part and no Invite, and nobody does without the bridges or before the people are ready", () => {
  const cases: Props[] = [
    { view: known({ ownMemberId: MEMBER }) },
    { withInvitations: false },
    { view: known({ status: "loading" }) },
    {
      view: known({
        status: "unavailable",
        problem: "failed",
      } as Partial<PeopleView>),
    },
  ];
  for (const props of cases) {
    const html = render(props);
    expect(html).not.toContain("invitations-heading");
    expect(html).not.toContain(">Invite<");
    expect(html).not.toContain(">Refresh the invitations<");
  }
  // Without the bridges, no paragraph for their sentence and no dialogs.
  const without = render({ withInvitations: false });
  expect(without).not.toContain("invitation-action-message");
  expect(without.match(/<dialog/g)).toHaveLength(1);
  // A member keeps the paragraph and the dialogs, which stay empty.
  const member = render({ view: known({ ownMemberId: MEMBER }) });
  expect(member).toContain(
    '<p class="people-status" id="invitation-action-message" role="status"></p>',
  );
  expect(
    member.match(/<dialog class="people-dialog"><\/dialog>/g),
  ).toHaveLength(3);
});

test("each button starts its own action with the shown workspace and gets the button; Refresh asks for the list", () => {
  const handlers = recorder();
  for (const button of buttonsOf({ handlers })) {
    button.props.onClick?.({ currentTarget: "button" });
  }
  expect(handlers.calls.filter((call) => !call.startsWith("people"))).toEqual([
    `invite ${WORKSPACE} ${UNCLAIMED} button`,
    `revoke ${WORKSPACE} ${INVITATION} button`,
    `revoke ${WORKSPACE} ${SECOND_INVITATION} button`,
    "refresh",
  ]);
});

test("while an action of either kind runs, every control of both kinds stays focusable and does nothing", () => {
  const running: Props[] = [
    { invitationActions: { ...IDLE_INVITATION_ACTIONS, running: true } },
    { actions: { ...IDLE_PEOPLE_ACTIONS, running: true } },
  ];
  for (const props of running) {
    const handlers = recorder();
    const html = render({ ...props, handlers });
    const buttons = [...html.matchAll(/<button [^>]*>([^<]*)<\/button>/g)];
    const labels = buttons.map(([, label]) => label);
    for (const label of [
      "Invite",
      "Rename",
      "Revoke",
      "Refresh the invitations",
      "Make admin",
      "Add person",
    ]) {
      expect(labels, label).toContain(label);
    }
    for (const [button] of buttons) {
      expect(button).toContain('aria-disabled="true"');
    }
    expect(html).not.toContain(" disabled");
    const elements = elementsOf(screen({ ...props, handlers }));
    for (const element of elements) {
      if (element.type === "button" && element.props.type === "button") {
        expect(
          element.props.onClick,
          String(element.props.children),
        ).toBeUndefined();
      }
    }
    elements
      .find((element) => element.type === "form")
      ?.props.onSubmit?.({ preventDefault: () => undefined });
    expect(handlers.calls).toEqual([]);
  }
  expect(render()).not.toContain("aria-disabled");
});

test("the sentence of the last invitation action sits in its own status paragraph, next to the people actions' one", () => {
  expect(
    render({
      invitationActions: {
        ...IDLE_INVITATION_ACTIONS,
        message: "The invitation was revoked.",
      },
    }),
  ).toContain(
    '<p class="people-status" id="people-action-message" role="status"></p><p class="people-status" id="invitation-action-message" role="status">The invitation was revoked.</p>',
  );
});

const INVITE: InvitationActionRequest = {
  kind: "invite",
  workspaceId: WORKSPACE,
  memberId: UNCLAIMED,
  name: "Margaret",
};
const REVOKE: InvitationActionRequest = {
  kind: "revoke",
  workspaceId: WORKSPACE,
  invitationId: INVITATION,
  name: "Margaret",
};

function question(request: InvitationActionRequest | undefined) {
  const handlers = recorder();
  const content = (
    <InvitationQuestionContent
      question={request}
      onConfirm={handlers.invitations.onConfirm}
      onCancel={handlers.invitations.onCancel}
    />
  );
  return { content, handlers };
}

test("the question before a create is a dialog with the name as text, its sentence, Cancel first, and Create the invitation", () => {
  expect(renderToString(question(INVITE).content)).toBe(
    '<dialog class="people-dialog" aria-labelledby="invitation-dialog-title" aria-describedby="invitation-dialog-name invitation-dialog-text"><form><h2 id="invitation-dialog-title">Invite this person?</h2><p class="people-dialog-name" id="invitation-dialog-name"><span dir="auto">Margaret</span></p><p id="invitation-dialog-text">This creates an invitation code with which one person can claim this person, once, within 7 days. The code is shown only once, right after it is created. If this person already has an open invitation, that invitation is revoked and its code stops working.</p><div class="people-dialog-actions"><button type="button" class="panel-action">Cancel</button><button type="submit" class="panel-action">Create the invitation</button></div></form></dialog>',
  );
  expect(renderToString(question({ ...REVOKE, name: null }).content)).toContain(
    '<h2 id="invitation-dialog-title">Revoke this invitation?</h2><p class="people-dialog-name" id="invitation-dialog-name"><span dir="auto">A person who is not shown here</span></p>',
  );
  expect(renderToString(question(undefined).content)).toBe(
    '<dialog class="people-dialog"></dialog>',
  );
});

test("the question confirms on submit, and cancels on Cancel, on Escape, and when the browser closes it", () => {
  const { content, handlers } = question(REVOKE);
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
  const open = { ...IDLE_INVITATION_ACTIONS, question: REVOKE };
  expect(render({ invitationActions: open })).toContain(
    'aria-labelledby="invitation-dialog-title"',
  );
  for (const props of [
    { invitations: listed({ invitations: [] }) },
    { view: known({ ownMemberId: MEMBER }) },
    { now: Date.parse(ENDS_AT) },
  ]) {
    expect(render({ ...props, invitationActions: open })).not.toContain(
      "invitation-dialog-title",
    );
  }
});

const SHOWN: InvitationCodeView = {
  name: "Margaret",
  code: CODE,
  expiresAt: CREATED_ENDS_AT,
};

function codeDialog(code: InvitationCodeView | undefined) {
  const handlers = recorder();
  let selected = 0;
  const content = (
    <InvitationCodeContent
      code={code}
      format={TIME_FORMAT}
      onClose={handlers.invitations.onCloseCode}
      onSelect={() => {
        selected += 1;
      }}
    />
  );
  return { content, handlers, selections: () => selected };
}

test("D2: the code's dialog has a read-only field for the code, says that it shows only now and must be passed on privately, gives the end, and has Select the code and Close; its markup never holds the code", () => {
  const end = TIME_FORMAT.format(new Date(CREATED_ENDS_AT));
  const html = renderToString(codeDialog(SHOWN).content);
  expect(html).toBe(
    `<dialog class="people-dialog" aria-labelledby="invitation-code-title" aria-describedby="invitation-code-name invitation-code-text"><div class="invitation-code-content"><h2 id="invitation-code-title">Invitation code</h2><p class="people-dialog-name" id="invitation-code-name"><span dir="auto">Margaret</span></p><p id="invitation-code-text">This code is shown only now. Once you close this, it cannot be shown again. Pass it on privately, only to this person, for example in a direct message: anyone who has the code can claim this person.</p><label class="account-label" for="invitation-code-field">Code</label><input id="invitation-code-field" class="account-input invitation-code" type="text" dir="ltr" translate="no" readOnly="" autoComplete="off" spellCheck="false" aria-describedby="invitation-code-expiry"/><p id="invitation-code-expiry">It can be used once, until <time dateTime="${CREATED_ENDS_AT}">${end}</time>.</p><div class="people-dialog-actions"><button type="button" class="panel-action">Select the code</button><button type="button" class="panel-action">Close</button></div></div></dialog>`,
  );
  // The code reaches the field only through `showCodeInField`.
  expect(html).not.toContain(CODE);
  expect(html).not.toContain("value=");
  // Closed, the dialog stays in the page, empty.
  expect(renderToString(codeDialog(undefined).content)).toBe(
    '<dialog class="people-dialog"></dialog>',
  );
});

test("D2: the code's field has no name, no value or default value, and sits in no form, so nothing sends it, and Enter in it closes nothing", () => {
  const elements = elementsOf(codeDialog(SHOWN).content);
  expect(elements.some((element) => element.type === "form")).toBe(false);
  const field = elements.find((element) => element.type === "input");
  expect(field?.props.readOnly).toBe(true);
  const keys = Object.keys(field?.props ?? {});
  for (const key of ["name", "value", "defaultValue"]) {
    expect(keys, key).not.toContain(key);
  }
  expect(
    JSON.stringify(elements.map((element) => element.props)),
  ).not.toContain(CODE);
  expect(
    elements.filter(
      (element) => element.type === "button" && element.props.type !== "button",
    ),
  ).toEqual([]);
});

test("D2: Select the code selects the field and Close, Escape, and the browser's close all close the dialog", () => {
  const { content, handlers, selections } = codeDialog(SHOWN);
  const elements = elementsOf(content);
  const buttons = elements.filter((element) => element.type === "button");
  expect(buttons.map((button) => button.props.children)).toEqual([
    INVITATION_CODE_MESSAGES.select,
    INVITATION_CODE_MESSAGES.close,
  ]);
  buttons[0]?.props.onClick?.({ currentTarget: null });
  expect(selections()).toBe(1);
  expect(handlers.calls).toEqual([]);
  buttons[1]?.props.onClick?.({ currentTarget: null });
  let prevented = 0;
  const dialog = elements.find((element) => element.type === "dialog");
  dialog?.props.onCancel?.({
    preventDefault: () => {
      prevented += 1;
    },
  });
  dialog?.props.onClose?.();
  expect(handlers.calls).toEqual(["close code", "close code", "close code"]);
  expect(prevented).toBe(1);
});

test("D2: selecting the code only focuses and selects the field, and touches nothing else, the clipboard least of all", () => {
  const touched: string[] = [];
  const field = new Proxy(
    {
      focus: () => touched.push("focus()"),
      select: () => touched.push("select()"),
    },
    {
      get(target, key, receiver) {
        touched.push(String(key));
        return Reflect.get(target, key, receiver) as unknown;
      },
      set(_target, key) {
        touched.push(`set ${String(key)}`);
        return false;
      },
    },
  );
  selectCode(field);
  expect(touched).toEqual(["focus", "focus()", "select", "select()"]);
  // Before the field exists, nothing happens.
  expect(() => selectCode(null)).not.toThrow();
});

test("D2: the dialog's effect puts the code into the field's value property only, and its cleanup empties the same field", () => {
  const touched: string[] = [];
  let value = "";
  const field = new Proxy(
    { value: "" },
    {
      get(_target, key) {
        touched.push(`get ${String(key)}`);
        return key === "value" ? value : undefined;
      },
      set(_target, key, next: unknown) {
        touched.push(
          `set ${String(key)} ${next === CODE ? "the code" : JSON.stringify(next)}`,
        );
        if (key === "value") {
          value = String(next);
        }
        return true;
      },
    },
  );
  const clear = showCodeInField(field, CODE);
  expect(touched).toEqual(["set value the code"]);
  expect(value).toBe(CODE);
  clear();
  expect(touched).toEqual(["set value the code", 'set value ""']);
  expect(value).toBe("");
  // Without a field, or without a code, nothing is touched.
  touched.length = 0;
  showCodeInField(null, CODE)();
  showCodeInField(field, undefined)();
  expect(touched).toEqual([]);
});

/** How often `text` appears in `html`. */
function count(html: string, text: string): number {
  return html.split(text).length - 1;
}

/** The contents of every `role="status"` paragraph. */
function statusTexts(html: string): string[] {
  return [...html.matchAll(/<p [^>]*role="status"[^>]*>([^<]*)<\/p>/g)].map(
    ([, text]) => text ?? "",
  );
}

/** A controller over fake bridges whose create answers with `CODE`. */
function createdController() {
  const bridge = {
    create: () =>
      Promise.resolve<CreateInvitationResult>({
        outcome: "ok",
        invitationId: NEW_INVITATION,
        code: CODE,
        expiresAt: CREATED_ENDS_AT,
      }),
    revoke: () => Promise.resolve({ outcome: "ok" as const }),
  } as unknown as Pick<InvitationActionsBridge, "create" | "revoke">;
  const list = {
    load: () => Promise.resolve({ outcome: "loading" as const }),
  } as unknown as Pick<InvitationsBridge, "load">;
  const views: InvitationActionsView[] = [];
  const actions = createInvitationActions(bridge, list, (view) =>
    views.push(view),
  );
  actions.listChanged(known(), listed(), NOW);
  return {
    actions,
    views,
    last: () => views.at(-1) ?? IDLE_INVITATION_ACTIONS,
  };
}

test("D2: while the dialog is open, the rendered screen holds the code nowhere, the field's value property being the only place for it, and no status paragraph holds it; once it closes, nothing rendered holds it", async () => {
  const { actions, views, last } = createdController();
  actions.start(INVITE);
  await actions.confirm();
  expect(last().code?.code).toBe(CODE);
  const open = render({ invitationActions: last() });
  expect(open).toContain('<input id="invitation-code-field"');
  expect(count(open, CODE)).toBe(0);
  expect(count(open, CODE.slice(5, 30))).toBe(0);
  expect(statusTexts(open)).toContain("The invitation was created.");
  for (const text of statusTexts(open)) {
    expect(text).not.toContain(CODE);
  }
  // The person's row still offers Invite; the page is inert behind the modal.
  expect(open).toContain(">Invite<");

  const before = views.length;
  actions.closeCode();
  const closed = render({ invitationActions: last() });
  expect(count(closed, CODE)).toBe(0);
  expect(count(closed, CODE.slice(5, 30))).toBe(0);
  expect(closed).toContain('<dialog class="people-dialog"></dialog>');
  expect(statusTexts(closed)).toContain("The invitation was created.");
  // Every view after the close renders without the code, also with the new
  // invitation listed and after another action.
  actions.listChanged(
    known(),
    listed({
      revision: 9,
      invitations: [invitation(NEW_INVITATION, UNCLAIMED)],
    }),
    NOW,
  );
  actions.start({ ...REVOKE, invitationId: NEW_INVITATION });
  await actions.confirm();
  for (const view of views.slice(before)) {
    const html = render({
      invitationActions: view,
      invitations: listed({
        invitations: [invitation(NEW_INVITATION, UNCLAIMED)],
      }),
    });
    expect(count(html, CODE)).toBe(0);
  }
});

test("names are rendered as text with their own direction in the rows, the questions, and the code's dialog", () => {
  const markup = '<img src="x" onerror="alert(1)">';
  const rtl = "שלום <b>";
  const view = known({
    people: [
      person(OWNER, "Ada", { role: "owner" }),
      person(UNCLAIMED, rtl, { claimed: false, login: null, verifiedAt: null }),
    ],
  });
  const html = render({
    view,
    invitations: listed({
      invitations: [invitation(INVITATION, UNCLAIMED, { creatorName: markup })],
    }),
    invitationActions: {
      ...IDLE_INVITATION_ACTIONS,
      code: { ...SHOWN, name: markup },
    },
  });
  const escapedMarkup =
    "&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;";
  const escapedRtl = "שלום &lt;b&gt;";
  expect(html).toContain(
    `<span dir="auto" id="invitations-heading-invitation-0">${escapedRtl}</span>`,
  );
  expect(html).toContain(`Created by <span dir="auto">${escapedMarkup}</span>`);
  expect(html).toContain(
    `<p class="people-dialog-name" id="invitation-code-name"><span dir="auto">${escapedMarkup}</span></p>`,
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
  expect(renderToString(question({ ...INVITE, name: rtl }).content)).toContain(
    `<span dir="auto">${escapedRtl}</span>`,
  );
});

function attributeValues(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map(
    ([, value]) => value ?? "",
  );
}

test("the screen with the invitations shows no ID, its element IDs are unique, every reference points to one of them, and nothing uses a style attribute", () => {
  const states: InvitationActionsView[] = [
    IDLE_INVITATION_ACTIONS,
    { ...IDLE_INVITATION_ACTIONS, question: INVITE },
    { ...IDLE_INVITATION_ACTIONS, question: REVOKE },
    {
      ...IDLE_INVITATION_ACTIONS,
      code: SHOWN,
      message: "The invitation was created.",
    },
  ];
  for (const own of [OWNER, ADMIN]) {
    for (const invitationActions of states) {
      const html = render({
        view: known({ ownMemberId: own }),
        invitationActions,
      });
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

// The sources of the invitations part, without the tests, as text.
const SOURCES = import.meta.glob<string>(
  [
    "./InvitationActions.tsx",
    "./invitations-view.ts",
    "./PeopleScreen.tsx",
    "./PeopleActions.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
);

test("D2: no source of the people screen reaches the clipboard, a log, storage, or another window, so the code goes nowhere but its field", () => {
  expect(Object.keys(SOURCES).sort()).toEqual([
    "./InvitationActions.tsx",
    "./PeopleActions.tsx",
    "./PeopleScreen.tsx",
    "./invitations-view.ts",
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
    const code = withoutComments(source);
    expect(code.length, file).toBeGreaterThan(1_000);
    for (const [name, pattern] of forbidden) {
      expect(pattern.test(code), `${file}: ${name}`).toBe(false);
    }
  }
  // The check finds each of them in code.
  const sample = withoutComments(
    [
      "// navigator.clipboard is named in a comment only.",
      "void navigator.clipboard.writeText(code);",
      'document.execCommand("copy");',
      "console.info(code);",
      'localStorage.setItem("code", code);',
      'sessionStorage.setItem("code", code);',
      "indexedDB.open(code);",
      "window.postMessage(code);",
      "window.open(code);",
      'history.pushState(null, "", code);',
      "location.hash = code;",
      "document.title = code;",
    ].join("\n"),
  );
  expect(
    forbidden
      .filter(([, pattern]) => pattern.test(sample))
      .map(([name]) => name),
  ).toEqual(forbidden.map(([name]) => name));
});

/** `source` without its block and line comments; the sources hold no `//` in a string. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("#274: the invitations keep the focus after an action whose button left the page with a later state: the shared hook gets their dialogs, their running state, the people, and the invitations", () => {
  const code = withoutComments(SOURCES["./InvitationActions.tsx"] ?? "")
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/,? \)/g, ")");
  expect(code).toContain(
    'import { useTitleFocusAfterAction } from "./JoinRequests.tsx";',
  );
  // The dialogs are the question and the code's dialog.
  expect(code).toContain(
    "const open = actions.question !== undefined || actions.code !== undefined;",
  );
  expect(code).toContain(
    "useTitleFocusAfterAction(trigger, open, actions.running, people, invitations);",
  );
  // The same button that the dialogs give the focus back to.
  expect(code).toContain("const trigger = useRef<Element | null>(null);");
  expect(code).toContain("trigger.current = button;");
});
