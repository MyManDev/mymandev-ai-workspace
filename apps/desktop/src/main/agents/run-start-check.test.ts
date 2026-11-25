import {
  RUN_CANCEL_REASONS,
  type AgentId,
  type DeviceId,
  type ProviderConnectionId,
  type RepositoryId,
  type RunId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import {
  ENFORCEMENT_DENIAL_REASONS,
  type EnforcementDecision,
  type EnforcementDenialReason,
  type HeldRun,
} from "../permissions/enforcement.ts";
import { RUN_EXECUTOR_REASON_PATTERN } from "./run-executor.ts";
import {
  createProviderUseStartCheck,
  startDecisionOfDenial,
} from "./run-start-check.ts";
import {
  ALLOW_RUN_START,
  denialEnd,
  HOST_RUN_REASONS,
} from "./run-supervisor.ts";

const RUN: HeldRun = Object.freeze({
  runId: "0192f0a0-7b3c-7d4e-8f50-000000000001" as RunId,
  agentId: "0192f0a0-7b3c-7d4e-8f50-000000000002" as AgentId,
  hostDeviceId: "0192f0a0-7b3c-7d4e-8f50-000000000004" as DeviceId,
  repositoryId: "0192f0a0-7b3c-7d4e-8f50-000000000009" as RepositoryId,
  providerConnectionId:
    "0192f0a0-7b3c-7d4e-8f50-00000000000b" as ProviderConnectionId,
});

/** A fake enforcement point that answers `answer` and records each call. */
function fakeEnforcement(answer: () => unknown) {
  const calls: { run: HeldRun; request: unknown }[] = [];
  return {
    calls,
    enforcement: {
      check: (run: HeldRun, request: unknown): EnforcementDecision => {
        calls.push({ run, request });
        return answer() as EnforcementDecision;
      },
    },
  };
}

test("every denial before a start maps to its end, and no_grant fails the run with provider_use_denied", () => {
  const cases: [EnforcementDenialReason, "failed" | "cancelled", string][] = [
    ["no_grant", "failed", HOST_RUN_REASONS.providerUseDenied],
    ["signed_out", "cancelled", HOST_RUN_REASONS.signedOut],
    ["sign_in_invalid", "cancelled", HOST_RUN_REASONS.signedOut],
    ["device_unknown", "cancelled", HOST_RUN_REASONS.signedOut],
    ["not_this_device", "cancelled", HOST_RUN_REASONS.signedOut],
    ["store_unusable", "failed", HOST_RUN_REASONS.grantCheckUnavailable],
    ["clock_invalid", "failed", HOST_RUN_REASONS.grantCheckUnavailable],
    ["record_failed", "failed", HOST_RUN_REASONS.grantCheckUnavailable],
    ["check_failed", "failed", HOST_RUN_REASONS.grantCheckUnavailable],
    ["run_invalid", "failed", HOST_RUN_REASONS.grantCheckUnavailable],
    ["request_invalid", "failed", HOST_RUN_REASONS.grantCheckUnavailable],
    ["no_scope", "failed", HOST_RUN_REASONS.grantCheckUnavailable],
    ["request_mismatch", "failed", HOST_RUN_REASONS.grantCheckUnavailable],
  ];
  expect(new Set(cases.map(([reason]) => reason))).toEqual(
    new Set(ENFORCEMENT_DENIAL_REASONS),
  );
  for (const [reason, state, sent] of cases) {
    const decision = startDecisionOfDenial(reason);
    expect(decision, reason).toEqual({ start: false, state, reason: sent });
    expect(Object.isFrozen(decision), reason).toBe(true);
    // The same mapping as a re-check, except for no_grant.
    if (reason !== "no_grant") {
      expect(decision, reason).toEqual({ start: false, ...denialEnd(reason) });
    }
  }
  // A re-check of a held action still reports a lost grant as inactive.
  expect(denialEnd("no_grant")).toEqual({
    state: "cancelled",
    reason: HOST_RUN_REASONS.grantInactive,
  });
});

test("provider_use_denied passes the supervisor's reason rules and is no server code", () => {
  const reason = HOST_RUN_REASONS.providerUseDenied;
  expect(reason).toBe("provider_use_denied");
  expect(RUN_EXECUTOR_REASON_PATTERN.test(reason)).toBe(true);
  expect(RUN_CANCEL_REASONS as readonly string[]).not.toContain(reason);
});

test("the check asks the enforcement point for provider.use of the run's agent on the run's provider connection", () => {
  const { calls, enforcement } = fakeEnforcement(() => ({
    allowed: true,
    request: {},
  }));
  const check = createProviderUseStartCheck(enforcement);

  expect(check(RUN)).toBe(ALLOW_RUN_START);
  expect(calls).toEqual([
    {
      run: RUN,
      request: {
        agentId: RUN.agentId,
        capability: "provider.use",
        providerConnectionId: RUN.providerConnectionId,
      },
    },
  ]);
  expect(calls[0]?.run).toBe(RUN);

  // A run without a provider connection asks without a scope, which the
  // enforcement point denies.
  check({ ...RUN, providerConnectionId: null });
  expect(calls[1]?.request).toEqual({
    agentId: RUN.agentId,
    capability: "provider.use",
  });
});

test("each denial of the enforcement point ends the run before it starts", () => {
  for (const reason of ENFORCEMENT_DENIAL_REASONS) {
    const { enforcement } = fakeEnforcement(() => ({
      allowed: false,
      reason,
    }));
    expect(createProviderUseStartCheck(enforcement)(RUN), reason).toEqual(
      startDecisionOfDenial(reason),
    );
  }
});

test("an enforcement point that throws or answers no decision counts as a check that failed, and the check never throws", () => {
  const failed = {
    start: false,
    state: "failed",
    reason: HOST_RUN_REASONS.grantCheckUnavailable,
  };
  const answers: (() => unknown)[] = [
    () => {
      throw new Error("broken");
    },
    () => null,
    () => undefined,
    () => "allowed",
    () => ({ allowed: "true" }),
    () => ({ allowed: false }),
    () => ({ allowed: false, reason: 7 }),
    // A reason outside the list is a check that failed, never a start.
    () => ({ allowed: false, reason: "something_else" }),
    () =>
      new Proxy(
        {},
        {
          get: () => {
            throw new Error("trap");
          },
        },
      ),
  ];
  for (const [index, answer] of answers.entries()) {
    const { enforcement } = fakeEnforcement(answer);
    expect(
      createProviderUseStartCheck(enforcement)(RUN),
      `answer ${String(index)}`,
    ).toEqual(failed);
  }
  // A run that throws when it is read.
  const { enforcement } = fakeEnforcement(() => ({ allowed: true }));
  const broken = new Proxy(RUN, {
    get: () => {
      throw new Error("trap");
    },
  });
  expect(createProviderUseStartCheck(enforcement)(broken)).toEqual(failed);
});
