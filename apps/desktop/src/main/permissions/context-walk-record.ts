// The record of the walk of a run's context (#366, Project Manager decision
// of 2026-11-26: one record per walk): the `context_walk` kind of the
// enforcement records, which the context builder (`agents/run-context.ts`)
// makes and the recorder (`file-recorder.ts`) writes to the series of the
// tool calls. It lives with the format of the records, as the record of a
// tool call does (`tool-call-record.ts`); the builder imports it from here.
import type {
  AgentId,
  ProviderConnectionId,
  RepositoryId,
  RunId,
} from "@mymandev/protocol";

/**
 * The result code of a walk, a closed list (defaults until the Project
 * Manager decides):
 *
 * - `ok`: the file list was placed in the context, whole or cut
 *   (`truncated`).
 * - `aborted`: the run's signal aborted after `repo.read` was allowed; the
 *   build fails.
 * - `repository_unavailable`: the repository's folder did not resolve on
 *   this device.
 * - `timed_out`: the deadline came before the repository's folder was
 *   listed, or the lister did not answer at it.
 * - `list_failed`: the lister failed, threw, or answered another shape.
 * - `list_refused`: the list broke a rule of the builder (a path that is
 *   not relative to the repository, that repeats, or that begins with the
 *   repository's folder, or a count out of its bound).
 *
 * A denial of `repo.read` and a run without a repository are no walk: the
 * enforcement point records the denial, and nothing is recorded for the
 * other. `record_failed`, the record's own failure, is never recorded. A
 * value may be added under the same format version; a reader accepts a
 * value that it does not know.
 */
export const CONTEXT_WALK_RECORD_RESULTS = Object.freeze([
  "ok",
  "aborted",
  "repository_unavailable",
  "timed_out",
  "list_failed",
  "list_refused",
] as const);
export type ContextWalkRecordResult =
  (typeof CONTEXT_WALK_RECORD_RESULTS)[number];

/**
 * The walk of a run's context after the enforcement point allowed
 * `repo.read`, as the context builder records it once the walk settled and
 * before the list is placed in the context (#366). It holds IDs, a result
 * code, two counts, a flag, and a time: never a file's or a folder's name, a
 * path, or a file's content.
 *
 * `files`, `folders`, and `truncated` are numbers and a flag for the result
 * `ok`, and null for every other result, since no list was placed.
 */
export interface ContextWalkRecord {
  readonly kind: "context_walk";
  readonly result: ContextWalkRecordResult;
  /**
   * The number of files in the list placed in the context, at most
   * `REPOSITORY_FILE_LIST_LIMITS.maxFiles`.
   */
  readonly files: number | null;
  /**
   * The number of folders whose listing the walk read, the repository's
   * folder included, at most `REPOSITORY_FILE_LIST_LIMITS.maxFolders`.
   */
  readonly folders: number | null;
  /** Whether the list placed in the context was cut. */
  readonly truncated: boolean | null;
  readonly runId: RunId;
  readonly agentId: AgentId;
  /** The repository of the allowed request. */
  readonly repositoryId: RepositoryId;
  readonly providerConnectionId: ProviderConnectionId | null;
  /** The time at which the walk settled. */
  readonly at: string;
}
