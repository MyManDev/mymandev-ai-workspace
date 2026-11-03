import {
  type AgentId,
  type DeviceId,
  INITIAL_RUN_STATE,
  newId,
  type ProjectId,
  type RunId,
  type RunState,
} from "@mymandev/protocol";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import {
  agentRuns,
  agents,
  devices,
  projects,
  workspaceMembers,
  workspaces,
} from "./schema/index.ts";

// The test source of M2 (#28, D2; ADR 0007, update of 2026-11-02): an agent
// hosted on the developer's device with runs in `queued`, which a
// development-only switch of the desktop moves through allowed transitions
// as the agent. No production route creates agents or runs before #35, so
// this module is not exported from the package: only the development
// command `db:dev-seed` (`src/dev-seed-cli.ts`) and the tests import it.
//
// Lock order, as `src/people.ts` asks of a writer that inserts an agent or a
// run: the device (`devices`) `FOR SHARE`, after which a revocation, which
// updates it, waits for the seed or is seen by it; then the owner's active
// person (`workspace_members`) `FOR SHARE`, which a removal waits for; then
// the project (`projects`) `FOR SHARE`, which an erasure that archives it
// waits for. The owner of the agent and the requester of its runs are the
// device's account.

/** The fewest and the most runs that one seed creates. */
export const DEV_SEED_RUNS = Object.freeze({ min: 1, max: 20, default: 3 });

/** The name of a seeded agent. */
export const DEV_SEED_AGENT_NAME = "Test agent";

export type SeedDevAgentInput = Readonly<{
  /** The developer's device; it hosts the agent, and its account owns it. */
  deviceId: DeviceId;
  projectId: ProjectId;
  /** From `DEV_SEED_RUNS.min` to `DEV_SEED_RUNS.max`; outside, a RangeError. */
  runs: number;
  now: Date;
}>;

export type SeedDevAgentResult =
  | Readonly<{
      seeded: true;
      agentId: AgentId;
      /** In the order of their creation, one millisecond apart from `now`. */
      runIds: readonly RunId[];
    }>
  | Readonly<{
      seeded: false;
      /**
       * `device_not_found`: the device does not exist or is revoked;
       * `project_not_found`: the project does not exist;
       * `not_member`: the device's account is not an active member of the
       * project's workspace; `archived`: the project or its workspace is
       * archived.
       */
      refusal:
        "device_not_found" | "project_not_found" | "not_member" | "archived";
    }>;

/**
 * Creates, in one transaction, an agent named `DEV_SEED_AGENT_NAME` in the
 * project, owned by the device's account and hosted on the device, and
 * `runs` runs of it in `queued`, requested by the same account, without a
 * repository or a correlation ID. Development only: the command that calls
 * it refuses a database that is not on the developer's own computer
 * (`src/dev-seed-command.ts`). Nothing is written when it refuses.
 */
export async function seedDevAgent(
  db: Database,
  input: SeedDevAgentInput,
): Promise<SeedDevAgentResult> {
  if (
    !Number.isSafeInteger(input.runs) ||
    input.runs < DEV_SEED_RUNS.min ||
    input.runs > DEV_SEED_RUNS.max
  ) {
    throw new RangeError(
      `A seed creates from ${DEV_SEED_RUNS.min} to ${DEV_SEED_RUNS.max} runs`,
    );
  }
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<SeedDevAgentResult> => {
      const [device] = await tx
        .select({ userId: devices.userId })
        .from(devices)
        .where(and(eq(devices.id, input.deviceId), isNull(devices.revokedAt)))
        .for("share");
      if (device === undefined) {
        return { seeded: false, refusal: "device_not_found" };
      }
      const [project] = await tx
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(eq(projects.id, input.projectId));
      if (project === undefined) {
        return { seeded: false, refusal: "project_not_found" };
      }
      const [person] = await tx
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, project.workspaceId),
            eq(workspaceMembers.userId, device.userId),
            isNull(workspaceMembers.removedAt),
          ),
        )
        .for("share");
      if (person === undefined) {
        return { seeded: false, refusal: "not_member" };
      }
      const [state] = await tx
        .select({
          projectArchivedAt: projects.archivedAt,
          workspaceArchivedAt: workspaces.archivedAt,
        })
        .from(projects)
        .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
        .where(eq(projects.id, input.projectId))
        .for("share", { of: projects });
      if (
        state === undefined ||
        state.projectArchivedAt !== null ||
        state.workspaceArchivedAt !== null
      ) {
        return { seeded: false, refusal: "archived" };
      }

      const agentId = newId<AgentId>();
      await tx.insert(agents).values({
        id: agentId,
        projectId: input.projectId,
        ownerUserId: device.userId,
        hostDeviceId: input.deviceId,
        name: DEV_SEED_AGENT_NAME,
        createdAt: input.now,
        updatedAt: input.now,
      });
      const runIds = Array.from({ length: input.runs }, () => newId<RunId>());
      await tx.insert(agentRuns).values(
        runIds.map((id, index) => ({
          id,
          agentId,
          projectId: input.projectId,
          requestedByUserId: device.userId,
          state: INITIAL_RUN_STATE as RunState,
          createdAt: new Date(input.now.getTime() + index),
        })),
      );
      return { seeded: true, agentId, runIds: Object.freeze(runIds) };
    }),
  );
}
