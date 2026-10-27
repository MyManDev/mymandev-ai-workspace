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

| Script                 | Runs                                | Purpose                                            |
| ---------------------- | ----------------------------------- | -------------------------------------------------- |
| `npm run format`       | `prettier --write .`                | Format every file that Prettier supports.          |
| `npm run format:check` | `prettier --check .`                | Fail if any file is not formatted.                 |
| `npm run lint`         | `eslint .`                          | Lint JavaScript and TypeScript files.              |
| `npm run lint:fix`     | `eslint . --fix`                    | Lint and apply automatic fixes.                    |
| `npm run typecheck`    | `tsc -p tsconfig.json`              | Type-check the root tooling files.                 |
| `npm run check`        | `format:check`, `lint`, `typecheck` | Run all three in order; stop at the first failure. |

npm runs scripts with `cmd.exe` on Windows and `sh` on other systems. Keep root scripts portable: chain commands with `&&`, quote arguments with double quotes, and do not use single quotes, `VAR=value` prefixes, `rm`, or `cp`.

`npm run lint` lints the whole repository, including every workspace. Files inside a workspace that has its own `eslint.config.mjs` are linted with that config. Do not add workspace lint delegation to the root scripts; it would lint workspaces twice.

`npm run typecheck` checks only the root tooling files: `tsconfig.json` includes the root-level `*.mjs` files. Workspace type checks are added together with the first workspace; see [Root typecheck delegation](#root-typecheck-delegation).

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

The root `package.json` declares the workspace globs `apps/*` and `packages/*`. A directory becomes a workspace when it contains a `package.json`. No workspace exists yet; each one is created by the task that needs it.

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

## Adding a workspace

1. Create `apps/<name>/` or `packages/<name>/` with a `package.json` that sets `"name": "@mymandev/<name>"` and `"private": true`.
2. Install dependencies from the repository root: `npm install <package>@<version> -w @mymandev/<name>`. Do not create a nested `package-lock.json` or a workspace `.npmrc`; npm ignores workspace `.npmrc` files.
3. Add a `tsconfig.json` that extends `../../tsconfig.base.json` and sets the options for the workspace runtime, following [TypeScript](#typescript).
4. Add a `typecheck` script that type-checks the workspace without emitting files.
5. If the workspace needs its own lint rules, add an `eslint.config.mjs` that imports the root config, as shown in [ESLint](#eslint). Otherwise the root config applies.
6. Make sure Git, Prettier, and ESLint ignore the workspace build output. The root `.gitignore` ignores `node_modules/`, `dist/`, `out/`, and `coverage/` at any depth, and the root ESLint config ignores `**/dist/`, `**/out/`, and `**/coverage/`. Any other output directory is added in two places: the root `.gitignore`, because root Prettier reads only the root `.gitignore` and `.prettierignore`, not nested ignore files; and the ESLint ignores, with `globalIgnores([...])` in the workspace `eslint.config.mjs` or in the root config with a `**/` prefix, because ESLint does not read `.gitignore`.
7. If this is the first workspace, apply the [root typecheck delegation](#root-typecheck-delegation).
8. Run `npm run check` from the repository root.

### Root typecheck delegation

While no workspace exists, the root `typecheck` script checks only the root tooling files, because `npm run <script> --workspaces` fails with `No workspaces found!` when there are no workspaces. The pull request that adds the first workspace changes the root script to:

```json
{
  "scripts": {
    "typecheck": "tsc -p tsconfig.json && npm run typecheck --workspaces --if-present"
  }
}
```

`--if-present` skips workspaces that have no `typecheck` script.

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

This list records the expected direction and is not binding. None of these workspaces exist yet. Each one is created by the task that needs it, as decided by the project manager; see [ROADMAP.md](../process/ROADMAP.md).

- `apps/desktop`
- `apps/api`
- `packages/protocol`
- `packages/database`
- `packages/permissions`
- `packages/agent-core`
- `packages/provider-adapters`
- `packages/repo-tools`
- `packages/ui`
