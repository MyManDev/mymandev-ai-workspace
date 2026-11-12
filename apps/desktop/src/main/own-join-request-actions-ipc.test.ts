import {
  type JoinRequestId,
  MEMBERSHIP_ROUTE_ERRORS,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import { INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  CreateJoinRequestResultSchema,
  OWN_JOIN_REQUEST_ACTION_REFUSALS,
  OWN_JOIN_REQUEST_LIMITS,
  PEOPLE_LIMITS,
  WithdrawJoinRequestResultSchema,
  type AccountStatus,
} from "../shared/ipc-contract.ts";
import type { AccountService } from "./account.ts";
import {
  WORKSPACE_ACTION_FAILURES,
  type WorkspaceActionFailure,
  type WorkspaceActionName,
  workspaceActionRequest,
  type WorkspaceActionResult,
} from "./api-actions.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import {
  createOwnJoinRequestActions,
  type OwnJoinRequestActions,
  registerOwnJoinRequestActionsIpc,
} from "./own-join-request-actions-ipc.ts";
import type { AuthorizedRequest } from "./session/session.ts";

const DEV_URL = "http://localhost:5173/";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const OTHER_WORKSPACE = id(0xa2) as WorkspaceId;
const REQUEST = id(0xf1) as JoinRequestId;
const USER_ID = id(0xb1);
const DEVICE_ID = id(0xd1);
const AT = "2026-11-05T10:00:00.000Z";
const EXPIRES_AT = "2026-11-12T10:00:00.000Z";
/** The account's display name, from the device record. */
const ACCOUNT_NAME = "Linus Torvalds";

type Answer = WorkspaceActionResult<unknown>;

interface Sent {
  readonly name: WorkspaceActionName;
  readonly params: unknown;
  readonly body: readonly unknown[];
  /** The session's request that the allowlist builds for the call. */
  readonly request: AuthorizedRequest<unknown>;
}

function accountStatus(account: AccountStatus["account"]): AccountStatus {
  return Object.freeze({
    revision: 1,
    account,
    signIn: Object.freeze({ kind: "idle" }),
    lastOutcome: null,
    deviceKey: "ready",
    replacementPending: false,
    apiOrigin: "set",
    device: "signed_in",
  }) as AccountStatus;
}

const SIGNED_IN = accountStatus({
  kind: "signed_in",
  login: "linus",
  displayName: ACCOUNT_NAME,
  deviceId: DEVICE_ID,
  signInExpiresAt: "2026-12-02T10:00:00.000Z",
});

/**
 * The answer of a create: the pending request, with a key that the API
 * might add and that must not cross.
 */
function created(
  workspaceId: WorkspaceId = WORKSPACE,
  requestedDisplayName = "Grace Requester",
): Answer {
  return {
    ok: true,
    value: {
      joinRequest: {
        id: REQUEST,
        workspaceId,
        requestedDisplayName,
        createdAt: AT,
        expiresAt: EXPIRES_AT,
        requesterUserId: USER_ID,
      },
    },
  };
}

/**
 * The account service's `status` and `sendWorkspaceAction`: like the
 * account service, it builds the request with the real allowlist and
 * answers `invalid` without sending anything when the allowlist refuses
 * the call. Otherwise it records the request as sent and answers with
 * `answer`, by default `ok`.
 */
function fakeAccount(
  answer: (name: WorkspaceActionName) => Answer | Promise<Answer> = (name) =>
    name === "createJoinRequest" ? created() : { ok: true, value: null },
  status: AccountStatus = SIGNED_IN,
) {
  const sent: Sent[] = [];
  /** Every call, also one that the allowlist refuses. */
  const calls: WorkspaceActionName[] = [];
  const sendWorkspaceAction = ((
    name: WorkspaceActionName,
    params: unknown,
    ...body: unknown[]
  ) => {
    calls.push(name);
    const request = workspaceActionRequest(name, params, body[0]);
    if (request === null) {
      return Promise.resolve({ ok: false, reason: "invalid" });
    }
    sent.push({ name, params, body, request });
    return Promise.resolve(answer(name));
  }) as AccountService["sendWorkspaceAction"];
  return {
    sent,
    calls,
    account: { status: () => status, sendWorkspaceAction },
  };
}

function failed(reason: WorkspaceActionFailure): Answer {
  return reason === "too_soon" || reason === "rate_limited"
    ? { ok: false, reason, retryAfterMs: 1_500 }
    : { ok: false, reason };
}

/** The own join request service's reloads. */
function fakeService() {
  let reloads = 0;
  return {
    reloads: () => reloads,
    ownJoinRequests: {
      reload: () => {
        reloads += 1;
        return true;
      },
    },
  };
}

function frame(url: string, parent: IpcFrame | null = null): IpcFrame {
  return { url, parent, detached: false, isDestroyed: () => false };
}

function receiver(): StatusReceiver {
  return {
    mainFrame: frame(DEV_URL),
    isDestroyed: () => false,
    send: () => undefined,
    once: () => undefined,
  };
}

function event(senderFrame: IpcFrame | null): IpcInvokeEvent {
  return { senderFrame, sender: receiver() };
}

function register(
  account = fakeAccount(),
  service = fakeService(),
  appUrl: string = DEV_URL,
) {
  const handlers = new Map<string, IpcInvokeListener>();
  const errors: string[] = [];
  registerOwnJoinRequestActionsIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    {
      account: account.account,
      ownJoinRequests: service.ownJoinRequests,
      onError: (message) => errors.push(message),
    },
  );
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`No handler for ${channel}.`);
    }
    return handler(event(frame(appUrl)), ...args) as Promise<unknown>;
  };
  return { handlers, call, errors, account, service };
}

/**
 * Each channel, its action's name on the allowlist, the arguments of a
 * valid call, and the exact route, path parameters, and body that it sends.
 */
const CASES = [
  {
    channel: INVOKE_CHANNELS.createJoinRequest,
    name: "createJoinRequest",
    args: [WORKSPACE, "Grace Requester"],
    path: "/join-requests",
    params: {},
    body: { workspaceId: WORKSPACE, displayName: "Grace Requester" },
  },
  {
    channel: INVOKE_CHANNELS.withdrawJoinRequest,
    name: "withdrawJoinRequest",
    args: [REQUEST],
    path: "/join-requests/:joinRequestId/withdraw",
    params: { joinRequestId: REQUEST },
  },
] as const;

type Case = (typeof CASES)[number];

/** The arguments of `entry` with `value` at `index`. */
function withArgument(entry: Case, index: number, value: unknown): unknown[] {
  return entry.args.map((arg, at) => (at === index ? value : arg));
}

/** The `OwnJoinRequestActions` function of each channel, for direct calls. */
function direct(
  actions: OwnJoinRequestActions,
  channel: Case["channel"],
): (...args: (string | null)[]) => Promise<unknown> {
  return channel === INVOKE_CHANNELS.createJoinRequest
    ? (workspaceId, displayName = null) =>
        actions.create(workspaceId ?? "", displayName)
    : (joinRequestId) => actions.withdraw(joinRequestId ?? "");
}

test("the two own join request action channels are registered, and nothing else", () => {
  const { handlers } = register();
  expect([...handlers.keys()].sort()).toEqual(
    CASES.map((entry) => entry.channel).sort(),
  );
});

test("every handler refuses a foreign sender before anything is sent", () => {
  const account = fakeAccount();
  const { handlers } = register(account, fakeService(), APP_ENTRY_URL);
  for (const entry of CASES) {
    const handler = handlers.get(entry.channel);
    for (const sender of [
      null,
      frame("https://example.invalid/"),
      frame(APP_ENTRY_URL, frame(APP_ENTRY_URL)),
      frame(DEV_URL),
    ]) {
      expect(() => handler?.(event(sender), ...entry.args)).toThrow(
        `The call on ${entry.channel} was refused: the sender is not the application.`,
      );
    }
  }
  expect(account.calls).toEqual([]);
});

test("every handler refuses arguments outside the contract before anything is sent: types, missing and extra arguments, IDs that are not lowercase UUIDv7s, and names out of bounds", () => {
  const account = fakeAccount();
  const { handlers } = register(account);
  const refusedCall = (channel: string, args: readonly unknown[]) => {
    const handler = handlers.get(channel);
    expect(() => handler?.(event(frame(DEV_URL)), ...args), channel).toThrow(
      `The call on ${channel} was refused: the arguments do not match the contract.`,
    );
  };
  const notIds = [
    "",
    "workspace",
    // Version 4, capitals, white space, and a huge string.
    "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b70",
    WORKSPACE.toUpperCase(),
    ` ${WORKSPACE}`,
    `${WORKSPACE}${"0".repeat(10_000)}`,
    1,
    null,
    undefined,
    [WORKSPACE],
    { id: WORKSPACE },
  ];
  for (const entry of CASES) {
    refusedCall(entry.channel, []);
    refusedCall(entry.channel, entry.args.slice(0, -1));
    refusedCall(entry.channel, [...entry.args, REQUEST]);
    refusedCall(entry.channel, [...entry.args, undefined]);
    for (const index of entry.args.keys()) {
      const isName = entry.name === "createJoinRequest" && index === 1;
      const values = isName
        ? [
            "",
            "a".repeat(PEOPLE_LIMITS.displayName + 1),
            "\u{1F600}".repeat(PEOPLE_LIMITS.displayName + 1),
            undefined,
            1,
            { displayName: "Linus" },
          ]
        : notIds;
      for (const value of values) {
        refusedCall(entry.channel, withArgument(entry, index, value));
      }
    }
  }
  expect(account.calls).toEqual([]);
});

test("each action sends exactly its route, path parameters, and body, once", async () => {
  for (const entry of CASES) {
    const account = fakeAccount();
    const { call } = register(account);
    await call(entry.channel, ...entry.args);

    expect(account.sent, entry.channel).toHaveLength(1);
    const [sent] = account.sent;
    expect(sent?.name).toBe(entry.name);
    expect(sent?.params).toEqual(entry.params);
    expect(sent?.body).toEqual("body" in entry ? [entry.body] : []);
    expect(sent?.request).toMatchObject({
      route: { method: "POST", path: entry.path },
      params: entry.params,
    });
    expect(sent?.request?.body).toEqual(
      "body" in entry ? entry.body : undefined,
    );
  }
});

test("a create without a name sends the account's display name, and a name of 64 characters goes as it is", async () => {
  const account = fakeAccount();
  const { call } = register(account);
  await call(INVOKE_CHANNELS.createJoinRequest, WORKSPACE, null);
  expect(account.sent[0]?.request.body).toEqual({
    workspaceId: WORKSPACE,
    displayName: ACCOUNT_NAME,
  });

  const longest = "\u{1F600}".repeat(PEOPLE_LIMITS.displayName);
  await call(INVOKE_CHANNELS.createJoinRequest, WORKSPACE, longest);
  expect(account.sent[1]?.request.body).toEqual({
    workspaceId: WORKSPACE,
    displayName: longest,
  });
});

test("a create without a name while no account is signed in, which would give that name, is not_signed_in, and nothing is sent", async () => {
  for (const shown of [
    { kind: "hidden" } as const,
    { kind: "signed_out" } as const,
  ]) {
    const account = fakeAccount(undefined, accountStatus(shown));
    const service = fakeService();
    const { call } = register(account, service);
    await expect(
      call(INVOKE_CHANNELS.createJoinRequest, WORKSPACE, null),
    ).resolves.toEqual({
      outcome: "refused",
      reason: "not_signed_in",
      retryAfterMs: null,
    });
    expect(account.calls).toEqual([]);
    expect(service.reloads()).toBe(0);
    // A name that the screen gives goes on; the account service answers.
    await call(INVOKE_CHANNELS.createJoinRequest, WORKSPACE, "Grace");
    expect(account.sent).toHaveLength(1);
  }
});

test("the main process checks the IDs again with the protocol's ID schemas, and refuses them as invalid before anything is sent", async () => {
  for (const entry of CASES) {
    for (const [index, arg] of entry.args.entries()) {
      if (entry.name === "createJoinRequest" && index === 1) {
        expect(arg).toBe("Grace Requester");
        continue;
      }
      for (const value of ["not-an-id", REQUEST.toUpperCase(), ""]) {
        const account = fakeAccount();
        const service = fakeService();
        const actions = createOwnJoinRequestActions({
          account: account.account,
          ownJoinRequests: service.ownJoinRequests,
        });
        const call = withArgument(entry, index, value) as (string | null)[];
        await expect(direct(actions, entry.channel)(...call)).resolves.toEqual({
          outcome: "refused",
          reason: "invalid",
          retryAfterMs: null,
        });
        // Refused before the account service is asked.
        expect(account.calls, `${entry.channel} ${index}`).toEqual([]);
        expect(service.reloads()).toBe(0);
      }
    }
  }
});

test("a create's name that the protocol refuses, such as a blank one or one with a line feed, resolves invalid, and nothing is sent", async () => {
  for (const name of ["   ", "a\nb", "\u200b", "a\u202eb"]) {
    const account = fakeAccount();
    const { call } = register(account);
    await expect(
      call(INVOKE_CHANNELS.createJoinRequest, WORKSPACE, name),
    ).resolves.toEqual({
      outcome: "refused",
      reason: "invalid",
      retryAfterMs: null,
    });
    expect(account.sent, JSON.stringify(name)).toEqual([]);
  }
});

function refusedWith(reason: string, retryAfterMs: number | null = null) {
  return { outcome: "refused", reason, retryAfterMs };
}

/** What the screen gets for each failure of a create and a withdrawal. */
const EXPECTED: Readonly<
  Record<
    Case["name"],
    Readonly<Record<WorkspaceActionFailure, Readonly<Record<string, unknown>>>>
  >
> = {
  createJoinRequest: {
    invalid: refusedWith("invalid"),
    too_soon: refusedWith("too_soon", 1_500),
    not_signed_in: refusedWith("not_signed_in"),
    unavailable: refusedWith("unavailable"),
    forbidden: refusedWith("failed"),
    not_found: refusedWith("failed"),
    conflict: refusedWith("failed"),
    already_member: refusedWith("already_member"),
    invitation_invalid: refusedWith("failed"),
    join_requests_closed: refusedWith("join_requests_closed"),
    workspace_not_found: refusedWith("workspace_not_found"),
    device_too_new: refusedWith("failed"),
    unclaimed_limit: refusedWith("failed"),
    rate_limited: refusedWith("rate_limited", 1_500),
    unknown: { outcome: "unknown" },
    failed: refusedWith("failed"),
  },
  withdrawJoinRequest: {
    invalid: refusedWith("invalid"),
    too_soon: refusedWith("too_soon", 1_500),
    not_signed_in: refusedWith("not_signed_in"),
    unavailable: refusedWith("unavailable"),
    forbidden: refusedWith("failed"),
    not_found: refusedWith("not_found"),
    conflict: refusedWith("conflict"),
    already_member: refusedWith("failed"),
    invitation_invalid: refusedWith("failed"),
    join_requests_closed: refusedWith("failed"),
    workspace_not_found: refusedWith("failed"),
    device_too_new: refusedWith("failed"),
    unclaimed_limit: refusedWith("failed"),
    rate_limited: refusedWith("rate_limited", 1_500),
    unknown: { outcome: "unknown" },
    failed: refusedWith("failed"),
  },
};

test("every failure of every action maps to one fixed result, which the contract accepts", async () => {
  const reasons = new Set<string>();
  for (const entry of CASES) {
    const expected = EXPECTED[entry.name];
    expect(Object.keys(expected).sort()).toEqual(
      [...WORKSPACE_ACTION_FAILURES].sort(),
    );
    const schema =
      entry.name === "createJoinRequest"
        ? CreateJoinRequestResultSchema
        : WithdrawJoinRequestResultSchema;
    for (const reason of WORKSPACE_ACTION_FAILURES) {
      const account = fakeAccount(() => failed(reason));
      const { call } = register(account);
      const result = await call(entry.channel, ...entry.args);
      expect(result, `${entry.channel} ${reason}`).toEqual(expected[reason]);
      expect(schema.safeParse(result).success, reason).toBe(true);
      expect(account.sent).toHaveLength(1);
      const shown = (result as { reason?: string }).reason;
      if (shown !== undefined) {
        reasons.add(shown);
      }
    }
  }
  // Every refusal of the contract comes from a failure.
  expect([...reasons].sort()).toEqual(
    [...OWN_JOIN_REQUEST_ACTION_REFUSALS].sort(),
  );
});

test("each code that the protocol lists for a create or a withdrawal maps to its own refusal, not to failed", () => {
  for (const entry of CASES) {
    for (const code of MEMBERSHIP_ROUTE_ERRORS[entry.name]) {
      if (
        code === "bad_request" ||
        code === "unauthorized" ||
        code === "internal_error"
      ) {
        continue;
      }
      expect(
        EXPECTED[entry.name][code as WorkspaceActionFailure],
        `${entry.name} ${code}`,
      ).toMatchObject({ reason: code });
    }
  }
  // `device_too_new`, which the protocol does not list for a create, is
  // `failed` (the Project Manager's decision of 2026-11-12).
  expect(MEMBERSHIP_ROUTE_ERRORS.createJoinRequest).not.toContain(
    "device_too_new",
  );
  expect(EXPECTED.createJoinRequest.device_too_new).toMatchObject({
    reason: "failed",
  });
});

test("a confirmed create answers the pending request only, with its name cut in characters, never a user ID; one that names another workspace is unknown", async () => {
  const { call } = register();
  const result = await call(
    INVOKE_CHANNELS.createJoinRequest,
    WORKSPACE,
    "Grace Requester",
  );
  expect(result).toEqual({
    outcome: "ok",
    joinRequestId: REQUEST,
    workspaceId: WORKSPACE,
    requestedName: "Grace Requester",
    createdAt: AT,
    expiresAt: EXPIRES_AT,
  });
  expect(JSON.stringify(result)).not.toContain(USER_ID);
  expect(CreateJoinRequestResultSchema.safeParse(result).success).toBe(true);

  // An answer with the request that was already pending, under another
  // name, crosses as the API gave it, cut to the limit.
  const face = "\u{1F600}";
  const longer = register(
    fakeAccount(() =>
      created(WORKSPACE, face.repeat(OWN_JOIN_REQUEST_LIMITS.displayName + 3)),
    ),
  );
  await expect(
    longer.call(INVOKE_CHANNELS.createJoinRequest, WORKSPACE, "Grace"),
  ).resolves.toMatchObject({
    outcome: "ok",
    requestedName: face.repeat(OWN_JOIN_REQUEST_LIMITS.displayName),
  });

  const other = register(fakeAccount(() => created(OTHER_WORKSPACE)));
  await expect(
    other.call(INVOKE_CHANNELS.createJoinRequest, WORKSPACE, null),
  ).resolves.toEqual({ outcome: "unknown" });
  // The answer does not say which request the API made, so the list loads.
  expect(other.service.reloads()).toBe(1);
});

test("each action is sent once: an uncertain answer and one that throws are unknown, never sent again, and a throw is reported with a fixed message", async () => {
  for (const entry of CASES) {
    const uncertain = fakeAccount(() => failed("unknown"));
    const first = register(uncertain);
    await expect(first.call(entry.channel, ...entry.args)).resolves.toEqual({
      outcome: "unknown",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(uncertain.sent, entry.channel).toHaveLength(1);
    expect(first.errors).toEqual([]);

    const throwing = fakeAccount(() => {
      throw new Error(`secret ${REQUEST} ${WORKSPACE}`);
    });
    const second = register(throwing);
    await expect(second.call(entry.channel, ...entry.args)).resolves.toEqual({
      outcome: "unknown",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(throwing.sent, entry.channel).toHaveLength(1);
    expect(second.errors).toHaveLength(1);
    expect(second.errors[0]).not.toContain("secret");
    expect(second.errors[0]).not.toContain(REQUEST);
    expect(second.errors[0]).not.toContain(WORKSPACE);
  }
});

test("a create loads the own join requests again after ok, unknown, and a throw; a withdrawal also after not_found and conflict; nothing else reloads", async () => {
  const all: readonly (WorkspaceActionFailure | "ok" | "throw")[] = [
    "ok",
    "throw",
    ...WORKSPACE_ACTION_FAILURES,
  ];
  const reloading: Readonly<Record<Case["name"], ReadonlySet<string>>> = {
    createJoinRequest: new Set(["ok", "unknown", "throw"]),
    withdrawJoinRequest: new Set([
      "ok",
      "unknown",
      "throw",
      "not_found",
      "conflict",
    ]),
  };
  for (const entry of CASES) {
    for (const outcome of all) {
      const account = fakeAccount((name) => {
        if (outcome === "throw") {
          throw new Error("no answer");
        }
        if (outcome === "ok") {
          return name === "createJoinRequest"
            ? created()
            : { ok: true, value: null };
        }
        return failed(outcome);
      });
      const service = fakeService();
      const { call } = register(account, service);
      await call(entry.channel, ...entry.args);
      expect(service.reloads(), `${entry.channel} ${outcome}`).toBe(
        reloading[entry.name].has(outcome) ? 1 : 0,
      );
    }
  }
});
