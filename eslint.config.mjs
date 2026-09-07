import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "artifacts/**",
      "examples/*/.astro/**",
      "examples/*/.next/**",
      "examples/*/.nuxt/**",
      "examples/*/.output/**",
      "examples/*/.svelte-kit/**",
      "examples/*/dist/**",
      "examples/*/.sweetener/**",
      "examples/tanstack-start/src/routeTree.gen.ts",
      "fixtures/acceptance/real-world/*/expected.*",
      "fixtures/legacy/**",
      "packages/*/dist/**",
      "playground/dist/**",
      "samples/external/*/dist/**",
      "samples/external/*/dist-standalone/**",
      // Macro-enabled JavaScript is not parseable by ordinary JavaScript
      // tooling; the sample's expanded output under dist/ is linted instead.
      "samples/external/javascript-project/src/macros.js",
      "samples/external/javascript-project/src/main.js",
      "node_modules/**",
      "pnpm-lock.yaml",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        performance: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
  {
    // A `.cts` file is CommonJS, and under `verbatimModuleSyntax` the only
    // static import it can spell is `import x = require(...)`.
    files: ["**/*.cts"],
    rules: {
      "@typescript-eslint/no-require-imports": [
        "error",
        { allowAsImport: true },
      ],
    },
  },
  {
    files: [
      "examples/**/*.ts",
      "examples/**/*.tsx",
      "playground/src/**/*.ts",
      "playground/src/**/*.tsx",
    ],
    languageOptions: {
      globals: {
        document: "readonly",
        self: "readonly",
        window: "readonly",
      },
    },
  },
  {
    files: ["fixtures/acceptance/**/*.ts"],
    rules: {
      "no-shadow-restricted-names": "off",
      "@typescript-eslint/no-namespace": "off",
    },
  },
);
