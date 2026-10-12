import { describe, expect, it, vi } from "vitest"

import { useFakeClock } from "../../test/support/fake-clock"
import { captureLogs } from "../../test/support/log-capture"
import type { Session } from "../../protocol"
import { createCatalog } from "../core/catalog"
import type { ExecutionEvent, PendingRequest } from "../core/events"
import type { Activity } from "../core/member"
import type { ServerRuntime } from "../core/runtime"
import type { SessionExecutionState } from "../core/session-coordinator"
import { createSessionRows } from "../core/session-rows"
import { createActivityFeed } from "./activity-feed"

const AGENT = "researcher"
const AT = "2026-09-19T10:00:00.000Z"

type Execution = {
  state: SessionExecutionState
  turnId?: string
  requests: PendingRequest[]
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    agentId: AGENT,
    title: "Weekly digest",
    archived: false,
    updatedAt: AT,
    status: "idle",
    ...overrides,
  }
}

function harness(
  options: {
    sessions?: Session[]
    executions?: Record<string, Execution>
    now?: () => number
  } = {}
) {
  let deliver: ((event: ExecutionEvent) => void) | undefined
  const unsubscribe = vi.fn()
  const listAllSessions = vi.fn(async () => ({
    sessions: options.sessions ?? [],
    total: options.sessions?.length ?? 0,
    limit: 100,
    offset: 0,
  }))
  const execution = ({ providerSessionId }: { providerSessionId: string }) =>
    options.executions?.[providerSessionId] ?? {
      state: "idle" as const,
      requests: [],
    }
  // The runtime is a wide shared surface; the feed reads one catalog page.
  const runtime = {
    listAllSessions,
    resolveProviderSessionId: (_agentId: string, publicId: string) =>
      `stored-${publicId}`,
  } as unknown as ServerRuntime
  const coordinator = {
    state: (scope: { providerSessionId: string }) => execution(scope).state,
    snapshot: execution,
    endIfGone: () => false,
    subscribeExecutions: (listener: (event: ExecutionEvent) => void) => {
      deliver = listener
      return unsubscribe
    },
  }
  const sessionRows = createSessionRows()
  const feed = createActivityFeed({
    catalog: createCatalog({
      runtime,
      coordinator,
      rows: sessionRows,
      logger: captureLogs().logger,
    }),
    coordinator,
    ...(options.now ? { now: options.now } : {}),
  })
  return {
    feed,
    sessionRows,
    unsubscribe,
    deliver: (event: ExecutionEvent) => deliver?.(event),
  }
}

function lifecycle(
  kind: "turn-started" | "turn-finished" | "turn-failed",
  turnId: string,
  occurredAt = AT
): ExecutionEvent {
  return { agentId: AGENT, sessionId: "session-1", turnId, occurredAt, kind }
}

describe("createActivityFeed", () => {
  it("hydrates unread rows, pending attention, and failed turns, as replayed and dated by the row", async () => {
    const clock = useFakeClock()
    const { feed, sessionRows } = harness({
      sessions: [
        session({ id: "session-1", unread: true }),
        session({ id: "session-2", status: "waiting-for-input" }),
        session({ id: "session-3", status: "failed" }),
        session({ id: "session-4", status: "failed", updatedAt: undefined }),
        session({ id: "session-5" }),
      ],
      executions: {
        "stored-session-2": {
          state: "waiting-for-input",
          turnId: "run-2",
          requests: [
            {
              requestId: "approval-1",
              kind: "permission",
              message: "Deploy\nnow?",
            },
            {
              requestId: "question-1",
              kind: "elicitation",
              questions: [
                { text: "Region?", choices: [], multiple: false, custom: true },
                { text: "Why?", choices: [], multiple: false, custom: true },
              ],
            },
          ],
        },
        "stored-session-3": { state: "idle", turnId: "run-3", requests: [] },
      },
    })

    const seen: Activity[] = []
    feed.open((activity) => seen.push(activity))
    await clock.advance(0)

    const replayed = (sessionId: string, occurredAt = AT) => ({
      agentId: AGENT,
      sessionId,
      occurredAt,
      replayed: true,
    })
    expect(seen).toEqual([
      { ...replayed("session-1"), type: "unread-changed", unread: true },
      {
        ...replayed("session-2"),
        type: "attention-requested",
        requestId: "approval-1",
        attentionKind: "permission",
        requestText: "Deploy now?",
      },
      {
        ...replayed("session-2"),
        type: "attention-requested",
        requestId: "question-1",
        attentionKind: "question",
        requestText: "Region?",
        requestMore: 1,
      },
      { ...replayed("session-3"), type: "turn-failed", turnId: "run-3" },
      {
        // An undated row is dated by the moment the feed re-sent it.
        ...replayed("session-4", new Date().toISOString()),
        type: "turn-failed",
        turnId: "session-4",
      },
    ])
    expect(sessionRows.get(AGENT, "session-1")?.unread).toBe(true)
  })

  it("publishes live execution events, with a request's preview, and every unread flip until its stop", async () => {
    const clock = useFakeClock()
    const { deliver, feed, sessionRows, unsubscribe } = harness({
      sessions: [session({ unread: true })],
    })
    const seen: Activity[] = []
    const stop = feed.open((activity) => seen.push(activity))
    await clock.advance(0)

    deliver(lifecycle("turn-started", "run-1"))
    deliver({
      agentId: AGENT,
      sessionId: "session-1",
      turnId: "run-1",
      occurredAt: AT,
      kind: "attention-requested",
      request: {
        requestId: "approval-1",
        kind: "permission",
        message: "Deploy now?",
      },
    })
    deliver({
      agentId: AGENT,
      sessionId: "session-1",
      turnId: "run-1",
      occurredAt: AT,
      kind: "attention-resolved",
      requestId: "approval-1",
    })
    deliver(lifecycle("turn-finished", "run-1"))
    sessionRows.rememberList([session({ unread: false })])
    sessionRows.rememberList([session({ title: "Renamed", unread: false })])

    expect(seen).toEqual([
      expect.objectContaining({
        type: "unread-changed",
        unread: true,
        replayed: true,
      }),
      expect.objectContaining({ type: "turn-started", turnId: "run-1" }),
      {
        agentId: AGENT,
        sessionId: "session-1",
        occurredAt: AT,
        type: "attention-requested",
        requestId: "approval-1",
        attentionKind: "permission",
        requestText: "Deploy now?",
      },
      expect.objectContaining({
        type: "attention-resolved",
        requestId: "approval-1",
      }),
      expect.objectContaining({ type: "turn-finished", turnId: "run-1" }),
      expect.objectContaining({ type: "unread-changed", unread: false }),
    ])
    // Only hydration re-sends; everything after it happened live.
    expect(seen.slice(1).filter((activity) => activity.replayed)).toEqual([])

    stop()
    deliver(lifecycle("turn-started", "run-2"))
    sessionRows.rememberList([session({ unread: true })])
    expect(seen).toHaveLength(6)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
