import {
  AGENT_COUNT_LIMITS,
  type AgentId,
  type AgentListItem,
  type DeviceId,
  type MemberId,
  newId,
  type PermissionGrantId,
  type ProjectId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { and, count, desc, eq, gt, isNull, min, sql } from "drizzle-orm";
import {
  type CancelledRun,
  cancelRuns,
  disableAgents,
  revokeGrants,
} from "./cascade.ts";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import { administers } from "./people.ts";
import {
  agentRuns,
  agents,
  devices,
  permissionGrants,
  projects,
  users,
  workspaceMembers,
  workspaces,
} from "./schema/index.ts";

// Creating and disabling an agent of a project (#294; Project Manager
// decisions of 2026-11-20, whose defaults the Project Manager accepted on
// 2026-11-23). The routes and their codes are the protocol's `AGENT_ROUTES`
// and `AGENT_ROUTE_ERRORS`, and the limits its `AGENT_COUNT_LIMITS`.
//
// - Any active member of the project's workspace creates an agent, from the
//   calling device, which becomes the agent's host device; the caller's
//   account owns it. An agent's project, owner, and host device never
//   change, and its name is a label: no unique index, stored as given. The
//   API passes names that the protocol checked. An agent has no provider
//   kind: a run names its provider connection (ADR 0007, update of
//   2026-11-14).
// - The agent's owner, from any device, and the workspace's owner and
//   admins disable it. Disabling is final in v0: nothing clears
//   `disabled_at`. In the same transaction it revokes the agent's grants that
//   are not revoked yet, an expired one included, with the disabling account
//   as `revoked_by_user_id` (ADR 0015, P-77), and cancels the agent's
//   unfinished runs with the reason `agent_disabled` (`src/cascade.ts`). The
//   result lists the revoked grants for the `agent.grant.revoked` events that
//   the grant routes will send (#75); the API sends none yet, as for a
//   repository removal, a device revocation, or a removal of a person.
// - Neither function writes an audit record: they are not administrative
//   actions of ADR 0014, and its audit vocabulary has no agent action.
//
// Lock order. A creation, as `src/people.ts` asks of a writer that inserts
// an agent, and as `src/repositories.ts` registers a repository: the account
// (`users`) `FOR NO KEY UPDATE`, so that the creations of one account are
// counted one after another; the calling device (`devices`) `FOR SHARE`,
// which a device revocation, which updates it, waits for, and then disables
// the new agent; both after `lockActor` in the API, which already holds
// them. Then the acting person (`workspace_members`) `FOR SHARE`, which a
// removal, which holds it `FOR NO KEY UPDATE`, waits for, and then disables
// the new agent. Then the project (`projects`) `FOR NO KEY UPDATE`, so that
// the creations of one project are counted one after another.
//
// A disable takes the order of a device revocation and a removal of a person
// for the rows that they change (`src/cascade.ts`): after the account and the
// device that `lockActor` locks, the acting person `FOR SHARE`, then the
// project `FOR SHARE`, then the agent `FOR NO KEY UPDATE`, then its grants,
// then its runs, each in the order of their IDs. A run creation
// (`src/runs.ts`) locks the person, the project, and the agent in the same
// order; a grant (`src/grants.ts`) and a run transition
// (`src/agent-activity.ts`) lock the agent `FOR SHARE` before any grant or
// run, so either the disable commits first and they find the agent
// disabled, or they commit first and the disable revokes the new grant or
// cancels the run.

const DAY_MS = 24 * 60 * 60_000;

export type CreateAgentInput = Readonly<{
  projectId: ProjectId;
  /** The acting account; its active person in the project's workspace creates the agent, and the account owns it. */
  userId: UserId;
  /** The calling device of the account; it becomes the agent's host device. */
  deviceId: DeviceId;
  name: string;
  now: Date;
}>;

/** Why a creation was refused. Nothing was written. */
export type CreateAgentRefusal =
  /**
   * The account is disabled, or the device is not an active device of the
   * account. The API's `lockActor` refuses both before, with
   * `unauthorized`.
   */
  | "forbidden"
  /**
   * The account is not an active member of the project's workspace, also
   * when the project does not exist.
   */
  | "not_member"
  /** The project or its workspace is archived. */
  | "conflict"
  /**
   * The project holds `AGENT_COUNT_LIMITS.enabledPerProject` enabled agents,
   * or has `AGENT_COUNT_LIMITS.perProject` agents, disabled ones included.
   * No time frees a place.
   */
  | "agent_limit";

export type CreateAgentResult =
  | Readonly<{
      created: true;
      /** The project's workspace, whose subscribers the caller tells. */
      workspaceId: WorkspaceId;
      /** The new agent as every member sees it in the agent list. */
      agent: AgentListItem;
    }>
  | Readonly<{ created: false; refusal: CreateAgentRefusal }>
  /**
   * The account created `AGENT_COUNT_LIMITS.perDay` agents within 24 hours,
   * the oldest of which leaves the window after `retryAfterMs`.
   */
  | Readonly<{
      created: false;
      refusal: "rate_limited";
      retryAfterMs: number;
    }>;

/**
 * Creates an agent in a project in one transaction (#294), hosted on the
 * calling device and owned by the acting account. It decides in this order:
 * `forbidden` for a disabled account or a device that is not an active
 * device of the account; `not_member`; `conflict` for an archived project
 * or workspace; `agent_limit` when the project holds
 * `AGENT_COUNT_LIMITS.enabledPerProject` enabled agents, and then when it
 * has `AGENT_COUNT_LIMITS.perProject` agents, disabled ones included; then
 * `rate_limited` when the account created `AGENT_COUNT_LIMITS.perDay`
 * agents, in any project, disabled ones included, whose `created_at` lies
 * within 24 hours before `now`. It inserts the agent with `name` as given
 * and the time `now`, enabled. Inside another transaction it runs as a
 * savepoint.
 */
export async function createAgent(
  db: Database,
  input: CreateAgentInput,
): Promise<CreateAgentResult> {
  const refused = (refusal: CreateAgentRefusal): CreateAgentResult => ({
    created: false,
    refusal,
  });
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<CreateAgentResult> => {
      const [account] = await tx
        .select({ disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, input.userId))
        .for("no key update");
      if (account === undefined) {
        return refused("not_member");
      }
      if (account.disabledAt !== null) {
        return refused("forbidden");
      }
      const [device] = await tx
        .select({ userId: devices.userId, revokedAt: devices.revokedAt })
        .from(devices)
        .where(eq(devices.id, input.deviceId))
        .for("share");
      if (
        device === undefined ||
        device.userId !== input.userId ||
        device.revokedAt !== null
      ) {
        return refused("forbidden");
      }

      // A project never moves to another workspace, so its workspace is
      // read before the person that the workspace names is locked.
      const [found] = await tx
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(eq(projects.id, input.projectId));
      if (found === undefined) {
        return refused("not_member");
      }
      const [person] = await tx
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, found.workspaceId),
            eq(workspaceMembers.userId, input.userId),
            isNull(workspaceMembers.removedAt),
          ),
        )
        .for("share");
      if (person === undefined) {
        return refused("not_member");
      }
      const [place] = await tx
        .select({
          projectArchivedAt: projects.archivedAt,
          workspaceArchivedAt: workspaces.archivedAt,
        })
        .from(projects)
        .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
        .where(eq(projects.id, input.projectId))
        .for("no key update", { of: projects });
      if (place === undefined) {
        // Nothing deletes a project or a workspace.
        throw new Error("Invariant broken: a project lost its workspace");
      }
      if (
        place.projectArchivedAt !== null ||
        place.workspaceArchivedAt !== null
      ) {
        return refused("conflict");
      }

      const [held] = await tx
        .select({
          enabled: sql<number>`count(*) filter (where ${isNull(agents.disabledAt)})::int`,
          all: sql<number>`count(*)::int`,
        })
        .from(agents)
        .where(eq(agents.projectId, input.projectId));
      if (
        (held?.enabled ?? 0) >= AGENT_COUNT_LIMITS.enabledPerProject ||
        (held?.all ?? 0) >= AGENT_COUNT_LIMITS.perProject
      ) {
        return refused("agent_limit");
      }
      const [recent] = await tx
        .select({ n: count(), oldest: min(agents.createdAt) })
        .from(agents)
        .where(
          and(
            eq(agents.ownerUserId, input.userId),
            gt(agents.createdAt, new Date(input.now.getTime() - DAY_MS)),
          ),
        );
      if ((recent?.n ?? 0) >= AGENT_COUNT_LIMITS.perDay) {
        const oldest = recent?.oldest ?? input.now;
        return {
          created: false,
          refusal: "rate_limited",
          retryAfterMs: oldest.getTime() + DAY_MS - input.now.getTime(),
        };
      }

      const agent: AgentListItem = {
        id: newId<AgentId>(),
        projectId: input.projectId,
        name: input.name,
        ownerMemberId: person.id,
        disabledAt: null,
      };
      await tx.insert(agents).values({
        id: agent.id,
        projectId: agent.projectId,
        ownerUserId: input.userId,
        hostDeviceId: input.deviceId,
        name: agent.name,
        createdAt: input.now,
        updatedAt: input.now,
      });
      return { created: true, workspaceId: found.workspaceId, agent };
    }),
  );
}

export type DisableAgentInput = Readonly<{
  projectId: ProjectId;
  agentId: AgentId;
  /** The acting account; its active person in the project's workspace disables the agent. */
  userId: UserId;
  now: Date;
}>;

export type DisableAgentResult =
  | Readonly<{
      disabled: true;
      /** The project's workspace, whose subscribers the caller tells. */
      workspaceId: WorkspaceId;
      /** The agent as every member sees it in the agent list, with `disabledAt` set to `now`. */
      agent: AgentListItem;
      /** The grants that the disable revoked, in the order of their IDs. */
      revokedGrantIds: readonly PermissionGrantId[];
      /** The runs that the disable cancelled, in the order of their IDs, each with the reason `agent_disabled`. */
      cancelledRuns: readonly CancelledRun[];
    }>
  | Readonly<{
      disabled: false;
      /**
       * `not_member`: the account is not an active member of the project's
       * workspace, also when the project does not exist; `not_found`: the
       * project has no agent with this ID; `forbidden`: the account does not
       * own the agent, and its person is neither the owner nor an admin;
       * `conflict`: the agent is already disabled, or the project or its
       * workspace is archived.
       */
      refusal: "not_member" | "not_found" | "forbidden" | "conflict";
    }>;

/**
 * Disables an agent of a project in one transaction (#294): the account
 * that owns it, from any device, the workspace's owner, or an admin. It
 * locks the acting person and the project `FOR SHARE`, then the agent
 * `FOR NO KEY UPDATE`, and decides in this order: `not_member`,
 * `not_found`, `forbidden`, then `conflict` for an agent that is already
 * disabled or an archived project or workspace. It sets `disabled_at` and
 * `updated_at` to `now`, revokes every grant of the agent that is not
 * revoked yet, an expired one included, with the acting account as
 * `revoked_by_user_id` (ADR 0015, P-77), and moves every unfinished run of
 * the agent to `cancelled` with the reason `agent_disabled` and
 * `finished_at` set to `now` (`src/cascade.ts`). Nothing restores them, and
 * nothing enables the agent again. The caller sends the run events after the
 * commit. Inside another transaction it runs as a savepoint.
 */
export async function disableAgent(
  db: Database,
  input: DisableAgentInput,
): Promise<DisableAgentResult> {
  const refused = (
    refusal: Extract<DisableAgentResult, { disabled: false }>["refusal"],
  ): DisableAgentResult => ({ disabled: false, refusal });
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<DisableAgentResult> => {
      const [found] = await tx
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(eq(projects.id, input.projectId));
      if (found === undefined) {
        return refused("not_member");
      }
      const [actor] = await tx
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, found.workspaceId),
            eq(workspaceMembers.userId, input.userId),
            isNull(workspaceMembers.removedAt),
          ),
        )
        .for("share");
      if (actor === undefined) {
        return refused("not_member");
      }
      const [place] = await tx
        .select({
          projectArchivedAt: projects.archivedAt,
          workspaceArchivedAt: workspaces.archivedAt,
        })
        .from(projects)
        .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
        .where(eq(projects.id, input.projectId))
        .for("share", { of: projects });
      if (place === undefined) {
        throw new Error("Invariant broken: a project lost its workspace");
      }
      const [agent] = await tx
        .select({
          ownerUserId: agents.ownerUserId,
          name: agents.name,
          disabledAt: agents.disabledAt,
        })
        .from(agents)
        .where(
          and(
            eq(agents.id, input.agentId),
            eq(agents.projectId, input.projectId),
          ),
        )
        .for("no key update");
      if (agent === undefined) {
        return refused("not_found");
      }
      if (agent.ownerUserId !== input.userId && !administers(actor.role)) {
        return refused("forbidden");
      }
      if (
        agent.disabledAt !== null ||
        place.projectArchivedAt !== null ||
        place.workspaceArchivedAt !== null
      ) {
        return refused("conflict");
      }

      const disabled = await disableAgents(
        tx,
        eq(agents.id, input.agentId),
        input.now,
      );
      if (disabled.length !== 1) {
        throw new Error(
          "Invariant broken: a locked enabled agent was not disabled",
        );
      }
      const revokedGrantIds = await revokeGrants(
        tx,
        eq(permissionGrants.granteeAgentId, input.agentId),
        input.userId,
        input.now,
      );
      const cancelledRuns = await cancelRuns(
        tx,
        eq(agentRuns.agentId, input.agentId),
        "agent_disabled",
        input.now,
      );
      const ownerMemberId = await ownerPerson(
        tx,
        found.workspaceId,
        agent.ownerUserId,
      );
      return {
        disabled: true,
        workspaceId: found.workspaceId,
        agent: {
          id: input.agentId,
          projectId: input.projectId,
          name: agent.name,
          ownerMemberId,
          disabledAt: input.now.toISOString(),
        },
        revokedGrantIds: Object.freeze(revokedGrantIds),
        cancelledRuns,
      };
    }),
  );
}

/**
 * The owner's person in the workspace, as `listProjectAgents` shows it: the
 * account's active person, or else its most recently removed one. Person
 * rows are never deleted, and an agent is created only for an active
 * person, so a missing person breaks an invariant and throws.
 */
async function ownerPerson(
  tx: Database,
  workspaceId: WorkspaceId,
  ownerUserId: UserId,
): Promise<MemberId> {
  const [person] = await tx
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, ownerUserId),
      ),
    )
    .orderBy(
      sql`${workspaceMembers.removedAt} desc nulls first`,
      desc(workspaceMembers.id),
    )
    .limit(1);
  if (person === undefined) {
    throw new Error(
      "Invariant broken: the owner of an agent has no person in its project's workspace",
    );
  }
  return person.id;
}
