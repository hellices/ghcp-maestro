import js from "@eslint/js";
import globals from "globals";

// Flat ESLint config (ESLint 9+). The ghcp-maestro runtime is zero-deps and
// ESM-only; lint enforces that plus the project rule that runtime code must
// never write to stdout/stderr directly (only `session.log()`), since the
// extension speaks JSON-RPC over stdio.
export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "**/runs/**",
      "plugin-data/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],
      "no-throw-literal": "error",
    },
  },
  {
    // Runtime + extension code must not touch the console or stdio directly —
    // the extension speaks JSON-RPC over stdout, so a stray write corrupts the
    // protocol. Only session.log() is allowed.
    files: ["core/**/*.mjs", "extensions/**/*.mjs"],
    rules: {
      "no-console": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.object.name='process'][callee.object.property.name='stdout'][callee.property.name='write']",
          message: "Use session.log(); never write to stdout directly (JSON-RPC stdio).",
        },
        {
          selector:
            "CallExpression[callee.object.object.name='process'][callee.object.property.name='stderr'][callee.property.name='write']",
          message: "Use session.log(); never write to stderr directly (JSON-RPC stdio).",
        },
      ],
    },
  },
  {
    // Example saved workflows run inside the runtime sandbox and use injected
    // globals; they legitimately reference identifiers the linter can't see.
    files: ["extensions/ghcp-maestro/saved-workflows/**/*.mjs"],
    languageOptions: {
      globals: {
        spawn: "readonly",
        spawnAll: "readonly",
        phase: "readonly",
        log: "readonly",
        args: "readonly",
        adversarialReview: "readonly",
        multiAngle: "readonly",
        fixLoop: "readonly",
        crossCheck: "readonly",
      },
    },
  },
  {
    files: ["tests/**/*.mjs"],
    rules: {
      "no-console": "off",
    },
  },
];
