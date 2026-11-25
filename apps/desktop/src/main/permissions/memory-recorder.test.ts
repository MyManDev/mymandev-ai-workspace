import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId, RepositoryId, RunId } from "@mymandev/protocol";
import { expect, test } from "vitest";
import type { DenialRecord, EnforcementRecord } from "./enforcement.ts";
import {
  createMemoryEnforcementRecorder,
  MEMORY_RECORDER_LIMIT,
} from "./memory-recorder.ts";

function runId(n: number): RunId {
  return `0192f0a0-7b3c-7d4e-8f50-0000000b${n.toString(16).padStart(4, "0")}` as RunId;
}

const AGENT = "0192f0a0-7b3c-7d4e-8f50-000000000002" as AgentId;
const REPOSITORY = "0192f0a0-7b3c-7d4e-8f50-000000000009" as RepositoryId;

/** A frozen denial of run `n`, as the enforcement point passes it. */
function denial(n: number): DenialRecord {
  return Object.freeze({
    kind: "denied",
    reason: "no_grant",
    capability: "provider.use",
    runId: runId(n),
    agentId: AGENT,
    repositoryId: null,
    providerConnectionId: null,
    at: "2026-11-25T10:00:00.000Z",
  });
}

test("the bound is 1,000 records", () => {
  expect(MEMORY_RECORDER_LIMIT).toBe(1_000);
});

test("the recorder takes every record and keeps them frozen, oldest first", () => {
  const recorder = createMemoryEnforcementRecorder();
  const start: EnforcementRecord = Object.freeze({
    kind: "shell_start_allowed",
    runId: runId(2),
    agentId: AGENT,
    repositoryId: REPOSITORY,
    at: "2026-11-25T10:00:01.000Z",
  });
  expect(recorder.records()).toEqual([]);

  expect(recorder.record(denial(1))).toBeUndefined();
  expect(recorder.record(start)).toBeUndefined();

  const kept = recorder.records();
  expect(kept).toEqual([denial(1), start]);
  expect(kept[1]).toBe(start);
  expect(Object.isFrozen(kept)).toBe(true);
  for (const entry of kept) {
    expect(Object.isFrozen(entry)).toBe(true);
  }
  // The list is a copy: changing it is refused, and the recorder keeps its own.
  expect(() => (kept as EnforcementRecord[]).push(denial(3))).toThrow();
  expect(recorder.records()).toHaveLength(2);
});

test("a record that is not frozen yet is frozen when it is kept", () => {
  const recorder = createMemoryEnforcementRecorder();
  const entry = { ...denial(1) } as EnforcementRecord;
  expect(Object.isFrozen(entry)).toBe(false);
  recorder.record(entry);
  expect(Object.isFrozen(recorder.records()[0])).toBe(true);
});

test("beyond the bound, the oldest records are dropped", () => {
  const small = createMemoryEnforcementRecorder(3);
  for (let n = 1; n <= 7; n += 1) {
    expect(small.record(denial(n))).toBeUndefined();
  }
  expect(small.records().map((entry) => entry.runId)).toEqual([
    runId(5),
    runId(6),
    runId(7),
  ]);

  const recorder = createMemoryEnforcementRecorder();
  for (let n = 1; n <= MEMORY_RECORDER_LIMIT + 5; n += 1) {
    recorder.record(denial(n));
  }
  const kept = recorder.records();
  expect(kept).toHaveLength(MEMORY_RECORDER_LIMIT);
  expect(kept[0]?.runId).toBe(runId(6));
  expect(kept.at(-1)?.runId).toBe(runId(MEMORY_RECORDER_LIMIT + 5));
});

test("a bound that is not a positive whole number falls back to the default", () => {
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const recorder = createMemoryEnforcementRecorder(limit);
    for (let n = 1; n <= MEMORY_RECORDER_LIMIT + 1; n += 1) {
      recorder.record(denial(n));
    }
    expect(recorder.records(), String(limit)).toHaveLength(
      MEMORY_RECORDER_LIMIT,
    );
  }
});

test("the recorder never throws, also for a record that cannot be frozen", () => {
  const recorder = createMemoryEnforcementRecorder(2);
  const refuses = new Proxy(
    { ...denial(1) },
    {
      preventExtensions: () => {
        throw new Error("trap");
      },
    },
  ) as EnforcementRecord;
  const odd: unknown[] = [refuses, null, undefined, 1, "text"];
  for (const entry of odd) {
    expect(recorder.record(entry as EnforcementRecord)).toBeUndefined();
  }
  expect(recorder.records()).toHaveLength(2);
});

const moduleFolder = path.dirname(fileURLToPath(import.meta.url));

test("the recorder logs nothing", () => {
  const source = readFileSync(
    path.join(moduleFolder, "memory-recorder.ts"),
    "utf8",
  );
  expect(source).not.toMatch(/\bconsole\.|\blog\(/);
});
