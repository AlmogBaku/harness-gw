import type {
  AgentCapabilities,
  AvailableCommand,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionInfo,
  SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2/unstable"
import type { z } from "zod"

import type { AgentCatalogResponseSchema } from "../protocol"
import type {
  HgwAgentUpdateRequest,
  HgwAgentUpdateResponseSchema,
  HgwHistoryCursor,
  HgwInitializeMetaSchema,
  HgwPromptMetaSchema,
  HgwSessionListMetaSchema,
  HgwSessionNewMetaSchema,
  HgwSessionSearchMeta,
  HgwSessionUpdateRequestSchema,
  HgwSteerRequestSchema,
  HgwSteerResponseSchema,
} from "../protocol/acp"
import type { HgwWorkspaceCapabilities } from "./hgw-client"

/**
 * The browser-side seam over one ACP v2 WebSocket connection to the gateway.
 * `connection.ts` implements it; the runtime, thread list, interactions, and
 * workspace client consume it and are tested against a fake.
 */

/** `capacity` is a reconnect the gateway asked to wait out, being full. */
export type AcpConnectionStatus =
  | "connecting"
  | "ready"
  | "reconnecting"
  | "capacity"
  | "closed"

/** Why the connection is recovering, as `AcpConnectionStatus` names it. */
export type AcpConnectionOutage = "reconnecting" | "capacity"

/** A server→client request awaiting the operator's answer. */
export type AcpPendingRequest =
  | {
      kind: "permission"
      sessionId: string
      /** The Session that owns the child Session `sessionId` names, if it is one. */
      parentSessionId?: string
      request: RequestPermissionRequest
      respond(response: RequestPermissionResponse): void
      /** Aborts when the gateway withdraws the request, which needs no answer. */
      signal: AbortSignal
    }
  | {
      kind: "elicitation"
      sessionId: string | undefined
      /** The Session that owns the child Session `sessionId` names, if it is one. */
      parentSessionId?: string
      request: CreateElicitationRequest
      respond(response: CreateElicitationResponse): void
      signal: AbortSignal
    }

export type AcpSessionUpdateListener = (
  update: SessionUpdate,
  meta: Record<string, unknown> | undefined
) => void

/** One older page of a Session, read without resuming it again. */
export type AcpHistoryPage = {
  /** The page's updates in arrival order, each with its `_meta.hgw`. */
  readonly updates: readonly {
    readonly update: SessionUpdate
    readonly meta: Record<string, unknown> | undefined
  }[]
  /** Where the page before this one starts, or that none can be read. */
  readonly history: HgwHistoryCursor
}

/**
 * Told a from-start replay is starting; may return its settle callback, told
 * whether the replay completed.
 */
export type AcpSessionReplayListener = () =>
  | ((replayed: boolean) => void)
  | void

/**
 * What a Session reports of its setup: its config options, its slash commands,
 * and the capabilities that travel with the commands. A `session/new`,
 * `session/resume`, or `session/fork` answer carries both lists, one it omits
 * read as none, and the capabilities when it names them; a
 * `config_option_update` or `available_commands_update` carries one list. Each
 * list is the Session's whole list, and a field left out here is unchanged.
 */
export type AcpSessionSetup = {
  readonly configOptions?: readonly SessionConfigOption[]
  readonly availableCommands?: readonly AvailableCommand[]
  readonly capabilities?: HgwWorkspaceCapabilities
}

/**
 * Where one opened Session stands: `joining` until the gateway has joined it,
 * `joined` while it follows the Session, `unavailable` while a failed join
 * waits out its backoff or one the transport refuses waits for the next, and
 * `gone` once the provider no longer has it.
 */
export type AcpSessionState = "joining" | "joined" | "unavailable" | "gone"

/** One consumer of an opened Session; it takes only the parts it names. */
export type AcpSessionListener = {
  /** The owning Agent, when known before any list, e.g. from a deep link. */
  agentId?: string
  /** `session/update` notifications for the Session, with `_meta.hgw`. */
  update?: AcpSessionUpdateListener
  /**
   * The updates of a child Session this one owns, announced by a
   * `subagent_update` this listener's `update` saw: ACP sends them under the
   * child's own id, on this connection.
   */
  child?: (
    childSessionId: string,
    update: SessionUpdate,
    meta: Record<string, unknown> | undefined
  ) => void
  /**
   * Fires just before a from-start replay is requested, so whoever projects
   * the Session can drop the transcript that replay is about to resend. It
   * may return a callback, called once that replay has settled either way.
   */
  replay?: AcpSessionReplayListener
  /**
   * The Session's setup: on subscribe, what it has reported so far by answer
   * or update, then what each later setup answer reports, such as a rejoin's
   * `session/resume`. Live updates of those lists reach `update` alone. An
   * answer and an update alike replace the lists they name, in the order they
   * arrive, as ACP has a client apply them.
   */
  setup?: (setup: AcpSessionSetup) => void
  state?: (state: AcpSessionState) => void
}

/**
 * A read (`listAgents`, `listSessions`, `searchSessions`, `resumePage`) waits
 * out a reconnect and goes out again on the transport that recovers, and a
 * write for an opened Session once it has rejoined. Any other call a
 * transport closes under, and every call once the connection has ended,
 * rejects as `AcpConnectionClosedError`.
 */
export interface AcpConnection {
  readonly status: AcpConnectionStatus
  /**
   * Opens the transport. Creating a connection performs no I/O, so a render
   * React discards leaks no socket; an effect owns the transport's lifetime.
   * Calling it again while the connection lives, or after `close`, does
   * nothing: reconnection belongs to the connection alone.
   */
  start(): void
  /** Resolves with `InitializeResponse._meta.hgw` once the handshake settles. */
  readonly initialized: Promise<z.infer<typeof HgwInitializeMetaSchema>>
  /**
   * ACP's `InitializeResponse.capabilities` from the latest handshake:
   * `session.fork` says the gateway forks. Undefined before one settles.
   */
  readonly capabilities: AgentCapabilities | undefined
  subscribeStatus(listener: (status: AcpConnectionStatus) => void): () => void
  /**
   * Set from a close until the transport is ready again. Each Session's
   * rejoin is its own state (`sessionState`), not the connection's.
   */
  readonly outage: AcpConnectionOutage | undefined
  subscribeOutage(
    listener: (outage: AcpConnectionOutage | undefined) => void
  ): () => void

  /**
   * Redeems a guest invitation. The connection keeps the token and replays the
   * login before it rejoins its Sessions on a recovered transport.
   */
  login(token: string): Promise<void>

  /**
   * Creates a Session, opened in its grace: it parts unless a listener
   * subscribes within it, and one that does is handed the setup the answer
   * reported. Its row follows as an update. The browser holds the shared
   * address, so it names the Agent.
   */
  newSession(
    meta: z.infer<typeof HgwSessionNewMetaSchema> & { agentId: string }
  ): Promise<{ sessionId: string }>
  /**
   * Forks a Session into a new one holding its conversation so far, where
   * `capabilities.session.fork` says the gateway forks; the gateway joins
   * this connection to it, and it opens in its grace, as `newSession` does.
   */
  forkSession(sessionId: string): Promise<{ sessionId: string }>
  listSessions(
    meta: z.infer<typeof HgwSessionListMetaSchema>,
    cursor?: string
  ): Promise<{ sessions: SessionInfo[]; nextCursor?: string }>
  /**
   * The Sessions matching a query, at most one window of them, newest first
   * where the runtime orders them. Operators only.
   */
  searchSessions(
    meta: HgwSessionSearchMeta
  ): Promise<{ sessions: SessionInfo[] }>
  /**
   * Opens the Session while any listener subscribes. The connection joins it,
   * replaying it from the start the first time, rejoins it from its own
   * position after a reconnect, and retries a refused join on backoff. It
   * parts, with `_hgw/session/part`, 2 s after the last listener leaves, so a
   * listener back within that grace costs neither a part nor a resume. A
   * listener that subscribes before anything of a from-start replay under way
   * has arrived takes part in that replay.
   */
  subscribe(sessionId: string, listener: AcpSessionListener): () => void
  /** Resolves once the opened Session is joined; rejects once it is gone or parts. */
  joined(sessionId: string): Promise<void>
  /**
   * Replays the opened Session from the start, after the join in flight, and
   * resolves once it is joined again. A from-start replay that nothing has
   * arrived for yet, under way or still owed, serves the call instead.
   */
  replay(sessionId: string): Promise<void>
  /** Where the opened Session stands; undefined for one no listener holds. */
  sessionState(sessionId: string): AcpSessionState | undefined
  /**
   * Reads the page before `cursor` of an opened Session, once it is joined.
   * Its updates come back here and never reach a listener or the rejoin
   * position, so a page cannot disturb the live turn.
   */
  resumePage(sessionId: string, cursor: string): Promise<AcpHistoryPage>
  /**
   * The history cursor the latest from-start replay of this opened Session
   * reported; a join that replays nothing leaves it as it was.
   */
  history(sessionId: string): HgwHistoryCursor | undefined
  /**
   * Prompts an opened Session once it is joined, as `setConfigOption` and
   * `steer` write. Open it first (`subscribe`, or `newSession` and
   * `forkSession`, which open the Session they make): the gateway takes
   * neither a prompt nor a config write of a Session no resume or create made
   * active on the connection, and answers `-32002` naming it.
   */
  prompt(
    sessionId: string,
    blocks: ContentBlock[],
    meta: z.infer<typeof HgwPromptMetaSchema>
  ): Promise<{ messageId: string }>
  cancel(sessionId: string): void
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<SessionConfigOption[]>
  /**
   * Ends the Session with ACP's `session/close`, which stops its work, and
   * forgets it here at once, with no `_hgw/session/part`: its listeners hear
   * nothing more of it, and nothing rejoins it. A Session the gateway no
   * longer has (`-32002`) is closed already, so that answer resolves too.
   */
  closeSession(sessionId: string): Promise<void>
  /** Resolves, as `closeSession` does, for a Session already gone (`-32002`). */
  deleteSession(sessionId: string): Promise<void>

  updateSession(
    request: z.infer<typeof HgwSessionUpdateRequestSchema>
  ): Promise<void>
  steer(
    request: z.infer<typeof HgwSteerRequestSchema>
  ): Promise<z.infer<typeof HgwSteerResponseSchema>>
  /** The exposed Session plus this connection's presence, re-sent on reconnect. */
  focus(
    sessionId: string | null,
    presence: { foreground: boolean; idle: boolean }
  ): void
  listAgents(): Promise<z.infer<typeof AgentCatalogResponseSchema>>
  /** Unsupported and revision-conflict refusals reject as `AgentUpdateError`. */
  updateAgent(
    request: HgwAgentUpdateRequest
  ): Promise<z.infer<typeof HgwAgentUpdateResponseSchema>>

  /** Extension notifications by method name (`HGW_METHODS.notify.*`). */
  subscribeNotification(
    method: string,
    listener: (params: unknown) => void
  ): () => void
  subscribePendingRequests(
    listener: (request: AcpPendingRequest) => void
  ): () => void
  close(): void
}
