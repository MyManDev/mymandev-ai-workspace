import {
  type JoinRequestId,
  MEMBERSHIP_ROUTE_ERRORS,
  type MemberId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import { INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  ApproveJoinRequestResultSchema,
  JOIN_REQUEST_ACTION_REFUSALS,
  JoinRequestActionResultSchema,
  PEOPLE_LIMITS,
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
  createJoinRequestActions,
  type JoinRequestActions,
  registerJoinRequestActionsIpc,
} from "./join-request-actions-ipc.ts";
import type { AuthorizedRequest } from "./session/session.ts";

const DEV_URL = "http://localhost:5173/";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const OTHER_WORKSPACE = id(0xa2) as WorkspaceId;
const REQUEST = id(0xf1) as JoinRequestId;
const NEW_MEMBER = id(0xc3) as MemberId;
const USER_ID = id(0xb1);
const AT = "2026-11-05T10:00:00.000Z";

type Answer = WorkspaceActionResult<unknown>;

interface Sent {
  readonly name: WorkspaceActionName;
  readonly params: unknown;
  readonly body: readonly unknown[];
  /** The session's request that the allowlist builds for the call. */
  readonly request: AuthorizedRequest<unknown>;
}

/** The answer of an approval, with the user ID that the protocol carries. */
function approved(workspaceId: WorkspaceId = WORKSPACE): Answer {
  return {
    ok: true,
    value: {
      member: {
        id: NEW_MEMBER,
        workspaceId,
        displayName: "Linus Requester",
        role: "member",
        userId: USER_ID,
        identity: { provider: "github", login: "linus", verifiedAt: AT },
        removedAt: null,
      },
    },
  };
}

/**
 * The account service's `sendWorkspaceAction`: like the account service, it
 * builds the request with the real allowlist and answers `invalid` without
 * sending anything when the allowlist refuses the call. Otherwise it records
 * the request as sent and answers with `answer`, by default `ok`.
 */
function fakeAccount(
  answer: (name: WorkspaceActionName) => Answer | Promise<Answer> = (name) =>
    name === "approveJoinRequest" ? approved() : { ok: true, value: null },
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
  return { sent, calls, account: { sendWorkspaceAction } };
}

function failed(reason: WorkspaceActionFailure): Answer {
  return reason === "too_soon" || reason === "rate_limited"
    ? { ok: false, reason, retryAfterMs: 1_500 }
    : { ok: false, reason };
}

/** The workspace service's selection and reloads, and the list's reloads. */
function fakeServices(selected: string | null = WORKSPACE) {
  const workspaceReloads: WorkspaceId[] = [];
  const listReloads: WorkspaceId[] = [];
  return {
    workspaceReloads,
    listReloads,
    workspaces: {
      selectedWorkspaceId: () => selected as WorkspaceId | null,
      reload: (workspaceId: WorkspaceId) => {
        workspaceReloads.push(workspaceId);
        return true;
      },
    },
    joinRequests: {
      reload: (workspaceId: WorkspaceId) => {
        listReloads.push(workspaceId);
        return true;
      },
    },
    select: (next: string | null) => {
      selected = next;
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
  services = fakeServices(),
  appUrl: string = DEV_URL,
) {
  const handlers = new Map<string, IpcInvokeListener>();
  const errors: string[] = [];
  registerJoinRequestActionsIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    {
      account: account.account,
      workspaces: services.workspaces,
      joinRequests: services.joinRequests,
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
  return { handlers, call, errors, account, services };
}

/**
 * Each channel, its action's name on the allowlist, the arguments of a
 * valid call, the exact route, path parameters, and body that it sends, and
 * what it reloads after it.
 */
const CASES = [
  {
    channel: INVOKE_CHANNELS.approveJoinRequest,
    name: "approveJoinRequest",
    args: [WORKSPACE, REQUEST, null],
    path: "/workspaces/:workspaceId/join-requests/:joinRequestId/approve",
    params: { workspaceId: WORKSPACE, joinRequestId: REQUEST },
    body: {},
    reloads: "list",
  },
  {
    channel: INVOKE_CHANNELS.denyJoinRequest,
    name: "denyJoinRequest",
    args: [WORKSPACE, REQUEST],
    path: "/workspaces/:workspaceId/join-requests/:joinRequestId/deny",
    params: { workspaceId: WORKSPACE, joinRequestId: REQUEST },
    reloads: "list",
  },
  {
    channel: INVOKE_CHANNELS.denyAllJoinRequests,
    name: "denyAllJoinRequests",
    args: [WORKSPACE],
    path: "/workspaces/:workspaceId/join-requests/deny-all",
    params: { workspaceId: WORKSPACE },
    reloads: "list",
  },
  {
    channel: INVOKE_CHANNELS.blockJoinRequest,
    name: "blockJoinRequest",
    args: [WORKSPACE, REQUEST],
    path: "/workspaces/:workspaceId/join-requests/:joinRequestId/block",
    params: { workspaceId: WORKSPACE, joinRequestId: REQUEST },
    reloads: "list",
  },
  {
    channel: INVOKE_CHANNELS.unblockJoinRequest,
    name: "unblockJoinRequest",
    args: [WORKSPACE, REQUEST],
    path: "/workspaces/:workspaceId/join-requests/:joinRequestId/unblock",
    params: { workspaceId: WORKSPACE, joinRequestId: REQUEST },
    reloads: "list",
  },
  {
    channel: INVOKE_CHANNELS.pauseJoinRequests,
    name: "pauseJoinRequests",
    args: [WORKSPACE],
    path: "/workspaces/:workspaceId/join-requests/pause",
    params: { workspaceId: WORKSPACE },
    reloads: "workspace",
  },
  {
    channel: INVOKE_CHANNELS.resumeJoinRequests,
    name: "resumeJoinRequests",
    args: [WORKSPACE],
    path: "/workspaces/:workspaceId/join-requests/resume",
    params: { workspaceId: WORKSPACE },
    reloads: "workspace",
  },
] as const;

type Case = (typeof CASES)[number];

/** The arguments of `entry` with `value` at `index`. */
function withArgument(entry: Case, index: number, value: unknown): unknown[] {
  return entry.args.map((arg, at) => (at === index ? value : arg));
}

/** The `JoinRequestActions` function of each channel, for direct calls. */
function direct(
  actions: JoinRequestActions,
  channel: Case["channel"],
): (...args: (string | null)[]) => Promise<unknown> {
  const of: Record<string, (...args: (string | null)[]) => Promise<unknown>> = {
    [INVOKE_CHANNELS.approveJoinRequest]: (w, r, n = null) =>
      actions.approve(w ?? "", r ?? "", n),
    [INVOKE_CHANNELS.denyJoinRequest]: (w, r) => actions.deny(w ?? "", r ?? ""),
    [INVOKE_CHANNELS.denyAllJoinRequests]: (w) => actions.denyAll(w ?? ""),
    [INVOKE_CHANNELS.blockJoinRequest]: (w, r) =>
      actions.block(w ?? "", r ?? ""),
    [INVOKE_CHANNELS.unblockJoinRequest]: (w, r) =>
      actions.unblock(w ?? "", r ?? ""),
    [INVOKE_CHANNELS.pauseJoinRequests]: (w) => actions.pause(w ?? ""),
    [INVOKE_CHANNELS.resumeJoinRequests]: (w) => actions.resume(w ?? ""),
  };
  const action = of[channel];
  if (action === undefined) {
    throw new Error(`No action for ${channel}.`);
  }
  return action;
}

test("the seven join request action channels are registered, and nothing else", () => {
  const { handlers } = register();
  expect([...handlers.keys()].sort()).toEqual(
    CASES.map((entry) => entry.channel).sort(),
  );
});

test("every handler refuses a foreign sender before anything is sent", () => {
  const account = fakeAccount();
  const { handlers } = register(account, fakeServices(), APP_ENTRY_URL);
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
  expect(account.sent).toEqual([]);
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
    "request",
    // Version 4, capitals, white space, and a huge string.
    "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b70",
    REQUEST.toUpperCase(),
    ` ${REQUEST}`,
    `${REQUEST}${"0".repeat(10_000)}`,
    1,
    null,
    undefined,
    [REQUEST],
    { id: REQUEST },
  ];
  for (const entry of CASES) {
    refusedCall(entry.channel, []);
    refusedCall(entry.channel, entry.args.slice(0, -1));
    refusedCall(entry.channel, [...entry.args, REQUEST]);
    refusedCall(entry.channel, [...entry.args, undefined]);
    for (const [index, arg] of entry.args.entries()) {
      const isName = arg === null;
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
  expect(account.sent).toEqual([]);
});

test("each action sends exactly its route, path parameters, and body, once; an approval with a name sends that name", async () => {
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

  const account = fakeAccount();
  const { call } = register(account);
  await call(
    INVOKE_CHANNELS.approveJoinRequest,
    WORKSPACE,
    REQUEST,
    "Linus Renamed",
  );
  expect(account.sent[0]?.body).toEqual([{ displayName: "Linus Renamed" }]);
  expect(account.sent[0]?.request.body).toEqual({
    displayName: "Linus Renamed",
  });
});

test("the main process checks the IDs again with the protocol's ID schemas, and refuses them as invalid before anything is sent", async () => {
  for (const entry of CASES) {
    for (const [index, arg] of entry.args.entries()) {
      if (arg === null) {
        continue;
      }
      for (const value of ["not-an-id", REQUEST.toUpperCase(), ""]) {
        const account = fakeAccount();
        // Even a selection that names the same text does not let it through.
        const services = fakeServices(index === 0 ? value : WORKSPACE);
        const actions = createJoinRequestActions({
          account: account.account,
          workspaces: services.workspaces,
          joinRequests: services.joinRequests,
        });
        const call = withArgument(entry, index, value) as (string | null)[];
        await expect(direct(actions, entry.channel)(...call)).resolves.toEqual({
          outcome: "refused",
          reason: "invalid",
          retryAfterMs: null,
        });
        // Refused before the account service is asked.
        expect(account.calls, `${entry.channel} ${index}`).toEqual([]);
        expect(services.listReloads).toEqual([]);
      }
    }
  }
});

test("an approval's name that the protocol refuses, such as a blank one or one with a line feed, resolves invalid, and nothing is sent", async () => {
  for (const name of ["   ", "a\nb", "\u200b", "a\u202eb"]) {
    const account = fakeAccount();
    const { call } = register(account);
    await expect(
      call(INVOKE_CHANNELS.approveJoinRequest, WORKSPACE, REQUEST, name),
    ).resolves.toEqual({
      outcome: "refused",
      reason: "invalid",
      retryAfterMs: null,
    });
    expect(account.sent, JSON.stringify(name)).toEqual([]);
  }
});

test("an action for a workspace that is not the selected one is refused as not_selected before anything is sent", async () => {
  for (const selected of [OTHER_WORKSPACE, null]) {
    const account = fakeAccount();
    const services = fakeServices(selected);
    const { call } = register(account, services);
    for (const entry of CASES) {
      await expect(call(entry.channel, ...entry.args)).resolves.toEqual({
        outcome: "refused",
        reason: "not_selected",
        retryAfterMs: null,
      });
    }
    expect(account.sent).toEqual([]);
    expect(services.listReloads).toEqual([]);
    expect(services.workspaceReloads).toEqual([]);
  }
  // The selection is read at the call, so a switch takes effect at once.
  const account = fakeAccount();
  const services = fakeServices(OTHER_WORKSPACE);
  const { call } = register(account, services);
  services.select(WORKSPACE);
  await expect(
    call(INVOKE_CHANNELS.denyJoinRequest, WORKSPACE, REQUEST),
  ).resolves.toEqual({ outcome: "ok" });
  expect(account.sent).toHaveLength(1);
});

/** What the screen gets for each failure of a write. */
const EXPECTED: Readonly<Record<WorkspaceActionFailure, unknown>> = {
  invalid: { outcome: "refused", reason: "invalid", retryAfterMs: null },
  too_soon: { outcome: "refused", reason: "too_soon", retryAfterMs: 1_500 },
  not_signed_in: {
    outcome: "refused",
    reason: "not_signed_in",
    retryAfterMs: null,
  },
  unavailable: {
    outcome: "refused",
    reason: "unavailable",
    retryAfterMs: null,
  },
  forbidden: { outcome: "refused", reason: "not_allowed", retryAfterMs: null },
  not_found: { outcome: "refused", reason: "not_found", retryAfterMs: null },
  conflict: { outcome: "refused", reason: "conflict", retryAfterMs: null },
  already_member: {
    outcome: "refused",
    reason: "already_member",
    retryAfterMs: null,
  },
  invitation_invalid: {
    outcome: "refused",
    reason: "failed",
    retryAfterMs: null,
  },
  join_requests_closed: {
    outcome: "refused",
    reason: "failed",
    retryAfterMs: null,
  },
  workspace_not_found: {
    outcome: "refused",
    reason: "failed",
    retryAfterMs: null,
  },
  device_too_new: { outcome: "refused", reason: "failed", retryAfterMs: null },
  unclaimed_limit: {
    outcome: "refused",
    reason: "failed",
    retryAfterMs: null,
  },
  rate_limited: {
    outcome: "refused",
    reason: "rate_limited",
    retryAfterMs: 1_500,
  },
  unknown: { outcome: "unknown" },
  failed: { outcome: "refused", reason: "failed", retryAfterMs: null },
};

test("every failure of every action maps to one fixed result, which the contract accepts", async () => {
  expect(Object.keys(EXPECTED).sort()).toEqual(
    [...WORKSPACE_ACTION_FAILURES].sort(),
  );
  for (const entry of CASES) {
    for (const reason of WORKSPACE_ACTION_FAILURES) {
      const account = fakeAccount(() => failed(reason));
      const { call } = register(account);
      const result = await call(entry.channel, ...entry.args);
      expect(result, `${entry.channel} ${reason}`).toEqual(EXPECTED[reason]);
      expect(account.sent).toHaveLength(1);
    }
  }
  // Every refusal of the contract but `not_selected` comes from a failure.
  const reasons = new Set(
    Object.values(EXPECTED).flatMap((value) =>
      (value as { reason?: string }).reason === undefined
        ? []
        : [(value as { reason: string }).reason],
    ),
  );
  expect([...reasons, "not_selected"].sort()).toEqual(
    [...JOIN_REQUEST_ACTION_REFUSALS].sort(),
  );
});

test("each code that a join request route of the protocol answers maps to its own refusal, not to failed", () => {
  const own: Readonly<Record<string, string>> = {
    forbidden: "not_allowed",
    not_found: "not_found",
    conflict: "conflict",
    already_member: "already_member",
    rate_limited: "rate_limited",
  };
  for (const entry of CASES) {
    for (const code of MEMBERSHIP_ROUTE_ERRORS[entry.name]) {
      if (
        code === "bad_request" ||
        code === "unauthorized" ||
        code === "internal_error"
      ) {
        continue;
      }
      expect(own[code], `${entry.name} ${code}`).toBeDefined();
      expect(EXPECTED[code as WorkspaceActionFailure], code).toMatchObject({
        reason: own[code],
      });
    }
  }
});

test("a confirmed approval answers the new person's member ID only, never a user ID; one that names another workspace is unknown", async () => {
  const { call } = register();
  const result = await call(
    INVOKE_CHANNELS.approveJoinRequest,
    WORKSPACE,
    REQUEST,
    null,
  );
  expect(result).toEqual({ outcome: "ok", memberId: NEW_MEMBER });
  expect(JSON.stringify(result)).not.toContain(USER_ID);
  expect(ApproveJoinRequestResultSchema.safeParse(result).success).toBe(true);

  const other = register(fakeAccount(() => approved(OTHER_WORKSPACE)));
  await expect(
    other.call(INVOKE_CHANNELS.approveJoinRequest, WORKSPACE, REQUEST, null),
  ).resolves.toEqual({ outcome: "unknown" });
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
      throw new Error(`secret ${REQUEST}`);
    });
    const second = register(throwing);
    await expect(second.call(entry.channel, ...entry.args)).resolves.toEqual({
      outcome: "unknown",
    });
    expect(throwing.sent, entry.channel).toHaveLength(1);
    expect(second.errors).toHaveLength(1);
    expect(second.errors[0]).not.toContain("secret");
    expect(second.errors[0]).not.toContain(REQUEST);
  }
});

test("a decision loads the join requests again after ok, unknown, not_found, conflict, already_member, and a throw, and a pause or a resume loads the workspace's view instead", async () => {
  const reloading: readonly (Answer | "throw")[] = [
    { ok: true, value: null },
    failed("unknown"),
    failed("not_found"),
    failed("conflict"),
    failed("already_member"),
    "throw",
  ];
  const quiet: readonly Answer[] = [
    failed("forbidden"),
    failed("rate_limited"),
    failed("too_soon"),
    failed("unavailable"),
    failed("not_signed_in"),
    failed("invalid"),
    failed("failed"),
  ];
  for (const entry of CASES) {
    for (const answer of [...reloading, ...quiet]) {
      const account = fakeAccount((name) => {
        if (answer === "throw") {
          throw new Error("no answer");
        }
        return answer.ok && name === "approveJoinRequest" ? approved() : answer;
      });
      const services = fakeServices();
      const { call } = register(account, services);
      await call(entry.channel, ...entry.args);
      const expected = reloading.includes(answer) ? [WORKSPACE] : [];
      const label = `${entry.channel} ${JSON.stringify(answer)}`;
      if (entry.reloads === "list") {
        expect(services.listReloads, label).toEqual(expected);
        expect(services.workspaceReloads, label).toEqual([]);
      } else {
        expect(services.workspaceReloads, label).toEqual(expected);
        expect(services.listReloads, label).toEqual([]);
      }
    }
  }
});

test("each result that crosses is one that the contract accepts", async () => {
  for (const entry of CASES) {
    const { call } = register();
    const result = await call(entry.channel, ...entry.args);
    const schema =
      entry.channel === INVOKE_CHANNELS.approveJoinRequest
        ? ApproveJoinRequestResultSchema
        : JoinRequestActionResultSchema;
    expect(schema.safeParse(result).success, entry.channel).toBe(true);
  }
});
