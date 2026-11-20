import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import {
  WORKSPACE_PROBLEMS,
  type PeopleView,
  type PersonActionResult,
  type PersonView,
} from "../shared/ipc-contract.ts";
import type {
  ClaimsBridge,
  InvitationActionsBridge,
  InvitationsBridge,
  JoinRequestActionsBridge,
  JoinRequestsBridge,
  PeopleActionsBridge,
  WorkspaceBridge,
} from "../shared/desktop-bridge.ts";
import { createRecentClaims, type RecentClaimsView } from "./claims-view.ts";
import {
  useInvitationActions,
  type InvitationActionHandlers,
} from "./InvitationActions.tsx";
import {
  createInvitationActions,
  type InvitationActionRequest,
  type InvitationActionsView,
} from "./invitations-view.ts";
import {
  useJoinRequestActions,
  type JoinRequestActionHandlers,
} from "./JoinRequests.tsx";
import type { JoinRequestActionRequest } from "./join-requests-view.ts";
import {
  ResultParagraph,
  usePeopleActions,
  type PeopleActionHandlers,
} from "./PeopleActions.tsx";
import {
  createPeopleActions,
  type PeopleActionRequest,
  type PeopleActionsView,
} from "./people-actions-view.ts";
import {
  endingOtherSentences,
  PeopleScreen,
  PeopleScreenContent,
  type PeopleScreenActionParts,
} from "./PeopleScreen.tsx";
import {
  PEOPLE_MESSAGES,
  PEOPLE_PROBLEM_MESSAGES,
  peopleDateFormat,
  type PeopleScreenView,
} from "./people-view.ts";
import type { RecentClaimHandlers } from "./RecentClaims.tsx";
import {
  useWorkspaceIdCopy,
  type WorkspaceIdCopyControls,
} from "./WorkspaceIdPart.tsx";
import {
  createWorkspaceIdCopy,
  type WorkspaceIdCopyView,
} from "./workspace-id-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OWNER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c1";
const MEMBER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c3";
const UNCLAIMED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c4";
const FORMER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c5";
const NEVER_CLAIMED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c6";

const VERIFIED_AT = "2026-11-06T22:30:00.000Z";

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
    verifiedAt: VERIFIED_AT,
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
    person(OWNER, "Ada", { role: "owner", login: "ada-l" }),
    person(MEMBER, "Linus"),
    person(UNCLAIMED, "Margaret", {
      claimed: false,
      login: null,
      verifiedAt: null,
    }),
    person(FORMER, "Alan", { role: "admin", former: true, login: "alan-t" }),
    person(NEVER_CLAIMED, "Barbara", {
      former: true,
      claimed: false,
      login: null,
      verifiedAt: null,
    }),
  ],
  morePeople: 0,
  ownershipOffer: null,
  maxUnclaimedMembers: null,
};

function known(overrides: Partial<PeopleView> = {}): PeopleScreenView {
  return { kind: "known", state: { ...READY, ...overrides } as PeopleView };
}

/** A fixed locale and a time zone that is not UTC, whatever the machine's. */
const ISTANBUL_DATES = peopleDateFormat({
  locale: "en-GB",
  timeZone: "Europe/Istanbul",
});

function render(view: PeopleScreenView): string {
  return renderToString(
    <PeopleScreenContent view={view} dateFormat={ISTANBUL_DATES} />,
  );
}

/** Text as React escapes it. */
function escaped(text: string): string {
  return text.replaceAll("'", "&#x27;");
}

const TITLE =
  '<section aria-labelledby="people-title"><h2 id="people-title" tabindex="-1">People</h2>';
const END = "</section>";
const HINT = `<p class="people-hint">${PEOPLE_MESSAGES.adminHint}</p>`;
/** The selected workspace's name below the heading. */
const NAMED =
  '<p class="people-workspace">Workspace: <span dir="auto">Team</span></p>';

function status(text: string): string {
  return `<p class="people-status" role="status">${escaped(text)}</p>`;
}

function attributeValues(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map(
    ([, value]) => value ?? "",
  );
}

test("each state without people shows its text in the status paragraph, and no list, below the workspace's name when there is one", () => {
  const unnamed = { workspaceId: null, workspaceName: null, people: [] };
  const cases: [PeopleScreenView, string, string][] = [
    [{ kind: "unavailable" }, "People are not available.", ""],
    [{ kind: "pending" }, "Checking the people.", ""],
    [
      known({ status: "signed_out", ...unnamed }),
      "People appear once this device is signed in and ready.",
      "",
    ],
    [
      known({ status: "no_workspace", ...unnamed }),
      "No workspace is selected.",
      "",
    ],
    [known({ status: "loading", people: [] }), "Loading the people.", NAMED],
    [known({ people: [] }), "No people yet.", NAMED],
  ];
  for (const [view, text, name] of cases) {
    expect(render(view), text).toBe(TITLE + name + status(text) + END);
  }
});

test("a ready state lists each person with the name, the role, and the login with its date, the own person marked, and the former members apart", () => {
  const html = render(known());

  expect(html).toBe(
    TITLE +
      NAMED +
      status("") +
      HINT +
      '<ul class="people-list" aria-labelledby="people-title">' +
      '<li class="person">' +
      '<p class="person-name"><span dir="auto">Ada</span><span class="person-you"> (you)</span></p>' +
      '<p class="person-meta">Owner</p>' +
      '<p class="person-meta">GitHub <span class="person-login" translate="no">ada-l</span>, last verified <time dateTime="2026-11-06T22:30:00.000Z">7 Nov 2026</time></p>' +
      "</li>" +
      '<li class="person">' +
      '<p class="person-name"><span dir="auto">Linus</span></p>' +
      '<p class="person-meta">Member</p>' +
      '<p class="person-meta">GitHub <span class="person-login" translate="no">octocat</span>, last verified <time dateTime="2026-11-06T22:30:00.000Z">7 Nov 2026</time></p>' +
      "</li>" +
      '<li class="person">' +
      '<p class="person-name"><span dir="auto">Margaret</span></p>' +
      '<p class="person-meta">Member</p>' +
      '<p class="person-meta">Not claimed yet</p>' +
      "</li>" +
      "</ul>" +
      '<h3 class="people-heading" id="former-people-heading">Former members</h3>' +
      '<ul class="people-list" aria-labelledby="former-people-heading">' +
      '<li class="person">' +
      '<p class="person-name"><span dir="auto">Alan</span></p>' +
      '<p class="person-meta">GitHub <span class="person-login" translate="no">alan-t</span>, last verified <time dateTime="2026-11-06T22:30:00.000Z">7 Nov 2026</time></p>' +
      "</li>" +
      '<li class="person">' +
      '<p class="person-name"><span dir="auto">Barbara</span></p>' +
      '<p class="person-meta">Never claimed</p>' +
      "</li>" +
      "</ul>" +
      END,
  );
});

test("the hint to make someone an admin shows to the owner only, when someone could become an admin", () => {
  expect(render(known())).toContain(HINT);
  expect(render(known({ ownMemberId: MEMBER }))).not.toContain("people-hint");
  // Only unclaimed people besides the owner: nobody can be promoted.
  expect(
    render(
      known({
        people: READY.people.filter((entry) => entry.memberId !== MEMBER),
      }),
    ),
  ).not.toContain("people-hint");
  expect(
    render(
      known({
        people: [
          ...READY.people,
          person("0192f2a0-7c3e-7a1b-8c4d-5e6f708192c7", "Grace", {
            role: "admin",
          }),
        ],
      }),
    ),
  ).not.toContain("people-hint");
});

test("people left out are counted after the last list", () => {
  const html = render(known({ morePeople: 2 }));
  const note = `<p class="people-note">${new Intl.NumberFormat().format(2)} more people are not shown.</p>`;
  expect(html).toContain(`</ul>${note}${END}`);
  expect(html.indexOf(note)).toBeGreaterThan(
    html.indexOf("former-people-heading"),
  );
});

test("without former members there is no former group, and people left out are counted", () => {
  const html = render(
    known({
      people: READY.people.filter((entry) => !entry.former),
      morePeople: 1200,
    }),
  );

  expect(html).not.toContain("Former members");
  expect(html).not.toContain("former-people-heading");
  expect(html).toContain(
    `<p class="people-note">${new Intl.NumberFormat().format(1200)} more people are not shown.</p>`,
  );
  // With people left out, the screen does not know whether an admin exists.
  expect(html).not.toContain("people-hint");
});

test("an unavailable state shows its problem with the people loaded before, or alone", () => {
  for (const problem of WORKSPACE_PROBLEMS) {
    const withPeople = render(
      known({ status: "unavailable", problem } as Partial<PeopleView>),
    );
    expect(withPeople).toContain(status(PEOPLE_PROBLEM_MESSAGES[problem]));
    expect(withPeople).toContain('<span dir="auto">Ada</span>');

    const alone = render(
      known({
        status: "unavailable",
        problem,
        people: [],
      } as Partial<PeopleView>),
    );
    expect(alone).toBe(
      TITLE + NAMED + status(PEOPLE_PROBLEM_MESSAGES[problem]) + END,
    );
  }
});

test("names and logins are rendered as text, never as markup", () => {
  const html = render(
    known({
      workspaceName: "<b>Team</b>",
      people: [
        person(OWNER, '<img src="x" onerror="alert(1)">', { role: "owner" }),
        // A right-to-left name takes its direction from its content.
        person(MEMBER, "\u05e9\u05dc\u05d5\u05dd <b>"),
      ],
    }),
  );

  expect(html).toContain(
    '<span dir="auto">&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;</span>',
  );
  expect(html).toContain(
    '<span dir="auto">\u05e9\u05dc\u05d5\u05dd &lt;b&gt;</span>',
  );
  expect(html).toContain(
    '<p class="people-workspace">Workspace: <span dir="auto">&lt;b&gt;Team&lt;/b&gt;</span></p>',
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
});

test("the screen's ids are unique, every reference points to one of them, no ID is shown, and nothing uses a style attribute", () => {
  const html = render(known());

  const ids = attributeValues(html, "id");
  expect(ids).toEqual(["people-title", "former-people-heading"]);
  for (const reference of attributeValues(html, "aria-labelledby")) {
    expect(ids).toContain(reference);
  }
  // The Content Security Policy allows no inline styles.
  expect(html).not.toMatch(/\sstyle=/);
  for (const id of [WORKSPACE, OWNER, MEMBER, UNCLAIMED, FORMER]) {
    expect(html).not.toContain(id);
  }
});

test("the screen with a bridge waits for the first people, and without one says that they are not available", () => {
  const people = {
    getState: () => new Promise<PeopleView>(() => undefined),
    subscribeState: () => () => undefined,
  };
  expect(
    renderToString(<PeopleScreen people={people} peopleActions={undefined} />),
  ).toContain(status("Checking the people."));
  expect(
    renderToString(
      <PeopleScreen people={undefined} peopleActions={undefined} />,
    ),
  ).toContain(status("People are not available."));
});

/** Handlers of every name, each of which records its calls with its arguments. */
function recordingParts(ended: string[], called: string[]) {
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      called.push(`${name}(${args.map(String).join(", ")})`);
    };
  const rowRef = () => () => undefined;
  const people: PeopleActionHandlers = {
    onStart: record("people.onStart"),
    onConfirm: record("people.onConfirm"),
    onCancel: record("people.onCancel"),
    onDialogDraft: record("people.onDialogDraft"),
    onDefineDraft: record("people.onDefineDraft"),
    onDefine: record("people.onDefine"),
  };
  const invitations: InvitationActionHandlers = {
    onStart: record("invitations.onStart"),
    onConfirm: record("invitations.onConfirm"),
    onCancel: record("invitations.onCancel"),
    onCloseCode: record("invitations.onCloseCode"),
    onRefresh: record("invitations.onRefresh"),
  };
  const joinRequests: JoinRequestActionHandlers = {
    onStart: record("joinRequests.onStart"),
    onConfirm: record("joinRequests.onConfirm"),
    onCancel: record("joinRequests.onCancel"),
    onDraft: record("joinRequests.onDraft"),
    onChoose: record("joinRequests.onChoose"),
    onCloseCode: record("joinRequests.onCloseCode"),
    onRefresh: record("joinRequests.onRefresh"),
  };
  const claims: RecentClaimHandlers = {
    onRefresh: record("claims.onRefresh"),
    rowRef,
  };
  const copy: WorkspaceIdCopyControls = {
    view: { running: false, last: undefined },
    onCopy: record("copy.onCopy"),
  };
  const end = (kind: string) => () => {
    ended.push(kind);
  };
  const parts: PeopleScreenActionParts = {
    copy: { handlers: copy, clearMessage: end("copy") },
    people: { handlers: people, clearMessage: end("people") },
    invitations: { handlers: invitations, clearMessage: end("invitations") },
    joinRequests: { handlers: joinRequests, clearMessage: end("joinRequests") },
    claims: { handlers: claims, clearMessage: end("claims") },
  };
  return { parts, rowRef, copy };
}

const PROMOTE: PeopleActionRequest = {
  kind: "promote",
  workspaceId: WORKSPACE,
  memberId: MEMBER,
  name: "Linus",
};

const REVOKE: InvitationActionRequest = {
  kind: "revoke",
  workspaceId: WORKSPACE,
  invitationId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e1",
  name: "Margaret",
};

const PAUSE: JoinRequestActionRequest = {
  kind: "pause",
  workspaceId: WORKSPACE,
};

test("each control that starts an action, also one that asks first, ends the sentences of the other kinds first and passes its arguments on; closing and typing end none (#319)", () => {
  const ended: string[] = [];
  const called: string[] = [];
  const { parts, rowRef, copy } = recordingParts(ended, called);
  const started = endingOtherSentences(parts);
  const others = (kind: string) =>
    ["copy", "people", "invitations", "joinRequests", "claims"].filter(
      (other) => other !== kind,
    );
  const starts: [string, string, () => void][] = [
    [
      "copy",
      `copy.onCopy(${WORKSPACE})`,
      () => started.copy?.onCopy(WORKSPACE),
    ],
    [
      "people",
      "people.onStart([object Object], null)",
      () => started.people?.onStart(PROMOTE, null),
    ],
    ["people", "people.onConfirm()", () => started.people?.onConfirm()],
    [
      "people",
      `people.onDefine(${WORKSPACE})`,
      () => started.people?.onDefine(WORKSPACE),
    ],
    [
      "invitations",
      "invitations.onStart([object Object], null)",
      () => started.invitations?.onStart(REVOKE, null),
    ],
    [
      "invitations",
      "invitations.onConfirm()",
      () => started.invitations?.onConfirm(),
    ],
    [
      "invitations",
      "invitations.onRefresh()",
      () => started.invitations?.onRefresh(),
    ],
    [
      "joinRequests",
      "joinRequests.onStart([object Object], null)",
      () => started.joinRequests?.onStart(PAUSE, null),
    ],
    [
      "joinRequests",
      "joinRequests.onConfirm()",
      () => started.joinRequests?.onConfirm(),
    ],
    [
      "joinRequests",
      "joinRequests.onRefresh()",
      () => started.joinRequests?.onRefresh(),
    ],
    ["claims", "claims.onRefresh()", () => started.claims?.onRefresh()],
  ];
  for (const [kind, call, start] of starts) {
    ended.length = 0;
    called.length = 0;
    start();
    expect(ended, call).toEqual(others(kind));
    expect(called, call).toEqual([call]);
  }

  ended.length = 0;
  called.length = 0;
  started.people?.onCancel();
  started.people?.onDialogDraft("a");
  started.people?.onDefineDraft("b");
  started.invitations?.onCancel();
  started.invitations?.onCloseCode();
  started.joinRequests?.onCancel();
  started.joinRequests?.onDraft("c");
  started.joinRequests?.onChoose("d");
  started.joinRequests?.onCloseCode();
  expect(ended).toEqual([]);
  expect(called).toEqual([
    "people.onCancel()",
    "people.onDialogDraft(a)",
    "people.onDefineDraft(b)",
    "invitations.onCancel()",
    "invitations.onCloseCode()",
    "joinRequests.onCancel()",
    "joinRequests.onDraft(c)",
    "joinRequests.onChoose(d)",
    "joinRequests.onCloseCode()",
  ]);
  // The claims' rows and the copy's view stay as they are.
  expect(started.claims?.rowRef).toBe(rowRef);
  expect(started.copy?.view).toBe(copy.view);
});

test("a kind without its bridges has no handlers and no end, and the other kinds still end (#319)", () => {
  const ended: string[] = [];
  const { parts } = recordingParts(ended, []);
  const started = endingOtherSentences({
    ...parts,
    invitations: { handlers: undefined, clearMessage: undefined },
    claims: { handlers: undefined, clearMessage: undefined },
  });
  expect(started.invitations).toBeUndefined();
  expect(started.claims).toBeUndefined();
  started.copy?.onCopy(WORKSPACE);
  expect(ended).toEqual(["people", "joinRequests"]);
});

/** The text of each action's status paragraph that the screen renders, by its ID. */
function sentences(html: string): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const [, id, text] of html.matchAll(
    /<p class="people-status" id="([a-z-]+)" role="status">([^<]*)<\/p>/g,
  )) {
    texts[id ?? ""] = text ?? "";
  }
  return texts;
}

/** Lets the answers on their way settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

test("after an action of one kind and then one of another kind, the screen shows only the second one's result, and a refused promotion shows its sentence alone (#319)", async () => {
  const promotions: PersonActionResult[] = [
    { outcome: "ok" },
    { outcome: "refused", reason: "device_too_new", retryAfterMs: null },
  ];
  let peopleView: PeopleActionsView | undefined;
  const people = createPeopleActions(
    {
      promote: () => Promise.resolve(promotions.shift()),
    } as unknown as PeopleActionsBridge,
    (view) => {
      peopleView = view;
    },
  );
  people.listChanged(known(), Date.parse("2026-11-09T12:00:00.000Z"));
  let invitationView: InvitationActionsView | undefined;
  const invitations = createInvitationActions(
    {
      revoke: () => Promise.resolve({ outcome: "ok" }),
    } as unknown as Pick<InvitationActionsBridge, "create" | "revoke">,
    {
      load: () => Promise.resolve({ outcome: "loading" }),
    } as unknown as Pick<InvitationsBridge, "load">,
    (view) => {
      invitationView = view;
    },
  );
  invitations.listChanged(known(), { kind: "unavailable" }, 0);
  let claimView: RecentClaimsView | undefined;
  const claims = createRecentClaims(
    {
      load: () => Promise.resolve({ outcome: "loading" }),
    } as unknown as Pick<ClaimsBridge, "load" | "markSeen">,
    (view) => {
      claimView = view;
    },
  );
  let copyView: WorkspaceIdCopyView = { running: false, last: undefined };
  const copy = createWorkspaceIdCopy(
    {
      copyId: () => Promise.resolve({ outcome: "ok" }),
    } as unknown as Pick<WorkspaceBridge, "copyId">,
    (view) => {
      copyView = view;
    },
  );
  copy.shown(WORKSPACE);

  // The screen as `PeopleScreen` puts it together, with the latest views.
  function screen() {
    const started = endingOtherSentences({
      copy: {
        handlers: {
          view: copyView,
          onCopy: (workspaceId: string) => void copy.copy(workspaceId),
        },
        clearMessage: copy.clearMessage,
      },
      people: {
        handlers: {
          onStart: (request) => void people.start(request),
          onConfirm: () => void people.confirm(),
          onCancel: people.cancel,
          onDialogDraft: people.editDialogDraft,
          onDefineDraft: people.editDefineDraft,
          onDefine: (workspaceId) => void people.define(workspaceId),
        },
        clearMessage: people.clearMessage,
      },
      invitations: {
        handlers: {
          onStart: (request) => invitations.start(request),
          onConfirm: () => void invitations.confirm(),
          onCancel: invitations.cancel,
          onCloseCode: invitations.closeCode,
          onRefresh: () => void invitations.refresh(),
        },
        clearMessage: invitations.clearMessage,
      },
      joinRequests: { handlers: undefined, clearMessage: undefined },
      claims: {
        handlers: {
          onRefresh: () => void claims.refresh(),
          rowRef: () => () => undefined,
        },
        clearMessage: claims.clearMessage,
      },
    });
    const html = renderToString(
      <PeopleScreenContent
        view={known()}
        dateFormat={ISTANBUL_DATES}
        workspaceIdCopy={started.copy}
        actions={peopleView}
        handlers={started.people}
        invitationActions={invitationView}
        invitationHandlers={started.invitations}
        claimActions={claimView}
        claimHandlers={started.claims}
      />,
    );
    return { started, shown: sentences(html) };
  }
  const NONE = {
    "workspace-id-message": "",
    "people-action-message": "",
    "invitation-action-message": "",
    "claim-action-message": "",
  };

  expect(screen().shown).toEqual(NONE);
  screen().started.copy?.onCopy(WORKSPACE);
  await settle();
  expect(screen().shown).toEqual({
    ...NONE,
    "workspace-id-message": "The workspace ID was copied.",
  });

  screen().started.people?.onStart(PROMOTE, null);
  await settle();
  expect(screen().shown).toEqual({
    ...NONE,
    "people-action-message": "The person is now an admin.",
  });

  // The question alone already ends the other kinds' sentences.
  screen().started.invitations?.onStart(REVOKE, null);
  expect(screen().shown).toEqual(NONE);
  screen().started.invitations?.onConfirm();
  await settle();
  expect(screen().shown).toEqual({
    ...NONE,
    "invitation-action-message": "The invitation was revoked.",
  });

  screen().started.claims?.onRefresh();
  await settle();
  expect(screen().shown).toEqual({
    ...NONE,
    "claim-action-message": "Loading the recent claims again.",
  });

  screen().started.people?.onStart(PROMOTE, null);
  await settle();
  expect(screen().shown).toEqual({
    ...NONE,
    "people-action-message":
      "The person could not be made an admin. Promoting an admin and offering the ownership need a device that was registered at least 72 hours ago. Use an older device, or try again later.",
  });
});

/**
 * The elements of a tree. A component without hooks is called to reach its
 * elements; one with hooks, such as a status paragraph, stays a leaf.
 */
function elementsOf(node: ReactNode): ReactElement<{ readonly id?: string }>[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => elementsOf(child));
  }
  if (
    !isValidElement<{ readonly id?: string; readonly children?: ReactNode }>(
      node,
    )
  ) {
    return [];
  }
  if (typeof node.type === "function") {
    try {
      return elementsOf(
        (node.type as (props: unknown) => ReactNode)(node.props),
      );
    } catch {
      return [node];
    }
  }
  return [node, ...elementsOf(node.props.children)];
}

test("the status paragraph of every kind of action brings its new sentence into view in the same way (#319)", () => {
  const { parts } = recordingParts([], []);
  const tree = (
    <PeopleScreenContent
      view={known()}
      dateFormat={ISTANBUL_DATES}
      workspaceIdCopy={parts.copy.handlers}
      handlers={parts.people.handlers}
      invitationHandlers={parts.invitations.handlers}
      joinRequestHandlers={parts.joinRequests.handlers}
      claimHandlers={parts.claims.handlers}
    />
  );
  const paragraphs = elementsOf(tree)
    .filter((element) => element.type === ResultParagraph)
    .map((element) => element.props.id);
  expect(paragraphs).toEqual([
    "workspace-id-message",
    "people-action-message",
    "invitation-action-message",
    "join-request-action-message",
    "claim-action-message",
  ]);
});

test("the hooks give the end of their sentence with their bridges, and none without (#319)", () => {
  const ends: Record<string, unknown> = {};
  function Harness({ bridges }: { readonly bridges: boolean }) {
    const view = known();
    ends["people"] = usePeopleActions(
      bridges ? ({} as PeopleActionsBridge) : undefined,
      view,
      0,
    ).clearMessage;
    ends["invitations"] = useInvitationActions(
      bridges ? ({} as InvitationActionsBridge) : undefined,
      bridges ? ({} as InvitationsBridge) : undefined,
      view,
      { kind: "unavailable" },
      0,
    ).clearMessage;
    ends["joinRequests"] = useJoinRequestActions(
      {
        joinRequestActions: bridges
          ? ({} as JoinRequestActionsBridge)
          : undefined,
        joinRequests: bridges ? ({} as JoinRequestsBridge) : undefined,
        invitationActions: bridges
          ? ({} as InvitationActionsBridge)
          : undefined,
      },
      view,
      { kind: "unavailable" },
    ).clearMessage;
    ends["copy"] = useWorkspaceIdCopy(
      bridges ? ({} as Pick<WorkspaceBridge, "copyId">) : undefined,
      WORKSPACE,
    )?.clearMessage;
    return null;
  }
  renderToString(<Harness bridges={false} />);
  expect(ends).toEqual({
    people: undefined,
    invitations: undefined,
    joinRequests: undefined,
    copy: undefined,
  });
  renderToString(<Harness bridges />);
  for (const [kind, end] of Object.entries(ends)) {
    expect(typeof end, kind).toBe("function");
  }
});
