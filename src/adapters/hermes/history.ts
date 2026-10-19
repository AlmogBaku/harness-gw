import type {
  SessionChildActivityMessage,
  SessionCompactionActivityMessage,
  SessionMessage,
} from "../../../protocol"
import type { McpToolNameResolver } from "../../core/aos-tool-names"
import { StopReason } from "../../core/events"
import type { SessionNotice } from "../../core/member"
import type { JsonValue } from "../json-value"
import {
  isRecord as isNativeRecord,
  rowText,
  timestamp,
  timestampMs,
  trimmedText,
  utf8BytesWithin,
} from "./native"
import {
  projectHermesAttachedImages,
  projectHermesMediaText,
  type HermesMediaOptions,
} from "./media-artifacts"
import { classifyHermesRow } from "./scaffolding"
import {
  canonicalToolName,
  hermesToolDiffs,
  hermesToolKind,
  hermesToolLocations,
  projectHermesToolCall,
  projectHermesToolOutcome,
} from "./tool-data"

type JsonRecord = Record<string, JsonValue>
type MessagePart = SessionMessage["content"][number]
function isRecord(value: unknown): value is JsonRecord {
  return isNativeRecord(value)
}

/**
 * A strict, unbounded JSON copy of a stored row. Not `publicJsonValue`: its
 * size limits would drop the image data URLs a row's content carries.
 */
function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const values = value.map(jsonValue)
    return values.some((item) => item === undefined)
      ? undefined
      : (values as JsonValue[])
  }
  if (!isRecord(value)) return undefined
  const output: JsonRecord = {}
  for (const [key, item] of Object.entries(value)) {
    const projected = jsonValue(item)
    if (projected === undefined) return undefined
    output[key] = projected
  }
  return output
}

/**
 * Row content parser: unlike `native.parseJson` this projects the decoded value
 * into the strict `JsonValue` the public history shape accepts, and keeps the
 * raw string when a row's content is not JSON at all.
 */
function parseRowJson(value: unknown): JsonValue | undefined {
  if (typeof value !== "string") return jsonValue(value)
  try {
    return jsonValue(JSON.parse(value) as unknown)
  } catch {
    return value
  }
}

function imageSource(value: unknown) {
  const image = isRecord(value) ? value.url : value
  if (typeof image !== "string") return undefined
  return /^(?:data:image\/(?:png|jpeg|gif|webp|bmp);base64,|\/api\/v1\/)/u.test(
    image
  )
    ? image
    : undefined
}

const HERMES_CONTEXT_MARKER =
  /(?:^|\n)--- (?:Attached Context|Context Warnings) ---[^\n]*(?:\n|$)/u
const HERMES_FILE_REFERENCE =
  /^@file:(?:`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))$/u
const SAFE_MIME =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u

function safeAttachmentName(reference: string) {
  const path = reference.match(HERMES_FILE_REFERENCE)?.slice(1).find(Boolean)
  const name = path?.split(/[\\/]/u).at(-1)
  const hasControlCharacter = [...(name ?? "")].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  return name &&
    utf8BytesWithin(name, 255) !== undefined &&
    !hasControlCharacter &&
    name !== "." &&
    name !== ".."
    ? name
    : undefined
}

function attachmentMime(context: string, reference: string) {
  const line = context
    .split(/\r?\n/u)
    .find((candidate) => candidate.includes(reference))
  const mime = line
    ?.slice(line.indexOf(reference) + reference.length)
    .match(/^\s+\(([^,\s()]+),/u)?.[1]
  return mime && SAFE_MIME.test(mime) ? mime : undefined
}

function projectHermesFileReferences(text: string, messageId: string) {
  const marker = text.match(HERMES_CONTEXT_MARKER)
  if (!marker || marker.index === undefined) return { text }
  const context = text.slice(marker.index)
  const lines = text.slice(0, marker.index).trimEnd().split(/\r?\n/u)
  const references: string[] = []
  while (lines.length > 0) {
    const candidate = lines.at(-1)?.trim() ?? ""
    if (!HERMES_FILE_REFERENCE.test(candidate)) break
    references.unshift(candidate)
    lines.pop()
  }
  const attachments = references.flatMap((reference, index) => {
    const name = safeAttachmentName(reference)
    if (!name) return []
    const contentType = attachmentMime(context, reference)
    return [
      {
        id: `${messageId}:attachment:${index}`,
        type: "file" as const,
        name,
        ...(contentType ? { contentType } : {}),
        status: { type: "complete" as const },
        content: [],
      },
    ]
  })
  return { text: lines.join("\n").trim(), attachments }
}

/**
 * What a durable user row shows: the prose the operator wrote, the files they
 * referenced, and the images they attached. Hermes persists both kinds as
 * directive text, so neither survives as prose — an attached image becomes the
 * same opaque artifact part a published one travels as.
 */
function projectHermesUserContent(text: string, messageId: string) {
  const attached = projectHermesAttachedImages(text)
  return {
    ...projectHermesFileReferences(attached.text, messageId),
    artifacts: attached.artifacts.map(({ descriptor }) => ({
      type: "data" as const,
      name: "hgw.artifact",
      data: descriptor,
    })),
  }
}

/**
 * How a stored assistant row's model call finished, where it ends a turn. A
 * `tool_calls` row, or one a stop gate reopened, leaves the turn running.
 */
const STOP_REASONS: Record<string, StopReason> = {
  stop: StopReason.EndTurn,
  length: StopReason.MaxTokens,
  content_filter: StopReason.Refusal,
}

/**
 * The boundary rows `agent/turn_failure_copy.py` has Hermes append when a turn
 * ends with no assistant reply of its own. Hermes writes them for a stopped
 * turn and a failed one alike, so a failure reads as stopped once reloaded.
 */
const FAILED_TURN_NOTICES: readonly string[] = [
  "Your request was not processed. Send it again if you still want me to carry it out.",
  "This turn did not complete. Some actions may already have run; verify their effects before resending.",
]

/**
 * The row Hermes appends when a stopped turn's tail is a tool result:
 * `agent/message_sanitization.py` `close_interrupted_tool_sequence` writes the
 * turn's interrupt text, or a bare "Operation interrupted.", as an assistant
 * row with no model call behind it, so no `finish_reason`. A failed-turn notice
 * closes a turn the same way. Either is Hermes' record that the turn ended
 * early, not assistant prose.
 */
function isInterruptMarker(value: JsonRecord, text: string): boolean {
  return (
    value.finish_reason == null &&
    !(Array.isArray(value.tool_calls) && value.tool_calls.length > 0) &&
    (text.startsWith("Operation interrupted") ||
      FAILED_TURN_NOTICES.includes(text.trim()))
  )
}

/** The id history gives the message a durable row opens. */
export function hermesRowMessageId(rowId: number) {
  return `hermes-row-${rowId}`
}

/**
 * The id of a turn's `count`-th compaction, named after the message its turn
 * opened with. Hermes names neither the compaction nor the summary carrier it
 * stores while the turn runs, but it does name the prompt's row on admission,
 * so live and history agree on this one where they agree on the turn's
 * messages.
 */
export function hermesCompactionId(turnBase: string, count: number) {
  return `${turnBase}:compaction:${count}`
}

/** A stored row of Session activity the projection places among messages. */
export type HermesActivityMessage =
  | SessionCompactionActivityMessage
  | SessionChildActivityMessage

/** What the projection makes of durable rows: messages and activity. */
export type HermesHistoryMessage = SessionMessage | HermesActivityMessage

/**
 * The messages with each activity row placed after the `before` messages that
 * preceded it, in the order the rows were read.
 */
function interleaved(
  messages: readonly SessionMessage[],
  activities: readonly { before: number; message: HermesActivityMessage }[]
): HermesHistoryMessage[] {
  // A row read later can still belong after an earlier message, as a call of
  // a reply its later rows continue does; the sort is stable.
  const ordered = [...activities].sort((a, b) => a.before - b.before)
  const placed: HermesHistoryMessage[] = []
  let next = 0
  messages.forEach((message, index) => {
    while (next < ordered.length && ordered[next]!.before <= index)
      placed.push(ordered[next++]!.message)
    placed.push(message)
  })
  for (; next < ordered.length; next += 1) placed.push(ordered[next]!.message)
  return placed
}

/**
 * The index of the oldest row that opens a turn: the first user row the
 * projection opens a turn at, prompt or automation. `-1` when the rows hold no
 * turn start.
 */
export function hermesTurnStart(rows: readonly unknown[]) {
  return rows.findIndex((value) => {
    if (!isRecord(value) || trimmedText(value.role) !== "user") return false
    const { kind } = classifyHermesRow(
      value,
      rowText(value, parseRowJson(value.content))
    )
    return kind === "prompt" || kind === "automation"
  })
}

/** The notice an automation turn's first message leads with, if it has one. */
function leadOf(
  opening: { notice?: SessionNotice } | undefined
): MessagePart[] {
  const notice = opening?.notice
  return notice ? [{ type: "data", name: "hgw-notice", data: notice }] : []
}

/**
 * A reply `session.branch` copied into its fork: Hermes copies a reply's text
 * alone, without the calls or the `finish_reason` of the model call that made
 * it (`tui_gateway/methods_session.py` `_BRANCH_COPY_FIELDS`), so nothing but
 * the row itself bounds the response it was.
 */
function isCopiedReply(value: JsonRecord, prose: boolean) {
  return (
    prose &&
    value.finish_reason == null &&
    !(Array.isArray(value.tool_calls) && value.tool_calls.length > 0)
  )
}

/**
 * Converts provider-native durable rows into the strict public history shape.
 * `branched`: the rows are a fork's, whose copied replies each stand alone.
 * `children`: the child Sessions a call spawned, each placed after the message
 * that made the call.
 */
export function projectHermesHistory(
  rows: readonly unknown[],
  resolve?: McpToolNameResolver,
  media: HermesMediaOptions = {},
  {
    branched = false,
    children,
  }: {
    branched?: boolean
    children?: (toolCallId: string) => readonly SessionChildActivityMessage[]
  } = {}
): HermesHistoryMessage[] {
  const messages: SessionMessage[] = []
  /** Activity rows, each after the messages that preceded it. */
  const activities: { before: number; message: HermesActivityMessage }[] = []
  const calls = new Map<string, { messageIndex: number; partIndex: number }>()
  /** The media each turn's calls returned, keyed by the turn's first row. */
  const mediaReferences = new Map<number, Set<string>>()
  /** The newest row time each merged message was built from, in epoch ms. */
  const completions = new Map<number, number>()
  /**
   * The turn the rows are in: the prompt row its model responses number from,
   * as live numbers them, and how many it opened. Rows before any prompt keep
   * their own row ids.
   */
  let turn: {
    base?: string
    responses: number
    index: number
    /** The summary carriers read since the turn opened. */
    compactions: number
  } = { responses: 0, index: -1, compactions: 0 }
  /** The model response the next assistant row may continue. */
  let response: number | undefined
  /** A call finished since that response opened. */
  let toolSince = false
  /** The automation row whose turn no message has opened yet. */
  let automated: { notice?: SessionNotice } | undefined

  /** A message spans every row that patched into it, so its end is their newest. */
  function contributed(messageIndex: number, row: JsonRecord) {
    const ms = timestampMs(row.timestamp ?? row.created_at)
    if (ms === undefined) return
    const newest = completions.get(messageIndex)
    if (newest === undefined || ms > newest) completions.set(messageIndex, ms)
  }

  /** Keeps every open call of one turn addressing its part after an insertion. */
  function shifted(messageIndex: number, afterPartIndex: number, by: number) {
    for (const [id, call] of calls)
      if (call.messageIndex === messageIndex && call.partIndex > afterPartIndex)
        calls.set(id, { ...call, partIndex: call.partIndex + by })
  }

  rows.forEach((value, index) => {
    if (!isRecord(value)) return
    const role = trimmedText(value.role)
    if (role === "tool") {
      if (trimmedText(value.display_kind)) return
      const toolCallId = trimmedText(value.tool_call_id ?? value.toolCallId)
      const target = toolCallId ? calls.get(toolCallId) : undefined
      if (!toolCallId || !target) return
      const message = messages[target.messageIndex]
      const part = message?.content[target.partIndex]
      if (
        !message ||
        message.role !== "assistant" ||
        part?.type !== "tool-call"
      )
        return
      const resultToolName = trimmedText(value.tool_name ?? value.toolName)
      const toolName = resultToolName
        ? canonicalToolName(resultToolName, resolve)
        : part.toolName
      const outcome = projectHermesToolOutcome(
        toolCallId,
        toolName,
        value.content ?? value.result,
        value.is_error === true,
        media
      )
      const diffs = outcome.isError
        ? undefined
        : hermesToolDiffs(toolName, value.content ?? value.result)
      const content = [...message.content]
      content[target.partIndex] = {
        ...part,
        ...(resultToolName ? { toolName, kind: hermesToolKind(toolName) } : {}),
        // A Hermes that hosts views keeps a view's call on its tool row.
        ...(isRecord(value.display_metadata) &&
        isRecord(value.display_metadata.mcp_app)
          ? { app: true as const }
          : {}),
        result: outcome.result,
        ...(outcome.isError ? { isError: true } : {}),
        ...(diffs ? { diffs } : {}),
      }
      // Live publishes an artifact the moment its tool result lands, so the
      // stored turn places it there too rather than at the turn's end.
      if (outcome.parts.length > 0) {
        content.splice(target.partIndex + 1, 0, ...outcome.parts)
        shifted(target.messageIndex, target.partIndex, outcome.parts.length)
      }
      if (outcome.trustedMedia.length) {
        const trusted = mediaReferences.get(turn.index) ?? new Set()
        for (const reference of outcome.trustedMedia) trusted.add(reference)
        mediaReferences.set(turn.index, trusted)
      }
      messages[target.messageIndex] = { ...message, content }
      contributed(target.messageIndex, value)
      toolSince = true
      return
    }

    if (role !== "user" && role !== "assistant" && role !== "system") return
    const rowId = value.row_id ?? value._row_id
    const rowMessageId =
      typeof rowId === "number" && Number.isSafeInteger(rowId) && rowId > 0
        ? hermesRowMessageId(rowId)
        : typeof value.id === "number" &&
            Number.isSafeInteger(value.id) &&
            value.id > 0
          ? hermesRowMessageId(value.id)
          : (trimmedText(value.id) ?? `hermes-history-${index}`)
    // A summary carrier is where Hermes compacted the context: it is stored as
    // that compaction, with no summary because no live compaction carries one,
    // and whatever the carrier still shows follows it.
    if (value._compressed_summary === true) {
      turn.compactions += 1
      activities.push({
        before: messages.length,
        message: {
          id: rowMessageId,
          role: "activity",
          activityType: "COMPACTION",
          content: {
            compactionId:
              turn.base === undefined
                ? rowMessageId
                : hermesCompactionId(turn.base, turn.compactions),
          },
        },
      })
    }
    const rawContent = parseRowJson(value.content)
    // `rowText` only reads Hermes' display projection on a persisted compaction
    // carrier, so provider-only fields cannot replace a Session's durable
    // transcript content. The artifact reader derives a row's text the same way,
    // so an attachment it resolves is the one the operator was shown.
    const row = classifyHermesRow(value, rowText(value, rawContent))
    // A hidden row neither splits the reply around it nor shifts its id.
    if (row.kind === "skip") return
    const text = row.text
    const interrupted = role === "assistant" && isInterruptMarker(value, text)
    const correction = row.kind === "correction"
    if (role !== "assistant") {
      response = undefined
      if (role === "user" && !correction) {
        turn = { base: rowMessageId, responses: 0, index, compactions: 0 }
        toolSince = false
        automated = undefined
      }
    }
    // An automation row opens its turn but shows nothing of its own: the
    // turn's first message opens it in the thread, led by its notice.
    if (row.kind === "automation") {
      automated = row.notice ? { notice: row.notice } : {}
      return
    }
    const userContent =
      role === "user" ? projectHermesUserContent(text, rowMessageId) : undefined
    const assistantContent =
      role === "assistant" && !interrupted
        ? projectHermesMediaText(
            text,
            mediaReferences.get(turn.index) ?? [],
            media
          )
        : undefined
    const visibleText = interrupted
      ? ""
      : (assistantContent?.text ?? userContent?.text ?? text)
    const reasoning =
      role === "assistant"
        ? (trimmedText(value.reasoning_content) ?? trimmedText(value.reasoning))
        : undefined
    // A model response is known by what it streams, as live knows it: prose
    // or thought after one of its calls finished is the next response.
    const prose = Boolean(
      reasoning || visibleText || assistantContent?.artifacts.length
    )
    const previousAssistant =
      role === "assistant" &&
      response !== undefined &&
      !(toolSince && prose) &&
      !(branched && isCopiedReply(value, prose))
        ? messages[response]
        : undefined
    let id = rowMessageId
    /** The automation turn this row's first new message opens. */
    let opening =
      role === "assistant" && !previousAssistant ? automated : undefined
    if (opening) automated = undefined
    if (role === "assistant" && !previousAssistant) {
      turn.responses += 1
      toolSince = false
      if (turn.base !== undefined) id = `${turn.base}-${turn.responses}`
      // A thought is its own message, ahead of the response it leads to.
      if (reasoning) {
        messages.push({
          id: `${id}-thought`,
          role,
          content: [...leadOf(opening), { type: "reasoning", text: reasoning }],
          createdAt: timestamp(value.timestamp ?? value.created_at, index),
          ...(opening ? { opensTurn: true as const } : {}),
        })
        opening = undefined
      }
    } else if (reasoning && previousAssistant) {
      // Live keeps thought only ahead of a response's prose.
      const thought = messages[response! - 1]
      if (
        thought?.id === `${previousAssistant.id}-thought` &&
        !previousAssistant.content.some((part) => part.type === "text")
      )
        messages[response! - 1] = {
          ...thought,
          content: [...thought.content, { type: "reasoning", text: reasoning }],
        }
    }
    const messageIndex = previousAssistant ? response! : messages.length
    if (role === "assistant") response = messageIndex
    const content = previousAssistant
      ? [...previousAssistant.content]
      : leadOf(opening)
    if (visibleText) content.push({ type: "text", text: visibleText })
    // Live publishes a MEDIA line's artifact as the line streams past, once per
    // reference however many rows of the turn repeat it.
    for (const { descriptor } of assistantContent?.artifacts ?? [])
      if (
        !content.some(
          (part) =>
            part.type === "data" &&
            isRecord(part.data) &&
            part.data.id === descriptor.id
        )
      )
        content.push({ type: "data", name: "hgw.artifact", data: descriptor })
    // A row that persisted its image's directive as well as its bytes shows the
    // directive's Artifact, the one its live echo showed; the inline copy would
    // only repeat it.
    const artifacts = userContent?.artifacts ?? []
    for (const artifact of artifacts) content.push(artifact)
    if (role === "user" && artifacts.length === 0 && Array.isArray(rawContent))
      for (const part of rawContent) {
        const image =
          isRecord(part) && part.type === "image_url"
            ? imageSource(part.image_url)
            : undefined
        if (image) content.push({ type: "image", image })
      }
    if (role === "assistant" && Array.isArray(value.tool_calls)) {
      for (const rawCall of value.tool_calls) {
        if (!isRecord(rawCall)) continue
        const fn = isRecord(rawCall.function) ? rawCall.function : undefined
        const toolCallId = trimmedText(rawCall.id)
        const nativeToolName = fn && trimmedText(fn.name)
        if (!toolCallId || !nativeToolName) continue
        const { toolName, args } = projectHermesToolCall(
          nativeToolName,
          fn?.arguments,
          resolve
        )
        const partIndex = content.length
        const locations = hermesToolLocations(toolName, args)
        content.push({
          type: "tool-call",
          toolCallId,
          toolName,
          args,
          argsText: JSON.stringify(args),
          kind: hermesToolKind(toolName),
          ...(locations ? { locations } : {}),
        })
        calls.set(toolCallId, { messageIndex, partIndex })
        for (const child of children?.(toolCallId) ?? [])
          activities.push({ before: messageIndex + 1, message: child })
      }
    }
    // Only an assistant message spans more than one row, so only its end is
    // worth recording: every other role completed where it was created.
    if (role === "assistant") contributed(messageIndex, value)
    // A message's newest row says how it stopped.
    const stopReason = interrupted
      ? StopReason.Cancelled
      : role === "assistant"
        ? STOP_REASONS[String(value.finish_reason)]
        : undefined
    if (previousAssistant) {
      const merged: SessionMessage = { ...previousAssistant, content }
      if (stopReason) merged.stopReason = stopReason
      else delete merged.stopReason
      messages[messageIndex] = merged
    } else {
      messages.push({
        id,
        role,
        content,
        createdAt: timestamp(value.timestamp ?? value.created_at, index),
        ...(stopReason ? { stopReason } : {}),
        ...(userContent?.attachments?.length
          ? { attachments: userContent.attachments }
          : {}),
        // The same turn the journal acknowledges as `aos.steer.accepted`: the
        // flag lets a from-start replay announce it once.
        ...(correction ? { correction: true as const } : {}),
        ...(opening ? { opensTurn: true as const } : {}),
      })
    }
  })
  // Stamped last because the rows that finish an assistant turn arrive after the
  // row that opened it.
  const stamped = messages.map((message, index) => {
    const ms = completions.get(index)
    return ms === undefined
      ? message
      : { ...message, completedAt: new Date(ms).toISOString() }
  })
  return interleaved(stamped, activities)
}

/** Every raw tool name the rows carry, so their MCP names load before projection. */
export function hermesHistoryToolNames(rows: readonly unknown[]) {
  const names = new Set<string>()
  for (const row of rows) {
    if (!isRecord(row)) continue
    const resultName = trimmedText(row.tool_name ?? row.toolName)
    if (resultName) names.add(resultName)
    if (!Array.isArray(row.tool_calls)) continue
    for (const call of row.tool_calls) {
      const name =
        isRecord(call) && isRecord(call.function)
          ? trimmedText(call.function.name)
          : undefined
      if (name) names.add(name)
    }
  }
  return names
}
