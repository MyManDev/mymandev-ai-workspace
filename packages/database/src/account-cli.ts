// Disables or enables an account (operator command):
//   npm run db:account -w @mymandev/database -- disable <user ID>
//   npm run db:account -w @mymandev/database -- enable <user ID>
// It connects with DATABASE_URL, the application role, like the API.
import { UserIdSchema } from "@mymandev/protocol";
import { disableAccount, enableAccount } from "./account-status.ts";
import { checkDatabaseUrl, createDatabase } from "./client.ts";

const [action, rawUserId] = process.argv.slice(2);
const userId = UserIdSchema.safeParse(rawUserId);
if ((action !== "disable" && action !== "enable") || !userId.success) {
  console.error("Usage: db:account -- disable|enable <user ID (UUIDv7)>");
  process.exit(1);
}

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
  if (action === "disable") {
    const result = await disableAccount(db, { userId: userId.data, now });
    console.log(
      result.changed
        ? `Account disabled; ${result.revokedGrantIds.length} grants revoked.`
        : "No change: the account does not exist or is already disabled.",
    );
  } else {
    const result = await enableAccount(db, { userId: userId.data, now });
    console.log(
      result.changed
        ? "Account enabled; no grant was restored."
        : "No change: the account does not exist or is not disabled.",
    );
  }
} finally {
  await close();
}
