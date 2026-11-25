// The paths that an agent's tool names inside the run's repository (#36,
// first slice: read tools). This module is lexical only: it reads no file.
// It accepts a relative path in POSIX form, segment by segment, and refuses
// every form that could name something outside the repository, or another
// thing than it seems to on one of the platforms: an absolute path, a drive
// letter, a UNC path, a `..` or `.` segment, NUL and the other control
// characters, a backslash, a Windows device name, an alternate data stream,
// and a name that Windows would change (a trailing dot or space). The same
// rules hold on every platform, so that a path means the same thing on each.
//
// The read tools (`read-tools.ts`) then resolve the real path and refuse
// anything that leaves the repository's real root or reaches it through a
// link; this module never decides that alone.

/**
 * Why a path is refused, a closed list. The lexical reasons come from
 * `parseRepositoryPath`; `outside`, `alias`, `hard_link`, and `changed` come
 * from the read tools, after the file system was read.
 *
 * - `not_text`: the path is not a string.
 * - `empty`: the path is empty.
 * - `too_long`: the path is longer than `MAX_REPOSITORY_PATH_LENGTH`, or a
 *   segment longer than `MAX_REPOSITORY_PATH_SEGMENT_LENGTH`.
 * - `nul`: the path holds NUL.
 * - `control`: the path holds another control character.
 * - `backslash`: the path holds a backslash; only `/` separates.
 * - `unc`: the path starts with two slashes, a UNC path.
 * - `absolute`: the path starts with a slash.
 * - `drive`: the path starts with a drive letter and a colon.
 * - `stream`: the path holds a colon elsewhere, which names an alternate
 *   data stream on Windows.
 * - `reserved_character`: the path holds a character that Windows reserves
 *   in names (`<`, `>`, `"`, `|`, `?`, `*`).
 * - `empty_segment`: two slashes in a row, or a slash at the end.
 * - `dot_segment`: a `.` segment, other than the whole path `.`.
 * - `dot_dot`: a `..` segment.
 * - `trailing_dot_space`: a segment that ends with a dot or a space, which
 *   Windows strips, so that `.git.` would name `.git`.
 * - `device_name`: a segment that is a Windows device name, also with an
 *   extension (`con`, `nul.txt`, `com1`, `lpt9`, `conin$`, `clock$`).
 * - `git`: a segment is `.git`, in any case: the repository's Git folder or
 *   file, and everything in it.
 * - `hidden`: a segment starts with a dot (default until the Project Manager
 *   decides: hidden files, such as `.env`, are neither listed nor read).
 * - `outside`: the real path leaves the repository's real root.
 * - `alias`: the real path is not the path itself under the real root: it
 *   passes through a symbolic link or a junction, or it names its target in
 *   another case or by a short name (default until the Project Manager
 *   decides: also a link that stays inside the repository).
 * - `hard_link`: the file has more than one hard link (default until the
 *   Project Manager decides), since another name of it may lie outside.
 * - `changed`: the file or folder changed between its check and its read,
 *   or the repository's folder is no longer the folder that the link
 *   recorded.
 * - `other_device`: the file or a folder on its path lies on another device
 *   than the repository's folder: a mounted volume, a bind mount, or a
 *   mount point inside the repository (default until the Project Manager
 *   decides).
 */
export const REPOSITORY_PATH_REFUSALS = Object.freeze([
  "not_text",
  "empty",
  "too_long",
  "nul",
  "control",
  "backslash",
  "unc",
  "absolute",
  "drive",
  "stream",
  "reserved_character",
  "empty_segment",
  "dot_segment",
  "dot_dot",
  "trailing_dot_space",
  "device_name",
  "git",
  "hidden",
  "outside",
  "alias",
  "hard_link",
  "changed",
  "other_device",
] as const);
export type RepositoryPathRefusal = (typeof REPOSITORY_PATH_REFUSALS)[number];

/** The longest path that a tool takes, in UTF-16 code units (default). */
export const MAX_REPOSITORY_PATH_LENGTH = 1_024;
/** The longest segment, in UTF-16 code units (default). */
export const MAX_REPOSITORY_PATH_SEGMENT_LENGTH = 255;

/**
 * A path that passed the lexical rules: its segments, none of them empty,
 * `.`, or `..`. The repository's root is `.`, with no segment.
 */
export interface RepositoryPath {
  /** The path as the tool got it, which an answer may repeat. */
  readonly text: string;
  readonly segments: readonly string[];
}

export type RepositoryPathParse =
  | { readonly ok: true; readonly path: RepositoryPath }
  | { readonly ok: false; readonly reason: RepositoryPathRefusal };

const NUL = "\u0000";

/**
 * Whether the text holds a control character other than NUL: the other C0
 * controls, DEL, and the C1 controls.
 */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code > 0x00 && code < 0x20) || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

const RESERVED = /[<>"|?*]/u;
const DRIVE = /^[A-Za-z]:/u;
/**
 * The Windows device names, with or without an extension, in any case;
 * the superscript digits count as digits for `COM` and `LPT`.
 */
const DEVICE_NAME =
  /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(?:\..*)?$/iu;

function refused(reason: RepositoryPathRefusal): RepositoryPathParse {
  return Object.freeze({ ok: false, reason });
}

/**
 * Why one segment of a path is refused, or null. The same rules decide
 * which names of a folder a listing shows, so that every name it shows can
 * be named again in a path.
 */
export function segmentRefusal(segment: string): RepositoryPathRefusal | null {
  if (segment === "") {
    return "empty_segment";
  }
  if (segment.length > MAX_REPOSITORY_PATH_SEGMENT_LENGTH) {
    return "too_long";
  }
  if (segment.includes(NUL)) {
    return "nul";
  }
  if (hasControlCharacter(segment)) {
    return "control";
  }
  if (segment.includes("\\")) {
    return "backslash";
  }
  if (segment.includes(":")) {
    return "stream";
  }
  if (RESERVED.test(segment)) {
    return "reserved_character";
  }
  if (segment === ".") {
    return "dot_segment";
  }
  if (segment === "..") {
    return "dot_dot";
  }
  if (segment.endsWith(".") || segment.endsWith(" ")) {
    return "trailing_dot_space";
  }
  if (DEVICE_NAME.test(segment)) {
    return "device_name";
  }
  if (segment.toLowerCase() === ".git") {
    return "git";
  }
  if (segment.startsWith(".")) {
    return "hidden";
  }
  return null;
}

/**
 * Parses a path that a tool got, by the lexical rules above: first the
 * rules of the whole path, then `segmentRefusal` for each segment between
 * the slashes. The whole path `.` is the repository's root. It never
 * throws.
 */
export function parseRepositoryPath(value: unknown): RepositoryPathParse {
  if (typeof value !== "string") {
    return refused("not_text");
  }
  if (value === "") {
    return refused("empty");
  }
  if (value.length > MAX_REPOSITORY_PATH_LENGTH) {
    return refused("too_long");
  }
  if (value.startsWith("//")) {
    return refused("unc");
  }
  if (value.startsWith("/")) {
    return refused("absolute");
  }
  if (DRIVE.test(value)) {
    return refused("drive");
  }
  if (value === ".") {
    return Object.freeze({
      ok: true,
      path: Object.freeze({ text: value, segments: Object.freeze([]) }),
    });
  }
  const segments = value.split("/");
  for (const segment of segments) {
    const reason = segmentRefusal(segment);
    if (reason !== null) {
      return refused(reason);
    }
  }
  return Object.freeze({
    ok: true,
    path: Object.freeze({ text: value, segments: Object.freeze(segments) }),
  });
}
