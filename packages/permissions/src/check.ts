import {
  GrantRecordSchema,
  PermissionRequestSchema,
  type GrantRecord,
  type PermissionGrant,
  type PermissionRequest,
} from "./grant.ts";

// The checks read no clock, no database and no environment. They never throw:
// malformed input is denied.

/** Marks input that is not plain data. */
const NOT_PLAIN_DATA: unique symbol = Symbol("not plain data");

/** The largest length of a JavaScript array. */
const MAX_ARRAY_LENGTH = 2 ** 32 - 1;

/**
 * A copy of `value` that holds only its own enumerable data properties, each
 * read once, in objects without a prototype. Parsing this copy means that a
 * missing field is never filled from a prototype, and that the value that is
 * validated is the value that is compared. An accessor, or a cycle through
 * objects, makes the whole value not plain data. An object that is referenced
 * more than once in `value` is copied once, so the copy grows with the number
 * of objects, not with the number of paths. Primitives and arrays are returned
 * as they are and arrays are not traversed: the schemas accept no array, so
 * an array is rejected where a field is expected and stripped where it is
 * unknown.
 */
function plainData(value: unknown): unknown {
  return copyPlainData(value, new Map(), new Set());
}

/**
 * `copies` holds the objects that are already copied, and `open` the objects
 * whose copy is not finished, so that reaching one of them again is a cycle.
 */
function copyPlainData(
  value: unknown,
  copies: Map<object, unknown>,
  open: Set<object>,
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  if (open.has(value)) {
    return NOT_PLAIN_DATA;
  }
  if (copies.has(value)) {
    return copies.get(value);
  }
  open.add(value);
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      return NOT_PLAIN_DATA;
    }
    const child = copyPlainData(descriptor.value, copies, open);
    if (child === NOT_PLAIN_DATA) {
      return NOT_PLAIN_DATA;
    }
    copy[key] = child;
  }
  open.delete(value);
  copies.set(value, copy);
  return copy;
}

/**
 * The time in milliseconds, or null unless `now` is a valid Date. Any genuine
 * Date is accepted, from any JavaScript realm. Its own time value is read, not
 * an overridable `getTime` method, so an object that only inherits from
 * `Date.prototype` or wraps a Date in a Proxy is rejected.
 */
function validNow(now: unknown): number | null {
  try {
    const ms = Date.prototype.getTime.call(now);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * The length of the list, read once from its own data property, or null
 * unless it is a valid array length.
 */
function listLength(list: readonly unknown[]): number | null {
  const descriptor = Object.getOwnPropertyDescriptor(list, "length");
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
    return null;
  }
  const length: unknown = descriptor.value;
  return typeof length === "number" &&
    Number.isSafeInteger(length) &&
    length >= 0 &&
    length <= MAX_ARRAY_LENGTH
    ? length
    : null;
}

/**
 * A parsed copy of the plain data of the record, or null when it is malformed
 * or reading it throws.
 */
function parseRecord(record: unknown): GrantRecord | null {
  try {
    const result = GrantRecordSchema.safeParse(plainData(record));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Whether a parsed record is active at `nowMs`. Every condition is written
 * affirmatively, so a value that cannot be compared denies. Any lifecycle
 * timestamp that is set means inactive, whatever its value. `createdAt` is
 * never compared with the time: there is no not-before check.
 */
function active(record: GrantRecord, nowMs: number): boolean {
  const { grant, facts } = record;
  const membership = facts.grantorMembership;
  return (
    grant.revokedAt === null &&
    (grant.expiresAt === null || nowMs < Date.parse(grant.expiresAt)) &&
    facts.agent.id === grant.granteeAgentId &&
    facts.agent.disabledAt === null &&
    facts.hostDevice.id === facts.agent.hostDeviceId &&
    facts.hostDevice.revokedAt === null &&
    facts.project.id === grant.projectId &&
    membership !== null &&
    membership.workspaceId === facts.project.workspaceId &&
    membership.userId === grant.grantedByUserId &&
    membership.removedAt === null
  );
}

/**
 * Whether the grant names the scope of the request: the same kind and the
 * same ID. Only own properties count, so a scope key inherited from a
 * polluted `Object.prototype` never matches.
 */
function sameScope(
  grant: PermissionGrant,
  request: PermissionRequest,
): boolean {
  if (
    "repositoryId" in grant &&
    "repositoryId" in request &&
    Object.hasOwn(grant, "repositoryId") &&
    Object.hasOwn(request, "repositoryId")
  ) {
    return grant.repositoryId === request.repositoryId;
  }
  if (
    "providerConnectionId" in grant &&
    "providerConnectionId" in request &&
    Object.hasOwn(grant, "providerConnectionId") &&
    Object.hasOwn(request, "providerConnectionId")
  ) {
    return grant.providerConnectionId === request.providerConnectionId;
  }
  return false;
}

/**
 * The single definition of an active grant (ADR 0008, ADR 0015). A grant is
 * active at `now` when it is not revoked, it has not expired (`now` is before
 * `expiresAt`), its agent is not disabled, the agent's host device is not
 * revoked, and the granting user is still a member of the workspace of the
 * grant's project. Each fact must describe the entity the grant names. No
 * other code combines these columns.
 *
 * Use it for display and listing; authorize with `hasGrant`. It never throws.
 * Malformed data, data that is not plain (an accessor, a cycle through
 * objects, or a field inherited from a prototype), and an invalid `now` are
 * inactive.
 */
export function isGrantActive(record: GrantRecord, now: Date): boolean {
  const nowMs = validNow(now);
  if (nowMs === null) {
    return false;
  }
  const parsed = parseRecord(record);
  return parsed !== null && active(parsed, nowMs);
}

/**
 * The only authorization check (ADR 0008, ADR 0015). It returns true only
 * when one record is active at `now` and grants exactly the requested
 * capability to the requesting agent on exactly the requested scope. An
 * absent grant is denied. Nothing is inferred from `terminal.execute` or from
 * any other capability: there is no wildcard, hierarchy or implication.
 *
 * The records come from one consistent read (ADR 0015, P-76). It never throws
 * and never mutates its inputs. A malformed request, an invalid `now`, a list
 * that is not an array, and a list whose length or elements cannot be read
 * are denied. A malformed record is skipped: it never grants, and it does not
 * stop another record from granting. The request and the records are read as
 * plain data. The list's length is read once from its own data, and each
 * element once through its own descriptor, so a hole or an accessor in the
 * list is skipped and never read through a prototype. The decision uses the
 * validated copies.
 */
export function hasGrant(
  records: readonly GrantRecord[],
  request: PermissionRequest,
  now: Date,
): boolean {
  try {
    const nowMs = validNow(now);
    if (nowMs === null || !Array.isArray(records)) {
      return false;
    }
    const length = listLength(records);
    if (length === null) {
      return false;
    }
    const parsedRequest = PermissionRequestSchema.safeParse(plainData(request));
    if (!parsedRequest.success) {
      return false;
    }
    const wanted = parsedRequest.data;
    for (let index = 0; index < length; index += 1) {
      const element = Object.getOwnPropertyDescriptor(records, index);
      if (element === undefined || !Object.hasOwn(element, "value")) {
        continue;
      }
      const parsed = parseRecord(element.value);
      if (
        parsed !== null &&
        parsed.grant.granteeAgentId === wanted.agentId &&
        parsed.grant.capability === wanted.capability &&
        sameScope(parsed.grant, wanted) &&
        active(parsed, nowMs)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
