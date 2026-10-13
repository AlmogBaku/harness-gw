import type { UnknownVariant } from "@agentclientprotocol/sdk/experimental/v2"
import { z } from "zod"

import {
  AgentCatalogResponseSchema,
  AgentUpdateFields,
  AgentUpdateResponseSchema,
  ArtifactDescriptorSchema,
  type ArtifactDescriptor,
  TurnSteerResponseSchema,
  SessionContextResponseSchema,
  SessionPlatformSchema,
  SessionStatusSchema,
  SessionTodosResponseSchema,
  SessionWorkspaceCapabilitiesResponseSchema,
  writesAgentField,
} from "./index"

/**
 * The gateway's extension contract carried over ACP v2 between the gateway
 * (agent side) and the browser (client side). ACP defines the turn stream,
 * sessions, config options, permissions, and plans; everything the gateway
 * needs beyond that travels as underscore-prefixed extension methods and
 * `_meta.hgw` payloads defined here. Both ends import this module and nothing
 * else defines these shapes.
 *
 * Client-to-agent shapes are strict: the gateway rejects what it does not
 * define. Agent-to-client shapes are read leniently (`readObject`): the
 * browser validates every key it knows and drops the rest, so a gateway that
 * adds a key never costs the browser the whole payload. The gateway's builders
 * stay exact through the inferred types.
 */

/**
 * An ACP value either end builds, as opposed to one it received. The SDK
 * brands the variants it does not know so only received values can carry them;
 * that brand also stops TypeScript from checking a built value whose tag is
 * computed (`stopReason: stopping ? "cancelled" : "end_turn"`) against the
 * known variants. Dropping the branded members at every depth restores that
 * check, and a `Built` value is still a plain `T`. The gateway builds every
 * update it sends this way; a browser test builds the updates it feeds in.
 */
export type Built<T> =
  T extends UnknownVariant<unknown>
    ? never
    : T extends object
      ? { [K in keyof T]: Built<T[K]> }
      : T

/**
 */

export const ACP_PROTOCOL_VERSION = 2 as const
/**
 * Every gateway route sits below this prefix, on both listeners: which
 * listener a request reaches, never its path, decides whether it is a guest's.
 */
export const HGW_API_PREFIX = "/api/v1" as const
export const HGW_ACP_PATH = `${HGW_API_PREFIX}/acp` as const
/**
 * Below the ACP path on the operator listener, each Agent's own address: its
 * Sessions alone, with no `_meta.hgw.agentId` to name.
 */
export const HGW_ACP_AGENTS_PATH = `${HGW_ACP_PATH}/agents` as const

/** One Agent's own ACP address, its id one path segment. */
export function hgwAcpAgentPath(agentId: string) {
  return `${HGW_ACP_AGENTS_PATH}/${encodeURIComponent(agentId)}`
}
export const HGW_META_KEY = "hgw" as const
export const HGW_EXTENSION_VERSION = 2 as const
export const HGW_AUTH_METHOD_INVITE = "hgw-invite" as const
export const HGW_ATTACHMENT_URI_SCHEME = "hgw-attachment:" as const
export const HGW_ARTIFACT_URI_SCHEME = "artifact:" as const

export const HGW_METHODS = {
  session: {
    update: "_hgw/session/update",
    steer: "_hgw/session/steer",
    focus: "_hgw/session/focus",
    part: "_hgw/session/part",
  },
  sessions: {
    search: "_hgw/sessions/search",
  },
  agents: {
    list: "_hgw/agents/list",
    update: "_hgw/agents/update",
  },
  notify: {
    activity: "_hgw/activity",
    composerPrefill: "_hgw/composer_prefill",
    catalogInvalidated: "_hgw/catalog_invalidated",
    error: "_hgw/error",
  },
} as const

/** Vendor permission option kind for Hermes' "allow for this session" scope. */
export const HGW_PERMISSION_KIND_SESSION = "_allow_session" as const

/** The single plan a Session carries: its Todos. */
export const HGW_PLAN_ID = "todos" as const

/**
 * JSON-RPC error codes for the failures ACP has no code for. Every error ACP
 * defines travels with ACP's own code, as the SDK's `RequestError` builds it;
 * these sit in their own block from -31010, clear of the codes ACP uses.
 */
export const HGW_JSONRPC_ERRORS = {
  turnInProgress: -31010,
  staleRequest: -31011,
  revisionConflict: -31012,
  temporarilyUnavailable: -31013,
  uncertainMutation: -31014,
  unsupported: -31015,
  /**
   * Params too large for one frame. The client raises it before sending and
   * the gateway never sends it, so it has no machine name on the wire.
   */
  requestTooLarge: -31016,
} as const

/**
 * The largest inbound WebSocket frame the gateway takes, in bytes. A larger
 * one closes the socket, and with it every Session on the tab.
 */
export const HGW_MAX_FRAME_BYTES = 1_100_000
export type HgwJsonRpcErrorCode =
  (typeof HGW_JSONRPC_ERRORS)[keyof typeof HGW_JSONRPC_ERRORS]

export const IdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )
const SequenceSchema = z.number().int().min(0)
const RoleSchema = z.enum(["operator", "guest"])

/** An agent-to-client object: known keys validated, unknown keys dropped. */
const readObject = z.object

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export const HgwExtensionsSchema = readObject({
  steer: z.boolean(),
  rewind: z.boolean(),
  composerPrefill: z.boolean(),
  agents: z.boolean(),
  invalidation: z.boolean(),
  activity: z.boolean(),
  readState: z.boolean(),
  focus: z.boolean(),
  guestProjection: z.boolean(),
  /** `session/resume` accepts `replayFrom: { type: "_hgw/before" }`. */
  historyPages: z.boolean().default(false),
})
export type HgwExtensions = z.infer<typeof HgwExtensionsSchema>

/**
 * `ClientCapabilities._meta.hgw` on `initialize`: the hgw extensions this
 * client understands. Without `historyPages`, a from-start resume replays the
 * whole Session, as ACP's `replayFrom: { type: "start" }` requires.
 */
export const HgwClientCapabilitiesMetaSchema = readObject({
  historyPages: z.boolean().default(false),
})

/** `InitializeResponse._meta.hgw` */
export const HgwInitializeMetaSchema = readObject({
  version: z.literal(HGW_EXTENSION_VERSION),
  role: RoleSchema,
  extensions: HgwExtensionsSchema,
})
export type HgwInitializeMeta = z.infer<typeof HgwInitializeMetaSchema>

/** `LoginAuthRequest._meta.hgw` for the guest listener. */
export const HgwLoginMetaSchema = z.strictObject({
  token: z.string().min(1).max(4096),
})

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

/**
 * The id the browser picks for one create or send, so a retry of it is
 * recognized as the same request rather than repeated.
 */
const ClientIdSchema = IdentifierSchema.optional()

/** `NewSessionRequest._meta.hgw` */
export const HgwSessionNewMetaSchema = z.strictObject({
  /**
   * Required on the shared address; on an Agent's own address it is that
   * Agent, or absent.
   */
  agentId: IdentifierSchema.optional(),
  title: z.string().min(1).max(4096).optional(),
  clientId: ClientIdSchema,
})

/** `ListSessionsRequest._meta.hgw` */
export const HgwSessionListMetaSchema = z.strictObject({
  agentId: IdentifierSchema.optional(),
})

/** `_hgw/sessions/search` request `_meta.hgw`. */
export const HgwSessionSearchMetaSchema = z.strictObject({
  agentId: IdentifierSchema.optional(),
  query: z.string().min(1).max(512),
})
export type HgwSessionSearchMeta = z.infer<typeof HgwSessionSearchMetaSchema>

/**
 * The `_hgw/sessions/search` response: matching Sessions as `session/list`
 * entries, which ACP's own schema validates for `session/list` alone.
 */
export const HgwSessionSearchResponseSchema = readObject({
  sessions: z.array(
    readObject({
      sessionId: IdentifierSchema,
      cwd: z.string(),
      title: z.string().nullish(),
      updatedAt: z.string().nullish(),
      _meta: z.record(z.string(), z.unknown()).nullish(),
    })
  ),
})

/**
 * `SessionInfo._meta.hgw` on `session/list` entries and
 * `session_info_update._meta.hgw`. `unread`, `pinned`, and `createdAt` are
 * absent when the runtime does not track that state or this read cannot know
 * it; absent never overwrites a known value.
 */
export const HgwSessionInfoMetaSchema = readObject({
  agentId: IdentifierSchema,
  status: SessionStatusSchema,
  archived: z.boolean(),
  createdAt: z.iso.datetime().optional(),
  unread: z.boolean().optional(),
  pinned: z.boolean().optional(),
  /** External platform the Session came from; absent for AOS-native Sessions. */
  platform: SessionPlatformSchema.optional(),
})
export type HgwSessionInfoMeta = z.infer<typeof HgwSessionInfoMetaSchema>

/** `ResumeSessionRequest._meta.hgw` */
export const HgwSessionResumeMetaSchema = z.strictObject({
  /** Owning Agent, when the client knows it before listing (deep links). */
  agentId: IdentifierSchema.optional(),
})

/**
 * The reserved `replayFrom` variant that resumes a view from where it already
 * reaches in the live turn: `from` is the first `_meta.hgw.sequence` of
 * `turnId` the client still needs, inclusive as every ACP cursor is. One that
 * names neither replays the live turn from its first event, or rebuilds the
 * view from history once the journal no longer holds that.
 */
export const HGW_REPLAY_POSITION = "_hgw/position" as const
export const HgwReplayPositionSchema = z.strictObject({
  type: z.literal(HGW_REPLAY_POSITION),
  turnId: IdentifierSchema.optional(),
  from: z.number().int().min(1).optional(),
  _meta: z.record(z.string(), z.unknown()).nullish(),
})

/**
 * The reserved `replayFrom` extension variant that reads one older page of a
 * Session this connection is already a member of. `cursor` is the opaque
 * `history.nextCursor` a previous resume returned; the server picks the page
 * size, so the client sends no limit. Like every ACP type it may carry `_meta`.
 */
export const HGW_REPLAY_BEFORE = "_hgw/before" as const
export const HgwReplayBeforeSchema = z.strictObject({
  type: z.literal(HGW_REPLAY_BEFORE),
  cursor: z.string().min(1).max(256),
  _meta: z.record(z.string(), z.unknown()).nullish(),
})

/**
 * `_meta.hgw.history` on a resume that replayed. It follows ACP v2
 * `session/list` pagination: `nextCursor` is opaque and its absence means the
 * replayed page reached the Session's beginning, unless `truncated` says older
 * history exists but this server cannot reach it.
 */
export const HgwHistoryCursorSchema = readObject({
  nextCursor: z.string().min(1).max(256).optional(),
  truncated: z.boolean().optional(),
})
export type HgwHistoryCursor = z.infer<typeof HgwHistoryCursorSchema>

/**
 * `ResumeSessionResponse._meta.hgw` for a `_hgw/before` page read: only the
 * cursor, since a page read never resumes.
 */
export const HgwHistoryPageResponseMetaSchema = readObject({
  history: HgwHistoryCursorSchema,
})

/**
 * Read from the `_meta.hgw` of any `session/update`: present only on an update
 * that belongs to a `_hgw/before` page, never on a live or start-replay one.
 * ACP notifications carry no request id, so this tag is what keeps a page apart
 * from live updates for the same Session.
 */
export const HgwHistoryPageTagSchema = readObject({
  historyPage: readObject({ cursor: z.string().min(1).max(256) }).optional(),
})

/**
 * `ResumeSessionResponse._meta.hgw`. `position` is the turn and sequence the
 * joined Session's stream stands at, which a later resume continues from.
 * The Session's row, execution, models and capabilities follow the answer as
 * updates.
 */
export const HgwSessionResumeResponseMetaSchema = readObject({
  position: readObject({
    turnId: IdentifierSchema,
    sequence: SequenceSchema,
  }).optional(),
  /** Present whenever this resume replayed history. */
  history: HgwHistoryCursorSchema.optional(),
})

/** `PromptRequest._meta.hgw` */
export const HgwPromptMetaSchema = z.strictObject({
  /** User turn to rewind before Edit or Retry; validated authoritatively. */
  rewindSourceId: IdentifierSchema.optional(),
  /** Server-staged attachment batch referenced by `resource_link` blocks. */
  attachmentStageId: IdentifierSchema.optional(),
  clientId: ClientIdSchema,
})

/** `_hgw/session/update` params: exactly one intent per write. */
export const HgwSessionUpdateRequestSchema = z
  .strictObject({
    sessionId: IdentifierSchema,
    title: z.string().min(1).max(4096).optional(),
    archived: z.boolean().optional(),
    unread: z.boolean().optional(),
    pinned: z.boolean().optional(),
  })
  .refine(
    (value) =>
      [value.title, value.archived, value.unread, value.pinned].filter(
        (intent) => intent !== undefined
      ).length === 1,
    "Exactly one of title, archived, unread, pinned"
  )

/**
 * `_hgw/session/part` params, answered `{}`: this connection stops following
 * the Session, whose work runs on. `session/close` also stops that work.
 */
export const HgwSessionPartRequestSchema = z.strictObject({
  sessionId: IdentifierSchema,
})

/** `_hgw/session/steer` params and response. */
export const HgwSteerRequestSchema = z.strictObject({
  sessionId: IdentifierSchema,
  requestId: IdentifierSchema,
  text: z.string().min(1),
})
export const HgwSteerResponseSchema = TurnSteerResponseSchema

/**
 * `_hgw/session/focus` request, answered `{}`: the exposed Session, or none,
 * plus the workspace presence the browser re-sends every
 * `PRESENCE_HEARTBEAT_MS`. A report without a `sessionId` changes nothing, so
 * the browser can probe its link with `{}`. An absent `foreground` means an
 * exposed Session is in the foreground, and an absent `idle` means the operator
 * is still interacting.
 */
export const HgwFocusRequestSchema = z.strictObject({
  sessionId: IdentifierSchema.nullable().optional(),
  foreground: z.boolean().optional(),
  idle: z.boolean().optional(),
})

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

export const HgwAgentsListResponseSchema = AgentCatalogResponseSchema
/** `_hgw/agents/update` params: at least one of visibility, avatar, and muted. */
export const HgwAgentUpdateRequestSchema = z
  .strictObject({ agentId: IdentifierSchema, ...AgentUpdateFields })
  .refine(writesAgentField, "At least one of visibility, avatar, muted")
export type HgwAgentUpdateRequest = z.infer<typeof HgwAgentUpdateRequestSchema>
export const HgwAgentUpdateResponseSchema = AgentUpdateResponseSchema

// ---------------------------------------------------------------------------
// turn stream `_meta.hgw`
// ---------------------------------------------------------------------------

/** Base for every `session/update` the proxy emits from a turn segment. */
const TurnMetaBase = {
  sequence: SequenceSchema,
  turnId: IdentifierSchema,
}

/**
 * `_meta.hgw` of a `terminal_update`, `terminal_output_chunk`, or
 * `compaction_update`: ACP's own fields carry every fact, so only the turn it
 * belongs to travels here.
 */
export const HgwTurnMetaSchema = readObject(TurnMetaBase)

const NoticeKindSchema = z.string().min(1).max(64)

/**
 * `_meta.hgw` of a Session-scoped `notice`: the provider's own status kind,
 * such as `heartbeat`, which picks the line's icon. A `notice` is live only; a
 * stored one heads the turn it started (`AosMessageMetaSchema`).
 */
export const HgwNoticeMetaSchema = readObject({
  kind: NoticeKindSchema.optional(),
})
export type HgwNoticeMeta = z.infer<typeof HgwNoticeMetaSchema>

/**
 * `_meta.hgw` of a replayed `agent_message` upsert whose message opens a turn
 * of its own: one the provider started without a prompt, led by the notice
 * naming what started it when the provider stored one. Live, a run no prompt
 * opened says the same by its shape.
 */
export const HgwMessageMetaSchema = readObject({
  opensTurn: z.literal(true),
  notice: readObject({
    severity: z.enum(["info", "warning", "error"]),
    title: z.string().min(1),
    kind: NoticeKindSchema.optional(),
  }).optional(),
})
export type HgwMessageMeta = z.infer<typeof HgwMessageMetaSchema>

const CountSchema = z.number().int().nonnegative()

/** What a turn cost, as the provider priced it; ISO 4217 currency. */
export const HgwCostSchema = readObject({
  amount: z.number().nonnegative(),
  currency: z.string().min(1).max(16),
})
export type HgwCost = z.infer<typeof HgwCostSchema>

/**
 * `subagent_update._meta.hgw`: what ACP's child Session announcement has no
 * field for. `toolCallId` names the parent's call that spawned the child; the
 * rest are the facts its runtime reports. A child's tokens arrive in its own
 * idle usage, apart from its parent's.
 */
export const HgwChildSessionMetaSchema = readObject({
  ...TurnMetaBase,
  toolCallId: IdentifierSchema.optional(),
  model: z.string().min(1).max(256).optional(),
  filesRead: z.array(z.string().max(4096)).max(1000).optional(),
  filesWritten: z.array(z.string().max(4096)).max(1000).optional(),
  durationMs: CountSchema.optional(),
  summary: z.string().max(65_536).optional(),
})
export type HgwChildSessionMeta = z.infer<typeof HgwChildSessionMetaSchema>

/** How far a delegated subagent has got. */
export const HGW_SUBAGENT_STATUSES = [
  "running",
  "completed",
  "failed",
  "cancelled",
] as const

/**
 * One delegated subagent, as a patch keyed by `id`: a later report restates
 * only what changed, so an omitted key leaves the known value standing.
 */
export const HgwSubagentSchema = readObject({
  id: IdentifierSchema,
  goal: z.string().max(65_536).optional(),
  model: z.string().min(1).max(256).optional(),
  /** 1 for a subagent the turn spawned, 2 for one that subagent spawned. */
  depth: z.number().int().min(1).optional(),
  status: z.enum(HGW_SUBAGENT_STATUSES).optional(),
  /** Every token the subagent spent. */
  tokens: CountSchema.optional(),
  filesRead: z.array(z.string()).optional(),
  filesWritten: z.array(z.string()).optional(),
  durationMs: CountSchema.optional(),
  /** The provider Session the subagent runs in, when it has its own. */
  childSessionId: IdentifierSchema.optional(),
  summary: z.string().max(65_536).optional(),
})
export type HgwSubagent = z.infer<typeof HgwSubagentSchema>

/**
 * Names the delegated subagent a chunk or tool call came from and, when the
 * spawning call is in the same stream, that call. Absent means the turn's own
 * agent produced it.
 */
const SubagentAttribution = {
  subagentId: IdentifierSchema.optional(),
  parentToolCallId: IdentifierSchema.optional(),
}

/** `state_update._meta.hgw` */
export const HgwStateMetaSchema = readObject({
  ...TurnMetaBase,
  /**
   * When the state took effect. The two state updates that bracket a turn carry
   * the turn's span, live and on replay alike, so the browser reads a turn's
   * duration from the wire rather than from its own clock.
   */
  at: z.iso.datetime().optional(),
  /** Stop was acknowledged but the provider has not settled yet. */
  execution: z.literal("stopping").optional(),
  /**
   * Present with the `error` stop reason and the `unknown` state, and on a
   * `requires_action` update when the turn reports a final failure but stays
   * active until it is stopped.
   */
  code: z.string().min(1).max(128).optional(),
  message: z.string().max(4096).optional(),
  /** The provider and model a failed turn ran on, when the failure names them. */
  provider: z.string().min(1).max(256).optional(),
  model: z.string().min(1).max(256).optional(),
  /**
   * What the turn cost, on its `idle` update. ACP prices only a Session's
   * cumulative spend, on a `usage_update` that also needs the context window.
   */
  cost: HgwCostSchema.optional(),
})

/** `agent_message_chunk` / `agent_thought_chunk` `_meta.hgw` */
export const HgwChunkMetaSchema = readObject({
  ...TurnMetaBase,
  ...SubagentAttribution,
})

/** `tool_call_update` / `tool_call_content_chunk` `_meta.hgw` */
export const HgwToolCallMetaSchema = readObject({
  ...TurnMetaBase,
  ...SubagentAttribution,
  messageId: IdentifierSchema,
  /** Streaming arguments text; ACP replaces `rawInput` wholesale. */
  argsTextDelta: z.string().optional(),
  argsText: z.string().optional(),
  /** When the call started and finished, as the provider timed it. */
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  /** How long the call ran, when the provider reports a span, not the ends. */
  durationMs: CountSchema.optional(),
  /** The subagent this call spawned; later updates patch it by `id`. */
  subagent: HgwSubagentSchema.optional(),
  /** The tool declares an MCP App view; a flag only, never a resource URI. */
  app: z.strictObject({}).optional(),
})

/** `plan_update._meta.hgw`: the lossless Session Todos. */
export const HgwPlanMetaSchema = readObject({
  sequence: SequenceSchema,
  turnId: IdentifierSchema.optional(),
  todos: SessionTodosResponseSchema.shape.todos,
})

/**
 * `usage_update._meta.hgw`. ACP's `usage_update` carries the used and total
 * token counts alone, so how the provider arrived at them and its own
 * attribution of what they hold travel here. A provider that attributes nothing
 * sends no breakdown rather than a guessed one, and usage belongs to the Session
 * rather than to a turn, so this meta names neither a turn nor a sequence.
 */
export const HgwUsageMetaSchema = readObject({
  source: SessionContextResponseSchema.shape.source,
  estimated: SessionContextResponseSchema.shape.estimated,
  breakdown: SessionContextResponseSchema.shape.breakdown,
})

/**
 * `available_commands_update._meta.hgw`: the Session's capabilities beyond its
 * slash commands travel with them, as one update.
 */
export const HgwAvailableCommandsMetaSchema = readObject({
  capabilities: SessionWorkspaceCapabilitiesResponseSchema,
})

// ---------------------------------------------------------------------------
// pending requests `_meta.hgw`
// ---------------------------------------------------------------------------

/** `RequestPermissionRequest._meta.hgw` */
export const HgwPermissionMetaSchema = readObject({
  requestId: IdentifierSchema,
  expiresAt: z.iso.datetime().optional(),
  message: z.string().max(4096).optional(),
})

export const HgwQuestionOptionSchema = readObject({
  label: z.string().min(1).max(4096),
  value: z.string().max(4096).optional(),
  description: z.string().max(4096).optional(),
})
export const HgwQuestionSchema = readObject({
  id: IdentifierSchema.optional(),
  /**
   * The provider's own short label for the question, when it has one. A
   * provider that carries only the question's words omits it, and the browser
   * labels the question by its place in the batch, in the reader's language.
   */
  header: z.string().min(1).max(256).optional(),
  prompt: z.string().max(65_536),
  options: z.array(HgwQuestionOptionSchema).max(64),
  multiple: z.boolean().optional(),
  custom: z.boolean().optional(),
})
export type HgwQuestion = z.infer<typeof HgwQuestionSchema>

/** `CreateElicitationRequest._meta.hgw`: lossless projection of the questions. */
export const HgwElicitationMetaSchema = readObject({
  requestId: IdentifierSchema,
  expiresAt: z.iso.datetime().optional(),
  questions: z.array(HgwQuestionSchema).min(1).max(64),
})

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

/** One published artifact; `ArtifactDescriptorSchema` in `./index` defines it. */
export const HgwArtifactDescriptorSchema = ArtifactDescriptorSchema
export type HgwArtifactDescriptor = ArtifactDescriptor

const ARTIFACT_URI_PREFIX = `${HGW_ARTIFACT_URI_SCHEME}//`

/**
 * The uri of the `resource_link` a published artifact is announced as. It
 * carries only the opaque artifact id: never a native path, and no route, since
 * the reader already knows the Session and listener it reads through.
 */
export function formatArtifactUri(artifactId: string) {
  return `${ARTIFACT_URI_PREFIX}${encodeURIComponent(artifactId)}`
}

/** The artifact id an `artifact://` uri names, or `undefined` for any other uri. */
export function parseArtifactUri(uri: string): string | undefined {
  if (!uri.startsWith(ARTIFACT_URI_PREFIX)) return undefined
  const encoded = uri.slice(ARTIFACT_URI_PREFIX.length)
  if (/[/?#]/u.test(encoded)) return undefined
  let artifactId: string
  try {
    artifactId = decodeURIComponent(encoded)
  } catch {
    return undefined
  }
  return IdentifierSchema.safeParse(artifactId).success ? artifactId : undefined
}

// ---------------------------------------------------------------------------
// extension notifications (agent → client)
// ---------------------------------------------------------------------------

/** `_hgw/composer_prefill` */
export const HgwComposerPrefillNotificationSchema = readObject({
  sessionId: IdentifierSchema,
  turnId: IdentifierSchema,
  text: z.string(),
})

/** `_hgw/error`: a failure with no request to answer, e.g. a rejected cancel. */
export const HgwErrorNotificationSchema = readObject({
  sessionId: IdentifierSchema.optional(),
  code: z.string().min(1).max(128),
  message: z.string().max(4096),
})

/**
 * The longest a request preview may be, in UTF-16 units, as zod's `.max`
 * counts; the push payload's `requestText` shares it.
 */
export const HGW_REQUEST_TEXT_MAX = 200

const ActivityBase = {
  agentId: IdentifierSchema,
  sessionId: IdentifierSchema,
  occurredAt: z.iso.datetime(),
  /** Re-sent on connect from what the gateway already holds, not just happened. */
  replayed: z.literal(true).optional(),
}

/**
 * `_hgw/activity`: workspace events for every Session the connection may
 * observe, in ids, times, and kinds. An attention request also carries a
 * one-line preview of what it asks, with credentials masked, and how many
 * questions follow it. Hydrated on connect from coordinator snapshots and the
 * session list, and those items are marked `replayed`.
 */
export const HgwActivityNotificationSchema = z.discriminatedUnion("type", [
  readObject({
    ...ActivityBase,
    type: z.enum(["turn-started", "turn-finished", "turn-failed"]),
    turnId: IdentifierSchema,
  }),
  readObject({
    ...ActivityBase,
    type: z.literal("attention-requested"),
    requestId: IdentifierSchema,
    attentionKind: z.enum(["question", "permission"]),
    requestText: z.string().min(1).max(HGW_REQUEST_TEXT_MAX).optional(),
    requestMore: z.number().int().min(1).optional(),
  }),
  readObject({
    ...ActivityBase,
    type: z.literal("attention-resolved"),
    requestId: IdentifierSchema,
  }),
  readObject({
    ...ActivityBase,
    type: z.literal("unread-changed"),
    unread: z.boolean(),
  }),
])
export type HgwActivityNotification = z.infer<
  typeof HgwActivityNotificationSchema
>
