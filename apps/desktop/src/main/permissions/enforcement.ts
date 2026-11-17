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
import type { DeviceSessionState } from "../session/session.ts";

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

/**
 * Receives every record. A record is frozen.
 *
 * `record` is synchronous: it returns `undefined` once it took the record,
 * and throws when it cannot. Any other result, a promise among them, counts
 * as not taken, so an allowed start of `terminal.execute` is then denied.
 */
export interface EnforcementRecorder {
  record(entry: EnforcementRecord): undefined;
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

/** An object without a prototype that holds only plain own data. */
type PlainObject = Record<string, unknown>;

/**
 * A copy of the value's own enumerable data properties, each read once, in
 * an object without a prototype, or `INVALID` when the value is not a
 * non-array object, has an accessor, or cannot be read (a revoked proxy, a
 * trap that throws). A missing field is then never filled from a prototype,
 * and the copy is what is checked. One level only; it never throws.
 */
function plainObject(value: unknown): PlainObject | typeof INVALID {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return INVALID;
    }
    const copy: PlainObject = Object.create(null);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
        return INVALID;
      }
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return INVALID;
  }
}

/**
 * The deepest object in a grant record: the record (0), the grant and the
 * facts (1), and each fact (2).
 */
const MAX_RECORD_DEPTH = 2;

/**
 * A deep copy of plain own data, as `plainObject` at every level, or
 * `INVALID` when any object in it is not plain data or is deeper than a
 * grant record. The depth bound also stops a cycle.
 */
function plainRecord(value: unknown, depth = 0): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (depth > MAX_RECORD_DEPTH) {
    return INVALID;
  }
  const copy = plainObject(value);
  if (copy === INVALID) {
    return INVALID;
  }
  for (const key of Object.keys(copy)) {
    const child = plainRecord(copy[key], depth + 1);
    if (child === INVALID) {
      return INVALID;
    }
    copy[key] = child;
  }
  return copy;
}

/**
 * Plain copies of the records of a store read, or `INVALID` when the list
 * is not an array, or its length or an element is not plain data, a hole
 * included. It never throws.
 */
function plainRecords(list: unknown): unknown[] | typeof INVALID {
  try {
    if (!Array.isArray(list)) {
      return INVALID;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(list, "length");
    const length: unknown = lengthDescriptor?.value;
    if (typeof length !== "number" || !Number.isSafeInteger(length)) {
      return INVALID;
    }
    const copies: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const element = Object.getOwnPropertyDescriptor(list, index);
      if (element === undefined || !Object.hasOwn(element, "value")) {
        return INVALID;
      }
      const copy = plainRecord(element.value);
      if (copy === INVALID) {
        return INVALID;
      }
      copies.push(copy);
    }
    return copies;
  } catch {
    return INVALID;
  }
}

/** The value as a plain copy made by `plainRecord`, or null. */
function asCopy(value: unknown): PlainObject | null {
  return typeof value === "object" && value !== null
    ? (value as PlainObject)
    : null;
}

/**
 * Whether a plain record's facts put its agent, and its provider
 * connection if it has one, on this device. `hasGrant` only checks that the
 * facts agree with each other; this binds them to this device.
 */
function hostedHere(record: unknown, device: DeviceId): boolean {
  const facts = asCopy(asCopy(record)?.facts);
  const agent = asCopy(facts?.agent);
  if (facts === null || agent === null || agent.hostDeviceId !== device) {
    return false;
  }
  const connection = facts.providerConnection;
  return connection === null || asCopy(connection)?.hostDeviceId === device;
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
  const kind = CAPABILITY_SCOPE[capability];
  let scope:
    | { repositoryId: RepositoryId }
    | {
        providerConnectionId: ProviderConnectionId;
      }
    | null;
  switch (kind) {
    case "repository":
      scope =
        run.repositoryId === null ? null : { repositoryId: run.repositoryId };
      break;
    case "provider_connection":
      scope =
        run.providerConnectionId === null
          ? null
          : { providerConnectionId: run.providerConnectionId };
      break;
    default: {
      // A new scope kind does not compile until it is handled here.
      const unknownKind: never = kind;
      return unknownKind;
    }
  }
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
 * The signed-in account of this device as a plain copy, or the denial
 * reason. The state and the account are each read once, as plain own data.
 * Only `signed_in` for this device passes; the expiry is checked against
 * the clock later.
 */
function signedInAccount(
  state: unknown,
  device: DeviceId,
): PlainObject | EnforcementDenialReason {
  const plainState = plainObject(state);
  if (plainState === INVALID) {
    return "sign_in_invalid";
  }
  if (plainState.kind === "signed_out" || plainState.signedOut === true) {
    return "signed_out";
  }
  if (plainState.kind !== "signed_in") {
    return "sign_in_invalid";
  }
  const account = plainObject(plainState.account);
  if (account === INVALID || account.deviceId !== device) {
    return "sign_in_invalid";
  }
  return account;
}

/**
 * Handles the rejection of a thenable, so that a recorder that returned a
 * promise leaves no unhandled rejection. It never throws.
 */
function settleQuietly(value: unknown): void {
  attempt(() => {
    if (
      (typeof value === "object" && value !== null) ||
      typeof value === "function"
    ) {
      const then: unknown = (value as { then?: unknown }).then;
      if (typeof then === "function") {
        then.call(value, undefined, () => undefined);
      }
    }
  });
}

/**
 * Creates the enforcement point. The dependencies are taken once, here, so
 * that changing the object afterwards changes nothing.
 */
export function createPermissionEnforcement(
  dependencies: PermissionEnforcementDependencies,
): PermissionEnforcement {
  const { now, grantStore, sessionState, thisDevice, recorder } = dependencies;

  /**
   * Passes a frozen record to the recorder. True only when the recorder
   * returned `undefined`; a promise or any other result is not taken.
   */
  function record(entry: EnforcementRecord): boolean {
    const result: unknown = attempt(() =>
      recorder.record(Object.freeze(entry)),
    );
    if (result === undefined) {
      return true;
    }
    settleQuietly(result);
    return false;
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
      // A denial that the recorder does not take is dropped; it still denies.
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
      // Only the parsed copy of the run is used from here on.
      const plainRun = plainObject(heldRun);
      const parsedRun =
        plainRun === INVALID
          ? INVALID
          : attempt(() => HeldRunSchema.safeParse(plainRun));
      if (parsedRun === INVALID || !parsedRun.success) {
        return deny("run_invalid");
      }
      run = parsedRun.data;

      const plain = plainObject(request);
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
          ? "sign_in_invalid"
          : signedInAccount(state, device.data);
      if (typeof account === "string") {
        return deny(account);
      }
      const signInExpiresAt = attempt(() =>
        UtcTimestampSchema.safeParse(account.signInExpiresAt),
      );

      // One read of the store per check, read as plain own data.
      const answer = plainObject(attempt(() => grantStore.read()));
      if (answer === INVALID || answer.usable !== true) {
        return deny("store_unusable");
      }
      const records = plainRecords(answer.records);
      if (records === INVALID) {
        return deny("store_unusable");
      }
      // Only records whose facts put the agent on this device count.
      const hostedRecords = records.filter((entry) =>
        hostedHere(entry, device.data),
      );

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

      // `hasGrant` parses every record; the copies are plain data.
      if (
        !hasGrant(
          hostedRecords as readonly unknown[] as readonly GrantRecord[],
          checked,
          decisionTime,
        )
      ) {
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
      // Not reachable: every dependency call and every read of an input is
      // wrapped above. It stays so that a future change fails closed.
      return deny("check_failed");
    }
  }

  return Object.freeze({ check });
}
