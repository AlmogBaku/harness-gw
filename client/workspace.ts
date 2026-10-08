import type { SessionPlatform } from "../protocol"

/**
 * The workspace shapes the client hands its caller: Agents, Sessions, Todos,
 * activity, questions, and the composer's model and usage. A UI built on the
 * client reads these, and proves its own types still match them.
 */

export type AgentVisibility = "visible" | "hidden"

/** Fields an operator changes on an Agent; `avatar: null` clears it. */
export type AgentUpdate = {
  visibility?: AgentVisibility
  avatar?: string | null
}

/** Actionable Agent update refusals; all other failures remain ordinary Errors. */
export class AgentUpdateError extends Error {
  constructor(
    readonly code: "unsupported" | "conflict",
    message: string
  ) {
    super(message)
    this.name = "AgentUpdateError"
  }
}

export type SessionStatus =
  "idle" | "running" | "waiting-for-input" | "failed" | "unknown"

export type ActivityBase = {
  id: string
  agentId: string
  sessionId: string
  occurredAt: string
}

export type WorkspaceActivityEvent =
  | (ActivityBase & { type: "turn-started"; turnId: string })
  | (ActivityBase & {
      type: "turn-finished" | "turn-failed"
      turnId: string
    })
  | (ActivityBase & {
      type: "attention-requested"
      attentionKind: "question" | "permission"
      requestId: string
    })
  | (ActivityBase & { type: "attention-resolved"; requestId: string })
  | (ActivityBase & { type: "agent-ready" | "agent-activation-failed" })

export type SessionMetadata = {
  sessionId: string
  agentId: string
  updatedAt: string
  status: SessionStatus
  /** Provider archival state; absent until a provider read reports it. */
  archived?: boolean
  /** Provider read state; absent when the runtime does not track it. */
  unread?: boolean
  /** Provider pin; absent when the runtime does not track it. */
  pinned?: boolean
  /** Provider creation time; absent when the runtime does not report it. */
  createdAt?: string
  /** External platform the Session came from; absent for AOS-native Sessions. */
  platform?: SessionPlatform
}

/** Which Session actions the selected runtime declares it performs. */
export type SessionActionCapabilities = {
  rename: boolean
  archive: boolean
  delete: boolean
  pin: boolean
}

export type TodoStatus = "pending" | "active" | "completed" | "failed"

export type TodoItem = {
  id: string
  label: string
  status: TodoStatus
}

export type SessionCreationOptions = {
  title: string
}

export type RuntimeQuestionOption = {
  label: string
  /** Opaque provider value; absent options submit their rendered label. */
  value?: string
  description?: string
}

export type RuntimeQuestion = {
  /** Provider-stable item identity for batched interaction responses. */
  id?: string
  /** The provider's short label, when it has one; the browser numbers it when not. */
  header?: string
  prompt: string
  options: readonly RuntimeQuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export type RuntimeQuestionRequest = {
  kind: "question"
  requestId: string
  sessionId: string
  questions: readonly RuntimeQuestion[]
  /** Non-actionable native requests remain inspectable after expiry/recovery. */
  status?: "expired" | "recovered"
}

export type RuntimeQuestionResponse = {
  kind: "question"
  answers: string[][]
}

/** Snapshots are immutable and stable until subscribe signals a change. */
export type RuntimeInteractionAdapter = {
  respond(
    request: RuntimeQuestionRequest,
    response: RuntimeQuestionResponse
  ): Promise<void>
  reject(request: RuntimeQuestionRequest): Promise<void>
  dismiss?(request: RuntimeQuestionRequest): void
  getPending(sessionId: string): RuntimeQuestionRequest | undefined
  subscribe(
    sessionId: string,
    listener: () => void,
    onError?: (error: Error) => void
  ): () => void
}

/**
 * What the last settled turn used, in raw tokens, as the provider reported it.
 * Every count is optional: a provider reports only what it measures.
 */
export type ComposerTurnUsage = {
  readonly inputTokens?: number | undefined
  readonly outputTokens?: number | undefined
  readonly thoughtTokens?: number | undefined
  readonly cachedReadTokens?: number | undefined
  readonly cachedWriteTokens?: number | undefined
  readonly totalTokens?: number | undefined
}

/** The model and reasoning effort the provider says the Session is on. */
export type ComposerModelCurrent = {
  readonly selectedId: string
  readonly effortId?: string | undefined
}

/**
 * A provider-side model change the composer follows as it happens, for
 * example after a slash command or another client switched the Session.
 * `current` returns the same reference until the next change replaces it,
 * which is what `useSyncExternalStore` requires.
 */
export type ComposerModelFeed = {
  readonly current: () => ComposerModelCurrent | undefined
  readonly subscribe: (listener: () => void) => () => void
}

export type { SessionPlatform }

/** An attachment as the client stages it: its bytes as a data URL. */
export type StagedAttachment = {
  type: "image" | "file"
  dataUrl: string
  filename?: string
  mimeType: string
}
