// Entry point and the only module with side effects: loads the configuration,
// builds the application, handles shutdown signals, and listens.
import packageJson from "../package.json" with { type: "json" };
import { buildApp } from "./app.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";

/** Shutdown exits with code 1 if closing takes longer than this. */
const FORCE_EXIT_MS = 10_000;

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    // The message names the invalid variables and never contains their values.
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const app = await buildApp({ config, version: packageJson.version });

// Only development and test can start without these (ADR 0014, "Configuration").
if (config.githubSignIn === null) {
  app.log.warn(
    "GitHub sign-in is disabled: API_PUBLIC_ORIGIN, API_GITHUB_CLIENT_ID, and API_GITHUB_CLIENT_SECRET are not set",
  );
}
if (config.databaseUrl === null) {
  app.log.warn("the database is disabled: DATABASE_URL is not set");
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  // Does not keep the process alive; it only fires if closing hangs.
  setTimeout(() => process.exit(1), FORCE_EXIT_MS).unref();
  try {
    await app.close();
  } catch (error) {
    app.log.error({ err: error }, "shutdown failed");
    process.exitCode = 1;
  }
}

// On Windows, Ctrl+C sends SIGINT; SIGTERM is never delivered there.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, (received) => void shutdown(received));
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, "listen failed");
  process.exit(1);
}
