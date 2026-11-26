// The context of an agent's run (#34; Project Manager decisions of
// 2026-11-25 and 2026-11-26), built in the main process before the run calls
// its provider. The context is the run's input message, the run's project,
// and, only when the run's agent may read the run's repository
// (`repo.read`), the repository's file list.
//
// - Who calls it. The executor of the run's provider kind (#30, #31), as its
//   first step, with the `RunExecution` that the host run supervisor gave
//   it, before any provider call; a failed build fails the run with its
//   reason, which is a code of `RUN_EXECUTOR_REASON_PATTERN`. No executor
//   exists yet, so nothing calls it, and `index.ts` creates no builder.
// - The message. `GET /projects/:projectId/messages/:messageId` of the read
//   allowlist (`getMessage`), with the device session of the signed-in
//   account. An answer that names another message or project is refused.
//   A run without an input message, or whose message cannot be read, has no
//   context: the build fails.
// - The repository. A run without a repository has none. Otherwise the
//   builder asks the executor's `check` for exactly `repo.read`, for the
//   run's agent on the run's repository, immediately before it reads the
//   folder, so that the enforcement point decides and records a denial.
//   Only an allowed check resolves the repository of the allowed request to
//   its folder and lists its files (`RepositoryFileLister`); the action
//   stays held until the lister settled or the deadline, so that a change of
//   the grants until then re-checks it and aborts the run. A denial, a
//   folder that does not resolve, and a list that fails leave the repository
//   out of the context (fail closed), and the context says so with a closed
//   reason; a failed list is never given in part.
// - The deadline. The resolution and the list together end after
//   `REPOSITORY_FILE_LIST_LIMITS.deadlineMs`: the builder aborts the walk
//   through its signal (the run's combined with the deadline's) and ends the
//   held action. A walk that listed the repository's folder answers the
//   files found so far, marked `truncated`; before that the repository is
//   left out (`unavailable`). The run's own abort still fails the build.
// - After the build. Once the list settled, a change of the grants no longer
//   reaches it: the executor calls `recheckRepositoryRead` right before
//   every provider request that carries the list, also on later turns, and
//   leaves the list out of that request on a denial.
// - No absolute path. Every path of the list is relative to the
//   repository's top-level folder, in POSIX form, and passes the lexical
//   rules of the read tools (`parseRepositoryPath`) again, whichever lister
//   gave it; a list with a path that begins with the folder, in any case and
//   with either separator (`startsWithFolder`), is left out as well. The
//   context never holds the folder, and nothing of it leaves the main
//   process.
import type {
  ChatMessage,
  MessageId,
  ProjectId,
  RepositoryId,
  WorkspaceId,
} from "@mymandev/protocol";
import type { AccountService } from "../account.ts";
import type { WorkspaceReadResult } from "../api-reads.ts";
import type { RepositoryFolderResolution } from "../repository-links/service.ts";
import {
  REPOSITORY_FILE_LIST_LIMITS,
  type RepositoryFileLister,
  type RepositoryFileListOutcome,
} from "../tools/repository-files.ts";
import { parseRepositoryPath } from "../tools/repository-path.ts";
import type { RunActionCheck, RunExecution } from "./run-executor.ts";

/**
 * Why a build failed, a closed list; each fits
 * `RUN_EXECUTOR_REASON_PATTERN`:
 *
 * - `aborted`: the run's signal aborted.
 * - `message_missing`: the run has no input message.
 * - `message_not_found`: the API answered `not_found` for the message.
 * - `message_unavailable`: the message could not be read otherwise, or the
 *   answer named another message or project.
 * - `context_failed`: the build failed in another way.
 */
export const RUN_CONTEXT_FAILURES = Object.freeze([
  "aborted",
  "message_missing",
  "message_not_found",
  "message_unavailable",
  "context_failed",
] as const);
export type RunContextFailure = (typeof RUN_CONTEXT_FAILURES)[number];

/**
 * Why the repository is not in a context, a closed list:
 *
 * - `no_repository`: the run has none; nothing is checked.
 * - `denied`: the enforcement point denied `repo.read` with any reason, or
 *   the check failed.
 * - `unavailable`: the repository's folder did not resolve on this device,
 *   its file list failed or broke a rule above, or the deadline came before
 *   the repository's folder was listed.
 */
export const RUN_CONTEXT_REPOSITORY_OMISSIONS = Object.freeze([
  "no_repository",
  "denied",
  "unavailable",
] as const);
export type RunContextRepositoryOmission =
  (typeof RUN_CONTEXT_REPOSITORY_OMISSIONS)[number];

/** The run's input message, as the chat holds it, without its author. */
export interface RunContextMessage {
  readonly id: MessageId;
  readonly seq: number;
  readonly body: string;
  readonly createdAt: string;
}

/**
 * The repository part of a context: its file list, or why it is left out.
 * `files` and `truncated` are those of `RepositoryFileListOutcome`.
 */
export type RunContextRepository =
  | {
      readonly included: true;
      readonly repositoryId: RepositoryId;
      readonly files: readonly string[];
      readonly truncated: boolean;
    }
  | {
      readonly included: false;
      readonly reason: RunContextRepositoryOmission;
    };

/** The context of a run. Frozen, plain JSON data. */
export interface RunContext {
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly message: RunContextMessage;
  readonly repository: RunContextRepository;
}

export type RunContextResult =
  | { readonly ok: true; readonly context: RunContext }
  | { readonly ok: false; readonly reason: RunContextFailure };

/** What a build gets: the executor's `RunExecution`, or these of it. */
export type RunContextInput = Pick<
  RunExecution,
  "run" | "workspaceId" | "projectId" | "inputMessageId" | "check" | "signal"
>;

export interface RunContextBuilderOptions {
  /** The account service's reads: `getMessage` of the allowlist. */
  readonly account: Pick<AccountService, "readWorkspaceData">;
  /**
   * The repository link service's `resolveFolder`: the folder of the
   * signed-in account's link of the repository, resolved for each build.
   */
  readonly resolveFolder: (
    repositoryId: RepositoryId,
  ) => Promise<RepositoryFolderResolution>;
  /** The file list: `createRepositoryWalkLister` until the Git slice. */
  readonly listFiles: RepositoryFileLister;
}

export interface RunContextBuilder {
  /** Builds the context of one run. Never rejects. */
  readonly build: (input: RunContextInput) => Promise<RunContextResult>;
}

function failed(reason: RunContextFailure): RunContextResult {
  return Object.freeze({ ok: false, reason });
}

function omitted(reason: RunContextRepositoryOmission): RunContextRepository {
  return Object.freeze({ included: false, reason });
}

/**
 * Whether a path of the list begins with the repository's folder, in any
 * case and with either separator. Every path passed `parseRepositoryPath`,
 * so it is relative, in POSIX form, without a drive letter: only its start
 * can hold the folder, and a name inside the repository that repeats the
 * folder's last names (`src/app/page.tsx` in `/app`) is kept.
 */
function startsWithFolder(file: string, folder: string): boolean {
  const path = file.toLowerCase();
  const form = folder.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return form !== "" && (path === form || path.startsWith(`${form}/`));
}

const ABORTED: unique symbol = Symbol("aborted");
const THREW: unique symbol = Symbol("threw");

/**
 * What `work` gives, `THREW` when it rejects, or `ABORTED` once the signal
 * aborts, whichever comes first.
 */
function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORTED | typeof THREW> {
  if (signal.aborted) {
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    const done = (value: T | typeof THREW) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    void work.then(done, () => done(THREW));
  });
}

/** The repository part, or `ABORTED`. */
type RepositoryPart = RunContextRepository | typeof ABORTED;

/** Settles after the current turn of the event loop. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Checks exactly `repo.read`, for the run's agent on the run's repository;
 * the enforcement point takes both from the run again. The allowed action,
 * whose `end` never throws, or null when it is denied, the check fails, or
 * the allowed request is not `repo.read` on the run's repository (its
 * action then ends at once).
 */
function checkRepositoryRead(
  input: Pick<RunExecution, "run" | "check">,
): { readonly repositoryId: RepositoryId; readonly end: () => void } | null {
  const { run, check } = input;
  if (run.repositoryId === null) {
    return null;
  }
  let decision: RunActionCheck;
  try {
    decision = check({
      agentId: run.agentId,
      capability: "repo.read",
      repositoryId: run.repositoryId,
    });
  } catch {
    return null;
  }
  if (
    typeof decision !== "object" ||
    decision === null ||
    decision.allowed !== true
  ) {
    return null;
  }
  const allowed = decision;
  let ended = false;
  const end = () => {
    if (!ended) {
      ended = true;
      try {
        allowed.end();
      } catch {
        // The supervisor's `end` never throws; the build still answers.
      }
    }
  };
  // Act only on the request that was checked, and only when it is
  // `repo.read` on the run's repository.
  const checked = allowed.request;
  if (
    typeof checked !== "object" ||
    checked === null ||
    checked.capability !== "repo.read" ||
    !("repositoryId" in checked) ||
    checked.repositoryId !== run.repositoryId
  ) {
    end();
    return null;
  }
  return { repositoryId: checked.repositoryId, end };
}

/**
 * Whether a provider request may carry the context's file list (Project
 * Manager decision of 2026-11-26): checks `repo.read` again, for the run's
 * agent on the run's repository, through the executor's `check`, so that
 * the enforcement point decides and records a denial. The executor (#30,
 * #31) calls it right before every provider request that carries the list,
 * also on later turns, and leaves the list out of that request when it
 * answers false. It answers false without a check for a context without a
 * list, or with the list of another repository. An allowed action ends at
 * once: a sent request cannot be taken back. Never throws.
 */
export function recheckRepositoryRead(
  input: Pick<RunExecution, "run" | "check">,
  repository: RunContextRepository,
): boolean {
  try {
    if (
      repository.included !== true ||
      repository.repositoryId !== input.run.repositoryId
    ) {
      return false;
    }
    const allowed = checkRepositoryRead(input);
    if (allowed === null) {
      return false;
    }
    allowed.end();
    return allowed.repositoryId === repository.repositoryId;
  } catch {
    return false;
  }
}

export function createRunContextBuilder(
  options: RunContextBuilderOptions,
): RunContextBuilder {
  const { account, resolveFolder, listFiles } = options;

  /** The message of the run, or why it has none. */
  async function readMessage(
    input: RunContextInput,
    messageId: MessageId,
  ): Promise<ChatMessage | RunContextFailure> {
    const reading = (async () =>
      account.readWorkspaceData("getMessage", {
        projectId: input.projectId,
        messageId,
      }))();
    const answer:
      | WorkspaceReadResult<{ message: ChatMessage }>
      | typeof THREW
      | typeof ABORTED = await untilAborted(reading, input.signal);
    if (answer === ABORTED || input.signal.aborted) {
      return "aborted";
    }
    if (answer === THREW || typeof answer !== "object" || answer === null) {
      return "message_unavailable";
    }
    if (!answer.ok) {
      return answer.reason === "not_found"
        ? "message_not_found"
        : "message_unavailable";
    }
    const { message } = answer.value;
    if (message.id !== messageId || message.projectId !== input.projectId) {
      return "message_unavailable";
    }
    return message;
  }

  /** Checks a lister's answer by the rules above; the list, or null. */
  function checkedList(
    outcome: RepositoryFileListOutcome,
    folder: string,
  ): { readonly files: readonly string[]; readonly truncated: boolean } | null {
    if (
      typeof outcome !== "object" ||
      outcome === null ||
      outcome.ok !== true
    ) {
      return null;
    }
    const { files, truncated } = outcome;
    if (!Array.isArray(files) || typeof truncated !== "boolean") {
      return null;
    }
    const seen = new Set<string>();
    for (const file of files as unknown[]) {
      if (typeof file !== "string" || seen.has(file)) {
        return null;
      }
      const parsed = parseRepositoryPath(file);
      // `.` is the repository's folder, never a file.
      if (!parsed.ok || parsed.path.segments.length === 0) {
        return null;
      }
      seen.add(file);
    }
    const { maxFiles } = REPOSITORY_FILE_LIST_LIMITS;
    const kept = [...(files as string[])]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, maxFiles);
    if (kept.some((file) => startsWithFolder(file, folder))) {
      return null;
    }
    return {
      files: Object.freeze(kept),
      truncated: truncated || files.length > maxFiles,
    };
  }

  /** The repository part of the run's context. Never rejects. */
  async function readRepository(
    input: RunContextInput,
  ): Promise<RepositoryPart> {
    const { run, signal } = input;
    if (run.repositoryId === null) {
      return omitted("no_repository");
    }
    if (signal.aborted) {
      return ABORTED;
    }
    const allowed = checkRepositoryRead(input);
    if (allowed === null) {
      return omitted("denied");
    }
    const { repositoryId } = allowed;

    // The repository part ends at the deadline: the walk is aborted through
    // its signal, the run's combined with the deadline's, and the held
    // action ends.
    const deadline = new AbortController();
    const stop = AbortSignal.any([signal, deadline.signal]);
    let ended = false;
    const end = () => {
      if (!ended) {
        ended = true;
        clearTimeout(timer);
        allowed.end();
      }
    };
    const timer = setTimeout(() => {
      deadline.abort();
      end();
    }, REPOSITORY_FILE_LIST_LIMITS.deadlineMs);

    const resolving = (async () => resolveFolder(repositoryId))();
    const resolved = await untilAborted(resolving, stop);
    if (signal.aborted) {
      end();
      return ABORTED;
    }
    if (
      resolved === ABORTED ||
      resolved === THREW ||
      typeof resolved !== "object" ||
      resolved === null ||
      resolved.ok !== true
    ) {
      end();
      return omitted("unavailable");
    }
    const folder = resolved.folder;

    // The action is held until the lister settled, also after an abort, or
    // until the deadline.
    const listing = (async () =>
      listFiles({ folder, folderIdentity: resolved.identity, signal: stop }))();
    void listing.then(end, end);
    let outcome = await untilAborted(listing, stop);
    if (outcome === ABORTED && !signal.aborted) {
      // The deadline: the lister answers right away with the files found so
      // far; one that does not is not waited for.
      outcome = await untilAborted(
        Promise.race([listing, nextTurn().then((): typeof ABORTED => ABORTED)]),
        signal,
      );
    }
    if (outcome === ABORTED || signal.aborted) {
      return signal.aborted ? ABORTED : omitted("unavailable");
    }
    if (outcome === THREW || typeof outcome !== "object" || outcome === null) {
      return omitted("unavailable");
    }
    const list = checkedList(outcome, folder);
    if (list === null) {
      return omitted("unavailable");
    }
    return Object.freeze({
      included: true,
      repositoryId,
      files: list.files,
      // A list that the deadline cut is never answered as whole.
      truncated: list.truncated || deadline.signal.aborted,
    });
  }

  async function build(input: RunContextInput): Promise<RunContextResult> {
    if (input.signal.aborted) {
      return failed("aborted");
    }
    if (input.inputMessageId === null) {
      return failed("message_missing");
    }
    const message = await readMessage(input, input.inputMessageId);
    if (typeof message === "string") {
      return failed(message);
    }
    if (input.signal.aborted) {
      return failed("aborted");
    }
    const repository = await readRepository(input);
    if (repository === ABORTED || input.signal.aborted) {
      return failed("aborted");
    }
    return Object.freeze({
      ok: true,
      context: Object.freeze({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        message: Object.freeze({
          id: message.id,
          seq: message.seq,
          body: message.body,
          createdAt: message.createdAt,
        }),
        repository,
      }),
    });
  }

  return Object.freeze({
    build: (input: RunContextInput) =>
      build(input).catch(() => failed("context_failed")),
  });
}
