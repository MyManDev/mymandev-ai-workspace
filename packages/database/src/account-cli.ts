// Disables, enables, or erases an account (operator command):
//   npm run db:account -w @mymandev/database -- disable <user ID>
//   npm run db:account -w @mymandev/database -- enable <user ID>
//   npm run db:account -w @mymandev/database -- erase <user ID> --confirm
// It connects with DATABASE_URL, the application role, like the API.
import {
  disableReport,
  enableReport,
  erasureReport,
  parseAccountCommand,
} from "./account-command.ts";
import { eraseAccount } from "./account-erasure.ts";
import { disableAccount, enableAccount } from "./account-status.ts";
import { checkDatabaseUrl, createDatabase } from "./client.ts";

const parsed = parseAccountCommand(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.message);
  process.exit(1);
}
const { action, userId } = parsed.command;

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const problem = checkDatabaseUrl(url, process.env["NODE_ENV"] === "production");
if (problem !== undefined) {
  console.error(`DATABASE_URL ${problem}.`);
  process.exit(1);
}

const { db, close } = createDatabase(url, { max: 1 });
try {
  const now = new Date();
  const report =
    action === "disable"
      ? disableReport(await disableAccount(db, { userId, now }))
      : action === "enable"
        ? enableReport(await enableAccount(db, { userId, now }))
        : erasureReport(await eraseAccount(db, { userId, now }));
  if (report.exitCode === 0) {
    console.log(report.message);
  } else {
    console.error(report.message);
    process.exitCode = report.exitCode;
  }
} finally {
  await close();
}
