import { v7 as uuidv7 } from "uuid";
import * as z from "zod";
import { UUIDV7_PATTERN } from "./model.ts";

// z.uuidv7() is case-insensitive, so IDs use the strict lowercase pattern.
function uuidV7String() {
  return z.string().regex(UUIDV7_PATTERN, "Expected a lowercase UUIDv7");
}

export const UserIdSchema = uuidV7String().brand<"UserId">();
export type UserId = z.infer<typeof UserIdSchema>;

export const DeviceIdSchema = uuidV7String().brand<"DeviceId">();
export type DeviceId = z.infer<typeof DeviceIdSchema>;

export const WorkspaceIdSchema = uuidV7String().brand<"WorkspaceId">();
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;

export const ProjectIdSchema = uuidV7String().brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectIdSchema>;

export const RepositoryIdSchema = uuidV7String().brand<"RepositoryId">();
export type RepositoryId = z.infer<typeof RepositoryIdSchema>;

export const AgentIdSchema = uuidV7String().brand<"AgentId">();
export type AgentId = z.infer<typeof AgentIdSchema>;

export const RunIdSchema = uuidV7String().brand<"RunId">();
export type RunId = z.infer<typeof RunIdSchema>;

export const EventIdSchema = uuidV7String().brand<"EventId">();
export type EventId = z.infer<typeof EventIdSchema>;

export const CorrelationIdSchema = uuidV7String().brand<"CorrelationId">();
export type CorrelationId = z.infer<typeof CorrelationIdSchema>;

/** Every branded ID kind. */
export type AnyId =
  | UserId
  | DeviceId
  | WorkspaceId
  | ProjectId
  | RepositoryId
  | AgentId
  | RunId
  | EventId
  | CorrelationId;

/**
 * Generates a new lowercase UUIDv7 string, for IDs that have no branded kind
 * yet. Never use it for a secret: an ID is not a capability, and a UUIDv7
 * reveals its creation time.
 */
export function newUuidV7(): string {
  return uuidv7();
}

/**
 * Generates a new lowercase UUIDv7 for one ID kind, for example
 * `newId<EventId>()`. Never use it for a secret: an ID is not a capability,
 * and a UUIDv7 reveals its creation time.
 */
export function newId<T extends AnyId>(): T {
  return uuidv7() as T;
}
