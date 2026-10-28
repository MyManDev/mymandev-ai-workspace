# Workspace and Tooling

This document describes the npm workspaces monorepo, the shared root tooling, and the package boundary rules.

## Requirements

- Node.js `^24.15.0` (Node.js 24, version 24.15.0 or newer). `.nvmrc` records the major version for version managers.
- npm `^11.12.1` (npm 11, version 11.12.1 or newer). Node.js 24.15.0 and newer ship a matching npm.
- Git.

The root `.npmrc` sets two options:

- `engine-strict=true`: `npm install` and `npm ci` fail when Node.js or npm does not match the `engines` field in `package.json`. `npm run` does not check `engines`.
- `save-exact=true`: new dependencies are saved with exact versions.

The `packageManager` field in `package.json` records the npm version used to create the lockfile. npm itself ignores this field. It only takes effect for developers who enabled Corepack for npm (`corepack enable npm`).

## Setup

From the repository root:

```sh
npm ci
npm run check
```

`npm ci` installs exactly the versions recorded in `package-lock.json`. Use `npm install` only when changing dependencies, and commit the updated `package-lock.json` together with that change.

## Root scripts

| Script                 | Runs                                                        | Purpose                                                |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `npm run format`       | `prettier --write .`                                        | Format every file that Prettier supports.              |
| `npm run format:check` | `prettier --check .`                                        | Fail if any file is not formatted.                     |
| `npm run lint`         | `eslint .`                                                  | Lint JavaScript and TypeScript files.                  |
| `npm run lint:fix`     | `eslint . --fix`                                            | Lint and apply automatic fixes.                        |
| `npm run typecheck`    | `tsc -p tsconfig.json`, then `typecheck` in every workspace | Type-check the root tooling files and every workspace. |
| `npm test`             | `test` in every workspace                                   | Run the tests of every workspace.                      |
| `npm run check`        | `format:check`, `lint`, `typecheck`, `test`                 | Run all four in order; stop at the first failure.      |

npm runs scripts with `cmd.exe` on Windows and `sh` on other systems. Keep root scripts portable: chain commands with `&&`, quote arguments with double quotes, and do not use single quotes, `VAR=value` prefixes, `rm`, or `cp`.

`npm run lint` lints the whole repository, including every workspace. Files inside a workspace that has its own `eslint.config.mjs` are linted with that config. Do not add workspace lint delegation to the root scripts; it would lint workspaces twice.

`npm run typecheck` first checks the root tooling files (`tsconfig.json` includes the root-level `*.mjs` files) and then runs the `typecheck` script of every workspace; see [Root typecheck delegation](#root-typecheck-delegation). `npm test` runs the `test` script of every workspace; see [Root test delegation](#root-test-delegation).

## Continuous integration

`.github/workflows/check.yml` runs `npm ci` and `npm run check` on Linux, Windows, and macOS for every pull request and push to `develop` and `main`. It installs the latest Node.js release that matches `.nvmrc` and does not use a dependency cache. A pull request is ready for review only when all three jobs pass.

`.github/workflows/database.yml` runs when a pull request or a push changes `packages/database`, `packages/protocol`, or the lockfile. It applies the migrations to a PostgreSQL 18 service container on Linux and compares the schema with PGlite; see [packages/database/README.md](../../packages/database/README.md). It also runs for pull requests whose base is another task branch.

## Editor setup

Editors that support EditorConfig follow the basic rules in `.editorconfig`.

For Visual Studio Code, `.vscode/extensions.json` recommends the ESLint, Prettier, and EditorConfig extensions. `.vscode/settings.json` formats files with Prettier on save, applies ESLint fixes on explicit saves, and points Visual Studio Code to the TypeScript version in `node_modules`. Run **TypeScript: Select TypeScript Version** and choose **Use Workspace Version** once.

Files listed in `.prettierignore` are not formatted, including on save.

## Line endings

All text files use LF line endings, in the repository and in working trees, on every operating system.

- `.gitattributes` sets `* text=auto eol=lf`. Git stores text files with LF and checks them out with LF, whatever `core.autocrlf` is set to. Files in `.githooks/` and `*.sh` files are always treated as text with LF. Common binary file types are marked `binary`.
- `.editorconfig` tells editors to use LF, a final newline, and two-space indentation. It does not set `charset`, so files that start with a UTF-8 byte order mark keep it.
- Prettier writes LF (`"endOfLine": "lf"` in `.prettierrc.json`).

A checkout created before `.gitattributes` existed may still have CRLF working files. Git reports no changes for them, because their stored content is already LF, and new clones get LF.

## Workspace layout

```text
apps/       applications
packages/   libraries shared by applications and other packages
docs/       project documentation
```

The root `package.json` declares the workspace globs `apps/*` and `packages/*`. A directory becomes a workspace when it contains a `package.json`. The first workspace is `packages/protocol` (`@mymandev/protocol`); each further workspace is created by the task that needs it.

The repository has a single `package-lock.json`, at the root. Shared tooling configuration also lives at the root:

- `tsconfig.base.json`: compiler options shared by every workspace. It does not set `module`, `moduleResolution`, `target`, `lib`, `jsx`, `types`, or `include`; each workspace `tsconfig.json` sets those for its own runtime.
- `tsconfig.json`: type-checks the root tooling files.
- `eslint.config.mjs`: the ESLint and typescript-eslint recommended rules, without type-aware rules, followed by eslint-config-prettier.
- `.prettierrc.json` and `.prettierignore`: Prettier with its default options.
- `.editorconfig`, `.gitattributes`, `.gitignore`, `.npmrc`, and `.nvmrc`.

## Package boundaries

These rules apply to every workspace. They are enforced in review; lint does not enforce them yet.

- `apps/*` contains applications. `packages/*` contains libraries.
- Applications may depend on packages, and packages may depend on other packages. Packages never depend on applications.
- Applications never import from other applications. Code shared between applications lives in a package.
- Dependencies between workspaces must not form cycles.
- Import another workspace only by its package name, for example `@mymandev/<name>`. Do not use relative paths into another workspace's directory.
- Every workspace declares the dependencies it uses in its own `package.json`: runtime and build dependencies, type packages, and workspace-specific ESLint plugins. The shared tools (`typescript`, `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-config-prettier`, and `prettier`) are declared only in the root `package.json` and are not declared again in workspaces.
- Every workspace is named `@mymandev/<directory-name>` and sets `"private": true` by default. Publishing a package is a separate decision.
- Shared contracts, such as the protocol, event schemas, permission and capability contracts, and shared TypeScript types, require explicit coordination as described in [OWNERSHIP.md](../process/OWNERSHIP.md).

## Internal packages

Internal workspace packages export their TypeScript source. There is no build step, no `dist` directory, and no TypeScript project references; see [ADR 0001](../architecture/decisions/0001-internal-packages-export-typescript-source.md). Node.js 24 runs `.ts` files through built-in type stripping. Node.js, `tsc`, `node --test`, and bundlers load a package from its source through the npm workspace link, so a clean checkout type-checks, tests, and runs directly after `npm ci`.

Every `packages/*` workspace follows these rules:

- `package.json` sets `"type": "module"`, `"private": true`, and `"exports": { ".": "./src/index.ts" }`. Further subpaths are added only as deliberate public API when a consumer needs them. A package without side effects also sets `"sideEffects": false`.
- The version stays `0.0.0`, and every dependent records exactly `"0.0.0"`. If the two differ, npm looks the package up on the public npm registry instead of linking the workspace.
- Relative imports include the `.ts` extension, for example `./envelope.ts`. An import of `./envelope.js` fails at runtime with `ERR_MODULE_NOT_FOUND`.
- Type-only imports use `import type`. `verbatimModuleSyntax` enforces this.
- Only erasable TypeScript syntax: no `enum`, no runtime `namespace`, no parameter properties, and no decorators. `erasableSyntaxOnly` enforces this.
- No `paths` in `tsconfig.json`. Workspaces import each other only by package name.
- A workspace package never becomes a real directory under `node_modules`: it is not published, not packed, not copied with dereferenced links, and not run with `--preserve-symlinks`. Node.js does not strip types under `node_modules` and fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. A deployment keeps the workspace layout or bundles the application.

Every Node-side workspace uses these compiler options in its `tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "es2025",
    "lib": ["es2025"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

A package that the desktop renderer imports, such as `packages/protocol`, must not depend on Node.js. It adds a `tsconfig.src.json` that extends its `tsconfig.json`, sets `"types": []` and `lib` to the agreed renderer language level (proposed: `["es2024"]`), and excludes the tests. Its `typecheck` script runs both configurations, `"tsc -p tsconfig.json && tsc -p tsconfig.src.json"`, so a Node.js global such as `process`, or a language feature newer than the renderer level, fails in the package's own check.

Consumers of an internal package:

- A Node.js application runs its source directly, for example `node src/server.ts`.
- A bundled consumer, such as the desktop renderer, sets `moduleResolution` to `bundler` together with `allowImportingTsExtensions` and `noEmit`. Its `target` and `lib` stay at or above the level in the package's `tsconfig.src.json`. Electron main and preload code that imports a workspace package is bundled too. Package source is never compiled with an emitting `tsc` build.

A bundled consumer's `tsconfig.json` can start from this example; `jsx` and `types` are the consumer's choice:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024", "dom"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "types": ["vite/client"],
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src"]
}
```

## Tests

Node-side workspaces use the built-in Node.js test runner, `node:test`; see [ADR 0002](../architecture/decisions/0002-node-test-runner.md).

- Tests sit next to the code as `src/**/*.test.ts`.
- The workspace script is `"test": "node --test \"src/**/*.test.ts\""`. Node.js runs the TypeScript tests directly, and the quoted glob also works through `cmd.exe`.
- Tests use dependency injection instead of module mocks.
- `node --test` exits with 0 when its pattern matches no file. When you add or remove tests, check the `tests` count in the summary.
- A workspace `test` script runs once and exits. A bundled workspace, such as `apps/desktop`, may use Vitest in its own `devDependencies`, matched to its Vite version. With Vitest, use `"test": "vitest run"`: plain `vitest` starts watch mode in an interactive terminal and would block `npm run check`.
- Vitest is never added to the root `package.json`, and nobody runs `node --test` at the root.
- Coverage (`--experimental-test-coverage`) is optional and not a gate.

## Adding a workspace

1. Create `apps/<name>/` or `packages/<name>/` with a `package.json` that sets `"name": "@mymandev/<name>"` and `"private": true`. A package also follows [Internal packages](#internal-packages).
2. Install dependencies from the repository root. Run a plain `npm install` once after creating the new `package.json`, then `npm install <package>@<version> -w @mymandev/<name>`. Without the plain `npm install`, the first `-w` install links the workspace but does not save the dependency; check the workspace `package.json` after every install. Do not create a nested `package-lock.json` or a workspace `.npmrc`; npm ignores workspace `.npmrc` files.
3. Add a `tsconfig.json` that extends `../../tsconfig.base.json` and sets the options for the workspace runtime, following [TypeScript](#typescript).
4. Add a `typecheck` script that type-checks the workspace without emitting files. If the workspace has tests, add a `test` script that runs them once; see [Tests](#tests).
5. If the workspace needs its own lint rules, add an `eslint.config.mjs` that imports the root config, as shown in [ESLint](#eslint). Otherwise the root config applies.
6. Make sure Git, Prettier, and ESLint ignore the workspace build output. The root `.gitignore` ignores `node_modules/`, `dist/`, `out/`, and `coverage/` at any depth, and the root ESLint config ignores `**/dist/`, `**/out/`, and `**/coverage/`. Any other output directory is added in two places: the root `.gitignore`, because root Prettier reads only the root `.gitignore` and `.prettierignore`, not nested ignore files; and the ESLint ignores, with `globalIgnores([...])` in the workspace `eslint.config.mjs` or in the root config with a `**/` prefix, because ESLint does not read `.gitignore`.
7. If this is the first workspace, apply the [root typecheck delegation](#root-typecheck-delegation).
8. Run `npm run check` from the repository root.

### Root typecheck delegation

The delegation is applied. The pull request that added the first workspace, `packages/protocol`, changed the root `typecheck` script to:

```json
{
  "scripts": {
    "typecheck": "tsc -p tsconfig.json && npm run typecheck --workspaces --if-present"
  }
}
```

It could not exist earlier, because `npm run <script> --workspaces` fails with `No workspaces found!` when there are no workspaces. `--if-present` skips workspaces that have no `typecheck` script. npm runs workspace scripts in directory order (`apps/*` before `packages/*`), not in dependency order. No build order is needed, because internal packages export their source; see [Internal packages](#internal-packages).

### Root test delegation

The root `test` script runs the `test` script of every workspace, and `npm run check` runs the tests last:

```json
{
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "check": "npm run format:check && npm run lint && npm run typecheck && npm test"
  }
}
```

`--if-present` skips workspaces that have no `test` script. Every workspace `test` script runs once and exits; see [Tests](#tests).

### TypeScript

Each workspace `tsconfig.json` extends `../../tsconfig.base.json` and sets its own `module`, `moduleResolution`, `target`, `lib`, `jsx`, and `types`.

- `strict`, `noImplicitAny`, and `noUncheckedIndexedAccess` are binding. No workspace sets a strict-family option to `false`, including through another base configuration. An array `extends` is allowed; list other base configurations before `../../tsconfig.base.json`, because later entries override earlier ones. Check the effective options with `npx tsc -p <tsconfig> --showConfig`.
- Do not use options that TypeScript 6 deprecates, and do not set `ignoreDeprecations`. In particular, do not set `baseUrl`; write `paths` entries relative to the `tsconfig.json` file, for example `"@app/*": ["./src/*"]`.
- `types` defaults to `[]`. List global type packages explicitly, for example `["node"]` for Node.js code, and declare the type package in the workspace.
- Side-effect imports are checked. Imports of non-code assets, such as `import "./styles.css"`, need type declarations, usually the client types of the bundler.
- Set `target` explicitly.

### ESLint

ESLint uses the `eslint.config.mjs` closest to each linted file and does not merge it with configs in parent directories. A workspace config therefore imports and extends the root config:

```js
// @ts-check
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import rootConfig from "../../eslint.config.mjs";

export default defineConfig(
  rootConfig,
  {
    files: ["**/*.{ts,tsx}"],
    // Workspace-specific plugin configs and rules go here.
    rules: {},
  },
  eslintConfigPrettier,
);
```

- Pass `rootConfig` as a top-level argument, not inside `extends`.
- Keep `eslintConfigPrettier` last, so plugin configs cannot re-enable rules that conflict with Prettier.
- `files` and ignore patterns in this file are relative to the workspace directory. Add workspace-only ignores with `globalIgnores([...])` from `eslint/config`.

## Desktop workspace contract

The desktop application shell (issue #3) builds on this baseline. This section is a shared boundary: it changes only by agreement, as described in [OWNERSHIP.md](../process/OWNERSHIP.md).

- Directory `apps/desktop`, package name `@mymandev/desktop`, `"private": true`.
- Dependencies are installed from the repository root with `-w @mymandev/desktop` and recorded in the root `package-lock.json`.
- Electron, React, the bundler, and their plugins and type packages are declared in `apps/desktop/package.json`. Shared tooling versions stay in the root `package.json`.
- Scripts: `dev`, `build`, and `typecheck`.
- The same pull request applies the [root typecheck delegation](#root-typecheck-delegation).
- The [TypeScript](#typescript) and [ESLint](#eslint) rules above apply.
- No Prettier configuration in `apps/desktop`. A build output directory that the root ignores do not cover is added to the root `.gitignore` and to the ESLint ignores, as described in [Adding a workspace](#adding-a-workspace).

## Planned workspaces

This list records the expected direction and is not binding. `packages/protocol`, `apps/api`, and `packages/database` exist so far. Each other one is created by the task that needs it, as decided by the project manager; see [ROADMAP.md](../process/ROADMAP.md).

- `apps/desktop`
- `apps/api`
- `packages/protocol`
- `packages/database`
- `packages/permissions`
- `packages/agent-core`
- `packages/provider-adapters`
- `packages/repo-tools`
- `packages/ui`
