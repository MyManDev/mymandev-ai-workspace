import {
  CreateProjectRequestSchema,
  CreateWorkspaceRequestSchema,
  type DeviceId,
  DeviceIdSchema,
  LIMITS,
} from "@mymandev/protocol";
import type { CommandReport } from "./account-command.ts";
import type { Database } from "./db.ts";
import { checkServerAddress, DEV_SEED_FLAG } from "./dev-seed-command.ts";
import {
  createDevWorkspace,
  type CreateDevWorkspaceResult,
} from "./dev-workspace.ts";
import {
  MAX_ACTIVE_PROJECTS_PER_WORKSPACE,
  MAX_NEW_PROJECTS_PER_DAY,
} from "./projects.ts";

/** The names that the command uses when no flag sets them. */
export const DEV_WORKSPACE_DEFAULT_NAMES = Object.freeze({
  workspace: "Test workspace",
  project: "Test project",
});

export const DEV_WORKSPACE_USAGE = `Usage: ${DEV_SEED_FLAG}=1 db:dev-workspace -- <device ID (UUIDv7)> [--workspace <name>] [--project <name>]`;

export type DevWorkspaceCommand = Readonly<{
  deviceId: DeviceId;
  /** As `CreateWorkspaceRequestSchema` parsed it. */
  workspaceName: string;
  /** As `CreateProjectRequestSchema` parsed it: normalized. */
  projectName: string;
}>;

export type ParsedDevWorkspaceCommand =
  | Readonly<{ ok: true; command: DevWorkspaceCommand }>
  | Readonly<{ ok: false; message: string }>;

const FLAGS = ["--workspace", "--project"] as const;
type Flag = (typeof FLAGS)[number];

function isFlag(value: string): value is Flag {
  return (FLAGS as readonly string[]).includes(value);
}

/** Why a name is refused, without repeating it. */
function nameRule(what: "workspace" | "project"): string {
  const normalized =
    what === "project"
      ? ", after Unicode NFC normalization and without white space at the start and the end"
      : "";
  return `Refused: the ${what} name must be 1 to ${LIMITS.name} characters of single-line text that is not blank and holds no control, format, or invisible characters${normalized}, as the API requires.`;
}

/**
 * Reads the arguments of the development command `db:dev-workspace`
 * (`src/dev-workspace-cli.ts`): a device ID, then optionally `--workspace`
 * and `--project`, each at most once and in either order, each followed by a
 * name. A malformed device ID, an unknown, repeated, or incomplete flag, and
 * an extra argument are refused with the usage; a name that the API's
 * request schemas refuse is refused with their rule. The names default to
 * `DEV_WORKSPACE_DEFAULT_NAMES`.
 */
export function parseDevWorkspaceCommand(
  args: readonly string[],
): ParsedDevWorkspaceCommand {
  const refused: ParsedDevWorkspaceCommand = {
    ok: false,
    message: DEV_WORKSPACE_USAGE,
  };
  const [device, ...rest] = args;
  const deviceId = DeviceIdSchema.safeParse(device);
  if (!deviceId.success) {
    return refused;
  }
  const names = new Map<Flag, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (
      flag === undefined ||
      !isFlag(flag) ||
      names.has(flag) ||
      value === undefined
    ) {
      return refused;
    }
    names.set(flag, value);
  }
  const workspaceName = CreateWorkspaceRequestSchema.shape.name.safeParse(
    names.get("--workspace") ?? DEV_WORKSPACE_DEFAULT_NAMES.workspace,
  );
  if (!workspaceName.success) {
    return { ok: false, message: nameRule("workspace") };
  }
  const projectName = CreateProjectRequestSchema.shape.name.safeParse(
    names.get("--project") ?? DEV_WORKSPACE_DEFAULT_NAMES.project,
  );
  if (!projectName.success) {
    return { ok: false, message: nameRule("project") };
  }
  return {
    ok: true,
    command: {
      deviceId: deviceId.data,
      workspaceName: workspaceName.data,
      projectName: projectName.data,
    },
  };
}

/** A wait in whole minutes, rounded up, at least one. */
function minutes(ms: number): string {
  const count = Math.max(1, Math.ceil(ms / 60_000));
  return count === 1 ? "1 minute" : `${count} minutes`;
}

/** What the command prints, and its exit code. */
export function devWorkspaceReport(
  result: CreateDevWorkspaceResult,
): CommandReport {
  if (result.created) {
    return {
      exitCode: 0,
      message: [
        `Workspace and project created for account ${result.userId}:`,
        `Workspace ID: ${result.workspaceId}`,
        `Project ID: ${result.projectId}`,
      ].join("\n"),
    };
  }
  if (result.refusal === "exists") {
    // A second run with the same names: the IDs of the first, or a refusal
    // when the workspace has no project of that name.
    return result.projectId === null
      ? {
          exitCode: 1,
          message: `Refused: account ${result.userId} already owns a workspace of that name, ${result.workspaceId}, without a project of that name. Nothing was changed. Choose another workspace name with --workspace.`,
        }
      : {
          exitCode: 0,
          message: [
            `Nothing was created: account ${result.userId} already owns a workspace of that name with a project of that name:`,
            `Workspace ID: ${result.workspaceId}`,
            `Project ID: ${result.projectId}`,
          ].join("\n"),
        };
  }
  if (result.refusal === "rate_limited") {
    const reason =
      result.limit === "workspaces"
        ? "the account reached its limit of new workspaces within 24 hours"
        : result.retryAfterMs === null
          ? `the workspace holds ${MAX_ACTIVE_PROJECTS_PER_WORKSPACE} projects that are not archived`
          : `the account created ${MAX_NEW_PROJECTS_PER_DAY} projects within 24 hours`;
    const retry =
      result.retryAfterMs === null
        ? ""
        : ` Try again in ${minutes(result.retryAfterMs)}.`;
    return {
      exitCode: 1,
      message: `Refused: ${reason}. Nothing was changed.${retry}`,
    };
  }
  const reasons = {
    device_not_found: "the device does not exist or is revoked",
    account_disabled: "the device's account is disabled",
    invalid_name:
      "the workspace name, the project name, or the account's display name, which becomes the owner's person name, does not meet the API's rules",
    not_member:
      "the device's account is not an active member of the new workspace",
    conflict: "a project of the new workspace already has that name",
  } satisfies Record<typeof result.refusal, string>;
  return {
    exitCode: 1,
    message: `Refused: ${reasons[result.refusal]}. Nothing was changed.`,
  };
}

/**
 * The command's work once it is connected: it refuses a server that did not
 * take the connection on a loopback address (`checkServerAddress`, with the
 * `host(inet_server_addr())` that the command read) before it writes
 * anything, and then creates the workspace and the project.
 */
export async function runDevWorkspaceCommand(
  db: Database,
  input: Readonly<{
    command: DevWorkspaceCommand;
    serverAddress: string | null;
    now: Date;
  }>,
): Promise<CommandReport> {
  const remote = checkServerAddress(input.serverAddress);
  if (remote !== undefined) {
    return { exitCode: 1, message: remote };
  }
  return devWorkspaceReport(
    await createDevWorkspace(db, { ...input.command, now: input.now }),
  );
}
