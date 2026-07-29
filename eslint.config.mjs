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
    // The compose dry-run child is a standalone process whose stderr is a
    // pipe read by the parent — it is NOT connected to the JSON-RPC stdio,
    // so stderr is the intended reporting channel. stdout stays restricted:
    // the parent ignores it, so writing there would silently drop output.
    files: ["core/compose-dry-run-child.mjs"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.object.name='process'][callee.object.property.name='stdout'][callee.property.name='write']",
          message: "The dry-run parent ignores the child's stdout; report via stderr.",
        },
      ],
    },
  },
  {
    // maestro-top is a standalone viewer process launched from a normal
    // terminal — it is never connected to the JSON-RPC stdio, and its whole
    // purpose is to own stdout. console stays off so output goes through the
    // one write path (process.stdout/stderr.write).
    files: ["extensions/ghcp-maestro/bin/**/*.mjs"],
    rules: {
      "no-restricted-syntax": "off",
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
