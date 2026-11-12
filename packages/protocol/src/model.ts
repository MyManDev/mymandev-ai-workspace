// Protocol v0 vocabulary: plain constants and functions without a zod import,
// so that other packages (for example the database CHECK constraints) can use
// them directly. The array and object constants are frozen, so that no code
// can change a vocabulary at runtime and widen a schema built from it later.

/**
 * The protocol version of this package. Version 0 is pre-stable: peers must
 * run the same version, and any other version is rejected as unsupported.
 */
export const PROTOCOL_VERSION = 0;

/**
 * The closed capability vocabulary. Exact match only: no wildcard, no
 * hierarchy and no implication between capabilities. This package defines
 * the names only; every grant check lives in the permissions package (M1-06).
 */
export const CAPABILITIES = Object.freeze([
  "repo.read",
  "repo.write",
  "terminal.execute",
  "git.commit",
  "git.push",
  "provider.use",
] as const);
export type Capability = (typeof CAPABILITIES)[number];

/** The six agent run states. */
export const RUN_STATES = Object.freeze([
  "queued",
  "running",
  "awaiting_input",
  "completed",
  "failed",
  "cancelled",
] as const);
export type RunState = (typeof RUN_STATES)[number];

/** The state of a newly created run. Only the server creates runs. */
export const INITIAL_RUN_STATE = "queued" satisfies RunState;

/** States without an outgoing transition. A retry is a new run. */
export const TERMINAL_RUN_STATES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly RunState[]);
export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];

/** Allowed next states for every run state. */
export const RUN_TRANSITIONS = Object.freeze({
  queued: Object.freeze(["running", "failed", "cancelled"] as const),
  running: Object.freeze([
    "awaiting_input",
    "completed",
    "failed",
    "cancelled",
  ] as const),
  awaiting_input: Object.freeze(["running", "failed", "cancelled"] as const),
  completed: Object.freeze([] as const),
  failed: Object.freeze([] as const),
  cancelled: Object.freeze([] as const),
} satisfies Record<RunState, readonly RunState[]>);

/** Whether a run may move from `from` to `to`. `from` is null when the run is created. */
export function canTransition(from: RunState | null, to: RunState): boolean {
  if (from === null) {
    return to === INITIAL_RUN_STATE;
  }
  const allowed: readonly RunState[] = RUN_TRANSITIONS[from];
  return allowed.includes(to);
}

/** Whether a run in this state is finished and can never change again. */
export function isTerminalRunState(state: RunState): state is TerminalRunState {
  const terminal: readonly RunState[] = TERMINAL_RUN_STATES;
  return terminal.includes(state);
}

/** Operating systems of a desktop device. */
export const DEVICE_PLATFORMS = Object.freeze([
  "windows",
  "macos",
  "linux",
] as const);
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/**
 * Workspace roles (ADR 0014, P-58). Roles are administration rights. They
 * are not capabilities and never imply one. An unclaimed person is always a
 * `member`, and a workspace has exactly one `owner`.
 */
export const MEMBER_ROLES = Object.freeze([
  "owner",
  "admin",
  "member",
] as const);
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Device key algorithms. Version 0 accepts Ed25519 only (P-52). */
export const DEVICE_KEY_ALGORITHMS = Object.freeze(["ed25519"] as const);
export type DeviceKeyAlgorithm = (typeof DEVICE_KEY_ALGORITHMS)[number];

/** Why a device was revoked. A revoked device never comes back. */
export const DEVICE_REVOCATION_REASONS = Object.freeze([
  "removed",
  "lost",
  "replaced",
  "account_erased",
] as const);
export type DeviceRevocationReason = (typeof DEVICE_REVOCATION_REASONS)[number];

/** How a join request ended. A request without a decision is pending. */
export const JOIN_REQUEST_DECISIONS = Object.freeze([
  "approved",
  "denied",
  "blocked",
  "withdrawn",
  "expired",
] as const);
export type JoinRequestDecision = (typeof JOIN_REQUEST_DECISIONS)[number];

/**
 * How a join request ended, as its requester sees it (#92): a block appears
 * as `denied`, and a request past its expiry as `expired`, also before the
 * server marks it. A new request after a block answers
 * `join_requests_closed`, as for a pause.
 */
export const OWN_JOIN_REQUEST_DECISIONS = Object.freeze([
  "approved",
  "denied",
  "withdrawn",
  "expired",
] as const);
export type OwnJoinRequestDecision =
  (typeof OWN_JOIN_REQUEST_DECISIONS)[number];

/** Sign-in methods that identify an account. */
export const IDENTITY_PROVIDERS = Object.freeze(["github"] as const);
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

/**
 * Reason codes in `reason` when the server cancels a run with a `system`
 * actor (P-60). The desktop shows a known code as its own text. They are
 * the server's alone: it refuses an agent's transition with one of them
 * with `event.refused` and `conflict` (`runReasonAllowed`, #201).
 */
export const RUN_CANCEL_REASONS = Object.freeze([
  "member_removed",
  "device_revoked",
] as const);
export type RunCancelReason = (typeof RUN_CANCEL_REASONS)[number];

/**
 * Why an ownership offer ended without a transfer: the owner withdrew it, or
 * nobody answered it within 7 days. The desktop already hides an offer past
 * its `expiresAt`; `expired` reaches it when the server clears the offer.
 */
export const OWNERSHIP_OFFER_END_REASONS = Object.freeze([
  "withdrawn",
  "expired",
] as const);
export type OwnershipOfferEndReason =
  (typeof OWNERSHIP_OFFER_END_REASONS)[number];

/**
 * How an account claimed a person (#208; Project Manager decision of
 * 2026-11-06): by accepting an invitation, or through a join request that an
 * owner or admin approved. Nobody vetted the account of an invitation claim
 * before it joined, while the approver of a join request saw its GitHub login
 * and the creation date of the account (ADR 0014, "Threats", a leaked
 * invitation code). The list is closed: a third way of claiming a person
 * needs a protocol change, because an older desktop refuses an unknown value.
 */
export const CLAIM_VIAS = Object.freeze([
  "invitation",
  "join_request",
] as const);
export type ClaimVia = (typeof CLAIM_VIAS)[number];

/**
 * A person's presence in a workspace (#110). A person is `online` while at
 * least one connection of its account is subscribed to the workspace, and
 * `offline` otherwise; an unclaimed person is always `offline`. Presence is
 * never stored and never names a device.
 */
export const PRESENCE_STATUSES = Object.freeze(["online", "offline"] as const);
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

/**
 * Why the server refused `workspace.subscribe`. An unknown workspace and a
 * workspace that the account is not an active member of both get
 * `not_found`, as the HTTP routes answer both with the same `404` (ADR 0014,
 * "What a workspace ID allows"). `too_many_subscriptions`: the connection
 * already holds as many subscriptions as the server allows; the server sets
 * the cap and tunes it with use (P-64). Subscribing again to a workspace
 * that the connection holds is never refused with it.
 */
export const WORKSPACE_SUBSCRIBE_REFUSAL_CODES = Object.freeze([
  "not_found",
  "too_many_subscriptions",
] as const);
export type WorkspaceSubscribeRefusalCode =
  (typeof WORKSPACE_SUBSCRIBE_REFUSAL_CODES)[number];

/**
 * Why a workspace subscription ended: the device asked with
 * `workspace.unsubscribe`, or the account's person was removed from the
 * workspace or left it.
 */
export const WORKSPACE_UNSUBSCRIBE_REASONS = Object.freeze([
  "requested",
  "membership_ended",
] as const);
export type WorkspaceUnsubscribeReason =
  (typeof WORKSPACE_UNSUBSCRIBE_REASONS)[number];

/**
 * Why the server refused an event that a device sent, in `event.refused`
 * (#27, #28). The connection stays open. The list is closed; it is complete
 * before protocol version 1, because a new value then needs a new version.
 *
 * - `not_found`: the event names a project, an agent, a run, or a
 *   repository that does not exist or is not in the event's workspace, or a
 *   run of another agent; both get the same code, so that a device cannot
 *   probe which IDs exist (ADR 0007, ADR 0014).
 * - `conflict`: what the event names exists in the workspace, but is not in
 *   the state that the event needs, for example a run whose stored state is
 *   not `previousState`, an archived project, or a disabled agent. Also an
 *   agent's run transition whose `reason` is a code of `RUN_CANCEL_REASONS`,
 *   which only the server gives (`runReasonAllowed`, #201).
 * - `rate_limited`: the device sent more events than the server's send
 *   limit allows. The limit's values are decided with the API part of #27.
 *
 * A protocol violation gets no code: it closes the connection.
 */
export const EVENT_REFUSAL_CODES = Object.freeze([
  "not_found",
  "conflict",
  "rate_limited",
] as const);
export type EventRefusalCode = (typeof EVENT_REFUSAL_CODES)[number];

/**
 * The `code` of every HTTP error answer (P-66), with its HTTP status. The
 * list is closed: the API never sends another code.
 */
export const API_ERROR_STATUS = Object.freeze({
  /** The request is malformed. */
  bad_request: 400,
  /** An access token is missing, unknown, or expired, or no longer valid for its device or account. */
  unauthorized: 401,
  /** Minting an access token or signing in failed: unknown device, bad signature, or disabled account. */
  auth_failed: 401,
  /** A valid signature from a revoked device. */
  device_revoked: 401,
  /** A valid signature, but the device must sign in with GitHub again. */
  sign_in_required: 401,
  /** The caller's role does not allow the action. */
  forbidden: 403,
  /** A new device while the account's registration lock is active. */
  device_registration_locked: 403,
  /** A device younger than 72 hours cannot offer ownership or promote admins. */
  device_too_new: 403,
  /** A GitHub login that does not match the login rule. */
  unsupported_account: 403,
  /** Join requests of the workspace are paused, or the account is blocked. */
  join_requests_closed: 403,
  /** No such route or resource, or a workspace that the caller is not an active member of. */
  not_found: 404,
  /** A join request names a workspace that does not exist. */
  workspace_not_found: 404,
  /** An unknown, used, expired, or revoked invitation code, or a removed person. */
  invitation_invalid: 404,
  /** The installation holds another account. The body carries no login. */
  device_account_mismatch: 409,
  /** The account is already an active member of the workspace. */
  already_member: 409,
  /** The action conflicts with the current state, for example a second ownership offer. */
  conflict: 409,
  /**
   * A sign-in code that an earlier request with the attempt's PKCE verifier
   * and `redirect_uri` already took; that request may have committed. Only a
   * request with the same verifier and `redirect_uri` gets it, within the
   * code's lifetime after the earlier request ended. A code that a request
   * without them consumed answers `auth_failed`, and so does every code
   * after an API restart.
   */
  sign_in_code_used: 409,
  /**
   * A definition in a workspace that already holds as many active unclaimed
   * people as its limit (#242). No time frees a place, only removing or
   * claiming an unclaimed person or a higher limit does, so the answer
   * carries no `Retry-After`.
   */
  unclaimed_limit: 409,
  /** A limit was reached; the answer carries `Retry-After`. */
  rate_limited: 429,
  /** An unexpected server error. */
  internal_error: 500,
  /** GitHub sign-in is unavailable for now; the answer carries `Retry-After`. */
  sign_in_unavailable: 503,
} as const);
export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

/** Every HTTP error code, in the order of `API_ERROR_STATUS`. */
export const API_ERROR_CODES: readonly ApiErrorCode[] = Object.freeze(
  Object.keys(API_ERROR_STATUS) as ApiErrorCode[],
);

/**
 * The code for an error that the API did not raise with its own code, such
 * as a framework error or an unexpected exception, by its HTTP status.
 */
export function genericApiErrorCode(status: number): ApiErrorCode {
  if (status >= 500) {
    return "internal_error";
  }
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 429:
      return "rate_limited";
    default:
      return "bad_request";
  }
}

/**
 * A GitHub login, including managed user accounts (`handle_shortcode`). The
 * API and the database CHECK use this pattern. A login is display data and
 * never identifies an account.
 */
export const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9_-]{1,39}$/u;

/** Invitation lifetimes in seconds: 7 days by default, from 1 hour to 7 days. */
/**
 * The maximum number of items in a list in an API answer (ADR 0003, usage
 * rule 3). It lies far above every count limit of ADR 0014, which are tuned
 * with use (P-64), so raising such a limit never breaks an older client. A
 * list that can grow without a limit, such as the people of a workspace with
 * its former members or the devices with the revoked ones, is cut by the API
 * to its most recent items until pagination exists.
 */
export const MAX_ANSWER_LIST_ITEMS = 1_000;

export const INVITATION_LIFETIME_SECONDS = Object.freeze({
  min: 3_600,
  max: 604_800,
  default: 604_800,
} as const);

/**
 * How many invitations a workspace may have (ADR 0014, "Limits"): at most
 * 50 live invitations, those neither accepted, revoked, nor expired, and at
 * most 100 new invitations within 24 hours. A creation over either limit
 * answers `rate_limited` with `Retry-After`. The person's own live
 * invitation, which a new invitation for that person replaces, does not
 * count toward `live`. The API applies these values, and the desktop
 * checks its copy of `live` against this one.
 */
export const INVITATION_COUNT_LIMITS = Object.freeze({
  live: 50,
  perDay: 100,
} as const);

/**
 * How many active unclaimed people a workspace may hold (Project Manager
 * decision of 2026-11-02): from 1 to 500, and 500 when the creator does not
 * choose. The owner may change it later within the same range, never below
 * the number of active unclaimed people at that moment. An active unclaimed
 * person has no account and is not removed. The workspace view shows the
 * active claimed people first and holds at most `MAX_ANSWER_LIST_ITEMS`
 * people, so it shows every active unclaimed person while at most 500
 * claimed people are active.
 */
export const UNCLAIMED_MEMBER_LIMIT = Object.freeze({
  min: 1,
  max: 500,
  default: 500,
} as const);

/**
 * How many messages one page of a project's chat history holds (#27): 50
 * when the request does not say, and at most 100. A page holds the newest
 * messages first; a page with fewer messages than its `limit` is the oldest.
 * The maximum lies far below `MAX_ANSWER_LIST_ITEMS`, because one message
 * can take about 64 KB of JSON.
 */
export const CHAT_HISTORY_PAGE = Object.freeze({
  default: 50,
  max: 100,
} as const);

/**
 * How many finished runs the server puts in the project's run list (#28):
 * its most recently finished runs, the most recent first. The list also
 * holds every unfinished run, up to `MAX_ANSWER_LIST_ITEMS`. The answer's
 * schema accepts up to `MAX_ANSWER_LIST_ITEMS` finished runs, so that
 * raising this count never breaks an older desktop.
 */
export const RECENT_FINISHED_RUNS = 50;

/**
 * How many claims the server puts in a workspace's list of recent claims
 * (#208): its most recent claims, the most recent first, whatever their age.
 * A count and no time window, so that a claim that the owner or an admin
 * missed while offline stays readable until 50 newer claims exist. 50 is
 * the size of the other lists that ADR 0014 bounds per workspace, 50 live
 * invitations and 50 pending join requests. The answer's schema accepts up
 * to `MAX_ANSWER_LIST_ITEMS` claims, so that raising this count never
 * breaks an older desktop.
 */
export const RECENT_CLAIMS = 50;

/** A UUIDv7 in canonical lowercase form. Uppercase is rejected on purpose. */
export const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** An event type: lowercase snake_case `<domain>.<entity>.<past_tense>`. */
export const EVENT_TYPE_PATTERN =
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

/**
 * A frame type: lowercase snake_case `<domain>.<name>`. It has two parts and
 * an event type has three, so a frame and an event never share a `type`.
 */
export const FRAME_TYPE_PATTERN =
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*[.][a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

/**
 * WebSocket close codes from the private range 4000 to 4999 (ADR 0014,
 * "Device key and authentication"; P-24). The close reason is the key. New
 * codes follow in order and a number is never reused.
 */
export const WS_CLOSE_CODES = Object.freeze({
  /** Unknown device, bad signature, or disabled account. */
  auth_failed: 4000,
  /** No `auth.response` within 10 seconds. */
  auth_timeout: 4001,
  /** A valid signature from a revoked device. */
  device_revoked: 4002,
  /** A valid signature, but the device must sign in with GitHub again. */
  sign_in_required: 4003,
  /** A newer connection of the same device authenticated. */
  connection_replaced: 4004,
  /**
   * Before authentication succeeded: a binary frame, a frame over
   * `MAX_AUTH_FRAME_BYTES`, a frame that is not JSON or that
   * `decodeClientFrame` refuses, any frame other than `auth.response`, or a
   * second frame. The desktop does not reconnect on its own and shows an
   * error; it asks the person to update when the protocol versions differ.
   */
  protocol_violation: 4005,
  /**
   * The connection authenticated with a key that a newer sign-in of the same
   * device has replaced. The desktop reconnects at once with its new key; a
   * copy of the old key then fails with `auth_failed`.
   */
  key_replaced: 4006,
} as const);
export type WsCloseReason = keyof typeof WS_CLOSE_CODES;

/**
 * How long a device's sign-in lasts (ADR 0014, "Lifetimes"): 30 days after
 * its last GitHub sign-in, the device must sign in again. `auth.ok` and the
 * device list report the expiry.
 */
export const SIGN_IN_LIFETIME_MS = 30 * 24 * 60 * 60_000;

/**
 * How long an open connection may outlive its device's sign-in (ADR 0014,
 * "Lifetimes"). From the expiry on, a new connection is refused; one that
 * authenticated before it stays open for this long. The server's sweep, which
 * runs every 60 seconds, then closes it with `sign_in_required` at its first
 * run after the grace, so up to one sweep interval later.
 */
export const SIGN_IN_GRACE_MS = 24 * 60 * 60_000;

/**
 * Human-entered text: rejects control, format (including bidirectional and tag
 * characters), surrogate, private-use, line and paragraph separator, and
 * default-ignorable characters. ZWNJ, ZWJ and the two emoji variation
 * selectors stay allowed for Persian, Indic scripts and emoji sequences.
 * They are alternatives, not a character class, because a joiner or a
 * variation selector inside a class is misleading (ESLint
 * no-misleading-character-class).
 * The `u` flag (not `v`) keeps z.toJSONSchema patterns valid.
 * Every invisible character in this source is written as an escape.
 */
export const SAFE_TEXT_PATTERN =
  /^(?:[^\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{DI}]|\u200C|\u200D|\uFE0E|\uFE0F)*$/u;

/**
 * Human-entered text that may span lines, such as a chat message:
 * `SAFE_TEXT_PATTERN` that also allows the line feed and the tab. Every
 * other control character stays rejected, the carriage return included, so
 * the desktop sends a line break as a single line feed.
 */
export const SAFE_MULTILINE_TEXT_PATTERN =
  /^(?:[^\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{DI}]|\n|\t|\u200C|\u200D|\uFE0E|\uFE0F)*$/u;

/** At least one character that is not white space. */
export const NOT_BLANK_PATTERN = /\S/u;

/**
 * Maximum lengths of strings on the wire, in Unicode code points: zod
 * measures a string in code points, as PostgreSQL's `char_length` does.
 */
export const LIMITS = Object.freeze({
  /** User display name. */
  displayName: 64,
  /** Device label. */
  deviceLabel: 64,
  /** Workspace, project and repository names. */
  name: 100,
  /** Agent name. */
  agentName: 64,
  /** Reason given with a run state change. */
  runReason: 500,
  /** Event type name. */
  eventType: 100,
  /**
   * Chat message body. Equal to the `messages_body_length` CHECK of the
   * database, so a body within this limit always fits there.
   */
  messageBody: 16_000,
} as const);
