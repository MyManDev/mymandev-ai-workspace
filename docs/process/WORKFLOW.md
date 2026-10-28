# Development Workflow

## Branch model

develop is the integration branch.
main is the release branch.

Normal development flow:

```text
origin/develop
  -> task branch/worktree
  -> pull request
  -> develop
  -> release review
  -> main
```

## Start a task

Update the main checkout first:

```sh
git switch develop
git fetch origin
git pull --ff-only origin develop
```

Then create a dedicated worktree:

```sh
git worktree add -b feature/example-task ../mymandev-ai-workspace-example-task origin/develop
```

Implementation happens inside the worktree.
The main checkout stays clean and remains the integration checkout.

## Task scope

Every task should define:

- Why
- What to change
- Finished when

Do not silently expand scope.
If unrelated work appears, create or propose a follow-up task.

## Parallel development

Prefer task assignments where @SpeedyV5 and @ErtugrulS32175 do not edit the same files.

When two tasks depend on a shared contract:

1. agree on the contract
2. land the contract
3. continue independent implementations

Do not build incompatible versions of the same shared boundary.

## Update a task branch

Do not rebase a pushed task branch.

Use:

```sh
git fetch origin
git merge origin/develop
```

## Task handoff

Tasks are intentionally transferable.

If one developer is busy or blocked, the Project Manager may reassign the issue.

The previous owner should leave:

- current branch
- latest relevant commit
- completed work
- remaining work
- tests already run
- known problems
- next recommended action

## Pull requests

Target develop.

One pull request, one topic.

Every pull request should contain:

- What this does
- Why
- What this does not do
- Checks
- Related issue

## GitHub authority

AI assistants may prepare drafts.

Publishing GitHub text, approving, merging, tagging, releasing, or changing repository settings requires human authority.

## Release

main represents released history.

A release is a separate decision from merging development work into develop.

The Project Manager owns release approval.
