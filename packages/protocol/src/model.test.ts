import assert from "node:assert/strict";
import { test } from "node:test";
import { CapabilitySchema } from "./entities.ts";
import {
  CAPABILITIES,
  canTransition,
  DEVICE_PLATFORMS,
  INITIAL_RUN_STATE,
  isTerminalRunState,
  LIMITS,
  RUN_STATES,
  RUN_TRANSITIONS,
  TERMINAL_RUN_STATES,
  type RunState,
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

test("the exported constants are frozen, nested values included", () => {
  const arrays: [label: string, value: readonly unknown[]][] = [
    ["CAPABILITIES", CAPABILITIES],
    ["RUN_STATES", RUN_STATES],
    ["TERMINAL_RUN_STATES", TERMINAL_RUN_STATES],
    ["DEVICE_PLATFORMS", DEVICE_PLATFORMS],
    ...RUN_STATES.map((state): [string, readonly unknown[]] => [
      `RUN_TRANSITIONS.${state}`,
      RUN_TRANSITIONS[state],
    ]),
  ];
  const objects: [label: string, value: object][] = [
    ["RUN_TRANSITIONS", RUN_TRANSITIONS],
    ["LIMITS", LIMITS],
  ];
  assert.equal(arrays.length, 10);
  assert.equal(objects.length, 2);

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
