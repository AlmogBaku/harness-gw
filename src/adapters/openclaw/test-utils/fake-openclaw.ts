/**
 * fakeOpenClaw — one in-memory OpenClaw Gateway holding one Agent and its
 * Sessions, for the runtime and wire contracts: the calls a create, a fork, a
 * rewind, a turn and a read reach, the events a run streams, the child
 * Sessions a run spawns with their own events, approvals and transcripts, and
 * the faults the runtime contract drives. Each Session has its own key,
 * transcript and transcript id. It stands in for the official Gateway client
 * under the real `OpenClawClient`, built by `fakeOpenClawClient`, so the
 * client's own link, deadlines and error mapping are what the contracts prove.
 *
 * It copies the OpenClaw v2026.10.2 Gateway protocol
 * (`@openclaw/gateway-protocol` 2026.10.2), for an operator device holding the
 * admin scope, and refuses a call whose params that protocol refuses.
 *
 * Usage:
 *
 *   const openclaw = fakeOpenClaw()
 *   const client = fakeOpenClawClient(openclaw)
 *   composeOpenClawRuntime({ ...client, baseUrl, logger })
 *   await client.start()
 *   openclaw.progress() // stream a reply fragment into the running turn
 *   await openclaw.spawnChild() // the running turn spawns a child Session
 *
 * The official client marks every Gateway answer it builds, so a test over
 * this fake mocks `@openclaw/gateway-client` with `gatewayClientMock`.
 */
import { GatewayClientRequestError } from "@openclaw/gateway-client"
import {
  PROTOCOL_VERSION,
  validateChatHistoryParams,
  validateChatSendParams,
  validateSessionsAbortParams,
  validateSessionsCreateParams,
  validateSessionsListParams,
  validateSessionsMessagesSubscribeParams,
  validateSessionsMessagesUnsubscribeParams,
  validateSessionsRewindParams,
} from "@openclaw/gateway-protocol"
import { vi } from "vitest"

import type {
  SessionHistoryResponse,
  SessionMessage,
} from "../../../../protocol"
import type { TurnEvent } from "../../../core/events"
import type { CallerError } from "../../../core/failures"
import * as ids from "../../../core/ids"
import { READY_LINK, type ServerLink } from "../../../core/link"
import type { ServerTurnEngine, ServerTurnHandle } from "../../../core/runtime"
import {
  OpenClawClient,
  type OpenClawClientOptions,
  type OpenClawGatewayClient,
  type OpenClawGatewayClientOptions,
  type OpenClawRequestOptions,
} from "../client"

const AGENT_ID = "research"

/**
 * An `agents.list` answer holding only the `research` Agent, for a test that
 * stubs the Gateway's answers one method at a time.
 */
export const RESEARCH_AGENTS = {
  defaultId: AGENT_ID,
  mainKey: "main",
  scope: "global",
  agents: [{ id: AGENT_ID, name: "Research", kind: "agent" }],
}

/**
 * An `OpenClawClient` stand-in whose link is up and whose every Gateway call
 * goes to `request`; `overrides` replace any member, the link included.
 */
export function stubOpenClawClient<
  Request extends (method: string, params?: never) => Promise<unknown>,
>(
  request: Request,
  overrides: Partial<OpenClawGatewayClient & { link: ServerLink }> = {}
) {
  return {
    link: READY_LINK,
    start: vi.fn(async () => undefined),
    stopAndWait: vi.fn(async () => undefined),
    request,
    ...overrides,
  } as unknown as OpenClawGatewayClient & {
    request: Request
    link: ServerLink
  }
}

/**
 * The `index`th row of a history page as a stored message; a missing row or a
 * Todos plan row fails the test.
 */
export function storedMessage(
  page: SessionHistoryResponse,
  index: number
): SessionMessage {
  const message = page.messages[index]
  if (!message || message.role === "activity")
    throw new Error(`Expected a stored message at ${index}`)
  return message
}

/** A turn engine whose every started or recovered turn is already idle. */
export function idleTurns(): ServerTurnEngine {
  const idle = (): ServerTurnHandle => ({
    events: (async function* (): AsyncIterable<TurnEvent> {})(),
    settled: Promise.resolve(),
    stop: async () => "idle",
    recoveryPosition: () => "token-1",
  })
  return { start: async () => idle(), recover: async () => idle() }
}
/** The folder `agents.list` names for the Agent, as the release resolves it. */
export const AGENT_WORKSPACE = "/srv/openclaw/research"
const SESSION_KEY = "agent:research:main"
const LOST_CLOSE_CODE = 1006
/** The native tool a run spawns a child Session with. */
const SPAWN_TOOL = "sessions_spawn"

type Fault = "none" | "native" | "refused" | "down"

/** One dialed official client: its options, whether it is up, and what it subscribed. */
type Connection = {
  readonly options: OpenClawGatewayClientOptions
  up: boolean
  stopped: boolean
  /** The Session keys `sessions.messages.subscribe` named. */
  readonly subscribed: Set<string>
  /** Whether `sessions.subscribe` asked for every Session's tool events. */
  sessionEvents: boolean
}

type Row = Record<string, unknown>

/** One Session the Gateway stores, under its key. */
type FakeSession = {
  readonly key: string
  readonly agentId: string
  /** The transcript the Session is on; a rewind moves it to a new one. */
  sessionId: string
  /** The transcript's active path, as `chat.history` reads it back. */
  rows: Row[]
  /** Rows a rewind took off the active path, which OpenClaw keeps. */
  readonly offPath: Row[]
  label?: string
  displayName?: string
  archived?: boolean
  deleted?: boolean
  toolOverrides?: unknown
  /** The lineage a spawn or a fork records on the Session's row. */
  spawnedBy?: string
  spawnDepth?: number
  parentSessionKey?: string
  forkSource?: { sessionKey: string; sessionId: string }
  forkedFromParent?: boolean
  createdVia?: "operator" | "spawn"
  /** The run in progress, and the next agent sequence its events carry. */
  run?: { id: string; seq: number }
}

/** An approval a run blocks on: where it was pushed, who raised it, its wait. */
type OpenApproval = {
  approval: Record<string, unknown>
  /** The Session whose audience the approval is pushed to. */
  sessionKey: string
  /** The Session that raised it: the run's own, or a child's. */
  sourceKey: string
  settle: () => void
}

/** A child Session a run spawned, and what its own run does next. */
export type FakeOpenClawChild = Readonly<{
  /** The child's Session key, which the spawn result names. */
  key: string
  /** The spawning call's id in its parent's run. */
  toolCallId: string
  /** The child's run streams `text`. */
  say(text: string): void
  /** The child's run ends, its last response `text` stored. */
  complete(text: string): void
  /** The child's run asks an approval; settles once it ends. */
  ask(): Promise<void>
}>

function invalidRequest(message: string) {
  return new GatewayClientRequestError({ code: "INVALID_REQUEST", message })
}

function textOf(row: Row) {
  const content = row.content
  if (typeof content === "string") return content
  return Array.isArray(content)
    ? content
        .map((part) =>
          (part as Row)?.type === "text" ? String((part as Row).text) : ""
        )
        .join("")
    : ""
}

/** A row's history id, from the envelope OpenClaw stores it with. */
function entryId(row: Row) {
  return (row.__openclaw as Row | undefined)?.id
}

/**
 * The real client over `openclaw`, as every contract composes it: synthetic
 * device credentials, a client factory, and the start that brings its link up
 * as the gateway's first catalog read does.
 */
export function fakeOpenClawClient(openclaw: FakeOpenClaw) {
  let client: OpenClawClient | undefined
  return {
    credentials: async () => ({
      deviceIdentity: {
        deviceId: "device-test",
        privateKeyPem: "test-private-key",
        publicKeyPem: "test-public-key",
      },
      deviceToken: "test-token",
      signDevicePayload: () => "test-signature",
      publicKeyRawBase64UrlFromPem: () => "test-public-key-raw",
    }),
    clientFactory: (options: OpenClawClientOptions) =>
      (client = new OpenClawClient({
        ...options,
        createGatewayClient: openclaw.createGatewayClient,
      })),
    start: () => client!.start(),
  }
}

export type FakeOpenClaw = ReturnType<typeof fakeOpenClaw>

export function fakeOpenClaw() {
  let connection: Connection | undefined
  let fault: Fault = "none"
  let failure: Error | undefined
  let calls = 0
  /** Every method the runtime called, in order, refused calls included. */
  const methods: string[] = []
  let seq = 0
  let nextRow = 1
  let nextSession = 1
  let nextTranscript = 1
  let nextChild = 1
  let nextApproval = 1
  /** Every Session the Gateway stores, oldest first. */
  const sessions = new Map<string, FakeSession>()
  /** What each `sessions.create` idempotency key answered. */
  const creates = new Map<string, unknown>()
  /** The Session whose turn the harness plays: the last one sent to. */
  let current = SESSION_KEY
  /** Approvals runs block on, by id. */
  const open = new Map<string, OpenApproval>()
  let interrupted: (() => void) | undefined
  /** Each wait for the connection to subscribe a key. */
  const waiters = new Set<{
    key: string
    tools: boolean
    resolve: () => void
  }>()

  function addSession(
    session: Omit<FakeSession, "sessionId" | "offPath" | "rows"> &
      Partial<Pick<FakeSession, "rows">>
  ) {
    const added: FakeSession = {
      sessionId: `transcript-${nextTranscript++}`,
      rows: [],
      offPath: [],
      ...session,
    }
    sessions.set(added.key, added)
    return added
  }

  // The Agent's own Session, the one the runtime contract plays on.
  addSession({
    key: SESSION_KEY,
    agentId: AGENT_ID,
    toolOverrides: { mcpServers: { "aos-ui": true } },
  }).sessionId = "transcript-a"

  function session(key: unknown) {
    const found = typeof key === "string" ? sessions.get(key) : undefined
    if (!found) throw invalidRequest(`unknown session ${String(key)}`)
    return found
  }

  function hello(dialed: Connection) {
    if (dialed.stopped || dialed.up || connection !== dialed) return
    if (fault === "down") return
    if (fault === "refused") {
      dialed.options.onConnectError?.(
        new GatewayClientRequestError({
          details: { code: "AUTH_UNAUTHORIZED" },
        })
      )
      return
    }
    dialed.up = true
    // The connection policy every hello carries; this Gateway takes no
    // chat attachments.
    dialed.options.onHelloOk?.({
      protocol: PROTOCOL_VERSION,
      policy: {
        maxPayload: 26_214_400,
        maxBufferedBytes: 52_428_800,
        tickIntervalMs: 30_000,
      },
    } as never)
  }

  /** Ends the live connection the way a dropped socket does. */
  function drop() {
    const dropped = connection
    if (!dropped?.up) return
    dropped.up = false
    dropped.options.onClose?.(LOST_CLOSE_CODE, "lost", {
      phase: "post-hello",
    } as never)
  }

  /**
   * Whether the connection hears `target`'s events. A top-level Session's
   * audience includes every operator; a spawned Session's events reach only a
   * connection that subscribed its key, and its tool events only one that
   * also subscribed to every Session's events.
   */
  function hears(target: FakeSession, tool: boolean) {
    const dialed = connection
    if (!dialed?.up) return false
    if (target.spawnedBy === undefined) return true
    return dialed.subscribed.has(target.key) && (!tool || dialed.sessionEvents)
  }

  function push(
    target: FakeSession,
    event: string,
    payload: Record<string, unknown>,
    tool = false
  ) {
    if (!hears(target, tool)) return
    seq += 1
    connection!.options.onEvent?.({
      type: "event",
      event,
      seq,
      payload: { sessionKey: target.key, ...payload },
    })
  }

  /** One event of `target`'s running run. */
  function emit(
    target: FakeSession,
    event: string,
    payload: Record<string, unknown>
  ) {
    if (!target.run) return
    push(
      target,
      event,
      { runId: target.run.id, agentId: target.agentId, ...payload },
      event === "agent" && payload.stream === "tool"
    )
  }

  function agentEvent(
    target: FakeSession,
    stream: string,
    data: Record<string, unknown>
  ) {
    const run = target.run
    if (!run) return
    emit(target, "agent", { seq: run.seq++, stream, ts: 1_000 + seq, data })
  }

  /** Stores `row` on `target`'s transcript under the next history id. */
  function store(target: FakeSession, row: Row, envelope: Row = {}) {
    const id = `msg-${nextRow++}`
    const stored = {
      timestamp: Date.now(),
      ...row,
      __openclaw: { id, seq: target.rows.length + 1, ...envelope },
    }
    target.rows.push(stored)
    return stored
  }

  /**
   * A `session.approval` transition, as the release pushes it to a Session's
   * audience: its payload names the Session and the approval, no run.
   */
  function emitApproval(
    phase: "pending" | "terminal",
    { approval, sessionKey, sourceKey }: Omit<OpenApproval, "settle">
  ) {
    const audience = sessions.get(sessionKey)
    if (!audience) return
    push(audience, "session.approval", {
      ...(phase === "pending" ? { sourceSessionKey: sourceKey } : {}),
      updatedAtMs: Date.now(),
      phase,
      approval,
    })
  }

  /** The approval `id` ends as `terminal` records it; its run goes on. */
  function endApproval(id: string, terminal: Record<string, unknown>) {
    const waiting = open.get(id)
    if (!waiting) return undefined
    open.delete(id)
    // A terminal snapshot drops the pending projection's `sourceSessionKey`.
    const common: Record<string, unknown> = { ...waiting.approval }
    delete common.sourceSessionKey
    delete common.status
    const source = sessions.get(waiting.sourceKey)
    const ended = {
      ...common,
      resolvedAtMs: Date.now(),
      source: {
        agentId: source?.agentId ?? AGENT_ID,
        sessionKey: waiting.sourceKey,
      },
      ...terminal,
    }
    emitApproval("terminal", { ...waiting, approval: ended })
    waiting.settle()
    return ended
  }

  /** The newest approval still open, which the wire contract's turn ends. */
  function newestApproval() {
    return [...open.keys()].at(-1)
  }

  /**
   * `source`'s run asks a plugin approval, pushed to `audience`'s Session:
   * its own for a top-level run, its parent's for a spawned one.
   */
  function ask(source: FakeSession, audience: string) {
    return new Promise<void>((settle) => {
      const now = Date.now()
      const id = `approval-${nextApproval++}`
      const approval = {
        id,
        urlPath: `/approvals/${id}`,
        createdAtMs: now,
        expiresAtMs: now + 600_000,
        presentation: {
          kind: "plugin",
          title: "Proceed?",
          description: "Proceed? yes / no",
          severity: "info",
          agentId: source.agentId,
          allowedDecisions: ["allow-once", "deny"],
        },
        status: "pending",
        sourceSessionKey: source.key,
      }
      const waiting = {
        approval,
        sessionKey: audience,
        sourceKey: source.key,
        settle,
      }
      open.set(id, waiting)
      emitApproval("pending", waiting)
    })
  }

  /** `target`'s run ends; its last model response is stored as a transcript row. */
  function complete(target: FakeSession, text: string) {
    agentEvent(target, "lifecycle", { phase: "end" })
    emit(target, "chat", { seq: 0, state: "final" })
    // The reply's row names the run that wrote it.
    store(
      target,
      { role: "assistant", content: [{ type: "text", text }] },
      target.run ? { runId: target.run.id } : {}
    )
    target.run = undefined
  }

  /** `target`'s run is aborted: its loop stops and it ends aborted. */
  function abortRun(target: FakeSession) {
    const run = target.run
    if (!run) return undefined
    for (const [id, waiting] of open)
      if (waiting.sourceKey === target.key)
        endApproval(id, { status: "cancelled", reason: "run-aborted" })
    emit(target, "chat", { seq: 0, state: "aborted" })
    target.run = undefined
    return run.id
  }

  /** Whether the connection subscribed `key` and, for `tools`, every Session's events. */
  function heard(key: string, tools: boolean) {
    const dialed = connection
    return !!dialed?.subscribed.has(key) && (!tools || dialed.sessionEvents)
  }

  /** Settles once the connection subscribed `key` and, for `tools`, every Session's events. */
  function subscribed(key: string, tools = false) {
    if (heard(key, tools)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      waiters.add({ key, tools, resolve })
    })
  }

  function wakeSubscribers() {
    for (const waiter of waiters)
      if (heard(waiter.key, waiter.tools)) {
        waiters.delete(waiter)
        waiter.resolve()
      }
  }

  /** A `sessions.list` row, as `SessionRowSchema` carries it. */
  function listRow(listed: FakeSession) {
    return {
      key: listed.key,
      kind: "direct",
      agentId: listed.agentId,
      sessionId: listed.sessionId,
      // `SessionRowSchema` carries the usage the gateway recorded.
      totalTokens: 1_200,
      contextTokens: 200_000,
      estimatedCostUsd: 0.42,
      ...(listed.label === undefined ? {} : { label: listed.label }),
      ...(listed.displayName === undefined
        ? {}
        : { displayName: listed.displayName }),
      ...(listed.archived === undefined ? {} : { archived: listed.archived }),
      ...(listed.toolOverrides === undefined
        ? {}
        : { toolOverrides: structuredClone(listed.toolOverrides) }),
      ...(listed.run
        ? { hasActiveRun: true, activeRunIds: [listed.run.id] }
        : {}),
      ...(listed.spawnedBy === undefined
        ? {}
        : { spawnedBy: listed.spawnedBy }),
      ...(listed.spawnDepth === undefined
        ? {}
        : { spawnDepth: listed.spawnDepth }),
      ...(listed.parentSessionKey === undefined
        ? {}
        : { parentSessionKey: listed.parentSessionKey }),
      ...(listed.forkSource === undefined
        ? {}
        : { forkSource: { ...listed.forkSource } }),
      ...(listed.forkedFromParent === undefined
        ? {}
        : { forkedFromParent: listed.forkedFromParent }),
      ...(listed.createdVia === undefined
        ? {}
        : { createdVia: listed.createdVia }),
    }
  }

  /** A new Session's key, as the release mints one for its Agent. */
  function newKey(agentId: string) {
    return `agent:${agentId}:session-${nextSession++}`
  }

  /**
   * `sessions.create`: a new empty Session, or with `fork` a copy of the
   * parent's active path. A running parent forks only through its last
   * completed response; the fork inherits no title, and its tool overrides
   * replace the parent's whenever the call names any.
   */
  function create(params: Record<string, unknown>) {
    if (!validateSessionsCreateParams(params))
      throw invalidRequest("invalid sessions.create params")
    const idempotency =
      typeof params.idempotencyKey === "string"
        ? params.idempotencyKey
        : undefined
    if (idempotency && creates.has(idempotency)) return creates.get(idempotency)
    const titled = {
      ...(typeof params.label === "string" ? { label: params.label } : {}),
      ...(typeof params.displayName === "string"
        ? { displayName: params.displayName }
        : {}),
    }
    let created: FakeSession
    if (params.fork === true) {
      const parent = session(params.parentSessionKey)
      if (parent.run && params.forkFrom !== "last-completed")
        throw invalidRequest("fork a running session from last-completed")
      const through =
        params.forkFrom === "last-completed"
          ? parent.rows.findLastIndex((row) => row.role === "assistant") + 1
          : parent.rows.length
      created = addSession({
        key: newKey(parent.agentId),
        agentId: parent.agentId,
        rows: structuredClone(parent.rows.slice(0, through)),
        ...titled,
        toolOverrides: structuredClone(
          params.toolOverrides ?? parent.toolOverrides
        ),
        parentSessionKey: parent.key,
        forkSource: { sessionKey: parent.key, sessionId: parent.sessionId },
        forkedFromParent: true,
        createdVia: "operator",
      })
    } else {
      const agentId =
        typeof params.agentId === "string" ? params.agentId : AGENT_ID
      created = addSession({
        key: newKey(agentId),
        agentId,
        ...titled,
        ...(params.toolOverrides === undefined
          ? {}
          : { toolOverrides: structuredClone(params.toolOverrides) }),
        createdVia: "operator",
      })
    }
    const answered = {
      ok: true,
      key: created.key,
      sessionId: created.sessionId,
    }
    if (idempotency) creates.set(idempotency, answered)
    return answered
  }

  /**
   * `sessions.rewind`: the Session's active path ends before the user entry
   * `entryId`, on a new transcript, and the entry's text comes back for the
   * composer. A working or archived Session is refused.
   */
  function rewind(params: Record<string, unknown>) {
    if (!validateSessionsRewindParams(params))
      throw invalidRequest("invalid sessions.rewind params")
    const target = session(params.sessionKey)
    if (target.run)
      throw invalidRequest("Rewind is unavailable while the agent is working")
    if (target.archived)
      throw invalidRequest("Rewind is unavailable for an archived session")
    const index = target.rows.findIndex(
      (row) => row.role === "user" && entryId(row) === params.entryId
    )
    if (index < 0) throw invalidRequest("unknown entry")
    const editorText = textOf(target.rows[index]!)
    target.offPath.push(...target.rows.splice(index))
    target.sessionId = `transcript-${nextTranscript++}`
    return { editorText }
  }

  /** `chat.history`: the newest `limit` rows of the active path from `offset`. */
  function history(params: Record<string, unknown>) {
    if (!validateChatHistoryParams(params))
      throw invalidRequest("invalid chat.history params")
    const target = session(params.sessionKey)
    const limit = typeof params.limit === "number" ? params.limit : 200
    const offset = typeof params.offset === "number" ? params.offset : 0
    const end = Math.max(0, target.rows.length - offset)
    return {
      sessionKey: target.key,
      sessionId: target.sessionId,
      messages: target.rows.slice(Math.max(0, end - limit), end),
      sessionInfo: {
        hasActiveRun: target.run !== undefined,
        activeRunIds: target.run ? [target.run.id] : [],
      },
    }
  }

  /**
   * `parent`'s run calls `sessions_spawn`: the Gateway creates the child,
   * starts its run, and answers the call `accepted`, naming both.
   */
  function spawn(parent: FakeSession): FakeOpenClawChild {
    const n = nextChild++
    const toolCallId = `call-spawn-${n}`
    const args = { task: "Count the names in the file.", label: `Counter ${n}` }
    agentEvent(parent, "tool", {
      toolCallId,
      name: SPAWN_TOOL,
      phase: "start",
      args,
    })
    const child = addSession({
      key: `agent:${parent.agentId}:subagent:child-${n}`,
      agentId: parent.agentId,
      spawnedBy: parent.key,
      spawnDepth: (parent.spawnDepth ?? 0) + 1,
      parentSessionKey: parent.key,
      createdVia: "spawn",
    })
    store(child, { role: "user", content: [{ type: "text", text: args.task }] })
    const runId = `child-run-${n}`
    child.run = { id: runId, seq: 0 }
    const details = { status: "accepted", childSessionKey: child.key, runId }
    const content = [{ type: "text", text: JSON.stringify(details) }]
    store(parent, {
      role: "assistant",
      content: [
        { type: "toolCall", id: toolCallId, name: SPAWN_TOOL, arguments: args },
      ],
    })
    store(parent, {
      role: "toolResult",
      toolCallId,
      toolName: SPAWN_TOOL,
      content,
      details,
      isError: false,
    })
    agentEvent(parent, "tool", {
      toolCallId,
      name: SPAWN_TOOL,
      phase: "result",
      result: { content, details },
      isError: false,
    })
    return {
      key: child.key,
      toolCallId,
      say: (text) => agentEvent(child, "assistant", { delta: text }),
      complete: (text) => complete(child, text),
      ask: () => ask(child, parent.key),
    }
  }

  function answer(
    dialed: Connection,
    method: string,
    params: Record<string, unknown>,
    options: OpenClawRequestOptions | undefined
  ): unknown {
    switch (method) {
      case "agents.list":
        return {
          defaultId: AGENT_ID,
          mainKey: "main",
          scope: "global",
          agents: [
            {
              id: AGENT_ID,
              name: "Research",
              kind: "agent",
              workspace: AGENT_WORKSPACE,
            },
          ],
        }
      case "sessions.list": {
        if (!validateSessionsListParams(params))
          throw invalidRequest("invalid sessions.list params")
        // The newest first, as `sortBy: updatedAt` reads them.
        const rows = [...sessions.values()]
          .reverse()
          .filter(
            (listed) =>
              !listed.deleted &&
              (params.agentId === undefined ||
                listed.agentId === params.agentId) &&
              (params.search === undefined ||
                listed.key.includes(String(params.search))) &&
              (params.spawnedBy === undefined ||
                listed.spawnedBy === params.spawnedBy)
          )
        const offset = typeof params.offset === "number" ? params.offset : 0
        const limit = typeof params.limit === "number" ? params.limit : 100
        return {
          sessions: rows.slice(offset, offset + limit).map(listRow),
        }
      }
      case "sessions.create":
        return create(params)
      case "sessions.rewind":
        return rewind(params)
      case "sessions.messages.subscribe":
        if (!validateSessionsMessagesSubscribeParams(params))
          throw invalidRequest("invalid sessions.messages.subscribe params")
        dialed.subscribed.add(String(params.key))
        queueMicrotask(wakeSubscribers)
        return { key: params.key }
      case "sessions.messages.unsubscribe":
        if (!validateSessionsMessagesUnsubscribeParams(params))
          throw invalidRequest("invalid sessions.messages.unsubscribe params")
        dialed.subscribed.delete(String(params.key))
        return {}
      case "sessions.subscribe":
        dialed.sessionEvents = true
        queueMicrotask(wakeSubscribers)
        return { subscribed: true }
      case "tools.effective":
        return { agentId: AGENT_ID, profile: "default", groups: [] }
      case "chat.history":
        return history(params)
      case "chat.send": {
        if (!validateChatSendParams(params))
          throw invalidRequest("invalid chat.send params")
        // The release answers a send once, as it starts the run, and pushes
        // the prompt's row once it stored it.
        const target = session(params.sessionKey)
        const id = String(params.idempotencyKey)
        options?.onSent?.()
        current = target.key
        target.run = { id, seq: 0 }
        const row = store(
          target,
          {
            role: "user",
            content: [{ type: "text", text: String(params.message) }],
          },
          { idempotencyKey: id }
        )
        queueMicrotask(() =>
          emit(target, "session.message", {
            message: row,
            messageId: row.__openclaw.id,
            messageSeq: row.__openclaw.seq,
          })
        )
        return { runId: id, status: "started" }
      }
      case "approval.get": {
        const waiting = open.get(String(params.id))
        if (!waiting)
          throw new GatewayClientRequestError({
            code: "INVALID_REQUEST",
            message: "unknown approval",
          })
        return { approval: waiting.approval }
      }
      case "approval.resolve": {
        // A deny ends the approval denied, the only terminal carrying it.
        const approval = endApproval(String(params.id), {
          status: params.decision === "deny" ? "denied" : "allowed",
          decision: params.decision,
          reason: "user",
        })
        if (!approval)
          throw new GatewayClientRequestError({
            code: "INVALID_REQUEST",
            message: "unknown approval",
          })
        return { applied: true, approval }
      }
      case "sessions.abort": {
        if (!validateSessionsAbortParams(params))
          throw invalidRequest("invalid sessions.abort params")
        const target = session(params.key)
        // A spawned Session's run stops at once; the abort cascades from a
        // parent to every child it spawned.
        if (target.spawnedBy !== undefined) {
          const aborted = abortRun(target)
          return aborted
            ? { ok: true, status: "aborted", abortedRunId: aborted }
            : { ok: true, status: "no-active-run", abortedRunId: null }
        }
        for (const child of sessions.values())
          if (child.spawnedBy === target.key) abortRun(child)
        // An abort cancels the run's open approval at once; the run ends
        // aborted only once its loop stops.
        const aborted = target.run?.id
        for (const [id, waiting] of open)
          if (waiting.sourceKey === target.key)
            endApproval(id, { status: "cancelled", reason: "run-aborted" })
        interrupted?.()
        return aborted
          ? { ok: true, status: "aborted", abortedRunId: aborted }
          : { ok: true, status: "no-active-run", abortedRunId: null }
      }
      default:
        throw new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: `unknown method ${method}`,
        })
    }
  }

  /** The Session whose turn the harness plays. */
  const playing = () => sessions.get(current)!

  /**
   * The played turn spawns one child Session, which says "Child at work."
   * once the runtime subscribed it, and ends, all stored.
   */
  async function spawnChild() {
    const child = spawn(playing())
    await subscribed(child.key)
    child.say("Child at work.")
    child.complete("Child at work.")
    return child.key
  }

  return {
    scope: {
      agentId: AGENT_ID,
      providerSessionId: ids.providerSessionId(SESSION_KEY),
      // OpenClaw names a Session publicly by its key, as the adapter resolves it.
      sessionId: ids.sessionId(SESSION_KEY),
    },

    createGatewayClient(
      options: OpenClawGatewayClientOptions
    ): OpenClawGatewayClient {
      const dialed: Connection = {
        options,
        up: false,
        stopped: false,
        subscribed: new Set(),
        sessionEvents: false,
      }
      connection = dialed
      return {
        start() {
          calls += 1
          queueMicrotask(() => hello(dialed))
        },
        async stopAndWait() {
          dialed.stopped = true
          dialed.up = false
        },
        async request<T>(
          method: string,
          params?: unknown,
          options?: OpenClawRequestOptions
        ) {
          calls += 1
          methods.push(method)
          if (!dialed.up) throw new Error("gateway not connected")
          if (fault === "native") throw failure
          return (await answer(
            dialed,
            method,
            (params ?? {}) as Record<string, unknown>,
            options
          )) as T
        },
      }
    },

    async progress() {
      agentEvent(playing(), "assistant", { delta: "Contract reply" })
    },

    async finish() {
      const target = playing()
      agentEvent(target, "lifecycle", { phase: "end" })
      emit(target, "chat", {
        seq: 0,
        state: "final",
        message: { content: [{ type: "text", text: "Contract reply" }] },
      })
      target.run = undefined
    },

    /**
     * The running turn spawns one child Session, which says "Child at work."
     * once the runtime subscribed it, and ends, all stored; resolves with its
     * key.
     */
    spawnChild,

    /**
     * `parentKey`'s running run, the played turn's by default, spawns one
     * child Session and leaves its run running; a spawned parent's own tool
     * events reach the runtime only once it subscribed them.
     */
    async spawn(parentKey = current) {
      const parent = session(parentKey)
      if (parent.spawnedBy !== undefined) await subscribed(parent.key, true)
      return spawn(parent)
    },

    /** Settles once the runtime subscribed `key`, and for `tools` its tool events. */
    subscribed,

    /** The Session `key` as the Gateway stores it, for a test to read back. */
    stored(key: string) {
      return structuredClone(session(key))
    },

    /** The wire contract's turn, as a run of the release streams it. */
    turn: {
      async firstResponse() {
        const target = playing()
        const call = { toolCallId: "call-read", name: "read_file" }
        agentEvent(target, "thinking", { delta: "I should read the file." })
        agentEvent(target, "assistant", { delta: "Reading the file." })
        agentEvent(target, "tool", {
          ...call,
          phase: "start",
          args: { path: "/tmp/demo.txt" },
        })
        agentEvent(target, "tool", {
          ...call,
          phase: "result",
          result: "alpha\nbeta\ngamma",
          isError: false,
        })
      },
      async secondResponse(text = "The file lists three names.") {
        const target = playing()
        agentEvent(target, "assistant", { delta: text })
        complete(target, text)
      },
      spawnChild,
      /**
       * The release has no Session-scoped push for a question (no
       * `question.*` event reaches `sessions.messages.subscribe`), so the
       * run's in-turn prompt is a plugin approval.
       */
      questions: {
        ask: () => ask(playing(), current),
        /** The approval timed out: it failed closed and the run goes on. */
        async withdraw() {
          const id = newestApproval()
          if (id) endApproval(id, { status: "expired", reason: "timeout" })
        },
        interrupted: () =>
          new Promise<void>((resolve) => {
            interrupted = () => {
              interrupted = undefined
              resolve()
            }
          }),
        /** The aborted run's loop stops: it ends aborted. */
        async confirmInterrupt() {
          const target = playing()
          emit(target, "chat", { seq: 0, state: "aborted" })
          target.run = undefined
        },
        held: {},
        lose: () =>
          Promise.reject(new Error("OpenClaw replays every pending approval")),
      },
    },

    deleteSession() {
      session(SESSION_KEY).deleted = true
    },

    failNative() {
      fault = "native"
      const native = new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "contract native failure",
      })
      failure = native
      return (error: unknown) => error === native
    },

    refuseAsCaller(kind: CallerError) {
      if (kind !== "runtime_authentication_required")
        throw new Error("OpenClaw refuses a read only for its device")
      fault = "refused"
      drop()
    },

    nativeCalls: () => calls,

    /** How many times the runtime called `method`, as a refused write's test asks. */
    requested: (method: string) =>
      methods.filter((called) => called === method).length,

    async dropLink() {
      fault = "down"
      drop()
    },

    /** The Gateway is back: a dial still waiting on its hello gets one. */
    async restoreLink() {
      fault = "none"
      if (connection) hello(connection)
    },
  }
}
