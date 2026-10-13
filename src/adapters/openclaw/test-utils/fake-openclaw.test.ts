import type { EventFrame } from "@openclaw/gateway-protocol"
import { describe, expect, it } from "vitest"

import type { OpenClawGatewayClientOptions } from "../client"
import { fakeOpenClaw } from "./fake-openclaw"

const MAIN = "agent:research:main"

/** One connection to `openclaw`, up, with every event it hears. */
async function dial(openclaw = fakeOpenClaw()) {
  const events: EventFrame[] = []
  const gateway = openclaw.createGatewayClient({
    onEvent: (event) => events.push(event),
  } as OpenClawGatewayClientOptions)
  gateway.start()
  await Promise.resolve()
  const request = <T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {}
  ) => gateway.request<T>(method, params)
  return { openclaw, events, request }
}

function texts(history: Record<string, unknown>) {
  return (history.messages as Array<{ role: string; content: unknown }>).map(
    ({ role, content }) =>
      `${role}:${(content as Array<{ text?: string }>)
        .map(({ text }) => text ?? "")
        .join("")}`
  )
}

/** Sends `message` on `sessionKey` and ends the played run, stored as `reply`. */
async function turn(
  native: Awaited<ReturnType<typeof dial>>,
  sessionKey: string,
  message: string,
  reply = "Done."
) {
  await native.request("chat.send", {
    sessionKey,
    message,
    idempotencyKey: `turn-${message}`,
  })
  await native.openclaw.turn.secondResponse(reply)
}

describe("fakeOpenClaw", () => {
  it("keeps each Session's transcript and transcript id under its own key", async () => {
    const native = await dial()
    const created = await native.request<{ key: string; sessionId: string }>(
      "sessions.create",
      { agentId: "research" }
    )
    await turn(native, created.key, "Hello")

    const own = await native.request("chat.history", {
      sessionKey: created.key,
    })
    const main = await native.request("chat.history", { sessionKey: MAIN })

    expect(created.key).not.toBe(MAIN)
    expect(own).toMatchObject({
      sessionKey: created.key,
      sessionId: created.sessionId,
    })
    expect(texts(own)).toEqual(["user:Hello", "assistant:Done."])
    expect(main.sessionId).not.toBe(created.sessionId)
    expect(texts(main)).toEqual([])
  })

  it("rewinds a Session before a user entry onto a new transcript, refusing a working one", async () => {
    const native = await dial()
    await turn(native, MAIN, "First")
    await turn(native, MAIN, "Second")
    const before = await native.request<{
      sessionId: string
      messages: Array<{ __openclaw: { id: string } }>
    }>("chat.history", { sessionKey: MAIN })
    const second = before.messages[2]!.__openclaw.id

    await expect(
      native.request("sessions.rewind", { sessionKey: MAIN, entryId: "msg-0" })
    ).rejects.toThrow("unknown entry")
    await expect(
      native.request("sessions.rewind", { sessionKey: MAIN })
    ).rejects.toThrow("invalid sessions.rewind params")
    const rewound = await native.request("sessions.rewind", {
      sessionKey: MAIN,
      agentId: "research",
      entryId: second,
    })
    const after = await native.request("chat.history", { sessionKey: MAIN })
    await native.request("chat.send", {
      sessionKey: MAIN,
      message: "Third",
      idempotencyKey: "turn-third",
    })

    expect(rewound).toEqual({ editorText: "Second" })
    // Refused calls count too: a test can prove none was made.
    expect(native.openclaw.requested("sessions.rewind")).toBe(3)
    expect(after.sessionId).not.toBe(before.sessionId)
    expect(texts(after)).toEqual(["user:First", "assistant:Done."])
    await expect(
      native.request("sessions.rewind", { sessionKey: MAIN, entryId: second })
    ).rejects.toThrow("Rewind is unavailable while the agent is working")
  })

  it("forks a Session's active path into a listed one, refusing a running parent unless it forks its last completed reply", async () => {
    const native = await dial()
    await turn(native, MAIN, "Hello", "Hi there.")
    const params = {
      agentId: "research",
      parentSessionKey: MAIN,
      fork: true,
      label: "Forked",
      idempotencyKey: "fork-1",
    }

    const forked = await native.request<{ key: string; sessionId: string }>(
      "sessions.create",
      params
    )
    const again = await native.request("sessions.create", params)
    await native.request("chat.send", {
      sessionKey: MAIN,
      message: "Still going",
      idempotencyKey: "turn-running",
    })
    await expect(
      native.request("sessions.create", { ...params, idempotencyKey: "f-2" })
    ).rejects.toThrow("fork a running session from last-completed")
    const running = await native.request<{ key: string }>("sessions.create", {
      ...params,
      idempotencyKey: "fork-3",
      forkFrom: "last-completed",
    })
    const listed = await native.request<{
      sessions: Array<Record<string, unknown>>
    }>("sessions.list", { agentId: "research" })

    expect(again).toEqual(forked)
    expect(
      texts(await native.request("chat.history", { sessionKey: forked.key }))
    ).toEqual(["user:Hello", "assistant:Hi there."])
    expect(
      texts(await native.request("chat.history", { sessionKey: running.key }))
    ).toEqual(["user:Hello", "assistant:Hi there."])
    expect(listed.sessions).toContainEqual(
      expect.objectContaining({
        key: forked.key,
        label: "Forked",
        parentSessionKey: MAIN,
        forkSource: { sessionKey: MAIN, sessionId: "transcript-a" },
        forkedFromParent: true,
        toolOverrides: { mcpServers: { "aos-ui": true } },
      })
    )
    expect(
      listed.sessions.find(({ key }) => key === forked.key)
    ).not.toHaveProperty("spawnedBy")
  })

  it("streams a spawned child only to a connection that subscribed it, and its tools only once Session events are subscribed", async () => {
    const native = await dial()
    await native.request("chat.send", {
      sessionKey: MAIN,
      message: "Delegate",
      idempotencyKey: "turn-delegate",
    })
    const child = await native.openclaw.spawn()

    const result = native.events.find(
      ({ payload }) =>
        (payload as { data?: { phase?: string } }).data?.phase === "result"
    )
    child.say("Unheard.")
    await native.request("sessions.messages.subscribe", {
      key: child.key,
      agentId: "research",
    })
    child.say("Heard.")
    const grandchildBeforeTools = native.openclaw.spawn(child.key)
    let spawnedEarly = false
    void grandchildBeforeTools.then(() => (spawnedEarly = true))
    await Promise.resolve()
    expect(spawnedEarly).toBe(false)
    await native.request("sessions.subscribe")
    const grandchild = await grandchildBeforeTools
    child.complete("Counted.")
    const listed = await native.request<{
      sessions: Array<Record<string, unknown>>
    }>("sessions.list", { spawnedBy: MAIN })

    expect(result?.payload).toMatchObject({
      sessionKey: MAIN,
      data: {
        name: "sessions_spawn",
        toolCallId: child.toolCallId,
        result: {
          details: {
            status: "accepted",
            childSessionKey: child.key,
            runId: expect.any(String),
          },
        },
      },
    })
    const heard = native.events
      .filter(
        ({ payload }) =>
          (payload as { sessionKey?: string }).sessionKey === child.key
      )
      .map(({ payload }) => {
        const { stream, data, state } = payload as Record<string, never>
        return (
          state ??
          `${stream}:${(data as { delta?: string; phase?: string }).delta ?? (data as { phase?: string }).phase}`
        )
      })
    expect(heard).toEqual([
      "assistant:Heard.",
      "tool:start",
      "tool:result",
      "lifecycle:end",
      "final",
    ])
    expect(listed.sessions).toEqual([
      expect.objectContaining({
        key: child.key,
        spawnedBy: MAIN,
        spawnDepth: 1,
        parentSessionKey: MAIN,
        createdVia: "spawn",
      }),
    ])
    expect(native.openclaw.stored(grandchild.key)).toMatchObject({
      spawnedBy: child.key,
      spawnDepth: 2,
    })
    expect(
      texts(await native.request("chat.history", { sessionKey: child.key }))
    ).toEqual([
      "user:Count the names in the file.",
      // The child's own spawn: its call, then its result.
      "assistant:",
      expect.stringContaining(`toolResult:{"status":"accepted"`),
      "assistant:Counted.",
    ])
  })

  it("aborts a child's run alone, and a parent's abort ends its children's too", async () => {
    const native = await dial()
    await native.request("chat.send", {
      sessionKey: MAIN,
      message: "Delegate",
      idempotencyKey: "turn-delegate",
    })
    const first = await native.openclaw.spawn()
    const second = await native.openclaw.spawn()

    const aborted = await native.request("sessions.abort", {
      key: first.key,
      agentId: "research",
    })
    const parentRunning = native.openclaw.stored(MAIN).run
    const cascaded = await native.request("sessions.abort", {
      key: MAIN,
      agentId: "research",
    })

    expect(aborted).toMatchObject({ ok: true, status: "aborted" })
    expect(parentRunning).toBeDefined()
    expect(cascaded).toMatchObject({
      ok: true,
      status: "aborted",
      abortedRunId: "turn-delegate",
    })
    expect(native.openclaw.stored(first.key).run).toBeUndefined()
    expect(native.openclaw.stored(second.key).run).toBeUndefined()
  })

  it("pushes a child's approval to its parent's audience, naming the child as its source", async () => {
    const native = await dial()
    await native.request("chat.send", {
      sessionKey: MAIN,
      message: "Delegate",
      idempotencyKey: "turn-delegate",
    })
    const child = await native.openclaw.spawn()

    const settled = child.ask()
    const pending = native.events.at(-1)!.payload as {
      approval: { id: string }
    }
    await native.request("approval.resolve", {
      id: pending.approval.id,
      kind: "plugin",
      decision: "allow-once",
    })
    await settled

    expect(pending).toMatchObject({
      sessionKey: MAIN,
      sourceSessionKey: child.key,
      phase: "pending",
      approval: {
        sourceSessionKey: child.key,
        presentation: { agentId: "research" },
      },
    })
    expect(native.events.at(-1)!.payload).toMatchObject({
      sessionKey: MAIN,
      phase: "terminal",
      approval: { source: { sessionKey: child.key }, status: "allowed" },
    })
  })
})
