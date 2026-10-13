import { describe, expect, it, vi } from "vitest"

import type { SessionHistoryResponse } from "../../protocol"
import { createCredentialsMiddleware } from "./credentials-middleware"
import {
  DiffOperation,
  PendingRequestKind,
  ReplyStatus,
  TurnEventKind,
  type ChildTurnEvent,
  type OwnTurnEvent,
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
function shownTurn(event: TurnEvent, stack = operator, sessionId = "s1") {
  const shown = runEvents(
    stack,
    {
      sessionId,
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
  it("drops a location, a diff, and a working directory that carry a credential", () => {
    const leaked = `/srv/${assigned("token")}`
    const started = shownTurn({
      ...open,
      locations: [{ path: "/srv/app/a.ts" }, { path: leaked }],
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

  it("masks a stored child Session as its live report was", () => {
    const leaked = `/srv/${assigned("token")}`
    const page: MemberEvent = {
      sessionId: "s1",
      kind: "history",
      sequence: 0,
      page: {
        sessionId: "s1",
        messages: [
          {
            id: "child-row",
            role: "activity",
            activityType: "CHILD_SESSION",
            content: {
              childSessionId: "child-1",
              title: `log in with ${assigned("password")}`,
              summary: "Read the logs.",
              filesWritten: ["/srv/app/a.ts", leaked],
            },
          },
        ],
        total: 1,
        limit: 500,
        offset: 0,
        nextOffset: 0,
      },
    }

    const masked = shown(page)

    expect(masked).toMatchObject({
      page: {
        messages: [
          {
            content: {
              title: `log in with ${assigned("password", M)}`,
              summary: "Read the logs.",
              filesWritten: ["/srv/app/a.ts"],
            },
          },
        ],
      },
    })
    expect(JSON.stringify(masked)).not.toContain(SECRET)
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

  // The tool that asked is part of the question: its call carries the operator's answers.
  // A child asks its questions through the same tool, so its call is part of
  // the question too; the child's other tool data is masked as any is.
  it("shows the operator a child Session's question tool call as written, masking its other calls", () => {
    const stack = [createCredentialsMiddleware()]
    const shownChild = (event: OwnTurnEvent) => {
      const shown = runEvents(
        stack,
        {
          sessionId: "child-1",
          kind: "child",
          parentSessionId: "s1",
          stream: { turnId: "turn-1", replayedCorrections: 0, dropped: false },
          sequence: 1,
          event: {
            kind: TurnEventKind.ChildSessionEvent,
            childSessionId: "child-1",
            event,
          },
        },
        { decline }
      )
      return shown?.kind === "child" &&
        shown.event.kind === TurnEventKind.ChildSessionEvent
        ? shown.event.event
        : undefined
    }
    const asked: OwnTurnEvent[] = [
      {
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "q1",
        title: "question",
        name: "question",
      },
      {
        kind: TurnEventKind.ToolCallInputChunk,
        toolCallId: "q1",
        delta: JSON.stringify({ question: `Use ${assigned("token")}?` }),
      },
    ]
    const other: OwnTurnEvent = {
      kind: TurnEventKind.ToolCallFinished,
      toolCallId: "c2",
      output: `env: ${assigned("token")}`,
      failed: false,
    }

    expect(asked.map(shownChild)).toEqual(asked)
    expect(JSON.stringify(shownChild(other))).not.toContain(SECRET)
  })

  it("shows the operator the question tool's call as written, live and replayed, and a guest it masked", () => {
    const args = { question: `Use ${assigned("token")}?` }
    const result = { status: "answered", answers: [assigned("token")] }
    const live: TurnEvent[] = [
      {
        kind: TurnEventKind.ToolCallStarted,
        toolCallId: "q1",
        title: "question",
        name: "question",
      },
      {
        kind: TurnEventKind.ToolCallInputChunk,
        toolCallId: "q1",
        delta: JSON.stringify(args),
      },
      {
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: "q1",
        output: JSON.stringify(result),
        failed: false,
      },
    ]
    const history: MemberEvent = {
      sessionId: "s1",
      kind: "history",
      sequence: 0,
      page: {
        sessionId: "s1",
        messages: [
          {
            id: "a1",
            role: "assistant",
            createdAt: "2026-09-19T09:00:01.000Z",
            content: [
              {
                type: "tool-call",
                toolCallId: "q1",
                toolName: "question",
                args,
                argsText: JSON.stringify(args),
                result,
              },
            ],
          },
        ],
        total: 1,
        limit: 500,
        offset: 0,
        nextOffset: 0,
      },
    }

    expect(live.map((event) => shownTurn(event))).toEqual(live)
    expect(shown(history)).toEqual(history)
    expect(
      JSON.stringify([
        live.map((event) => shownTurn(event, guest)),
        shown(history, guest),
      ])
    ).not.toContain(SECRET)
  })

  // Each eviction masks: a call forgotten too early shows its answers masked, never a credential.
  it("forgets a Session's question calls when its turn ends and the oldest past ten, never another Session's", () => {
    const stack = [createCredentialsMiddleware()]
    const ask = (sessionId: string, toolCallId: string) =>
      shownTurn(
        {
          kind: TurnEventKind.ToolCallStarted,
          toolCallId,
          title: "question",
          name: "question",
        },
        stack,
        sessionId
      )
    const answered = (sessionId: string, toolCallId: string) =>
      JSON.stringify(
        shownTurn(
          {
            kind: TurnEventKind.ToolCallFinished,
            toolCallId,
            output: assigned("token"),
            failed: false,
          },
          stack,
          sessionId
        )
      ).includes(SECRET)

    ask("s2", "kept")
    for (let index = 0; index <= 10; index += 1) ask("s1", `q${index}`)
    ask("s3", "ended")
    shownTurn({ kind: TurnEventKind.TurnEnded }, stack, "s3")

    expect([
      answered("s1", "q0"),
      answered("s1", "q1"),
      answered("s2", "kept"),
      answered("s3", "ended"),
    ]).toEqual([false, true, true, false])
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
