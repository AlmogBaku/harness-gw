import { describe, expect, it, vi } from "vitest"

import {
  PendingRequestKind,
  ReplyStatus,
  type PendingRequest,
} from "../../core/events"
import { runCommand, runEvents, type MemberCommands } from "../../core/member"
import { createGuestMiddleware } from "."

const REF = "invited-ref"
const M = "[credential redacted]"
const secret = ["token", "abcdefgh1234"].join("=")
const other = ["token", "zyxw9876"].join("=")
const masked = ["token", M].join("=")

const stack = createGuestMiddleware({
  grant: { agentId: "agent", ref: REF, principalId: "guest", expiresAt: 100 },
  catalog: { invited: async () => undefined },
  guestActiveExecutions: 1,
})

const question: PendingRequest = {
  requestId: "q1",
  kind: PendingRequestKind.Elicitation,
  questions: [
    { choices: [secret, other], multiple: false, custom: true, text: "Which?" },
  ],
}

// A guest's whole stack: credentials sit innermost, so every other layer reads
// a masked question and the runtime reads the choice it wrote.
describe("a guest's stack", () => {
  it("shows a guest a question masked and answers the runtime with the choice it wrote", async () => {
    const shown = runEvents(
      stack,
      { sessionId: REF, kind: "request-asked", request: question },
      { decline: () => undefined }
    )
    const execute = vi.fn<(command: MemberCommands["answer"]) => Promise<void>>(
      async () => undefined
    )
    const picked = [[`${masked} (option 2)`]]

    await runCommand(
      stack,
      "answer",
      {
        sessionId: REF,
        request: question,
        reply: {
          requestId: "q1",
          status: ReplyStatus.Resolved,
          payload: { answers: picked },
        },
        answers: picked,
      },
      execute
    )

    expect(shown).toMatchObject({
      request: {
        questions: [
          { choices: [`${masked} (option 1)`, `${masked} (option 2)`] },
        ],
      },
    })
    expect(execute.mock.calls[0]?.[0].reply.payload).toEqual({
      answers: [[other]],
    })
  })
})
