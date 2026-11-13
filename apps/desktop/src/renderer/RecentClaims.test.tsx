// The recent claims of the people screen (#95, D8 and D9). The components
// below the screen use no hooks except the dialogs' boxes, so the tests
// render the markup and also call the components as functions, walk the
// returned elements, and invoke their event handlers. No DOM is used.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import type {
  ClaimsBridge,
  PeopleActionsBridge,
  PeopleBridge,
} from "../shared/desktop-bridge.ts";
import type {
  ClaimView,
  ClaimsView,
  PeopleView,
  PersonView,
} from "../shared/ipc-contract.ts";
import {
  describeRecentClaims,
  IDLE_RECENT_CLAIMS,
  NO_MARKED_CLAIMS,
  type ClaimsScreenView,
  type RecentClaimsView,
} from "./claims-view.ts";
import type { InvitationActionHandlers } from "./InvitationActions.tsx";
import { IDLE_INVITATION_ACTIONS } from "./invitations-view.ts";
import type { JoinRequestActionHandlers } from "./JoinRequests.tsx";
import { IDLE_JOIN_REQUEST_ACTIONS } from "./join-requests-view.ts";
import { WorkspaceNav } from "./Navigation.tsx";
import type { PeopleActionHandlers } from "./PeopleActions.tsx";
import { PeopleScreen, PeopleScreenContent } from "./PeopleScreen.tsx";
import {
  describePeopleActions,
  IDLE_PEOPLE_ACTIONS,
  offerTimeFormat,
  type PeopleActionRequest,
  type PeopleActionsView,
} from "./people-actions-view.ts";
import { peopleDateFormat, type PeopleScreenView } from "./people-view.ts";
import {
  RecentClaimsPart,
  usePageAttention,
  useRecentClaims,
  type RecentClaimHandlers,
} from "./RecentClaims.tsx";
import { createShellState } from "./screens.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OWNER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c1";
const ADMIN = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c2";
const MEMBER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c3";
const FORMER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c5";
const UNLISTED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c6";
const IDS = [WORKSPACE, OWNER, ADMIN, MEMBER, FORMER, UNLISTED];

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const VERIFIED_AT = "2026-11-12T09:00:00.000Z";
const ACCOUNT_CREATED_AT = "2026-10-01T00:00:00.000Z";
const CLAIMED_AT = "2026-11-12T09:30:00.000Z";

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
    person(FORMER, "Alan", { former: true }),
  ],
  morePeople: 0,
  ownershipOffer: null,
  maxUnclaimedMembers: 50,
};

function known(overrides: Partial<PeopleView> = {}): PeopleScreenView {
  return { kind: "known", state: { ...READY, ...overrides } as PeopleView };
}

function claim(
  memberId: string,
  overrides: Partial<ClaimView> = {},
): ClaimView {
  return {
    memberId,
    login: "kjohnson",
    verifiedAt: VERIFIED_AT,
    accountCreatedAt: ACCOUNT_CREATED_AT,
    via: "invitation",
    claimedAt: CLAIMED_AT,
    unseen: false,
    ...overrides,
  };
}

const CLAIMS: ClaimsView = {
  revision: 9,
  status: "ready",
  workspaceId: WORKSPACE,
  claims: [
    claim(MEMBER, { unseen: true, via: "join_request" }),
    claim(ADMIN, { login: "ghopper" }),
    claim(FORMER, { login: "aturing" }),
    claim(UNLISTED, { login: null, verifiedAt: null, accountCreatedAt: null }),
  ],
};

function listed(overrides: Partial<ClaimsView> = {}): ClaimsScreenView {
  return { kind: "known", state: { ...CLAIMS, ...overrides } as ClaimsView };
}

/** A fixed locale and a time zone that is not UTC, whatever the machine's. */
const ISTANBUL = { locale: "en-GB", timeZone: "Europe/Istanbul" };
const DATE_FORMAT = peopleDateFormat(ISTANBUL);
const TIME_FORMAT = offerTimeFormat(ISTANBUL);

interface HostProps {
  readonly children?: ReactNode;
  readonly id?: string;
  readonly "aria-describedby"?: string;
  readonly "aria-disabled"?: string;
  readonly "aria-label"?: string;
  readonly ref?: unknown;
  readonly onClick?: (event: { readonly currentTarget: unknown }) => void;
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

/** The text of an element and its children. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child: ReactNode) => textOf(child)).join("");
  }
  return isValidElement<HostProps>(node) ? textOf(node.props.children) : "";
}

/** Handlers that record each call as text. */
function recorder() {
  const calls: string[] = [];
  const people: PeopleActionHandlers = {
    onStart: (request: PeopleActionRequest, button: Element | null) =>
      calls.push(`people ${JSON.stringify(request)} ${String(button)}`),
    onConfirm: () => calls.push("people confirm"),
    onCancel: () => calls.push("people cancel"),
    onDialogDraft: () => calls.push("people draft"),
    onDefineDraft: () => calls.push("define draft"),
    onDefine: () => calls.push("define"),
  };
  const refs = new Map<string, (element: Element | null) => void>();
  const claims: RecentClaimHandlers = {
    onRefresh: () => calls.push("refresh"),
    rowRef: (memberId: string) => {
      let ref = refs.get(memberId);
      if (ref === undefined) {
        ref = () => calls.push(`ref ${memberId}`);
        refs.set(memberId, ref);
      }
      return ref;
    },
  };
  const other = () => calls.push("other");
  const invitations: InvitationActionHandlers = {
    onStart: other,
    onConfirm: other,
    onCancel: other,
    onCloseCode: other,
    onRefresh: other,
  };
  const joinRequests: JoinRequestActionHandlers = {
    onStart: other,
    onConfirm: other,
    onCancel: other,
    onDraft: other,
    onChoose: other,
    onCloseCode: other,
    onRefresh: other,
  };
  return { calls, refs, people, claims, invitations, joinRequests };
}

interface Props {
  readonly view?: PeopleScreenView;
  readonly claims?: ClaimsScreenView;
  readonly actions?: PeopleActionsView;
  readonly claimActions?: RecentClaimsView;
  readonly handlers?: ReturnType<typeof recorder>;
  readonly withPeopleActions?: boolean;
  readonly withClaims?: boolean;
  readonly joinRunning?: boolean;
}

function screen({
  view = known(),
  claims = listed(),
  actions = IDLE_PEOPLE_ACTIONS,
  claimActions = IDLE_RECENT_CLAIMS,
  handlers = recorder(),
  withPeopleActions = true,
  withClaims = true,
  joinRunning = false,
}: Props) {
  return (
    <PeopleScreenContent
      view={view}
      now={NOW}
      actions={actions}
      handlers={withPeopleActions ? handlers.people : undefined}
      invitations={{ kind: "pending" }}
      invitationActions={IDLE_INVITATION_ACTIONS}
      invitationHandlers={handlers.invitations}
      joinRequests={{ kind: "pending" }}
      joinRequestHandlers={handlers.joinRequests}
      joinRequestActions={{
        ...IDLE_JOIN_REQUEST_ACTIONS,
        running: joinRunning,
      }}
      claims={claims}
      claimActions={claimActions}
      claimHandlers={withClaims ? handlers.claims : undefined}
      dateFormat={DATE_FORMAT}
      timeFormat={TIME_FORMAT}
    />
  );
}

function render(props: Props = {}): string {
  return renderToString(screen(props));
}

/** The markup of the recent claims section. */
function partOf(html: string): string {
  const start = html.indexOf('<section class="recent-claims"');
  return start === -1
    ? ""
    : html.slice(
        start,
        html.indexOf("</section>", start) + "</section>".length,
      );
}

function attributeValues(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map(
    ([, value]) => value ?? "",
  );
}

test("the owner sees each claim, the most recent first, with the person, New while unseen, the login and its dates, how and when, and Remove where the people list offers it", () => {
  const verified = DATE_FORMAT.format(new Date(VERIFIED_AT));
  const created = DATE_FORMAT.format(new Date(ACCOUNT_CREATED_AT));
  const claimed = TIME_FORMAT.format(new Date(CLAIMED_AT));
  // In Istanbul's time, three hours ahead of UTC.
  expect(verified).toBe("12 Nov 2026");
  expect(created).toBe("1 Oct 2026");
  expect(claimed).toBe("12 Nov 2026, 12:30");
  const meta = (login: string) =>
    `<p class="person-meta">GitHub <span class="person-login" translate="no">${login}</span>, last verified <time dateTime="${VERIFIED_AT}">${verified}</time></p><p class="person-meta">GitHub account created <time dateTime="${ACCOUNT_CREATED_AT}">${created}</time></p>`;
  const when = (via: string) =>
    `<p class="person-meta">${via} on <time dateTime="${CLAIMED_AT}">${claimed}</time></p>`;
  const remove = (index: number) =>
    `<div class="account-actions"><button type="button" class="panel-action" aria-describedby="recent-claims-heading-claim-${String(index)}">Remove</button></div>`;
  expect(partOf(render())).toBe(
    `<section class="recent-claims" aria-labelledby="recent-claims-heading"><h3 class="people-heading" id="recent-claims-heading">Recent claims</h3><p class="person-meta">Accounts that joined this workspace recently, the most recent first. Check each GitHub login and the creation date of its account, not only the name, and remove anyone who should not be here.</p><p class="people-status" role="status"></p><ul class="people-list" aria-labelledby="recent-claims-heading">` +
      `<li class="person"><p class="person-name"><span dir="auto" id="recent-claims-heading-claim-0">Linus</span> <strong class="claim-new">New</strong></p>${meta("kjohnson")}${when("Joined through a join request")}${remove(0)}</li>` +
      `<li class="person"><p class="person-name"><span dir="auto" id="recent-claims-heading-claim-1">Grace</span></p>${meta("ghopper")}${when("Joined with an invitation")}${remove(1)}</li>` +
      `<li class="person"><p class="person-name"><span dir="auto">Alan</span><span class="person-you"> (former member)</span></p>${meta("aturing")}${when("Joined with an invitation")}</li>` +
      `<li class="person"><p class="person-name"><span>A person who is not shown here</span></p><p class="person-meta">No GitHub login</p>${when("Joined with an invitation")}</li>` +
      `</ul><div class="account-actions"><button type="button" class="panel-action">Refresh the recent claims</button></div></section>`,
  );
});

test("an admin sees Remove only on members, and the own claim marked as theirs", () => {
  const html = partOf(render({ view: known({ ownMemberId: ADMIN }) }));
  expect(html.match(/>Remove</g)).toHaveLength(1);
  expect(html).toContain(
    '<span dir="auto" id="recent-claims-heading-claim-0">Linus</span>',
  );
  expect(html).toContain(
    '<p class="person-name"><span dir="auto">Grace</span><span class="person-you"> (you)</span></p>',
  );
});

test("the section comes first, below the hint and the offer and above the people, and the refresh's sentence sits in its own status paragraph after the join request actions' one", () => {
  const html = render({
    view: known({
      people: READY.people.map((one) =>
        one.memberId === ADMIN ? { ...one, role: "member" } : one,
      ),
      ownershipOffer: {
        memberId: MEMBER,
        expiresAt: "2026-11-20T00:00:00.000Z",
      },
    }),
    claimActions: {
      ...IDLE_RECENT_CLAIMS,
      message: "Loading the recent claims again.",
    },
  });
  const section = html.indexOf('<section class="recent-claims"');
  expect(section).toBeGreaterThan(html.indexOf('class="people-hint"'));
  expect(section).toBeGreaterThan(html.indexOf('class="people-offer"'));
  expect(section).toBeLessThan(
    html.indexOf('<ul class="people-list" aria-labelledby="people-title"'),
  );
  expect(html).toContain(
    '<p class="people-status" id="join-request-action-message" role="status"></p><p class="people-status" id="claim-action-message" role="status">Loading the recent claims again.</p>',
  );
});

test("a member sees no section, and nobody does without the bridge, before the people are ready, or while the claims say not_allowed", () => {
  const cases: Props[] = [
    { view: known({ ownMemberId: MEMBER }) },
    { withClaims: false },
    { view: known({ status: "loading" }) },
    { claims: listed({ status: "not_allowed", claims: [] }) },
  ];
  for (const props of cases) {
    const html = render(props);
    expect(html).not.toContain("recent-claims-heading");
    expect(html).not.toContain(">Refresh the recent claims<");
    expect(html).not.toContain("kjohnson");
  }
  // Without the bridge, no paragraph for the refresh's sentence.
  expect(render({ withClaims: false })).not.toContain("claim-action-message");
  // A member keeps the paragraph, which stays empty.
  expect(render({ view: known({ ownMemberId: MEMBER }) })).toContain(
    '<p class="people-status" id="claim-action-message" role="status"></p>',
  );
});

test("the section shows its state's text: checking, loading, another workspace's state, none, and a problem with what was loaded before", () => {
  const status = (claims: ClaimsScreenView) =>
    /<p class="people-status" role="status">([^<]*)<\/p>/.exec(
      partOf(render({ claims })),
    )?.[1];
  expect(status({ kind: "pending" })).toBe("Checking the recent claims.");
  expect(status({ kind: "unavailable" })).toBe(
    "Recent claims are not available.",
  );
  expect(status(listed({ status: "loading", claims: [] }))).toBe(
    "Loading the recent claims.",
  );
  expect(status(listed({ claims: [] }))).toBe("No recent claims.");
  const elsewhere = listed({
    workspaceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4",
  });
  expect(status(elsewhere)).toBe("Loading the recent claims.");
  expect(partOf(render({ claims: elsewhere }))).not.toContain("Linus");
  const failed = listed({
    status: "unavailable",
    problem: "unavailable",
  } as Partial<ClaimsView>);
  expect(status(failed)).toBe(
    "The server could not be reached. Trying again later.",
  );
  expect(partOf(render({ claims: failed }))).toContain("Linus");
});

test("New is a word on each claim that is unseen or marked during the visit, not only a color", () => {
  const seen = listed({
    claims: CLAIMS.claims.map((one) => ({ ...one, unseen: false })),
  });
  expect(partOf(render({ claims: seen }))).not.toContain("claim-new");
  const html = partOf(
    render({
      claims: seen,
      claimActions: {
        ...IDLE_RECENT_CLAIMS,
        marked: {
          scope: `${WORKSPACE} ${OWNER}`,
          memberIds: new Set([FORMER]),
        },
      },
    }),
  );
  expect(html.match(/<strong class="claim-new">New<\/strong>/g)).toHaveLength(
    1,
  );
  expect(html).toContain(
    '<span class="person-you"> (former member)</span> <strong class="claim-new">New</strong>',
  );
});

test("D9: Remove on a claim starts the people list's own removal with its button, and Refresh asks for the claims", () => {
  const handlers = recorder();
  const buttons = elementsOf(screen({ handlers })).filter(
    (element) =>
      element.type === "button" &&
      (textOf(element.props.children) === "Refresh the recent claims" ||
        element.props["aria-describedby"]?.startsWith(
          "recent-claims-heading-claim-",
        ) === true),
  );
  expect(buttons.map((button) => textOf(button.props.children))).toEqual([
    "Remove",
    "Remove",
    "Refresh the recent claims",
  ]);
  for (const button of buttons) {
    button.props.onClick?.({ currentTarget: "button" });
  }
  expect(handlers.calls).toEqual([
    `people ${JSON.stringify({ kind: "remove", workspaceId: WORKSPACE, memberId: MEMBER, name: "Linus", claimed: true })} button`,
    `people ${JSON.stringify({ kind: "remove", workspaceId: WORKSPACE, memberId: ADMIN, name: "Grace", claimed: true })} button`,
    "refresh",
  ]);
});

test("while an action of any kind runs, Remove and Refresh stay focusable and do nothing", () => {
  for (const props of [
    { actions: { ...IDLE_PEOPLE_ACTIONS, running: true } },
    { joinRunning: true },
  ] satisfies Props[]) {
    const handlers = recorder();
    const buttons = elementsOf(screen({ ...props, handlers })).filter(
      (element) =>
        element.type === "button" &&
        ["Remove", "Refresh the recent claims"].includes(
          textOf(element.props.children),
        ),
    );
    // Both Remove buttons of the people list and of the claims, and Refresh.
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const button of buttons) {
      expect(button.props["aria-disabled"]).toBe("true");
      expect(button.props.onClick).toBeUndefined();
    }
    expect(partOf(renderToString(screen(props)))).toContain(
      '<button type="button" class="panel-action" aria-disabled="true">Refresh the recent claims</button>',
    );
  }
});

test("without the people actions, the claims show without Remove", () => {
  const html = partOf(render({ withPeopleActions: false }));
  expect(html).toContain("Linus");
  expect(html).not.toContain(">Remove<");
  expect(html).not.toContain("aria-describedby");
  expect(html).not.toContain('id="recent-claims-heading-claim-');
  // The section alone never shows Remove without the people actions' start,
  // also when its model offers it.
  const model = describeRecentClaims(
    known(),
    listed(),
    NO_MARKED_CLAIMS,
    describePeopleActions(known(), NOW).personActions,
  );
  expect(model?.rows.filter((row) => row.remove !== null)).toHaveLength(2);
  const alone = renderToString(
    model === null ? null : (
      <RecentClaimsPart
        model={model}
        dateFormat={DATE_FORMAT}
        timeFormat={TIME_FORMAT}
        inert={false}
        onStart={undefined}
        onRefresh={() => undefined}
      />
    ),
  );
  expect(alone).toContain("Linus");
  expect(alone).not.toContain(">Remove<");
  expect(alone).not.toContain('id="recent-claims-heading-claim-');
});

test("D9: Remove on a claim opens the same question as the people list's removal", () => {
  const request: PeopleActionRequest = {
    kind: "remove",
    workspaceId: WORKSPACE,
    memberId: MEMBER,
    name: "Linus",
    claimed: true,
  };
  const html = render({
    actions: {
      ...IDLE_PEOPLE_ACTIONS,
      dialog: { request, draft: "", problem: undefined },
    },
  });
  expect(html).toContain(
    '<h2 id="people-dialog-title">Remove this person?</h2><p class="people-dialog-name" id="people-dialog-name"><span dir="auto">Linus</span></p>',
  );
});

test("names and logins are rendered as text with their own direction, and a login is never translated", () => {
  const html = partOf(
    render({
      view: known({
        people: READY.people.map((one) =>
          one.memberId === MEMBER
            ? { ...one, displayName: '<img src="x">Linus' }
            : one,
        ),
      }),
      claims: listed({
        claims: [claim(MEMBER, { login: "a<b>c" })],
      }),
    }),
  );
  expect(html).toContain(
    '<span dir="auto" id="recent-claims-heading-claim-0">&lt;img src=&quot;x&quot;&gt;Linus</span>',
  );
  expect(html).toContain(
    '<span class="person-login" translate="no">a&lt;b&gt;c</span>',
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
});

test("the screen with the claims shows no ID, its element IDs are unique, every reference points to one of them, and nothing uses a style attribute", () => {
  for (const own of [OWNER, ADMIN]) {
    for (const withPeopleActions of [true, false]) {
      const html = render({
        view: known({ ownMemberId: own }),
        withPeopleActions,
      });
      expect(html).toContain('id="recent-claims-heading"');
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

test("the people screen has the recent claims with the claims bridge alone, and follows them only in an effect", () => {
  const calls: string[] = [];
  const call = (name: string) => () => {
    calls.push(name);
    return Promise.reject(new Error("not called"));
  };
  const people: PeopleBridge = {
    getState: call("people getState"),
    subscribeState: () => () => undefined,
  };
  const claims: ClaimsBridge = {
    getState: call("getState"),
    subscribeState: () => {
      calls.push("subscribeState");
      return () => undefined;
    },
    load: call("load"),
    markSeen: call("markSeen"),
  };
  const peopleActions = {
    define: call("define"),
    rename: call("rename"),
    remove: call("remove"),
    promote: call("promote"),
    demote: call("demote"),
    leave: call("leave"),
    offerOwnership: call("offerOwnership"),
    withdrawOwnershipOffer: call("withdrawOwnershipOffer"),
    acceptOwnershipOffer: call("acceptOwnershipOffer"),
  } satisfies PeopleActionsBridge;
  const paragraph =
    '<p class="people-status" id="claim-action-message" role="status"></p>';
  expect(
    renderToString(
      <PeopleScreen
        people={people}
        peopleActions={undefined}
        claims={claims}
      />,
    ),
  ).toContain(paragraph);
  expect(
    renderToString(
      <PeopleScreen
        people={people}
        peopleActions={peopleActions}
        claims={claims}
        shellDialogOpen
      />,
    ),
  ).toContain(paragraph);
  expect(
    renderToString(
      <PeopleScreen people={people} peopleActions={peopleActions} />,
    ),
  ).not.toContain("claim-action-message");
  // The subscription runs in an effect, which a server render does not run;
  // nothing is loaded or reported while rendering.
  expect(calls).toEqual([]);
});

test("the sidebar's People item carries a dot hidden from assistive technologies, and its name says so, only while a claim is unseen", () => {
  const nav = (unseenClaims: boolean | undefined) =>
    renderToString(
      <WorkspaceNav
        state={createShellState([], { screen: "people" })}
        dispatch={() => undefined}
        workspaces={{
          view: { kind: "pending" },
          message: undefined,
          onSelect: () => undefined,
        }}
        unseenClaims={unseenClaims}
      />,
    );
  expect(nav(true)).toContain(
    '<button type="button" class="nav-item" aria-current="page" aria-label="People, new claims">People<span class="nav-marker" aria-hidden="true"></span></button>',
  );
  expect(nav(true).match(/nav-marker/g)).toHaveLength(1);
  expect(nav(true).match(/<button[^>]*aria-label=/g)).toHaveLength(1);
  for (const unmarked of [nav(false), nav(undefined)]) {
    expect(unmarked).toContain(
      '<button type="button" class="nav-item" aria-current="page">People</button>',
    );
    expect(unmarked).not.toContain("nav-marker");
    expect(unmarked).not.toContain("new claims");
  }
});

test("each claim's row gets the ref callback of its claim, which follows whether the row is in view", () => {
  const handlers = recorder();
  const rows = elementsOf(screen({ handlers })).filter(
    (element) =>
      element.type === "li" &&
      handlers.refs.size > 0 &&
      [...handlers.refs.values()].includes(
        element.props.ref as (element: Element | null) => void,
      ),
  );
  expect(rows).toHaveLength(CLAIMS.claims.length);
  expect([...handlers.refs.keys()]).toEqual(
    CLAIMS.claims.map((one) => one.memberId),
  );
  rows.forEach((element, index) => {
    expect(element.props.ref).toBe(
      handlers.refs.get(CLAIMS.claims[index]!.memberId),
    );
  });
  // The section alone without rowRef follows no row.
  const model = describeRecentClaims(known(), listed());
  const alone =
    model === null
      ? []
      : elementsOf(
          <RecentClaimsPart
            model={model}
            dateFormat={DATE_FORMAT}
            timeFormat={TIME_FORMAT}
            inert={false}
            onStart={undefined}
            onRefresh={() => undefined}
          />,
        ).filter((element) => element.type === "li");
  expect(alone).toHaveLength(CLAIMS.claims.length);
  for (const element of alone) {
    expect(element.props.ref).toBeUndefined();
  }
});

test("while rendering, the page counts as hidden and without the focus, no row is in view, and no observer is made", () => {
  const seen: string[] = [];
  function Probe() {
    const attention = usePageAttention();
    const claims = useRecentClaims(undefined, () => {
      seen.push("observer");
      return undefined;
    });
    seen.push(
      `${String(attention.documentShown)} ${String(attention.windowFocused)} ${String(claims.rowsInView.size)} ${String(claims.attention.documentShown)} ${String(claims.attention.windowFocused)} ${String(claims.handlers)} ${String(claims.controller)}`,
    );
    return null;
  }
  renderToString(<Probe />);
  expect(seen).toEqual(["false false 0 false false undefined undefined"]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A claims bridge whose calls fail; rendering calls none of them. */
function idleClaims(): ClaimsBridge {
  const fail = () => Promise.reject(new Error("not called"));
  return {
    getState: fail,
    subscribeState: () => () => undefined,
    load: fail,
    markSeen: fail,
  };
}

test("the rows' ref callbacks observe each row with the observer from the factory that the screen gets, and by default with the page's IntersectionObserver", () => {
  const element = { name: "row" } as unknown as Element;
  const observed: string[] = [];
  function Probe({ withFactory }: { readonly withFactory: boolean }) {
    const claims = withFactory
      ? useRecentClaims(idleClaims(), () => ({
          observe: () => observed.push("factory observe"),
          unobserve: () => undefined,
          disconnect: () => undefined,
        }))
      : useRecentClaims(idleClaims());
    claims.handlers?.rowRef(MEMBER)(element);
    return null;
  }
  renderToString(<Probe withFactory />);
  expect(observed).toEqual(["factory observe"]);
  class PageObserver {
    observe(target: Element) {
      observed.push(`page observe ${String(target === element)}`);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", PageObserver);
  renderToString(<Probe withFactory={false} />);
  expect(observed).toEqual(["factory observe", "page observe true"]);
});

// The wiring that runs only in effects and the commit, which the Node-only
// tests cannot run, as text.
const WIRING = import.meta.glob<string>(
  ["./PeopleScreen.tsx", "./RecentClaims.tsx", "./App.tsx"],
  { query: "?raw", import: "default", eager: true },
);

test("the wiring that runs in effects passes the whole views: the People screen's report, the one effect after each render, the page's attention, and the shell's dialogs", () => {
  const people = WIRING["./PeopleScreen.tsx"] ?? "";
  const call = /claimsReport\(\{([\s\S]*?)\}\);/.exec(people)?.[1] ?? "";
  expect(call.split(",").filter((part) => part.trim() !== "")).toHaveLength(9);
  for (const field of [
    "people: view,",
    "claims: claimsView,",
    "marked: claimParts.view.marked,",
    "attention: claimParts.attention,",
    "rowsInView: claimParts.rowsInView,",
    "shellDialogOpen: shellDialogOpen === true,",
    "peopleActions: actions,",
    "invitationActions: invitationParts.actions,",
    "joinRequestActions: joinRequestParts.actions,",
  ]) {
    expect(call, field).toContain(field);
  }
  expect(people).toContain(
    "useClaimsRendered(claimParts.controller, view, claimsView, claimsSeen);",
  );
  expect(people).toContain("rowRef={claimHandlers.rowRef}");
  const part = WIRING["./RecentClaims.tsx"] ?? "";
  // One effect: the controller follows the views first and compares the key.
  expect(part.match(/controller\?\.rendered\(/g)).toHaveLength(1);
  expect(part).toMatch(
    /useEffect\(\s*\(\) => controller\?\.rendered\(people, claims, report\),[^\]]*\[controller, people, claims, key\],\s*\);/,
  );
  expect(part).toContain("useState(NO_PAGE_ATTENTION)");
  expect(part).toContain(
    "useEffect(() => followPageAttention(window, document, setAttention), []);",
  );
  expect(part).toContain("useEffect(() => () => rows.stop(), [rows]);");
  const app = WIRING["./App.tsx"] ?? "";
  expect(app).toContain(
    "const shellDialogOpen = isShellDialogOpen(question.question, creation?.view);",
  );
  expect(app.match(/shellDialogOpen=\{shellDialogOpen\}/g)).toHaveLength(2);
});

// The sources of the recent claims, without the tests, as text.
const SOURCES = import.meta.glob<string>(
  ["./RecentClaims.tsx", "./claims-view.ts", "./claims-attention.ts"],
  { query: "?raw", import: "default", eager: true },
);

test("the recent claims read no clock of the renderer and nothing of the machine: the main process says which claims are unseen", () => {
  expect(Object.keys(SOURCES).sort()).toEqual([
    "./RecentClaims.tsx",
    "./claims-attention.ts",
    "./claims-view.ts",
  ]);
  const forbidden: [string, RegExp][] = [
    ["Date.now", /\bDate\.now\b/],
    ["new Date()", /\bnew Date\(\s*\)/],
    ["performance", /\bperformance\b/],
    ["setTimeout", /\bset(?:Timeout|Interval)\b/],
    ["console", /\bconsole\b/],
    ["localStorage", /\blocalStorage\b/],
    ["sessionStorage", /\bsessionStorage\b/],
    ["indexedDB", /\bindexedDB\b/],
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
