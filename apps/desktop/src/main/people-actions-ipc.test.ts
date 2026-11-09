import {
  decodeServerMessage,
  type MemberId,
  MEMBERSHIP_ROUTE_ERRORS,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import { INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  DefinePersonResultSchema,
  PEOPLE_LIMITS,
  PERSON_ACTION_REFUSALS,
  PersonActionResultSchema,
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
import type { ServerMessage } from "./connection/client.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import {
  createPeopleActions,
  type PeopleActions,
  registerPeopleActionsIpc,
} from "./people-actions-ipc.ts";
import { peopleView } from "./people-ipc.ts";
import type { AuthorizedRequest } from "./session/session.ts";
import {
  createWorkspaceService,
  type WorkspaceAccount,
  type WorkspaceConnection,
  type WorkspaceService,
} from "./workspace/service.ts";

const DEV_URL = "http://localhost:5173/";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const OTHER_WORKSPACE = id(0xa2) as WorkspaceId;
const OWNER = id(0xc1) as MemberId;
const MEMBER = id(0xc2) as MemberId;
const NEW_MEMBER = id(0xc3) as MemberId;
const USER_ID = id(0xb1);
const OTHER_USER_ID = id(0xb2);
const DEVICE_ID = id(0xd1);
const AT = "2026-11-05T10:00:00.000Z";
const EXPIRES_AT = "2026-11-12T10:00:00.000Z";

type Answer = WorkspaceActionResult<unknown>;

interface Sent {
  readonly name: WorkspaceActionName;
  readonly params: unknown;
  readonly body: readonly unknown[];
  /** The session's request that the allowlist builds for the call. */
  readonly request: AuthorizedRequest<unknown> | null;
}

/**
 * The account service's `sendWorkspaceAction`, which records each call with
 * the request that the real allowlist builds for it, and answers with
 * `answer`, by default `ok` with the answer of a definition.
 */
function fakeAccount(
  answer: (name: WorkspaceActionName) => Answer | Promise<Answer> = (name) =>
    name === "defineMember" ? defined() : { ok: true, value: null },
) {
  const sent: Sent[] = [];
  const sendWorkspaceAction = ((
    name: WorkspaceActionName,
    params: unknown,
    ...body: unknown[]
  ) => {
    sent.push({
      name,
      params,
      body,
      request: workspaceActionRequest(name, params, body[0]),
    });
    return Promise.resolve(answer(name));
  }) as AccountService["sendWorkspaceAction"];
  return { sent, account: { sendWorkspaceAction } };
}

/** The answer of a definition, with the user ID that the protocol allows. */
function defined(
  workspaceId: WorkspaceId = WORKSPACE,
  userId: string | null = null,
): Answer {
  return {
    ok: true,
    value: {
      member: {
        id: NEW_MEMBER,
        workspaceId,
        displayName: "Linus Newcomer",
        role: "member",
        userId,
        identity: null,
        removedAt: null,
      },
    },
  };
}

function failed(reason: WorkspaceActionFailure): Answer {
  return reason === "too_soon" || reason === "rate_limited"
    ? { ok: false, reason, retryAfterMs: 1_500 }
    : { ok: false, reason };
}

/** The workspace service's selection and its reloads. */
function fakeWorkspaces(selected: string | null = WORKSPACE) {
  const reloads: WorkspaceId[] = [];
  const workspaces: Pick<WorkspaceService, "selectedWorkspaceId" | "reload"> = {
    selectedWorkspaceId: () => selected as WorkspaceId | null,
    reload: (workspaceId) => {
      reloads.push(workspaceId);
      return true;
    },
  };
  return {
    reloads,
    workspaces,
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
  workspaces = fakeWorkspaces(),
  appUrl: string = DEV_URL,
) {
  const handlers = new Map<string, IpcInvokeListener>();
  const errors: string[] = [];
  registerPeopleActionsIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    {
      account: account.account,
      workspaces: workspaces.workspaces,
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
  return { handlers, call, errors, account, workspaces };
}

/**
 * Each channel, its action's name on the allowlist, the arguments of a
 * valid call, and the exact route, path parameters, and body that it sends.
 */
const CASES = [
  {
    channel: INVOKE_CHANNELS.definePerson,
    name: "defineMember",
    args: [WORKSPACE, "Linus Newcomer"],
    method: "POST",
    path: "/workspaces/:workspaceId/members",
    params: { workspaceId: WORKSPACE },
    body: { displayName: "Linus Newcomer" },
  },
  {
    channel: INVOKE_CHANNELS.renamePerson,
    name: "renameMember",
    args: [WORKSPACE, MEMBER, "Grace Renamed"],
    method: "POST",
    path: "/workspaces/:workspaceId/members/:memberId/rename",
    params: { workspaceId: WORKSPACE, memberId: MEMBER },
    body: { displayName: "Grace Renamed" },
  },
  {
    channel: INVOKE_CHANNELS.removePerson,
    name: "removeMember",
    args: [WORKSPACE, MEMBER],
    method: "POST",
    path: "/workspaces/:workspaceId/members/:memberId/remove",
    params: { workspaceId: WORKSPACE, memberId: MEMBER },
  },
  {
    channel: INVOKE_CHANNELS.promotePerson,
    name: "promoteMember",
    args: [WORKSPACE, MEMBER],
    method: "POST",
    path: "/workspaces/:workspaceId/members/:memberId/promote",
    params: { workspaceId: WORKSPACE, memberId: MEMBER },
  },
  {
    channel: INVOKE_CHANNELS.demotePerson,
    name: "demoteMember",
    args: [WORKSPACE, MEMBER],
    method: "POST",
    path: "/workspaces/:workspaceId/members/:memberId/demote",
    params: { workspaceId: WORKSPACE, memberId: MEMBER },
  },
  {
    channel: INVOKE_CHANNELS.leaveWorkspace,
    name: "leaveWorkspace",
    args: [WORKSPACE],
    method: "POST",
    path: "/workspaces/:workspaceId/leave",
    params: { workspaceId: WORKSPACE },
  },
  {
    channel: INVOKE_CHANNELS.offerOwnership,
    name: "offerOwnership",
    args: [WORKSPACE, MEMBER],
    method: "POST",
    path: "/workspaces/:workspaceId/ownership-offer",
    params: { workspaceId: WORKSPACE },
    body: { memberId: MEMBER },
  },
  {
    channel: INVOKE_CHANNELS.withdrawOwnershipOffer,
    name: "withdrawOwnershipOffer",
    args: [WORKSPACE],
    method: "POST",
    path: "/workspaces/:workspaceId/ownership-offer/withdraw",
    params: { workspaceId: WORKSPACE },
  },
  {
    channel: INVOKE_CHANNELS.acceptOwnershipOffer,
    name: "acceptOwnershipOffer",
    args: [WORKSPACE],
    method: "POST",
    path: "/workspaces/:workspaceId/ownership-offer/accept",
    params: { workspaceId: WORKSPACE },
  },
] as const;

/** The arguments of `entry` with `value` at `index`. */
function withArgument(
  entry: (typeof CASES)[number],
  index: number,
  value: unknown,
): unknown[] {
  return entry.args.map((arg, at) => (at === index ? value : arg));
}

/** The `PeopleActions` function of each channel, for direct calls. */
function direct(
  actions: PeopleActions,
  channel: (typeof CASES)[number]["channel"],
): (...args: string[]) => Promise<unknown> {
  const of: Record<string, (...args: string[]) => Promise<unknown>> = {
    [INVOKE_CHANNELS.definePerson]: (w = "", n = "") => actions.define(w, n),
    [INVOKE_CHANNELS.renamePerson]: (w = "", m = "", n = "") =>
      actions.rename(w, m, n),
    [INVOKE_CHANNELS.removePerson]: (w = "", m = "") => actions.remove(w, m),
    [INVOKE_CHANNELS.promotePerson]: (w = "", m = "") => actions.promote(w, m),
    [INVOKE_CHANNELS.demotePerson]: (w = "", m = "") => actions.demote(w, m),
    [INVOKE_CHANNELS.leaveWorkspace]: (w = "") => actions.leave(w),
    [INVOKE_CHANNELS.offerOwnership]: (w = "", m = "") =>
      actions.offerOwnership(w, m),
    [INVOKE_CHANNELS.withdrawOwnershipOffer]: (w = "") =>
      actions.withdrawOwnershipOffer(w),
    [INVOKE_CHANNELS.acceptOwnershipOffer]: (w = "") =>
      actions.acceptOwnershipOffer(w),
  };
  const action = of[channel];
  if (action === undefined) {
    throw new Error(`No action for ${channel}.`);
  }
  return action;
}

test("the nine people action channels are registered, and nothing else", () => {
  const { handlers } = register();
  expect([...handlers.keys()].sort()).toEqual(
    CASES.map((entry) => entry.channel).sort(),
  );
});

test("every handler refuses a foreign sender before anything is sent", () => {
  const account = fakeAccount();
  const { handlers } = register(account, fakeWorkspaces(), APP_ENTRY_URL);
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
    "workspace",
    // Version 4, a wrong variant, capitals, and white space.
    "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b70",
    "0192f0a0-7b3c-7d4e-c f50-0000000000a1",
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
    refusedCall(entry.channel, [...entry.args, MEMBER]);
    refusedCall(entry.channel, [...entry.args, undefined]);
    for (const [index, arg] of entry.args.entries()) {
      const isName = arg !== WORKSPACE && arg !== MEMBER;
      const values = isName
        ? [
            "",
            "a".repeat(PEOPLE_LIMITS.displayName + 1),
            "\u{1F600}".repeat(PEOPLE_LIMITS.displayName + 1),
            1,
            null,
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
    // The allowlist accepts the call as it is, and its route is the
    // protocol's.
    expect(sent?.request).toMatchObject({
      route: { method: entry.method, path: entry.path },
      params: entry.params,
    });
    expect(sent?.request?.body).toEqual(
      "body" in entry ? entry.body : undefined,
    );
  }
});

test("the main process checks the IDs again with the protocol's ID schemas, and refuses them as invalid before anything is sent", async () => {
  for (const entry of CASES) {
    for (const [index, arg] of entry.args.entries()) {
      if (arg !== WORKSPACE && arg !== MEMBER) {
        continue;
      }
      for (const value of ["not-an-id", WORKSPACE.toUpperCase(), ""]) {
        const account = fakeAccount();
        // Even a selection that names the same text does not let it through.
        const workspaces = fakeWorkspaces(index === 0 ? value : WORKSPACE);
        const actions = createPeopleActions({
          account: account.account,
          workspaces: workspaces.workspaces,
        });
        const call = withArgument(entry, index, value) as string[];
        await expect(direct(actions, entry.channel)(...call)).resolves.toEqual({
          outcome: "refused",
          reason: "invalid",
          retryAfterMs: null,
        });
        expect(account.sent, `${entry.channel} ${index}`).toEqual([]);
      }
    }
  }
});

test("an action for a workspace that is not the selected one is refused as not_selected before anything is sent", async () => {
  for (const selected of [OTHER_WORKSPACE, null]) {
    const account = fakeAccount();
    const workspaces = fakeWorkspaces(selected);
    const { call } = register(account, workspaces);
    for (const entry of CASES) {
      await expect(call(entry.channel, ...entry.args)).resolves.toEqual({
        outcome: "refused",
        reason: "not_selected",
        retryAfterMs: null,
      });
    }
    expect(account.sent).toEqual([]);
    expect(workspaces.reloads).toEqual([]);
  }
  // The selection is read at the call, so a switch takes effect at once.
  const account = fakeAccount();
  const workspaces = fakeWorkspaces(OTHER_WORKSPACE);
  const { call } = register(account, workspaces);
  workspaces.select(WORKSPACE);
  await expect(
    call(INVOKE_CHANNELS.removePerson, WORKSPACE, MEMBER),
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
  already_member: { outcome: "refused", reason: "failed", retryAfterMs: null },
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
  device_too_new: {
    outcome: "refused",
    reason: "device_too_new",
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
    [...PERSON_ACTION_REFUSALS].sort(),
  );
});

test("each code that a person route of the protocol answers maps to its own refusal, not to failed", () => {
  const own: Readonly<Record<string, string>> = {
    forbidden: "not_allowed",
    not_found: "not_found",
    conflict: "conflict",
    device_too_new: "device_too_new",
    rate_limited: "rate_limited",
  };
  for (const entry of CASES) {
    for (const code of MEMBERSHIP_ROUTE_ERRORS[entry.name]) {
      if (code === "bad_request") {
        expect(EXPECTED.failed).toMatchObject({ reason: "failed" });
        continue;
      }
      if (code === "unauthorized") {
        // The session answers it as `not_signed_in` (`api-actions.ts`).
        continue;
      }
      if (code === "internal_error") {
        // The session answers every 5xx as uncertain.
        expect(EXPECTED.unknown).toEqual({ outcome: "unknown" });
        continue;
      }
      expect(own[code], `${entry.name} ${code}`).toBeDefined();
      expect(EXPECTED[code as WorkspaceActionFailure]).toMatchObject({
        reason: own[code],
      });
    }
  }
});

test("a confirmed action answers ok, a definition with the new member ID only, and never a user ID", async () => {
  for (const entry of CASES) {
    const account = fakeAccount((name) =>
      name === "defineMember"
        ? defined(WORKSPACE, USER_ID)
        : { ok: true, value: null },
    );
    const { call } = register(account);
    const result = await call(entry.channel, ...entry.args);
    expect(result, entry.channel).toEqual(
      entry.channel === INVOKE_CHANNELS.definePerson
        ? { outcome: "ok", memberId: NEW_MEMBER }
        : { outcome: "ok" },
    );
    expect(JSON.stringify(result)).not.toContain(USER_ID);
    expect(
      (entry.channel === INVOKE_CHANNELS.definePerson
        ? DefinePersonResultSchema
        : PersonActionResultSchema
      ).safeParse(result).success,
    ).toBe(true);
  }
  // A person of another workspace is not this write's answer.
  const { call } = register(fakeAccount(() => defined(OTHER_WORKSPACE)));
  await expect(
    call(INVOKE_CHANNELS.definePerson, WORKSPACE, "Linus Newcomer"),
  ).resolves.toEqual({ outcome: "unknown" });
});

test("an uncertain answer, also one that throws, is unknown and is never sent again", async () => {
  for (const entry of CASES) {
    for (const answer of [
      () => failed("unknown"),
      () => Promise.reject(new Error("Linus Newcomer")),
      () => {
        throw new Error("Linus Newcomer");
      },
    ]) {
      const account = fakeAccount(answer);
      const { call, errors } = register(account);
      await expect(call(entry.channel, ...entry.args)).resolves.toEqual({
        outcome: "unknown",
      });
      // Nothing is sent again, not even later.
      await new Promise((resolve) => setImmediate(resolve));
      expect(account.sent, entry.channel).toHaveLength(1);
      for (const message of errors) {
        expect(message).toBe("A people action could not be sent.");
      }
    }
  }
});

test("the budget's too_soon and the API's rate_limited pass through with their wait, without a second write", async () => {
  for (const reason of ["too_soon", "rate_limited"] as const) {
    const account = fakeAccount(() => ({
      ok: false,
      reason,
      retryAfterMs: 42_000,
    }));
    const { call } = register(account);
    for (const entry of CASES) {
      await expect(call(entry.channel, ...entry.args)).resolves.toEqual({
        outcome: "refused",
        reason,
        retryAfterMs: 42_000,
      });
    }
    expect(account.sent).toHaveLength(CASES.length);
  }
});

test("only the offer actions reload the workspace: an offer and a withdrawal after ok, and all three when the shown offer may be out of date", async () => {
  const reloading = new Map<string, readonly WorkspaceActionFailure[]>([
    ["offerOwnership", ["unknown", "not_found", "conflict"]],
    ["withdrawOwnershipOffer", ["unknown", "not_found", "conflict"]],
    ["acceptOwnershipOffer", ["unknown", "not_found", "conflict"]],
  ]);
  for (const entry of CASES) {
    const reloadsOn = reloading.get(entry.name) ?? [];
    // The answers that reach the API and the ones refused before it.
    for (const answer of [null, ...WORKSPACE_ACTION_FAILURES]) {
      const workspaces = fakeWorkspaces();
      const { call } = register(
        fakeAccount((name) =>
          answer !== null
            ? failed(answer)
            : name === "defineMember"
              ? defined()
              : { ok: true, value: null },
        ),
        workspaces,
      );
      await call(entry.channel, ...entry.args);
      const expected =
        answer === null
          ? entry.name === "offerOwnership" ||
            entry.name === "withdrawOwnershipOffer"
          : reloadsOn.includes(answer);
      expect(workspaces.reloads, `${entry.name} ${String(answer)}`).toEqual(
        expected ? [WORKSPACE] : [],
      );
    }
  }
});

// The real workspace service, end to end.

const SIGNED_IN = Object.freeze({
  revision: 1,
  account: Object.freeze({
    kind: "signed_in",
    login: "octocat",
    displayName: "The Octocat",
    deviceId: DEVICE_ID,
    signInExpiresAt: "2026-12-02T10:00:00.000Z",
  }),
  signIn: Object.freeze({ kind: "idle" }),
  lastOutcome: null,
  deviceKey: "ready",
  replacementPending: false,
  apiOrigin: "set",
  device: "signed_in",
}) satisfies AccountStatus;

function member(
  workspaceId: WorkspaceId,
  memberId: string,
  displayName: string,
  role: "owner" | "admin" | "member",
  userId: string | null,
) {
  return {
    id: memberId,
    workspaceId,
    displayName,
    role,
    userId,
    identity:
      userId === null
        ? null
        : { provider: "github", login: "octocat", verifiedAt: AT },
    removedAt: null,
  };
}

let eventCount = 0;

function decoded(input: Record<string, unknown>): ServerMessage {
  const result = decodeServerMessage({ protocolVersion: 0, ...input });
  if (!result.ok) {
    throw new Error("The test message does not decode");
  }
  return result.kind === "frame"
    ? { kind: "frame", frame: result.frame }
    : { kind: "event", event: result.event };
}

function membershipEvent(
  type: string,
  payload: Record<string, unknown>,
): ServerMessage {
  eventCount += 1;
  return decoded({
    id: id(0x9000 + eventCount),
    occurredAt: AT,
    workspaceId: WORKSPACE,
    actor: { kind: "system" },
    deviceId: null,
    type,
    payload,
  });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * The real workspace service over a fake account and connection, with the
 * account's two workspaces, `WORKSPACE` selected, subscribed, and loaded,
 * and the people actions over the same account. The account's own person
 * is the owner; `offer` is the view's ownership offer.
 */
async function liveService(account = fakeAccount()) {
  const listeners = new Set<(message: ServerMessage) => void>();
  const reads: string[] = [];
  let offer: {
    memberId: MemberId;
    offeredAt: string;
    expiresAt: string;
  } | null = null;
  let workspaces = [WORKSPACE, OTHER_WORKSPACE];
  const requested = new Set<WorkspaceId>();
  const readWorkspaceData = (name: string, params: unknown) => {
    reads.push(name);
    const workspaceId = (params as { workspaceId?: WorkspaceId }).workspaceId;
    switch (name) {
      case "listWorkspaces":
        return Promise.resolve({
          ok: true,
          value: {
            workspaces: workspaces.map((listed) => ({
              workspace: { id: listed, name: "Workspace" },
              member: member(listed, OWNER, "Ada Owner", "owner", USER_ID),
            })),
          },
        });
      case "getWorkspace":
        return Promise.resolve({
          ok: true,
          value: {
            workspace: { id: workspaceId, name: "Workspace" },
            members: [
              member(WORKSPACE, OWNER, "Ada Owner", "owner", USER_ID),
              member(
                WORKSPACE,
                MEMBER,
                "Grace Member",
                "member",
                OTHER_USER_ID,
              ),
            ].map((entry) => ({ ...entry, workspaceId })),
            joinRequestsPausedAt: null,
            maxUnclaimedMembers: 40,
            ownershipOffer: offer,
          },
        });
      default:
        return Promise.resolve({ ok: true, value: { projects: [] } });
    }
  };
  const workspaceAccount = {
    status: () => SIGNED_IN,
    onStatusChange: () => () => undefined,
    readWorkspaceData,
  } as unknown as WorkspaceAccount;
  const connection = {
    status: () => ({ state: "connected", revision: 1 }),
    onStatusChange: () => () => undefined,
    onMessage: (listener: (message: ServerMessage) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeWorkspace: (workspaceId: WorkspaceId) => {
      requested.add(workspaceId);
    },
    unsubscribeWorkspace: (workspaceId: WorkspaceId) => {
      requested.delete(workspaceId);
    },
  } as unknown as WorkspaceConnection;
  const receive = (message: ServerMessage) => {
    for (const listener of [...listeners]) {
      listener(message);
    }
  };
  const service = createWorkspaceService({
    account: workspaceAccount,
    connection,
  });
  await settle();
  receive(
    decoded({
      type: "workspace.subscribed",
      workspaceId: WORKSPACE,
      onlineMemberIds: [],
    }),
  );
  await settle();
  expect(service.gateLive(WORKSPACE)).toBe(true);
  const actions = createPeopleActions({
    account: account.account,
    workspaces: service,
  });
  return {
    service,
    actions,
    account,
    reads,
    requested,
    receive,
    setOffer: (next: typeof offer) => {
      offer = next;
    },
    setWorkspaces: (next: WorkspaceId[]) => {
      workspaces = next;
    },
    view: () =>
      peopleView(
        service.state(),
        service.people(),
        service.ownMemberId(WORKSPACE),
        {
          ownershipOffer: service.ownershipOffer(),
          unclaimedMemberLimit: service.unclaimedMemberLimit(),
          now: Date.parse(AT),
        },
      ),
  };
}

test("a confirmed action changes the people only through its event, in either order, without a reload", async () => {
  const live = await liveService();
  const name = () =>
    live.service.people().find((person) => person.id === MEMBER)?.displayName;
  live.reads.length = 0;

  // The answer first: the people change when the event arrives.
  await expect(
    live.actions.rename(WORKSPACE, MEMBER, "Grace Renamed"),
  ).resolves.toEqual({ outcome: "ok" });
  expect(name()).toBe("Grace Member");
  live.receive(
    membershipEvent("workspace.member.renamed", {
      memberId: MEMBER,
      displayName: "Grace Renamed",
    }),
  );
  expect(name()).toBe("Grace Renamed");

  // The event first: the answer changes nothing after it.
  live.receive(
    membershipEvent("workspace.member.role_changed", {
      memberId: MEMBER,
      role: "admin",
    }),
  );
  const people = live.service.people();
  await expect(live.actions.promote(WORKSPACE, MEMBER)).resolves.toEqual({
    outcome: "ok",
  });
  expect(live.service.people()).toBe(people);

  // A definition's event adds the person that the answer names.
  const defined = await live.actions.define(WORKSPACE, "Linus Newcomer");
  expect(defined).toEqual({ outcome: "ok", memberId: NEW_MEMBER });
  live.receive(
    membershipEvent("workspace.member.defined", {
      member: member(WORKSPACE, NEW_MEMBER, "Linus Newcomer", "member", null),
    }),
  );
  expect(live.view().people.map((person) => person.memberId)).toContain(
    NEW_MEMBER,
  );
  expect(live.reads).toEqual([]);
  expect(JSON.stringify(live.view())).not.toContain(USER_ID);
  expect(JSON.stringify(live.view())).not.toContain(OTHER_USER_ID);
  live.service.close();
});

test("an offer and its withdrawal reload the workspace, so the owner sees the offer, which no event reports", async () => {
  const live = await liveService();
  expect(live.view()).toMatchObject({
    ownershipOffer: null,
    maxUnclaimedMembers: 40,
  });
  live.reads.length = 0;

  live.setOffer({ memberId: MEMBER, offeredAt: AT, expiresAt: EXPIRES_AT });
  await expect(live.actions.offerOwnership(WORKSPACE, MEMBER)).resolves.toEqual(
    { outcome: "ok" },
  );
  await settle();
  expect(live.reads.sort()).toEqual(["getWorkspace", "listProjects"]);
  expect(live.view().ownershipOffer).toEqual({
    memberId: MEMBER,
    expiresAt: EXPIRES_AT,
  });
  expect(live.service.gateLive(WORKSPACE)).toBe(true);

  live.reads.length = 0;
  live.setOffer(null);
  await expect(live.actions.withdrawOwnershipOffer(WORKSPACE)).resolves.toEqual(
    { outcome: "ok" },
  );
  await settle();
  expect(live.reads.sort()).toEqual(["getWorkspace", "listProjects"]);
  expect(live.view().ownershipOffer).toBeNull();
  live.service.close();
});

test("after a confirmed leave, the frames of the membership's end drop the workspace and select the next one", async () => {
  const live = await liveService();
  await expect(live.actions.leave(WORKSPACE)).resolves.toEqual({
    outcome: "ok",
  });
  // Nothing changes until the API's frames arrive.
  expect(live.service.selectedWorkspaceId()).toBe(WORKSPACE);
  expect(live.account.sent.map((sent) => sent.name)).toEqual([
    "leaveWorkspace",
  ]);

  // The API's order: the subscription ends, then the account frame.
  live.setWorkspaces([OTHER_WORKSPACE]);
  live.reads.length = 0;
  live.receive(
    decoded({
      type: "workspace.unsubscribed",
      workspaceId: WORKSPACE,
      reason: "membership_ended",
    }),
  );
  live.receive(
    decoded({
      type: "account.removed_from_workspace",
      workspaceId: WORKSPACE,
      removedAt: AT,
    }),
  );
  await settle();
  expect(live.service.selectedWorkspaceId()).toBe(OTHER_WORKSPACE);
  expect(live.service.state().workspaces.map((entry) => entry.id)).toEqual([
    OTHER_WORKSPACE,
  ]);
  expect([...live.requested]).toEqual([OTHER_WORKSPACE]);
  expect(live.reads).toContain("listWorkspaces");
  expect(live.service.people()).toEqual([]);

  // The left workspace is not selected any more: its actions go nowhere.
  await expect(live.actions.leave(WORKSPACE)).resolves.toEqual({
    outcome: "refused",
    reason: "not_selected",
    retryAfterMs: null,
  });
  expect(live.account.sent).toHaveLength(1);
  live.service.close();
});
