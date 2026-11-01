import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "./ipc-channels.ts";
import {
  EVENT_CONTRACT,
  INVOKE_CONTRACT,
  RUNTIME_STATES,
  RuntimeStatusSchema,
} from "./ipc-contract.ts";

test("every channel has exactly one schema entry, and no name is used twice", () => {
  const invokeChannels = Object.values(INVOKE_CHANNELS);
  const eventChannels = Object.values(EVENT_CHANNELS);

  expect(Object.keys(INVOKE_CONTRACT).sort()).toEqual(
    [...invokeChannels].sort(),
  );
  expect(Object.keys(EVENT_CONTRACT).sort()).toEqual([...eventChannels].sort());
  expect(new Set([...invokeChannels, ...eventChannels]).size).toBe(
    invokeChannels.length + eventChannels.length,
  );
});

test("the channel names and the contract cannot be changed at runtime", () => {
  expect(Object.isFrozen(INVOKE_CHANNELS)).toBe(true);
  expect(Object.isFrozen(EVENT_CHANNELS)).toBe(true);
  expect(Object.isFrozen(INVOKE_CONTRACT)).toBe(true);
  expect(Object.isFrozen(EVENT_CONTRACT)).toBe(true);
  expect(Object.isFrozen(RUNTIME_STATES)).toBe(true);
  for (const entry of Object.values(INVOKE_CONTRACT)) {
    expect(Object.isFrozen(entry)).toBe(true);
  }
});

test("a runtime status with every state is accepted", () => {
  for (const state of RUNTIME_STATES) {
    expect(RuntimeStatusSchema.parse({ state, revision: 3 })).toEqual({
      state,
      revision: 3,
    });
  }
});

test("a runtime status drops unknown keys, also __proto__ and constructor", () => {
  const parsed = RuntimeStatusSchema.parse(
    JSON.parse(
      '{"state":"running","revision":1,"token":"secret","__proto__":{"polluted":true},"constructor":{"x":1}}',
    ),
  );

  expect(parsed).toEqual({ state: "running", revision: 1 });
  expect(Object.keys(parsed).sort()).toEqual(["revision", "state"]);
  expect(Object.hasOwn(parsed, "__proto__")).toBe(false);
  expect(Object.hasOwn(parsed, "constructor")).toBe(false);
  expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
});

test("a runtime status with a wrong state or revision is refused", () => {
  for (const value of [
    undefined,
    null,
    "running",
    {},
    { state: "running" },
    { revision: 0 },
    { state: "paused", revision: 0 },
    { state: "RUNNING", revision: 0 },
    { state: "running", revision: -1 },
    { state: "running", revision: 1.5 },
    { state: "running", revision: "1" },
    { state: "running", revision: Number.MAX_SAFE_INTEGER + 1 },
    { state: "running", revision: Number.NaN },
  ]) {
    expect(RuntimeStatusSchema.safeParse(value).success).toBe(false);
  }
});

test("the invoke channels take no arguments and refuse any", () => {
  for (const { args } of Object.values(INVOKE_CONTRACT)) {
    expect(args.parse([])).toEqual([]);
    for (const value of [
      [undefined],
      [null],
      ["runtime:get-status"],
      [{ state: "running" }],
      [1, 2],
      undefined,
      {},
      "",
    ]) {
      expect(args.safeParse(value).success).toBe(false);
    }
  }
});

test("an error message of the contract never contains the input", () => {
  const result = RuntimeStatusSchema.safeParse({
    state: "secret-value",
    revision: "secret-number",
  });

  expect(result.success).toBe(false);
  expect(JSON.stringify(result.error?.issues)).not.toContain("secret");
});
