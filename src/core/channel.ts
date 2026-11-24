import { isDeepStrictEqual } from "node:util"

import {
  backoffDelay,
  createOwner,
  Deadline,
  defaultClock,
  ownerSetup,
  type Clock,
  type Logger,
  type Owner,
  type OwnerContext,
} from "../../lifecycle"
import type {
  SessionHistoryResponse,
  SessionModelsResponse,
  SessionModelUpdateRequest,
} from "../../protocol"
import {
  CHILD_FOLLOW_GRACE_MS,
  CLOSE_DEADLINE_MS,
  DELETE_SHOWN_MS,
  JOIN_DEADLINE_MS,
  READING_BACKOFF,
  READING_RETRIES,
  RESTATED_TERMINAL_OUTPUT,
  SETUP_READ_MS,
} from "./limits"
import { outputTail } from "./credentials-middleware"
import { persistedCorrections, withoutLiveRows } from "./replay-page"
import {
  isAwaitingStopFailure,
  isChildTurnEvent,
  isRedialableFailure,
  ChildSessionStatus,
  ReplyStatus,
  TurnEventKind,
  type ChildTurnEvent,
  type ExecutionEvent,
  type PendingRequest,
  type RequestReply,
  type TerminalTurnEvent,
  type TurnEvent,
  type TurnEventOf,
} from "./events"
import {
  CommandRefusedError,
  hasSession,
  runEvents,
  unhandledKind,
  type BackgroundWork,
  type CommandResults,
  type Member,
  type MemberEvent,
  type MemberScope,
  type MemberSetup,
  type PromptPart,
  type SessionEvent,
  type SessionNotice,
  type TurnStream,
} from "./member"
import {
  ServerRequestStaleError,
  ServerTurnConflictError,
  ServerTurnEndedError,
  ServerTurnUncertainError,
  type ServerRuntime,
  type ServerTurnListener,
  type SessionScope,
} from "./runtime"
import {
  ReplayCursorLostError,
  type CoordinatedTurnSubscription,
  type CoordinatorAccess,
  type ClientSend,
  type CreateInput,
  type SessionCoordinator,
  type StartOptions,
} from "./session-coordinator"
import type { SessionRow } from "./session-rows"
import { FanoutOverflowError } from "./subscriber-fanout"

/** The readings a setup answer tells, as the coordinator read them. */
type SetupReadings = Awaited<ReturnType<SessionCoordinator["setupReadings"]>>

/**
 * A channel is one provider Session; its members are the connections that
 * have joined it. The coordinator already fans a turn's stream out to many
 * followers, so a channel only carries what the stream cannot: the prompt that
 * started the turn, and a nudge to reload when a member saw a prompt but missed
 * its reply. A channel with members also subscribes to its Session, so a turn the
 * runtime starts by itself is adopted and streamed to every member like one of
 * their own.
 */

export type ChannelScope = Pick<SessionScope, "agentId" | "providerSessionId">

export type ChannelTurn = {
  turnId: string
  messageId: string
  content: readonly PromptPart[]
  /** When the turn was admitted, on the channels' monotonic clock. */
  at: number
}

export type MembershipDelivery = {
  /** Send this turn's prompt to the member as its user_message. */
  sendTurn(turn: ChannelTurn): void | Promise<void>
  /** Subscribe the member to the current turn's stream. */
  follow(): Promise<"following" | "idle">
  /** The turnId the member's own subscription last carried, if any. */
  followedTurn(): string | undefined
  /**
   * Rebuild the member's view from the Session's history, once its stream of
   * the `ended` turn, if it reads one, has shown that turn's end.
   */
  rebuild(ended?: string): void | Promise<void>
  /** Record a send/follow failure for this member alone. */
  report(cause: unknown): void
  /** Show the member a status the runtime announced, live only. */
  notice(notice: SessionNotice): void
  /**
   * Show the member one report or event of a child still at work after the
   * turn that spawned it, `turnId`, ended; live only.
   */
  child(turnId: string, event: ChildTurnEvent): void
  /**
   * Show the member one step of a terminal still running after the turn
   * that started it, `turnId`, ended; live only.
   */
  terminal(turnId: string, event: TerminalTurnEvent): void
  /** Offer the member a request such a child asks, or withdraw one. */
  offerChild(request: PendingRequest): void
  withdrawChild(requestId: string): void
  /** Settles once the member was shown the last stream it follows, whole. */
  shown(): Promise<void>
}

/** A member a wait follows until it was shown the last stream it follows. */
type ShownMember = Pick<MembershipDelivery, "shown">

export type Channels = ReturnType<typeof createChannels>
type ChannelTable = ReturnType<typeof createChannelTable>
/** What lets a channel adopt a turn the runtime started by itself. */
export type ChannelAdoption = {
  subscribeTurns(scope: SessionScope, listener: ServerTurnListener): () => void
  /** Adopts the runtime's running turn, if any. */
  discover(scope: SessionScope): Promise<unknown>
  /**
   * Reports how each terminal the Session's turns left running stands now,
   * through the turn listener, before it settles; never rejects.
   */
  readTerminals?(scope: SessionScope): Promise<void>
  /** The Session's execution feed. */
  subscribeExecutions(
    scope: ChannelScope,
    listener: (event: ExecutionEvent) => void
  ): () => void
}

type Delivery = {
  /** The member's own scope, which an adoption runs under. */
  scope: SessionScope
  /** The turnId whose prompt this member already holds. */
  delivered?: string
  /** Whether the channel sent that prompt, rather than the member owning it. */
  fromChannel: boolean
}

type Channel = {
  turn?: ChannelTurn
  memberships: Map<MembershipDelivery, Delivery>
  /**
   * The open requests of children that outlived their turn, which no turn
   * carries: each is offered to every member, one who joins later included.
   */
  childRequests: Map<string, PendingRequest>
  /**
   * The latest report of each child that outlived its turn, under that turn,
   * restated to every member who joins later.
   */
  children: Map<string, BackgroundChild>
  /**
   * The latest step of each terminal still running after its turn, its output
   * aside, under that turn, restated to every member who joins later.
   */
  terminals: Map<string, BackgroundTerminal>
  /**
   * The runtime's read of the terminals its turns left running, which a
   * resume's state waits for, within `SETUP_READ_MS`.
   */
  terminalsRead: Promise<void>
  /** The close of a channel nobody watches, held for its background children. */
  lingering?: unknown
  /** Ends the channel's turn subscription and its execution feed. */
  unsubscribe?: () => void
  /** One adoption runs at a time; a trigger meanwhile asks for one more. */
  adopting?: boolean
  again?: boolean
  /** The turn this channel adopted, whose prompt no member has seen. */
  adopted?: string
  /** Failed discovers in a row, which the next retry backs off on. */
  failures: number
  /** The pending retry of a failed discover. */
  retry?: unknown
  /** Bumped when the channel closes: a discover answered since changes nothing. */
  generation: number
}

type ChildReport = TurnEventOf<typeof TurnEventKind.ChildSessionUpdated>

/**
 * One piece of a Session's work a member follows, with what lists it: it
 * still runs, and no foreground work waits on it, because the tool call that
 * started it finished or the turn that started it ended.
 */
type FollowedWork = {
  item: BackgroundWork
  /** The tool call that started it, once a report named it. */
  toolCallId?: string
  detached: boolean
  runs: boolean
}

type BackgroundChild = {
  turnId: string
  report: ChildReport
  /** When its reports first left it no longer at work, on the channels' clock. */
  endedAt?: number
}

type BackgroundTerminal = {
  turnId: string
  /** Its command, folder and exit as last reported, without its output. */
  report: TerminalTurnEvent
  /**
   * The latest of its output the channel was shown, its last
   * `RESTATED_TERMINAL_OUTPUT` units, unmasked: each member's stack masks it.
   */
  output?: string
  /** When its exit was reported, on the channels' clock. */
  endedAt?: number
}

const DEFAULT_BACKSTOP_MS = 60 * 60 * 1000

/** One item of background work as a list names it, its kind and its id. */
function workKey(item: BackgroundWork) {
  return `${item.kind}\u0000${item.kind === "child" ? item.childSessionId : item.terminalId}`
}

/** The statuses that say how a child's work ended. */
const OVER: ReadonlySet<string> = new Set([
  ChildSessionStatus.Idle,
  ChildSessionStatus.Failed,
  ChildSessionStatus.Cancelled,
])

/**
 * Whether a child's report leaves it running, as ACP lists a detached child
 * while its state is not idle: at work, waiting on input, or `unknown`, which
 * nothing follows any more and may still run.
 */
function runs(report: ChildReport) {
  return report.status !== undefined && !OVER.has(report.status)
}

/**
 * How a declined permission is answered: the one-time refusal when the
 * request offers it, so no lasting rule lands on the Agent, and a
 * cancellation otherwise.
 */
function declineReply(request: PendingRequest): RequestReply {
  const choices = request.responseSchema?.enum
  return Array.isArray(choices) && choices.includes("deny")
    ? {
        requestId: request.requestId,
        status: ReplyStatus.Resolved,
        payload: "deny",
      }
    : { requestId: request.requestId, status: ReplyStatus.Cancelled }
}

/** Where a resuming view already reaches in the live turn. */
export type ResumePosition = { turnId?: string; after?: number }

/**
 * How a resume builds its view: rebuilt from history `fromStart`, followed
 * from its position when `positioned` and from the live turn's next event
 * otherwise, and rebuilt from the newest page alone for a member that `paged`
 * older history itself.
 */
export type ResumeView = {
  fromStart: boolean
  positioned: boolean
  paged: boolean
}

/**
 * How history is read: the bounded `pageSize` one from-start read or one
 * older page reads, and the `maxOffset` pages reach back to; older history
 * reads as truncated.
 */
export type HistoryReach = { pageSize: number; maxOffset: number }

export const HISTORY_REACH: HistoryReach = { pageSize: 500, maxOffset: 100_000 }

/** Whether an older page exists within the reach, past the one just read. */
export function hasOlderPage(page: SessionHistoryResponse, maxOffset: number) {
  return (
    !page.truncated &&
    page.nextOffset < page.total &&
    page.nextOffset > page.offset &&
    page.nextOffset < maxOffset
  )
}

/**
 * Whether a resume already shows the live turn's prompt: its cursor sits inside
 * that turn, or the page it replayed holds the prompt's id, the one the
 * provider stored it under.
 */
function showsPrompt(
  turn: ChannelTurn | undefined,
  position: ResumePosition,
  history?: SessionHistoryResponse
) {
  if (!turn) return false
  if (position.turnId === turn.turnId) return true
  return history?.messages.some(({ id }) => id === turn.messageId) ?? false
}

/** A turn's state as a member's view reads it, from the event that set it. */
function statedBy(event: TurnEvent) {
  switch (event.kind) {
    case TurnEventKind.TurnStarted:
      return "running"
    case TurnEventKind.TurnRequiresAction:
      return "requires_action"
    case TurnEventKind.TurnEnded:
      return "idle"
    case TurnEventKind.TurnFailed:
      return isAwaitingStopFailure(event) ? "requires_action" : "idle"
    default:
      return undefined
  }
}

/**
 * The same state, from the coordinator's view of the Session. Stopping and
 * uncertain read as no stream event does, so a resume always states them.
 */
function viewState(state: string, awaitingStop?: boolean) {
  if (state === "waiting-for-input" || (state === "running" && awaitingStop))
    return "requires_action"
  return state
}

/**
 * Keyed like the coordinator's `scopeKey`, never by the public `sessionId`: a
 * guest's public id differs from the operator's for the same provider Session.
 */
function channelKey(scope: ChannelScope) {
  return `${scope.agentId}\u0000${scope.providerSessionId}`
}

/** Runs one member's call so its failure reaches only that member. */
async function attempt<T>(
  member: MembershipDelivery,
  call: () => T | Promise<T>
): Promise<T | undefined> {
  try {
    return await call()
  } catch (cause) {
    member.report(cause)
    return undefined
  }
}

/**
 * The member an adoption runs as: the first to join. The coordinator reports
 * the turn under this member's Session, and activity and push read it.
 */
function adopter(channel: Channel) {
  return [...channel.memberships].at(0)
}

function createChannelTable({
  snapshot,
  adoption,
  clock,
  logger,
  backstopMs = DEFAULT_BACKSTOP_MS,
}: {
  /** Coordinator view of a Session: state and the live segment's turnId. */
  snapshot: (scope: ChannelScope) => { state: string; turnId?: string }
  /** Absent when the runtime cannot report the turns it starts. */
  adoption?: ChannelAdoption
  /** The monotonic clock a turn's admission and the backstop read. */
  clock: Clock
  /**
   * Where the channels write, and the logger the membership machine is set
   * up on; each membership writes on its own.
   */
  logger: Logger
  backstopMs?: number
}) {
  const channels = new Map<string, Channel>()

  /**
   * The cached prompt while its turn is still live. A finished execution keeps
   * its old turnId in the coordinator, so only the state check ends it.
   */
  function currentTurn(scope: ChannelScope, channel: Channel) {
    const { turn } = channel
    if (!turn) return undefined
    const { state, turnId } = snapshot(scope)
    const live = state !== "idle" && turnId === turn.turnId
    // A question may wait on a person indefinitely; the backstop only guards
    // against a turn the coordinator never reports as ended.
    const expired =
      state !== "waiting-for-input" && clock.now() - turn.at > backstopMs
    if (live && !expired) return turn
    channel.turn = undefined
    return undefined
  }

  async function send(
    member: MembershipDelivery,
    delivery: Delivery,
    turn: ChannelTurn
  ) {
    // Marked while in flight so a concurrent sync cannot repeat it, and
    // unmarked on failure so the next sync retries it.
    const { delivered, fromChannel } = delivery
    delivery.delivered = turn.turnId
    delivery.fromChannel = true
    try {
      await member.sendTurn(turn)
    } catch (cause) {
      member.report(cause)
      if (delivery.delivered !== turn.turnId) return
      delivery.delivered = delivered
      delivery.fromChannel = fromChannel
    }
  }

  async function catchUpMember(
    scope: ChannelScope,
    channel: Channel,
    member: MembershipDelivery,
    delivery: Delivery
  ) {
    const turn = currentTurn(scope, channel)
    if (turn && delivery.delivered !== turn.turnId) {
      await send(member, delivery, turn)
    }
    // Read before following: the prompt may be dropped meanwhile.
    const shown = delivery.fromChannel ? delivery.delivered : undefined
    const following = await attempt(member, () => member.follow())
    if (following !== "idle" || !shown || member.followedTurn() === shown) {
      return
    }
    // Shown a prompt whose reply it never streamed; history has the reply.
    delivery.fromChannel = false
    await attempt(member, () => member.rebuild())
  }

  async function syncChannel(scope: ChannelScope, channel: Channel) {
    await Promise.all(
      [...channel.memberships].map(([member, delivery]) =>
        catchUpMember(scope, channel, member, delivery)
      )
    )
  }

  /** Records what a member holds of the live turn, sending it the prompt if not. */
  function join(
    channel: Channel,
    member: MembershipDelivery,
    delivery: Delivery,
    hasPrompt: boolean
  ) {
    channel.memberships.set(member, delivery)
    const turn = currentTurn(delivery.scope, channel)
    if (!turn) return
    if (hasPrompt) delivery.delivered = turn.turnId
    else
      send(member, delivery, turn).catch((err: unknown) =>
        logger.error({ err }, "channel.send.failed")
      )
  }

  /**
   * Asks the runtime for a turn it started by itself and, when it adopts one,
   * brings every member into it. Runs one at a time per channel, and once more
   * when asked again meanwhile.
   */
  async function adopt(channel: Channel) {
    if (channel.adopting) {
      channel.again = true
      return
    }
    channel.adopting = true
    try {
      do {
        channel.again = false
        await adoptOnce(channel)
      } while (channel.again)
    } finally {
      channel.adopting = false
    }
  }

  /** Asks in the background: nothing awaits the ask, so a failure is logged. */
  function adoptLater(channel: Channel) {
    adopt(channel).catch((err: unknown) =>
      logger.error({ err }, "channel.adopt.failed")
    )
  }

  async function adoptOnce(channel: Channel) {
    // This ask replaces a retry still pending.
    clock.clearTimeout(channel.retry)
    channel.retry = undefined
    const joined = adopter(channel)
    if (!adoption || !joined) return
    const [member, { scope }] = joined
    const { generation } = channel
    const before = snapshot(scope).turnId
    try {
      await adoption.discover(scope)
    } catch (cause) {
      if (channel.generation !== generation) return
      // A gateway turn still starting refuses it; that turn's end asks again.
      if (cause instanceof ServerTurnConflictError) return
      retryAdoption(channel)
      member.report(cause)
      return
    }
    if (channel.generation !== generation) return
    channel.failures = 0
    const { state, turnId } = snapshot(scope)
    if (state === "idle" || turnId === undefined || turnId === before) return
    channel.adopted = turnId
    await syncChannel(scope, channel)
  }

  /**
   * Asks again on backoff after a failed discover, so a turn the runtime
   * started is not missed until the next turn's end; past the budget, that
   * end asks.
   */
  function retryAdoption(channel: Channel) {
    if (channel.failures >= READING_RETRIES) {
      channel.failures = 0
      return
    }
    const delay = backoffDelay(channel.failures, READING_BACKOFF)
    channel.failures += 1
    channel.retry = clock.setTimeout(() => {
      channel.retry = undefined
      adoptLater(channel)
    }, delay)
  }

  /** Ends a memberless channel's feeds and its pending retry. */
  function close(channel: Channel) {
    clock.clearTimeout(channel.lingering)
    channel.lingering = undefined
    channel.generation += 1
    clock.clearTimeout(channel.retry)
    channel.retry = undefined
    channel.unsubscribe?.()
  }

  /**
   * Every turn's end asks the runtime once more, which finds a turn it started
   * while the gateway's own ran. An adopted turn's end rebuilds every member's
   * view from history, which holds the prompt none of them was shown.
   */
  function onExecution(channel: Channel, event: ExecutionEvent) {
    if (event.kind !== "turn-finished" && event.kind !== "turn-failed") return
    if (event.turnId === channel.adopted) {
      channel.adopted = undefined
      for (const member of channel.memberships.keys())
        attempt(member, () => member.rebuild(event.turnId)).catch(
          (err: unknown) => logger.error({ err }, "channel.rebuild.failed")
        )
    }
    adoptLater(channel)
  }

  /** A child's request ended: no member offers it any more. */
  function endChildRequest(channel: Channel, requestId: string) {
    if (!channel.childRequests.delete(requestId)) return
    for (const member of channel.memberships.keys())
      member.withdrawChild(requestId)
  }

  /** Folds a background child's report into the one restated to a joiner. */
  function noteChild(channel: Channel, turnId: string, report: ChildReport) {
    const known = channel.children.get(report.childSessionId)
    const merged = known ? { ...known.report, ...report } : report
    channel.children.set(report.childSessionId, {
      turnId,
      report: merged,
      ...(runs(merged) ? {} : { endedAt: known?.endedAt ?? clock.now() }),
    })
  }

  /**
   * The background children a member who joins now is told of: each still at
   * work, and each that ended within the grace, which a reload or a reconnect
   * may have missed. One over for longer is forgotten.
   */
  function currentChildren(channel: Channel) {
    const now = clock.now()
    for (const [childSessionId, { endedAt }] of channel.children)
      if (endedAt !== undefined && now - endedAt >= CHILD_FOLLOW_GRACE_MS)
        channel.children.delete(childSessionId)
    return [...channel.children.values()]
  }

  /**
   * Folds a background terminal's step into its restatement: its command,
   * folder and exit, and its output, which a snapshot replaces and a chunk
   * appends to, as far as `RESTATED_TERMINAL_OUTPUT` reaches back.
   */
  function noteTerminal(
    channel: Channel,
    turnId: string,
    event: TerminalTurnEvent
  ) {
    const { data, output, ...step } = event
    const known = channel.terminals.get(step.terminalId)
    const merged = known ? { ...known.report, ...step } : step
    const held =
      output ??
      (data === undefined ? known?.output : `${known?.output ?? ""}${data}`)
    channel.terminals.set(step.terminalId, {
      turnId,
      report: merged,
      ...(held === undefined
        ? {}
        : { output: outputTail(held, RESTATED_TERMINAL_OUTPUT) }),
      ...(merged.exit ? { endedAt: known?.endedAt ?? clock.now() } : {}),
    })
  }

  /**
   * The background terminals a member who joins now is told of: each still
   * running, and each that exited within the grace, which a reload or a
   * reconnect may have missed. Each is restated whole, with the latest of
   * its output the channel holds as its snapshot.
   */
  function currentTerminals(channel: Channel) {
    const now = clock.now()
    for (const [terminalId, { endedAt }] of channel.terminals)
      if (endedAt !== undefined && now - endedAt >= CHILD_FOLLOW_GRACE_MS)
        channel.terminals.delete(terminalId)
    return [...channel.terminals.values()].map(
      ({ turnId, report, output }) => ({
        turnId,
        report: output === undefined ? report : { ...report, output },
      })
    )
  }

  /**
   * The last member left. A child that outlived its turn is still followed
   * for a while, so a reload or a reconnect comes back to it followed, and
   * reads how it ended if it ended meanwhile.
   */
  function vacate(key: string, channel: Channel) {
    const retire = () => {
      if (channel.memberships.size > 0 || channels.get(key) !== channel) return
      channels.delete(key)
      close(channel)
    }
    if (currentChildren(channel).length === 0) return retire()
    channel.lingering = clock.setTimeout(() => {
      channel.lingering = undefined
      retire()
    }, CHILD_FOLLOW_GRACE_MS)
  }

  function subscribe(scope: SessionScope, channel: Channel) {
    if (!adoption) return
    const unsubscribeExecutions = adoption.subscribeExecutions(scope, (event) =>
      onExecution(channel, event)
    )
    const unsubscribeTurns = adoption.subscribeTurns(scope, {
      onTurn: () => adoptLater(channel),
      onError: (cause) => adopter(channel)?.[0].report(cause),
      onNotice: (notice) => {
        for (const member of channel.memberships.keys()) member.notice(notice)
      },
      onChild: (turnId, event) => {
        if (event.kind === TurnEventKind.ChildSessionUpdated)
          noteChild(channel, turnId, event)
        for (const member of channel.memberships.keys())
          member.child(turnId, event)
      },
      onChildRequest: (_turnId, request) => {
        channel.childRequests.set(request.requestId, request)
        for (const member of channel.memberships.keys())
          member.offerChild(request)
      },
      onChildRequestEnded: (requestId) => endChildRequest(channel, requestId),
      onTerminal: (turnId, event) => {
        noteTerminal(channel, turnId, event)
        for (const member of channel.memberships.keys())
          member.terminal(turnId, event)
      },
    })
    // Read once the listener is in place, which hears what the read finds.
    channel.terminalsRead =
      adoption
        .readTerminals?.(scope)
        .catch((err: unknown) =>
          logger.warn({ err }, "channel.terminals.read_failed")
        ) ?? Promise.resolve()
    channel.unsubscribe = () => {
      unsubscribeTurns()
      unsubscribeExecutions()
    }
  }

  return {
    /**
     * Whether the Session has children that outlived their turns, at work or
     * over within the grace, whose updates no turn's journal kept.
     */
    followsChildren(scope: ChannelScope) {
      const channel = channels.get(channelKey(scope))
      return channel !== undefined && currentChildren(channel).length > 0
    },

    /**
     * The Session's background work: each child that outlived its turn and
     * still runs, which a delete stops.
     */
    backgroundWork(scope: ChannelScope): BackgroundWork[] {
      const channel = channels.get(channelKey(scope))
      const children = [...(channel?.children ?? [])].flatMap(
        ([childSessionId, { report }]): BackgroundWork[] =>
          runs(report) ? [{ kind: "child", childSessionId }] : []
      )
      const terminals = [...(channel?.terminals ?? [])].flatMap(
        ([terminalId, { report }]): BackgroundWork[] =>
          report.exit ? [] : [{ kind: "terminal", terminalId }]
      )
      return [...children, ...terminals]
    },

    /**
     * Settles once the runtime's read of the terminals the Session's turns
     * left running was reported, or `SETUP_READ_MS` passed: a state stated
     * before it lands lists what the gateway holds, and the read still lands
     * as an update.
     */
    async terminalsRead(scope: ChannelScope) {
      const read = channels.get(channelKey(scope))?.terminalsRead
      if (!read) return
      const deadline = new Deadline(SETUP_READ_MS, clock)
      try {
        await unlessAborted(read, deadline.signal).catch(() => undefined)
      } finally {
        deadline.clear()
      }
    },

    /** A request a child that outlived its turn asks, while it is open. */
    childRequest(scope: ChannelScope, requestId: string) {
      return channels.get(channelKey(scope))?.childRequests.get(requestId)
    },

    /** Ends one child's request, as its answer just did. */
    endChildRequest(scope: ChannelScope, requestId: string) {
      const channel = channels.get(channelKey(scope))
      if (channel) endChildRequest(channel, requestId)
    },

    add(
      scope: SessionScope,
      member: MembershipDelivery,
      options: { hasPrompt: boolean }
    ) {
      const key = channelKey(scope)
      let channel = channels.get(key)
      const created = !channel
      if (!channel) {
        channel = {
          memberships: new Map(),
          childRequests: new Map(),
          children: new Map(),
          terminals: new Map(),
          terminalsRead: Promise.resolve(),
          failures: 0,
          generation: 0,
        }
        channels.set(key, channel)
      }
      const joined = channel
      const remove = () => {
        joined.memberships.delete(member)
        if (joined.memberships.size === 0 && channels.get(key) === joined)
          vacate(key, joined)
      }
      if (joined.memberships.has(member)) return remove
      const lingered = joined.lingering !== undefined
      clock.clearTimeout(joined.lingering)
      joined.lingering = undefined
      join(joined, member, { scope, fromChannel: false }, options.hasPrompt)
      // A turn the runtime started while nobody watched found no member to
      // adopt it as.
      if (lingered) adoptLater(joined)
      for (const { turnId, report } of currentChildren(joined))
        member.child(turnId, report)
      for (const { turnId, report } of currentTerminals(joined))
        member.terminal(turnId, report)
      for (const request of joined.childRequests.values())
        member.offerChild(request)
      // Subscribed once the first member joins, so a turn already running
      // has someone to adopt it as.
      if (created) subscribe(scope, joined)
      return remove
    },

    /**
     * Rejoins a member after its view was rebuilt from history, which
     * holds the live prompt only when `hasPrompt` says so.
     */
    rejoin(
      scope: ChannelScope,
      member: MembershipDelivery,
      options: { hasPrompt: boolean }
    ) {
      const channel = channels.get(channelKey(scope))
      const delivery = channel?.memberships.get(member)
      if (channel && delivery)
        join(
          channel,
          member,
          { scope: delivery.scope, fromChannel: false },
          options.hasPrompt
        )
    },

    /** Called only after the coordinator admitted `turn`. */
    async broadcastTurn(
      scope: ChannelScope,
      turn: ChannelTurn,
      sender: MembershipDelivery
    ) {
      const channel = channels.get(channelKey(scope))
      // No member means nobody to tell, and a memberless channel would leak.
      if (!channel) return
      channel.turn = turn
      const own = channel.memberships.get(sender)
      if (own) {
        own.delivered = turn.turnId
        own.fromChannel = false
      }
      // A member already shown the turn, as a repeat's first sender was, is
      // not shown it again.
      await Promise.all(
        [...channel.memberships]
          .filter(
            ([member, delivery]) =>
              member !== sender && delivery.delivered !== turn.turnId
          )
          .map(([member, delivery]) => send(member, delivery, turn))
      )
    },

    /** An answered question resumes the same prompt under a fresh turnId. */
    continueTurn(scope: ChannelScope, fromTurnId: string, toTurnId: string) {
      const channel = channels.get(channelKey(scope))
      if (!channel?.turn || channel.turn.turnId !== fromTurnId) return
      channel.turn = { ...channel.turn, turnId: toTurnId }
      for (const delivery of channel.memberships.values()) {
        if (delivery.delivered === fromTurnId) delivery.delivered = toTurnId
      }
    },

    /** The live turn's prompt, which a resume checks its own replay against. */
    current(scope: ChannelScope) {
      const channel = channels.get(channelKey(scope))
      return channel ? currentTurn(scope, channel) : undefined
    },

    async catchUp(scope: ChannelScope, member: MembershipDelivery) {
      const channel = channels.get(channelKey(scope))
      const delivery = channel?.memberships.get(member)
      if (channel && delivery)
        await catchUpMember(scope, channel, member, delivery)
    },

    async sync(scope: ChannelScope) {
      const channel = channels.get(channelKey(scope))
      if (channel) await syncChannel(scope, channel)
    },

    /**
     * Asks the runtime once for a turn no turn end will report: one a
     * member's failed start may have lost to, or one behind a wait a resume
     * found.
     */
    async recheck(scope: ChannelScope) {
      const channel = channels.get(channelKey(scope))
      if (channel) await adopt(channel)
    },

    /** Settles once every member was shown the last stream it follows. */
    async shown(scope: ChannelScope) {
      const channel = channels.get(channelKey(scope))
      await Promise.all(
        [...(channel?.memberships.keys() ?? [])].map((member) => member.shown())
      )
    },

    /** How many members every channel holds, for the health gauges. */
    memberships() {
      let count = 0
      for (const channel of channels.values()) count += channel.memberships.size
      return count
    },
  }
}

type CreateChannelsOptions = Omit<
  Parameters<typeof createChannelTable>[0],
  "snapshot" | "clock"
> & {
  coordinator: SessionCoordinator
  /** Where a resume and an older page read the Session's history. */
  runtime: Pick<ServerRuntime, "history" | "childHistory">
  clock?: Clock
  /** Defaults to `HISTORY_REACH`; a small one stands for a long Session. */
  historyReach?: HistoryReach
}

/** How a transport joins one member to one Session. */
export type MembershipOptions = {
  /** The membership the coordinator knows this member's stream by. */
  membershipId: string
  /** Where the membership writes, already naming its member and its Session. */
  logger: Logger
  /** The public code and message a failure is logged under. */
  describe: (cause: unknown) => { code: string; message: string }
  /** The Session's row as a replaying cell: the known row, then each change. */
  subscribeRow: (listener: (row: SessionRow) => void) => () => void
  /** The row the gateway holds of the Session now, read from no provider. */
  knownRow?: () => SessionRow | undefined
}

/** A membership's options, with the coordinator and clock its channels share. */
type MembershipContext = MembershipOptions & {
  coordinator: SessionCoordinator
  clock: Clock
  /** The history a from-start view replays, the newest page alone if `paged`. */
  readReplay: (
    scope: SessionScope,
    paged: boolean
  ) => Promise<SessionHistoryResponse>
  /** A child Session's whole transcript, where the runtime keeps one. */
  readChildHistory: (
    scope: SessionScope,
    childSessionId: string
  ) => Promise<SessionHistoryResponse> | undefined
}

/**
 * What moves a membership: a join and the answer that lands it, each stream
 * it follows, and parting.
 */
type MembershipSignal =
  | { type: "join" }
  | { type: "joined" }
  | { type: "followed" }
  | { type: "part" }

/**
 * One membership's lifetime: joining until the answer to its join lands,
 * joined while it follows its Session, and detached for good once it parts
 * or its join's deadline passes. A member that cannot catch up with its
 * Session is never left behind on it: its connection closes, which parts it.
 * Each stream it follows is a generation of its own, so a stream another one
 * replaced settles nothing.
 */
export function membershipMachine(logger: Logger, clock: Clock) {
  return ownerSetup<OwnerContext, MembershipSignal>(
    "membership",
    logger,
    clock
  ).createMachine({
    context: { generation: 0 },
    initial: "joining",
    on: {
      followed: { actions: "bumpGeneration" },
      part: ".detached",
    },
    states: {
      joining: {
        after: { [JOIN_DEADLINE_MS]: "detached" },
        on: {
          // A membership a read or write made first gives each join its
          // whole deadline.
          join: { target: "joining", reenter: true },
          joined: "joined",
        },
      },
      joined: { on: { join: "joining" } },
      detached: { type: "final" },
    },
  })
}

type MembershipOwner = Owner<ReturnType<typeof membershipMachine>>

/** A join its membership's end cut short, which the next join may land. */
export class MembershipDetachedError extends Error {
  constructor() {
    super("The membership detached before its join landed")
    this.name = "MembershipDetachedError"
  }
}

/**
 * A close or a delete its runtime did not confirm within `CLOSE_DEADLINE_MS`:
 * its Stop, a background stop or a delete's own call may still land.
 */
export class CloseUnconfirmedError extends Error {
  constructor() {
    super("The runtime did not confirm the close in time")
    this.name = "CloseUnconfirmedError"
  }
}

/**
 * Stops a Session's turn with `stop`, as `session/close` asks, and settles
 * once the turn rests idle and `shown` settled: what the members it names were
 * owed of how the turn ended. A turn already idle is stopped no further and
 * owes nothing more. Each step takes what is left of the close's deadline
 * through `signal`, and rejects with its reason once it aborts.
 */
async function stopAndSettle(
  coordinator: SessionCoordinator,
  scope: SessionScope,
  stop: () => Promise<unknown>,
  shown: (signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal
) {
  if (coordinator.state(scope) === "idle") return
  await unlessAborted(stop(), signal)
  await coordinator.idle(scope, signal)
  await shown(signal)
}

/** Settles as `work` does, unless `signal` aborts first: then with its reason. */
export function unlessAborted<T>(work: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    work
      .finally(() => signal.removeEventListener("abort", abort))
      .then(resolve, reject)
  })
}

export function createChannels(options: CreateChannelsOptions) {
  const { coordinator, runtime, logger } = options
  const clock = options.clock ?? defaultClock
  const historyReach = options.historyReach ?? HISTORY_REACH
  const channels = createChannelTable({
    ...options,
    clock,
    snapshot: (scope) => coordinator.snapshot(scope),
  })
  const machine = membershipMachine(logger, clock)
  /** The memberships reading an older page: one page at a time each. */
  const paging = new WeakSet<Membership>()

  /**
   * One history page, `offset` rows back from the newest, each prompt under
   * the id its answer named.
   */
  async function readHistory(scope: SessionScope, offset = 0) {
    const page = await runtime.history(
      scope.agentId,
      scope.providerSessionId,
      historyReach.pageSize,
      offset
    )
    return coordinator.answeredHistory(scope, page)
  }

  /**
   * The history a from-start resume replays. ACP replays all retained
   * history; a member that pages older history itself gets the newest page
   * and where the page before it starts. Either way the reach bounds the
   * reading.
   */
  async function readReplay(scope: SessionScope, paged: boolean) {
    const newest = await readHistory(scope)
    if (paged) return newest
    const older: SessionHistoryResponse["messages"][] = []
    // A turn stored between two reads shifts the offsets, so the same message
    // can come back on the next older page.
    const seen = new Set(newest.messages.map(({ id }) => id))
    let page = newest
    while (hasOlderPage(page, historyReach.maxOffset)) {
      page = await readHistory(scope, page.nextOffset)
      older.unshift(page.messages.filter(({ id }) => !seen.has(id)))
      for (const { id } of page.messages) seen.add(id)
    }
    return {
      ...newest,
      messages: [...older.flat(), ...newest.messages],
      nextOffset: page.nextOffset,
      truncated: page.truncated,
    }
  }

  function readChildHistory(scope: SessionScope, childSessionId: string) {
    return runtime.childHistory?.(
      scope.agentId,
      scope.providerSessionId,
      childSessionId
    )
  }

  /**
   * Stops each item of `work`, the Session's background work as a close
   * stops it beside its turn: every one is asked, and the first failure is
   * thrown once all were, or the reason `signal` aborts with first. A
   * runtime that cannot stop a child alone leaves each running.
   */
  async function stopBackground(
    scope: SessionScope,
    signal: AbortSignal,
    work: readonly BackgroundWork[]
  ) {
    const stopped = await unlessAborted(
      Promise.allSettled(
        work.map((item) =>
          item.kind === "child"
            ? coordinator.stopChild(scope, item.childSessionId)
            : coordinator.stopTerminal(scope, item.terminalId)
        )
      ),
      signal
    )
    const failed = stopped.find((settled) => settled.status === "rejected")
    if (failed) throw failed.reason
  }

  /**
   * Settles once the `deleter`, if a member, was shown how the Session's turn
   * ended, as its close would wait, and once every member was or
   * `DELETE_SHOWN_MS` passed: any other member slower than that is behind its
   * socket, and a delete goes on without it, so one member's slow reader
   * never fails another's delete. Rejects with `signal`'s reason once it
   * aborts.
   */
  async function everyMemberShown(
    scope: SessionScope,
    signal: AbortSignal,
    deleter?: ShownMember
  ) {
    const wait = new Deadline(DELETE_SHOWN_MS, clock, signal)
    const othersShown = async () => {
      try {
        await wait.run(() => channels.shown(scope))
      } catch (cause) {
        if (signal.aborted || cause !== wait.signal.reason) throw cause
        const { agentId, sessionId } = scope
        logger.warn({ agentId, sessionId }, "channel.delete.shown_late")
      }
    }
    await Promise.all([
      deleter && unlessAborted(deleter.shown(), signal),
      othersShown(),
    ])
  }

  return {
    ...channels,
    historyReach,
    /** Joins one member to one Session until the membership detaches. */
    join(member: Member, scope: MemberScope, membership: MembershipOptions) {
      const owner = createOwner(machine, {
        logger: membership.logger,
        clock,
        bindings: {
          agentId: scope.agentId,
          membershipId: membership.membershipId,
        },
      })
      return new Membership(
        channels,
        member,
        scope,
        { ...membership, coordinator, clock, readReplay, readChildHistory },
        owner
      )
    },

    /**
     * Resumes one member's view of its Session, rebuilt from its history
     * first when `view` asks `fromStart` or its position cannot be followed:
     * the newest page alone for a member that `paged` older history itself.
     * The view reads the history, then the live events the journal buffered,
     * then, for a resume with a cursor, `replay_complete` and what it held,
     * then the Session's state and the row the gateway holds, before the
     * answer; the setup it tells is read beside all that, and built from after
     * it. The join lands once the answer is written, and the Session's
     * readings and row reach the member as events after it. A Session waiting
     * on input asks its runtime whether the wait still stands, which the
     * answer does not wait for. A resume the journal serves asks the provider
     * nothing first: the reads its join starts, and the turn subscription,
     * find a Session gone meanwhile and end it, which spares every rejoin a
     * round trip.
     */
    async resume(
      membership: Membership,
      position: ResumePosition,
      view?: ResumeView
    ): Promise<CommandResults["resume"]> {
      try {
        // The setup is read beside the replay, and told after it.
        const [resumed, readings] = await Promise.all([
          membership.resume(position, view),
          membership.readSetup(),
        ])
        await membership.showRow()
        const setup = await membership.setup(readings)
        membership.joined()
        if (
          !membership.pending &&
          coordinator.state(membership.scope) === "waiting-for-input"
        )
          channels
            .recheck(membership.scope)
            .catch((err: unknown) =>
              logger.error({ err }, "channel.adopt.failed")
            )
        return { ...resumed, setup }
      } finally {
        membership.answered()
      }
    },

    /**
     * Shows one member an older page of its Session, as tagged updates ahead
     * of the answer, its `replay_complete`, the Session's current state and
     * the row the gateway holds after them, as a resume shows them. A member
     * reads one page at a time.
     */
    async olderPage(
      membership: Membership,
      older: { cursor: string; offset: number }
    ): Promise<CommandResults["older-page"]> {
      if (paging.has(membership)) throw new CommandRefusedError("invalid")
      paging.add(membership)
      try {
        const page = await membership.showOlderPage(async () => {
          const page = await readHistory(membership.scope, older.offset)
          // A cursor past this Session's history was never issued for it. One
          // at its end was: a runtime that estimates `total` learns the start
          // only by reading an empty page there.
          if (older.offset > page.total)
            throw new CommandRefusedError("invalid")
          return page
        }, older)
        // ACP's current session info follows a replay, a page's as well.
        await membership.showRow()
        // Every resume answer restates the setup, a page read's as well.
        return { page, setup: await membership.setup() }
      } catch (cause) {
        membership.endIfGone(cause)
        throw cause
      } finally {
        paging.delete(membership)
        membership.answered()
      }
    },

    /**
     * Creates a Session in `agentId` for `principalId`. A repeat of a client
     * id answers the Session its first create made.
     */
    createSession(agentId: string, input: CreateInput, principalId: string) {
      return coordinator.createSession(agentId, input, principalId)
    },

    /**
     * Runs one close or one delete, `work`, under one `CLOSE_DEADLINE_MS`,
     * which each of its steps takes what is left of through `signal`. One
     * still waiting when it passes throws `CloseUnconfirmedError`: what it
     * asked of the runtime may still land.
     */
    async closing<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const deadline = new Deadline(CLOSE_DEADLINE_MS, clock)
      try {
        return await work(deadline.signal)
      } catch (cause) {
        const { signal } = deadline
        if (signal.aborted && cause === signal.reason)
          throw new CloseUnconfirmedError()
        throw cause
      } finally {
        deadline.clear()
      }
    },

    /**
     * Discards a Session a member closed, where a create here made it, no
     * prompt reached it, and nothing else holds it. The member has left, so
     * the close waits on the discard only until `signal` aborts, and the
     * discard goes on.
     */
    async closed(scope: SessionScope, signal: AbortSignal) {
      await unlessAborted(coordinator.closed(scope), signal).catch(
        (cause: unknown) => {
          if (cause !== signal.reason) throw cause
        }
      )
    },

    stopBackground,

    /**
     * Stops all of a Session's work as `session/delete` asks, as a close on
     * every connection would: its turn, settling once the `deleter`, if a
     * member, was shown how it ended, and each member was or
     * `DELETE_SHOWN_MS` passed, then every background child. Throws as
     * `stopAndSettle` and `stopBackground` do.
     */
    async stopWork(
      scope: SessionScope,
      signal: AbortSignal,
      deleter?: ShownMember
    ) {
      await stopAndSettle(
        coordinator,
        scope,
        () => coordinator.stop(scope),
        (shownSignal) => everyMemberShown(scope, shownSignal, deleter),
        signal
      )
      await stopBackground(scope, signal, channels.backgroundWork(scope))
    },

    /** Whether the runtime forks Sessions. */
    get forks() {
      return coordinator.forks
    },

    /** Forks a Session into a new one, answered as `createSession` answers. */
    forkSession(scope: SessionScope) {
      return coordinator.forkSession(scope)
    },

    /** The model options the Session offers now, which a switch picks from. */
    models(scope: SessionScope) {
      return coordinator.models(scope)
    },

    /**
     * Switches the model of the Session `membership` asked it of. As ACP
     * has a writer told, its member is shown the switch before its answer,
     * and every member hears the readings the switch moved once that answer
     * is written; the writer is not shown its own switch again.
     */
    switchModel(
      membership: Membership,
      write: SessionModelUpdateRequest
    ): Promise<SessionModelsResponse> {
      return coordinator.switchModel(
        membership.scope,
        write,
        async (models, report) => {
          await membership.showSwitch(models)
          membership.afterResponse(async () => report())
        }
      )
    },
  }
}

/** An older page one member asked for by its cursor. */
type OlderPage = { cursor: string; offset: number }

/**
 * One replay a member is shown, a resume's from its cursor or an older
 * page's, with each child Session it announced: ACP owes the Session one
 * `replay_complete`, and each child one of its own.
 */
type Replay = { children: Set<string>; older?: OlderPage }

/** One event a replay held back, and what learns once it is shown. */
type HeldEvent = { event: SessionEvent; shown: PromiseWithResolvers<void> }

/**
 * Whether `event` reaches a member at once while a replay is in flight: the
 * history it replays, as a page, a stream's buffer up to its cut, the prompt
 * of the turn that buffer replays while a resume is `restating` the view, and
 * a replay's end; and what is neither a `session/update` nor a request, a
 * failure's report and a withdrawal of a request already asked. ACP has
 * nothing else precede `replay_complete`.
 */
function showsInReplay(event: SessionEvent, restating: boolean) {
  switch (event.kind) {
    case "history":
    case "child-history":
    case "replay-complete":
    case "request-withdrawn":
    case "error":
      return true
    case "turn":
    case "child":
      return event.replayed === true
    // No journal keeps a terminal's steps between turns.
    case "terminal":
      return false
    case "prompt":
      return restating
    case "request-asked":
    case "question-answered":
    case "execution":
    case "background":
    case "usage":
    case "model":
    case "session-info":
    case "commands":
    case "notice":
      return false
  }
  return unhandledKind(event) ?? false
}

/**
 * The child Sessions `event` announces, as a member's transport announces
 * them: each a page's row names, and each a report names, a child's child's
 * included.
 */
function announcedChildren(event: SessionEvent): string[] {
  if (event.kind === "history" || event.kind === "child-history")
    return event.page.messages.flatMap((message) =>
      message.role === "activity" && message.activityType === "CHILD_SESSION"
        ? [message.content.childSessionId]
        : []
    )
  if (event.kind !== "child") return []
  const reported =
    event.event.kind === TurnEventKind.ChildSessionEvent
      ? event.event.event
      : event.event
  return reported.kind === TurnEventKind.ChildSessionUpdated
    ? [reported.childSessionId]
    : []
}

/**
 * One Session as one member observes it: at most one coordinator
 * subscription, the cursor it has reached, and the requests it was asked.
 *
 * A membership owns only the member's subscriber lifetime. Detaching
 * releases the subscription, its place in the Session's channel and the
 * readings it was given, and nothing else: the native Session, the
 * coordinator's logical execution, and a pending request all outlive it.
 */
class Membership {
  readonly #channels: ChannelTable
  readonly #member: Member
  readonly #addressed: MemberScope
  readonly #options: MembershipContext
  #subscription: CoordinatedTurnSubscription | undefined
  /** Subscriptions a restart dropped, whose remaining events nobody is owed. */
  readonly #dropped = new WeakSet<CoordinatedTurnSubscription>()
  /**
   * The requests this member's stack was offered and not settled, and those
   * of them its connection was handed: a decline needs the first, an answer
   * and a withdrawal the second.
   */
  readonly #offered = new Set<string>()
  readonly #delivered = new Set<string>()
  #sequence = 0
  #stopRequested = false
  /** The turnId the latest subscription carried, which outlives its stream. */
  #followedTurn: string | undefined
  /** The turn whose stream this member last fell behind and rebuilt for. */
  #rebuiltTurn: string | undefined
  /**
   * The model options this member's own switch was shown, which the reading
   * that follows the switch shows it no more.
   */
  #switched: SessionModelsResponse | undefined
  /**
   * The row a resume showed this member before its answer, which the row
   * its join's readings start with shows it no more.
   */
  #rowShown: SessionRow | undefined
  /** Whether this member's view pages older history itself. */
  #paged = false
  /** Settles once the member was shown what the journal buffered. */
  #caughtUp: Promise<void> = Promise.resolve()
  /** The turn state the member's stream last showed it since its resume. */
  #stated: string | undefined
  /**
   * Set while a resume builds the view, which is told the turn's state once
   * caught up: what a follow meanwhile replays says no state of its own.
   */
  #restating = false
  /** What a resume in flight waits on, which a missed join deadline names. */
  #resuming: "follow" | "history" | "report" | undefined
  /** Set once this member parts, so only a missed deadline warns. */
  #parted = false
  /**
   * The turn whose stream an interrupt ended, which this member follows again
   * once its coordinator settles whether it still runs.
   */
  #interrupted: string | undefined
  /**
   * Set while a from-start replay rebuilds the view: the channel waits for it.
   */
  #rebuilding = false
  /**
   * The replays in flight on this member's view. Until each completes, the
   * member is shown only replayed history, and every other event waits in
   * `#held`, in the order it came.
   */
  readonly #replays = new Set<Replay>()
  #held: HeldEvent[] = []
  /** Set while the held events go out, which later ones queue behind. */
  #releasing = false
  /**
   * The children a completed replay accounted for, until its answer is
   * written: one first announced in between is owed its own
   * `replay_complete` at once, as ACP has every child announced between a
   * resume and its answer get one.
   */
  #answering: Replay | undefined
  /** The notices that arrived while the view was rebuilt, shown after its page. */
  #heldNotices: SessionNotice[] = []
  /**
   * Background child and terminal events held, as notices are, while the
   * view rebuilds.
   */
  #heldBackground: {
    turnId: string
    event: ChildTurnEvent | TerminalTurnEvent
  }[] = []
  /**
   * The work this member was shown each child of its Session doing, by child
   * id. The Session's background work is each that still runs, at work or
   * `unknown`, detached from foreground work; every state the member is
   * shown carries that list, and its close stops it.
   */
  readonly #followed = new Map<string, FollowedWork>()
  /**
   * The stream a background child event names, one per turn that spawned
   * it, so a transport keys the child's state the same across its events.
   */
  readonly #backgroundStreams = new Map<string, TurnStream>()
  /** The last stream this member was shown, settling once it has shown all. */
  #streamed: { turnId: string; done: Promise<void> } | undefined
  /**
   * The follow or start in flight. Both subscribe this member, so one waits
   * for the other rather than both subscribing it to the same turn.
   */
  #entering: Promise<unknown> | undefined
  /** This member as the Session's channel addresses it. */
  readonly #delivery: MembershipDelivery
  #partChannel: (() => void) | undefined
  /** Releases the Session's readings, which the member is given once joined. */
  #cells: (() => void) | undefined
  readonly #owner: MembershipOwner
  /** Aborts as the membership detaches, which ends a join still in flight. */
  readonly #detaching: AbortSignal

  constructor(
    channels: ChannelTable,
    member: Member,
    scope: MemberScope,
    options: MembershipContext,
    owner: MembershipOwner
  ) {
    this.#channels = channels
    this.#member = member
    this.#addressed = scope
    this.#options = options
    this.#owner = owner
    this.#detaching = owner.stack.adopt(new AbortController(), (controller) =>
      controller.abort(new MembershipDetachedError())
    ).signal
    owner.stack.defer(() => {
      this.#partChannel?.()
      this.#releaseCells()
      this.#subscription?.close()
      this.#subscription = undefined
      // A member that detached is shown nothing more, so nothing waits on it.
      this.#replays.clear()
      for (const { shown } of this.#held.splice(0)) shown.resolve()
    })
    // A Session a member is on, joining or joined, is never discarded.
    if (hasSession(scope)) owner.stack.defer(options.coordinator.hold(scope))
    this.#delivery = {
      sendTurn: ({ messageId, content }) =>
        this.#rebuilding
          ? undefined
          : this.emit({ kind: "prompt", messageId, content, own: false }),
      // A view being rebuilt rejoins and follows once its page lands.
      follow: async () =>
        this.#rebuilding || (await this.#follow(false)) !== undefined
          ? "following"
          : "idle",
      followedTurn: () => this.#followedTurn,
      rebuild: async (ended) => {
        if (ended !== undefined && this.#streamed?.turnId === ended)
          await this.#streamed.done
        await this.#rebuild()
      },
      // A Session the provider reports gone ends each of its memberships.
      report: (cause) => {
        if (this.detached || this.endIfGone(cause)) return
        const failure = options.describe(cause)
        options.logger.error(
          { errorCode: failure.code, message: failure.message },
          "channel.failed"
        )
      },
      notice: (notice) => {
        if (this.#rebuilding) this.#heldNotices.push(notice)
        else this.#showNotice(notice)
      },
      child: (turnId, event) => {
        if (this.#rebuilding) this.#heldBackground.push({ turnId, event })
        else this.#showBackgroundChild(turnId, event)
      },
      terminal: (turnId, event) => {
        if (this.#rebuilding) this.#heldBackground.push({ turnId, event })
        else this.#showBackgroundTerminal(turnId, event)
      },
      offerChild: (request) => this.#offerChild(request),
      withdrawChild: (requestId) => this.#withdraw(requestId),
      shown: () => this.shown(),
    }
  }

  /** The Session this member joined, as its transport resolved it. */
  get scope() {
    return this.#scope
  }

  /**
   * Whether this member addresses an invitation whose Session does not exist
   * yet. It is shown what it can do until its first Send creates the Session,
   * which joins it anew.
   */
  get pending() {
    return !hasSession(this.#addressed)
  }

  get #scope(): SessionScope {
    if (!hasSession(this.#addressed))
      throw new Error("The invited Session does not exist yet")
    return this.#addressed
  }

  /** Whether this membership is over: it parted, or a deadline passed. */
  get detached() {
    return this.#owner.stack.disposed
  }

  /**
   * Shows this member one event of its Session, through its stack. A member
   * that detached is shown nothing, and neither is one whose stack hides it: a
   * resolved promise rather than `undefined`, because callers chain on what
   * this returns, and never an extra await, because a turn's delivery order
   * rides on the send starting now. What the stack declines runs once the
   * event is delivered. While a replay is in flight an event it does not
   * replay waits, and settles once shown after the replay's end; one that
   * comes while held events go out waits behind them.
   */
  emit(event: SessionEvent): Promise<void> {
    if (this.detached) return Promise.resolve()
    const holds =
      this.#replays.size > 0
        ? !showsInReplay(event, this.#restating)
        : this.#held.length > 0
    if (!holds) return this.#write(event)
    const shown = Promise.withResolvers<void>()
    this.#held.push({ event, shown })
    return shown.promise
  }

  /**
   * Writes one event now, as `emit` describes, then the `replay_complete`
   * each child it announces is owed at once.
   */
  #write(event: SessionEvent): Promise<void> {
    if (this.detached) return Promise.resolve()
    // A request held while a replay ran, and settled meanwhile, is not asked.
    if (
      event.kind === "request-asked" &&
      !this.#offered.has(event.request.requestId)
    )
      return Promise.resolve()
    const declines = new Set<string>()
    let shown: ReturnType<typeof runEvents>
    try {
      shown = this.#shown(this.#listing(event), (requestId) =>
        declines.add(requestId)
      )
    } catch (cause) {
      // A stack that throws costs this event alone, through the caller's own
      // handling of a failed send, never the members or events after it.
      return Promise.reject(cause)
    }
    if (shown?.kind === "request-asked")
      this.#delivered.add(shown.request.requestId)
    const sent = shown ? this.#member.connection.send(shown) : Promise.resolve()
    // Said at once after the report that moved it, as ACP has a list follow
    // what it announces or ends; a view not stated yet since its resume
    // takes the list with the state that closes it.
    const moved = shown !== undefined && this.#noteBackground(shown)
    if (moved && this.#stated !== undefined) this.#restateBackground()
    // The caller learns whether the event was sent; the declines run either
    // way.
    const decline = () =>
      Promise.all([...declines].map((id) => this.#decline(id)))
    if (declines.size > 0)
      sent
        .then(decline, decline)
        .catch((err: unknown) =>
          this.#options.logger.warn(
            { err },
            "membership.request.decline.failed"
          )
        )
    const owed = this.#announced(event)
    return owed.length === 0
      ? sent
      : sent.then(() => this.#completeChildren(owed, this.#answering?.older))
  }

  /**
   * Records the children `event` announces. A replay in flight owes each its
   * own `replay_complete` once it completes; a completed one whose answer is
   * not written yet owes one at once to each it did not account for, which
   * this returns.
   */
  #announced(event: SessionEvent): string[] {
    const announced = announcedChildren(event)
    if (announced.length === 0) return []
    const older =
      event.kind === "history" || event.kind === "child-history"
        ? event.older
        : undefined
    for (const replay of this.#replays)
      if (replay.older?.cursor === older?.cursor)
        for (const childSessionId of announced)
          replay.children.add(childSessionId)
    const answering = this.#answering
    if (this.#replays.size > 0 || !answering) return []
    const owed = announced.filter((id) => !answering.children.has(id))
    for (const childSessionId of owed) answering.children.add(childSessionId)
    return owed
  }

  /** The Session's background work as this member was shown it. */
  backgroundWork(): BackgroundWork[] {
    return [...this.#followed.values()].flatMap(({ item, detached, runs }) =>
      detached && runs ? [item] : []
    )
  }

  /** `event` with the background list, where it reports the Session's state. */
  #listing(event: SessionEvent): SessionEvent {
    const states =
      event.kind === "execution" ||
      (event.kind === "turn" && statedBy(event.event) !== undefined)
    return states ? { ...event, background: this.backgroundWork() } : event
  }

  /**
   * Notes what `shown` tells of the Session's work, returning whether the
   * list moved: a child's report, which names the call that spawned it and
   * whether it still runs, and outlived its turn when shown between turns;
   * and a call's finish, which detaches the work it started from the
   * foreground, since no foreground work waits on that call any longer.
   */
  #noteBackground(shown: MemberEvent) {
    const before = this.backgroundWork().length
    const listed = new Set(this.backgroundWork().map(workKey))
    if (shown.kind === "child") {
      const report = shown.event
      // A child's own child is announced in its stream, not the Session's.
      if (report.kind !== TurnEventKind.ChildSessionUpdated) return false
      const { childSessionId, toolCallId, status } = report
      this.#track(
        { kind: "child", childSessionId },
        toolCallId,
        shown.background === true,
        status === undefined ? undefined : runs(report)
      )
    } else if (
      shown.kind === "terminal" ||
      (shown.kind === "turn" &&
        shown.event.kind === TurnEventKind.TerminalOutput)
    ) {
      // A process outlives its call where the call returned before its exit.
      const step = shown.event as TerminalTurnEvent
      this.#track(
        { kind: "terminal", terminalId: step.terminalId },
        step.toolCallId,
        shown.kind === "terminal",
        step.exit === undefined
      )
    } else if (
      shown.kind === "turn" &&
      shown.event.kind === TurnEventKind.ToolCallFinished
    ) {
      const { toolCallId } = shown.event
      for (const followed of this.#followed.values())
        if (followed.toolCallId === toolCallId) followed.detached = true
    } else if (shown.kind === "turn" && statedBy(shown.event) === "idle") {
      // Past its turn, work shown over has no call left to detach it from.
      for (const [key, { runs: still }] of this.#followed)
        if (!still) this.#followed.delete(key)
      return false
    } else return false
    const after = this.backgroundWork()
    return (
      after.length !== before ||
      after.some((item) => !listed.has(workKey(item)))
    )
  }

  /**
   * Notes one step of `item`: the call that started it, whether it came
   * between turns, which detaches it, and whether it still runs, where the
   * step says. Work shown over between turns is forgotten at once, and work
   * shown over in a turn once that turn ends.
   */
  #track(
    item: BackgroundWork,
    toolCallId: string | undefined,
    betweenTurns: boolean,
    stillRuns: boolean | undefined
  ) {
    const key = workKey(item)
    if (betweenTurns && stillRuns === false) {
      this.#followed.delete(key)
      return
    }
    const followed = this.#followed.get(key) ?? {
      item,
      detached: false,
      runs: false,
    }
    this.#followed.set(key, {
      ...followed,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      detached: followed.detached || betweenTurns,
      runs: stillRuns ?? followed.runs,
    })
  }

  /** Shows this member its state again, with the list as it stands now. */
  #restateBackground() {
    this.#write({
      kind: "background",
      background: this.backgroundWork(),
    }).catch((err: unknown) =>
      this.#options.logger.warn({ err }, "membership.background.failed")
    )
  }

  /** One event as this member's stack shows it, or `undefined` when hidden. */
  #shown(event: SessionEvent, decline: (requestId: string) => void) {
    return runEvents(
      this.#member.middleware,
      {
        // A child's event is the child's, under its own id.
        sessionId:
          event.kind === "child"
            ? event.event.childSessionId
            : event.kind === "child-history"
              ? event.childSessionId
              : event.kind === "replay-complete" && event.child
                ? event.child.childSessionId
                : this.#addressed.sessionId,
        ...event,
      },
      { decline }
    )
  }

  /**
   * Starts one replay of this member's view, which holds every event it
   * does not replay until `#completeReplay` or `#endReplay` ends it.
   */
  #openReplay(older?: OlderPage): Replay {
    const replay: Replay = { children: new Set(), ...(older ? { older } : {}) }
    this.#replays.add(replay)
    return replay
  }

  /**
   * Completes one replay as ACP asks, once all it replayed was shown: a
   * `replay_complete` on each child it announced, then on the Session, and
   * then what it held goes out. Until the answer is written, a child first
   * announced is owed its own at once.
   */
  async #completeReplay(replay: Replay) {
    const { older } = replay
    await this.#completeChildren([...replay.children], older)
    await this.#write({ kind: "replay-complete", ...(older ? { older } : {}) })
    this.#answering = replay
    this.#endReplay(replay)
  }

  /** Shows each child's `replay_complete`, under the Session that owns it. */
  async #completeChildren(
    childSessionIds: readonly string[],
    older?: OlderPage
  ) {
    const parentSessionId = this.#addressed.sessionId
    for (const childSessionId of childSessionIds)
      await this.#write({
        kind: "replay-complete",
        child: { parentSessionId, childSessionId },
        ...(older ? { older } : {}),
      })
  }

  /**
   * Ends one replay, completed or not: once none is in flight, the events
   * the replays held go out in order. A replay that never completed sends no
   * `replay_complete`, as ACP has a replay that cannot finish send none.
   */
  #endReplay(replay: Replay) {
    if (!this.#replays.delete(replay) || this.#replays.size > 0) return
    this.#release().catch((err: unknown) =>
      this.#options.logger.error({ err }, "membership.release.failed")
    )
  }

  /**
   * Shows the held events in order, each settling as it goes out, until none
   * is left or another replay holds them again.
   */
  async #release() {
    if (this.#releasing) return
    this.#releasing = true
    try {
      while (this.#replays.size === 0) {
        const next = this.#held.shift()
        if (!next) break
        await this.#write(next.event).then(
          next.shown.resolve,
          next.shown.reject
        )
      }
    } finally {
      this.#releasing = false
    }
  }

  /**
   * Ends what a completed replay owes the children first announced before
   * its answer, once the answer to the request that asked for it is
   * written. Call it as `afterResponse` asks.
   */
  answered() {
    const answering = this.#answering
    this.afterResponse(async () => {
      if (this.#answering === answering) this.#answering = undefined
    })
  }

  /**
   * Reads what a setup answer tells this member, each reading at most once
   * and seeded for this member's own readings; one that cannot be read in
   * time answers the reading held, and its value follows as an update. A
   * Session being discarded is refused, as its resume is, and read no more.
   */
  async readSetup(): Promise<SetupReadings> {
    if (!this.pending) this.#options.coordinator.refuseDiscarded(this.#scope)
    return this.#options.coordinator.setupReadings(
      this.#addressed,
      this.#options.membershipId
    )
  }

  /**
   * What a setup answer tells this member of its Session: the model options
   * and capabilities `readings` holds, read now when none is given, as the
   * `model` and `commands` events its stack would show it, so it is told only
   * what its stream shows. Take it before `joined`, which lets those updates
   * go.
   */
  async setup(readings?: SetupReadings): Promise<MemberSetup> {
    const [models, capabilities] = readings ?? (await this.readSetup())
    const shown = (event: SessionEvent) => {
      try {
        return this.#shown(event, () => undefined)
      } catch (err) {
        // As a stack that throws on an event costs it that event alone.
        this.#options.logger.warn({ err }, "membership.setup.hidden")
        return undefined
      }
    }
    const model = models && shown({ kind: "model", models })
    const commands = capabilities && shown({ kind: "commands", capabilities })
    return {
      ...(model?.kind === "model" ? { models: model.models } : {}),
      ...(commands?.kind === "commands"
        ? { capabilities: commands.capabilities }
        : {}),
    }
  }

  /**
   * Builds this member's view on resume, as its `view` asks. One from the
   * start is rebuilt from history first; any other keeps what it holds up to
   * `position`, and is rebuilt all the same when that cannot be positioned.
   * The view keeps whether it pages older history, for each rebuild after.
   * Either way the
   * member joins the channel, reads the live events the journal buffered and
   * then the Session's state. A resume with a cursor replays: from the
   * request on, the member is shown only the history it replays until its
   * `replay_complete`, and the rest after it. Returns the page it replayed. A
   * join that has not landed by its deadline detaches the membership, and the
   * resume rejects then; one that finds its Session gone ends it.
   */
  resume(
    position: ResumePosition,
    view: ResumeView = {
      fromStart: false,
      positioned: true,
      paged: this.#paged,
    }
  ) {
    this.#releaseCells()
    // A resume with a cursor replays, and holds from its request on all it
    // does not replay, as ACP has only history precede `replay_complete`.
    const replay =
      view.fromStart || view.positioned ? this.#openReplay() : undefined
    // The resume answers before its join lands; a Session found gone between
    // the two still ends this member.
    if (!this.pending)
      this.#cells = this.#options.coordinator.subscribeReadings(
        this.#scope,
        this.#options.membershipId,
        { gone: (cause) => this.#end(cause) }
      )
    this.#send({ type: "join" })
    this.#paged = view.paged
    return unlessAborted(this.#resume(position, view, replay), this.#detaching)
      .catch((cause: unknown) => {
        // A join its deadline cut short; the membership's log names its Session.
        if (cause instanceof MembershipDetachedError && !this.#parted)
          this.#options.logger.warn(
            { agentId: this.#addressed.agentId, waitingOn: this.#resuming },
            "membership.join.expired"
          )
        this.endIfGone(cause)
        throw cause
      })
      .finally(() => {
        if (replay) this.#endReplay(replay)
      })
  }

  /**
   * Builds the view as `resume` describes. A `replay` completes once the
   * history and what the view's own streams buffered were shown, before the
   * Session's state; a stream the view already followed streams on behind it.
   */
  async #resume(
    position: ResumePosition,
    { fromStart, positioned }: ResumeView,
    replay?: Replay
  ): Promise<{ history?: SessionHistoryResponse }> {
    // A fresh invitation has no history to replay and no turn to follow, and
    // its empty history completes all the same.
    if (this.pending) {
      if (replay) await this.#completeReplay(replay)
      return {}
    }
    this.#options.coordinator.refuseDiscarded(this.#scope)
    this.#stated = undefined
    this.#restating = true
    const followed = this.#caughtUp
    if (replay) this.#caughtUp = Promise.resolve()
    try {
      this.#resuming = "follow"
      let history: SessionHistoryResponse | undefined
      if (fromStart) history = await this.#replay()
      else if (!positioned) await this.#followNext()
      else if (!(await this.#followPositioned(position)))
        history = await this.#replay()
      this.#resuming = "report"
      if (replay) {
        await this.#caughtUp
        await this.#completeReplay(replay)
        await followed
      }
      // ACP has each listed item's current update precede the state that
      // closes a resume: what the runtime reads of the terminals its turns
      // left running reaches the view first.
      await this.#channels.terminalsRead(this.#scope)
      await this.#reportView()
      return history === undefined ? {} : { history }
    } finally {
      this.#restating = false
      this.#resuming = undefined
    }
  }

  /**
   * Closes a view with the Session's state, once the member was shown what
   * the journal buffered: stated unless its stream already said it, with the
   * requests a wait still holds asked again. A view that `restate`s, an older
   * page's, is told again the state its stream last showed it, which no event
   * held back for its replay can overtake, as ACP has a state "delivered in
   * order, without replacing a newer state with a stale snapshot".
   */
  async #reportView(restate = false) {
    await this.#caughtUp
    const { state, awaitingStop } = this.#coordinator.snapshot(this.#scope)
    const stated = viewState(state, awaitingStop)
    if (restate) await this.reportExecution(true)
    else if (this.#stated !== stated) {
      this.#stated = stated
      await this.reportExecution()
    }
    if (state === "waiting-for-input") this.reissuePending()
  }

  /**
   * Rebuilds the view from history and follows the live turn beside it,
   * returning the page it showed.
   */
  async #replay(): Promise<SessionHistoryResponse> {
    this.#resuming = "history"
    // A correction the provider persisted the moment it accepted the steer is
    // already in this page, so the journal's acknowledgement of it is dropped.
    const replay = await this.#replayHistory(() =>
      this.#options.readReplay(this.#scope, this.#paged)
    )
    // Joined after its history and before any other provider read, so a turn
    // another browser starts meanwhile reaches it, prompt first.
    this.joinChannel(
      showsPrompt(this.#channels.current(this.#scope), {}, replay.history),
      true
    )
    this.#resuming = "follow"
    const followed = await this.#followPage(replay)
    // A turn that ended before it was followed took the rows the page left to
    // its replay, and history now holds them.
    if ("cut" in replay && followed !== replay.cut) return this.#replay()
    return replay.history
  }

  /**
   * Rebuilds this member's view in place, as a from-start resume builds it:
   * what a view that fell behind, lost its place, or was shown a prompt
   * without its reply is owed. One that cannot be rebuilt is told why, and
   * left behind no further: its connection closes, and its client resumes.
   */
  async #rebuild() {
    if (this.detached || this.pending) return
    try {
      await this.#resume(
        {},
        {
          fromStart: true,
          positioned: false,
          paged: this.#paged,
        }
      )
    } catch (cause) {
      await this.report(cause)
      this.#cannotCatchUp()
    }
  }

  /**
   * Closes the connection of a member whose view its Session left behind,
   * which ends each Session's activity on it, as ACP has a connection's end
   * do: its client reconnects and resumes every Session it holds, rather
   * than holding one the gateway no longer streams to it.
   */
  #cannotCatchUp() {
    if (this.detached) return
    this.#options.logger.warn(
      { membershipId: this.#options.membershipId },
      "membership.cannot_catch_up"
    )
    this.#member.connection.fellBehind()
  }

  /**
   * Lands this member's join once the response to it has been written. From
   * then on the member is given its Session's readings, each the last value
   * at once and then each change, so none overtakes that response.
   */
  joined() {
    this.afterResponse(async () => {
      if (!this.#owner.actor.getSnapshot().matches("joining")) return
      this.#send({ type: "joined" })
      // Taken before the resume's hold is let go, so the Session stays held.
      const held = this.#cells
      this.#cells = this.#subscribeCells()
      held?.()
    })
  }

  /**
   * Runs work once the response for the current request has been written. The
   * caller must have settled every await its response needs before calling
   * this: the task fires on the next turn of the loop, so anything still
   * pending in the handler lets these notifications reach the client before
   * the response does.
   */
  afterResponse(task: () => Promise<void>) {
    setTimeout(() => {
      task().catch((cause: unknown) => this.report(cause))
    }, 0)
  }

  /**
   * Shows this member the older page `read` reads, as ACP has a resume with
   * a cursor replay: from the request on, the member is shown only the page,
   * then the page's `replay_complete`, then what it held and the Session's
   * current state. A page resumes nothing else: the view keeps its channel,
   * follow, and reports, and learns only where the next page starts. A turn
   * longer than the newest page leaves its first rows on older pages too,
   * and the live turn's replay owns those, so the page drops them as the
   * newest page does. Returns the page read.
   */
  async showOlderPage(
    read: () => Promise<SessionHistoryResponse>,
    older: OlderPage
  ) {
    const replay = this.#openReplay(older)
    try {
      const page = await read()
      const live = this.#coordinator.replayStart(this.#scope)?.ids
      await this.#showHistory(live ? withoutLiveRows(page, live) : page, older)
      await this.#completeReplay(replay)
      await this.#reportView(true)
      return page
    } finally {
      this.#endReplay(replay)
    }
  }

  /**
   * Whether this member's stack shows it a child's transcript at all, asked
   * with an empty one before the runtime is asked for the real one.
   */
  #showsChildHistory(childSessionId: string, page: SessionHistoryResponse) {
    return (
      runEvents(
        this.#member.middleware,
        {
          sessionId: childSessionId,
          kind: "child-history",
          parentSessionId: this.#addressed.sessionId,
          childSessionId,
          page: { ...page, sessionId: childSessionId, messages: [] },
        },
        { decline: () => undefined }
      ) !== undefined
    )
  }

  /**
   * Shows this member a history page at the cursor it has reached, then the
   * whole transcript of each child Session the page names, under the child's
   * id. One the member's stack would not show it is not read.
   */
  async #showHistory(
    page: SessionHistoryResponse,
    older?: { cursor: string; offset: number }
  ) {
    await this.emit({
      kind: "history",
      page,
      sequence: this.#sequence,
      ...(older ? { older } : {}),
    })
    for (const message of page.messages) {
      if (message.role !== "activity") continue
      if (message.activityType !== "CHILD_SESSION") continue
      const { childSessionId } = message.content
      if (!this.#showsChildHistory(childSessionId, page)) continue
      const transcript = await this.#options
        .readChildHistory(this.#scope, childSessionId)
        ?.catch((err: unknown) => {
          // A child whose transcript cannot be read is still announced.
          this.#options.logger.warn({ err }, "membership.child_history.failed")
          return undefined
        })
      if (transcript)
        await this.emit({
          kind: "child-history",
          parentSessionId: this.#addressed.sessionId,
          childSessionId,
          page: transcript,
          ...(older ? { older } : {}),
        })
    }
  }

  /**
   * The page a from-start resume replays. The stream the member held stops
   * before the page is read. A running turn the coordinator replays from its
   * start is shown by that replay: the page drops each row the journal
   * buffered, joined by id, so the turn shows once. Any other turn
   * keeps the page, whose history stands for the start the journal no longer
   * holds, and its live events follow it from as far as it had `streamed`. A
   * turn that starts during the read waits for the page and is replayed the
   * same way.
   */
  async #replayPage(read: () => Promise<SessionHistoryResponse>) {
    const scope = this.#scope
    const liveTurn = () => {
      const { state, turnId } = this.#coordinator.snapshot(scope)
      return state === "idle" ? undefined : turnId
    }
    const before = liveTurn()
    const started = () => {
      const after = liveTurn()
      return after !== undefined && after !== before
    }
    const restarted = this.#coordinator.replayStart(scope)
    // The channel's prompts and streams wait while the view is rebuilt, so
    // none lands above the page; `joinChannel` or a recovery ends the hold.
    this.#rebuilding = true
    // Any live stream waits for the page, so none of it lands inside it.
    const stopped = restarted !== undefined || before !== undefined
    if (stopped) await this.#restartStream()
    let history: SessionHistoryResponse
    try {
      history = await read()
    } catch (cause) {
      // A turn that started during the read was held back, so it streams the
      // same way a stopped one does once its reload failed.
      await this.#recoverReplay(stopped || started())
      throw cause
    }
    const held = started()
    // Read after the page, so a row the journal buffered during the read is
    // dropped from it too.
    const shown =
      restarted || held ? this.#coordinator.replayStart(scope) : undefined
    const replay = { held, stopped }
    if (!shown)
      return {
        ...replay,
        history,
        ...(restarted ? {} : { streamed: this.#coordinator.streamed(scope) }),
      }
    return {
      ...replay,
      history: withoutLiveRows(history, shown.ids),
      cut: shown.turnId,
    }
  }

  /**
   * Ends the hold of a from-start replay that failed before the view was
   * rebuilt. A stream the replay stopped, or a turn the hold kept back, still
   * `needsFollow`: the view streams it from its prompt.
   */
  async #recoverReplay(needsFollow: boolean) {
    // A view that was not rebuilt shows nothing it held for after its page.
    this.#heldNotices = []
    this.#heldBackground = []
    this.#rebuilding = false
    if (needsFollow) {
      this.joinChannel(false, true)
      await this.#follow(true).catch((err: unknown) =>
        this.#options.logger.warn({ err }, "membership.follow.failed")
      )
    }
  }

  /**
   * Rebuilds the view from the page a from-start resume replays. A page that
   * cannot reach the view recovers as a failed read does, so the channel's
   * turns still reach it.
   */
  async #replayHistory(read: () => Promise<SessionHistoryResponse>) {
    const replay = await this.#replayPage(read)
    try {
      // Counted on the authoritative page, before a member's stack rebuilds
      // its messages: a guest's projection keeps no user-turn metadata.
      const corrections = persistedCorrections(replay.history)
      await this.#showHistory(replay.history)
      return { ...replay, corrections }
    } catch (cause) {
      await this.#recoverReplay(replay.stopped || replay.held)
      throw cause
    }
  }

  /**
   * Follows the live turn beside a page from as far as it had `streamed` when
   * the page was read, or else as the page left it to the journal. A journal
   * that pruned that point since streams its live events alone, and a turn
   * that ended with it adds nothing to the page. Returns the turnId it streams.
   */
  async #followPage(replay: {
    corrections: number
    streamed?: { turnId: string; after: number }
  }) {
    const { corrections, streamed } = replay
    const { turnId } = this.#coordinator.snapshot(this.#scope)
    if (streamed && streamed.turnId === turnId) {
      const followed = await this.#follow(
        true,
        streamed.after,
        corrections
      ).catch((cause: unknown) => {
        if (!(cause instanceof ReplayCursorLostError)) throw cause
        return null
      })
      if (followed !== null) return followed
    }
    return this.#follow(true, undefined, corrections)
  }

  /**
   * Follows the live turn from `position`, returning whether the view holds
   * the Session from there: a cursor for another turn, one the journal no
   * longer holds, or none beside a turn the journal cannot replay whole
   * leaves the view to be rebuilt from history. So does a child that outlived
   * its turn, whose updates no journal keeps.
   */
  async #followPositioned(position: ResumePosition) {
    if (this.#channels.followsChildren(this.#scope)) return false
    this.joinChannel(showsPrompt(this.#channels.current(this.#scope), position))
    const { state, turnId } = this.#coordinator.snapshot(this.#scope)
    if (position.turnId !== undefined && position.turnId !== turnId)
      return false
    const { after } = position
    if (after === undefined) {
      if (state === "idle" || turnId === undefined) return true
      if (!this.#coordinator.replayStart(this.#scope)) return false
      await this.#follow(true)
      return true
    }
    // A settled turn streams nothing more: the view holds it once its cursor
    // reached the turn's last event.
    if (state === "idle") return this.#coordinator.holds(this.#scope, after)
    if (turnId !== undefined) await this.#reannounceChildren(turnId, after)
    return this.#follow(true, after).then(
      () => true,
      (cause: unknown) => {
        // Only a lost cursor rebuilds; a Session gone or unavailable answers so.
        if (!(cause instanceof ReplayCursorLostError)) throw cause
        return false
      }
    )
  }

  /**
   * Follows the live turn from the next event it streams, as a resume that
   * names no cursor asks: the view is shown nothing that came before, not even
   * the turn's prompt, and is never rebuilt from history.
   */
  async #followNext() {
    this.joinChannel(true)
    await this.#follow(true, "next")
  }

  /**
   * Announces again each child Session the live turn reported up to the
   * view's cursor: the view holds them, but its connection may be a new one,
   * which knows none, and the events after the cursor are theirs too.
   */
  async #reannounceChildren(turnId: string, after: number) {
    const stream: TurnStream = {
      turnId,
      replayedCorrections: 0,
      dropped: false,
    }
    for (const { sequence, event } of this.#coordinator.childReports(
      this.#scope,
      turnId,
      after
    ))
      await this.emit({
        kind: "child",
        parentSessionId: this.#addressed.sessionId,
        stream,
        sequence,
        event,
        replayed: true,
      })
  }

  /**
   * Drops the stream this member is reading, so its next follow replays the
   * turn from the start to a view about to be rebuilt from history. The turn
   * stays followed, so the channel does not subscribe this member meanwhile.
   */
  async #restartStream() {
    await this.#exclusive(async () => {
      const subscription = this.#subscription
      if (!subscription) return
      this.#subscription = undefined
      this.#dropped.add(subscription)
      subscription.close()
    })
  }

  /**
   * Admits one user turn and subscribes to the segment it starts, settling
   * once the coordinator admitted or refused it and the channel was shown
   * the turn. This member is shown its prompt and then the turn once the
   * answer is written. A turn another member won is followed instead; a
   * repeat of the turn this member follows shows it nothing again, and one of
   * a turn the channel was shown, which reached it as it joined, only the
   * turn. `echo` reads the prompt as members are shown it, once admitted.
   */
  async startTurn(
    input: ClientSend,
    echo: () => readonly PromptPart[],
    options: StartOptions = {}
  ): Promise<CommandResults["send"]> {
    // Joined before admission, so a turn that wins the race still reaches it.
    this.joinChannel()
    // Entered from the admission to the showing, so no follow subscribes this
    // member to the turn first. A first admission enters once its prompt is
    // prepared, so a slow one keeps no other turn from reaching this member.
    let entered: Promise<() => void> | undefined
    const enter = () => (entered ??= this.#enter())
    let subscription
    try {
      subscription = await this.#coordinator.start(
        this.#scope,
        {
          ...input,
          prepare: async () => {
            const prepared = await input.prepare()
            await enter()
            return prepared
          },
        },
        this.#access(),
        options
      )
    } catch (cause) {
      entered
        ?.then((release) => release())
        .catch((err: unknown) =>
          this.#options.logger.error({ err }, "membership.release.failed")
        )
      // A Session the start found gone is over: nothing asks after it again.
      if (this.endIfGone(cause)) throw cause
      // No turn started, so no turn end asks the runtime for one it started
      // meanwhile, which may be what refused this one.
      this.#channels
        .recheck(this.#scope)
        .catch((err: unknown) =>
          this.#options.logger.error({ err }, "channel.adopt.failed")
        )
      if (cause instanceof ServerTurnConflictError)
        this.afterResponse(() => this.catchUp())
      // A start the provider may have taken, or a turn that ended before its
      // prompt was stored, is shown to every member as the coordinator holds it.
      if (
        cause instanceof ServerTurnUncertainError ||
        cause instanceof ServerTurnEndedError
      )
        this.afterResponse(() => this.#channels.sync(this.#scope))
      throw cause
    }
    const release = await enter()
    // The prompt goes by the id its provider stored it under, where it did.
    const { messageId } = subscription
    let turn: ChannelTurn
    try {
      if (subscription.turnId === this.#followedTurn) {
        subscription.close()
        return { messageId }
      }
      const { turnId } = subscription
      const content = echo()
      const announced = this.#channels.current(this.#scope)?.turnId === turnId
      const answered = new Promise<void>((resolve) => {
        this.afterResponse(async () => resolve())
      })
      this.#consume(
        subscription,
        0,
        announced
          ? answered
          : answered.then(() =>
              this.emit({ kind: "prompt", messageId, content, own: true })
            )
      )
      if (announced) return { messageId }
      turn = { turnId, messageId, content, at: this.#options.clock.now() }
    } finally {
      release()
    }
    // A turn that started is answered as started, whatever showing it met.
    await this.announce(turn).catch((cause: unknown) => this.report(cause))
    return { messageId }
  }

  /**
   * Joins this member to the Session's channel. `hasPrompt` says the view
   * holds the live turn's prompt; a `replayed` view was just rebuilt from
   * history, so a member already joined rejoins from what it holds.
   */
  joinChannel(hasPrompt = false, replayed = false) {
    this.#rebuilding = false
    // The notices held while the view was rebuilt follow its page.
    const held = this.#heldNotices
    this.#heldNotices = []
    const background = this.#heldBackground
    this.#heldBackground = []
    if (this.detached) return
    for (const notice of held) this.#showNotice(notice)
    for (const { turnId, event } of background)
      if (event.kind === TurnEventKind.TerminalOutput)
        this.#showBackgroundTerminal(turnId, event)
      else this.#showBackgroundChild(turnId, event)
    if (!this.#partChannel) {
      const part = this.#channels.add(this.#scope, this.#delivery, {
        hasPrompt,
      })
      // A request the Session resolves, through another member's answer or a
      // Stop, is withdrawn here so this member stops offering it.
      const unsubscribe = this.#coordinator.subscribeScope(
        this.#scope,
        (event) => {
          if (event.kind !== "attention-resolved") return
          this.#withdraw(event.requestId)
          this.#followContinued(event.turnId)
        }
      )
      this.#partChannel = () => {
        part()
        unsubscribe()
      }
    } else if (replayed)
      this.#channels.rejoin(this.#scope, this.#delivery, { hasPrompt })
  }

  /**
   * Shows the channel a turn this member admitted, then brings every member in.
   */
  async announce(turn: ChannelTurn) {
    await this.#channels.broadcastTurn(this.#scope, turn, this.#delivery)
    await this.#channels.sync(this.#scope)
  }

  /** Brings this member alone into whatever turn the channel is running. */
  catchUp() {
    return this.#channels.catchUp(this.#scope, this.#delivery)
  }

  /** Stops one child Session this Session's live turn spawned. */
  cancelChild(childSessionId: string) {
    return this.#coordinator.stopChild(this.#scope, childSessionId)
  }

  /** Requests Stop, reporting an unsettled provider as `stopping`. */
  async cancel() {
    const status = await this.#coordinator.stop(this.#scope)
    if (status !== "stopping") return
    this.#stopRequested = true
    await this.reportExecution()
  }

  /**
   * Stops the Session's turn as `session/close` asks, as `cancel` does, and
   * settles once this member was shown how it ended: ACP has a closer shown
   * the turn's final updates and its idle state before the close's answer.
   * Throws as `stopAndSettle` does, under the close's `signal`.
   */
  closeTurn(signal: AbortSignal) {
    return stopAndSettle(
      this.#coordinator,
      this.#scope,
      () => this.cancel(),
      (shownSignal) => unlessAborted(this.shown(), shownSignal),
      signal
    )
  }

  /** Settles once this member was shown the last stream it follows, whole. */
  async shown() {
    // A follow in flight subscribes before its stream can be waited on.
    await this.#exclusive(async () => undefined)
    await this.#streamed?.done
  }

  /**
   * Reports the Session's execution outside a turn stream: what a resume or
   * an acknowledged Stop owes the member, or, where it `repeats`, the state
   * its stream last showed it, said again.
   */
  reportExecution(repeats = false) {
    const { state, turnId, awaitingStop, startedAt } =
      this.#coordinator.snapshot(this.#scope)
    return this.emit({
      kind: "execution",
      state,
      ...(turnId === undefined ? {} : { turnId }),
      ...(awaitingStop ? { awaitingStop } : {}),
      ...(startedAt === undefined ? {} : { startedAt }),
      sequence: this.#sequence,
      ...(repeats ? { repeats } : {}),
    })
  }

  /**
   * Subscribes this member to its Session's readings, which its stack shows it
   * or hides. The coordinator's reporter re-reads a value that is unreadable
   * right after joining, usually the provider's agent still being built, and
   * leaves the last reading standing if it never becomes readable. The
   * execution is never restated here: the resume stated it, and each later
   * move reaches the member on its turn's stream, which a reading would run
   * ahead of.
   */
  #subscribeCells() {
    const { coordinator, membershipId } = this.#options
    const { agentId, sessionId } = this.#addressed
    const subscribeCapabilities = () =>
      coordinator.subscribeCapabilities(
        { agentId, sessionId },
        membershipId,
        (capabilities) => this.#deliver({ kind: "commands", capabilities })
      )
    // A fresh invitation has no Session to read, only what it can do there.
    if (this.pending) return subscribeCapabilities()
    const readings = coordinator.subscribeReadings(this.#scope, membershipId, {
      execution: () => this.#followInterrupted(),
      usage: (usage) => this.#deliver({ kind: "usage", usage }),
      model: (models) => this.#showModels(models),
      gone: (cause) => this.#end(cause),
    })
    const capabilities = subscribeCapabilities()
    const row = this.#options.subscribeRow((row) => {
      const shown = this.#rowShown
      this.#rowShown = undefined
      if (shown && isDeepStrictEqual(shown, row)) return
      this.#deliver({ kind: "session-info", row }).catch((err: unknown) =>
        this.#options.logger.error({ err }, "membership.row.failed")
      )
    })
    return () => {
      readings()
      capabilities()
      row()
    }
  }

  /**
   * Shows this member the row the gateway holds of its Session, ahead of a
   * resume's answer, as ACP has current session info precede it. It reads
   * no provider, so a rejoin the journal serves still asks none first: a row
   * the gateway does not hold yet, or one the read after the join changes,
   * follows the answer as an update.
   */
  async showRow() {
    const row = this.pending ? undefined : this.#options.knownRow?.()
    if (!row) return
    this.#rowShown = row
    await this.#deliver({ kind: "session-info", row })
  }

  /**
   * Shows this member the model options its own switch left, ahead of the
   * switch's answer, which a failure to show them does not fail.
   */
  showSwitch(models: SessionModelsResponse) {
    this.#switched = models
    return this.#deliver({ kind: "model", models })
  }

  /**
   * Shows one model reading, unless it is the first since this member's own
   * switch and repeats the options that switch showed it.
   */
  #showModels(models: SessionModelsResponse) {
    const switched = this.#switched
    this.#switched = undefined
    return switched && isDeepStrictEqual(switched, models)
      ? Promise.resolve()
      : this.#deliver({ kind: "model", models })
  }

  /**
   * Follows the turn an interrupt cut this member's stream of again, from
   * where the member stopped, once the coordinator settled it: every member
   * keeps following a turn whose native link dropped, and none has to redial.
   * A turn a reconcile confirmed running streams on; one that ended meanwhile
   * replays how it ended from its journal. Asked as the stream ends and at
   * each move of the Session's execution, so a settle that lands first is not
   * missed.
   */
  async #followInterrupted() {
    const turnId = this.#interrupted
    if (turnId === undefined) return
    const current = this.#coordinator.snapshot(this.#scope)
    // Still reconciling: the move that settles it asks again.
    if (current.state === "uncertain") return
    this.#interrupted = undefined
    if (current.turnId !== turnId) return
    await this.#follow(true, this.#sequence, 0, turnId).catch(
      (cause: unknown) =>
        // A cursor the journal no longer holds leaves history the only way on.
        cause instanceof ReplayCursorLostError
          ? this.#rebuild()
          : this.report(cause)
    )
  }

  #releaseCells() {
    this.#cells?.()
    this.#cells = undefined
  }

  /** Moves this membership, which nothing moves once it detached. */
  #send(signal: MembershipSignal) {
    if (!this.detached) this.#owner.actor.send(signal)
  }

  /** Asks again the requests a recovered wait is still holding. */
  reissuePending() {
    for (const request of this.#coordinator.snapshot(this.#scope).requests)
      this.#offer(request)
  }

  /**
   * Reports a failure that has no request to answer. One the member cannot
   * be shown is logged, so a report never fails in turn.
   */
  async report(cause: unknown) {
    if (this.endIfGone(cause)) return
    await this.emit({ kind: "error", cause }).catch((err: unknown) =>
      this.#options.logger.warn({ err }, "membership.report.failed")
    )
  }

  /**
   * Ends this membership when `cause` finds its Session gone. The coordinator
   * tells each member whose readings it holds and drops the Session; this
   * member, whose readings a join may not hold yet, is told as well. Returns
   * whether the Session was gone.
   */
  endIfGone(cause: unknown) {
    if (this.pending || !this.#coordinator.endIfGone(this.#scope, cause))
      return false
    if (!this.detached) this.#end(cause)
    return true
  }

  /** Tells this member its Session is gone, and parts. */
  #end(cause: unknown) {
    this.emit({ kind: "error", cause }).catch((err: unknown) =>
      this.#options.logger.warn({ err }, "membership.gone.failed")
    )
    this.part()
  }

  /** Steers the turn this member follows, which a later turn has not replaced. */
  steer(requestId: string, text: string) {
    const expectedTurnId = this.#followedTurn
    if (expectedTurnId === undefined) throw new ServerTurnConflictError()
    return this.#coordinator.steer(this.#scope, {
      requestId,
      expectedTurnId,
      text,
    })
  }

  /**
   * The open request this member answers. One settled, or never handed to
   * this member, is stale.
   */
  request(requestId: string) {
    const request = this.#delivered.has(requestId)
      ? (this.#openRequest(requestId) ??
        this.#channels.childRequest(this.#scope, requestId))
      : undefined
    if (!request) throw new ServerRequestStaleError()
    return request
  }

  /**
   * Gives the Session this member's answer to one request. A question's
   * `answers` reach the member before the turn continues, so the call that
   * asked it stops reading as unanswered while the next segment streams. The
   * answer that leaves nothing open continues the turn, and every member
   * follows it.
   */
  async answer(
    request: PendingRequest,
    reply: RequestReply,
    answers?: string[][]
  ) {
    if (answers)
      await this.emit({ kind: "question-answered", request, answers })
    await this.#settle(reply)
  }

  /** Detaches this member, first withdrawing each request it was offered. */
  part() {
    for (const requestId of [...this.#offered]) this.#withdraw(requestId)
    this.#parted = true
    this.#send({ type: "part" })
  }

  /** Gives the Session one reply of this member's. */
  async #settle(reply: RequestReply) {
    this.#options.logger.info(
      { requestId: reply.requestId, status: reply.status },
      "membership.request.answered"
    )
    // Before the answer resolves this request, so the member answering it
    // is not withdrawn its own request, and a second decline finds none.
    this.#offered.delete(reply.requestId)
    this.#delivered.delete(reply.requestId)
    // A child that outlived its turn asks outside any turn: its runtime takes
    // the answer, and no turn continues.
    if (this.#channels.childRequest(this.#scope, reply.requestId)) {
      await this.#coordinator.respondChild(this.#scope, reply)
      this.#channels.endChildRequest(this.#scope, reply.requestId)
      return
    }
    const continued = await this.#coordinator.answer(this.#scope, reply)
    if (!continued) return
    this.#channels.continueTurn(this.#scope, continued.from, continued.turnId)
    await this.#channels.sync(this.#scope)
  }

  /**
   * Follows a wait the Session continued with no answer, as a Stop or the
   * runtime itself ends one: the same prompt runs on under a fresh turnId.
   */
  #followContinued(from: string) {
    const { state, turnId } = this.#coordinator.snapshot(this.#scope)
    if (state !== "running" || turnId === undefined || turnId === from) return
    this.#channels.continueTurn(this.#scope, from, turnId)
    this.catchUp().catch((cause: unknown) => this.report(cause))
  }

  /**
   * Declines one request as the member's stack decided, which alone knows
   * which requests are its to decline. Only a request this member was offered
   * and the Session still holds, while its credential holds; any other
   * decline, a second one from another tab included, is dropped silently.
   */
  async #decline(requestId: string) {
    if (
      this.detached ||
      !this.#offered.has(requestId) ||
      !this.#member.connection.live()
    )
      return
    const request = this.#coordinator
      .snapshot(this.#scope)
      .requests.find((pending) => pending.requestId === requestId)
    if (!request) return
    try {
      await this.#settle(declineReply(request))
    } catch (cause) {
      if (!(cause instanceof ServerRequestStaleError)) await this.report(cause)
    }
  }

  /**
   * Subscribes to the live turn unless this member already carries it. A
   * resume asks whether its current subscription does, so it can re-follow a
   * turn whose stream it lost; the channel asks whether any subscription
   * ever did, so a member is never streamed one turn twice. `ended` names a
   * turn followed even once it ended, whose end the member is still owed.
   * Without a cursor `after`, a turn the journal holds from its first event
   * replays whole, and any other streams its live events alone; one that has
   * none left to stream is stated instead. Returns the turnId it streams, or
   * `undefined` when no turn is live.
   */
  #follow(
    refollow: boolean,
    after?: number | "next",
    replayedCorrections = 0,
    ended?: string
  ) {
    return this.#exclusive(async (): Promise<string | undefined> => {
      if (this.detached) return undefined
      const { state, turnId } = this.#coordinator.snapshot(this.#scope)
      if (turnId === undefined || (state === "idle" && turnId !== ended))
        return undefined
      const carried = refollow ? this.#subscription?.turnId : this.#followedTurn
      if (carried === turnId) return turnId
      const cursor =
        after === "next"
          ? this.#coordinator.nextCursor(this.#scope)
          : (after ?? this.#startCursor(refollow))
      if (after === "next" && cursor === undefined) return undefined
      let subscription
      try {
        subscription = await this.#coordinator.recover(
          this.#scope,
          {
            sessionId: this.#scope.sessionId,
            turnId,
            ...(cursor === undefined ? {} : { after: cursor }),
          },
          this.#access()
        )
      } catch (cause) {
        if (after !== undefined || !(cause instanceof ReplayCursorLostError))
          throw cause
        // A replay in flight holds the state this states until it completes,
        // which a follow inside its resume must not wait for.
        const stated = this.#reportView()
        if (this.#replays.size === 0) await stated
        else stated.catch((err: unknown) => this.report(err))
        return undefined
      }
      this.#consume(subscription, replayedCorrections)
      return turnId
    })
  }

  /**
   * Where a follow with no cursor reads the live turn from: its first event
   * when the journal holds it, else its live events. A member that followed
   * the turn a wait's end continued holds that journal as far as it went.
   */
  #startCursor(refollow: boolean) {
    const start = this.#coordinator.replayStart(this.#scope)
    if (!start) return 0
    const { continues } = start
    return !refollow && continues?.turnId === this.#followedTurn
      ? continues?.after
      : undefined
  }

  /** Runs one subscribing task once every earlier one has settled. */
  async #exclusive<T>(task: () => Promise<T>) {
    while (this.#entering) await this.#entering.catch(() => undefined)
    const entering = task()
    this.#entering = entering
    try {
      return await entering
    } finally {
      if (this.#entering === entering) this.#entering = undefined
    }
  }

  /** Enters one subscribing task that holds until the returned release. */
  #enter() {
    return new Promise<() => void>((entered) => {
      this.#exclusive(
        () => new Promise<void>((release) => entered(() => release()))
      ).catch((err: unknown) =>
        this.#options.logger.error({ err }, "membership.enter.failed")
      )
    })
  }

  /**
   * Shows one reading the coordinator reported. Nothing awaits a deferred
   * one, so this reports its own failure rather than rejecting into nowhere.
   */
  #deliver(event: SessionEvent) {
    return this.emit(event).catch((cause: unknown) => this.report(cause))
  }

  /**
   * Shows one step of a terminal still running after its turn: the
   * Session's own, at no position in the turn that started it. One this
   * member follows no step of yet is restated first, as ACP announces an
   * item before any list names it, should output be the first it hears.
   */
  #showBackgroundTerminal(turnId: string, event: TerminalTurnEvent) {
    const { terminalId, toolCallId } = event
    const known = this.#followed.has(workKey({ kind: "terminal", terminalId }))
    const steps: TerminalTurnEvent[] =
      known || event.data === undefined
        ? [event]
        : [
            { kind: TurnEventKind.TerminalOutput, terminalId, toolCallId },
            event,
          ]
    for (const step of steps)
      this.#deliver({
        kind: "terminal",
        stream: this.#backgroundStream(turnId),
        event: step,
      }).catch((err: unknown) =>
        this.#options.logger.error({ err }, "membership.terminal.failed")
      )
  }

  /** The stream a background event of `turnId`'s names, one per turn. */
  #backgroundStream(turnId: string) {
    let stream = this.#backgroundStreams.get(turnId)
    if (!stream) {
      stream = { turnId, replayedCorrections: 0, dropped: false }
      this.#backgroundStreams.set(turnId, stream)
    }
    return stream
  }

  /**
   * Shows one event of a child that outlived its turn: the child's own, under
   * its id, at no position in the turn that spawned it.
   */
  #showBackgroundChild(turnId: string, event: ChildTurnEvent) {
    this.#deliver({
      kind: "child",
      parentSessionId: this.#addressed.sessionId,
      stream: this.#backgroundStream(turnId),
      sequence: 0,
      event,
      background: true,
    }).catch((err: unknown) =>
      this.#options.logger.error({ err }, "membership.child.failed")
    )
  }

  /** Asks this member a request a child that outlived its turn asks. */
  #offerChild(request: PendingRequest) {
    if (this.#offered.has(request.requestId)) return
    this.#offered.add(request.requestId)
    this.emit({ kind: "request-asked", request }).catch((err: unknown) =>
      this.#options.logger.warn({ err }, "membership.request.offer.failed")
    )
  }

  /** Shows one notice, which nothing awaits or retries. */
  #showNotice(notice: SessionNotice) {
    this.#deliver({ kind: "notice", notice }).catch((err: unknown) =>
      this.#options.logger.error({ err }, "membership.notice.failed")
    )
  }

  get #coordinator() {
    return this.#options.coordinator
  }

  /**
   * Whether Stop was acknowledged for the stream being read. The coordinator
   * clears its own `stopping` state as soon as the provider settles, which is
   * the same event the member has to be shown as cancelled, so the
   * acknowledgement is latched until the next segment.
   */
  get #stopping() {
    return (
      this.#stopRequested ||
      this.#coordinator.snapshot(this.#scope).state === "stopping"
    )
  }

  /** How the coordinator sees one subscription of this member. */
  #access(): CoordinatorAccess {
    return {
      membershipId: this.#options.membershipId,
      principalId: this.#member.principal.id,
    }
  }

  /** Follows one subscription, whose stream waits for `shown` when given. */
  #consume(
    subscription: CoordinatedTurnSubscription,
    replayedCorrections: number,
    shown?: Promise<void>
  ) {
    // A member that detached while its subscription was admitted keeps none.
    if (this.detached) {
      subscription.close()
      return
    }
    this.#subscription = subscription
    this.#interrupted = undefined
    // A restarted stream is the same segment, whose Stop stays acknowledged.
    if (subscription.turnId !== this.#followedTurn) this.#stopRequested = false
    this.#followedTurn = subscription.turnId
    this.#send({ type: "followed" })
    let caughtUp = () => {}
    this.#caughtUp = new Promise<void>((resolve) => (caughtUp = resolve))
    const done = this.#pump(
      subscription,
      this.#owner.generation,
      replayedCorrections,
      { restating: this.#restating, caughtUp },
      shown
    )
      .catch((err: unknown) =>
        this.#options.logger.error({ err }, "membership.stream.failed")
      )
      .finally(caughtUp)
    this.#streamed = { turnId: subscription.turnId, done }
  }

  /**
   * Shows one subscription's segment to the member, event by event, settling
   * `caughtUp` once it showed what the journal buffered. A view `restating`
   * is shown that buffer without its states or requests, which it is told as
   * they stand once caught up. The stream is the membership's `generation`
   * until a later follow replaces it.
   */
  async #pump(
    subscription: CoordinatedTurnSubscription,
    generation: number,
    replayedCorrections: number,
    view: { restating: boolean; caughtUp: () => void },
    shown?: Promise<void>
  ) {
    let buffered = subscription.replayed ?? 0
    if (buffered === 0) view.caughtUp()
    const dropped = this.#dropped
    const stream: TurnStream = {
      turnId: subscription.turnId,
      replayedCorrections,
      get dropped() {
        return dropped.has(subscription)
      },
    }
    let overflow: FanoutOverflowError | undefined
    let interrupted = false
    try {
      await shown
      for await (const { sequence, event } of subscription.events) {
        if (stream.dropped) break
        this.#sequence = sequence
        interrupted = isRedialableFailure(event)
        const replayed = view.restating && buffered > 0
        // A child Session's report or event is the child's, under its id.
        await this.emit(
          isChildTurnEvent(event)
            ? {
                kind: "child",
                parentSessionId: this.#addressed.sessionId,
                stream,
                sequence,
                event,
                ...(replayed ? { replayed: true as const } : {}),
              }
            : {
                kind: "turn",
                stream,
                sequence,
                event,
                stopping: this.#stopping,
                ...(replayed ? { replayed: true as const } : {}),
              }
        )
        if (!replayed && !isChildTurnEvent(event)) {
          this.#stated = statedBy(event) ?? this.#stated
          if (
            event.kind === TurnEventKind.TurnRequiresAction &&
            !stream.dropped
          )
            for (const request of event.requests) this.#offer(request)
        }
        if (--buffered === 0) view.caughtUp()
      }
    } catch (cause) {
      if (cause instanceof FanoutOverflowError) overflow = cause
      else await this.report(cause)
    } finally {
      if (!this.#owner.stale(generation)) this.#subscription = undefined
    }
    // The stream that replaced a dropped one settles the segment instead.
    if (stream.dropped) return
    if (overflow) return this.#fellBehind(subscription.turnId, overflow)
    // An interrupt ends the stream, not the turn: its reconcile decides that.
    if (interrupted && !this.#owner.stale(generation)) {
      this.#interrupted = subscription.turnId
      await this.#followInterrupted()
      return
    }
    // A stream that could not carry the wait it ended on, such as the reset of
    // a discovered turn no journal replays, still leaves its requests open. A
    // replay in flight asks them after the state it closes with.
    if (
      this.#replays.size === 0 &&
      this.#coordinator.state(this.#scope) === "waiting-for-input"
    )
      this.reissuePending()
  }

  /**
   * Rebuilds the view of a member whose stream was dropped for falling behind
   * its bounds, once per turn: one that falls behind the same turn again
   * cannot catch up, and its connection closes.
   *
   * The turn itself is unharmed and may still be going, so this is not a turn
   * failure and the segment did not settle: reporting either would leave the
   * member believing a turn it only saw part of had ended. The member owes
   * itself the Session from history, then the turn's live events and state.
   */
  async #fellBehind(turnId: string, overflow: FanoutOverflowError) {
    this.#options.logger.error(
      {
        membershipId: this.#options.membershipId,
        turnId,
        events: overflow.events,
        bytes: overflow.bytes,
      },
      "membership.fell-behind"
    )
    if (this.#rebuiltTurn === turnId) {
      this.#cannotCatchUp()
      return
    }
    this.#rebuiltTurn = turnId
    await this.#rebuild()
  }

  /**
   * Asks this member one request. A request already asked here, or one the
   * Session no longer waits on, is not asked again, however a replay or a
   * reissue reaches it.
   */
  #offer(request: PendingRequest) {
    if (this.#offered.has(request.requestId)) return
    const open = this.#coordinator.snapshot(this.#scope)
    if (!open.requests.some(({ requestId }) => requestId === request.requestId))
      return
    this.#offered.add(request.requestId)
    this.emit({
      kind: "request-asked",
      request,
      ...(open.startedBy === undefined ? {} : { startedBy: open.startedBy }),
    }).catch((err: unknown) =>
      this.#options.logger.warn({ err }, "membership.request.offer.failed")
    )
  }

  /**
   * Withdraws a request the Session resolved from this member, which is told
   * only of a request its connection was handed.
   */
  #withdraw(requestId: string) {
    this.#offered.delete(requestId)
    if (!this.#delivered.delete(requestId)) return
    this.emit({ kind: "request-withdrawn", requestId }).catch((err: unknown) =>
      this.#options.logger.warn({ err }, "membership.request.withdraw.failed")
    )
  }

  #openRequest(requestId: string) {
    return this.#coordinator
      .snapshot(this.#scope)
      .requests.find((pending) => pending.requestId === requestId)
  }
}

export type { Membership }
