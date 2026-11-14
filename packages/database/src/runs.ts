import {
  type AgentId,
  type AgentRunListItem,
  type DeviceId,
  INITIAL_RUN_STATE,
  type MessageId,
  newId,
  type ProjectId,
  type ProviderConnectionId,
  type RepositoryId,
  type RunId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { and, count, eq, gt, isNull, min } from "drizzle-orm";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import {
  agentRuns,
  agents,
  conversations,
  messages,
  projects,
  providerConnections,
  repositories,
  workspaceMembers,
  workspaces,
} from "./schema/index.ts";

// Creating a run (#35; Project Manager decision of 2026-11-14; ADR 0007):
// the owner of an agent asks for a run of it, the server stores the run in
// `queued`, and the agent's host device moves it from there
// (`recordRunTransition` in `src/agent-activity.ts`).
//
// - Only the account that owns the agent asks in v0. A run that another
//   member asked for would spend the owner's provider, which belongs to
//   provider sharing (M5); the table can already hold such a run, and a
//   removal cancels it (`src/people.ts`), so the rule lives here, not in a
//   foreign key.
// - Only from the agent's host device, as only that device grants (#75,
//   Project Manager decision of 2026-11-14): another device of the account,
//   for example one that a taken-over GitHub account registered, would
//   otherwise start a run with the grants that the agent already holds.
// - A run names one provider connection of its agent's host device. The
//   table keeps the connection on that device with two composite foreign
//   keys (`agent_runs_agent_host_device_fk` and
//   `agent_runs_provider_connection_device_fk`), as it keeps a
//   `provider.use` grant there, and no writer changes the column after the
//   insert, so the enforcement point can take the scope of `provider.use`
//   from the run (ADR 0015).
// - A run's input is a chat message of its project that the asking account
//   wrote, so that the chat shows the instruction as the requester's own
//   words, and no other member's or agent's text becomes the instruction of
//   the owner's run. The run has no text.
//
// Lock order, the order of `src/people.ts`, `src/chat.ts`, and
// `src/agent-activity.ts` extended: after the account and the device that
// `lockActor` in the API locks first, the requester's person
// (`workspace_members`) `FOR SHARE`, as `src/people.ts` asks of a writer that
// inserts a run: the requester is the agent's owner, so it is one person. A
// removal holds the person `FOR NO KEY UPDATE`, so either the removal
// commits first and the creation finds no active person, or the creation
// commits first and the removal cancels the new run. Then the project
// (`projects`) `FOR SHARE`, which an erasure that archives it waits for or
// is seen by. Then the agent (`agents`) `FOR NO KEY UPDATE`: the creations
// of one agent are counted one after another, and a device revocation and a
// removal, which disable the agent before they cancel its runs
// (`src/cascade.ts`), either commit first and the creation finds the agent
// disabled, or wait for the creation and cancel the new run. A transition
// locks the person and the agent `FOR SHARE` and then its run, and a
// creation locks no run, so a creation waits for a transition only at the
// agent and a transition never waits for a row that a creation locked
// before it. Then the repository (`repositories`) and the provider connection
// (`provider_connections`), each `FOR SHARE`: a writer that archives a
// repository or removes a connection locks its row `FOR NO KEY UPDATE`
// first, and then either is seen by the creation or waits for it and sees
// the new run. `removeRepository` (`src/repositories.ts`) locks the project
// `FOR NO KEY UPDATE` before the repository, so a creation waits for it
// already at the project; no writer removes a connection yet. The message
// is read without a lock: a message never changes its conversation.

const DAY_MS = 24 * 60 * 60_000;

/**
 * The most unfinished runs (`queued`, `running`, or `awaiting_input`) that
 * one agent has at a time (#35). A creation above it is `run_limit`, which
 * no wait frees: only a run of the agent that finishes does. The runs of
 * the development seed count too. Provisional (#35): the value, a default
 * until the Project Manager decides. 10 keeps what one host device has to
 * work through small, and keeps a project's unfinished runs, which
 * `listProjectRuns` returns whole, far below `MAX_ANSWER_LIST_ITEMS`.
 */
export const MAX_UNFINISHED_RUNS_PER_AGENT = 10;

/**
 * The most runs that one agent gets within 24 hours (#35), whoever asked
 * and however they ended. A creation above it is `run_daily_limit`, with
 * the time until the oldest of those runs leaves the 24 hours.
 * Provisional (#35): the value, a default until the Project Manager
 * decides. 100 a day bounds what one agent adds to the run tables and what
 * it can spend of its owner's provider in a day.
 */
export const MAX_NEW_RUNS_PER_AGENT_PER_DAY = 100;

export type CreateRunInput = Readonly<{
  /**
   * The asking account. It must own the agent, and its active person in the
   * project's workspace asks.
   */
  userId: UserId;
  /** The asking device of the account. It must be the agent's host device. */
  deviceId: DeviceId;
  /** The project of the path; the agent must be an agent of it. */
  projectId: ProjectId;
  agentId: AgentId;
  /** A repository of the project; undefined for a run without one. */
  repositoryId?: RepositoryId | undefined;
  /** A provider connection of the agent's host device. */
  providerConnectionId: ProviderConnectionId;
  /** A message of the asking account in the project's chat: the run's input. */
  inputMessageId: MessageId;
  /** The server's time: the run's `created_at`. */
  now: Date;
}>;

/** Why a creation was refused. Nothing was written. */
export type CreateRunRefusal =
  /**
   * The project does not exist, or the account is not an active member of
   * its workspace: one answer, so that a project ID cannot be probed.
   */
  | "not_member"
  /**
   * The project has no agent with this ID; or, for the agent's owner, the
   * project has no repository with this ID, the agent's host device has no
   * provider connection with this ID, or the project's chat has no message
   * with this ID that the asking account wrote and that is not deleted. An ID
   * that exists elsewhere, one of another author, and one that exists
   * nowhere get the same answer.
   */
  | "not_found"
  /**
   * The account does not own the agent, or the asking device is not the
   * agent's host device.
   */
  | "forbidden"
  /**
   * The project or its workspace is archived, the agent is disabled, the
   * repository is archived, or the provider connection is removed.
   */
  | "conflict"
  /** The agent has `MAX_UNFINISHED_RUNS_PER_AGENT` unfinished runs. */
  | "run_limit";

export type CreateRunResult =
  | Readonly<{
      created: true;
      /** The workspace of the run's project, whose subscribers are told. */
      workspaceId: WorkspaceId;
      /**
       * The new run as its agent's owner reads it in the run list: in
       * `queued`, with its input message and its provider connection.
       */
      run: AgentRunListItem;
    }>
  | Readonly<{ created: false; refusal: CreateRunRefusal }>
  /**
   * The agent got `MAX_NEW_RUNS_PER_AGENT_PER_DAY` runs within 24 hours, the
   * oldest of which leaves them after `retryAfterMs`.
   */
  | Readonly<{
      created: false;
      refusal: "run_daily_limit";
      retryAfterMs: number;
    }>;

/**
 * Creates a run of an agent in one transaction (#35), in `queued`, requested
 * by the asking account. It decides in this order:
 *
 * 1. It locks the account's active person in the project's workspace
 *    `FOR SHARE`; without one, also for a project that does not exist,
 *    `not_member`.
 * 2. It locks the project `FOR SHARE`, and then the agent
 *    `FOR NO KEY UPDATE`. An agent that the project does not have, also an
 *    agent of another project, is `not_found`.
 * 3. An agent that the account does not own, or that the asking device does
 *    not host, is `forbidden`, before anything about the repository, the
 *    provider connection, or the message is read, so that only the owner,
 *    on the agent's host device, learns anything about them.
 * 4. A `repositoryId` that is not a repository of the project, a
 *    `providerConnectionId` that is not a connection of the agent's host
 *    device, and an `inputMessageId` that is not a message of the asking
 *    account in the project's chat or is deleted are `not_found`. The
 *    repository and the connection are locked `FOR SHARE`.
 * 5. An archived project or workspace, a disabled agent, an archived
 *    repository, and a removed provider connection are `conflict`. A
 *    revoked host device needs no check of its own: a revocation disables
 *    its agents in its own transaction.
 * 6. `run_limit` when the agent has `MAX_UNFINISHED_RUNS_PER_AGENT` runs
 *    without a `finished_at`, and then `run_daily_limit` when it has
 *    `MAX_NEW_RUNS_PER_AGENT_PER_DAY` runs whose `created_at` lies within
 *    24 hours before `now`.
 *
 * It then inserts the run with a new ID, the state `queued`, the account as
 * `requested_by_user_id`, `now` as `created_at`, the repository or null,
 * the provider connection with the agent's host device as `host_device_id`,
 * and the message as `input_message_id`, without a correlation ID. The
 * caller sends the run's `agent.run.state_changed` after the commit.
 * Inside another transaction it runs as a savepoint.
 */
export async function createRun(
  db: Database,
  input: CreateRunInput,
): Promise<CreateRunResult> {
  const refused = (refusal: CreateRunRefusal): CreateRunResult => ({
    created: false,
    refusal,
  });
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<CreateRunResult> => {
      // A project never moves to another workspace, so its workspace is
      // read before the person that the workspace names is locked.
      const [project] = await tx
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(eq(projects.id, input.projectId));
      if (project === undefined) {
        return refused("not_member");
      }
      const [person] = await tx
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, project.workspaceId),
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
        .for("share", { of: projects });
      if (place === undefined) {
        // Nothing deletes a project or a workspace.
        throw new Error("Invariant broken: a project lost its workspace");
      }

      const [agent] = await tx
        .select({
          ownerUserId: agents.ownerUserId,
          hostDeviceId: agents.hostDeviceId,
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
      // Only the owner, and only on the agent's host device (#75).
      if (
        agent.ownerUserId !== input.userId ||
        agent.hostDeviceId !== input.deviceId
      ) {
        return refused("forbidden");
      }

      let repositoryArchivedAt: Date | null = null;
      if (input.repositoryId !== undefined) {
        const [repository] = await tx
          .select({ archivedAt: repositories.archivedAt })
          .from(repositories)
          .where(
            and(
              eq(repositories.id, input.repositoryId),
              eq(repositories.projectId, input.projectId),
            ),
          )
          .for("share");
        if (repository === undefined) {
          return refused("not_found");
        }
        repositoryArchivedAt = repository.archivedAt;
      }
      const [connection] = await tx
        .select({ removedAt: providerConnections.removedAt })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.id, input.providerConnectionId),
            eq(providerConnections.hostDeviceId, agent.hostDeviceId),
          ),
        )
        .for("share");
      if (connection === undefined) {
        return refused("not_found");
      }
      const [message] = await tx
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(
          and(
            eq(messages.id, input.inputMessageId),
            eq(conversations.projectId, input.projectId),
            eq(conversations.kind, "project"),
            // Only the asking account's own words: an agent's message names
            // no account, and another member's names theirs.
            eq(messages.authorUserId, input.userId),
            isNull(messages.deletedAt),
          ),
        );
      if (message === undefined) {
        return refused("not_found");
      }

      if (
        place.projectArchivedAt !== null ||
        place.workspaceArchivedAt !== null ||
        agent.disabledAt !== null ||
        repositoryArchivedAt !== null ||
        connection.removedAt !== null
      ) {
        return refused("conflict");
      }

      const [unfinished] = await tx
        .select({ n: count() })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.agentId, input.agentId),
            isNull(agentRuns.finishedAt),
          ),
        );
      if ((unfinished?.n ?? 0) >= MAX_UNFINISHED_RUNS_PER_AGENT) {
        return refused("run_limit");
      }
      const [recent] = await tx
        .select({ n: count(), oldest: min(agentRuns.createdAt) })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.agentId, input.agentId),
            gt(agentRuns.createdAt, new Date(input.now.getTime() - DAY_MS)),
          ),
        );
      if ((recent?.n ?? 0) >= MAX_NEW_RUNS_PER_AGENT_PER_DAY) {
        const oldest = recent?.oldest ?? input.now;
        return {
          created: false,
          refusal: "run_daily_limit",
          retryAfterMs: oldest.getTime() + DAY_MS - input.now.getTime(),
        };
      }

      const run: AgentRunListItem = {
        id: newId<RunId>(),
        agentId: input.agentId,
        projectId: input.projectId,
        repositoryId: input.repositoryId ?? null,
        state: INITIAL_RUN_STATE,
        reason: null,
        createdAt: input.now.toISOString(),
        finishedAt: null,
        inputMessageId: input.inputMessageId,
        providerConnectionId: input.providerConnectionId,
      };
      await tx.insert(agentRuns).values({
        id: run.id,
        agentId: run.agentId,
        projectId: run.projectId,
        repositoryId: run.repositoryId,
        requestedByUserId: input.userId,
        state: run.state,
        createdAt: input.now,
        providerConnectionId: input.providerConnectionId,
        hostDeviceId: agent.hostDeviceId,
        inputMessageId: input.inputMessageId,
      });
      return { created: true, workspaceId: project.workspaceId, run };
    }),
  );
}
