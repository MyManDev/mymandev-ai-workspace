import { isIPv4, isIPv6 } from "node:net";
import {
  type DeviceId,
  DeviceIdSchema,
  type ProjectId,
  ProjectIdSchema,
} from "@mymandev/protocol";
import { checkDatabaseUrl } from "./client.ts";
import type { CommandReport } from "./account-command.ts";
import { DEV_SEED_RUNS, type SeedDevAgentResult } from "./dev-seed.ts";

/** The environment variable that must be `1` before the command runs. */
export const DEV_SEED_FLAG = "MYMANDEV_DEV_SEED";

export const DEV_SEED_USAGE = `Usage: ${DEV_SEED_FLAG}=1 db:dev-seed -- <device ID (UUIDv7)> <project ID (UUIDv7)> [--runs <${DEV_SEED_RUNS.min} to ${DEV_SEED_RUNS.max}, default ${DEV_SEED_RUNS.default}>]`;

export type DevSeedCommand = Readonly<{
  deviceId: DeviceId;
  projectId: ProjectId;
  runs: number;
}>;

export type ParsedDevSeedCommand =
  | Readonly<{ ok: true; command: DevSeedCommand }>
  | Readonly<{ ok: false; message: string }>;

/**
 * Reads the arguments of the development command `db:dev-seed`
 * (`src/dev-seed-cli.ts`): a device ID and a project ID, in this order, and
 * optionally `--runs` with a count in plain decimal form. Anything else is
 * refused with the usage.
 */
export function parseDevSeedCommand(
  args: readonly string[],
): ParsedDevSeedCommand {
  const refused: ParsedDevSeedCommand = { ok: false, message: DEV_SEED_USAGE };
  const [device, project, ...rest] = args;
  const deviceId = DeviceIdSchema.safeParse(device);
  const projectId = ProjectIdSchema.safeParse(project);
  if (!deviceId.success || !projectId.success) {
    return refused;
  }
  let runs: number = DEV_SEED_RUNS.default;
  if (rest.length > 0) {
    const [flag, count, ...extra] = rest;
    if (
      flag !== "--runs" ||
      count === undefined ||
      extra.length > 0 ||
      !/^[1-9][0-9]{0,1}$/u.test(count)
    ) {
      return refused;
    }
    runs = Number(count);
    if (runs < DEV_SEED_RUNS.min || runs > DEV_SEED_RUNS.max) {
      return refused;
    }
  }
  return {
    ok: true,
    command: { deviceId: deviceId.data, projectId: projectId.data, runs },
  };
}

/**
 * Whether an IP address is the computer itself: an IPv4 address in
 * 127.0.0.0/8, `::1`, or an IPv4-mapped IPv6 address in 127.0.0.0/8, in
 * their usual text forms. Anything else, also another spelling of `::1`, is
 * not.
 */
export function isLoopbackAddress(address: string): boolean {
  if (isIPv4(address)) {
    return address.startsWith("127.");
  }
  if (!isIPv6(address)) {
    return false;
  }
  const lower = address.toLowerCase();
  const mapped = lower.startsWith("::ffff:")
    ? lower.slice("::ffff:".length)
    : "";
  return lower === "::1" || (isIPv4(mapped) && mapped.startsWith("127."));
}

/** Whether a URL's host is the computer itself: `localhost` or a loopback address. */
function isLoopbackHost(hostname: string): boolean {
  const address =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return hostname === "localhost" || isLoopbackAddress(address);
}

/**
 * Decides whether the command may run, before it connects, and returns the
 * URL to connect with, or the message of a refusal. It refuses unless the
 * environment sets `MYMANDEV_DEV_SEED=1`, an explicit opt-in that no server
 * sets; with `NODE_ENV=production`; without a `DATABASE_URL` that
 * `checkDatabaseUrl` accepts; and for a database that is not on the
 * developer's own computer: the URL's host must be a loopback address
 * (`localhost`, 127.0.0.0/8, or `::1`), and it must not name a host in its
 * query, which pg would connect to instead. Every server database, the
 * production one among them, is reached over the network, so the host
 * decides without a marker in the database itself. A tunnel that forwards a
 * local port to a server defeats the host rule; the opt-in is the second
 * guard against that.
 */
export function checkDevSeedEnvironment(
  env: Readonly<Record<string, string | undefined>>,
):
  | Readonly<{ ok: true; url: string }>
  | Readonly<{ ok: false; message: string }> {
  if (env[DEV_SEED_FLAG] !== "1") {
    return {
      ok: false,
      message: `Refused: ${DEV_SEED_FLAG} is not 1. This command writes test data and is for development only.`,
    };
  }
  if (env["NODE_ENV"] === "production") {
    return {
      ok: false,
      message: "Refused: NODE_ENV is production.",
    };
  }
  const url = env["DATABASE_URL"];
  if (!url) {
    return { ok: false, message: "DATABASE_URL is not set." };
  }
  const problem = checkDatabaseUrl(url, false);
  if (problem !== undefined) {
    return { ok: false, message: `DATABASE_URL ${problem}.` };
  }
  const parsed = new URL(url);
  if (!isLoopbackHost(parsed.hostname) || parsed.searchParams.has("host")) {
    return {
      ok: false,
      message:
        "Refused: DATABASE_URL does not name a database on this computer (localhost, 127.0.0.0/8, or ::1).",
    };
  }
  return { ok: true, url };
}

/**
 * The second check, after the command connected: the address on which the
 * server took the connection, `host(inet_server_addr())`, must be a loopback
 * address, or null for a Unix-domain socket, so that a name that resolves
 * elsewhere cannot pass. A tunnel to a server still passes, because its
 * local end is the loopback address; the opt-in guards against it. Returns
 * the message of a refusal, or undefined.
 */
export function checkServerAddress(address: string | null): string | undefined {
  return address === null || isLoopbackAddress(address)
    ? undefined
    : "Refused: the database server did not accept the connection on a loopback address. Nothing was changed.";
}

/** What the command prints, and its exit code. */
export function devSeedReport(result: SeedDevAgentResult): CommandReport {
  if (result.seeded) {
    return {
      exitCode: 0,
      message: [
        `Agent ${result.agentId} created with ${result.runIds.length} queued runs:`,
        ...result.runIds,
      ].join("\n"),
    };
  }
  const reasons = {
    device_not_found: "the device does not exist or is revoked",
    project_not_found: "the project does not exist",
    not_member:
      "the device's account is not an active member of the project's workspace",
    archived: "the project or its workspace is archived",
  } satisfies Record<typeof result.refusal, string>;
  return {
    exitCode: 1,
    message: `Refused: ${reasons[result.refusal]}. Nothing was changed.`,
  };
}
