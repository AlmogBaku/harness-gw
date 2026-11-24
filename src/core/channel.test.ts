import { describe, expect, it } from "vitest"

import { useFakeClock } from "../../test/support/fake-clock"
import { captureLogs } from "../../test/support/log-capture"
import { defaultClock } from "../../lifecycle"
import {
  PendingRequestKind,
  TurnEventKind,
  type ExecutionEvent,
  type TurnEvent,
  type PendingRequest,
  type RequestReply,
} from "./events"
import type {
  MemberAct,
  MemberConnection,
  Middleware,
  SessionNotice,
} from "./member"
import {
  ServerRequestStaleError,
  ServerSessionNotFoundError,
  ServerTurnConflictError,
  type ServerTurnListener,
  type SessionScope,
} from "./runtime"
import {
  CloseUnconfirmedError,
  createChannels,
  type MembershipDelivery,
  type ChannelScope,
  type ChannelTurn,
} from "./channel"
import { providerSessionId, sessionId } from "./ids"
import { CLOSE_DEADLINE_MS, DELETE_SHOWN_MS, STATE_WAIT_MS } from "./limits"
import { FanoutOverflowError } from "./subscriber-fanout"
import type {
  SequencedTurnEvent,
  SessionCoordinator,
} from "./session-coordinator"

/** No test here reads history; a channel that did would fail loudly. */
const NO_HISTORY = {
  history: () => Promise.reject(new Error("no history")),
}

/** A coordinator that only reports each Session's execution. */
/** What a membership asks of every coordinator: a hold, and no Session gone. */
const HOLDING = {
  hold: () => () => undefined,
  refuseDiscarded: () => undefined,
}

function reporting(
  snapshot: (scope: ChannelScope) => { state: string; turnId?: string }
) {
  return { snapshot, ...HOLDING } as unknown as SessionCoordinator
}

const SCOPE: SessionScope = {
  agentId: "researcher",
  providerSessionId: providerSessionId("session-1"),
  sessionId: sessionId("thread-operator"),
}

function turn(turnId: string, at = 0): ChannelTurn {
  return {
    turnId,
    messageId: `message-${turnId}`,
    content: [{ kind: "text", text: `prompt ${turnId}` }],
    at,
  }
}

function member(
  options: {
    follow?: () => Promise<"following" | "idle">
    followedTurn?: string
    sendTurn?: () => void | Promise<void>
  } = {}
) {
  const sent: string[] = []
  const reported: unknown[] = []
  const notices: SessionNotice[] = []
  let follows = 0
  let rebuilds = 0
  const fake: MembershipDelivery = {
    sendTurn(sentTurn) {
      sent.push(sentTurn.turnId)
      return options.sendTurn?.()
    },
    follow() {
      follows += 1
      return options.follow?.() ?? Promise.resolve("following")
    },
    followedTurn: () => options.followedTurn,
    rebuild() {
      rebuilds += 1
    },
    report(cause) {
      reported.push(cause)
    },
    notice(notice) {
      notices.push(notice)
    },
    child: () => undefined,
    terminal: () => undefined,
    offerChild: () => undefined,
    withdrawChild: () => undefined,
    shown: async () => undefined,
  }
  return {
    fake,
    sent,
    reported,
    notices,
    follows: () => follows,
    rebuilds: () => rebuilds,
  }
}

function harness() {
  const snapshots = new Map<string, { state: string; turnId?: string }>()
  const clock = { now: 0 }
  const key = (scope: ChannelScope) =>
    `${scope.agentId}/${scope.providerSessionId}`
  const channels = createChannels({
    coordinator: reporting(
      (scope) => snapshots.get(key(scope)) ?? { state: "idle" }
    ),
    runtime: NO_HISTORY,
    logger: captureLogs().logger,
    clock: { ...defaultClock, now: () => clock.now },
    backstopMs: 1_000,
  })
  const setSnapshot = (
    snapshot: { state: string; turnId?: string },
    scope: ChannelScope = SCOPE
  ) => snapshots.set(key(scope), snapshot)
  return { channels, clock, setSnapshot }
}

/** A send that fails the first time, so only a later catch-up delivers it. */
function failOnce() {
  let failed = false
  return () => {
    if (failed) return
    failed = true
    throw new Error("first send failed")
  }
}

/** Lets fire-and-forget sends from `add` settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createChannel", () => {
  it("broadcasts a turn to every member but the sender, once each", async () => {
    const { channels, setSnapshot } = harness()
    const sender = member()
    const first = member()
    const second = member()
    channels.add(SCOPE, sender.fake, { hasPrompt: false })
    channels.add(SCOPE, first.fake, { hasPrompt: false })
    channels.add(SCOPE, second.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })

    await channels.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    expect(sender.sent).toEqual([])
    expect(first.sent).toEqual(["turn-1"])
    expect(second.sent).toEqual(["turn-1"])
  })

  it("does not add a sender that is not a member", async () => {
    const { channels, setSnapshot } = harness()
    const listener = member()
    const outsider = member()
    channels.add(SCOPE, listener.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })

    await channels.broadcastTurn(SCOPE, turn("turn-1"), outsider.fake)
    await channels.broadcastTurn(SCOPE, turn("turn-1b"), listener.fake)

    expect(outsider.sent).toEqual([])
  })

  it("puts one provider Session in one channel whatever the sessionId", async () => {
    const { channels, setSnapshot } = harness()
    const operator = member()
    const guest = member()
    channels.add(SCOPE, operator.fake, { hasPrompt: false })
    channels.add(
      { ...SCOPE, sessionId: sessionId("thread-guest") },
      guest.fake,
      {
        hasPrompt: false,
      }
    )
    setSnapshot({ state: "running", turnId: "turn-1" })

    await channels.broadcastTurn(SCOPE, turn("turn-1"), operator.fake)

    expect(guest.sent).toEqual(["turn-1"])
  })

  it("keeps another sessionId in another channel", async () => {
    const { channels, setSnapshot } = harness()
    const other = {
      ...SCOPE,
      providerSessionId: providerSessionId("session-2"),
    }
    const sender = member()
    const elsewhere = member()
    channels.add(SCOPE, sender.fake, { hasPrompt: false })
    channels.add(other, elsewhere.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    setSnapshot({ state: "running", turnId: "turn-1" }, other)

    await channels.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)
    await channels.sync(other)

    expect(elsewhere.sent).toEqual([])
  })

  it("stops delivering to a removed member and drops an empty channel", async () => {
    const { channels, setSnapshot } = harness()
    const sender = member()
    const leaver = member()
    const removeSender = channels.add(SCOPE, sender.fake, { hasPrompt: false })
    const removeLeaver = channels.add(SCOPE, leaver.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    removeLeaver()
    removeLeaver()

    await channels.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)
    expect(leaver.sent).toEqual([])

    removeSender()
    const newcomer = member()
    channels.add(SCOPE, newcomer.fake, { hasPrompt: false })
    await settle()
    expect(newcomer.sent).toEqual([])
  })

  it("ignores a repeat add of the same member", async () => {
    const { channels, setSnapshot } = harness()
    const sender = member()
    const listener = member()
    channels.add(SCOPE, sender.fake, { hasPrompt: false })
    const remove = channels.add(SCOPE, listener.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    await channels.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    const again = channels.add(SCOPE, listener.fake, { hasPrompt: false })
    await settle()
    expect(listener.sent).toEqual(["turn-1"])

    again()
    remove()
    await channels.broadcastTurn(SCOPE, turn("turn-2"), sender.fake)
    expect(listener.sent).toEqual(["turn-1"])
  })

  it("delivers the current prompt once to a joining member", async () => {
    const { channels, setSnapshot } = harness()
    const sender = member()
    channels.add(SCOPE, sender.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    await channels.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    const joiner = member()
    const holder = member()
    channels.add(SCOPE, joiner.fake, { hasPrompt: false })
    channels.add(SCOPE, holder.fake, { hasPrompt: true })
    await settle()
    await channels.sync(SCOPE)

    expect(joiner.sent).toEqual(["turn-1"])
    expect(holder.sent).toEqual([])
    expect(sender.sent).toEqual([])
  })

  it.each([
    ["the Session went idle", { state: "idle", turnId: "turn-1" }],
    ["another turn is live", { state: "running", turnId: "turn-2" }],
  ])("drops a prompt that is no longer current: %s", async (_, later) => {
    const { channels, setSnapshot } = harness()
    const sender = member()
    channels.add(SCOPE, sender.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    await channels.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    setSnapshot(later)
    const joiner = member()
    channels.add(SCOPE, joiner.fake, { hasPrompt: false })
    await settle()

    expect(joiner.sent).toEqual([])
  })

  it.each(["uncertain", "waiting-for-input"])(
    "treats %s as live",
    async (state) => {
      const { channels, setSnapshot } = harness()
      const sender = member()
      channels.add(SCOPE, sender.fake, { hasPrompt: false })
      setSnapshot({ state: "running", turnId: "turn-1" })
      await channels.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

      setSnapshot({ state, turnId: "turn-1" })
      const joiner = member()
      channels.add(SCOPE, joiner.fake, { hasPrompt: false })
      await settle()

      expect(joiner.sent).toEqual(["turn-1"])
    }
  )

  it("drops an old prompt at the backstop, but not while waiting for input", async () => {
    const { channels, clock, setSnapshot } = harness()
    const sender = member()
    channels.add(SCOPE, sender.fake, { hasPrompt: false })
    setSnapshot({ state: "waiting-for-input", turnId: "turn-1" })
    await channels.broadcastTurn(SCOPE, turn("turn-1", 0), sender.fake)
    clock.now = 5_000

    const waiting = member()
    channels.add(SCOPE, waiting.fake, { hasPrompt: false })
    await settle()
    expect(waiting.sent).toEqual(["turn-1"])

    setSnapshot({ state: "running", turnId: "turn-1" })
    const late = member()
    channels.add(SCOPE, late.fake, { hasPrompt: false })
    await settle()
    expect(late.sent).toEqual([])
  })

  it("keeps a continued prompt deliverable without re-sending it", async () => {
    const { channels, setSnapshot } = harness()
    const sender = member()
    const listener = member()
    channels.add(SCOPE, sender.fake, { hasPrompt: false })
    channels.add(SCOPE, listener.fake, { hasPrompt: false })
    setSnapshot({ state: "waiting-for-input", turnId: "turn-1" })
    await channels.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    channels.continueTurn(SCOPE, "turn-1", "turn-2")
    setSnapshot({ state: "running", turnId: "turn-2" })
    const joiner = member()
    channels.add(SCOPE, joiner.fake, { hasPrompt: false })
    await settle()
    await channels.sync(SCOPE)

    expect(joiner.sent).toEqual(["turn-2"])
    expect(listener.sent).toEqual(["turn-1"])
    expect(sender.sent).toEqual([])
  })

  it("syncs by delivering to members that lack the prompt and following all", async () => {
    const { channels, setSnapshot } = harness()
    const sender = member()
    const listener = member()
    const missed = member({ sendTurn: failOnce() })
    channels.add(SCOPE, sender.fake, { hasPrompt: false })
    channels.add(SCOPE, listener.fake, { hasPrompt: false })
    channels.add(SCOPE, missed.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    await channels.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    await channels.sync(SCOPE)

    expect(missed.sent).toEqual(["turn-1", "turn-1"])
    expect(listener.sent).toEqual(["turn-1"])
    expect(sender.sent).toEqual([])
    expect([sender, listener, missed].map((m) => m.follows())).toEqual([
      1, 1, 1,
    ])
  })

  it("rebuilds only a member shown a channel prompt whose reply it missed", async () => {
    const { channels, setSnapshot } = harness()
    const idle = () => Promise.resolve("idle" as const)
    const sender = member({ follow: idle })
    const missed = member({ follow: idle })
    const streamed = member({ follow: idle, followedTurn: "turn-1" })
    const holder = member({ follow: idle })
    channels.add(SCOPE, sender.fake, { hasPrompt: false })
    channels.add(SCOPE, missed.fake, { hasPrompt: false })
    channels.add(SCOPE, streamed.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    await channels.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)
    channels.add(SCOPE, holder.fake, { hasPrompt: true })
    setSnapshot({ state: "idle", turnId: "turn-1" })

    await channels.sync(SCOPE)

    expect(missed.rebuilds()).toBe(1)
    expect(sender.rebuilds()).toBe(0)
    expect(streamed.rebuilds()).toBe(0)
    expect(holder.rebuilds()).toBe(0)
  })

  it("reports a failing member and still serves the others", async () => {
    const { channels, setSnapshot } = harness()
    const sendFailure = new Error("send failed")
    const followFailure = new Error("follow failed")
    const sender = member()
    const brokenSend = member({
      sendTurn: () => {
        throw sendFailure
      },
    })
    const brokenFollow = member({ follow: () => Promise.reject(followFailure) })
    const healthy = member()
    for (const each of [sender, brokenSend, brokenFollow, healthy]) {
      channels.add(SCOPE, each.fake, { hasPrompt: false })
    }
    setSnapshot({ state: "running", turnId: "turn-1" })

    await channels.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)
    expect(brokenSend.reported).toEqual([sendFailure])
    expect(healthy.sent).toEqual(["turn-1"])

    await channels.sync(SCOPE)
    expect(brokenFollow.reported).toEqual([followFailure])
    expect(healthy.sent).toEqual(["turn-1"])
    expect(healthy.follows()).toBe(1)
    expect(healthy.reported).toEqual([])
  })

  it("catches up one member alone", async () => {
    const { channels, setSnapshot } = harness()
    const sender = member()
    const late = member({ sendTurn: failOnce() })
    const other = member({ sendTurn: failOnce() })
    for (const each of [sender, late, other]) {
      channels.add(SCOPE, each.fake, { hasPrompt: false })
    }
    setSnapshot({ state: "running", turnId: "turn-1" })
    await channels.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    await channels.catchUp(SCOPE, late.fake)

    expect(late.sent).toEqual(["turn-1", "turn-1"])
    expect(late.follows()).toBe(1)
    expect(other.sent).toEqual(["turn-1"])
    expect(other.follows()).toBe(0)
  })

  it("rejoins a member so a reopened view gets the prompt its history lacks", async () => {
    const { channels, setSnapshot } = harness()
    const sender = member()
    const listener = member()
    channels.add(SCOPE, sender.fake, { hasPrompt: false })
    channels.add(SCOPE, listener.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    await channels.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    channels.rejoin(SCOPE, listener.fake, { hasPrompt: false })
    channels.rejoin(SCOPE, sender.fake, { hasPrompt: false })
    const holder = member()
    channels.add(SCOPE, holder.fake, { hasPrompt: false })
    channels.rejoin(SCOPE, holder.fake, { hasPrompt: true })
    await settle()
    await channels.sync(SCOPE)

    expect(listener.sent).toEqual(["turn-1", "turn-1"])
    expect(sender.sent).toEqual(["turn-1"])
    expect(holder.sent).toEqual(["turn-1"])
  })

  it("reads the current prompt only while its turn is live", async () => {
    const { channels, setSnapshot } = harness()
    const sender = member()
    expect(channels.current(SCOPE)).toBeUndefined()
    channels.add(SCOPE, sender.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    await channels.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    expect(channels.current(SCOPE)).toEqual(turn("turn-1"))
    expect(sender.sent).toEqual([])

    setSnapshot({ state: "idle", turnId: "turn-1" })
    expect(channels.current(SCOPE)).toBeUndefined()
  })
})

/** A runtime whose Session the channels subscribe to, driven by hand. */
function adoptingHarness() {
  let state: { state: string; turnId?: string } = { state: "idle" }
  const watchers: ServerTurnListener[] = []
  const listeners = new Set<(event: ExecutionEvent) => void>()
  const discovered: SessionScope[] = []
  let stopped = 0
  let discover: () => Promise<unknown> = async () => undefined
  const channels = createChannels({
    coordinator: reporting(() => state),
    runtime: NO_HISTORY,
    logger: captureLogs().logger,
    adoption: {
      subscribeTurns(_scope, watcher) {
        watchers.push(watcher)
        return () => {
          stopped += 1
        }
      },
      async discover(scope) {
        discovered.push(scope)
        return discover()
      },
      subscribeExecutions(_scope, listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  })
  return {
    channels,
    watchers,
    discovered,
    stopped: () => stopped,
    observers: () => listeners.size,
    /** The runtime starts `turnId`, which the next `discover` adopts. */
    runtimeStarts(turnId: string) {
      discover = async () => {
        state = { state: "running", turnId }
      }
    },
    failDiscover(cause: unknown) {
      discover = async () => {
        throw cause
      }
    },
    end(turnId: string) {
      state = { state: "idle", turnId }
      for (const listener of listeners)
        listener({
          agentId: SCOPE.agentId,
          sessionId: SCOPE.providerSessionId,
          turnId,
          occurredAt: "2026-09-23T00:00:00Z",
          kind: "turn-finished",
        })
    },
  }
}

const GUEST_SCOPE: SessionScope = {
  ...SCOPE,
  sessionId: sessionId("thread-guest"),
}

describe("a delete's wait for its members", () => {
  // One member's slow reader never fails the delete for another, while the
  // deleter is shown its turn's end before its answer, as its close would be.
  it.each([
    [
      "any other member for at most its wait, and then goes on",
      false,
      "stopped",
    ],
    [
      "the deleter for its whole deadline, as its close would",
      true,
      "unconfirmed",
    ],
  ])("waits on %s", async (_member, deleting, outcomeAtEnd) => {
    const clock = useFakeClock()
    const channels = createChannels({
      coordinator: {
        ...HOLDING,
        snapshot: () => ({ state: "running" }),
        state: () => "running",
        stop: async () => "stopping",
        idle: async () => undefined,
      } as unknown as SessionCoordinator,
      runtime: NO_HISTORY,
      logger: captureLogs().logger,
    })
    const slow: MembershipDelivery = {
      ...member().fake,
      shown: () => new Promise<void>(() => {}),
    }
    channels.add(SCOPE, slow, { hasPrompt: false })
    let outcome: unknown
    void channels
      .closing((signal) =>
        channels.stopWork(
          SCOPE,
          signal,
          () => true,
          deleting ? slow : undefined
        )
      )
      .then(
        () => (outcome = "stopped"),
        (cause: unknown) =>
          (outcome =
            cause instanceof CloseUnconfirmedError ? "unconfirmed" : cause)
      )

    const wait = deleting ? CLOSE_DEADLINE_MS : DELETE_SHOWN_MS
    await clock.advance(wait - 1)
    expect(outcome).toBeUndefined()
    await clock.advance(1)
    expect(outcome).toBe(outcomeAtEnd)
  })
})

describe("createChannel adopting runtime-started turns", () => {
  it("subscribes while the channel has members and stops when the last parts", () => {
    const runtime = adoptingHarness()
    const removeFirst = runtime.channels.add(SCOPE, member().fake, {
      hasPrompt: false,
    })
    const removeSecond = runtime.channels.add(SCOPE, member().fake, {
      hasPrompt: false,
    })

    expect(runtime.watchers).toHaveLength(1)
    removeFirst()
    expect(runtime.stopped()).toBe(0)
    removeSecond()
    expect(runtime.stopped()).toBe(1)
    expect(runtime.observers()).toBe(0)
  })

  it("adopts a turn the runtime started and brings every member into it", async () => {
    const runtime = adoptingHarness()
    const first = member()
    const second = member()
    runtime.channels.add(SCOPE, first.fake, { hasPrompt: false })
    runtime.channels.add(SCOPE, second.fake, { hasPrompt: false })
    runtime.runtimeStarts("aos-recovered-1")

    runtime.watchers[0]!.onTurn()
    await settle()

    expect(runtime.discovered).toHaveLength(1)
    expect(first.follows()).toBe(1)
    expect(second.follows()).toBe(1)
  })

  it("reloads every member when an adopted turn ends, for the prompt it never showed", async () => {
    const runtime = adoptingHarness()
    const first = member()
    const second = member()
    runtime.channels.add(SCOPE, first.fake, { hasPrompt: false })
    runtime.channels.add(SCOPE, second.fake, { hasPrompt: false })
    runtime.runtimeStarts("aos-recovered-1")
    runtime.watchers[0]!.onTurn()
    await settle()

    runtime.end("aos-recovered-1")
    await settle()

    expect(first.rebuilds()).toBe(1)
    expect(second.rebuilds()).toBe(1)
  })

  it("asks the runtime again when the channel's own turn ends, without a reload", async () => {
    const runtime = adoptingHarness()
    const first = member()
    runtime.channels.add(SCOPE, first.fake, { hasPrompt: false })

    runtime.end("turn-1")
    await settle()

    expect(first.rebuilds()).toBe(0)
    expect(runtime.discovered).toHaveLength(1)
  })

  it("adopts in the scope of the member that joined first", async () => {
    const runtime = adoptingHarness()
    runtime.channels.add(GUEST_SCOPE, member().fake, { hasPrompt: false })
    runtime.channels.add(SCOPE, member().fake, { hasPrompt: false })

    runtime.watchers[0]!.onTurn()
    await settle()

    expect(runtime.discovered).toEqual([GUEST_SCOPE])
  })

  it("skips a conflict silently and adopts at the gateway turn's end", async () => {
    const runtime = adoptingHarness()
    const first = member()
    runtime.channels.add(SCOPE, first.fake, { hasPrompt: false })
    runtime.failDiscover(new ServerTurnConflictError())
    runtime.watchers[0]!.onTurn()
    await settle()
    expect(first.reported).toEqual([])
    expect(first.follows()).toBe(0)

    runtime.runtimeStarts("aos-recovered-1")
    runtime.end("turn-1")
    await settle()

    expect(first.follows()).toBe(1)
  })

  it("reports any other failure and stays usable", async () => {
    const runtime = adoptingHarness()
    const first = member()
    runtime.channels.add(SCOPE, first.fake, { hasPrompt: false })
    const failure = new Error("discover failed")
    runtime.failDiscover(failure)
    runtime.watchers[0]!.onTurn()
    await settle()
    const watchFailure = new Error("watch lost")
    runtime.watchers[0]!.onError(watchFailure)

    expect(first.reported).toEqual([failure, watchFailure])
    runtime.runtimeStarts("aos-recovered-1")
    runtime.watchers[0]!.onTurn()
    await settle()
    expect(first.follows()).toBe(1)
  })

  it("asks once more when a trigger arrives while adopting", async () => {
    const runtime = adoptingHarness()
    runtime.channels.add(SCOPE, member().fake, { hasPrompt: false })

    runtime.watchers[0]!.onTurn()
    runtime.watchers[0]!.onTurn()
    runtime.watchers[0]!.onTurn()
    await settle()

    expect(runtime.discovered).toHaveLength(2)
  })

  it("shows a notice the runtime reports to every member, and not to a later one", () => {
    const runtime = adoptingHarness()
    const first = member()
    const second = member()
    runtime.channels.add(SCOPE, first.fake, { hasPrompt: false })
    runtime.channels.add(GUEST_SCOPE, second.fake, { hasPrompt: false })
    const notice: SessionNotice = {
      severity: "info",
      title: "Heartbeat",
      kind: "heartbeat",
    }

    runtime.watchers[0]!.onNotice?.(notice)
    const late = member()
    runtime.channels.add(SCOPE, late.fake, { hasPrompt: false })

    expect(first.notices).toEqual([notice])
    expect(second.notices).toEqual([notice])
    expect(late.notices).toEqual([])
  })

  it("rechecks after a member's own start fails", async () => {
    const runtime = adoptingHarness()
    const first = member()
    runtime.channels.add(SCOPE, first.fake, { hasPrompt: false })
    runtime.runtimeStarts("aos-recovered-1")

    await runtime.channels.recheck(SCOPE)

    expect(first.follows()).toBe(1)
  })
})

const GUEST = "guest:token-1"

const APPROVAL: PendingRequest = {
  requestId: "approval-1",
  kind: PendingRequestKind.Permission,
  responseSchema: { type: "string", enum: ["once", "deny"] },
}

const QUESTION: PendingRequest = {
  requestId: "question-1",
  kind: PendingRequestKind.Elicitation,
  questions: [{ choices: ["Yes"], multiple: false, custom: false }],
}

/**
 * One member joined to a Session waiting on `requests`, over a coordinator
 * that records the answers it is given. `decline` is what the member's stack
 * does with each request it is asked, and `hide` hides every request.
 */
function joined(
  options: {
    requests?: PendingRequest[]
    decline?: (requestId: string, act: MemberAct) => void
    hide?: boolean
  } = {}
) {
  let requests = options.requests ?? [APPROVAL]
  const observers = new Set<(event: ExecutionEvent) => void>()
  const log: string[] = []
  const state = { live: true }
  const coordinator = {
    snapshot: () => ({
      state: requests.length > 0 ? "waiting-for-input" : "idle",
      turnId: "turn-1",
      requests: [...requests],
    }),
    subscribeScope(
      _scope: SessionScope,
      listener: (e: ExecutionEvent) => void
    ) {
      observers.add(listener)
      return () => observers.delete(listener)
    },
    /** Resolves one open request, as any member's answer or Stop does. */
    async answer(_scope: SessionScope, reply: RequestReply) {
      if (!requests.some(({ requestId }) => requestId === reply.requestId))
        throw new ServerRequestStaleError()
      log.push(
        `answered:${reply.requestId}:${reply.status}:${String(reply.payload)}`
      )
      requests = requests.filter(
        ({ requestId }) => requestId !== reply.requestId
      )
      for (const observer of observers)
        observer({
          agentId: SCOPE.agentId,
          sessionId: SCOPE.providerSessionId,
          turnId: "turn-1",
          occurredAt: "2026-09-24T00:00:00Z",
          kind: "attention-resolved",
          requestId: reply.requestId,
        })
      return undefined
    },
    ...HOLDING,
  } as unknown as SessionCoordinator
  const middleware: Middleware = {
    event(event, act) {
      if (event.kind !== "request-asked") return event
      options.decline?.(event.request.requestId, act)
      return options.hide ? undefined : event
    },
  }
  const connection: MemberConnection = {
    async send(event) {
      log.push(
        event.kind === "request-asked"
          ? `asked:${event.request.requestId}`
          : event.kind === "request-withdrawn"
            ? `withdrawn:${event.requestId}`
            : event.kind
      )
    },
    live: () => state.live,
    fellBehind: () => undefined,
  }
  const { logger } = captureLogs()
  const membership = createChannels({
    coordinator,
    runtime: NO_HISTORY,
    logger,
  }).join(
    {
      principal: { id: GUEST, role: "guest" },
      middleware: [middleware],
      connection,
    },
    SCOPE,
    {
      membershipId: "subscriber-1",
      logger,
      describe: () => ({ code: "failed", message: "failed" }),
      subscribeRow: () => () => undefined,
    }
  )
  membership.joinChannel()
  return { membership, log, state, coordinator }
}

const declining = (requestId: string, act: MemberAct) => act.decline(requestId)

describe("a membership's declines", () => {
  it("still asks the other requests when the member's stack throws on one", async () => {
    const test = joined({
      requests: [APPROVAL, QUESTION],
      decline: (requestId) => {
        if (requestId === APPROVAL.requestId) throw new Error("stack failed")
      },
    })

    expect(() => test.membership.reissuePending()).not.toThrow()
    await settle()

    expect(test.log).toContain("asked:question-1")
  })

  it("denies a permission its stack declines once the member was offered it", async () => {
    const test = joined({ decline: declining })

    test.membership.reissuePending()
    await settle()

    expect(test.log).toEqual([
      "asked:approval-1",
      "answered:approval-1:resolved:deny",
    ])
  })

  it("cancels a permission that offers no deny", async () => {
    const test = joined({
      decline: declining,
      hide: true,
      requests: [{ ...APPROVAL, responseSchema: { enum: ["once"] } }],
    })

    test.membership.reissuePending()
    await settle()

    expect(test.log).toEqual(["answered:approval-1:cancelled:undefined"])
  })

  it("declines a question its stack declines, but never a request it did not ask this member", async () => {
    const test = joined({
      hide: true,
      requests: [QUESTION, { ...APPROVAL, requestId: "approval-2" }],
      decline: (requestId, act) => {
        act.decline(requestId)
        act.decline("approval-unasked")
      },
    })

    test.membership.reissuePending()
    await settle()

    expect(test.log).toEqual([
      "answered:question-1:cancelled:undefined",
      "answered:approval-2:resolved:deny",
    ])
  })

  it("skips a decline whose connection stopped being live before it ran", async () => {
    const test = joined({ decline: declining, hide: true })

    test.membership.reissuePending()
    test.state.live = false
    await settle()

    expect(test.log).toEqual([])
  })

  it("drops a second decline of the same request silently", async () => {
    const test = joined({
      hide: true,
      decline: (requestId, act) => {
        act.decline(requestId)
        act.decline(requestId)
      },
    })

    test.membership.reissuePending()
    await settle()

    expect(test.log).toEqual(["answered:approval-1:resolved:deny"])
  })

  it("gives a member no answer and no withdrawal of a request its stack hid", async () => {
    const test = joined({ hide: true })

    test.membership.reissuePending()
    expect(() => test.membership.request("approval-1")).toThrow(
      ServerRequestStaleError
    )
    await test.coordinator.answer(SCOPE, {
      requestId: "approval-1",
      status: "cancelled",
    })
    await settle()

    expect(test.log).toEqual(["answered:approval-1:cancelled:undefined"])
  })

  it("withdraws a request it delivered once another member answers it", async () => {
    const test = joined()

    test.membership.reissuePending()
    await settle()
    expect(test.membership.request("approval-1")).toEqual(APPROVAL)
    await test.coordinator.answer(SCOPE, {
      requestId: "approval-1",
      status: "cancelled",
    })
    await settle()

    expect(test.log).toEqual([
      "asked:approval-1",
      "answered:approval-1:cancelled:undefined",
      "withdrawn:approval-1",
    ])
  })
})

describe("a membership's resume", () => {
  it("answers a Session its follow finds gone as gone, rebuilding nothing", async () => {
    const gone = new ServerSessionNotFoundError()
    const coordinator = {
      snapshot: () => ({ state: "running", turnId: "turn-1" }),
      subscribeScope: () => () => undefined,
      subscribeReadings: () => () => undefined,
      recover: () => Promise.reject(gone),
      childReports: () => [],
      workReports: () => ({ terminals: [], finished: [] }),
      endIfGone: (_scope: SessionScope, cause: unknown) => cause === gone,
      ...HOLDING,
    } as unknown as SessionCoordinator
    const { logger } = captureLogs()
    const membership = createChannels({
      coordinator,
      runtime: NO_HISTORY,
      logger,
    }).join(
      {
        principal: { id: GUEST, role: "guest" },
        middleware: [],
        connection: {
          send: async () => undefined,
          live: () => true,
          fellBehind: () => undefined,
        },
      },
      SCOPE,
      {
        membershipId: "subscriber-1",
        logger,
        describe: () => ({ code: "failed", message: "failed" }),
        subscribeRow: () => () => undefined,
      }
    )

    await expect(
      membership.resume({ turnId: "turn-1", after: 2 })
    ).rejects.toBe(gone)
  })

  // ACP: "The snapshot and subsequent live state changes MUST be delivered
  // in order, without replacing a newer state with a stale snapshot." A turn
  // that ended while a reconnect was positioned in it streams its last
  // events to the view after the replay, and the state the resume closes
  // with may not tell the view it ended ahead of them.
  it("closes a positioned resume with no state ahead of the events its stream still owes the view", async () => {
    const live: SequencedTurnEvent[] = [
      chunkAt(3, "One"),
      chunkAt(4, "Two"),
      { sequence: 5, event: { kind: TurnEventKind.TurnEnded } },
    ]
    let state = "running"
    const coordinator = {
      snapshot: () => ({ state, turnId: "turn-1", requests: [] }),
      nextCursor: () => 5,
      subscribeScope: () => () => undefined,
      subscribeReadings: () => () => undefined,
      // The turn ends as the view follows it: its journal holds its last
      // events and its end, which the view's stream has yet to show.
      recover: async () => {
        state = "idle"
        return {
          turnId: "turn-1",
          replayed: 0,
          close: () => undefined,
          events: (async function* () {
            yield* live
          })(),
        }
      },
      childReports: () => [],
      workReports: () => ({ terminals: [], finished: [] }),
      endIfGone: (_scope: SessionScope, cause: unknown) => {
        throw cause
      },
      ...HOLDING,
    } as unknown as SessionCoordinator
    const shown: string[] = []
    // A socket slow to take the first event, as a busy one is.
    const first = Promise.withResolvers<void>()
    const { logger } = captureLogs()
    const membership = createChannels({
      coordinator,
      runtime: NO_HISTORY,
      logger,
    }).join(
      {
        principal: { id: GUEST, role: "guest" },
        middleware: [],
        connection: {
          send: async (event) => {
            shown.push(
              event.kind === "turn" ? event.event.kind : String(event.kind)
            )
            if (shown.length === 2) await first.promise
          },
          live: () => true,
          fellBehind: () => undefined,
        },
      },
      SCOPE,
      {
        membershipId: "subscriber-1",
        logger,
        describe: () => ({ code: "failed", message: "failed" }),
        subscribeRow: () => () => undefined,
      }
    )

    const resumed = membership.resume({ turnId: "turn-1", after: 2 })
    await settle()
    first.resolve()
    await resumed
    await settle()

    const ended = shown.indexOf(TurnEventKind.TurnEnded)
    expect(shown.slice(0, ended + 1)).toEqual([
      "replay-complete",
      TurnEventKind.MessageChunk,
      TurnEventKind.MessageChunk,
      TurnEventKind.TurnEnded,
    ])
  })
})

function chunkAt(sequence: number, text: string): SequencedTurnEvent {
  return {
    sequence,
    event: { kind: TurnEventKind.MessageChunk, messageId: "reply", text },
  }
}

/**
 * A turn subscription the test feeds: what `push` adds is read in order, a
 * `fail` ends it with its cause, and `close`, as the fanout's, ends it.
 */
function controlledSubscription(turnId: string, replayed = 0) {
  const queue: SequencedTurnEvent[] = []
  let ended = false
  let failure: unknown
  let wake: (() => void) | undefined
  const poke = () => {
    const woken = wake
    wake = undefined
    woken?.()
  }
  return {
    subscription: {
      turnId,
      replayed,
      close: () => {
        ended = true
        poke()
      },
      events: {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (queue.length === 0 && !ended && failure === undefined)
              await new Promise<void>((resolve) => (wake = resolve))
            const next = queue.shift()
            if (next) yield next
            else if (failure !== undefined) throw failure
            else return
          }
        },
      },
    },
    push(...values: SequencedTurnEvent[]) {
      queue.push(...values)
      poke()
    },
    fail(cause: unknown) {
      failure = cause
      poke()
    },
  }
}

/**
 * A member of one Session whose coordinator the test drives: its turn's
 * state and how far its journal reached, the subscriptions its follows get
 * in order, and a history read it may hold. What the member is shown is
 * recorded as `history`, `replay-complete`, `state <state>` and
 * `<kind> <sequence>`; a send of a turn event `slowSequence` names waits
 * for `slow`.
 */
function drivenMember() {
  const turn = {
    state: "running",
    turnId: "turn-1",
    through: 1,
    replayStart: undefined as { turnId: string; ids: Set<string> } | undefined,
  }
  const follows: ReturnType<typeof controlledSubscription>[] = []
  const calls = { recover: 0, history: 0 }
  let read: Promise<void> | undefined
  const coordinator = {
    snapshot: () => ({
      state: turn.state,
      turnId: turn.turnId,
      requests: [],
    }),
    state: () => turn.state,
    nextCursor: () => turn.through,
    streamed: () => undefined,
    replayStart: () => turn.replayStart,
    holds: () => true,
    answeredHistory: (_scope: SessionScope, page: unknown) => page,
    subscribeScope: () => () => undefined,
    subscribeReadings: () => () => undefined,
    childReports: () => [],
    workReports: () => ({ terminals: [], finished: [] }),
    recover: async () => {
      calls.recover += 1
      const next = follows.shift()
      if (!next) throw new Error("No subscription was armed")
      return next.subscription
    },
    endIfGone: () => false,
    ...HOLDING,
  } as unknown as SessionCoordinator
  const shown: string[] = []
  const slow = Promise.withResolvers<void>()
  let slowSequence: number | undefined
  let slowSends = 0
  const logs = captureLogs()
  const { logger } = logs
  const membership = createChannels({
    coordinator,
    runtime: {
      history: async () => {
        calls.history += 1
        await read
        return {
          sessionId: "session-1",
          messages: [],
          total: 0,
          limit: 500,
          offset: 0,
          nextOffset: 0,
        }
      },
    },
    logger,
  }).join(
    {
      principal: { id: GUEST, role: "guest" },
      middleware: [],
      connection: {
        send: async (event) => {
          if (event.kind === "turn") {
            shown.push(`${event.event.kind} ${event.sequence}`)
            if (event.sequence === slowSequence && slowSends++ === 0)
              await slow.promise
          } else if (event.kind === "execution")
            shown.push(`state ${event.state}`)
          else shown.push(event.kind)
        },
        live: () => true,
        fellBehind: () => undefined,
      },
    },
    SCOPE,
    {
      membershipId: "subscriber-1",
      logger,
      describe: () => ({ code: "failed", message: "failed" }),
      subscribeRow: () => () => undefined,
    }
  )
  return {
    turn,
    membership,
    shown,
    logs,
    /** How many follows and history reads the coordinator was asked. */
    calls,
    /** Arms the subscription the next follow gets. */
    follow(replayed = 0) {
      const next = controlledSubscription(turn.turnId, replayed)
      follows.push(next)
      return next
    },
    /** Holds the next history read until the returned release. */
    holdRead() {
      const held = Promise.withResolvers<void>()
      read = held.promise
      return () => held.resolve()
    },
    /** Holds the first send of the turn event at `sequence` until `release`. */
    slowAt(sequence: number) {
      slowSequence = sequence
      return () => slow.resolve()
    },
  }
}

const turnEvent = (sequence: number, event: TurnEvent): SequencedTurnEvent => ({
  sequence,
  event,
})

/** Settles once `promise` does, or reports that it did not in time. */
async function settledWithin(
  advance: (ms: number) => Promise<void>,
  promise: Promise<unknown>
) {
  let settled = false
  promise.then(
    () => (settled = true),
    () => (settled = true)
  )
  await advance(100)
  return settled
}

// A resume's closing state waits for the member's stream to reach it, and
// never for a stream that will show nothing more: one that fell behind, one
// a rebuild dropped, or one another replaced, which may not release a wait
// meant for its replacement.
describe("a membership's closing state", () => {
  it("closes a view rebuilt for falling behind when its turn ends during the rebuild's read", async () => {
    const clock = useFakeClock()
    const member = drivenMember()
    const first = member.follow()
    first.push(turnEvent(1, { kind: TurnEventKind.TurnStarted }))
    await member.membership.resume({ turnId: "turn-1", after: 0 })
    const release = member.holdRead()

    first.fail(new FanoutOverflowError(4, 400))
    await clock.advance(0)
    // The turn ends while the rebuild reads history; its journal holds more
    // than the dropped stream showed.
    member.turn.state = "idle"
    member.turn.through = 5
    release()
    await clock.advance(100)

    expect(member.shown.slice(member.shown.lastIndexOf("history"))).toEqual([
      "history",
      "state idle",
    ])
  })

  it("answers a from-start resume on the connection that holds the Session when its turn ends during the read", async () => {
    const clock = useFakeClock()
    const member = drivenMember()
    const first = member.follow()
    first.push(turnEvent(1, { kind: TurnEventKind.TurnStarted }))
    await member.membership.resume({ turnId: "turn-1", after: 0 })
    const release = member.holdRead()

    const resumed = member.membership.resume(
      {},
      { fromStart: true, positioned: false, paged: false }
    )
    await clock.advance(0)
    member.turn.state = "idle"
    member.turn.through = 5
    release()

    expect(await settledWithin(clock.advance, resumed)).toBe(true)
    expect(member.shown.slice(member.shown.lastIndexOf("history"))).toEqual([
      "history",
      "replay-complete",
      "state idle",
    ])
  })

  // A stream that falls silent short of what the journal held, never
  // ending, holds a resume's answer no longer than the wait's bound.
  it("states a resume past its wait when its stream falls silent short of the journal", async () => {
    const clock = useFakeClock()
    const member = drivenMember()
    const first = member.follow()
    first.push(chunkAt(1, "One"))
    member.turn.through = 3

    const resumed = member.membership.resume({ turnId: "turn-1", after: 0 })
    await clock.advance(STATE_WAIT_MS - 1)
    expect(member.shown).not.toContain("state running")
    await clock.advance(1)
    await resumed

    expect(member.shown.at(-1)).toBe("state running")
    expect(
      member.logs
        .records()
        .filter(({ message }) => message === "membership.state.wait_passed")
    ).toHaveLength(1)
  })

  // One build of a view at a time: a resume that comes while the view is
  // rebuilt waits for the rebuild, and a rebuild a resume's own stream asks
  // for waits for the resume, which the stream that fell behind no longer
  // holds up.
  it("starts a resume that comes during a rebuild only once the rebuild is done", async () => {
    const clock = useFakeClock()
    const member = drivenMember()
    const first = member.follow()
    first.push(turnEvent(1, { kind: TurnEventKind.TurnStarted }))
    await member.membership.resume({ turnId: "turn-1", after: 0 })
    const release = member.holdRead()
    first.fail(new FanoutOverflowError(4, 400))
    await clock.advance(0)
    member.follow().push(turnEvent(2, chunkAt(2, "Two").event))
    member.turn.through = 2
    const follows = member.calls.recover

    const resumed = member.membership.resume({ turnId: "turn-1", after: 1 })
    await clock.advance(0)
    expect(member.calls.recover).toBe(follows)
    member.turn.state = "idle"
    release()

    expect(await settledWithin(clock.advance, resumed)).toBe(true)
    expect(member.shown.at(-1)).toBe("state idle")
  })

  it("rebuilds a view whose resume's own stream fell behind once that resume is done", async () => {
    const clock = useFakeClock()
    const member = drivenMember()
    const first = member.follow()
    first.push(turnEvent(1, { kind: TurnEventKind.TurnStarted }))
    await member.membership.resume({ turnId: "turn-1", after: 0 })
    first.subscription.close()
    await clock.advance(0)
    // The resume's stream falls behind before it showed what it buffered.
    const second = member.follow(3)
    second.push(turnEvent(2, chunkAt(2, "Two").event))
    second.fail(new FanoutOverflowError(4, 400))
    member.turn.through = 4

    const resumed = member.membership.resume({ turnId: "turn-1", after: 1 })

    expect(await settledWithin(clock.advance, resumed)).toBe(true)
    await clock.advance(100)
    expect(member.calls.history).toBe(1)
    expect(member.shown.indexOf("history")).toBeGreaterThan(
      member.shown.indexOf("replay-complete")
    )
  })

  it("keeps a stream a resume replaced from releasing the state its replacement owes", async () => {
    const clock = useFakeClock()
    const member = drivenMember()
    const first = member.follow()
    first.push(turnEvent(1, { kind: TurnEventKind.TurnStarted }))
    await member.membership.resume({ turnId: "turn-1", after: 0 })
    // The first stream is still writing its next event as the resume
    // replaces it.
    const unblock = member.slowAt(2)
    first.push(turnEvent(2, chunkAt(2, "One").event))
    await clock.advance(0)
    member.turn.replayStart = { turnId: "turn-1", ids: new Set() }
    const second = member.follow(2)
    second.push(
      turnEvent(1, { kind: TurnEventKind.TurnStarted }),
      turnEvent(2, chunkAt(2, "One").event)
    )
    // The journal holds one event more than the replacement replays.
    member.turn.through = 3
    const resumed = member.membership.resume(
      {},
      { fromStart: true, positioned: false, paged: false }
    )
    await clock.advance(0)
    // The replaced stream ends only once the resume waits for its state.
    unblock()
    await clock.advance(0)
    second.push(turnEvent(3, chunkAt(3, "Two").event))

    expect(await settledWithin(clock.advance, resumed)).toBe(true)
    const tail = member.shown.slice(member.shown.lastIndexOf("history"))
    expect(tail.slice(tail.indexOf("replay-complete"))).toEqual([
      "replay-complete",
      `${TurnEventKind.MessageChunk} 3`,
      "state running",
    ])
  })
})
