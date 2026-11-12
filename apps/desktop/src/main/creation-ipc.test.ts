import {
  decodeServerMessage,
  LIMITS,
  type MemberId,
  MEMBERSHIP_ROUTE_ERRORS,
  PROJECT_ROUTE_ERRORS,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import { INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  CREATE_PROJECT_REFUSALS,
  CREATE_WORKSPACE_REFUSALS,
  CreateProjectResultSchema,
  CreateWorkspaceResultSchema,
  WORKSPACE_LIMITS,
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
import type { ChatSwitchOptions, ChatSwitchResult } from "./chat/service.ts";
import type { ServerMessage } from "./connection/client.ts";
import {
  type CreationActions,
  createCreationActions,
  registerCreationIpc,
} from "./creation-ipc.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import type { AuthorizedRequest } from "./session/session.ts";
import { workspaceView } from "./workspace-ipc.ts";
import {
  createWorkspaceService,
  type WorkspaceAccount,
  type WorkspaceConnection,
  type WorkspaceService,
  type WorkspaceSummary,
} from "./workspace/service.ts";

const DEV_URL = "http://localhost:5173/";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const OTHER_WORKSPACE = id(0xa2) as WorkspaceId;
const NEW_WORKSPACE = id(0xa3) as WorkspaceId;
const OWNER = id(0xc1) as MemberId;
const NEW_OWNER = id(0xc3) as MemberId;
const PROJECT = id(0xe1);
const USER_ID = id(0xb1);
const DEVICE_ID = id(0xd1);
const AT = "2026-11-05T10:00:00.000Z";

const WORKSPACE_NAME = "Team Alpha";
const PROJECT_NAME = "Launch Plan";
const DISPLAY_NAME = "The Octocat";

const SIGNED_IN = Object.freeze({
  revision: 1,
  account: Object.freeze({
    kind: "signed_in",
    login: "octocat",
    displayName: DISPLAY_NAME,
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

type Answer = WorkspaceActionResult<unknown>;

interface Sent {
  readonly name: WorkspaceActionName;
  readonly params: unknown;
  readonly body: readonly unknown[];
  /** The session's request that the allowlist builds for the call. */
  readonly request: AuthorizedRequest<unknown>;
}

function owner(workspaceId: WorkspaceId, memberId: MemberId = NEW_OWNER) {
  return {
    id: memberId,
    workspaceId,
    displayName: DISPLAY_NAME,
    role: "owner",
    userId: USER_ID,
    identity: { provider: "github", login: "octocat", verifiedAt: AT },
    removedAt: null,
  };
}

/** The answer of a workspace create, with the user ID that the protocol has. */
function createdWorkspace(workspaceId: WorkspaceId = NEW_WORKSPACE): Answer {
  return {
    ok: true,
    value: {
      workspace: { id: workspaceId, name: WORKSPACE_NAME },
      member: owner(workspaceId),
    },
  };
}

/** The answer of a project create. */
function createdProject(workspaceId: WorkspaceId = WORKSPACE): Answer {
  return {
    ok: true,
    value: {
      project: {
        id: PROJECT,
        workspaceId,
        name: PROJECT_NAME,
        createdByMemberId: OWNER,
      },
    },
  };
}

function defaultAnswer(name: WorkspaceActionName): Answer {
  return name === "createWorkspace" ? createdWorkspace() : createdProject();
}

/**
 * The account service's `status` and `sendWorkspaceAction`: like the
 * account service, it builds the request with the real allowlist and
 * answers `invalid` without sending anything when the allowlist refuses the
 * call. Otherwise it records the request as sent and answers with `answer`.
 */
function fakeAccount(
  answer: (
    name: WorkspaceActionName,
  ) => Answer | Promise<Answer> = defaultAnswer,
  status: AccountStatus = SIGNED_IN,
) {
  const sent: Sent[] = [];
  const sendWorkspaceAction = ((
    name: WorkspaceActionName,
    params: unknown,
    ...body: unknown[]
  ) => {
    const request = workspaceActionRequest(name, params, body[0]);
    if (request === null) {
      return Promise.resolve({ ok: false, reason: "invalid" });
    }
    sent.push({ name, params, body, request });
    return Promise.resolve(answer(name));
  }) as AccountService["sendWorkspaceAction"];
  let current = status;
  return {
    sent,
    account: { status: () => current, sendWorkspaceAction },
    setStatus: (next: AccountStatus) => {
      current = next;
    },
  };
}

function failed(reason: WorkspaceActionFailure): Answer {
  return reason === "too_soon" || reason === "rate_limited"
    ? { ok: false, reason, retryAfterMs: 1_500 }
    : { ok: false, reason };
}

/**
 * The workspace service's selection and `addWorkspace`, and the chat
 * service's switch, which answers `switch` and selects on `switched`.
 */
function fakeWorkspaces(
  selected: string | null = WORKSPACE,
  options: {
    readonly added?: boolean;
    readonly switch?: ChatSwitchResult;
    /** Runs when the create answers, before the main process selects. */
    readonly onAdd?: () => void;
  } = {},
) {
  const added: [WorkspaceSummary, MemberId][] = [];
  const switches: [WorkspaceId, ChatSwitchOptions][] = [];
  const workspaces: Pick<
    WorkspaceService,
    "selectedWorkspaceId" | "addWorkspace"
  > = {
    selectedWorkspaceId: () => selected as WorkspaceId | null,
    addWorkspace: (workspace, memberId) => {
      added.push([workspace, memberId]);
      options.onAdd?.();
      return options.added ?? true;
    },
  };
  const switcher = {
    selectWorkspace: (
      workspaceId: WorkspaceId,
      switchOptions: ChatSwitchOptions,
    ): ChatSwitchResult => {
      switches.push([workspaceId, switchOptions]);
      const result = options.switch ?? { kind: "switched" };
      if (result.kind === "switched") {
        selected = workspaceId;
      }
      return result;
    },
  };
  return {
    added,
    switches,
    workspaces,
    switcher,
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
  registerCreationIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    {
      account: account.account,
      workspaces: workspaces.workspaces,
      switcher: workspaces.switcher,
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
    channel: INVOKE_CHANNELS.createWorkspace,
    name: "createWorkspace",
    args: [WORKSPACE_NAME],
    method: "POST",
    path: "/workspaces",
    params: {},
    body: { name: WORKSPACE_NAME, displayName: DISPLAY_NAME },
  },
  {
    channel: INVOKE_CHANNELS.createProject,
    name: "createProject",
    args: [WORKSPACE, PROJECT_NAME],
    method: "POST",
    path: "/workspaces/:workspaceId/projects",
    params: { workspaceId: WORKSPACE },
    body: { name: PROJECT_NAME },
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

/** The `CreationActions` function of each channel, for direct calls. */
function direct(
  actions: CreationActions,
  channel: (typeof CASES)[number]["channel"],
): (...args: string[]) => Promise<unknown> {
  return channel === INVOKE_CHANNELS.createWorkspace
    ? (name = "") => actions.createWorkspace(name)
    : (workspaceId = "", name = "") => actions.createProject(workspaceId, name);
}

test("the two create channels are registered, and nothing else", () => {
  const { handlers } = register();
  expect([...handlers.keys()].sort()).toEqual(
    CASES.map((entry) => entry.channel).sort(),
  );
});

test("the contract's name limit is the protocol's, in characters", () => {
  expect(WORKSPACE_LIMITS.name).toBe(LIMITS.name);
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
    // Version 4, capitals, and white space.
    "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b70",
    WORKSPACE.toUpperCase(),
    ` ${WORKSPACE}`,
    `${WORKSPACE}${"0".repeat(10_000)}`,
    1,
    null,
    undefined,
    [WORKSPACE],
  ];
  const notNames = [
    "",
    "a".repeat(WORKSPACE_LIMITS.name + 1),
    "\u{1F600}".repeat(WORKSPACE_LIMITS.name + 1),
    "x".repeat(1_000_000),
    1,
    null,
    undefined,
    { name: "Team" },
  ];
  for (const entry of CASES) {
    refusedCall(entry.channel, []);
    refusedCall(entry.channel, entry.args.slice(0, -1));
    refusedCall(entry.channel, [...entry.args, WORKSPACE]);
    refusedCall(entry.channel, [...entry.args, undefined]);
    for (const [index, arg] of entry.args.entries()) {
      for (const value of arg === WORKSPACE ? notIds : notNames) {
        refusedCall(entry.channel, withArgument(entry, index, value));
      }
    }
  }
  expect(account.sent).toEqual([]);
});

test("a name of 100 characters is accepted, counted in code points as the protocol counts them", async () => {
  const name = "\u{1F600}".repeat(WORKSPACE_LIMITS.name);
  const account = fakeAccount();
  // The project goes first: the workspace's create selects the new one.
  const { call } = register(account);
  await call(INVOKE_CHANNELS.createProject, WORKSPACE, name);
  await call(INVOKE_CHANNELS.createWorkspace, name);
  expect(account.sent.map((sent) => sent.request.body)).toEqual([
    { name },
    { name, displayName: DISPLAY_NAME },
  ]);
});

test("each create sends exactly its route, path parameters, and body, once, and a workspace takes the account's display name", async () => {
  for (const entry of CASES) {
    const account = fakeAccount();
    const { call } = register(account);
    await call(entry.channel, ...entry.args);

    expect(account.sent, entry.channel).toHaveLength(1);
    const [sent] = account.sent;
    expect(sent?.name).toBe(entry.name);
    expect(sent?.params).toEqual(entry.params);
    expect(sent?.body).toEqual([entry.body]);
    // The allowlist accepts the call as it is, and its route is the
    // protocol's; no limit of unclaimed people is sent, so the API applies
    // its default.
    expect(sent?.request).toMatchObject({
      route: { method: entry.method, path: entry.path },
      params: entry.params,
    });
    expect(sent?.request?.body).toEqual(entry.body);
  }
});

test("a project's name goes as the protocol normalizes it", async () => {
  const account = fakeAccount();
  const { call } = register(account);
  // "Cafe" with a combining acute accent, and white space around it.
  await call(INVOKE_CHANNELS.createProject, WORKSPACE, "  Cafe\u0301 ");
  expect(account.sent[0]?.request.body).toEqual({ name: "Caf\u00e9" });
});

test("without a signed-in account, a workspace create is refused as not_signed_in, and nothing is sent", async () => {
  for (const kind of ["signed_out", "hidden"] as const) {
    const account = fakeAccount(defaultAnswer, {
      ...SIGNED_IN,
      account: { kind },
    } as AccountStatus);
    const workspaces = fakeWorkspaces();
    const { call } = register(account, workspaces);
    await expect(
      call(INVOKE_CHANNELS.createWorkspace, WORKSPACE_NAME),
    ).resolves.toEqual({
      outcome: "refused",
      reason: "not_signed_in",
      retryAfterMs: null,
    });
    expect(account.sent, kind).toEqual([]);
    expect(workspaces.added).toEqual([]);
  }
});

test("the main process checks the workspace ID again with the protocol's ID schema, and refuses it as invalid before anything is sent", async () => {
  for (const value of ["not-an-id", WORKSPACE.toUpperCase(), ""]) {
    const account = fakeAccount();
    // Even a selection that names the same text does not let it through.
    const workspaces = fakeWorkspaces(value);
    const actions = createCreationActions({
      account: account.account,
      workspaces: workspaces.workspaces,
      switcher: workspaces.switcher,
    });
    await expect(actions.createProject(value, PROJECT_NAME)).resolves.toEqual({
      outcome: "refused",
      reason: "invalid",
      retryAfterMs: null,
    });
    expect(account.sent).toEqual([]);
  }
});

test("a name that the protocol refuses, such as a blank one or one with a line feed, resolves invalid, and nothing is sent", async () => {
  const refusedInvalid = {
    outcome: "refused",
    reason: "invalid",
    retryAfterMs: null,
  };
  for (const name of ["   ", "a\nb", "\u200b", "a\u202eb"]) {
    const account = fakeAccount();
    const workspaces = fakeWorkspaces();
    const { call } = register(account, workspaces);
    for (const entry of CASES) {
      const actions = direct(
        createCreationActions({
          account: account.account,
          workspaces: workspaces.workspaces,
          switcher: workspaces.switcher,
        }),
        entry.channel,
      );
      const args = withArgument(entry, entry.args.length - 1, name) as string[];
      await expect(call(entry.channel, ...args)).resolves.toEqual(
        refusedInvalid,
      );
      await expect(actions(...args)).resolves.toEqual(refusedInvalid);
    }
    expect(account.sent, JSON.stringify(name)).toEqual([]);
    expect(workspaces.added).toEqual([]);
  }
});

test("a project for a workspace that is not the selected one is refused as not_selected before anything is sent", async () => {
  for (const selected of [OTHER_WORKSPACE, null]) {
    const account = fakeAccount();
    const { call } = register(account, fakeWorkspaces(selected));
    await expect(
      call(INVOKE_CHANNELS.createProject, WORKSPACE, PROJECT_NAME),
    ).resolves.toEqual({
      outcome: "refused",
      reason: "not_selected",
      retryAfterMs: null,
    });
    expect(account.sent).toEqual([]);
  }
  // The selection is read at the call, so a switch takes effect at once.
  const account = fakeAccount();
  const workspaces = fakeWorkspaces(OTHER_WORKSPACE);
  const { call } = register(account, workspaces);
  workspaces.select(WORKSPACE);
  await expect(
    call(INVOKE_CHANNELS.createProject, WORKSPACE, PROJECT_NAME),
  ).resolves.toEqual({ outcome: "ok", projectId: PROJECT });
  expect(account.sent).toHaveLength(1);
});

/** What the screen gets for each failure of a write, by channel. */
const EXPECTED: Readonly<
  Record<
    (typeof CASES)[number]["name"],
    Readonly<Record<WorkspaceActionFailure, unknown>>
  >
> = (() => {
  const refused = (reason: string, retryAfterMs: number | null = null) => ({
    outcome: "refused",
    reason,
    retryAfterMs,
  });
  const common = {
    invalid: refused("invalid"),
    too_soon: refused("too_soon", 1_500),
    not_signed_in: refused("not_signed_in"),
    unavailable: refused("unavailable"),
    forbidden: refused("failed"),
    already_member: refused("failed"),
    invitation_invalid: refused("failed"),
    join_requests_closed: refused("failed"),
    workspace_not_found: refused("failed"),
    device_too_new: refused("failed"),
    unclaimed_limit: refused("failed"),
    // The limits pass through as the API answers them (#255).
    rate_limited: refused("rate_limited", 1_500),
    unknown: { outcome: "unknown" },
    failed: refused("failed"),
  };
  return {
    createWorkspace: {
      ...common,
      not_found: refused("failed"),
      conflict: refused("failed"),
    },
    createProject: {
      ...common,
      not_found: refused("not_found"),
      conflict: refused("conflict"),
    },
  };
})();

test("every failure of each create maps to one fixed result, which the contract accepts, and nothing is added or selected", async () => {
  for (const entry of CASES) {
    const expected = EXPECTED[entry.name];
    expect(Object.keys(expected).sort()).toEqual(
      [...WORKSPACE_ACTION_FAILURES].sort(),
    );
    const schema =
      entry.name === "createWorkspace"
        ? CreateWorkspaceResultSchema
        : CreateProjectResultSchema;
    for (const reason of WORKSPACE_ACTION_FAILURES) {
      const account = fakeAccount(() => failed(reason));
      const workspaces = fakeWorkspaces();
      const { call } = register(account, workspaces);
      const result = await call(entry.channel, ...entry.args);
      expect(result, `${entry.channel} ${reason}`).toEqual(expected[reason]);
      expect(schema.safeParse(result).success).toBe(true);
      expect(account.sent).toHaveLength(1);
      expect(workspaces.added).toEqual([]);
      expect(workspaces.switches).toEqual([]);
    }
    // Every refusal of the contract but `not_selected` comes from a failure.
    const reasons = new Set(
      Object.values(expected).flatMap((value) =>
        (value as { reason?: string }).reason === undefined
          ? []
          : [(value as { reason: string }).reason],
      ),
    );
    expect(
      entry.name === "createWorkspace"
        ? [...reasons].sort()
        : [...reasons, "not_selected"].sort(),
    ).toEqual(
      [
        ...(entry.name === "createWorkspace"
          ? CREATE_WORKSPACE_REFUSALS
          : CREATE_PROJECT_REFUSALS),
      ].sort(),
    );
  }
});

test("each code that a create route of the protocol answers maps to its own refusal, not to failed", () => {
  const own: Readonly<Record<string, string>> = {
    not_found: "not_found",
    conflict: "conflict",
    rate_limited: "rate_limited",
  };
  const routeErrors = {
    createWorkspace: MEMBERSHIP_ROUTE_ERRORS.createWorkspace,
    createProject: PROJECT_ROUTE_ERRORS.createProject,
  };
  for (const entry of CASES) {
    for (const code of routeErrors[entry.name]) {
      if (code === "bad_request") {
        expect(EXPECTED[entry.name].failed).toMatchObject({
          reason: "failed",
        });
        continue;
      }
      if (code === "unauthorized") {
        // The session answers it as `not_signed_in` (`api-actions.ts`).
        continue;
      }
      if (code === "internal_error") {
        // The session answers every 5xx as uncertain.
        expect(EXPECTED[entry.name].unknown).toEqual({ outcome: "unknown" });
        continue;
      }
      expect(own[code], `${entry.name} ${code}`).toBeDefined();
      expect(
        EXPECTED[entry.name][code as WorkspaceActionFailure],
      ).toMatchObject({ reason: own[code] });
    }
  }
});

test("a confirmed workspace create adds the workspace with the account's own person, selects it through the chat service's switch, keeping waiting messages, and never answers a user ID", async () => {
  const workspaces = fakeWorkspaces(WORKSPACE);
  const { call } = register(fakeAccount(), workspaces);
  const result = await call(INVOKE_CHANNELS.createWorkspace, WORKSPACE_NAME);
  expect(result).toEqual({
    outcome: "ok",
    workspaceId: NEW_WORKSPACE,
    selected: true,
  });
  expect(CreateWorkspaceResultSchema.parse(result)).toEqual(result);
  expect(workspaces.added).toEqual([
    [{ id: NEW_WORKSPACE, name: WORKSPACE_NAME }, NEW_OWNER],
  ]);
  expect(workspaces.switches).toEqual([
    [NEW_WORKSPACE, { discardWaiting: false }],
  ]);
  expect(workspaces.workspaces.selectedWorkspaceId()).toBe(NEW_WORKSPACE);
  expect(JSON.stringify(result)).not.toContain(USER_ID);
  expect(JSON.stringify(result)).not.toContain(NEW_OWNER);

  // Also without a workspace selected before, for an account's first one.
  const first = fakeWorkspaces(null);
  await expect(
    register(fakeAccount(), first).call(
      INVOKE_CHANNELS.createWorkspace,
      WORKSPACE_NAME,
    ),
  ).resolves.toMatchObject({ selected: true });
  expect(first.switches).toHaveLength(1);
});

test("a confirmed workspace create is not selected while chat messages wait to be sent, nor after another workspace was selected meanwhile, nor without a signed-in device in the workspace service", async () => {
  // Chat messages wait: the switch answers so, and nothing is dropped.
  const waiting = fakeWorkspaces(WORKSPACE, {
    switch: { kind: "waiting", count: 2 },
  });
  await expect(
    register(fakeAccount(), waiting).call(
      INVOKE_CHANNELS.createWorkspace,
      WORKSPACE_NAME,
    ),
  ).resolves.toEqual({
    outcome: "ok",
    workspaceId: NEW_WORKSPACE,
    selected: false,
  });
  expect(waiting.switches).toEqual([
    [NEW_WORKSPACE, { discardWaiting: false }],
  ]);
  expect(waiting.workspaces.selectedWorkspaceId()).toBe(WORKSPACE);
  expect(waiting.added).toHaveLength(1);

  // The person selected another workspace while the create was on its way.
  const switched = fakeWorkspaces(WORKSPACE);
  const account = fakeAccount(async () => {
    switched.select(OTHER_WORKSPACE);
    return createdWorkspace();
  });
  await expect(
    register(account, switched).call(
      INVOKE_CHANNELS.createWorkspace,
      WORKSPACE_NAME,
    ),
  ).resolves.toMatchObject({ outcome: "ok", selected: false });
  expect(switched.switches).toEqual([]);
  expect(switched.added).toHaveLength(1);
  expect(switched.workspaces.selectedWorkspaceId()).toBe(OTHER_WORKSPACE);

  // The workspace service has no signed-in device any more.
  const gone = fakeWorkspaces(WORKSPACE, { added: false });
  await expect(
    register(fakeAccount(), gone).call(
      INVOKE_CHANNELS.createWorkspace,
      WORKSPACE_NAME,
    ),
  ).resolves.toMatchObject({ outcome: "ok", selected: false });
  expect(gone.switches).toEqual([]);
});

test("a confirmed project create answers the new project's ID only and changes nothing in the main process; a project of another workspace is unknown", async () => {
  const workspaces = fakeWorkspaces();
  const { call } = register(fakeAccount(), workspaces);
  const result = await call(
    INVOKE_CHANNELS.createProject,
    WORKSPACE,
    PROJECT_NAME,
  );
  expect(result).toEqual({ outcome: "ok", projectId: PROJECT });
  expect(CreateProjectResultSchema.parse(result)).toEqual(result);
  expect(workspaces.added).toEqual([]);
  expect(workspaces.switches).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(OWNER);

  await expect(
    register(fakeAccount(() => createdProject(OTHER_WORKSPACE))).call(
      INVOKE_CHANNELS.createProject,
      WORKSPACE,
      PROJECT_NAME,
    ),
  ).resolves.toEqual({ outcome: "unknown" });
});

test("an uncertain answer, also one that throws, is unknown and is never sent again, and only a throw is reported, with a fixed message", async () => {
  const messages: Readonly<Record<string, string>> = {
    createWorkspace: "Creating a workspace could not be sent.",
    createProject: "Creating a project could not be sent.",
  };
  for (const entry of CASES) {
    const thrown = [messages[entry.name]];
    for (const [answer, reported] of [
      [() => failed("unknown"), []],
      [() => Promise.reject(new Error(WORKSPACE_NAME)), thrown],
      [
        () => {
          throw new Error(PROJECT_NAME);
        },
        thrown,
      ],
    ] as const) {
      const account = fakeAccount(answer);
      const workspaces = fakeWorkspaces();
      const { call, errors } = register(account, workspaces);
      await expect(call(entry.channel, ...entry.args)).resolves.toEqual({
        outcome: "unknown",
      });
      // Nothing is sent again, not even later.
      await new Promise((resolve) => setImmediate(resolve));
      expect(account.sent, entry.channel).toHaveLength(1);
      expect(workspaces.added).toEqual([]);
      expect(errors, entry.channel).toEqual(reported);
      expect(errors.join("\n")).not.toContain(WORKSPACE_NAME);
      expect(errors.join("\n")).not.toContain(PROJECT_NAME);
    }
  }
});

test("the budget's too_soon and the API's rate_limited pass through with their wait, without a second write", async () => {
  for (const reason of ["too_soon", "rate_limited"] as const) {
    const account = fakeAccount(() => ({
      ok: false,
      reason,
      retryAfterMs: 86_400_000,
    }));
    const { call } = register(account);
    for (const entry of CASES) {
      await expect(call(entry.channel, ...entry.args)).resolves.toEqual({
        outcome: "refused",
        reason,
        retryAfterMs: 86_400_000,
      });
    }
    expect(account.sent).toHaveLength(CASES.length);
  }
});

// The real workspace service, end to end.

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
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * The real workspace service over a fake account and connection, with the
 * account's workspace `WORKSPACE` selected, subscribed, and loaded, the
 * creates over the same account, and a switch that selects like the chat
 * service's while no message waits. `listed` is what the next list read
 * answers.
 */
async function liveService() {
  const listeners = new Set<(message: ServerMessage) => void>();
  const reads: string[] = [];
  let listed: WorkspaceId[] = [WORKSPACE];
  const projects: Record<string, unknown>[] = [];
  const requested = new Set<WorkspaceId>();
  const readWorkspaceData = (name: string, params: unknown) => {
    reads.push(name);
    const workspaceId = (params as { workspaceId?: WorkspaceId }).workspaceId;
    switch (name) {
      case "listWorkspaces":
        return Promise.resolve({
          ok: true,
          value: {
            workspaces: listed.map((entry) => ({
              workspace: { id: entry, name: WORKSPACE_NAME },
              member: owner(entry, entry === WORKSPACE ? OWNER : NEW_OWNER),
            })),
          },
        });
      case "getWorkspace":
        return Promise.resolve({
          ok: true,
          value: {
            workspace: { id: workspaceId, name: WORKSPACE_NAME },
            members: [
              owner(
                workspaceId as WorkspaceId,
                workspaceId === WORKSPACE ? OWNER : NEW_OWNER,
              ),
            ],
            joinRequestsPausedAt: null,
            maxUnclaimedMembers: 500,
            ownershipOffer: null,
          },
        });
      default:
        return Promise.resolve({
          ok: true,
          value: {
            projects: projects.filter(
              (entry) => entry["workspaceId"] === workspaceId,
            ),
          },
        });
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
  const account = fakeAccount((name) => {
    if (name === "createWorkspace") {
      listed = [NEW_WORKSPACE, ...listed];
      return createdWorkspace();
    }
    const created = createdProject();
    projects.push(
      (created as { value: { project: Record<string, unknown> } }).value
        .project,
    );
    return created;
  });
  const actions = createCreationActions({
    account: account.account,
    workspaces: service,
    switcher: {
      selectWorkspace: (workspaceId) =>
        service.select(workspaceId)
          ? { kind: "switched" }
          : { kind: "refused" },
    },
  });
  return { service, actions, account, reads, requested, receive };
}

test("a created workspace shows in the list at once and is selected and subscribed, and the list loads again, without a restart", async () => {
  const live = await liveService();
  live.reads.length = 0;
  await expect(live.actions.createWorkspace(WORKSPACE_NAME)).resolves.toEqual({
    outcome: "ok",
    workspaceId: NEW_WORKSPACE,
    selected: true,
  });
  const view = workspaceView(live.service.state());
  expect(view.workspaces.map((entry) => entry.id)).toEqual([
    NEW_WORKSPACE,
    WORKSPACE,
  ]);
  expect(view.selectedWorkspaceId).toBe(NEW_WORKSPACE);
  expect(live.service.ownMemberId(NEW_WORKSPACE)).toBe(NEW_OWNER);
  expect([...live.requested]).toEqual([NEW_WORKSPACE]);
  expect(live.reads).toEqual(["listWorkspaces"]);
  await settle();
  // The list's answer holds it, and its subscription loads its view.
  expect(
    workspaceView(live.service.state()).workspaces.map((entry) => entry.id),
  ).toEqual([NEW_WORKSPACE, WORKSPACE]);
  live.receive(
    decoded({
      type: "workspace.subscribed",
      workspaceId: NEW_WORKSPACE,
      onlineMemberIds: [],
    }),
  );
  await settle();
  expect(live.service.gateLive(NEW_WORKSPACE)).toBe(true);
  expect(live.service.state().status).toBe("ready");
  expect(JSON.stringify(workspaceView(live.service.state()))).not.toContain(
    USER_ID,
  );
  live.service.close();
});

test("a created project shows in the project list through its workspace event, without a reload", async () => {
  const live = await liveService();
  live.reads.length = 0;
  await expect(
    live.actions.createProject(WORKSPACE, PROJECT_NAME),
  ).resolves.toEqual({ outcome: "ok", projectId: PROJECT });
  expect(live.service.state().projects).toEqual([]);
  live.receive(
    decoded({
      id: id(0x9001),
      occurredAt: AT,
      workspaceId: WORKSPACE,
      actor: { kind: "system" },
      deviceId: null,
      type: "workspace.project.created",
      payload: {
        project: {
          id: PROJECT,
          workspaceId: WORKSPACE,
          name: PROJECT_NAME,
          createdByMemberId: OWNER,
        },
      },
    }),
  );
  expect(workspaceView(live.service.state()).projects).toEqual([
    { id: PROJECT, name: PROJECT_NAME },
  ]);
  expect(live.reads).toEqual([]);
  live.service.close();
});
