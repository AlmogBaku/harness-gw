import { z } from "zod"

import type { Logger } from "../../../lifecycle"
import type { CallToolResult } from "../../../protocol/mcp-apps"
import { CallToolResultSchema } from "../../../protocol/mcp-apps"
import { createMcpServerCache } from "../../core/mcp-server-cache"
import type {
  ServerMcpApps,
  ServerMcpAppView,
  SessionScope,
} from "../../core/runtime"
import { DESCRIBE_TIMEOUT_MS } from "../../mcp-apps/annotate"
import { logViewOpened } from "../../mcp-apps/audit"
import {
  relayedResource,
  type McpAppClient,
  type McpAppResource,
} from "../../mcp-apps/client"
import { reachableUrl } from "../../mcp-apps/discovery"
import {
  createMcpAppsFallback,
  McpAppNotFoundError,
  McpAppRefusedError,
  McpAppUnsupportedError,
  type McpAppServer,
  type StoredMcpToolCall,
} from "../../mcp-apps/fallback"
import { declaredResourceUri, isUiResourceUri } from "../../mcp-apps/policy"
import {
  createMcpToolNames,
  mcpToolCatalog,
  type McpToolNames,
} from "../../mcp-apps/tool-names"
import { isSessionGone } from "./attachment-registry"
import {
  HermesRpcRejectedError,
  HermesUnavailableError,
  JSON_RPC_METHOD_NOT_FOUND,
  type HermesRpcOptions,
  type HermesRpcTransport,
} from "./gateway"
import { MAX_SOCKET_FRAME_BYTES } from "./gateway-socket"
import { HERMES_MCP_TOOL_NAMES } from "./mcp-tool-names"
import { isRecord, parseJson, trimmedText, unwrappedToolText } from "./native"
import { projectHermesToolCall, unwrapToolCall } from "./tool-data"

/**
 * MCP Apps for Hermes. A Hermes that hosts views itself (`mcp.app.*`,
 * NousResearch/hermes-agent#132426) serves them over its own MCP connection,
 * so a view reaches whatever server the call ran on. An older one answers
 * those methods unknown, and the gateway then reaches a profile's MCP servers
 * itself, only those it can reach without credentials or with headers the
 * operator configured. Names are keyed by profile, which is the Agent id.
 */

/** Hermes' answer to a view whose call has no view, or none committed yet. */
const NO_VIEW = 4064
/** Hermes' answer to a view's call of a tool that is not app-visible. */
const NOT_CALLABLE_BY_VIEW = 4030

/** `mcp.app.view`'s answer (`tui_gateway/contracts/mcp_apps.py`). */
const HermesMcpAppViewSchema = z.object({
  status: z.enum(["result", "cancelled"]),
  arguments: z.record(z.string(), z.unknown()),
  result: CallToolResultSchema.nullish(),
  /** The live MCP `Tool`, whose `_meta.ui.resourceUri` names the view. */
  tool: z.looseObject({ name: z.string() }),
})

/** Whether Hermes has no such method: one older than its own MCP Apps host. */
function isUnknownMethod(error: unknown) {
  return (
    error instanceof HermesRpcRejectedError &&
    error.code === JSON_RPC_METHOD_NOT_FOUND
  )
}

/** One `/api/mcp/servers` entry, reduced to what decides reachability. */
const HermesMcpServerSchema = z.object({
  name: z.string().min(1),
  transport: z.string(),
  url: z.string().nullish(),
  auth: z.unknown(),
  enabled: z.boolean(),
})

const HermesMcpServersSchema = z.object({ servers: z.array(z.unknown()) })

/**
 * A profile's MCP server, and the URL it registers whether or not the gateway
 * may dial it: the one a view's declared domain is judged by.
 */
export type HermesMcpAppServer = McpAppServer & { registered?: string }

/**
 * Every readable entry, dialable when it is on and on Streamable HTTP, and
 * credentialed when it carries `auth` of its own.
 */
export function hermesMcpServers(
  payload: unknown,
  credentialed: (name: string) => boolean = () => false
): HermesMcpAppServer[] {
  const { servers } = HermesMcpServersSchema.parse(payload)
  return servers.flatMap((entry) => {
    const server = HermesMcpServerSchema.safeParse(entry)
    if (!server.success) return []
    const { name, transport, url: listed, auth, enabled } = server.data
    const native = {
      name,
      dialable: enabled && transport === "http",
      url: listed,
      credentials: Boolean(auth),
    }
    const url = reachableUrl(native, credentialed)
    const registered = reachableUrl(
      { ...native, dialable: true, credentials: false },
      () => false
    )
    return [
      { name, ...(url ? { url } : {}), ...(registered ? { registered } : {}) },
    ]
  })
}

/**
 * Rebuilds the `CallToolResult` Hermes stored as handler JSON: `{error}` for a
 * failure, else `result` (text, or the structured content when the text was
 * empty) with optional `structuredContent` and `_meta`.
 */
export function storedHermesToolResult(
  stored: unknown,
  isError: boolean
): CallToolResult | undefined {
  const content = unwrappedToolText(stored)
  const parsed = parseJson(content)
  const text = typeof content === "string" ? content : undefined
  if (!isRecord(parsed))
    return text === undefined
      ? undefined
      : { content: [{ type: "text", text }], ...(isError ? { isError } : {}) }
  if (isError || (typeof parsed.error === "string" && !("result" in parsed)))
    return {
      content: [
        {
          type: "text",
          text: typeof parsed.error === "string" ? parsed.error : (text ?? ""),
        },
      ],
      isError: true,
    }
  const result = parsed.result
  const structuredContent = isRecord(parsed.structuredContent)
    ? parsed.structuredContent
    : isRecord(result)
      ? result
      : undefined
  const candidate = {
    content:
      typeof result === "string" && result
        ? [{ type: "text", text: result }]
        : [],
    ...(structuredContent ? { structuredContent } : {}),
    ...(isRecord(parsed._meta) ? { _meta: parsed._meta } : {}),
  }
  const valid = CallToolResultSchema.safeParse(candidate)
  return valid.success ? valid.data : undefined
}

/**
 * The native name and arguments of the call `toolCallId` names in `rows`, as
 * Hermes stored them. Hermes stores a call's row before the tool runs
 * (`agent/turn_tool_round.py:118`), so a running call is there too.
 */
function nativeToolCall(rows: readonly unknown[], toolCallId: string) {
  let call: { name: string; arguments: unknown } | undefined
  for (const row of rows) {
    if (
      !isRecord(row) ||
      row.role !== "assistant" ||
      !Array.isArray(row.tool_calls)
    )
      continue
    for (const raw of row.tool_calls) {
      const fn = isRecord(raw) && isRecord(raw.function) ? raw.function : {}
      const name = trimmedText(fn.name)
      if (isRecord(raw) && trimmedText(raw.id) === toolCallId && name)
        call = { name, arguments: fn.arguments }
    }
  }
  return call
}

/** The call only if this Session's own rows hold it. */
function storedCall(
  rows: readonly unknown[],
  toolCallId: string,
  resolve: ReturnType<McpToolNames["resolver"]>
): StoredMcpToolCall | undefined {
  const call = nativeToolCall(rows, toolCallId)
  if (!call) return undefined
  let result: CallToolResult | undefined
  for (const row of rows)
    if (
      isRecord(row) &&
      row.role === "tool" &&
      trimmedText(row.tool_call_id ?? row.toolCallId) === toolCallId
    )
      result = storedHermesToolResult(
        row.content ?? row.result,
        row.is_error === true
      )
  // The view receives the arguments the browser already reads, redacted.
  const projected = projectHermesToolCall(call.name, call.arguments, resolve)
  return {
    toolName: projected.toolName,
    input: isRecord(projected.args) ? projected.args : {},
    ...(result ? { result } : {}),
  }
}

export type HermesMcpApps = { mcpApps: ServerMcpApps; names: McpToolNames }

/** The socket a view's `mcp.app.*` travel, on its Session's live binding. */
export type HermesMcpAppHost = {
  transport: Pick<HermesRpcTransport, "request" | "subscribeConnection">
  /** The live Session the durable one is bound to on this socket. */
  live(scope: SessionScope): Promise<string>
  /** The live Session it is bound to now, never resuming one. */
  bound(scope: SessionScope): string | undefined
  /** Hermes no longer holds that live Session: the next `live` binds anew. */
  invalidate(liveSessionId: string): void
}

/** A view Hermes read for the gateway from `server`, as a view opens. */
type RelayedView = (
  scope: SessionScope,
  server: string | undefined,
  value: unknown,
  uri: string
) => Promise<McpAppResource>

export function createHermesMcpApps(input: {
  servers: (profile: string) => Promise<unknown>
  rawHistory: (scope: SessionScope) => Promise<readonly unknown[]>
  /** The first answer `find` gives, reading the Session's raw rows page by page. */
  scanHistory<T>(
    scope: SessionScope,
    find: (rows: readonly unknown[]) => T | undefined
  ): Promise<T | undefined>
  client: McpAppClient
  logger: Logger
  host: HermesMcpAppHost
}): HermesMcpApps {
  const servers = createMcpServerCache<HermesMcpAppServer>(async (profile) =>
    hermesMcpServers(await input.servers(profile), input.client.credentialed)
  )
  const names = createMcpToolNames(
    HERMES_MCP_TOOL_NAMES,
    mcpToolCatalog(servers, input.client)
  )
  const fallback = createMcpAppsFallback(
    {
      servers: (scope) => servers.get(scope.agentId),
      async storedCall(scope, toolCallId) {
        const rows = await input.rawHistory(scope)
        const resolve = await names.load(scope.agentId)
        return storedCall(rows, toolCallId, resolve)
      },
    },
    input.client,
    input.logger
  )
  const gateway: ServerMcpApps = {
    ...fallback,
    // The raw row's own arguments, never the projection the browser reads. A
    // tool-search `tool_call` envelope, which defers MCP tools
    // (`tools/tool_search.py:162`), stands for the one tool it selected.
    async toolCall(scope, toolCallId) {
      const call = await input.scanHistory(scope, (rows) =>
        nativeToolCall(rows, toolCallId)
      )
      const args = call && parseJson(call.arguments)
      if (!call || !isRecord(args)) return undefined
      const tool = unwrapToolCall(call.name, args)
      const split = await names.split(scope.agentId, tool.name)
      return split && { ...split, input: tool.args }
    },
  }
  // Its domain judged as the gateway's own read is, by the URL the profile
  // registers for the server.
  const relayedView: RelayedView = async (scope, server, value, uri) => {
    const listed = await servers.get(scope.agentId).catch(() => [])
    const registered = listed.find(({ name }) => name === server)?.registered
    return input.client.relayedAppResource(
      server === undefined ? undefined : { name: server, url: registered },
      value,
      uri
    )
  }
  return {
    mcpApps: hermesHostedMcpApps(
      input.host,
      gateway,
      relayedView,
      input.logger
    ),
    names,
  }
}

/**
 * Views as Hermes hosts them, over its own MCP connection, on a socket whose
 * Hermes does; on one whose Hermes answers `mcp.app.*` unknown, as `gateway`
 * hosts them. Each new connection may reach another Hermes, so it asks again.
 * Every other operation is the gateway's.
 */
function hermesHostedMcpApps(
  host: HermesMcpAppHost,
  gateway: ServerMcpApps,
  relayedView: RelayedView,
  logger: Logger
): ServerMcpApps {
  let hostless = false
  const askAgain = () => {
    hostless = false
  }
  host.transport.subscribeConnection?.({
    restored: askAgain,
    epochChanged: askAgain,
  })

  /** Hermes' own host first; the gateway's, on a socket whose Hermes has none. */
  async function hosted<T>(native: () => Promise<T>, own: () => Promise<T>) {
    if (!hostless)
      try {
        return await native()
      } catch (error) {
        if (!isUnknownMethod(error)) throw error
        hostless = true
        logger.info({}, "hermes.mcp_apps.gateway_hosted")
      }
    return own()
  }

  /**
   * One `mcp.app.*` of the call's view, on its Session's live binding. A live
   * Session Hermes no longer holds refused it before running anything, so the
   * binding is renewed and the request sent once more.
   */
  async function request(
    scope: SessionScope,
    toolCallId: string,
    method: string,
    params: Record<string, unknown>,
    options?: HermesRpcOptions
  ) {
    for (let attempt = 0; ; attempt += 1) {
      const liveSessionId = await host.live(scope)
      try {
        return await host.transport.request(
          method,
          { session_id: liveSessionId, tool_call_id: toolCallId, ...params },
          options
        )
      } catch (error) {
        if (error instanceof HermesRpcRejectedError && error.code === NO_VIEW)
          throw new McpAppNotFoundError()
        if (
          error instanceof HermesRpcRejectedError &&
          error.code === NOT_CALLABLE_BY_VIEW
        )
          throw new McpAppRefusedError()
        if (!isSessionGone(error)) throw error
        host.invalidate(liveSessionId)
        if (attempt > 0) throw new HermesUnavailableError({ cause: error })
      }
    }
  }

  /** One `resources/read` on the call's server, held to the gateway's cap. */
  const read = async (
    scope: SessionScope,
    toolCallId: string,
    uri: string,
    signal?: AbortSignal
  ) =>
    request(
      scope,
      toolCallId,
      "mcp.app.read_resource",
      { uri },
      { signal, maxResponseBytes: MAX_SOCKET_FRAME_BYTES }
    )

  return {
    ...gateway,
    // Hermes holds a call's view once it commits the call's row, result and
    // all, and the history that reads the row flags a stored view itself. A
    // running call has none yet: `withMcpApps` asks again once its result
    // arrives, so the view opens on a call Hermes can answer for. A Session
    // nobody holds live is not attached just to ask about one of its calls.
    describe: (scope, call) =>
      hosted(
        async () => {
          if (call.result === undefined) return false
          const liveSessionId = host.bound(scope)
          if (liveSessionId === undefined) return gateway.describe(scope, call)
          try {
            await host.transport.request(
              "mcp.app.view",
              { session_id: liveSessionId, tool_call_id: call.toolCallId },
              { timeoutMs: DESCRIBE_TIMEOUT_MS }
            )
            return true
          } catch (error) {
            if (isUnknownMethod(error)) throw error
            // A live Session Hermes no longer holds is bound anew by whoever
            // needs it next; the gateway's own answer stands meanwhile.
            if (isSessionGone(error)) {
              host.invalidate(liveSessionId)
              return gateway.describe(scope, call)
            }
            if (
              !(error instanceof HermesRpcRejectedError) ||
              error.code !== NO_VIEW
            )
              logger.warn(
                { toolCallId: call.toolCallId },
                "hermes.mcp_apps.describe_failed"
              )
            return false
          }
        },
        () => gateway.describe(scope, call)
      ),
    open: (scope, toolCallId, signal) =>
      hosted<ServerMcpAppView>(
        async () => {
          const [answer, call] = await Promise.all([
            request(scope, toolCallId, "mcp.app.view", {}, { signal }),
            gateway.toolCall?.(scope, toolCallId).catch(() => undefined),
          ])
          const view = HermesMcpAppViewSchema.parse(answer)
          const uri = declaredResourceUri(view.tool)
          if (!uri) throw new McpAppNotFoundError()
          const resource = await relayedView(
            scope,
            call?.server,
            await read(scope, toolCallId, uri, signal),
            uri
          )
          logViewOpened(logger, scope, {
            toolCallId,
            ...(call ? { server: call.server } : {}),
            tool: call?.tool ?? view.tool.name,
            ...(resource.csp ? { csp: resource.csp } : {}),
          })
          return {
            ...resource,
            toolInput: view.arguments,
            ...(view.result ? { toolResult: view.result } : {}),
          }
        },
        () => gateway.open(scope, toolCallId, signal)
      ),
    callTool: (scope, toolCallId, name, args) =>
      hosted(
        async () =>
          CallToolResultSchema.parse(
            await request(scope, toolCallId, "mcp.app.call_tool", {
              name,
              arguments: args,
            })
          ),
        () => gateway.callTool(scope, toolCallId, name, args)
      ),
    readResource: (scope, toolCallId, uri) =>
      hosted(
        async () => {
          // A view reads only its own server's views, as the gateway's own host.
          if (!isUiResourceUri(uri)) throw new McpAppRefusedError()
          return relayedResource(await read(scope, toolCallId, uri))
        },
        () => gateway.readResource(scope, toolCallId, uri)
      ),
    updateModelContext: (scope, toolCallId, { content, structuredContent }) =>
      hosted(
        async () => {
          await request(scope, toolCallId, "mcp.app.update_model_context", {
            ...(content ? { content } : {}),
            ...(structuredContent
              ? { structured_content: structuredContent }
              : {}),
          })
        },
        // An older Hermes takes no prompt context its transcript leaves out.
        () => Promise.reject(new McpAppUnsupportedError())
      ),
  }
}
