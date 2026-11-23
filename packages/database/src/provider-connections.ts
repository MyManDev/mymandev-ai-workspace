import {
  type DeviceId,
  newId,
  type PermissionGrantId,
  PROVIDER_CONNECTION_COUNT_LIMITS,
  type ProviderConnection,
  type ProviderConnectionId,
  type ProviderKind,
  type UserId,
} from "@mymandev/protocol";
import { and, asc, count, eq, gt, isNull, min } from "drizzle-orm";
import { revokeGrants } from "./cascade.ts";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import {
  devices,
  permissionGrants,
  providerConnections,
  users,
} from "./schema/index.ts";

// The provider connections of a host device: registering, listing, and
// removing them (#295; Project Manager decisions of 2026-11-20, whose
// defaults the Project Manager accepted on 2026-11-23; ADR 0015, P-82). The
// routes and their codes are the protocol's `PROVIDER_CONNECTION_ROUTES` and
// `PROVIDER_CONNECTION_ROUTE_ERRORS`, and the limits its
// `PROVIDER_CONNECTION_COUNT_LIMITS`.
//
// - A connection is metadata: its ID, its host device, its provider kind
//   (`PROVIDER_KINDS`, held by the CHECK `provider_connections_kind_check`),
//   a label, and its times. The table has no column for a credential, a
//   provider account, or anything derived from either, and these functions
//   take none (#33). A label is a label: no unique index, stored as given.
//   The API passes kinds and labels that the protocol checked.
// - Only the host device registers, lists, and removes its own connections:
//   every function takes the calling device and acts on that device's
//   connections only. A connection of another device, also of the same
//   account, is `not_found`, as an unknown one is.
// - A device holds `PROVIDER_CONNECTION_COUNT_LIMITS.activePerDevice`
//   connections that are not removed, and an account registers
//   `PROVIDER_CONNECTION_COUNT_LIMITS.perDay` connections in 24 hours, on all
//   its devices, removed ones included.
// - A removal sets `removed_at`; nothing is deleted (ADR 0013). In the same
//   transaction it revokes every `provider.use` grant on the connection that
//   is not revoked yet, an expired one included, through `revokeGrants` of
//   `src/cascade.ts`, with the removing account as `revoked_by_user_id`
//   (ADR 0015, P-77). It cancels no run, as a repository removal cancels
//   none: the host device stops the work that relied on the connection
//   (#55). The result lists the revoked grants for the `agent.grant.revoked`
//   events that the grant routes will send (#75); the API sends none yet,
//   as for a repository removal, an agent's disable, a device revocation,
//   or a removal of a person.
// - A device revocation does not mark its connections removed: it already
//   revokes the grants of the device's agents, and the host device fact of a
//   grant record denies (ADR 0014, ADR 0015).
// - No function writes an audit record or a workspace event: a connection is
//   device data (#110), and the audit vocabulary of ADR 0014 has no provider
//   connection action.
//
// Lock order, the order of `src/runs.ts` and `src/grants.ts`: the account
// (`users`), then the device (`devices`), as `lockActor` in the API does;
// then the connection; then its grants. A registration locks the account
// `FOR NO KEY UPDATE`, so that the registrations of one account, and so of
// each of its devices, are counted one after another, and then the calling
// device `FOR SHARE`, which a device revocation waits for. A removal locks
// the account and the calling device `FOR SHARE`, then the connection
// `FOR NO KEY UPDATE`, then its grants in the order of their IDs
// (`revokeGrants`). A grant (`src/grants.ts`) and a run creation
// (`src/runs.ts`) lock the connection `FOR SHARE` after the account and the
// device, and check that it is not removed, so either the removal commits
// first and they are `conflict`, or they commit first and the removal
// revokes the new grant; a run that they created stays, because a removal
// cancels no run. A grant also locks the calling device `FOR NO KEY UPDATE`,
// so a removal on that device waits for it at the device, or it waits for
// the removal there. No transaction locks a connection before the account
// or the device, or a grant before its connection, so none of them wait for
// each other in a cycle.

const DAY_MS = 24 * 60 * 60_000;

/** Why an action on a provider connection was refused. Nothing was written. */
type ActorRefusal =
  /**
   * The account is disabled, or the device is not an active device of the
   * account. The API's `lockActor` refuses both before, with
   * `unauthorized`.
   */
  "forbidden";

export type RegisterProviderConnectionInput = Readonly<{
  /** The acting account. */
  userId: UserId;
  /** The calling device of the account; it becomes the connection's host device. */
  deviceId: DeviceId;
  kind: ProviderKind;
  label: string;
  now: Date;
}>;

export type RegisterProviderConnectionResult =
  | Readonly<{
      registered: true;
      /** The new connection as its host device reads it in the list. */
      providerConnection: ProviderConnection;
    }>
  | Readonly<{
      registered: false;
      /**
       * `forbidden`: see `ActorRefusal`; `provider_connection_limit`: the
       * device holds `PROVIDER_CONNECTION_COUNT_LIMITS.activePerDevice`
       * connections that are not removed. No time frees a place.
       */
      refusal: ActorRefusal | "provider_connection_limit";
    }>
  /**
   * The account registered `PROVIDER_CONNECTION_COUNT_LIMITS.perDay`
   * connections within 24 hours, the oldest of which leaves the window after
   * `retryAfterMs`.
   */
  | Readonly<{
      registered: false;
      refusal: "rate_limited";
      retryAfterMs: number;
    }>;

/**
 * Registers a provider connection of the calling device in one transaction
 * (#295). It locks the account `FOR NO KEY UPDATE` and the device
 * `FOR SHARE`, and decides in this order: `forbidden` for a disabled
 * account or a device that is not an active device of the account;
 * `provider_connection_limit` when the device holds
 * `PROVIDER_CONNECTION_COUNT_LIMITS.activePerDevice` connections that are
 * not removed; then `rate_limited` when the account registered
 * `PROVIDER_CONNECTION_COUNT_LIMITS.perDay` connections, on any of its
 * devices and removed ones included, whose `created_at` lies within 24
 * hours before `now`. It inserts the connection with `kind` and `label` as
 * given and the time `now`. Inside another transaction it runs as a
 * savepoint.
 */
export async function registerProviderConnection(
  db: Database,
  input: RegisterProviderConnectionInput,
): Promise<RegisterProviderConnectionResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<RegisterProviderConnectionResult> => {
      const [account] = await tx
        .select({ disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, input.userId))
        .for("no key update");
      if (account === undefined || account.disabledAt !== null) {
        return { registered: false, refusal: "forbidden" };
      }
      if (!(await activeDevice(tx, input.userId, input.deviceId))) {
        return { registered: false, refusal: "forbidden" };
      }

      const [held] = await tx
        .select({ n: count() })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.hostDeviceId, input.deviceId),
            isNull(providerConnections.removedAt),
          ),
        );
      if ((held?.n ?? 0) >= PROVIDER_CONNECTION_COUNT_LIMITS.activePerDevice) {
        return { registered: false, refusal: "provider_connection_limit" };
      }
      const [recent] = await tx
        .select({ n: count(), oldest: min(providerConnections.createdAt) })
        .from(providerConnections)
        .innerJoin(devices, eq(devices.id, providerConnections.hostDeviceId))
        .where(
          and(
            eq(devices.userId, input.userId),
            gt(
              providerConnections.createdAt,
              new Date(input.now.getTime() - DAY_MS),
            ),
          ),
        );
      if ((recent?.n ?? 0) >= PROVIDER_CONNECTION_COUNT_LIMITS.perDay) {
        const oldest = recent?.oldest ?? input.now;
        return {
          registered: false,
          refusal: "rate_limited",
          retryAfterMs: oldest.getTime() + DAY_MS - input.now.getTime(),
        };
      }

      const providerConnection: ProviderConnection = {
        id: newId<ProviderConnectionId>(),
        kind: input.kind,
        label: input.label,
        createdAt: input.now.toISOString(),
      };
      await tx.insert(providerConnections).values({
        id: providerConnection.id,
        hostDeviceId: input.deviceId,
        kind: providerConnection.kind,
        label: providerConnection.label,
        createdAt: input.now,
      });
      return { registered: true, providerConnection };
    }),
  );
}

export type ListProviderConnectionsInput = Readonly<{
  userId: UserId;
  /** The calling device; only its connections are listed. */
  deviceId: DeviceId;
}>;

/**
 * The calling device's provider connections that are not removed, the
 * oldest first, in one statement. A device of another account gets none.
 * The count limit of a device keeps the list far within
 * `MAX_ANSWER_LIST_ITEMS`.
 */
export async function listProviderConnections(
  db: Database,
  input: ListProviderConnectionsInput,
): Promise<ProviderConnection[]> {
  const rows = await withDatabaseErrors(() =>
    db
      .select({
        id: providerConnections.id,
        kind: providerConnections.kind,
        label: providerConnections.label,
        createdAt: providerConnections.createdAt,
      })
      .from(providerConnections)
      .innerJoin(devices, eq(devices.id, providerConnections.hostDeviceId))
      .where(
        and(
          eq(providerConnections.hostDeviceId, input.deviceId),
          eq(devices.userId, input.userId),
          isNull(providerConnections.removedAt),
        ),
      )
      .orderBy(asc(providerConnections.createdAt), asc(providerConnections.id)),
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
  }));
}

export type RemoveProviderConnectionInput = Readonly<{
  /** The acting account; it is stored as the revoker of the grants. */
  userId: UserId;
  /** The calling device, which must host the connection. */
  deviceId: DeviceId;
  providerConnectionId: ProviderConnectionId;
  now: Date;
}>;

export type RemoveProviderConnectionResult =
  | Readonly<{
      removed: true;
      /** The `provider.use` grants that the removal revoked, in the order of their IDs. */
      revokedGrantIds: readonly PermissionGrantId[];
    }>
  | Readonly<{
      removed: false;
      /**
       * `forbidden`: see `ActorRefusal`; `not_found`: the calling device
       * hosts no connection with this ID, also when another device, of the
       * same account or another, does; `conflict`: the connection is
       * already removed.
       */
      refusal: ActorRefusal | "not_found" | "conflict";
    }>;

/**
 * Removes a provider connection of the calling device in one transaction
 * (#295). It locks the account and the device `FOR SHARE`, then the
 * connection `FOR NO KEY UPDATE`, and decides in this order: `forbidden`,
 * `not_found`, then `conflict` for a connection that is already removed. It
 * sets `removed_at` to `now` and revokes every `provider.use` grant on the
 * connection that is not revoked yet, an expired one included, with the
 * acting account as `revoked_by_user_id` (ADR 0015, P-77). It cancels no
 * run. Nothing restores the connection or the grants. Inside another
 * transaction it runs as a savepoint.
 */
export async function removeProviderConnection(
  db: Database,
  input: RemoveProviderConnectionInput,
): Promise<RemoveProviderConnectionResult> {
  const refused = (
    refusal: Extract<
      RemoveProviderConnectionResult,
      { removed: false }
    >["refusal"],
  ): RemoveProviderConnectionResult => ({ removed: false, refusal });
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<RemoveProviderConnectionResult> => {
      const [account] = await tx
        .select({ disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, input.userId))
        .for("share");
      if (account === undefined || account.disabledAt !== null) {
        return refused("forbidden");
      }
      if (!(await activeDevice(tx, input.userId, input.deviceId))) {
        return refused("forbidden");
      }
      const [connection] = await tx
        .select({ removedAt: providerConnections.removedAt })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.id, input.providerConnectionId),
            eq(providerConnections.hostDeviceId, input.deviceId),
          ),
        )
        .for("no key update");
      if (connection === undefined) {
        return refused("not_found");
      }
      if (connection.removedAt !== null) {
        return refused("conflict");
      }

      await tx
        .update(providerConnections)
        .set({ removedAt: input.now })
        .where(eq(providerConnections.id, input.providerConnectionId));
      const revokedGrantIds = await revokeGrants(
        tx,
        eq(permissionGrants.providerConnectionId, input.providerConnectionId),
        input.userId,
        input.now,
      );
      return { removed: true, revokedGrantIds: Object.freeze(revokedGrantIds) };
    }),
  );
}

/**
 * Locks the device `FOR SHARE` and tells whether it is an active device of
 * the account. A device revocation updates the row, so it waits for the
 * lock, and the action waits for a revocation that holds the row.
 */
async function activeDevice(
  tx: Database,
  userId: UserId,
  deviceId: DeviceId,
): Promise<boolean> {
  const [device] = await tx
    .select({ userId: devices.userId, revokedAt: devices.revokedAt })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .for("share");
  return (
    device !== undefined &&
    device.userId === userId &&
    device.revokedAt === null
  );
}
