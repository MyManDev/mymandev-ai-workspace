import type { DeviceId, ProviderConnectionId } from "@mymandev/protocol";
import { index, pgTable, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, nullableTimestamp } from "./columns.ts";
import { devices } from "./identity.ts";

/**
 * One connection of a host device to an AI provider account (ADR 0015, P-82).
 * It holds metadata only, never a credential: credentials stay on the device.
 * The provider kind is deferred to M3. Removing a connection revokes its
 * active grants in the same transaction (P-77).
 */
export const providerConnections = pgTable(
  "provider_connections",
  {
    id: uuid("id").primaryKey().$type<ProviderConnectionId>(),
    hostDeviceId: uuid("host_device_id")
      .notNull()
      .$type<DeviceId>()
      .references(() => devices.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    removedAt: nullableTimestamp("removed_at"),
  },
  (t) => [
    index("provider_connections_host_device_id_idx").on(t.hostDeviceId),
    // Target of the composite foreign key that keeps a provider.use grant on
    // a connection of its agent's host device.
    unique("provider_connections_id_host_device_id_key").on(
      t.id,
      t.hostDeviceId,
    ),
  ],
);
