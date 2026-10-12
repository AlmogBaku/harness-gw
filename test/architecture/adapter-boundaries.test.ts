import { spawnSync } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

const root = join(import.meta.dirname, "../..")

const crossAdapter = [
  'import { createOpenClawRuntime } from "../openclaw/factory"',
  'export * from "../opencode"',
  'const runtime = import("../openclaw/factory")',
  'type Client = import("../opencode/client").OpenCodeClient',
]
const shared = [
  'import type { ServerRuntime } from "../../core/runtime"',
  'import { jsonValue } from "../json-value"',
  'import { gateway } from "./gateway"',
]
const cases = [...crossAdapter, ...shared]

/** Where a case is written: the Hermes adapter, relative to the root. */
const probeFile = (code: string) =>
  `src/adapters/hermes/boundary-probe-${process.pid}-${cases.indexOf(code)}.ts`

const OxlintReport = z.object({
  diagnostics: z.array(
    z.object({ code: z.string().nullish(), filename: z.string() })
  ),
})

let report: z.infer<typeof OxlintReport>

/** Lints every case at once, as `bun run lint` does, then removes them. */
beforeAll(() => {
  for (const code of cases) writeFileSync(join(root, probeFile(code)), code)
  try {
    const oxlint = spawnSync(
      join(root, "node_modules/.bin/oxlint"),
      ["--format", "json", ...cases.map(probeFile)],
      { cwd: root, encoding: "utf8" }
    )
    report = OxlintReport.parse(JSON.parse(oxlint.stdout))
  } finally {
    for (const code of cases) rmSync(join(root, probeFile(code)))
  }
})

/** The adapter-boundary reports for `code` written in the Hermes adapter. */
function boundaryErrors(code: string) {
  return report.diagnostics.filter(
    ({ code: rule, filename }) =>
      filename === probeFile(code) && rule === "hgw(adapter-boundaries)"
  )
}

describe("server adapter boundaries", () => {
  it.each(crossAdapter)("rejects one adapter importing another: %s", (code) => {
    expect(boundaryErrors(code)).toHaveLength(1)
  })

  it.each(shared)("admits what the adapters share: %s", (code) => {
    expect(boundaryErrors(code)).toEqual([])
  })
})
