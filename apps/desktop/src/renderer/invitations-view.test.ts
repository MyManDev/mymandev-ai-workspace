import { afterEach, expect, test, vi } from "vitest";
import type {
  InvitationActionsBridge,
  InvitationsBridge,
} from "../shared/desktop-bridge.ts";
import type {
  CreateInvitationResult,
  InvitationActionRefusal,
  InvitationLoadResult,
  InvitationsView,
  InvitationView,
  PeopleView,
  PersonView,
  RevokeInvitationResult,
  WorkspaceProblem,
} from "../shared/ipc-contract.ts";
import {
  createInvitationActions,
  describeInvitationActionResult,
  describeInvitationQuestion,
  describeInvitations,
  followInvitations,
  IDLE_INVITATION_ACTIONS,
  initialInvitationsScreenView,
  INVITATION_ACTION_DONE_MESSAGES,
  INVITATION_ACTION_NOT_DONE_MESSAGES,
  INVITATION_ACTION_UNKNOWN_MESSAGES,
  INVITATION_CREATED_UNSEEN_MESSAGE,
  INVITATION_MESSAGES,
  INVITATION_PROBLEM_MESSAGES,
  INVITATION_REFRESH_MESSAGES,
  isInvitationOffered,
  liveLimitReached,
  MAX_LIVE_INVITATIONS,
  nextInvitationsChange,
  type InvitationActionRequest,
  type InvitationActionsView,
  type InvitationsScreenView,
} from "./invitations-view.ts";
import type { PeopleScreenView } from "./people-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OTHER_WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4";
const OWNER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c1";
const ADMIN = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c2";
const MEMBER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c3";
const UNCLAIMED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c4";
const FORMER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c5";
const SECOND_UNCLAIMED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c6";
const NEVER_CLAIMED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c7";
const UNLISTED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c8";
const INVITATION = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e1";
const SECOND_INVITATION = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e2";
const NEW_INVITATION = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e3";

/** Codes in the protocol's form (`mmdi_`, 48 characters). */
const CODE = "mmdi_Zx9-_Qw8Zx9-_Qw8Zx9-_Qw8Zx9-_Qw8Zx9-_Qw8Kpw";
const SECOND_CODE = "mmdi_Ab3_Ab3_Ab3_Ab3_Ab3_Ab3_Ab3_Ab3_Ab3_Ab3_CdA";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const ENDS_AT = "2026-11-16T10:00:00.000Z";
const SOONER_END = "2026-11-10T12:00:00.000Z";
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

const unclaimed = { claimed: false, login: null, verifiedAt: null };

const PEOPLE: readonly PersonView[] = [
  person(OWNER, "Ada", { role: "owner" }),
  person(ADMIN, "Grace", { role: "admin" }),
  person(MEMBER, "Linus"),
  person(UNCLAIMED, "Margaret", unclaimed),
  person(SECOND_UNCLAIMED, "Barbara", unclaimed),
  person(FORMER, "Alan", { former: true }),
  person(NEVER_CLAIMED, "Hedy", { ...unclaimed, former: true }),
];

const READY: PeopleView = {
  revision: 4,
  status: "ready",
  workspaceId: WORKSPACE,
  workspaceName: "Team",
  ownMemberId: OWNER,
  people: PEOPLE,
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
    invitation(SECOND_INVITATION, SECOND_UNCLAIMED, {
      creatorName: "Ada",
      expiresAt: SOONER_END,
    }),
  ],
};

function listed(
  overrides: Partial<InvitationsView> = {},
): InvitationsScreenView {
  return { kind: "known", state: { ...LIVE, ...overrides } as InvitationsView };
}

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

afterEach(() => {
  vi.restoreAllMocks();
});

test("the screen starts unavailable without the bridge and pending with it", () => {
  expect(initialInvitationsScreenView(false)).toEqual({ kind: "unavailable" });
  expect(initialInvitationsScreenView(true)).toEqual({ kind: "pending" });
});

test("following the invitations reports each state, asks the main process to load them once as the screen opens, and ends the subscription", async () => {
  const views: InvitationsScreenView[] = [];
  let listener: ((state: InvitationsView) => void) | undefined;
  let onError: (() => void) | undefined;
  let stopped = 0;
  let loads = 0;
  const bridge: Pick<InvitationsBridge, "subscribeState" | "load"> = {
    subscribeState: (next, error) => {
      listener = next;
      onError = error;
      return () => {
        stopped += 1;
      };
    },
    load: () => {
      loads += 1;
      // The main process refuses it for a member; the screen shows the state.
      return Promise.reject(new Error("refused"));
    },
  };
  const stop = followInvitations(bridge, (view) => views.push(view));
  expect(loads).toBe(1);
  listener?.(LIVE);
  onError?.();
  expect(views).toEqual([
    { kind: "known", state: LIVE },
    { kind: "unavailable" },
  ]);
  stop();
  expect(stopped).toBe(1);
  // A rejected load is not reported, and nothing loads again.
  await Promise.resolve();
  expect(loads).toBe(1);
});

test("the owner and the admins get Invite on each active unclaimed person, with the workspace that the screen showed", () => {
  for (const own of [OWNER, ADMIN]) {
    const model = describeInvitations(
      known({ ownMemberId: own }),
      listed(),
      NOW,
    );
    expect([...(model?.invites.values() ?? [])]).toEqual([
      INVITE,
      {
        kind: "invite",
        workspaceId: WORKSPACE,
        memberId: SECOND_UNCLAIMED,
        name: "Barbara",
      },
    ]);
  }
});

test("members see no invitations part, and neither does anyone while the people are not ready or the own person is not an active manager", () => {
  const nothing: PeopleScreenView[] = [
    known({ ownMemberId: MEMBER }),
    known({ ownMemberId: FORMER }),
    known({ ownMemberId: null }),
    known({ ownMemberId: UNLISTED }),
    known({ status: "loading" }),
    known({ status: "signed_out", workspaceId: null }),
    known({ status: "no_workspace", workspaceId: null }),
    known({ status: "unavailable", problem: "failed" } as Partial<PeopleView>),
    known({ workspaceId: null }),
    known({
      people: PEOPLE.map((entry) =>
        entry.memberId === OWNER ? { ...entry, former: true } : entry,
      ),
    }),
    { kind: "pending" },
    { kind: "unavailable" },
  ];
  for (const view of nothing) {
    expect(describeInvitations(view, listed(), NOW)).toBeNull();
  }
});

test("each live invitation shows the invited person's name, its creator, its end, and Revoke for the shown workspace", () => {
  const model = describeInvitations(known(), listed(), NOW);
  expect(model?.status).toBe("");
  expect(model?.rows).toEqual([
    {
      invitationId: INVITATION,
      personName: "Margaret",
      creatorName: "Grace",
      expiresAt: ENDS_AT,
      revoke: REVOKE,
    },
    {
      invitationId: SECOND_INVITATION,
      personName: "Barbara",
      creatorName: "Ada",
      expiresAt: SOONER_END,
      revoke: {
        kind: "revoke",
        workspaceId: WORKSPACE,
        invitationId: SECOND_INVITATION,
        name: "Barbara",
      },
    },
  ]);
  // A person that the people do not list has no name.
  const unlisted = describeInvitations(
    known(),
    listed({ invitations: [invitation(INVITATION, UNLISTED)] }),
    NOW,
  );
  expect(unlisted?.rows[0]?.personName).toBeNull();
  expect(unlisted?.rows[0]?.revoke).toEqual({ ...REVOKE, name: null });
});

test("an invitation past its end by the renderer's clock is left out, also at the exact end", () => {
  for (const now of [Date.parse(SOONER_END), Date.parse(SOONER_END) + 1]) {
    const model = describeInvitations(known(), listed(), now);
    expect(model?.rows.map((row) => row.invitationId)).toEqual([INVITATION]);
  }
  const ended = describeInvitations(known(), listed(), Date.parse(ENDS_AT));
  expect(ended?.rows).toEqual([]);
  expect(ended?.status).toBe(INVITATION_MESSAGES.empty);
  // An end that is not a time never shows as live.
  expect(
    describeInvitations(
      known(),
      listed({
        invitations: [invitation(INVITATION, UNCLAIMED, { expiresAt: "soon" })],
      }),
      NOW,
    )?.rows,
  ).toEqual([]);
});

test("each state of the invitations has its own fixed text, and another workspace's invitations never show", () => {
  const status = (view: InvitationsScreenView) =>
    describeInvitations(known(), view, NOW);
  expect(status({ kind: "unavailable" })?.status).toBe(
    "Invitations are not available.",
  );
  expect(status({ kind: "pending" })?.status).toBe("Checking the invitations.");
  for (const value of ["signed_out", "no_workspace", "not_allowed"] as const) {
    expect(status(listed({ status: value, invitations: [] }))?.status).toBe(
      "Checking the invitations.",
    );
  }
  expect(status(listed({ status: "loading", invitations: [] }))?.status).toBe(
    "Loading the invitations.",
  );
  expect(status(listed({ invitations: [] }))?.status).toBe(
    "No open invitations.",
  );
  const other = status(listed({ workspaceId: OTHER_WORKSPACE }));
  expect(other?.status).toBe("Loading the invitations.");
  expect(other?.rows).toEqual([]);
  // The invites stay with every state of the list.
  expect(other?.invites.size).toBe(2);
});

test("a failed load shows a fixed sentence for its problem, with what was loaded before", () => {
  const problems: Record<WorkspaceProblem, string> = {
    not_signed_in: "The server did not accept this device's sign-in.",
    not_found: "The server did not find the selected workspace.",
    rate_limited: "The server asked to wait. Trying again in a minute.",
    unavailable: "The server could not be reached. Trying again later.",
    failed: "The invitations could not be loaded. Trying again later.",
  };
  expect(INVITATION_PROBLEM_MESSAGES).toEqual(problems);
  for (const [problem, text] of Object.entries(problems)) {
    const model = describeInvitations(
      known(),
      listed({ status: "unavailable", problem } as Partial<InvitationsView>),
      NOW,
    );
    expect(model?.status).toBe(text);
    expect(model?.rows).toHaveLength(2);
  }
});

test("a question stays offered only as it was asked", () => {
  const model = describeInvitations(known(), listed(), NOW);
  expect(isInvitationOffered(model, INVITE)).toBe(true);
  expect(isInvitationOffered(model, REVOKE)).toBe(true);
  expect(isInvitationOffered(null, INVITE)).toBe(false);
  const claimed = describeInvitations(
    known({
      people: PEOPLE.map((entry) =>
        entry.memberId === UNCLAIMED
          ? { ...entry, claimed: true, login: "hopper" }
          : entry,
      ),
    }),
    listed(),
    NOW,
  );
  expect(isInvitationOffered(claimed, INVITE)).toBe(false);
  const renamed = describeInvitations(
    known({
      people: PEOPLE.map((entry) =>
        entry.memberId === UNCLAIMED
          ? { ...entry, displayName: "Peggy" }
          : entry,
      ),
    }),
    listed(),
    NOW,
  );
  expect(isInvitationOffered(renamed, INVITE)).toBe(false);
  expect(isInvitationOffered(renamed, REVOKE)).toBe(false);
  const gone = describeInvitations(
    known(),
    listed({ invitations: [invitation(SECOND_INVITATION, SECOND_UNCLAIMED)] }),
    NOW,
  );
  expect(isInvitationOffered(gone, REVOKE)).toBe(false);
  expect(isInvitationOffered(gone, INVITE)).toBe(true);
  const switched = describeInvitations(
    known({ workspaceId: OTHER_WORKSPACE }),
    listed({ workspaceId: OTHER_WORKSPACE }),
    NOW,
  );
  expect(isInvitationOffered(switched, INVITE)).toBe(false);
  expect(isInvitationOffered(switched, REVOKE)).toBe(false);
});

test("the list changes by the clock at the end of the soonest live invitation", () => {
  expect(nextInvitationsChange(listed(), NOW)).toBe(Date.parse(SOONER_END));
  expect(nextInvitationsChange(listed(), Date.parse(SOONER_END))).toBe(
    Date.parse(ENDS_AT),
  );
  expect(nextInvitationsChange(listed(), Date.parse(ENDS_AT))).toBeUndefined();
  expect(nextInvitationsChange({ kind: "pending" }, NOW)).toBeUndefined();
  expect(
    nextInvitationsChange(
      listed({
        invitations: [invitation(INVITATION, UNCLAIMED, { expiresAt: "x" })],
      }),
      NOW,
    ),
  ).toBeUndefined();
});

test("the question before a create says that it revokes an earlier invitation and that the code shows once; the revocation's names its person", () => {
  expect(describeInvitationQuestion(INVITE)).toEqual({
    title: "Invite this person?",
    text: "This creates an invitation code with which one person can claim this person, once, within 7 days. The code is shown only once, right after it is created. If this person already has an open invitation, that invitation is revoked and its code stops working.",
    confirm: "Create the invitation",
    name: "Margaret",
  });
  expect(describeInvitationQuestion(REVOKE)).toEqual({
    title: "Revoke this invitation?",
    text: "Its code stops working at once. The person stays listed as not claimed, and you can invite them again.",
    confirm: "Revoke",
    name: "Margaret",
  });
  expect(describeInvitationQuestion({ ...REVOKE, name: null }).name).toBe(
    "A person who is not shown here",
  );
});

function refused(
  reason: InvitationActionRefusal,
  retryAfterMs: number | null = null,
): CreateInvitationResult & RevokeInvitationResult {
  return {
    outcome: "refused",
    reason,
    retryAfterMs,
  } as CreateInvitationResult & RevokeInvitationResult;
}

test("every result of a create and a revocation has its fixed sentence", () => {
  const describe = (
    request: InvitationActionRequest,
    result: CreateInvitationResult | RevokeInvitationResult,
  ) => describeInvitationActionResult(request, result, LIVE, NOW);
  expect(
    describe(INVITE, {
      outcome: "ok",
      invitationId: NEW_INVITATION,
      code: CODE,
      expiresAt: CREATED_ENDS_AT,
    }),
  ).toBe("The invitation was created.");
  expect(describe(REVOKE, { outcome: "ok" })).toBe(
    "The invitation was revoked.",
  );
  expect(describe(INVITE, { outcome: "unknown" })).toBe(
    "It is not known whether the invitation was created. Check the open invitations; the request is not sent again on its own. A code that was not shown here cannot be shown later: to get a code, invite the person again, which revokes an earlier invitation.",
  );
  expect(describe(REVOKE, { outcome: "unknown" })).toBe(
    "It is not known whether the invitation was revoked. Check the open invitations; the request is not sent again on its own.",
  );
  const create = "The invitation could not be created.";
  const revoke = "The invitation could not be revoked.";
  const both: [InvitationActionRefusal, string][] = [
    ["invalid", "The request was not valid."],
    [
      "not_selected",
      "Another workspace was selected before it was sent. Check the list, then try again.",
    ],
    [
      "not_signed_in",
      "This device is not signed in, or the server did not accept its sign-in.",
    ],
    [
      "unavailable",
      "This device cannot send it now. Wait until the sign-in or the current change of the account is finished, then try again.",
    ],
    ["not_allowed", "Your role in this workspace does not allow it."],
    ["failed", "The server refused it."],
  ];
  for (const [reason, text] of both) {
    expect(describe(INVITE, refused(reason))).toBe(`${create} ${text}`);
    expect(describe(REVOKE, refused(reason))).toBe(`${revoke} ${text}`);
  }
  expect(describe(INVITE, refused("not_found"))).toBe(
    `${create} The server does not know this workspace or this person for your account. Check the list.`,
  );
  expect(describe(REVOKE, refused("not_found"))).toBe(
    `${revoke} The server does not know this invitation for your account. Check the open invitations.`,
  );
  expect(describe(INVITE, refused("conflict"))).toBe(
    `${create} The person was claimed or removed in the meantime. Check the list.`,
  );
  expect(describe(REVOKE, refused("conflict"))).toBe(
    `${revoke} The invitation is no longer open: it was used, revoked, or it ended. Check the open invitations.`,
  );
  expect(describe(INVITE, refused("too_soon", 1_500))).toBe(
    `${create} This device sent many changes in a short time. Try again in 2 seconds.`,
  );
  expect(describe(REVOKE, refused("rate_limited", 90_000))).toBe(
    `${revoke} The server asked to wait. Try again in 2 minutes.`,
  );
  expect(describe(INVITE, refused("rate_limited", 20 * 3_600_000))).toBe(
    `${create} The server asked to wait. Try again in 20 hours.`,
  );
});

/** A list with `others` live invitations of other people, and one of Margaret's if `own`. */
function crowded(others: number, own = false): InvitationsView {
  const invitations = Array.from({ length: others }, (_, index) =>
    invitation(
      `0192f2a0-7c3e-7a1b-8c4d-${String(index).padStart(12, "0")}`,
      `0192f2a0-7c3e-7a1b-9c4d-${String(index).padStart(12, "0")}`,
    ),
  );
  if (own) {
    invitations.push(invitation(INVITATION, UNCLAIMED));
  }
  return { ...LIVE, invitations };
}

test("a create's rate_limited names the limit of 50 live invitations only when the list shows it reached without the person's own", () => {
  expect(MAX_LIVE_INVITATIONS).toBe(50);
  const limit =
    "The invitation could not be created. The workspace already has as many open invitations as it allows (50). Revoke one, or wait until one is used or ends, then try again.";
  const wait =
    "The invitation could not be created. The server asked to wait. Try again in 3 hours.";
  const result = refused("rate_limited", 3 * 3_600_000);
  expect(describeInvitationActionResult(INVITE, result, crowded(50), NOW)).toBe(
    limit,
  );
  expect(describeInvitationActionResult(INVITE, result, crowded(49), NOW)).toBe(
    wait,
  );
  // The person's own invitation is replaced, so it does not count.
  expect(
    describeInvitationActionResult(INVITE, result, crowded(49, true), NOW),
  ).toBe(wait);
  expect(liveLimitReached(crowded(49, true), WORKSPACE, UNCLAIMED, NOW)).toBe(
    false,
  );
  // Another workspace's list, a list not loaded, and none at all tell nothing.
  for (const invitations of [
    { ...crowded(50), workspaceId: OTHER_WORKSPACE },
    { ...crowded(50), status: "loading" as const },
    undefined,
  ]) {
    expect(
      describeInvitationActionResult(INVITE, result, invitations, NOW),
    ).toBe(wait);
  }
  // A failed load keeps what it held.
  expect(
    describeInvitationActionResult(
      INVITE,
      result,
      { ...crowded(50), status: "unavailable", problem: "failed" },
      NOW,
    ),
  ).toBe(limit);
  // Invitations that ended by the clock do not count.
  expect(
    describeInvitationActionResult(
      INVITE,
      result,
      crowded(50),
      Date.parse(ENDS_AT),
    ),
  ).toBe(wait);
  // A revocation never names the limit.
  expect(describeInvitationActionResult(REVOKE, result, crowded(50), NOW)).toBe(
    "The invitation could not be revoked. The server asked to wait. Try again in 3 hours.",
  );
});

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

interface Answers {
  readonly create?: () => Promise<CreateInvitationResult>;
  readonly revoke?: () => Promise<RevokeInvitationResult>;
  readonly load?: () => Promise<InvitationLoadResult>;
}

const NOT_CALLED = () => Promise.reject(new Error("not expected"));

/**
 * A controller over fake bridges that has seen `people` and `invitations`,
 * the owner's ready people and the live invitations by default, as the
 * screen shows them before any click.
 */
function controllerWith(
  answers: Answers,
  people: PeopleScreenView = known(),
  invitations: InvitationsScreenView = listed(),
) {
  const calls: Call[] = [];
  const record =
    <T>(name: string, answer: () => Promise<T>) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return answer();
    };
  const bridge = {
    create: record("create", answers.create ?? NOT_CALLED),
    revoke: record("revoke", answers.revoke ?? NOT_CALLED),
  } as unknown as Pick<InvitationActionsBridge, "create" | "revoke">;
  const list = {
    load: record("load", answers.load ?? NOT_CALLED),
  } as unknown as Pick<InvitationsBridge, "load">;
  const views: InvitationActionsView[] = [];
  const actions = createInvitationActions(bridge, list, (view) =>
    views.push(view),
  );
  actions.listChanged(people, invitations, NOW);
  const last = () => views.at(-1) ?? IDLE_INVITATION_ACTIONS;
  return { actions, calls, views, last };
}

/** An answer that waits until the test resolves it. */
function pending<T>() {
  const answers: ((result: T) => void)[] = [];
  const failures: ((error: Error) => void)[] = [];
  const answer = () =>
    new Promise<T>((done, fail) => {
      answers.push(done);
      failures.push(fail);
    });
  const resolve = (result: T) => answers.shift()?.(result);
  const reject = () => failures.shift()?.(new Error("lost"));
  return { answer, resolve, reject };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

const CREATED: CreateInvitationResult = {
  outcome: "ok",
  invitationId: NEW_INVITATION,
  code: CODE,
  expiresAt: CREATED_ENDS_AT,
};

test("both actions ask first, and send nothing until confirmed, then once, with the shown workspace and no lifetime", async () => {
  const { actions, calls, last } = controllerWith({
    create: () => Promise.resolve({ outcome: "unknown" }),
    revoke: () => Promise.resolve({ outcome: "unknown" }),
  });
  actions.start(INVITE);
  expect(last().question).toEqual(INVITE);
  expect(calls).toEqual([]);
  await actions.confirm();
  actions.start(REVOKE);
  expect(last().question).toEqual(REVOKE);
  expect(calls).toHaveLength(1);
  await actions.confirm();
  expect(calls).toEqual([
    { name: "create", args: [WORKSPACE, UNCLAIMED] },
    { name: "revoke", args: [WORKSPACE, INVITATION] },
  ]);
  // Confirming again sends nothing: the question is gone.
  await actions.confirm();
  expect(calls).toHaveLength(2);
});

test("cancelling closes the question and sends nothing, also on a later confirmation", async () => {
  const { actions, calls, last } = controllerWith({});
  actions.start(INVITE);
  actions.cancel();
  expect(last()).toEqual(IDLE_INVITATION_ACTIONS);
  expect(await actions.confirm()).toBe(false);
  expect(calls).toEqual([]);
});

test("one action runs at a time: while one runs, nothing else opens, sends, or refreshes", async () => {
  const create = pending<CreateInvitationResult>();
  const { actions, calls, last } = controllerWith({ create: create.answer });
  actions.start(INVITE);
  const first = actions.confirm();
  expect(last().running).toBe(true);
  expect(last().question).toBeUndefined();
  actions.start(REVOKE);
  expect(last().question).toBeUndefined();
  expect(await actions.confirm()).toBe(false);
  await actions.refresh();
  expect(calls).toEqual([{ name: "create", args: [WORKSPACE, UNCLAIMED] }]);
  create.resolve({ outcome: "unknown" });
  expect(await first).toBe(false);
  expect(last().running).toBe(false);
});

test("an unknown answer is never sent again on its own", async () => {
  const { actions, calls, last } = controllerWith({
    create: () => Promise.resolve({ outcome: "unknown" }),
  });
  actions.start(INVITE);
  await actions.confirm();
  for (let turn = 0; turn < 3; turn += 1) {
    actions.listChanged(known(), listed({ revision: 10 + turn }), NOW + turn);
    await settle();
  }
  expect(calls).toHaveLength(1);
  expect(last().message).toBe(INVITATION_ACTION_UNKNOWN_MESSAGES.invite);
  expect(last().code).toBeUndefined();
});

test("a confirmed revocation resolves to true, so the focus moves; a create and a refusal resolve to false", async () => {
  const revoked = controllerWith({
    revoke: () => Promise.resolve({ outcome: "ok" }),
  });
  revoked.actions.start(REVOKE);
  expect(await revoked.actions.confirm()).toBe(true);
  expect(revoked.last().message).toBe(INVITATION_ACTION_DONE_MESSAGES.revoke);

  const created = controllerWith({ create: () => Promise.resolve(CREATED) });
  created.actions.start(INVITE);
  expect(await created.actions.confirm()).toBe(false);

  const conflict = controllerWith({
    revoke: () => Promise.resolve(refused("conflict")),
  });
  conflict.actions.start(REVOKE);
  expect(await conflict.actions.confirm()).toBe(false);
  expect(conflict.last().message).toBe(
    "The invitation could not be revoked. The invitation is no longer open: it was used, revoked, or it ended. Check the open invitations.",
  );
});

test("a call that fails on its way says that nothing was sent", async () => {
  const { actions, last } = controllerWith({
    create: () => Promise.reject(new Error("refused by the contract")),
  });
  actions.start(INVITE);
  expect(await actions.confirm()).toBe(false);
  expect(last()).toEqual({
    running: false,
    message: `${INVITATION_ACTION_NOT_DONE_MESSAGES.invite} It was not sent. Try again.`,
    question: undefined,
    code: undefined,
  });
});

test("a create's limit sentence uses the latest invitations that the screen showed", async () => {
  const { actions, last } = controllerWith(
    { create: () => Promise.resolve(refused("rate_limited", 60_000)) },
    known(),
    { kind: "known", state: crowded(50) },
  );
  actions.start(INVITE);
  await actions.confirm();
  expect(last().message).toBe(
    "The invitation could not be created. The workspace already has as many open invitations as it allows (50). Revoke one, or wait until one is used or ends, then try again.",
  );
});

/** Every console method, spied on, so that a test sees any log. */
function spyOnConsole() {
  return (["log", "info", "warn", "error", "debug", "trace"] as const).map(
    (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
  );
}

/** The views as text, with every string whole. */
function serialized(views: readonly unknown[]): string {
  return JSON.stringify(views);
}

test("D2: the code of a confirmed create shows once, in its dialog's view only, never in a sentence; closing the dialog drops it from every later view", async () => {
  const logs = spyOnConsole();
  const { actions, calls, views, last } = controllerWith({
    create: () => Promise.resolve(CREATED),
    revoke: () => Promise.resolve({ outcome: "ok" }),
    load: () => Promise.resolve({ outcome: "loading" }),
  });
  actions.start(INVITE);
  await actions.confirm();
  expect(last()).toEqual({
    running: false,
    message: "The invitation was created.",
    question: undefined,
    code: { name: "Margaret", code: CODE, expiresAt: CREATED_ENDS_AT },
  });
  // The code is in the dialog's field of the view, and nowhere else.
  expect(
    views.filter((view) => serialized([view]).includes(CODE)),
  ).toHaveLength(1);
  for (const view of views) {
    expect(serialized([{ ...view, code: undefined }])).not.toContain(CODE);
  }
  // A new action cannot start while the code shows.
  actions.start(REVOKE);
  expect(last().question).toBeUndefined();

  const before = views.length;
  actions.closeCode();
  expect(last()).toEqual({
    running: false,
    message: "The invitation was created.",
    question: undefined,
    code: undefined,
  });
  // Whatever follows, no view holds the code again: new states, the new
  // invitation in the list, another action, a refresh, and a new question.
  actions.listChanged(
    known(),
    listed({
      revision: 9,
      invitations: [invitation(NEW_INVITATION, UNCLAIMED)],
    }),
    NOW + 1,
  );
  actions.closeCode();
  actions.start({ ...REVOKE, invitationId: NEW_INVITATION });
  await actions.confirm();
  await actions.refresh();
  actions.start(INVITE);
  actions.cancel();
  const later = views.slice(before);
  expect(later.length).toBeGreaterThan(4);
  expect(serialized(later)).not.toContain(CODE);
  expect(serialized(later)).not.toContain(CODE.slice(5, 30));
  // The create went once, and no other call answers with a code.
  expect(calls.map((call) => call.name)).toEqual(["create", "revoke", "load"]);
  // Nothing was logged.
  for (const log of logs) {
    expect(log).not.toHaveBeenCalled();
  }
});

test("D2: a second create shows only its own code, and closing drops it as well", async () => {
  let next = CREATED;
  const { actions, views, last } = controllerWith({
    create: () => Promise.resolve(next),
  });
  actions.start(INVITE);
  await actions.confirm();
  actions.closeCode();
  next = { ...CREATED, code: SECOND_CODE };
  const before = views.length;
  actions.start(INVITE);
  await actions.confirm();
  expect(last().code?.code).toBe(SECOND_CODE);
  expect(serialized(views.slice(before))).not.toContain(CODE);
  actions.closeCode();
  expect(last().code).toBeUndefined();
});

test("D2: a switch or a sign-out while the code shows drops it", async () => {
  for (const next of [
    known({ workspaceId: OTHER_WORKSPACE }),
    known({ status: "signed_out", workspaceId: null }),
    known({ workspaceId: null, status: "no_workspace" }),
  ]) {
    const { actions, views, last } = controllerWith({
      create: () => Promise.resolve(CREATED),
    });
    actions.start(INVITE);
    await actions.confirm();
    expect(last().code?.code).toBe(CODE);
    const before = views.length;
    actions.listChanged(next, listed(), NOW);
    expect(last()).toEqual(IDLE_INVITATION_ACTIONS);
    expect(serialized(views.slice(before))).not.toContain(CODE);
  }
});

test("D2: an answer after a switch, a switch away and back, or a sign-out never shows the code, and shows the create's result only as the fixed sentence of its workspace", async () => {
  const unseen: InvitationActionsView = {
    ...IDLE_INVITATION_ACTIONS,
    message: INVITATION_CREATED_UNSEEN_MESSAGE,
  };
  const scenarios: [PeopleScreenView[], InvitationActionsView][] = [
    // Another workspace is shown: it says nothing.
    [[known({ workspaceId: OTHER_WORKSPACE })], IDLE_INVITATION_ACTIONS],
    // The action's workspace is shown again: it says so at once.
    [[known({ workspaceId: OTHER_WORKSPACE }), known()], unseen],
    // A sign-out ends the session: nothing, also after a new sign-in.
    [
      [known({ status: "signed_out", workspaceId: null }), known()],
      IDLE_INVITATION_ACTIONS,
    ],
  ];
  for (const [steps, expected] of scenarios) {
    const create = pending<CreateInvitationResult>();
    const { actions, views, last } = controllerWith({ create: create.answer });
    actions.start(INVITE);
    const done = actions.confirm();
    for (const step of steps) {
      actions.listChanged(step, listed(), NOW);
    }
    create.resolve(CREATED);
    expect(await done).toBe(false);
    expect(last()).toEqual(expected);
    expect(serialized(views)).not.toContain(CODE);
    expect(serialized(views)).not.toContain(CODE.slice(5, 30));
  }
  // A revocation's answer after a switch shows nothing either.
  const revoke = pending<RevokeInvitationResult>();
  const { actions, last } = controllerWith({ revoke: revoke.answer });
  actions.start(REVOKE);
  const done = actions.confirm();
  actions.listChanged(known({ workspaceId: OTHER_WORKSPACE }), listed(), NOW);
  revoke.resolve({ outcome: "ok" });
  expect(await done).toBe(false);
  expect(last().message).toBeUndefined();
});

/**
 * A controller whose create answered with the code while another workspace
 * was shown, with `steps` the views that the screen showed in between.
 */
async function createdAway(steps: PeopleScreenView[], answers: Answers = {}) {
  const create = pending<CreateInvitationResult>();
  const controller = controllerWith({ ...answers, create: create.answer });
  controller.actions.start(INVITE);
  const done = controller.actions.confirm();
  for (const step of steps) {
    controller.actions.listChanged(step, listed(), NOW);
  }
  create.resolve(CREATED);
  await done;
  return controller;
}

const THIRD_WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a5";

test("a create confirmed after a switch away says, on its own workspace only, once it is shown again, that the code could not be shown, and never holds the code", async () => {
  expect(INVITATION_CREATED_UNSEEN_MESSAGE).toBe(
    "An invitation was created, but its code could not be shown. Invite the person again for a new code.",
  );
  expect(INVITATION_CREATED_UNSEEN_MESSAGE).not.toContain("mmdi_");
  const { actions, views, last } = await createdAway([
    known({ workspaceId: OTHER_WORKSPACE }),
  ]);
  // Not in the workspace shown when the answer came, nor in another one.
  expect(last().message).toBeUndefined();
  actions.listChanged(known({ workspaceId: THIRD_WORKSPACE }), listed(), NOW);
  expect(last().message).toBeUndefined();
  actions.listChanged(
    known({ workspaceId: null, status: "no_workspace" }),
    listed(),
    NOW,
  );
  expect(last().message).toBeUndefined();
  // The action's workspace shown again says it, without a code or a dialog.
  actions.listChanged(known(), listed(), NOW);
  expect(last()).toEqual({
    ...IDLE_INVITATION_ACTIONS,
    message: INVITATION_CREATED_UNSEEN_MESSAGE,
  });
  // It stays through later states of the same workspace.
  actions.listChanged(known(), listed({ revision: 12 }), NOW + 1);
  expect(last().message).toBe(INVITATION_CREATED_UNSEEN_MESSAGE);
  // Like every sentence, a switch ends it, and it never comes back.
  actions.listChanged(known({ workspaceId: OTHER_WORKSPACE }), listed(), NOW);
  expect(last().message).toBeUndefined();
  actions.listChanged(known(), listed(), NOW);
  expect(last().message).toBeUndefined();
  expect(serialized(views)).not.toContain(CODE);
  expect(serialized(views)).not.toContain(CODE.slice(5, 30));
});

test("the sentence of a code that could not be shown ends with the next action or a refresh, and with a sign-out before its workspace shows again", async () => {
  // The next action, also in another workspace, ends it before it shows.
  const next = await createdAway([known({ workspaceId: OTHER_WORKSPACE })], {
    revoke: () => Promise.resolve({ outcome: "unknown" }),
  });
  next.actions.listChanged(
    known({ workspaceId: OTHER_WORKSPACE }),
    listed({ workspaceId: OTHER_WORKSPACE }),
    NOW,
  );
  next.actions.start({ ...REVOKE, workspaceId: OTHER_WORKSPACE });
  await next.actions.confirm();
  next.actions.listChanged(known(), listed(), NOW);
  expect(next.last().message).toBeUndefined();

  // A refresh ends it before it shows.
  const refreshed = await createdAway(
    [known({ workspaceId: OTHER_WORKSPACE })],
    { load: () => Promise.resolve({ outcome: "refused", reason: "too_soon" }) },
  );
  await refreshed.actions.refresh();
  refreshed.actions.listChanged(known(), listed(), NOW);
  expect(refreshed.last().message).toBeUndefined();

  // A sign-out ends it before it shows.
  const signedOut = await createdAway([
    known({ workspaceId: OTHER_WORKSPACE }),
  ]);
  signedOut.actions.listChanged(
    known({ status: "signed_out", workspaceId: null }),
    listed(),
    NOW,
  );
  signedOut.actions.listChanged(known(), listed(), NOW);
  expect(signedOut.last().message).toBeUndefined();

  // Once shown, the next action and a refresh replace it.
  const shown = await createdAway([known({ workspaceId: OTHER_WORKSPACE })], {
    revoke: () => Promise.resolve({ outcome: "ok" }),
    load: () => Promise.resolve({ outcome: "refused", reason: "too_soon" }),
  });
  shown.actions.listChanged(known(), listed(), NOW);
  expect(shown.last().message).toBe(INVITATION_CREATED_UNSEEN_MESSAGE);
  await shown.actions.refresh();
  expect(shown.last().message).toBe(INVITATION_REFRESH_MESSAGES.too_soon);
  const again = await createdAway([known({ workspaceId: OTHER_WORKSPACE })], {
    revoke: () => Promise.resolve({ outcome: "ok" }),
  });
  again.actions.listChanged(known(), listed(), NOW);
  again.actions.start(REVOKE);
  expect(again.last().message).toBe(INVITATION_CREATED_UNSEEN_MESSAGE);
  await again.actions.confirm();
  expect(again.last().message).toBe(INVITATION_ACTION_DONE_MESSAGES.revoke);
});

test("only a confirmed create says that its code could not be shown: an unknown or refused create, a failed call, and a revocation answered after a switch say nothing", async () => {
  const answers: (() => Promise<CreateInvitationResult>)[] = [
    () => Promise.resolve({ outcome: "unknown" }),
    () => Promise.resolve(refused("conflict")),
    () => Promise.reject(new Error("lost")),
  ];
  for (const answer of answers) {
    const create = pending<CreateInvitationResult>();
    const { actions, last } = controllerWith({ create: create.answer });
    actions.start(INVITE);
    const done = actions.confirm();
    actions.listChanged(known({ workspaceId: OTHER_WORKSPACE }), listed(), NOW);
    answer().then(create.resolve, create.reject);
    await done;
    actions.listChanged(known(), listed(), NOW);
    expect(last().message).toBeUndefined();
  }
  const revoke = pending<RevokeInvitationResult>();
  const { actions, last } = controllerWith({ revoke: revoke.answer });
  actions.start(REVOKE);
  const done = actions.confirm();
  actions.listChanged(known({ workspaceId: OTHER_WORKSPACE }), listed(), NOW);
  revoke.resolve({ outcome: "ok" });
  await done;
  actions.listChanged(known(), listed(), NOW);
  expect(last().message).toBeUndefined();
});

test("an open question ends once the screen no longer offers it as it was asked, and a later confirmation sends nothing", async () => {
  const cases: [
    InvitationActionRequest,
    PeopleScreenView,
    InvitationsScreenView,
  ][] = [
    [
      INVITE,
      known({
        people: PEOPLE.map((entry) =>
          entry.memberId === UNCLAIMED ? { ...entry, claimed: true } : entry,
        ),
      }),
      listed(),
    ],
    [INVITE, known({ ownMemberId: MEMBER }), listed()],
    [INVITE, known({ status: "loading" }), listed()],
    [REVOKE, known(), listed({ invitations: [] })],
    [REVOKE, known(), listed({ status: "loading", invitations: [] })],
  ];
  for (const [request, people, invitations] of cases) {
    const { actions, calls, last } = controllerWith({});
    actions.start(request);
    actions.listChanged(people, invitations, NOW);
    expect(last().question).toBeUndefined();
    expect(await actions.confirm()).toBe(false);
    expect(calls).toEqual([]);
  }
  // The revocation's question also ends when the invitation ends by the clock.
  const { actions, last } = controllerWith({});
  actions.start(REVOKE);
  actions.listChanged(known(), listed(), Date.parse(ENDS_AT));
  expect(last().question).toBeUndefined();
  // A view that changes nothing keeps it.
  const kept = controllerWith({});
  kept.actions.start(INVITE);
  kept.actions.listChanged(known(), listed({ revision: 8 }), NOW + 1);
  expect(kept.last().question).toEqual(INVITE);
});

test("another workspace, none, or a sign-out drops the question and the sentence", async () => {
  for (const next of [
    known({ workspaceId: OTHER_WORKSPACE }),
    known({ workspaceId: null, status: "no_workspace" }),
    known({ status: "signed_out", workspaceId: null }),
  ]) {
    const { actions, last } = controllerWith({
      revoke: () => Promise.resolve({ outcome: "ok" }),
    });
    actions.start(REVOKE);
    await actions.confirm();
    expect(last().message).toBe("The invitation was revoked.");
    actions.listChanged(next, listed(), NOW);
    expect(last()).toEqual(IDLE_INVITATION_ACTIONS);
  }
});

test("refreshing asks the main process to load once, says so until the next state of the invitations, and says why it was refused", async () => {
  const { actions, calls, last } = controllerWith({
    load: () => Promise.resolve({ outcome: "loading" }),
  });
  await actions.refresh();
  expect(calls).toEqual([{ name: "load", args: [] }]);
  expect(last().message).toBe("Loading the invitations again.");
  // The same state again keeps it; a newer one ends it.
  actions.listChanged(known(), listed(), NOW);
  expect(last().message).toBe("Loading the invitations again.");
  actions.listChanged(known(), listed({ revision: 4 }), NOW);
  expect(last().message).toBeUndefined();

  const refusals: [InvitationLoadResult, string][] = [
    [
      { outcome: "refused", reason: "too_soon" },
      "The invitations were loaded a moment ago. Try again in a few seconds.",
    ],
    [
      { outcome: "refused", reason: "not_signed_in" },
      "The invitations appear once this device is signed in.",
    ],
    [
      { outcome: "refused", reason: "no_workspace" },
      "No workspace is selected.",
    ],
    [
      { outcome: "refused", reason: "not_allowed" },
      "Only the owner and the admins see the invitations.",
    ],
  ];
  for (const [answer, text] of refusals) {
    const refusedLoad = controllerWith({ load: () => Promise.resolve(answer) });
    await refusedLoad.actions.refresh();
    expect(refusedLoad.last().message).toBe(text);
    // A newer state keeps a refusal's sentence.
    refusedLoad.actions.listChanged(known(), listed({ revision: 9 }), NOW);
    expect(refusedLoad.last().message).toBe(text);
  }
  const failed = controllerWith({
    load: () => Promise.reject(new Error("lost")),
  });
  await failed.actions.refresh();
  expect(failed.last().message).toBe(INVITATION_REFRESH_MESSAGES.failed);
  expect(INVITATION_REFRESH_MESSAGES.failed).toBe(
    "The invitations could not be loaded again. Try again.",
  );
});

test("a refresh's answer after a switch shows nothing", async () => {
  const load = pending<InvitationLoadResult>();
  const { actions, last } = controllerWith({ load: load.answer });
  const done = actions.refresh();
  actions.listChanged(known({ workspaceId: OTHER_WORKSPACE }), listed(), NOW);
  load.resolve({ outcome: "loading" });
  await done;
  expect(last().message).toBeUndefined();
});
