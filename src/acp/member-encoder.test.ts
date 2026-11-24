import type { AgentContext } from "@agentclientprotocol/sdk/experimental/v2/unstable"
import { describe, expect, it, vi } from "vitest"

import { SessionWorkspaceCapabilitiesResponseSchema } from "../../protocol"
import { captureLogs } from "../../test/support/log-capture"
import { configOptionsOf } from "./config-options"
import { createMemberEncoder, setupAnswer } from "./member-encoder"
import { CAPABILITIES } from "./test-harness"
import * as translators from "./translate"

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

describe("a repeated state", () => {
  // ACP's repeated snapshot moves nothing but its list: a state the Session
  // was shown with no `_meta`, as one no turn of this gateway's stated is,
  // is said again with none.
  it("carries no `_meta` the state it repeats did not", async () => {
    const notify = vi.fn(async () => undefined)
    const encoder = createMemberEncoder({
      context: { logger: captureLogs().logger, translators },
      client: { notify } as unknown as AgentContext,
      describe: () => ({ code: "internal", message: "" }),
      replied: async () => undefined,
      elicits: () => false,
      report: () => undefined,
      live: () => true,
      fellBehind: () => undefined,
      children: { announce: () => true, owns: () => true },
    })

    await encoder.send({
      kind: "execution",
      sessionId: "session-1",
      state: "idle",
      sequence: 0,
      background: [{ kind: "terminal", terminalId: "run-1:terminal" }],
    })
    await encoder.send({
      kind: "background",
      sessionId: "session-1",
      background: [],
    })

    const stated = notify.mock.calls.map(
      (call) => (call as unknown[])[1] as { update: object }
    )
    expect(stated.map(({ update }) => update)).toEqual([
      {
        sessionUpdate: "state_update",
        state: "idle",
        background: [{ type: "terminal", terminalId: "run-1:terminal" }],
      },
      { sessionUpdate: "state_update", state: "idle", background: [] },
    ])
  })
})
