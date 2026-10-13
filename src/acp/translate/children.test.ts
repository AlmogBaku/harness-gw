import { RequestError } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it } from "vitest"

import { HGW_META_KEY } from "../../../protocol/acp"
import { ChildSessionStatus, TurnEventKind } from "../../core/events"
import type { TranslateContext } from "../types"
import { translateChildUpdate } from "./children"

const context: TranslateContext = {
  turnId: "run-1",
  sequence: 7,
  stopping: false,
}

/**
 * ACP announces a child Session on its parent with `subagent_update`: the
 * parent's title and description for it, what a client may do to it, and its
 * state mirrored. The call that spawned it rides in the gateway's meta.
 */
describe("child Session announcement", () => {
  it("announces a child with its title, purpose and spawning call, masking a credential", () => {
    const update = translateChildUpdate(
      {
        kind: TurnEventKind.ChildSessionUpdated,
        childSessionId: "child-1",
        toolCallId: "call-spawn",
        title: "Review the notes",
        description: "Read them with password: synthetic-pass-123",
        status: ChildSessionStatus.Running,
        cancellable: true,
        model: "small",
      },
      context
    )

    expect(update).toMatchObject({
      sessionUpdate: "subagent_update",
      sessionId: "child-1",
      title: "Review the notes",
      capabilities: { cancel: {} },
      state: { state: "running" },
      _meta: {
        [HGW_META_KEY]: {
          sequence: 7,
          turnId: "run-1",
          toolCallId: "call-spawn",
          model: "small",
        },
      },
    })
    expect(JSON.stringify(update)).not.toContain("synthetic-pass-123")
  })

  it.each([
    [ChildSessionStatus.WaitingForInput, { state: "requires_action" }],
    [ChildSessionStatus.Idle, { state: "idle", stopReason: "end_turn" }],
    [ChildSessionStatus.Cancelled, { state: "idle", stopReason: "cancelled" }],
    [
      ChildSessionStatus.Failed,
      {
        state: "idle",
        stopReason: "error",
        error: {
          code: RequestError.internalError().code,
          message: "internal_error",
        },
      },
    ],
  ])("mirrors a child that is %s as its state", (status, state) => {
    expect(
      translateChildUpdate(
        {
          kind: TurnEventKind.ChildSessionUpdated,
          childSessionId: "child-1",
          status,
        },
        context
      )
    ).toMatchObject({ state })
  })

  // A later report patches the announcement, and ACP replaces capabilities
  // whole, so one that does not report them leaves them as they were.
  it("restates only what changed", () => {
    const update = translateChildUpdate(
      {
        kind: TurnEventKind.ChildSessionUpdated,
        childSessionId: "child-1",
        summary: "Done",
      },
      context
    )

    expect(update).toEqual({
      sessionUpdate: "subagent_update",
      sessionId: "child-1",
      _meta: {
        [HGW_META_KEY]: { sequence: 7, turnId: "run-1", summary: "Done" },
      },
    })
  })
})
