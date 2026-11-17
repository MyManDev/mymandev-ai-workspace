import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import {
  type DeviceId,
  LIMITS,
  newId,
  type ProjectId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { and, count, eq } from "drizzle-orm";
import type { Database } from "./db.ts";
import { DEV_SEED_FLAG } from "./dev-seed-command.ts";
import { createDevWorkspace } from "./dev-workspace.ts";
import {
  DEV_WORKSPACE_DEFAULT_NAMES,
  DEV_WORKSPACE_USAGE,
  devWorkspaceReport,
  parseDevWorkspaceCommand,
  runDevWorkspaceCommand,
} from "./dev-workspace-command.ts";
import { createWorkspace, listWorkspaces } from "./membership.ts";
import {
  createProject,
  listProjects,
  MAX_NEW_PROJECTS_PER_DAY,
} from "./projects.ts";
import {
  auditEvents,
  conversations,
  devices,
  users,
  workspaces,
} from "./schema/index.ts";
import { createTestDatabase } from "./testing.ts";

const DEVICE = newId<DeviceId>();
const LOCAL =
  "postgres://mymandev_app:secret@127.0.0.1:5432/mymandev?sslmode=disable";
const DAY_MS = 24 * 60 * 60_000;
const NOW = new Date("2026-11-05T12:00:00.000Z");

test("the workspace command takes a device ID and optional workspace and project names", () => {
  assert.deepEqual(parseDevWorkspaceCommand([DEVICE]), {
    ok: true,
    command: {
      deviceId: DEVICE,
      workspaceName: DEV_WORKSPACE_DEFAULT_NAMES.workspace,
      projectName: DEV_WORKSPACE_DEFAULT_NAMES.project,
    },
  });
  for (const args of [
    [DEVICE, "--workspace", "Team", "--project", "Website"],
    [DEVICE, "--project", "Website", "--workspace", "Team"],
  ]) {
    assert.deepEqual(
      parseDevWorkspaceCommand(args),
      {
        ok: true,
        command: {
          deviceId: DEVICE,
          workspaceName: "Team",
          projectName: "Website",
        },
      },
      args.join(" "),
    );
  }
  // A project name is normalized as the API normalizes it: NFC, then
  // without white space at the start and the end. A workspace name is not.
  assert.deepEqual(
    parseDevWorkspaceCommand([
      DEVICE,
      "--workspace",
      " Team ",
      "--project",
      "  Cafe\u0301 ",
    ]),
    {
      ok: true,
      command: {
        deviceId: DEVICE,
        workspaceName: " Team ",
        projectName: "Caf\u00e9",
      },
    },
  );
  for (const args of [
    [],
    ["not-an-id"],
    [DEVICE.toUpperCase()],
    [DEVICE, "extra"],
    [DEVICE, "--workspace"],
    [DEVICE, "--project"],
    [DEVICE, "--name", "Team"],
    [DEVICE, "--workspace", "A", "--workspace", "B"],
    [DEVICE, "--project", "A", "--project", "B"],
    [DEVICE, "--workspace", "A", "--project"],
    [DEVICE, "--project", "A", "extra"],
    ["--workspace", "A", DEVICE],
  ]) {
    assert.deepEqual(
      parseDevWorkspaceCommand(args),
      { ok: false, message: DEV_WORKSPACE_USAGE },
      args.join(" "),
    );
  }
});

test("the workspace command refuses a name that the API refuses, without repeating it", () => {
  const tooLong = "x".repeat(LIMITS.name + 1);
  for (const name of ["", "   ", tooLong, "Tab\there", "Zero\u200bwidth"]) {
    for (const flag of ["--workspace", "--project"] as const) {
      const parsed = parseDevWorkspaceCommand([DEVICE, flag, name]);
      assert.ok(!parsed.ok, `${flag} ${JSON.stringify(name)}`);
      const what = flag === "--workspace" ? "workspace" : "project";
      assert.match(
        parsed.message,
        new RegExp(
          `^Refused: the ${what} name must be 1 to 100 characters`,
          "u",
        ),
      );
      if (name.trim() !== "") {
        assert.equal(parsed.message.includes(name), false);
      }
    }
  }
  // The limit counts the normalized project name.
  assert.ok(
    parseDevWorkspaceCommand([
      DEVICE,
      "--project",
      ` ${"e\u0301".repeat(LIMITS.name)} `,
    ]).ok,
  );
});

test("the workspace command runs only with the opt-in, outside production, and on a database of this computer, before it connects", async () => {
  const cli = fileURLToPath(new URL("./dev-workspace-cli.ts", import.meta.url));
  // The processes run at the same time; each refuses before it connects.
  const run = async (env: Record<string, string>, args: readonly string[]) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [cli, ...args],
        {
          encoding: "utf8",
          env: { PATH: process.env["PATH"] ?? "", ...env },
          timeout: 60_000,
        },
      );
      return { status: 0, stdout, stderr };
    } catch (error) {
      const failed = error as {
        code: number | null;
        stdout: string;
        stderr: string;
      };
      return {
        status: failed.code,
        stdout: failed.stdout,
        stderr: failed.stderr,
      };
    }
  };
  const cases: readonly (readonly [Record<string, string>, RegExp])[] = [
    [{ DATABASE_URL: LOCAL }, /^Refused: MYMANDEV_DEV_SEED is not 1/u],
    [
      { [DEV_SEED_FLAG]: "true", DATABASE_URL: LOCAL },
      /^Refused: MYMANDEV_DEV_SEED is not 1/u,
    ],
    [
      { [DEV_SEED_FLAG]: "1", NODE_ENV: "production", DATABASE_URL: LOCAL },
      /^Refused: NODE_ENV is production\./u,
    ],
    [{ [DEV_SEED_FLAG]: "1" }, /^DATABASE_URL is not set\./u],
    [
      {
        [DEV_SEED_FLAG]: "1",
        DATABASE_URL:
          "postgres://mymandev_app:secret@db.example.com:5432/mymandev?sslmode=verify-full",
      },
      /^Refused: DATABASE_URL does not name a database on this computer/u,
    ],
    [
      {
        [DEV_SEED_FLAG]: "1",
        DATABASE_URL:
          "postgres://mymandev_app:secret@127.0.0.1/mymandev?sslmode=disable&host=db.example.com",
      },
      /^Refused: DATABASE_URL does not name a database on this computer/u,
    ],
  ];
  const results = await Promise.all(cases.map(([env]) => run(env, [DEVICE])));
  for (const [index, [env, message]] of cases.entries()) {
    const result = results[index];
    assert.ok(result !== undefined);
    assert.equal(result.status, 1, JSON.stringify(env));
    assert.match(result.stderr, message);
    assert.equal(result.stdout, "");
    // The URL, with its password, is never printed.
    assert.doesNotMatch(result.stderr, /secret|example\.com/u);
  }
  // The arguments are checked first, with the usage.
  const usage = await run({ [DEV_SEED_FLAG]: "1", DATABASE_URL: LOCAL }, ["x"]);
  assert.equal(usage.status, 1);
  assert.equal(usage.stderr.trim(), DEV_WORKSPACE_USAGE);
});

test("the workspace command reports the IDs, also of an existing workspace, and a refusal or a limit with exit code 1", () => {
  const userId = newId<UserId>();
  const workspaceId = newId<WorkspaceId>();
  const projectId = newId<ProjectId>();
  assert.deepEqual(
    devWorkspaceReport({ created: true, userId, workspaceId, projectId }),
    {
      exitCode: 0,
      message: `Workspace and project created for account ${userId}:\nWorkspace ID: ${workspaceId}\nProject ID: ${projectId}`,
    },
  );
  assert.deepEqual(
    devWorkspaceReport({
      created: false,
      refusal: "exists",
      userId,
      workspaceId,
      projectId,
    }),
    {
      exitCode: 0,
      message: `Nothing was created: account ${userId} already owns a workspace of that name with a project of that name:\nWorkspace ID: ${workspaceId}\nProject ID: ${projectId}`,
    },
  );
  assert.deepEqual(
    devWorkspaceReport({
      created: false,
      refusal: "exists",
      userId,
      workspaceId,
      projectId: null,
    }),
    {
      exitCode: 1,
      message: `Refused: account ${userId} already owns a workspace of that name, ${workspaceId}, without a project of that name. Nothing was changed. Choose another workspace name with --workspace.`,
    },
  );
  assert.deepEqual(
    devWorkspaceReport({ created: false, refusal: "device_not_found" }),
    {
      exitCode: 1,
      message:
        "Refused: the device does not exist or is revoked. Nothing was changed.",
    },
  );
  assert.deepEqual(
    devWorkspaceReport({
      created: false,
      refusal: "rate_limited",
      limit: "workspaces",
      retryAfterMs: 90 * 60_000 + 1,
    }),
    {
      exitCode: 1,
      message:
        "Refused: the account reached its limit of new workspaces within 24 hours. Nothing was changed. Try again in 91 minutes.",
    },
  );
  assert.deepEqual(
    devWorkspaceReport({
      created: false,
      refusal: "rate_limited",
      limit: "projects",
      retryAfterMs: 1,
    }),
    {
      exitCode: 1,
      message: `Refused: the account created ${MAX_NEW_PROJECTS_PER_DAY} projects within 24 hours. Nothing was changed. Try again in 1 minute.`,
    },
  );
  // The limit of projects per workspace has its own refusal, without a
  // wait; a daily limit always has one.
  assert.deepEqual(
    devWorkspaceReport({ created: false, refusal: "project_limit" }),
    {
      exitCode: 1,
      message:
        "Refused: the workspace holds 100 projects that are not archived. Nothing was changed.",
    },
  );
  const typeOnly = () =>
    devWorkspaceReport({
      created: false,
      refusal: "rate_limited",
      limit: "projects",
      // @ts-expect-error -- a daily limit always has a wait
      retryAfterMs: null,
    });
  assert.equal(typeof typeOnly, "function");
  for (const refusal of [
    "account_disabled",
    "invalid_name",
    "not_member",
    "conflict",
  ] as const) {
    const report = devWorkspaceReport({ created: false, refusal });
    assert.equal(report.exitCode, 1);
    assert.match(report.message, /^Refused: .+\. Nothing was changed\.$/u);
  }
});

let testDatabase: Awaited<ReturnType<typeof createTestDatabase>> | undefined;

function database(): Database {
  assert.ok(testDatabase, "the test database is created in before()");
  return testDatabase.db;
}

before(async () => {
  testDatabase = await createTestDatabase();
});

after(async () => {
  await testDatabase?.close();
});

type Account = Readonly<{ userId: UserId; deviceId: DeviceId }>;

/** An account with one device. */
async function account(displayName: string): Promise<Account> {
  const userId = newId<UserId>();
  await database().insert(users).values({ id: userId, displayName });
  const deviceId = newId<DeviceId>();
  await database()
    .insert(devices)
    .values({
      id: deviceId,
      userId,
      label: "Laptop",
      platform: "linux",
      publicKey: randomBytes(32).toString("hex"),
      keyAlgorithm: "ed25519",
      lastSignInAt: NOW,
    });
  return { userId, deviceId };
}

/** The workspaces that the account created, and the audit records of all. */
async function counts(userId: UserId) {
  const [created] = await database()
    .select({ n: count() })
    .from(workspaces)
    .where(eq(workspaces.createdByUserId, userId));
  const [audited] = await database()
    .select({ n: count() })
    .from(auditEvents)
    .where(eq(auditEvents.actorUserId, userId));
  return { workspaces: created?.n ?? 0, auditEvents: audited?.n ?? 0 };
}

function create(
  deviceId: DeviceId,
  names: Partial<{ workspaceName: string; projectName: string }> = {},
) {
  return createDevWorkspace(database(), {
    deviceId,
    workspaceName: DEV_WORKSPACE_DEFAULT_NAMES.workspace,
    projectName: DEV_WORKSPACE_DEFAULT_NAMES.project,
    ...names,
    now: NOW,
  });
}

test("the workspace command creates a workspace that the device's account owns, with one project, by the API's functions, and finds them on a second run", async () => {
  const owner = await account("Ayla");
  const result = await create(owner.deviceId, {
    workspaceName: "Team",
    projectName: "  Cafe\u0301 ",
  });
  assert.ok(result.created, JSON.stringify(result));
  assert.equal(result.userId, owner.userId);

  const [membership] = await listWorkspaces(database(), owner.userId);
  assert.ok(membership !== undefined);
  assert.equal(membership.workspace.id, result.workspaceId);
  assert.equal(membership.workspace.name, "Team");
  assert.equal(membership.member.role, "owner");
  assert.equal(membership.member.displayName, "Ayla");

  const projects = await listProjects(database(), result.workspaceId);
  assert.deepEqual(projects, [
    {
      id: result.projectId,
      workspaceId: result.workspaceId,
      name: "Caf\u00e9",
      createdByMemberId: membership.member.id,
    },
  ]);
  // The project's chat, as createProject creates it.
  const [chat] = await database()
    .select({ n: count() })
    .from(conversations)
    .where(
      and(
        eq(conversations.projectId, result.projectId),
        eq(conversations.kind, "project"),
      ),
    );
  assert.equal(chat?.n, 1);
  // The device is the actor's device of workspace.created.
  const audit = await database()
    .select({
      action: auditEvents.action,
      actorDeviceId: auditEvents.actorDeviceId,
    })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, result.workspaceId));
  assert.deepEqual(audit, [
    { action: "workspace.created", actorDeviceId: owner.deviceId },
  ]);

  // A second run with the same names creates nothing and finds both; the
  // project name is compared as the API compares it, ignoring case.
  const unchanged = await counts(owner.userId);
  assert.deepEqual(
    await create(owner.deviceId, {
      workspaceName: "Team",
      projectName: "caf\u00e9",
    }),
    {
      created: false,
      refusal: "exists",
      userId: owner.userId,
      workspaceId: result.workspaceId,
      projectId: result.projectId,
    },
  );
  // Another project name in that workspace is not created either.
  assert.deepEqual(
    await create(owner.deviceId, {
      workspaceName: "Team",
      projectName: "Other",
    }),
    {
      created: false,
      refusal: "exists",
      userId: owner.userId,
      workspaceId: result.workspaceId,
      projectId: null,
    },
  );
  assert.deepEqual(await counts(owner.userId), unchanged);
  assert.equal((await listProjects(database(), result.workspaceId)).length, 1);

  // Workspace names are compared exactly, and only among the workspaces
  // that the account owns.
  const renamed = await create(owner.deviceId, {
    workspaceName: "team",
    projectName: "Caf\u00e9",
  });
  assert.ok(renamed.created);
  assert.notEqual(renamed.workspaceId, result.workspaceId);
  const stranger = await account("Stranger");
  const theirs = await create(stranger.deviceId, { workspaceName: "Team" });
  assert.ok(theirs.created);
  assert.notEqual(theirs.workspaceId, result.workspaceId);
});

test("the connected workspace command refuses a server that did not take the connection on a loopback address, before it writes", async () => {
  const owner = await account("Remote");
  const parsed = parseDevWorkspaceCommand([owner.deviceId]);
  assert.ok(parsed.ok);
  const run = (serverAddress: string | null) =>
    runDevWorkspaceCommand(database(), {
      command: parsed.command,
      serverAddress,
      now: NOW,
    });
  for (const address of ["192.168.1.10", "10.0.0.5", "2001:db8::1"]) {
    assert.deepEqual(
      await run(address),
      {
        exitCode: 1,
        message:
          "Refused: the database server did not accept the connection on a loopback address. Nothing was changed.",
      },
      address,
    );
  }
  assert.deepEqual(await counts(owner.userId), {
    workspaces: 0,
    auditEvents: 0,
  });
  // A loopback address, or none for a Unix-domain socket, lets it create,
  // and a second run finds what the first created.
  const created = await run("127.0.0.1");
  assert.equal(created.exitCode, 0);
  assert.match(created.message, /^Workspace and project created for account /u);
  const again = await run(null);
  assert.equal(again.exitCode, 0);
  assert.match(again.message, /^Nothing was created: account /u);
  assert.equal((await counts(owner.userId)).workspaces, 1);
});

test("the workspace command refuses an unknown or revoked device, a disabled account, and a name that the API refuses, and writes nothing", async () => {
  const revoked = await account("Revoked");
  await database()
    .update(devices)
    .set({ revokedAt: NOW, revocationReason: "lost" })
    .where(eq(devices.id, revoked.deviceId));
  const disabled = await account("Disabled");
  await database()
    .update(users)
    .set({ disabledAt: NOW })
    .where(eq(users.id, disabled.userId));
  // The sign-in stores only display names that pass the API's rule; a row
  // written otherwise is refused as the API would refuse it.
  const badName = await account("Bell\u0007");
  const fine = await account("Fine");

  assert.deepEqual(await create(newId<DeviceId>()), {
    created: false,
    refusal: "device_not_found",
  });
  assert.deepEqual(await create(revoked.deviceId), {
    created: false,
    refusal: "device_not_found",
  });
  assert.deepEqual(await create(disabled.deviceId), {
    created: false,
    refusal: "account_disabled",
  });
  assert.deepEqual(await create(badName.deviceId), {
    created: false,
    refusal: "invalid_name",
  });
  for (const names of [
    { workspaceName: "" },
    { workspaceName: "x".repeat(LIMITS.name + 1) },
    { projectName: "   " },
    { projectName: "Zero\u200bwidth" },
  ]) {
    assert.deepEqual(
      await create(fine.deviceId, names),
      { created: false, refusal: "invalid_name" },
      JSON.stringify(names),
    );
  }
  for (const who of [revoked, disabled, badName, fine]) {
    assert.deepEqual(await counts(who.userId), {
      workspaces: 0,
      auditEvents: 0,
    });
  }
});

test("the workspace command returns the workspace limit, and the project limit without keeping the workspace", async () => {
  // Ten workspaces within 24 hours: the eleventh is refused.
  const busy = await account("Busy");
  for (let index = 0; index < 10; index += 1) {
    const result = await createWorkspace(database(), {
      ...busy,
      name: `Team ${index}`,
      displayName: "Busy",
      now: new Date(NOW.getTime() - DAY_MS + 60_000 * (index + 1)),
    });
    assert.ok(result.created);
  }
  const earlier = await counts(busy.userId);
  assert.deepEqual(await create(busy.deviceId), {
    created: false,
    refusal: "rate_limited",
    limit: "workspaces",
    retryAfterMs: 60_000,
  });
  assert.deepEqual(await counts(busy.userId), earlier);

  // Twenty projects within 24 hours: the workspace is created, its project
  // is refused, and the whole transaction rolls back.
  const builder = await account("Builder");
  const first = await createWorkspace(database(), {
    ...builder,
    name: "Team",
    displayName: "Builder",
    now: new Date(NOW.getTime() - DAY_MS + 60_000),
  });
  assert.ok(first.created);
  for (let index = 0; index < MAX_NEW_PROJECTS_PER_DAY; index += 1) {
    const project = await createProject(database(), {
      workspaceId: first.membership.workspace.id,
      userId: builder.userId,
      name: `Project ${index}`,
      now: new Date(NOW.getTime() - DAY_MS + 120_000 + index),
    });
    assert.ok(project.created);
  }
  const prior = await counts(builder.userId);
  assert.deepEqual(await create(builder.deviceId), {
    created: false,
    refusal: "rate_limited",
    limit: "projects",
    retryAfterMs: 120_000,
  });
  assert.deepEqual(await counts(builder.userId), prior);
  assert.equal((await listWorkspaces(database(), builder.userId)).length, 1);
});
