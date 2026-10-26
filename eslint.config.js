// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["node_modules", "dist", "coverage"] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      // The CLI writes to stdout/stderr deliberately; the journal must only ever get what we chose to log.
      "no-console": "error",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // Fakes implement async interfaces with synchronous bodies.
      "@typescript-eslint/require-await": "off",
      // node:test collects the promises returned by test() itself.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test"] }],
        },
      ],
    },
  },
  {
    // Tooling config runs as plain JavaScript, outside the TypeScript project.
    files: ["*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
