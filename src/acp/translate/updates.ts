import type {
  ContentBlock,
  SessionUpdate,
  ToolCallContent,
  ToolCallUpdate,
  Usage,
} from "@agentclientprotocol/sdk/experimental/v2"
import type { z } from "zod"

import {
  HGW_META_KEY,
  HGW_PLAN_ID,
  HgwPlanMetaSchema,
  type HgwArtifactDescriptor,
  type HgwChunkMetaSchema,
  type HgwStateMetaSchema,
  type HgwToolCallMetaSchema,
  formatArtifactUri,
} from "../../../protocol/acp"
import type { AcpOutbound, Built, TranslateContext } from "../types"
import { StopReason, type ToolDiff } from "../../core/events"
import { maskCredentials, maskJson } from "../../redaction"

/**
 * The `session/update` values the gateway emits, each carrying the `_meta.hgw`
 * its schema in `protocol/acp.ts` defines. Run translation and history replay
 * share these builders so one Session speaks one vocabulary.
 */

/** Session Todo status → plan entry status; `failed` has no ACP spec peer. */
const PLAN_STATUS = {
  pending: "pending",
  active: "in_progress",
  completed: "completed",
  failed: "_failed",
} as const

export const TodosSchema = HgwPlanMetaSchema.shape.todos
type SessionTodos = z.infer<typeof TodosSchema>

export function turnMeta(context: TranslateContext) {
  return { sequence: context.sequence, turnId: context.turnId }
}

export function update(value: Built<SessionUpdate>): AcpOutbound {
  return { kind: "update", update: value }
}

/** What a builder adds to the turn meta every update carries. */
type ExtraMeta<Schema extends z.ZodObject> = Omit<
  z.input<Schema>,
  "sequence" | "turnId"
>

/** A stop reason ACP names, or a `_`-prefixed one the gateway owns. */
type IdleStopReason = (typeof ACP_STOP_REASON)[StopReason] | `_${string}`

/**
 * `at` says when the state took effect: a live run reads the clock, and a replay
 * passes the time the transcript recorded, so a turn's span is the same whether
 * the browser watched it or reloaded onto it.
 */
export function stateOutbound(
  context: TranslateContext,
  state:
    | { state: "running" }
    | { state: "requires_action" }
    | { state: "idle"; stopReason: IdleStopReason; usage?: Usage },
  extra?: ExtraMeta<typeof HgwStateMetaSchema>
): AcpOutbound {
  const at = extra?.at ?? new Date(context.now?.() ?? Date.now()).toISOString()
  return update({
    sessionUpdate: "state_update",
    ...state,
    _meta: { [HGW_META_KEY]: { ...turnMeta(context), ...extra, at } },
  })
}

/** A streamed delta, or the whole block a stored part replays as. */
export function chunkOutbound(
  context: TranslateContext,
  sessionUpdate:
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "user_message_chunk",
  messageId: string,
  content: string | Built<ContentBlock>,
  extra?: ExtraMeta<typeof HgwChunkMetaSchema>
): AcpOutbound {
  return update({
    sessionUpdate,
    messageId,
    content:
      typeof content === "string" ? { type: "text", text: content } : content,
    _meta: { [HGW_META_KEY]: { ...turnMeta(context), ...extra } },
  })
}

/**
 * A published artifact as a `resource_link` chunk on the turn it belongs to.
 * The link names only the artifact; the reader fetches it through the Session
 * it already reads.
 */
export function artifactOutbound(
  context: TranslateContext,
  sessionUpdate: "agent_message_chunk" | "user_message_chunk",
  messageId: string,
  artifact: HgwArtifactDescriptor
): AcpOutbound {
  return chunkOutbound(context, sessionUpdate, messageId, {
    type: "resource_link",
    uri: formatArtifactUri(artifact.id),
    name: artifact.filename,
    ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType }),
    ...(artifact.sizeBytes === undefined ? {} : { size: artifact.sizeBytes }),
  })
}

type ToolMeta = Omit<ExtraMeta<typeof HgwToolCallMetaSchema>, "messageId">

/**
 * The most text one tool field carries, which is also the most a browser keeps
 * of a terminal: a longer one is cut before it is masked, so one huge output
 * costs the masker no more than this.
 */
const MAX_TOOL_TEXT = 262_144

/** The first, or for a terminal the last, `MAX_TOOL_TEXT` units of `text`. */
function bounded(text: string, keep: "head" | "tail") {
  if (text.length <= MAX_TOOL_TEXT) return text
  return keep === "head"
    ? text.slice(0, MAX_TOOL_TEXT)
    : text.slice(-MAX_TOOL_TEXT)
}

/** Text that reads as a JSON object, array, or string, parsed; anything else `undefined`. */
function parsedJson(text: string): unknown {
  if (!/^\s*[[{"]/u.test(text)) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * A tool's text as it may leave the gateway, for every runtime alike. JSON is
 * masked by key and value and sent as written when nothing in it was a
 * credential; any other text is masked broadly. Either is then bounded.
 */
export function maskedToolText(text: string, keep: "head" | "tail" = "head") {
  const json = parsedJson(text)
  if (json === undefined) return maskCredentials(bounded(text, keep))
  const masked = maskJson(json)
  return bounded(masked === json ? text : JSON.stringify(masked), keep)
}

/** A tool call update's every field a reader sees, masked as tool data. */
function maskedCall(call: Omit<Built<ToolCallUpdate>, "_meta">) {
  const { title, rawInput, rawOutput, content } = call
  return {
    ...call,
    ...(typeof title === "string" ? { title: maskedToolText(title) } : {}),
    ...(rawInput === undefined ? {} : { rawInput: maskJson(rawInput) }),
    ...(rawOutput === undefined
      ? {}
      : {
          rawOutput:
            typeof rawOutput === "string"
              ? maskedToolText(rawOutput)
              : maskJson(rawOutput),
        }),
    ...(content
      ? {
          content: content.map((item) =>
            item.type === "content" ? maskedStreamed(item) : item
          ),
        }
      : {}),
  }
}

/** A tool call's meta with its arguments text masked. */
function maskedMeta(extra: ToolMeta | undefined) {
  if (!extra) return {}
  const { argsText, argsTextDelta } = extra
  return {
    ...extra,
    ...(argsText === undefined ? {} : { argsText: maskedToolText(argsText) }),
    ...(argsTextDelta === undefined
      ? {}
      : { argsTextDelta: maskedToolText(argsTextDelta) }),
  }
}

/**
 * One tool call update, live or replayed, for any runtime: every text a reader
 * sees is masked here, the one place each runtime's tool data passes on its
 * way to a browser. A path or a patch a mask would break is the adapter's to
 * drop, since only it knows which of its fields name a file.
 */
export function toolOutbound(
  context: TranslateContext,
  messageId: string,
  call: Omit<Built<ToolCallUpdate>, "_meta">,
  extra?: ToolMeta
): AcpOutbound {
  return update({
    sessionUpdate: "tool_call_update",
    ...maskedCall(call),
    _meta: {
      [HGW_META_KEY]: { ...turnMeta(context), messageId, ...maskedMeta(extra) },
    },
  })
}

/** What a call streams into its content: text, or the terminal it runs. */
type StreamedContent = Built<
  Extract<ToolCallContent, { type: "content" } | { type: "terminal" }>
>

/** A streamed item with its text masked; a terminal carries none. */
function maskedStreamed<Content extends StreamedContent>(
  content: Content
): Content {
  return content.type === "content" && content.content.type === "text"
    ? {
        ...content,
        content: {
          ...content.content,
          text: maskedToolText(content.content.text),
        },
      }
    : content
}

/** Appends one item to a call's content; `tool_call_update` replaces it all. */
export function toolContentOutbound(
  context: TranslateContext,
  messageId: string,
  toolCallId: string,
  content: StreamedContent
): AcpOutbound {
  return update({
    sessionUpdate: "tool_call_content_chunk",
    toolCallId,
    content: maskedStreamed(content),
    _meta: { [HGW_META_KEY]: { ...turnMeta(context), messageId } },
  })
}

/** The one plan a Session carries: its Todos, kept losslessly in `_meta.hgw`. */
export function planUpdate(
  todos: SessionTodos,
  meta: { sequence: number; turnId?: string }
): Built<SessionUpdate> {
  return {
    sessionUpdate: "plan_update",
    plan: {
      type: "items",
      planId: HGW_PLAN_ID,
      entries: todos.map((todo) => ({
        content: todo.label,
        priority: "medium",
        status: PLAN_STATUS[todo.status],
      })),
    },
    _meta: { [HGW_META_KEY]: { ...meta, todos } },
  }
}

/** The ACP stop reason for each domain one. */
export const ACP_STOP_REASON = {
  [StopReason.EndTurn]: "end_turn",
  [StopReason.MaxTokens]: "max_tokens",
  [StopReason.MaxTurnRequests]: "max_turn_requests",
  [StopReason.Refusal]: "refusal",
  [StopReason.Cancelled]: "cancelled",
} as const satisfies Record<StopReason, string>

/** A call's text output as ACP tool content. */
export function textContent(text: string): StreamedContent {
  return { type: "content", content: { type: "text", text } }
}

/**
 * A settled call's output as the text its content shows, live and stored
 * alike: a string as itself, any other value as its JSON.
 */
export function outputContent(output: unknown): Built<ToolCallContent> {
  return textContent(
    typeof output === "string" ? output : JSON.stringify(output)
  )
}

/** A call's changed files and patch as ACP diff content. */
export function diffContent({
  changes,
  patch,
}: ToolDiff): Built<ToolCallContent> {
  return {
    type: "diff",
    changes,
    ...(patch === undefined
      ? {}
      : { patch: { format: "git_patch", text: patch } }),
  }
}
