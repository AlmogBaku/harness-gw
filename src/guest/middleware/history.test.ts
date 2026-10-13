import { describe, expect, it, vi } from "vitest"

import type { SessionHistoryResponse } from "../../../protocol"
import { guestErrorDescription } from "../../auth/guest-projection"
import {
  CommandRefusedError,
  type MemberAct,
  type MemberCommands,
  type MemberEvent,
} from "../../core/member"
import { createHistoryMiddleware, projectGuestHistory } from "./history"

describe("guest history projection", () => {
  it("keeps normalized recovery state and hides any first-turn envelope, whatever it asks", () => {
    const projected = projectGuestHistory(
      {
        sessionId: "stored",
        messages: [
          {
            id: "seed",
            role: "user",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  v: 1,
                  type: "aos.guest.first-turn",
                  instruction: "Private setup",
                }),
              },
            ],
            createdAt: "2026-09-15T00:00:00.000Z",
          },
        ],
        total: 1,
        limit: 200,
        offset: 0,
        nextOffset: 1,
        execution: { status: "running", turnId: "run-1" },
      },
      "ref"
    )

    expect(projected.messages).toEqual([])
    expect(projected.execution).toEqual({ status: "running", turnId: "run-1" })
  })

  it("hides the first-turn envelope on whichever page holds it, and nothing else", () => {
    const envelope = JSON.stringify({
      v: 1,
      type: "aos.guest.first-turn",
      instruction: "Private setup",
    })
    const text = (id: string, role: "user" | "assistant", body: string) => ({
      id,
      role,
      content: [{ type: "text" as const, text: body }],
      createdAt: "2026-09-15T00:00:00.000Z",
    })
    // Three pages of one Session, newest first, as a guest scrolls back.
    const pages = [
      [text("next", "user", "Next"), text("answer-3", "assistant", "Three")],
      [text("hello", "user", "Hello"), text("answer-2", "assistant", "Two")],
      [text("seed", "user", envelope), text("answer-1", "assistant", "One")],
    ].map((messages, index) =>
      projectGuestHistory(
        {
          sessionId: "stored",
          messages,
          total: 6,
          limit: 2,
          offset: index * 2,
          nextOffset: index * 2 + 2,
        },
        "ref"
      )
    )

    expect(
      pages.map((page) => page.messages.map((message) => message.id))
    ).toEqual([["next", "answer-3"], ["hello", "answer-2"], ["answer-1"]])
  })

  it("keeps no correction flag on a projected user turn", () => {
    const projected = projectGuestHistory(
      {
        sessionId: "stored",
        messages: [
          {
            id: "prompt",
            role: "user",
            content: [{ type: "text", text: "Summarize the notes" }],
            createdAt: "2026-09-15T00:00:00.000Z",
          },
          {
            id: "correction",
            role: "user",
            content: [{ type: "text", text: "Use the tables" }],
            createdAt: "2026-09-15T00:00:01.000Z",
            correction: true as const,
          },
        ],
        total: 2,
        limit: 200,
        offset: 0,
        nextOffset: 2,
      },
      "ref"
    )

    // The projection rebuilds every message, so a resume must count the
    // corrections it owes the journal on the authoritative page instead.
    expect(projected.messages).toHaveLength(2)
    for (const message of projected.messages)
      expect(message).not.toHaveProperty("metadata")
  })

  it("keeps a turn the provider started on its own apart for a guest, without its notice", () => {
    const projected = projectGuestHistory(
      {
        sessionId: "stored",
        messages: [
          {
            id: "wake-thought",
            role: "assistant",
            content: [
              {
                type: "data",
                name: "hgw-notice",
                data: { severity: "info", title: "/loop wakeup #1" },
              },
              { type: "reasoning", text: "Check it" },
            ],
            createdAt: "2026-09-15T00:00:00.000Z",
            opensTurn: true,
          },
          {
            id: "wake",
            role: "assistant",
            content: [{ type: "text", text: "TICK" }],
            createdAt: "2026-09-15T00:00:01.000Z",
          },
        ],
        total: 2,
        limit: 200,
        offset: 0,
        nextOffset: 2,
      },
      "ref"
    )

    // A guest is not shown the thought, so the reply opens the turn instead.
    expect(projected.messages).toEqual([
      expect.objectContaining({
        id: "wake",
        opensTurn: true,
        content: [{ type: "text", text: "TICK" }],
      }),
    ])
    expect(JSON.stringify(projected)).not.toContain("loop wakeup")
  })

  it("keeps a restored failed turn failed for a guest", () => {
    const projected = projectGuestHistory(
      {
        sessionId: "stored",
        messages: [
          {
            id: "ask",
            role: "user",
            content: [{ type: "text", text: "Summarize the filing" }],
            createdAt: "2026-09-15T00:00:00.000Z",
          },
          {
            id: "failed",
            role: "assistant",
            content: [{ type: "text", text: "I could not reach the model." }],
            createdAt: "2026-09-15T00:00:01.000Z",
            status: {
              type: "incomplete",
              reason: "error",
              error:
                "Hermes' model provider returned an error for this turn. Retry, switch models with /model, or continue in a new Session.",
            },
            turnErrorCode: "HGW_PROVIDER_RETRYABLE_FAILURE",
          },
        ],
        total: 2,
        limit: 200,
        offset: 0,
        nextOffset: 2,
      },
      "ref"
    )

    expect(projected.messages[1]).toMatchObject({
      id: "failed",
      role: "assistant",
      content: [{ type: "text", text: "I could not reach the model." }],
      status: {
        type: "incomplete",
        reason: "error",
        error: guestErrorDescription("temporarily_unavailable"),
      },
    })
    expect(projected.messages[1]).not.toHaveProperty("metadata")
    expect(JSON.stringify(projected)).not.toContain("Hermes")
  })

  it("keeps a restored failed turn that streamed no text", () => {
    const projected = projectGuestHistory(
      {
        sessionId: "stored",
        messages: [
          {
            id: "silent",
            role: "assistant",
            content: [],
            createdAt: "2026-09-15T00:00:01.000Z",
            status: {
              type: "incomplete",
              reason: "error",
              error: "Hermes could not complete this turn.",
            },
          },
        ],
        total: 1,
        limit: 200,
        offset: 0,
        nextOffset: 1,
      },
      "ref"
    )

    expect(projected.messages[0]).toMatchObject({
      id: "silent",
      content: [],
      status: {
        type: "incomplete",
        reason: "error",
        error: guestErrorDescription("request_failed"),
      },
    })
  })

  it("never projects the provider detail of a restored failure to a guest", () => {
    const projected = projectGuestHistory(
      {
        sessionId: "stored",
        messages: [
          {
            id: "failed",
            role: "assistant",
            content: [],
            createdAt: "2026-09-15T00:00:01.000Z",
            status: {
              type: "incomplete",
              reason: "error",
              error:
                "Hermes' model provider returned an error for this turn. Retry, switch models with /model, or continue in a new Session.\nAn error occurred (ValidationException) when calling the InvokeModel operation",
            },
            turnErrorCode: "HGW_PROVIDER_RETRYABLE_FAILURE",
          },
        ],
        total: 1,
        limit: 200,
        offset: 0,
        nextOffset: 1,
      },
      "ref"
    )

    expect(projected.messages[0]).toMatchObject({
      status: {
        type: "incomplete",
        reason: "error",
        error: guestErrorDescription("temporarily_unavailable"),
      },
    })
    expect(JSON.stringify(projected)).not.toContain("ValidationException")
  })

  it("preserves only normalized attachment metadata in guest history", () => {
    const projected = projectGuestHistory(
      {
        sessionId: "stored",
        messages: [
          {
            id: "message",
            role: "user",
            content: [{ type: "text", text: "what do you see?" }],
            attachments: [
              {
                id: "message:attachment:0",
                type: "file",
                name: "click.mov",
                contentType: "video/quicktime",
                status: { type: "complete" },
                content: [],
              },
            ],
            createdAt: "2026-09-15T00:00:00.000Z",
          },
        ],
        total: 1,
        limit: 200,
        offset: 0,
        nextOffset: 1,
      },
      "ref"
    )

    expect(projected.messages[0]).toMatchObject({
      content: [{ type: "text", text: "what do you see?" }],
      attachments: [
        {
          type: "file",
          name: "click.mov",
          contentType: "video/quicktime",
        },
      ],
    })
    expect(JSON.stringify(projected)).not.toContain(".hermes")
    expect(JSON.stringify(projected)).not.toContain("@file:")
  })

  it("drops a system notice", () => {
    const projected = projectGuestHistory(
      {
        ...page([{ id: "ask", role: "user", text: "Hello" }]),
        messages: [
          {
            id: "notice",
            role: "system",
            content: [{ type: "text", text: "Private notice" }],
            createdAt: "2026-09-15T00:00:00.000Z",
          },
          ...page([{ id: "ask", role: "user", text: "Hello" }]).messages,
        ],
      },
      "ref"
    )

    expect(projected.messages.map((message) => message.id)).toEqual(["ask"])
  })

  // A guest is not shown compaction live, so its history holds none either;
  // only the plan, which it is shown, passes, and any activity added later is
  // hidden until it is allowed.
  it("passes the plan alone of the Session's activity", () => {
    const plan = {
      id: "plan",
      role: "activity" as const,
      activityType: "PLAN" as const,
      content: { todos: [] },
    }
    const projected = projectGuestHistory(
      {
        ...page([{ id: "ask", role: "user", text: "Hello" }]),
        messages: [
          plan,
          {
            id: "compacted",
            role: "activity",
            activityType: "COMPACTION",
            content: { compactionId: "k1", summary: "Private summary" },
          },
          ...page([{ id: "ask", role: "user", text: "Hello" }]).messages,
        ],
      },
      "ref"
    )

    expect(projected.messages.map((message) => message.id)).toEqual([
      "plan",
      "ask",
    ])
  })

  it("keeps a long message whole", () => {
    const text = "x".repeat(20_000)
    const projected = projectGuestHistory(
      page([
        { id: "ask", role: "user", text },
        { id: "reply", role: "assistant", text },
      ]),
      "ref"
    )

    expect(projected.messages.map((message) => message.content)).toEqual([
      [{ type: "text", text }],
      [{ type: "text", text }],
    ])
  })

  it("keeps an App call's result from an allowlisted server, and never any call's arguments", () => {
    const call = (toolCallId: string, toolName: string) => ({
      type: "tool-call" as const,
      toolCallId,
      toolName,
      args: { path: "/private/report.pdf" },
      argsText: '{"path":"/private/report.pdf"}',
      result: { structuredContent: { value: { filename: "report.pdf" } } },
      app: true as const,
    })
    const history = page([])
    history.messages = [
      {
        id: "reply",
        role: "assistant",
        content: [
          call("file-1", "present_artifact"),
          call("board-1", "mcp__excalidraw__create_view"),
        ],
        createdAt: "2026-09-15T00:00:00.000Z",
      },
    ]

    const [reply] = projectGuestHistory(history, "ref", ["aos-ui"]).messages
    expect(reply?.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "file-1",
        toolName: "present_artifact",
        args: {},
        argsText: "",
        result: { structuredContent: { value: { filename: "report.pdf" } } },
        app: true,
      },
      {
        type: "tool-call",
        toolCallId: "board-1",
        toolName: "mcp__excalidraw__create_view",
        args: {},
        argsText: "",
        app: true,
      },
    ])
    expect(JSON.stringify(reply)).not.toContain("/private")
  })

  it("replays a provider-held Artifact as it streamed live, and never inline data", () => {
    const held = {
      id: "art-1",
      filename: "episode-memo.md",
      mimeType: "text/markdown",
      source: { type: "provider" as const, reference: "art-1" },
    }
    const history = page([])
    history.messages = [
      {
        id: "reply",
        role: "assistant",
        content: [
          { type: "data", name: "hgw.artifact", data: held },
          {
            type: "data",
            name: "hgw.artifact",
            data: {
              id: "inline-1",
              filename: "secret.txt",
              source: { type: "inline", encoding: "utf8", data: "private" },
            },
          },
        ],
        createdAt: "2026-09-15T00:00:00.000Z",
      },
    ]

    const [reply] = projectGuestHistory(history, "ref").messages
    expect(reply?.content).toEqual([
      { type: "data", name: "hgw.artifact", data: held },
    ])
  })
})

const SETUP = JSON.stringify({
  v: 1,
  type: "aos.guest.first-turn",
  instruction: "Private setup",
})

/** One history page of text messages. */
function page(
  messages: Array<{ id: string; role: "user" | "assistant"; text: string }>
): SessionHistoryResponse {
  return {
    sessionId: "stored",
    messages: messages.map(({ id, role, text }) => ({
      id,
      role,
      content: [{ type: "text", text }],
      createdAt: "2026-09-15T00:00:00.000Z",
    })),
    total: messages.length,
    limit: 200,
    offset: 0,
    nextOffset: messages.length,
  }
}

const act: MemberAct = { decline: () => undefined }

/** A guest's history layer, and what an Edit or Retry of `sourceId` does. */
function guarded() {
  const middleware = createHistoryMiddleware({
    grant: {
      agentId: "agent",
      ref: "ref",
      principalId: "guest_ref",
      expiresAt: 100,
    },
  })
  const next = vi.fn(async () => ({ messageId: "sent" }))
  return {
    show: (event: MemberEvent) => middleware.event?.(event, act),
    rewind: (rewindSourceId: string) => {
      const command: MemberCommands["send"] = {
        sessionId: "ref",
        content: [{ kind: "text", text: "Again" }],
        text: "Again",
        rewindSourceId,
      }
      return middleware.commands?.send?.(command, next)
    },
    next,
  }
}

describe("guest Edit and Retry", () => {
  it("refuses a message the guest was never shown, the setup turn among them", async () => {
    const test = guarded()
    test.show({
      sessionId: "ref",
      kind: "history",
      sequence: 0,
      page: page([
        { id: "seed", role: "user", text: SETUP },
        { id: "reply", role: "assistant", text: "Welcome" },
      ]),
    })

    for (const id of ["seed", "reply", "never-shown"])
      await expect(test.rewind(id), id).rejects.toBeInstanceOf(
        CommandRefusedError
      )
    expect(test.next).not.toHaveBeenCalled()
  })

  it("runs on a message the guest was shown in history or as a prompt", async () => {
    const test = guarded()
    test.show({
      sessionId: "ref",
      kind: "history",
      sequence: 0,
      page: page([{ id: "stored-ask", role: "user", text: "Hello" }]),
    })
    test.show({
      sessionId: "ref",
      kind: "prompt",
      messageId: "live-ask",
      content: [{ kind: "text", text: "Next" }],
      own: true,
    })

    for (const id of ["stored-ask", "live-ask"])
      await expect(test.rewind(id), id).resolves.toEqual({
        messageId: "sent",
      })
    expect(test.next).toHaveBeenCalledTimes(2)
  })
})
