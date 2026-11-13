// The seen claims (#95, decision D8 of 2026-11-13, and the Project Manager's
// decision of 2026-11-13 on #270 to keep the seen claims rather than a
// time): for each workspace and account on this device, the member IDs of
// the claims that the account has seen, so that a claim made while the
// application was closed is new at the next start.
//
// One small versioned JSON file in the application's data folder (Electron's
// `userData` path, `appData` and `DATA_FOLDER_NAME`), written atomically like
// the device files. Each entry names the workspace and the account's own
// person in it: a person belongs to one workspace and is claimed by one
// account only, once, so the pair names the account and the workspace
// together, and another account on this device never finds the entries of
// an earlier one. The file holds IDs only, never a login, a name, or a
// secret.
import path from "node:path";
import {
  type MemberId,
  MemberIdSchema,
  RECENT_CLAIMS,
  type WorkspaceId,
  WorkspaceIdSchema,
} from "@mymandev/protocol";
import * as z from "zod";
import {
  isTemporaryFileOf,
  KEY_FOLDER_MODE,
  type KeyFileSystem,
  nodeKeyFileSystem,
  readFileIfPresent,
  removeFile,
  writeFileAtomic,
} from "../device-key/atomic-file.ts";

/** The file of the seen claims, in the data folder. */
export const CLAIM_SEEN_FILE = "claims-seen.json";

/**
 * The format version that this build writes and reads. Version 1, which
 * kept the time of the newest claim seen, never shipped; a file of it is
 * not of this format and counts as no entry.
 */
export const CLAIM_SEEN_VERSION = 2;

/**
 * At most this many entries are kept, one for each workspace and account;
 * the service drops the one that changed longest ago first. An account is
 * the owner or an admin of far fewer workspaces, and the whole file is
 * written again on every change, so the limit keeps it small.
 */
export const MAX_CLAIM_SEEN_ENTRIES = 200;

/**
 * At most this many seen claims are kept for each entry: the claims that
 * the API lists (`RECENT_CLAIMS`). The service keeps only claims of its
 * latest list, the most recent first.
 */
export const MAX_SEEN_CLAIMS_PER_ENTRY = RECENT_CLAIMS;

/** A full file is about 410 KB; a larger one is not a file of this format. */
const MAX_CLAIM_SEEN_BYTES = 512 * 1024;

const ClaimSeenFileSchema = z.strictObject({
  version: z.literal(CLAIM_SEEN_VERSION),
  entries: z
    .array(
      z.strictObject({
        workspaceId: WorkspaceIdSchema,
        ownMemberId: MemberIdSchema,
        seenMemberIds: z.array(MemberIdSchema).max(MAX_SEEN_CLAIMS_PER_ENTRY),
      }),
    )
    .max(MAX_CLAIM_SEEN_ENTRIES),
});

/** The claims that an account has seen in a workspace. */
export interface ClaimSeenEntry {
  readonly workspaceId: WorkspaceId;
  /** The account's own person in the workspace. */
  readonly ownMemberId: MemberId;
  /** The member IDs of the claimed people whose claims the account saw. */
  readonly seenMemberIds: readonly MemberId[];
}

/**
 * What the data folder holds: no file, the entries, or a file that is not
 * one of this format.
 */
export type ClaimSeenRead =
  | { readonly kind: "none" }
  | { readonly kind: "entries"; readonly entries: readonly ClaimSeenEntry[] }
  | { readonly kind: "corrupt" };

export interface ClaimSeenStore {
  /**
   * Deletes the temporary files that a stopped write left, best effort, and
   * reads the entries strictly. Rejects only when the file cannot be read.
   */
  readonly read: () => Promise<ClaimSeenRead>;
  /**
   * Writes the entries atomically, in their order. Throws a `TypeError`
   * that names no value for entries outside the format.
   */
  readonly write: (entries: readonly ClaimSeenEntry[]) => Promise<void>;
}

export interface ClaimSeenStoreOptions {
  /** The data folder: Electron's `userData` path. */
  readonly folder: string;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Defaults to `node:fs/promises`. */
  readonly fileSystem?: KeyFileSystem;
}

function frozenEntries(
  entries: readonly {
    readonly workspaceId: string;
    readonly ownMemberId: string;
    readonly seenMemberIds: readonly string[];
  }[],
): readonly ClaimSeenEntry[] {
  return Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        workspaceId: entry.workspaceId as WorkspaceId,
        ownMemberId: entry.ownMemberId as MemberId,
        seenMemberIds: Object.freeze([
          ...new Set(entry.seenMemberIds as readonly MemberId[]),
        ]),
      }),
    ),
  );
}

/**
 * Decodes the bytes of a seen claims file, or returns null when they are not
 * one. A workspace and person named twice keep the later entry, in its
 * place; a member ID named twice in an entry counts once.
 */
export function decodeClaimSeen(
  bytes: Uint8Array,
): readonly ClaimSeenEntry[] | null {
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
  const unique = new Map<string, (typeof parsed.data.entries)[number]>();
  for (const entry of parsed.data.entries) {
    const key = `${entry.workspaceId} ${entry.ownMemberId}`;
    unique.delete(key);
    unique.set(key, entry);
  }
  return frozenEntries([...unique.values()]);
}

/** Encodes the entries as the bytes of a seen claims file. */
export function encodeClaimSeen(
  entries: readonly ClaimSeenEntry[],
): Uint8Array {
  const parsed = ClaimSeenFileSchema.safeParse({
    version: CLAIM_SEEN_VERSION,
    entries: frozenEntries(entries),
  });
  if (!parsed.success) {
    const field =
      parsed.error.issues[0]?.path.map(String).join(".") || "entries";
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

  /**
   * Deletes the temporary files that a write left when the process stopped,
   * as the device key store does. Best effort: a failure changes nothing,
   * and the read goes on.
   */
  async function removeTemporaryFiles(): Promise<void> {
    try {
      for (const name of await fileSystem.readdir(folder)) {
        if (isTemporaryFileOf(name, CLAIM_SEEN_FILE)) {
          await removeFile(fileSystem, path.join(folder, name)).catch(
            () => undefined,
          );
        }
      }
    } catch {
      // A missing or unreadable folder leaves nothing to delete.
    }
  }

  return Object.freeze({
    read: async (): Promise<ClaimSeenRead> => {
      await removeTemporaryFiles();
      const bytes = await readFileIfPresent(fileSystem, file);
      if (bytes === null) {
        return Object.freeze({ kind: "none" });
      }
      const entries = decodeClaimSeen(bytes);
      return entries === null
        ? Object.freeze({ kind: "corrupt" })
        : Object.freeze({ kind: "entries", entries });
    },
    write: async (entries: readonly ClaimSeenEntry[]): Promise<void> => {
      const bytes = encodeClaimSeen(entries);
      await fileSystem.mkdir(folder, {
        recursive: true,
        mode: KEY_FOLDER_MODE,
      });
      await writeFileAtomic(fileSystem, file, bytes, platform);
    },
  });
}
