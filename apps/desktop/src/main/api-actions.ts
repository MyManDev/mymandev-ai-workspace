// The writes of the workspace screens of #95 that the main process may send
// to the API (the Project Manager's decision D1 of 2026-11-06): a frozen
// allowlist of `POST` routes, each with its path parameters, the protocol's
// request schema or none, and the protocol's answer schema or `empty` for a
// `204`. The account service sends them with the device session
// (`sendWorkspaceAction`); no IPC channel and no bridge member reach them
// yet, and each action gets its own strict channel later. The device actions
// are not here: they become fixed functions of the session, as sign-out and
// removal are.
//
// D2: an invitation code travels only in the body of a preview or an accept,
// as the text that the person pasted, and in the answer of a create, which
// goes back to the caller once. Nothing here keeps, logs, or repeats it: a
// refusal names a fixed reason only.
import {
  type AcceptInvitationRequest,
  AcceptInvitationRequestSchema,
  type AcceptInvitationResponse,
  AcceptInvitationResponseSchema,
  type ApiErrorCode,
  type ApiRoute,
  type ApproveJoinRequestRequest,
  ApproveJoinRequestRequestSchema,
  type ApproveJoinRequestResponse,
  ApproveJoinRequestResponseSchema,
  type CreateInvitationRequest,
  CreateInvitationRequestSchema,
  type CreateInvitationResponse,
  CreateInvitationResponseSchema,
  type CreateJoinRequestRequest,
  CreateJoinRequestRequestSchema,
  type CreateJoinRequestResponse,
  CreateJoinRequestResponseSchema,
  CreateProjectRequestSchema,
  type CreateProjectResponse,
  CreateProjectResponseSchema,
  type CreateWorkspaceRequest,
  CreateWorkspaceRequestSchema,
  type CreateWorkspaceResponse,
  CreateWorkspaceResponseSchema,
  type DefineMemberRequest,
  DefineMemberRequestSchema,
  type DefineMemberResponse,
  DefineMemberResponseSchema,
  type InvitationId,
  InvitationIdSchema,
  type JoinRequestId,
  JoinRequestIdSchema,
  MEMBERSHIP_ROUTES,
  type MemberId,
  MemberIdSchema,
  type OfferOwnershipRequest,
  OfferOwnershipRequestSchema,
  type PreviewInvitationRequest,
  PreviewInvitationRequestSchema,
  type PreviewInvitationResponse,
  PreviewInvitationResponseSchema,
  PROJECT_ROUTES,
  type RenameMemberRequest,
  RenameMemberRequestSchema,
  type WorkspaceId,
  WorkspaceIdSchema,
} from "@mymandev/protocol";
import type * as z from "zod";
import type { AuthorizedRequest, SessionFailure } from "./session/session.ts";

/**
 * The schema of each path parameter: every one is an ID, checked as a
 * lowercase UUIDv7 before it enters a path.
 */
const PATH_PARAMS = Object.freeze({
  workspaceId: WorkspaceIdSchema,
  memberId: MemberIdSchema,
  invitationId: InvitationIdSchema,
  joinRequestId: JoinRequestIdSchema,
});
export type WorkspaceActionParam = keyof typeof PATH_PARAMS;

interface WorkspaceAction {
  readonly route: ApiRoute;
  /** The names of the route's path parameters, in order. */
  readonly params: readonly WorkspaceActionParam[];
  /** The protocol's request schema, or null for a route without a body. */
  readonly body: z.ZodType | null;
  /** The schema of the `200` answer, or `empty` for a `204` without a body. */
  readonly answer: z.ZodType | "empty";
}

function action(
  route: ApiRoute,
  params: readonly WorkspaceActionParam[],
  body: z.ZodType | null,
  answer: z.ZodType | "empty",
): WorkspaceAction {
  return Object.freeze({
    route,
    params: Object.freeze([...params]),
    body,
    answer,
  });
}

const M = MEMBERSHIP_ROUTES;

/**
 * The allowlist, named as the protocol names each route. Every answer is
 * small, so the default answer cap of the session holds it. Removing a
 * person, claimed or unclaimed, is one route; the API checks who may remove
 * whom.
 */
export const WORKSPACE_ACTIONS = Object.freeze({
  /** `POST /workspaces`: creates a workspace with the caller as its owner. */
  createWorkspace: action(
    M.createWorkspace,
    [],
    CreateWorkspaceRequestSchema,
    CreateWorkspaceResponseSchema,
  ),
  /** Defines an unclaimed person. */
  defineMember: action(
    M.defineMember,
    ["workspaceId"],
    DefineMemberRequestSchema,
    DefineMemberResponseSchema,
  ),
  /** Renames the caller's own person or an unclaimed person. */
  renameMember: action(
    M.renameMember,
    ["workspaceId", "memberId"],
    RenameMemberRequestSchema,
    "empty",
  ),
  /** Removes a person, unclaimed or claimed. */
  removeMember: action(
    M.removeMember,
    ["workspaceId", "memberId"],
    null,
    "empty",
  ),
  promoteMember: action(
    M.promoteMember,
    ["workspaceId", "memberId"],
    null,
    "empty",
  ),
  demoteMember: action(
    M.demoteMember,
    ["workspaceId", "memberId"],
    null,
    "empty",
  ),
  leaveWorkspace: action(M.leaveWorkspace, ["workspaceId"], null, "empty"),
  offerOwnership: action(
    M.offerOwnership,
    ["workspaceId"],
    OfferOwnershipRequestSchema,
    "empty",
  ),
  acceptOwnershipOffer: action(
    M.acceptOwnershipOffer,
    ["workspaceId"],
    null,
    "empty",
  ),
  withdrawOwnershipOffer: action(
    M.withdrawOwnershipOffer,
    ["workspaceId"],
    null,
    "empty",
  ),
  /** Its answer carries the invitation code once (D2). */
  createInvitation: action(
    M.createInvitation,
    ["workspaceId"],
    CreateInvitationRequestSchema,
    CreateInvitationResponseSchema,
  ),
  revokeInvitation: action(
    M.revokeInvitation,
    ["workspaceId", "invitationId"],
    null,
    "empty",
  ),
  /** The pasted code goes in the body only (D2). */
  previewInvitation: action(
    M.previewInvitation,
    [],
    PreviewInvitationRequestSchema,
    PreviewInvitationResponseSchema,
  ),
  /** The pasted code goes in the body only (D2). */
  acceptInvitation: action(
    M.acceptInvitation,
    [],
    AcceptInvitationRequestSchema,
    AcceptInvitationResponseSchema,
  ),
  createJoinRequest: action(
    M.createJoinRequest,
    [],
    CreateJoinRequestRequestSchema,
    CreateJoinRequestResponseSchema,
  ),
  withdrawJoinRequest: action(
    M.withdrawJoinRequest,
    ["joinRequestId"],
    null,
    "empty",
  ),
  /** With an optional display name that replaces the requested one. */
  approveJoinRequest: action(
    M.approveJoinRequest,
    ["workspaceId", "joinRequestId"],
    ApproveJoinRequestRequestSchema,
    ApproveJoinRequestResponseSchema,
  ),
  denyJoinRequest: action(
    M.denyJoinRequest,
    ["workspaceId", "joinRequestId"],
    null,
    "empty",
  ),
  denyAllJoinRequests: action(
    M.denyAllJoinRequests,
    ["workspaceId"],
    null,
    "empty",
  ),
  blockJoinRequest: action(
    M.blockJoinRequest,
    ["workspaceId", "joinRequestId"],
    null,
    "empty",
  ),
  unblockJoinRequest: action(
    M.unblockJoinRequest,
    ["workspaceId", "joinRequestId"],
    null,
    "empty",
  ),
  pauseJoinRequests: action(
    M.pauseJoinRequests,
    ["workspaceId"],
    null,
    "empty",
  ),
  resumeJoinRequests: action(
    M.resumeJoinRequests,
    ["workspaceId"],
    null,
    "empty",
  ),
  /** D7: project creation stays with #95, next to workspace creation. */
  createProject: action(
    PROJECT_ROUTES.createProject,
    ["workspaceId"],
    CreateProjectRequestSchema,
    CreateProjectResponseSchema,
  ),
});
export type WorkspaceActionName = keyof typeof WORKSPACE_ACTIONS;

/** No path parameter. */
type NoParams = Readonly<Record<string, never>>;
type InWorkspace = { readonly workspaceId: WorkspaceId };
type OfMember = InWorkspace & { readonly memberId: MemberId };
type OfJoinRequest = InWorkspace & { readonly joinRequestId: JoinRequestId };

/** The path parameters of each write. */
export interface WorkspaceActionParams {
  readonly createWorkspace: NoParams;
  readonly defineMember: InWorkspace;
  readonly renameMember: OfMember;
  readonly removeMember: OfMember;
  readonly promoteMember: OfMember;
  readonly demoteMember: OfMember;
  readonly leaveWorkspace: InWorkspace;
  readonly offerOwnership: InWorkspace;
  readonly acceptOwnershipOffer: InWorkspace;
  readonly withdrawOwnershipOffer: InWorkspace;
  readonly createInvitation: InWorkspace;
  readonly revokeInvitation: InWorkspace & {
    readonly invitationId: InvitationId;
  };
  readonly previewInvitation: NoParams;
  readonly acceptInvitation: NoParams;
  readonly createJoinRequest: NoParams;
  readonly withdrawJoinRequest: { readonly joinRequestId: JoinRequestId };
  readonly approveJoinRequest: OfJoinRequest;
  readonly denyJoinRequest: OfJoinRequest;
  readonly denyAllJoinRequests: InWorkspace;
  readonly blockJoinRequest: OfJoinRequest;
  readonly unblockJoinRequest: OfJoinRequest;
  readonly pauseJoinRequests: InWorkspace;
  readonly resumeJoinRequests: InWorkspace;
  readonly createProject: InWorkspace;
}

/** The body of each write, as the caller passes it; `never` for none. */
export interface WorkspaceActionBody {
  readonly createWorkspace: CreateWorkspaceRequest;
  readonly defineMember: DefineMemberRequest;
  readonly renameMember: RenameMemberRequest;
  readonly removeMember: never;
  readonly promoteMember: never;
  readonly demoteMember: never;
  readonly leaveWorkspace: never;
  readonly offerOwnership: OfferOwnershipRequest;
  readonly acceptOwnershipOffer: never;
  readonly withdrawOwnershipOffer: never;
  readonly createInvitation: CreateInvitationRequest;
  readonly revokeInvitation: never;
  /** The code as pasted; it must match `INVITATION_CODE_PATTERN` exactly. */
  readonly previewInvitation: PreviewInvitationRequest;
  /** The code as pasted; it must match `INVITATION_CODE_PATTERN` exactly. */
  readonly acceptInvitation: AcceptInvitationRequest;
  readonly createJoinRequest: CreateJoinRequestRequest;
  readonly withdrawJoinRequest: never;
  readonly approveJoinRequest: ApproveJoinRequestRequest;
  readonly denyJoinRequest: never;
  readonly denyAllJoinRequests: never;
  readonly blockJoinRequest: never;
  readonly unblockJoinRequest: never;
  readonly pauseJoinRequests: never;
  readonly resumeJoinRequests: never;
  /** The name as typed; it is sent normalized (`normalizeProjectName`). */
  readonly createProject: z.input<typeof CreateProjectRequestSchema>;
}

/**
 * The body argument of a write: required for a write with a body, also when
 * every key of it is optional (`approveJoinRequest` takes `{}`), and not
 * allowed for a write without one.
 */
export type WorkspaceActionBodyArgument<N extends WorkspaceActionName> = [
  WorkspaceActionBody[N],
] extends [never]
  ? []
  : [body: WorkspaceActionBody[N]];

/** The answer of each write, as its schema parsed it; null for a `204`. */
export interface WorkspaceActionAnswer {
  readonly createWorkspace: CreateWorkspaceResponse;
  readonly defineMember: DefineMemberResponse;
  readonly renameMember: null;
  readonly removeMember: null;
  readonly promoteMember: null;
  readonly demoteMember: null;
  readonly leaveWorkspace: null;
  readonly offerOwnership: null;
  readonly acceptOwnershipOffer: null;
  readonly withdrawOwnershipOffer: null;
  /** Holds the invitation code: pass it on once, and never keep or log it. */
  readonly createInvitation: CreateInvitationResponse;
  readonly revokeInvitation: null;
  readonly previewInvitation: PreviewInvitationResponse;
  readonly acceptInvitation: AcceptInvitationResponse;
  readonly createJoinRequest: CreateJoinRequestResponse;
  readonly withdrawJoinRequest: null;
  readonly approveJoinRequest: ApproveJoinRequestResponse;
  readonly denyJoinRequest: null;
  readonly denyAllJoinRequests: null;
  readonly blockJoinRequest: null;
  readonly unblockJoinRequest: null;
  readonly pauseJoinRequests: null;
  readonly resumeJoinRequests: null;
  readonly createProject: CreateProjectResponse;
}

/**
 * The write budget of an installation: at most `writes` writes are sent
 * within any `windowMs`, far below the API's 300 requests a minute, so that
 * even a renderer that misbehaves cannot send writes in a loop. A write over
 * it is refused as `too_soon` without a request. A write counts once the
 * account service hands it to the session, also when the session then sends
 * nothing (for example while signed out, while a removal is pending, without
 * a loaded key or an API origin, or when its token cannot be minted),
 * because the budget also limits the token requests. Only a write that the
 * service refuses itself (`invalid`, `unavailable`, `not_signed_in`, or
 * `too_soon`) does not count. A session's `invalid_request`, which the
 * service also answers as `invalid`, has counted already.
 */
export const WORKSPACE_ACTION_BUDGET = Object.freeze({
  writes: 30,
  windowMs: 60_000,
});

/**
 * The wait after `rate_limited` when the answer held no valid `Retry-After`;
 * the wait of the reads (`RATE_LIMITED_RETRY_MS`) is the same.
 */
export const ACTION_RATE_LIMITED_WAIT_MS = 60_000;

/**
 * Why a write failed, a closed set that the screens can show. Only
 * `unknown` leaves open whether the API acted; after every other failure it
 * did not.
 *
 * - `invalid`: the name is not on the allowlist, a path parameter is missing,
 *   extra, or not an ID, or the body is outside its request schema, for
 *   example a pasted text that is not an invitation code; or the session
 *   found a value outside the protocol's format (`invalid_request`). Nothing
 *   was sent.
 * - `too_soon`: the write budget is spent (`WORKSPACE_ACTION_BUDGET`);
 *   `retryAfterMs` says when the next write may go. Nothing was sent.
 * - `not_signed_in`: as for the reads: no device of this installation is
 *   signed in or its key is not usable, or the API refused its key or token.
 * - `unavailable`: try again later; nothing was sent, or the API refused it
 *   before it acted: a sign-in, a sign-out, "This is not me", a device
 *   removal, or an unlock runs, or the API origin, the key store, or the
 *   device record is not usable.
 * - `forbidden`, `not_found`, `conflict`, `already_member`,
 *   `invitation_invalid`, `join_requests_closed`, `workspace_not_found`,
 *   `device_too_new`, `unclaimed_limit`: the API's refusal with that code
 *   (`MEMBERSHIP_ROUTE_ERRORS`, `PROJECT_ROUTE_ERRORS`). `unclaimed_limit`
 *   carries no wait: only removing an unclaimed person, or a claim of one,
 *   frees a place for a definition (#242).
 * - `rate_limited`: the API's limit; `retryAfterMs` follows its
 *   `Retry-After`, or `ACTION_RATE_LIMITED_WAIT_MS` without one.
 * - `unknown`: whether the API acted is not known: it gave no answer, failed,
 *   or answered outside its schema, or the account or the device changed
 *   while the write was on its way, so that its answer is not passed on.
 *   The write is never sent again on its own; the screen reloads what it
 *   shows, and the person decides.
 * - `failed`: the API refused it otherwise, for example as `bad_request`.
 */
export const WORKSPACE_ACTION_FAILURES = Object.freeze([
  "invalid",
  "too_soon",
  "not_signed_in",
  "unavailable",
  "forbidden",
  "not_found",
  "conflict",
  "already_member",
  "invitation_invalid",
  "join_requests_closed",
  "workspace_not_found",
  "device_too_new",
  "unclaimed_limit",
  "rate_limited",
  "unknown",
  "failed",
] as const);
export type WorkspaceActionFailure = (typeof WORKSPACE_ACTION_FAILURES)[number];

/** The failures that say when the next write may go. */
type WaitFailure = "too_soon" | "rate_limited";

export type WorkspaceActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: Exclude<WorkspaceActionFailure, WaitFailure>;
    }
  | {
      readonly ok: false;
      readonly reason: WaitFailure;
      /** How long to wait before the next try, in milliseconds. */
      readonly retryAfterMs: number;
    };

export function workspaceActionFailed(
  reason: Exclude<WorkspaceActionFailure, WaitFailure>,
): WorkspaceActionResult<never>;
export function workspaceActionFailed(
  reason: WaitFailure,
  retryAfterMs: number,
): WorkspaceActionResult<never>;
export function workspaceActionFailed(
  reason: WorkspaceActionFailure,
  retryAfterMs?: number,
): WorkspaceActionResult<never> {
  return reason === "too_soon" || reason === "rate_limited"
    ? Object.freeze({
        ok: false,
        reason,
        retryAfterMs: Math.max(1, Math.ceil(retryAfterMs ?? 0)),
      })
    : Object.freeze({ ok: false, reason });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The body as its schema parsed it, null for a route without one, or
 * undefined when it is outside the schema or holds a key that the schema
 * does not know (the protocol's objects drop such keys instead of refusing
 * them).
 */
function parsedBody(
  schema: z.ZodType | null,
  body: unknown,
): Readonly<Record<string, unknown>> | null | undefined {
  if (schema === null) {
    return body === undefined ? null : undefined;
  }
  if (!isRecord(body)) {
    return undefined;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success || !isRecord(parsed.data)) {
    return undefined;
  }
  const known = parsed.data;
  return Object.keys(body).every((key) => Object.hasOwn(known, key))
    ? known
    : undefined;
}

/**
 * The session's request for one write of the allowlist, or null when the
 * name is not on it, a path parameter is missing, extra, or not an ID, or
 * the body is outside its schema. The values are checked at runtime as
 * well, because a caller's types do not hold there. The body is sent as its
 * schema parsed it, so a project's name goes normalized.
 */
export function workspaceActionRequest<N extends WorkspaceActionName>(
  name: N,
  params: unknown,
  body: unknown,
): AuthorizedRequest<WorkspaceActionAnswer[N]> | null {
  if (typeof name !== "string" || !Object.hasOwn(WORKSPACE_ACTIONS, name)) {
    return null;
  }
  const entry: WorkspaceAction = WORKSPACE_ACTIONS[name];
  if (!isRecord(params)) {
    return null;
  }
  const names = Object.keys(params);
  if (names.length !== entry.params.length) {
    return null;
  }
  const filled: Record<string, string> = {};
  for (const param of entry.params) {
    const value = Object.hasOwn(params, param) ? params[param] : undefined;
    if (
      typeof value !== "string" ||
      !PATH_PARAMS[param].safeParse(value).success
    ) {
      return null;
    }
    filled[param] = value;
  }
  const sent = parsedBody(entry.body, body);
  if (sent === undefined) {
    return null;
  }
  return Object.freeze({
    route: entry.route,
    params: Object.freeze(filled),
    ...(sent === null ? {} : { body: sent }),
    answer: entry.answer as AuthorizedRequest<
      WorkspaceActionAnswer[N]
    >["answer"],
  });
}

/** The API's codes that mean that the device or its token is refused. */
const NOT_SIGNED_IN_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  "unauthorized",
  "auth_failed",
  "device_revoked",
  "sign_in_required",
  "device_account_mismatch",
]);

/** The API's codes that a screen shows as they are. */
const SHOWN_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  "forbidden",
  "not_found",
  "conflict",
  "already_member",
  "invitation_invalid",
  "join_requests_closed",
  "workspace_not_found",
  "device_too_new",
  "unclaimed_limit",
]);

/** The closed failure of a write for a failure of the device session. */
export function workspaceActionFailureOf(
  failure: SessionFailure,
): WorkspaceActionFailure {
  switch (failure.reason) {
    case "no_device":
    case "key_lost":
    case "key_not_loaded":
    case "signed_out":
    case "removal_pending":
      return "not_signed_in";
    case "refused": {
      const code = failure.code;
      if (code === undefined) {
        return "failed";
      }
      if (code === "rate_limited") {
        return "rate_limited";
      }
      if (SHOWN_CODES.has(code)) {
        return code as WorkspaceActionFailure;
      }
      if (NOT_SIGNED_IN_CODES.has(code)) {
        return "not_signed_in";
      }
      // Defensive only: the session never refuses with `internal_error`.
      // The error body allows it only with a 5xx (`ApiErrorBodySchema`), and
      // `callApi` answers every 5xx as `server_error` before it reads a
      // body. Should one come, the API may have acted.
      return code === "internal_error" ? "unknown" : "failed";
    }
    // Nothing was sent, or the write itself was refused with a 401 before
    // the session failed to mint a new token.
    case "api_origin_unset":
    case "api_origin_invalid":
    case "record_unreadable":
    case "key_store_failed":
    case "sign_in_running":
    case "replacement_pending":
    case "record_not_saved":
      return "unavailable";
    // Nothing was sent: a value of the call is outside the protocol's
    // format, as with `invalid`. The allowlist checks every value first, so
    // the session should never find one.
    case "invalid_request":
      return "invalid";
    // The write, or the token request before it, may have reached the API.
    case "no_answer":
    case "server_error":
    case "unexpected_response":
      return "unknown";
  }
}

/** The failed result of a write for a failure of the device session. */
export function workspaceActionFailedFor(
  failure: SessionFailure,
): WorkspaceActionResult<never> {
  const reason = workspaceActionFailureOf(failure);
  if (reason === "rate_limited") {
    return workspaceActionFailed(
      reason,
      failure.retryAfterSeconds === undefined
        ? ACTION_RATE_LIMITED_WAIT_MS
        : failure.retryAfterSeconds * 1000,
    );
  }
  // `too_soon` is the service's own refusal, never the session's.
  return workspaceActionFailed(reason as Exclude<typeof reason, WaitFailure>);
}
