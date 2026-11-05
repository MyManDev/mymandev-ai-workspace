import {
  CreateProjectRequestSchema,
  CreateWorkspaceRequestSchema,
  type DeviceId,
  type ProjectId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import type { Database } from "./db.ts";
import { toDatabaseError } from "./errors.ts";
import { createWorkspace } from "./membership.ts";
import { createProject } from "./projects.ts";
import { devices, users } from "./schema/index.ts";

// Test data for #27 and #28 (Project Manager decision of 2026-11-05): until
// #95 adds the screens that create workspaces and projects, a
// development-only command creates a workspace owned by the account of the
// developer's device, with one project, through `createWorkspace` and
// `createProject`, the functions of `POST /workspaces` and `POST
// /workspaces/:workspaceId/projects`, after the names passed the API's
// request schemas. This module is not exported from the package: only the
// development command `db:dev-workspace` (`src/dev-workspace-cli.ts`) and
// the tests import it.
//
// Lock order, as the API's `lockActor` and then the two functions: the
// account (`users`), then the device (`devices`), each `FOR NO KEY UPDATE`;
// then what `createWorkspace` and `createProject` lock.

export type CreateDevWorkspaceInput = Readonly<{
  /** The developer's device; its account owns the workspace. */
  deviceId: DeviceId;
  /** Checked again with `CreateWorkspaceRequestSchema`. */
  workspaceName: string;
  /** Normalized and checked again with `CreateProjectRequestSchema`. */
  projectName: string;
  now: Date;
}>;

export type CreateDevWorkspaceResult =
  | Readonly<{
      created: true;
      userId: UserId;
      workspaceId: WorkspaceId;
      projectId: ProjectId;
    }>
  | Readonly<{
      created: false;
      /**
       * `device_not_found`: the device does not exist or is revoked;
       * `account_disabled`: the device's account is disabled or erased;
       * `invalid_name`: the workspace name, the project name, or the
       * account's display name, which becomes the owner's person name, does
       * not pass the API's request schemas; `not_member` and `conflict`:
       * `createProject` refused the project in the new workspace, which
       * holds no other project, so neither is expected.
       */
      refusal:
        | "device_not_found"
        | "account_disabled"
        | "invalid_name"
        | "not_member"
        | "conflict";
    }>
  /**
   * A limit of `createWorkspace` (`limit: "workspaces"`) or of
   * `createProject` (`limit: "projects"`) is reached; `retryAfterMs` as
   * they return it.
   */
  | Readonly<{
      created: false;
      refusal: "rate_limited";
      limit: "workspaces" | "projects";
      retryAfterMs: number | null;
    }>;

type Refused = Extract<CreateDevWorkspaceResult, { created: false }>;

/** Rolls back the transaction after the workspace was created, with the refusal. */
class Undo extends Error {
  readonly result: Refused;

  constructor(result: Refused) {
    super("The project was refused");
    this.result = result;
  }
}

/**
 * Creates, in one transaction, a workspace named `workspaceName` that the
 * device's account owns, with the account's display name as the owner's
 * person name, and a project named `projectName` in it, through
 * `createWorkspace` and `createProject` with the device as the actor's
 * device, as the API does for the device's account. The names are parsed
 * with the API's request schemas first, so a project name is normalized
 * (NFC, without white space at the start and the end). It refuses a device
 * that does not exist or is revoked, a disabled account, and a name that
 * the schemas refuse, and returns the limits of the two functions; nothing
 * is written then. Like the API, it sends no event: a running desktop loads
 * the workspaces only when it connects. Development only: the command that
 * calls it refuses a database that is not on the developer's own computer
 * (`src/dev-seed-command.ts`).
 */
export async function createDevWorkspace(
  db: Database,
  input: CreateDevWorkspaceInput,
): Promise<CreateDevWorkspaceResult> {
  try {
    return await db.transaction(
      async (tx): Promise<CreateDevWorkspaceResult> => {
        const [owner] = await tx
          .select({ userId: devices.userId })
          .from(devices)
          .where(eq(devices.id, input.deviceId));
        if (owner === undefined) {
          return { created: false, refusal: "device_not_found" };
        }
        const [user] = await tx
          .select({
            displayName: users.displayName,
            disabledAt: users.disabledAt,
          })
          .from(users)
          .where(eq(users.id, owner.userId))
          .for("no key update");
        const [device] = await tx
          .select({ revokedAt: devices.revokedAt })
          .from(devices)
          .where(eq(devices.id, input.deviceId))
          .for("no key update");
        if (
          user === undefined ||
          device === undefined ||
          device.revokedAt !== null
        ) {
          return { created: false, refusal: "device_not_found" };
        }
        if (user.disabledAt !== null) {
          return { created: false, refusal: "account_disabled" };
        }
        const workspaceRequest = CreateWorkspaceRequestSchema.safeParse({
          name: input.workspaceName,
          displayName: user.displayName,
        });
        const projectRequest = CreateProjectRequestSchema.safeParse({
          name: input.projectName,
        });
        if (!workspaceRequest.success || !projectRequest.success) {
          return { created: false, refusal: "invalid_name" };
        }

        const workspace = await createWorkspace(tx, {
          userId: owner.userId,
          deviceId: input.deviceId,
          name: workspaceRequest.data.name,
          displayName: workspaceRequest.data.displayName,
          now: input.now,
        });
        if (!workspace.created) {
          return {
            created: false,
            refusal: "rate_limited",
            limit: "workspaces",
            retryAfterMs: workspace.retryAfterMs,
          };
        }
        const workspaceId = workspace.membership.workspace.id;
        const project = await createProject(tx, {
          workspaceId,
          userId: owner.userId,
          name: projectRequest.data.name,
          now: input.now,
        });
        if (!project.created) {
          throw new Undo(
            project.refusal === "rate_limited"
              ? {
                  created: false,
                  refusal: "rate_limited",
                  limit: "projects",
                  retryAfterMs: project.retryAfterMs,
                }
              : { created: false, refusal: project.refusal },
          );
        }
        return {
          created: true,
          userId: owner.userId,
          workspaceId,
          projectId: project.project.id,
        };
      },
    );
  } catch (error) {
    if (error instanceof Undo) {
      return error.result;
    }
    throw toDatabaseError(error);
  }
}
