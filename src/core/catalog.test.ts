// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import type { AgentCatalogEntry, Session } from "../../protocol"
import { useFakeClock } from "../../test/support/fake-clock"
import { captureLogs } from "../../test/support/log-capture"
import { createCatalog } from "./catalog"
import * as ids from "./ids"
import { READY_LINK } from "./link"
import type { ServerRuntime } from "./runtime"
import type { SessionExecutionState } from "./session-coordinator"
import { createSessionRows } from "./session-rows"

const AGENT = "researcher"
const SESSION = "session-1"

function row(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION,
    agentId: AGENT,
    title: "Weekly digest",
    archived: false,
    updatedAt: "2026-09-19T10:00:00.000Z",
    status: "idle",
    ...overrides,
  }
}

function harness(
  options: {
    listed?: Session
    /** Every listed Session, when a test needs more than one. */
    window?: Session[]
    held?: Session
    state?: SessionExecutionState
    updateSession?: () => Promise<void>
    subscribeCatalogChanges?: ServerRuntime["subscribeCatalogChanges"]
    searchSessions?: ServerRuntime["searchSessions"]
    updateAgent?: ServerRuntime["updateAgent"]
  } = {}
) {
  const updateSession = vi.fn(options.updateSession ?? (async () => undefined))
  // The runtime surface is wide; these tests reach for the list, the row, and
  // the change feed.
  const runtime = {
    publicError: () => undefined,
    link: READY_LINK,
    subscribeCatalogChanges: options.subscribeCatalogChanges,
    searchSessions: options.searchSessions,
    resolveProviderSessionId: (_agentId: string, publicId: string) =>
      `stored-${publicId}`,
    listAllSessions: async (limit: number, offset: number) => ({
      sessions: options.window ?? [options.listed ?? row()],
      total: options.window?.length ?? 1,
      limit,
      offset,
    }),
    getSession: async () => options.held ?? options.listed ?? row(),
    updateSession,
    updateAgent: options.updateAgent,
  } as unknown as ServerRuntime
  const rows = createSessionRows()
  const catalog = createCatalog({
    runtime,
    coordinator: {
      state: () => options.state ?? "idle",
      endIfGone: () => false,
    },
    rows,
    logger: captureLogs().logger,
  })
  return { catalog, rows, updateSession }
}

describe("createCatalog", () => {
  it.each([
    // No live execution: the provider's settled answer stands.
    ["idle", "failed", "failed"],
    ["idle", "waiting-for-input", "waiting-for-input"],
    // A live execution outranks it.
    ["running", "failed", "running"],
    ["stopping", "idle", "running"],
    ["waiting-for-input", "idle", "waiting-for-input"],
    ["uncertain", "idle", "failed"],
  ] satisfies Array<
    [SessionExecutionState, Session["status"], Session["status"]]
  >)(
    "lists a %s Session the provider reports %s as %s",
    async (state, settled, shown) => {
      const { catalog } = harness({ state, listed: row({ status: settled }) })

      const { rows } = await catalog.list(undefined, 0)

      expect(rows.map(({ status }) => status)).toEqual([shown])
    }
  )

  it("shows a member of a listed Session its listed row at once, then the one the provider holds now", async () => {
    const clock = useFakeClock()
    const { catalog } = harness({ held: row({ title: "Renamed elsewhere" }) })
    await catalog.list(undefined, 0)
    const titles: (string | undefined)[] = []

    catalog.subscribe(
      {
        agentId: AGENT,
        sessionId: ids.sessionId(SESSION),
        providerSessionId: ids.providerSessionId(`stored-${SESSION}`),
      },
      ({ title }) => titles.push(title),
      () => undefined
    )
    await clock.advance(0)

    expect(titles).toEqual(["Weekly digest", "Renamed elsewhere"])
  })

  it("keeps the optimistic read row when the provider rejects the write", async () => {
    const { catalog, rows, updateSession } = harness({
      updateSession: async () => {
        throw new Error("Session not found")
      },
    })
    rows.rememberList([row({ unread: true })])

    await expect(catalog.markRead(AGENT, SESSION)).resolves.toBeUndefined()

    expect(updateSession).toHaveBeenCalledWith(AGENT, `stored-${SESSION}`, {
      unread: false,
    })
    expect(rows.get(AGENT, SESSION)?.unread).toBe(false)
  })

  it("matches titles of the listed window, ignoring case, when the runtime cannot search", async () => {
    const { catalog } = harness({
      window: [
        row({ id: "session-1", title: "Weekly Digest" }),
        row({ id: "session-2", title: "Release notes" }),
        row({ id: "session-3", title: undefined }),
      ],
    })

    const { rows } = await catalog.search(undefined, "digest")

    expect(rows.map(({ id }) => id)).toEqual(["session-1"])
  })

  it("keeps a Session's known read state when the runtime's search omits it", async () => {
    const { catalog, rows } = harness({
      searchSessions: async () => ({
        sessions: [row()],
        total: 1,
        limit: 1,
        offset: 0,
      }),
    })
    rows.rememberList([row({ unread: true })])

    const found = await catalog.search(AGENT, "weekly")

    expect(found.rows.map(({ unread }) => unread)).toEqual([true])
  })

  it("tells the catalog and the Agent's listeners of a write, with the entry the runtime stored, and of no failed one", async () => {
    const agent: AgentCatalogEntry = {
      summary: { kind: "ready", id: AGENT, name: "Researcher", muted: true },
      visibility: "visible",
      selectable: true,
      editable: true,
      avatarEditable: true,
      muteEditable: true,
      revision: "revision-2",
    }
    const updateAgent = vi
      .fn<ServerRuntime["updateAgent"]>()
      .mockResolvedValueOnce({ revision: "catalog-2", agent })
      .mockRejectedValueOnce(new Error("revision conflict"))
    const { catalog } = harness({ updateAgent })
    const invalidated = vi.fn()
    const updated = vi.fn()
    catalog.invalidation.subscribe(invalidated)
    catalog.agentUpdates.subscribe(updated)

    await expect(
      catalog.updateAgent(AGENT, { muted: true }, "revision-1")
    ).resolves.toEqual({ revision: "catalog-2", agent })
    expect(invalidated).toHaveBeenCalledOnce()
    expect(updated.mock.calls).toEqual([[agent]])

    await expect(
      catalog.updateAgent(AGENT, { muted: false }, "revision-2")
    ).rejects.toThrow("revision conflict")
    expect(invalidated).toHaveBeenCalledOnce()
    expect(updated).toHaveBeenCalledOnce()
  })

  it("starts the runtime's change feed again when it fails to start", async () => {
    const clock = useFakeClock()
    const subscribeCatalogChanges = vi
      .fn<NonNullable<ServerRuntime["subscribeCatalogChanges"]>>()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValue(() => undefined)
    const { catalog } = harness({ subscribeCatalogChanges })
    const listener = vi.fn()

    catalog.invalidation.subscribe(listener)
    await clock.advance(250)

    expect(subscribeCatalogChanges).toHaveBeenCalledTimes(2)
    subscribeCatalogChanges.mock.calls[1]![0]()
    expect(listener).toHaveBeenCalledOnce()
  })
})
