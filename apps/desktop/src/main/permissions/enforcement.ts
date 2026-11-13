// The permission enforcement point of the main process (#55, ADR 0015,
// "Rules for the enforcement point"). This is its core: one synchronous
// check that every later tool call and process start of an agent passes
// through, immediately before it acts.
//
// The check owns every input of the decision. The agent and the scope come
// from the run that the caller holds, the grant records from one read of
// the injected grant store, the time from the injected clock, read on every
// call, and the session and this device's identity from their injected
// readers. The request only names the capability: its agent and scope must
// equal the run's, or the check denies. Nothing is cached, and nothing is
// kept between calls.
//
// Every denial, and every allowed start of `terminal.execute`, is passed to
// the injected recorder. A record holds IDs, a capability name, a reason
// from a closed list, and a time, never a path, a command, or a value that
// the requester sent.
//
// Not in this module: the grant store's real source (#75), the freshness
// bound of locally held facts (P-76), the wiring into the main process and
// the IPC, and stopping work that runs when a grant becomes inactive or the
// sign-in ends.
import {
  AgentIdSchema,
  type AgentId,
  type Capability,
  DeviceIdSchema,
  type DeviceId,
  ProviderConnectionIdSchema,
  type ProviderConnectionId,
  RepositoryIdSchema,
  type RepositoryId,
  RunIdSchema,
  type RunId,
  UtcTimestampSchema,
} from "@mymandev/protocol";
import {
  CAPABILITY_SCOPE,
  type GrantRecord,
  hasGrant,
  type PermissionRequest,
  PermissionRequestSchema,
} from "@mymandev/permissions";
import * as z from "zod";
import type { DeviceSessionState, SessionAccount } from "../session/session.ts";

/**
 * Why a check denied, a closed list:
 *
 * - `run_invalid`: the run that the caller passed is malformed.
 * - `request_invalid`: the request does not parse with
 *   `PermissionRequestSchema`, or it is not plain data.
 * - `no_scope`: the run has no scope of the capability's kind, for example
 *   `terminal.execute` in a run without a repository.
 * - `request_mismatch`: the request names another agent or another scope
 *   than the run.
 * - `device_unknown`: this device's identity is not known.
 * - `not_this_device`: the run's agent is hosted on another device.
 * - `signed_out`: the person signed out on this device (P-65).
 * - `sign_in_invalid`: the device is not signed in for another reason, the
 *   session names another device, or the sign-in has expired.
 * - `store_unusable`: the grant store cannot give one consistent read.
 * - `clock_invalid`: the clock gave no valid time.
 * - `no_grant`: no active grant gives exactly this capability to the agent
 *   on exactly this scope (`hasGrant`).
 * - `record_failed`: an allowed start of `terminal.execute` could not be
 *   recorded.
 * - `check_failed`: the check failed in another way.
 */
export const ENFORCEMENT_DENIAL_REASONS = Object.freeze([
  "run_invalid",
  "request_invalid",
  "no_scope",
  "request_mismatch",
  "device_unknown",
  "not_this_device",
  "signed_out",
  "sign_in_invalid",
  "store_unusable",
  "clock_invalid",
  "no_grant",
  "record_failed",
  "check_failed",
] as const);
export type EnforcementDenialReason =
  (typeof ENFORCEMENT_DENIAL_REASONS)[number];

/**
 * The run that the caller holds, as the caller knows it: never from the
 * requester, a message between processes, or the network.
 *
 * - `hostDeviceId`: the host device of the run's agent.
 * - `repositoryId`: the run's repository, or null for a run without one.
 * - `providerConnectionId`: the provider connection that the run uses, or
 *   null. The caller resolves it only from this device's own store
 *   (ADR 0015, P-82).
 */
export interface HeldRun {
  readonly runId: RunId;
  readonly agentId: AgentId;
  readonly hostDeviceId: DeviceId;
  readonly repositoryId: RepositoryId | null;
  readonly providerConnectionId: ProviderConnectionId | null;
}

const HeldRunSchema = z.object({
  runId: RunIdSchema,
  agentId: AgentIdSchema,
  hostDeviceId: DeviceIdSchema,
  repositoryId: RepositoryIdSchema.nullable(),
  providerConnectionId: ProviderConnectionIdSchema.nullable(),
});

/**
 * One read of the grant store. `usable` is true only when `records` is one
 * consistent read of the store (ADR 0015, P-76); an unusable read carries
 * no records.
 */
export interface GrantStoreRead {
  readonly usable: boolean;
  readonly records: readonly GrantRecord[];
}

/** The grant store of this device. The check reads it at most once. */
export interface GrantStore {
  read(): GrantStoreRead;
}

/** A denied check. */
export interface DenialRecord {
  readonly kind: "denied";
  readonly reason: EnforcementDenialReason;
  /** The requested capability, or null when the request is malformed. */
  readonly capability: Capability | null;
  /** The run's IDs, or null when the run is malformed. */
  readonly runId: RunId | null;
  readonly agentId: AgentId | null;
  readonly repositoryId: RepositoryId | null;
  readonly providerConnectionId: ProviderConnectionId | null;
  /** The time of the check, or null when the clock gave no valid time. */
  readonly at: string | null;
}

/** An allowed start of `terminal.execute` (ADR 0015, P-70). */
export interface ShellStartRecord {
  readonly kind: "shell_start_allowed";
  readonly runId: RunId;
  readonly agentId: AgentId;
  readonly repositoryId: RepositoryId;
  /** The time that the check used. */
  readonly at: string;
}

/** What the check records: IDs, closed vocabularies, and times only. */
export type EnforcementRecord = DenialRecord | ShellStartRecord;

/** Receives every record. A record is frozen. */
export interface EnforcementRecorder {
  record(entry: EnforcementRecord): void;
}

export interface PermissionEnforcementDependencies {
  /** The wall clock, read on every check. */
  readonly now: () => Date;
  readonly grantStore: GrantStore;
  /** The current state of the device session. */
  readonly sessionState: () => DeviceSessionState;
  /** The ID of this device, or null when it is not known. */
  readonly thisDevice: () => DeviceId | null;
  readonly recorder: EnforcementRecorder;
}

/**
 * The decision of one check. An allowed decision carries the request that
 * was checked, built from the run: act only on it, never on the raw
 * request. A denial stops the action; never retry with a looser request.
 */
export type EnforcementDecision =
  | { readonly allowed: true; readonly request: PermissionRequest }
  | { readonly allowed: false; readonly reason: EnforcementDenialReason };

export interface PermissionEnforcement {
  /**
   * Checks one request of the run's agent immediately before the action or
   * process start. It never throws: every failure denies.
   */
  check(run: HeldRun, request: unknown): EnforcementDecision;
}

/** Marks a value that could not be read or is not valid. */
const INVALID: unique symbol = Symbol("invalid");

/** `fn()`, or `INVALID` when it throws. */
function attempt<T>(fn: () => T): T | typeof INVALID {
  try {
    return fn();
  } catch {
    return INVALID;
  }
}

/**
 * A copy of the request's own enumerable data properties in an object
 * without a prototype, or `INVALID` when the request is not an object or
 * has an accessor. A missing field is then never filled from a prototype.
 * The request schema is flat, so one level is enough.
 */
function plainRequest(request: unknown): object | typeof INVALID {
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    return INVALID;
  }
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(request)) {
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      return INVALID;
    }
    copy[key] = descriptor.value;
  }
  return copy;
}

/** The time in milliseconds of a genuine, valid Date, or `INVALID`. */
function validTime(now: unknown): number | typeof INVALID {
  const ms = attempt(() => Date.prototype.getTime.call(now));
  return typeof ms === "number" && Number.isFinite(ms) ? ms : INVALID;
}

/**
 * The request that the check decides on: the run's agent, the capability,
 * and the run's scope of the capability's kind. Null when the run has no
 * such scope.
 */
function runRequest(
  run: HeldRun,
  capability: Capability,
): PermissionRequest | null {
  const scope =
    CAPABILITY_SCOPE[capability] === "repository"
      ? run.repositoryId === null
        ? null
        : { repositoryId: run.repositoryId }
      : run.providerConnectionId === null
        ? null
        : { providerConnectionId: run.providerConnectionId };
  if (scope === null) {
    return null;
  }
  const parsed = PermissionRequestSchema.safeParse({
    agentId: run.agentId,
    capability,
    ...scope,
  });
  return parsed.success ? parsed.data : null;
}

/** Whether the parsed request names the same agent and scope as `checked`. */
function sameRequest(
  parsed: PermissionRequest,
  checked: PermissionRequest,
): boolean {
  if (parsed.agentId !== checked.agentId) {
    return false;
  }
  if ("repositoryId" in checked) {
    return (
      "repositoryId" in parsed && parsed.repositoryId === checked.repositoryId
    );
  }
  return (
    "providerConnectionId" in parsed &&
    parsed.providerConnectionId === checked.providerConnectionId
  );
}

/**
 * The signed-in account of this device, or the denial reason. Only
 * `signed_in` for this device passes; the expiry is checked against the
 * clock later.
 */
function signedInAccount(
  state: DeviceSessionState,
  device: DeviceId,
): SessionAccount | EnforcementDenialReason {
  if (
    state.kind === "signed_out" ||
    ("signedOut" in state && state.signedOut === true)
  ) {
    return "signed_out";
  }
  if (state.kind !== "signed_in" || state.account.deviceId !== device) {
    return "sign_in_invalid";
  }
  return state.account;
}

/**
 * Creates the enforcement point. The dependencies are taken once, here, so
 * that changing the object afterwards changes nothing.
 */
export function createPermissionEnforcement(
  dependencies: PermissionEnforcementDependencies,
): PermissionEnforcement {
  const { now, grantStore, sessionState, thisDevice, recorder } = dependencies;

  /** Passes a frozen record to the recorder; true when it took it. */
  function record(entry: EnforcementRecord): boolean {
    return attempt(() => recorder.record(Object.freeze(entry))) !== INVALID;
  }

  /** The time as an ISO string, read from the clock now, or null. */
  function timeNow(): string | null {
    const ms = validTime(attempt(now));
    return ms === INVALID ? null : new Date(ms).toISOString();
  }

  function check(heldRun: HeldRun, request: unknown): EnforcementDecision {
    // Each step below names what it learned, so that the denial record holds
    // what is known and nothing that the requester sent.
    let run: HeldRun | null = null;
    let capability: Capability | null = null;
    // The time of the decision, once the clock was read for it.
    let at: string | null | undefined;

    const deny = (reason: EnforcementDenialReason): EnforcementDecision => {
      record({
        kind: "denied",
        reason,
        capability,
        runId: run?.runId ?? null,
        agentId: run?.agentId ?? null,
        repositoryId: run?.repositoryId ?? null,
        providerConnectionId: run?.providerConnectionId ?? null,
        // The clock is read once per check: here only when the check did not
        // read it yet.
        at: at === undefined ? timeNow() : at,
      });
      return Object.freeze({ allowed: false, reason });
    };

    try {
      const parsedRun = attempt(() => HeldRunSchema.safeParse(heldRun));
      if (parsedRun === INVALID || !parsedRun.success) {
        return deny("run_invalid");
      }
      run = parsedRun.data;

      const plain = plainRequest(request);
      const parsedRequest =
        plain === INVALID
          ? INVALID
          : attempt(() => PermissionRequestSchema.safeParse(plain));
      if (parsedRequest === INVALID || !parsedRequest.success) {
        return deny("request_invalid");
      }
      capability = parsedRequest.data.capability;

      // The agent and the scope come from the run, never from the request.
      const checked = runRequest(run, capability);
      if (checked === null) {
        return deny("no_scope");
      }
      if (!sameRequest(parsedRequest.data, checked)) {
        return deny("request_mismatch");
      }

      const device = attempt(() => DeviceIdSchema.safeParse(thisDevice()));
      if (device === INVALID || !device.success) {
        return deny("device_unknown");
      }
      if (run.hostDeviceId !== device.data) {
        return deny("not_this_device");
      }

      const state = attempt(sessionState);
      const account =
        state === INVALID
          ? INVALID
          : attempt(() => signedInAccount(state, device.data));
      if (account === INVALID) {
        return deny("sign_in_invalid");
      }
      if (typeof account === "string") {
        return deny(account);
      }
      const signInExpiresAt = attempt(() =>
        UtcTimestampSchema.safeParse(account.signInExpiresAt),
      );

      // One read of the store per check.
      const read = attempt(() => {
        const answer = grantStore.read();
        const { usable, records } = answer;
        return { usable, records };
      });
      if (read === INVALID || read.usable !== true) {
        return deny("store_unusable");
      }

      // The clock, read immediately before `hasGrant`.
      const nowMs = validTime(attempt(now));
      if (nowMs === INVALID) {
        at = null;
        return deny("clock_invalid");
      }
      const decisionTime = new Date(nowMs);
      at = decisionTime.toISOString();

      // Expiry is half-open, as for grants: at the end, the sign-in is over.
      if (
        signInExpiresAt === INVALID ||
        !signInExpiresAt.success ||
        !(nowMs < Date.parse(signInExpiresAt.data))
      ) {
        return deny("sign_in_invalid");
      }

      if (!hasGrant(read.records, checked, decisionTime)) {
        return deny("no_grant");
      }

      if (checked.capability === "terminal.execute") {
        const recorded = record({
          kind: "shell_start_allowed",
          runId: run.runId,
          agentId: run.agentId,
          repositoryId: checked.repositoryId,
          at,
        });
        if (!recorded) {
          return deny("record_failed");
        }
      }
      return Object.freeze({
        allowed: true,
        request: Object.freeze(checked),
      });
    } catch {
      return deny("check_failed");
    }
  }

  return Object.freeze({ check });
}
