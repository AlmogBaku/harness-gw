import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"

import { captureLogs, type LogCapture } from "../../test/support/log-capture"
import type { AgentCatalogEntry, AgentCatalogResponse } from "../../protocol"
import {
  COALESCE_WINDOW_MS,
  PRESENCE_CLOSED_GRACE_MS,
  PRESENCE_GRACE_MS,
} from "../../protocol/push"
import type { ExecutionEvent } from "../core/events"
import type { RuntimeInstance } from "../core/runtime"
import { createSessionRows, type SessionRow } from "../core/session-rows"
import { createAgentFacts } from "./agent-facts"
import { createPushDispatcher } from "./dispatcher"
import { createPresenceRegistry } from "./presence"
import {
  openPushRegistrations,
  type PushRegistrations,
  type StoredRegistration,
} from "./registrations"
import type { PushSendResult, PushSender } from "./sender"
import { createTestTimers } from "./test-utils/timers"

const START = 1_700_000_000_000
const DAY_MS = 86_400_000
const OPERATOR = "operator"
const AGENT = "researcher"
const SESSION = "session-1"
const CONNECTION = "connection-1"

const iso = (ms: number) => new Date(ms).toISOString()

/** Lets every pending continuation run, so a push not sent is one never sent. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function device(
  suffix: string,
  overrides: Partial<StoredRegistration> = {}
): StoredRegistration {
  return {
    subscription: {
      endpoint: `https://push.example/${suffix}`,
      keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
    },
    locale: "en",
    categories: { input: true, failure: true, completion: true },
    createdAt: new Date(START).toISOString(),
    ...overrides,
  }
}

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION,
    agentId: AGENT,
    title: "Notes",
    archived: false,
    updatedAt: new Date(START).toISOString(),
    status: "idle",
    ...overrides,
  }
}

function occurred(
  kind: ExecutionEvent["kind"],
  sessionId = SESSION,
  occurredAtMs = START
): ExecutionEvent {
  const base = {
    agentId: AGENT,
    sessionId,
    turnId: "run-1",
    occurredAt: new Date(occurredAtMs).toISOString(),
  }
  if (kind === "attention-requested")
    return {
      ...base,
      kind,
      request: { requestId: "request-1", kind: "permission" },
    }
  if (kind === "attention-resolved")
    return { ...base, kind, requestId: "request-1" }
  return { ...base, kind }
}

/** A request that asks `texts` of the operator, one question each. */
function asked(
  texts: string[],
  { sessionId = SESSION, agentId = AGENT, occurredAtMs = START } = {}
): ExecutionEvent {
  return {
    agentId,
    sessionId,
    turnId: "run-1",
    occurredAt: iso(occurredAtMs),
    kind: "attention-requested",
    request: {
      requestId: `ask-${occurredAtMs}`,
      kind: "elicitation",
      questions: texts.map((text) => ({
        text,
        choices: [],
        multiple: false,
        custom: true,
      })),
    },
  }
}

function entry(
  id: string,
  name: string,
  overrides: Partial<AgentCatalogEntry> = {}
): AgentCatalogEntry {
  return {
    summary: { kind: "ready", id, name },
    visibility: "visible",
    selectable: true,
    editable: true,
    avatarEditable: false,
    muteEditable: false,
    revision: "revision-1",
    ...overrides,
  }
}

function muted(agent: AgentCatalogEntry): AgentCatalogEntry {
  return { ...agent, summary: { ...agent.summary, muted: true } }
}

function catalogOf(...agents: AgentCatalogEntry[]) {
  return { agents: async () => ({ revision: "revision-1", agents }) }
}

type HarnessOptions = {
  devices?: StoredRegistration[]
  rows?: SessionRow[]
  send?: (target: unknown) => Promise<PushSendResult>
  /** Where Agent facts come from; none means every push goes, unnamed. */
  catalog?: { agents: () => Promise<AgentCatalogResponse> }
  registrations?: PushRegistrations
  clock?: ReturnType<typeof createTestTimers>
}

function harness(options: HarnessOptions = {}) {
  const clock = options.clock ?? createTestTimers(START)
  const observers = new Set<(event: ExecutionEvent) => void>()
  const unsubscribe = vi.fn()
  const runtimeInstance = {
    sessions: {
      subscribeExecutions: vi.fn(
        (listener: (event: ExecutionEvent) => void) => {
          observers.add(listener)
          return unsubscribe
        }
      ),
    },
  } as unknown as RuntimeInstance

  // The real cache, so every read the gate consults is one the gateway could have
  // recorded: a provider report through `rememberList`, an acknowledgement
  // through `markRead`.
  const sessionRows = createSessionRows({ now: clock.now })
  if (options.rows) sessionRows.rememberList(options.rows)

  const stored = [...(options.devices ?? [device("device-1")])]
  const registrations: PushRegistrations = options.registrations ?? {
    list: vi.fn(() => [...stored]),
    put: vi.fn(async () => undefined),
    remove: vi.fn(async (_principalId: string, endpoint: string) => {
      const index = stored.findIndex(
        (entry) => entry.subscription.endpoint === endpoint
      )
      if (index !== -1) stored.splice(index, 1)
    }),
    prune: vi.fn(async () => undefined),
  }

  const send = vi.fn<PushSender["send"]>(
    options.send ?? (async () => ({ result: "sent" }) as PushSendResult)
  )
  const sender: PushSender = { send }
  const presence = createPresenceRegistry({ now: clock.now })
  const logs = captureLogs()
  const agentUpdated = new Set<(agent: AgentCatalogEntry) => void>()

  const dispatcher = createPushDispatcher({
    runtimeInstance,
    sessionRows,
    registrations,
    presence,
    sender,
    principalOf: () => OPERATOR,
    ...(options.catalog
      ? {
          agentFacts: createAgentFacts({
            catalog: {
              agents: options.catalog.agents,
              agentUpdates: {
                subscribe(listener) {
                  agentUpdated.add(listener)
                  return () => agentUpdated.delete(listener)
                },
              },
            },
            logger: logs.logger,
            now: clock.now,
            schedule: clock.schedule,
          }),
        }
      : {}),
    logger: logs.logger,
    now: clock.now,
    schedule: clock.schedule,
  })

  return {
    clock,
    dispatcher,
    /** An Agent write the catalog confirmed. */
    agentUpdated(agent: AgentCatalogEntry) {
      for (const listener of agentUpdated) listener(agent)
    },
    presence,
    rows: sessionRows,
    registrations,
    send,
    logs,
    unsubscribe,
    stored,
    publish(event: ExecutionEvent) {
      for (const observer of [...observers]) observer(event)
    },
  }
}

const lines = (logs: LogCapture) =>
  logs.records().map(({ message, fields }) => ({ event: message, ...fields }))

describe("push dispatcher", () => {
  it("notifies only the devices that asked for the category", async () => {
    const test = harness({
      devices: [
        device("device-1"),
        device("device-2", {
          locale: "he",
          categories: { input: false, failure: true, completion: true },
        }),
      ],
    })

    test.publish(occurred("attention-requested"))
    test.clock.advance(COALESCE_WINDOW_MS.input)

    await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce())
    const [target, message, urgency] = test.send.mock.calls[0]!
    expect(target).toMatchObject({
      subscription: { endpoint: "https://push.example/device-1" },
    })
    expect(message).toEqual({
      v: 2,
      category: "input",
      agentId: AGENT,
      sessionId: SESSION,
      occurredAt: iso(START),
      locale: "en",
    })
    expect(urgency).toBe("high")
  })

  it("sends each Session its own push, naming its Agent, its title, and what it asks", async () => {
    const test = harness({
      rows: [
        row({ title: "Quarterly\nnotes" }),
        // A lock screen shows the title and the name, so both are masked.
        row({
          id: "session-2",
          agentId: "writer",
          title: "Draft for token: AAAAbbbb1111",
        }),
      ],
      catalog: catalogOf(
        entry(AGENT, "Researcher"),
        entry("writer", "Writer sk-leaked0000")
      ),
    })

    test.publish(asked(["Which region?", "Why?"]))
    test.clock.advance(1_000)
    test.publish(
      asked(["Ship it?"], {
        sessionId: "session-2",
        agentId: "writer",
        occurredAtMs: START + 1_000,
      })
    )
    test.clock.advance(COALESCE_WINDOW_MS.input)

    await vi.waitFor(() => expect(test.send).toHaveBeenCalledTimes(2))
    const ids = { v: 2, category: "input", locale: "en" }
    expect(test.send.mock.calls.map(([, message]) => message)).toEqual([
      {
        ...ids,
        agentId: AGENT,
        sessionId: SESSION,
        occurredAt: iso(START),
        agentName: "Researcher",
        sessionTitle: "Quarterly notes",
        requestText: "Which region?",
        requestMore: 1,
      },
      {
        ...ids,
        agentId: "writer",
        sessionId: "session-2",
        occurredAt: iso(START + 1_000),
        agentName: "Writer [credential redacted]",
        sessionTitle: "Draft for [credential redacted]",
        requestText: "Ship it?",
      },
    ])
  })

  it("skips a push about an event older than one its Session was already sent", async () => {
    const test = harness()
    const categories = () =>
      test.send.mock.calls.map(([, { category }]) => category)

    test.publish(occurred("turn-finished", SESSION, START))
    test.clock.advance(1_000)
    test.publish(occurred("attention-requested", SESSION, START + 1_000))
    test.clock.advance(COALESCE_WINDOW_MS.input)
    await vi.waitFor(() => expect(categories()).toEqual(["input"]))

    // The question came after the finished turn, so the completion window
    // that closes later has nothing newer to say.
    test.clock.advance(COALESCE_WINDOW_MS.completion)
    await vi.waitFor(() => expect(test.logs.records()).toHaveLength(2))
    expect(lines(test.logs)[1]).toEqual({
      event: "push.suppressed",
      category: "completion",
      reason: "stale",
      sessions: 1,
    })

    // A turn that finishes after the question is news again.
    const finishedAt = test.clock.now()
    test.publish(occurred("turn-finished", SESSION, finishedAt))
    test.clock.advance(COALESCE_WINDOW_MS.completion)
    await vi.waitFor(() =>
      expect(categories()).toEqual(["input", "completion"])
    )
    expect(test.send.mock.calls[1]![1].occurredAt).toBe(iso(finishedAt))
  })

  it.each([
    ["slow", () => new Promise<never>(() => {}), "timeout"],
    ["failing", () => Promise.reject(new Error("catalog down")), "error"],
  ])(
    "sends without the Agent's name when the catalog is %s",
    async (_case, agents, reason) => {
      const test = harness({ catalog: { agents } })

      test.publish(occurred("attention-requested"))
      test.clock.advance(COALESCE_WINDOW_MS.input)
      await flush()
      test.clock.advance(1_000)

      await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce())
      expect(test.send.mock.calls[0]![1]).not.toHaveProperty("agentName")
      expect(lines(test.logs)[0]).toEqual({
        event: "push.agent_facts.failed",
        reason,
      })
    }
  )

  it.each<[string, AgentCatalogEntry, "quiet" | "unnamed"]>([
    ["muted", muted(entry(AGENT, "Researcher")), "quiet"],
    [
      "hidden and not the creator",
      entry(AGENT, "Researcher", { visibility: "hidden" }),
      "quiet",
    ],
    [
      "not selectable",
      entry(AGENT, "Researcher", { selectable: false }),
      "unnamed",
    ],
    [
      "the creator",
      entry(AGENT, "Creator", {
        visibility: "hidden",
        summary: { kind: "ready", id: AGENT, name: "Creator", role: "creator" },
      }),
      "unnamed",
    ],
    ["not in the catalog", entry("writer", "Writer"), "unnamed"],
  ])(
    "sends nothing for an Agent that is quiet, and names no other: %s",
    async (_case, agent, outcome) => {
      const test = harness({ rows: [row()], catalog: catalogOf(agent) })

      test.publish(asked(["Ship it?"]))
      test.clock.advance(COALESCE_WINDOW_MS.input)
      await flush()

      if (outcome === "quiet") {
        expect(test.send).not.toHaveBeenCalled()
        expect(lines(test.logs)).toEqual([
          {
            event: "push.suppressed",
            category: "input",
            reason: "quiet",
            sessions: 1,
          },
        ])
        return
      }
      expect(test.send).toHaveBeenCalledOnce()
      expect(test.send.mock.calls[0]![1]).toMatchObject({
        sessionTitle: "Notes",
        requestText: "Ship it?",
      })
      expect(test.send.mock.calls[0]![1]).not.toHaveProperty("agentName")
    }
  )

  it("honors a mute from the next push, without waiting out the cached read", async () => {
    const agents = vi.fn(catalogOf(entry(AGENT, "Researcher")).agents)
    const test = harness({ catalog: { agents } })
    const ask = () => {
      test.publish(asked(["Ship it?"], { occurredAtMs: test.clock.now() }))
      test.clock.advance(COALESCE_WINDOW_MS.input)
    }
    ask()
    await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce())

    test.agentUpdated(muted(entry(AGENT, "Researcher")))
    ask()
    await flush()

    expect(test.send).toHaveBeenCalledOnce()
    expect(agents).toHaveBeenCalledOnce()
  })

  it.each([
    ["slow", () => new Promise<never>(() => {})],
    ["failing", () => Promise.reject(new Error("catalog down"))],
  ])(
    "keeps a muted Agent quiet when a later read is %s",
    async (_case, later) => {
      const agents = vi
        .fn<() => Promise<AgentCatalogResponse>>()
        .mockImplementationOnce(
          catalogOf(muted(entry(AGENT, "Researcher"))).agents
        )
        .mockImplementation(later)
      const test = harness({ catalog: { agents } })
      const ask = async () => {
        test.publish(asked(["Ship it?"], { occurredAtMs: test.clock.now() }))
        test.clock.advance(COALESCE_WINDOW_MS.input)
        await flush()
        test.clock.advance(1_000)
        await flush()
      }
      await ask()

      // The read has lapsed; the last one that succeeded still answers.
      test.clock.advance(61_000)
      await ask()

      expect(agents).toHaveBeenCalledTimes(2)
      expect(test.send).not.toHaveBeenCalled()
    }
  )

  it("keeps a mute written while a read was out, whatever that read says", async () => {
    const read = Promise.withResolvers<AgentCatalogResponse>()
    const agents = vi
      .fn<() => Promise<AgentCatalogResponse>>()
      .mockReturnValueOnce(read.promise)
    const test = harness({ catalog: { agents } })
    test.publish(asked(["Ship it?"]))
    test.clock.advance(COALESCE_WINDOW_MS.input)
    await flush()

    test.agentUpdated(muted(entry(AGENT, "Researcher")))
    read.resolve({
      revision: "revision-1",
      agents: [entry(AGENT, "Researcher")],
    })
    await flush()

    expect(test.send).not.toHaveBeenCalled()
    expect(lines(test.logs)).toContainEqual(
      expect.objectContaining({ reason: "quiet" })
    )
  })

  it("pushes after an unmute even when the next read fails", async () => {
    const agents = vi
      .fn<() => Promise<AgentCatalogResponse>>()
      .mockImplementationOnce(
        catalogOf(muted(entry(AGENT, "Researcher"))).agents
      )
      .mockRejectedValue(new Error("catalog down"))
    const test = harness({ catalog: { agents } })
    test.publish(asked(["Ship it?"]))
    test.clock.advance(COALESCE_WINDOW_MS.input)
    await flush()
    expect(test.send).not.toHaveBeenCalled()

    test.agentUpdated(entry(AGENT, "Researcher"))
    test.clock.advance(61_000)
    test.publish(asked(["Ship it?"], { occurredAtMs: test.clock.now() }))
    test.clock.advance(COALESCE_WINDOW_MS.input)

    await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce())
    expect(agents).toHaveBeenCalledTimes(2)
    expect(test.send.mock.calls[0]![1]).toMatchObject({
      agentName: "Researcher",
    })
  })

  it("tells only a device registered in the last 30 days what a Session is about, and drops one past 90", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aos-push-dispatch-"))
    onTestFinished(() => rm(stateDir, { recursive: true }))
    const clock = createTestTimers(START)
    const registrations = await openPushRegistrations({
      stateDir,
      now: clock.now,
    })
    const { subscription, locale, categories } = device("device-1")
    const register = () =>
      registrations.put(OPERATOR, { subscription, locale, categories })
    const test = harness({ clock, registrations, rows: [row()] })
    const ask = () => {
      test.publish(asked(["Ship it?"], { occurredAtMs: clock.now() }))
      clock.advance(COALESCE_WINDOW_MS.input)
    }
    await register()

    clock.advance(31 * DAY_MS)
    ask()
    await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce())
    expect(Object.keys(test.send.mock.calls[0]![1]).sort()).toEqual([
      "agentId",
      "category",
      "locale",
      "occurredAt",
      "sessionId",
      "v",
    ])

    // The browser registering it again makes it fresh again.
    await register()
    ask()
    await vi.waitFor(() => expect(test.send).toHaveBeenCalledTimes(2))
    expect(test.send.mock.calls[1]![1]).toMatchObject({
      sessionTitle: "Notes",
      requestText: "Ship it?",
    })

    clock.advance(91 * DAY_MS)
    ask()
    await vi.waitFor(() => expect(registrations.list(OPERATOR)).toEqual([]))
    await flush()
    expect(test.send).toHaveBeenCalledTimes(2)
  })

  it("sends a finished run to every device at the slower cadence", async () => {
    const test = harness({ devices: [device("device-1"), device("device-2")] })

    test.publish(occurred("turn-finished", "session-1"))
    test.publish(occurred("turn-finished", "session-2"))
    test.clock.advance(COALESCE_WINDOW_MS.input)
    expect(test.send).not.toHaveBeenCalled()

    test.clock.advance(COALESCE_WINDOW_MS.completion)

    // Two Sessions to each of two devices.
    await vi.waitFor(() => expect(test.send).toHaveBeenCalledTimes(4))
    expect(
      test.send.mock.calls.map(([, { category }, urgency]) => [
        category,
        urgency,
      ])
    ).toEqual(Array(4).fill(["completion", "normal"]))
  })

  it("sends nothing while the operator is at the workspace", () => {
    const test = harness()
    test.presence.set(OPERATOR, CONNECTION, {
      sessionId: null,
      foreground: true,
      idle: false,
    })

    test.publish(occurred("attention-requested"))
    test.clock.advance(COALESCE_WINDOW_MS.input)

    expect(test.send).not.toHaveBeenCalled()
    expect(test.clock.pending()).toBe(0)
    expect(lines(test.logs)).toEqual([
      {
        event: "push.suppressed",
        category: "input",
        reason: "present",
        sessions: 1,
      },
    ])
  })

  it("notifies about an event that happened after the operator read the Session", async () => {
    // The closed-app case: the operator read the Session, then closed the tab,
    // and the turn finished afterwards. Nothing will ever report the row unread
    // again, so only the time the read settled can answer for this event.
    const test = harness({ rows: [row({ unread: true })] })
    test.rows.markRead(AGENT, SESSION)

    test.clock.advance(1_000)
    test.publish(occurred("turn-finished", SESSION, START + 1_000))
    test.clock.advance(COALESCE_WINDOW_MS.completion)

    await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce())
    expect(test.send.mock.calls[0]![1]).toMatchObject({
      category: "completion",
      sessionId: SESSION,
    })
  })

  it("notifies when only a roster read reported the Session read", async () => {
    // The live failure: the operator read the Session, the turn finished after
    // that, and a roster read a second later still reported it read. A provider
    // report carries no read time, so it must not settle over the event.
    const test = harness({ rows: [row({ unread: true })] })
    test.rows.markRead(AGENT, SESSION)

    test.clock.advance(1_000)
    test.publish(occurred("turn-finished", SESSION, START + 1_000))
    test.clock.advance(1_000)
    test.rows.rememberList([row({ unread: false })])
    test.clock.advance(COALESCE_WINDOW_MS.completion)

    await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce())
    expect(test.send.mock.calls[0]![1]).toMatchObject({
      category: "completion",
      sessionId: SESSION,
    })
  })

  it("leaves out a Session the operator read after the event, and says which read", () => {
    const test = harness({ rows: [row({ unread: true })] })

    test.clock.advance(1_000)
    test.publish(occurred("attention-requested", SESSION, START + 1_000))
    test.clock.advance(1_000)
    test.rows.markRead(AGENT, SESSION)
    test.clock.advance(COALESCE_WINDOW_MS.input)

    expect(test.send).not.toHaveBeenCalled()
    expect(test.clock.pending()).toBe(0)
    expect(lines(test.logs)).toEqual([
      {
        event: "push.suppressed",
        category: "input",
        reason: "read",
        sessions: 1,
        readAtMs: START + 2_000,
        occurredAtMs: START + 1_000,
      },
    ])
  })

  it("reports the read decision that held back the oldest event", () => {
    const test = harness({
      rows: [row({ unread: true }), row({ id: "session-2", unread: true })],
    })

    test.publish(occurred("attention-requested", SESSION, START + 1_000))
    test.publish(occurred("attention-requested", "session-2", START + 500))
    test.clock.advance(1_500)
    test.rows.markRead(AGENT, "session-2")
    test.clock.advance(500)
    test.rows.markRead(AGENT, SESSION)
    test.clock.advance(COALESCE_WINDOW_MS.input)

    expect(test.send).not.toHaveBeenCalled()
    expect(lines(test.logs)).toEqual([
      {
        event: "push.suppressed",
        category: "input",
        reason: "read",
        sessions: 2,
        readAtMs: START + 1_500,
        occurredAtMs: START + 500,
      },
    ])
  })

  it("leaves out a Session that is on screen, even behind an idle reader", async () => {
    const test = harness()
    test.presence.set(OPERATOR, CONNECTION, {
      sessionId: SESSION,
      foreground: true,
      idle: true,
    })

    test.publish(occurred("attention-requested", SESSION))
    test.publish(occurred("attention-requested", "session-2"))
    test.clock.advance(COALESCE_WINDOW_MS.input)

    await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce())
    expect(test.send.mock.calls[0]![1]).toMatchObject({
      sessionId: "session-2",
    })
  })

  it("reports a window emptied by the Session on screen as exposed", () => {
    const test = harness()
    test.presence.set(OPERATOR, CONNECTION, {
      sessionId: SESSION,
      foreground: true,
      idle: true,
    })

    test.publish(occurred("attention-requested", SESSION))
    test.clock.advance(COALESCE_WINDOW_MS.input)

    expect(test.send).not.toHaveBeenCalled()
    expect(lines(test.logs)).toEqual([
      {
        event: "push.suppressed",
        category: "input",
        reason: "exposed",
        sessions: 1,
      },
    ])
  })

  it("waits out the full grace of an operator who is only away", async () => {
    const test = harness()
    test.presence.set(OPERATOR, CONNECTION, {
      sessionId: null,
      foreground: true,
      idle: false,
    })
    // The grace runs from the lapse, not from the last heartbeat before it.
    const lapsedAt = START + 30_000
    test.clock.advance(30_000)
    test.presence.set(OPERATOR, CONNECTION, {
      sessionId: null,
      foreground: false,
      idle: false,
    })

    test.publish(occurred("attention-requested"))
    test.clock.advance(COALESCE_WINDOW_MS.input)
    expect(test.send).not.toHaveBeenCalled()
    expect(test.clock.pending()).toBe(1)

    // The held window closes when the full grace ends, not a moment before.
    test.clock.advance(lapsedAt + PRESENCE_GRACE_MS - test.clock.now() - 1)
    expect(test.clock.pending()).toBe(1)
    test.clock.advance(1)
    expect(test.clock.pending()).toBe(0)

    await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce())
  })

  it("waits only long enough for a reconnect once every connection has gone", async () => {
    const test = harness()
    test.presence.set(OPERATOR, CONNECTION, {
      sessionId: null,
      foreground: true,
      idle: false,
    })
    test.publish(occurred("attention-requested"))

    const closedAt = START + 2_000
    test.clock.advance(2_000)
    test.presence.clear(OPERATOR, CONNECTION)
    test.clock.advance(1_000)
    expect(test.send).not.toHaveBeenCalled()
    expect(test.clock.pending()).toBe(1)

    // The held window closes when the closed grace ends, not a moment before.
    test.clock.advance(
      closedAt + PRESENCE_CLOSED_GRACE_MS - test.clock.now() - 1
    )
    expect(test.clock.pending()).toBe(1)
    test.clock.advance(1)
    expect(test.clock.pending()).toBe(0)

    await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce())
  })

  it("sends nothing when a reload reconnects inside the closed grace", () => {
    const test = harness()
    test.presence.set(OPERATOR, CONNECTION, {
      sessionId: null,
      foreground: true,
      idle: false,
    })
    test.publish(occurred("attention-requested"))
    test.presence.clear(OPERATOR, CONNECTION)

    // The reloaded page opens a new connection and reports itself present again.
    test.clock.advance(1_000)
    test.presence.set(OPERATOR, "connection-2", {
      sessionId: null,
      foreground: true,
      idle: false,
    })
    test.clock.advance(COALESCE_WINDOW_MS.input)

    expect(test.send).not.toHaveBeenCalled()
    expect(test.clock.pending()).toBe(0)
    expect(lines(test.logs)).toEqual([
      {
        event: "push.suppressed",
        category: "input",
        reason: "present",
        sessions: 1,
      },
    ])
  })

  it("forgets a device the push service reports as gone", async () => {
    const test = harness({
      devices: [device("device-1"), device("device-2")],
      send: async (target) =>
        (target as StoredRegistration).subscription.endpoint.endsWith(
          "device-2"
        )
          ? { result: "gone", status: 410 }
          : { result: "sent" },
    })

    test.publish(occurred("turn-failed"))
    test.clock.advance(COALESCE_WINDOW_MS.failure)

    await vi.waitFor(() =>
      expect(test.registrations.remove).toHaveBeenCalledWith(
        OPERATOR,
        "https://push.example/device-2"
      )
    )
    expect(
      test.stored.map(({ subscription }) => subscription.endpoint)
    ).toEqual(["https://push.example/device-1"])
    expect(lines(test.logs)).toEqual([
      {
        event: "push.dispatched",
        category: "failure",
        count: 1,
        devices: 2,
        sent: 1,
        gone: 1,
        failed: 0,
        statuses: { "410": 1 },
      },
    ])
  })

  it("writes lines that name no device, no Session, and nothing a push tells", async () => {
    const content = {
      rows: [row({ title: "Zebra title" })],
      catalog: catalogOf(entry(AGENT, "Quokka name")),
    }
    const question = asked(["Walrus question?"])
    // Sent, then held back while the operator looks on.
    const shown = harness(content)
    shown.publish(question)
    shown.clock.advance(COALESCE_WINDOW_MS.input)
    await vi.waitFor(() => expect(shown.send).toHaveBeenCalledOnce())
    shown.presence.set(OPERATOR, CONNECTION, {
      sessionId: null,
      foreground: true,
      idle: false,
    })
    shown.publish(asked(["Walrus question?"], { occurredAtMs: START + 5_000 }))
    shown.clock.advance(COALESCE_WINDOW_MS.input)
    // Sent without a name the catalog could not give.
    const unnamed = harness({
      ...content,
      catalog: { agents: () => Promise.reject(new Error("catalog down")) },
    })
    unnamed.publish(question)
    unnamed.clock.advance(COALESCE_WINDOW_MS.input)
    await vi.waitFor(() => expect(unnamed.send).toHaveBeenCalledOnce())
    // Not sent at all.
    const broken = harness({
      ...content,
      registrations: {
        list: () => {
          throw new Error("registrations unreadable")
        },
        put: async () => undefined,
        remove: async () => undefined,
        prune: async () => undefined,
      },
    })
    broken.publish(question)
    broken.clock.advance(COALESCE_WINDOW_MS.input)
    await vi.waitFor(() => expect(broken.logs.records()).toHaveLength(1))
    // Held back because the Agent is muted.
    const quiet = harness({
      ...content,
      catalog: catalogOf(muted(entry(AGENT, "Quokka name"))),
    })
    quiet.publish(question)
    quiet.clock.advance(COALESCE_WINDOW_MS.input)
    await vi.waitFor(() =>
      expect(lines(quiet.logs)).toContainEqual(
        expect.objectContaining({ reason: "quiet" })
      )
    )

    const written = [shown, unnamed, broken, quiet].flatMap((test) =>
      lines(test.logs)
    )
    expect(new Set(written.map(({ event }) => event))).toEqual(
      new Set([
        "push.dispatched",
        "push.suppressed",
        "push.agent_facts.failed",
        "push.deliver.failed",
      ])
    )
    const text = JSON.stringify(written)
    for (const told of [
      "push.example",
      "p256dh",
      SESSION,
      AGENT,
      "Quokka",
      "Zebra",
      "Walrus",
    ])
      expect(text).not.toContain(told)
  })

  it("ignores the events no device is notified about", async () => {
    const test = harness()

    test.publish(occurred("turn-started"))
    test.publish(occurred("attention-resolved"))
    test.clock.advance(60_000)

    expect(test.clock.pending()).toBe(0)
    expect(test.send).not.toHaveBeenCalled()
  })

  it("stops observing the coordinator when it closes", () => {
    const test = harness()
    test.publish(occurred("attention-requested"))

    test.dispatcher.close()

    expect(test.unsubscribe).toHaveBeenCalledOnce()
    test.clock.advance(60_000)
    expect(test.send).not.toHaveBeenCalled()
  })
})
