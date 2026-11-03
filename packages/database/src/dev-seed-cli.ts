// Seeds an agent hosted on the developer's device, with runs in `queued`, as
// the test source of M2 (#28; development only):
//   MYMANDEV_DEV_SEED=1 npm run db:dev-seed -w @mymandev/database -- <device ID> <project ID> [--runs <n>]
// It connects with DATABASE_URL, the application role, like the API, and
// refuses a database that is not on this computer (`src/dev-seed-command.ts`).
import { createDatabase } from "./client.ts";
import {
  checkDevSeedEnvironment,
  devSeedReport,
  parseDevSeedCommand,
} from "./dev-seed-command.ts";
import { seedDevAgent } from "./dev-seed.ts";

const parsed = parseDevSeedCommand(process.argv.slice(2));
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
  const report = devSeedReport(
    await seedDevAgent(db, { ...parsed.command, now: new Date() }),
  );
  if (report.exitCode === 0) {
    console.log(report.message);
  } else {
    console.error(report.message);
    process.exitCode = report.exitCode;
  }
} finally {
  await close();
}
