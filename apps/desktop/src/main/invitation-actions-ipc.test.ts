import {
  AcceptInvitationResponseSchema,
  CreateInvitationResponseSchema,
  decodeServerMessage,
  InvitationCodeSchema,
  type InvitationId,
  type MemberId,
  MEMBERSHIP_ROUTE_ERRORS,
  PreviewInvitationResponseSchema,
  type WorkspaceId,
} from "@mymandev/protocol";
import { inspect } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  AcceptInvitationResultSchema,
  CreateInvitationResultSchema,
  INVITATION_ACTION_REFUSALS,
  InvitationCodeTextSchema,
  JOIN_INVITATION_REFUSALS,
  PreviewInvitationResultSchema,
  RevokeInvitationResultSchema,
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
import {
  createInvitationActions,
  type InvitationActions,
  registerInvitationActionsIpc,
} from "./invitation-actions-ipc.ts";
import { registerInvitationIpc } from "./invitation-ipc.ts";
import { createInvitationService } from "./invitations/service.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
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
const OTHER_MEMBER = id(0xc3) as MemberId;
const INVITATION = id(0xe1) as InvitationId;
const USER_ID = id(0xb1);
const DEVICE_ID = id(0xd1);
const AT = "2026-11-05T10:00:00.000Z";
const EXPIRES_AT = "2026-11-12T10:00:00.000Z";

/** The code of a new invitation, in the protocol's form. */
const CODE = `mmdi_${"Cr3atedC0de_-".repeat(4).slice(0, 42)}w`;
/** A code that the person pasted, in the protocol's form. */
const PASTED = `mmdi_${"Pa5tedC0de-_x".repeat(4).slice(0, 42)}A`;

test("the test codes are invitation codes of the protocol and the contract", () => {
  for (const code of [CODE, PASTED]) {
    expect(InvitationCodeSchema.safeParse(code).success).toBe(true);
    expect(InvitationCodeTextSchema.safeParse(code).success).toBe(true);
  }
});

type Answer = WorkspaceActionResult<unknown>;

interface Sent {
  readonly name: WorkspaceActionName;
  readonly params: unknown;
  readonly body: readonly unknown[];
  /** The session's request that the allowlist builds for the call. */
  readonly request: AuthorizedRequest<unknown>;
}

/** The answer of a create, as its schema parses it. */
function created(
  workspaceId: WorkspaceId = WORKSPACE,
  memberId: MemberId = MEMBER,
): Answer {
  return {
    ok: true,
    value: CreateInvitationResponseSchema.parse({
      invitation: {
        id: INVITATION,
        workspaceId,
        memberId,
        createdByMemberId: OWNER,
        createdAt: AT,
        expiresAt: EXPIRES_AT,
      },
      code: CODE,
    }),
  };
}

function previewed(): Answer {
  return {
    ok: true,
    value: PreviewInvitationResponseSchema.parse({
      workspaceName: "Workspace",
      displayName: "Grace Invitee",
      inviter: {
        displayName: "Ada Owner",
        identity: { provider: "github", login: "octocat", verifiedAt: AT },
      },
      expiresAt: EXPIRES_AT,
    }),
  };
}

/** The answer of an accept, with the account's user ID that it carries. */
function accepted(): Answer {
  return {
    ok: true,
    value: AcceptInvitationResponseSchema.parse({
      workspace: { id: OTHER_WORKSPACE, name: "Joined Workspace" },
      member: {
        id: MEMBER,
        workspaceId: OTHER_WORKSPACE,
        displayName: "Grace Invitee",
        role: "member",
        userId: USER_ID,
        identity: { provider: "github", login: "octocat", verifiedAt: AT },
        removedAt: null,
      },
    }),
  };
}

/** The confirmed answer of each write. */
function confirmed(name: WorkspaceActionName): Answer {
  switch (name) {
    case "createInvitation":
      return created();
    case "previewInvitation":
      return previewed();
    case "acceptInvitation":
      return accepted();
    default:
      return { ok: true, value: null };
  }
}

/**
 * The account service's `sendWorkspaceAction`: like the account service, it
 * builds the request with the real allowlist and answers `invalid` without
 * sending anything when the allowlist refuses the call. Otherwise it records
 * the request as sent and answers with `answer`, by default the confirmed
 * answer of the write. `called` counts every call, also a refused one.
 */
function fakeAccount(
  answer: (name: WorkspaceActionName) => Answer | Promise<Answer> = confirmed,
) {
  const sent: Sent[] = [];
  let calls = 0;
  const sendWorkspaceAction = ((
    name: WorkspaceActionName,
    params: unknown,
    ...body: unknown[]
  ) => {
    calls += 1;
    const request = workspaceActionRequest(name, params, body[0]);
    if (request === null) {
      return Promise.resolve({ ok: false, reason: "invalid" });
    }
    sent.push({ name, params, body, request });
    return Promise.resolve(answer(name));
  }) as AccountService["sendWorkspaceAction"];
  return { sent, called: () => calls, account: { sendWorkspaceAction } };
}

function failed(reason: WorkspaceActionFailure): Answer {
  return reason === "too_soon" || reason === "rate_limited"
    ? { ok: false, reason, retryAfterMs: 1_500 }
    : { ok: false, reason };
}

/** The workspace service's selection and its list loads. */
function fakeWorkspaces(selected: string | null = WORKSPACE) {
  let listReloads = 0;
  const workspaces: Pick<
    WorkspaceService,
    "selectedWorkspaceId" | "reloadList"
  > = {
    selectedWorkspaceId: () => selected as WorkspaceId | null,
    reloadList: () => {
      listReloads += 1;
      return true;
    },
  };
  return {
    workspaces,
    listReloads: () => listReloads,
    select: (next: string | null) => {
      selected = next;
    },
  };
}

/** The invitation service's reloads after an action. */
function fakeInvitations() {
  const reloads: WorkspaceId[] = [];
  return {
    reloads,
    invitations: {
      reload: (workspaceId: WorkspaceId) => {
        reloads.push(workspaceId);
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
  workspaces = fakeWorkspaces(),
  invitations = fakeInvitations(),
  appUrl: string = DEV_URL,
) {
  const handlers = new Map<string, IpcInvokeListener>();
  // Every argument of every report, so that an error passed on shows.
  const errors: unknown[][] = [];
  registerInvitationActionsIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    {
      account: account.account,
      workspaces: workspaces.workspaces,
      invitations: invitations.invitations,
      onError: (...args: unknown[]) => errors.push(args),
    },
  );
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`No handler for ${channel}.`);
    }
    return handler(event(frame(appUrl)), ...args) as Promise<unknown>;
  };
  return { handlers, call, errors, account, workspaces, invitations };
}

/**
 * Each channel, its action's name on the allowlist, the arguments of a
 * valid call, and the exact route, path parameters, and body that it sends.
 */
const CASES = [
  {
    channel: INVOKE_CHANNELS.createInvitation,
    name: "createInvitation",
    args: [WORKSPACE, MEMBER, null],
    method: "POST",
    path: "/workspaces/:workspaceId/invitations",
    params: { workspaceId: WORKSPACE },
    body: { memberId: MEMBER },
  },
  {
    channel: INVOKE_CHANNELS.createInvitation,
    name: "createInvitation",
    args: [WORKSPACE, MEMBER, 3_600],
    method: "POST",
    path: "/workspaces/:workspaceId/invitations",
    params: { workspaceId: WORKSPACE },
    body: { memberId: MEMBER, lifetimeSeconds: 3_600 },
  },
  {
    channel: INVOKE_CHANNELS.revokeInvitation,
    name: "revokeInvitation",
    args: [WORKSPACE, INVITATION],
    method: "POST",
    path: "/workspaces/:workspaceId/invitations/:invitationId/revoke",
    params: { workspaceId: WORKSPACE, invitationId: INVITATION },
  },
  {
    channel: INVOKE_CHANNELS.previewInvitation,
    name: "previewInvitation",
    args: [PASTED],
    method: "POST",
    path: "/invitations/preview",
    params: {},
    body: { code: PASTED },
  },
  {
    channel: INVOKE_CHANNELS.acceptInvitation,
    name: "acceptInvitation",
    args: [PASTED],
    method: "POST",
    path: "/invitations/accept",
    params: {},
    body: { code: PASTED },
  },
] as const;

type Case = (typeof CASES)[number];

/** Whether `entry` acts on the selected workspace. */
function manages(entry: Case): boolean {
  return entry.name === "createInvitation" || entry.name === "revokeInvitation";
}

/** The `InvitationActions` function of each channel, for direct calls. */
function direct(
  actions: InvitationActions,
  entry: Case,
): (...args: unknown[]) => Promise<unknown> {
  switch (entry.name) {
    case "createInvitation":
      return (w, m, l) =>
        actions.create(w as string, m as string, l as number | null);
    case "revokeInvitation":
      return (w, i) => actions.revoke(w as string, i as string);
    case "previewInvitation":
      return (code) => actions.preview(code as string);
    case "acceptInvitation":
      return (code) => actions.accept(code as string);
  }
}

function withArgument(entry: Case, index: number, value: unknown): unknown[] {
  return entry.args.map((arg, at) => (at === index ? value : arg));
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("the four invitation action channels are registered, and nothing else", () => {
  const { handlers } = register();
  expect([...handlers.keys()].sort()).toEqual(
    [...new Set(CASES.map((entry) => entry.channel))].sort(),
  );
});

test("every handler refuses a foreign sender before anything is sent", () => {
  const account = fakeAccount();
  const { handlers } = register(
    account,
    fakeWorkspaces(),
    fakeInvitations(),
    APP_ENTRY_URL,
  );
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

/** Texts that are not exactly an invitation code. */
const NOT_CODES: readonly unknown[] = [
  "",
  `${PASTED} `,
  ` ${PASTED}`,
  `${PASTED}\n`,
  PASTED.toUpperCase(),
  PASTED.slice(0, -1),
  `${PASTED.slice(0, -1)}B`,
  `mmda_${PASTED.slice(5)}`,
  `${PASTED}${"x".repeat(10_000)}`,
  1,
  null,
  undefined,
  [PASTED],
  { code: PASTED },
];

test("every handler refuses arguments outside the contract before anything is sent, without repeating them: types, missing and extra arguments, IDs that are not lowercase UUIDv7s, lifetimes out of range, and texts that are not exactly a code", () => {
  const account = fakeAccount();
  const { handlers } = register(account);
  const refusedCall = (channel: string, args: readonly unknown[]) => {
    const handler = handlers.get(channel);
    let message = "";
    try {
      handler?.(event(frame(DEV_URL)), ...args);
    } catch (error) {
      message = String(error);
    }
    expect(message, channel).toBe(
      `IpcRefusedError: The call on ${channel} was refused: the arguments do not match the contract.`,
    );
  };
  const notIds = [
    "",
    "workspace",
    "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b70",
    WORKSPACE.toUpperCase(),
    ` ${WORKSPACE}`,
    `${WORKSPACE}${"0".repeat(10_000)}`,
    PASTED,
    1,
    null,
    undefined,
    [WORKSPACE],
  ];
  const notLifetimes = [3_599, 604_801, 3_600.5, "3600", -1, Number.NaN, {}];
  for (const entry of CASES) {
    refusedCall(entry.channel, []);
    refusedCall(entry.channel, entry.args.slice(0, -1));
    refusedCall(entry.channel, [...entry.args, MEMBER]);
    refusedCall(entry.channel, [...entry.args, undefined]);
    for (const [index, arg] of entry.args.entries()) {
      const values =
        arg === PASTED
          ? NOT_CODES
          : arg === null || typeof arg === "number"
            ? notLifetimes
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

    expect(account.sent, entry.name).toHaveLength(1);
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

test("the main process checks the IDs and the code again with the protocol's schemas, and refuses them as invalid before anything is sent", async () => {
  for (const entry of CASES) {
    for (const [index, arg] of entry.args.entries()) {
      const values =
        arg === PASTED
          ? [`${PASTED} `, "mmdi_short", PASTED.toUpperCase(), ""]
          : arg === null || typeof arg === "number"
            ? []
            : ["not-an-id", WORKSPACE.toUpperCase(), ""];
      for (const value of values) {
        const account = fakeAccount();
        // Even a selection that names the same text does not let it through.
        const workspaces = fakeWorkspaces(index === 0 ? value : WORKSPACE);
        const actions = createInvitationActions({
          account: account.account,
          workspaces: workspaces.workspaces,
          invitations: fakeInvitations().invitations,
        });
        const args = withArgument(entry, index, value);
        await expect(direct(actions, entry)(...args)).resolves.toEqual({
          outcome: "refused",
          reason: "invalid",
          retryAfterMs: null,
        });
        // Refused in the main process, before the account service.
        expect(account.called(), `${entry.name} ${index}`).toBe(0);
      }
    }
  }
  // A lifetime out of range is refused by the protocol's request schema in
  // the account service's allowlist.
  for (const lifetime of [3_599, 604_801, 3_600.5]) {
    const account = fakeAccount();
    const actions = createInvitationActions({
      account: account.account,
      workspaces: fakeWorkspaces().workspaces,
      invitations: fakeInvitations().invitations,
    });
    await expect(actions.create(WORKSPACE, MEMBER, lifetime)).resolves.toEqual({
      outcome: "refused",
      reason: "invalid",
      retryAfterMs: null,
    });
    expect(account.sent).toEqual([]);
  }
});

test("a create or a revocation for a workspace that is not the selected one is refused as not_selected before anything is sent; a preview and an accept are not tied to the selection", async () => {
  for (const selected of [OTHER_WORKSPACE, null]) {
    const account = fakeAccount();
    const invitations = fakeInvitations();
    const { call } = register(account, fakeWorkspaces(selected), invitations);
    for (const entry of CASES) {
      const result = await call(entry.channel, ...entry.args);
      if (manages(entry)) {
        expect(result, entry.name).toEqual({
          outcome: "refused",
          reason: "not_selected",
          retryAfterMs: null,
        });
      } else {
        expect(result, entry.name).toMatchObject({ outcome: "ok" });
      }
    }
    expect(account.sent.map((sent) => sent.name)).toEqual([
      "previewInvitation",
      "acceptInvitation",
    ]);
    expect(invitations.reloads).toEqual([]);
  }
  // The selection is read at the call, so a switch takes effect at once.
  const account = fakeAccount();
  const workspaces = fakeWorkspaces(OTHER_WORKSPACE);
  const { call } = register(account, workspaces);
  workspaces.select(WORKSPACE);
  await expect(
    call(INVOKE_CHANNELS.revokeInvitation, WORKSPACE, INVITATION),
  ).resolves.toEqual({ outcome: "ok" });
  expect(account.sent).toHaveLength(1);
});

/** What the screen gets for each failure of a create or a revocation. */
const MANAGE_EXPECTED: Readonly<Record<WorkspaceActionFailure, unknown>> = {
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
  device_too_new: { outcome: "refused", reason: "failed", retryAfterMs: null },
  rate_limited: {
    outcome: "refused",
    reason: "rate_limited",
    retryAfterMs: 1_500,
  },
  unknown: { outcome: "unknown" },
  failed: { outcome: "refused", reason: "failed", retryAfterMs: null },
};

/** What the join screen gets for each failure of a preview or an accept. */
const JOIN_EXPECTED: Readonly<Record<WorkspaceActionFailure, unknown>> = {
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
  forbidden: { outcome: "refused", reason: "failed", retryAfterMs: null },
  not_found: { outcome: "refused", reason: "failed", retryAfterMs: null },
  conflict: { outcome: "refused", reason: "failed", retryAfterMs: null },
  already_member: {
    outcome: "refused",
    reason: "already_member",
    retryAfterMs: null,
  },
  invitation_invalid: {
    outcome: "refused",
    reason: "invitation_invalid",
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
  rate_limited: {
    outcome: "refused",
    reason: "rate_limited",
    retryAfterMs: 1_500,
  },
  unknown: { outcome: "unknown" },
  failed: { outcome: "refused", reason: "failed", retryAfterMs: null },
};

/** The refusal reasons that `expected` maps to. */
function reasonsOf(
  expected: Readonly<Record<WorkspaceActionFailure, unknown>>,
): string[] {
  return [
    ...new Set(
      Object.values(expected).flatMap((value) => {
        const reason = (value as { reason?: string }).reason;
        return reason === undefined ? [] : [reason];
      }),
    ),
  ];
}

test("every failure of every action maps to one fixed result, which the contract accepts", async () => {
  for (const expected of [MANAGE_EXPECTED, JOIN_EXPECTED]) {
    expect(Object.keys(expected).sort()).toEqual(
      [...WORKSPACE_ACTION_FAILURES].sort(),
    );
  }
  const schemas = {
    createInvitation: CreateInvitationResultSchema,
    revokeInvitation: RevokeInvitationResultSchema,
    previewInvitation: PreviewInvitationResultSchema,
    acceptInvitation: AcceptInvitationResultSchema,
  } as const;
  for (const entry of CASES) {
    const expected = manages(entry) ? MANAGE_EXPECTED : JOIN_EXPECTED;
    for (const reason of WORKSPACE_ACTION_FAILURES) {
      const account = fakeAccount(() => failed(reason));
      const { call } = register(account);
      const result = await call(entry.channel, ...entry.args);
      expect(result, `${entry.name} ${reason}`).toEqual(expected[reason]);
      expect(schemas[entry.name].safeParse(result).success).toBe(true);
      expect(account.sent).toHaveLength(1);
    }
  }
  // Every refusal of the contract comes from a failure, but `not_selected`.
  expect([...reasonsOf(MANAGE_EXPECTED), "not_selected"].sort()).toEqual(
    [...INVITATION_ACTION_REFUSALS].sort(),
  );
  expect(reasonsOf(JOIN_EXPECTED).sort()).toEqual(
    [...JOIN_INVITATION_REFUSALS].sort(),
  );
});

test("each code that an invitation route of the protocol answers maps to its own refusal, not to failed", () => {
  const own: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    createInvitation: {
      forbidden: "not_allowed",
      not_found: "not_found",
      conflict: "conflict",
      rate_limited: "rate_limited",
    },
    revokeInvitation: {
      forbidden: "not_allowed",
      not_found: "not_found",
      conflict: "conflict",
      rate_limited: "rate_limited",
    },
    previewInvitation: {
      invitation_invalid: "invitation_invalid",
      already_member: "already_member",
      rate_limited: "rate_limited",
    },
    acceptInvitation: {
      invitation_invalid: "invitation_invalid",
      already_member: "already_member",
      rate_limited: "rate_limited",
    },
  };
  for (const name of Object.keys(own) as (keyof typeof own &
    keyof typeof MEMBERSHIP_ROUTE_ERRORS)[]) {
    const expected =
      name === "createInvitation" || name === "revokeInvitation"
        ? MANAGE_EXPECTED
        : JOIN_EXPECTED;
    for (const code of MEMBERSHIP_ROUTE_ERRORS[name]) {
      if (
        code === "bad_request" ||
        code === "unauthorized" ||
        code === "internal_error"
      ) {
        // `failed`, `not_signed_in`, and `unknown` in the session.
        continue;
      }
      expect(own[name]?.[code], `${name} ${code}`).toBeDefined();
      expect(expected[code as WorkspaceActionFailure]).toMatchObject({
        reason: own[name]?.[code],
      });
    }
  }
});

test("a confirmed create answers the invitation's ID, its code, and its expiry only; another workspace's or person's invitation is unknown", async () => {
  const { call } = register();
  const result = await call(
    INVOKE_CHANNELS.createInvitation,
    WORKSPACE,
    MEMBER,
    null,
  );
  expect(result).toEqual({
    outcome: "ok",
    invitationId: INVITATION,
    code: CODE,
    expiresAt: EXPIRES_AT,
  });
  expect(CreateInvitationResultSchema.safeParse(result).success).toBe(true);

  for (const answer of [
    created(OTHER_WORKSPACE, MEMBER),
    created(WORKSPACE, OTHER_MEMBER),
  ]) {
    const other = register(fakeAccount(() => answer));
    const unknown = await other.call(
      INVOKE_CHANNELS.createInvitation,
      WORKSPACE,
      MEMBER,
      null,
    );
    expect(unknown).toEqual({ outcome: "unknown" });
    // The code of an answer that is not this write's is dropped.
    expect(JSON.stringify(unknown)).not.toContain(CODE);
  }
});

test("a confirmed revocation answers ok, a preview what the code claims, and an accept the joined workspace without a user ID", async () => {
  const { call } = register();
  await expect(
    call(INVOKE_CHANNELS.revokeInvitation, WORKSPACE, INVITATION),
  ).resolves.toEqual({ outcome: "ok" });

  const preview = await call(INVOKE_CHANNELS.previewInvitation, PASTED);
  expect(preview).toEqual({
    outcome: "ok",
    workspaceName: "Workspace",
    displayName: "Grace Invitee",
    inviterName: "Ada Owner",
    inviterLogin: "octocat",
    inviterVerifiedAt: AT,
    expiresAt: EXPIRES_AT,
  });
  expect(PreviewInvitationResultSchema.safeParse(preview).success).toBe(true);

  const accept = await call(INVOKE_CHANNELS.acceptInvitation, PASTED);
  expect(accept).toEqual({
    outcome: "ok",
    workspaceId: OTHER_WORKSPACE,
    workspaceName: "Joined Workspace",
  });
  expect(JSON.stringify(accept)).not.toContain(USER_ID);
  expect(AcceptInvitationResultSchema.safeParse(accept).success).toBe(true);
  // Neither answer repeats the pasted code.
  expect(JSON.stringify([preview, accept])).not.toContain(PASTED);
});

/** A day in milliseconds: longer than any wait of a write. */
const DAY_MS = 24 * 60 * 60 * 1_000;

test("no answer is ever sent again on its own: after unknown, an answer that throws, too_soon, rate_limited, and unavailable, every timer runs and a day passes with one write per call", async () => {
  vi.useFakeTimers();
  try {
    const reports: Readonly<Record<string, string>> = {
      createInvitation: "An invitation could not be created.",
      revokeInvitation: "An invitation could not be revoked.",
      previewInvitation: "An invitation could not be previewed.",
      acceptInvitation: "An invitation could not be accepted.",
    };
    // An error that holds both codes, also in its cause.
    const holding = () =>
      new Error(`${PASTED} ${CODE}`, { cause: { body: { code: PASTED } } });
    const answers = [
      ["unknown", () => failed("unknown"), { outcome: "unknown" }, false],
      [
        "rejects",
        () => Promise.reject(holding()),
        { outcome: "unknown" },
        true,
      ],
      [
        "throws",
        () => {
          throw holding();
        },
        { outcome: "unknown" },
        true,
      ],
      [
        "too_soon",
        () => failed("too_soon"),
        { outcome: "refused", reason: "too_soon", retryAfterMs: 1_500 },
        false,
      ],
      [
        "rate_limited",
        () => failed("rate_limited"),
        { outcome: "refused", reason: "rate_limited", retryAfterMs: 1_500 },
        false,
      ],
      [
        "unavailable",
        () => failed("unavailable"),
        { outcome: "refused", reason: "unavailable", retryAfterMs: null },
        false,
      ],
    ] as const;
    for (const entry of CASES) {
      for (const [label, answer, expected, thrownReport] of answers) {
        const account = fakeAccount(answer);
        const { call, errors } = register(account);
        await expect(call(entry.channel, ...entry.args)).resolves.toEqual(
          expected,
        );
        // Nothing is sent again, not even after every timer and a day.
        await vi.runAllTimersAsync();
        await vi.advanceTimersByTimeAsync(DAY_MS);
        await vi.runAllTimersAsync();
        expect(account.called(), `${entry.name} ${label}`).toBe(1);
        expect(account.sent, `${entry.name} ${label}`).toHaveLength(1);
        // Only an answer that throws is reported: its fixed message alone,
        // never the error.
        expect(errors, `${entry.name} ${label}`).toEqual(
          thrownReport ? [[reports[entry.name]]] : [],
        );
      }
    }
  } finally {
    vi.useRealTimers();
  }
});

test("a create and a revocation reload the live invitations after ok, unknown, not_found, and conflict, and after an answer that throws; a preview and an accept never do", async () => {
  const reloading: readonly (WorkspaceActionFailure | null)[] = [
    null,
    "unknown",
    "not_found",
    "conflict",
  ];
  for (const entry of CASES) {
    for (const answer of [null, ...WORKSPACE_ACTION_FAILURES]) {
      const invitations = fakeInvitations();
      const { call } = register(
        fakeAccount((name) =>
          answer === null ? confirmed(name) : failed(answer),
        ),
        fakeWorkspaces(),
        invitations,
      );
      await call(entry.channel, ...entry.args);
      expect(invitations.reloads, `${entry.name} ${String(answer)}`).toEqual(
        manages(entry) && reloading.includes(answer) ? [WORKSPACE] : [],
      );
    }
    const invitations = fakeInvitations();
    const { call } = register(
      fakeAccount(() => Promise.reject(new Error("no answer"))),
      fakeWorkspaces(),
      invitations,
    );
    await call(entry.channel, ...entry.args);
    expect(invitations.reloads, entry.name).toEqual(
      manages(entry) ? [WORKSPACE] : [],
    );
  }
});

test("an accept loads the workspace list again after ok, unknown, and an answer that throws, and nothing else does", async () => {
  for (const entry of CASES) {
    for (const answer of [
      null,
      ...WORKSPACE_ACTION_FAILURES,
      "throws" as const,
    ]) {
      const workspaces = fakeWorkspaces();
      const { call } = register(
        fakeAccount((name) =>
          answer === null
            ? confirmed(name)
            : answer === "throws"
              ? Promise.reject(new Error("no answer"))
              : failed(answer),
        ),
        workspaces,
      );
      await call(entry.channel, ...entry.args);
      const reloads =
        entry.name === "acceptInvitation" &&
        (answer === null || answer === "unknown" || answer === "throws");
      expect(workspaces.listReloads(), `${entry.name} ${String(answer)}`).toBe(
        reloads ? 1 : 0,
      );
    }
  }
});

// The code (D2), end to end.

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

function decoded(input: Record<string, unknown>): ServerMessage {
  const result = decodeServerMessage({ protocolVersion: 0, ...input });
  if (!result.ok) {
    throw new Error("The test message does not decode");
  }
  return result.kind === "frame"
    ? { kind: "frame", frame: result.frame }
    : { kind: "event", event: result.event };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("an invitation code appears in exactly one create answer, and never in a published state, a log line, the output, a reported error, or a refusal, with the reports of production", async () => {
  // Every argument of every console call and every write to the output,
  // also the ones that a library makes.
  const logged: unknown[][] = [];
  for (const method of [
    "log",
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "dir",
    "table",
    "dirxml",
  ] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }
  const written: unknown[][] = [];
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, "write").mockImplementation((...args: unknown[]) => {
      // A chunk of bytes is checked as its text.
      written.push(
        args.map((arg) =>
          arg instanceof Uint8Array
            ? Buffer.from(arg.buffer, arg.byteOffset, arg.byteLength).toString(
                "utf8",
              )
            : arg,
        ),
      );
      return true;
    });
  }
  // The services log as in `index.ts`.
  const log = (message: string) => console.info(message);

  // The real workspace and invitation services over a fake account, whose
  // invitations read never holds a code, and a fake connection.
  const listeners = new Set<(message: ServerMessage) => void>();
  const receive = (message: ServerMessage) => {
    for (const listener of [...listeners]) {
      listener(message);
    }
  };
  let invitationReads = 0;
  const readWorkspaceData = (name: string, params: unknown) => {
    const workspaceId = (params as { workspaceId?: WorkspaceId }).workspaceId;
    switch (name) {
      case "listWorkspaces":
        return Promise.resolve({
          ok: true,
          value: {
            workspaces: [
              {
                workspace: { id: WORKSPACE, name: "Workspace" },
                member: member(WORKSPACE, OWNER, "Ada Owner", "owner", USER_ID),
              },
            ],
          },
        });
      case "getWorkspace":
        return Promise.resolve({
          ok: true,
          value: {
            workspace: { id: workspaceId, name: "Workspace" },
            members: [
              member(WORKSPACE, OWNER, "Ada Owner", "owner", USER_ID),
              member(WORKSPACE, MEMBER, "Grace Invitee", "member", null),
            ],
            joinRequestsPausedAt: null,
            maxUnclaimedMembers: 40,
            ownershipOffer: null,
          },
        });
      case "listInvitations":
        invitationReads += 1;
        // The read fails once, so that its failure is logged too.
        return Promise.resolve(
          invitationReads === 1
            ? { ok: false, reason: "unavailable" }
            : {
                ok: true,
                value: {
                  invitations: [
                    {
                      id: INVITATION,
                      workspaceId: WORKSPACE,
                      memberId: MEMBER,
                      createdByMemberId: OWNER,
                      createdAt: AT,
                      expiresAt: EXPIRES_AT,
                    },
                  ],
                },
              },
        );
      default:
        return Promise.resolve({ ok: true, value: { projects: [] } });
    }
  };
  const connection = {
    status: () => ({ state: "connected", revision: 1 }),
    onStatusChange: () => () => undefined,
    onMessage: (listener: (message: ServerMessage) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeWorkspace: () => undefined,
    unsubscribeWorkspace: () => undefined,
  } as unknown as WorkspaceConnection;
  const workspaces = createWorkspaceService({
    account: {
      status: () => SIGNED_IN,
      onStatusChange: () => () => undefined,
      readWorkspaceData,
    } as unknown as WorkspaceAccount,
    connection,
    log,
  });
  const timers: (() => void)[] = [];
  const schedule = (callback: () => void) => {
    timers.push(callback);
    return () => undefined;
  };
  const invitations = createInvitationService({
    account: {
      readWorkspaceData,
    } as unknown as Pick<WorkspaceAccount, "readWorkspaceData">,
    connection,
    workspaces,
    scheduleTimer: schedule,
    log,
  });

  // The IPC, with a subscribed frame that records every payload.
  const handlers = new Map<string, IpcInvokeListener>();
  const ipc = {
    handle: (channel: string, listener: IpcInvokeListener) =>
      handlers.set(channel, listener),
  };
  // An error that holds both codes, in its message and its cause.
  const holding = () =>
    new Error(`${PASTED} ${CODE}`, {
      cause: { body: { code: PASTED }, answer: { code: CODE } },
    });
  const published: unknown[] = [];
  let sends = 0;
  const subscriber: StatusReceiver = {
    mainFrame: frame(DEV_URL),
    isDestroyed: () => false,
    send: (channel, ...args) => {
      sends += 1;
      // The first publish fails with such an error.
      if (sends === 1) {
        throw holding();
      }
      published.push([channel, ...args]);
    },
    once: () => undefined,
  };
  // Both IPC modules report as in production: no `onError` is given.
  const invitationIpc = registerInvitationIpc(ipc, DEV_URL, {
    invitations,
    workspaces,
    scheduleTimer: schedule,
    now: () => Date.parse(AT),
  });
  const writes: (WorkspaceActionName | "throws")[] = [];
  const account = fakeAccount((name) => {
    const next = writes.shift() ?? name;
    if (next === "throws") {
      return Promise.reject(holding());
    }
    return confirmed(next);
  });
  registerInvitationActionsIpc(ipc, DEV_URL, {
    account: account.account,
    workspaces,
    invitations,
  });
  const call = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)?.(
      { senderFrame: frame(DEV_URL), sender: subscriber },
      ...args,
    );
  const answers: unknown[] = [];
  const refusals: unknown[] = [];
  const answer = async (channel: string, ...args: unknown[]) => {
    try {
      answers.push(await call(channel, ...args));
    } catch (error) {
      refusals.push(error);
    }
  };
  const runTimers = () => {
    while (timers.length > 0) {
      timers.shift()?.();
    }
  };

  await settle();
  receive(
    decoded({
      type: "workspace.subscribed",
      workspaceId: WORKSPACE,
      onlineMemberIds: [],
    }),
  );
  await settle();
  await answer(INVOKE_CHANNELS.subscribeInvitationState);
  await answer(INVOKE_CHANNELS.loadInvitations);
  await settle();
  // The first read failed; its retry loads the list.
  runTimers();
  await settle();
  runTimers();

  // A create, then every other action with the pasted code, also with an
  // answer that throws with both codes in its message.
  await answer(INVOKE_CHANNELS.createInvitation, WORKSPACE, MEMBER, null);
  await settle();
  runTimers();
  await answer(INVOKE_CHANNELS.previewInvitation, PASTED);
  await answer(INVOKE_CHANNELS.acceptInvitation, PASTED);
  writes.push("throws", "throws", "throws");
  await answer(INVOKE_CHANNELS.createInvitation, WORKSPACE, MEMBER, null);
  await answer(INVOKE_CHANNELS.previewInvitation, PASTED);
  await answer(INVOKE_CHANNELS.acceptInvitation, PASTED);
  // Refusals of texts that are close to a code.
  for (const text of [`${PASTED} `, ` ${CODE}`, PASTED.toUpperCase()]) {
    await answer(INVOKE_CHANNELS.previewInvitation, text);
    await answer(INVOKE_CHANNELS.acceptInvitation, text);
  }
  receive(
    decoded({
      id: id(0x9001),
      occurredAt: AT,
      workspaceId: WORKSPACE,
      actor: { kind: "system" },
      deviceId: null,
      type: "workspace.member.claimed",
      payload: {
        member: member(WORKSPACE, MEMBER, "Grace Invitee", "member", USER_ID),
      },
    }),
  );
  await settle();
  runTimers();
  await answer(INVOKE_CHANNELS.getInvitationState);

  // The list was published with its invitation, and the actions went out.
  expect(
    published.some(
      (entry) =>
        (entry as unknown[])[0] === EVENT_CHANNELS.invitationStateChanged &&
        JSON.stringify(entry).includes(`"invitationId":"${INVITATION}"`) &&
        // The creator's name, from the real workspace service.
        JSON.stringify(entry).includes(`"creatorName":"Ada Owner"`),
    ),
  ).toBe(true);
  expect(account.sent.map((sent) => sent.name)).toEqual([
    "createInvitation",
    "previewInvitation",
    "acceptInvitation",
    "createInvitation",
    "previewInvitation",
    "acceptInvitation",
  ]);
  // The fixed reports of production, each alone.
  for (const message of [
    "The invitations did not load (unavailable).",
    "Sending the invitations failed.",
    "An invitation could not be created.",
    "An invitation could not be previewed.",
    "An invitation could not be accepted.",
  ]) {
    expect(logged, message).toContainEqual([message]);
  }
  expect(refusals).toHaveLength(6);

  // The code of the new invitation: in exactly one answer, once.
  const withCode = answers.filter((entry) =>
    JSON.stringify(entry).includes(CODE),
  );
  expect(withCode).toEqual([
    {
      outcome: "ok",
      invitationId: INVITATION,
      code: CODE,
      expiresAt: EXPIRES_AT,
    },
  ]);
  expect(JSON.stringify(answers).split(CODE)).toHaveLength(2);
  // Neither code, nor its body after the prefix, anywhere else: every
  // value in full, with hidden properties such as an error's message,
  // stack, and cause.
  const elsewhere = inspect(
    [
      answers.filter((entry) => !withCode.includes(entry)),
      published,
      logged,
      written,
      refusals,
      invitations.state(),
      workspaces.state(),
      workspaces.people(),
    ],
    {
      depth: Infinity,
      showHidden: true,
      maxArrayLength: null,
      maxStringLength: null,
      breakLength: Infinity,
    },
  );
  for (const code of [CODE, PASTED, PASTED.toUpperCase()]) {
    expect(elsewhere).not.toContain(code);
    expect(elsewhere).not.toContain(code.slice(5));
  }

  invitationIpc.close();
  invitations.close();
  workspaces.close();
});
