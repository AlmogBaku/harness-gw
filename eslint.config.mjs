import js from "@eslint/js"
import { defineConfig, globalIgnores } from "eslint/config"
import globals from "globals"
import tseslint from "typescript-eslint"
import adapterBoundaries from "./scripts/eslint-adapter-boundaries.mjs"

const styleAssertionMessage =
  "Tests never assert styling; assert behavior instead."

/** The gateway's own code, which the client must never reach. */
const gatewayImports = ["../src", "../src/**", "../../src/**"]

export default defineConfig([
  globalIgnores([
    "dist/**",
    "coverage/**",
    ".agents/**",
    // Upstream-verbatim files are ignored; files authored here in the same
    // directory (gateway-events.ts, snapshot.test.ts, UPSTREAM.md) are not.
    "src/adapters/hermes/vendor/**/json-rpc-gateway.ts",
    "src/adapters/hermes/vendor/**/json-rpc-channel.ts",
    "src/adapters/hermes/vendor/**/reconnect-backoff.ts",
  ]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    plugins: { hgw: adapterBoundaries },
    rules: { "hgw/adapter-boundaries": "error" },
  },
  {
    files: ["src/**/*.ts", "protocol/**/*.ts", "test/**/*.ts", "*.config.ts"],
    languageOptions: {
      globals: { ...globals.node, Bun: "readonly" },
    },
  },
  {
    files: ["client/**/*.ts"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Tests may compose the client with the gateway's in-process harness.
    files: ["client/**/*.ts"],
    ignores: ["client/**/*.test.ts"],
    rules: {
      "no-restricted-globals": ["error", "process"],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "bun", "bun:*", ...gatewayImports],
              message:
                "The client runs in a browser: no Node, Bun, or gateway imports.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["protocol/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "bun",
                "bun:*",
                ...gatewayImports,
                "../client",
                "../client/**",
                "../lifecycle",
                "../lifecycle/**",
              ],
              message:
                "The protocol loads alone: no Node, Bun, gateway, client, or lifecycle imports.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["lifecycle/**/*.ts"],
    rules: {
      "no-console": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "bun",
                "bun:*",
                ...gatewayImports,
                "../client",
                "../client/**",
              ],
              message:
                "The lifecycle library stays pure: no Node, Bun, client, or gateway imports.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.bun-spec.ts", "test/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, Bun: "readonly" },
    },
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name=/^(toHaveClass|toHaveStyle|toHaveCSS|toHaveScreenshot)$/]",
          message: styleAssertionMessage,
        },
      ],
    },
  },
  {
    // Type-aware promise rules for production code.
    files: ["src/**/*.ts", "lifecycle/**/*.ts", "client/**/*.ts"],
    ignores: ["**/*.test.ts", "**/*.bun-spec.ts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          // The virtual path the boundary test lints, which exists on no disk.
          allowDefaultProject: ["src/adapters/hermes/example.ts"],
        },
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: false, ignoreIIFE: true },
      ],
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
])
