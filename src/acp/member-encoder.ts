import {
  methods,
  RequestError,
  SessionUpdate,
  StateUpdate,
  type AgentContext,
  type CreateElicitationResponse,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2"

import type { SessionContextResponse } from "../../protocol"
import {
  HGW_METHODS,
  HGW_META_KEY,
  HgwStateMetaSchema,
  type HgwActivityNotification,
  type HgwNoticeMeta,
} from "../../protocol/acp"
import {
  PendingRequestKind,
  TurnEventKind,
  type PendingRequest,
  type TurnEventOf,
} from "../core/events"
import {
  unhandledKind,
  type MemberConnection,
  type MemberEvent,
  type SessionNotice,
  type TurnStream,
  type WorkspaceEvent,
} from "../core/member"
import type { SessionRow } from "../core/session-rows"
import { sessionInfoMeta } from "./agent-sessions"
import { promptBlocks } from "./prompt-content"
import { answeredQuestionOutbound } from "./translate/requests"
import {
  initialTranslateState,
  type AcpConnectionContext,
  type AcpOutbound,
  type TranslateContext,
  type TranslateState,
  type WorkspaceCapabilities,
} from "./types"

/**
 * Writes one connection's member events as ACP: `session/update` and `_hgw/*`
 * notifications, and the server→client requests a paused turn asks. It builds
 * every ACP update from the event alone, and hands each reply back undecoded,
 * so it reaches neither a membership nor the runtime. The translators'
 * reducer state lives here, one per turn stream.
 */

type Elicitation = Extract<AcpOutbound, { kind: "elicitation" }>["request"]

/**
 * Subtracting `sessionId` cannot reach inside the custom-mode variant's index
 * signature, so the outbound elicitation type carries one degenerate branch
 * that has lost its `mode`. Selecting the modes a translator actually produces
 * keeps the request assignable without widening what is sent.
 */
type ModedElicitation = Extract<Elicitation, { mode: string }>

function hasMode(request: Elicitation): request is ModedElicitation {
  return typeof request.mode === "string"
}

/** How much of a provider sentence one log line carries. */
const MAX_LOGGED_FAILURE_CHARS = 200

/**
 * The failure a `state_update` reports, when it reports one: the `error` stop
 * reason, or the `unknown` state of a turn nothing observes. Every other
 * update — including every streamed chunk — falls out on the first check. The
 * state names the class of failure and nothing else, so the machine code and
 * the provider's sentence travel with it: they are what an operator diagnoses
 * one turn by. `errorCode` is the name `acp.error` already logs the same
 * classification under.
 */
function turnFailureOf(update: SessionUpdate) {
  if (!SessionUpdate.isStateUpdate(update)) return undefined
  if (StateUpdate.isUnknown(update))
    return failureDetail({ state: "unknown" }, update._meta)
  if (StateUpdate.isIdle(update) && update.stopReason === "error")
    return failureDetail({ stopReason: "error" }, update._meta)
  return undefined
}

/** A failure's class, with what its `_meta.hgw` says of it. */
function failureDetail<Outcome extends object>(
  outcome: Outcome,
  extension: Record<string, unknown> | null | undefined
) {
  const meta = HgwStateMetaSchema.safeParse(extension?.[HGW_META_KEY])
  if (!meta.success) return outcome
  const { turnId, code, message } = meta.data
  return {
    ...outcome,
    turnId,
    ...(code === undefined ? {} : { errorCode: code }),
    ...(message === undefined
      ? {}
      : { message: message.slice(0, MAX_LOGGED_FAILURE_CHARS) }),
  }
}

/**
 * One `usage_update`. ACP's own fields carry the two token counts; everything
 * the provider reported about them travels in `_meta.hgw`, which is what lets
 * the composer attribute the window instead of showing one opaque total.
 */
function usageUpdate(usage: SessionContextResponse): SessionUpdate {
  return {
    sessionUpdate: "usage_update",
    used: usage.usedTokens,
    size: usage.maxTokens,
    ...(usage.cost ? { cost: usage.cost } : {}),
    _meta: {
      [HGW_META_KEY]: {
        source: usage.source,
        ...(usage.estimated ? { estimated: usage.estimated } : {}),
        ...(usage.breakdown ? { breakdown: usage.breakdown } : {}),
      },
    },
  }
}

/** One Session-scoped `notice`; the provider's own status kind rides in `_meta.hgw`. */
function noticeUpdate({
  severity,
  title,
  description,
  kind,
}: SessionNotice): SessionUpdate {
  return {
    sessionUpdate: "notice",
    severity,
    title,
    ...(description === undefined ? {} : { description }),
    ...(kind === undefined
      ? {}
      : { _meta: { [HGW_META_KEY]: { kind } satisfies HgwNoticeMeta } }),
  }
}

/**
 * The Session's execution as one `state_update`: the out-of-band report a
 * resume or an acknowledged Stop owes the client.
 */
function executionUpdate({
  state,
  turnId,
  sequence,
  awaitingStop,
  startedAt,
}: Extract<MemberEvent, { kind: "execution" }>): SessionUpdate {
  const live =
    state === "running" || state === "stopping" || state === "waiting-for-input"
  const meta =
    turnId === undefined
      ? {}
      : {
          _meta: {
            [HGW_META_KEY]: {
              sequence,
              turnId,
              ...(state === "stopping"
                ? { execution: "stopping" as const }
                : {}),
              // A live turn is dated where it began, as its stream dated it.
              ...(startedAt === undefined || !live ? {} : { at: startedAt }),
            },
          },
        }
  if (state === "waiting-for-input" || (state === "running" && awaitingStop))
    return { sessionUpdate: "state_update", state: "requires_action", ...meta }
  if (state === "running" || state === "stopping")
    return { sessionUpdate: "state_update", state: "running", ...meta }
  // Nothing observes an uncertain turn until a recover confirms it or its
  // deadline ends it.
  if (state === "uncertain")
    return { sessionUpdate: "state_update", state: "unknown", ...meta }
  return { sessionUpdate: "state_update", state: "idle", ...meta }
}

function sessionInfoUpdate(row: SessionRow): SessionUpdate {
  return {
    sessionUpdate: "session_info_update",
    title: row.title,
    updatedAt: row.updatedAt,
    _meta: { [HGW_META_KEY]: sessionInfoMeta(row) },
  }
}

function commandsUpdate(capabilities: WorkspaceCapabilities): SessionUpdate {
  const { slashCommands } = capabilities.workspace
  return {
    sessionUpdate: "available_commands_update",
    availableCommands: (slashCommands.status === "available"
      ? slashCommands.commands
      : []
    ).map(({ name, description }) => ({
      name,
      description: description ?? "",
    })),
    _meta: { [HGW_META_KEY]: { capabilities } },
  }
}

/** One update of an older page, tagged with the cursor that asked for it. */
function pageUpdate(update: SessionUpdate, cursor: string): SessionUpdate {
  const meta = (update._meta ?? {}) as Record<string, unknown>
  const aos = meta[HGW_META_KEY]
  return {
    ...update,
    _meta: {
      ...meta,
      [HGW_META_KEY]: {
        ...(typeof aos === "object" ? aos : {}),
        historyPage: { cursor },
      },
    },
  }
}

/** The client's reply to one server→client request, as ACP carries it. */
export type ClientReply =
  | { kind: "permission"; response: RequestPermissionResponse }
  | { kind: "elicitation"; response: CreateElicitationResponse }

export type MemberEncoderOptions = {
  /** The connection the encoder logs for, and the translators it writes with. */
  context: Pick<AcpConnectionContext, "logger" | "translators">
  /** The connection's send port for client-side ACP methods. */
  client: AgentContext
  /** How the runtime acknowledges a steer, which a turn's translation reads. */
  steerAck: TranslateContext["steerAck"]
  /** The public code and message a failure is shown as. */
  describe(cause: unknown): { code: string; message: string }
  /** Hands the client's reply to one request back to the connection. */
  replied(
    sessionId: string,
    requestId: string,
    reply: ClientReply
  ): Promise<void>
  /** Whether the client declared it answers elicitations in `mode`. */
  elicits(mode: string): boolean
  /** Reports a failure that has no request to answer to the Session's member. */
  report(sessionId: string, cause: unknown): unknown
  /** Whether the connection's credential still holds. */
  live(): boolean
  /** The child Sessions this connection's Sessions announced. */
  children: {
    /** Registers one; `false` means it may not be shown. */
    announce(
      childSessionId: string,
      parentSessionId: string,
      cancellable: boolean | undefined
    ): boolean
    has(childSessionId: string): boolean
  }
}

export function createMemberEncoder({
  context,
  client,
  steerAck,
  describe,
  replied,
  elicits,
  report,
  live,
  children,
}: MemberEncoderOptions): MemberConnection {
  const { translators, logger } = context
  const states = new WeakMap<TurnStream, TranslateState>()
  /** Each child's own translation, by the parent stream it streams in. */
  const childStates = new WeakMap<TurnStream, Map<string, TranslateState>>()
  /** The requests asked and not settled, by Session and requestId. */
  const asked = new Map<string, AbortController>()
  const askedKey = (sessionId: string, requestId: string) =>
    `${sessionId}\u0000${requestId}`

  function update(sessionId: string, value: SessionUpdate) {
    const failure = turnFailureOf(value)
    if (failure) logger.error({ sessionId, ...failure }, "acp.turn.failed")
    return client.notify(methods.client.session.update, {
      sessionId,
      update: value,
    })
  }

  async function send(
    sessionId: string,
    outbound: AcpOutbound,
    sequence: number
  ) {
    switch (outbound.kind) {
      case "update":
        return update(sessionId, outbound.update)
      // A steer the turn took is a user message on it, as any client reads one.
      case "steer-accepted":
        return update(sessionId, {
          sessionUpdate: "user_message",
          messageId: outbound.requestId,
          content: [{ type: "text", text: outbound.text }],
          _meta: {
            [HGW_META_KEY]: {
              turnId: outbound.turnId,
              sequence,
              delivery: outbound.delivery,
            },
          },
        })
      case "composer-prefill":
        return client.notify(HGW_METHODS.notify.composerPrefill, {
          sessionId,
          turnId: outbound.turnId,
          text: outbound.text,
        })
      // The model reading restates the options, and a request is asked once
      // the membership offers it.
      case "model-changed":
      case "request-permission":
      case "elicitation":
        return
    }
    return unhandledKind(outbound)
  }

  /**
   * A client that answered with an error cannot answer, so it declines, as a
   * cancel, and the Session stops waiting on it. A lost connection is no
   * answer, and a withdrawn request is refused as cancelled already.
   */
  function declined<T>(signal: AbortSignal, cancel: T) {
    return (cause: unknown) => {
      if (cause instanceof RequestError && !signal.aborted) return cancel
      throw cause
    }
  }

  /**
   * The Session a request is asked on: the child's that asks it, once that
   * child was announced, else the Session whose wait it is. Its answer
   * settles that wait either way.
   */
  function askedOn(sessionId: string, request: PendingRequest) {
    const { childSessionId } = request
    return childSessionId !== undefined && children.has(childSessionId)
      ? childSessionId
      : sessionId
  }

  async function askPermission(
    sessionId: string,
    request: PendingRequest,
    signal: AbortSignal
  ): Promise<ClientReply | undefined> {
    const outbound = translators.pendingRequestToOutbound(request)
    if (outbound.kind !== "request-permission") return undefined
    const response = await client
      .request(
        methods.client.session.requestPermission,
        { ...outbound.request, sessionId: askedOn(sessionId, request) },
        { cancellationSignal: signal }
      )
      .catch(declined(signal, { outcome: { outcome: "cancelled" as const } }))
    return { kind: "permission", response }
  }

  async function askElicitation(
    sessionId: string,
    request: PendingRequest,
    signal: AbortSignal
  ): Promise<ClientReply | undefined> {
    const outbound = translators.pendingRequestToOutbound(request)
    if (outbound.kind !== "elicitation") return undefined
    if (!hasMode(outbound.request))
      throw new Error("The elicitation carries no mode")
    // A client that cannot answer is not asked; its state shows the wait.
    if (!elicits(outbound.request.mode)) return undefined
    // A runtime's question belongs to its Session and, when one asked it, to a
    // tool call. ACP's request scope names a JSON-RPC request outside any
    // Session, so it is never this one's; the request id rides in `_meta.hgw`.
    const response = await client
      .request(
        methods.client.elicitation.create,
        {
          ...outbound.request,
          sessionId: askedOn(sessionId, request),
          ...(request.toolCallId === undefined
            ? {}
            : { toolCallId: request.toolCallId }),
        },
        { cancellationSignal: signal }
      )
      .catch(declined(signal, { action: "cancel" as const }))
    return { kind: "elicitation", response }
  }

  /** Issues one server→client request and hands its reply back. */
  function ask(sessionId: string, request: PendingRequest) {
    const controller = new AbortController()
    const { signal } = controller
    const key = askedKey(sessionId, request.requestId)
    asked.set(key, controller)
    void (async () => {
      const reply = await (request.kind === PendingRequestKind.Permission
        ? askPermission(sessionId, request, signal)
        : askElicitation(sessionId, request, signal))
      // An answer that crossed its withdrawal is no longer this member's to give.
      if (signal.aborted) return
      asked.delete(key)
      if (reply) await replied(sessionId, request.requestId, reply)
    })().catch((cause: unknown) =>
      // A withdrawn request is refused as cancelled, which is no failure.
      signal.aborted ? undefined : report(sessionId, cause)
    )
  }

  /** Cancels a request the Session resolved, which is `$/cancel_request`. */
  function withdraw(sessionId: string, requestId: string) {
    const key = askedKey(sessionId, requestId)
    const controller = asked.get(key)
    if (!controller) return
    asked.delete(key)
    controller.abort()
  }

  async function turn(event: Extract<MemberEvent, { kind: "turn" }>) {
    const { sessionId, stream, sequence } = event
    const translated = translators.translateTurnEvent(
      states.get(stream) ?? {
        ...initialTranslateState,
        replayedCorrections: stream.replayedCorrections,
      },
      event.event,
      {
        turnId: stream.turnId,
        sequence,
        stopping: event.stopping,
        steerAck,
      }
    )
    states.set(stream, translated.state)
    for (const outbound of translated.outbound) {
      if (stream.dropped) return
      // A replayed state has passed; the view is told the turn's own after.
      if (
        event.replayed &&
        outbound.kind === "update" &&
        outbound.update.sessionUpdate === "state_update"
      )
        continue
      await send(sessionId, outbound, sequence)
    }
  }

  /**
   * A child Session's report, on the Session that owns it, and the child's
   * own events, under its id once it was announced. A report of a child that
   * may not be shown, and every event of it, reach nobody. A child's requests
   * are its parent turn's, asked on the child, so its own stream carries
   * only updates.
   */
  async function child(event: Extract<MemberEvent, { kind: "child" }>) {
    const { parentSessionId, stream, sequence } = event
    const context = { turnId: stream.turnId, sequence, stopping: false }
    const reported = event.event
    if (reported.kind === TurnEventKind.ChildSessionUpdated)
      return reportChild(parentSessionId, reported, context)
    const { childSessionId, event: own } = reported
    if (!children.has(childSessionId)) return
    // A child that a child spawned is announced on that child.
    if (own.kind === TurnEventKind.ChildSessionUpdated)
      return reportChild(childSessionId, own, context)
    const owned = childStates.get(stream) ?? new Map<string, TranslateState>()
    childStates.set(stream, owned)
    const translated = translators.translateTurnEvent(
      owned.get(childSessionId) ?? initialTranslateState,
      own,
      { ...context, steerAck }
    )
    owned.set(childSessionId, translated.state)
    for (const outbound of translated.outbound) {
      if (stream.dropped) return
      if (outbound.kind !== "update") continue
      if (event.replayed && outbound.update.sessionUpdate === "state_update")
        continue
      await send(childSessionId, outbound, sequence)
    }
  }

  function reportChild(
    parentSessionId: string,
    reported: TurnEventOf<typeof TurnEventKind.ChildSessionUpdated>,
    context: TranslateContext
  ) {
    const { childSessionId, cancellable } = reported
    if (!children.announce(childSessionId, parentSessionId, cancellable)) {
      logger.warn({ parentSessionId }, "acp.child.refused")
      return
    }
    return update(
      parentSessionId,
      translators.translateChildUpdate(reported, context)
    )
  }

  /**
   * A page as its updates, each child Session it names announced, the way a
   * live report announces one: a row naming a child that may not be shown is
   * left out, and nothing of that child follows it.
   */
  function historyOutbounds(event: Extract<MemberEvent, { kind: "history" }>) {
    const messages = event.page.messages.filter(
      (message) =>
        message.role !== "activity" ||
        message.activityType !== "CHILD_SESSION" ||
        children.announce(
          message.content.childSessionId,
          event.sessionId,
          undefined
        )
    )
    return translators.translateHistory({ ...event.page, messages })
  }

  /**
   * An older page as tagged updates ahead of the reply. Only the newest page
   * carries the plan.
   */
  async function olderPage(
    event: Extract<MemberEvent, { kind: "history" }>,
    older: { cursor: string; offset: number }
  ) {
    const updates = historyOutbounds(event).flatMap((outbound) =>
      outbound.kind === "update" &&
      outbound.update.sessionUpdate !== "plan_update"
        ? [pageUpdate(outbound.update, older.cursor)]
        : []
    )
    for (const value of updates) await update(event.sessionId, value)
    logger.info(
      {
        sessionId: event.sessionId,
        offset: older.offset,
        count: updates.length,
      },
      "acp.history.page"
    )
  }

  /** Shows the member a prompt, as blocks rebuilt from its parts. */
  function prompt(event: Extract<MemberEvent, { kind: "prompt" }>) {
    return update(event.sessionId, {
      sessionUpdate: "user_message",
      messageId: event.messageId,
      content: promptBlocks(event.content),
    })
  }

  /** A workspace event, as its `_hgw/*` notification. */
  function workspace(event: WorkspaceEvent) {
    switch (event.kind) {
      case "catalog-invalidated":
        return client.notify(HGW_METHODS.notify.catalogInvalidated)
      case "activity": {
        const activity: HgwActivityNotification = event.activity
        return client.notify(HGW_METHODS.notify.activity, activity)
      }
    }
    return unhandledKind(event)
  }

  async function encode(event: MemberEvent): Promise<void> {
    if (!("sessionId" in event)) return workspace(event)
    const { sessionId } = event
    switch (event.kind) {
      case "turn":
        return turn(event)
      case "prompt":
        return prompt(event)
      case "history":
        if (event.older) return olderPage(event, event.older)
        for (const outbound of historyOutbounds(event))
          await send(sessionId, outbound, event.sequence)
        return
      case "child-history":
        // A child's transcript follows the announcement its row made.
        if (!children.has(event.childSessionId)) return
        for (const outbound of translators.translateHistory(event.page))
          if (outbound.kind === "update")
            await update(event.childSessionId, outbound.update)
        return
      case "request-asked":
        return ask(sessionId, event.request)
      case "request-withdrawn":
        return withdraw(sessionId, event.requestId)
      case "child":
        return child(event)
      case "question-answered": {
        const record = answeredQuestionOutbound(event.request, event.answers)
        if (record) await send(sessionId, record, 0)
        return
      }
      case "execution":
        return update(sessionId, executionUpdate(event))
      case "usage":
        return update(sessionId, usageUpdate(event.usage))
      case "model":
        // ACP restates the whole option set on a model switch.
        return update(sessionId, {
          sessionUpdate: "config_option_update",
          configOptions: translators.configOptionsOf(event.models),
        })
      case "session-info":
        return update(sessionId, sessionInfoUpdate(event.row))
      case "commands":
        return update(sessionId, commandsUpdate(event.capabilities))
      case "notice":
        return update(sessionId, noticeUpdate(event.notice))
      case "error": {
        const failure = describe(event.cause)
        logger.error(
          { sessionId, errorCode: failure.code, message: failure.message },
          "acp.error"
        )
        await client
          .notify(HGW_METHODS.notify.error, { sessionId, ...failure })
          .catch((err: unknown) =>
            logger.warn({ err, sessionId }, "acp.error.notify_failed")
          )
        return
      }
    }
    return unhandledKind(event)
  }

  return {
    send: encode,
    live,
  }
}
