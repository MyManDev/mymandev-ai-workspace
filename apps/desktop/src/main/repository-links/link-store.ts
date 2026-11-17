// The repository links of this device (#286; the Project Manager's decision
// of 2026-11-14: the cloud registers a repository, an identity and a name,
// and the folder's path stays on the device). Each link names a registered
// repository, its project and workspace, the account's own person in that
// workspace, the folder of the repository on this device, and the identity
// of that folder and of its common Git folder when it was linked.
//
// One small versioned JSON file in the local data folder of the device key
// (`repositoryLinkFolder`): `%LOCALAPPDATA%\MyManDev` on Windows, which a
// roaming profile never copies to another machine, and the data folder on
// macOS and Linux, which does not roam. The path never leaves the device
// (ADR 0013), so it is not kept in `%APPDATA%`, which roams. The file is
// written atomically like the device files, with mode 0600 on Linux and
// macOS.
//
// The identity (identity.ts; the Project Manager's decision of 2026-11-17)
// lets a resolution notice a folder that was replaced at the same path.
// Version 2 of the file added it: a file of version 1 counts as no link and
// is replaced at the next change, so each repository is linked again.
//
// The person names the account: a person belongs to one workspace and is
// claimed by one account only, once, as for the seen claims. So another
// account on this device never finds the links of an earlier one, and an
// account that leaves and joins again starts without links in that
// workspace. The file holds IDs, folders, and device and file numbers only,
// never a name or a secret.
import path from "node:path";
import {
  type MemberId,
  MemberIdSchema,
  type ProjectId,
  ProjectIdSchema,
  type RepositoryId,
  RepositoryIdSchema,
  type WorkspaceId,
  WorkspaceIdSchema,
} from "@mymandev/protocol";
import * as z from "zod";
import { REPOSITORY_LIMITS } from "../../shared/ipc-contract.ts";
import {
  isTemporaryFileOf,
  KEY_FOLDER_MODE,
  type KeyFileSystem,
  nodeKeyFileSystem,
  readFileIfPresent,
  removeFile,
  writeFileAtomic,
} from "../device-key/atomic-file.ts";
import {
  type DeviceKeyFolderOptions,
  deviceKeyFolder,
} from "../device-key/key-folder.ts";
import type { FileIdentity, RepositoryFolderIdentity } from "./identity.ts";

/** The file of the links, in the local data folder. */
export const REPOSITORY_LINK_FILE = "repository-links.json";

/**
 * The format version that this build writes and reads. Version 2 added the
 * identity of the folders; a file of version 1 counts as no link.
 */
export const REPOSITORY_LINK_VERSION = 2;

/**
 * At most this many links are kept on this device, for every account
 * together. A project holds 20 repositories, and 16 can be mounted at once,
 * so this leaves room for many projects. At the limit, a new link takes the
 * place of the oldest link of another account or of a former person; when
 * every link is the signed-in account's own, it is refused.
 */
export const MAX_REPOSITORY_LINKS = 256;

/**
 * A full file with the longest folders, each character escaped by JSON in
 * six bytes, is about 6.3 MB; a larger one is not a file of this format.
 */
const MAX_REPOSITORY_LINK_BYTES = 8 * 1024 * 1024;

/**
 * The folder of the link file: the local data folder of the device key,
 * `%LOCALAPPDATA%\MyManDev` on Windows and the data folder (`userData`) on
 * macOS and Linux, which does not roam. On Windows it throws when
 * `LOCALAPPDATA` is not set to an absolute folder with a drive: it never
 * falls back to the roaming `%APPDATA%` or to `userData`, which is in it.
 */
export function repositoryLinkFolder(options: DeviceKeyFolderOptions): string {
  return deviceKeyFolder(options);
}

/** A folder as a mount keeps it: absolute, without NUL, within the limit. */
function folderSchema(isAbsolute: (folder: string) => boolean) {
  return z
    .string()
    .min(1)
    .max(REPOSITORY_LIMITS.path, { abort: true })
    .refine((folder) => !folder.includes("\0") && isAbsolute(folder));
}

/**
 * A device or file number of `lstat` with `bigint`, as decimal text: at most
 * 20 digits without a leading zero, and a minus sign for a number that
 * Node.js reports as a signed 64-bit value.
 */
const FileNumberSchema = z.string().regex(/^-?(?:0|[1-9][0-9]{0,19})$/u);

const FileIdentitySchema = z.strictObject({
  dev: FileNumberSchema,
  ino: FileNumberSchema,
});

function fileSchema(isAbsolute: (folder: string) => boolean) {
  return z.strictObject({
    version: z.literal(REPOSITORY_LINK_VERSION),
    links: z
      .array(
        z.strictObject({
          workspaceId: WorkspaceIdSchema,
          ownMemberId: MemberIdSchema,
          projectId: ProjectIdSchema,
          repositoryId: RepositoryIdSchema,
          folder: folderSchema(isAbsolute),
          identity: z.strictObject({
            folder: FileIdentitySchema,
            commonDir: FileIdentitySchema,
          }),
        }),
      )
      .max(MAX_REPOSITORY_LINKS),
  });
}

/** One link: a registered repository of an account, and its folder here. */
export interface RepositoryLink {
  readonly workspaceId: WorkspaceId;
  /** The account's own person in the workspace, which names the account. */
  readonly ownMemberId: MemberId;
  readonly projectId: ProjectId;
  readonly repositoryId: RepositoryId;
  /** The repository's top-level folder on this device, as Git reported it. */
  readonly folder: string;
  /** The identity of the top-level folder and the common Git folder then. */
  readonly identity: RepositoryFolderIdentity;
}

/**
 * What the folder holds: no file, the links, a file that is not one of this
 * format, a file of an earlier format version, which counts as no link and
 * is replaced at the next change, or a file of a later format version,
 * which this build neither uses nor overwrites.
 */
export type RepositoryLinkRead =
  | { readonly kind: "none" }
  | { readonly kind: "links"; readonly links: readonly RepositoryLink[] }
  | { readonly kind: "corrupt" }
  | { readonly kind: "older" }
  | { readonly kind: "newer" };

export interface RepositoryLinkStore {
  /**
   * Deletes the temporary files that a stopped write left, best effort, and
   * reads the links strictly. Rejects when the folder is not known or the
   * file cannot be read.
   */
  readonly read: () => Promise<RepositoryLinkRead>;
  /**
   * Writes the links atomically, in their order. Throws a `TypeError` that
   * names no value for links outside the format.
   */
  readonly write: (links: readonly RepositoryLink[]) => Promise<void>;
}

export interface RepositoryLinkStoreOptions {
  /**
   * The local data folder (`repositoryLinkFolder`). It may throw, for
   * example on Windows without `LOCALAPPDATA`; every read and write then
   * rejects, and nothing falls back to the roaming folder.
   */
  readonly folder: () => string;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Whether a folder is absolute on this system; `path.isAbsolute`. */
  readonly isAbsolute?: (folder: string) => boolean;
  /** Defaults to `node:fs/promises`. */
  readonly fileSystem?: KeyFileSystem;
}

function frozenIdentity(identity: FileIdentity): FileIdentity {
  return Object.freeze({ dev: identity.dev, ino: identity.ino });
}

function frozenLinks(
  links: readonly {
    readonly workspaceId: string;
    readonly ownMemberId: string;
    readonly projectId: string;
    readonly repositoryId: string;
    readonly folder: string;
    readonly identity: RepositoryFolderIdentity;
  }[],
): readonly RepositoryLink[] {
  return Object.freeze(
    links.map((link) =>
      Object.freeze({
        workspaceId: link.workspaceId as WorkspaceId,
        ownMemberId: link.ownMemberId as MemberId,
        projectId: link.projectId as ProjectId,
        repositoryId: link.repositoryId as RepositoryId,
        folder: link.folder,
        identity: Object.freeze({
          folder: frozenIdentity(link.identity.folder),
          commonDir: frozenIdentity(link.identity.commonDir),
        }),
      }),
    ),
  );
}

/** The whole format version of parsed JSON, or null when it has none. */
function formatVersion(value: unknown): number | null {
  return typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "number" &&
    Number.isSafeInteger(value.version)
    ? value.version
    : null;
}

/**
 * Decodes the bytes of a link file. A repository linked twice by the same
 * person keeps the later link, in its place.
 */
export function decodeRepositoryLinks(
  bytes: Uint8Array,
  isAbsolute: (folder: string) => boolean = path.isAbsolute,
): RepositoryLinkRead {
  if (bytes.length > MAX_REPOSITORY_LINK_BYTES) {
    return Object.freeze({ kind: "corrupt" });
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    return Object.freeze({ kind: "corrupt" });
  }
  const version = formatVersion(value);
  if (version !== null && version > REPOSITORY_LINK_VERSION) {
    return Object.freeze({ kind: "newer" });
  }
  // Version 1 holds no identity of the folders, so its links are not used.
  if (version !== null && version >= 1 && version < REPOSITORY_LINK_VERSION) {
    return Object.freeze({ kind: "older" });
  }
  const parsed = fileSchema(isAbsolute).safeParse(value);
  if (!parsed.success) {
    return Object.freeze({ kind: "corrupt" });
  }
  const unique = new Map<string, (typeof parsed.data.links)[number]>();
  for (const link of parsed.data.links) {
    const key = `${link.workspaceId} ${link.ownMemberId} ${link.repositoryId}`;
    unique.delete(key);
    unique.set(key, link);
  }
  return Object.freeze({
    kind: "links",
    links: frozenLinks([...unique.values()]),
  });
}

/** Encodes the links as the bytes of a link file. */
export function encodeRepositoryLinks(
  links: readonly RepositoryLink[],
  isAbsolute: (folder: string) => boolean = path.isAbsolute,
): Uint8Array {
  const parsed = fileSchema(isAbsolute).safeParse({
    version: REPOSITORY_LINK_VERSION,
    links,
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.map(String).join(".") || "links";
    throw new TypeError(`Invalid repository link field ${field}`);
  }
  return Buffer.from(`${JSON.stringify(parsed.data)}\n`, "utf8");
}

export function createRepositoryLinkStore(
  options: RepositoryLinkStoreOptions,
): RepositoryLinkStore {
  const { platform } = options;
  const isAbsolute = options.isAbsolute ?? path.isAbsolute;
  const fileSystem = options.fileSystem ?? nodeKeyFileSystem;

  /**
   * Deletes the temporary files that a write left when the process stopped,
   * as the device key store does. Best effort: a failure changes nothing.
   */
  async function removeTemporaryFiles(folder: string): Promise<void> {
    try {
      for (const name of await fileSystem.readdir(folder)) {
        if (isTemporaryFileOf(name, REPOSITORY_LINK_FILE)) {
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
    read: async (): Promise<RepositoryLinkRead> => {
      const folder = options.folder();
      await removeTemporaryFiles(folder);
      const bytes = await readFileIfPresent(
        fileSystem,
        path.join(folder, REPOSITORY_LINK_FILE),
      );
      return bytes === null
        ? Object.freeze({ kind: "none" })
        : decodeRepositoryLinks(bytes, isAbsolute);
    },
    write: async (links: readonly RepositoryLink[]): Promise<void> => {
      const bytes = encodeRepositoryLinks(links, isAbsolute);
      const folder = options.folder();
      await fileSystem.mkdir(folder, {
        recursive: true,
        mode: KEY_FOLDER_MODE,
      });
      await writeFileAtomic(
        fileSystem,
        path.join(folder, REPOSITORY_LINK_FILE),
        bytes,
        platform,
      );
    },
  });
}
