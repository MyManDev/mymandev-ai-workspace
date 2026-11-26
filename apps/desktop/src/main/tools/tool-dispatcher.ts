// The tool registry and dispatcher of the desktop's main process (#36,
// first slice: read tools; Project Manager decision of 2026-11-25). An
// executor of #30 or #31, which do not exist yet, hands every tool call of
// its agent to `call`, with what the host run supervisor gave it
// (`RunExecution`): the held run, its `check`, and its `AbortSignal`.
//
// Before every call, the dispatcher asks the enforcement point, through the
// executor's `check`, for exactly the capability that the tool names, for
// the run's agent on the run's repository; no capability is ever inferred
// from another. A denial runs nothing, and the enforcement point records it.
// Only an allowed call parses its input, resolves the repository of the
// allowed request to its folder on this device, and runs the tool. The
// allowed action stays held, so that a change of the grants re-checks it and
// aborts the run, until the tool settled.
//
// Every allowed call is recorded (#37, Project Manager decision of
// 2026-11-26): once the call has its answer, and before the answer is
// given, one `tool_call_allowed` record goes to the enforcement point's
// recorder, with the tool, its capability, the path that the call names
// relative to the repository (or null), the result code (`ok`, or the
// refusal), the run's IDs, and the time (`ToolCallRecord`, in
// `permissions/tool-call-record.ts` with the format of the records). It never
// holds the input, the answer, a file's content, or an absolute path; a path
// with a lone surrogate or a Unicode format character is recorded as null.
// A record that is not taken withholds the answer: the call is refused with
// `record_failed` (default until the Project Manager decides: fail closed, as
// for a shell start). The recorder must be the enforcement point's own
// instance. A call refused before the check (`unknown_tool`, `aborted`) is not
// recorded here, and a denial is recorded by the enforcement point.
//
// Every answer is plain JSON data. A refusal is a code of a closed list,
// with a reason of a closed list for some codes, never a message, a path,
// or an error of the file system. An answer never holds the repository's
// folder.
import type { Capability, RepositoryId } from "@mymandev/protocol";
import { CAPABILITY_SCOPE } from "@mymandev/permissions";
import type * as z from "zod";
import type { RunExecution } from "../agents/run-executor.ts";
import type {
  EnforcementDenialReason,
  EnforcementRecorder,
} from "../permissions/enforcement.ts";
import {
  recordablePath,
  TOOL_CALL_RECORD_RESULTS,
  TOOL_NAME_PATTERN,
  type ToolCallRecord,
  type ToolCallRecordResult,
} from "../permissions/tool-call-record.ts";
import type { FileIdentity } from "../repository-links/identity.ts";
import type {
  RepositoryFolderFailure,
  RepositoryFolderResolution,
} from "../repository-links/service.ts";
import type { RepositoryPathRefusal } from "./repository-path.ts";

/**
 * The largest answer of one call, in bytes of its JSON text (UTF-8), the
 * bound of what one call gives the agent (default until the Project
 * Manager decides). A larger answer is refused (`answer_too_large`).
 */
export const MAX_TOOL_ANSWER_BYTES = 1024 * 1024;

/**
 * The largest input of one call, in bytes of its JSON text (UTF-8)
 * (default until the Project Manager decides). A larger input is refused
 * (`invalid_input`).
 */
export const MAX_TOOL_INPUT_BYTES = 64 * 1024;

/**
 * Why a call was refused, a closed list:
 *
 * - `unknown_tool`: no tool has the name.
 * - `aborted`: the run's signal aborted before the call answered.
 * - `denied`: the enforcement point denied the capability (`reason`: one of
 *   `ENFORCEMENT_DENIAL_REASONS`), or the check could not be made
 *   (`check_failed`).
 * - `invalid_input`: the input is not JSON data of at most
 *   `MAX_TOOL_INPUT_BYTES`, or does not parse with the tool's schema.
 * - `repository_unavailable`: the run's repository did not resolve to a
 *   folder on this device (`reason`: one of `REPOSITORY_FOLDER_FAILURES`).
 * - `path_refused`: the path is refused (`reason`: one of
 *   `REPOSITORY_PATH_REFUSALS`).
 * - `not_found`: nothing is at the path.
 * - `not_a_file` and `not_a_directory`: the path names another kind.
 * - `read_failed`: the file system failed.
 * - `answer_too_large`: the answer is larger than `MAX_TOOL_ANSWER_BYTES`.
 * - `answer_has_path`: the answer holds the repository's folder (default
 *   until the Project Manager decides: also when the folder is in a file's
 *   content).
 * - `tool_failed`: the tool failed in another way.
 * - `record_failed`: the record of the allowed call was not taken, so its
 *   answer is withheld.
 */
export const TOOL_CALL_REFUSALS = Object.freeze([
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
  "record_failed",
] as const);
export type ToolCallRefusal = (typeof TOOL_CALL_REFUSALS)[number];

const RECORD_RESULTS: ReadonlySet<string> = new Set(TOOL_CALL_RECORD_RESULTS);

/** The refusals that a tool itself may answer. */
export type ToolRunRefusal = Extract<
  ToolCallRefusal,
  | "aborted"
  | "path_refused"
  | "not_found"
  | "not_a_file"
  | "not_a_directory"
  | "read_failed"
>;

const TOOL_RUN_REFUSALS: ReadonlySet<string> = new Set<ToolRunRefusal>([
  "aborted",
  "path_refused",
  "not_found",
  "not_a_file",
  "not_a_directory",
  "read_failed",
]);

/** What a call answers. */
export type ToolCallAnswer =
  | { readonly ok: true; readonly tool: string; readonly result: unknown }
  | {
      readonly ok: false;
      readonly code: ToolCallRefusal;
      readonly reason?:
        | EnforcementDenialReason
        | RepositoryFolderFailure
        | RepositoryPathRefusal;
    };

/** What a tool's run answers: JSON data, or a refusal of its own. */
export type ToolRunOutcome =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly code: ToolRunRefusal;
      readonly reason?: RepositoryPathRefusal;
    };

/** What a tool's run gets. */
export interface ToolRunContext {
  /**
   * The repository's top-level folder on this device, resolved for this
   * call. Never put it, or a path under it, in a result.
   */
  readonly folder: string;
  /**
   * The identity (device and file number) of `folder` that the link
   * recorded and that the resolution read again. A tool checks that the
   * folder it acts on still has it, and is not a link.
   */
  readonly folderIdentity: FileIdentity;
  /** The run's signal: stop at once when it aborts. */
  readonly signal: AbortSignal;
}

/**
 * A tool as its module defines it: a name, a strict input schema, the one
 * capability that it needs, and its run.
 */
export interface ToolDefinition<Input> {
  readonly name: string;
  /** A capability scoped to a repository (`CAPABILITY_SCOPE`). */
  readonly capability: Capability;
  /** A strict schema: unknown fields are refused. */
  readonly input: z.ZodType<Input>;
  /**
   * The path that a parsed input names, for the call's record: relative to
   * the repository's top-level folder, as it passed `parseRepositoryPath`,
   * or null. Never an absolute path: the recorder refuses one, and the call
   * is then refused (`record_failed`). Without it, or when it throws, the
   * record's path is null.
   */
  readonly recordPath?: (input: Input) => string | null;
  readonly run: (
    input: Input,
    context: ToolRunContext,
  ) => Promise<ToolRunOutcome>;
}

/** A tool as the registry holds it, its input type closed in. */
export interface Tool {
  readonly name: string;
  readonly capability: Capability;
  /**
   * Parses the input; an allowed call then runs it, and records `path`.
   * Never throws.
   */
  readonly parse: (input: unknown) =>
    | {
        readonly ok: true;
        readonly path: string | null;
        readonly run: (context: ToolRunContext) => Promise<ToolRunOutcome>;
      }
    | { readonly ok: false };
}

export function defineTool<Input>(definition: ToolDefinition<Input>): Tool {
  const { name, capability, input, recordPath, run } = definition;
  return Object.freeze({
    name,
    capability,
    parse: (value: unknown) => {
      let parsed: ReturnType<typeof input.safeParse>;
      try {
        parsed = input.safeParse(value);
      } catch {
        return Object.freeze({ ok: false } as const);
      }
      if (!parsed.success) {
        return Object.freeze({ ok: false } as const);
      }
      const data = parsed.data;
      let path: string | null;
      try {
        path = recordPath === undefined ? null : recordPath(data);
      } catch {
        path = null;
      }
      return Object.freeze({
        ok: true,
        path,
        run: (context: ToolRunContext) => run(data, context),
      } as const);
    },
  });
}

/** The tools of this device, by name. Frozen. */
export interface ToolRegistry {
  /** The tool with exactly this name, or null. */
  readonly get: (name: unknown) => Tool | null;
  readonly names: () => readonly string[];
}

/**
 * Creates the registry. It throws for a name outside `TOOL_NAME_PATTERN`,
 * a name given twice, and a capability that is not scoped to a repository,
 * so that a wrong tool never starts.
 */
export function createToolRegistry(tools: readonly Tool[]): ToolRegistry {
  const held = new Map<string, Tool>();
  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error("A tool's name does not fit TOOL_NAME_PATTERN");
    }
    if (held.has(tool.name)) {
      throw new Error("Two tools have the same name");
    }
    if (
      !Object.hasOwn(CAPABILITY_SCOPE, tool.capability) ||
      CAPABILITY_SCOPE[tool.capability] !== "repository"
    ) {
      throw new Error("A tool's capability is not scoped to a repository");
    }
    held.set(tool.name, tool);
  }
  const names = Object.freeze([...held.keys()]);
  return Object.freeze({
    get: (name: unknown) =>
      typeof name === "string" ? (held.get(name) ?? null) : null,
    names: () => names,
  });
}

/** What a call gets from the executor: its `RunExecution`, or these of it. */
export type ToolCallContext = Pick<RunExecution, "run" | "check" | "signal">;

export interface ToolDispatcherOptions {
  readonly registry: ToolRegistry;
  /**
   * The repository link service's `resolveFolder`: the folder of the
   * signed-in account's link of the repository, resolved for each call.
   */
  readonly resolveFolder: (
    repositoryId: RepositoryId,
  ) => Promise<RepositoryFolderResolution>;
  /**
   * The enforcement point's recorder, which takes the `ToolCallRecord` of
   * every allowed call: the very instance that the enforcement point got,
   * never a second file recorder on the same folder (a second writer) or a
   * recorder in memory (nothing kept on the device). A call whose record is
   * not taken is refused (`record_failed`).
   */
  readonly recorder: EnforcementRecorder;
  /** The wall clock, read once for each record. */
  readonly now: () => Date;
}

export interface ToolDispatcher {
  /** Runs one tool call of the run's agent. Never rejects. */
  readonly call: (
    context: ToolCallContext,
    name: unknown,
    input: unknown,
  ) => Promise<ToolCallAnswer>;
}

function refuse(
  code: ToolCallRefusal,
  reason?:
    EnforcementDenialReason | RepositoryFolderFailure | RepositoryPathRefusal,
): ToolCallAnswer {
  return Object.freeze(
    reason === undefined ? { ok: false, code } : { ok: false, code, reason },
  );
}

/**
 * The input as JSON data: a copy of its own enumerable data, so that a
 * field is never taken from a prototype and the tool parses what was
 * checked, or `undefined` when it is not JSON data or too large. It never
 * throws.
 */
function jsonInput(input: unknown): { readonly value: unknown } | undefined {
  try {
    const json = JSON.stringify(input);
    if (
      typeof json !== "string" ||
      Buffer.byteLength(json, "utf8") > MAX_TOOL_INPUT_BYTES
    ) {
      return undefined;
    }
    return { value: JSON.parse(json) as unknown };
  } catch {
    return undefined;
  }
}

const ABORTED: unique symbol = Symbol("aborted");
const FAILED: unique symbol = Symbol("failed");

/**
 * What `work` gives, `FAILED` when it rejects, or `ABORTED` once the signal
 * aborts, whichever comes first.
 */
function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORTED | typeof FAILED> {
  if (signal.aborted) {
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    const done = (value: T | typeof FAILED) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    void work.then(done, () => done(FAILED));
  });
}

/**
 * Whether the JSON text holds the folder, in any case, with either
 * separator, as JSON writes it.
 */
function holdsFolder(json: string, folder: string): boolean {
  const text = json.toLowerCase();
  const forms = new Set([
    folder,
    folder.replaceAll("\\", "/"),
    folder.replaceAll("/", "\\"),
  ]);
  for (const form of forms) {
    const written = JSON.stringify(form).slice(1, -1).toLowerCase();
    if (written !== "" && text.includes(written)) {
      return true;
    }
  }
  return false;
}

/**
 * Handles the rejection of a thenable, so that a recorder that returned a
 * promise leaves no unhandled rejection. It never throws.
 */
function settleQuietly(value: unknown): void {
  try {
    if (
      (typeof value === "object" && value !== null) ||
      typeof value === "function"
    ) {
      const then: unknown = (value as { then?: unknown }).then;
      if (typeof then === "function") {
        then.call(value, undefined, () => undefined);
      }
    }
  } catch {
    // Nothing more to do.
  }
}

/** The ISO time of a genuine, valid Date from the clock, or null. */
function timeOf(now: () => Date): string | null {
  try {
    const ms = Date.prototype.getTime.call(now());
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  } catch {
    return null;
  }
}

export function createToolDispatcher(
  options: ToolDispatcherOptions,
): ToolDispatcher {
  const { registry, resolveFolder, recorder, now } = options;

  /**
   * Records the answer of an allowed call, and gives it only when the
   * recorder took the record: `undefined`, as the enforcement point counts
   * it. Otherwise, a clock without a valid time included, the call is
   * refused with `record_failed`.
   */
  function recorded(
    answer: ToolCallAnswer,
    entry: Omit<ToolCallRecord, "result" | "at">,
  ): ToolCallAnswer {
    const at = timeOf(now);
    if (at === null) {
      return refuse("record_failed");
    }
    // `unknown_tool`, `denied`, and `record_failed` never come after the
    // check; they are recorded as `tool_failed`, never as given.
    const result: ToolCallRecordResult = answer.ok
      ? "ok"
      : RECORD_RESULTS.has(answer.code)
        ? (answer.code as ToolCallRecordResult)
        : "tool_failed";
    let taken: unknown;
    try {
      taken = recorder.record(Object.freeze({ ...entry, result, at }));
    } catch {
      return refuse("record_failed");
    }
    if (taken !== undefined) {
      settleQuietly(taken);
      return refuse("record_failed");
    }
    return answer;
  }

  /**
   * Runs an allowed call whose input parsed: resolves the folder, runs the
   * tool, and checks its answer. `end` ends the held action.
   */
  async function act(
    tool: Tool,
    repositoryId: RepositoryId,
    run: (context: ToolRunContext) => Promise<ToolRunOutcome>,
    signal: AbortSignal,
    end: () => void,
  ): Promise<ToolCallAnswer> {
    // An abort while the folder resolves answers at once, also when the
    // resolution hangs. The held action ends at once as well: the resolution
    // only reads the identity of the repository's folders, and no tool runs
    // after an abort.
    const resolving = (async () => resolveFolder(repositoryId))();
    const resolved = await untilAborted(resolving, signal);
    if (resolved === ABORTED || signal.aborted) {
      end();
      return refuse("aborted");
    }
    const resolution: RepositoryFolderResolution =
      resolved === FAILED
        ? Object.freeze({ ok: false, reason: "unavailable" })
        : resolved;
    if (!resolution.ok) {
      end();
      return refuse("repository_unavailable", resolution.reason);
    }
    const folder = resolution.folder;
    const folderIdentity = resolution.identity;

    // The action is held until the tool settled, also after an abort.
    const work = (async () => run({ folder, folderIdentity, signal }))();
    void work.then(end, end);
    const outcome = await untilAborted(work, signal);
    if (outcome === ABORTED || signal.aborted) {
      return refuse("aborted");
    }
    if (outcome === FAILED) {
      return refuse("tool_failed");
    }
    if (typeof outcome !== "object" || outcome === null) {
      return refuse("tool_failed");
    }
    if (outcome.ok !== true) {
      return TOOL_RUN_REFUSALS.has(outcome.code)
        ? refuse(outcome.code, outcome.reason)
        : refuse("tool_failed");
    }

    // The answer is the JSON text's data, checked as it will be sent.
    let json: string | undefined;
    try {
      json = JSON.stringify(outcome.result);
    } catch {
      json = undefined;
    }
    if (json === undefined) {
      return refuse("tool_failed");
    }
    if (Buffer.byteLength(json, "utf8") > MAX_TOOL_ANSWER_BYTES) {
      return refuse("answer_too_large");
    }
    if (holdsFolder(json, folder)) {
      return refuse("answer_has_path");
    }
    return Object.freeze({
      ok: true,
      tool: tool.name,
      result: JSON.parse(json) as unknown,
    });
  }

  async function call(
    context: ToolCallContext,
    name: unknown,
    input: unknown,
  ): Promise<ToolCallAnswer> {
    const tool = registry.get(name);
    if (tool === null) {
      return refuse("unknown_tool");
    }
    const { run, check, signal } = context;
    if (signal.aborted) {
      return refuse("aborted");
    }

    // Exactly the tool's capability, for the run's agent on the run's
    // repository; the enforcement point takes both from the run again.
    let decision: ReturnType<typeof check>;
    try {
      decision = check({
        agentId: run.agentId,
        capability: tool.capability,
        repositoryId: run.repositoryId,
      });
    } catch {
      return refuse("denied", "check_failed");
    }
    if (typeof decision !== "object" || decision === null) {
      return refuse("denied", "check_failed");
    }
    if (decision.allowed !== true) {
      return refuse(
        "denied",
        decision.allowed === false ? decision.reason : "check_failed",
      );
    }
    const allowed = decision;
    let ended = false;
    const end = () => {
      if (!ended) {
        ended = true;
        try {
          allowed.end();
        } catch {
          // The supervisor's `end` never throws; a call still answers.
        }
      }
    };
    // Act only on the request that was checked, and only when it is the
    // tool's capability on the run's repository.
    const checked = allowed.request;
    if (
      checked.capability !== tool.capability ||
      !("repositoryId" in checked) ||
      checked.repositoryId !== run.repositoryId
    ) {
      end();
      return refuse("denied", "check_failed");
    }

    // From here on, the call is allowed: whatever it answers is recorded
    // first, with the path that its input names when it parsed.
    const entry = {
      kind: "tool_call_allowed",
      tool: tool.name,
      capability: tool.capability,
      runId: run.runId,
      agentId: run.agentId,
      repositoryId: checked.repositoryId,
      providerConnectionId: run.providerConnectionId,
    } as const;

    const plain = jsonInput(input);
    let parsed: ReturnType<Tool["parse"]> | undefined;
    try {
      parsed = plain === undefined ? undefined : tool.parse(plain.value);
    } catch {
      end();
      return recorded(refuse("tool_failed"), { ...entry, path: null });
    }
    if (parsed === undefined || !parsed.ok) {
      end();
      return recorded(refuse("invalid_input"), { ...entry, path: null });
    }
    // A path that a reader could misread is recorded as null.
    const path = recordablePath(parsed.path);
    let answer: ToolCallAnswer;
    try {
      answer = await act(tool, checked.repositoryId, parsed.run, signal, end);
    } catch {
      answer = refuse("tool_failed");
    }
    return recorded(answer, { ...entry, path });
  }

  return Object.freeze({
    call: (context: ToolCallContext, name: unknown, input: unknown) =>
      call(context, name, input).catch(() => refuse("tool_failed")),
  });
}
