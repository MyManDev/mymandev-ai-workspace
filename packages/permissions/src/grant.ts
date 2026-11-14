import * as z from "zod";
import {
  AgentIdSchema,
  CAPABILITIES,
  CAPABILITY_SCOPE,
  CapabilitySchema,
  ProviderConnectionIdSchema,
  RepositoryIdSchema,
  type ProviderConnectionCapability,
  type RepositoryCapability,
} from "@mymandev/protocol";

// The shape of a grant, of its facts, and of a grant record is defined in
// `@mymandev/protocol` since #75, because whole grants and grant records
// travel on the wire and the protocol can never import this package. They
// are re-exported here under the same names: the same schema objects, not
// copies.
export {
  GrantFactsSchema,
  GrantRecordSchema,
  PermissionGrantSchema,
} from "@mymandev/protocol";
export type {
  GrantFacts,
  GrantRecord,
  PermissionGrant,
} from "@mymandev/protocol";

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
