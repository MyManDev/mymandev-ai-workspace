// The record of an allowed tool call (#37, Project Manager decision of
// 2026-11-26): the `tool_call_allowed` kind of the enforcement records, which
// the tool dispatcher (`tools/tool-dispatcher.ts`) makes and the recorder
// (`file-recorder.ts`) writes. It lives with the format of the records, so
// that the format does not depend on the tools; the dispatcher imports it
// from here.
import type {
  AgentId,
  Capability,
  ProviderConnectionId,
  RepositoryId,
  RunId,
} from "@mymandev/protocol";

/**
 * The form of a tool's name: lowercase letters, digits, and underscores,
 * starting with a letter, at most 64 characters, which every provider's
 * tool names accept.
 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The result code of a recorded call, a closed list: `ok` for an answer with
 * a result, or the refusal of a call that the enforcement point allowed.
 * `unknown_tool` and `denied` come before or at the check, and
 * `record_failed` is the record's own failure, so none is ever recorded.
 * A value may be added under the same format version; a reader accepts a
 * value that it does not know.
 */
export const TOOL_CALL_RECORD_RESULTS = Object.freeze([
  "ok",
  "aborted",
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
] as const);
export type ToolCallRecordResult = (typeof TOOL_CALL_RECORD_RESULTS)[number];

/**
 * A tool call that the enforcement point allowed, as the dispatcher records
 * it once the call has its answer (#37, Project Manager decision of
 * 2026-11-26). It holds IDs, the tool's name, a capability, a path relative
 * to the repository, a result code, and a time: never the input, the
 * answer, a file's content, or an absolute path.
 */
export interface ToolCallRecord {
  readonly kind: "tool_call_allowed";
  /** The tool's name (`TOOL_NAME_PATTERN`). */
  readonly tool: string;
  /** The capability that the tool needs, which the check allowed. */
  readonly capability: Capability;
  /**
   * The path that the call names, relative to the repository's top-level
   * folder in POSIX form, as it passed `parseRepositoryPath` (`.` for the
   * folder itself), or null when the call names none, or none that passed,
   * or one that `isRecordablePathText` refuses.
   */
  readonly path: string | null;
  readonly result: ToolCallRecordResult;
  readonly runId: RunId;
  readonly agentId: AgentId;
  /** The repository of the allowed request. */
  readonly repositoryId: RepositoryId;
  readonly providerConnectionId: ProviderConnectionId | null;
  /** The time of the answer. */
  readonly at: string;
}

/** A Unicode format character: bidi controls, zero-width ones, and the BOM. */
const FORMAT_CHARACTER = /\p{Cf}/u;

/**
 * Whether a path's text may be recorded: it is well-formed UTF-16 (no lone
 * surrogate, which UTF-8 cannot hold) and holds no Unicode format character
 * (`\p{Cf}`: a bidi override, a zero-width character, the BOM), which would
 * show a reader of the record another path than the one it holds. The read
 * tools' own path rules do not change: such a path is still read, and its
 * record holds a null path.
 */
export function isRecordablePathText(text: string): boolean {
  return text.isWellFormed() && !FORMAT_CHARACTER.test(text);
}

/**
 * The path of a call's record: `path`, or null when it is text that
 * `isRecordablePathText` refuses. Anything else is given as it is, for the
 * recorder to validate.
 */
export function recordablePath(path: string | null): string | null {
  return typeof path === "string" && !isRecordablePathText(path) ? null : path;
}
