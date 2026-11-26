import type {
  Capability,
  ChatMessage,
  MessageId,
  ProjectId,
  RepositoryId,
  WorkspaceId,
} from "@mymandev/protocol";
import { type GrantRecord, GrantRecordSchema } from "@mymandev/permissions";
import { expect, test } from "vitest";
import type { WorkspaceReadResult } from "../api-reads.ts";
import {
  createPermissionEnforcement,
  type EnforcementRecord,
  type HeldRun,
} from "../permissions/enforcement.ts";
import type { RepositoryFolderResolution } from "../repository-links/service.ts";
import type { DeviceSessionState } from "../session/session.ts";
import type {
  RepositoryFileListOutcome,
  RepositoryFileLister,
} from "../tools/repository-files.ts";
import type { ToolRunContext } from "../tools/tool-dispatcher.ts";
import {
  createRunContextBuilder,
  RUN_CONTEXT_FAILURES,
  RUN_CONTEXT_REPOSITORY_OMISSIONS,
  type RunContextInput,
} from "./run-context.ts";
import type { RunActionCheck } from "./run-executor.ts";

const RUN_ID = "0192f0a0-7b3c-7d4e-8f50-000000000001";
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000002";
const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const PROJECT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000006" as ProjectId;
const OTHER_PROJECT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000016" as ProjectId;
const WORKSPACE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000007" as WorkspaceId;
const USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000008";
const REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009";
const OTHER_REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000a";
const PROVIDER_CONNECTION_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000b";
const MESSAGE_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000c" as MessageId;
const OTHER_MESSAGE_ID = "0192f0a0-7b3c-7d4e-8f50-00000000001c" as MessageId;
const MEMBER_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000d";
const NOW = Date.parse("2026-11-26T12:00:00.000Z");

const FOLDER = "/home/octocat/secret-web";
const IDENTITY = Object.freeze({ dev: "2049", ino: "131" });

const RUN: HeldRun = Object.freeze({
  runId: RUN_ID,
  agentId: AGENT_ID,
  hostDeviceId: DEVICE_ID,
  repositoryId: REPOSITORY_ID,
  providerConnectionId: PROVIDER_CONNECTION_ID,
}) as HeldRun;

const MESSAGE: ChatMessage = Object.freeze({
  id: MESSAGE_ID,
  projectId: PROJECT_ID,
  seq: 12,
  author: { kind: "member", memberId: MEMBER_ID },
  body: "Explain the build.",
  createdAt: "2026-11-26T11:00:00.000Z",
}) as ChatMessage;

const LISTED: RepositoryFileListOutcome = Object.freeze({
  ok: true,
  files: Object.freeze(["README.md", "src/index.ts"]),
  truncated: false,
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function allowRepoRead(): RunActionCheck {
  return {
    allowed: true,
    request: {
      agentId: AGENT_ID,
      capability: "repo.read",
      repositoryId: REPOSITORY_ID,
    } as never,
    end: () => undefined,
  };
}

function setup(
  options: {
    decide?: (request: unknown) => unknown;
    message?: () => Promise<WorkspaceReadResult<{ message: ChatMessage }>>;
    resolve?: () => Promise<RepositoryFolderResolution>;
    list?: (context: ToolRunContext) => Promise<RepositoryFileListOutcome>;
    run?: HeldRun;
    inputMessageId?: MessageId | null;
  } = {},
) {
  const reads: [string, unknown][] = [];
  const requests: unknown[] = [];
  const resolutions: RepositoryId[] = [];
  const listings: ToolRunContext[] = [];
  let ends = 0;
  const builder = createRunContextBuilder({
    account: {
      readWorkspaceData: (async (name: string, params: unknown) => {
        reads.push([name, params]);
        return options.message === undefined
          ? { ok: true, value: { message: MESSAGE } }
          : options.message();
      }) as never,
    },
    resolveFolder: async (repositoryId) => {
      resolutions.push(repositoryId);
      return options.resolve === undefined
        ? { ok: true, repositoryId, folder: FOLDER, identity: IDENTITY }
        : options.resolve();
    },
    listFiles: (async (context: ToolRunContext) => {
      listings.push(context);
      return options.list === undefined ? LISTED : options.list(context);
    }) as RepositoryFileLister,
  });
  const decide = options.decide ?? (() => allowRepoRead());
  const check = (request: unknown): RunActionCheck => {
    requests.push(request);
    const decision = decide(request) as RunActionCheck;
    if (decision.allowed) {
      return {
        ...decision,
        end: () => {
          ends += 1;
        },
      };
    }
    return decision;
  };
  const controller = new AbortController();
  const input: RunContextInput = {
    run: options.run ?? RUN,
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    inputMessageId:
      options.inputMessageId === undefined
        ? MESSAGE_ID
        : options.inputMessageId,
    check,
    signal: controller.signal,
  };
  return {
    builder,
    input,
    controller,
    reads,
    requests,
    resolutions,
    listings,
    get ends() {
      return ends;
    },
  };
}

test("the failures and the omissions are closed lists of codes", () => {
  expect(RUN_CONTEXT_FAILURES).toEqual([
    "aborted",
    "message_missing",
    "message_not_found",
    "message_unavailable",
    "context_failed",
  ]);
  expect(RUN_CONTEXT_REPOSITORY_OMISSIONS).toEqual([
    "no_repository",
    "denied",
    "unavailable",
  ]);
  for (const code of RUN_CONTEXT_FAILURES) {
    expect(code).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  }
});

test("with repo.read granted, the context holds the message, the project, and the file list; exactly repo.read is checked and held until the list settled", async () => {
  const harness = setup();
  const result = await harness.builder.build(harness.input);
  expect(result).toEqual({
    ok: true,
    context: {
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      message: {
        id: MESSAGE_ID,
        seq: 12,
        body: "Explain the build.",
        createdAt: "2026-11-26T11:00:00.000Z",
      },
      repository: {
        included: true,
        repositoryId: REPOSITORY_ID,
        files: ["README.md", "src/index.ts"],
        truncated: false,
      },
    },
  });
  expect(harness.reads).toEqual([
    ["getMessage", { projectId: PROJECT_ID, messageId: MESSAGE_ID }],
  ]);
  expect(harness.requests).toEqual([
    { agentId: AGENT_ID, capability: "repo.read", repositoryId: REPOSITORY_ID },
  ]);
  expect(harness.resolutions).toEqual([REPOSITORY_ID]);
  expect(harness.listings).toHaveLength(1);
  expect(harness.listings[0]?.folder).toBe(FOLDER);
  expect(harness.listings[0]?.folderIdentity).toEqual(IDENTITY);
  expect(harness.listings[0]?.signal).toBe(harness.input.signal);
  expect(harness.ends).toBe(1);
  // Plain, frozen data without the folder.
  expect(Object.isFrozen(result)).toBe(true);
  if (!result.ok) {
    throw new Error("the build failed");
  }
  expect(Object.isFrozen(result.context)).toBe(true);
  expect(Object.isFrozen(result.context.repository)).toBe(true);
  expect(JSON.stringify(result.context)).not.toContain("octocat");
});

test("without repo.read, the context holds the message and the project only, and no folder is resolved or listed", async () => {
  const harness = setup({
    decide: () => ({ allowed: false, reason: "no_grant" }),
  });
  const result = await harness.builder.build(harness.input);
  expect(result).toEqual({
    ok: true,
    context: {
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      message: {
        id: MESSAGE_ID,
        seq: 12,
        body: "Explain the build.",
        createdAt: "2026-11-26T11:00:00.000Z",
      },
      repository: { included: false, reason: "denied" },
    },
  });
  expect(harness.resolutions).toEqual([]);
  expect(harness.listings).toEqual([]);
  expect(harness.ends).toBe(0);
});

test("a check that throws or answers no decision, and an allowed decision for another capability or repository, leave the repository out", async () => {
  const decisions: (() => unknown)[] = [
    () => {
      throw new Error("check");
    },
    () => null,
    () => "allowed",
    () => ({ allowed: "yes" }),
    () => ({ allowed: false, reason: "store_unusable" }),
    () => ({
      allowed: true,
      request: {
        agentId: AGENT_ID,
        capability: "repo.write",
        repositoryId: REPOSITORY_ID,
      },
    }),
    () => ({
      allowed: true,
      request: {
        agentId: AGENT_ID,
        capability: "repo.read",
        repositoryId: OTHER_REPOSITORY_ID,
      },
    }),
    () => ({
      allowed: true,
      request: {
        agentId: AGENT_ID,
        capability: "repo.read",
      },
    }),
  ];
  for (const [index, decide] of decisions.entries()) {
    const harness = setup({ decide });
    const result = await harness.builder.build(harness.input);
    expect(result.ok && result.context.repository, String(index)).toEqual({
      included: false,
      reason: "denied",
    });
    expect(harness.resolutions, String(index)).toEqual([]);
    expect(harness.listings, String(index)).toEqual([]);
  }
});

test("a run without a repository checks nothing and says so", async () => {
  const harness = setup({
    run: Object.freeze({ ...RUN, repositoryId: null }) as HeldRun,
  });
  const result = await harness.builder.build(harness.input);
  expect(result.ok && result.context.repository).toEqual({
    included: false,
    reason: "no_repository",
  });
  expect(harness.requests).toEqual([]);
  expect(harness.resolutions).toEqual([]);
});

test("a folder that does not resolve, and a list that fails or throws, leave the repository out; the held action ends", async () => {
  const cases: Parameters<typeof setup>[0][] = [
    { resolve: async () => ({ ok: false, reason: "not_linked" }) as never },
    {
      resolve: async () => {
        throw new Error(FOLDER);
      },
    },
    { list: async () => ({ ok: false, reason: "failed" }) },
    {
      list: async () => {
        throw new Error(FOLDER);
      },
    },
    { list: async () => null as never },
  ];
  for (const [index, options] of cases.entries()) {
    const harness = setup(options);
    const result = await harness.builder.build(harness.input);
    expect(result.ok && result.context.repository, String(index)).toEqual({
      included: false,
      reason: "unavailable",
    });
    expect(harness.ends, String(index)).toBe(1);
  }
});

test("a list with a path that is absolute, leaves the repository, names .git or a hidden name, repeats, or holds the folder is left out as a whole", async () => {
  const lists: unknown[][] = [
    [`${FOLDER}/README.md`],
    ["/etc/passwd"],
    ["C:/Users/octocat/a.txt"],
    ["src\\index.ts"],
    ["../outside.txt"],
    ["src/../../outside.txt"],
    [".git/config"],
    [".env"],
    ["."],
    [""],
    ["README.md", "README.md"],
    [7],
    // A relative path that holds the folder's text.
    ["a/home/octocat/secret-web/b.txt"],
    ["a/HOME/OCTOCAT/SECRET-WEB/b.txt"],
  ];
  for (const files of lists) {
    const harness = setup({
      list: async () =>
        ({ ok: true, files, truncated: false }) as RepositoryFileListOutcome,
    });
    const result = await harness.builder.build(harness.input);
    expect(
      result.ok && result.context.repository,
      JSON.stringify(files),
    ).toEqual({ included: false, reason: "unavailable" });
  }
});

test("a lister that gives more than 1,000 files is cut to the first 1,000 in order, and the context says so", async () => {
  const files = Array.from(
    { length: 1_001 },
    (_, index) => `f${String(1_000 - index).padStart(4, "0")}.txt`,
  );
  const harness = setup({
    list: async () => ({ ok: true, files, truncated: false }),
  });
  const result = await harness.builder.build(harness.input);
  if (!result.ok || !result.context.repository.included) {
    throw new Error("the repository is missing");
  }
  expect(result.context.repository.files).toHaveLength(1_000);
  expect(result.context.repository.files[0]).toBe("f0000.txt");
  expect(result.context.repository.files.at(-1)).toBe("f0999.txt");
  expect(result.context.repository.truncated).toBe(true);

  const exact = setup({
    list: async () => ({ ok: true, files: files.slice(1), truncated: false }),
  });
  const whole = await exact.builder.build(exact.input);
  expect(
    whole.ok &&
      whole.context.repository.included &&
      whole.context.repository.truncated,
  ).toBe(false);

  const cut = setup({
    list: async () => ({ ok: true, files: ["a.txt"], truncated: true }),
  });
  const marked = await cut.builder.build(cut.input);
  expect(marked.ok && marked.context.repository).toEqual({
    included: true,
    repositoryId: REPOSITORY_ID,
    files: ["a.txt"],
    truncated: true,
  });
});

test("a run without an input message, or whose message cannot be read or is another one, has no context", async () => {
  const missing = setup({ inputMessageId: null });
  expect(await missing.builder.build(missing.input)).toEqual({
    ok: false,
    reason: "message_missing",
  });
  expect(missing.reads).toEqual([]);
  expect(missing.requests).toEqual([]);

  type Answer = () => Promise<WorkspaceReadResult<{ message: ChatMessage }>>;
  const cases: [Answer, string][] = [
    [async () => ({ ok: false, reason: "not_found" }), "message_not_found"],
    [async () => ({ ok: false, reason: "unavailable" }), "message_unavailable"],
    [
      async () => ({ ok: false, reason: "not_signed_in" }),
      "message_unavailable",
    ],
    [async () => ({ ok: false, reason: "failed" }), "message_unavailable"],
    [
      async () => {
        throw new Error("read");
      },
      "message_unavailable",
    ],
    [
      async () => ({
        ok: true,
        value: { message: { ...MESSAGE, id: OTHER_MESSAGE_ID } },
      }),
      "message_unavailable",
    ],
    [
      async () => ({
        ok: true,
        value: { message: { ...MESSAGE, projectId: OTHER_PROJECT_ID } },
      }),
      "message_unavailable",
    ],
  ];
  for (const [message, reason] of cases) {
    const harness = setup({ message });
    expect(await harness.builder.build(harness.input), reason).toEqual({
      ok: false,
      reason,
    });
    // Nothing of the repository is read without a message.
    expect(harness.requests).toEqual([]);
  }
});

test("an abort before the build, during the message read, the resolution, or the list fails the build as aborted, and the held action ends once the list settled", async () => {
  const before = setup();
  before.controller.abort();
  expect(await before.builder.build(before.input)).toEqual({
    ok: false,
    reason: "aborted",
  });
  expect(before.reads).toEqual([]);

  const reading = deferred<WorkspaceReadResult<{ message: ChatMessage }>>();
  const duringRead = setup({ message: () => reading.promise });
  const read = duringRead.builder.build(duringRead.input);
  duringRead.controller.abort();
  expect(await read).toEqual({ ok: false, reason: "aborted" });
  expect(duringRead.requests).toEqual([]);

  const resolving = deferred<RepositoryFolderResolution>();
  const duringResolve = setup({ resolve: () => resolving.promise });
  const resolved = duringResolve.builder.build(duringResolve.input);
  await new Promise((done) => setTimeout(done, 0));
  duringResolve.controller.abort();
  expect(await resolved).toEqual({ ok: false, reason: "aborted" });
  expect(duringResolve.ends).toBe(1);
  expect(duringResolve.listings).toEqual([]);

  const listing = deferred<RepositoryFileListOutcome>();
  const duringList = setup({ list: () => listing.promise });
  const listed = duringList.builder.build(duringList.input);
  await new Promise((done) => setTimeout(done, 0));
  duringList.controller.abort();
  expect(await listed).toEqual({ ok: false, reason: "aborted" });
  // Held until the lister settled, also after the abort.
  expect(duringList.ends).toBe(0);
  listing.resolve(LISTED);
  await new Promise((done) => setTimeout(done, 0));
  expect(duringList.ends).toBe(1);

  const lister = setup({
    list: async () => ({ ok: false, reason: "aborted" }),
  });
  expect(await lister.builder.build(lister.input)).toEqual({
    ok: false,
    reason: "aborted",
  });
});

// Through the real enforcement point.

function grant(
  capability: Capability,
  repositoryId: string,
  index = 0,
): GrantRecord {
  return GrantRecordSchema.parse({
    grant: {
      id: `0192f0a0-7b3c-7d4e-8f50-0000000001${index.toString(16).padStart(2, "0")}`,
      projectId: PROJECT_ID,
      granteeAgentId: AGENT_ID,
      capability,
      repositoryId,
      grantedByUserId: USER_ID,
      createdAt: "2026-11-25T10:00:00.000Z",
      expiresAt: null,
      revokedAt: null,
      revokedByUserId: null,
    },
    facts: {
      agent: { id: AGENT_ID, hostDeviceId: DEVICE_ID, disabledAt: null },
      hostDevice: { id: DEVICE_ID, revokedAt: null },
      project: { id: PROJECT_ID, workspaceId: WORKSPACE_ID },
      grantorMembership: {
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        removedAt: null,
      },
      providerConnection: null,
    },
  });
}

function realSetup(records: readonly GrantRecord[]) {
  const recorded: EnforcementRecord[] = [];
  const enforcement = createPermissionEnforcement({
    now: () => new Date(NOW),
    grantStore: { read: () => ({ usable: true, records }) },
    sessionState: () =>
      ({
        kind: "signed_in",
        account: {
          deviceId: DEVICE_ID,
          userId: USER_ID,
          login: "octocat",
          displayName: "The Octocat",
          signInExpiresAt: "2026-12-25T12:00:00.000Z",
        },
      }) as unknown as DeviceSessionState,
    thisDevice: () => DEVICE_ID as never,
    recorder: {
      record: (entry) => {
        recorded.push(entry);
        return undefined;
      },
    },
  });
  const harness = setup({
    decide: (request) => enforcement.check(RUN, request),
  });
  return { ...harness, recorded };
}

test("through the real enforcement point: a grant of repo.read includes the list; every other grant on the repository, and repo.read on another repository, leave it out and are recorded as a denial", async () => {
  const granted = realSetup([grant("repo.read", REPOSITORY_ID)]);
  const included = await granted.builder.build(granted.input);
  expect(included.ok && included.context.repository.included).toBe(true);
  expect(granted.recorded).toEqual([]);

  const others = (
    ["repo.write", "terminal.execute", "git.commit", "git.push"] as const
  ).map((capability, index) => grant(capability, REPOSITORY_ID, index + 1));
  const denied = realSetup([
    ...others,
    grant("repo.read", OTHER_REPOSITORY_ID, 9),
  ]);
  const result = await denied.builder.build(denied.input);
  expect(result.ok && result.context.repository).toEqual({
    included: false,
    reason: "denied",
  });
  expect(denied.listings).toEqual([]);
  expect(denied.resolutions).toEqual([]);
  expect(denied.recorded).toEqual([
    {
      kind: "denied",
      reason: "no_grant",
      capability: "repo.read",
      runId: RUN_ID,
      agentId: AGENT_ID,
      repositoryId: REPOSITORY_ID,
      providerConnectionId: PROVIDER_CONNECTION_ID,
      at: new Date(NOW).toISOString(),
    },
  ]);
});
