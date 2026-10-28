// Applies pending migrations: npm run db:migrate -w @mymandev/database.
// Migrations are a separate deployment step and never run on API startup.
import { checkDatabaseUrl, createDatabase } from "./client.ts";
import { runMigrations } from "./migrate.ts";

// The migration role owns the schema; the application role (M2) cannot change it.
const url = process.env["DATABASE_MIGRATION_URL"];
if (!url) {
  console.error("DATABASE_MIGRATION_URL is not set.");
  process.exit(1);
}
const problem = checkDatabaseUrl(url, process.env["NODE_ENV"] === "production");
if (problem !== undefined) {
  console.error(`DATABASE_MIGRATION_URL ${problem}.`);
  process.exit(1);
}

const { db, close } = createDatabase(url, { max: 1 });
try {
  await runMigrations(db);
  console.log("Migrations applied.");
} finally {
  await close();
}
