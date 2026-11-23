// The grant routes and the payloads of the grant events (#75; Project
// Manager decisions of 2026-11-02 and 2026-11-14; ADR 0015, P-80): granting a
// capability to an agent, revoking a grant, and the grant records of the
// agents that the calling device hosts. Every route needs an access token.
// An agent that does not exist and an agent of a workspace that the account
// is not an active member of both answer `404` and `not_found`, so that a
// route never tells them apart.
//
// Decided by the Project Manager on 2026-11-14 (#75): only the agent's host
// device may grant, a grant of `terminal.execute` expires within 30 days, the
// record list leaves revoked grants out, and a record has no repository fact.
//
// Provisional (#75): the Project Manager's decisions leave open the paths,
// the error codes, the count limits, the bounds of a lifetime, and the event
// payloads. Each such choice below is the conservative one and is marked
// "Provisional"; the README lists them with their alternatives under "Open
// decisions".

import * as z from "zod";
import type { ApiRoute } from "./auth-api.ts";
import { UtcTimestampSchema } from "./entities.ts";
import { GrantRecordSchema, PermissionGrantSchema } from "./grant.ts";
import { AgentIdSchema, PermissionGrantIdSchema } from "./ids.ts";
import type { ApiErrorCode } from "./model.ts";
import { MAX_ANSWER_LIST_ITEMS } from "./model.ts";

function route(method: ApiRoute["method"], path: string): ApiRoute {
  return Object.freeze({ method, path });
}

/**
 * The grant routes. Every path parameter is an ID, and no route takes a
 * query. Provisional (#75): the paths. A write starts with the agent, as the
 * agent activity routes start with the project: an agent ID names its
 * project and its workspace. The list has no parameter, so a device can only
 * ever ask for its own records.
 */
export const GRANT_ROUTES = Object.freeze({
  /**
   * The grant records of the agents that the calling device hosts: every
   * grant of those agents that is not revoked, each with the facts that the
   * check needs (`GrantRecord`), all read from one snapshot (one statement,
   * or a REPEATABLE READ transaction), so that the answer is one consistent
   * read (ADR 0015, P-76). Any signed-in device; a device that hosts no
   * agent gets an empty list. The server never cuts this list
   * (`GRANT_COUNT_LIMITS`).
   */
  listGrantRecords: route("GET", "/grant-records"),
  /**
   * Grants one capability on one scope to an agent and answers the new
   * grant. The agent's owner only (ADR 0013, P-44), and only from the agent's
   * host device (#75, decision of 2026-11-14), so that no other device of the
   * account, for example one that a taken-over GitHub account registered,
   * can grant a shell on this one. A grant of the same capability on the
   * same scope that is neither revoked nor expired answers `conflict`; an
   * expired one is revoked and replaced in the same transaction (ADR 0015,
   * P-77).
   */
  grantCapability: route("POST", "/agents/:agentId/grants"),
  /**
   * Revokes a grant of the agent, also an expired one. The agent's owner
   * only in version 0 (#75, recommendation 4), from any of the owner's
   * devices. A grant that is already revoked answers `conflict`.
   */
  revokeGrant: route("POST", "/agents/:agentId/grants/:grantId/revoke"),
});
export type GrantRouteName = keyof typeof GRANT_ROUTES;

/** The codes that every grant route can answer, as every membership route can. */
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
 * Every error code that each grant route can answer, with its status from
 * `API_ERROR_STATUS`. Every route can answer `bad_request`, `unauthorized`,
 * `rate_limited` (with `Retry-After`), and `internal_error`. Beyond those:
 *
 * - `not_found`: an agent that does not exist or that is in a workspace that
 *   the account is not an active member of; for a grant, a repository that
 *   is not in the agent's project or a provider connection that is not on
 *   the agent's host device; for a revocation, a grant ID that the agent
 *   does not have. All answer alike, so that a route never tells which IDs
 *   exist.
 * - `forbidden`: the caller is an active member of the agent's workspace but
 *   not the agent's owner, or, for a grant, the owner on a device that is
 *   not the agent's host. Every member already sees the project's agents,
 *   so the code tells nothing new.
 * - `conflict`: what the request names exists, but is not in the state that
 *   the action needs. For a grant: a disabled agent, an archived repository,
 *   project, or workspace, a removed provider connection, or a grant of the
 *   same capability on the same scope that is neither revoked nor expired.
 *   For a revocation: a grant that is already revoked.
 * - `grant_limit`: a grant over a count limit of `GRANT_COUNT_LIMITS`, with
 *   its own code and without `Retry-After` (#75, decision of 2026-11-14).
 * - `rate_limited`, one of the common codes, also answers a grant of an
 *   account that made `GRANT_COUNT_LIMITS.perDay` grants within 24 hours,
 *   with `Retry-After`, after every other refusal (#75, decision of
 *   2026-11-23).
 *
 * Provisional (#75): the other codes.
 */
export const GRANT_ROUTE_ERRORS = Object.freeze({
  listGrantRecords: errors(),
  grantCapability: errors("not_found", "forbidden", "conflict", "grant_limit"),
  revokeGrant: errors("not_found", "forbidden", "conflict"),
} satisfies Record<GrantRouteName, readonly ApiErrorCode[]>);

/**
 * How long a grant with an expiry may live, in seconds: from 1 minute to 365
 * days. Provisional (#75): ADR 0015 (P-71) sets no maximum for the other
 * capabilities; these bounds only keep a lifetime that is sent sensible, and
 * a grant that must live longer is granted without an expiry.
 * `terminal.execute` has its own maximum, `SHELL_GRANT_MAX_LIFETIME_SECONDS`.
 */
export const GRANT_LIFETIME_SECONDS = Object.freeze({
  min: 60,
  max: 31_536_000,
} as const);

/**
 * The longest lifetime of a grant of `terminal.execute`, in seconds: 30 days.
 * Such a grant always has an expiry, from `GRANT_LIFETIME_SECONDS.min` to
 * this value (#75, decision of 2026-11-14, which narrows ADR 0015, P-71, for
 * the shell only). The database holds the same maximum with a CHECK.
 */
export const SHELL_GRANT_MAX_LIFETIME_SECONDS = 2_592_000;

/**
 * How many grants may exist and be made:
 *
 * - `perAgent` and `perHostDevice`: at most 100 grants that are not revoked
 *   for one agent, and at most `MAX_ANSWER_LIST_ITEMS` (1,000) for all the
 *   agents that one device hosts, so that `GET /grant-records` always holds
 *   every one of them and is never cut: a record that is left out would deny
 *   a check. An expired grant counts until it is revoked, as it keeps its
 *   place in the database. A grant over either limit answers its own code,
 *   `grant_limit`, without `Retry-After`, because no time frees a place
 *   (#75, decision of 2026-11-14). Provisional (#75): both values.
 * - `perDay`: at most 200 grants of one account within 24 hours, on all its
 *   agents together, revoked ones included; the renewal of an expired grant
 *   counts as a grant. A grant over it answers `rate_limited` with
 *   `Retry-After`, by the rule of 2026-11-14 for a limit that time frees
 *   (#75, decision of 2026-11-23): every grant sends `agent.grant.created`
 *   to every subscribed member, so the limit bounds what one member makes
 *   the others' devices read, and the growth of the grants.
 *
 * The API applies these values.
 */
export const GRANT_COUNT_LIMITS = Object.freeze({
  perAgent: 100,
  perHostDevice: MAX_ANSWER_LIST_ITEMS,
  perDay: 200,
} as const);

/**
 * The lifetime of a new grant: an integer number of seconds within
 * `GRANT_LIFETIME_SECONDS`, or null for a grant without an expiry.
 */
const grantLifetime = () =>
  z
    .int()
    .min(GRANT_LIFETIME_SECONDS.min)
    .max(GRANT_LIFETIME_SECONDS.max)
    .nullable();

/**
 * The lifetime of a new grant of `terminal.execute`: an integer number of
 * seconds from `GRANT_LIFETIME_SECONDS.min` to
 * `SHELL_GRANT_MAX_LIFETIME_SECONDS`, never null.
 */
const shellGrantLifetime = () =>
  z.int().min(GRANT_LIFETIME_SECONDS.min).max(SHELL_GRANT_MAX_LIFETIME_SECONDS);

// The two forms of a grant, on a repository and on a provider connection.
// The schemas below pick their fields from these, so that a field of a
// request or of an event is always the grant's own field.
const [RepositoryGrantSchema, ProviderConnectionGrantSchema] =
  PermissionGrantSchema.options;

/**
 * `POST /agents/:agentId/grants`: one capability on exactly one scope of the
 * capability's kind, a repository of the agent's project or, for
 * `provider.use`, a provider connection on the agent's host device. Unknown
 * fields are stripped, so a body that names both scopes keeps only the scope
 * of its capability, and a client cannot set the grant's ID, its agent, its
 * granting account, or its times by adding a field.
 *
 * `lifetimeSeconds` is required and has no default: the server sets
 * `expiresAt` to its own time plus the lifetime, and null grants without an
 * expiry. A grant of `terminal.execute` requires an expiry of at most 30 days
 * (`SHELL_GRANT_MAX_LIFETIME_SECONDS`; #75, decision of 2026-11-14, which
 * narrows ADR 0015, P-71, for the shell only). The other capabilities need
 * no expiry, but a grant without one is always an explicit null, never a
 * missing field. The lifetime is relative, so that the clock of the granting
 * device never sets a time on the grant. A refused lifetime is not echoed:
 * an issue names the bound, never the value that was sent.
 */
export const GrantCapabilityRequestSchema = z.discriminatedUnion("capability", [
  RepositoryGrantSchema.pick({ capability: true, repositoryId: true }).extend({
    capability: RepositoryGrantSchema.shape.capability.exclude([
      "terminal.execute",
    ]),
    lifetimeSeconds: grantLifetime(),
  }),
  RepositoryGrantSchema.pick({ capability: true, repositoryId: true }).extend({
    capability: RepositoryGrantSchema.shape.capability.extract([
      "terminal.execute",
    ]),
    lifetimeSeconds: shellGrantLifetime(),
  }),
  ProviderConnectionGrantSchema.pick({
    capability: true,
    providerConnectionId: true,
  }).extend({ lifetimeSeconds: grantLifetime() }),
]);
export type GrantCapabilityRequest = z.infer<
  typeof GrantCapabilityRequestSchema
>;

/**
 * The answer of `POST /agents/:agentId/grants`: the new grant, whole. Only
 * the agent's owner gets it, on the agent's host device, so
 * `grantedByUserId` is the caller's own account and a provider connection
 * is the calling device's own. A new grant is not revoked.
 */
export const GrantCapabilityResponseSchema = z
  .object({ grant: PermissionGrantSchema })
  .superRefine((answer, ctx) => {
    if (answer.grant.revokedAt !== null) {
      ctx.addIssue({
        code: "custom",
        message: "A new grant is not revoked",
        path: ["grant", "revokedAt"],
      });
    }
  });
export type GrantCapabilityResponse = z.infer<
  typeof GrantCapabilityResponseSchema
>;

/**
 * The answer of `GET /grant-records`: the grant records of the agents that
 * the calling device hosts, read from one snapshot (ADR 0015, P-76). The
 * enforcement point passes them to `hasGrant` of `@mymandev/permissions` as
 * they are, and never merges them with records of another read.
 *
 * The schema checks what the route promises, and nothing about whether a
 * grant is active, which only `isGrantActive` decides:
 *
 * - a grant is listed once;
 * - no listed grant is revoked, so `revokedByUserId` is always null;
 * - the answer names one device: every agent fact, host device fact, and
 *   provider connection fact carries the same device ID;
 * - the answer names one account: every grant was granted by the same
 *   account, and every membership fact is that account's. Only the owner
 *   grants (P-44) and the host device is the owner's.
 *
 * The schema cannot know the caller. Whoever reads the answer compares that
 * one device and that one account with its own session.
 *
 * Revoked grants are left out (#75, decision of 2026-11-14), the stated
 * exception to the letter of ADR 0015, P-74. An expired grant stays listed
 * until it is revoked; the device's own clock decides expiry. A record has
 * no repository fact (same decision): the repository is the grant's scope,
 * and archiving a repository revokes its grants (P-77).
 */
export const GrantRecordListResponseSchema = z
  .object({
    records: z.array(GrantRecordSchema).max(MAX_ANSWER_LIST_ITEMS),
  })
  .superRefine((list, ctx) => {
    const first = list.records[0];
    const deviceId = first?.facts.agent.hostDeviceId;
    const userId = first?.grant.grantedByUserId;
    const seen = new Set<string>();
    list.records.forEach(({ grant, facts }, index) => {
      if (seen.has(grant.id)) {
        ctx.addIssue({
          code: "custom",
          message: "A grant is listed once",
          path: ["records", index, "grant", "id"],
        });
      }
      seen.add(grant.id);
      if (grant.revokedAt !== null) {
        ctx.addIssue({
          code: "custom",
          message: "A listed grant is not revoked",
          path: ["records", index, "grant", "revokedAt"],
        });
      }
      if (
        facts.agent.hostDeviceId !== deviceId ||
        facts.hostDevice.id !== deviceId ||
        (facts.providerConnection !== null &&
          facts.providerConnection.hostDeviceId !== deviceId)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Every record belongs to one host device",
          path: ["records", index, "facts"],
        });
      }
      if (
        grant.grantedByUserId !== userId ||
        (facts.grantorMembership !== null &&
          facts.grantorMembership.userId !== userId)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Every record names one account",
          path: ["records", index, "grant", "grantedByUserId"],
        });
      }
    });
  });
export type GrantRecordListResponse = z.infer<
  typeof GrantRecordListResponseSchema
>;

/**
 * A grant as the members of its workspace see it, in `agent.grant.created`:
 * its ID, project, agent, and capability, the repository of a grant on a
 * repository, and when it was created and expires. Its fields are the
 * grant's own, under the same names.
 *
 * It names no account and no device data: neither `grantedByUserId` nor the
 * revocation fields, and for `provider.use` no provider connection, because
 * a connection belongs to the agent's host device, which other accounts
 * never see (#110). The granting person is the agent's owner, whom the
 * agent list shows as `ownerMemberId`. Provisional (#75): these fields.
 */
export const WorkspaceGrantSchema = z
  .discriminatedUnion("capability", [
    RepositoryGrantSchema.pick({
      id: true,
      projectId: true,
      granteeAgentId: true,
      capability: true,
      repositoryId: true,
      createdAt: true,
      expiresAt: true,
    }),
    ProviderConnectionGrantSchema.pick({
      id: true,
      projectId: true,
      granteeAgentId: true,
      capability: true,
      createdAt: true,
      expiresAt: true,
    }),
  ])
  .superRefine((grant, ctx) => {
    if (
      grant.expiresAt !== null &&
      !(Date.parse(grant.expiresAt) > Date.parse(grant.createdAt))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "expiresAt is after createdAt",
        path: ["expiresAt"],
      });
    }
  });
export type WorkspaceGrant = z.infer<typeof WorkspaceGrantSchema>;

/** The payload of `agent.grant.created`: the new grant as members see it. */
export const AgentGrantCreatedPayloadSchema = z.object({
  grant: WorkspaceGrantSchema,
});
export type AgentGrantCreatedPayload = z.infer<
  typeof AgentGrantCreatedPayloadSchema
>;

/**
 * The payload of `agent.grant.revoked`: exactly one grant, its agent, and
 * the time that the server stored as `revoked_at`. It names no account, so
 * it does not say who revoked the grant, and it gives no reason.
 * Provisional (#75): these fields.
 */
export const AgentGrantRevokedPayloadSchema = z.object({
  grantId: PermissionGrantIdSchema,
  granteeAgentId: AgentIdSchema,
  revokedAt: UtcTimestampSchema,
});
export type AgentGrantRevokedPayload = z.infer<
  typeof AgentGrantRevokedPayloadSchema
>;
