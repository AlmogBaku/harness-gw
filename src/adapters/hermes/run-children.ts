/**
 * The child Sessions a Hermes turn delegates to.
 *
 * `delegate_task` runs each child as a Session of its own, stored under its
 * own id, while the delegating call is open. Hermes reports a child on the
 * parent's live Session only as `subagent.*` frames: `subagent.start` with its
 * goal and `subagent.complete` with its outcome, each carrying the child's
 * stored id (`tools/delegate_tool_progress.py` `_identity_kwargs`). A child's
 * own transcript reaches a client only through the watch mirror a lazy
 * `session.resume` of the child opens, which Hermes fills from that same
 * relayed progress (`tui_gateway/agent_callbacks.py`
 * `_mirror_subagent_to_child`): what the child did before the watch opened is
 * never mirrored, so its live transcript is thin and its history whole.
 */
import {
  ChildSessionStatus,
  StopReason,
  TurnEventKind,
  type OwnTurnEvent,
  type TokenUsage,
  type TurnEventOf,
} from "../../core/events"
import { publicReason } from "./native"
import { TURN_FAILURES } from "./run-failures"
import {
  boundedText,
  durationMs,
  nativeEvent,
  payloadOf,
  stableNativeId,
} from "./run-frames"
import type { ActiveTurn, ChildRun, TurnEngineHost } from "./run-state"
import { hermesToolKind, projectHermesToolCall, publicPath } from "./tool-data"

type ChildPatch = Omit<
  TurnEventOf<typeof TurnEventKind.ChildSessionUpdated>,
  "kind"
>

/** Hermes' lifecycle of a child (`SubagentStatus`), as the child's own state. */
const CHILD_STATUSES: Record<string, ChildSessionStatus> = {
  queued: ChildSessionStatus.Running,
  running: ChildSessionStatus.Running,
  completed: ChildSessionStatus.Idle,
  failed: ChildSessionStatus.Failed,
  error: ChildSessionStatus.Failed,
  timeout: ChildSessionStatus.Failed,
  interrupted: ChildSessionStatus.Cancelled,
}

/** How much of a goal's first line a child's title keeps. */
const MAX_TITLE_CHARS = 120

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function publicPaths(value: unknown) {
  return Array.isArray(value) ? value.filter(publicPath) : undefined
}

/** Drops what a report does not carry, so a patch restates only that. */
function present<T extends Record<string, unknown>>(fields: T) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as Partial<T>
}

/**
 * A child's goal as what it is shown by: the goal's first line as its title,
 * the whole goal as its description where it says more.
 */
function childTitles(goal: unknown) {
  const text = boundedText(goal)?.trim()
  if (!text) return {}
  const [line = ""] = text.split("\n", 1)
  const title =
    line.length > MAX_TITLE_CHARS
      ? `${line.slice(0, MAX_TITLE_CHARS - 1)}…`
      : line
  return { title, ...(title === text ? {} : { description: text }) }
}

/** What a `subagent.*` frame says of how its child stands. */
function childFacts(payload: Record<string, unknown>) {
  return present({
    status: CHILD_STATUSES[String(payload.status)],
    model: stableNativeId(payload.model),
    summary: boundedText(payload.summary),
    durationMs: durationMs(payload.duration_seconds),
    filesRead: publicPaths(payload.files_read),
    filesWritten: publicPaths(payload.files_written),
  })
}

/** The tokens a child spent, as the usage its own turn ends with. */
function childUsage(
  payload: Record<string, unknown>
): TokenUsage[] | undefined {
  const counts = present({
    inputTokens: count(payload.input_tokens),
    outputTokens: count(payload.output_tokens),
    reasoningTokens: count(payload.reasoning_tokens),
  })
  if (Object.keys(counts).length === 0) return undefined
  const model = stableNativeId(payload.model)
  return [{ ...(model ? { model } : {}), ...counts }]
}

/** The delegation still running last: Hermes runs children while it is open. */
function openDelegation(active: ActiveTurn) {
  let open: string | undefined
  for (const [toolCallId, tool] of active.tools)
    if (tool.name === "delegate_subagent" && !tool.ended) open = toolCallId
  return open
}

function childOf(active: ActiveTurn, childSessionId: string) {
  for (const child of active.children.values())
    if (child.childSessionId === childSessionId) return child
  return undefined
}

/**
 * One report of a child: on the turn for a child it spawned, in its parent's
 * stream for a child's child. Every report is also kept for a reload.
 */
function report(
  host: TurnEngineHost,
  active: ActiveTurn,
  child: ChildRun,
  patch: ChildPatch
) {
  // Whether a child stops alone is a fact of the live turn, not of its replay.
  const { cancellable, ...stored } = patch
  host.recordChild(active, stored, child.parent)
  const event = {
    kind: TurnEventKind.ChildSessionUpdated,
    ...stored,
    ...(cancellable === undefined ? {} : { cancellable }),
  } as const
  host.emit(
    active,
    child.parent === undefined
      ? event
      : {
          kind: TurnEventKind.ChildSessionEvent,
          childSessionId: child.parent,
          event,
        }
  )
}

/** One event of the child's own stream. */
function emitOwn(
  host: TurnEngineHost,
  active: ActiveTurn,
  child: ChildRun,
  event: OwnTurnEvent
) {
  host.emit(active, {
    kind: TurnEventKind.ChildSessionEvent,
    childSessionId: child.childSessionId,
    event,
  })
}

/** The one reply a child's mirrored stream carries. */
function replyId(child: ChildRun) {
  return `${child.childSessionId}:reply`
}

function startStream(
  host: TurnEngineHost,
  active: ActiveTurn,
  child: ChildRun
) {
  if (child.stream.started) return
  child.stream.started = true
  emitOwn(host, active, child, { kind: TurnEventKind.TurnStarted })
}

function appendText(
  host: TurnEngineHost,
  active: ActiveTurn,
  child: ChildRun,
  text: string
) {
  startStream(host, active, child)
  child.stream.text += text
  emitOwn(host, active, child, {
    kind: TurnEventKind.MessageChunk,
    messageId: replyId(child),
    text,
  })
}

/**
 * Ends the child's own stream once, closing its watch: as Hermes completed
 * it when the parent's frame says how, or as its mirror completed it.
 */
function endStream(
  host: TurnEngineHost,
  active: ActiveTurn,
  child: ChildRun,
  ending: {
    status?: ChildSessionStatus
    usage?: TokenUsage[]
    summary?: string
  } = {}
) {
  const { stream } = child
  if (stream.ended) return
  stream.ended = true
  child.stopWatch?.()
  child.stopWatch = undefined
  if (!stream.started) return
  // The mirror streams a reply only as the child relays it; one it never
  // relayed is the summary Hermes completed the child with.
  if (!stream.text && ending.summary)
    appendText(host, active, child, ending.summary)
  const stopped = ending.status === ChildSessionStatus.Cancelled
  for (const toolCallId of stream.tools)
    emitOwn(host, active, child, {
      kind: TurnEventKind.ToolCallFinished,
      toolCallId,
      output: JSON.stringify({ status: stopped ? "stopped" : "completed" }),
      failed: false,
    })
  stream.tools.clear()
  if (ending.status === ChildSessionStatus.Failed) {
    const { code, message } = TURN_FAILURES.turnFailed
    emitOwn(host, active, child, {
      kind: TurnEventKind.TurnFailed,
      code,
      message,
    })
    return
  }
  emitOwn(host, active, child, {
    kind: TurnEventKind.TurnEnded,
    stopReason: stopped ? StopReason.Cancelled : StopReason.EndTurn,
    ...(ending.usage ? { usage: ending.usage } : {}),
  })
}

/**
 * Opens the child's watch. A child Hermes cannot reach is followed without
 * one, so the caller logs the failure and goes on.
 */
async function watch(
  host: TurnEngineHost,
  active: ActiveTurn,
  child: ChildRun
) {
  const stop = await host.native.watchChild(
    active.scope,
    child.childSessionId,
    (event) => acceptChildFrame(host, active, child, event)
  )
  // The child, or the run, ended while its watch opened.
  if (child.stream.ended || active.terminal || active.detached) stop()
  else child.stopWatch = stop
}

/**
 * A `subagent.start` or `subagent.complete` on the parent's live Session. The
 * first report of a child announces it, under Hermes' stored id of the child,
 * before anything of its own; a report naming no stored id names no child.
 */
export function acceptSubagent(
  host: TurnEngineHost,
  active: ActiveTurn,
  type: string,
  payload: Record<string, unknown>
) {
  const subagentId = stableNativeId(payload.subagent_id)
  const childSessionId = stableNativeId(payload.child_session_id)
  if (!subagentId || !childSessionId) return
  const child =
    active.children.get(subagentId) ??
    announce(host, active, subagentId, childSessionId, payload)
  if (child?.childSessionId !== childSessionId) return
  if (type === "subagent.complete") complete(host, active, child, payload)
}

function announce(
  host: TurnEngineHost,
  active: ActiveTurn,
  subagentId: string,
  childSessionId: string,
  payload: Record<string, unknown>
) {
  // A child's id is its own: never another child's, nor its Session's.
  if (
    childSessionId === active.scope.providerSessionId ||
    childOf(active, childSessionId)
  )
    return undefined
  // Hermes counts a child the turn spawned as depth 0; a deeper one belongs to
  // the child named by `parent_id`, announced in that child's stream.
  const nested = (count(payload.depth) ?? 0) > 0
  const parent = nested
    ? active.children.get(stableNativeId(payload.parent_id) ?? "")
    : undefined
  if (nested && !parent) return undefined
  const child: ChildRun = {
    childSessionId,
    subagentId,
    ...(parent ? { parent: parent.childSessionId } : {}),
    done: false,
    stream: { started: false, text: "", tools: new Set(), ended: false },
  }
  active.children.set(subagentId, child)
  const toolCallId = parent ? undefined : openDelegation(active)
  const { model } = childFacts(payload)
  report(host, active, child, {
    childSessionId,
    ...(toolCallId ? { toolCallId } : {}),
    ...childTitles(payload.goal),
    status: ChildSessionStatus.Running,
    // `subagent.interrupt` stops a child the turn spawned, and its own
    // children with it, so only the first stops alone.
    cancellable: !parent,
    ...(model ? { model } : {}),
  })
  // Only a child the turn spawned is watched: Hermes relays no more than the
  // start and the end of a child's child.
  if (!parent)
    watch(host, active, child).catch((error: unknown) =>
      host.log.warn(
        { reason: publicReason(error) },
        "hermes.child.watch_failed"
      )
    )
  return child
}

function complete(
  host: TurnEngineHost,
  active: ActiveTurn,
  child: ChildRun,
  payload: Record<string, unknown>
) {
  if (child.done) return
  child.done = true
  const facts = childFacts(payload)
  report(host, active, child, {
    childSessionId: child.childSessionId,
    ...facts,
  })
  endStream(host, active, child, {
    ...(facts.status ? { status: facts.status } : {}),
    ...(facts.summary ? { summary: facts.summary } : {}),
    ...present({ usage: childUsage(payload) }),
  })
}

/**
 * One frame of a child's watch, as an event of the child's own stream. The
 * mirror carries the reply the child relays, its calls with no arguments or
 * results, and the completion; its reasoning is Hermes' spinner text, which
 * no turn of this gateway reads as thought.
 */
export function acceptChildFrame(
  host: TurnEngineHost,
  active: ActiveTurn,
  child: ChildRun,
  value: unknown
) {
  if (active.terminal || active.detached || child.stream.ended) return
  const event = nativeEvent(value)
  if (!event) return
  const payload = payloadOf(event)
  const { stream } = child
  switch (event.type) {
    case "message.start":
      return startStream(host, active, child)
    case "message.delta": {
      const text = boundedText(payload.text)
      if (text) appendText(host, active, child, text)
      return
    }
    case "tool.start": {
      const toolCallId = stableNativeId(payload.tool_id)
      const nativeName = stableNativeId(payload.name)
      if (!toolCallId || !nativeName || stream.tools.has(toolCallId)) return
      startStream(host, active, child)
      stream.tools.add(toolCallId)
      const { toolName, args } = projectHermesToolCall(nativeName, {})
      emitOwn(host, active, child, {
        kind: TurnEventKind.ToolCallStarted,
        toolCallId,
        title: toolName,
        name: toolName,
        toolKind: hermesToolKind(toolName),
        parentMessageId: replyId(child),
      })
      emitOwn(host, active, child, {
        kind: TurnEventKind.ToolCallInputChunk,
        toolCallId,
        delta: JSON.stringify(args),
      })
      emitOwn(host, active, child, {
        kind: TurnEventKind.ToolCallInputEnded,
        toolCallId,
      })
      return
    }
    case "tool.complete": {
      const toolCallId = stableNativeId(payload.tool_id)
      if (!toolCallId || !stream.tools.delete(toolCallId)) return
      emitOwn(host, active, child, {
        kind: TurnEventKind.ToolCallFinished,
        toolCallId,
        output: JSON.stringify({ status: "completed" }),
        failed: false,
      })
      return
    }
    case "message.complete": {
      // The completion's text is the child's summary, cut short: only what
      // continues the streamed reply is new.
      const text = boundedText(payload.text)
      if (text && text.startsWith(stream.text))
        if (text.length > stream.text.length)
          appendText(host, active, child, text.slice(stream.text.length))
      endStream(host, active, child)
      return
    }
  }
}

/**
 * Stops the work of one child the turn spawned through `subagent.interrupt`
 * on the parent's live Session; the child's completion confirms it. A child's
 * child stops with its parent, and one already over has nothing to stop.
 */
export async function stopChild(
  host: TurnEngineHost,
  active: ActiveTurn,
  childSessionId: string
) {
  const child = childOf(active, childSessionId)
  if (!child || child.parent !== undefined || child.done) return
  await host.native.interruptChild(active.liveSessionId, child.subagentId)
}

/** Closes every watch the run holds open: nothing reads its frames any more. */
export function releaseChildren(active: ActiveTurn) {
  for (const child of active.children.values()) {
    child.stopWatch?.()
    child.stopWatch = undefined
  }
}
