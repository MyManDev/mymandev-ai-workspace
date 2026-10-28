# ADR 0001: Internal workspace packages export TypeScript source

- Status: Accepted (2026-10-28)
- Date: 2026-10-27
- Decided by: Project Manager

## Context

M1 creates three Node-side workspaces: `packages/protocol`, `apps/api`, and `packages/database`. The desktop application (`apps/desktop`, #3) is built in parallel and has not chosen a bundler yet. A clean checkout must type-check, test, and run directly after `npm ci`.

- Node.js 24 runs `.ts` files through built-in type stripping. The Node.js 24 documentation marks it as stable: it is on by default since v23.6.0, prints no warning since v24.3.0, and is stable since v24.12.0. The `engines` range `^24.15.0` covers it.
- Type stripping refuses files under `node_modules`. An npm workspace link is a junction on Windows and a symbolic link elsewhere. Node.js resolves it to the real path (`packages/<name>/...`), which is outside `node_modules`, so type stripping applies.
- npm runs `--workspaces` scripts in directory order (`apps/*` before `packages/*`), not in dependency order.

## Options considered

| Option                                                                   | Result                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Source exports: `"exports": { ".": "./src/index.ts" }`                | A clean checkout type-checks, tests, and runs. Vite and esbuild bundle it without configuration. `node --watch` restarts when a linked package changes.                                                     |
| 2. Compiled `dist` per package with `tsc`                                | A clean checkout fails until a build runs (TS2307, `ERR_MODULE_NOT_FOUND`). `npm run build --workspaces` built a consumer before its dependency and failed on the first run. Needs a hand-kept build order. |
| 3. Project references with `tsc -b`                                      | Correct build order, but it emits `dist` and `tsconfig.tsbuildinfo`, needs `composite` and `references` kept in sync with `package.json`, and plain `tsc -p` still fails on a clean tree.                   |
| 4. Custom export condition (source in development, `dist` in production) | Every `node`, `tsc`, and bundler invocation needs the condition, and it keeps every `dist` ordering problem of option 2.                                                                                    |

## Decision

Option 1 for every `packages/*` workspace:

- `package.json` sets `"type": "module"`, `"private": true`, and `"exports": { ".": "./src/index.ts" }`. Further subpaths are added only as deliberate public API when a consumer needs them; M1 adds none. A package without side effects also sets `"sideEffects": false`.
- Internal workspaces stay at version `0.0.0`, and dependents record exactly `"0.0.0"`. If the two drift apart, npm looks the package up on the public registry, and whoever owns the `@mymandev` scope there could publish a matching version.
- Relative imports include the `.ts` extension (`./envelope.ts`). A `./envelope.js` import fails at runtime with `ERR_MODULE_NOT_FOUND`.
- Type-only imports use `import type`, enforced by `verbatimModuleSyntax` (TS1484 otherwise; Node.js would fail with "does not provide an export named").
- Only erasable syntax: no `enum`, no runtime `namespace`, no parameter properties, and no decorators. `erasableSyntaxOnly` turns these into TS1294 at type-check time; Node.js would fail with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
- No `paths` in `tsconfig.json`. Workspaces import each other only by package name.
- Every Node-side workspace uses the same compiler options: `target` and `lib` `es2025` (like the root `tsconfig.json`), `module` and `moduleResolution` `nodenext`, `types: ["node"]`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `allowImportingTsExtensions`, and `noEmit`.
- An environment-agnostic package (the protocol now, later any package that the desktop renderer imports) adds `tsconfig.src.json` with `types: []` and an explicit `lib` at the agreed renderer language level, and excludes the tests. Its `typecheck` runs both configurations, so a Node.js global such as `process` in `src` fails in the package's own check (TS2591), and so does a language feature newer than the renderer level (TS2550, TS2693), instead of failing later in the desktop check. The proposed renderer level is ES2024.
- Consumers:
  - Node.js applications run their source directly: `node src/server.ts`.
  - A bundled consumer (the desktop renderer) sets `moduleResolution: "bundler"`, `allowImportingTsExtensions: true`, and `noEmit: true`. Its `target` and `lib` stay at or above the level in the package's `tsconfig.src.json`. The Electron main and preload code that imports a workspace package is bundled too; running it unbundled was not verified.

## Consequences

- No `dist`, no build order, and no stale output. Go to definition opens the source.
- A workspace package must never become a real directory under `node_modules`: it is not published, not packed, not copied with dereferenced links, and not run with `--preserve-symlinks`. Each of these fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. A future deployment must keep the workspace layout or bundle the application.
- Each consumer type-checks package source with its own options. Shared packages must compile under the strictest consumer. The `tsconfig.src.json` check covers the renderer case for Node.js globals (`types: []`) and for language features (`lib`), as long as its `lib` matches the renderer's.
- Decorator-based frameworks and ORMs (NestJS, TypeORM) are excluded.
- Revisit (move one package to `tsc -b`) only if a package must be published, needs non-erasable syntax, consumer type checks become slow, or the deployment task chooses a compiled artifact.

## Dependency policy

- TypeScript 6 stays a root devDependency with an exact pin. No new root devDependencies.
- Each Node-side workspace declares `@types/node` for Node.js 24 in its own `devDependencies`, with an exact pin. The root declares no `@types/node` and keeps `types: []`.

## Evidence

- [`packages/protocol/package.json`](../../../packages/protocol/package.json), [`packages/protocol/tsconfig.json`](../../../packages/protocol/tsconfig.json), and [`packages/protocol/tsconfig.src.json`](../../../packages/protocol/tsconfig.src.json).
- The rules for every workspace: [WORKSPACE.md, Internal packages](../../development/WORKSPACE.md#internal-packages).
- M1-01 acceptance checks: temporary probes in `packages/protocol/src` (`process.env`, an `enum`, an import without `.ts`, `Set.prototype.union`) fail `tsconfig.src.json` with TS2591, TS1294, TS2835, and TS2550.
- Review record: [M1 Technical Decision Set](../research/m1-technical-decision-set.md), revision 2 of 2026-10-27 (ADR 0001, Sections 2.2 and 2.5).

## Needs Project Manager decision

Answered by the Project Manager on 2026-10-28.

- Accept source exports for every internal package (P-01).
  - Accepted.
- Agree with the desktop owner on the consumer rules: the renderer tsconfig flags, one renderer language level (proposed: ES2024) written into the protocol's `tsconfig.src.json`, bundling the Electron main and preload code, never compiling package source with an emitting `tsc` build, and whether the desktop opens the WebSocket from the main process (no Origin header) or from the renderer (P-02).
  - Accepted by the Project Manager. The desktop owner's agreement was requested in pull request #48, and the merge did not wait for it. Changes that the desktop owner asks for are made before the desktop imports the protocol.
- Claim the npm organization `mymandev` and keep internal versions at `0.0.0` (P-46).
  - Accepted. Claiming the organization is a Project Manager action.
