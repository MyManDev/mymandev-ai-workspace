import { expect, test } from "vitest";
import type { ClaimsBridge } from "../shared/desktop-bridge.ts";
import {
  CLAIM_VIAS_VIEW,
  WORKSPACE_PROBLEMS,
  type ClaimLoadResult,
  type ClaimMarkSeenResult,
  type ClaimView,
  type ClaimsView,
  type PeopleView,
  type PersonView,
  type WorkspaceView,
} from "../shared/ipc-contract.ts";
import {
  CLAIM_MESSAGES,
  CLAIM_PROBLEM_MESSAGES,
  CLAIM_REFRESH_MESSAGES,
  CLAIM_VIA_MESSAGES,
  claimScope,
  claimsCovered,
  createRecentClaims,
  describeRecentClaims,
  followClaims,
  hasUnseenClaims,
  IDLE_RECENT_CLAIMS,
  initialClaimsScreenView,
  NO_MARKED_CLAIMS,
  shownClaims,
  type ClaimsScreenView,
  type RecentClaimsView,
  type ShownClaims,
} from "./claims-view.ts";
import { IDLE_INVITATION_ACTIONS } from "./invitations-view.ts";
import { IDLE_JOIN_REQUEST_ACTIONS } from "./join-requests-view.ts";
import {
  describePeopleActions,
  IDLE_PEOPLE_ACTIONS,
  isOffered,
} from "./people-actions-view.ts";
import type { PeopleScreenView } from "./people-view.ts";
import type { WorkspacePanelView } from "./workspace-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OTHER_WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4";
const OWNER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c1";
const ADMIN = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c2";
const MEMBER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c3";
const OTHER_ADMIN = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c4";
const FORMER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c5";
const UNLISTED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c6";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");

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
    person(OTHER_ADMIN, "Barbara", { role: "admin" }),
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
    verifiedAt: "2026-11-12T09:00:00.000Z",
    accountCreatedAt: "2026-10-01T00:00:00.000Z",
    via: "invitation",
    claimedAt: "2026-11-12T09:00:00.000Z",
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
    claim(OTHER_ADMIN, { unseen: true }),
    claim(FORMER),
    claim(UNLISTED, {
      login: null,
      verifiedAt: null,
      accountCreatedAt: null,
    }),
    claim(ADMIN),
  ],
};

function listed(overrides: Partial<ClaimsView> = {}): ClaimsScreenView {
  return {
    kind: "known",
    state: { ...CLAIMS, ...overrides } as ClaimsView,
  };
}

const SCOPE = `${WORKSPACE} ${OWNER}`;

test("the screen starts unavailable without the bridge and pending with it", () => {
  expect(initialClaimsScreenView(false)).toEqual({ kind: "unavailable" });
  expect(initialClaimsScreenView(true)).toEqual({ kind: "pending" });
});

test("following the claims reports each state, asks for no load, and ends the subscription", () => {
  const views: ClaimsScreenView[] = [];
  let listener: ((state: ClaimsView) => void) | undefined;
  let onError: (() => void) | undefined;
  let stopped = 0;
  const bridge = {
    subscribeState: (next: (state: ClaimsView) => void, error?: () => void) => {
      listener = next;
      onError = error;
      return () => {
        stopped += 1;
      };
    },
    load: () => {
      throw new Error("The claims load without the screen asking.");
    },
  };
  const stop = followClaims(bridge, (view) => views.push(view));
  listener?.(CLAIMS);
  onError?.();
  expect(views).toEqual([
    { kind: "known", state: CLAIMS },
    { kind: "unavailable" },
  ]);
  stop();
  expect(stopped).toBe(1);
});

test("the owner and the admins see each claim in the main process's order, with the person from the people, the login and its dates, how and when, and New while it is unseen", () => {
  for (const own of [OWNER, ADMIN]) {
    const model = describeRecentClaims(known({ ownMemberId: own }), listed());
    expect(model?.status).toBe("");
    expect(model?.workspaceId).toBe(WORKSPACE);
    expect(model?.scope).toBe(`${WORKSPACE} ${own}`);
    expect(model?.rows).toEqual([
      {
        memberId: MEMBER,
        name: "Linus",
        former: false,
        you: false,
        login: "kjohnson",
        verifiedAt: "2026-11-12T09:00:00.000Z",
        accountCreatedAt: "2026-10-01T00:00:00.000Z",
        via: "join_request",
        claimedAt: "2026-11-12T09:00:00.000Z",
        unseen: true,
        marked: true,
        remove: null,
      },
      expect.objectContaining({
        memberId: OTHER_ADMIN,
        name: "Barbara",
        via: "invitation",
        unseen: true,
        marked: true,
      }),
      // A removed person shows as a former member.
      expect.objectContaining({
        memberId: FORMER,
        name: "Alan",
        former: true,
        unseen: false,
        marked: false,
      }),
      // A person whom the people do not list, with the account's data erased.
      expect.objectContaining({
        memberId: UNLISTED,
        name: null,
        former: false,
        login: null,
        verifiedAt: null,
        accountCreatedAt: null,
      }),
      expect.objectContaining({
        memberId: ADMIN,
        name: "Grace",
        you: own === ADMIN,
      }),
    ]);
  }
});

test("a member sees no section, and neither does anyone while the people are not ready, without an own active manager, or while the claims say not_allowed", () => {
  const cases: [PeopleScreenView, ClaimsScreenView][] = [
    [known({ ownMemberId: MEMBER }), listed()],
    [known({ ownMemberId: FORMER }), listed()],
    [known({ ownMemberId: null }), listed()],
    [known({ status: "loading" }), listed()],
    [
      known({
        status: "unavailable",
        problem: "failed",
      } as Partial<PeopleView>),
      listed(),
    ],
    [known({ workspaceId: null, status: "no_workspace" }), listed()],
    [{ kind: "pending" }, listed()],
    [{ kind: "unavailable" }, listed()],
    [known(), listed({ status: "not_allowed", claims: [] })],
  ];
  for (const [people, claims] of cases) {
    expect(describeRecentClaims(people, claims)).toBeNull();
  }
});

test("each state of the claims has its own fixed text, and another workspace's claims never show", () => {
  const status = (claims: ClaimsScreenView) =>
    describeRecentClaims(known(), claims)?.status;
  const rows = (claims: ClaimsScreenView) =>
    describeRecentClaims(known(), claims)?.rows;
  expect(status({ kind: "unavailable" })).toBe(CLAIM_MESSAGES.unavailable);
  expect(status({ kind: "pending" })).toBe(CLAIM_MESSAGES.pending);
  expect(status(listed({ status: "signed_out", claims: [] }))).toBe(
    CLAIM_MESSAGES.pending,
  );
  expect(status(listed({ status: "no_workspace", claims: [] }))).toBe(
    CLAIM_MESSAGES.pending,
  );
  expect(status(listed({ status: "loading", claims: [] }))).toBe(
    CLAIM_MESSAGES.loading,
  );
  expect(status(listed({ claims: [] }))).toBe(CLAIM_MESSAGES.empty);
  // Another workspace's state, before the main process followed a switch.
  const elsewhere = listed({ workspaceId: OTHER_WORKSPACE });
  expect(status(elsewhere)).toBe(CLAIM_MESSAGES.loading);
  expect(rows(elsewhere)).toEqual([]);
  expect(rows(listed({ workspaceId: null }))).toEqual([]);
  // A failed load keeps what was loaded before.
  for (const problem of WORKSPACE_PROBLEMS) {
    const failed = listed({
      status: "unavailable",
      problem,
    } as Partial<ClaimsView>);
    expect(status(failed)).toBe(CLAIM_PROBLEM_MESSAGES[problem]);
    expect(rows(failed)).toHaveLength(CLAIMS.claims.length);
  }
  expect(Object.keys(CLAIM_PROBLEM_MESSAGES).sort()).toEqual(
    [...WORKSPACE_PROBLEMS].sort(),
  );
  expect(Object.keys(CLAIM_VIA_MESSAGES).sort()).toEqual(
    [...CLAIM_VIAS_VIEW].sort(),
  );
  expect(CLAIM_VIA_MESSAGES).toEqual({
    invitation: "Joined with an invitation",
    join_request: "Joined through a join request",
  });
});

test("D9: Remove is the people list's own removal, offered as the roles table allows: the owner on admins and members, an admin only on members, never on the own person or a former member", () => {
  const removable = (own: string) => {
    const people = known({ ownMemberId: own });
    const actions = describePeopleActions(people, NOW);
    const model = describeRecentClaims(
      people,
      listed(),
      NO_MARKED_CLAIMS,
      actions.personActions,
    );
    for (const row of model?.rows ?? []) {
      if (row.remove !== null) {
        // The same request as the people list's, so the same question.
        expect(isOffered(actions, row.remove)).toBe(true);
        expect(actions.personActions.get(row.memberId)).toContainEqual(
          row.remove,
        );
      }
    }
    return (model?.rows ?? [])
      .filter((row) => row.remove !== null)
      .map((row) => row.memberId);
  };
  expect(removable(OWNER)).toEqual([MEMBER, OTHER_ADMIN, ADMIN]);
  expect(removable(ADMIN)).toEqual([MEMBER]);
  const owner = known();
  const request = describeRecentClaims(
    owner,
    listed(),
    NO_MARKED_CLAIMS,
    describePeopleActions(owner, NOW).personActions,
  )?.rows[0]?.remove;
  expect(request).toEqual({
    kind: "remove",
    workspaceId: WORKSPACE,
    memberId: MEMBER,
    name: "Linus",
    claimed: true,
  });
  // Without the people actions, no Remove.
  expect(
    describeRecentClaims(owner, listed())?.rows.every(
      (row) => row.remove === null,
    ),
  ).toBe(true);
});

test("a claim stays marked New while the marked claims hold it for the same workspace and own person, after the main process saw it", () => {
  const seen = listed({
    claims: CLAIMS.claims.map((one) => ({ ...one, unseen: false })),
  });
  const marked = (memberIds: string[], scope: string | null) =>
    describeRecentClaims(known(), seen, {
      scope,
      memberIds: new Set(memberIds),
    })
      ?.rows.filter((row) => row.marked)
      .map((row) => row.memberId);
  expect(marked([MEMBER], SCOPE)).toEqual([MEMBER]);
  expect(marked([], SCOPE)).toEqual([]);
  // Marks of another workspace or another own person never show.
  expect(marked([MEMBER], `${OTHER_WORKSPACE} ${OWNER}`)).toEqual([]);
  expect(marked([MEMBER], `${WORKSPACE} ${ADMIN}`)).toEqual([]);
  expect(marked([MEMBER], null)).toEqual([]);
});

test("the claims to report are the rendered rows that the state marks unseen, only while the section is visible", () => {
  const model = describeRecentClaims(known(), listed());
  expect(shownClaims(model, true)).toEqual({
    scope: SCOPE,
    workspaceId: WORKSPACE,
    memberIds: [MEMBER, OTHER_ADMIN],
  });
  // Not visible: nothing, whatever the state holds.
  expect(shownClaims(model, false)).toBeNull();
  // No section, no rows, or nothing unseen: nothing.
  expect(shownClaims(null, true)).toBeNull();
  expect(
    shownClaims(describeRecentClaims(known(), { kind: "pending" }), true),
  ).toBeNull();
  expect(
    shownClaims(
      describeRecentClaims(known(), listed({ workspaceId: OTHER_WORKSPACE })),
      true,
    ),
  ).toBeNull();
  expect(
    shownClaims(
      describeRecentClaims(known({ ownMemberId: MEMBER }), listed()),
      true,
    ),
  ).toBeNull();
  const seen = describeRecentClaims(
    known(),
    listed({
      claims: CLAIMS.claims.map((one) => ({ ...one, unseen: false })),
    }),
    { scope: SCOPE, memberIds: new Set([MEMBER]) },
  );
  // A row that stays marked New after the main process saw it is not reported again.
  expect(seen?.rows[0]?.marked).toBe(true);
  expect(shownClaims(seen, true)).toBeNull();
});

test("a modal dialog of the shell or the people screen covers the claims", () => {
  const open = {
    shell: false,
    people: IDLE_PEOPLE_ACTIONS,
    invitations: IDLE_INVITATION_ACTIONS,
    joinRequests: IDLE_JOIN_REQUEST_ACTIONS,
  };
  expect(claimsCovered(open)).toBe(false);
  const code = { name: "Ada", code: "code", expiresAt: "2026-11-20T00:00:00Z" };
  const remove = {
    kind: "remove",
    workspaceId: WORKSPACE,
    memberId: MEMBER,
    name: "Linus",
    claimed: true,
  } as const;
  const cases: Parameters<typeof claimsCovered>[0][] = [
    { ...open, shell: true },
    {
      ...open,
      people: {
        ...IDLE_PEOPLE_ACTIONS,
        dialog: { request: remove, draft: "", problem: undefined },
      },
    },
    {
      ...open,
      invitations: {
        ...IDLE_INVITATION_ACTIONS,
        question: {
          kind: "invite",
          workspaceId: WORKSPACE,
          memberId: MEMBER,
          name: "Linus",
        },
      },
    },
    { ...open, invitations: { ...IDLE_INVITATION_ACTIONS, code } },
    {
      ...open,
      joinRequests: {
        ...IDLE_JOIN_REQUEST_ACTIONS,
        dialog: {
          request: { kind: "denyAll", workspaceId: WORKSPACE },
          draft: "",
          invitee: undefined,
          problem: undefined,
        },
      },
    },
    { ...open, joinRequests: { ...IDLE_JOIN_REQUEST_ACTIONS, code } },
  ];
  for (const dialogs of cases) {
    expect(claimsCovered(dialogs)).toBe(true);
  }
  // A running action covers nothing: its controls stay on the page.
  const running = { ...IDLE_PEOPLE_ACTIONS, running: true };
  expect(claimsCovered({ ...open, people: running })).toBe(false);
});

function workspaceView(
  overrides: Partial<WorkspaceView> = {},
): WorkspacePanelView {
  return {
    kind: "known",
    state: {
      revision: 1,
      status: "ready",
      workspaces: [
        { id: WORKSPACE, name: "Team" },
        { id: OTHER_WORKSPACE, name: "Other" },
      ],
      selectedWorkspaceId: WORKSPACE,
      projects: [],
      openProjectId: null,
      ...overrides,
    } as WorkspaceView,
  };
}

test("the sidebar marks the people item while the selected workspace's claims hold an unseen one", () => {
  expect(hasUnseenClaims(listed(), workspaceView())).toBe(true);
  // A failed reload keeps what was loaded, and so does the marker.
  expect(
    hasUnseenClaims(
      listed({
        status: "unavailable",
        problem: "failed",
      } as Partial<ClaimsView>),
      workspaceView(),
    ),
  ).toBe(true);
  const seen = CLAIMS.claims.map((one) => ({ ...one, unseen: false }));
  const none: [ClaimsScreenView, WorkspacePanelView][] = [
    [listed({ claims: seen }), workspaceView()],
    // Another workspace's claims, before the main process followed a switch.
    [listed(), workspaceView({ selectedWorkspaceId: OTHER_WORKSPACE })],
    [listed(), workspaceView({ selectedWorkspaceId: null })],
    [
      listed({ workspaceId: null }),
      workspaceView({ selectedWorkspaceId: null }),
    ],
    [listed(), workspaceView({ status: "signed_out" })],
    [listed({ status: "loading" }), workspaceView()],
    [listed({ status: "not_allowed" }), workspaceView()],
    [{ kind: "pending" }, workspaceView()],
    [{ kind: "unavailable" }, workspaceView()],
    [listed(), { kind: "pending" }],
    [listed(), { kind: "unavailable" }],
  ];
  for (const [claims, workspaces] of none) {
    expect(hasUnseenClaims(claims, workspaces)).toBe(false);
  }
});

test("the scope names the workspace and the own person, and nothing after a sign-out", () => {
  expect(claimScope(known())).toBe(SCOPE);
  expect(claimScope(known({ ownMemberId: ADMIN }))).toBe(
    `${WORKSPACE} ${ADMIN}`,
  );
  expect(claimScope(known({ ownMemberId: null }))).toBeNull();
  expect(claimScope(known({ workspaceId: null }))).toBeNull();
  expect(claimScope(known({ status: "signed_out" }))).toBeNull();
  expect(claimScope({ kind: "pending" })).toBeNull();
});

/** A controller with recorded calls and answers that the test settles. */
function controllerWith(
  answers: {
    readonly markSeen?: () => Promise<ClaimMarkSeenResult>;
    readonly load?: () => Promise<ClaimLoadResult>;
  } = {},
) {
  const calls: { name: string; args: unknown[] }[] = [];
  const views: RecentClaimsView[] = [];
  const bridge: Pick<ClaimsBridge, "load" | "markSeen"> = {
    load: () => {
      calls.push({ name: "load", args: [] });
      return answers.load?.() ?? Promise.resolve({ outcome: "loading" });
    },
    markSeen: (workspaceId, memberIds) => {
      calls.push({ name: "markSeen", args: [workspaceId, [...memberIds]] });
      return answers.markSeen?.() ?? Promise.resolve({ outcome: "ok" });
    },
  };
  const claims = createRecentClaims(bridge, (view) => views.push(view));
  const last = () => views.at(-1) ?? IDLE_RECENT_CLAIMS;
  return { claims, calls, views, last };
}

const REPORT: ShownClaims = {
  scope: SCOPE,
  workspaceId: WORKSPACE,
  memberIds: [MEMBER, OTHER_ADMIN],
};

/** Lets the answers on their way settle. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await Promise.resolve();
  }
}

test("a report sends the shown claims once, with the workspace, and keeps them marked New during the visit", async () => {
  const { claims, calls, last } = controllerWith();
  claims.listChanged(known(), listed());
  claims.shown(REPORT);
  expect(calls).toEqual([
    { name: "markSeen", args: [WORKSPACE, [MEMBER, OTHER_ADMIN]] },
  ]);
  expect(last().marked).toEqual({
    scope: SCOPE,
    memberIds: new Set([MEMBER, OTHER_ADMIN]),
  });
  await settle();
  // The same claims again, and a later report with one more: only the new one goes.
  claims.shown(REPORT);
  claims.shown({ ...REPORT, memberIds: [FORMER, MEMBER] });
  expect(calls.slice(1)).toEqual([
    { name: "markSeen", args: [WORKSPACE, [FORMER]] },
  ]);
  // The main process saw them: the rows stay marked New on this visit.
  const seen = listed({
    revision: CLAIMS.revision + 1,
    claims: CLAIMS.claims.map((one) => ({ ...one, unseen: false })),
  });
  claims.listChanged(known(), seen);
  await settle();
  expect(
    describeRecentClaims(known(), seen, last().marked)
      ?.rows.filter((row) => row.marked)
      .map((row) => row.memberId),
  ).toEqual([MEMBER, OTHER_ADMIN, FORMER]);
});

test("nothing is reported before the people name the scope, for no claims, or for another scope", () => {
  const { claims, calls } = controllerWith();
  claims.shown(REPORT);
  claims.listChanged(known(), listed());
  claims.shown(null);
  claims.shown({ ...REPORT, scope: `${OTHER_WORKSPACE} ${OWNER}` });
  claims.shown({ ...REPORT, scope: `${WORKSPACE} ${ADMIN}` });
  expect(calls).toEqual([]);
});

test("a refused or failed report forgets its claims, so that they stay New and a later state reports them again", async () => {
  for (const markSeen of [
    () =>
      Promise.resolve({
        outcome: "refused",
        reason: "not_listed",
      } as ClaimMarkSeenResult),
    () => Promise.reject(new Error("lost")),
  ]) {
    const { claims, calls, last } = controllerWith({ markSeen });
    claims.listChanged(known(), listed());
    claims.shown(REPORT);
    await settle();
    expect(last().marked.memberIds.size).toBe(0);
    claims.shown(REPORT);
    expect(calls.filter((call) => call.name === "markSeen")).toHaveLength(2);
  }
});

test("a switch, a switch away and back, another own person, or a sign-out ends the marks, and a report's answer after it changes nothing", async () => {
  const changes: PeopleScreenView[][] = [
    [known({ workspaceId: OTHER_WORKSPACE })],
    [known({ workspaceId: OTHER_WORKSPACE }), known()],
    [known({ ownMemberId: ADMIN })],
    [known({ status: "signed_out", workspaceId: null, ownMemberId: null })],
  ];
  for (const steps of changes) {
    let refuse: (result: ClaimMarkSeenResult) => void = () => undefined;
    const { claims, calls, last } = controllerWith({
      markSeen: () =>
        new Promise((resolve) => {
          refuse = resolve;
        }),
    });
    claims.listChanged(known(), listed());
    claims.shown(REPORT);
    expect(last().marked.memberIds.size).toBe(2);
    for (const step of steps) {
      claims.listChanged(step, listed());
    }
    expect(last().marked).toEqual(NO_MARKED_CLAIMS);
    const before = last();
    // The refusal of the earlier scope's report comes after the change.
    refuse({ outcome: "refused", reason: "not_selected" });
    await settle();
    expect(last()).toBe(before);
    // Back in the first scope, the claims are reported again.
    claims.listChanged(known(), listed());
    claims.shown(REPORT);
    expect(calls.filter((call) => call.name === "markSeen")).toHaveLength(2);
  }
});

test("refreshing asks the main process to load once, says so until the next state of the claims, and says why it was refused", async () => {
  let answer: ClaimLoadResult = { outcome: "loading" };
  const { claims, calls, last } = controllerWith({
    load: () => Promise.resolve(answer),
  });
  claims.listChanged(known(), listed());
  await claims.refresh();
  expect(calls).toEqual([{ name: "load", args: [] }]);
  expect(last().message).toBe(CLAIM_REFRESH_MESSAGES.loading);
  // The same revision keeps it; a newer one ends it.
  claims.listChanged(known(), listed());
  expect(last().message).toBe(CLAIM_REFRESH_MESSAGES.loading);
  claims.listChanged(known(), listed({ revision: CLAIMS.revision + 1 }));
  expect(last().message).toBeUndefined();
  for (const reason of [
    "not_signed_in",
    "no_workspace",
    "not_allowed",
    "too_soon",
  ] as const) {
    answer = { outcome: "refused", reason };
    await claims.refresh();
    expect(last().message).toBe(CLAIM_REFRESH_MESSAGES[reason]);
  }
  const failing = controllerWith({
    load: () => Promise.reject(new Error("lost")),
  });
  await failing.claims.refresh();
  expect(failing.last().message).toBe(CLAIM_REFRESH_MESSAGES.failed);
  expect(CLAIM_REFRESH_MESSAGES).toEqual({
    loading: "Loading the recent claims again.",
    not_signed_in: "The recent claims appear once this device is signed in.",
    no_workspace: "No workspace is selected.",
    not_allowed: "Only the owner and the admins see the recent claims.",
    too_soon:
      "The recent claims were loaded a moment ago. Try again in a few seconds.",
    failed: "The recent claims could not be loaded again. Try again.",
  });
});

test("a switch, a switch away and back, or a sign-out drops the refresh's sentence and its answer on its way", async () => {
  const changes: PeopleScreenView[][] = [
    [known({ workspaceId: OTHER_WORKSPACE })],
    [known({ workspaceId: OTHER_WORKSPACE }), known()],
    [known({ status: "signed_out", workspaceId: null, ownMemberId: null })],
  ];
  for (const steps of changes) {
    // The sentence that shows goes with the change.
    const shown = controllerWith();
    shown.claims.listChanged(known(), listed());
    await shown.claims.refresh();
    expect(shown.last().message).toBe(CLAIM_REFRESH_MESSAGES.loading);
    shown.claims.listChanged(steps[0]!, listed());
    expect(shown.last().message).toBeUndefined();
    // An answer that arrives after the change shows nothing.
    let answer: (result: ClaimLoadResult) => void = () => undefined;
    const late = controllerWith({
      load: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    late.claims.listChanged(known(), listed());
    const refreshed = late.claims.refresh();
    for (const step of steps) {
      late.claims.listChanged(step, listed());
    }
    answer({ outcome: "refused", reason: "too_soon" });
    await refreshed;
    expect(late.last().message).toBeUndefined();
  }
});

test("the claims never change from an answer: the controller holds no claim", async () => {
  const { claims, views } = controllerWith();
  claims.listChanged(known(), listed());
  claims.shown(REPORT);
  await claims.refresh();
  await settle();
  for (const view of views) {
    expect(Object.keys(view).sort()).toEqual(["marked", "message"]);
    expect(Object.keys(view.marked).sort()).toEqual(["memberIds", "scope"]);
  }
});
