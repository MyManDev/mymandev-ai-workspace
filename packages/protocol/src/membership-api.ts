// The membership routes of ADR 0014: workspaces and people, invitations, join
// requests, removal and leaving, promotion and demotion, and ownership offers.
// Every route needs an access token. Every path under `/workspaces/:workspaceId`
// checks active membership first and answers a non-member with `404` and
// `not_found`, exactly as for a workspace that does not exist. The only action
// that a non-member can take with a workspace ID, a join request, is therefore
// not under that path.

import * as z from "zod";
import {
  InvitationCodeSchema,
  JoinRequestDecisionSchema,
  MemberIdentitySchema,
  WorkspaceMemberSchema,
} from "./account.ts";
import type { ApiRoute } from "./auth-api.ts";
import { displayText, WorkspaceSchema } from "./entities.ts";
import { UtcTimestampSchema } from "./envelope.ts";
import {
  InvitationIdSchema,
  JoinRequestIdSchema,
  MemberIdSchema,
  WorkspaceIdSchema,
} from "./ids.ts";
import type { ApiErrorCode } from "./model.ts";
import {
  INVITATION_LIFETIME_SECONDS,
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
} from "./model.ts";

function route(method: ApiRoute["method"], path: string): ApiRoute {
  return Object.freeze({ method, path });
}

/**
 * The membership routes (ADR 0014). Every path parameter is an ID. An
 * invitation code travels only in a request body and in the one answer that
 * creates it, never in a path or a query. A route with a response schema
 * answers `200` with that body; every other route answers `204` without a
 * body, and the caller reads the new state from the workspace view, the
 * lists, or the server's workspace events.
 */
export const MEMBERSHIP_ROUTES = Object.freeze({
  /** The account's workspaces, each with the account's own active person. */
  listWorkspaces: route("GET", "/workspaces"),
  /** Creates a workspace. The creator's person is the claimed `owner`. */
  createWorkspace: route("POST", "/workspaces"),
  /**
   * The workspace, all its people including former members, whether join
   * requests are paused, and the live ownership offer. Any active member.
   */
  getWorkspace: route("GET", "/workspaces/:workspaceId"),
  /** Defines an unclaimed person, who is always a `member`. Owner or admin. */
  defineMember: route("POST", "/workspaces/:workspaceId/members"),
  /**
   * Renames a person: any member renames their own person, and the owner or
   * an admin renames an unclaimed person. Nobody renames another claimed
   * person.
   */
  renameMember: route(
    "POST",
    "/workspaces/:workspaceId/members/:memberId/rename",
  ),
  /**
   * Removes a person. The owner or an admin removes an unclaimed person; the
   * owner removes any claimed person except the owner, and an admin only a
   * claimed person with the role `member`. Nobody removes the owner. A member
   * leaves with `leaveWorkspace`, not with this route.
   */
  removeMember: route(
    "POST",
    "/workspaces/:workspaceId/members/:memberId/remove",
  ),
  /**
   * Promotes an active, claimed `member` to `admin`. The owner only, from a
   * device older than 72 hours.
   */
  promoteMember: route(
    "POST",
    "/workspaces/:workspaceId/members/:memberId/promote",
  ),
  /**
   * Demotes an active `admin` to `member` and revokes, in the same
   * transaction, the live invitations that the admin created. The owner only.
   */
  demoteMember: route(
    "POST",
    "/workspaces/:workspaceId/members/:memberId/demote",
  ),
  /** The caller's own person leaves the workspace. The owner cannot leave. */
  leaveWorkspace: route("POST", "/workspaces/:workspaceId/leave"),
  /**
   * Offers ownership to another active, claimed person, an admin or a member.
   * The owner only, from a device older than 72 hours. A workspace has at
   * most one offer; a second offer answers `conflict` until the first is
   * withdrawn, accepted, or past its expiry.
   */
  offerOwnership: route("POST", "/workspaces/:workspaceId/ownership-offer"),
  /**
   * The target accepts the live offer within 7 days. The owner becomes an
   * `admin` and the target the `owner`, in one transaction.
   */
  acceptOwnershipOffer: route(
    "POST",
    "/workspaces/:workspaceId/ownership-offer/accept",
  ),
  /** The owner withdraws the live offer. */
  withdrawOwnershipOffer: route(
    "POST",
    "/workspaces/:workspaceId/ownership-offer/withdraw",
  ),
  /** The live invitations, each with its creator. Owner or admin. */
  listInvitations: route("GET", "/workspaces/:workspaceId/invitations"),
  /**
   * Creates an invitation for an unclaimed person and revokes that person's
   * previous live invitation in the same transaction. The answer carries the
   * code once and never again, with `Cache-Control: no-store`. Owner or admin.
   */
  createInvitation: route("POST", "/workspaces/:workspaceId/invitations"),
  /** Revokes a live invitation. Owner or admin. */
  revokeInvitation: route(
    "POST",
    "/workspaces/:workspaceId/invitations/:invitationId/revoke",
  ),
  /**
   * Shows what an invitation code claims, without consuming it. Any
   * signed-in device; the answer carries `Cache-Control: no-store`.
   */
  previewInvitation: route("POST", "/invitations/preview"),
  /**
   * Consumes an invitation code and claims its person. Any signed-in device;
   * the answer carries `Cache-Control: no-store`.
   */
  acceptInvitation: route("POST", "/invitations/accept"),
  /**
   * Asks to join a workspace as a new person: the only action that a
   * workspace ID allows a non-member. A second request while one is pending
   * answers with the pending request instead of creating another.
   */
  createJoinRequest: route("POST", "/join-requests"),
  /** The requester withdraws their own pending request. */
  withdrawJoinRequest: route("POST", "/join-requests/:joinRequestId/withdraw"),
  /**
   * The pending join requests and the blocks in force, in the approver's
   * view. Owner or admin.
   */
  listJoinRequests: route("GET", "/workspaces/:workspaceId/join-requests"),
  /**
   * Approves a pending request: creates a claimed person with the role
   * `member` in the same transaction. Owner or admin.
   */
  approveJoinRequest: route(
    "POST",
    "/workspaces/:workspaceId/join-requests/:joinRequestId/approve",
  ),
  /** Denies a pending request. Owner or admin. */
  denyJoinRequest: route(
    "POST",
    "/workspaces/:workspaceId/join-requests/:joinRequestId/deny",
  ),
  /**
   * Denies a pending request and keeps its account from asking this
   * workspace again until the block is lifted. Owner or admin.
   */
  blockJoinRequest: route(
    "POST",
    "/workspaces/:workspaceId/join-requests/:joinRequestId/block",
  ),
  /** Lifts the block of a blocked request. Owner or admin. */
  unblockJoinRequest: route(
    "POST",
    "/workspaces/:workspaceId/join-requests/:joinRequestId/unblock",
  ),
  /** Denies every pending request of the workspace at once. Owner or admin. */
  denyAllJoinRequests: route(
    "POST",
    "/workspaces/:workspaceId/join-requests/deny-all",
  ),
  /**
   * Pauses new join requests; they answer `join_requests_closed`. Pending
   * requests stay. A pause ends only with `resumeJoinRequests`. Pausing a
   * paused workspace changes nothing. Owner or admin.
   */
  pauseJoinRequests: route(
    "POST",
    "/workspaces/:workspaceId/join-requests/pause",
  ),
  /**
   * Ends a pause of join requests. Resuming a workspace that is not paused
   * changes nothing. Owner or admin.
   */
  resumeJoinRequests: route(
    "POST",
    "/workspaces/:workspaceId/join-requests/resume",
  ),
});
export type MembershipRouteName = keyof typeof MEMBERSHIP_ROUTES;

/** The codes that every membership route can answer. */
const COMMON_ERRORS = Object.freeze([
  "bad_request",
  "unauthorized",
  "rate_limited",
  "internal_error",
] as const satisfies readonly ApiErrorCode[]);

function errors(...codes: readonly ApiErrorCode[]): readonly ApiErrorCode[] {
  return Object.freeze([...COMMON_ERRORS, ...codes]);
}

/**
 * Every error code that each membership route can answer, with its status
 * from `API_ERROR_STATUS`. Every route can answer `bad_request`,
 * `unauthorized` (a missing or invalid access token), `rate_limited` (with
 * `Retry-After`), and `internal_error`. Beyond those:
 *
 * - `not_found`: a non-member on a path under `/workspaces/:workspaceId`, or
 *   a member, invitation, or join request ID that the workspace (or, for a
 *   withdrawal, the caller) does not have;
 * - `forbidden`: the caller's role does not allow the action;
 * - `device_too_new`: an ownership offer or a promotion from a device younger
 *   than 72 hours;
 * - `conflict`: the target is not in the state that the action needs, for
 *   example a removed person, a request that is no longer pending, or a
 *   second ownership offer;
 * - `invitation_invalid`, `already_member`, `workspace_not_found`, and
 *   `join_requests_closed` as ADR 0014 defines them.
 *
 * Limits answer `rate_limited`, also those that count live or pending items,
 * such as 50 live invitations or 50 pending join requests per workspace.
 */
export const MEMBERSHIP_ROUTE_ERRORS = Object.freeze({
  listWorkspaces: errors(),
  createWorkspace: errors(),
  getWorkspace: errors("not_found"),
  defineMember: errors("not_found", "forbidden"),
  renameMember: errors("not_found", "forbidden", "conflict"),
  removeMember: errors("not_found", "forbidden", "conflict"),
  promoteMember: errors("not_found", "forbidden", "device_too_new", "conflict"),
  demoteMember: errors("not_found", "forbidden", "conflict"),
  leaveWorkspace: errors("not_found", "forbidden"),
  offerOwnership: errors(
    "not_found",
    "forbidden",
    "device_too_new",
    "conflict",
  ),
  acceptOwnershipOffer: errors("not_found", "forbidden", "conflict"),
  withdrawOwnershipOffer: errors("not_found", "forbidden", "conflict"),
  listInvitations: errors("not_found", "forbidden"),
  createInvitation: errors("not_found", "forbidden", "conflict"),
  revokeInvitation: errors("not_found", "forbidden", "conflict"),
  previewInvitation: errors("invitation_invalid", "already_member"),
  acceptInvitation: errors("invitation_invalid", "already_member"),
  createJoinRequest: errors(
    "workspace_not_found",
    "join_requests_closed",
    "already_member",
  ),
  withdrawJoinRequest: errors("not_found", "conflict"),
  listJoinRequests: errors("not_found", "forbidden"),
  approveJoinRequest: errors(
    "not_found",
    "forbidden",
    "conflict",
    "already_member",
  ),
  denyJoinRequest: errors("not_found", "forbidden", "conflict"),
  blockJoinRequest: errors("not_found", "forbidden", "conflict"),
  unblockJoinRequest: errors("not_found", "forbidden", "conflict"),
  denyAllJoinRequests: errors("not_found", "forbidden"),
  pauseJoinRequests: errors("not_found", "forbidden"),
  resumeJoinRequests: errors("not_found", "forbidden"),
} satisfies Record<MembershipRouteName, readonly ApiErrorCode[]>);

/** A person's display name in a workspace: 1 to 64 characters. */
const memberDisplayName = () => displayText(LIMITS.displayName);

/**
 * A workspace together with the account's own active, claimed person in it:
 * an item of the workspace list, and the answer of creating a workspace or
 * accepting an invitation.
 */
export const WorkspaceMembershipSchema = z
  .object({
    workspace: WorkspaceSchema,
    member: WorkspaceMemberSchema,
  })
  .superRefine((value, ctx) => {
    if (value.member.workspaceId !== value.workspace.id) {
      ctx.addIssue({
        code: "custom",
        message: "The person belongs to another workspace",
        path: ["member", "workspaceId"],
      });
    }
    if (value.member.userId === null || value.member.removedAt !== null) {
      ctx.addIssue({
        code: "custom",
        message: "The account's own person is claimed and active",
        path: ["member"],
      });
    }
  });
export type WorkspaceMembership = z.infer<typeof WorkspaceMembershipSchema>;

/** The answer of `GET /workspaces`: only workspaces the account is an active member of. */
export const WorkspaceListResponseSchema = z.object({
  workspaces: z.array(WorkspaceMembershipSchema).max(MAX_ANSWER_LIST_ITEMS),
});
export type WorkspaceListResponse = z.infer<typeof WorkspaceListResponseSchema>;

/**
 * `POST /workspaces`. `displayName` is the creator's person in the new
 * workspace; the desktop fills it in with the account's display name.
 */
export const CreateWorkspaceRequestSchema = z.object({
  name: displayText(LIMITS.name),
  displayName: memberDisplayName(),
});
export type CreateWorkspaceRequest = z.infer<
  typeof CreateWorkspaceRequestSchema
>;

/** The answer of `POST /workspaces`: the workspace and the creator's `owner` person. */
export const CreateWorkspaceResponseSchema = WorkspaceMembershipSchema;
export type CreateWorkspaceResponse = WorkspaceMembership;

/**
 * The live ownership offer of a workspace. It expires 7 days after it was
 * made; an offer past `expiresAt` is no offer and is never shown.
 */
export const OwnershipOfferSchema = z.object({
  /** The target: an active, claimed person who is not the owner. */
  memberId: MemberIdSchema,
  offeredAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema,
});
export type OwnershipOffer = z.infer<typeof OwnershipOfferSchema>;

/**
 * The answer of `GET /workspaces/:workspaceId`. `members` holds every person
 * of the workspace, unclaimed, active, and former (`removedAt` set), so that
 * history stays attributed.
 */
export const WorkspaceViewResponseSchema = z
  .object({
    workspace: WorkspaceSchema,
    members: z.array(WorkspaceMemberSchema).max(MAX_ANSWER_LIST_ITEMS),
    /** When new join requests were paused; null while they are accepted. */
    joinRequestsPausedAt: UtcTimestampSchema.nullable(),
    ownershipOffer: OwnershipOfferSchema.nullable(),
  })
  .superRefine((view, ctx) => {
    view.members.forEach((member, index) => {
      if (member.workspaceId !== view.workspace.id) {
        ctx.addIssue({
          code: "custom",
          message: "The person belongs to another workspace",
          path: ["members", index, "workspaceId"],
        });
      }
    });
    const owners = view.members.filter(
      (member) => member.role === "owner" && member.removedAt === null,
    );
    if (owners.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "A workspace has exactly one active owner",
        path: ["members"],
      });
    }
    const offer = view.ownershipOffer;
    if (offer !== null) {
      const target = view.members.find(
        (member) => member.id === offer.memberId,
      );
      if (
        target === undefined ||
        target.userId === null ||
        target.removedAt !== null ||
        target.role === "owner"
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "An ownership offer names an active, claimed person who is not the owner",
          path: ["ownershipOffer", "memberId"],
        });
      }
    }
  });
export type WorkspaceViewResponse = z.infer<typeof WorkspaceViewResponseSchema>;

/** `POST /workspaces/:workspaceId/members`: defines an unclaimed person. */
export const DefineMemberRequestSchema = z.object({
  displayName: memberDisplayName(),
});
export type DefineMemberRequest = z.infer<typeof DefineMemberRequestSchema>;

/** The answer of `POST /workspaces/:workspaceId/members`: the new unclaimed person. */
export const DefineMemberResponseSchema = z.object({
  member: WorkspaceMemberSchema,
});
export type DefineMemberResponse = z.infer<typeof DefineMemberResponseSchema>;

/** `POST /workspaces/:workspaceId/members/:memberId/rename`. */
export const RenameMemberRequestSchema = z.object({
  displayName: memberDisplayName(),
});
export type RenameMemberRequest = z.infer<typeof RenameMemberRequestSchema>;

/** `POST /workspaces/:workspaceId/ownership-offer`. */
export const OfferOwnershipRequestSchema = z.object({
  memberId: MemberIdSchema,
});
export type OfferOwnershipRequest = z.infer<typeof OfferOwnershipRequestSchema>;

/**
 * A live invitation, as owners and admins see it. Its code is never shown
 * again after creation. The creator is an active member, because removing a
 * person or demoting an admin revokes the invitations they created; the
 * desktop shows the creator through their person row.
 */
export const InvitationSchema = z.object({
  id: InvitationIdSchema,
  workspaceId: WorkspaceIdSchema,
  /** The unclaimed person that the invitation claims. */
  memberId: MemberIdSchema,
  createdByMemberId: MemberIdSchema,
  createdAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema,
});
export type Invitation = z.infer<typeof InvitationSchema>;

/** The answer of `GET /workspaces/:workspaceId/invitations`. */
export const InvitationListResponseSchema = z.object({
  invitations: z.array(InvitationSchema).max(MAX_ANSWER_LIST_ITEMS),
});
export type InvitationListResponse = z.infer<
  typeof InvitationListResponseSchema
>;

/**
 * `POST /workspaces/:workspaceId/invitations`. The invitation lives
 * `lifetimeSeconds`, from 1 hour to 7 days, and 7 days when it is omitted.
 */
export const CreateInvitationRequestSchema = z.object({
  memberId: MemberIdSchema,
  lifetimeSeconds: z
    .int()
    .min(INVITATION_LIFETIME_SECONDS.min)
    .max(INVITATION_LIFETIME_SECONDS.max)
    .optional(),
});
export type CreateInvitationRequest = z.infer<
  typeof CreateInvitationRequestSchema
>;

/**
 * The answer of `POST /workspaces/:workspaceId/invitations`, sent with
 * `Cache-Control: no-store`. The only answer that carries an invitation code:
 * show it once to pass on, and never store or log it.
 */
export const CreateInvitationResponseSchema = z.object({
  invitation: InvitationSchema,
  code: InvitationCodeSchema,
});
export type CreateInvitationResponse = z.infer<
  typeof CreateInvitationResponseSchema
>;

/** `POST /invitations/preview`. The code travels only in this body. */
export const PreviewInvitationRequestSchema = z.object({
  code: InvitationCodeSchema,
});
export type PreviewInvitationRequest = z.infer<
  typeof PreviewInvitationRequestSchema
>;

/**
 * The answer of `POST /invitations/preview`, sent with `Cache-Control:
 * no-store`: what the code claims, without consuming it. The inviter is
 * shown by their person in the workspace, with the GitHub login.
 */
export const PreviewInvitationResponseSchema = z.object({
  workspaceName: displayText(LIMITS.name),
  /** The display name of the person that the code claims. */
  displayName: memberDisplayName(),
  inviter: z.object({
    displayName: memberDisplayName(),
    identity: MemberIdentitySchema,
  }),
  expiresAt: UtcTimestampSchema,
});
export type PreviewInvitationResponse = z.infer<
  typeof PreviewInvitationResponseSchema
>;

/** `POST /invitations/accept`. The code travels only in this body. */
export const AcceptInvitationRequestSchema = z.object({
  code: InvitationCodeSchema,
});
export type AcceptInvitationRequest = z.infer<
  typeof AcceptInvitationRequestSchema
>;

/**
 * The answer of `POST /invitations/accept`, sent with `Cache-Control:
 * no-store`: the workspace and the person that the account claimed.
 */
export const AcceptInvitationResponseSchema = WorkspaceMembershipSchema;
export type AcceptInvitationResponse = WorkspaceMembership;

/**
 * `POST /join-requests`. The display name that the requester asks for; the
 * desktop fills it in with the account's display name. There is no free-text
 * note.
 */
export const CreateJoinRequestRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  displayName: memberDisplayName(),
});
export type CreateJoinRequestRequest = z.infer<
  typeof CreateJoinRequestRequestSchema
>;

/**
 * A pending join request as its requester sees it: only what the requester
 * sent, and nothing about the workspace.
 */
export const OwnJoinRequestSchema = z.object({
  id: JoinRequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  requestedDisplayName: memberDisplayName(),
  createdAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema,
});
export type OwnJoinRequest = z.infer<typeof OwnJoinRequestSchema>;

/** The answer of `POST /join-requests`: the new or the already pending request. */
export const CreateJoinRequestResponseSchema = z.object({
  joinRequest: OwnJoinRequestSchema,
});
export type CreateJoinRequestResponse = z.infer<
  typeof CreateJoinRequestResponseSchema
>;

/**
 * The GitHub account behind a join request: the login, the time it was last
 * verified, and the creation time of the account, which approvers always see
 * next to the requested name.
 */
export const JoinRequesterIdentitySchema = MemberIdentitySchema.extend({
  accountCreatedAt: UtcTimestampSchema,
});
export type JoinRequesterIdentity = z.infer<typeof JoinRequesterIdentitySchema>;

/**
 * A join request as owners and admins see it. `decision` is null while the
 * request is pending. `requester` is null only after the account's data was
 * erased, which never happens to a pending request in this view.
 */
export const JoinRequestSchema = z
  .object({
    id: JoinRequestIdSchema,
    workspaceId: WorkspaceIdSchema,
    requestedDisplayName: memberDisplayName(),
    requester: JoinRequesterIdentitySchema.nullable(),
    createdAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema,
    decision: JoinRequestDecisionSchema.nullable(),
    decidedAt: UtcTimestampSchema.nullable(),
  })
  .superRefine((request, ctx) => {
    if ((request.decision === null) !== (request.decidedAt === null)) {
      ctx.addIssue({
        code: "custom",
        message: "A decision has a time, and only a decision",
        path: ["decidedAt"],
      });
    }
    if (request.decision === null && request.requester === null) {
      ctx.addIssue({
        code: "custom",
        message: "A pending request shows its requester",
        path: ["requester"],
      });
    }
  });
export type JoinRequest = z.infer<typeof JoinRequestSchema>;

/**
 * The answer of `GET /workspaces/:workspaceId/join-requests`: the pending
 * requests, and the blocked requests whose block is in force.
 */
export const JoinRequestListResponseSchema = z.object({
  joinRequests: z.array(JoinRequestSchema).max(MAX_ANSWER_LIST_ITEMS),
});
export type JoinRequestListResponse = z.infer<
  typeof JoinRequestListResponseSchema
>;

/**
 * `POST /workspaces/:workspaceId/join-requests/:joinRequestId/approve`. The
 * approver may change the display name; without one the person gets the
 * requested name.
 */
export const ApproveJoinRequestRequestSchema = z.object({
  displayName: memberDisplayName().optional(),
});
export type ApproveJoinRequestRequest = z.infer<
  typeof ApproveJoinRequestRequestSchema
>;

/** The answer of an approval: the new claimed person with the role `member`. */
export const ApproveJoinRequestResponseSchema = z.object({
  member: WorkspaceMemberSchema,
});
export type ApproveJoinRequestResponse = z.infer<
  typeof ApproveJoinRequestResponseSchema
>;
