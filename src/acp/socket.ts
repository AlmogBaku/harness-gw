import {
  DEFAULT_MAX_ID_LENGTH,
  type PreparedWebSocketUpgrade,
} from "@agentclientprotocol/sdk/experimental/server"
import {
  methods,
  RequestError,
} from "@agentclientprotocol/sdk/experimental/v2/unstable"

import {
  ACP_PROTOCOL_VERSION,
  HGW_MAX_FRAME_BYTES,
  HGW_METHODS,
} from "../../protocol/acp"
import { authenticationRequired } from "./validation"

/** The WebSocket shape a prepared ACP upgrade drives. */
export type AcpWebSocket = Parameters<PreparedWebSocketUpgrade["accept"]>[0]

/** One inbound frame may carry a whole prompt, matching `boundedJson`'s ceiling. */
const MAX_FRAME_BYTES = HGW_MAX_FRAME_BYTES
const DEFAULT_INPUT_WINDOW_MS = 1_000
const DEFAULT_INPUT_FRAMES_PER_WINDOW = 64
/**
 * Room for one frame at the cap and the same second's ordinary traffic. A
 * budget below the cap closed the tab's one socket, and with it every
 * Session, on a single large prompt.
 */
const DEFAULT_INPUT_BYTES_PER_WINDOW = 2 * MAX_FRAME_BYTES
/**
 * The unanswered requests naming a Session one socket records, while failures
 * are made public. The ACP SDK bounds no number of pending requests, so this
 * is the gateway's: a guest reaches one invited Session, and a real tab holds
 * a few requests naming it at once (its resume, prompt, steer or page), so
 * the bound is a backstop that keeps a flood to about 256 KiB a socket, each
 * entry two ids of at most `DEFAULT_MAX_ID_LENGTH`.
 */
const DEFAULT_MAX_NAMED_REQUESTS = 64

/**
 * What ACP v2 answers a request whose id is a number but no integer
 * (`rejectInvalidRequestId`, `v2/acp.js`): `-32600` under `id: null`.
 */
const NON_INTEGER_ID_REPLY = JSON.stringify({
  jsonrpc: "2.0",
  id: null,
  error: RequestError.invalidRequest(
    undefined,
    "ACP v2 request IDs must be strings or integers"
  ).toErrorResponse(),
})

const decoder = new TextDecoder()

/** A JSON-RPC error reply's `error` member. */
export type AcpErrorReply = { code: number; message: string; data?: unknown }

/**
 * How a listener shows its failures: an error reply's code, whatever it is, as
 * a public reply, and an `_hgw/error` notification's code as a public code.
 * `sessionId` is the Session the request a reply answers named, if it named
 * one as a string: what alone a public not-found may name back.
 */
export type PublicErrors = {
  reply(code: unknown, sessionId?: string): AcpErrorReply
  notice(code: unknown): string
}

export type AcpSocketOptions = {
  /** Closes the concrete WebSocket. Authorization happens before this shim exists. */
  close(code: number, reason: string): void
  /**
   * Delivers one serialized frame to the concrete WebSocket. Called directly
   * for every outbound SDK frame; backpressure and drops are handled by the
   * Bun listener's own limits.
   */
  send(raw: string): void
  /**
   * Bytes the concrete WebSocket still holds unsent. The ACP SDK pauses its
   * output on it; without it, the SDK never limits what it sends.
   */
  bufferedAmount?: () => number
  /**
   * Whether the connection's credential has lapsed. From then on no frame
   * passes either way: a request is refused, and the connection closes.
   */
  lapsed?: () => boolean
  /** How a failure is shown; as written by default. */
  publicErrors?: PublicErrors
  now?: () => number
  inputWindowMs?: number
  maxInputFramesPerWindow?: number
  maxInputBytesPerWindow?: number
  /** At most this many unanswered requests' Sessions are recorded at once. */
  maxNamedRequests?: number
}

export type AcpSocket = {
  /** Handed to the prepared ACP upgrade so the SDK owns the JSON-RPC session. */
  socket: AcpWebSocket
  /** Delivers one inbound frame from the concrete WebSocket to the SDK. */
  receive(raw: string | Uint8Array): void
  /** Releases the SDK session after a peer or transport close without closing twice. */
  close(): void
}

/**
 * Inbound WebSocket shim between Bun's `ServerWebSocket` handlers and the ACP
 * SDK, with an inbound frame cap and an inbound rate window. Outbound frames
 * are written directly through `send`; Bun's own backpressure limit and
 * `closeOnBackpressureLimit` bound the outbound side. Pure logic: it touches
 * no Bun global and takes its clock from `now`.
 */
export function createAcpSocket(options: AcpSocketOptions): AcpSocket {
  const now = options.now ?? Date.now
  const inputWindowMs = positiveLimit(
    options.inputWindowMs,
    DEFAULT_INPUT_WINDOW_MS
  )
  const maxInputFrames = positiveLimit(
    options.maxInputFramesPerWindow,
    DEFAULT_INPUT_FRAMES_PER_WINDOW
  )
  const maxInputBytes = positiveLimit(
    options.maxInputBytesPerWindow,
    DEFAULT_INPUT_BYTES_PER_WINDOW
  )
  const maxNamed = positiveLimit(
    options.maxNamedRequests,
    DEFAULT_MAX_NAMED_REQUESTS
  )

  const listeners = new Map<string, Set<(event: unknown) => void>>()
  /**
   * The Session each request still unanswered named, by its id, while
   * failures are made public: the reply to it may name that id back, and
   * nothing the gateway wrote in its place. Once full it records no more, so
   * a request past the bound is answered without its Session, and none is
   * dropped to make room.
   */
  const named = new Map<string | number, string>()
  /** Whether a frame the SDK begins its handshake on has passed. */
  let handshaking = false
  let closed = false
  let windowStartedAt = now()
  let windowFrames = 0
  let windowBytes = 0

  function dispatch(type: string, event: unknown) {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event)
  }

  /** Ends the session and closes the concrete WebSocket with a reason. */
  function closePeer(code: number, reason: string) {
    if (closed) return
    closed = true
    options.close(code, reason)
    dispatch("close", { type: "close", code, reason })
    listeners.clear()
    named.clear()
  }

  /**
   * Answers a request a lapsed credential sent that authentication is
   * required, so it is the last frame written, and closes the connection.
   */
  function refuse(data: string) {
    const id = requestIdOf(parsed(data))
    if (id !== undefined) {
      const { code, message } = authenticationRequired()
      options.send(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })
      )
    }
    closePeer(1008, "ACP credential lapsed")
  }

  function exceedsInputRate(bytes: number) {
    const currentTime = now()
    if (currentTime - windowStartedAt >= inputWindowMs) {
      windowStartedAt = currentTime
      windowFrames = 0
      windowBytes = 0
    }
    windowFrames += 1
    windowBytes += bytes
    return windowFrames > maxInputFrames || windowBytes > maxInputBytes
  }

  const socket: AcpWebSocket = {
    send(raw) {
      if (closed) return
      if (options.lapsed?.()) {
        closePeer(1008, "ACP credential lapsed")
        return
      }
      options.send(
        options.publicErrors
          ? publicFrame(raw, options.publicErrors, named)
          : raw
      )
    },
    get bufferedAmount() {
      return options.bufferedAmount?.() ?? 0
    },
    close(code, reason) {
      closePeer(peerCloseCode(code ?? 1000, reason ?? ""), reason ?? "")
    },
    addEventListener(type, listener) {
      const existing = listeners.get(type)
      if (existing) existing.add(listener)
      else listeners.set(type, new Set([listener]))
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
  }

  return {
    socket,
    receive(raw) {
      if (closed) return
      const bytes = frameSize(raw)
      if (bytes > MAX_FRAME_BYTES) {
        closePeer(1008, "ACP frame too large")
        return
      }
      if (exceedsInputRate(bytes)) {
        closePeer(1008, "ACP rate exceeded")
        return
      }
      const data = typeof raw === "string" ? raw : decoder.decode(raw)
      if (options.lapsed?.()) {
        refuse(data)
        return
      }
      const frame = parsed(data)
      // Answered here as the SDK would answer it, so the SDK keeps no route
      // for it that its answer would never free.
      if (handshaking && strandsRoute(frame)) {
        socket.send(NON_INTEGER_ID_REPLY)
        return
      }
      if (beginsHandshake(frame)) handshaking = true
      if (options.publicErrors) {
        const request = namedSessionOf(frame)
        if (request && (named.has(request.id) || named.size < maxNamed))
          named.set(request.id, request.sessionId)
      }
      dispatch("message", {
        type: "message",
        data: askingVersion2(data, frame),
      })
    },
    close() {
      if (closed) return
      closed = true
      dispatch("close", { type: "close" })
      listeners.clear()
      named.clear()
    },
  }
}

/**
 * The ACP SDK closes with 1008 for every limit it enforces. Its buffer and
 * stall limits mean a reader that fell behind, which is transient: those
 * leave with 4409, which the client reconnects on, so a tab that slept
 * through a large replay comes back. Its other limits stay terminal.
 */
export const READER_FELL_BEHIND = 4409
const READER_LIMITS = /\b(maxBufferedBytes|maxOutputStallMs)\b/u

function peerCloseCode(code: number, reason: string) {
  return code === 1008 && READER_LIMITS.test(reason) ? READER_FELL_BEHIND : code
}

/** A frame's JSON, or `undefined` for one that is not JSON. */
function parsed(data: string): unknown {
  try {
    return JSON.parse(data) as unknown
  } catch {
    return undefined
  }
}

/** The id of the one JSON-RPC request a frame carries, if it carries one. */
function requestIdOf(frame: unknown): string | number | undefined {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame))
    return undefined
  const { id, method } = frame as { id?: unknown; method?: unknown }
  return typeof method === "string" &&
    (typeof id === "string" || typeof id === "number")
    ? id
    : undefined
}

/**
 * The one request a frame carries and the Session it names as a string, where
 * the SDK answers that request under its own id, so the reply settles it. The
 * SDK answers `id: null` to a frame without the `jsonrpc: "2.0"` envelope
 * (`isRequestMessage`, `core/jsonrpc.js`) and to an id ACP v2 forbids, `null`
 * or a non-integer number (`isV2RequestId`), and closes the connection on a
 * string id or a Session id longer than `maxIdLength` (`validateRequestId`,
 * `validateSessionId`, `transports/connection.js`), which the gateway leaves
 * at `DEFAULT_MAX_ID_LENGTH`. None of those is recorded.
 */
function namedSessionOf(frame: unknown) {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame))
    return undefined
  const { jsonrpc, id, method, params } = frame as {
    jsonrpc?: unknown
    id?: unknown
    method?: unknown
    params?: unknown
  }
  if (jsonrpc !== "2.0" || typeof method !== "string" || !answeredUnder(id))
    return undefined
  const sessionId =
    typeof params === "object" && params !== null
      ? (params as { sessionId?: unknown }).sessionId
      : undefined
  return typeof sessionId === "string" && withinIdLength(sessionId)
    ? { id, sessionId }
    : undefined
}

/**
 * Whether the SDK begins its handshake on a frame: an `initialize` it reads
 * as a request (`isRequestMessage`, `core/jsonrpc.js`) under an id other than
 * `null` (`handleInitialize`, `transports/ws-server.js`). Before one, it
 * closes the connection on any other request itself.
 */
function beginsHandshake(frame: unknown) {
  if (typeof frame !== "object" || frame === null) return false
  const { jsonrpc, id, method } = frame as {
    jsonrpc?: unknown
    id?: unknown
    method?: unknown
  }
  return (
    jsonrpc === "2.0" &&
    method === methods.agent.initialize &&
    (typeof id === "string" || Number.isFinite(id))
  )
}

/**
 * Whether the SDK, once its handshake began, would keep a route for a frame
 * that nothing frees until the socket closes. It keeps one for each request
 * under its id (`trackInboundRoutes`, `transports/ws-server.js`), and frees
 * it on the answer under that id (`routeOutboundResponse`,
 * `transports/connection.js`); ACP v2 answers an id that is a finite number
 * but no integer under `null` (`rejectInvalidRequestId`, `v2/acp.js`), so its
 * route stays. The SDK answers an `initialize` itself and keeps no route for
 * it, frees a `null` id's route under `null`, and closes on a Session id past
 * `DEFAULT_MAX_ID_LENGTH` before it keeps one, so none of those strands one.
 */
function strandsRoute(frame: unknown) {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame))
    return false
  const { jsonrpc, id, method, params } = frame as {
    jsonrpc?: unknown
    id?: unknown
    method?: unknown
    params?: unknown
  }
  if (
    jsonrpc !== "2.0" ||
    typeof method !== "string" ||
    method === methods.agent.initialize ||
    !Number.isFinite(id) ||
    Number.isInteger(id)
  )
    return false
  const sessionId =
    typeof params === "object" && params !== null
      ? (params as { sessionId?: unknown }).sessionId
      : undefined
  return typeof sessionId !== "string" || withinIdLength(sessionId)
}

/** Whether the SDK answers a request under `id` itself. */
function answeredUnder(id: unknown): id is string | number {
  return typeof id === "string" ? withinIdLength(id) : Number.isInteger(id)
}

function withinIdLength(id: string) {
  return id.length <= DEFAULT_MAX_ID_LENGTH
}

/**
 * A frame whose `initialize` asks for a version, with that version set to 2,
 * so the SDK answers the one version it serves rather than refusing the
 * handshake. Every other frame is passed on untouched.
 */
function askingVersion2(data: string, frame: unknown) {
  if (typeof frame !== "object" || frame === null) return data
  const { method, params } = frame as { method?: unknown; params?: unknown }
  if (
    method !== methods.agent.initialize ||
    typeof params !== "object" ||
    params === null ||
    Array.isArray(params)
  )
    return data
  const { protocolVersion } = params as { protocolVersion?: unknown }
  if (
    !Number.isInteger(protocolVersion) ||
    protocolVersion === ACP_PROTOCOL_VERSION
  )
    return data
  ;(params as { protocolVersion: number }).protocolVersion =
    ACP_PROTOCOL_VERSION
  return JSON.stringify(frame)
}

function frameSize(raw: string | Uint8Array) {
  return typeof raw === "string"
    ? Buffer.byteLength(raw, "utf8")
    : raw.byteLength
}

/**
 * One serialized frame as `shown` makes it public, each reply settling the
 * request `named` held for it. The SDK writes no batch, but its v2
 * entrypoints are experimental, so an array is made public entry by entry
 * rather than passed on as it is.
 */
function publicFrame(
  raw: string,
  shown: PublicErrors,
  named: Map<string | number, string>
) {
  const frame = JSON.parse(raw) as unknown
  if (Array.isArray(frame))
    return JSON.stringify(
      frame.map((message) => publicMessage(message, shown, named))
    )
  const message = publicMessage(frame, shown, named)
  return message === frame ? raw : JSON.stringify(message)
}

/** The Session the request a reply answers named, which it settles. */
function answeredSession(frame: object, named: Map<string | number, string>) {
  if (!("id" in frame) || !("result" in frame || "error" in frame))
    return undefined
  const { id } = frame
  if (typeof id !== "string" && typeof id !== "number") return undefined
  const sessionId = named.get(id)
  named.delete(id)
  return sessionId
}

/**
 * One message as `shown` makes it public: an error reply rebuilt from its
 * code and the Session its request named, and an error notification from its
 * Session and its code, which is its message too. Any other message is
 * returned as it is.
 */
function publicMessage(
  frame: unknown,
  shown: PublicErrors,
  named: Map<string | number, string>
): unknown {
  if (typeof frame !== "object" || frame === null) return frame
  const sessionId = answeredSession(frame, named)
  if ("error" in frame) {
    const { error } = frame
    return {
      ...frame,
      error: shown.reply(
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined,
        sessionId
      ),
    }
  }
  if ("method" in frame && frame.method === HGW_METHODS.notify.error) {
    const params: Record<string, unknown> =
      "params" in frame &&
      typeof frame.params === "object" &&
      frame.params !== null
        ? { ...frame.params }
        : {}
    const code = shown.notice(params.code)
    return {
      ...frame,
      params: {
        ...(typeof params.sessionId === "string"
          ? { sessionId: params.sessionId }
          : {}),
        code,
        message: code,
      },
    }
  }
  return frame
}

function positiveLimit(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? value
    : fallback
}
