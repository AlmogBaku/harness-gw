import { describe, expect, it, vi } from "vitest"

import type { SessionHistoryResponse } from "../../protocol"
import { createCredentialsMiddleware } from "./credentials-middleware"
import {
  DiffOperation,
  PendingRequestKind,
  ReplyStatus,
  TurnEventKind,
  type ChildTurnEvent,
  type PendingRequest,
  type TurnEvent,
} from "./events"
import { runEvents, type MemberCommands, type MemberEvent } from "./member"

const M = "[credential redacted]"
/** A synthetic value, assigned in two parts so no scanner reads it as a leak. */
const SECRET = "abcdefgh1234"
const assigned = (name: string, value = SECRET) => [name, value].join("=")

const operator = [createCredentialsMiddleware()]
const guest = [createCredentialsMiddleware({ guest: true })]
const decline = () => undefined

/** One turn event as a member is shown it through `stack`. */
function shownTurn(event: TurnEvent, stack = operator) {
  const shown = runEvents(
    stack,
    {
      sessionId: "s1",
      kind: "turn",
      stream: { turnId: "turn-1", replayedCorrections: 0, dropped: false },
      sequence: 1,
      event,
      stopping: false,
    },
    { decline }
  )
  return shown?.kind === "turn" ? shown.event : undefined
}

function shown(event: MemberEvent, stack = operator) {
  return runEvents(stack, event, { decline })
}

describe("credentials middleware: tool data, for every runtime and both listeners", () => {
  const open = {
    kind: TurnEventKind.ToolCallStarted,
    toolCallId: "c1",
    title: "terminal",
  } as const

  // Each row is one field a reader sees, whichever runtime reported it.
  it.each<[string, TurnEvent, Record<string, unknown>]>([
    [
      "the title",
      { ...open, title: `deploy --${assigned("token")}` },
      { title: `deploy --${assigned("token", M)}` },
    ],
    [
      "the arguments, which stay JSON",
      {
        kind: TurnEventKind.ToolCallInputChunk,
        toolCallId: "c1",
        delta: JSON.stringify({
          command: `export ${assigned("TOKEN")}`,
          apiKey: SECRET,
        }),
      },
      {
        delta: JSON.stringify({
          command: `export ${assigned("TOKEN", M)}`,
          apiKey: M,
        }),
      },
    ],
    [
      "streamed output",
      {
        kind: TurnEventKind.ToolCallOutputChunk,
        toolCallId: "c1",
        text: assigned("token"),
      },
      { text: assigned("token", M) },
    ],
    [
      "the result",
      {
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "c1",
        output: `password: ${SECRET}`,
        failed: false,
      },
      { output: `password: ${M}` },
    ],
    [
      "a terminal's command and output",
      {
        kind: TurnEventKind.TerminalOutput,
        terminalId: "t1",
        toolCallId: "c1",
        command: `export ${assigned("TOKEN")}`,
        data: `password: ${SECRET}`,
      },
      { command: `export ${assigned("TOKEN", M)}`, data: `password: ${M}` },
    ],
    [
      "a failed run's message",
      {
        kind: TurnEventKind.TurnFailed,
        code: "HGW_PROVIDER_RUN_FAILED",
        message: `Hermes could not complete this turn.\nhttps://h.test/api?${assigned("token")}`,
      },
      {
        message: `Hermes could not complete this turn.\nhttps://h.test/api?${assigned("token", M)}`,
      },
    ],
  ])("masks %s", (_field, event, expected) => {
    const masked = shownTurn(event)

    expect(JSON.stringify(masked)).not.toContain(SECRET)
    expect(masked).toMatchObject(expected)
  })

  // A path or a patch a mask would break is dropped, not masked.
  it("drops a location, a diff, a working directory, and a subagent's file that carry a credential, masking its prose", () => {
    const leaked = `/srv/${assigned("token")}`
    const started = shownTurn({
      ...open,
      locations: [{ path: "/srv/app/a.ts" }, { path: leaked }],
      subagent: {
        id: "sub-1",
        goal: `log in with ${assigned("password")}`,
        summary: "Read the logs.",
        filesRead: ["/srv/app/a.ts", leaked],
      },
    })
    const finished = shownTurn({
      kind: TurnEventKind.ToolCallFinished,
      toolCallId: "c1",
      output: "ok",
      failed: false,
      diffs: [
        {
          changes: [{ operation: DiffOperation.Modify, path: "/srv/app/a.ts" }],
          patch: `--- a/a.ts\n+${assigned("const token")}`,
        },
        { changes: [{ operation: DiffOperation.Add, path: leaked }] },
      ],
    })
    const terminal = shownTurn({
      kind: TurnEventKind.TerminalOutput,
      terminalId: "t1",
      toolCallId: "c1",
      cwd: leaked,
    })

    expect(started).toMatchObject({
      locations: [{ path: "/srv/app/a.ts" }],
      subagent: {
        id: "sub-1",
        goal: `log in with ${assigned("password", M)}`,
        summary: "Read the logs.",
        filesRead: ["/srv/app/a.ts"],
      },
    })
    expect(finished).toMatchObject({
      diffs: [
        {
          changes: [{ operation: DiffOperation.Modify, path: "/srv/app/a.ts" }],
        },
      ],
    })
    expect(JSON.stringify([started, finished, terminal])).not.toContain(SECRET)
  })

  // A child Session's report and its own events reach a member as the
  // child's, so the masker reads them where they travel: on a child event.
  it("masks a child Session's report and its own tool data, dropping a file that carries a credential", () => {
    const leaked = `/srv/${assigned("token")}`
    const shownChild = (event: ChildTurnEvent) => {
      const shown = runEvents(
        operator,
        {
          sessionId: "child-1",
          kind: "child",
          parentSessionId: "s1",
          stream: { turnId: "turn-1", replayedCorrections: 0, dropped: false },
          sequence: 1,
          event,
        },
        { decline }
      )
      return shown?.kind === "child" ? shown.event : undefined
    }

    const reported = shownChild({
      kind: TurnEventKind.ChildSessionUpdated,
      childSessionId: "child-1",
      title: `log in with ${assigned("password")}`,
      description: "Read the logs.",
      summary: `found ${assigned("api_key")}`,
      filesRead: ["/srv/app/a.ts", leaked],
    })
    const called = shownChild({
      kind: TurnEventKind.ChildSessionEvent,
      childSessionId: "child-1",
      event: {
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "c1",
        output: `env: ${assigned("token")}`,
        failed: false,
      },
    })

    expect(reported).toMatchObject({
      title: `log in with ${assigned("password", M)}`,
      description: "Read the logs.",
      filesRead: ["/srv/app/a.ts"],
    })
    expect(JSON.stringify([reported, called])).not.toContain(SECRET)
  })

  it("sends JSON arguments with nothing to mask exactly as written", () => {
    const delta = '{ "path" : "a.txt" }'

    expect(
      shownTurn({
        kind: TurnEventKind.ToolCallInputChunk,
        toolCallId: "c1",
        delta,
      })
    ).toMatchObject({ delta })
  })

  // Only a terminal is cut, to the tail a browser keeps of one.
  it("masks a large JSON output whole, keeping it JSON", () => {
    const output = JSON.stringify({ apiKey: SECRET, pad: "x".repeat(300_000) })
    const masked = shownTurn({
      kind: TurnEventKind.ToolCallFinished,
      toolCallId: "c1",
      output,
      failed: false,
    })

    expect(
      masked?.kind === TurnEventKind.ToolCallFinished &&
        JSON.parse(masked.output)
    ).toEqual({ apiKey: M, pad: "x".repeat(300_000) })
  })

  it("drops the word a terminal's kept tail cuts into, so no name loses its head", () => {
    // The tail starts inside `DB_PASSWORD`: read whole, `WORD` names nothing.
    const tail = `WORD=${SECRET} `
    const masked = shownTurn({
      kind: TurnEventKind.TerminalOutput,
      terminalId: "t1",
      toolCallId: "c1",
      data: `x DB_PASS${tail}${"y".repeat(262_144 - tail.length)}`,
    })

    expect(JSON.stringify(masked)).not.toContain(SECRET)
  })

  it("masks a replayed call and a replayed failure as the live ones were", () => {
    const command = `export ${assigned("TOKEN")}`
    const page: SessionHistoryResponse = {
      sessionId: "s1",
      messages: [
        {
          id: "a1",
          role: "assistant",
          createdAt: "2026-09-19T09:00:01.000Z",
          status: {
            type: "incomplete",
            reason: "error",
            error: `Hermes could not complete this turn.\n${assigned("token")}`,
          },
          content: [
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "terminal",
              args: { command },
              argsText: JSON.stringify({ command }),
              result: { apiKey: SECRET },
              locations: [{ path: `/srv/${assigned("token")}` }],
            },
          ],
        },
      ],
      total: 1,
      limit: 500,
      offset: 0,
      nextOffset: 0,
    }

    const replayed = shown({
      sessionId: "s1",
      kind: "history",
      page,
      sequence: 0,
    })

    expect(JSON.stringify(replayed)).not.toContain(SECRET)
    expect(replayed).toMatchObject({
      page: {
        messages: [
          {
            status: {
              error: `Hermes could not complete this turn.\n${assigned("token", M)}`,
            },
            content: [
              {
                args: { command: `export ${assigned("TOKEN", M)}` },
                result: { apiKey: M },
                locations: [],
              },
            ],
          },
        ],
      },
    })
  })
})

describe("credentials middleware: questions", () => {
  const question: PendingRequest = {
    requestId: "q1",
    kind: PendingRequestKind.Elicitation,
    questions: [
      {
        text: `Use ${assigned("token")} or the other one?`,
        choices: [assigned("token"), assigned("token", "zyxw9876"), "neither"],
        multiple: false,
        custom: true,
      },
    ],
  }
  const asked: MemberEvent = {
    sessionId: "s1",
    kind: "request-asked",
    request: question,
  }

  // The operator answers what the runtime wrote, so they read it as written.
  it("shows the operator a question and its answers exactly as written", () => {
    const answered: MemberEvent = {
      sessionId: "s1",
      kind: "question-answered",
      request: question,
      answers: [[assigned("token")]],
    }

    expect(shown(asked)).toEqual(asked)
    expect(shown(answered)).toEqual(answered)
  })

  it("shows a guest a question masked, its choices still telling which", () => {
    expect(shown(asked, guest)).toMatchObject({
      request: {
        questions: [
          {
            text: `Use ${assigned("token", M)} or the other one?`,
            choices: [
              `${assigned("token", M)} (option 1)`,
              `${assigned("token", M)} (option 2)`,
              "neither",
            ],
          },
        ],
      },
    })
  })

  it("answers the runtime with the choice a guest picked as the runtime wrote it, and free text as typed", async () => {
    const [layer] = guest
    const next = vi.fn<(sent: MemberCommands["answer"]) => Promise<void>>(
      async () => undefined
    )
    const command: MemberCommands["answer"] = {
      sessionId: "s1",
      request: question,
      reply: {
        requestId: "q1",
        status: ReplyStatus.Resolved,
        payload: { answers: [[`${assigned("token", M)} (option 2)`]] },
      },
      answers: [[`${assigned("token", M)} (option 2)`]],
    }

    await layer!.commands!.answer!(command, next)
    await layer!.commands!.answer!(
      {
        ...command,
        reply: { ...command.reply, payload: { answers: [["something else"]] } },
        answers: [["something else"]],
      },
      next
    )

    expect(next.mock.calls.map(([sent]) => sent.reply.payload)).toEqual([
      { answers: [[assigned("token", "zyxw9876")]] },
      { answers: [["something else"]] },
    ])
  })

  it("shows a guest the answers echoed back masked", () => {
    expect(
      shown(
        {
          sessionId: "s1",
          kind: "question-answered",
          request: question,
          answers: [[assigned("token")]],
        },
        guest
      )
    ).toMatchObject({ answers: [[assigned("token", M)]] })
  })
})
