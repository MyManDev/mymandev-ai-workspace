import assert from "node:assert/strict";
import { test } from "node:test";
import { CapabilitySchema } from "./entities.ts";
import {
  CAPABILITIES,
  canTransition,
  INITIAL_RUN_STATE,
  isTerminalRunState,
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
