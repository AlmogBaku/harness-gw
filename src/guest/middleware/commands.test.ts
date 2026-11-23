import { describe, expect, it } from "vitest"

import { SessionWorkspaceCapabilitiesResponseSchema } from "../../../protocol"
import { CAPABILITIES } from "../../acp/test-harness"
import { runCommand, runEvents } from "../../core/member"
import { createCommandsMiddleware } from "./commands"

describe("guest commands", () => {
  // Not only because a guest is told of no child: whatever its connection
  // holds, the guest's close asks no background work stopped.
  it("closes a guest's Session stopping no background work", async () => {
    const reached: unknown[] = []

    await runCommand(
      [createCommandsMiddleware()],
      "close",
      { sessionId: "ref", stopsBackground: true },
      async (command) => {
        reached.push(command)
      }
    )

    expect(reached).toEqual([{ sessionId: "ref", stopsBackground: false }])
  })

  it("shows a guest its commands event without the operator's slash commands", () => {
    const shown = runEvents(
      [createCommandsMiddleware()],
      {
        sessionId: "ref",
        kind: "commands",
        capabilities:
          SessionWorkspaceCapabilitiesResponseSchema.parse(CAPABILITIES),
      },
      { decline: () => undefined }
    )

    expect(
      shown?.kind === "commands" && shown.capabilities.workspace.slashCommands
    ).toEqual({
      status: "unavailable",
      reason: "operator-session-controls-required",
    })
  })
})
