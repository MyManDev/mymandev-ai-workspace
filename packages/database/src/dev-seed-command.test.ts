import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentId,
  type DeviceId,
  newId,
  type ProjectId,
  type RunId,
} from "@mymandev/protocol";
import {
  checkDevSeedEnvironment,
  checkServerAddress,
  DEV_SEED_FLAG,
  DEV_SEED_USAGE,
  devSeedReport,
  isLoopbackAddress,
  parseDevSeedCommand,
} from "./dev-seed-command.ts";

const DEVICE = newId<DeviceId>();
const PROJECT = newId<ProjectId>();
const LOCAL =
  "postgres://mymandev_app:secret@127.0.0.1:5432/mymandev?sslmode=disable";

test("the seed command takes a device ID, a project ID, and an optional run count from 1 to 20", () => {
  assert.deepEqual(parseDevSeedCommand([DEVICE, PROJECT]), {
    ok: true,
    command: { deviceId: DEVICE, projectId: PROJECT, runs: 3 },
  });
  assert.deepEqual(parseDevSeedCommand([DEVICE, PROJECT, "--runs", "20"]), {
    ok: true,
    command: { deviceId: DEVICE, projectId: PROJECT, runs: 20 },
  });
  for (const args of [
    [],
    [DEVICE],
    [PROJECT.toUpperCase(), DEVICE],
    ["not-an-id", PROJECT],
    [DEVICE, PROJECT, "--runs"],
    [DEVICE, PROJECT, "--runs", "0"],
    [DEVICE, PROJECT, "--runs", "21"],
    [DEVICE, PROJECT, "--runs", "05"],
    [DEVICE, PROJECT, "--runs", "2.5"],
    [DEVICE, PROJECT, "--runs", "1e1"],
    [DEVICE, PROJECT, "--runs", "2", "extra"],
    [DEVICE, PROJECT, "--confirm"],
  ]) {
    assert.deepEqual(
      parseDevSeedCommand(args),
      { ok: false, message: DEV_SEED_USAGE },
      args.join(" "),
    );
  }
});

test("the seed command runs only with the opt-in, outside production, and on a database of this computer", () => {
  const allowed = (url: string) =>
    checkDevSeedEnvironment({ [DEV_SEED_FLAG]: "1", DATABASE_URL: url });
  for (const url of [
    LOCAL,
    "postgres://mymandev_app:secret@localhost:5432/mymandev",
    "postgresql://mymandev_app:secret@127.1.2.3/mymandev",
    "postgres://mymandev_app:secret@[::1]:5432/mymandev",
  ]) {
    assert.deepEqual(allowed(url), { ok: true, url }, url);
  }
  for (const url of [
    "postgres://mymandev_app:secret@db.example.com:5432/mymandev?sslmode=verify-full",
    "postgres://mymandev_app:secret@10.0.0.5:5432/mymandev",
    "postgres://mymandev_app:secret@127.0.0.1.example.com/mymandev",
    "postgres://mymandev_app:secret@localhost.example.com/mymandev",
    // Not an IPv4 address in its usual form, or outside 127.0.0.0/8.
    "postgres://mymandev_app:secret@127.1/mymandev",
    "postgres://mymandev_app:secret@127.0.0.256/mymandev",
    "postgres://mymandev_app:secret@0127.0.0.1/mymandev",
    "postgres://mymandev_app:secret@128.0.0.1/mymandev",
    "postgres://mymandev_app:secret@[::2]/mymandev",
    // pg would connect to the host in the query instead.
    "postgres://mymandev_app:secret@127.0.0.1/mymandev?host=db.example.com",
  ]) {
    const result = allowed(url);
    assert.ok(!result.ok, url);
    assert.match(
      result.message,
      /^Refused: DATABASE_URL does not name a database on this computer/u,
    );
    // The URL, with its password, is never printed.
    assert.doesNotMatch(result.message, /secret/u);
  }
  for (const flag of [undefined, "", "0", "true", "yes"]) {
    const result = checkDevSeedEnvironment({
      [DEV_SEED_FLAG]: flag,
      DATABASE_URL: LOCAL,
    });
    assert.ok(!result.ok);
    assert.match(result.message, /^Refused: MYMANDEV_DEV_SEED is not 1/u);
  }
  assert.deepEqual(
    checkDevSeedEnvironment({
      [DEV_SEED_FLAG]: "1",
      NODE_ENV: "production",
      DATABASE_URL: LOCAL,
    }),
    { ok: false, message: "Refused: NODE_ENV is production." },
  );
  assert.deepEqual(checkDevSeedEnvironment({ [DEV_SEED_FLAG]: "1" }), {
    ok: false,
    message: "DATABASE_URL is not set.",
  });
  assert.deepEqual(
    checkDevSeedEnvironment({
      [DEV_SEED_FLAG]: "1",
      DATABASE_URL:
        "postgres://mymandev_app:secret@127.0.0.1/mymandev?sslmode=require",
    }),
    {
      ok: false,
      message: "DATABASE_URL sslmode must be disable or verify-full.",
    },
  );
});

test("the seed command reports the agent and its runs, and a refusal with exit code 1", () => {
  const agentId = newId<AgentId>();
  const runIds = [newId<RunId>(), newId<RunId>()];
  assert.deepEqual(devSeedReport({ seeded: true, agentId, runIds }), {
    exitCode: 0,
    message: `Agent ${agentId} created with 2 queued runs:\n${runIds.join("\n")}`,
  });
  assert.deepEqual(devSeedReport({ seeded: false, refusal: "not_member" }), {
    exitCode: 1,
    message:
      "Refused: the device's account is not an active member of the project's workspace. Nothing was changed.",
  });
});

test("only loopback addresses count as this computer, also for the address on which the server took the connection", () => {
  for (const address of [
    "127.0.0.1",
    "127.255.255.254",
    "::1",
    "::ffff:127.0.0.1",
    "::FFFF:127.1.2.3",
  ]) {
    assert.equal(isLoopbackAddress(address), true, address);
    assert.equal(checkServerAddress(address), undefined, address);
  }
  for (const address of [
    "",
    "localhost",
    "127.1",
    "127.0.0.1/32",
    "10.0.0.5",
    "::2",
    "::ffff:10.0.0.5",
    "fe80::1",
  ]) {
    assert.equal(isLoopbackAddress(address), false, address);
  }
  // A Unix-domain socket has no address.
  assert.equal(checkServerAddress(null), undefined);
  assert.match(
    checkServerAddress("10.0.0.5") ?? "",
    /^Refused: the database server did not accept the connection on a loopback address/u,
  );
});
