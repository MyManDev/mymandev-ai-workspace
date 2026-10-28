import * as z from "zod";
import {
  AgentIdSchema,
  CAPABILITIES,
  CapabilitySchema,
  DeviceIdSchema,
  PermissionGrantIdSchema,
  ProjectIdSchema,
  ProviderConnectionIdSchema,
  RepositoryIdSchema,
  UserIdSchema,
  UtcTimestampSchema,
  WorkspaceIdSchema,
} from "@mymandev/protocol";
import {
  CAPABILITY_SCOPE,
  type ProviderConnectionCapability,
  type RepositoryCapability,
} from "./capabilities.ts";

// These lists stay private, so that the contract offers no ready-made bundle
// of capabilities to grant together.
const REPOSITORY_CAPABILITIES: readonly RepositoryCapability[] = Object.freeze(
  CAPABILITIES.filter(
    (capability): capability is RepositoryCapability =>
      CAPABILITY_SCOPE[capability] === "repository",
  ),
);
const PROVIDER_CONNECTION_CAPABILITIES: readonly ProviderConnectionCapability[] =
  Object.freeze(
    CAPABILITIES.filter(
      (capability): capability is ProviderConnectionCapability =>
        CAPABILITY_SCOPE[capability] === "provider_connection",
    ),
  );

const RepositoryCapabilitySchema = CapabilitySchema.extract(
  REPOSITORY_CAPABILITIES,
);
const ProviderConnectionCapabilitySchema = CapabilitySchema.extract(
  PROVIDER_CONNECTION_CAPABILITIES,
);

// The fields of every grant except the capability and its scope. The names
// equal the Drizzle property names of the permission_grants table.
const grantHeaderShape = {
  id: PermissionGrantIdSchema,
  projectId: ProjectIdSchema,
  granteeAgentId: AgentIdSchema,
  grantedByUserId: UserIdSchema,
  createdAt: UtcTimestampSchema,
  /** null means that the grant does not expire. */
  expiresAt: UtcTimestampSchema.nullable(),
  revokedAt: UtcTimestampSchema.nullable(),
  revokedByUserId: UserIdSchema.nullable(),
};

/**
 * One grant gives one capability to one agent on exactly one scope: a
 * repository, or a provider connection for `provider.use`. There is no
 * wildcard, role or level. A grant never carries a credential.
 *
 * The refinement mirrors the database CHECK constraints: `revokedAt` and
 * `revokedByUserId` are set together, and `expiresAt` is after `createdAt`.
 * Unknown keys are stripped, so a grant that names both scopes keeps only the
 * scope of its own capability.
 */
export const PermissionGrantSchema = z
  .discriminatedUnion("capability", [
    z.object({
      ...grantHeaderShape,
      capability: RepositoryCapabilitySchema,
      repositoryId: RepositoryIdSchema,
    }),
    z.object({
      ...grantHeaderShape,
      capability: ProviderConnectionCapabilitySchema,
      providerConnectionId: ProviderConnectionIdSchema,
    }),
  ])
  .superRefine((grant, ctx) => {
    if ((grant.revokedAt === null) !== (grant.revokedByUserId === null)) {
      ctx.addIssue({
        code: "custom",
        message: "revokedAt and revokedByUserId are set together",
        path: ["revokedByUserId"],
      });
    }
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
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;

/**
 * The current state of the entities that decide whether a grant is active.
 * Every fact names the entity it describes, so a fact about another entity
 * makes the grant inactive.
 *
 * - `agent`: the grantee agent and its host device.
 * - `hostDevice`: the agent's host device.
 * - `project`: the grant's project and its workspace.
 * - `grantorMembership`: the granting user's current membership in the
 *   workspace of the grant's project, or null when there is none.
 */
export const GrantFactsSchema = z.object({
  agent: z.object({
    id: AgentIdSchema,
    hostDeviceId: DeviceIdSchema,
    disabledAt: UtcTimestampSchema.nullable(),
  }),
  hostDevice: z.object({
    id: DeviceIdSchema,
    revokedAt: UtcTimestampSchema.nullable(),
  }),
  project: z.object({
    id: ProjectIdSchema,
    workspaceId: WorkspaceIdSchema,
  }),
  grantorMembership: z
    .object({
      workspaceId: WorkspaceIdSchema,
      userId: UserIdSchema,
      removedAt: UtcTimestampSchema.nullable(),
    })
    .nullable(),
});
export type GrantFacts = z.infer<typeof GrantFactsSchema>;

/** A grant together with the facts it is judged on, read together. */
export const GrantRecordSchema = z.object({
  grant: PermissionGrantSchema,
  facts: GrantFactsSchema,
});
export type GrantRecord = z.infer<typeof GrantRecordSchema>;

/**
 * A request for one capability by one agent on exactly one scope of that
 * capability's kind: `{ agentId, capability, repositoryId |
 * providerConnectionId }` (ADR 0008). Unknown keys are stripped, so an extra
 * scope cannot widen a check.
 */
export const PermissionRequestSchema = z.discriminatedUnion("capability", [
  z.object({
    agentId: AgentIdSchema,
    capability: RepositoryCapabilitySchema,
    repositoryId: RepositoryIdSchema,
  }),
  z.object({
    agentId: AgentIdSchema,
    capability: ProviderConnectionCapabilitySchema,
    providerConnectionId: ProviderConnectionIdSchema,
  }),
]);
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;
