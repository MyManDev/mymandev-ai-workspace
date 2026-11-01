import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { newId, type UserId, type WorkspaceId } from "@mymandev/protocol";
import {
  ACCOUNT_COMMAND_USAGE,
  CONFIRM_FLAG,
  disableReport,
  enableReport,
  erasureReport,
  parseAccountCommand,
} from "./account-command.ts";

const userId = newId<UserId>();

test("disable and enable take a user ID, and erase takes a user ID and --confirm in any order", () => {
  for (const action of ["disable", "enable"] as const) {
    assert.deepEqual(parseAccountCommand([action, userId]), {
      ok: true,
      command: { action, userId },
    });
  }
  for (const args of [
    ["erase", userId, CONFIRM_FLAG],
    ["erase", CONFIRM_FLAG, userId],
  ]) {
    assert.deepEqual(parseAccountCommand(args), {
      ok: true,
      command: { action: "erase", userId },
    });
  }
});

test("an unknown action, a malformed or missing user ID, an extra argument, and --confirm on another action answer the usage", () => {
  for (const args of [
    [],
    ["delete", userId],
    ["Erase", userId, CONFIRM_FLAG],
    ["disable"],
    ["disable", "not-a-uuid"],
    ["erase", "not-a-uuid", CONFIRM_FLAG],
    // A UUIDv4 is not a user ID.
    ["erase", "3b241101-e2bb-4255-8caf-4136c566a962", CONFIRM_FLAG],
    ["disable", userId, userId],
    ["erase", userId, CONFIRM_FLAG, "--force"],
    ["erase", userId, CONFIRM_FLAG, CONFIRM_FLAG],
    ["erase", userId, "--confirm=yes"],
    ["disable", userId, CONFIRM_FLAG],
    ["enable", CONFIRM_FLAG, userId],
  ]) {
    assert.deepEqual(
      parseAccountCommand(args),
      { ok: false, message: ACCOUNT_COMMAND_USAGE },
      args.join(" "),
    );
  }
});

test("erase without --confirm says what it would do and changes nothing", () => {
  const parsed = parseAccountCommand(["erase", userId]);
  assert.equal(parsed.ok, false);
  assert.ok(!parsed.ok);
  assert.match(parsed.message, /cannot be undone/);
  assert.ok(parsed.message.includes(userId));
  assert.ok(parsed.message.includes(CONFIRM_FLAG));
});

test("the command exits with 1 before it connects when the arguments are refused", () => {
  const cli = fileURLToPath(new URL("./account-cli.ts", import.meta.url));
  for (const args of [["erase", userId], ["delete"]]) {
    let status: number | null = null;
    let stderr = "";
    try {
      execFileSync(process.execPath, [cli, ...args], {
        encoding: "utf8",
        // Without DATABASE_URL: a refusal must come before the connection.
        env: { PATH: process.env["PATH"] ?? "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failed = error as { status: number | null; stderr: string };
      status = failed.status;
      stderr = failed.stderr;
    }
    assert.equal(status, 1, args.join(" "));
    assert.equal(stderr.includes("DATABASE_URL"), false);
  }
});

test("an erasure that is refused, or of an account that does not exist, exits with 1; a second erasure exits with 0", () => {
  const workspaceId = newId<WorkspaceId>();
  const owner = erasureReport({
    erased: false,
    refusal: "owner",
    ownedWorkspaceIds: [workspaceId],
  });
  assert.equal(owner.exitCode, 1);
  assert.ok(owner.message.includes(workspaceId));
  assert.match(owner.message, /Transfer their ownership first/);
  const unknown = erasureReport({ erased: false, refusal: "not_found" });
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.message, /^Refused: no account/);
  assert.deepEqual(
    erasureReport({ erased: false, refusal: "already_erased" }),
    {
      exitCode: 0,
      message: "No change: the account is already erased.",
    },
  );
  const erased = erasureReport({
    erased: true,
    endedMemberships: [],
    revokedDevices: [],
    withdrawnJoinRequestIds: [],
  });
  assert.equal(erased.exitCode, 0);
  assert.match(
    erased.message,
    /^Account erased: 0 memberships ended, 0 devices revoked, 0 join requests withdrawn, 0 invitations revoked, 0 grants revoked, 0 runs cancelled\.\nThe API closes/,
  );
});

test("enabling an erased account is refused with 1; disable and enable otherwise exit with 0", () => {
  const erased = enableReport({ changed: false, erased: true });
  assert.equal(erased.exitCode, 1);
  assert.match(erased.message, /^Refused: the account is erased/);
  assert.deepEqual(enableReport({ changed: true, erased: false }), {
    exitCode: 0,
    message: "Account enabled; no grant was restored.",
  });
  assert.equal(enableReport({ changed: false, erased: false }).exitCode, 0);
  assert.equal(
    disableReport({ changed: false, revokedGrantIds: [] }).exitCode,
    0,
  );
});
