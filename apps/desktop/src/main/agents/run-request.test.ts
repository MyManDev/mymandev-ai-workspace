import {
  type AgentListItem,
  AgentListItemSchema,
  type ChatMessage,
  ChatMessageSchema,
  CreateRunResponseSchema,
  type MemberId,
  type ProjectId,
  type RepositoryId,
  RUN_ROUTE_ERRORS,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import {
  RUN_REQUEST_REFUSALS,
  RunRequestOutcomeSchema,
  RunRequestResultSchema,
  type AccountStatus,
  type RunRequestResult,
  type RunRequestView,
} from "../../shared/ipc-contract.ts";
import {
  RUN_CREATION_FAILURES,
  type RunCreationFailure,
  type WorkspaceActionResult,
  workspaceActionFailed,
  workspaceActionFailedFor,
  workspaceActionSent,
} from "../api-actions.ts";
import type { ChatState } from "../chat/service.ts";
import type { ProviderConnectionsState } from "../provider-connections/service.ts";
import type { ProjectRepositoryState } from "../repository-links/service.ts";
import { createRunRequests, KEPT_RUN_REQUEST_OUTCOMES } from "./run-request.ts";
import type { AgentActivityState } from "./service.ts";

// Requesting a run from the project chat (#35, part A) in the main process:
// what is refused without a request, what is sent, what each answer
// becomes, that nothing is ever sent again on its own, and that the agent
// activity reloads after every request that may have reached the API.

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const PROJECT = id(0xe1) as ProjectId;
const OTHER_PROJECT = id(0xe2) as ProjectId;
const ME = id(0xc1) as MemberId;
const SOMEONE = id(0xc2) as MemberId;
const DEVICE = id(0xd1);
const OTHER_DEVICE = id(0xd2);
const AGENT = id(0xf1);
const ELSEWHERE = id(0xf2);
const THEIRS = id(0xf3);
const DISABLED = id(0xf4);
const OLDER_SERVER = id(0xf5);
const MISSING_AGENT = id(0xf6);
const CONNECTION = id(0x3001);
const OTHER_CONNECTION = id(0x3002);
const MY_MESSAGE = id(0x1001);
const THEIR_MESSAGE = id(0x1002);
const AGENT_MESSAGE = id(0x1003);
const MISSING_MESSAGE = id(0x1004);
const FOREIGN_MESSAGE = id(0x1005);
const RUN = id(0x5001);
const REPOSITORY = id(0x2001) as RepositoryId;
const UNLINKED_REPOSITORY = id(0x2002) as RepositoryId;
const MISSING_REPOSITORY = id(0x2003) as RepositoryId;
const AT = "2026-11-25T10:00:00.000Z";

function agent(
  agentId: string,
  ownerMemberId: string,
  hostDeviceId: string | null,
  disabledAt: string | null = null,
): AgentListItem {
  return AgentListItemSchema.parse({
    id: agentId,
    projectId: PROJECT,
    name: "Builder",
    ownerMemberId,
    disabledAt,
    ...(hostDeviceId === null ? {} : { hostDeviceId }),
  });
}

function message(
  messageId: string,
  author: ChatMessage["author"],
  seq: number,
): ChatMessage {
  return ChatMessageSchema.parse({
    id: messageId,
    projectId: PROJECT,
    seq,
    author,
    body: "Fix the build",
    createdAt: AT,
  });
}

function signedIn(deviceId: string = DEVICE): AccountStatus {
  return {
    apiOrigin: "set",
    device: "signed_in",
    deviceKey: "ready",
    account: { kind: "signed_in", deviceId, login: "octocat" },
  } as unknown as AccountStatus;
}

/** The answer of a creation: the run as the server stores it. */
function created(overrides: Record<string, unknown> = {}) {
  return CreateRunResponseSchema.parse({
    run: {
      id: RUN,
      agentId: AGENT,
      projectId: PROJECT,
      repositoryId: null,
      state: "queued",
      reason: null,
      createdAt: AT,
      finishedAt: null,
      inputMessageId: MY_MESSAGE,
      providerConnectionId: CONNECTION,
      ...overrides,
    },
  });
}

const REQUEST: RunRequestView = Object.freeze({
  projectId: PROJECT,
  agentId: AGENT,
  providerConnectionId: CONNECTION,
  inputMessageId: MY_MESSAGE,
  repositoryId: null,
});

/** The request with the repository that the person chose (#362). */
const WITH_REPOSITORY: RunRequestView = Object.freeze({
  ...REQUEST,
  repositoryId: REPOSITORY,
});

interface Sent {
  readonly name: string;
  readonly params: unknown;
  readonly body: unknown;
  readonly resolve: (
    result: WorkspaceActionResult<unknown, RunCreationFailure>,
  ) => void;
  readonly reject: (error: unknown) => void;
}

function setup() {
  let status = signedIn();
  let activity: AgentActivityState = {
    revision: 1,
    status: "ready",
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    agents: [
      agent(AGENT, ME, DEVICE),
      agent(ELSEWHERE, ME, OTHER_DEVICE),
      agent(THEIRS, SOMEONE, null),
      agent(DISABLED, ME, DEVICE, AT),
      // The account's agent from a server that does not send its host.
      agent(OLDER_SERVER, ME, null),
    ],
    unfinishedRuns: [],
    finishedRuns: [],
  };
  let chat = {
    revision: 1,
    status: "ready",
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    messages: [
      message(MY_MESSAGE, { kind: "member", memberId: ME }, 1),
      message(THEIR_MESSAGE, { kind: "member", memberId: SOMEONE }, 2),
      message(
        AGENT_MESSAGE,
        { kind: "agent", agentId: AGENT } as ChatMessage["author"],
        3,
      ),
    ],
    hasOlder: false,
    loadingOlder: false,
    pending: [],
  } as unknown as ChatState;
  let connections: ProviderConnectionsState = {
    revision: 1,
    status: "ready",
    connections: [
      {
        id: CONNECTION,
        kind: "claude",
        label: "Work laptop",
        createdAt: AT,
        status: "ready",
      },
    ] as unknown as ProviderConnectionsState["connections"],
  };
  let repositories: ProjectRepositoryState = {
    revision: 1,
    status: "ready",
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    links: "ready",
    repositories: [
      {
        repositoryId: REPOSITORY,
        name: "web",
        linked: true,
        mountId: null,
        removable: true,
      },
      // Registered in the project, but not linked on this device.
      {
        repositoryId: UNLINKED_REPOSITORY,
        name: "api",
        linked: false,
        mountId: null,
        removable: true,
      },
    ],
  };
  let ownMember: MemberId | null = ME;
  const sent: Sent[] = [];
  const logs: string[] = [];
  let reloads = 0;
  let clock = 1_000_000;
  const service = createRunRequests({
    account: {
      status: () => status,
      sendWorkspaceAction: ((name: string, params: unknown, body?: unknown) =>
        new Promise((resolve, reject) => {
          sent.push({ name, params, body, resolve, reject });
        })) as never,
    },
    agents: {
      state: () => activity,
      requestReload: () => {
        reloads += 1;
      },
    },
    chat: { state: () => chat },
    workspaces: {
      ownMemberId: (workspaceId: WorkspaceId) =>
        workspaceId === WORKSPACE ? ownMember : null,
    },
    providerConnections: { state: () => connections },
    repositories: { state: () => repositories },
    log: (entry) => logs.push(entry),
    now: () => clock,
  });
  return {
    service,
    sent,
    logs,
    reloads: () => reloads,
    setStatus(next: AccountStatus) {
      status = next;
    },
    setActivity(next: Partial<AgentActivityState>) {
      activity = { ...activity, ...next };
    },
    setChat(next: Partial<ChatState>) {
      chat = { ...chat, ...next } as ChatState;
    },
    setConnections(next: Partial<ProviderConnectionsState>) {
      connections = { ...connections, ...next };
    },
    setOwnMember(next: MemberId | null) {
      ownMember = next;
    },
    setRepositories(next: Partial<ProjectRepositoryState>) {
      repositories = { ...repositories, ...next };
    },
    advance(ms: number) {
      clock += ms;
    },
  };
}

/** Lets the service's awaits run. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

/** The failures of a write that carry a wait. */
type Wait = "too_soon" | "rate_limited" | "run_daily_limit";

function refusedWith(reason: string, retryAfterMs: number | null = null) {
  return { outcome: "refused", reason, retryAfterMs };
}

test("the request of the owner's enabled agent hosted here, with the person's own message and this device's connection, is sent once with IDs only, and the new run's ID is the answer", async () => {
  const h = setup();
  const answer = h.service.request(REQUEST);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]?.name).toBe("createRun");
  expect(h.sent[0]?.params).toEqual({ projectId: PROJECT });
  // IDs only: no text, no requester, no retry key, and no repository,
  // because none was chosen.
  expect(h.sent[0]?.body).toEqual({
    agentId: AGENT,
    providerConnectionId: CONNECTION,
    inputMessageId: MY_MESSAGE,
  });
  h.sent[0]?.resolve({ ok: true, value: created() });
  const result = await answer;
  expect(result).toEqual({ outcome: "ok", runId: RUN });
  expect(RunRequestResultSchema.parse(result)).toEqual(result);
  expect(Object.isFrozen(result)).toBe(true);
  // The agent activity reads the new run; nothing is sent again.
  expect(h.reloads()).toBe(1);
  await settle();
  expect(h.sent).toHaveLength(1);
});

test("a request with the repository that the person chose, one linked on this device, sends its ID, and the answer must name it (#362)", async () => {
  const h = setup();
  const answer = h.service.request(WITH_REPOSITORY);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]?.body).toEqual({
    agentId: AGENT,
    providerConnectionId: CONNECTION,
    inputMessageId: MY_MESSAGE,
    repositoryId: REPOSITORY,
  });
  h.sent[0]?.resolve({
    ok: true,
    value: created({ repositoryId: REPOSITORY }),
  });
  expect(await answer).toEqual({ outcome: "ok", runId: RUN });
  // While the repositories reload after a failure, what was loaded stays,
  // and a link there is still accepted: the server checks again.
  h.setRepositories({ status: "unavailable", problem: "unavailable" });
  const again = h.service.request(WITH_REPOSITORY);
  expect(h.sent).toHaveLength(2);
  h.sent[1]?.resolve(workspaceActionFailed("unknown"));
  await again;
});

test("a run without a repository sends none, also when the project has one linked here: no repository enters without the person's choice (#362)", async () => {
  const h = setup();
  const answer = h.service.request(REQUEST);
  expect(h.sent[0]?.body).not.toHaveProperty("repositoryId");
  h.sent[0]?.resolve({ ok: true, value: created() });
  expect(await answer).toEqual({ outcome: "ok", runId: RUN });
});

test("an answer for a request with a repository that names none or another one is not this request's: unknown (#362)", async () => {
  for (const repositoryId of [null, UNLINKED_REPOSITORY]) {
    const h = setup();
    const answer = h.service.request(WITH_REPOSITORY);
    h.sent[0]?.resolve({ ok: true, value: created({ repositoryId }) });
    expect(await answer, String(repositoryId)).toEqual({ outcome: "unknown" });
    expect(h.logs).toEqual(["A run request was answered with another run."]);
  }
});

test("each local refusal sends nothing and reloads nothing", async () => {
  const cases: [string, (h: ReturnType<typeof setup>) => RunRequestView][] = [
    // An ID that is not one.
    ["invalid", () => ({ ...REQUEST, agentId: "agent" })],
    ["invalid", () => ({ ...REQUEST, projectId: PROJECT.toUpperCase() })],
    ["invalid", () => ({ ...REQUEST, providerConnectionId: "" })],
    ["invalid", () => ({ ...REQUEST, inputMessageId: id(0x1).slice(1) })],
    // Another project than the open one, or none open.
    ["not_open", () => ({ ...REQUEST, projectId: OTHER_PROJECT })],
    [
      "not_open",
      (h) => {
        h.setActivity({ projectId: null, workspaceId: null, agents: [] });
        return REQUEST;
      },
    ],
    // An agent that the open project does not have.
    ["not_open", () => ({ ...REQUEST, agentId: MISSING_AGENT })],
    // Another person's agent.
    ["not_owner", () => ({ ...REQUEST, agentId: THEIRS })],
    // Without an own person in the workspace, no agent is the account's.
    [
      "not_owner",
      (h) => {
        h.setOwnMember(null);
        return REQUEST;
      },
    ],
    // The account's agent on another device, or on an unknown one.
    ["not_hosted_here", () => ({ ...REQUEST, agentId: ELSEWHERE })],
    ["not_hosted_here", () => ({ ...REQUEST, agentId: OLDER_SERVER })],
    // This device is not signed in with a ready key: its ID is not known.
    [
      "not_hosted_here",
      (h) => {
        h.setStatus({
          ...signedIn(),
          deviceKey: "loading",
        } as unknown as AccountStatus);
        return REQUEST;
      },
    ],
    // Another device of the account.
    [
      "not_hosted_here",
      (h) => {
        h.setStatus(signedIn(OTHER_DEVICE));
        return REQUEST;
      },
    ],
    // A disabled agent.
    ["disabled", () => ({ ...REQUEST, agentId: DISABLED })],
    // A message that the open project's chat does not hold.
    [
      "message_not_found",
      () => ({ ...REQUEST, inputMessageId: MISSING_MESSAGE }),
    ],
    // The chat of another project or workspace is not the open project's.
    [
      "message_not_found",
      (h) => {
        h.setChat({ projectId: OTHER_PROJECT });
        return REQUEST;
      },
    ],
    [
      "message_not_found",
      (h) => {
        h.setChat({ workspaceId: id(0xa2) as WorkspaceId });
        return REQUEST;
      },
    ],
    // A message of another project, although the open project's chat
    // holds it and the person wrote it.
    [
      "message_not_found",
      (h) => {
        h.setChat({
          messages: [
            ChatMessageSchema.parse({
              ...message(FOREIGN_MESSAGE, { kind: "member", memberId: ME }, 4),
              projectId: OTHER_PROJECT,
            }),
          ],
        });
        return { ...REQUEST, inputMessageId: FOREIGN_MESSAGE };
      },
    ],
    // Another person's message, and an agent's.
    ["not_own_message", () => ({ ...REQUEST, inputMessageId: THEIR_MESSAGE })],
    ["not_own_message", () => ({ ...REQUEST, inputMessageId: AGENT_MESSAGE })],
    // A connection that this device's list does not hold, or no list.
    [
      "connection_not_here",
      () => ({ ...REQUEST, providerConnectionId: OTHER_CONNECTION }),
    ],
    [
      "connection_not_here",
      (h) => {
        h.setConnections({ status: "signed_out", connections: [] });
        return REQUEST;
      },
    ],
    // A repository ID that is not one (#362).
    ["invalid", () => ({ ...REQUEST, repositoryId: "web" })],
    ["invalid", () => ({ ...REQUEST, repositoryId: REPOSITORY.toUpperCase() })],
    // A repository of the project that is not linked on this device, one
    // that the project does not have, and one unlinked or removed after the
    // person chose it.
    [
      "repository_not_linked",
      () => ({ ...REQUEST, repositoryId: UNLINKED_REPOSITORY }),
    ],
    [
      "repository_not_linked",
      () => ({ ...REQUEST, repositoryId: MISSING_REPOSITORY }),
    ],
    [
      "repository_not_linked",
      (h) => {
        h.setRepositories({
          repositories: [
            {
              repositoryId: REPOSITORY,
              name: "web",
              linked: false,
              mountId: null,
              removable: true,
            },
          ],
        });
        return WITH_REPOSITORY;
      },
    ],
    [
      "repository_not_linked",
      (h) => {
        h.setRepositories({ repositories: [] });
        return WITH_REPOSITORY;
      },
    ],
    // The repositories of another project or workspace, or none loaded.
    [
      "repository_not_linked",
      (h) => {
        h.setRepositories({ projectId: OTHER_PROJECT });
        return WITH_REPOSITORY;
      },
    ],
    [
      "repository_not_linked",
      (h) => {
        h.setRepositories({ workspaceId: id(0xa2) as WorkspaceId });
        return WITH_REPOSITORY;
      },
    ],
    [
      "repository_not_linked",
      (h) => {
        h.setRepositories({
          status: "no_project",
          workspaceId: null,
          projectId: null,
          repositories: [],
        });
        return WITH_REPOSITORY;
      },
    ],
  ];
  for (const [reason, build] of cases) {
    const h = setup();
    const request = build(h);
    const pending = h.service.request(request);
    // Checked before the answer: a request that went out would wait for
    // an answer that never comes.
    expect(h.sent, reason).toEqual([]);
    const result = await pending;
    expect(result, `${reason} ${JSON.stringify(request)}`).toEqual(
      refusedWith(reason),
    );
    expect(h.reloads(), reason).toBe(0);
  }
  // Every local refusal is one of the contract's.
  for (const [reason] of cases) {
    expect(RUN_REQUEST_REFUSALS).toContain(reason);
  }
});

test("a second request while the first waits is refused as busy and never queued, and after the answer the next one goes", async () => {
  const h = setup();
  const first = h.service.request(REQUEST);
  expect(await h.service.request(REQUEST)).toEqual(refusedWith("busy"));
  expect(h.sent).toHaveLength(1);
  h.sent[0]?.resolve({ ok: true, value: created() });
  await first;
  // Only a new press sends a new request.
  const second = h.service.request(REQUEST);
  expect(h.sent).toHaveLength(2);
  h.sent[1]?.resolve(workspaceActionFailed("unknown"));
  await second;
});

test("an uncertain answer is unknown and is never sent again, also after a thrown error; the activity reloads", async () => {
  for (const settleWith of [
    (sent: Sent) =>
      sent.resolve(workspaceActionSent(workspaceActionFailed("unknown"))),
    (sent: Sent) =>
      sent.resolve(
        workspaceActionSent(
          workspaceActionFailedFor(
            { ok: false, reason: "no_answer" },
            "createRun",
          ),
        ),
      ),
    (sent: Sent) =>
      sent.resolve(
        workspaceActionSent(
          workspaceActionFailedFor(
            { ok: false, reason: "server_error" },
            "createRun",
          ),
        ),
      ),
    (sent: Sent) => sent.reject(new Error("lost")),
  ]) {
    const h = setup();
    const answer = h.service.request(REQUEST);
    settleWith(h.sent[0]!);
    expect(await answer).toEqual({ outcome: "unknown" });
    await settle();
    // Sent once: nothing here ever sends it again.
    expect(h.sent).toHaveLength(1);
    expect(h.reloads()).toBe(1);
    // The logs never name an ID.
    for (const entry of h.logs) {
      for (const hidden of [PROJECT, AGENT, CONNECTION, MY_MESSAGE]) {
        expect(entry).not.toContain(hidden);
      }
    }
  }
});

test("an answer that names another project, agent, connection, or message, or a repository, is not this request's: unknown", async () => {
  for (const overrides of [
    { projectId: OTHER_PROJECT },
    { agentId: ELSEWHERE },
    { providerConnectionId: OTHER_CONNECTION },
    { inputMessageId: THEIR_MESSAGE },
    { repositoryId: REPOSITORY },
  ]) {
    const h = setup();
    const answer = h.service.request(REQUEST);
    h.sent[0]?.resolve({ ok: true, value: created(overrides) });
    expect(await answer, JSON.stringify(overrides)).toEqual({
      outcome: "unknown",
    });
    expect(h.logs).toEqual(["A run request was answered with another run."]);
    expect(h.sent).toHaveLength(1);
    expect(h.reloads()).toBe(1);
  }
});

test("every failure of a run creation maps to its own refusal, with its wait for the waits only, and every code of the route beyond the common ones has its own", async () => {
  const expected: Record<RunCreationFailure, string> = {
    invalid: "invalid",
    too_soon: "too_soon",
    not_signed_in: "not_signed_in",
    unavailable: "unavailable",
    forbidden: "forbidden",
    not_found: "not_found",
    conflict: "conflict",
    already_member: "failed",
    invitation_invalid: "failed",
    join_requests_closed: "failed",
    workspace_not_found: "failed",
    device_too_new: "failed",
    unclaimed_limit: "failed",
    project_limit: "failed",
    repository_limit: "failed",
    grant_limit: "failed",
    provider_connection_limit: "failed",
    rate_limited: "rate_limited",
    unknown: "unknown",
    failed: "failed",
    run_limit: "run_limit",
    run_daily_limit: "run_daily_limit",
  };
  expect(Object.keys(expected).sort()).toEqual(
    [...RUN_CREATION_FAILURES].sort(),
  );
  for (const reason of RUN_CREATION_FAILURES) {
    const wait =
      reason === "too_soon" ||
      reason === "rate_limited" ||
      reason === "run_daily_limit";
    const h = setup();
    const answer = h.service.request(REQUEST);
    const failure: WorkspaceActionResult<never, RunCreationFailure> = wait
      ? workspaceActionFailed(reason as Wait, 90_000)
      : workspaceActionFailed(reason as Exclude<RunCreationFailure, Wait>);
    h.sent[0]?.resolve(workspaceActionSent(failure));
    const result = await answer;
    const outcome = expected[reason];
    expect(result, reason).toEqual(
      outcome === "unknown"
        ? { outcome: "unknown" }
        : refusedWith(outcome, wait ? 90_000 : null),
    );
    expect(RunRequestResultSchema.parse(result)).toEqual(result);
    expect(h.sent, reason).toHaveLength(1);
  }
  // Beyond the common codes, every code of the route has its own refusal.
  for (const code of RUN_ROUTE_ERRORS.createRun) {
    if (code === "bad_request" || code === "internal_error") {
      continue;
    }
    const failure = workspaceActionFailedFor(
      { ok: false, reason: "refused", code },
      "createRun",
    );
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(expected[failure.reason], code).not.toBe("failed");
    }
  }
});

test("the server's run limits reach the screen: run_limit without a wait, run_daily_limit with the server's wait", async () => {
  const h = setup();
  let answer = h.service.request(REQUEST);
  h.sent[0]?.resolve(
    workspaceActionSent(
      workspaceActionFailedFor(
        { ok: false, reason: "refused", code: "run_limit" },
        "createRun",
      ),
    ),
  );
  expect(await answer).toEqual(refusedWith("run_limit"));
  answer = h.service.request(REQUEST);
  h.sent[1]?.resolve(
    workspaceActionSent(
      workspaceActionFailedFor(
        {
          ok: false,
          reason: "refused",
          code: "run_daily_limit",
          retryAfterSeconds: 7_200,
        },
        "createRun",
      ),
    ),
  );
  expect(await answer).toEqual(refusedWith("run_daily_limit", 7_200_000));
});

test("only a request that may have reached the API reloads the agent activity", async () => {
  // Refused by the account service itself, without a request.
  for (const failure of [
    workspaceActionFailed("invalid"),
    workspaceActionFailed("too_soon", 1_000),
    workspaceActionFailed("unavailable"),
    workspaceActionFailed("not_signed_in"),
  ]) {
    const h = setup();
    const answer = h.service.request(REQUEST);
    h.sent[0]?.resolve(failure);
    await answer;
    expect(h.reloads(), failure.ok ? "ok" : failure.reason).toBe(0);
  }
  // Handed to the session: whatever the failure, the run may be stored.
  for (const failure of [
    workspaceActionSent(workspaceActionFailed("not_signed_in")),
    workspaceActionSent(workspaceActionFailed("conflict")),
    workspaceActionSent(workspaceActionFailed("run_limit")),
  ]) {
    const h = setup();
    const answer = h.service.request(REQUEST);
    h.sent[0]?.resolve(failure);
    await answer;
    expect(h.reloads()).toBe(1);
  }
});

test("a reload that throws changes nothing of the answer", async () => {
  const h = setup();
  const service = createRunRequests({
    account: {
      status: () => signedIn(),
      sendWorkspaceAction: (() =>
        Promise.resolve({ ok: true, value: created() })) as never,
    },
    agents: {
      state: () =>
        ({
          revision: 1,
          status: "ready",
          workspaceId: WORKSPACE,
          projectId: PROJECT,
          agents: [agent(AGENT, ME, DEVICE)],
          unfinishedRuns: [],
          finishedRuns: [],
        }) as AgentActivityState,
      requestReload: () => {
        throw new Error("reload");
      },
    },
    chat: {
      state: () =>
        ({
          workspaceId: WORKSPACE,
          projectId: PROJECT,
          messages: [message(MY_MESSAGE, { kind: "member", memberId: ME }, 1)],
        }) as unknown as ChatState,
    },
    workspaces: { ownMemberId: () => ME },
    providerConnections: {
      state: () =>
        ({
          revision: 1,
          status: "ready",
          connections: [{ id: CONNECTION }],
        }) as unknown as ProviderConnectionsState,
    },
    repositories: {
      state: () =>
        ({
          workspaceId: WORKSPACE,
          projectId: PROJECT,
          repositories: [],
        }) as unknown as ProjectRepositoryState,
    },
    log: (entry) => h.logs.push(entry),
  });
  expect(await service.request(REQUEST)).toEqual({
    outcome: "ok",
    runId: RUN,
  });
  expect(h.logs).toEqual(["The agent activity could not be read again."]);
});

test("after close, a request is refused as unavailable without a request", async () => {
  const h = setup();
  h.service.close();
  expect(await h.service.request(REQUEST)).toEqual(refusedWith("unavailable"));
  expect(h.sent).toEqual([]);
});

test("every result crosses the contract", () => {
  const results: RunRequestResult[] = [
    { outcome: "ok", runId: RUN },
    { outcome: "unknown" },
    { outcome: "refused", reason: "busy", retryAfterMs: null },
  ];
  for (const result of results) {
    expect(RunRequestResultSchema.parse(result)).toEqual(result);
  }
});

// ---- The kept outcome (#35) ------------------------------------------

/** Opens `projectId` with the account's agent and the person's message. */
function openProject(
  h: ReturnType<typeof setup>,
  projectId: ProjectId,
  hostDeviceId: string = DEVICE,
): void {
  h.setActivity({
    projectId,
    agents: [{ ...agent(AGENT, ME, hostDeviceId), projectId }],
  });
  h.setChat({
    projectId,
    messages: [
      ChatMessageSchema.parse({
        ...message(MY_MESSAGE, { kind: "member", memberId: ME }, 1),
        projectId,
      }),
    ],
  });
}

/** A project ID of the test's own, `n` from 1. */
function project(n: number): ProjectId {
  return id(0x7000 + n) as ProjectId;
}

test("the outcome of a sent request is kept for its project without the run's ID, and taken once", async () => {
  const h = setup();
  const answer = h.service.request(REQUEST);
  h.sent[0]?.resolve({ ok: true, value: created() });
  expect(await answer).toEqual({ outcome: "ok", runId: RUN });
  const kept = await h.service.takeOutcome(PROJECT);
  expect(kept).toEqual({ outcome: "ok" });
  expect(JSON.stringify(kept)).not.toContain(RUN);
  // Once only.
  expect(await h.service.takeOutcome(PROJECT)).toBeNull();
  // Another project has nothing kept, and an ID that is not one is null.
  expect(await h.service.takeOutcome(OTHER_PROJECT)).toBeNull();
  expect(await h.service.takeOutcome("project")).toBeNull();
});

test("every outcome of a sent request is kept, also unknown after a thrown error, and a later request replaces it", async () => {
  const h = setup();
  let answer = h.service.request(REQUEST);
  h.sent[0]?.reject(new Error("lost"));
  expect(await answer).toEqual({ outcome: "unknown" });
  answer = h.service.request(REQUEST);
  h.sent[1]?.resolve(
    workspaceActionSent(
      workspaceActionFailedFor(
        { ok: false, reason: "refused", code: "run_limit" },
        "createRun",
      ),
    ),
  );
  await answer;
  expect(await h.service.takeOutcome(PROJECT)).toEqual(
    refusedWith("run_limit"),
  );
  answer = h.service.request(REQUEST);
  h.sent[2]?.resolve(workspaceActionFailed("unknown"));
  await answer;
  expect(await h.service.takeOutcome(PROJECT)).toEqual({ outcome: "unknown" });
  // A refusal of the account service, which sent nothing, is kept too: it
  // is what the screen said.
  answer = h.service.request(REQUEST);
  h.sent[3]?.resolve(workspaceActionFailed("too_soon", 5_000));
  await answer;
  expect(await h.service.takeOutcome(PROJECT)).toEqual(
    refusedWith("too_soon", 5_000),
  );
});

test("a refusal of the service's own checks is not kept", async () => {
  const h = setup();
  for (const request of [
    { ...REQUEST, inputMessageId: THEIR_MESSAGE },
    { ...REQUEST, agentId: ELSEWHERE },
    { ...REQUEST, providerConnectionId: OTHER_CONNECTION },
  ]) {
    expect((await h.service.request(request)).outcome).toBe("refused");
    expect(await h.service.takeOutcome(PROJECT)).toBeNull();
  }
  // A busy refusal does not replace the outcome of the request on its way.
  const first = h.service.request(REQUEST);
  expect(await h.service.request(REQUEST)).toEqual(refusedWith("busy"));
  h.sent[0]?.resolve(workspaceActionFailed("unknown"));
  await first;
  expect(await h.service.takeOutcome(PROJECT)).toEqual({ outcome: "unknown" });
});

test("a take while a request of that project is on its way waits for its outcome; another project's does not wait", async () => {
  const h = setup();
  const answer = h.service.request(REQUEST);
  let taken: unknown = "waiting";
  const take = h.service.takeOutcome(PROJECT).then((outcome) => {
    taken = outcome;
  });
  expect(await h.service.takeOutcome(OTHER_PROJECT)).toBeNull();
  await settle();
  expect(taken).toBe("waiting");
  h.sent[0]?.resolve(workspaceActionFailed("unknown"));
  await answer;
  await take;
  expect(taken).toEqual({ outcome: "unknown" });
  // Taken by the waiting screen: nothing is left.
  expect(await h.service.takeOutcome(PROJECT)).toBeNull();
});

test("a kept wait counts from the answer, and one that passed is the shortest", async () => {
  const h = setup();
  const daily = () =>
    workspaceActionSent(
      workspaceActionFailedFor(
        {
          ok: false,
          reason: "refused",
          code: "run_daily_limit",
          retryAfterSeconds: 3_600,
        },
        "createRun",
      ),
    );
  let answer = h.service.request(REQUEST);
  h.sent[0]?.resolve(daily());
  expect(await answer).toEqual(refusedWith("run_daily_limit", 3_600_000));
  h.advance(600_000);
  expect(await h.service.takeOutcome(PROJECT)).toEqual(
    refusedWith("run_daily_limit", 3_000_000),
  );
  answer = h.service.request(REQUEST);
  h.sent[1]?.resolve(daily());
  await answer;
  h.advance(3_600_000 + 1);
  expect(await h.service.takeOutcome(PROJECT)).toEqual(
    refusedWith("run_daily_limit", 1),
  );
});

test("only the latest projects are kept, the oldest dropped first", async () => {
  const h = setup();
  const count = KEPT_RUN_REQUEST_OUTCOMES + 1;
  for (let n = 1; n <= count; n += 1) {
    openProject(h, project(n));
    const answer = h.service.request({ ...REQUEST, projectId: project(n) });
    h.sent[n - 1]?.resolve(workspaceActionFailed("unknown"));
    await answer;
  }
  // The first project, the oldest, is dropped; the others are kept.
  expect(await h.service.takeOutcome(project(1))).toBeNull();
  for (let n = 2; n <= count; n += 1) {
    expect(await h.service.takeOutcome(project(n)), String(n)).toEqual({
      outcome: "unknown",
    });
  }
  // A project asked again becomes the newest: the next one over the limit
  // drops the second project, not the first.
  const again = setup();
  const order = [
    ...Array.from(
      { length: KEPT_RUN_REQUEST_OUTCOMES },
      (_, index) => index + 1,
    ),
    1,
    count,
  ];
  for (const [index, which] of order.entries()) {
    openProject(again, project(which));
    const answer = again.service.request({
      ...REQUEST,
      projectId: project(which),
    });
    again.sent[index]?.resolve(workspaceActionFailed("unknown"));
    await answer;
  }
  expect(await again.service.takeOutcome(project(2))).toBeNull();
  expect(await again.service.takeOutcome(project(1))).toEqual({
    outcome: "unknown",
  });
  expect(KEPT_RUN_REQUEST_OUTCOMES).toBe(20);
});

test("a take while signed out or on another device gives nothing and drops every kept outcome", async () => {
  const h = setup();
  openProject(h, project(1));
  let answer = h.service.request({ ...REQUEST, projectId: project(1) });
  h.sent[0]?.resolve(workspaceActionFailed("unknown"));
  await answer;
  openProject(h, project(2));
  answer = h.service.request({ ...REQUEST, projectId: project(2) });
  h.sent[1]?.resolve(workspaceActionFailed("unknown"));
  await answer;
  // Signed out: nothing, and nothing comes back with the next sign-in.
  h.setStatus({ ...signedIn(), device: "signed_out" } as AccountStatus);
  expect(await h.service.takeOutcome(project(1))).toBeNull();
  h.setStatus(signedIn());
  expect(await h.service.takeOutcome(project(2))).toBeNull();

  // Another device's request drops this device's outcomes as it is kept.
  const d = setup();
  openProject(d, project(1));
  answer = d.service.request({ ...REQUEST, projectId: project(1) });
  d.sent[0]?.resolve(workspaceActionFailed("unknown"));
  await answer;
  d.setStatus(signedIn(OTHER_DEVICE));
  openProject(d, project(2), OTHER_DEVICE);
  answer = d.service.request({ ...REQUEST, projectId: project(2) });
  d.sent[1]?.resolve(workspaceActionFailed("unknown"));
  await answer;
  d.setStatus(signedIn());
  expect(await d.service.takeOutcome(project(1))).toBeNull();
});

test("after close, nothing kept is given", async () => {
  const h = setup();
  const answer = h.service.request(REQUEST);
  h.sent[0]?.resolve(workspaceActionFailed("unknown"));
  await answer;
  h.service.close();
  expect(await h.service.takeOutcome(PROJECT)).toBeNull();
});

test("every kept outcome crosses the contract", async () => {
  const h = setup();
  const answers: WorkspaceActionResult<unknown, RunCreationFailure>[] = [
    { ok: true, value: created() },
    workspaceActionFailed("unknown"),
    workspaceActionFailed("rate_limited", 30_000),
    workspaceActionSent(
      workspaceActionFailedFor(
        { ok: false, reason: "refused", code: "run_limit" },
        "createRun",
      ),
    ),
  ];
  for (const [index, result] of answers.entries()) {
    const answer = h.service.request(REQUEST);
    h.sent[index]?.resolve(result);
    await answer;
    const kept = await h.service.takeOutcome(PROJECT);
    expect(RunRequestOutcomeSchema.parse(kept)).toEqual(kept);
  }
});
