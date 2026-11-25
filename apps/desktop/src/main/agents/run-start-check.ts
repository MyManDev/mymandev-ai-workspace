// The check before a run starts (decision D13 of 2026-11-25 on #35 and #55):
// the `beforeStart` of the host run supervisor in production. Immediately
// before `queued -> running`, it asks the enforcement point whether the
// run's agent may use the run's provider connection (`provider.use`).
//
// - Allowed: the run starts.
// - `no_grant`: no active grant gives the agent `provider.use` on the run's
//   provider connection. The run fails at once with `provider_use_denied`;
//   it does not stay queued.
// - Every other denial ends the run as the supervisor's re-checks do
//   (`denialEnd`): a denial of the sign-in is `cancelled` with
//   `signed_out`, and a check that cannot be made (`store_unusable`,
//   `clock_invalid`, `check_failed`, a malformed input) is `failed` with
//   `grant_check_unavailable`. An enforcement point that throws, or answers
//   anything else than an allowed decision or a denial, counts as
//   `check_failed`.
//
// The check uses `check`, not `recheck`: nothing runs yet. The enforcement
// point records every denial; an allowed `provider.use` is not recorded.
// The request names the run's own agent and provider connection only, so
// the enforcement point decides on the run that the supervisor holds.
import type { PermissionRequest } from "@mymandev/permissions";
import type {
  EnforcementDenialReason,
  HeldRun,
  PermissionEnforcement,
} from "../permissions/enforcement.ts";
import {
  ALLOW_RUN_START,
  denialEnd,
  HOST_RUN_REASONS,
  type RunStartDecision,
} from "./run-supervisor.ts";

/** The part of the enforcement point that the check uses. */
export type RunStartEnforcement = Pick<PermissionEnforcement, "check">;

/**
 * How a denial of `provider.use` before a start ends the run: `no_grant`
 * fails it with `provider_use_denied`, and every other denial ends it as
 * `denialEnd` says.
 */
export function startDecisionOfDenial(
  reason: EnforcementDenialReason,
): RunStartDecision {
  if (reason === "no_grant") {
    return Object.freeze({
      start: false,
      state: "failed",
      reason: HOST_RUN_REASONS.providerUseDenied,
    });
  }
  const end = denialEnd(reason);
  return Object.freeze({ start: false, state: end.state, reason: end.reason });
}

/**
 * The `provider.use` request of the run's agent on the run's provider
 * connection. A run without one gets a request without a scope, which the
 * enforcement point denies.
 */
function providerUseRequest(run: HeldRun): Record<string, unknown> {
  return {
    agentId: run.agentId,
    capability: "provider.use" satisfies PermissionRequest["capability"],
    ...(run.providerConnectionId === null
      ? {}
      : { providerConnectionId: run.providerConnectionId }),
  };
}

/**
 * Creates the `beforeStart` of the host run supervisor that checks
 * `provider.use` with `enforcement`. It never throws.
 */
export function createProviderUseStartCheck(
  enforcement: RunStartEnforcement,
): (run: HeldRun) => RunStartDecision {
  return (run: HeldRun): RunStartDecision => {
    let reason: EnforcementDenialReason = "check_failed";
    try {
      const decision: unknown = enforcement.check(run, providerUseRequest(run));
      if (typeof decision === "object" && decision !== null) {
        const value = decision as { allowed?: unknown; reason?: unknown };
        if (value.allowed === true) {
          return ALLOW_RUN_START;
        }
        // Any other answer is a denial. A reason outside the list, or none,
        // ends as `grant_check_unavailable` (`denialEnd`).
        reason = value.reason as EnforcementDenialReason;
      }
    } catch {
      // The check could not be made.
    }
    return startDecisionOfDenial(reason);
  };
}
