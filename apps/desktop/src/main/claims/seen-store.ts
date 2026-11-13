// The seen claims (#95, decision D8 of 2026-11-13): for each workspace and
// account on this device, the `claimedAt` of the newest claim that the
// account has seen, so that a claim made while the application was closed
// is marked as new at the next start.
//
// One small versioned JSON file in the application's data folder (Electron's
// `userData` path, `appData` and `DATA_FOLDER_NAME`), written atomically like
// the device files. Each mark names the workspace and the account's own
// person in it: a person belongs to one workspace and is claimed by one
// account only, once, so the pair names the account and the workspace
// together, and another account on this device never finds the marks of an
// earlier one. The file holds IDs and times only, never a login or a name,
// and no secret.
import path from "node:path";
import {
  type MemberId,
  MemberIdSchema,
  UtcTimestampSchema,
  type WorkspaceId,
  WorkspaceIdSchema,
} from "@mymandev/protocol";
import * as z from "zod";
import {
  KEY_FOLDER_MODE,
  type KeyFileSystem,
  nodeKeyFileSystem,
  readFileIfPresent,
  writeFileAtomic,
} from "../device-key/atomic-file.ts";

/** The file of the seen claims, in the data folder. */
export const CLAIM_SEEN_FILE = "claims-seen.json";

/** The format version that this build writes and reads. */
export const CLAIM_SEEN_VERSION = 1;

/**
 * At most this many marks are kept, one for each workspace and account; the
 * service drops the one that moved longest ago first. It is the most
 * workspaces that one answer of the API lists (`MAX_ANSWER_LIST_ITEMS`).
 */
export const MAX_CLAIM_SEEN_MARKS = 1_000;

/**
 * A full file is about 140 KB; a larger one is not a file of this format.
 */
const MAX_CLAIM_SEEN_BYTES = 256 * 1024;

const ClaimSeenFileSchema = z.strictObject({
  version: z.literal(CLAIM_SEEN_VERSION),
  marks: z
    .array(
      z.strictObject({
        workspaceId: WorkspaceIdSchema,
        memberId: MemberIdSchema,
        seenAt: UtcTimestampSchema,
      }),
    )
    .max(MAX_CLAIM_SEEN_MARKS),
});

/** The newest claim that an account has seen in a workspace. */
export interface ClaimSeenMark {
  readonly workspaceId: WorkspaceId;
  /** The account's own person in the workspace. */
  readonly memberId: MemberId;
  /** The `claimedAt` of the newest claim seen, in the protocol's form. */
  readonly seenAt: string;
}

/**
 * What the data folder holds: no file, the marks, or a file that is not one
 * of this format.
 */
export type ClaimSeenRead =
  | { readonly kind: "none" }
  | { readonly kind: "marks"; readonly marks: readonly ClaimSeenMark[] }
  | { readonly kind: "corrupt" };

export interface ClaimSeenStore {
  /** Reads the marks strictly. Rejects only when the file cannot be read. */
  readonly read: () => Promise<ClaimSeenRead>;
  /**
   * Writes the marks atomically, in their order. Throws a `TypeError` that
   * names no value for marks outside the format.
   */
  readonly write: (marks: readonly ClaimSeenMark[]) => Promise<void>;
}

export interface ClaimSeenStoreOptions {
  /** The data folder: Electron's `userData` path. */
  readonly folder: string;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Defaults to `node:fs/promises`. */
  readonly fileSystem?: KeyFileSystem;
}

function frozenMarks(
  marks: readonly {
    readonly workspaceId: string;
    readonly memberId: string;
    readonly seenAt: string;
  }[],
): readonly ClaimSeenMark[] {
  return Object.freeze(
    marks.map((mark) =>
      Object.freeze({
        workspaceId: mark.workspaceId as WorkspaceId,
        memberId: mark.memberId as MemberId,
        seenAt: mark.seenAt,
      }),
    ),
  );
}

/**
 * Decodes the bytes of a seen claims file, or returns null when they are not
 * one. A workspace and person named twice keep the later mark.
 */
export function decodeClaimSeen(
  bytes: Uint8Array,
): readonly ClaimSeenMark[] | null {
  if (bytes.length > MAX_CLAIM_SEEN_BYTES) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    return null;
  }
  const parsed = ClaimSeenFileSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const unique = new Map<string, (typeof parsed.data.marks)[number]>();
  for (const mark of parsed.data.marks) {
    const key = `${mark.workspaceId} ${mark.memberId}`;
    unique.delete(key);
    unique.set(key, mark);
  }
  return frozenMarks([...unique.values()]);
}

/** Encodes the marks as the bytes of a seen claims file. */
export function encodeClaimSeen(marks: readonly ClaimSeenMark[]): Uint8Array {
  const parsed = ClaimSeenFileSchema.safeParse({
    version: CLAIM_SEEN_VERSION,
    marks: frozenMarks(marks),
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.map(String).join(".") || "marks";
    throw new TypeError(`Invalid seen claims field ${field}`);
  }
  return Buffer.from(`${JSON.stringify(parsed.data)}\n`, "utf8");
}

export function createClaimSeenStore(
  options: ClaimSeenStoreOptions,
): ClaimSeenStore {
  const { folder, platform } = options;
  const fileSystem = options.fileSystem ?? nodeKeyFileSystem;
  const file = path.join(folder, CLAIM_SEEN_FILE);

  return Object.freeze({
    read: async (): Promise<ClaimSeenRead> => {
      const bytes = await readFileIfPresent(fileSystem, file);
      if (bytes === null) {
        return Object.freeze({ kind: "none" });
      }
      const marks = decodeClaimSeen(bytes);
      return marks === null
        ? Object.freeze({ kind: "corrupt" })
        : Object.freeze({ kind: "marks", marks });
    },
    write: async (marks: readonly ClaimSeenMark[]): Promise<void> => {
      const bytes = encodeClaimSeen(marks);
      await fileSystem.mkdir(folder, {
        recursive: true,
        mode: KEY_FOLDER_MODE,
      });
      await writeFileAtomic(fileSystem, file, bytes, platform);
    },
  });
}
