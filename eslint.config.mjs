// @ts-check
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

export default defineConfig(
  // "**/" patterns also work when a workspace config imports this file.
  globalIgnores(["**/dist/", "**/out/", "**/coverage/"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  // Must stay last: turns off rules that conflict with Prettier.
  eslintConfigPrettier,
);
