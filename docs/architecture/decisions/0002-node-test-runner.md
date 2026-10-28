# ADR 0002: node:test is the test runner; the root delegates

- Status: Accepted (2026-10-28)
- Date: 2026-10-27
- Decided by: Project Manager

## Context

No test runner exists. The three M1 workspaces run on Node.js. The desktop may later need DOM and `.tsx` tests. npm 11 cannot delegate a script when no workspace exists: every form, including `--if-present` and `--include-workspace-root`, fails with `No workspaces found!`. The root `test` delegation can therefore only land together with the first workspace, exactly like the root `typecheck` delegation.

## Options considered

| Option                                           | Result                                                                                                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:test` (built in), one script per workspace | No dependency. Runs `.ts` tests directly through type stripping. The quoted glob works through `cmd.exe`. Excludes `node_modules`. Exits with 0 when nothing matches. No `.tsx`; module mocking is experimental. |
| Vitest in each workspace that wants it           | Works on Windows with source exports. Requires `vite` as a non-optional peer, which pulls in Vite and Rolldown native bindings (about 63 packages and 42 MB). Fits a bundled workspace.                          |
| Vitest at the root                               | Adds Vite to the root and can choose a different Vite than the desktop. A root-level `node --test` would also execute Vitest files and fail.                                                                     |

## Decision

- Every Node-side workspace uses `node:test` with the script `"test": "node --test \"src/**/*.test.ts\""`. Tests sit next to the code as `src/**/*.test.ts`.
- The root gets `"test": "npm run test --workspaces --if-present"` in M1-01. A workspace without a `test` script is skipped.
- Tests use dependency injection rather than module mocks. `mock.module` needs `--experimental-test-module-mocks` and already prints a deprecation warning on Node.js 24.
- A bundled workspace (`apps/desktop`, a future `packages/ui`) may choose Vitest in its own `devDependencies`, matched to its Vite version. Vitest never goes into the root `package.json`, and nobody runs `node --test` at the root.
- A workspace `test` script runs once and exits. With Vitest that means `"test": "vitest run"`: plain `vitest` enters watch mode in an interactive terminal and would block the root `npm run check`.
- `node --test` exits with 0 when its pattern matches no file. Every acceptance check therefore states the expected number of tests, and the reviewer compares it with the `tests` count in the output.
- Coverage (`--experimental-test-coverage`) is optional and not a gate.
- The root `check` script also runs the tests, so the CI workflow proposed in PR #46 runs them on all three operating systems for every pull request that the workflow covers: `"check": "npm run format:check && npm run lint && npm run typecheck && npm test"`.

## Consequences

- Zero test dependencies in M1. A workspace test run takes well under a second for the protocol.
- With a failing test, npm still runs the other workspaces, and the root exits with 1.
- No `.tsx` tests under `node:test`. That is the desktop's concern and is handled by the Vitest exception.
- As proposed in PR #46, the CI workflow covers only pull requests into `develop` or `main`. Stacked pull requests run `npm ci` and `npm run check` locally and report the result until they are retargeted (P-45).

## Dependency policy

- No dependency: `node:test` ships with Node.js 24.
- Only if the desktop opts in, and only in `apps/desktop`: Vitest, pinned exactly and matched to the desktop's Vite version.

## Evidence

- Root scripts: [`package.json`](../../../package.json); documented in [WORKSPACE.md, Root test delegation](../../development/WORKSPACE.md#root-test-delegation) and [Tests](../../development/WORKSPACE.md#tests).
- First workspace with tests: [`packages/protocol/package.json`](../../../packages/protocol/package.json) and `packages/protocol/src/*.test.ts` (15 tests).
- Review record: M1 Technical Decision Set, revision 2 of 2026-10-27 (ADR 0002), linked from the M1-01 pull request.

## Needs Project Manager decision

Answered by the Project Manager on 2026-10-28.

- Accept `node:test` and the root `test` delegation in M1-01 (P-03).
  - Accepted.
- Decide whether `check` runs the tests, which makes CI run them (P-04, recommended: yes; implemented in M1-01).
  - Yes, as implemented in M1-01.
