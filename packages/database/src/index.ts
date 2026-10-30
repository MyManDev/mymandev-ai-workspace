export * from "./schema/index.ts";
export type { Database } from "./db.ts";
export {
  checkDatabaseUrl,
  createDatabase,
  type DatabaseConnection,
} from "./client.ts";
export { migrationsFolder, runMigrations } from "./migrate.ts";
export {
  revokeDevice,
  type RevokeDeviceInput,
  type RevokeDeviceResult,
} from "./device-revocation.ts";
export {
  DatabaseError,
  toDatabaseError,
  withDatabaseErrors,
} from "./errors.ts";
export {
  AUDIT_ACTIONS,
  AUDIT_REASONS,
  type AuditAction,
  type AuditReason,
} from "./audit-vocabulary.ts";
