// Closed vocabularies of `audit_events` (ADR 0014, P-61). Only the server uses
// them, so they live here and not in @mymandev/protocol. A test compares them
// with the CHECK constraints of the table; later issues extend both together.

/** What an audit record reports. */
export const AUDIT_ACTIONS = Object.freeze([
  // Sign-in and devices.
  "account.signed_in",
  "device.registered",
  "device.key_replaced",
  "device.signed_out",
  "device.revoked",
  "account.registration_locked",
  "account.registration_lock_lifted",
  "connection.replaced",
  "github.authorization_revoked",
  "event.identity_mismatch",
  // Operator actions on an account.
  "account.disabled",
  "account.enabled",
  "account.erased",
  // Workspaces and the people in them.
  "workspace.created",
  "member.defined",
  "member.renamed",
  "member.claimed",
  "member.removed",
  "member.left",
  "member.promoted",
  "member.demoted",
  "ownership.offered",
  "ownership.offer_withdrawn",
  "ownership.transferred",
  "invitation.created",
  "invitation.accepted",
  "invitation.revoked",
  "join_request.created",
  "join_request.approved",
  "join_request.denied",
  "join_request.blocked",
  "join_request.unblocked",
  "join_request.withdrawn",
  "join_requests.paused",
  "join_requests.resumed",
] as const);
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Why the action happened, where the action alone does not say. The first four
 * are the device revocation reasons of the protocol; the last two say why an
 * invitation was revoked without an explicit revoke.
 */
export const AUDIT_REASONS = Object.freeze([
  "removed",
  "lost",
  "replaced",
  "account_erased",
  "creator_demoted",
  "member_removed",
] as const);
export type AuditReason = (typeof AUDIT_REASONS)[number];
