# ADR 0005: Workspaces contain projects

- Status: Accepted (2026-10-28)
- Amended by [ADR 0014](0014-accounts-devices-and-invitations.md)
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
- Update of 2026-11-01 (#110): chat message bodies, and only they, also allow the line feed (U+000A) and the tab (U+0009), so that a message can span lines and hold indented code. The carriage return and every other control character stay refused, so a line break is sent as a single line feed. Every other rule above applies to chat message bodies unchanged. The protocol checks it with `multilineText` and `SAFE_MULTILINE_TEXT_PATTERN`. This exception awaits the Project Manager's confirmation. The text above is unchanged.
- Update of 2026-11-02 (#110): the Project Manager confirmed the exception of the update of 2026-11-01, the line feed and the tab in chat message bodies. The text above is unchanged.
- Update of 2026-11-02 (#27, #28): a chat message names its author as a person or an agent of the project, `{ kind: "member", memberId }` or `{ kind: "agent", agentId }`, and servers of M2 send only `member`. The list of a project's agents that every member reads shows each agent's `id`, `projectId`, `name`, the owner's person (`ownerMemberId`), and `disabledAt`, but not `hostDeviceId`, so that other accounts never see the host device (#110), and names the owner by person instead of `ownerUserId`, because inside a workspace a user is always shown through their person row (ADR 0014). The text above is unchanged.
- Update of 2026-11-02 (#155): the Project Manager decided the first project API. Any active member of a workspace may create a project in it; the project's creator, the workspace owner, and admins may rename it; archiving comes later. A project's name is normalized to Unicode NFC and trimmed of white space at the start and the end before the 1 to 100 characters are checked, which workspace and person names are not, and it is now unique among the workspace's projects that are not archived, compared without regard to case (Unicode's simple lowercase mapping, `lower` with the built-in `pg_c_utf8` collation), so the Consequence "M1 adds no uniqueness constraint on names" no longer holds for projects; workspace, repository, and agent names stay labels. A workspace holds at most 100 projects that are not archived, and an account creates at most 20 projects in 24 hours. The project routes and `workspace.project.created` show a project with its creator, `createdByMemberId`, and the right to rename follows the creating account, also after it rejoined. The server reports the changes as `workspace.project.created` and `workspace.project.renamed`. The text above is unchanged.
- Update of 2026-11-14 (#286): the Project Manager decided on 2026-11-14 that the cloud registers a repository for a project, an identity and a name, and that the folder's path stays on the device, which keeps its own map from `RepositoryId` to the path. The Repository entity above stays as it is: `id`, `projectId`, and `name`, with no path, and the remote URL stays deferred, so no route, answer, or event carries either; the `repositories` table of ADR 0013 is unchanged. The first repository API registers a repository in a project, lists a project's repositories, and removes one, under `/projects/:projectId/repositories`, and the server reports the changes as `workspace.repository.registered` and `workspace.repository.removed` to the workspace's subscribers. The answers and the first event show a repository with who registered it, `createdByMemberId`. The following is provisional: it is applied with the conservative option, as the first project API settled it, and awaits the Project Manager's confirmation. Any active member of the project's workspace registers a repository; the registering account, the workspace owner, and admins remove it. A project holds at most 20 repositories that are not removed, which answers `409` with the new code `repository_limit` and no `Retry-After`, as the limit of projects does (ADR 0014, update of 2026-11-10, #255), and an account registers at most 20 repositories in 24 hours, which answers `rate_limited`. A repository's name stays a label, stored as sent, not normalized and not unique, and as sent it holds no slash and no backslash, so that neither a folder's path nor a remote URL travels as a name. A removal sets `archived_at`, deletes nothing, and revokes the grants scoped to the repository in the same transaction (ADR 0015, P-77), which is what keeps a grant on a removed repository from granting, because the Project Manager decided on 2026-11-14 that a grant record has no repository fact (#75); it cancels no run, and it sends no `agent.grant.revoked` until the grant routes send them for every change that revokes grants (#75). The contract is in the protocol README, "Repository routes". This is a protocol change before protocol version 1 (#29). The text above is unchanged.
- Update of 2026-11-17 (#286): the Project Manager decided two provisional points of the update of 2026-11-14 on that day: a project at its limit of repositories answers with its own code, `repository_limit`, and the account that registered a repository, the workspace owner, and admins remove it, while any active member registers one. The other points stay provisional. The desktop links a registered repository to a folder on the device and keeps that map only on the device, in its local data folder, which a roaming Windows profile does not copy (`%LOCALAPPDATA%`); the map names the repository, its project and workspace, the account's own person in the workspace, and the folder, and also stores the device and file numbers that identify the folder and its common Git folder. The text above is unchanged.
- Update of 2026-11-17 (#286), later that day: the Project Manager accepted the other points of the update of 2026-11-14 as proposed, so none of them stays provisional: a project holds at most 20 repositories that are not removed and an account registers at most 20 repositories in 24 hours, a name as sent holds no slash and no backslash, the routes lie under `/projects/:projectId/repositories`, the events carry the payloads of the protocol README, and a removal deletes nothing, revokes the repository's grants in its transaction, cancels no run, and sends no `agent.grant.revoked` until the grant routes send them (#75). The limits may be tuned with use, as ADR 0014 says for other limits (P-64). The text above is unchanged.
