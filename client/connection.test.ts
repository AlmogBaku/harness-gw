import {
  agent,
  methods,
  RequestError,
  type AgentContext,
  type SessionConfigOption,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import {
  HGW_AUTH_METHOD_INVITE,
  HGW_EXTENSION_VERSION,
  HGW_JSONRPC_ERRORS,
  HGW_METHODS,
  HGW_META_KEY,
  HGW_REPLAY_BEFORE,
  HGW_REPLAY_POSITION,
  HgwReplayBeforeSchema,
  type HgwHistoryCursor,
} from "../protocol/acp"

import { AcpConnectionClosedError, AgentUpdateError } from "./workspace"

import { useFakeClock } from "../test/support/fake-clock"
import { captureLogs } from "../test/support/log-capture"

import { createAcpConnection } from "./connection"
import { PART_GRACE_MS, REQUEST_DEADLINE_MS } from "./limits"
import { pipedSockets } from "./test-socket"
import type { AcpPendingRequest } from "./types"

const SESSION_ID = "session-1"
/** The Session a fork of `SESSION_ID` makes. */
const FORKED_ID = "session-forked"
/** A child Session a turn of `SESSION_ID` spawned. */
const CHILD_ID = "child-1"
const AGENT_ID = "agent-1"
const UPDATED_AT = "2026-09-19T10:00:00.000Z"
const CLIENT_INFO = { name: "aos-ui", version: "1.2.3" }

function sessionInfoMeta() {
  return { agentId: AGENT_ID, status: "idle", archived: false, unread: true }
}

function modelOption(currentValue: string): SessionConfigOption {
  return {
    configId: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [
      { value: "sonnet", name: "Sonnet" },
      { value: "opus", name: "Opus" },
    ],
  }
}

/** The Agent's folder, the `cwd` the gateway lists its Sessions in. */
const FOLDER = "/srv/research"

function catalogEntry() {
  return {
    summary: { kind: "ready", id: AGENT_ID, name: "Research" },
    visibility: "visible",
    selectable: true,
    editable: true,
    avatarEditable: true,
    muteEditable: true,
    revision: "revision-1",
  }
}

type AgentCall = { method: string; params: unknown }

/** Recorded once the fake has answered a plain resume, for ordering checks. */
const RESUME_REPLIED = "session/resume:replied"

/** An in-process gateway: the AOS agent side of the connection under test. */
function createGatewayAgent(
  options: {
    refuseLoginAfter?: number
    /** `_meta.hgw.history` on every resume that replays from the start. */
    history?: HgwHistoryCursor
    /** What a `_hgw/before` page read streams, and the cursor it replies with. */
    page?: {
      /** Each update, and the Session it names when not the one read. */
      updates: readonly (
        | readonly [SessionUpdate, Record<string, unknown>]
        | readonly [SessionUpdate, Record<string, unknown>, string]
      )[]
      history?: HgwHistoryCursor
    }
    /**
     * Holds each resume open briefly, a page read's reply after its updates,
     * as a real rejoin or page read takes time.
     */
    slowResume?: boolean
    /** The JSON-RPC code an Agent update is refused with. */
    refuseAgentUpdate?: number
    /** The hgw extension version `initialize` announces. */
    version?: number
    /** Never answers `_hgw/session/focus`, as a reply held behind a replay. */
    holdFocus?: boolean
    /** The entries `_hgw/agents/list` answers with. */
    agents?: readonly unknown[]
    /** The results `_hgw/sessions/search` answers with. */
    searchResults?: readonly unknown[]
    /** Advertises `session/fork`, which answers `FORKED_ID`. */
    forks?: boolean
  } = {}
) {
  const calls: AgentCall[] = []
  let peer: AgentContext | undefined
  let logins = 0
  const record = (method: string, params: unknown) => {
    calls.push({ method, params })
  }
  const app = agent({ name: "fake-harness-gw" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      record("initialize", params)
      return {
        protocolVersion: 2,
        info: { name: "harness-gw", version: "9.9.9" },
        capabilities: {
          session: { delete: {}, ...(options.forks ? { fork: {} } : {}) },
        },
        _meta: {
          [HGW_META_KEY]: {
            version: options.version ?? HGW_EXTENSION_VERSION,
            role: "operator",
            extensions: {
              steer: true,
              rewind: true,
              composerPrefill: true,
              agents: true,
              invalidation: true,
              activity: true,
              readState: true,
              focus: true,
              guestProjection: false,
            },
          },
        },
      }
    })
    .onRequest(methods.agent.auth.login, ({ params }) => {
      record(methods.agent.auth.login, params)
      logins += 1
      if (
        options.refuseLoginAfter !== undefined &&
        logins > options.refuseLoginAfter
      )
        throw RequestError.authRequired()
      return {}
    })
    .onRequest(methods.agent.session.new, ({ params }) => {
      record(methods.agent.session.new, params)
      return { sessionId: SESSION_ID }
    })
    .onRequest(methods.agent.session.list, ({ params }) => {
      record(methods.agent.session.list, params)
      return {
        sessions: [
          {
            sessionId: SESSION_ID,
            cwd: FOLDER,
            updatedAt: UPDATED_AT,
            _meta: { [HGW_META_KEY]: sessionInfoMeta() },
          },
        ],
        nextCursor: "cursor-2",
      }
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      record(methods.agent.session.resume, params)
      const replayFrom = params.replayFrom
      if (replayFrom?.type === HGW_REPLAY_BEFORE) {
        const { cursor } = HgwReplayBeforeSchema.parse(replayFrom)
        for (const [update, meta, sessionId] of options.page?.updates ?? [])
          await peer?.notify(methods.client.session.update, {
            sessionId: sessionId ?? params.sessionId,
            update: {
              ...update,
              _meta: {
                [HGW_META_KEY]: { ...meta, historyPage: { cursor } },
              },
            },
          })
        const history = options.page?.history
        if (options.slowResume)
          await new Promise((resolve) => setTimeout(resolve, 20))
        return {
          _meta: { [HGW_META_KEY]: history === undefined ? {} : { history } },
        }
      }
      if (options.slowResume)
        await new Promise((resolve) => setTimeout(resolve, 20))
      record(RESUME_REPLIED, params)
      const replayed = replayFrom?.type === "start"
      return {
        _meta: {
          [HGW_META_KEY]: {
            ...(replayed && options.history
              ? { history: options.history }
              : {}),
          },
        },
      }
    })
    .onRequest(methods.agent.session.prompt, ({ params }) => {
      record(methods.agent.session.prompt, params)
      return { messageId: "message-7" }
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      record(methods.agent.session.setConfigOption, params)
      return { configOptions: [modelOption("opus")] }
    })
    .onRequest(methods.agent.session.close, ({ params }) => {
      record(methods.agent.session.close, params)
      return {}
    })
    .onRequest(methods.agent.session.delete, ({ params }) => {
      record(methods.agent.session.delete, params)
      return {}
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      record(methods.agent.session.cancel, params)
    })
    .onRequest(HGW_METHODS.sessions.search, z.unknown(), ({ params }) => {
      record(HGW_METHODS.sessions.search, params)
      return {
        sessions: options.searchResults ?? [
          {
            sessionId: SESSION_ID,
            cwd: FOLDER,
            title: "Weekly report",
            _meta: { [HGW_META_KEY]: sessionInfoMeta() },
          },
        ],
      }
    })
    .onRequest(HGW_METHODS.session.update, z.unknown(), ({ params }) => {
      record(HGW_METHODS.session.update, params)
      return {}
    })
    .onRequest(HGW_METHODS.session.steer, z.unknown(), ({ params }) => {
      record(HGW_METHODS.session.steer, params)
      return { status: "queued" }
    })
    .onRequest(
      HGW_METHODS.agents.list,
      z.unknown().optional(),
      ({ params }) => {
        record(HGW_METHODS.agents.list, params)
        return {
          revision: "revision-1",
          agents: options.agents ?? [catalogEntry()],
        }
      }
    )
    .onRequest(HGW_METHODS.agents.update, z.unknown(), ({ params }) => {
      record(HGW_METHODS.agents.update, params)
      if (options.refuseAgentUpdate !== undefined)
        throw new RequestError(options.refuseAgentUpdate, "refused")
      return { revision: "revision-2", agent: catalogEntry() }
    })
    .onRequest(methods.agent.session.fork, ({ params }) => {
      record(methods.agent.session.fork, params)
      return { sessionId: FORKED_ID }
    })
    .onRequest(HGW_METHODS.session.focus, z.unknown(), ({ params }) => {
      record(HGW_METHODS.session.focus, params)
      return options.holdFocus ? new Promise<never>(() => {}) : {}
    })
    .onConnect((connection) => {
      peer = connection.client
    })

  return {
    app,
    calls,
    callsOf: (method: string) =>
      calls.flatMap((call) => (call.method === method ? [call.params] : [])),
    paramsOf: (method: string) =>
      calls.find((call) => call.method === method)?.params,
    pushUpdate(
      update: SessionUpdate,
      meta?: Record<string, unknown>,
      sessionId = SESSION_ID
    ) {
      return peer?.notify(methods.client.session.update, {
        sessionId,
        update: {
          ...update,
          ...(meta ? { _meta: { [HGW_META_KEY]: meta } } : {}),
        },
      })
    },
    notify(method: string, params: unknown) {
      return peer?.notify(method, params)
    },
    /** Aborting `withdrawal` withdraws the request with `$/cancel_request`. */
    askPermission(withdrawal?: AbortSignal, sessionId = SESSION_ID) {
      return peer?.request(
        methods.client.session.requestPermission,
        {
          sessionId,
          title: "Run the tool?",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          _meta: {
            [HGW_META_KEY]: { requestId: "interrupt-1", message: "read file" },
          },
        },
        withdrawal ? { cancellationSignal: withdrawal } : undefined
      )
    },
    /** Aborting `withdrawal` withdraws the question with `$/cancel_request`. */
    askQuestion(withdrawal?: AbortSignal) {
      return peer?.request(
        methods.client.elicitation.create,
        {
          sessionId: SESSION_ID,
          mode: "form",
          message: "Which one?",
          requestedSchema: { type: "object", properties: {} },
          _meta: { [HGW_META_KEY]: { requestId: "interrupt-2" } },
        },
        withdrawal ? { cancellationSignal: withdrawal } : undefined
      )
    },
  }
}

function connectInProcess(gateway: ReturnType<typeof createGatewayAgent>) {
  const connection = createAcpConnection({
    clientInfo: CLIENT_INFO,
    connectAgent: gateway.app,
  })
  connection.start()
  return connection
}

/** A connection to `gateway` over piped sockets, started; `pipe` faults them. */
function connectOverSockets(gateway: ReturnType<typeof createGatewayAgent>) {
  const pipe = pipedSockets(() => gateway.app)
  const connection = createAcpConnection({
    clientInfo: CLIENT_INFO,
    url: "ws://gateway.test/api/v1/acp",
    socketConstructor: pipe.WebSocket,
  })
  connection.start()
  return { pipe, connection }
}

describe("ACP connection", () => {
  it("constructs no transport until it is started, and only one", async () => {
    const gateway = createGatewayAgent()
    const pipe = pipedSockets(() => gateway.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://gateway.test/api/v1/acp",
      socketConstructor: pipe.WebSocket,
    })

    expect(pipe.sockets).toHaveLength(0)

    connection.start()
    connection.start()
    await connection.initialized

    expect(pipe.sockets).toHaveLength(1)
    connection.close()
    connection.close()
    expect(connection.status).toBe("closed")
  })

  it("stays closed when a connection is closed before it starts", async () => {
    const gateway = createGatewayAgent()
    const pipe = pipedSockets(() => gateway.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://gateway.test/api/v1/acp",
      socketConstructor: pipe.WebSocket,
    })

    connection.close()
    connection.start()

    expect(pipe.sockets).toHaveLength(0)
    expect(connection.status).toBe("closed")
    await expect(connection.initialized).rejects.toThrow()
  })

  it("holds a first request until the inspector settles, and runs without one that cannot load", async () => {
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      connectAgent: createGatewayAgent().app,
      inspector: () =>
        Promise.reject(new Error("The inspector is unavailable")),
    })
    connection.start()

    await expect(connection.listAgents()).resolves.toBeDefined()
    connection.close()
  })

  it("reads the gateway's ACP capabilities at initialize", async () => {
    const forking = connectInProcess(createGatewayAgent({ forks: true }))
    const plain = connectInProcess(createGatewayAgent())
    await Promise.all([forking.initialized, plain.initialized])

    expect(forking.capabilities?.session).toMatchObject({ fork: {} })
    expect(plain.capabilities?.session).not.toHaveProperty("fork")
    forking.close()
    plain.close()
  })

  it("forks a Session into one the gateway joined it to", async () => {
    const gateway = createGatewayAgent({ forks: true })
    const connection = connectInProcess(gateway)
    await connection.initialized

    await expect(connection.forkSession(SESSION_ID)).resolves.toEqual({
      sessionId: FORKED_ID,
    })
    expect(gateway.paramsOf(methods.agent.session.fork)).toEqual({
      sessionId: SESSION_ID,
      cwd: "",
    })
    // Opened in its grace, as a created Session is.
    expect(connection.sessionState(FORKED_ID)).toBeDefined()
    connection.close()
  })

  // ACP v2 child Sessions arrive on the same connection, under their own id,
  // announced first on the Session that owns them.
  it("gives a child Session's updates to the listeners of the Session that owns it, in its turn's position", async () => {
    const clock = useFakeClock()
    const gateway = createGatewayAgent()
    const pipe = pipedSockets(() => gateway.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://gateway.test/api/v1/acp",
      socketConstructor: pipe.WebSocket,
    })
    connection.start()
    await connection.initialized
    const updated = vi.fn()
    const child = vi.fn()
    connection.subscribe(SESSION_ID, {
      agentId: AGENT_ID,
      update: updated,
      child,
    })
    await connection.joined(SESSION_ID)

    await gateway.pushUpdate(
      {
        sessionUpdate: "subagent_update",
        sessionId: CHILD_ID,
        title: "Review",
      },
      { sequence: 4, turnId: "run-1" }
    )
    await gateway.pushUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "child-message",
        content: { type: "text", text: "Reading" },
      },
      { sequence: 5, turnId: "run-1" },
      CHILD_ID
    )
    await clock.advance(0)

    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({ sessionUpdate: "subagent_update" }),
      expect.anything()
    )
    expect(child).toHaveBeenCalledWith(
      CHILD_ID,
      expect.objectContaining({ sessionUpdate: "agent_message_chunk" }),
      { sequence: 5, turnId: "run-1" }
    )
    // The child's events share its parent turn's sequence.
    pipe.sockets[0]?.drop()
    await clock.advance(250)
    expect(gateway.callsOf(methods.agent.session.resume)[1]).toMatchObject({
      replayFrom: { type: HGW_REPLAY_POSITION, turnId: "run-1", from: 6 },
    })
    connection.close()
  })

  it("names the Session that owns a child Session asking for permission", async () => {
    const gateway = createGatewayAgent()
    const connection = connectInProcess(gateway)
    await connection.initialized
    const pending: AcpPendingRequest[] = []
    connection.subscribePendingRequests((request) => pending.push(request))
    connection.subscribe(SESSION_ID, { agentId: AGENT_ID })
    await connection.joined(SESSION_ID)
    await gateway.pushUpdate(
      { sessionUpdate: "subagent_update", sessionId: CHILD_ID },
      { sequence: 1, turnId: "run-1" }
    )

    const answered = gateway.askPermission(undefined, CHILD_ID)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    const [request] = pending
    expect(request).toMatchObject({
      kind: "permission",
      sessionId: CHILD_ID,
      parentSessionId: SESSION_ID,
    })
    if (request?.kind !== "permission") throw new Error("expected permission")
    request.respond({ outcome: { outcome: "selected", optionId: "allow" } })

    // The answer reaches the gateway as the child's.
    await expect(answered).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "allow" },
    })
    connection.close()
  })

  it("initializes with the negotiated AOS extension metadata", async () => {
    const gateway = createGatewayAgent()
    const connection = connectInProcess(gateway)

    await expect(connection.initialized).resolves.toEqual({
      version: 2,
      role: "operator",
      extensions: expect.objectContaining({ readState: true, focus: true }),
    })
    expect(gateway.paramsOf("initialize")).toMatchObject({
      protocolVersion: 2,
      info: CLIENT_INFO,
      // The question composer answers form elicitations.
      capabilities: { elicitation: { form: {} } },
    })
    await vi.waitFor(() => expect(connection.status).toBe("ready"))
    connection.close()
    expect(connection.status).toBe("closed")
  })

  it("ends without reconnecting when the gateway speaks another version", async () => {
    // A gateway from before the release this client speaks.
    const gateway = createGatewayAgent({ version: 1 })
    const statuses: string[] = []
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://gateway.test/api/v1/acp",
      socketConstructor: pipedSockets(() => gateway.app).WebSocket,
    })
    connection.subscribeStatus((status) => statuses.push(status))
    connection.start()

    const refusal = await connection.initialized.catch((error: Error) => error)
    expect(refusal).toBeInstanceOf(Error)
    expect((refusal as Error).message).toMatch(/version 2\b/)
    expect((refusal as Error).message).toMatch(/version 1\b/)
    await vi.waitFor(() => expect(connection.status).toBe("closed"))
    expect(statuses).not.toContain("ready")
    expect(statuses).not.toContain("reconnecting")
    expect(gateway.callsOf("initialize")).toHaveLength(1)
  })

  it("keeps the readable Agent entries and search results, and rejects when none can be read", async () => {
    const result = (sessionId: string) => ({
      sessionId,
      cwd: FOLDER,
      title: sessionId,
      _meta: { [HGW_META_KEY]: sessionInfoMeta() },
    })
    const logs = captureLogs()
    const connect = (options: Parameters<typeof createGatewayAgent>[0]) => {
      const connection = createAcpConnection({
        clientInfo: CLIENT_INFO,
        connectAgent: createGatewayAgent(options).app,
        logger: logs.logger,
      })
      connection.start()
      return connection
    }
    const verbose = { kind: "ready", id: "verbose", name: "n".repeat(257) }
    const partial = connect({
      agents: [catalogEntry(), { ...catalogEntry(), summary: verbose }],
      searchResults: [result("weekly"), { sessionId: "broken" }],
    })

    const catalog = await partial.listAgents()
    const searched = await partial.searchSessions({ query: "w" })

    expect(catalog.agents.map(({ summary }) => summary.id)).toEqual([AGENT_ID])
    expect(searched.sessions.map(({ sessionId }) => sessionId)).toEqual([
      "weekly",
    ])
    expect(
      logs
        .records()
        .filter(({ message }) => message.endsWith("_skipped"))
        .map(({ message, fields }) => [message, fields])
    ).toEqual([
      ["agents.entry_skipped", { id: "verbose" }],
      ["sessions.result_skipped", { id: "broken" }],
    ])

    const unreadable = connect({
      agents: [{ ...catalogEntry(), summary: verbose }],
      searchResults: [{ sessionId: "broken" }],
    })
    await expect(unreadable.listAgents()).rejects.toThrow()
    await expect(unreadable.searchSessions({ query: "w" })).rejects.toThrow()
    partial.close()
    unreadable.close()
  })

  it("redeems an invitation with the AOS login metadata, never logging it", async () => {
    const gateway = createGatewayAgent()
    const logs = captureLogs()
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://guest.test/api/v1/acp",
      socketConstructor: pipedSockets(() => gateway.app).WebSocket,
      logger: logs.logger,
    })
    connection.start()

    await connection.login("invitation-token")

    expect(gateway.paramsOf(methods.agent.auth.login)).toEqual({
      methodId: HGW_AUTH_METHOD_INVITE,
      _meta: { [HGW_META_KEY]: { token: "invitation-token" } },
    })
    expect(logs.records()).toContainEqual(
      expect.objectContaining({
        message: "acp.frame",
        fields: expect.objectContaining({
          method: methods.agent.auth.login,
          requestId: expect.anything(),
        }),
      })
    )
    expect(JSON.stringify(logs.records())).not.toContain("invitation-token")
    connection.close()
  })

  it("creates, lists, resumes, and prompts Sessions with AOS metadata", async () => {
    const gateway = createGatewayAgent()
    const connection = connectInProcess(gateway)

    const created = await connection.newSession({
      agentId: AGENT_ID,
      title: "Weekly report",
    })
    expect(created).toEqual({ sessionId: SESSION_ID })
    expect(gateway.paramsOf(methods.agent.session.new)).toMatchObject({
      cwd: "",
      _meta: { [HGW_META_KEY]: { agentId: AGENT_ID, title: "Weekly report" } },
    })

    const listed = await connection.listSessions(
      { agentId: AGENT_ID },
      "cursor-1"
    )
    expect(listed.sessions[0]?.sessionId).toBe(SESSION_ID)
    expect(listed.nextCursor).toBe("cursor-2")
    expect(gateway.paramsOf(methods.agent.session.list)).toMatchObject({
      cursor: "cursor-1",
      _meta: { [HGW_META_KEY]: { agentId: AGENT_ID } },
    })

    const searched = await connection.searchSessions({ query: "weekly" })
    expect(searched.sessions.map(({ title }) => title)).toEqual([
      "Weekly report",
    ])
    expect(gateway.paramsOf(HGW_METHODS.sessions.search)).toEqual({
      _meta: { [HGW_META_KEY]: { query: "weekly" } },
    })

    // `session/new` joined the Session, so opening it resumes nothing; the
    // Agent it was created in travels on every later resume.
    connection.subscribe(SESSION_ID, {})
    await connection.replay(SESSION_ID)
    expect(gateway.callsOf(methods.agent.session.resume)).toHaveLength(1)
    expect(gateway.paramsOf(methods.agent.session.resume)).toMatchObject({
      sessionId: SESSION_ID,
      replayFrom: { type: "start" },
      _meta: { [HGW_META_KEY]: { agentId: AGENT_ID } },
    })

    await expect(
      connection.prompt(SESSION_ID, [{ type: "text", text: "Hello" }], {
        attachmentStageId: "stage-1",
      })
    ).resolves.toEqual({ messageId: "message-7" })
    expect(gateway.paramsOf(methods.agent.session.prompt)).toMatchObject({
      sessionId: SESSION_ID,
      prompt: [{ type: "text", text: "Hello" }],
      _meta: { [HGW_META_KEY]: { attachmentStageId: "stage-1" } },
    })
    connection.close()
  })

  it("refuses a prompt or steer whose frame the gateway would not take, sending nothing", async () => {
    const gateway = createGatewayAgent()
    const connection = connectInProcess(gateway)
    await connection.initialized
    const tooLarge = expect.objectContaining({
      code: HGW_JSONRPC_ERRORS.requestTooLarge,
    })

    await expect(
      connection.prompt(
        SESSION_ID,
        [{ type: "text", text: "a".repeat(1_100_000) }],
        {}
      )
    ).rejects.toEqual(tooLarge)
    // Bytes decide, not characters: each of these takes two in UTF-8.
    await expect(
      connection.steer({
        sessionId: SESSION_ID,
        requestId: "request-1",
        text: "א".repeat(600_000),
      })
    ).rejects.toEqual(tooLarge)
    expect(gateway.callsOf(methods.agent.session.prompt)).toHaveLength(0)
    expect(gateway.callsOf(HGW_METHODS.session.steer)).toHaveLength(0)
    connection.close()
  })

  it("replays a Session from the start when asked", async () => {
    const gateway = createGatewayAgent()
    const connection = connectInProcess(gateway)
    const replaySettled = vi.fn()
    const dropTranscript = vi.fn(() => replaySettled)
    connection.subscribe(SESSION_ID, {
      agentId: AGENT_ID,
      replay: dropTranscript,
    })

    // The opening join is the replay asked for, not a second one.
    const replayed = connection.replay(SESSION_ID)
    expect(replaySettled).not.toHaveBeenCalled()
    await replayed
    expect(replaySettled).toHaveBeenCalledTimes(1)

    expect(gateway.callsOf(methods.agent.session.resume)).toHaveLength(1)
    expect(gateway.paramsOf(methods.agent.session.resume)).toMatchObject({
      replayFrom: { type: "start" },
      _meta: { [HGW_META_KEY]: { agentId: AGENT_ID } },
    })
    // The whole Session is on its way, so whoever projects it is told to drop
    // what this replay resends.
    expect(dropTranscript).toHaveBeenCalledTimes(1)
    connection.close()
  })

  it("writes Session config, lifecycle, and AOS extension requests", async () => {
    const gateway = createGatewayAgent()
    const connection = connectInProcess(gateway)

    const options = await connection.setConfigOption(
      SESSION_ID,
      "model",
      "opus"
    )
    expect(options[0]).toMatchObject({ currentValue: "opus" })
    expect(
      gateway.paramsOf(methods.agent.session.setConfigOption)
    ).toMatchObject({
      sessionId: SESSION_ID,
      configId: "model",
      type: "id",
      value: "opus",
    })

    await connection.deleteSession(SESSION_ID)
    await connection.updateSession({ sessionId: SESSION_ID, unread: false })
    expect(gateway.paramsOf(HGW_METHODS.session.update)).toEqual({
      sessionId: SESSION_ID,
      unread: false,
    })

    await expect(
      connection.steer({
        sessionId: SESSION_ID,
        requestId: "request-1",
        text: "focus on tests",
      })
    ).resolves.toEqual({ status: "queued" })

    const catalog = await connection.listAgents()
    expect(catalog.agents[0]?.summary.id).toBe(AGENT_ID)
    const updated = await connection.updateAgent({
      agentId: AGENT_ID,
      visibility: "hidden",
      avatar: null,
      revision: "revision-1",
    })
    expect(updated.revision).toBe("revision-2")
    expect(gateway.paramsOf(HGW_METHODS.agents.update)).toEqual({
      agentId: AGENT_ID,
      visibility: "hidden",
      avatar: null,
      revision: "revision-1",
    })
    connection.close()
  })

  it.each([
    // ACP's invalid params: a field this runtime cannot take.
    [RequestError.invalidParams().code, "unsupported"],
    [HGW_JSONRPC_ERRORS.revisionConflict, "conflict"],
  ] as const)(
    "names an Agent update refused with code %i as %s",
    async (refusal, code) => {
      const gateway = createGatewayAgent({ refuseAgentUpdate: refusal })
      const connection = connectInProcess(gateway)
      await connection.initialized

      const failure = await connection
        .updateAgent({ agentId: AGENT_ID, avatar: "ring/blue", revision: "r" })
        .catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(AgentUpdateError)
      expect(failure).toMatchObject({ code })
      connection.close()
    }
  )

  it("leaves any other Agent update failure as it came", async () => {
    const gateway = createGatewayAgent({
      refuseAgentUpdate: HGW_JSONRPC_ERRORS.temporarilyUnavailable,
    })
    const connection = connectInProcess(gateway)
    await connection.initialized

    const failure = await connection
      .updateAgent({ agentId: AGENT_ID, avatar: "ring/blue", revision: "r" })
      .catch((error: unknown) => error)

    expect(failure).not.toBeInstanceOf(AgentUpdateError)
    expect(failure).toMatchObject({
      code: HGW_JSONRPC_ERRORS.temporarilyUnavailable,
    })
    connection.close()
  })

  it("sends cancel as a notification and focus as a request", async () => {
    const gateway = createGatewayAgent()
    const connection = connectInProcess(gateway)
    await connection.initialized

    connection.cancel(SESSION_ID)
    connection.focus(null, { foreground: true, idle: false })

    await vi.waitFor(() => {
      expect(gateway.paramsOf(methods.agent.session.cancel)).toEqual({
        sessionId: SESSION_ID,
      })
      expect(gateway.paramsOf(HGW_METHODS.session.focus)).toEqual({
        sessionId: null,
        foreground: true,
        idle: false,
      })
    })
    connection.close()
  })

  it("dispatches Session updates with their AOS metadata to the Session's listeners", async () => {
    const gateway = createGatewayAgent()
    const connection = connectInProcess(gateway)
    await connection.initialized
    const seen: { update: SessionUpdate; meta?: Record<string, unknown> }[] = []
    const unsubscribe = connection.subscribe(SESSION_ID, {
      update: (update, meta) => seen.push({ update, meta }),
    })

    await gateway.pushUpdate(
      {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "error",
      },
      { sequence: 7, turnId: "run-1", code: "HGW_SEND_FAILED" }
    )

    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]?.update).toMatchObject({ sessionUpdate: "state_update" })
    expect(seen[0]?.meta).toMatchObject({ sequence: 7, turnId: "run-1" })

    unsubscribe()
    const stayed = vi.fn()
    connection.subscribe(SESSION_ID, { update: stayed })
    await gateway.pushUpdate(
      { sessionUpdate: "state_update", state: "running" },
      { sequence: 8, turnId: "run-1" }
    )
    await vi.waitFor(() => expect(stayed).toHaveBeenCalledTimes(1))
    expect(seen).toHaveLength(1)
    connection.close()
  })

  it("keeps a Session joined while any subscription of a listener stays", async () => {
    const clock = useFakeClock()
    const gateway = createGatewayAgent()
    const connection = connectInProcess(gateway)
    const listener = { agentId: AGENT_ID }
    const leave = connection.subscribe(SESSION_ID, listener)
    connection.subscribe(SESSION_ID, listener)
    await connection.joined(SESSION_ID)

    leave()
    await clock.advance(PART_GRACE_MS)
    expect(gateway.callsOf(methods.agent.session.close)).toHaveLength(0)
    connection.close()
  })

  it("dispatches AOS extension notifications by method", async () => {
    const gateway = createGatewayAgent()
    const connection = connectInProcess(gateway)
    await connection.initialized
    const activity: unknown[] = []
    let catalogInvalidations = 0
    connection.subscribeNotification(HGW_METHODS.notify.activity, (params) =>
      activity.push(params)
    )
    connection.subscribeNotification(
      HGW_METHODS.notify.catalogInvalidated,
      () => {
        catalogInvalidations += 1
      }
    )

    await gateway.notify(HGW_METHODS.notify.activity, {
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      occurredAt: UPDATED_AT,
      type: "turn-started",
      turnId: "lifecycle-1",
    })
    await gateway.notify(HGW_METHODS.notify.catalogInvalidated, undefined)

    await vi.waitFor(() => {
      expect(activity).toHaveLength(1)
      expect(catalogInvalidations).toBe(1)
    })
    expect(activity[0]).toMatchObject({ type: "turn-started" })
    connection.close()
  })

  it("answers a pending permission request with the operator's response", async () => {
    const gateway = createGatewayAgent()
    const connection = connectInProcess(gateway)
    await connection.initialized
    const pending: AcpPendingRequest[] = []
    connection.subscribePendingRequests((request) => pending.push(request))

    const answered = gateway.askPermission()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    const request = pending[0]
    expect(request?.kind).toBe("permission")
    expect(request?.sessionId).toBe(SESSION_ID)
    if (request?.kind !== "permission") throw new Error("expected permission")
    expect(request.request.title).toBe("Run the tool?")
    request.respond({ outcome: { outcome: "selected", optionId: "allow" } })

    await expect(answered).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "allow" },
    })
    connection.close()
  })

  it.each(["askPermission", "askQuestion"] as const)(
    "releases a request the gateway withdraws as cancelled (%s)",
    async (ask) => {
      const gateway = createGatewayAgent()
      const connection = connectInProcess(gateway)
      await connection.initialized
      const pending: AcpPendingRequest[] = []
      connection.subscribePendingRequests((request) => pending.push(request))
      const withdrawal = new AbortController()

      const answered = gateway[ask](withdrawal.signal)
      await vi.waitFor(() => expect(pending).toHaveLength(1))
      withdrawal.abort()

      await expect(answered).rejects.toMatchObject({ code: -32800 })
      expect(pending[0]?.signal.aborted).toBe(true)
      connection.close()
    }
  )

  it("keeps a pending request answerable when one consumer cannot show it", async () => {
    const gateway = createGatewayAgent()
    const connection = connectInProcess(gateway)
    await connection.initialized
    const pending: AcpPendingRequest[] = []
    connection.subscribePendingRequests(() => {
      throw new Error("this consumer cannot project the request")
    })
    connection.subscribePendingRequests((request) => pending.push(request))

    const answered = gateway.askPermission()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    const request = pending[0]
    if (request?.kind !== "permission") throw new Error("expected permission")
    request.respond({ outcome: { outcome: "selected", optionId: "allow" } })

    await expect(answered).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "allow" },
    })
    connection.close()
  })

  describe("older history pages", () => {
    const olderPage = {
      updates: [
        [
          {
            sessionUpdate: "user_message",
            messageId: "u0",
            content: [{ type: "text", text: "Earlier question" }],
          },
          { sequence: 1, turnId: "run-0" },
        ],
        [
          {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
          },
          { sequence: 2, turnId: "run-0" },
        ],
      ] as const satisfies readonly (readonly [
        SessionUpdate,
        Record<string, unknown>,
      ])[],
      history: { nextCursor: "cursor-older" },
    }

    it("keeps the latest history a resume reports, and a rejoin without one leaves it", async () => {
      const clock = useFakeClock()
      const gateway = createGatewayAgent({
        history: { nextCursor: "cursor-1" },
      })
      const { pipe, connection } = connectOverSockets(gateway)

      expect(connection.history(SESSION_ID)).toBeUndefined()
      connection.subscribe(SESSION_ID, {})
      await connection.joined(SESSION_ID)
      expect(connection.history(SESSION_ID)).toEqual({ nextCursor: "cursor-1" })

      // A rejoin replays nothing and reports no history: the cursor stands.
      pipe.sockets[0]?.drop()
      await clock.advance(250)
      expect(gateway.callsOf(methods.agent.session.resume)).toHaveLength(2)
      expect(connection.history(SESSION_ID)).toEqual({ nextCursor: "cursor-1" })
      connection.close()
    })

    it("reads a page as tagged updates that reach no live listener or position", async () => {
      const gateway = createGatewayAgent({ page: olderPage })
      const connection = connectInProcess(gateway)
      await connection.initialized
      const live: SessionUpdate[] = []
      connection.subscribe(SESSION_ID, {
        agentId: AGENT_ID,
        update: (update) => live.push(update),
      })
      await connection.joined(SESSION_ID)
      await gateway.pushUpdate(
        { sessionUpdate: "state_update", state: "running" },
        { sequence: 4, turnId: "run-1" }
      )
      await vi.waitFor(() => expect(live).toHaveLength(1))

      const page = await connection.resumePage(SESSION_ID, "cursor-1")

      expect(gateway.callsOf(methods.agent.session.resume).at(-1)).toEqual({
        sessionId: SESSION_ID,
        cwd: "",
        replayFrom: { type: HGW_REPLAY_BEFORE, cursor: "cursor-1" },
      })
      expect(page.history).toEqual({ nextCursor: "cursor-older" })
      expect(page.updates.map(({ update }) => update.sessionUpdate)).toEqual([
        "user_message",
        "state_update",
      ])
      expect(page.updates[1]?.meta).toMatchObject({
        sequence: 2,
        turnId: "run-0",
      })
      // The page's idle marker belongs to an old turn: the running turn's
      // listeners never see it.
      expect(live).toHaveLength(1)
      // A page read is not a resume, so the resume cursor is untouched.
      expect(connection.history(SESSION_ID)).toBeUndefined()

      // The live stream is unaffected once the page is in.
      await gateway.pushUpdate(
        { sessionUpdate: "state_update", state: "idle" },
        { sequence: 5, turnId: "run-1" }
      )
      await vi.waitFor(() => expect(live).toHaveLength(2))
      connection.close()
    })

    // A child's transcript is part of the page that named it, and its
    // positions are that page's, never the live turn's.
    it("gives the child listener a child transcript a page carries, moving no rejoin position", async () => {
      const clock = useFakeClock()
      const gateway = createGatewayAgent({
        page: {
          updates: [
            [
              { sessionUpdate: "subagent_update", sessionId: CHILD_ID },
              { sequence: 1, turnId: "history" },
            ],
            [
              {
                sessionUpdate: "agent_message",
                messageId: "child-message",
                content: [{ type: "text", text: "Two notes were stale" }],
              },
              { sequence: 2, turnId: "history" },
              CHILD_ID,
            ],
          ],
          history: {},
        },
      })
      const pipe = pipedSockets(() => gateway.app)
      const connection = createAcpConnection({
        clientInfo: CLIENT_INFO,
        url: "ws://gateway.test/api/v1/acp",
        socketConstructor: pipe.WebSocket,
      })
      connection.start()
      await connection.initialized
      const children: string[] = []
      connection.subscribe(SESSION_ID, {
        agentId: AGENT_ID,
        child: (childSessionId, update) =>
          children.push(`${childSessionId} ${update.sessionUpdate}`),
      })
      await connection.joined(SESSION_ID)
      await gateway.pushUpdate(
        { sessionUpdate: "state_update", state: "running" },
        { sequence: 4, turnId: "run-1" }
      )

      const page = await connection.resumePage(SESSION_ID, "cursor-1")

      expect(page.updates.map(({ update }) => update.sessionUpdate)).toEqual([
        "subagent_update",
      ])
      expect(children).toEqual([`${CHILD_ID} agent_message`])
      pipe.sockets[0]?.drop()
      await clock.advance(250)
      expect(
        gateway.callsOf(methods.agent.session.resume).at(-1)
      ).toHaveProperty("replayFrom", {
        type: HGW_REPLAY_POSITION,
        turnId: "run-1",
        from: 5,
      })
      connection.close()
    })

    // A child still at work after its turn reports between turns: it is no
    // position in that turn's stream, which a rejoin still resumes from.
    it("gives the child listener a background child update, moving no rejoin position", async () => {
      const clock = useFakeClock()
      const gateway = createGatewayAgent()
      const pipe = pipedSockets(() => gateway.app)
      const connection = createAcpConnection({
        clientInfo: CLIENT_INFO,
        url: "ws://gateway.test/api/v1/acp",
        socketConstructor: pipe.WebSocket,
      })
      connection.start()
      await connection.initialized
      const children: string[] = []
      connection.subscribe(SESSION_ID, {
        agentId: AGENT_ID,
        child: (childSessionId, update) =>
          children.push(`${childSessionId} ${update.sessionUpdate}`),
      })
      await connection.joined(SESSION_ID)
      await gateway.pushUpdate(
        { sessionUpdate: "subagent_update", sessionId: CHILD_ID },
        { sequence: 4, turnId: "run-1" }
      )

      await gateway.pushUpdate(
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "child-message",
          content: { type: "text", text: "Still working." },
        },
        { sequence: 0, turnId: "run-1", background: true },
        CHILD_ID
      )

      await vi.waitFor(() =>
        expect(children).toEqual([`${CHILD_ID} agent_message_chunk`])
      )
      pipe.sockets[0]?.drop()
      await clock.advance(250)
      expect(
        gateway.callsOf(methods.agent.session.resume).at(-1)
      ).toHaveProperty("replayFrom", {
        type: HGW_REPLAY_POSITION,
        turnId: "run-1",
        from: 5,
      })
      connection.close()
    })

    it("fails a page whose reply carries no history", async () => {
      const gateway = createGatewayAgent({
        page: { updates: olderPage.updates },
      })
      const connection = connectInProcess(gateway)

      await expect(
        connection.resumePage(SESSION_ID, "cursor-1")
      ).rejects.toThrow()
      connection.close()
    })

    it("waits for a recovering transport to rejoin before reading a page", async () => {
      const clock = useFakeClock()
      const gateway = createGatewayAgent({ page: olderPage, slowResume: true })
      const { pipe, connection } = connectOverSockets(gateway)
      await connection.initialized
      connection.subscribe(SESSION_ID, {})
      const joined = connection.joined(SESSION_ID)
      await clock.advance(20)
      await joined

      const recovering = new Promise<void>((resolve) =>
        connection.subscribeStatus((status) => {
          if (status === "reconnecting") resolve()
        })
      )
      pipe.sockets[0]?.drop()
      await recovering
      const page = connection.resumePage(SESSION_ID, "cursor-1")
      await clock.advance(300)
      await page

      const order = gateway.calls.flatMap(({ method, params }) =>
        method === RESUME_REPLIED
          ? ["rejoined"]
          : method === methods.agent.session.resume &&
              z.object({ replayFrom: HgwReplayBeforeSchema }).safeParse(params)
                .success
            ? ["page"]
            : []
      )
      expect(order).toEqual(["rejoined", "rejoined", "page"])
      connection.close()
    })

    it("reads a page its socket fails under again, whole, once the Session rejoins", async () => {
      const clock = useFakeClock()
      const gateway = createGatewayAgent({ page: olderPage, slowResume: true })
      const { pipe, connection } = connectOverSockets(gateway)
      connection.subscribe(SESSION_ID, {})
      const joined = connection.joined(SESSION_ID)
      await clock.advance(20)
      await joined

      // The page's updates arrive, and its socket fails before the reply.
      const page = connection.resumePage(SESSION_ID, "cursor-1")
      await clock.advance(0)
      pipe.sockets[0]!.fail()
      await clock.advance(300)

      const { updates } = await page
      expect(updates.map(({ update }) => update.sessionUpdate)).toEqual([
        "user_message",
        "state_update",
      ])
      const pageReads = gateway
        .callsOf(methods.agent.session.resume)
        .filter(
          (params) =>
            z.object({ replayFrom: HgwReplayBeforeSchema }).safeParse(params)
              .success
        )
      expect(pageReads).toHaveLength(2)
      connection.close()
    })
  })

  it("delivers no request over a half-open transport", async () => {
    const clock = useFakeClock()
    const gateway = createGatewayAgent()
    const { pipe, connection } = connectOverSockets(gateway)
    await connection.initialized

    pipe.sockets[0]?.halfOpen()
    void connection.listAgents().catch(() => {})
    await clock.advance(1_000)

    expect(gateway.callsOf(HGW_METHODS.agents.list)).toEqual([])
    connection.close()
  })

  it("reconnects a dropped transport and rejoins every resumed Session", async () => {
    const clock = useFakeClock()
    const gateway = createGatewayAgent()
    const { pipe, connection } = connectOverSockets(gateway)
    await connection.initialized
    const seen = vi.fn()
    connection.subscribe(SESSION_ID, { agentId: AGENT_ID, update: seen })
    await connection.joined(SESSION_ID)
    connection.focus(SESSION_ID, { foreground: true, idle: true })
    await gateway.pushUpdate(
      { sessionUpdate: "state_update", state: "running" },
      { sequence: 4, turnId: "run-1" }
    )
    // A drop loses whatever is still in flight, so the first report lands first.
    await clock.advance(0)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(gateway.callsOf(HGW_METHODS.session.focus)).toHaveLength(1)

    pipe.sockets[0]?.drop()
    await clock.advance(250)

    expect(gateway.callsOf(methods.agent.session.resume)).toHaveLength(2)
    // ACP cursors are inclusive, so the rejoin names the first event it lacks.
    const rejoin = gateway.callsOf(methods.agent.session.resume)[1]
    expect(rejoin).toMatchObject({
      replayFrom: { type: HGW_REPLAY_POSITION, turnId: "run-1", from: 5 },
      _meta: { [HGW_META_KEY]: { agentId: AGENT_ID } },
    })
    expect(rejoin).not.toHaveProperty(["_meta", HGW_META_KEY, "after"])
    // The gateway forgot this connection's presence when the transport dropped, so
    // the report goes out again ahead of the rejoin it would otherwise
    // contradict. The wire order is the browser's to keep; the order the agent
    // runs its handlers in is not.
    expect(gateway.callsOf(HGW_METHODS.session.focus)).toEqual([
      { sessionId: SESSION_ID, foreground: true, idle: true },
      { sessionId: SESSION_ID, foreground: true, idle: true },
    ])
    const sent = pipe.sockets[1]!.sent.map((frame) =>
      "method" in frame ? frame.method : undefined
    )
    expect(sent.indexOf(HGW_METHODS.session.focus)).toBeGreaterThan(-1)
    expect(sent.indexOf(HGW_METHODS.session.focus)).toBeLessThan(
      sent.indexOf(methods.agent.session.resume)
    )
    expect(connection.status).toBe("ready")
    expect(pipe.sockets).toHaveLength(2)
    connection.close()
  })

  it("rejoins a Session it saw no turn of at the position it holds", async () => {
    const clock = useFakeClock()
    const gateway = createGatewayAgent()
    const pipe = pipedSockets(() => gateway.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://gateway.test/api/v1/acp",
      socketConstructor: pipe.WebSocket,
    })
    connection.start()
    await connection.initialized
    connection.subscribe(SESSION_ID, { agentId: AGENT_ID })
    await connection.joined(SESSION_ID)

    pipe.sockets[0]?.drop()
    await clock.advance(250)

    // Not a resume without a cursor, which ACP answers with no replay at all.
    expect(gateway.callsOf(methods.agent.session.resume)[1]).toHaveProperty(
      "replayFrom",
      { type: HGW_REPLAY_POSITION }
    )
    connection.close()
  })

  it("reports the outage from a drop until the transport is ready, leaving a rejoin to its Session", async () => {
    const clock = useFakeClock()
    const gateway = createGatewayAgent({ slowResume: true })
    const { pipe, connection } = connectOverSockets(gateway)
    connection.subscribe(SESSION_ID, {})
    const joined = connection.joined(SESSION_ID)
    await clock.advance(20)
    await joined
    expect(connection.outage).toBeUndefined()

    pipe.sockets[0]?.drop()
    await clock.advance(0)
    expect(connection.outage).toBe("reconnecting")
    while (connection.status !== "ready") await clock.advance(1)
    await clock.advance(0)
    // The transport is back: the outage is over, and the Session still
    // rejoining says so in its own state, holding up no other Session.
    expect(connection.sessionState(SESSION_ID)).toBe("joining")
    expect(connection.outage).toBeUndefined()

    await clock.advance(20)
    expect(connection.sessionState(SESSION_ID)).toBe("joined")
    connection.close()
  })

  it("keeps a transport whose probe reply is held while its frames keep arriving", async () => {
    const clock = useFakeClock()
    const gateway = createGatewayAgent({ holdFocus: true })
    const pipe = pipedSockets(() => gateway.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://gateway.test/api/v1/acp",
      socketConstructor: pipe.WebSocket,
    })
    connection.start()
    connection.subscribe(SESSION_ID, {})
    const joined = connection.joined(SESSION_ID)
    await clock.advance(20)
    await joined

    connection.focus(SESSION_ID, { foreground: true, idle: false })
    // The probe's reply waits behind one Session's long replay, whose frames
    // keep arriving: the transport is alive, so it stays.
    for (let waited = 0; waited <= REQUEST_DEADLINE_MS.probe; waited += 5_000) {
      await gateway.pushUpdate(
        { sessionUpdate: "state_update", state: "running" },
        { sequence: waited + 1, turnId: "run-1" }
      )
      await clock.advance(5_000)
    }

    expect(pipe.sockets).toHaveLength(1)
    expect(connection.status).toBe("ready")
    connection.close()
  })

  it("answers a read its socket fails under, or one made while it reconnects, once a transport recovers", async () => {
    const clock = useFakeClock()
    const gateway = createGatewayAgent()
    const { pipe, connection } = connectOverSockets(gateway)
    await connection.initialized

    // In flight as its socket fails.
    pipe.sockets[0]!.holdOutbound()
    const catalog = connection.listAgents()
    await clock.advance(0)
    pipe.neverAnswerHandshake()
    pipe.sockets[0]!.fail()
    await clock.advance(0)
    expect(connection.status).toBe("reconnecting")
    // Made while the connection waits to reopen.
    const listed = connection.listSessions({ agentId: AGENT_ID })
    await clock.advance(250)
    // Made while the reopened socket's handshake goes unanswered; it fails.
    expect(pipe.sockets).toHaveLength(2)
    const searched = connection.searchSessions({ query: "weekly" })
    await clock.advance(0)
    pipe.sockets[1]!.fail()
    await clock.advance(500)

    expect(pipe.sockets).toHaveLength(3)
    await expect(catalog).resolves.toMatchObject({ revision: "revision-1" })
    await expect(listed).resolves.toMatchObject({ nextCursor: "cursor-2" })
    await expect(searched).resolves.toMatchObject({
      sessions: [{ title: "Weekly report" }],
    })
    // Each reached the gateway once, over the transport that recovered.
    for (const method of [
      HGW_METHODS.agents.list,
      methods.agent.session.list,
      HGW_METHODS.sessions.search,
    ])
      expect(gateway.callsOf(method)).toHaveLength(1)
    connection.close()
  })

  it("fails a Session create its socket fails under as a closed connection, and never sends it again", async () => {
    const clock = useFakeClock()
    const gateway = createGatewayAgent()
    const { pipe, connection } = connectOverSockets(gateway)
    await connection.initialized

    pipe.sockets[0]!.holdOutbound()
    const created = connection
      .newSession({ agentId: AGENT_ID })
      .catch((error: unknown) => error)
    await clock.advance(0)
    pipe.sockets[0]!.fail()

    const failure = await created
    expect(failure).toBeInstanceOf(AcpConnectionClosedError)
    expect(failure).toMatchObject({ cause: expect.any(Event) })
    await clock.advance(250)
    expect(connection.status).toBe("ready")
    expect(gateway.callsOf(methods.agent.session.new)).toEqual([])
    connection.close()
  })

  it("rejects a read the connection ends under as a closed connection, never with the socket's event", async () => {
    const clock = useFakeClock()
    const { pipe, connection } = connectOverSockets(createGatewayAgent())
    await connection.initialized

    pipe.sockets[0]!.holdOutbound()
    const catalog = connection.listAgents().catch((error: unknown) => error)
    await clock.advance(0)
    pipe.sockets[0]!.fail()
    await clock.advance(0)
    connection.close()

    expect(await catalog).toBeInstanceOf(AcpConnectionClosedError)
  })

  it("redeems the invitation again before replaying a recovered transport", async () => {
    const clock = useFakeClock()
    const gateway = createGatewayAgent()
    const pipe = pipedSockets(() => gateway.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://guest.test/api/v1/acp",
      socketConstructor: pipe.WebSocket,
    })
    connection.start()
    await connection.initialized
    await connection.login("invitation-token")
    connection.subscribe(SESSION_ID, {})
    await connection.joined(SESSION_ID)

    pipe.sockets[0]?.drop()
    await clock.advance(250)

    expect(gateway.callsOf(methods.agent.session.resume)).toHaveLength(2)
    expect(
      gateway.calls
        .map(({ method }) => method)
        .filter(
          (method) =>
            method === methods.agent.auth.login ||
            method === methods.agent.session.resume
        )
    ).toEqual([
      methods.agent.auth.login,
      methods.agent.session.resume,
      methods.agent.auth.login,
      methods.agent.session.resume,
    ])
    connection.close()
  })

  it("ends the connection when the invitation can no longer be redeemed", async () => {
    const clock = useFakeClock()
    const gateway = createGatewayAgent({ refuseLoginAfter: 1 })
    const pipe = pipedSockets(() => gateway.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://guest.test/api/v1/acp",
      socketConstructor: pipe.WebSocket,
    })
    connection.start()
    await connection.initialized
    await connection.login("invitation-token")
    connection.subscribe(SESSION_ID, {})
    await connection.joined(SESSION_ID)

    pipe.sockets[0]?.drop()
    await clock.advance(250)

    expect(connection.status).toBe("closed")
    // A refused invitation stops the reconnect loop instead of replaying.
    expect(gateway.callsOf(methods.agent.auth.login)).toHaveLength(2)
    expect(gateway.callsOf(methods.agent.session.resume)).toHaveLength(1)
    expect(pipe.sockets).toHaveLength(2)
  })
})
