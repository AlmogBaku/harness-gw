import {
  Client,
  ProtocolError,
  StreamableHTTPClientTransport,
  type Resource,
  type Tool,
} from "@modelcontextprotocol/client"

import {
  CallToolResultSchema,
  MAX_MCP_APP_FILE_BYTES,
  McpAppFileReadErrorDataSchema,
  ReadResourceResultSchema,
  type CallToolResult,
  type McpAppFileReadFailure,
  type McpAppView,
  type ReadResourceResult,
} from "../../protocol/mcp-apps"
import type { Logger } from "../../lifecycle"
import { isHttpsOrLoopback } from "../config"
import { createMcpServerCache } from "../core/mcp-server-cache"
import {
  judgedDomain,
  MCP_APP_MIME_TYPE,
  sanitizeUiMeta,
  type DeclaredUiMeta,
  type McpUiMeta,
} from "./policy"

/** The largest UI resource a view is served from. */
export const MAX_MCP_APP_HTML_BYTES = 2 * 1024 * 1024
/** How many pages one `tools/list` or `resources/list` may take. */
const MAX_LIST_PAGES = 20
const IDLE_CLOSE_MS = 5 * 60_000
/**
 * How long a connect or one `tools/list` or `resources/list` page may take. A
 * history read waits on the tool listing, so a server that does not answer
 * resolves by its prefix instead, and a view opens without the resource
 * listing; an App's own tool call and resource read keep the SDK's longer
 * default, since a person watches that work.
 */
export const MCP_CATALOG_TIMEOUT_MS = 3_000

/**
 * A view's resource, validated: its HTML and the `_meta.ui` it declared, with
 * `domain` only as its own server's stable origin.
 */
export type McpAppResource = Pick<McpAppView, "html"> & McpUiMeta

/** One MCP server: the name the runtime reports for it, and its Streamable HTTP URL. */
export type McpAppEndpoint = { name: string; url: string }

/**
 * What the operator configured for one MCP server: a `url` the gateway connects
 * to instead of the one the runtime reports, and request headers that replace
 * whatever credentials the runtime holds.
 */
export type McpServerOverride = {
  url?: string
  headers?: Readonly<Record<string, string>>
}

/** Operator overrides keyed by the server name the runtime reports. */
export type McpServerOverrides = ReadonlyMap<string, McpServerOverride>

/** The gateway's own MCP client, one pooled connection per server and URL. */
export type McpAppClient = {
  /** Whether the operator configured headers for this server name. */
  credentialed(server: string): boolean
  /** `tools/list`, cached per server. */
  tools(server: McpAppEndpoint): Promise<readonly Tool[]>
  /** `tools/list` after a lookup miss, refetched at most once per window. */
  refreshTools(server: McpAppEndpoint): Promise<readonly Tool[]>
  /**
   * An App's UI resource as every view opens it: `_meta.ui` from its content
   * item, else from its listing entry, with `domain` only as the dialed
   * server's own; anything but `text/html;profile=mcp-app` is refused.
   */
  appResource(server: McpAppEndpoint, uri: string): Promise<McpAppResource>
  /** One `resources/read`, as the server answered it. */
  readResource(server: McpAppEndpoint, uri: string): Promise<ReadResourceResult>
  /**
   * A view's read of its own file address, as the server answered it: up to
   * `MAX_MCP_APP_FILE_BYTES` of decoded content. It fails as
   * `McpAppFileError`, with the reason the server's JSON-RPC error gave in its
   * `data`, `tooLarge` past the cap, and `unavailable` for any other failure.
   */
  readFile(server: McpAppEndpoint, uri: string): Promise<ReadResourceResult>
  callTool(
    server: McpAppEndpoint,
    name: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult>
  close(): Promise<void>
}

export class McpAppResourceError extends Error {
  constructor(reason: string) {
    super(`MCP App resource refused: ${reason}`)
    this.name = "McpAppResourceError"
  }
}

/** A view's read of its own file address failed, for the reason it names. */
export class McpAppFileError extends Error {
  constructor(readonly reason: McpAppFileReadFailure) {
    super(`MCP App file read failed: ${reason}`)
    this.name = "McpAppFileError"
  }
}

/**
 * The bytes a read answers, against its cap: each text item's UTF-8, and each
 * blob's base64 characters, or the bytes they decode to for a file.
 */
const bytesOf = (
  { contents }: ReadResourceResult,
  blob: "characters" | "decoded"
) =>
  contents.reduce(
    (total, entry) =>
      total +
      ("text" in entry
        ? Buffer.byteLength(entry.text)
        : blob === "decoded"
          ? Buffer.byteLength(entry.blob, "base64")
          : entry.blob.length),
    0
  )

/**
 * The App view `uri` names in a `resources/read` result: its HTML and its
 * content item's `_meta.ui`, as declared. Anything but
 * `text/html;profile=mcp-app` is refused.
 */
function appContentOf({ contents }: ReadResourceResult, uri: string) {
  const entry = contents.find((candidate) => candidate.uri === uri)
  if (!entry || entry.mimeType !== MCP_APP_MIME_TYPE)
    throw new McpAppResourceError("mime type")
  const html =
    "text" in entry
      ? entry.text
      : Buffer.from(entry.blob, "base64").toString("utf8")
  return { html, ui: entry._meta?.ui }
}

/** Configured headers never travel in the clear beyond this machine. */
export class McpAppConnectionRefusedError extends Error {
  constructor() {
    super("MCP server connection refused: credentials need HTTPS or loopback")
    this.name = "McpAppConnectionRefusedError"
  }
}

type Pooled = { client: Promise<Client>; timer?: ReturnType<typeof setTimeout> }

/** A server's pool and cache key: its name picks the headers, so both count. */
const keyOf = ({ name, url }: McpAppEndpoint) => JSON.stringify([name, url])

function endpointOf(key: string): McpAppEndpoint {
  const [name, url] = JSON.parse(key) as [string, string]
  return { name, url }
}

export function createMcpAppClient(
  options: {
    fetch?: typeof fetch
    servers?: McpServerOverrides
    logger?: Logger
    /** How long a connect or one list page may take. */
    catalogTimeoutMs?: number
    /** The most file content one file read answers. */
    maxFileBytes?: number
  } = {}
): McpAppClient {
  const { logger, maxFileBytes = MAX_MCP_APP_FILE_BYTES } = options
  const catalogRequest = {
    timeout: options.catalogTimeoutMs ?? MCP_CATALOG_TIMEOUT_MS,
  }
  const overrides: McpServerOverrides = options.servers ?? new Map()
  const pool = new Map<string, Pooled>()

  function drop(key: string, pooled: Pooled) {
    if (pool.get(key) !== pooled) return
    pool.delete(key)
    clearTimeout(pooled.timer)
    pooled.client
      .then((client) => client.close())
      .catch((err: unknown) =>
        logger?.warn({ err }, "mcp_app.client.close_failed")
      )
  }

  /** The URL a server is dialed at: the operator's, else the runtime's. */
  const dialedUrl = ({ name, url }: McpAppEndpoint) =>
    overrides.get(name)?.url ?? url

  async function open(server: McpAppEndpoint) {
    const target = new URL(dialedUrl(server))
    const headers = overrides.get(server.name)?.headers
    if (headers && !isHttpsOrLoopback(target))
      throw new McpAppConnectionRefusedError()
    const client = new Client(
      { name: "harness-gw", version: "1.0.0" },
      { listMaxPages: MAX_LIST_PAGES }
    )
    await client.connect(
      new StreamableHTTPClientTransport(target, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(headers ? { requestInit: { headers: { ...headers } } } : {}),
      }),
      catalogRequest
    )
    return client
  }

  function connect(server: McpAppEndpoint): Promise<Client> {
    const key = keyOf(server)
    const existing = pool.get(key)
    const pooled: Pooled = existing ?? { client: open(server) }
    if (!existing) {
      pool.set(key, pooled)
      pooled.client.catch(() => drop(key, pooled))
    }
    clearTimeout(pooled.timer)
    pooled.timer = setTimeout(() => drop(key, pooled), IDLE_CLOSE_MS)
    pooled.timer.unref?.()
    return pooled.client
  }

  /** One request; a failed connection is dropped so the next call reconnects. */
  async function request<T>(
    server: McpAppEndpoint,
    run: (client: Client) => Promise<T>
  ) {
    const client = await connect(server)
    try {
      return await run(client)
    } catch (error) {
      // A JSON-RPC error is the server answering; a timeout or anything else
      // is the link.
      const key = keyOf(server)
      const pooled = pool.get(key)
      const answered = error instanceof ProtocolError
      if (pooled && !answered) drop(key, pooled)
      throw error
    }
  }

  /** Every page of one server's list; a failure warns once per fetch. */
  async function listAll<T>(
    key: string,
    failed: "mcp_app.tools.list_failed" | "mcp_app.resources.list_failed",
    list: (client: Client) => Promise<readonly T[]>
  ) {
    const server = endpointOf(key)
    const started = performance.now()
    try {
      return await request(server, list)
    } catch (err) {
      logger?.warn(
        {
          err,
          server: server.name,
          elapsedMs: Math.round(performance.now() - started),
        },
        failed
      )
      throw err
    }
  }

  const toolCache = createMcpServerCache<Tool>((key) =>
    listAll(
      key,
      "mcp_app.tools.list_failed",
      async (client) =>
        (await client.listTools(undefined, catalogRequest)).tools
    )
  )
  const resourceCache = createMcpServerCache<Resource>((key) =>
    listAll(
      key,
      "mcp_app.resources.list_failed",
      async (client) =>
        (await client.listResources(undefined, catalogRequest)).resources
    )
  )

  /**
   * The `_meta.ui` a server's `resources/list` entry for `uri` declares. A
   * listing that fails or times out has none, so the view still opens.
   */
  async function listedUi(server: McpAppEndpoint, uri: string) {
    try {
      const resources = await resourceCache.get(keyOf(server))
      return resources.find((resource) => resource.uri === uri)?._meta?.ui
    } catch {
      return undefined
    }
  }

  /**
   * `meta` with its `domain` only when that is the dialed server's own stable
   * origin. One dropped is logged by the server's name and why, with the label
   * a well-formed one declared, never by a URL.
   */
  function verified(
    server: McpAppEndpoint,
    { domain, ...meta }: DeclaredUiMeta
  ): McpUiMeta {
    if (domain === undefined) return meta
    const judged = judgedDomain(domain, dialedUrl(server))
    if ("domain" in judged) return { ...meta, ...judged }
    logger?.warn({ server: server.name, ...judged }, "mcp_app.domain.dropped")
    return meta
  }

  const read = async (server: McpAppEndpoint, uri: string) =>
    ReadResourceResultSchema.parse(
      await request(server, (client) => client.readResource({ uri }))
    )

  async function readResource(server: McpAppEndpoint, uri: string) {
    const result = await read(server, uri)
    if (bytesOf(result, "characters") > MAX_MCP_APP_HTML_BYTES)
      throw new McpAppResourceError("size")
    return result
  }

  async function readFile(server: McpAppEndpoint, uri: string) {
    let result: ReadResourceResult
    try {
      result = await read(server, uri)
    } catch (error) {
      const reason = McpAppFileReadErrorDataSchema.safeParse(
        error instanceof ProtocolError ? error.data : undefined
      ).data?.reason
      throw new McpAppFileError(reason ?? "unavailable")
    }
    if (bytesOf(result, "decoded") > maxFileBytes)
      throw new McpAppFileError("tooLarge")
    return result
  }

  return {
    credentialed: (server) => overrides.get(server)?.headers !== undefined,
    tools: (server) => toolCache.get(keyOf(server)),
    refreshTools: (server) => toolCache.refresh(keyOf(server)),
    readResource,
    readFile,
    // The draft spec: "Hosts MUST check both locations, preferring the
    // content item and falling back to the listing entry", each taken whole.
    async appResource(server, uri) {
      const { html, ui } = appContentOf(await readResource(server, uri), uri)
      const meta =
        sanitizeUiMeta(ui) ?? sanitizeUiMeta(await listedUi(server, uri)) ?? {}
      return { html, ...verified(server, meta) }
    },
    async callTool(server, name, args) {
      return CallToolResultSchema.parse(
        await request(server, (client) =>
          client.callTool({ name, arguments: args })
        )
      )
    },
    async close() {
      for (const [key, pooled] of [...pool]) drop(key, pooled)
    },
  }
}
