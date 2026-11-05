// Creates a workspace owned by the account of the developer's device, with
// one project, as test data for #27 and #28 until #95 adds the screens that
// create them (development only):
//   MYMANDEV_DEV_SEED=1 npm run db:dev-workspace -w @mymandev/database -- <device ID> [--workspace <name>] [--project <name>]
// It connects with DATABASE_URL, the application role, like the API, and
// refuses a database that is not on this computer, with the guards of
// `db:dev-seed` (`src/dev-seed-command.ts`).
import { sql } from "drizzle-orm";
import { createDatabase } from "./client.ts";
import { checkDevSeedEnvironment } from "./dev-seed-command.ts";
import {
  parseDevWorkspaceCommand,
  runDevWorkspaceCommand,
} from "./dev-workspace-command.ts";

const parsed = parseDevWorkspaceCommand(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.message);
  process.exit(1);
}
const allowed = checkDevSeedEnvironment(process.env);
if (!allowed.ok) {
  console.error(allowed.message);
  process.exit(1);
}

const { db, close } = createDatabase(allowed.url, { max: 1 });
try {
  const { rows } = await db.execute<{ address: string | null }>(
    sql`select host(inet_server_addr()) as address`,
  );
  // runDevWorkspaceCommand refuses a remote server before it writes.
  const report = await runDevWorkspaceCommand(db, {
    command: parsed.command,
    serverAddress: rows[0]?.address ?? null,
    now: new Date(),
  });
  if (report.exitCode === 0) {
    console.log(report.message);
  } else {
    console.error(report.message);
    process.exitCode = report.exitCode;
  }
} finally {
  await close();
}
