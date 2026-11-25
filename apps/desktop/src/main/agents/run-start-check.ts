// The check before a run starts (decision D13 of 2026-11-25 on #35 and #55,
// and the decision of the Project Manager of 2026-11-25 on the other
// denials): the `beforeStart` of the host run supervisor in production.
// Immediately before `queued -> running`, it asks the enforcement point
// whether the run's agent may use the run's provider connection
// (`provider.use`).
//
// - Allowed: the run starts.
// - `no_grant`: no active grant gives the agent `provider.use` on the run's
//   provider connection. The run fails at once with `provider_use_denied`
//   (D13); it does not stay queued.
// - Every other denial (`store_unusable`, `clock_invalid`, `check_failed`,
//   a denial of the sign-in such as `signed_out` or `sign_in_invalid`, a
//   malformed input) leaves the run queued (`wait`): it does not start,
//   and the supervisor checks it again after the next change of the grants
//   or the next reload of the runs. An enforcement point that throws, or
//   answers anything else than an allowed decision or a denial, counts as
//   `check_failed`, so the run waits too.
//
// Every decision that does not start names its `denial`. The supervisor
// asks the check a second time once the server acknowledged the start,
// before the executor starts; a denial then ends the running run as
// `denialEnd` says (`no_grant` is `cancelled` with `grant_inactive`).
//
// The check uses `check`, not `recheck`: nothing runs yet. The enforcement
// point records every denial; an allowed `provider.use` is not recorded.
// The request names the run's own agent and provider connection only, so
// the enforcement point decides on the run that the supervisor holds.
import type { PermissionRequest } from "@mymandev/permissions";
import {
  ENFORCEMENT_DENIAL_REASONS,
  type EnforcementDenialReason,
  type HeldRun,
  type PermissionEnforcement,
} from "../permissions/enforcement.ts";
import {
  ALLOW_RUN_START,
  HOST_RUN_REASONS,
  type RunStartDecision,
} from "./run-supervisor.ts";

/** The part of the enforcement point that the check uses. */
export type RunStartEnforcement = Pick<PermissionEnforcement, "check">;

/**
 * What a denial of `provider.use` before a start decides: `no_grant` fails
 * the run with `provider_use_denied`, and every other denial leaves it
 * queued. Both name the denial.
 */
export function startDecisionOfDenial(
  reason: EnforcementDenialReason,
): RunStartDecision {
  if (reason === "no_grant") {
    return Object.freeze({
      start: false,
      state: "failed",
      reason: HOST_RUN_REASONS.providerUseDenied,
      denial: reason,
    });
  }
  return Object.freeze({ start: "wait", denial: reason });
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
        // counts as `check_failed`.
        const given = value.reason;
        reason =
          ENFORCEMENT_DENIAL_REASONS.find((item) => item === given) ??
          "check_failed";
      }
    } catch {
      // The check could not be made.
    }
    return startDecisionOfDenial(reason);
  };
}
