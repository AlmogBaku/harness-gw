// @vitest-environment node

import {
  isJSONRPCRequest,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server"
import { afterEach, describe, expect, it } from "vitest"

import { mcpAppStableOriginKey } from "../../protocol/node"
import { captureLogs } from "../../test/support/log-capture"
import * as ids from "../core/ids"
import type { McpAppFileReadFailure, McpAppView } from "../../protocol/mcp-apps"
import {
  ServerSessionNotFoundError,
  type ServerRuntime,
  type SessionScope,
} from "../core/runtime"
import { withMcpApps } from "./annotate"
import {
  createMcpAppClient,
  McpAppConnectionRefusedError,
  McpAppFileError,
  McpAppResourceError,
  type McpAppClient,
  type McpServerOverrides,
} from "./client"
import {
  createMcpAppsFallback,
  McpAppNotFoundError,
  McpAppRefusedError,
  type StoredMcpToolCall,
} from "./fallback"
import type { DroppedDomain } from "./policy"
import { createMcpToolNames } from "./tool-names"

const VIEW_URI = "ui://weather/forecast"
const ARTIFACT_URI = "ui://aos-ui/artifact"
/** A viewer's own script, which is no App view. */
const WORKER_URI = "ui://aos-ui/pdfjs/pdf.worker.js"
const TOOLS = [
  { name: "show-forecast", _meta: { ui: { resourceUri: VIEW_URI } } },
  { name: "refresh_forecast", _meta: { ui: { visibility: ["app"] } } },
  { name: "delete_station", _meta: { ui: { visibility: ["model"] } } },
  { name: "plain_lookup" },
]

/** The `_meta.ui` the forecast view declares, one origin in it invalid. */
const FORECAST_UI = {
  csp: {
    connectDomains: [
      "https://api.weather.test",
      "wss://live.weather.test",
      "javascript:x",
    ],
  },
  prefersBorder: false,
}

/** The `_meta.ui` a view declares on its content item and its listing entry. */
type DeclaredUi = {
  item?: Record<string, unknown>
  listed?: Record<string, unknown>
}

/**
 * A resource's answer: its blob or text, a JSON-RPC error with `data`, or
 * none ever.
 */
type Answer =
  | { blob: string }
  | { text: string }
  | { error: unknown }
  | { hangs: true }

/**
 * A Streamable HTTP MCP App server, answered in process through `fetch`; given
 * an `authorization`, it answers 401 to any request that does not carry it.
 * Each view declares `_meta.ui` where `views` says, by default the forecast's
 * on its content item; `listing` answers `resources/list` with a 500, or
 * never. Each of `reads` is one more resource, answered as it says.
 */
function appServer({
  authorization,
  views,
  listing,
  reads,
}: {
  authorization?: string
  views?: Record<string, DeclaredUi>
  listing?: "fails" | "hangs"
  reads?: Record<string, Answer>
} = {}) {
  const seen = {
    listTools: 0,
    listResources: 0,
    calls: [] as string[],
    urls: new Set<string>(),
  }
  const declared: Record<string, DeclaredUi> = {
    [VIEW_URI]: { item: FORECAST_UI },
    [ARTIFACT_URI]: { item: FORECAST_UI },
    ...views,
  }
  const handle = async (request: Request) => {
    seen.urls.add(request.url)
    if (
      authorization !== undefined &&
      request.headers.get("authorization") !== authorization
    )
      return new Response(null, { status: 401 })
    if (request.method === "POST") {
      const message: unknown = await request.clone().json()
      if (isJSONRPCRequest(message) && message.method === "tools/list")
        seen.listTools += 1
      if (isJSONRPCRequest(message) && message.method === "resources/list") {
        seen.listResources += 1
        if (listing === "fails") return new Response(null, { status: 500 })
        if (listing === "hangs") return new Promise<Response>(() => {})
      }
    }
    const server = new McpServer({ name: "weather", version: "1.0.0" })
    for (const { name, _meta } of TOOLS)
      server.registerTool(name, { _meta }, () => {
        seen.calls.push(name)
        return { content: [{ type: "text", text: `ran ${name}` }] }
      })
    for (const [uri, { item, listed }] of Object.entries(declared))
      server.registerResource(
        uri,
        uri,
        listed ? { _meta: { ui: listed } } : {},
        () => ({
          contents: [
            {
              uri,
              mimeType: "text/html;profile=mcp-app",
              text: "<!doctype html><p>Forecast</p>",
              ...(item ? { _meta: { ui: item } } : {}),
            },
          ],
        })
      )
    server.registerResource(WORKER_URI, WORKER_URI, {}, () => ({
      contents: [
        { uri: WORKER_URI, mimeType: "text/javascript", text: "onmessage=0" },
      ],
    }))
    for (const [uri, answer] of Object.entries(reads ?? {}))
      server.registerResource(uri, uri, {}, () => {
        if ("hangs" in answer) return new Promise<never>(() => {})
        if ("error" in answer)
          throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            "The file read failed",
            answer.error
          )
        return { contents: [{ uri, ...answer }] }
      })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    try {
      return await transport.handleRequest(request)
    } finally {
      await server.close()
    }
  }
  const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handle(
      input instanceof Request
        ? new Request(input, init)
        : new Request(String(input), init)
    )) as typeof globalThis.fetch
  return { seen, fetch }
}

const scope: SessionScope = {
  agentId: "agent-1",
  providerSessionId: ids.providerSessionId("session-1"),
  sessionId: ids.sessionId("session-1"),
}

const stored: Record<string, StoredMcpToolCall> = {
  "call-forecast": {
    toolName: "mcp__weather__show-forecast",
    input: { city: "Haifa" },
    result: { content: [{ type: "text", text: "Sunny" }] },
  },
  "call-declared": {
    toolName: "mcp__weather__plain_lookup",
    input: {},
    result: {
      content: [{ type: "text", text: "Rain" }],
      _meta: { ui: { resourceUri: VIEW_URI } },
    },
  },
  "call-artifact": {
    toolName: "present_artifact",
    input: { path: "/srv/agent/q3.md" },
    result: {
      content: [{ type: "text", text: "q3.md is ready for display." }],
      _meta: { ui: { resourceUri: ARTIFACT_URI } },
    },
  },
}

let client: McpAppClient | undefined

afterEach(async () => {
  await client?.close()
  client = undefined
})

function fallback(
  options: {
    weatherUrl?: string
    authorization?: string
    servers?: McpServerOverrides
    views?: Record<string, DeclaredUi>
    listing?: "fails" | "hangs"
    reads?: Record<string, Answer>
    catalogTimeoutMs?: number
    maxFileBytes?: number
  } = {}
) {
  const server = appServer(options)
  const logs = captureLogs()
  client = createMcpAppClient({
    fetch: server.fetch,
    servers: options.servers,
    logger: logs.logger,
    catalogTimeoutMs: options.catalogTimeoutMs,
    maxFileBytes: options.maxFileBytes,
  })
  const apps = createMcpAppsFallback(
    {
      servers: async () => [
        {
          name: "weather",
          url: options.weatherUrl ?? "http://weather.test/mcp",
        },
        { name: "notes", url: "http://notes.test/mcp" },
        { name: "aos_ui", url: "http://aos-ui.test/mcp" },
        { name: "unreachable" },
      ],
      storedCall: async (_scope, toolCallId) => stored[toolCallId],
    },
    client,
    logs.logger
  )
  return { apps, seen: server.seen, logs }
}

describe("MCP Apps fallback host", () => {
  it("opens the view with its sanitized CSP, the call's input, and its result", async () => {
    const { apps } = fallback()

    await expect(
      apps.describe(scope, {
        toolCallId: "call-forecast",
        toolName: "mcp__weather__show-forecast",
      })
    ).resolves.toBe(true)
    await expect(apps.open(scope, "call-forecast")).resolves.toEqual({
      html: "<!doctype html><p>Forecast</p>",
      csp: {
        connectDomains: ["https://api.weather.test", "wss://live.weather.test"],
      },
      prefersBorder: false,
      toolInput: { city: "Haifa" },
      toolResult: { content: [{ type: "text", text: "Sunny" }] },
    })
  })

  it("lets a view call an app-visible tool on its own server", async () => {
    const { apps, seen } = fallback()

    await expect(
      apps.callTool(scope, "call-forecast", "refresh_forecast", {})
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "ran refresh_forecast" }],
    })
    expect(seen.calls).toEqual(["refresh_forecast"])
  })

  it("refuses a model-only tool and a tool of another server", async () => {
    const { apps, seen } = fallback()

    await expect(
      apps.callTool(scope, "call-forecast", "delete_station", {})
    ).rejects.toBeInstanceOf(McpAppRefusedError)
    await expect(
      apps.callTool(scope, "call-forecast", "create_note", {})
    ).rejects.toBeInstanceOf(McpAppRefusedError)
    await expect(
      apps.readResource(scope, "call-forecast", "https://notes.test/secret")
    ).rejects.toBeInstanceOf(McpAppRefusedError)
    expect(seen.calls).toEqual([])
  })

  it("answers not found for a call this Session does not hold", async () => {
    const { apps } = fallback()

    await expect(apps.open(scope, "call-elsewhere")).rejects.toBeInstanceOf(
      McpAppNotFoundError
    )
    await expect(
      apps.callTool(scope, "call-elsewhere", "refresh_forecast", {})
    ).rejects.toBeInstanceOf(McpAppNotFoundError)
  })

  it("opens a named server's view, and reads its resources as it answers them, without a tool call", async () => {
    const { apps, seen } = fallback()

    await expect(
      apps.serverView!(scope, "aos-ui", ARTIFACT_URI)
    ).resolves.toEqual({
      html: "<!doctype html><p>Forecast</p>",
      csp: {
        connectDomains: ["https://api.weather.test", "wss://live.weather.test"],
      },
      prefersBorder: false,
    })
    // The view's own reads need not be App views.
    await expect(
      apps.serverResource!(scope, "aos-ui", WORKER_URI)
    ).resolves.toMatchObject({
      contents: [
        { uri: WORKER_URI, mimeType: "text/javascript", text: "onmessage=0" },
      ],
    })
    await expect(
      apps.serverView!(scope, "aos-ui", WORKER_URI)
    ).rejects.toBeInstanceOf(McpAppResourceError)
    expect(seen.urls).toEqual(new Set(["http://aos-ui.test/mcp"]))
    const reads = [
      (server: string, uri: string) => apps.serverView!(scope, server, uri),
      (server: string, uri: string) => apps.serverResource!(scope, server, uri),
    ]
    for (const read of reads) {
      await expect(
        read("aos-ui", "https://aos-ui.test/secret")
      ).rejects.toBeInstanceOf(McpAppRefusedError)
      // A server the Agent lacks, and one with no URL the gateway may dial.
      for (const server of ["absent", "unreachable"])
        await expect(read(server, ARTIFACT_URI)).rejects.toBeInstanceOf(
          McpAppNotFoundError
        )
    }
  })

  it("takes the view a stored result names without listing tools", async () => {
    const { apps, seen } = fallback()

    await expect(
      apps.describe(scope, {
        toolCallId: "call-declared",
        toolName: "mcp__weather__plain_lookup",
        result: stored["call-declared"]!.result,
      })
    ).resolves.toBe(true)
    await expect(apps.open(scope, "call-declared")).resolves.toMatchObject({
      html: "<!doctype html><p>Forecast</p>",
    })
    expect(seen.listTools).toBe(0)
  })

  describe("with operator-configured headers", () => {
    const SECRET = "Bearer weather-s3cret"
    const servers: McpServerOverrides = new Map([
      ["weather", { headers: { Authorization: SECRET } }],
    ])

    it("sends them to a server that requires them", async () => {
      const { apps, logs } = fallback({
        weatherUrl: "https://weather.test/mcp",
        authorization: SECRET,
        servers,
      })

      await expect(
        apps.describe(scope, {
          toolCallId: "call-forecast",
          toolName: "mcp__weather__show-forecast",
        })
      ).resolves.toBe(true)
      await expect(apps.open(scope, "call-forecast")).resolves.toMatchObject({
        html: "<!doctype html><p>Forecast</p>",
      })
      expect(JSON.stringify(logs.records())).not.toContain("s3cret")
    })

    it("refuses to send them over plain HTTP, and falls back to text", async () => {
      const { apps, seen } = fallback({ authorization: SECRET, servers })

      await expect(
        apps.describe(scope, {
          toolCallId: "call-forecast",
          toolName: "mcp__weather__show-forecast",
        })
      ).resolves.toBe(false)
      const refused = await apps.open(scope, "call-forecast").catch((e) => e)
      expect(refused).toBeInstanceOf(McpAppConnectionRefusedError)
      expect(String(refused)).not.toContain("s3cret")
      expect(seen.listTools).toBe(0)
    })
  })

  it("keeps the newest running calls of the newest Sessions until a Session is gone", async () => {
    const { apps } = fallback()
    const runtime = withMcpApps({
      mcpApps: apps,
      turns: {
        start: async () => Promise.reject(new Error("unused")),
        recover: async () => Promise.reject(new ServerSessionNotFoundError()),
      },
      deleteSession: async () => undefined,
      publicError: () => undefined,
    } as unknown as ServerRuntime)
    const session = (n: number): SessionScope => ({
      agentId: "agent-1",
      providerSessionId: ids.providerSessionId(`session-${n}`),
      sessionId: ids.sessionId(`session-${n}`),
    })
    const observe = (at: SessionScope, toolCallId: string) =>
      apps.observe?.(at, {
        toolCallId,
        toolName: "mcp__weather__show-forecast",
      })
    const view = { html: "<!doctype html><p>Forecast</p>" }

    // A Session keeps its newest 32 running calls.
    for (let call = 0; call <= 32; call++) observe(scope, `live-${call}`)
    await expect(apps.open(scope, "live-1")).resolves.toMatchObject(view)
    await expect(apps.open(scope, "live-0")).rejects.toBeInstanceOf(
      McpAppNotFoundError
    )
    // The fallback keeps the newest 8 Sessions.
    for (let n = 2; n <= 9; n++) observe(session(n), "live-0")
    await expect(apps.open(scope, "live-1")).rejects.toBeInstanceOf(
      McpAppNotFoundError
    )
    // A Session deleted, or one a recover finds gone, keeps none.
    await runtime.deleteSession("agent-1", session(2).providerSessionId)
    await expect(
      runtime.turns.recover(session(3), {
        sessionId: session(3).sessionId,
        turnId: "turn-1",
      })
    ).rejects.toBeInstanceOf(ServerSessionNotFoundError)
    await expect(apps.open(session(2), "live-0")).rejects.toBeInstanceOf(
      McpAppNotFoundError
    )
    await expect(apps.open(session(3), "live-0")).rejects.toBeInstanceOf(
      McpAppNotFoundError
    )
    await expect(apps.open(session(4), "live-0")).resolves.toMatchObject(view)
  })

  describe("with an operator-configured URL", () => {
    it("connects there instead of the URL the runtime reports", async () => {
      const { apps, seen } = fallback({
        servers: new Map([["weather", { url: "http://tools-mcp:4110/mcp" }]]),
      })

      await expect(apps.open(scope, "call-forecast")).resolves.toMatchObject({
        html: "<!doctype html><p>Forecast</p>",
      })
      expect([...seen.urls]).toEqual(["http://tools-mcp:4110/mcp"])
    })

    it("sends headers to the override URL", async () => {
      const SECRET = "Bearer weather-s3cret"
      const secured = fallback({
        authorization: SECRET,
        servers: new Map([
          [
            "weather",
            {
              url: "https://weather.internal/mcp",
              headers: { Authorization: SECRET },
            },
          ],
        ]),
      })
      await expect(
        secured.apps.open(scope, "call-forecast")
      ).resolves.toMatchObject({ html: "<!doctype html><p>Forecast</p>" })
      expect([...secured.seen.urls]).toEqual(["https://weather.internal/mcp"])
    })

    it("refuses to send headers to a plain-HTTP override the runtime reported as HTTPS", async () => {
      const SECRET = "Bearer weather-s3cret"
      const plain = fallback({
        weatherUrl: "https://weather.test/mcp",
        authorization: SECRET,
        servers: new Map([
          [
            "weather",
            {
              url: "http://tools-mcp:4110/mcp",
              headers: { Authorization: SECRET },
            },
          ],
        ]),
      })
      await expect(
        plain.apps.open(scope, "call-forecast")
      ).rejects.toBeInstanceOf(McpAppConnectionRefusedError)
      expect(plain.seen.urls.size).toBe(0)
    })
  })
})

describe("a view's read of its own file address", () => {
  const PASS = "pass-s3cret"
  /** One of the Session's file addresses, as a view sends it. */
  const address = (subject: string) =>
    `https://sandbox.test/api/v1/agents/agent-1/sessions/session-1/${subject}/app/files/path?pass=${PASS}`
  const CALL_FILE = address("tool-calls/call-forecast")
  const ARTIFACT_FILE = address("artifacts/artifact-1")
  const forecastFile = (apps: ReturnType<typeof fallback>["apps"]) =>
    apps.fileResource!(scope, { toolCallId: "call-forecast" }, CALL_FILE)

  it("reaches the server that owns the view, and logs no pass", async () => {
    const { apps, seen, logs } = fallback({
      reads: {
        [CALL_FILE]: { blob: "JVBERi0x" },
        [ARTIFACT_FILE]: { blob: "IyBOb3Rlcw==" },
      },
    })

    await expect(forecastFile(apps)).resolves.toEqual({
      contents: [{ uri: CALL_FILE, blob: "JVBERi0x" }],
    })
    expect(seen.urls).toEqual(new Set(["http://weather.test/mcp"]))
    // A published Artifact's file, through the viewer's server.
    await expect(
      apps.fileResource!(scope, { server: "aos-ui" }, ARTIFACT_FILE)
    ).resolves.toEqual({
      contents: [{ uri: ARTIFACT_FILE, blob: "IyBOb3Rlcw==" }],
    })
    expect(seen.urls).toContain("http://aos-ui.test/mcp")
    // No server the gateway may dial.
    await expect(
      apps.fileResource!(scope, { server: "unreachable" }, ARTIFACT_FILE)
    ).rejects.toBeInstanceOf(McpAppNotFoundError)
    expect(logs.records()).toContainEqual({
      level: "info",
      message: "mcp_app.upstream",
      fields: {
        agentId: "agent-1",
        sessionId: "session-1",
        toolCallId: "call-forecast",
        server: "weather",
        operation: "resources/read",
        path: "/api/v1/agents/agent-1/sessions/session-1/tool-calls/call-forecast/app/files/path",
      },
    })
    expect(JSON.stringify(logs.records())).not.toContain(PASS)
  })

  it.each<[string, unknown, McpAppFileReadFailure]>([
    ["denied", { reason: "denied" }, "denied"],
    ["too large", { reason: "tooLarge" }, "tooLarge"],
    ["out of the file's reach", { reason: "unreachable" }, "unreachable"],
    ["failed without a reason", undefined, "unavailable"],
    [
      "failed for a reason the protocol lacks",
      { reason: "gone" },
      "unavailable",
    ],
  ])("fails a read its server %s as it said", async (_, error, reason) => {
    const { apps } = fallback({ reads: { [CALL_FILE]: { error } } })

    await expect(forecastFile(apps)).rejects.toEqual(
      new McpAppFileError(reason)
    )
  })

  it("stops its read once its request's signal aborts", async () => {
    const { apps } = fallback({ reads: { [CALL_FILE]: { hangs: true } } })
    const request = new AbortController()

    const read = apps.fileResource!(
      scope,
      { toolCallId: "call-forecast" },
      CALL_FILE,
      request.signal
    )
    request.abort()

    await expect(read).rejects.toEqual(new McpAppFileError("unavailable"))
  })

  it("answers a file up to its cap, past the 2 MiB every other read keeps", async () => {
    // The cap is 64 MiB; a smaller one makes the same boundary cheap to reach.
    const CAP = 3 * 1024 * 1024
    const LARGE_URI = "ui://aos-ui/large.js"
    const { apps } = fallback({
      maxFileBytes: CAP,
      reads: {
        [CALL_FILE]: { blob: Buffer.alloc(CAP).toString("base64") },
        [ARTIFACT_FILE]: { blob: Buffer.alloc(CAP + 1).toString("base64") },
        [LARGE_URI]: { text: "x".repeat(2 * 1024 * 1024 + 1) },
      },
    })

    const largest = await forecastFile(apps)
    expect(
      largest.contents.map(
        (entry) => "blob" in entry && Buffer.byteLength(entry.blob, "base64")
      )
    ).toEqual([CAP])
    await expect(
      apps.fileResource!(scope, { server: "aos-ui" }, ARTIFACT_FILE)
    ).rejects.toEqual(new McpAppFileError("tooLarge"))
    await expect(
      apps.serverResource!(scope, "aos-ui", LARGE_URI)
    ).rejects.toBeInstanceOf(McpAppResourceError)
  })
})

describe("an MCP App view's _meta.ui", () => {
  const view = (declared: DeclaredUi) =>
    fallback({ views: { [VIEW_URI]: declared } })
  const call = {
    html: "<!doctype html><p>Forecast</p>",
    toolInput: { city: "Haifa" },
    toolResult: { content: [{ type: "text", text: "Sunny" }] },
  }

  it("takes the content item's whole, never a field of the listing entry's", async () => {
    const { apps, seen } = view({
      item: { prefersBorder: true },
      listed: FORECAST_UI,
    })

    await expect(apps.open(scope, "call-forecast")).resolves.toEqual({
      ...call,
      prefersBorder: true,
    })
    expect(seen.listResources).toBe(0)
  })

  it("falls back to the listing entry's whole, sanitized alike, listed once", async () => {
    const { apps, seen } = view({ listed: FORECAST_UI })
    const opened = {
      ...call,
      csp: {
        connectDomains: ["https://api.weather.test", "wss://live.weather.test"],
      },
      prefersBorder: false,
    }

    await expect(apps.open(scope, "call-forecast")).resolves.toEqual(opened)
    await expect(apps.open(scope, "call-forecast")).resolves.toEqual(opened)
    expect(seen.listResources).toBe(1)
  })

  it.each(["fails", "hangs"] as const)(
    "opens with neither when the listing %s, and logs it",
    async (listing) => {
      const { apps, logs } = fallback({
        views: { [VIEW_URI]: { listed: FORECAST_UI } },
        listing,
        catalogTimeoutMs: 200,
      })

      await expect(apps.open(scope, "call-forecast")).resolves.toEqual(call)
      expect(logs.records()).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: "mcp_app.resources.list_failed",
          fields: expect.objectContaining({ server: "weather" }),
        })
      )
    }
  )
})

describe("an MCP App view's stable origin", () => {
  const REPORTED = "http://weather.test/mcp"
  /** The tools server's URL, as an operator's override names it. */
  const TOOLS_URL = "http://tools-mcp:4110/mcp"
  const toTools: McpServerOverrides = new Map([["weather", { url: TOOLS_URL }]])
  /** The domain a view of the server dialed at `url` may declare. */
  const stable = (url: string) =>
    `${mcpAppStableOriginKey(url)}.mcp-apps.example`
  const declaring = (uri: string, domain: string) => ({
    [uri]: { item: { domain } },
  })
  type Open = (apps: ReturnType<typeof fallback>["apps"]) => Promise<McpAppView>
  const forecast: Open = (apps) => apps.open(scope, "call-forecast")
  const presented: Open = (apps) => apps.open(scope, "call-artifact")
  const viewer: Open = (apps) => apps.serverView!(scope, "aos-ui", ARTIFACT_URI)

  it.each<[string, Parameters<typeof fallback>[0], Open, string]>([
    [
      "a call's view, keyed to the URL the runtime reports",
      { views: declaring(VIEW_URI, stable(REPORTED)) },
      forecast,
      stable(REPORTED),
    ],
    [
      "a call's view, keyed to the operator's URL it is dialed at instead",
      { servers: toTools, views: declaring(VIEW_URI, stable(TOOLS_URL)) },
      forecast,
      stable(TOOLS_URL),
    ],
    [
      "a call's view, keyed to the canonical form of the URL the runtime reports",
      {
        weatherUrl: "http://Weather.test:80/mcp/",
        views: declaring(VIEW_URI, stable(REPORTED)),
      },
      forecast,
      stable(REPORTED),
    ],
    [
      "the viewer's view, read without a call",
      {
        views: declaring(ARTIFACT_URI, stable("http://aos-ui.test/mcp")),
      },
      viewer,
      stable("http://aos-ui.test/mcp"),
    ],
  ])("keeps the domain of %s", async (_, options, open, domain) => {
    const { apps, logs } = fallback(options)

    await expect(open(apps)).resolves.toMatchObject({ domain })
    expect(logs.records().map(({ message }) => message)).not.toContain(
      "mcp_app.domain.dropped"
    )
  })

  it.each<
    [string, Parameters<typeof fallback>[0], Open, string, DroppedDomain]
  >([
    // An Agent's own server named `aos-ui` claims the tools server's origin.
    [
      "a look-alike aos-ui server's call view",
      { views: declaring(ARTIFACT_URI, stable(TOOLS_URL)) },
      presented,
      "aos_ui",
      { reason: "mismatch", label: mcpAppStableOriginKey(TOOLS_URL) },
    ],
    [
      "a look-alike aos-ui server's viewer",
      { views: declaring(ARTIFACT_URI, stable(TOOLS_URL)) },
      viewer,
      "aos_ui",
      { reason: "mismatch", label: mcpAppStableOriginKey(TOOLS_URL) },
    ],
    [
      "a call's view keyed to the reported URL, dialed at the operator's",
      { servers: toTools, views: declaring(VIEW_URI, stable(REPORTED)) },
      forecast,
      "weather",
      { reason: "mismatch", label: mcpAppStableOriginKey(REPORTED) },
    ],
    [
      "a call's view naming no host",
      {
        views: declaring(VIEW_URI, `https://${stable(REPORTED)}`),
      },
      forecast,
      "weather",
      { reason: "malformed" },
    ],
  ])(
    "drops the domain of %s, logging its server and why alone",
    async (_, options, open, server, why) => {
      const { apps, logs } = fallback(options)

      const opened = await open(apps)

      expect(opened).toMatchObject({ html: "<!doctype html><p>Forecast</p>" })
      expect(opened).not.toHaveProperty("domain")
      expect(
        logs
          .records()
          .filter(({ message }) => message === "mcp_app.domain.dropped")
      ).toEqual([
        {
          level: "warn",
          message: "mcp_app.domain.dropped",
          fields: { server, ...why },
        },
      ])
      expect(JSON.stringify(logs.records())).not.toMatch(/https?:/u)
    }
  )
})

describe("MCP tool name split", () => {
  it("matches the longest server once the server list loads", async () => {
    const names = createMcpToolNames(
      {
        format: (server, tool) => `mcp__${server}__${tool}`,
        prefix: (server) => `mcp__${server}__`,
        candidate: (rawName) => rawName.startsWith("mcp__"),
      },
      async () => [{ name: "a" }, { name: "a__b" }]
    )

    expect(await names.split("agent-1", "mcp__a__b__c")).toEqual({
      server: "a__b",
      tool: "c",
    })
    expect(await names.split("agent-1", "mcp__z__c")).toBeUndefined()
  })
})
