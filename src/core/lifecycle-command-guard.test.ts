import { RequestError } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it, vi } from "vitest"

import { refusalError } from "../acp/validation"
import { createLifecycleCommandGuard } from "./lifecycle-command-guard"
import { CommandRefusedError, runCommand, type MemberCommands } from "./member"

const HINT = "Session commands run in the client, not as a prompt."

type Guarded =
  | { kind: "send"; command: MemberCommands["send"] }
  | { kind: "steer"; command: MemberCommands["steer"] }

/** A send whose text parts are `parts`, its own text `text`. */
const send = (text: string, parts: readonly string[] = [text]): Guarded => ({
  kind: "send",
  command: {
    sessionId: "session-1",
    text,
    content: parts.map((part) => ({ kind: "text", text: part })),
  },
})
const steer = (text: string): Guarded => ({
  kind: "steer",
  command: { sessionId: "session-1", requestId: "steer-1", text },
})

/** Runs one command through the guard; `next` records what passed it. */
async function guarded(entry: Guarded) {
  const next = vi.fn()
  const stack = [createLifecycleCommandGuard()]
  const ran =
    entry.kind === "send"
      ? runCommand(stack, "send", entry.command, async (command) => {
          next(command)
          return { messageId: "message-1" }
        })
      : runCommand(stack, "steer", entry.command, async (command) => {
          next(command)
          return { status: "steered" }
        })
  return {
    outcome: await ran.then(
      () => undefined,
      (error: unknown) => error
    ),
    next,
  }
}

describe("the lifecycle command guard", () => {
  it.each<[string, Guarded, boolean]>([
    ["refuses /reset", send("/reset"), true],
    ["refuses /Resume with an argument", send("/Resume x"), true],
    ["refuses /reset behind a zero-width space", send("\u200B/reset"), true],
    ["refuses /New behind a space", send(" /New"), true],
    ["refuses /quit behind a byte order mark", send("\uFEFF/quit"), true],
    [
      "refuses /clear in a text part alone",
      send("Hello", ["Hello", "/clear"]),
      true,
    ],
    ["refuses a steer with /exit", steer("/exit"), true],
    ["passes /branch, which forks", send("/branch try"), false],
    ["passes /fork", send("/fork"), false],
    ["passes /compress with arguments", send("/compress here 5"), false],
    ["passes a longer command name", send("/reset-password please"), false],
    [
      "passes /compress behind a zero-width space",
      send("\u200B/compress"),
      false,
    ],
    ["passes a steer with /stop", steer("/stop"), false],
    ["passes prose", send("Start a new session, please"), false],
  ])("%s", async (_name, entry, refused) => {
    const { outcome, next } = await guarded(entry)

    if (refused) {
      expect(outcome).toBeInstanceOf(CommandRefusedError)
      expect(outcome).toMatchObject({ refusal: "invalid", hint: HINT })
      expect(next).not.toHaveBeenCalled()
    } else {
      expect(outcome).toBeUndefined()
      expect(next).toHaveBeenCalledExactlyOnceWith(entry.command)
    }
  })

  it("answers a refusal with ACP's invalid params, carrying its hint", () => {
    const error = refusalError("invalid", HINT)

    expect(error).toBeInstanceOf(RequestError)
    expect(error.code).toBe(-32602)
    expect(error.message).toContain(HINT)
  })
})
