/**
 * The browser fault rows' shared setup: a browser connection to the harness
 * proxy over piped sockets, the frames it sends, and the transcript it holds.
 * Only a test file may import the proxy, so each row hands its harness in.
 */
import { onTestFinished, vi } from "vitest"

import type { AgentCatalogResponse } from "../../protocol"

import { createAcpConnection } from "../connection"
import type { AcpConnection } from "../types"
import { PipedSocket, pipedSockets } from "../test-socket"

/** What a browser connection needs of the harness proxy. */
type Harness = {
  agentApp: Parameters<typeof pipedSockets>[0]
  catalog: { agents(): Promise<AgentCatalogResponse> }
  scope: { agentId: string }
  close(): void
}

/**
 * A browser connection to the harness proxy over piped sockets, not started.
 * The test fakes the clock first, so every deadline runs on it. The catalog
 * lists the harness's Agent, as the roster a browser opens a Session from
 * does, so the browser names that Agent's folder.
 */
export function connectBrowser<T extends Harness>(test: T) {
  vi.spyOn(test.catalog, "agents").mockResolvedValue({
    revision: "rev-1",
    agents: [
      {
        summary: { kind: "ready", id: test.scope.agentId, name: "Agent" },
        visibility: "visible",
        selectable: true,
        editable: false,
        avatarEditable: false,
        revision: "rev-1",
      },
    ],
  })
  const pipe = pipedSockets(test.agentApp)
  const connection = createAcpConnection({
    clientInfo: { name: "aos-ui", version: "1" },
    url: "ws://proxy.test/api/v1/acp",
    socketConstructor: pipe.WebSocket,
  })
  onTestFinished(() => {
    connection.close()
    test.close()
  })
  return { test, pipe, connection }
}

export type Frame = {
  method?: string
  params?: {
    sessionId?: string
    replayFrom?: { type: string }
    _meta?: { hgw?: { clientId?: string } }
  }
}

/**
 * Every frame the browser sends, in order. `fault` sees each as it leaves and
 * may fault its socket instead, so the proxy never receives that frame.
 */
export function sentFrames(
  fault?: (frame: Frame, socket: PipedSocket) => boolean
) {
  const frames: Frame[] = []
  const send = PipedSocket.prototype.send
  vi.spyOn(PipedSocket.prototype, "send").mockImplementation(function (
    this: PipedSocket,
    data: string
  ) {
    const frame = JSON.parse(data) as Frame
    frames.push(frame)
    if (!fault?.(frame, this)) send.call(this, data)
  })
  return frames
}

export const methodsOf = (frames: Frame[], session: string) =>
  frames.flatMap((frame) =>
    frame.params?.sessionId === session && frame.method ? [frame.method] : []
  )

type Recorded = { role: string; text: string }

const ROLES: Readonly<Record<string, string>> = {
  user_message: "user",
  user_message_chunk: "user",
  agent_message: "assistant",
  agent_message_chunk: "assistant",
}

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content.map(textOf).join("")
    : typeof content === "object" &&
        content !== null &&
        "type" in content &&
        content.type === "text" &&
        "text" in content &&
        typeof content.text === "string"
      ? content.text
      : ""

/**
 * Records what the connection hands a Session's subscriber: each message's
 * text by its id, a whole message replacing its text and a chunk appending
 * to it, and a from-start replay replacing everything before it once its
 * first update lands or it settles replayed. Reads the transcript as
 * `role: text`, one line per message.
 */
export function watchTranscript(
  connection: AcpConnection,
  { agentId, sessionId }: { agentId: string; sessionId: string }
) {
  const messages = new Map<string, Recorded>()
  let replacing = false
  connection.subscribe(sessionId, {
    agentId,
    update: (update) => {
      if (replacing) messages.clear()
      replacing = false
      const role = ROLES[update.sessionUpdate]
      if (!role || !("messageId" in update)) return
      const id = update.messageId
      if (typeof id !== "string" || !id) return
      const text = textOf("content" in update ? update.content : undefined)
      const whole = !update.sessionUpdate.endsWith("_chunk")
      const before = messages.get(id)?.text ?? ""
      messages.set(id, {
        role,
        text: whole ? text : before + text,
      })
    },
    replay: () => {
      replacing = true
      return (replayed) => {
        if (replacing && replayed) messages.clear()
        replacing = false
      }
    },
  })
  return () =>
    [...messages.values()].map(({ role, text }) => `${role}: ${text}`)
}
