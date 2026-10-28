# ADR 0005: Workspaces contain projects

- Status: Accepted (2026-10-28)
- Date: 2026-10-27
- Decided by: Project Manager

## Context

The product description lets people "meet in a shared workspace ID". The roadmap talks about projects, project chat (M2-03), and "the same workspace" and "the same project events" (M2-05). The event envelope must carry the routing and security boundary. The invitation and join flow is an open decision (#14), and so is the account model (#15).

## Options considered

1. Two levels: a workspace contains projects. The workspace is the membership, security, and routing boundary; a project holds repositories, agents, conversations, and runs.
2. One level: a workspace and a project are the same thing.

## Decision

Option 1. The protocol v0 entities are:

| Entity     | Fields                                                                                  | Notes                                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User       | `id`, `displayName` (1 to 64 characters)                                                | No handle, email, or credentials until #15 is decided.                                                                                                                                       |
| Device     | `id`, `userId`, `label` (1 to 64), `platform` (`windows`, `macos`, `linux`)             | One desktop installation, owned by exactly one user. The server issues the ID at registration.                                                                                               |
| Workspace  | `id`, `name` (1 to 100)                                                                 | Membership boundary. The envelope carries `workspaceId`.                                                                                                                                     |
| Project    | `id`, `workspaceId`, `name` (1 to 100)                                                  | Holds repositories, agents, conversations, and runs.                                                                                                                                         |
| Repository | `id`, `projectId`, `name` (1 to 100)                                                    | Logical repository registered in a project. The local path never leaves the device, because paths contain operating system user names. The remote URL is deferred to the M1-05 coordination. |
| Agent      | `id`, `projectId`, `ownerUserId`, `hostDeviceId`, `name` (1 to 64)                      | Runs on its host device, where provider credentials stay. The provider kind is deferred to M3.                                                                                               |
| Agent run  | `id`, `agentId`, `projectId`, `repositoryId?`, `requestedBy`, `state`, `correlationId?` | `requestedBy` is a `UserId`. Lifecycle in [ADR 0007](0007-agent-run-lifecycle-v0.md).                                                                                                        |

Rules:

- Workspace membership grants visibility only. It never implies a capability ([ADR 0008](0008-capability-vocabulary-v0.md)).
- A workspace ID is not a join secret. Joining requires a separate invitation token (32 bytes from `crypto.randomBytes`, base64url, stored only as a SHA-256 hash, expiring, revocable; [ADR 0004](0004-uuidv7-identifiers.md)) and a server-side membership check. The token design belongs to #14.
- All human-entered text (`displayName`, `label`, `name`, run `reason`) is always rendered as text, never as markup, and rejects:
  - control characters (Cc);
  - format characters (Cf), which include the bidirectional controls, U+200B, U+FEFF, U+00AD, and the invisible tag characters U+E0000 to U+E007F that an AI model still reads;
  - lone surrogates (Cs) and private-use characters (Co);
  - line and paragraph separators (Zl, Zp);
  - every other default-ignorable code point (Hangul fillers, U+034F, variation selectors);
  - text that is empty or only white space.

  Allowed exceptions: U+200C (ZWNJ, needed for Persian and Indic scripts), U+200D (ZWJ, emoji sequences and Indic scripts), and U+FE0E and U+FE0F (emoji presentation). Trade-off: subdivision flags made of tag characters (England, Scotland, Wales) are rejected.

## Consequences

- M1-03 needs two tables that issue #21 does not list: `workspaces` and `workspace_members` (P-12).
- Per-project authorization can be added later without changing the envelope.
- Names are labels, not identity, so M1 adds no uniqueness constraint on names.

## Dependency policy

No new dependency.

## Evidence

- [`packages/protocol/src/entities.ts`](../../../packages/protocol/src/entities.ts) and the text rule `SAFE_TEXT_PATTERN` with `LIMITS` in [`packages/protocol/src/model.ts`](../../../packages/protocol/src/model.ts).
- [`packages/protocol/src/entities.test.ts`](../../../packages/protocol/src/entities.test.ts): accepted scripts and emoji sequences, and every rejected character class, all written as escapes.
- Review record: [M1 Technical Decision Set](../research/m1-technical-decision-set.md), revision 2 of 2026-10-27 (ADR 0005, Section 2.5).

## Needs Project Manager decision

Answered by the Project Manager on 2026-10-28.

- Two levels, workspace and project (recommended), or one level (P-11).
  - Two levels.
- Add `workspaces` and `workspace_members` to M1-03 (P-12).
  - Yes.
- Confirm that a workspace ID is not a join secret and that joining needs an invitation token plus a membership check (P-13; detailed design in #14).
  - Confirmed. The join flow is decided in issue #14.
