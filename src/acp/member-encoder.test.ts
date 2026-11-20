import { describe, expect, it } from "vitest"

import { SessionWorkspaceCapabilitiesResponseSchema } from "../../protocol"
import { configOptionsOf } from "./config-options"
import { setupAnswer } from "./member-encoder"
import { CAPABILITIES } from "./test-harness"

describe("setupAnswer", () => {
  // ACP: "omission or `[]` means none, and empty lists are omitted when
  // serializing" (session setup, ACP v2).
  it("leaves an empty model catalog and command list out, and the capabilities in", () => {
    const capabilities = SessionWorkspaceCapabilitiesResponseSchema.parse({
      ...CAPABILITIES,
      workspace: {
        ...CAPABILITIES.workspace,
        slashCommands: { status: "available", scope: "session", commands: [] },
      },
    })

    expect(
      setupAnswer(
        { configOptionsOf },
        { models: { selectedId: "sonnet", options: [] }, capabilities }
      )
    ).toEqual({ meta: { capabilities } })
  })
})
