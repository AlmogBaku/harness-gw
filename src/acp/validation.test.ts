import { describe, expect, it } from "vitest"

import { ServerTurnEndedError } from "../core/runtime"
import { invalidParams, publicCodeOf, publicRequestError } from "./validation"

const replyOf = (cause: unknown) =>
  publicCodeOf(publicRequestError(() => undefined, cause))

describe("a prompt whose turn ended before its storage receipt", () => {
  it.each([
    ["a stop", new ServerTurnEndedError("stopped"), "request_cancelled"],
    [
      "a failure",
      new ServerTurnEndedError("failed", "HGW_PROVIDER_RUN_FAILED"),
      "temporarily_unavailable",
    ],
    [
      "a detach that may leave the turn alive",
      new ServerTurnEndedError("failed", "HGW_CONNECTION_INTERRUPTED"),
      "uncertain_mutation",
    ],
  ])("answers %s as what happened", (_, cause, reply) => {
    expect(replyOf(cause)).toBe(reply)
  })

  it.each([
    ["a command the runtime refused", "HGW_COMMAND_UNSUPPORTED"],
    ["a rewind to a message history no longer holds", "HGW_REWIND_CONFLICT"],
  ])("names %s by its code, so a client can word it", (_, code) => {
    const reply = publicRequestError(
      () => undefined,
      new ServerTurnEndedError("failed", code, { unstored: true })
    )

    expect(reply).toMatchObject({
      code: invalidParams().code,
      data: { code },
    })
  })
})
