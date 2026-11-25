import {
  CAPABILITIES,
  type Capability,
  type RepositoryId,
} from "@mymandev/protocol";
import { type GrantRecord, GrantRecordSchema } from "@mymandev/permissions";
import { expect, test } from "vitest";
import * as z from "zod";
import type { RunActionCheck } from "../agents/run-executor.ts";
import {
  createPermissionEnforcement,
  type EnforcementRecord,
  type HeldRun,
  type PermissionEnforcement,
} from "../permissions/enforcement.ts";
import type { RepositoryFolderResolution } from "../repository-links/service.ts";
import type { DeviceSessionState } from "../session/session.ts";
import {
  createToolDispatcher,
  createToolRegistry,
  defineTool,
  MAX_TOOL_ANSWER_BYTES,
  MAX_TOOL_INPUT_BYTES,
  type Tool,
  type ToolCallContext,
  type ToolRunContext,
  type ToolRunOutcome,
  TOOL_CALL_REFUSALS,
} from "./tool-dispatcher.ts";

const RUN_ID = "0192f0a0-7b3c-7d4e-8f50-000000000001";
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000002";
const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const PROJECT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000006";
const WORKSPACE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000007";
const USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000008";
const REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009";
const OTHER_REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000a";
const PROVIDER_CONNECTION_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000b";
const NOW = Date.parse("2026-11-25T12:00:00.000Z");

const FOLDER = "/home/octocat/secret-web";
const IDENTITY = Object.freeze({ dev: "2049", ino: "131" });

const RUN: HeldRun = Object.freeze({
  runId: RUN_ID,
  agentId: AGENT_ID,
  hostDeviceId: DEVICE_ID,
  repositoryId: REPOSITORY_ID,
  providerConnectionId: PROVIDER_CONNECTION_ID,
}) as HeldRun;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

/** A test tool that notes its runs and answers what the test sets. */
function probeTool(
  name: string,
  capability: Capability = "repo.read",
  answer: (
    input: { value: string },
    context: ToolRunContext,
  ) => Promise<ToolRunOutcome> = async (input) => ({
    ok: true,
    result: { echo: input.value },
  }),
) {
  const runs: { input: { value: string }; context: ToolRunContext }[] = [];
  const tool = defineTool({
    name,
    capability,
    input: z.strictObject({ value: z.string() }),
    run: (input, context) => {
      runs.push({ input, context });
      return answer(input, context);
    },
  });
  return { tool, runs };
}

/** A fake `RunExecution.check` that notes every request and every end. */
function fakeCheck(decide: (request: unknown) => RunActionCheck | unknown) {
  const requests: unknown[] = [];
  let ends = 0;
  const check = (request: unknown): RunActionCheck => {
    requests.push(request);
    const decision = decide(request);
    if (
      typeof decision === "object" &&
      decision !== null &&
      (decision as { allowed?: unknown }).allowed === true &&
      !("end" in decision)
    ) {
      return {
        ...(decision as object),
        end: () => {
          ends += 1;
        },
      } as RunActionCheck;
    }
    return decision as RunActionCheck;
  };
  return {
    check,
    requests,
    get ends() {
      return ends;
    },
  };
}

function allowRepo(capability: Capability = "repo.read") {
  return () => ({
    allowed: true,
    request: { agentId: AGENT_ID, capability, repositoryId: REPOSITORY_ID },
  });
}

function setup(
  tools: readonly Tool[],
  options: {
    decide?: (request: unknown) => unknown;
    resolve?: (
      repositoryId: RepositoryId,
    ) => Promise<RepositoryFolderResolution>;
  } = {},
) {
  const resolutions: RepositoryId[] = [];
  const dispatcher = createToolDispatcher({
    registry: createToolRegistry(tools),
    resolveFolder: async (repositoryId) => {
      resolutions.push(repositoryId);
      return options.resolve === undefined
        ? { ok: true, repositoryId, folder: FOLDER, identity: IDENTITY }
        : options.resolve(repositoryId);
    },
  });
  const checker = fakeCheck(options.decide ?? allowRepo());
  const controller = new AbortController();
  const context: ToolCallContext = {
    run: RUN,
    check: checker.check,
    signal: controller.signal,
  };
  return { dispatcher, checker, controller, context, resolutions };
}

test("the refusal codes are a closed list", () => {
  expect(TOOL_CALL_REFUSALS).toEqual([
    "unknown_tool",
    "aborted",
    "denied",
    "invalid_input",
    "repository_unavailable",
    "path_refused",
    "not_found",
    "not_a_file",
    "not_a_directory",
    "read_failed",
    "answer_too_large",
    "answer_has_path",
    "tool_failed",
  ]);
  expect(Object.isFrozen(TOOL_CALL_REFUSALS)).toBe(true);
});

test("an allowed call checks exactly the tool's capability for the run's agent and repository, then resolves the folder and runs the tool, and ends the held action", async () => {
  const probe = probeTool("probe");
  const harness = setup([probe.tool]);
  const answer = await harness.dispatcher.call(harness.context, "probe", {
    value: "hello",
  });
  expect(answer).toEqual({
    ok: true,
    tool: "probe",
    result: { echo: "hello" },
  });
  expect(harness.checker.requests).toEqual([
    { agentId: AGENT_ID, capability: "repo.read", repositoryId: REPOSITORY_ID },
  ]);
  expect(harness.resolutions).toEqual([REPOSITORY_ID]);
  expect(probe.runs).toHaveLength(1);
  expect(probe.runs[0]?.context.folder).toBe(FOLDER);
  expect(probe.runs[0]?.context.folderIdentity).toEqual(IDENTITY);
  expect(probe.runs[0]?.context.signal).toBe(harness.controller.signal);
  await settle();
  expect(harness.checker.ends).toBe(1);
});

test("every call is checked again: nothing is cached between calls", async () => {
  const probe = probeTool("probe");
  let allow = true;
  const harness = setup([probe.tool], {
    decide: () =>
      allow ? allowRepo()() : { allowed: false, reason: "no_grant" },
  });
  expect(
    (await harness.dispatcher.call(harness.context, "probe", { value: "a" }))
      .ok,
  ).toBe(true);
  allow = false;
  expect(
    await harness.dispatcher.call(harness.context, "probe", { value: "a" }),
  ).toEqual({ ok: false, code: "denied", reason: "no_grant" });
  expect(harness.checker.requests).toHaveLength(2);
  expect(probe.runs).toHaveLength(1);
});

test("a denial runs nothing and resolves no folder, whatever the reason", async () => {
  for (const reason of [
    "no_grant",
    "signed_out",
    "store_unusable",
    "no_scope",
  ]) {
    const probe = probeTool("probe");
    const harness = setup([probe.tool], {
      decide: () => ({ allowed: false, reason }),
    });
    expect(
      await harness.dispatcher.call(harness.context, "probe", { value: "x" }),
    ).toEqual({ ok: false, code: "denied", reason });
    expect(probe.runs).toEqual([]);
    expect(harness.resolutions).toEqual([]);
  }
});

test("a check that throws or answers no decision denies with check_failed and runs nothing", async () => {
  for (const decide of [
    () => {
      throw new Error("check failed");
    },
    () => undefined,
    () => null,
    () => "allowed",
    () => ({ allowed: "yes" }),
    () => ({}),
  ]) {
    const probe = probeTool("probe");
    const harness = setup([probe.tool], { decide });
    expect(
      await harness.dispatcher.call(harness.context, "probe", { value: "x" }),
    ).toEqual({ ok: false, code: "denied", reason: "check_failed" });
    expect(probe.runs).toEqual([]);
    expect(harness.resolutions).toEqual([]);
  }
});

test("an allowed decision for another capability or another repository is not acted on", async () => {
  for (const request of [
    {
      agentId: AGENT_ID,
      capability: "repo.write",
      repositoryId: REPOSITORY_ID,
    },
    {
      agentId: AGENT_ID,
      capability: "repo.read",
      repositoryId: OTHER_REPOSITORY_ID,
    },
    {
      agentId: AGENT_ID,
      capability: "provider.use",
      providerConnectionId: PROVIDER_CONNECTION_ID,
    },
  ]) {
    const probe = probeTool("probe");
    const harness = setup([probe.tool], {
      decide: () => ({ allowed: true, request }),
    });
    expect(
      await harness.dispatcher.call(harness.context, "probe", { value: "x" }),
    ).toEqual({ ok: false, code: "denied", reason: "check_failed" });
    expect(probe.runs).toEqual([]);
    expect(harness.resolutions).toEqual([]);
    expect(harness.checker.ends).toBe(1);
  }
});

test("an unknown tool is refused before any check, also a name of the object prototype", async () => {
  const probe = probeTool("probe");
  const harness = setup([probe.tool]);
  for (const name of [
    "Probe",
    "probe ",
    "read_file",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "",
    7,
    null,
    undefined,
    { name: "probe" },
    ["probe"],
  ]) {
    expect(
      await harness.dispatcher.call(harness.context, name, { value: "x" }),
      String(name),
    ).toEqual({ ok: false, code: "unknown_tool" });
  }
  expect(harness.checker.requests).toEqual([]);
  expect(probe.runs).toEqual([]);
});

test("an invalid input is refused with invalid_input after the check, runs nothing, and ends the held action", async () => {
  const probe = probeTool("probe");
  const harness = setup([probe.tool]);
  const inputs: unknown[] = [
    undefined,
    null,
    "x",
    [],
    {},
    { value: 7 },
    { value: "x", extra: true },
    { value: "x", path: "/etc/passwd" },
    Object.create({ value: "inherited" }) as unknown,
    { value: "x".repeat(MAX_TOOL_INPUT_BYTES) },
    { value: 1n },
  ];
  for (const input of inputs) {
    expect(
      await harness.dispatcher.call(harness.context, "probe", input),
      String(input),
    ).toEqual({ ok: false, code: "invalid_input" });
  }
  expect(probe.runs).toEqual([]);
  expect(harness.resolutions).toEqual([]);
  expect(harness.checker.requests).toHaveLength(inputs.length);
  expect(harness.checker.ends).toBe(inputs.length);
});

test("an input whose getter throws is invalid, never a failure of the call", async () => {
  const probe = probeTool("probe");
  const harness = setup([probe.tool]);
  const input = {
    get value(): string {
      throw new Error("getter");
    },
  };
  expect(
    await harness.dispatcher.call(harness.context, "probe", input),
  ).toEqual({
    ok: false,
    code: "invalid_input",
  });
  expect(probe.runs).toEqual([]);
});

test("a repository that does not resolve runs nothing, with the resolution's reason", async () => {
  for (const reason of [
    "not_linked",
    "nested_link",
    "changed_folder",
  ] as const) {
    const probe = probeTool("probe");
    const harness = setup([probe.tool], {
      resolve: async () => ({ ok: false, reason }),
    });
    expect(
      await harness.dispatcher.call(harness.context, "probe", { value: "x" }),
    ).toEqual({ ok: false, code: "repository_unavailable", reason });
    expect(probe.runs).toEqual([]);
    expect(harness.checker.ends).toBe(1);
  }
  const probe = probeTool("probe");
  const harness = setup([probe.tool], {
    resolve: () => Promise.reject(new Error(FOLDER)),
  });
  expect(
    await harness.dispatcher.call(harness.context, "probe", { value: "x" }),
  ).toEqual({
    ok: false,
    code: "repository_unavailable",
    reason: "unavailable",
  });
  expect(probe.runs).toEqual([]);
});

test("an aborted run checks nothing and runs nothing", async () => {
  const probe = probeTool("probe");
  const harness = setup([probe.tool]);
  harness.controller.abort();
  expect(
    await harness.dispatcher.call(harness.context, "probe", { value: "x" }),
  ).toEqual({ ok: false, code: "aborted" });
  expect(harness.checker.requests).toEqual([]);
  expect(probe.runs).toEqual([]);
});

test("an abort while the folder resolves runs nothing and ends the held action", async () => {
  const probe = probeTool("probe");
  const resolution = deferred<RepositoryFolderResolution>();
  const harness = setup([probe.tool], { resolve: () => resolution.promise });
  const answer = harness.dispatcher.call(harness.context, "probe", {
    value: "x",
  });
  await settle();
  harness.controller.abort();
  resolution.resolve({
    ok: true,
    repositoryId: REPOSITORY_ID as RepositoryId,
    folder: FOLDER,
    identity: IDENTITY,
  });
  expect(await answer).toEqual({ ok: false, code: "aborted" });
  expect(probe.runs).toEqual([]);
  expect(harness.checker.ends).toBe(1);
});

test("an abort while the folder resolution hangs answers aborted at once and ends the held action; a late resolution runs nothing", async () => {
  for (const settleLate of [
    (resolution: Deferred<RepositoryFolderResolution>) =>
      resolution.resolve({
        ok: true,
        repositoryId: REPOSITORY_ID as RepositoryId,
        folder: FOLDER,
        identity: IDENTITY,
      }),
    (resolution: Deferred<RepositoryFolderResolution>) =>
      resolution.reject(new Error(FOLDER)),
  ]) {
    const probe = probeTool("probe");
    const resolution = deferred<RepositoryFolderResolution>();
    const harness = setup([probe.tool], { resolve: () => resolution.promise });
    let answered: unknown = "pending";
    void harness.dispatcher
      .call(harness.context, "probe", { value: "x" })
      .then((answer) => {
        answered = answer;
      });
    await settle();
    expect(harness.resolutions).toEqual([REPOSITORY_ID]);
    expect(answered).toBe("pending");
    // The resolution never settles before the abort is answered.
    harness.controller.abort();
    await settle();
    expect(answered).toEqual({ ok: false, code: "aborted" });
    expect(harness.checker.ends).toBe(1);
    settleLate(resolution);
    await settle();
    expect(probe.runs).toEqual([]);
    expect(harness.checker.ends).toBe(1);
  }
});

test("an abort while the tool runs answers aborted at once; the held action ends only when the tool settled, and its late answer is dropped", async () => {
  const work = deferred<ToolRunOutcome>();
  const probe = probeTool("probe", "repo.read", () => work.promise);
  const harness = setup([probe.tool]);
  const answer = harness.dispatcher.call(harness.context, "probe", {
    value: "x",
  });
  await settle();
  expect(probe.runs).toHaveLength(1);
  harness.controller.abort();
  expect(await answer).toEqual({ ok: false, code: "aborted" });
  expect(harness.checker.ends).toBe(0);
  work.resolve({ ok: true, result: { late: true } });
  await settle();
  expect(harness.checker.ends).toBe(1);
});

test("a tool that settles after an abort with a rejection leaves nothing unhandled", async () => {
  const work = deferred<ToolRunOutcome>();
  const probe = probeTool("probe", "repo.read", () => work.promise);
  const harness = setup([probe.tool]);
  const answer = harness.dispatcher.call(harness.context, "probe", {
    value: "x",
  });
  await settle();
  harness.controller.abort();
  expect(await answer).toEqual({ ok: false, code: "aborted" });
  work.reject(new Error(FOLDER));
  await settle();
  expect(harness.checker.ends).toBe(1);
});

test("a tool that throws, rejects, or answers something else fails with tool_failed and never shows its error", async () => {
  const answers: (() => Promise<ToolRunOutcome>)[] = [
    () => {
      throw new Error(FOLDER);
    },
    () => Promise.reject(new Error(FOLDER)),
    () => Promise.resolve(undefined as unknown as ToolRunOutcome),
    () =>
      Promise.resolve({
        ok: false,
        code: "denied",
      } as unknown as ToolRunOutcome),
    () =>
      Promise.resolve({
        ok: false,
        code: "made_up",
      } as unknown as ToolRunOutcome),
    () => Promise.resolve({ ok: true, result: { big: 1n } }),
    () => Promise.resolve({ ok: true, result: undefined }),
  ];
  for (const run of answers) {
    const probe = probeTool("probe", "repo.read", run);
    const harness = setup([probe.tool]);
    const answer = await harness.dispatcher.call(harness.context, "probe", {
      value: "x",
    });
    expect(answer).toEqual({ ok: false, code: "tool_failed" });
    await settle();
    expect(harness.checker.ends).toBe(1);
  }
});

test("a tool's own refusal passes with its reason", async () => {
  const probe = probeTool("probe", "repo.read", async () => ({
    ok: false,
    code: "path_refused",
    reason: "outside",
  }));
  const harness = setup([probe.tool]);
  expect(
    await harness.dispatcher.call(harness.context, "probe", { value: "x" }),
  ).toEqual({ ok: false, code: "path_refused", reason: "outside" });
});

test("an answer larger than the bound is refused; one at the bound passes", async () => {
  // `{"s":"..."}` is 8 bytes around the text.
  const atBound = "a".repeat(MAX_TOOL_ANSWER_BYTES - 8);
  for (const [text, ok] of [
    [atBound, true],
    [`${atBound}a`, false],
    // Two bytes in UTF-8 for each character.
    ["\u00e9".repeat(MAX_TOOL_ANSWER_BYTES / 2), false],
  ] as const) {
    const probe = probeTool("probe", "repo.read", async () => ({
      ok: true,
      result: { s: text },
    }));
    const harness = setup([probe.tool]);
    const answer = await harness.dispatcher.call(harness.context, "probe", {
      value: "x",
    });
    expect(answer.ok).toBe(ok);
    if (!ok) {
      expect(answer).toEqual({ ok: false, code: "answer_too_large" });
    }
  }
});

test("an answer that holds the repository's folder is refused, in any case and with either separator", async () => {
  for (const leaked of [
    FOLDER,
    `${FOLDER}/src/index.ts`,
    FOLDER.toUpperCase(),
    FOLDER.replaceAll("/", "\\"),
    `see ${FOLDER} here`,
  ]) {
    const probe = probeTool("probe", "repo.read", async () => ({
      ok: true,
      result: { nested: { list: [leaked] } },
    }));
    const harness = setup([probe.tool]);
    expect(
      await harness.dispatcher.call(harness.context, "probe", { value: "x" }),
      leaked,
    ).toEqual({ ok: false, code: "answer_has_path" });
  }
  // A Windows folder, written with backslashes.
  const windowsFolder = "C:\\Users\\octocat\\secret-web";
  for (const leaked of [windowsFolder, "c:/users/octocat/secret-web/a.ts"]) {
    const probe = probeTool("probe", "repo.read", async () => ({
      ok: true,
      result: { path: leaked },
    }));
    const harness = setup([probe.tool], {
      resolve: async (repositoryId) => ({
        ok: true,
        repositoryId,
        folder: windowsFolder,
        identity: IDENTITY,
      }),
    });
    expect(
      await harness.dispatcher.call(harness.context, "probe", { value: "x" }),
      leaked,
    ).toEqual({ ok: false, code: "answer_has_path" });
  }
});

test("the answer is a plain JSON copy of the tool's result", async () => {
  const result = { list: [1, "two", { three: null }], when: new Date(NOW) };
  const probe = probeTool("probe", "repo.read", async () => ({
    ok: true,
    result,
  }));
  const harness = setup([probe.tool]);
  const answer = await harness.dispatcher.call(harness.context, "probe", {
    value: "x",
  });
  expect(answer).toEqual({
    ok: true,
    tool: "probe",
    result: {
      list: [1, "two", { three: null }],
      when: new Date(NOW).toISOString(),
    },
  });
  expect(answer.ok && answer.result).not.toBe(result);
  expect(Object.isFrozen(answer)).toBe(true);
});

test("the registry refuses a malformed name, a name given twice, and a capability that is not scoped to a repository", () => {
  for (const name of [
    "",
    "Read",
    "read-file",
    "read.file",
    "1read",
    "a".repeat(65),
  ]) {
    expect(() => createToolRegistry([probeTool(name).tool]), name).toThrow(
      "TOOL_NAME_PATTERN",
    );
  }
  expect(() =>
    createToolRegistry([probeTool("probe").tool, probeTool("probe").tool]),
  ).toThrow("same name");
  for (const capability of ["provider.use", "repo.admin", "toString"]) {
    expect(
      () =>
        createToolRegistry([probeTool("probe", capability as Capability).tool]),
      capability,
    ).toThrow("not scoped to a repository");
  }
  const registry = createToolRegistry([
    probeTool("probe").tool,
    probeTool("other", "repo.write").tool,
  ]);
  expect(registry.names()).toEqual(["probe", "other"]);
  expect(Object.isFrozen(registry)).toBe(true);
});

// Through the real enforcement point.

function grant(
  capability: Capability,
  repositoryId: string = REPOSITORY_ID,
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

function realEnforcement(records: readonly GrantRecord[]) {
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
  return { enforcement, recorded };
}

/** The executor's `check` over the enforcement point, as the supervisor gives it. */
function checkOf(enforcement: PermissionEnforcement, run: HeldRun) {
  return (request: unknown): RunActionCheck => {
    const decision = enforcement.check(run, request);
    return decision.allowed ? { ...decision, end: () => undefined } : decision;
  };
}

function realSetup(
  records: readonly GrantRecord[],
  tools: readonly Tool[],
  run = RUN,
) {
  const { enforcement, recorded } = realEnforcement(records);
  const resolutions: RepositoryId[] = [];
  const dispatcher = createToolDispatcher({
    registry: createToolRegistry(tools),
    resolveFolder: async (repositoryId) => {
      resolutions.push(repositoryId);
      return { ok: true, repositoryId, folder: FOLDER, identity: IDENTITY };
    },
  });
  const context: ToolCallContext = {
    run,
    check: checkOf(enforcement, run),
    signal: new AbortController().signal,
  };
  return { dispatcher, context, recorded, resolutions };
}

test("no capability is inferred from another: every other grant on the repository, and repo.read on another repository, leave a read denied and recorded", async () => {
  const others = CAPABILITIES.filter(
    (capability) => capability !== "repo.read" && capability !== "provider.use",
  ).map((capability, index) => grant(capability, REPOSITORY_ID, index));
  const records = [...others, grant("repo.read", OTHER_REPOSITORY_ID, 9)];
  const read = probeTool("probe");
  const harness = realSetup(records, [read.tool]);
  expect(
    await harness.dispatcher.call(harness.context, "probe", { value: "x" }),
  ).toEqual({ ok: false, code: "denied", reason: "no_grant" });
  expect(read.runs).toEqual([]);
  expect(harness.resolutions).toEqual([]);
  // The enforcement point recorded the denial, with the capability, the
  // run, the agent, and the repository, and nothing that the call sent.
  expect(harness.recorded).toEqual([
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

test("each tool is checked for its own capability only: a grant of repo.read allows a read tool and not a tool that needs repo.write", async () => {
  const read = probeTool("reader");
  const write = probeTool("writer", "repo.write");
  const harness = realSetup([grant("repo.read")], [read.tool, write.tool]);
  expect(
    (await harness.dispatcher.call(harness.context, "reader", { value: "x" }))
      .ok,
  ).toBe(true);
  expect(
    await harness.dispatcher.call(harness.context, "writer", { value: "x" }),
  ).toEqual({ ok: false, code: "denied", reason: "no_grant" });
  expect(write.runs).toEqual([]);
  expect(
    harness.recorded.map(
      (entry) => entry.kind === "denied" && entry.capability,
    ),
  ).toEqual(["repo.write"]);
});

test("a run without a repository is denied and recorded, and runs nothing", async () => {
  const read = probeTool("probe");
  const run = Object.freeze({ ...RUN, repositoryId: null }) as HeldRun;
  const harness = realSetup([grant("repo.read")], [read.tool], run);
  const answer = await harness.dispatcher.call(harness.context, "probe", {
    value: "x",
  });
  expect(answer).toMatchObject({ ok: false, code: "denied" });
  expect(read.runs).toEqual([]);
  expect(harness.recorded).toHaveLength(1);
  expect(harness.recorded[0]?.kind).toBe("denied");
});
