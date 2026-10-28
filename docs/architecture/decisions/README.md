# Architecture decision records

This directory records architecture decisions for MyManDev AI Workspace. Each record explains one decision, the options that were considered, and the consequences. Architecture documents are a shared boundary; see [OWNERSHIP.md](../../process/OWNERSHIP.md).

A record starts with Status: Proposed. The Project Manager accepts it; the status then becomes Accepted with the date, and "Needs Project Manager decision" records the answers. A later record can supersede an accepted one.

ADRs 0001 to 0013 were reviewed together. Their research, experiments, and review points are kept in the [M1 Technical Decision Set](../research/m1-technical-decision-set.md).

## Index

| ADR                                                        | Title                                                | Status   |
| ---------------------------------------------------------- | ---------------------------------------------------- | -------- |
| [0001](0001-internal-packages-export-typescript-source.md) | Internal workspace packages export TypeScript source | Accepted |
| [0002](0002-node-test-runner.md)                           | node:test is the test runner; the root delegates     | Accepted |
| [0003](0003-zod-runtime-validation.md)                     | zod 4 is the runtime validation library              | Accepted |
| [0004](0004-uuidv7-identifiers.md)                         | Identifiers are lowercase UUIDv7                     | Accepted |
| [0005](0005-workspaces-contain-projects.md)                | Workspaces contain projects                          | Accepted |
| [0006](0006-event-envelope-v0.md)                          | Event envelope v0, decoding and versioning           | Accepted |
| [0007](0007-agent-run-lifecycle-v0.md)                     | Agent run lifecycle v0                               | Accepted |
| [0008](0008-capability-vocabulary-v0.md)                   | Capability vocabulary v0                             | Accepted |
| [0009](0009-fastify-cloud-api.md)                          | Fastify 5 for the cloud API, with hardened defaults  | Accepted |
| [0010](0010-api-configuration-and-runtime.md)              | API configuration, runtime and shutdown              | Accepted |
| [0011](0011-drizzle-sql-migrations.md)                     | Drizzle ORM with generated SQL migrations            | Accepted |
| [0012](0012-pglite-database-tests.md)                      | Database tests run on in-process PGlite              | Accepted |
| [0013](0013-m1-data-model.md)                              | M1 data model conventions and the M1-03 tables       | Accepted |
| [0015](0015-capability-and-permission-contract-v0.md)      | Capability and permission contract v0                | Accepted |

## Numbering

Records are numbered in sequence and never renumbered. A new record takes the next free number when it is merged. A number that a record in an open pull request already uses is not free, so records can be merged in a different order than their numbers (ADR 0015, P-81). New records are appended to the index; existing lines are not reordered.

## Writing a record

- File name: `NNNN-short-title.md`, in lowercase with hyphens.
- Use the template below. Prettier formats the file.
- A record keeps the decision and its reasons, which do not change with every patch release. It states the dependency policy (library, major version, pin rule) and links to the code and tests that implement the decision, instead of copying code or exact versions. Exact versions live in `package.json` and `package-lock.json`.

## Template

```markdown
# ADR NNNN: Title

- Status: Proposed | Accepted | Superseded by ADR NNNN
- Date: YYYY-MM-DD
- Decided by: (filled in by the Project Manager on acceptance)

## Context

## Options considered

## Decision

## Consequences

## Dependency policy

Library, major version and pin rule only. Exact versions live in package.json and package-lock.json.

## Evidence

Links to the files and tests that implement the decision, and to the review record.

## Needs Project Manager decision
```
