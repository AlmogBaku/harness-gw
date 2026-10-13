import type { EventFrame } from "@openclaw/gateway-protocol"

import type { Logger } from "../../../lifecycle"
import type {
  AgentUpdatePatch,
  AgentUpdateResponse,
  RuntimeInfo,
  SessionAttachmentStageRequest,
  SessionModelUpdateRequest,
} from "../../../protocol"
import {
  SESSION_CATALOG_MAX_WINDOW,
  SessionWorkspaceCapabilitiesResponseSchema,
} from "../../../protocol"
import type {
  ServerAttachmentStage,
  ServerFileReader,
  ServerMcpApps,
  ServerTurnEngine,
  ServerRuntime,
  ServerRuntimeTranslation,
  SessionPatch,
} from "../../core/runtime"
import { failureOf, publicFailure, TURN_FAILURES } from "../../core/failures"
import type { ServerLink } from "../../core/link"
import {
  openClawConnectionFailure,
  OpenClawClientRequestError,
  type OpenClawGatewayClient,
} from "./client"
import {
  artifactFilename,
  artifactMime,
  downloadBytes,
  isNativeArtifactId,
  OpenClawArtifactUnavailableError,
  OpenClawArtifactUnreadableError,
} from "./artifacts"
import { OpenClawContentPublicError } from "./content"
import { openClawCapabilities } from "./capabilities"
import { stageOpenClawChatAttachments } from "./content"
import { createOpenClawFileReader } from "./file-reader"
import {
  createOpenClawHistory,
  OpenClawHistoryUnavailableError,
  type OpenClawHistorySubscription,
} from "./history"
import { OpenClawInteractionPublicError } from "./interactions"
import { createOpenClawMcpApps } from "./mcp-apps"
import { OpenClawRewindRefusedError, OpenClawTurnPublicError } from "./run"
import {
  createOpenClawMcpToolNames,
  type OpenClawMcpToolNames,
} from "./mcp-tool-names"
import {
  OpenClawNativePayloadError,
  openClawArtifactDownloadParams,
  parseOpenClawArtifactDownload,
} from "./native-schemas"
import {
  createOpenClawWorkspace,
  OpenClawForkRefusedError,
  OpenClawWorkspaceOwnershipError,
  OpenClawWorkspaceRevisionConflictError,
  OpenClawWorkspaceUnavailableError,
} from "./workspace"

/** One wake per burst of `sessions.changed`: the first opens the window. */
export const CATALOG_CHANGE_WINDOW_MS = 1_000

/** A native operation is intentionally absent until its exact V4 semantics are proven. */
export class OpenClawAdapterUnavailableError extends Error {
  constructor() {
    super("OpenClaw operation is unavailable")
    this.name = "OpenClawAdapterUnavailableError"
  }
}

/**
 * One artifact read. The gateway refuses a missing, unknown, or unsupported
 * artifact without saying which, so every refusal reads as unreadable.
 */
async function readable(read: () => Promise<unknown>) {
  try {
    return await read()
  } catch (error) {
    if (
      error instanceof OpenClawClientRequestError &&
      error.kind === "rejected"
    )
      throw new OpenClawArtifactUnreadableError()
    throw error
  }
}

/** Sorts every failure an OpenClaw leaf or its Gateway link raises. */
export function openClawPublicError(cause: unknown) {
  const connection = openClawConnectionFailure(cause)
  if (connection) return connection
  if (cause instanceof OpenClawClientRequestError && cause.uncertain)
    return failureOf("uncertain", cause)
  // A send or Stop that may have landed says so by its code; any other did not.
  if (cause instanceof OpenClawTurnPublicError)
    return (
      publicFailure(cause, TURN_FAILURES) ?? failureOf("unavailable", cause)
    )
  if (
    cause instanceof OpenClawWorkspaceOwnershipError ||
    // The artifact is still authoritative, but OpenClaw cannot read it:
    // unlike a 503, "not found" never invites a retry that cannot succeed.
    cause instanceof OpenClawArtifactUnreadableError ||
    (cause instanceof OpenClawInteractionPublicError &&
      cause.code === "HGW_INTERACTION_NOT_FOUND")
  )
    return failureOf("gone", cause)
  if (cause instanceof OpenClawWorkspaceRevisionConflictError)
    return failureOf("revision_conflict", cause)
  if (
    cause instanceof OpenClawContentPublicError ||
    // A rewind or fork OpenClaw refused is refused again on a retry.
    cause instanceof OpenClawRewindRefusedError ||
    cause instanceof OpenClawForkRefusedError ||
    (cause instanceof OpenClawInteractionPublicError &&
      cause.code === "HGW_INVALID_INTERACTION")
  )
    return failureOf("invalid_request", cause)
  if (
    cause instanceof OpenClawClientRequestError ||
    cause instanceof OpenClawWorkspaceUnavailableError ||
    cause instanceof OpenClawHistoryUnavailableError ||
    cause instanceof OpenClawNativePayloadError ||
    cause instanceof OpenClawAdapterUnavailableError ||
    cause instanceof OpenClawArtifactUnavailableError ||
    (cause instanceof OpenClawInteractionPublicError &&
      cause.code === "HGW_PROVIDER_INVALID_RESPONSE")
  )
    return failureOf("unavailable", cause)
  return undefined
}

/** Hears every Gateway event as it arrives, until the returned stop. */
type OpenClawEvents = (listener: (event: EventFrame) => void) => () => void

type OpenClawServerAdapterOptions = Readonly<{
  /** The Gateway's calls, and the link they ride on. */
  client: OpenClawGatewayClient & { readonly link: ServerLink }
  turns: ServerTurnEngine
  hiddenAgentIds?: readonly string[]
  subscribeSession: OpenClawHistorySubscription
  /**
   * The gateway's HTTP origin, where a ticketed media download and an MCP
   * App's files resolve.
   */
  gatewayOrigin?: string
  /** The device token an MCP App's file read presents, read afresh each time. */
  deviceToken?: () => Promise<string>
  fetch?: typeof fetch
  /** Shared with the turn engine so live and stored tool names agree. */
  mcpToolNames?: OpenClawMcpToolNames
  /** `runtime.mediaArtifacts`; on unless the deployment turns it off. */
  mediaArtifacts?: boolean
  /** Where a row or an Agent left out of a list is told. */
  logger?: Logger
  /** The Gateway's events; without them there is no catalog change feed. */
  subscribeEvents?: OpenClawEvents
}>

/**
 * Provider composition only: native identity, subscriptions, and validation
 * remain in the OpenClaw leaves; the coordinator retains admission and turns.
 */
export class OpenClawServerAdapter implements ServerRuntime {
  readonly link: ServerLink
  readonly turns: ServerTurnEngine
  /** OpenClaw's read position moves only on a write, and no event re-lights it. */
  readonly translation: ServerRuntimeTranslation = { relighting: [] }
  readonly mcpApps: ServerMcpApps
  /** Absent without the gateway's origin and a device token. */
  readonly readFile?: ServerFileReader
  /**
   * A wake per burst of the Gateway's `sessions.changed`, which it sends to a
   * connection that called `sessions.subscribe`; each new connection calls it
   * again. A lost connection is no change: the next read reconciles it.
   */
  readonly subscribeCatalogChanges?: (
    listener: () => void
  ) => Promise<() => void>
  readonly #workspace
  readonly #history
  readonly #client: OpenClawGatewayClient
  readonly #gatewayOrigin?: string
  readonly #fetch: typeof fetch
  readonly #log?: Logger
  #close?: Promise<void>

  constructor(options: OpenClawServerAdapterOptions) {
    this.link = options.client.link
    this.turns = options.turns
    this.#client = options.client
    this.#gatewayOrigin = options.gatewayOrigin
    this.#fetch = options.fetch ?? fetch
    this.#log = options.logger
    this.#workspace = createOpenClawWorkspace({
      client: options.client,
      hiddenAgentIds: options.hiddenAgentIds,
      ...(options.logger ? { log: options.logger } : {}),
      readState: () => this.#readState(),
    })
    this.#history = createOpenClawHistory({
      client: options.client,
      authority: this.#workspace,
      subscribeSession: options.subscribeSession,
      mcpToolNames:
        options.mcpToolNames ?? createOpenClawMcpToolNames(options.client),
      ...(options.mediaArtifacts === undefined
        ? {}
        : { mediaArtifacts: options.mediaArtifacts }),
    })
    this.mcpApps = createOpenClawMcpApps({
      client: options.client,
      authority: {
        getSession: (agentId, sessionKey) =>
          this.#workspace.getSession(agentId, sessionKey),
        mcpAppViewId: (agentId, sessionKey, toolCallId) =>
          this.#history.mcpAppViewId(agentId, sessionKey, toolCallId),
        mcpToolCall: (agentId, sessionKey, toolCallId) =>
          this.#history.mcpToolCall(agentId, sessionKey, toolCallId),
      },
      start: () => this.#start(),
    })
    if (options.gatewayOrigin && options.deviceToken)
      this.readFile = createOpenClawFileReader({
        client: options.client,
        start: () => this.#start(),
        origin: options.gatewayOrigin,
        deviceToken: options.deviceToken,
        fetch: this.#fetch,
      })
    const subscribeEvents = options.subscribeEvents
    if (subscribeEvents)
      this.subscribeCatalogChanges = (listener) =>
        this.#catalogChanges(subscribeEvents, listener)
  }

  resolveProviderSessionId(agentId: string, publicSessionId: string) {
    return this.#workspace.resolveProviderSessionId(agentId, publicSessionId)
  }

  async resolveInvitedSession(
    agentId: string,
    ref: string,
    create?: { readonly firstTurnInstruction?: string }
  ) {
    await this.#start()
    // The pinned Gateway leaves do not prove equivalent native Session
    // creation, so a Send that may create resolves only the reserved Session
    // already there, as a read does.
    void create
    return this.#workspace.resolveInvitedSession(agentId, ref)
  }

  publicError(cause: unknown) {
    return openClawPublicError(cause)
  }

  async runtimeInfo(): Promise<RuntimeInfo> {
    try {
      await this.listAgents()
    } catch (error) {
      if (this.publicError(error)?.code === "runtime_authentication_required")
        throw error
      return this.#runtimeInfo("unavailable")
    }
    return this.#runtimeInfo("ready")
  }

  async listAgents() {
    await this.#start()
    return this.#workspace.listAgents()
  }

  async agentFolder(agentId: string) {
    await this.#start()
    return this.#workspace.agentFolder(agentId)
  }

  async updateAgent(
    agentId: string,
    patch: AgentUpdatePatch,
    observedRevision: string
  ): Promise<AgentUpdateResponse> {
    await this.#start()
    return this.#workspace.updateAgent(agentId, patch, observedRevision)
  }

  async listAllSessions(limit: number, offset: number) {
    await this.#start()
    if (offset + limit > SESSION_CATALOG_MAX_WINDOW)
      throw new OpenClawWorkspaceUnavailableError()
    return this.#workspace.listAllSessions(limit, offset)
  }

  async listSessions(agentId: string, limit: number, offset: number) {
    await this.#start()
    return this.#workspace.listSessions(agentId, limit, offset)
  }

  async history(
    agentId: string,
    providerSessionId: string,
    limit: number,
    offset: number
  ) {
    await this.#start()
    return this.#history.history(agentId, providerSessionId, limit, offset)
  }

  /** A child Session's whole transcript, once its row names the Session. */
  async childHistory(
    agentId: string,
    providerSessionId: string,
    childSessionId: string
  ) {
    await this.#start()
    return this.#history.childHistory(
      agentId,
      providerSessionId,
      childSessionId
    )
  }

  async getSession(agentId: string, providerSessionId: string) {
    await this.#start()
    return this.#workspace.getSession(agentId, providerSessionId)
  }

  async createSession(agentId: string, _title?: string): Promise<unknown> {
    void _title
    await this.#start()
    return this.#workspace.createSession(agentId)
  }

  /** A fork through `sessions.create`, answered as `createSession` answers. */
  async forkSession(agentId: string, providerSessionId: string) {
    await this.#start()
    return this.#workspace.forkSession(agentId, providerSessionId)
  }

  async updateSession(
    agentId: string,
    providerSessionId: string,
    patch: SessionPatch
  ): Promise<void> {
    await this.#start()
    // The native patch owns each flag's side effects; the gateway sends one at a time.
    await this.#workspace.updateSession(agentId, providerSessionId, patch)
  }

  async deleteSession(agentId: string, providerSessionId: string) {
    await this.#start()
    await this.#workspace.deleteSession(agentId, providerSessionId)
  }

  async workspaceCapabilities(
    agentId: string,
    publicSessionId: string
  ): Promise<unknown> {
    await this.#start()
    await this.#workspace.getSession(agentId, publicSessionId)
    const policy = this.#client.negotiatedPolicy?.()
    if (!policy) throw new OpenClawAdapterUnavailableError()
    const provider = openClawCapabilities(policy)
    return SessionWorkspaceCapabilitiesResponseSchema.parse({
      workspace: {
        slashCommands: {
          status: "unavailable",
          reason: "native-slash-command-catalog-unavailable",
        },
        models: {
          status: "available",
          scope: "session",
          selection: "native-session",
          choices: "provider-reported",
        },
        context: {
          status: "available",
          scope: "session",
          source: "provider-usage-or-estimate",
          breakdown: "provider-categories",
        },
        todos: { status: "unavailable", reason: "todo-projection-unavailable" },
        activity: {
          status: "unavailable",
          reason: "activity-projection-unavailable",
        },
      },
      ...provider,
    })
  }

  async models(agentId: string, providerSessionId: string) {
    await this.#start()
    return this.#history.models(agentId, providerSessionId)
  }

  async updateModel(
    _agentId: string,
    _providerSessionId: string,
    _patch: SessionModelUpdateRequest
  ): Promise<unknown> {
    void [_agentId, _providerSessionId, _patch]
    throw new OpenClawAdapterUnavailableError()
  }

  async context(agentId: string, providerSessionId: string) {
    await this.#start()
    return this.#history.context(agentId, providerSessionId)
  }

  async stageAttachments(
    agentId: string,
    publicSessionId: string,
    attachments: SessionAttachmentStageRequest["attachments"]
  ): Promise<ServerAttachmentStage> {
    await this.#start()
    await this.#workspace.getSession(agentId, publicSessionId)
    const policy = this.#client.negotiatedPolicy?.()
    if (!policy?.attachments) throw new OpenClawAdapterUnavailableError()
    return stageOpenClawChatAttachments(attachments, {
      maxPayload: policy.maxPayload,
      attachments: policy.attachments,
    })
  }

  async artifact(
    agentId: string,
    publicSessionId: string,
    artifactId: string
  ): Promise<{ bytes: Uint8Array; mimeType?: string; filename: string }> {
    await this.#start()
    await this.#workspace.getSession(agentId, publicSessionId)
    return this.#nativeArtifact(agentId, publicSessionId, artifactId)
  }

  /** OpenClaw's own transcript artifact; the gateway scopes it to the Session. */
  async #nativeArtifact(agentId: string, sessionKey: string, id: string) {
    if (!isNativeArtifactId(id)) throw new OpenClawWorkspaceOwnershipError()
    const download = parseOpenClawArtifactDownload(
      await readable(() =>
        this.#client.request(
          "artifacts.download",
          openClawArtifactDownloadParams(agentId, sessionKey, id)
        )
      )
    )
    const mimeType = artifactMime(download.artifact.mimeType)
    return {
      bytes: await downloadBytes(download, this.#gatewayOrigin, this.#fetch),
      ...(mimeType ? { mimeType } : {}),
      filename: artifactFilename(download.artifact.title),
    }
  }

  async transcribe(
    _agentId: string,
    _bytes: Uint8Array,
    _mimeType: string,
    _signal?: AbortSignal
  ): Promise<string> {
    void [_agentId, _bytes, _mimeType, _signal]
    throw new OpenClawAdapterUnavailableError()
  }

  async speak(
    _agentId: string,
    _text: string,
    _signal?: AbortSignal
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    void [_agentId, _text, _signal]
    throw new OpenClawAdapterUnavailableError()
  }

  close(): Promise<void> {
    this.#close ??= this.#client.stopAndWait()
    return this.#close
  }

  /** Never cached: a failed start leaves the next call to dial again. */
  #start() {
    return Promise.resolve(this.#client.start())
  }

  /** Whether the Gateway now keeps read state under its acknowledgement contract. */
  #readState() {
    return this.#client.negotiatedPolicy?.()?.sessionUnreadAck === true
  }

  async #catalogChanges(subscribeEvents: OpenClawEvents, listener: () => void) {
    await this.#start()
    const subscribe = () => this.#client.request("sessions.subscribe", {})
    let burst: ReturnType<typeof setTimeout> | undefined
    const leaveEvents = subscribeEvents(({ event }) => {
      if (event !== "sessions.changed" || burst !== undefined) return
      burst = setTimeout(() => {
        burst = undefined
        listener()
      }, CATALOG_CHANGE_WINDOW_MS)
    })
    // The link turns ready only after it was lost, on a new connection.
    const leaveLink = this.link.subscribe((state) => {
      if (state === "ready")
        subscribe().catch((err: unknown) =>
          this.#log?.warn({ err }, "openclaw.catalog.subscribe_failed")
        )
    })
    const leave = () => {
      leaveEvents()
      leaveLink()
      clearTimeout(burst)
    }
    try {
      await subscribe()
    } catch (error) {
      leave()
      throw error
    }
    return leave
  }

  #runtimeInfo(status: "ready" | "unavailable"): RuntimeInfo {
    const available = status === "ready"
    const operation = available
      ? ({ status: "available" } as const)
      : ({ status: "unavailable", reason: "temporarily-unavailable" } as const)
    const unavailable = (reason: string) =>
      ({ status: "unavailable", reason }) as const
    return {
      runtime: { id: "openclaw", name: "OpenClaw" },
      status,
      capabilities: {
        agentCatalog: operation,
        agentVisibility: unavailable("native-semantic-equivalent-unavailable"),
        sessionCatalog: available
          ? {
              status: "available",
              scope: "workspace",
              order: "recent",
              defaultPageSize: 50,
              maxPageSize: 100,
              maxWindow: SESSION_CATALOG_MAX_WINDOW,
            }
          : unavailable("temporarily-unavailable"),
        sessionHistory: available
          ? {
              status: "available",
              order: "chronological",
              compacted: true,
              loading: "on-open",
              defaultPageSize: 200,
              maxPageSize: 500,
            }
          : unavailable("temporarily-unavailable"),
        sessionDetail: operation,
        sessionCreation: operation,
        sessionTitle: operation,
        sessionArchival: operation,
        sessionPin: operation,
        sessionDeletion: operation,
        sessionTurn: operation,
        sessionStop: operation,
        sessionSteer: unavailable("native-active-turn-steering-unavailable"),
        sessionReadState: this.#readState()
          ? operation
          : unavailable("native-session-read-state-unavailable"),
      },
    }
  }
}
