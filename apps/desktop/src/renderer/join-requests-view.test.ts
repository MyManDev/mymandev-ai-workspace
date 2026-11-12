import { afterEach, expect, test, vi } from "vitest";
import type {
  InvitationActionsBridge,
  JoinRequestActionsBridge,
  JoinRequestsBridge,
  PeopleActionsBridge,
} from "../shared/desktop-bridge.ts";
import type {
  ApproveJoinRequestResult,
  BlockedJoinRequestView,
  CreateInvitationResult,
  DefinePersonResult,
  JoinRequestActionRefusal,
  JoinRequestActionResult,
  JoinRequestLoadResult,
  JoinRequestsView,
  PeopleView,
  PendingJoinRequestView,
  PersonView,
} from "../shared/ipc-contract.ts";
import {
  ASKING_JOIN_REQUEST_ACTIONS,
  createJoinRequestActions,
  describeJoinRequestActionResult,
  describeJoinRequestQuestion,
  describeJoinRequests,
  followJoinRequests,
  IDLE_JOIN_REQUEST_ACTIONS,
  initialJoinRequestsScreenView,
  INVITE_INSTEAD_MESSAGES,
  isJoinRequestOffered,
  JOIN_REQUEST_ACTION_DONE_MESSAGES,
  JOIN_REQUEST_ACTION_NOT_DONE_MESSAGES,
  JOIN_REQUEST_ACTION_UNKNOWN_MESSAGES,
  JOIN_REQUEST_MESSAGES,
  JOIN_REQUEST_PROBLEM_MESSAGES,
  JOIN_REQUEST_REFRESH_MESSAGES,
  type JoinRequestActionKind,
  type JoinRequestActionRequest,
  type JoinRequestActionsView,
  type JoinRequestsScreenView,
} from "./join-requests-view.ts";
import {
  MAX_PERSON_NAME_LENGTH,
  PEOPLE_ACTION_UNKNOWN_MESSAGES,
} from "./people-actions-view.ts";
import { INVITATION_ACTION_UNKNOWN_MESSAGES } from "./invitations-view.ts";
import type { PeopleScreenView } from "./people-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OTHER_WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4";
const OWNER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c1";
const ADMIN = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c2";
const MEMBER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c3";
const UNCLAIMED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c4";
const FORMER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c5";
const NEW_PERSON = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c9";
const REQUEST = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d1";
const SECOND_REQUEST = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d2";
const BLOCKED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d3";
const NEW_INVITATION = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e3";

/** A code in the protocol's form (`mmdi_`, 48 characters). */
const CODE = "mmdi_Zx9-_Qw8Zx9-_Qw8Zx9-_Qw8Zx9-_Qw8Zx9-_Qw8Kpw";
const CREATED_ENDS_AT = "2026-11-19T12:00:00.000Z";
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

const unclaimed = { claimed: false, login: null, verifiedAt: null };

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
    person(UNCLAIMED, "Margaret", unclaimed),
    person(FORMER, "Alan", { ...unclaimed, former: true }),
  ],
  morePeople: 0,
  ownershipOffer: null,
  maxUnclaimedMembers: 50,
};

function known(overrides: Partial<PeopleView> = {}): PeopleScreenView {
  return { kind: "known", state: { ...READY, ...overrides } as PeopleView };
}

function pendingRequest(
  joinRequestId: string,
  requestedName: string,
  login: string,
): PendingJoinRequestView {
  return {
    joinRequestId,
    requestedName,
    login,
    verifiedAt: "2026-11-11T09:00:00.000Z",
    accountCreatedAt: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-11-11T09:00:00.000Z",
    expiresAt: "2026-11-18T09:00:00.000Z",
  };
}

const BLOCK: BlockedJoinRequestView = {
  joinRequestId: BLOCKED,
  requestedName: "Mallory",
  login: "mallory",
  verifiedAt: "2026-11-01T09:00:00.000Z",
  accountCreatedAt: "2026-10-30T00:00:00.000Z",
  createdAt: "2026-11-01T09:00:00.000Z",
  blockedAt: "2026-11-02T10:00:00.000Z",
};

const LISTED: JoinRequestsView = {
  revision: 7,
  status: "ready",
  workspaceId: WORKSPACE,
  pending: [
    pendingRequest(REQUEST, "Katherine", "kjohnson"),
    pendingRequest(SECOND_REQUEST, "Dorothy", "dvaughan"),
  ],
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

const ON_REQUEST = {
  workspaceId: WORKSPACE,
  joinRequestId: REQUEST,
  name: "Katherine",
  login: "kjohnson",
};
const APPROVE: JoinRequestActionRequest = { kind: "approve", ...ON_REQUEST };
const INVITE: JoinRequestActionRequest = { kind: "invite", ...ON_REQUEST };
const DENY: JoinRequestActionRequest = { kind: "deny", ...ON_REQUEST };
const BLOCK_REQUEST: JoinRequestActionRequest = {
  kind: "block",
  ...ON_REQUEST,
};
const UNBLOCK: JoinRequestActionRequest = {
  kind: "unblock",
  workspaceId: WORKSPACE,
  joinRequestId: BLOCKED,
  name: "Mallory",
  login: "mallory",
};
const DENY_ALL: JoinRequestActionRequest = {
  kind: "denyAll",
  workspaceId: WORKSPACE,
};
const PAUSE: JoinRequestActionRequest = {
  kind: "pause",
  workspaceId: WORKSPACE,
};
const RESUME: JoinRequestActionRequest = {
  kind: "resume",
  workspaceId: WORKSPACE,
};

afterEach(() => {
  vi.restoreAllMocks();
});

test("the screen starts unavailable without the bridge and pending with it", () => {
  expect(initialJoinRequestsScreenView(false)).toEqual({ kind: "unavailable" });
  expect(initialJoinRequestsScreenView(true)).toEqual({ kind: "pending" });
});

test("following the join requests reports each state, asks the main process to load them once as the screen opens, and ends the subscription", async () => {
  const views: JoinRequestsScreenView[] = [];
  let listener: ((state: JoinRequestsView) => void) | undefined;
  let onError: (() => void) | undefined;
  let stopped = 0;
  let loads = 0;
  const bridge: Pick<JoinRequestsBridge, "subscribeState" | "load"> = {
    subscribeState: (next, error) => {
      listener = next;
      onError = error;
      return () => {
        stopped += 1;
      };
    },
    load: () => {
      loads += 1;
      return Promise.reject(new Error("refused"));
    },
  };
  const stop = followJoinRequests(bridge, (view) => views.push(view));
  expect(loads).toBe(1);
  listener?.(LISTED);
  onError?.();
  expect(views).toEqual([
    { kind: "known", state: LISTED },
    { kind: "unavailable" },
  ]);
  stop();
  expect(stopped).toBe(1);
  await Promise.resolve();
  expect(loads).toBe(1);
});

test("the owner and the admins see each pending request with its actions in order, the blocks with Unblock, Deny all, the pause, and the unclaimed people", () => {
  for (const own of [OWNER, ADMIN]) {
    const model = describeJoinRequests(known({ ownMemberId: own }), listed());
    expect(model?.status).toBe("");
    expect(model?.pending.map((row) => row.requestedName)).toEqual([
      "Katherine",
      "Dorothy",
    ]);
    expect(model?.pending[0]).toEqual({
      joinRequestId: REQUEST,
      requestedName: "Katherine",
      login: "kjohnson",
      verifiedAt: "2026-11-11T09:00:00.000Z",
      accountCreatedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-11-18T09:00:00.000Z",
      actions: [APPROVE, INVITE, DENY, BLOCK_REQUEST],
    });
    expect(model?.blocked).toEqual([
      {
        joinRequestId: BLOCKED,
        requestedName: "Mallory",
        login: "mallory",
        verifiedAt: "2026-11-01T09:00:00.000Z",
        accountCreatedAt: "2026-10-30T00:00:00.000Z",
        blockedAt: "2026-11-02T10:00:00.000Z",
        unblock: UNBLOCK,
      },
    ]);
    expect(model?.denyAll).toEqual(DENY_ALL);
    expect(model?.pause).toEqual({ pausedAt: null, request: PAUSE });
    // Only active unclaimed people: no claimed one and no former one.
    expect(model?.unclaimed).toEqual([
      { memberId: UNCLAIMED, name: "Margaret" },
    ]);
  }
  // A pause offers the resume, with its time.
  expect(
    describeJoinRequests(known(), listed({ pausedAt: PAUSED_AT }))?.pause,
  ).toEqual({ pausedAt: PAUSED_AT, request: RESUME });
  // Without a pending request: no Deny all, and the empty text.
  const empty = describeJoinRequests(known(), listed({ pending: [] }));
  expect(empty?.denyAll).toBeNull();
  expect(empty?.status).toBe(JOIN_REQUEST_MESSAGES.empty);
  expect(empty?.blocked).toHaveLength(1);
});

test("members see no join requests part, and neither does anyone while the people are not ready, without an own active manager, or while the join requests say not_allowed", () => {
  const nothing: [PeopleScreenView, JoinRequestsScreenView][] = [
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
    // The main process dropped the list at a demotion before the people
    // show it.
    [known(), listed({ status: "not_allowed", pending: [], blocked: [] })],
    [
      known(),
      listed({
        workspaceId: OTHER_WORKSPACE,
        status: "not_allowed",
        pending: [],
        blocked: [],
      }),
    ],
  ];
  for (const [people, joinRequests] of nothing) {
    expect(describeJoinRequests(people, joinRequests)).toBeNull();
  }
});

test("each state of the join requests has its own fixed text, and another workspace's requests never show", () => {
  const status = (view: JoinRequestsScreenView) =>
    describeJoinRequests(known(), view)?.status;
  expect(status({ kind: "unavailable" })).toBe(
    JOIN_REQUEST_MESSAGES.unavailable,
  );
  expect(status({ kind: "pending" })).toBe(JOIN_REQUEST_MESSAGES.pending);
  expect(status(listed({ status: "loading", pending: [], blocked: [] }))).toBe(
    JOIN_REQUEST_MESSAGES.loading,
  );
  for (const other of ["signed_out", "no_workspace"] as const) {
    expect(status(listed({ status: other, pending: [], blocked: [] }))).toBe(
      JOIN_REQUEST_MESSAGES.pending,
    );
  }
  const elsewhere = describeJoinRequests(
    known(),
    listed({ workspaceId: OTHER_WORKSPACE }),
  );
  expect(elsewhere?.status).toBe(JOIN_REQUEST_MESSAGES.loading);
  expect(elsewhere?.pending).toEqual([]);
  expect(elsewhere?.blocked).toEqual([]);
  expect(elsewhere?.denyAll).toBeNull();
  expect(elsewhere?.pause).toBeNull();
  // A failed load shows its problem, with what was loaded before.
  for (const problem of Object.keys(JOIN_REQUEST_PROBLEM_MESSAGES)) {
    const model = describeJoinRequests(
      known(),
      listed({ status: "unavailable", problem } as Partial<JoinRequestsView>),
    );
    expect(model?.status).toBe(
      JOIN_REQUEST_PROBLEM_MESSAGES[
        problem as keyof typeof JOIN_REQUEST_PROBLEM_MESSAGES
      ],
    );
    expect(model?.pending).toHaveLength(2);
  }
});

test("a question stays offered only as it was asked", () => {
  const model = describeJoinRequests(known(), listed());
  for (const request of [
    APPROVE,
    INVITE,
    DENY,
    BLOCK_REQUEST,
    UNBLOCK,
    DENY_ALL,
    PAUSE,
  ]) {
    expect(isJoinRequestOffered(model, request), request.kind).toBe(true);
  }
  expect(isJoinRequestOffered(model, RESUME)).toBe(false);
  expect(isJoinRequestOffered(null, APPROVE)).toBe(false);
  // Another workspace, request, name, or login is not the same request.
  expect(
    isJoinRequestOffered(model, { ...APPROVE, workspaceId: OTHER_WORKSPACE }),
  ).toBe(false);
  expect(isJoinRequestOffered(model, { ...DENY, joinRequestId: BLOCKED })).toBe(
    false,
  );
  expect(isJoinRequestOffered(model, { ...DENY, name: "Kate" })).toBe(false);
  expect(isJoinRequestOffered(model, { ...BLOCK_REQUEST, login: "kj" })).toBe(
    false,
  );
  expect(
    isJoinRequestOffered(model, { ...UNBLOCK, joinRequestId: REQUEST }),
  ).toBe(false);
  // Deny all goes with the last pending request.
  expect(
    isJoinRequestOffered(
      describeJoinRequests(known(), listed({ pending: [] })),
      DENY_ALL,
    ),
  ).toBe(false);
});

test("deny, deny all, block, the approval, and Deny and invite instead ask first; an unblock, a pause, and a resume do not", () => {
  expect([...ASKING_JOIN_REQUEST_ACTIONS].sort()).toEqual([
    "approve",
    "block",
    "deny",
    "denyAll",
    "invite",
  ]);
  for (const request of [UNBLOCK, PAUSE, RESUME]) {
    expect(describeJoinRequestQuestion(request)).toBeUndefined();
  }
  expect(describeJoinRequestQuestion(DENY)?.title).toBe("Deny this request?");
  expect(describeJoinRequestQuestion(DENY_ALL)?.title).toBe(
    "Deny all pending requests?",
  );
  expect(describeJoinRequestQuestion(BLOCK_REQUEST)?.text).toBe(
    "The request ends, and this account cannot ask to join this workspace again until it is unblocked.",
  );
  // The composition's question says that the invitation comes first, and
  // that the request stays pending when it cannot be created.
  const invite = describeJoinRequestQuestion(INVITE)?.text ?? "";
  expect(invite).toContain("First an invitation is created");
  expect(invite).toContain("its code is shown once");
  expect(invite).toContain("Only then is the request denied.");
  expect(invite).toContain(
    "If the invitation cannot be created, the request stays pending.",
  );
});

function refused(
  reason: JoinRequestActionRefusal,
  retryAfterMs: number | null = null,
): JoinRequestActionResult {
  return { outcome: "refused", reason, retryAfterMs };
}

const DECISIONS: readonly Exclude<JoinRequestActionKind, "invite">[] = [
  "approve",
  "deny",
  "denyAll",
  "block",
  "unblock",
  "pause",
  "resume",
];

test("every result of every action has its fixed sentence", () => {
  for (const kind of DECISIONS) {
    expect(describeJoinRequestActionResult(kind, { outcome: "ok" })).toBe(
      JOIN_REQUEST_ACTION_DONE_MESSAGES[kind],
    );
    const unknown = describeJoinRequestActionResult(kind, {
      outcome: "unknown",
    });
    expect(unknown).toBe(JOIN_REQUEST_ACTION_UNKNOWN_MESSAGES[kind]);
    expect(unknown).toContain("the request is not sent again on its own.");
    for (const reason of [
      "invalid",
      "not_selected",
      "not_signed_in",
      "unavailable",
      "not_allowed",
      "not_found",
      "conflict",
      "already_member",
      "failed",
    ] as const) {
      const sentence = describeJoinRequestActionResult(kind, refused(reason));
      expect(
        sentence.startsWith(JOIN_REQUEST_ACTION_NOT_DONE_MESSAGES[kind]),
      ).toBe(true);
      expect(sentence.length).toBeGreaterThan(
        JOIN_REQUEST_ACTION_NOT_DONE_MESSAGES[kind].length + 10,
      );
    }
  }
  expect(
    describeJoinRequestActionResult("approve", {
      outcome: "ok",
      memberId: NEW_PERSON,
    }),
  ).toBe("The request was approved. The account is now a member.");
  expect(describeJoinRequestActionResult("approve", refused("invalid"))).toBe(
    "The request could not be approved. The name is not allowed. Use visible characters, without line breaks.",
  );
  expect(describeJoinRequestActionResult("deny", refused("invalid"))).toBe(
    "The request could not be denied. The request was not valid.",
  );
  expect(describeJoinRequestActionResult("deny", refused("conflict"))).toBe(
    "The request could not be denied. The request is no longer pending: it was decided, withdrawn, or it ended. Check the join requests.",
  );
  expect(describeJoinRequestActionResult("unblock", refused("conflict"))).toBe(
    "The account could not be unblocked. The account is no longer blocked: the block was lifted in the meantime. Check the blocked accounts.",
  );
  expect(
    describeJoinRequestActionResult("approve", refused("already_member")),
  ).toBe(
    "The request could not be approved. The account is already a member of this workspace, for example after it joined with an invitation. Check the people.",
  );
  expect(
    describeJoinRequestActionResult("block", refused("too_soon", 1_500)),
  ).toBe(
    "The account could not be blocked. This device sent many changes in a short time. Try again in 2 seconds.",
  );
  expect(
    describeJoinRequestActionResult("pause", refused("rate_limited", 90_000)),
  ).toBe(
    "New join requests could not be paused. The server asked to wait. Try again in 2 minutes.",
  );
});

interface Answers {
  readonly approve?: () => Promise<ApproveJoinRequestResult>;
  readonly deny?: () => Promise<JoinRequestActionResult>;
  readonly denyAll?: () => Promise<JoinRequestActionResult>;
  readonly block?: () => Promise<JoinRequestActionResult>;
  readonly unblock?: () => Promise<JoinRequestActionResult>;
  readonly pause?: () => Promise<JoinRequestActionResult>;
  readonly resume?: () => Promise<JoinRequestActionResult>;
  readonly load?: () => Promise<JoinRequestLoadResult>;
  readonly define?: () => Promise<DefinePersonResult>;
  readonly create?: () => Promise<CreateInvitationResult>;
}

interface Call {
  readonly name: string;
  readonly args: unknown[];
}

const NOT_CALLED = () => Promise.reject(new Error("not expected"));

/**
 * A controller over fake bridges that has seen `people` and `joinRequests`,
 * the owner's ready people and the listed requests by default.
 */
function controllerWith(
  answers: Answers,
  people: PeopleScreenView = known(),
  joinRequests: JoinRequestsScreenView = listed(),
) {
  const calls: Call[] = [];
  const record =
    <T>(name: string, answer: () => Promise<T>) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return answer();
    };
  const joinRequestActions = {
    approve: record("approve", answers.approve ?? NOT_CALLED),
    deny: record("deny", answers.deny ?? NOT_CALLED),
    denyAll: record("denyAll", answers.denyAll ?? NOT_CALLED),
    block: record("block", answers.block ?? NOT_CALLED),
    unblock: record("unblock", answers.unblock ?? NOT_CALLED),
    pause: record("pause", answers.pause ?? NOT_CALLED),
    resume: record("resume", answers.resume ?? NOT_CALLED),
  } as unknown as JoinRequestActionsBridge;
  const views: JoinRequestActionsView[] = [];
  const actions = createJoinRequestActions(
    {
      joinRequestActions,
      joinRequests: {
        load: record("load", answers.load ?? NOT_CALLED),
      } as unknown as Pick<JoinRequestsBridge, "load">,
      peopleActions: {
        define: record("define", answers.define ?? NOT_CALLED),
      } as unknown as Pick<PeopleActionsBridge, "define">,
      invitationActions: {
        create: record("create", answers.create ?? NOT_CALLED),
      } as unknown as Pick<InvitationActionsBridge, "create">,
    },
    (view) => views.push(view),
  );
  actions.listChanged(people, joinRequests);
  const last = () => views.at(-1) ?? IDLE_JOIN_REQUEST_ACTIONS;
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
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

const OK = () => Promise.resolve<JoinRequestActionResult>({ outcome: "ok" });
const UNKNOWN = () =>
  Promise.resolve<JoinRequestActionResult>({ outcome: "unknown" });
const DEFINED = () =>
  Promise.resolve<DefinePersonResult>({ outcome: "ok", memberId: NEW_PERSON });
const CREATED: CreateInvitationResult = {
  outcome: "ok",
  invitationId: NEW_INVITATION,
  code: CODE,
  expiresAt: CREATED_ENDS_AT,
};

test("deny, deny all, and block ask first and send nothing until confirmed, then once, with the shown workspace", async () => {
  const { actions, calls, last } = controllerWith({
    deny: OK,
    denyAll: OK,
    block: OK,
  });
  for (const request of [DENY, DENY_ALL, BLOCK_REQUEST]) {
    expect(await actions.start(request)).toBe(false);
    expect(last().dialog?.request).toEqual(request);
    actions.listChanged(known(), listed());
    expect(await actions.confirm()).toBe(true);
    expect(last().message).toBe(
      JOIN_REQUEST_ACTION_DONE_MESSAGES[
        request.kind as Exclude<JoinRequestActionKind, "invite">
      ],
    );
    // Confirming again sends nothing: the question is gone.
    expect(await actions.confirm()).toBe(false);
  }
  expect(calls).toEqual([
    { name: "deny", args: [WORKSPACE, REQUEST] },
    { name: "denyAll", args: [WORKSPACE] },
    { name: "block", args: [WORKSPACE, REQUEST] },
  ]);
});

test("cancelling closes the question and sends nothing, also on a later confirmation", async () => {
  const { actions, calls, last } = controllerWith({});
  for (const request of [DENY, DENY_ALL, BLOCK_REQUEST, APPROVE, INVITE]) {
    await actions.start(request);
    actions.cancel();
    expect(last()).toEqual(IDLE_JOIN_REQUEST_ACTIONS);
    expect(await actions.confirm()).toBe(false);
  }
  expect(calls).toEqual([]);
});

test("an unblock, a pause, and a resume run at once, once, and resolve to true when confirmed", async () => {
  const { actions, calls, last } = controllerWith({
    unblock: OK,
    pause: OK,
    resume: OK,
  });
  expect(await actions.start(UNBLOCK)).toBe(true);
  expect(last().message).toBe("The account is no longer blocked.");
  expect(await actions.start(PAUSE)).toBe(true);
  expect(last().message).toBe("New join requests are paused.");
  actions.listChanged(known(), listed({ pausedAt: PAUSED_AT }));
  expect(await actions.start(RESUME)).toBe(true);
  expect(last().message).toBe("New join requests are accepted again.");
  expect(calls).toEqual([
    { name: "unblock", args: [WORKSPACE, BLOCKED] },
    { name: "pause", args: [WORKSPACE] },
    { name: "resume", args: [WORKSPACE] },
  ]);
  expect(last().dialog).toBeUndefined();
});

test("an approval starts with the requested name, sends null for it unchanged and the trimmed name otherwise", async () => {
  const approved = () =>
    Promise.resolve<ApproveJoinRequestResult>({
      outcome: "ok",
      memberId: NEW_PERSON,
    });
  const { actions, calls, last } = controllerWith({ approve: approved });
  await actions.start(APPROVE);
  expect(last().dialog).toEqual({
    request: APPROVE,
    draft: "Katherine",
    problem: undefined,
    choice: { kind: "new" },
  });
  expect(await actions.confirm()).toBe(true);
  await actions.start(APPROVE);
  actions.editDraft("  Kate J.  ");
  expect(await actions.confirm()).toBe(true);
  // The requested name with spaces around it is still the requested name.
  await actions.start(APPROVE);
  actions.editDraft(" Katherine ");
  await actions.confirm();
  expect(calls).toEqual([
    { name: "approve", args: [WORKSPACE, REQUEST, null] },
    { name: "approve", args: [WORKSPACE, REQUEST, "Kate J."] },
    { name: "approve", args: [WORKSPACE, REQUEST, null] },
  ]);
  expect(last().message).toBe(JOIN_REQUEST_ACTION_DONE_MESSAGES.approve);
});

test("an approval's name is checked first, in characters (code points): empty and 65 characters keep the question open with the problem, and 64 emoji go", async () => {
  const { actions, calls, last } = controllerWith({
    approve: () =>
      Promise.resolve<ApproveJoinRequestResult>({ outcome: "unknown" }),
  });
  await actions.start(APPROVE);
  actions.editDraft("   ");
  expect(await actions.confirm()).toBe(false);
  expect(last().dialog?.problem).toBe("Enter a name.");
  // Editing ends the problem of the name as it was.
  actions.editDraft("\u{1F600}".repeat(MAX_PERSON_NAME_LENGTH + 1));
  expect(last().dialog?.problem).toBeUndefined();
  expect(await actions.confirm()).toBe(false);
  expect(last().dialog?.problem).toBe("A name has at most 64 characters.");
  expect(calls).toEqual([]);
  const wide = "\u{1F600}".repeat(MAX_PERSON_NAME_LENGTH);
  actions.editDraft(wide);
  await actions.confirm();
  expect(calls).toEqual([
    { name: "approve", args: [WORKSPACE, REQUEST, wide] },
  ]);
  expect(last().message).toBe(JOIN_REQUEST_ACTION_UNKNOWN_MESSAGES.approve);
});

test("one action runs at a time: while one runs, nothing else opens, sends, or refreshes", async () => {
  const deny = pending<JoinRequestActionResult>();
  const { actions, calls, last } = controllerWith({ deny: deny.answer });
  await actions.start(DENY);
  const first = actions.confirm();
  expect(last().running).toBe(true);
  expect(last().dialog).toBeUndefined();
  expect(await actions.start(BLOCK_REQUEST)).toBe(false);
  expect(await actions.start(PAUSE)).toBe(false);
  expect(last().dialog).toBeUndefined();
  expect(await actions.confirm()).toBe(false);
  await actions.refresh();
  expect(calls).toEqual([{ name: "deny", args: [WORKSPACE, REQUEST] }]);
  deny.resolve({ outcome: "ok" });
  expect(await first).toBe(true);
  expect(last().running).toBe(false);
});

test("an unknown answer is never sent again on its own, and a refusal or a failed call resolves to false", async () => {
  const { actions, calls, last } = controllerWith({
    block: UNKNOWN,
    deny: () => Promise.resolve(refused("conflict")),
    pause: () => Promise.reject(new Error("refused by the contract")),
  });
  await actions.start(BLOCK_REQUEST);
  expect(await actions.confirm()).toBe(false);
  for (let turn = 0; turn < 3; turn += 1) {
    actions.listChanged(known(), listed({ revision: 10 + turn }));
    await settle();
  }
  expect(calls).toHaveLength(1);
  expect(last().message).toBe(JOIN_REQUEST_ACTION_UNKNOWN_MESSAGES.block);
  await actions.start(DENY);
  expect(await actions.confirm()).toBe(false);
  expect(last().message).toBe(
    "The request could not be denied. The request is no longer pending: it was decided, withdrawn, or it ended. Check the join requests.",
  );
  expect(await actions.start(PAUSE)).toBe(false);
  expect(last().message).toBe(
    "New join requests could not be paused. It was not sent. Try again.",
  );
  expect(calls.map((call) => call.name)).toEqual(["block", "deny", "pause"]);
});

test("a switch while a question is open closes it, and a switch, a switch away and back, or a sign-out while an action runs drops its answer", async () => {
  // An open question closes with a switch, and a later confirmation sends nothing.
  const open = controllerWith({ deny: OK });
  await open.actions.start(DENY);
  open.actions.listChanged(
    known({ workspaceId: OTHER_WORKSPACE }),
    listed({ workspaceId: OTHER_WORKSPACE }),
  );
  expect(open.last()).toEqual(IDLE_JOIN_REQUEST_ACTIONS);
  expect(await open.actions.confirm()).toBe(false);
  expect(open.calls).toEqual([]);

  const scenarios: PeopleScreenView[][] = [
    [known({ workspaceId: OTHER_WORKSPACE })],
    [known({ workspaceId: OTHER_WORKSPACE }), known()],
    [known({ status: "signed_out", workspaceId: null }), known()],
    [known({ workspaceId: null, status: "no_workspace" })],
  ];
  for (const steps of scenarios) {
    const deny = pending<JoinRequestActionResult>();
    const { actions, last } = controllerWith({ deny: deny.answer });
    await actions.start(DENY);
    const done = actions.confirm();
    for (const step of steps) {
      actions.listChanged(step, listed());
    }
    deny.resolve({ outcome: "ok" });
    // No sentence and no focus move for an answer of another workspace.
    expect(await done).toBe(false);
    expect(last().message).toBeUndefined();
    expect(last().running).toBe(false);
  }
});

test("another workspace, none, or a sign-out drops the sentence", async () => {
  for (const next of [
    known({ workspaceId: OTHER_WORKSPACE }),
    known({ workspaceId: null, status: "no_workspace" }),
    known({ status: "signed_out", workspaceId: null }),
  ]) {
    const { actions, last } = controllerWith({ deny: OK });
    await actions.start(DENY);
    await actions.confirm();
    expect(last().message).toBe(JOIN_REQUEST_ACTION_DONE_MESSAGES.deny);
    actions.listChanged(next, listed());
    expect(last()).toEqual(IDLE_JOIN_REQUEST_ACTIONS);
  }
});

test("an open question ends once the screen no longer offers it as it was asked, and a later confirmation sends nothing", async () => {
  const cases: [
    JoinRequestActionRequest,
    PeopleScreenView,
    JoinRequestsScreenView,
  ][] = [
    // Decided on another device: the request left the list.
    [DENY, known(), listed({ pending: [LISTED.pending[1]!] })],
    // A demotion that the main process applied first.
    [
      BLOCK_REQUEST,
      known(),
      listed({ status: "not_allowed", pending: [], blocked: [] }),
    ],
    // A demotion that the people show.
    [APPROVE, known({ ownMemberId: MEMBER }), listed()],
    // The block was lifted elsewhere.
    [UNBLOCK, known(), listed({ blocked: [] })],
    // The last pending request went.
    [DENY_ALL, known(), listed({ pending: [] })],
  ];
  for (const [request, people, joinRequests] of cases) {
    const { actions, calls, last } = controllerWith({});
    actions.start(request).catch(() => undefined);
    if (!ASKING_JOIN_REQUEST_ACTIONS.has(request.kind)) {
      continue;
    }
    expect(last().dialog?.request).toEqual(request);
    actions.listChanged(people, joinRequests);
    expect(last().dialog, request.kind).toBeUndefined();
    // It never comes back on its own.
    actions.listChanged(known(), listed());
    expect(last().dialog).toBeUndefined();
    expect(await actions.confirm()).toBe(false);
    expect(calls).toEqual([]);
  }
});

test("refreshing asks the main process to load once, says so until the next state of the join requests, and says why it was refused", async () => {
  let answer: JoinRequestLoadResult = { outcome: "loading" };
  const { actions, calls, last } = controllerWith({
    load: () => Promise.resolve(answer),
  });
  await actions.refresh();
  expect(calls).toEqual([{ name: "load", args: [] }]);
  expect(last().message).toBe(JOIN_REQUEST_REFRESH_MESSAGES.loading);
  // The same revision keeps it; a newer one ends it.
  actions.listChanged(known(), listed());
  expect(last().message).toBe(JOIN_REQUEST_REFRESH_MESSAGES.loading);
  actions.listChanged(known(), listed({ revision: LISTED.revision + 1 }));
  expect(last().message).toBeUndefined();
  for (const reason of [
    "not_signed_in",
    "no_workspace",
    "not_allowed",
    "too_soon",
  ] as const) {
    answer = { outcome: "refused", reason };
    await actions.refresh();
    expect(last().message).toBe(JOIN_REQUEST_REFRESH_MESSAGES[reason]);
  }
  const failing = controllerWith({
    load: () => Promise.reject(new Error("lost")),
  });
  await failing.actions.refresh();
  expect(failing.last().message).toBe(JOIN_REQUEST_REFRESH_MESSAGES.failed);
});

// "Deny and invite instead": the invitation first, then the denial.

/** Every console method, spied on, so that a test sees any log. */
function spyOnConsole() {
  return (["log", "info", "warn", "error", "debug", "trace"] as const).map(
    (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
  );
}

test("Deny and invite instead defines a new person with the requested name, creates the invitation, shows its code once, and only then denies", async () => {
  const logs = spyOnConsole();
  const deny = pending<JoinRequestActionResult>();
  const { actions, calls, views, last } = controllerWith({
    define: DEFINED,
    create: () => Promise.resolve(CREATED),
    deny: deny.answer,
  });
  await actions.start(INVITE);
  expect(last().dialog?.choice).toEqual({ kind: "new" });
  expect(calls).toEqual([]);
  const done = actions.confirm();
  await settle();
  // The code shows before the denial answers, and the action still runs.
  expect(calls).toEqual([
    { name: "define", args: [WORKSPACE, "Katherine"] },
    { name: "create", args: [WORKSPACE, NEW_PERSON] },
    { name: "deny", args: [WORKSPACE, REQUEST] },
  ]);
  expect(last()).toEqual({
    running: true,
    message: undefined,
    dialog: undefined,
    code: { name: "Katherine", code: CODE, expiresAt: CREATED_ENDS_AT },
  });
  deny.resolve({ outcome: "ok" });
  expect(await done).toBe(true);
  expect(last().message).toBe(
    "The invitation was created, and the request was denied.",
  );
  expect(last().running).toBe(false);
  // D2: the code is in the code of the views only, never in a sentence.
  for (const view of views) {
    expect(JSON.stringify({ ...view, code: undefined })).not.toContain(CODE);
  }
  // While the code shows, nothing else starts.
  expect(await actions.start(DENY)).toBe(false);
  expect(last().dialog).toBeUndefined();
  const before = views.length;
  actions.closeCode();
  expect(last().code).toBeUndefined();
  actions.listChanged(known(), listed({ revision: 20 }));
  await actions.start(DENY);
  actions.cancel();
  expect(JSON.stringify(views.slice(before))).not.toContain(CODE);
  expect(JSON.stringify(views.slice(before))).not.toContain(CODE.slice(5, 30));
  for (const log of logs) {
    expect(log).not.toHaveBeenCalled();
  }
});

test("Deny and invite instead invites a chosen unclaimed person without a definition", async () => {
  const { actions, calls, last } = controllerWith({
    create: () => Promise.resolve(CREATED),
    deny: OK,
  });
  await actions.start(INVITE);
  // A person that the screen does not offer cannot be chosen.
  actions.choose({ kind: "existing", memberId: MEMBER });
  expect(last().dialog?.choice).toEqual({ kind: "new" });
  actions.choose({ kind: "existing", memberId: UNCLAIMED });
  expect(last().dialog?.choice).toEqual({
    kind: "existing",
    memberId: UNCLAIMED,
  });
  expect(await actions.confirm()).toBe(true);
  expect(calls).toEqual([
    { name: "create", args: [WORKSPACE, UNCLAIMED] },
    { name: "deny", args: [WORKSPACE, REQUEST] },
  ]);
  expect(last().code).toEqual({
    name: "Margaret",
    code: CODE,
    expiresAt: CREATED_ENDS_AT,
  });
});

test("Deny and invite instead: a definition that is refused, uncertain, or fails on its way creates nothing and denies nothing, and says so", async () => {
  const cases: [() => Promise<DefinePersonResult>, string][] = [
    [
      () =>
        Promise.resolve({
          outcome: "refused",
          reason: "unclaimed_limit",
          retryAfterMs: null,
        }),
      "The request was not denied. The person could not be added. The workspace already has as many unclaimed people as it allows. Remove one, or invite one of them: once they join, they no longer count.",
    ],
    [
      () => Promise.resolve({ outcome: "unknown" }),
      `The request was not denied. ${PEOPLE_ACTION_UNKNOWN_MESSAGES.define}`,
    ],
    [
      () => Promise.reject(new Error("lost")),
      "The request was not denied. The person could not be added. It was not sent. Try again.",
    ],
  ];
  for (const [define, sentence] of cases) {
    const { actions, calls, last } = controllerWith({ define });
    await actions.start(INVITE);
    expect(await actions.confirm()).toBe(false);
    expect(calls.map((call) => call.name)).toEqual(["define"]);
    expect(last()).toEqual({ ...IDLE_JOIN_REQUEST_ACTIONS, message: sentence });
  }
});

test("Deny and invite instead: a create that is refused, uncertain, or fails on its way denies nothing, shows no code, and says whether the person was added", async () => {
  const cases: [boolean, () => Promise<CreateInvitationResult>, string][] = [
    [
      true,
      () =>
        Promise.resolve({
          outcome: "refused",
          reason: "conflict",
          retryAfterMs: null,
        }),
      "The request was not denied. The person was added. The invitation could not be created. The person was claimed or removed in the meantime. Check the list.",
    ],
    [
      true,
      () => Promise.resolve({ outcome: "unknown" }),
      `The request was not denied. The person was added. ${INVITATION_ACTION_UNKNOWN_MESSAGES.invite}`,
    ],
    [
      false,
      () => Promise.resolve({ outcome: "unknown" }),
      `The request was not denied. ${INVITATION_ACTION_UNKNOWN_MESSAGES.invite}`,
    ],
    [
      false,
      () => Promise.reject(new Error("lost")),
      "The request was not denied. The invitation could not be created. It was not sent. Try again.",
    ],
  ];
  for (const [defining, create, sentence] of cases) {
    const { actions, calls, last } = controllerWith({
      define: DEFINED,
      create,
    });
    await actions.start(INVITE);
    if (!defining) {
      actions.choose({ kind: "existing", memberId: UNCLAIMED });
    }
    expect(await actions.confirm()).toBe(false);
    expect(calls.map((call) => call.name)).toEqual(
      defining ? ["define", "create"] : ["create"],
    );
    expect(last()).toEqual({ ...IDLE_JOIN_REQUEST_ACTIONS, message: sentence });
    // Nothing is sent again on its own.
    actions.listChanged(known(), listed({ revision: 30 }));
    await settle();
    expect(calls).toHaveLength(defining ? 2 : 1);
  }
});

test("Deny and invite instead: a denial that is refused, uncertain, or fails after the invitation keeps the code shown once and says that the invitation was created", async () => {
  const cases: [() => Promise<JoinRequestActionResult>, string][] = [
    [
      () => Promise.resolve(refused("conflict")),
      "The invitation was created. The request could not be denied. The request is no longer pending: it was decided, withdrawn, or it ended. Check the join requests.",
    ],
    [
      UNKNOWN,
      `The invitation was created. ${JOIN_REQUEST_ACTION_UNKNOWN_MESSAGES.deny}`,
    ],
    [
      () => Promise.reject(new Error("lost")),
      "The invitation was created. The request could not be denied. It was not sent. Try again.",
    ],
  ];
  for (const [deny, sentence] of cases) {
    const { actions, calls, views, last } = controllerWith({
      create: () => Promise.resolve(CREATED),
      deny,
    });
    await actions.start(INVITE);
    actions.choose({ kind: "existing", memberId: UNCLAIMED });
    expect(await actions.confirm()).toBe(false);
    expect(calls.map((call) => call.name)).toEqual(["create", "deny"]);
    expect(last().message).toBe(sentence);
    expect(last().code?.code).toBe(CODE);
    expect(views.filter((view) => view.code !== undefined)).toHaveLength(2);
    expect(sentence).not.toContain(CODE);
  }
});

test("Deny and invite instead stops at a switch: an answer after it sends no next step and shows no sentence, and a code created meanwhile is dropped unseen, which its workspace says once it is shown again", async () => {
  // A switch during the definition: nothing more is sent.
  const define = pending<DefinePersonResult>();
  const first = controllerWith({ define: define.answer });
  await first.actions.start(INVITE);
  const defining = first.actions.confirm();
  first.actions.listChanged(known({ workspaceId: OTHER_WORKSPACE }), listed());
  define.resolve({ outcome: "ok", memberId: NEW_PERSON });
  expect(await defining).toBe(false);
  expect(first.calls.map((call) => call.name)).toEqual(["define"]);
  expect(first.last()).toEqual(IDLE_JOIN_REQUEST_ACTIONS);

  // A switch during the create: the code is dropped, and nothing is denied.
  const create = pending<CreateInvitationResult>();
  const second = controllerWith({ create: create.answer });
  await second.actions.start(INVITE);
  second.actions.choose({ kind: "existing", memberId: UNCLAIMED });
  const creating = second.actions.confirm();
  second.actions.listChanged(known({ workspaceId: OTHER_WORKSPACE }), listed());
  create.resolve(CREATED);
  expect(await creating).toBe(false);
  expect(second.calls.map((call) => call.name)).toEqual(["create"]);
  expect(second.last()).toEqual(IDLE_JOIN_REQUEST_ACTIONS);
  expect(JSON.stringify(second.views)).not.toContain(CODE);
  // Its workspace says so once it is shown again, and only it.
  second.actions.listChanged(known(), listed());
  expect(second.last().message).toBe(INVITE_INSTEAD_MESSAGES.unseen);
  expect(INVITE_INSTEAD_MESSAGES.unseen).toBe(
    "An invitation was created, but its code could not be shown, and the request was not denied. Invite the person again for a new code.",
  );

  // A sign-out during the create: nothing, also after a new sign-in.
  const lost = pending<CreateInvitationResult>();
  const third = controllerWith({ create: lost.answer });
  await third.actions.start(INVITE);
  third.actions.choose({ kind: "existing", memberId: UNCLAIMED });
  const signedOut = third.actions.confirm();
  third.actions.listChanged(
    known({ status: "signed_out", workspaceId: null }),
    listed(),
  );
  lost.resolve(CREATED);
  expect(await signedOut).toBe(false);
  third.actions.listChanged(known(), listed());
  expect(third.last()).toEqual(IDLE_JOIN_REQUEST_ACTIONS);
  expect(JSON.stringify(third.views)).not.toContain(CODE);

  // A switch during the denial drops the code and the sentence.
  const deny = pending<JoinRequestActionResult>();
  const fourth = controllerWith({
    create: () => Promise.resolve(CREATED),
    deny: deny.answer,
  });
  await fourth.actions.start(INVITE);
  fourth.actions.choose({ kind: "existing", memberId: UNCLAIMED });
  const denying = fourth.actions.confirm();
  await settle();
  expect(fourth.last().code?.code).toBe(CODE);
  fourth.actions.listChanged(known({ workspaceId: OTHER_WORKSPACE }), listed());
  expect(fourth.last().code).toBeUndefined();
  deny.resolve({ outcome: "ok" });
  expect(await denying).toBe(false);
  expect(fourth.last()).toEqual(IDLE_JOIN_REQUEST_ACTIONS);
});

test("Deny and invite instead's question ends when the chosen person is no longer an unclaimed person", async () => {
  const { actions, calls, last } = controllerWith({});
  await actions.start(INVITE);
  actions.choose({ kind: "existing", memberId: UNCLAIMED });
  // A rename keeps the choice; the person is still offered.
  actions.listChanged(
    known({
      people: READY.people.map((one) =>
        one.memberId === UNCLAIMED ? { ...one, displayName: "Maggie" } : one,
      ),
    }),
    listed(),
  );
  expect(last().dialog?.choice).toEqual({
    kind: "existing",
    memberId: UNCLAIMED,
  });
  // A claim ends the question.
  actions.listChanged(
    known({
      people: READY.people.map((one) =>
        one.memberId === UNCLAIMED
          ? { ...one, claimed: true, login: "mhamilton" }
          : one,
      ),
    }),
    listed(),
  );
  expect(last().dialog).toBeUndefined();
  expect(await actions.confirm()).toBe(false);
  expect(calls).toEqual([]);
});

test("the lists never change from an answer: the controller holds no requests", async () => {
  const { actions, views } = controllerWith({ deny: OK });
  await actions.start(DENY);
  await actions.confirm();
  for (const view of views) {
    expect(Object.keys(view).sort()).toEqual([
      "code",
      "dialog",
      "message",
      "running",
    ]);
  }
});
