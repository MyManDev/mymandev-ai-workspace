import { expect, test } from "vitest";
import { RUNTIME_STATES } from "../shared/ipc-contract.ts";
import { describeRuntimeView, initialRuntimeView } from "./runtime-status.ts";

test("the view starts pending with the bridge and unavailable without it", () => {
  expect(initialRuntimeView(true)).toEqual({ kind: "pending" });
  expect(initialRuntimeView(false)).toEqual({ kind: "unavailable" });
});

test("every runtime state has its own label and tone", () => {
  const labels = RUNTIME_STATES.map(
    (state) =>
      describeRuntimeView({ kind: "known", status: { state, revision: 1 } })
        .label,
  );

  expect(labels).toEqual([
    "Local runtime: Starting",
    "Local runtime: Running",
    "Local runtime: Stopping",
    "Local runtime: Stopped",
    "Local runtime: Failed",
  ]);
  for (const state of RUNTIME_STATES) {
    expect(
      describeRuntimeView({ kind: "known", status: { state, revision: 1 } })
        .tone,
    ).toBe(state);
  }
});

test("a missing status is shown as unknown", () => {
  expect(describeRuntimeView({ kind: "pending" })).toEqual({
    tone: "unknown",
    label: "Local runtime: Checking",
  });
  expect(describeRuntimeView({ kind: "unavailable" })).toEqual({
    tone: "unknown",
    label: "Local runtime: Unavailable",
  });
});
