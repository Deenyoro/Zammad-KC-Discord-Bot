// ESLint flat config, run with `npm run lint`.
//
// ESLint and typescript-eslint are installed in tools/lint (its own
// package.json), not in the root package: typescript-eslint needs the
// TypeScript 6 compiler API, while the bot itself builds with TypeScript 7.
// tools/lint/lint.sh installs them on first use.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const lintRequire = createRequire(new URL("./tools/lint/package.json", import.meta.url));
const load = async (name) => (await import(pathToFileURL(lintRequire.resolve(name)).href)).default;

const js = await load("@eslint/js");
const tseslint = await load("typescript-eslint");
const globals = await load("globals");

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "tools/", "data/", ".compose-test.*/"] },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: globals.node,
    },
  },
  {
    // Test doubles stand in for discord.js and Zammad objects with partial
    // shapes, cast with `as any`. Production code stays strict.
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
