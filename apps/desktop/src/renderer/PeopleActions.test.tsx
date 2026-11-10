// The people actions on the people screen. The components below the screen
// use no hooks except the dialog's box, so the tests render the markup and
// also call the components as functions, walk the returned elements, and
// invoke their event handlers.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type { PeopleView, PersonView } from "../shared/ipc-contract.ts";
import {
  PeopleActionDialogContent,
  type PeopleActionHandlers,
} from "./PeopleActions.tsx";
import { PeopleScreenContent } from "./PeopleScreen.tsx";
import {
  IDLE_PEOPLE_ACTIONS,
  offerTimeFormat,
  type PeopleActionDialog,
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
const IDS = [WORKSPACE, OWNER, ADMIN, MEMBER, UNCLAIMED, FORMER];

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const EXPIRES_AT = "2026-11-12T12:00:00.000Z";

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

/** A fixed locale and a time zone that is not UTC, whatever the machine's. */
const ISTANBUL = { locale: "en-GB", timeZone: "Europe/Istanbul" };

interface HostProps {
  readonly children?: ReactNode;
  readonly id?: string;
  readonly type?: string;
  readonly "aria-describedby"?: string;
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
  const handlers: PeopleActionHandlers = {
    onStart: (request: PeopleActionRequest, button: Element | null) => {
      const target = "memberId" in request ? ` ${request.memberId}` : "";
      calls.push(
        `${request.kind} ${request.workspaceId}${target} ${String(button)}`,
      );
    },
    onConfirm: () => calls.push("confirm"),
    onCancel: () => calls.push("cancel"),
    onDialogDraft: (text) => calls.push(`dialog draft ${text}`),
    onDefineDraft: (text) => calls.push(`define draft ${text}`),
    onDefine: (workspaceId) => calls.push(`define ${workspaceId}`),
  };
  return { calls, handlers };
}

interface Props {
  readonly view?: PeopleScreenView;
  readonly actions?: PeopleActionsView;
  readonly handlers?: PeopleActionHandlers | undefined;
  readonly now?: number;
}

function screen({
  view = known(),
  actions = IDLE_PEOPLE_ACTIONS,
  handlers = recorder().handlers,
  now = NOW,
}: Props) {
  return (
    <PeopleScreenContent
      view={view}
      now={now}
      actions={actions}
      handlers={handlers}
      dateFormat={peopleDateFormat(ISTANBUL)}
      timeFormat={offerTimeFormat(ISTANBUL)}
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

/** The labels of the buttons outside the lists and the dialog. */
function screenButtons(html: string): string[] {
  const outside = html
    .replace(/<ul[\s\S]*?<\/ul>/g, "")
    .replace(/<dialog[\s\S]*?<\/dialog>/g, "");
  return [...outside.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(
    ([, label]) => label ?? "",
  );
}

test("the owner's screen offers each person's actions by the roles table, the definition, and no leave", () => {
  const html = render();
  expect(rowButtons(html, "Ada")).toEqual([]);
  expect(rowButtons(html, "Grace")).toEqual([
    "Make member",
    "Offer ownership",
    "Remove",
  ]);
  expect(rowButtons(html, "Linus")).toEqual([
    "Make admin",
    "Offer ownership",
    "Remove",
  ]);
  expect(rowButtons(html, "Margaret")).toEqual(["Rename", "Remove"]);
  // A former member has none.
  expect(rowButtons(html, "Alan")).toEqual([]);
  expect(screenButtons(html)).toEqual(["Add person"]);
});

test("an admin's screen removes claimed members only, renames and removes unclaimed people, defines, and leaves", () => {
  const html = render({ view: known({ ownMemberId: ADMIN }) });
  expect(rowButtons(html, "Ada")).toEqual([]);
  expect(rowButtons(html, "Grace")).toEqual([]);
  expect(rowButtons(html, "Linus")).toEqual(["Remove"]);
  expect(rowButtons(html, "Margaret")).toEqual(["Rename", "Remove"]);
  expect(screenButtons(html)).toEqual(["Add person", "Leave this workspace"]);
});

test("a member's screen offers only the leave", () => {
  const html = render({ view: known({ ownMemberId: MEMBER }) });
  for (const name of ["Ada", "Grace", "Linus", "Margaret"]) {
    expect(rowButtons(html, name), name).toEqual([]);
  }
  expect(screenButtons(html)).toEqual(["Leave this workspace"]);
  expect(html).not.toContain("define-person");
});

test("without the bridge, or before the people are ready, no action shows", () => {
  for (const html of [
    renderToString(
      <PeopleScreenContent
        view={known()}
        now={NOW}
        actions={IDLE_PEOPLE_ACTIONS}
      />,
    ),
    renderToString(<PeopleScreenContent view={known()} now={NOW} />),
  ]) {
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain("people-action-message");
  }
  for (const view of [
    known({ status: "loading" }),
    known({ status: "unavailable", problem: "failed" } as Partial<PeopleView>),
  ]) {
    expect(render({ view })).not.toContain("<button");
  }
});

test("each person's button starts its action on that person and gets the button; the screen's buttons start theirs", () => {
  const { calls, handlers } = recorder();
  for (const button of buttonsOf({ handlers })) {
    button.props.onClick?.({ currentTarget: "button" });
  }
  expect(calls).toEqual([
    `demote ${WORKSPACE} ${ADMIN} button`,
    `offer ${WORKSPACE} ${ADMIN} button`,
    `remove ${WORKSPACE} ${ADMIN} button`,
    `promote ${WORKSPACE} ${MEMBER} button`,
    `offer ${WORKSPACE} ${MEMBER} button`,
    `remove ${WORKSPACE} ${MEMBER} button`,
    `rename ${WORKSPACE} ${UNCLAIMED} button`,
    `remove ${WORKSPACE} ${UNCLAIMED} button`,
  ]);

  calls.length = 0;
  for (const button of buttonsOf({
    view: known({ ownMemberId: MEMBER }),
    handlers,
  })) {
    button.props.onClick?.({ currentTarget: "leave button" });
  }
  expect(calls).toEqual([`leave ${WORKSPACE} leave button`]);
});

test("each person's buttons are described by the name, whose ID is the person's place, never its member ID", () => {
  const html = render();
  expect(html).toContain(
    '<p class="person-name"><span dir="auto" id="people-title-person-1">Grace</span></p>',
  );
  expect(html).toContain(
    '<button type="button" class="panel-action" aria-describedby="people-title-person-1">Make member</button>',
  );
  // The own person has no action, and its name no ID.
  expect(html).toContain(
    '<p class="person-name"><span dir="auto">Ada</span><span class="person-you"> (you)</span></p>',
  );
});

test("the definition is a name field with Add person, and submits the workspace's definition", () => {
  const { calls, handlers } = recorder();
  const html = render({
    handlers,
    actions: { ...IDLE_PEOPLE_ACTIONS, defineDraft: "<b>Grace</b>" },
  });
  expect(html).toContain(
    '<form class="people-form" aria-labelledby="define-person-title"><h3 class="people-heading" id="define-person-title">Add a person</h3><p class="person-meta" id="define-person-hint">Add someone by name before they join. They show as not claimed until they accept an invitation for this person.</p><label class="account-label" for="define-person-name">Name</label><input id="define-person-name" class="account-input" type="text" dir="auto" autoComplete="off" spellCheck="false" aria-describedby="define-person-hint define-person-problem" value="&lt;b&gt;Grace&lt;/b&gt;"/><p class="panel-message" id="define-person-problem" role="alert"></p><div class="account-actions"><button type="submit" class="panel-action">Add person</button></div></form>',
  );
  // After the active people, before the former members.
  expect(html.indexOf("define-person-title")).toBeLessThan(
    html.indexOf("former-people-heading"),
  );
  const elements = elementsOf(screen({ handlers }));
  const form = elements.find((element) => element.type === "form");
  const input = elements.find(
    (element) => element.props.id === "define-person-name",
  );
  input?.props.onChange?.({ currentTarget: { value: "Grace" } });
  let prevented = false;
  form?.props.onSubmit?.({
    preventDefault: () => {
      prevented = true;
    },
  });
  expect(prevented).toBe(true);
  expect(calls).toEqual(["define draft Grace", `define ${WORKSPACE}`]);
});

test("a problem of the definition's name shows in the field's own alert, not in the status paragraph, and marks the field", () => {
  const html = render({
    actions: {
      ...IDLE_PEOPLE_ACTIONS,
      message: "The person was removed.",
      defineDraft: " ",
      defineProblem: "Enter a name.",
    },
  });
  expect(html).toContain(
    'aria-invalid="true" aria-describedby="define-person-hint define-person-problem" value=" "/><p class="panel-message" id="define-person-problem" role="alert">Enter a name.</p>',
  );
  // The field is not described by the results of other actions.
  expect(html).not.toMatch(/aria-describedby="[^"]*people-action-message/);
  expect(html).toContain(
    '<p class="people-status" id="people-action-message" role="status">The person was removed.</p>',
  );
});

test("while an action runs, every action's control stays focusable and does nothing, and the definition does not submit, for the owner, an admin, and the offer's target", () => {
  const offered = {
    ownershipOffer: { memberId: MEMBER, expiresAt: EXPIRES_AT },
  };
  const cases: [PeopleScreenView, string[]][] = [
    [
      known(offered),
      [
        "Withdraw the offer",
        "Make member",
        "Make admin",
        "Rename",
        "Remove",
        "Add person",
      ],
    ],
    [
      known({ ownMemberId: ADMIN }),
      ["Rename", "Remove", "Add person", "Leave this workspace"],
    ],
    [
      known({ ...offered, ownMemberId: MEMBER }),
      ["Accept the ownership", "Leave this workspace"],
    ],
  ];
  for (const [view, labels] of cases) {
    const { calls, handlers } = recorder();
    const running = {
      view,
      actions: { ...IDLE_PEOPLE_ACTIONS, running: true },
      handlers,
    };
    const html = render(running);
    const buttons = [...html.matchAll(/<button [^>]*>([^<]*)<\/button>/g)];
    const shown = buttons.map(([, label]) => label);
    for (const label of labels) {
      expect(shown, label).toContain(label);
    }
    for (const [button] of buttons) {
      expect(button).toContain('aria-disabled="true"');
    }
    expect(html).not.toContain(" disabled");
    const elements = elementsOf(screen(running));
    const elementButtons = elements.filter(
      (element) => element.type === "button",
    );
    expect(elementButtons).toHaveLength(buttons.length);
    for (const element of elementButtons) {
      if (element.props.type === "button") {
        expect(
          element.props.onClick,
          String(element.props.children),
        ).toBeUndefined();
      }
      element.props.onClick?.({ currentTarget: "button" });
    }
    elements
      .find((element) => element.type === "form")
      ?.props.onSubmit?.({ preventDefault: () => undefined });
    expect(calls).toEqual([]);
    // Idle, none is inert.
    expect(render({ view }), "idle").not.toContain("aria-disabled");
  }
});

test("the sentence of the last action sits in its own status paragraph, always rendered with the bridge", () => {
  expect(render()).toContain(
    '<p class="people-status" role="status"></p><p class="people-status" id="people-action-message" role="status"></p>',
  );
  expect(
    render({
      actions: { ...IDLE_PEOPLE_ACTIONS, message: "The person was removed." },
    }),
  ).toContain(
    '<p class="people-status" id="people-action-message" role="status">The person was removed.</p>',
  );
});

test("the owner sees the live offer with its target's name as text and its withdrawal; the target sees it with its acceptance; nobody sees it after it ends", () => {
  const offered = {
    ownershipOffer: { memberId: MEMBER, expiresAt: EXPIRES_AT },
  };
  const time = offerTimeFormat(ISTANBUL).format(new Date(EXPIRES_AT));
  const owner = render({ view: known(offered) });
  expect(owner).toContain(
    `<div class="people-offer"><p id="ownership-offer-line">Ownership offered to <span dir="auto">Linus</span> until <time dateTime="${EXPIRES_AT}">${time}</time>.</p><div class="account-actions"><button type="button" class="panel-action" aria-describedby="ownership-offer-line">Withdraw the offer</button></div></div>`,
  );
  // No second offer while one is live.
  expect(owner).not.toContain("Offer ownership");

  const target = render({ view: known({ ...offered, ownMemberId: MEMBER }) });
  expect(target).toContain(
    `<p id="ownership-offer-line">You are offered the ownership of this workspace<!-- --> until <time dateTime="${EXPIRES_AT}">${time}</time>.</p><div class="account-actions"><button type="button" class="panel-action" aria-describedby="ownership-offer-line">Accept the ownership</button></div>`,
  );
  expect(
    render({ view: known({ ...offered, ownMemberId: ADMIN }) }),
  ).not.toContain("people-offer");

  for (const now of [Date.parse(EXPIRES_AT), Date.parse(EXPIRES_AT) + 1]) {
    expect(render({ view: known(offered), now })).not.toContain("people-offer");
    expect(
      render({ view: known({ ...offered, ownMemberId: MEMBER }), now }),
    ).not.toContain("Accept the ownership");
  }

  const { calls, handlers } = recorder();
  for (const button of buttonsOf({
    view: known({ ...offered, ownMemberId: MEMBER }),
    handlers,
  })) {
    button.props.onClick?.({ currentTarget: "button" });
  }
  expect(calls).toEqual([
    `accept ${WORKSPACE} button`,
    `leave ${WORKSPACE} button`,
  ]);
});

test("the hint to make someone an admin still shows to the owner when there is no admin", () => {
  const html = render({
    view: known({
      people: READY.people.filter((entry) => entry.role !== "admin"),
    }),
  });
  expect(html).toContain('<p class="people-hint">');
  expect(render()).not.toContain("people-hint");
});

function dialogOf(
  request: PeopleActionRequest,
  overrides: Partial<PeopleActionDialog> = {},
): PeopleActionDialog {
  return { request, draft: "", problem: undefined, ...overrides };
}

const TARGET = { workspaceId: WORKSPACE, memberId: MEMBER, name: "Linus" };

test("an open question is a dialog with its title, the name as text, its sentence, Cancel first, and its confirming button", () => {
  const { handlers } = recorder();
  const html = renderToString(
    <PeopleActionDialogContent
      dialog={dialogOf({ kind: "remove", ...TARGET, claimed: true })}
      onConfirm={handlers.onConfirm}
      onCancel={handlers.onCancel}
      onDraft={handlers.onDialogDraft}
    />,
  );
  expect(html).toBe(
    '<dialog class="people-dialog" aria-labelledby="people-dialog-title" aria-describedby="people-dialog-name people-dialog-text"><form><h2 id="people-dialog-title">Remove this person?</h2><p class="people-dialog-name" id="people-dialog-name"><span dir="auto">Linus</span></p><p id="people-dialog-text">They lose access to the workspace at once. Their agents in its projects are disabled, the permissions on them are revoked, their unfinished runs are cancelled, and the invitations that they created and that are still open are revoked. Their messages stay, and they are listed as a former member. To come back, they need a new invitation or join request.</p><div class="people-dialog-actions"><button type="button" class="panel-action">Cancel</button><button type="submit" class="panel-action">Remove</button></div></form></dialog>',
  );
  // Without a question, the dialog stays in the page, closed and empty.
  expect(
    renderToString(
      <PeopleActionDialogContent
        dialog={undefined}
        onConfirm={handlers.onConfirm}
        onCancel={handlers.onCancel}
        onDraft={handlers.onDialogDraft}
      />,
    ),
  ).toBe('<dialog class="people-dialog"></dialog>');
});

test("the dialog is described by the name before its sentence, and by the sentence alone without a name", () => {
  const { handlers } = recorder();
  const leave = (workspaceName: string | null) =>
    renderToString(
      <PeopleActionDialogContent
        dialog={dialogOf({
          kind: "leave",
          workspaceId: WORKSPACE,
          workspaceName,
        })}
        onConfirm={handlers.onConfirm}
        onCancel={handlers.onCancel}
        onDraft={handlers.onDialogDraft}
      />,
    );
  expect(leave("Team")).toContain(
    'aria-describedby="people-dialog-name people-dialog-text"><form><h2 id="people-dialog-title">Leave this workspace?</h2><p class="people-dialog-name" id="people-dialog-name"><span dir="auto">Team</span></p>',
  );
  const unnamed = leave(null);
  expect(unnamed).toContain(
    'aria-describedby="people-dialog-text"><form><h2 id="people-dialog-title">Leave this workspace?</h2><p id="people-dialog-text">',
  );
  expect(unnamed).not.toContain("people-dialog-name");
});

test("the dialog confirms on submit, and cancels on Cancel, on Escape, and when the browser closes it", () => {
  const { calls, handlers } = recorder();
  const elements = elementsOf(
    <PeopleActionDialogContent
      dialog={dialogOf({
        kind: "leave",
        workspaceId: WORKSPACE,
        workspaceName: "Team",
      })}
      onConfirm={handlers.onConfirm}
      onCancel={handlers.onCancel}
      onDraft={handlers.onDialogDraft}
    />,
  );
  const dialog = elements.find((element) => element.type === "dialog");
  const form = elements.find((element) => element.type === "form");
  const cancel = elements.find(
    (element) => element.type === "button" && element.props.type === "button",
  );
  let prevented = 0;
  const event = {
    preventDefault: () => {
      prevented += 1;
    },
  };
  form?.props.onSubmit?.(event);
  cancel?.props.onClick?.({ currentTarget: null });
  dialog?.props.onCancel?.(event);
  dialog?.props.onClose?.();
  expect(calls).toEqual(["confirm", "cancel", "cancel", "cancel"]);
  expect(prevented).toBe(2);
});

test("a rename's dialog has the name field with the draft and an alert for its problem", () => {
  const { calls, handlers } = recorder();
  const dialog = dialogOf(
    { kind: "rename", ...TARGET },
    { draft: "Linus T.", problem: "Enter a name." },
  );
  const content = (
    <PeopleActionDialogContent
      dialog={dialog}
      onConfirm={handlers.onConfirm}
      onCancel={handlers.onCancel}
      onDraft={handlers.onDialogDraft}
    />
  );
  expect(renderToString(content)).toContain(
    '<p id="people-dialog-text">Enter the new name. Everyone in the workspace sees it.</p><label class="account-label" for="people-dialog-field">Name</label><input id="people-dialog-field" class="account-input" type="text" dir="auto" autoComplete="off" spellCheck="false" aria-invalid="true" aria-describedby="people-dialog-problem" value="Linus T."/><p class="panel-message" id="people-dialog-problem" role="alert">Enter a name.</p><div class="people-dialog-actions"><button type="button" class="panel-action">Cancel</button><button type="submit" class="panel-action">Save</button></div>',
  );
  elementsOf(content)
    .find((element) => element.props.id === "people-dialog-field")
    ?.props.onChange?.({ currentTarget: { value: "Linus" } });
  expect(calls).toEqual(["dialog draft Linus"]);
  // Without a problem, the alert is there and empty.
  expect(
    renderToString(
      <PeopleActionDialogContent
        dialog={{ ...dialog, problem: undefined }}
        onConfirm={handlers.onConfirm}
        onCancel={handlers.onCancel}
        onDraft={handlers.onDialogDraft}
      />,
    ),
  ).toContain(
    '<input id="people-dialog-field" class="account-input" type="text" dir="auto" autoComplete="off" spellCheck="false" aria-describedby="people-dialog-problem" value="Linus T."/><p class="panel-message" id="people-dialog-problem" role="alert"></p>',
  );
});

test("the screen shows the open question while it offers its action, and closes it once the action goes away", () => {
  const request: PeopleActionRequest = {
    kind: "remove",
    ...TARGET,
    claimed: true,
  };
  const actions = { ...IDLE_PEOPLE_ACTIONS, dialog: dialogOf(request) };
  // The box has hooks, so the markup shows what it renders.
  expect(render({ actions })).toContain(
    '<dialog class="people-dialog" aria-labelledby="people-dialog-title"',
  );
  for (const view of [
    known({
      people: READY.people.filter((entry) => entry.memberId !== MEMBER),
    }),
    known({ workspaceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4" }),
    known({
      ownMemberId: ADMIN,
      people: READY.people.map((entry) =>
        entry.memberId === MEMBER ? { ...entry, role: "admin" } : entry,
      ),
    }),
  ]) {
    expect(render({ view, actions })).toContain(
      '<dialog class="people-dialog"></dialog>',
    );
  }
});

test("names are rendered as text with their own direction in the rows, the offer, the dialog, and the field", () => {
  const markup = '<img src="x" onerror="alert(1)">';
  const rtl = "\u05e9\u05dc\u05d5\u05dd <b>";
  const view = known({
    people: [
      person(OWNER, "Ada", { role: "owner" }),
      person(MEMBER, markup),
      person(UNCLAIMED, rtl, { claimed: false, login: null, verifiedAt: null }),
    ],
    ownershipOffer: { memberId: MEMBER, expiresAt: EXPIRES_AT },
  });
  const html = render({
    view,
    actions: {
      ...IDLE_PEOPLE_ACTIONS,
      defineDraft: markup,
      dialog: dialogOf(
        {
          kind: "rename",
          workspaceId: WORKSPACE,
          memberId: UNCLAIMED,
          name: rtl,
        },
        { draft: rtl },
      ),
    },
  });
  const escapedMarkup =
    "&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;";
  expect(html).toContain(
    `<span dir="auto" id="people-title-person-1">${escapedMarkup}</span>`,
  );
  expect(html).toContain(
    `Ownership offered to <span dir="auto">${escapedMarkup}</span> until`,
  );
  expect(html).toContain(
    '<p class="people-dialog-name" id="people-dialog-name"><span dir="auto">\u05e9\u05dc\u05d5\u05dd &lt;b&gt;</span></p>',
  );
  expect(html).toContain('value="\u05e9\u05dc\u05d5\u05dd &lt;b&gt;"');
  expect(html).toContain(`value="${escapedMarkup}"`);
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
});

function attributeValues(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map(
    ([, value]) => value ?? "",
  );
}

test("the screen with its actions shows no ID, its element IDs are unique, every reference points to one of them, and nothing uses a style attribute", () => {
  const views = [
    known({ ownershipOffer: { memberId: MEMBER, expiresAt: EXPIRES_AT } }),
    known({
      ownMemberId: MEMBER,
      ownershipOffer: { memberId: MEMBER, expiresAt: EXPIRES_AT },
    }),
    known({ ownMemberId: ADMIN }),
  ];
  const dialogs: PeopleActionDialog[] = [
    dialogOf({ kind: "remove", ...TARGET, claimed: true }),
    dialogOf(
      {
        kind: "rename",
        workspaceId: WORKSPACE,
        memberId: UNCLAIMED,
        name: "Margaret",
      },
      { draft: "M" },
    ),
  ];
  for (const view of views) {
    for (const dialog of [undefined, ...dialogs]) {
      const html = render({
        view,
        actions: {
          ...IDLE_PEOPLE_ACTIONS,
          dialog,
          message: "The person was removed.",
        },
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
