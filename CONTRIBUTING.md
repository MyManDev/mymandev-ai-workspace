# Contributing

MyManDev AI Workspace uses small, issue-driven changes and explicit ownership.

Read first:

- CLAUDE.md
- docs/process/OWNERSHIP.md
- docs/process/WORKFLOW.md
- docs/process/ROADMAP.md

## Branches

develop is the integration branch.
main is the release branch.

Do not implement features directly on develop or main.

Use task branches created from fresh origin/develop.

Allowed branch prefixes:

- feature/
- fix/
- docs/
- chore/
- test/

## Pull requests

One topic per pull request.

Keep changes small enough to review without reconstructing unrelated work.

A pull request should explain:

- What this does
- Why
- What this does not do
- Checks
- Related issue

## Commits

Use Conventional Commits.

Examples:

- feat(protocol): define agent run events
- fix(runtime): reject unauthorized repository writes
- docs(workflow): document task handoff
- chore(database): establish migration baseline

Never add AI attribution or AI co-author trailers.

## Ownership

Ownership means default implementation responsibility and review authority.
It does not mean exclusive access.

The Project Manager may reassign tasks when needed.

## Verification

Every pull request must state what was actually checked.

A focused test may be used during implementation, but it must not be presented as full verification.
