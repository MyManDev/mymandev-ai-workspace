import type {
  DeviceId,
  ProviderConnectionId,
  ProviderKind,
} from "@mymandev/protocol";
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, nullableTimestamp } from "./columns.ts";
import { devices } from "./identity.ts";

/**
 * One connection of a host device to an AI provider account (ADR 0015, P-82).
 * It holds metadata only, never a credential: credentials stay on the device.
 * Its provider kind is one of the protocol's `PROVIDER_KINDS`, and its label a
 * text that a person chose, not unique (#295). Nothing identifies the
 * provider account or derives from the credential (#33). Removing a
 * connection revokes its active grants in the same transaction (P-77).
 */
export const providerConnections = pgTable(
  "provider_connections",
  {
    id: uuid("id").primaryKey().$type<ProviderConnectionId>(),
    hostDeviceId: uuid("host_device_id")
      .notNull()
      .$type<DeviceId>()
      .references(() => devices.id, { onDelete: "restrict" }),
    kind: text("kind").notNull().$type<ProviderKind>(),
    label: text("label").notNull(),
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
    // A closed list, the protocol's `PROVIDER_KINDS` (#295).
    check(
      "provider_connections_kind_check",
      sql`${t.kind} in ('claude', 'codex')`,
    ),
    check(
      "provider_connections_label_length",
      sql`char_length(${t.label}) between 1 and 64`,
    ),
  ],
);
