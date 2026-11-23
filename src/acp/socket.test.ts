import { describe, expect, it } from "vitest"

import { HGW_JSONRPC_ERRORS, HGW_METHODS } from "../../protocol/acp"

import { createAcpSocket, type AcpSocketOptions } from "./socket"
import { authenticationRequired, notFound, PUBLIC_ERRORS } from "./validation"

const NOW = 1_700_000_000_000
const NOT_FOUND = notFound().code
/** The frame the SDK begins its handshake on. */
const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: { protocolVersion: 2 },
})
/** A request under an id ACP v2 forbids, a number but no integer. */
const NON_INTEGER_ID = {
  jsonrpc: "2.0",
  id: 0.5,
  method: "session/prompt",
  params: { sessionId: "ref" },
}

function harness(overrides: Partial<AcpSocketOptions> = {}) {
  const closed: Array<{ code: number; reason: string }> = []
  const messages: string[] = []
  const closes: unknown[] = []
  const sent: string[] = []
  let now = NOW
  const socket = createAcpSocket({
    close: (code, reason) => closed.push({ code, reason }),
    send: (raw) => sent.push(raw),
    now: () => now,
    ...overrides,
  })
  socket.socket.addEventListener?.("message", (event) => {
    messages.push(String((event as { data: unknown }).data))
  })
  socket.socket.addEventListener?.("close", (event) => closes.push(event))
  return {
    socket,
    closed,
    messages,
    closes,
    sent,
    advance(milliseconds: number) {
      now += milliseconds
    },
  }
}

describe("ACP WebSocket shim", () => {
  it("delivers text and decoded binary frames to the SDK listener", () => {
    const { socket, messages } = harness()

    socket.receive('{"jsonrpc":"2.0"}')
    socket.receive(new TextEncoder().encode('{"id":1}'))

    expect(messages).toEqual(['{"jsonrpc":"2.0"}', '{"id":1}'])
  })

  it("delivers a frame at the frame cap and closes with 1008 one byte past it", () => {
    // One prompt as large as a frame may carry stays inside the default byte
    // budget: closing here would end every Session on the tab's one socket.
    const atCap = harness()
    atCap.socket.receive("a".repeat(1_100_000))
    expect(atCap.closed).toEqual([])
    expect(atCap.messages).toHaveLength(1)

    const { socket, closed, messages, closes } = harness()

    socket.receive("a".repeat(1_100_001))

    expect(closed).toEqual([{ code: 1008, reason: "ACP frame too large" }])
    expect(messages).toEqual([])
    expect(closes).toHaveLength(1)
  })

  it("closes with 1008 when the inbound rate window overflows", () => {
    const { socket, closed, messages, advance } = harness({
      inputWindowMs: 1_000,
      maxInputFramesPerWindow: 2,
    })

    socket.receive("1")
    socket.receive("2")
    expect(closed).toEqual([])

    advance(1_000)
    socket.receive("3")
    socket.receive("4")
    expect(closed).toEqual([])

    socket.receive("5")
    expect(messages).toEqual(["1", "2", "3", "4"])
    expect(closed).toEqual([{ code: 1008, reason: "ACP rate exceeded" }])
  })

  it("passes the SDK's buffer and stall closes on as 4409, and its other limit closes as 1008", () => {
    const stalled = harness()
    stalled.socket.socket.close(
      1008,
      "Connection output stalled for maxOutputStallMs (60000)"
    )
    const exceeded = harness()
    exceeded.socket.socket.close(
      1008,
      "Connection exceeds maxBufferedBytes (1)"
    )
    const idLength = harness()
    idLength.socket.socket.close(1008, "Connection exceeds maxIdLength (1024)")

    expect(stalled.closed.map(({ code }) => code)).toEqual([4409])
    expect(exceeded.closed.map(({ code }) => code)).toEqual([4409])
    expect(idLength.closed.map(({ code }) => code)).toEqual([1008])
  })

  it("closes with 1008 when the inbound byte window overflows", () => {
    const { socket, closed } = harness({ maxInputBytesPerWindow: 8 })

    socket.receive("123456789")

    expect(closed).toEqual([{ code: 1008, reason: "ACP rate exceeded" }])
  })

  // The SDK writes no batch, but an array written all the same is made
  // public entry by entry: redaction fails closed.
  it("writes each error reply, batched or not, as its public code alone", () => {
    const { socket, sent } = harness({ publicErrors: PUBLIC_ERRORS })
    const unavailable = {
      code: HGW_JSONRPC_ERRORS.temporarilyUnavailable,
      message: "temporarily_unavailable",
    }

    socket.socket.send(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, result: {} },
        {
          jsonrpc: "2.0",
          id: 2,
          error: {
            code: HGW_JSONRPC_ERRORS.turnInProgress,
            message: "internal detail 7f3a",
            data: "internal detail 7f3a",
          },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          error: { code: "internal detail 7f3a", message: "private" },
        },
      ])
    )
    socket.socket.send(
      JSON.stringify({ jsonrpc: "2.0", id: 4, error: "internal detail 7f3a" })
    )

    expect(sent.map((raw) => JSON.parse(raw) as unknown)).toEqual([
      [
        { jsonrpc: "2.0", id: 1, result: {} },
        {
          jsonrpc: "2.0",
          id: 2,
          error: {
            code: HGW_JSONRPC_ERRORS.turnInProgress,
            message: "turn_in_progress",
          },
        },
        { jsonrpc: "2.0", id: 3, error: unavailable },
      ],
      { jsonrpc: "2.0", id: 4, error: unavailable },
    ])
  })

  // ACP has a not-found name the Session the request named; a guest is shown
  // that id, its own, and never one the gateway wrote in its place.
  it("names back on a not-found only the Session the request named as a string", () => {
    const { socket, sent } = harness({ publicErrors: PUBLIC_ERRORS })
    const request = (id: number, sessionId: unknown) =>
      socket.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "session/prompt",
          params: { sessionId },
        })
      )
    const reply = (id: number, code: number) =>
      socket.socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code,
            message: "internal detail 7f3a",
            data: {
              sessionId: "stored-native",
              detail: "internal detail 7f3a",
            },
          },
        })
      )
    request(1, "ref")
    request(2, "ref")
    request(3, 7)
    request(4, "ref")
    socket.socket.send(JSON.stringify({ jsonrpc: "2.0", id: 4, result: {} }))

    reply(1, NOT_FOUND)
    reply(2, HGW_JSONRPC_ERRORS.turnInProgress)
    reply(3, NOT_FOUND)
    // Its request was answered already, so nothing names a Session for it.
    reply(4, NOT_FOUND)

    expect(sent.slice(-4).map((raw) => JSON.parse(raw) as unknown)).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: NOT_FOUND,
          message: "not_found",
          data: { sessionId: "ref" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        error: {
          code: HGW_JSONRPC_ERRORS.turnInProgress,
          message: "turn_in_progress",
        },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        error: { code: NOT_FOUND, message: "not_found" },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        error: { code: NOT_FOUND, message: "not_found" },
      },
    ])
  })

  // The SDK answers these with `id: null`, or closes on them, so no reply
  // would ever settle a record of them.
  it.each([
    [
      "without the JSON-RPC envelope",
      { id: 1, method: "session/prompt", params: { sessionId: "ref" } },
    ],
    [
      "with an id ACP v2 forbids",
      {
        jsonrpc: "2.0",
        id: 0.5,
        method: "session/prompt",
        params: { sessionId: "ref" },
      },
    ],
    [
      "whose id is past the SDK's id length",
      {
        jsonrpc: "2.0",
        id: "i".repeat(1_025),
        method: "session/prompt",
        params: { sessionId: "ref" },
      },
    ],
    [
      "naming a Session id past the SDK's id length",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "session/prompt",
        params: { sessionId: "r".repeat(1_025) },
      },
    ],
  ])("records nothing of a request %s", (_label, frame) => {
    const { socket, sent } = harness({ publicErrors: PUBLIC_ERRORS })
    socket.receive(JSON.stringify(frame))

    socket.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        error: { code: NOT_FOUND, message: "not found" },
      })
    )

    expect(JSON.parse(sent[0]!)).toEqual({
      jsonrpc: "2.0",
      id: frame.id,
      error: { code: NOT_FOUND, message: "not_found" },
    })
  })

  // The SDK keeps a route for each request until an answer under its id, but
  // ACP v2 answers a non-integer id under `null`, so each such request would
  // hold its route until the socket closed.
  it.each([
    [
      "operator",
      {},
      "Invalid request: ACP v2 request IDs must be strings or integers",
    ],
    ["guest", { publicErrors: PUBLIC_ERRORS }, "malformed_request"],
  ])(
    "answers a request with a non-integer id on the %s listener as the SDK does, and hands the SDK none of it",
    (_listener, overrides, message) => {
      const { socket, messages, sent } = harness(overrides)
      const valid = JSON.stringify({ ...NON_INTEGER_ID, id: 2 })
      socket.receive(INITIALIZE)
      socket.receive(JSON.stringify(NON_INTEGER_ID))
      socket.receive(valid)

      expect(messages).toEqual([INITIALIZE, valid])
      expect(sent.map((raw) => JSON.parse(raw) as unknown)).toEqual([
        { jsonrpc: "2.0", id: null, error: { code: -32600, message } },
      ])
    }
  )

  it.each([
    ["before its handshake, on which it closes", [], NON_INTEGER_ID],
    [
      "that is an initialize, which it answers itself",
      [INITIALIZE],
      { ...NON_INTEGER_ID, method: "initialize" },
    ],
    [
      "naming a Session id past its id length, on which it closes",
      [INITIALIZE],
      { ...NON_INTEGER_ID, params: { sessionId: "r".repeat(1_025) } },
    ],
    [
      "whose id is null, which it answers and frees under null",
      [INITIALIZE],
      { ...NON_INTEGER_ID, id: null },
    ],
  ])(
    "hands the SDK a request with an id ACP v2 forbids %s",
    (_label, before, frame) => {
      const { socket, messages, sent } = harness({
        publicErrors: PUBLIC_ERRORS,
      })
      for (const earlier of before) socket.receive(earlier)
      socket.receive(JSON.stringify(frame))

      expect(messages).toEqual([...before, JSON.stringify(frame)])
      expect(sent).toEqual([])
    }
  )

  it("records at most its bound of unanswered requests, dropping none to make room", () => {
    const { socket, sent } = harness({
      publicErrors: PUBLIC_ERRORS,
      maxNamedRequests: 2,
    })
    for (const id of [1, 2, 3])
      socket.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "session/prompt",
          params: { sessionId: `ref-${id}` },
        })
      )

    for (const id of [3, 1])
      socket.socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: NOT_FOUND, message: "not found" },
        })
      )

    expect(sent.map((raw) => JSON.parse(raw) as unknown)).toEqual([
      {
        jsonrpc: "2.0",
        id: 3,
        error: { code: NOT_FOUND, message: "not_found" },
      },
      {
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: NOT_FOUND,
          message: "not_found",
          data: { sessionId: "ref-1" },
        },
      },
    ])
  })

  it("writes a listener's error notice as its Session and a public code alone", () => {
    const { socket, sent } = harness({ publicErrors: PUBLIC_ERRORS })
    const notice = (params: Record<string, unknown>) =>
      socket.socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: HGW_METHODS.notify.error,
          params,
        })
      )

    notice({ sessionId: "ref", code: "not_found", message: "not_found" })
    notice({ sessionId: "ref", code: "private detail", detail: "private" })
    notice({ code: 7, message: "private" })

    expect(sent.map((raw) => JSON.parse(raw) as unknown)).toEqual([
      {
        jsonrpc: "2.0",
        method: HGW_METHODS.notify.error,
        params: { sessionId: "ref", code: "not_found", message: "not_found" },
      },
      {
        jsonrpc: "2.0",
        method: HGW_METHODS.notify.error,
        params: {
          sessionId: "ref",
          code: "internal_error",
          message: "internal_error",
        },
      },
      {
        jsonrpc: "2.0",
        method: HGW_METHODS.notify.error,
        params: { code: "internal_error", message: "internal_error" },
      },
    ])
  })

  it("refuses a request once the credential lapsed, as the last frame before it closes", () => {
    let lapsed = false
    const written: string[] = []
    const test = harness({
      lapsed: () => lapsed,
      send: (raw) => written.push(raw),
    })
    test.socket.receive('{"jsonrpc":"2.0","id":1,"method":"session/prompt"}')

    lapsed = true
    test.socket.receive('{"jsonrpc":"2.0","id":2,"method":"session/prompt"}')
    test.socket.receive('{"jsonrpc":"2.0","id":3,"method":"session/prompt"}')

    expect(test.messages).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"session/prompt"}',
    ])
    expect(written.map((raw) => JSON.parse(raw) as unknown)).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        error: expect.objectContaining({
          code: authenticationRequired().code,
        }),
      },
    ])
    expect(test.closed).toEqual([
      { code: 1008, reason: "ACP credential lapsed" },
    ])
  })

  it("writes nothing once the credential lapsed, and closes", () => {
    const written: string[] = []
    const test = harness({
      lapsed: () => true,
      send: (raw) => written.push(raw),
    })

    test.socket.socket.send('{"jsonrpc":"2.0","method":"session/update"}')

    expect(written).toEqual([])
    expect(test.closed).toEqual([
      { code: 1008, reason: "ACP credential lapsed" },
    ])
  })

  it("forwards an SDK-initiated close to the peer exactly once", () => {
    const { socket, closed, closes } = harness()

    socket.socket.close(1002, "First message must be initialize")
    socket.socket.close(1011, "later")

    expect(closed).toEqual([
      { code: 1002, reason: "First message must be initialize" },
    ])
    expect(closes).toHaveLength(1)
  })

  it("ends the SDK session on a transport close without closing the peer", () => {
    const { socket, closed, closes, messages, sent } = harness()

    socket.close()
    socket.close()
    socket.receive('{"jsonrpc":"2.0"}')
    socket.socket.send("ignored")

    expect(closes).toHaveLength(1)
    expect(closed).toEqual([])
    expect(messages).toEqual([])
    expect(sent).toEqual([])
  })
})
