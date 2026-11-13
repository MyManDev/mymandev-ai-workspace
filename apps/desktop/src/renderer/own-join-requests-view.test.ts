import { expect, test } from "vitest";
import type {
  OwnJoinRequestActionsBridge,
  OwnJoinRequestsBridge,
} from "../shared/desktop-bridge.ts";
import {
  OWN_JOIN_REQUEST_ACTION_REFUSALS,
  OWN_JOIN_REQUEST_OUTCOMES,
  ProtocolIdSchema,
  WORKSPACE_PROBLEMS,
  type AccountStatus,
  type CreateJoinRequestResult,
  type OwnJoinRequestActionRefusal,
  type OwnJoinRequestLoadResult,
  type OwnJoinRequestView,
  type OwnJoinRequestsView,
  type WithdrawJoinRequestResult,
  type WorkspaceView,
} from "../shared/ipc-contract.ts";
import type { AccountView } from "./account-view.ts";
import {
  accountDisplayName,
  createOwnJoinRequestActions,
  describeCreateResult,
  describeOwnJoinRequests,
  describeWithdrawResult,
  followOwnJoinRequests,
  IDLE_OWN_JOIN_REQUEST_ACTIONS,
  initialOwnJoinRequestsScreenView,
  isWithdrawalOffered,
  JOIN_REQUEST_FORM_MESSAGES,
  JOIN_REQUEST_POLICY_LIMITS,
  OWN_JOIN_REQUEST_DONE_MESSAGES,
  OWN_JOIN_REQUEST_MESSAGES,
  OWN_JOIN_REQUEST_NOT_DONE_MESSAGES,
  OWN_JOIN_REQUEST_OUTCOME_LABELS,
  OWN_JOIN_REQUEST_PROBLEM_MESSAGES,
  OWN_JOIN_REQUEST_REFRESH_MESSAGES,
  OWN_JOIN_REQUEST_REFUSAL_MESSAGES,
  OWN_JOIN_REQUEST_UNKNOWN_MESSAGES,
  WITHDRAW_QUESTION,
  withdrawOutcome,
  WORKSPACE_ID_PATTERN,
  workspaceIdProblem,
  workspaceIdToSend,
  type OwnJoinRequestActionsView,
  type OwnJoinRequestsScreenView,
  type WithdrawRequest,
} from "./own-join-requests-view.ts";
import {
  MAX_PERSON_NAME_LENGTH,
  PEOPLE_ACTION_MESSAGES,
  PEOPLE_ACTION_NOT_SENT,
} from "./people-actions-view.ts";
import type { WorkspacePanelView } from "./workspace-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OTHER_WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4";
const REQUEST = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d1";
const SECOND_REQUEST = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d2";
const NEW_REQUEST = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d3";
const DEVICE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e1";
const OTHER_DEVICE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e2";

const SIGNED_IN: AccountStatus = {
  revision: 3,
  account: {
    kind: "signed_in",
    login: "octocat",
    displayName: "The Octocat",
    deviceId: DEVICE,
    signInExpiresAt: "2026-12-09T10:00:00.000Z",
  },
  signIn: { kind: "idle" },
  lastOutcome: null,
  deviceKey: "ready",
  replacementPending: false,
  apiOrigin: "set",
  device: "signed_in",
};

function account(overrides: Partial<AccountStatus> = {}): AccountView {
  return { kind: "known", status: { ...SIGNED_IN, ...overrides } };
}

/** The status of the same account with another display name, device, or login. */
function signedIn(
  changes: Partial<{ login: string; displayName: string; deviceId: string }>,
): AccountView {
  return account({
    account: {
      kind: "signed_in",
      login: "octocat",
      displayName: "The Octocat",
      deviceId: DEVICE,
      signInExpiresAt: "2026-12-09T10:00:00.000Z",
      ...changes,
    },
  });
}

const SIGNED_OUT = account({
  account: { kind: "hidden" },
  device: "signed_out",
});

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

const READY: OwnJoinRequestsView = {
  revision: 5,
  status: "ready",
  requests: [
    request(REQUEST),
    request(SECOND_REQUEST, {
      workspaceId: OTHER_WORKSPACE,
      requestedName: "Kathy",
      decision: "denied",
      decidedAt: "2026-11-10T10:00:00.000Z",
    }),
  ],
};

function listed(
  overrides: Partial<OwnJoinRequestsView> = {},
): OwnJoinRequestsScreenView {
  return {
    kind: "known",
    state: { ...READY, ...overrides } as OwnJoinRequestsView,
  };
}

function workspaces(
  overrides: Partial<WorkspaceView> = {},
): WorkspacePanelView {
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

const WITHDRAW: WithdrawRequest = {
  joinRequestId: REQUEST,
  workspaceId: WORKSPACE,
  requestedName: "Katherine",
};

interface Answers {
  readonly create?: () => Promise<CreateJoinRequestResult>;
  readonly withdraw?: () => Promise<WithdrawJoinRequestResult>;
  readonly load?: () => Promise<OwnJoinRequestLoadResult>;
}

interface Call {
  readonly name: string;
  readonly args: unknown[];
}

const NOT_CALLED = () => Promise.reject(new Error("not expected"));

/** A controller over fake bridges that has seen `status` and `list`. */
function controllerWith(
  answers: Answers,
  status: AccountView = account(),
  list: OwnJoinRequestsScreenView = listed(),
) {
  const calls: Call[] = [];
  const record =
    <T>(name: string, answer: () => Promise<T>) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return answer();
    };
  const views: OwnJoinRequestActionsView[] = [];
  const actions = createOwnJoinRequestActions(
    {
      ownJoinRequestActions: {
        create: record("create", answers.create ?? NOT_CALLED),
        withdraw: record("withdraw", answers.withdraw ?? NOT_CALLED),
      } as unknown as Pick<OwnJoinRequestActionsBridge, "create" | "withdraw">,
      ownJoinRequests: {
        load: record("load", answers.load ?? NOT_CALLED),
      } as unknown as Pick<OwnJoinRequestsBridge, "load">,
    },
    (view) => views.push(view),
  );
  actions.accountChanged(status);
  actions.listChanged(list);
  const last = () => views.at(-1) ?? IDLE_OWN_JOIN_REQUEST_ACTIONS;
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

/** The pending request that a create of `name` for WORKSPACE answers. */
function created(
  name = "Katherine",
  joinRequestId = NEW_REQUEST,
): CreateJoinRequestResult {
  return {
    outcome: "ok",
    joinRequestId,
    workspaceId: WORKSPACE,
    requestedName: name,
    createdAt: "2026-11-13T09:00:00.000Z",
    expiresAt: "2026-11-20T09:00:00.000Z",
  };
}

function refused(
  reason: OwnJoinRequestActionRefusal,
  retryAfterMs: number | null = null,
): CreateJoinRequestResult & WithdrawJoinRequestResult {
  return { outcome: "refused", reason, retryAfterMs } as never;
}

test("the screen starts unavailable without the bridge and pending with it", () => {
  expect(initialOwnJoinRequestsScreenView(false)).toEqual({
    kind: "unavailable",
  });
  expect(initialOwnJoinRequestsScreenView(true)).toEqual({ kind: "pending" });
});

test("following the own join requests reports each state, asks the main process to load them once as the screen opens, and ends the subscription", async () => {
  const views: OwnJoinRequestsScreenView[] = [];
  let listener: ((state: OwnJoinRequestsView) => void) | undefined;
  let onError: (() => void) | undefined;
  let loads = 0;
  let stopped = 0;
  const stop = followOwnJoinRequests(
    {
      subscribeState: (next, error) => {
        listener = next;
        onError = error;
        return () => {
          stopped += 1;
        };
      },
      // A refused load shows only in the state, and a rejected one nowhere.
      load: () => {
        loads += 1;
        return Promise.reject(new Error("refused"));
      },
    },
    (view) => views.push(view),
  );
  await settle();
  expect(loads).toBe(1);
  listener?.(READY);
  onError?.();
  expect(views).toEqual([
    { kind: "known", state: READY },
    { kind: "unavailable" },
  ]);
  stop();
  expect(stopped).toBe(1);
  expect(loads).toBe(1);
});

test("each state of the own join requests has its own fixed text, with what was loaded before when a load fails", () => {
  const none = workspaces();
  const status = (view: OwnJoinRequestsScreenView) =>
    describeOwnJoinRequests(view, none).status;
  expect(status({ kind: "unavailable" })).toBe(
    "Your join requests are not available.",
  );
  expect(status({ kind: "pending" })).toBe("Checking your join requests.");
  expect(status(listed({ status: "signed_out", requests: [] }))).toBe(
    "Your join requests appear once this device is signed in and ready.",
  );
  expect(status(listed({ status: "loading", requests: [] }))).toBe(
    "Loading your join requests.",
  );
  expect(status(listed({ requests: [] }))).toBe(
    "You have not asked to join a workspace.",
  );
  expect(status(listed())).toBe("");
  for (const problem of WORKSPACE_PROBLEMS) {
    const failed = describeOwnJoinRequests(
      listed({ status: "unavailable", problem } as never),
      none,
    );
    expect(failed.status).toBe(OWN_JOIN_REQUEST_PROBLEM_MESSAGES[problem]);
    // What was loaded before stays.
    expect(failed.pending.map((row) => row.joinRequestId)).toEqual([REQUEST]);
    expect(failed.ended.map((row) => row.joinRequestId)).toEqual([
      SECOND_REQUEST,
    ]);
  }
  expect(OWN_JOIN_REQUEST_PROBLEM_MESSAGES).toEqual({
    not_signed_in: "The server did not accept this device's sign-in.",
    not_found: "Your join requests could not be loaded. Trying again later.",
    rate_limited: "The server asked to wait. Trying again in a minute.",
    unavailable: "The server could not be reached. Trying again later.",
    failed: "Your join requests could not be loaded. Trying again later.",
  });
  // No list while it is not loaded.
  for (const view of [
    { kind: "unavailable" } as const,
    { kind: "pending" } as const,
    listed({ status: "signed_out" }),
    listed({ status: "loading" }),
  ]) {
    const model = describeOwnJoinRequests(view, none);
    expect(model.pending).toEqual([]);
    expect(model.ended).toEqual([]);
  }
});

test("the pending requests come first with Withdraw, then the ended ones with how and when, each group in the main process's order", () => {
  const requests = [
    request(NEW_REQUEST, { requestedName: "Kate" }),
    request(SECOND_REQUEST, {
      decision: "expired",
      decidedAt: "2026-11-18T09:00:00.000Z",
    }),
    request(REQUEST, { workspaceId: OTHER_WORKSPACE }),
    ...OWN_JOIN_REQUEST_OUTCOMES.map((decision, index) =>
      request(`0192f2a0-7c3e-7a1b-8c4d-5e6f70819${String(300 + index)}`, {
        decision,
        decidedAt: "2026-11-12T10:00:00.000Z",
      }),
    ),
  ];
  const model = describeOwnJoinRequests(listed({ requests }), workspaces());
  expect(model.pending).toEqual([
    {
      joinRequestId: NEW_REQUEST,
      workspaceId: WORKSPACE,
      workspaceName: undefined,
      requestedName: "Kate",
      createdAt: "2026-11-11T09:00:00.000Z",
      expiresAt: "2026-11-18T09:00:00.000Z",
      outcome: null,
      decidedAt: null,
      withdraw: {
        joinRequestId: NEW_REQUEST,
        workspaceId: WORKSPACE,
        requestedName: "Kate",
      },
    },
    expect.objectContaining({
      joinRequestId: REQUEST,
      workspaceId: OTHER_WORKSPACE,
      withdraw: {
        joinRequestId: REQUEST,
        workspaceId: OTHER_WORKSPACE,
        requestedName: "Katherine",
      },
    }),
  ]);
  expect(
    model.ended.map((row) => [row.outcome, row.decidedAt, row.withdraw]),
  ).toEqual([
    ["expired", "2026-11-18T09:00:00.000Z", null],
    ["approved", "2026-11-12T10:00:00.000Z", null],
    ["denied", "2026-11-12T10:00:00.000Z", null],
    ["withdrawn", "2026-11-12T10:00:00.000Z", null],
    ["expired", "2026-11-12T10:00:00.000Z", null],
  ]);
  // Every outcome of the main process has its own label, an expired
  // request too (the Project Manager's decision of 2026-11-12).
  expect(OWN_JOIN_REQUEST_OUTCOME_LABELS).toEqual({
    approved: "Approved ",
    denied: "Denied ",
    withdrawn: "Withdrawn ",
    expired: "Expired ",
  });
  expect(Object.keys(OWN_JOIN_REQUEST_OUTCOME_LABELS).sort()).toEqual(
    [...OWN_JOIN_REQUEST_OUTCOMES].sort(),
  );
});

test("a request shows its workspace's name once the account's workspace list holds it, never while signed out", () => {
  const list = listed();
  const holding = workspaces({
    workspaces: [
      { id: OTHER_WORKSPACE, name: "Team" },
      { id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a9", name: "Other" },
    ],
  });
  const model = describeOwnJoinRequests(list, holding);
  expect(model.pending[0]?.workspaceName).toBeUndefined();
  expect(model.ended[0]?.workspaceName).toBe("Team");
  for (const view of [
    workspaces({
      status: "signed_out",
      workspaces: [{ id: OTHER_WORKSPACE, name: "Team" }],
    }),
    { kind: "pending" } as const,
    { kind: "unavailable" } as const,
  ]) {
    expect(describeOwnJoinRequests(list, view).ended[0]?.workspaceName).toBe(
      undefined,
    );
  }
});

test("the screen's workspace ID check is the contract's ID check", () => {
  const samples = [
    WORKSPACE,
    "0192f2a0-7c3e-7a1b-9c4d-5e6f708192a3",
    "0192f2a0-7c3e-7a1b-ac4d-5e6f708192a3",
    "0192f2a0-7c3e-7a1b-bc4d-5e6f708192a3",
    // Capitals, another version, another variant, other lengths, other
    // characters, and braces.
    WORKSPACE.toUpperCase(),
    "0192f2a0-7c3e-4a1b-8c4d-5e6f708192a3",
    "0192f2a0-7c3e-7a1b-cc4d-5e6f708192a3",
    "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a",
    `${WORKSPACE}0`,
    "0192f2a07c3e7a1b8c4d5e6f708192a3",
    "0192f2a0-7c3e-7a1b-8c4d-5e6f708192g3",
    `{${WORKSPACE}}`,
    "",
  ];
  for (const sample of samples) {
    expect(WORKSPACE_ID_PATTERN.test(sample), sample).toBe(
      ProtocolIdSchema.safeParse(sample).success,
    );
  }
  expect(
    samples.filter((sample) => WORKSPACE_ID_PATTERN.test(sample)),
  ).toHaveLength(4);
});

test("a pasted workspace ID is trimmed at its ends only and written small, and a text that is not an ID is never sent", () => {
  for (const text of [
    WORKSPACE,
    `${WORKSPACE}\n`,
    `  ${WORKSPACE}\t`,
    `\u200b\u2060\ufeff${WORKSPACE}\u200e\u200f\u0085`,
    WORKSPACE.toUpperCase(),
    ` ${WORKSPACE.toUpperCase()} `,
  ]) {
    expect(workspaceIdToSend(text), JSON.stringify(text)).toBe(WORKSPACE);
    expect(workspaceIdProblem(text)).toBeUndefined();
  }
  for (const text of [
    `${WORKSPACE.slice(0, 10)}\u200b${WORKSPACE.slice(10)}`,
    `${WORKSPACE.slice(0, 10)} ${WORKSPACE.slice(11)}`,
    // Full-width digits and a Kelvin sign look like an ID, but are none.
    `\uff10${WORKSPACE.slice(1)}`,
    `${WORKSPACE.slice(0, 35)}\u212a`,
    "0192F2A0-7C3E-4A1B-8C4D-5E6F708192A3",
    "not an ID",
    `${WORKSPACE} ${WORKSPACE}`,
    WORKSPACE.repeat(100_000),
  ]) {
    expect(workspaceIdToSend(text), JSON.stringify(text)).toBeUndefined();
    expect(workspaceIdProblem(text)).toBe(
      "This is not a workspace ID. Check that you pasted all of the ID that a member of the workspace gave you.",
    );
  }
  for (const text of ["", " \n", "\u200b\ufeff"]) {
    expect(workspaceIdToSend(text)).toBeUndefined();
    expect(workspaceIdProblem(text)).toBe("Paste the ID of the workspace.");
  }
});

test("the name field starts with the account's display name while the status names a signed-in account", () => {
  expect(accountDisplayName(account())).toBe("The Octocat");
  expect(accountDisplayName(SIGNED_OUT)).toBeUndefined();
  expect(
    accountDisplayName(account({ account: { kind: "signed_out" } })),
  ).toBeUndefined();
  expect(accountDisplayName({ kind: "pending" })).toBeUndefined();
  expect(accountDisplayName({ kind: "unavailable" })).toBeUndefined();
  // A device whose sign-in the server no longer accepts keeps its account.
  expect(accountDisplayName(account({ device: "sign_in_required" }))).toBe(
    "The Octocat",
  );
});

test("the name follows the account's display name until the person edits it, and the edit stays", () => {
  const { actions, last } = controllerWith({}, { kind: "pending" });
  expect(last().name).toBe("");
  actions.accountChanged(account());
  expect(last().name).toBe("The Octocat");
  actions.accountChanged(signedIn({ displayName: "Octo" }));
  expect(last().name).toBe("Octo");
  actions.editName("Katherine");
  expect(last().name).toBe("Katherine");
  actions.accountChanged(signedIn({ displayName: "The Octocat" }));
  expect(last().name).toBe("Katherine");
  // An emptied field stays empty: the person edited it.
  actions.editName("");
  actions.accountChanged(signedIn({ displayName: "Octo" }));
  expect(last().name).toBe("");
});

test("a request checks the ID and the name first, in characters (code points), and sends nothing with a problem", async () => {
  const { actions, calls, last } = controllerWith({});
  await actions.submit();
  expect(last().workspaceProblem).toBe("Paste the ID of the workspace.");
  expect(last().nameProblem).toBeUndefined();
  actions.editWorkspaceId("not an ID");
  expect(last().workspaceProblem).toBeUndefined();
  actions.editName("   ");
  await actions.submit();
  expect(last().workspaceProblem).toBe(JOIN_REQUEST_FORM_MESSAGES.notAnId);
  expect(last().nameProblem).toBe(PEOPLE_ACTION_MESSAGES.nameMissing);
  expect(last().nameProblem).toBe("Enter a name.");
  // Editing a field ends its own problem only.
  actions.editName("x".repeat(MAX_PERSON_NAME_LENGTH + 1));
  expect(last().nameProblem).toBeUndefined();
  expect(last().workspaceProblem).toBe(JOIN_REQUEST_FORM_MESSAGES.notAnId);
  actions.editWorkspaceId(WORKSPACE);
  await actions.submit();
  expect(last().workspaceProblem).toBeUndefined();
  expect(last().nameProblem).toBe("A name has at most 64 characters.");
  // 65 emoji are 65 characters, too many.
  actions.editName("\u{1F600}".repeat(MAX_PERSON_NAME_LENGTH + 1));
  await actions.submit();
  expect(last().nameProblem).toBe("A name has at most 64 characters.");
  expect(calls).toEqual([]);
  expect(last().running).toBe(false);
  expect(last().formMessage).toBeUndefined();
});

test("a request sends the trimmed, lowercase ID and the trimmed name once; a confirmed one empties the ID and gives the name field the account's name again", async () => {
  const answer = pending<CreateJoinRequestResult>();
  const { actions, calls, last } = controllerWith({ create: answer.answer });
  actions.editWorkspaceId(` ${WORKSPACE.toUpperCase()}\n`);
  actions.editName(
    "  \u{1F600}".padEnd(2 + 2 * MAX_PERSON_NAME_LENGTH, "\u{1F600}"),
  );
  const sent = "\u{1F600}".repeat(MAX_PERSON_NAME_LENGTH);
  const done = actions.submit();
  expect(last().running).toBe(true);
  expect(calls).toEqual([{ name: "create", args: [WORKSPACE, sent] }]);
  answer.resolve(created(sent));
  await done;
  expect(last()).toEqual({
    ...IDLE_OWN_JOIN_REQUEST_ACTIONS,
    name: "The Octocat",
    formMessage:
      "Your request to join was sent. The owner and the admins of the workspace decide on it; it shows under Your join requests.",
  });
  expect(calls).toHaveLength(1);
});

test("the account's display name is sent as the name while the field is not edited", async () => {
  const { actions, calls } = controllerWith({
    create: () => Promise.resolve(created("The Octocat")),
  });
  actions.editWorkspaceId(WORKSPACE);
  await actions.submit();
  expect(calls).toEqual([{ name: "create", args: [WORKSPACE, "The Octocat"] }]);
});

test("an answer with the account's pending request for the workspace says that no new one was made", () => {
  const none = new Set<string>();
  expect(describeCreateResult(created("Katherine"), "Katherine", none)).toBe(
    OWN_JOIN_REQUEST_DONE_MESSAGES.create,
  );
  // Another name: the pending request kept the one it was sent with.
  expect(describeCreateResult(created("Kathy"), "Katherine", none)).toBe(
    "You already have a pending request for this workspace, so no new one was made. It shows under Your join requests, with the name it was sent with.",
  );
  // The same name, but the list already held that request as pending.
  expect(
    describeCreateResult(
      created("Katherine", REQUEST),
      "Katherine",
      new Set([REQUEST]),
    ),
  ).toBe(OWN_JOIN_REQUEST_DONE_MESSAGES.createPending);
});

test("the controller tells a pending request that the list held before the create", async () => {
  const { actions, last } = controllerWith({
    create: () => Promise.resolve(created("Katherine", REQUEST)),
  });
  actions.editWorkspaceId(WORKSPACE);
  actions.editName("Katherine");
  await actions.submit();
  expect(last().formMessage).toBe(OWN_JOIN_REQUEST_DONE_MESSAGES.createPending);
});

test("every result of a create has its fixed sentence, a refusal that a create never gets says that the server refused it, and the fields stay", async () => {
  const sentence = (result: CreateJoinRequestResult) =>
    describeCreateResult(result, "Katherine", new Set());
  const start = "No request to join was made.";
  expect(sentence({ outcome: "unknown" })).toBe(
    "It is not known whether your request to join was made. Check your join requests; the request is not sent again on its own. Asking again does not make a second request while one is pending.",
  );
  const expected: Record<OwnJoinRequestActionRefusal, string> = {
    invalid:
      "The name is not allowed. Use visible characters, without line breaks.",
    not_signed_in:
      "This device is not signed in, or the server did not accept its sign-in. Sign in on the Account screen, then try again.",
    unavailable:
      "This device cannot send it now. Wait until the sign-in or the current change of the account is finished, then try again.",
    too_soon:
      "This device sent many requests in a short time. Try again in 3 seconds.",
    rate_limited:
      "The server asked to wait. Join requests have limits: an account can have at most 5 pending requests and make 10 in 24 hours, a workspace takes at most 50 pending requests, and after a denial the same workspace can be asked again after 24 hours. Try again in 3 hours.",
    already_member:
      "You are already a member of this workspace. It is in your list of workspaces.",
    workspace_not_found:
      "No workspace has this ID, or the workspace was archived. Check the ID with the person who gave it to you.",
    join_requests_closed:
      "The workspace does not take your request: it has paused new requests, or it has blocked your account. Ask its owner or an admin.",
    // A create never gets these; the main process maps unknown codes to
    // `failed`, and so does the screen.
    not_found: "The server refused it.",
    conflict: "The server refused it.",
    failed: "The server refused it.",
  };
  const waits: Partial<Record<OwnJoinRequestActionRefusal, number>> = {
    too_soon: 2_500,
    rate_limited: 3 * 60 * 60 * 1000,
  };
  for (const reason of OWN_JOIN_REQUEST_ACTION_REFUSALS) {
    expect(sentence(refused(reason, waits[reason] ?? null)), reason).toBe(
      `${start} ${expected[reason]}`,
    );
  }
  expect(Object.keys(expected).sort()).toEqual(
    [...OWN_JOIN_REQUEST_ACTION_REFUSALS].sort(),
  );
  // In the controller: a refusal, an unknown answer, and a call that fails
  // keep both fields as they were.
  for (const answer of [
    () => Promise.resolve(refused("workspace_not_found")),
    () => Promise.resolve<CreateJoinRequestResult>({ outcome: "unknown" }),
    () => Promise.reject(new Error("lost")),
  ]) {
    const { actions, last } = controllerWith({ create: answer });
    actions.editWorkspaceId(WORKSPACE);
    actions.editName("Katherine");
    await actions.submit();
    expect(last().workspaceId).toBe(WORKSPACE);
    expect(last().name).toBe("Katherine");
    expect(last().running).toBe(false);
  }
  const { actions, last } = controllerWith({
    create: () => Promise.reject(new Error("lost")),
  });
  actions.editWorkspaceId(WORKSPACE);
  await actions.submit();
  expect(last().formMessage).toBe(`${start} ${PEOPLE_ACTION_NOT_SENT}`);
  expect(last().formMessage).toBe(
    "No request to join was made. It was not sent. Try again.",
  );
});

test("every result of a withdrawal has its fixed sentence, and a refusal that a withdrawal never gets says that the server refused it", () => {
  const start = "The request could not be withdrawn.";
  expect(describeWithdrawResult({ outcome: "ok" })).toBe(
    "The request was withdrawn.",
  );
  expect(describeWithdrawResult({ outcome: "unknown" })).toBe(
    "It is not known whether the request was withdrawn. Check your join requests; the request is not sent again on its own.",
  );
  const expected: Record<OwnJoinRequestActionRefusal, string> = {
    invalid: "The request was not valid.",
    not_signed_in: OWN_JOIN_REQUEST_REFUSAL_MESSAGES.not_signed_in,
    unavailable: OWN_JOIN_REQUEST_REFUSAL_MESSAGES.unavailable,
    too_soon:
      "This device sent many requests in a short time. Try again in 1 second.",
    rate_limited: "The server asked to wait. Try again in 2 minutes.",
    not_found:
      "The server does not know this request for your account. Check your join requests.",
    conflict:
      "The request is no longer pending: it was decided, or it ended. Check your join requests.",
    failed: "The server refused it.",
    already_member: "The server refused it.",
    workspace_not_found: "The server refused it.",
    join_requests_closed: "The server refused it.",
  };
  const waits: Partial<Record<OwnJoinRequestActionRefusal, number>> = {
    too_soon: 400,
    rate_limited: 90_000,
  };
  for (const reason of OWN_JOIN_REQUEST_ACTION_REFUSALS) {
    expect(
      describeWithdrawResult(refused(reason, waits[reason] ?? null)),
      reason,
    ).toBe(`${start} ${expected[reason]}`);
  }
  expect(OWN_JOIN_REQUEST_NOT_DONE_MESSAGES).toEqual({
    create: "No request to join was made.",
    withdraw: start,
  });
  expect(OWN_JOIN_REQUEST_UNKNOWN_MESSAGES.withdraw).toBe(
    describeWithdrawResult({ outcome: "unknown" }),
  );
});

test("a withdrawal asks first and sends nothing until confirmed, then once, and resolves to withdrawn once confirmed, because its button leaves the pending requests", async () => {
  const answer = pending<WithdrawJoinRequestResult>();
  const { actions, calls, last } = controllerWith({ withdraw: answer.answer });
  actions.startWithdraw(WITHDRAW);
  expect(last().withdrawal).toEqual(WITHDRAW);
  expect(calls).toEqual([]);
  const done = actions.confirmWithdraw();
  // The question closes as the request goes, so the dialog gives the focus
  // back to Withdraw until the answer.
  expect(last().withdrawal).toBeUndefined();
  expect(last().running).toBe(true);
  expect(calls).toEqual([{ name: "withdraw", args: [REQUEST] }]);
  answer.resolve({ outcome: "ok" });
  expect(await done).toBe("withdrawn");
  expect(last().listMessage).toBe("The request was withdrawn.");
  expect(last().formMessage).toBeUndefined();
  expect(last().running).toBe(false);
  // Confirming again sends nothing: the question is gone.
  expect(await actions.confirmWithdraw()).toBe("none");
  expect(calls).toHaveLength(1);
  expect(WITHDRAW_QUESTION).toEqual({
    title: "Withdraw this request?",
    text: "The request ends, and the owner and the admins of the workspace can no longer approve it. You can ask again with the workspace ID, but a new request is refused while the workspace pauses new requests, and it counts toward the 10 requests that an account can make in 24 hours.",
    confirm: "Withdraw",
  });
});

test("cancelling the question sends nothing, also on a later confirmation", async () => {
  const { actions, calls, last } = controllerWith({});
  actions.startWithdraw(WITHDRAW);
  // A cancel says that it closed a question; the close of a dialog whose
  // question had already ended, which calls it again, does not.
  expect(actions.cancelWithdraw()).toBe(true);
  expect(last().withdrawal).toBeUndefined();
  expect(actions.cancelWithdraw()).toBe(false);
  expect(await actions.confirmWithdraw()).toBe("none");
  expect(calls).toEqual([]);
});

test("a withdrawal that is refused, uncertain, or fails on its way says so and resolves to whether its row may still leave with the reloaded list; an unknown answer is never sent again", async () => {
  for (const [answer, sentence, outcome] of [
    [
      () => Promise.resolve(refused("conflict")),
      `${OWN_JOIN_REQUEST_NOT_DONE_MESSAGES.withdraw} ${OWN_JOIN_REQUEST_REFUSAL_MESSAGES.conflict}`,
      "may_leave",
    ],
    [
      () => Promise.resolve<WithdrawJoinRequestResult>({ outcome: "unknown" }),
      OWN_JOIN_REQUEST_UNKNOWN_MESSAGES.withdraw,
      "may_leave",
    ],
    [
      () => Promise.reject(new Error("lost")),
      "The request could not be withdrawn. It was not sent. Try again.",
      "stays",
    ],
  ] as const) {
    const { actions, calls, last } = controllerWith({ withdraw: answer });
    actions.startWithdraw(WITHDRAW);
    expect(await actions.confirmWithdraw()).toBe(outcome);
    await settle();
    expect(last().listMessage).toBe(sentence);
    expect(calls).toHaveLength(1);
  }
});

test("only a pending request that the latest list holds as it was asked can be withdrawn, and the question ends once its request ends", async () => {
  expect(isWithdrawalOffered(listed(), WITHDRAW)).toBe(true);
  expect(
    isWithdrawalOffered(
      listed({ status: "unavailable", problem: "failed" } as never),
      WITHDRAW,
    ),
  ).toBe(true);
  for (const [view, why] of [
    [{ kind: "pending" }, "no state"],
    [{ kind: "unavailable" }, "no subscription"],
    [listed({ status: "loading", requests: [] }), "loading"],
    [listed({ status: "signed_out", requests: [] }), "signed out"],
    [listed({ requests: [] }), "gone"],
    [
      listed({
        requests: [
          request(REQUEST, {
            decision: "expired",
            decidedAt: "2026-11-18T09:00:00.000Z",
          }),
        ],
      }),
      "expired",
    ],
    [
      listed({
        requests: [
          request(REQUEST, {
            decision: "approved",
            decidedAt: "2026-11-12T09:00:00.000Z",
          }),
        ],
      }),
      "approved",
    ],
    [
      listed({ requests: [request(REQUEST, { requestedName: "Kathy" })] }),
      "another name",
    ],
    [
      listed({
        requests: [request(REQUEST, { workspaceId: OTHER_WORKSPACE })],
      }),
      "another workspace",
    ],
  ] as const) {
    expect(isWithdrawalOffered(view, WITHDRAW), why).toBe(false);
  }
  // Not offered: nothing opens.
  const closed = controllerWith({}, account(), listed({ requests: [] }));
  closed.actions.startWithdraw(WITHDRAW);
  expect(closed.last().withdrawal).toBeUndefined();
  // Offered, then ended by the main process's expiry: the question ends,
  // and a later confirmation sends nothing.
  const { actions, calls, last } = controllerWith({});
  actions.startWithdraw(WITHDRAW);
  actions.listChanged(listed({ revision: 6 }));
  expect(last().withdrawal).toEqual(WITHDRAW);
  actions.listChanged(
    listed({
      revision: 7,
      requests: [
        request(REQUEST, {
          decision: "expired",
          decidedAt: "2026-11-18T09:00:00.000Z",
        }),
      ],
    }),
  );
  expect(last().withdrawal).toBeUndefined();
  expect(await actions.confirmWithdraw()).toBe("none");
  expect(calls).toEqual([]);
});

test("one action runs at a time: while one runs, the fields keep their text and nothing else opens, sends, or refreshes", async () => {
  const answer = pending<CreateJoinRequestResult>();
  const { actions, calls, last } = controllerWith({
    create: answer.answer,
    withdraw: () => Promise.resolve({ outcome: "ok" }),
    load: () => Promise.resolve({ outcome: "loading" }),
  });
  actions.editWorkspaceId(WORKSPACE);
  const done = actions.submit();
  actions.editWorkspaceId("changed");
  actions.editName("changed");
  await actions.submit();
  actions.startWithdraw(WITHDRAW);
  await actions.refresh();
  expect(last().workspaceId).toBe(WORKSPACE);
  expect(last().name).toBe("The Octocat");
  expect(last().withdrawal).toBeUndefined();
  expect(calls.map((call) => call.name)).toEqual(["create"]);
  answer.resolve({ outcome: "unknown" });
  await done;
  // An unknown answer is never sent again on its own.
  await settle();
  expect(calls.map((call) => call.name)).toEqual(["create"]);
  // A withdrawal that runs blocks a create in the same way.
  const withdrawal = pending<WithdrawJoinRequestResult>();
  const second = controllerWith({ withdraw: withdrawal.answer });
  second.actions.startWithdraw(WITHDRAW);
  const confirmed = second.actions.confirmWithdraw();
  second.actions.editWorkspaceId(WORKSPACE);
  await second.actions.submit();
  expect(second.calls.map((call) => call.name)).toEqual(["withdraw"]);
  withdrawal.resolve({ outcome: "ok" });
  expect(await confirmed).toBe("withdrawn");
});

test("a new action ends the sentence of the last one, wherever it shows", async () => {
  const { actions, last } = controllerWith({
    create: () => Promise.resolve(refused("join_requests_closed")),
    withdraw: () => Promise.resolve({ outcome: "ok" }),
  });
  actions.editWorkspaceId(WORKSPACE);
  await actions.submit();
  expect(last().formMessage).toContain("No request to join was made.");
  actions.startWithdraw(WITHDRAW);
  // Opening the question keeps it; the withdrawal ends it.
  expect(last().formMessage).toContain("No request to join was made.");
  await actions.confirmWithdraw();
  expect(last().formMessage).toBeUndefined();
  expect(last().listMessage).toBe("The request was withdrawn.");
  await actions.submit();
  expect(last().listMessage).toBeUndefined();
  expect(last().formMessage).toContain("No request to join was made.");
});

test("a sign-out, another account, or another device ends the session: the fields, the question, and the sentence go, and an answer on its way shows nothing", async () => {
  for (const next of [
    SIGNED_OUT,
    account({ account: { kind: "signed_out" }, device: "no_device" }),
    signedIn({ login: "hubot", displayName: "Hubot" }),
    signedIn({ deviceId: OTHER_DEVICE }),
  ]) {
    const answer = pending<CreateJoinRequestResult>();
    const { actions, calls, last } = controllerWith({ create: answer.answer });
    actions.editWorkspaceId(WORKSPACE);
    actions.editName("Katherine");
    const done = actions.submit();
    actions.accountChanged(next);
    expect(last().workspaceId).toBe("");
    expect(last().name).toBe(accountDisplayName(next) ?? "");
    answer.resolve(created());
    await done;
    expect(last().formMessage).toBeUndefined();
    expect(last().running).toBe(false);
    expect(calls).toHaveLength(1);
  }
  // The question, a sentence, and the problems go too.
  const { actions, last } = controllerWith({
    create: () => Promise.resolve(refused("workspace_not_found")),
  });
  actions.editWorkspaceId(WORKSPACE);
  await actions.submit();
  actions.editWorkspaceId("x");
  actions.editName("");
  await actions.submit();
  actions.startWithdraw(WITHDRAW);
  expect(last().withdrawal).toEqual(WITHDRAW);
  expect(last().workspaceProblem).toBeDefined();
  actions.accountChanged(SIGNED_OUT);
  expect(last()).toEqual(IDLE_OWN_JOIN_REQUEST_ACTIONS);
});

test("a withdrawal's answer after a sign-out shows nothing and moves no focus", async () => {
  const answer = pending<WithdrawJoinRequestResult>();
  const { actions, last } = controllerWith({ withdraw: answer.answer });
  actions.startWithdraw(WITHDRAW);
  const done = actions.confirmWithdraw();
  actions.accountChanged(SIGNED_OUT);
  actions.accountChanged(account());
  answer.resolve({ outcome: "ok" });
  expect(await done).toBe("none");
  expect(last().listMessage).toBeUndefined();
});

test("the same account and device keep the session: a first status, a changed name, a refused sign-in, and a sign-in after none end nothing", async () => {
  const answer = pending<CreateJoinRequestResult>();
  const { actions, last } = controllerWith(
    { create: answer.answer },
    { kind: "pending" },
  );
  actions.accountChanged(SIGNED_OUT);
  actions.accountChanged(account());
  actions.editWorkspaceId(WORKSPACE);
  actions.editName("Katherine");
  const done = actions.submit();
  actions.accountChanged(signedIn({ displayName: "Octo" }));
  actions.accountChanged(account({ device: "sign_in_required" }));
  actions.accountChanged({ kind: "unavailable" });
  answer.resolve(refused("not_signed_in"));
  await done;
  expect(last().formMessage).toBe(
    `${OWN_JOIN_REQUEST_NOT_DONE_MESSAGES.create} ${OWN_JOIN_REQUEST_REFUSAL_MESSAGES.not_signed_in}`,
  );
  expect(last().workspaceId).toBe(WORKSPACE);
});

test("refreshing asks the main process to load once, says so until the next state of the own join requests, and says why it was refused", async () => {
  const load = pending<OwnJoinRequestLoadResult>();
  const { actions, calls, last } = controllerWith({ load: load.answer });
  const done = actions.refresh();
  expect(calls).toEqual([{ name: "load", args: [] }]);
  load.resolve({ outcome: "loading" });
  await done;
  expect(last().listMessage).toBe("Loading your join requests again.");
  // The same revision again keeps it; a newer one ends it.
  actions.listChanged(listed());
  expect(last().listMessage).toBe("Loading your join requests again.");
  actions.listChanged(listed({ revision: 6 }));
  expect(last().listMessage).toBeUndefined();
  for (const [answer, sentence] of [
    [
      () =>
        Promise.resolve<OwnJoinRequestLoadResult>({
          outcome: "refused",
          reason: "not_signed_in",
        }),
      "Your join requests appear once this device is signed in.",
    ],
    [
      () =>
        Promise.resolve<OwnJoinRequestLoadResult>({
          outcome: "refused",
          reason: "too_soon",
        }),
      "Your join requests were loaded a moment ago. Try again in a few seconds.",
    ],
    [
      () => Promise.reject(new Error("lost")),
      "Your join requests could not be loaded again. Try again.",
    ],
  ] as const) {
    const refreshed = controllerWith({ load: answer });
    await refreshed.actions.refresh();
    expect(refreshed.last().listMessage).toBe(sentence);
    // A later state does not end a refusal's sentence.
    refreshed.actions.listChanged(listed({ revision: 9 }));
    expect(refreshed.last().listMessage).toBe(sentence);
  }
  expect(OWN_JOIN_REQUEST_REFRESH_MESSAGES.loading).toBe(
    "Loading your join requests again.",
  );
});

test("a refresh before the first state ends its sentence with the first state", async () => {
  const { actions, last } = controllerWith(
    { load: () => Promise.resolve({ outcome: "loading" }) },
    account(),
    { kind: "pending" },
  );
  await actions.refresh();
  expect(last().listMessage).toBe("Loading your join requests again.");
  actions.listChanged(listed({ revision: 0 }));
  expect(last().listMessage).toBeUndefined();
});

test("a refresh's answer after a sign-out, or after an action that started meanwhile, shows nothing", async () => {
  const load = pending<OwnJoinRequestLoadResult>();
  const first = controllerWith({ load: load.answer });
  const done = first.actions.refresh();
  first.actions.accountChanged(SIGNED_OUT);
  load.resolve({ outcome: "loading" });
  await done;
  expect(first.last().listMessage).toBeUndefined();
  const again = pending<OwnJoinRequestLoadResult>();
  const create = pending<CreateJoinRequestResult>();
  const second = controllerWith({ load: again.answer, create: create.answer });
  const refreshed = second.actions.refresh();
  second.actions.editWorkspaceId(WORKSPACE);
  const submitted = second.actions.submit();
  again.resolve({ outcome: "loading" });
  await refreshed;
  expect(second.last().listMessage).toBeUndefined();
  create.resolve(created("The Octocat"));
  await submitted;
  expect(second.last().formMessage).toBe(OWN_JOIN_REQUEST_DONE_MESSAGES.create);
});

test("no sentence, problem, or question text holds what the person typed", async () => {
  const typed = "<b>Katherine</b>";
  const { actions, views } = controllerWith({
    create: () => Promise.resolve(refused("invalid")),
  });
  actions.editWorkspaceId(`${WORKSPACE}x`);
  actions.editName(typed);
  await actions.submit();
  actions.editWorkspaceId(WORKSPACE);
  await actions.submit();
  for (const view of views) {
    for (const text of [
      view.formMessage,
      view.listMessage,
      view.workspaceProblem,
      view.nameProblem,
    ]) {
      expect(text ?? "").not.toContain("Katherine");
      expect(text ?? "").not.toContain(WORKSPACE);
    }
  }
});

test("the texts of the form and the list are fixed", () => {
  expect(JOIN_REQUEST_FORM_MESSAGES.claimHint).toBe(
    "If the workspace already added you as a person, do not ask here: ask its owner or an admin for an invitation code for that person, and join with the code above. A request by ID adds you as a new person.",
  );
  expect(OWN_JOIN_REQUEST_MESSAGES.heading).toBe("Your join requests");
  expect(OWN_JOIN_REQUEST_DONE_MESSAGES.withdraw).toBe(
    "The request was withdrawn.",
  );
});

test("the limits of join requests live in one constant that both the refused request's sentence and the withdrawal's question name", () => {
  expect(JOIN_REQUEST_POLICY_LIMITS).toEqual({
    pendingPerAccount: 5,
    newRequestsPerAccount: 10,
    newRequestWindowHours: 24,
    pendingPerWorkspace: 50,
    hoursAfterDenial: 24,
  });
  // The sentence hedges: the API's own limit of requests per minute also
  // answers rate_limited.
  expect(OWN_JOIN_REQUEST_REFUSAL_MESSAGES.createRateLimited("1 minute")).toBe(
    "The server asked to wait. Join requests have limits: an account can have at most 5 pending requests and make 10 in 24 hours, a workspace takes at most 50 pending requests, and after a denial the same workspace can be asked again after 24 hours. Try again in 1 minute.",
  );
  expect(WITHDRAW_QUESTION.text).toContain(
    "it counts toward the 10 requests that an account can make in 24 hours.",
  );
});

test("a sign-out ends the running state at once, so that the new session can act before the old answer arrives, which then changes nothing (the new answer first)", async () => {
  const old = pending<CreateJoinRequestResult>();
  const next = pending<CreateJoinRequestResult>();
  const answers = [old.answer, next.answer];
  const { actions, calls, last } = controllerWith({
    create: () => (answers.shift() ?? NOT_CALLED)(),
  });
  actions.editWorkspaceId(WORKSPACE);
  const first = actions.submit();
  expect(last().running).toBe(true);
  actions.accountChanged(SIGNED_OUT);
  expect(last().running).toBe(false);
  actions.accountChanged(signedIn({ login: "hubot", displayName: "Hubot" }));
  actions.editWorkspaceId(OTHER_WORKSPACE);
  const second = actions.submit();
  expect(calls.map((call) => call.args)).toEqual([
    [WORKSPACE, "The Octocat"],
    [OTHER_WORKSPACE, "Hubot"],
  ]);
  expect(last().running).toBe(true);
  next.resolve(refused("workspace_not_found"));
  await second;
  expect(last().running).toBe(false);
  expect(last().formMessage).toContain("No workspace has this ID");
  old.resolve(created("The Octocat"));
  await first;
  expect(last().running).toBe(false);
  expect(last().formMessage).toContain("No workspace has this ID");
  expect(last().workspaceId).toBe(OTHER_WORKSPACE);
});

test("an old session's answer that arrives while the new session's action runs neither unlocks it nor shows its sentence (the old answer first)", async () => {
  const old = pending<WithdrawJoinRequestResult>();
  const create = pending<CreateJoinRequestResult>();
  const { actions, last } = controllerWith({
    withdraw: old.answer,
    create: create.answer,
  });
  actions.startWithdraw(WITHDRAW);
  const withdrawn = actions.confirmWithdraw();
  actions.accountChanged(signedIn({ deviceId: OTHER_DEVICE }));
  expect(last().running).toBe(false);
  actions.editWorkspaceId(WORKSPACE);
  const submitted = actions.submit();
  old.resolve({ outcome: "ok" });
  // No focus move for the old withdrawal, and the create still runs.
  expect(await withdrawn).toBe("none");
  expect(last().running).toBe(true);
  expect(last().listMessage).toBeUndefined();
  // While it runs, nothing else starts.
  actions.editWorkspaceId("changed");
  expect(last().workspaceId).toBe(WORKSPACE);
  create.resolve(created("The Octocat"));
  await submitted;
  expect(last().running).toBe(false);
  expect(last().formMessage).toBe(OWN_JOIN_REQUEST_DONE_MESSAGES.create);
});

test("a sign-in after a sign-out keeps the new session: what was typed meanwhile and an answer on its way stay", async () => {
  const answer = pending<CreateJoinRequestResult>();
  const { actions, last } = controllerWith({ create: answer.answer });
  actions.accountChanged(SIGNED_OUT);
  actions.editWorkspaceId(WORKSPACE);
  actions.editName("Katherine");
  const done = actions.submit();
  actions.accountChanged(account());
  expect(last().running).toBe(true);
  answer.resolve(refused("not_signed_in"));
  await done;
  expect(last().formMessage).toBe(
    `${OWN_JOIN_REQUEST_NOT_DONE_MESSAGES.create} ${OWN_JOIN_REQUEST_REFUSAL_MESSAGES.not_signed_in}`,
  );
  expect(last().workspaceId).toBe(WORKSPACE);
  expect(last().name).toBe("Katherine");
});

test("a refresh's answer that arrives after an action started and ended keeps that action's sentence", async () => {
  const load = pending<OwnJoinRequestLoadResult>();
  const { actions, last } = controllerWith({
    load: load.answer,
    create: () => Promise.resolve(refused("join_requests_closed")),
  });
  const refreshed = actions.refresh();
  actions.editWorkspaceId(WORKSPACE);
  await actions.submit();
  expect(last().running).toBe(false);
  const sentence = last().formMessage;
  expect(sentence).toContain("No request to join was made.");
  load.resolve({ outcome: "loading" });
  await refreshed;
  expect(last().formMessage).toBe(sentence);
  expect(last().listMessage).toBeUndefined();
  // A refresh with no action meanwhile shows its sentence.
  const again = pending<OwnJoinRequestLoadResult>();
  const second = controllerWith({ load: again.answer });
  const done = second.actions.refresh();
  again.resolve({ outcome: "loading" });
  await done;
  expect(second.last().listMessage).toBe("Loading your join requests again.");
});

test("an old session's create answer that arrives while the new session's create runs neither unlocks it nor shows its sentence (the old answer first)", async () => {
  const old = pending<CreateJoinRequestResult>();
  const next = pending<CreateJoinRequestResult>();
  const answers = [old.answer, next.answer];
  const { actions, last } = controllerWith({
    create: () => (answers.shift() ?? NOT_CALLED)(),
  });
  actions.editWorkspaceId(WORKSPACE);
  const first = actions.submit();
  actions.accountChanged(signedIn({ login: "hubot", displayName: "Hubot" }));
  actions.editWorkspaceId(OTHER_WORKSPACE);
  const second = actions.submit();
  old.resolve(created("The Octocat"));
  await first;
  expect(last().running).toBe(true);
  expect(last().formMessage).toBeUndefined();
  expect(last().workspaceId).toBe(OTHER_WORKSPACE);
  // Still locked: the field keeps its text, and nothing else is sent.
  actions.editWorkspaceId("changed");
  await actions.submit();
  expect(last().workspaceId).toBe(OTHER_WORKSPACE);
  next.resolve(created("Hubot"));
  await second;
  expect(last().running).toBe(false);
  expect(last().formMessage).toBe(OWN_JOIN_REQUEST_DONE_MESSAGES.create);
  expect(last().workspaceId).toBe("");
});

test("a withdrawal's row may still leave only after the answers after which the main process loads the list again: ok, unknown, not_found, and conflict", () => {
  expect(withdrawOutcome({ outcome: "ok" })).toBe("withdrawn");
  expect(withdrawOutcome({ outcome: "unknown" })).toBe("may_leave");
  expect(withdrawOutcome(undefined)).toBe("stays");
  for (const reason of OWN_JOIN_REQUEST_ACTION_REFUSALS) {
    const waits = reason === "too_soon" || reason === "rate_limited";
    expect(withdrawOutcome(refused(reason, waits ? 1_000 : null)), reason).toBe(
      reason === "not_found" || reason === "conflict" ? "may_leave" : "stays",
    );
  }
});
