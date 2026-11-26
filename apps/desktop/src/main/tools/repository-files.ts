// The file list of a run's context (#34; Project Manager decision of
// 2026-11-26): the files of the run's repository, found by walking its
// folder under the rules of the read tools (`read-tools.ts`). It needs no
// capability of its own: the context builder (`../agents/run-context.ts`)
// checks `repo.read` before it calls a lister, and holds that action until
// the lister settled.
//
// The walk lists each folder with the `list_directory` tool itself, so every
// listing passes the same lexical rules (`repository-path.ts`) and the same
// checks on the file system: the repository's folder must still be the one
// that the link recorded, a path through a link or a junction is refused,
// and so is one on another device. On top of the tool's own rules (hidden
// names and `.git` left out), the walk never follows a link (`link`), skips
// what is neither a file nor a folder (`other`), and does not enter a folder
// named `node_modules`, `dist`, `out`, or `build`, at any depth.
//
// `RepositoryFileLister` is the seam of the later swap to `git ls-files`
// (#36, Git slice): another lister gives the same answer, and the context
// builder checks every path of any lister again with the lexical rules.
import type { PlatformPath } from "node:path";
import {
  createReadTools,
  READ_TOOL_NAMES,
  type ReadToolFileSystem,
} from "./read-tools.ts";
import { MAX_REPOSITORY_PATH_LENGTH } from "./repository-path.ts";
import type {
  Tool,
  ToolRunContext,
  ToolRunOutcome,
} from "./tool-dispatcher.ts";

/**
 * The bounds of the file list (`maxFiles` by the Project Manager's decision
 * of 2026-11-26; `maxFolders` a default until the Project Manager decides):
 *
 * - `maxFiles`: at most this many files are listed; a repository with more
 *   is answered with the first ones and `truncated: true`.
 * - `maxFolders`: at most this many folders are listed, the repository's
 *   folder included, so that a tree of many folders with few files ends
 *   too; a folder left out for it sets `truncated: true`.
 */
export const REPOSITORY_FILE_LIST_LIMITS = Object.freeze({
  maxFiles: 1_000,
  maxFolders: 1_000,
});

/**
 * The folder names that the walk never enters, at any depth, in exactly this
 * case (Project Manager decision of 2026-11-26). A file of such a name is
 * listed.
 */
export const SKIPPED_FOLDER_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(["node_modules", "dist", "out", "build"]),
);

/**
 * What a lister answers.
 *
 * - `files`: paths relative to the repository's top-level folder, in POSIX
 *   form, each once, sorted by UTF-16 code unit; never a folder, a link, or
 *   an absolute path.
 * - `truncated`: a bound of `REPOSITORY_FILE_LIST_LIMITS` cut the list, or a
 *   folder held more entries than one listing reads.
 * - `aborted`: the run's signal aborted.
 * - `failed`: a listing was refused or failed; no partial list is answered.
 */
export type RepositoryFileListOutcome =
  | {
      readonly ok: true;
      readonly files: readonly string[];
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly reason: "aborted" | "failed" };

/**
 * Lists the files of the repository's folder that the resolution named for
 * this build, with its recorded identity and the run's signal. Never
 * rejects.
 */
export type RepositoryFileLister = (
  context: ToolRunContext,
) => Promise<RepositoryFileListOutcome>;

const ABORTED: RepositoryFileListOutcome = Object.freeze({
  ok: false,
  reason: "aborted",
});
const FAILED: RepositoryFileListOutcome = Object.freeze({
  ok: false,
  reason: "failed",
});

interface ListedEntry {
  readonly name: string;
  readonly kind: string;
}

interface Listing {
  readonly entries: readonly ListedEntry[];
  readonly truncated: boolean;
}

/** The entries and the truncation of a listing, or null for another shape. */
function listingOf(result: unknown): Listing | null {
  if (typeof result !== "object" || result === null) {
    return null;
  }
  const { entries, truncated } = result as {
    entries?: unknown;
    truncated?: unknown;
  };
  if (!Array.isArray(entries) || typeof truncated !== "boolean") {
    return null;
  }
  for (const entry of entries as unknown[]) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { name?: unknown }).name !== "string" ||
      typeof (entry as { kind?: unknown }).kind !== "string"
    ) {
      return null;
    }
  }
  return { entries: entries as ListedEntry[], truncated };
}

/**
 * Whether a refused listing of a folder below the repository's folder skips
 * that folder rather than failing the list: it is gone or no longer a
 * folder since its parent was listed, or it lies on another device (a
 * mount, which the read tools refuse as well).
 */
function skipsFolder(outcome: Extract<ToolRunOutcome, { ok: false }>): boolean {
  return (
    outcome.code === "not_found" ||
    outcome.code === "not_a_directory" ||
    (outcome.code === "path_refused" && outcome.reason === "other_device")
  );
}

export interface RepositoryWalkOptions {
  readonly files: ReadToolFileSystem;
  /** The system's path functions, `node:path` by default. */
  readonly pathApi?: PlatformPath;
}

/**
 * The lister that walks the repository's folder breadth-first, each folder's
 * entries in the order of `list_directory` (sorted by name), so that a cut
 * keeps the files nearest the top. The kept paths are then sorted.
 */
export function createRepositoryWalkLister(
  options: RepositoryWalkOptions,
): RepositoryFileLister {
  const tools = createReadTools(
    options.pathApi === undefined
      ? { files: options.files }
      : { files: options.files, pathApi: options.pathApi },
  );
  const list = tools.find(
    (tool) => tool.name === READ_TOOL_NAMES.listDirectory,
  ) as Tool;
  const { maxFiles, maxFolders } = REPOSITORY_FILE_LIST_LIMITS;

  async function walk(
    context: ToolRunContext,
  ): Promise<RepositoryFileListOutcome> {
    const { signal } = context;
    const files: string[] = [];
    let truncated = false;
    // The folders to list, the repository's folder first; `next` is the
    // first one not listed yet. At most `maxFolders` are ever held.
    const folders: string[] = ["."];
    let next = 0;
    walking: while (next < folders.length) {
      if (signal.aborted) {
        return ABORTED;
      }
      const folder = folders[next] as string;
      next += 1;
      const parsed = list.parse({ path: folder });
      if (!parsed.ok) {
        return FAILED;
      }
      let outcome: ToolRunOutcome;
      try {
        outcome = await parsed.run(context);
      } catch {
        return FAILED;
      }
      if (signal.aborted) {
        return ABORTED;
      }
      if (!outcome.ok) {
        if (outcome.code === "aborted") {
          return ABORTED;
        }
        if (folder !== "." && skipsFolder(outcome)) {
          continue;
        }
        return FAILED;
      }
      const listing = listingOf(outcome.result);
      if (listing === null) {
        return FAILED;
      }
      if (listing.truncated) {
        truncated = true;
      }
      for (const entry of listing.entries) {
        const child = folder === "." ? entry.name : `${folder}/${entry.name}`;
        // A path that the read tools could not name again is left out.
        if (child.length > MAX_REPOSITORY_PATH_LENGTH) {
          continue;
        }
        if (entry.kind === "file") {
          if (files.length >= maxFiles) {
            truncated = true;
            break walking;
          }
          files.push(child);
        } else if (
          entry.kind === "directory" &&
          !SKIPPED_FOLDER_NAMES.has(entry.name)
        ) {
          if (folders.length >= maxFolders) {
            truncated = true;
          } else {
            folders.push(child);
          }
        }
        // A link and anything else is never followed or listed.
      }
    }
    files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.freeze({
      ok: true,
      files: Object.freeze(files),
      truncated,
    });
  }

  return (context: ToolRunContext) => walk(context).catch(() => FAILED);
}
