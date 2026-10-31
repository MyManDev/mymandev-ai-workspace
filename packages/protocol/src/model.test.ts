import assert from "node:assert/strict";
import { test } from "node:test";
import { CapabilitySchema } from "./entities.ts";
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  CAPABILITIES,
  canTransition,
  DEVICE_KEY_ALGORITHMS,
  DEVICE_PLATFORMS,
  DEVICE_REVOCATION_REASONS,
  genericApiErrorCode,
  GITHUB_LOGIN_PATTERN,
  IDENTITY_PROVIDERS,
  INITIAL_RUN_STATE,
  INVITATION_LIFETIME_SECONDS,
  isTerminalRunState,
  JOIN_REQUEST_DECISIONS,
  LIMITS,
  MEMBER_ROLES,
  OWNERSHIP_OFFER_END_REASONS,
  RUN_CANCEL_REASONS,
  RUN_STATES,
  RUN_TRANSITIONS,
  SIGN_IN_LIFETIME_MS,
  TERMINAL_RUN_STATES,
  type RunState,
  WS_CLOSE_CODES,
} from "./model.ts";

test("the capability vocabulary is exactly the six names and matches exactly", () => {
  assert.deepEqual(CAPABILITIES, [
    "repo.read",
    "repo.write",
    "terminal.execute",
    "git.commit",
    "git.push",
    "provider.use",
  ]);
  for (const capability of CAPABILITIES) {
    assert.equal(CapabilitySchema.safeParse(capability).success, true);
  }
  for (const rejected of [
    "repo.*",
    "*",
    "REPO.READ",
    "Repo.Read",
    " repo.read",
    "repo.admin",
    "",
  ]) {
    assert.equal(
      CapabilitySchema.safeParse(rejected).success,
      false,
      `${JSON.stringify(rejected)} must be rejected`,
    );
  }
});

test("every state pair follows RUN_TRANSITIONS, and a new run starts in queued", () => {
  // The literal table from ADR 0007, so that RUN_TRANSITIONS cannot drift from it.
  assert.deepEqual(RUN_TRANSITIONS, {
    queued: ["running", "failed", "cancelled"],
    running: ["awaiting_input", "completed", "failed", "cancelled"],
    awaiting_input: ["running", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  });
  assert.equal(INITIAL_RUN_STATE, "queued");
  for (const to of RUN_STATES) {
    assert.equal(canTransition(null, to), to === "queued", `null -> ${to}`);
  }
  for (const from of RUN_STATES) {
    const allowed: readonly RunState[] = RUN_TRANSITIONS[from];
    for (const to of RUN_STATES) {
      assert.equal(
        canTransition(from, to),
        allowed.includes(to),
        `${from} -> ${to}`,
      );
    }
  }
  assert.deepEqual(Object.keys(RUN_TRANSITIONS).sort(), [...RUN_STATES].sort());
});

test("terminal states have no outgoing transition", () => {
  assert.deepEqual([...TERMINAL_RUN_STATES].sort(), [
    "cancelled",
    "completed",
    "failed",
  ]);
  for (const from of RUN_STATES) {
    const terminal = RUN_TRANSITIONS[from].length === 0;
    assert.equal(isTerminalRunState(from), terminal, from);
    if (terminal) {
      for (const to of RUN_STATES) {
        assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
      }
    }
  }
});

test("the account vocabularies are exactly the values of ADR 0014", () => {
  assert.deepEqual(MEMBER_ROLES, ["owner", "admin", "member"]);
  assert.deepEqual(DEVICE_KEY_ALGORITHMS, ["ed25519"]);
  assert.deepEqual(DEVICE_REVOCATION_REASONS, [
    "removed",
    "lost",
    "replaced",
    "account_erased",
  ]);
  assert.deepEqual(JOIN_REQUEST_DECISIONS, [
    "approved",
    "denied",
    "blocked",
    "withdrawn",
    "expired",
  ]);
  assert.deepEqual(IDENTITY_PROVIDERS, ["github"]);
  assert.deepEqual(RUN_CANCEL_REASONS, ["member_removed", "device_revoked"]);
  assert.deepEqual(OWNERSHIP_OFFER_END_REASONS, ["withdrawn", "expired"]);
  assert.deepEqual(INVITATION_LIFETIME_SECONDS, {
    min: 3_600,
    max: 604_800,
    default: 604_800,
  });
});

test("a device sign-in lasts 30 days", () => {
  assert.equal(SIGN_IN_LIFETIME_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(SIGN_IN_LIFETIME_MS, 2_592_000_000);
});

test("every API error code has its fixed HTTP status", () => {
  // The literal table, so that a status cannot change without this test.
  assert.deepEqual(API_ERROR_STATUS, {
    bad_request: 400,
    unauthorized: 401,
    auth_failed: 401,
    device_revoked: 401,
    sign_in_required: 401,
    forbidden: 403,
    device_registration_locked: 403,
    device_too_new: 403,
    unsupported_account: 403,
    join_requests_closed: 403,
    not_found: 404,
    workspace_not_found: 404,
    invitation_invalid: 404,
    device_account_mismatch: 409,
    already_member: 409,
    conflict: 409,
    rate_limited: 429,
    internal_error: 500,
    sign_in_unavailable: 503,
  });
  assert.deepEqual(API_ERROR_CODES, Object.keys(API_ERROR_STATUS));
  for (const code of API_ERROR_CODES) {
    assert.match(code, /^[a-z]+(?:_[a-z]+)*$/u);
  }
  // Codes that ADR 0014 names under "HTTP errors".
  for (const named of [
    "bad_request",
    "unauthorized",
    "auth_failed",
    "device_revoked",
    "sign_in_required",
    "device_account_mismatch",
    "device_registration_locked",
    "unsupported_account",
    "invitation_invalid",
    "already_member",
    "workspace_not_found",
    "join_requests_closed",
    "rate_limited",
    "sign_in_unavailable",
    "not_found",
    "internal_error",
  ]) {
    assert.equal(API_ERROR_CODES.includes(named as never), true, named);
  }
});

test("an error without its own code gets a generic code by status", () => {
  const expected: [status: number, code: string][] = [
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [405, "bad_request"],
    [409, "conflict"],
    [413, "bad_request"],
    [415, "bad_request"],
    [429, "rate_limited"],
    [500, "internal_error"],
    [503, "internal_error"],
  ];
  for (const [status, code] of expected) {
    assert.equal(genericApiErrorCode(status), code, String(status));
  }
  // The generic code of a status keeps that status, except 405, 413, and 415.
  for (const [status, code] of expected) {
    if (status < 500 && ![405, 413, 415].includes(status)) {
      assert.equal(
        API_ERROR_STATUS[code as keyof typeof API_ERROR_STATUS],
        status,
      );
    }
  }
});

test("the GitHub login rule accepts logins and managed user handles only", () => {
  for (const login of [
    "octocat",
    "a",
    "a".repeat(39),
    "user_shortcode",
    "my-name",
    "A1-b_2",
  ]) {
    assert.match(login, GITHUB_LOGIN_PATTERN, login);
  }
  for (const login of [
    "",
    "a".repeat(40),
    "has space",
    "dot.name",
    "\u0130stanbul",
    "name\n",
    "@octocat",
  ]) {
    assert.doesNotMatch(login, GITHUB_LOGIN_PATTERN, JSON.stringify(login));
  }
});

test("the exported constants are frozen, nested values included", () => {
  const arrays: [label: string, value: readonly unknown[]][] = [
    ["CAPABILITIES", CAPABILITIES],
    ["RUN_STATES", RUN_STATES],
    ["TERMINAL_RUN_STATES", TERMINAL_RUN_STATES],
    ["DEVICE_PLATFORMS", DEVICE_PLATFORMS],
    ["MEMBER_ROLES", MEMBER_ROLES],
    ["DEVICE_KEY_ALGORITHMS", DEVICE_KEY_ALGORITHMS],
    ["DEVICE_REVOCATION_REASONS", DEVICE_REVOCATION_REASONS],
    ["JOIN_REQUEST_DECISIONS", JOIN_REQUEST_DECISIONS],
    ["IDENTITY_PROVIDERS", IDENTITY_PROVIDERS],
    ["RUN_CANCEL_REASONS", RUN_CANCEL_REASONS],
    ["OWNERSHIP_OFFER_END_REASONS", OWNERSHIP_OFFER_END_REASONS],
    ["API_ERROR_CODES", API_ERROR_CODES],
    ...RUN_STATES.map((state): [string, readonly unknown[]] => [
      `RUN_TRANSITIONS.${state}`,
      RUN_TRANSITIONS[state],
    ]),
  ];
  const objects: [label: string, value: object][] = [
    ["RUN_TRANSITIONS", RUN_TRANSITIONS],
    ["LIMITS", LIMITS],
    ["API_ERROR_STATUS", API_ERROR_STATUS],
    ["INVITATION_LIFETIME_SECONDS", INVITATION_LIFETIME_SECONDS],
    ["WS_CLOSE_CODES", WS_CLOSE_CODES],
  ];
  assert.equal(arrays.length, 18);
  assert.equal(objects.length, 5);

  // Modules run in strict mode, so a write to a frozen value throws.
  for (const [label, value] of arrays) {
    const before = JSON.stringify(value);
    const mutable = value as unknown[];
    assert.equal(Object.isFrozen(value), true, label);
    assert.throws(() => mutable.push("added"), TypeError, `${label}: push`);
    assert.throws(
      () => {
        mutable[0] = "changed";
      },
      TypeError,
      `${label}: index`,
    );
    assert.throws(
      () => {
        mutable.length = 0;
      },
      TypeError,
      `${label}: length`,
    );
    assert.equal(JSON.stringify(value), before, label);
  }
  for (const [label, value] of objects) {
    const before = JSON.stringify(value);
    const mutable = value as Record<string, unknown>;
    const key = Object.keys(value)[0] ?? "";
    assert.equal(Object.isFrozen(value), true, label);
    assert.throws(
      () => {
        mutable[key] = 1;
      },
      TypeError,
      `${label}: change`,
    );
    assert.throws(
      () => {
        mutable.added = 1;
      },
      TypeError,
      `${label}: add`,
    );
    assert.throws(
      () => {
        delete mutable[key];
      },
      TypeError,
      `${label}: delete`,
    );
    assert.equal(JSON.stringify(value), before, label);
  }
});
