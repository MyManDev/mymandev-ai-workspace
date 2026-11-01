import * as z from "zod";
import {
  AgentIdSchema,
  CorrelationIdSchema,
  DeviceIdSchema,
  MemberIdSchema,
  MessageIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RunIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "./ids.ts";
import {
  CAPABILITIES,
  DEVICE_PLATFORMS,
  LIMITS,
  NOT_BLANK_PATTERN,
  RUN_STATES,
  SAFE_MULTILINE_TEXT_PATTERN,
  SAFE_TEXT_PATTERN,
} from "./model.ts";
import { privatePattern } from "./private-pattern.ts";

const safeTextPattern = privatePattern(SAFE_TEXT_PATTERN);
const safeMultilineTextPattern = privatePattern(SAFE_MULTILINE_TEXT_PATTERN);
const notBlankPattern = privatePattern(NOT_BLANK_PATTERN);

/**
 * Human-entered text that other devices render, from 1 to `maxLength`
 * characters. Always render it as text, never as markup.
 * Text over the limit stops validation before the patterns run, because a
 * pattern over a very long string can overflow the stack.
 */
export function displayText(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength, { abort: true })
    .regex(safeTextPattern, "Contains control, format or invisible characters")
    .regex(notBlankPattern, "Must not be blank");
}

/**
 * Like `displayText`, but the text may also hold line feeds and tabs, for
 * example a chat message. Always render it as text, never as markup.
 */
export function multilineText(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength, { abort: true })
    .regex(
      safeMultilineTextPattern,
      "Contains control, format or invisible characters",
    )
    .regex(notBlankPattern, "Must not be blank");
}

/** ISO 8601 in UTC with a Z suffix and exactly three fractional digits. */
export const UtcTimestampSchema = z.iso.datetime({ precision: 3 });

/** One capability name, matched exactly. An unknown name rejects the message. */
export const CapabilitySchema = z.enum(CAPABILITIES);

export const RunStateSchema = z.enum(RUN_STATES);

export const DevicePlatformSchema = z.enum(DEVICE_PLATFORMS);

/** A person. Handle, email and credentials wait for the account model (#15). */
export const UserSchema = z.object({
  id: UserIdSchema,
  displayName: displayText(LIMITS.displayName),
});
export type User = z.infer<typeof UserSchema>;

/** One desktop installation, owned by exactly one user. The server issues the ID. */
export const DeviceSchema = z.object({
  id: DeviceIdSchema,
  userId: UserIdSchema,
  label: displayText(LIMITS.deviceLabel),
  platform: DevicePlatformSchema,
});
export type Device = z.infer<typeof DeviceSchema>;

/**
 * The membership, security and routing boundary. Membership grants visibility
 * only, never a capability. A workspace ID is not a join secret.
 */
export const WorkspaceSchema = z.object({
  id: WorkspaceIdSchema,
  name: displayText(LIMITS.name),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** Holds repositories, agents, conversations and runs. */
export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  workspaceId: WorkspaceIdSchema,
  name: displayText(LIMITS.name),
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * A logical repository registered in a project. The local path never leaves
 * the device, because paths contain operating system user names.
 */
export const RepositorySchema = z.object({
  id: RepositoryIdSchema,
  projectId: ProjectIdSchema,
  name: displayText(LIMITS.name),
});
export type Repository = z.infer<typeof RepositorySchema>;

/** An agent runs on its host device, where provider credentials stay. */
export const AgentSchema = z.object({
  id: AgentIdSchema,
  projectId: ProjectIdSchema,
  ownerUserId: UserIdSchema,
  hostDeviceId: DeviceIdSchema,
  name: displayText(LIMITS.agentName),
});
export type Agent = z.infer<typeof AgentSchema>;

/** One run of an agent. A retry is a new run, linked through `correlationId`. */
export const AgentRunSchema = z.object({
  id: RunIdSchema,
  agentId: AgentIdSchema,
  projectId: ProjectIdSchema,
  repositoryId: RepositoryIdSchema.optional(),
  requestedBy: UserIdSchema,
  state: RunStateSchema,
  correlationId: CorrelationIdSchema.optional(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

/**
 * One message of a project's chat (#110). The server generates the ID and
 * the time when it stores the message; storing and the history route belong
 * to #27. The author is shown through their person row, also after they
 * were removed (ADR 0014, "People and roles").
 */
export const ChatMessageSchema = z.object({
  id: MessageIdSchema,
  projectId: ProjectIdSchema,
  /** The person who wrote the message, in the project's workspace. */
  authorMemberId: MemberIdSchema,
  body: multilineText(LIMITS.messageBody),
  createdAt: UtcTimestampSchema,
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
