import {
  CallToolResultSchema,
  McpAppResourceReadRequestSchema,
  McpAppToolCallRequestSchema,
  McpAppViewSchema,
  ReadResourceResultSchema,
  viewerFileResult,
  type McpAppFileReadFailure,
  type McpAppView,
} from "../../protocol/mcp-apps"
import type { GatewayAppOptions } from "../app"
import { coreFailure } from "../core/failures"
import * as ids from "../core/ids"
import type { ServerMcpApps, ServerRuntime } from "../core/runtime"
import { McpAppFileError, McpAppResourceError } from "../mcp-apps/client"
import { McpAppNotFoundError, McpAppRefusedError } from "../mcp-apps/fallback"
import { isUiResourceUri } from "../mcp-apps/policy"
import { maskJson } from "../redaction"
import {
  answerAppFile,
  appFiles,
  artifactFiles,
  isOwnFileAddress,
  offerAppFiles,
  subjectId,
  type AppFileContext,
  type AppFileGrant,
  type AppSubject,
  type AppTarget,
} from "./app-files"
import {
  createFileReadQueue,
  heldBody,
  OPERATOR_FILE_READS,
  type FileReadTurn,
} from "./file-reads"
import { boundedJson, errorResponse } from "./http"
import type { GatewayRouteApp } from "./types"

/**
 * MCP App views, keyed by the tool call that opened them. The browser names no
 * server, tool, or resource URI to open a view; a view's own requests reach
 * only the server its tool call came from. A published Artifact opens in the
 * configured viewer instead, with no tool call: its view reads only the
 * viewer server's `ui://` resources and calls no tool. Either view may also
 * read its own file addresses through its server, which reads them back from
 * the file route.
 */

const MCP_APP_PATH = "/tool-calls/:toolCallId/app"
const ARTIFACT_APP_PATH = "/artifacts/:artifactId/app"
const MAX_REQUEST_BYTES = 256 * 1024
const RATE_WINDOW_MS = 1_000
const RATE_MAX_PER_WINDOW = 10
const RATE_MAX_TRACKED = 4_096
/** The type a streamed answer carries, as `context.json`'s does. */
export const JSON_TYPE = { "content-type": "application/json" }

/**
 * A view as a browser may read it, for every runtime and both listeners: the
 * call's input and result masked as tool data is, after the files the view
 * may read are worked out from the call itself.
 */
function maskedView(view: McpAppView) {
  return McpAppViewSchema.parse({
    ...view,
    toolInput: maskJson(view.toolInput),
    toolResult: maskJson(view.toolResult),
  })
}

export type McpAppOperation = "open" | "tools/call" | "resources/read" | "files"

export type McpAppOutcome =
  | { ok: true; body: unknown }
  /** A forwarded file read's JSON, written within its turn. */
  | { ok: true; stream: ReadableStream<Uint8Array> }
  | {
      ok: false
      reason:
        | "not_found"
        | "forbidden"
        | "invalid_request"
        | "rate_limited"
        | "temporarily_unavailable"
      status: 400 | 403 | 404 | 429 | 503
      /**
       * Why a read of a view's own file address failed; no other failure
       * names one.
       */
      fileReason?: McpAppFileReadFailure
    }

const failure = {
  not_found: { ok: false, reason: "not_found", status: 404 },
  forbidden: { ok: false, reason: "forbidden", status: 403 },
  invalid_request: { ok: false, reason: "invalid_request", status: 400 },
  rate_limited: { ok: false, reason: "rate_limited", status: 429 },
  unavailable: { ok: false, reason: "temporarily_unavailable", status: 503 },
} as const satisfies Record<string, McpAppOutcome>

/**
 * A failed read of a view's own file address, with its reason: refused when
 * asking again cannot help, unavailable when it may.
 */
const fileFailure = (fileReason: McpAppFileReadFailure): McpAppOutcome => ({
  ...(fileReason === "denied" || fileReason === "tooLarge"
    ? failure.forbidden
    : failure.unavailable),
  fileReason,
})

/**
 * A view's read of its own file address, forwarded to the server that owns
 * the view within a turn on the listener, since each holds its whole file:
 * the read, its parse and its answer's write all happen within the turn,
 * which the written body gives back. A read whose request ends stops, and
 * writes nothing. Every failure names its reason: the server's, the cap's,
 * `unreachable` for a read that found no turn, outlasted it, or outlasted
 * its request, or `unavailable` where the runtime cannot forward it or the
 * read fails short of an answer.
 */
async function readOwnFile(
  { scope, request, fileReads }: McpAppInput,
  apps: ServerMcpApps,
  owner: { toolCallId: string } | { server: string },
  uri: string
): Promise<McpAppOutcome> {
  const fileResource = apps.fileResource?.bind(apps)
  if (!fileResource) return fileFailure("unavailable")
  let turn: FileReadTurn
  try {
    turn = await fileReads(request.signal)
  } catch {
    return fileFailure("unreachable")
  }
  const signal = AbortSignal.any([request.signal, turn.signal])
  try {
    const result = ReadResourceResultSchema.parse(
      await fileResource(scope, owner, uri, signal)
    )
    signal.throwIfAborted()
    const json = new TextEncoder().encode(JSON.stringify(result))
    return { ok: true, stream: heldBody(json, turn) }
  } catch (error) {
    turn.release()
    // A read its request or its turn ended found no time to answer in.
    return fileFailure(
      signal.aborted
        ? "unreachable"
        : error instanceof McpAppFileError
          ? error.reason
          : "unavailable"
    )
  }
}

/** A fixed window per view, so one chatty view cannot flood its server. */
function createMcpAppRateLimit(
  now: () => number = Date.now,
  max = RATE_MAX_PER_WINDOW
) {
  const windows = new Map<string, { start: number; count: number }>()
  return (target: AppTarget) => {
    const subject =
      "toolCallId" in target
        ? `call\u0000${target.toolCallId}`
        : `artifact\u0000${target.artifactId}`
    const key = `${target.agentId}\u0000${target.sessionId}\u0000${subject}`
    const at = now()
    const current = windows.get(key)
    if (!current || at - current.start >= RATE_WINDOW_MS) {
      if (windows.size >= RATE_MAX_TRACKED) windows.clear()
      windows.set(key, { start: at, count: 1 })
      return true
    }
    current.count += 1
    return current.count <= max
  }
}

/**
 * One listener's limits, by operation: a view's file reads and renewals have
 * their own window, so neither they nor the view's other requests starve the
 * other.
 */
export function createMcpAppLimits(now?: () => number, fileRate?: number) {
  const view = createMcpAppRateLimit(now)
  const files = createMcpAppRateLimit(now, fileRate)
  return (operation: McpAppOperation) => (operation === "files" ? files : view)
}

type McpAppInput = AppFileContext & {
  operation: McpAppOperation
  allow: (target: AppTarget) => boolean
  /** A forwarded file read's turn on this listener, while `signal` holds. */
  fileReads: (signal: AbortSignal) => Promise<FileReadTurn>
}

/**
 * One request of an Artifact's view. `open` and `files` read the Artifact
 * first, so one the Session lacks answers 404, as its content route does.
 * `open` verifies the viewer's view as a call's is; the view's own reads reach
 * only the viewer's server, as it answers them. An Artifact that is there with
 * no viewer to open it in (a listener serving no files, a runtime that reads
 * no server's resource without a call, or a viewer out of reach) answers 503,
 * so the browser never mistakes it for a pruned one.
 */
async function handleArtifactRequest(
  input: McpAppInput,
  apps: ServerMcpApps,
  subject: Extract<AppSubject, { artifactId: string }>
): Promise<McpAppOutcome> {
  const { scope, operation, request, files } = input
  if (operation === "tools/call") return failure.not_found
  const artifact = await subject.read(scope)
  const serverView = apps.serverView?.bind(apps)
  const serverResource = apps.serverResource?.bind(apps)
  if (!files || !serverView || !serverResource) return failure.unavailable
  const { viewer } = files.options
  if (operation === "resources/read") {
    const body = McpAppResourceReadRequestSchema.safeParse(
      await boundedJson(request, MAX_REQUEST_BYTES)
    )
    if (!body.success) return failure.invalid_request
    if (isOwnFileAddress(input, body.data.uri))
      return readOwnFile(input, apps, { server: viewer.server }, body.data.uri)
    // The viewer reads only its own server's views, whatever the adapter allows.
    if (!isUiResourceUri(body.data.uri)) return failure.forbidden
    return {
      ok: true,
      body: ReadResourceResultSchema.parse(
        await serverResource(
          scope,
          viewer.server,
          body.data.uri,
          request.signal
        )
      ),
    }
  }
  if (operation === "files")
    return { ok: true, body: await artifactFiles(input, files) }
  let view: McpAppView
  try {
    view = await serverView(
      scope,
      viewer.server,
      viewer.resource,
      request.signal
    )
  } catch (error) {
    if (
      error instanceof McpAppNotFoundError ||
      error instanceof McpAppResourceError
    )
      return failure.unavailable
    throw error
  }
  return {
    ok: true,
    body: McpAppViewSchema.parse({
      ...view,
      toolInput: {},
      toolResult: viewerFileResult(artifact),
      files: await artifactFiles(input, files),
    }),
  }
}

/**
 * One MCP App request, listener-neutral. The caller has already authorized the
 * Session and resolved `scope`; this reads the body, applies the view's rate
 * limit, and maps every failure to an answer that never names a native detail.
 */
export async function handleMcpAppRequest(
  input: McpAppInput
): Promise<McpAppOutcome> {
  const { runtime, scope, subject, operation, request } = input
  const apps = runtime.mcpApps
  if (!apps) return failure.not_found
  if (
    !input.allow({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      ...subjectId(subject),
    })
  )
    return failure.rate_limited
  try {
    if ("read" in subject)
      return await handleArtifactRequest(input, apps, subject)
    const { toolCallId } = subject
    if (operation === "open")
      return {
        ok: true,
        body: maskedView(
          await offerAppFiles(
            McpAppViewSchema.parse(
              await apps.open(scope, toolCallId, request.signal)
            ),
            input,
            toolCallId
          )
        ),
      }
    if (operation === "files") {
      const grant = input.files
      const call =
        grant &&
        (await grant.options.calls.lookup(
          apps,
          scope,
          toolCallId,
          request.signal
        ))
      return grant && call
        ? { ok: true, body: await appFiles(input, grant, call) }
        : failure.not_found
    }
    const json = await boundedJson(request, MAX_REQUEST_BYTES)
    if (operation === "tools/call") {
      const body = McpAppToolCallRequestSchema.safeParse(json)
      if (!body.success) return failure.invalid_request
      return {
        ok: true,
        body: CallToolResultSchema.parse(
          await apps.callTool(
            scope,
            toolCallId,
            body.data.name,
            body.data.arguments
          )
        ),
      }
    }
    const body = McpAppResourceReadRequestSchema.safeParse(json)
    if (!body.success) return failure.invalid_request
    if (isOwnFileAddress(input, body.data.uri))
      return await readOwnFile(input, apps, { toolCallId }, body.data.uri)
    return {
      ok: true,
      body: ReadResourceResultSchema.parse(
        await apps.readResource(scope, toolCallId, body.data.uri)
      ),
    }
  } catch (error) {
    if (
      error instanceof McpAppNotFoundError ||
      error instanceof McpAppResourceError ||
      (coreFailure(error) ?? runtime.publicError(error))?.kind === "gone"
    )
      return failure.not_found
    if (error instanceof McpAppRefusedError) return failure.forbidden
    return failure.unavailable
  }
}

/** The Agent, Session, and subject every MCP App route carries in its path. */
export function mcpAppParams(
  params: Record<string, string | undefined>
): AppTarget | undefined {
  const { agentId, sessionId, toolCallId, artifactId } = params
  if (!agentId || !sessionId) return undefined
  if (toolCallId) return { agentId, sessionId, toolCallId }
  return artifactId ? { agentId, sessionId, artifactId } : undefined
}

type McpAppRoute = [method: "get" | "post", path: string, McpAppOperation]

/**
 * One listener's MCP App routes under its Session path: a tool call's view
 * and a published Artifact's view. Only a tool call's view calls tools;
 * `filePaths` are where each view reads a file, on a listener serving files.
 */
export function mcpAppRoutes(
  sessionPath: string,
  servesFiles: boolean
): { routes: McpAppRoute[]; filePaths: string[] } {
  const call = `${sessionPath}${MCP_APP_PATH}`
  const bases = [call, `${sessionPath}${ARTIFACT_APP_PATH}`]
  return {
    routes: [
      ["post", `${call}/tools/call`, "tools/call"],
      ...bases.flatMap((base): McpAppRoute[] => [
        ["get", base, "open"],
        ["post", `${base}/resources/read`, "resources/read"],
        ...(servesFiles
          ? [["post", `${base}/files`, "files"] satisfies McpAppRoute]
          : []),
      ]),
    ],
    filePaths: servesFiles
      ? bases.map((base) => `${base}/files/:argument`)
      : [],
  }
}

export function registerMcpAppRoutes(
  app: GatewayRouteApp,
  options: GatewayAppOptions,
  requireRuntime: (request: Request) => Promise<ServerRuntime>,
  requireScopedSession: (
    runtime: ServerRuntime,
    agentId: string,
    sessionId: string
  ) => Promise<ids.ProviderSessionId>
) {
  const limit = createMcpAppLimits(options.clock, options.files?.ratePerSecond)
  const fileReads = createFileReadQueue(OPERATOR_FILE_READS)
  const files: AppFileGrant | undefined = options.files && {
    options: options.files,
    role: "operator",
    root: "/api/v1",
    sets: [options.files.operator],
    requiresRealPath: false,
  }
  const { routes, filePaths } = mcpAppRoutes(
    "/api/v1/agents/:agentId/sessions/:sessionId",
    Boolean(files)
  )
  /** The subject a path names; an Artifact reads as the content route reads it. */
  const subjectOf = (runtime: ServerRuntime, target: AppTarget): AppSubject =>
    "toolCallId" in target
      ? { toolCallId: target.toolCallId }
      : {
          artifactId: target.artifactId,
          read: (scope) =>
            runtime.artifact(scope.agentId, scope.sessionId, target.artifactId),
        }
  if (files)
    for (const path of filePaths)
      app.get(path, async (context) => {
        const runtime = await requireRuntime(context.req.raw)
        const target = mcpAppParams(context.req.param())
        const argument = context.req.param("argument")
        if (!target || !argument) return errorResponse("not_found", 404)
        const { agentId, sessionId } = target
        return answerAppFile({
          request: context.req.raw,
          runtime,
          grant: files,
          target: { agentId, sessionId },
          subject: () => subjectOf(runtime, target),
          argument,
          allow: limit("files"),
          // The operator listener has no login of its own.
          login: async () => true,
          scope: async () => ({
            agentId,
            providerSessionId: await requireScopedSession(
              runtime,
              agentId,
              sessionId
            ),
            sessionId: ids.sessionId(sessionId),
          }),
        })
      })
  for (const [method, path, operation] of routes)
    app[method](path, async (context) => {
      const runtime = await requireRuntime(context.req.raw)
      const target = mcpAppParams(context.req.param())
      if (!target) return errorResponse("not_found", 404)
      const { agentId, sessionId } = target
      const providerSessionId = await requireScopedSession(
        runtime,
        agentId,
        sessionId
      )
      options.logger.info(
        { requestId: context.get("requestId"), operation, ...target },
        "mcp_app.request"
      )
      const outcome = await handleMcpAppRequest({
        runtime,
        scope: {
          agentId,
          providerSessionId,
          sessionId: ids.sessionId(sessionId),
        },
        subject: subjectOf(runtime, target),
        operation,
        request: context.req.raw,
        allow: limit(operation),
        fileReads: (signal) => fileReads.take("", signal),
        files,
      })
      if (outcome.ok)
        return "stream" in outcome
          ? context.body(outcome.stream, 200, JSON_TYPE)
          : context.json(outcome.body)
      return errorResponse(
        outcome.reason === "rate_limited"
          ? "temporarily_unavailable"
          : outcome.reason,
        outcome.status,
        undefined,
        outcome.fileReason
      )
    })
}
