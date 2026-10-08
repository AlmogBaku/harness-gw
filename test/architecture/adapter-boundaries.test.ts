import { ESLint } from "eslint"
import { describe, expect, it } from "vitest"

const eslint = new ESLint()

/** The adapter-boundary reports for `code` written in the Hermes adapter. */
async function boundaryErrors(code: string) {
  const [result] = await eslint.lintText(code, {
    filePath: "src/adapters/hermes/example.ts",
  })
  return result!.messages.filter(
    ({ ruleId }) => ruleId === "hgw/adapter-boundaries"
  )
}

describe("server adapter boundaries", () => {
  it.each([
    'import { createOpenClawRuntime } from "../openclaw/factory"',
    'export * from "../opencode"',
    'const runtime = import("../openclaw/factory")',
    'type Client = import("../opencode/client").OpenCodeClient',
  ])("rejects one adapter importing another: %s", async (code) => {
    expect(await boundaryErrors(code)).toHaveLength(1)
  })

  it.each([
    'import type { ServerRuntime } from "../../core/runtime"',
    'import { jsonValue } from "../json-value"',
    'import { gateway } from "./gateway"',
  ])("admits what the adapters share: %s", async (code) => {
    expect(await boundaryErrors(code)).toEqual([])
  })
})
