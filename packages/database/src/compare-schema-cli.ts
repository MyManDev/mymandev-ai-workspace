// Compares the schema on a PostgreSQL server with the schema that the migrations
// create on PGlite, where the tests run: npm run db:compare -w @mymandev/database.
// Run it after db:migrate. Development and CI only: PGlite is a devDependency.
import pg from "pg";
import { checkDatabaseUrl } from "./client.ts";
import { createTestDatabase } from "./testing.ts";

type CatalogRow = { kind: string; name: string; definition: string | null };

// Every column, constraint, index and trigger of the public schema, and the
// applied migrations. Ownership and privileges differ by design and are not compared.
const CATALOG = `
  select 'column' as kind, table_name || '.' || column_name as name,
    concat_ws(' ', data_type, character_maximum_length, numeric_precision,
      is_nullable, column_default, is_identity, is_generated,
      generation_expression) as definition
  from information_schema.columns where table_schema = 'public'
  union all
  select 'constraint', cls.relname || '.' || con.conname, pg_get_constraintdef(con.oid)
  from pg_constraint con
  join pg_class cls on cls.oid = con.conrelid
  join pg_namespace ns on ns.oid = cls.relnamespace
  where ns.nspname = 'public'
  union all
  select 'index', indexname, indexdef from pg_indexes where schemaname = 'public'
  union all
  select 'trigger', cls.relname || '.' || tg.tgname, pg_get_triggerdef(tg.oid)
  from pg_trigger tg
  join pg_class cls on cls.oid = tg.tgrelid
  join pg_namespace ns on ns.oid = cls.relnamespace
  where ns.nspname = 'public' and not tg.tgisinternal
  union all
  select 'migration', hash, created_at::text from drizzle.__drizzle_migrations
  order by 1, 2
`;

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

const server = new pg.Client({
  connectionString: url,
  connectionTimeoutMillis: 5_000,
});
await server.connect();
let onServer: CatalogRow[];
let serverVersion: string;
try {
  onServer = (await server.query<CatalogRow>(CATALOG)).rows;
  const version = await server.query<{ version: string }>(
    "select current_setting('server_version') as version",
  );
  serverVersion = version.rows[0]?.version ?? "unknown";
} finally {
  await server.end();
}

const pglite = await createTestDatabase();
let onPglite: CatalogRow[];
try {
  onPglite = (await pglite.client.query<CatalogRow>(CATALOG)).rows;
} finally {
  await pglite.close();
}

const describe = (row: CatalogRow) =>
  `${row.kind} ${row.name}: ${row.definition ?? ""}`;
const serverSet = new Set(onServer.map(describe));
const pgliteSet = new Set(onPglite.map(describe));
const onlyOnServer = [...serverSet].filter((line) => !pgliteSet.has(line));
const onlyOnPglite = [...pgliteSet].filter((line) => !serverSet.has(line));

for (const line of onlyOnServer) console.error(`only on the server: ${line}`);
for (const line of onlyOnPglite) console.error(`only on PGlite: ${line}`);
if (onlyOnServer.length > 0 || onlyOnPglite.length > 0) {
  process.exit(1);
}
const counts = Object.entries(Object.groupBy(onServer, (row) => row.kind)).map(
  ([kind, rows]) => `${kind}: ${rows?.length ?? 0}`,
);
console.log(
  `PostgreSQL ${serverVersion} and PGlite have the same schema (${counts.join(", ")}).`,
);
