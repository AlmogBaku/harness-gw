import { describe, expect, it, vi } from "vitest"

import { captureLogs } from "../../../test/support/log-capture"
import {
  createOpenCodeWorkspaceOperations,
  OpenCodeWorkspaceUnavailableError,
} from "./workspace"

const session = (overrides: Record<string, unknown> = {}) => ({
  id: "session-1",
  agent: "research",
  title: "Research notes",
  time: { created: 1_000, updated: 2_000 },
  ...overrides,
})

type Client = Parameters<typeof createOpenCodeWorkspaceOperations>[0]["client"]

/** A native client with an empty catalog whose Sessions all belong to `research`. */
function stubClient(
  sessions: Partial<Client["sessions"]> = {},
  agents: Client["catalog"]["agents"] = async () => ({ data: [] })
): Client {
  return {
    catalog: { agents },
    sessions: {
      list: async () => ({ data: [], cursor: {} }),
      get: async () => session(),
      create: async () => session(),
      update: async () => {},
      delete: async () => {},
      ...sessions,
    },
  }
}

describe("OpenCode workspace operations", () => {
  it("returns only exact-Agent owned Sessions in stable recent order", async () => {
    const operations = createOpenCodeWorkspaceOperations({
      client: stubClient({
        list: async () => ({
          data: [
            session({ id: "older", time: { created: 1, updated: 10 } }),
            session({
              id: "foreign",
              agent: "other",
              time: { created: 1, updated: 90 },
            }),
            session({ id: "newer", time: { created: 1, updated: 90 } }),
            session({
              id: "unowned",
              agent: undefined,
              time: { created: 1, updated: 100 },
            }),
          ],
          cursor: {},
        }),
      }),
    })

    await expect(operations.listSessions("research", 50, 0)).resolves.toEqual({
      sessions: [
        {
          id: "newer",
          agentId: "research",
          title: "Research notes",
          archived: false,
          createdAt: "1970-01-01T00:00:01.000Z",
          updatedAt: "1970-01-01T00:01:30.000Z",
          status: "idle",
        },
        {
          id: "older",
          agentId: "research",
          title: "Research notes",
          archived: false,
          createdAt: "1970-01-01T00:00:01.000Z",
          updatedAt: "1970-01-01T00:00:10.000Z",
          status: "idle",
        },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    })
  })

  it.each([
    ["one Agent's", "research", "research", ["s3", "s1"]],
    ["every Agent's", undefined, "RESEARCH", ["s4", "s3", "s1"]],
    ["no", "research", "budget", []],
  ])(
    "searches %s Session titles, ignoring case, newest first",
    async (_case, agentId, query, matched) => {
      const operations = createOpenCodeWorkspaceOperations({
        client: stubClient({
          list: async () => ({
            data: [
              session({ id: "s1", title: "Research notes" }),
              session({ id: "s2", title: "Meeting minutes" }),
              session({
                id: "s3",
                title: "research follow-up",
                time: { created: 1, updated: 3_000 },
              }),
              session({
                id: "s4",
                agent: "other",
                title: "Other research",
                time: { created: 1, updated: 4_000 },
              }),
              session({
                id: "s5",
                agent: undefined,
                title: "Unowned research",
              }),
            ],
            cursor: {},
          }),
        }),
      })

      const page = await operations.searchSessions(agentId, query)

      expect(page.sessions.map(({ id }) => id)).toEqual(matched)
      expect(page.total).toBe(matched.length)
    }
  )

  // A child is a Session OpenCode's `task` tool spawned, and `parentID` is its
  // only marker: the parent is the one top-level Session.
  it("keeps a child Session out of every list, search and invite lookup, whatever else its row holds", async () => {
    const invited = "aos-invite:guest-1"
    const logs = captureLogs()
    const operations = createOpenCodeWorkspaceOperations({
      client: stubClient({
        list: async () => ({
          data: [
            session({ id: "parent", title: invited }),
            session({ id: "child", parentID: "parent", title: invited }),
            session({ id: "unreadable-child", parentID: "parent", title: "" }),
            session({ id: "other-child", agent: "other", parentID: "parent" }),
          ],
          cursor: {},
        }),
      }),
      log: logs.logger,
    })

    for (const page of [
      await operations.listSessions("research", 50, 0),
      await operations.listAllSessions(50, 0),
      await operations.searchSessions(undefined, "guest"),
    ])
      expect(page).toMatchObject({ sessions: [{ id: "parent" }], total: 1 })
    // Only the parent holds the invited title, and no child row is a bad one.
    await expect(
      operations.resolveInvitedSession("research", "guest-1")
    ).resolves.toEqual({ providerSessionId: "parent", created: false })
    expect(logs.records()).toEqual([])
  })

  // A child named by id is as out of reach as an unlisted one.
  it("refuses a child Session named by id before any native mutation", async () => {
    const update = vi.fn(async () => {})
    const remove = vi.fn(async () => {})
    const operations = createOpenCodeWorkspaceOperations({
      client: stubClient({
        get: async () => session({ id: "child", parentID: "parent" }),
        update,
        delete: remove,
      }),
    })

    for (const refused of [
      operations.getSession("research", "child"),
      operations.updateSession("research", "child", { title: "Renamed" }),
      operations.deleteSession("research", "child"),
    ])
      await expect(refused).rejects.toMatchObject({
        name: "OpenCodeWorkspaceScopeError",
      })
    expect(update).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it("lists the other Sessions past a malformed row across cursor pages, and fails only when none can be read", async () => {
    const at = (id: string, updated: number) =>
      session({ id, time: { created: 1, updated } })
    let pages: Record<string, unknown> = {
      first: {
        data: [at("one", 30), session({ id: "untitled", title: "" })],
        cursor: { next: "second" },
      },
      second: { data: [at("two", 20), at("one", 99)], cursor: {} },
    }
    const logs = captureLogs()
    const operations = createOpenCodeWorkspaceOperations({
      client: stubClient({
        list: async ({ cursor } = {}) => pages[cursor ?? "first"],
      }),
      log: logs.logger,
    })

    const page = await operations.listSessions("research", 50, 0)

    expect(page.sessions.map(({ id }) => id)).toEqual(["one", "two"])
    expect(
      logs.records().map(({ message, fields }) => [message, fields])
    ).toEqual([
      ["opencode.session.skipped", { sessionId: "untitled" }],
      ["opencode.session.skipped", { sessionId: "one" }],
    ])
    // An invite read that skipped a row cannot tell its Session is not there.
    await expect(
      operations.resolveInvitedSession("research", "guest")
    ).rejects.toBeInstanceOf(OpenCodeWorkspaceUnavailableError)

    pages = { first: { data: [session({ title: "" })], cursor: {} } }
    await expect(
      operations.listSessions("research", 50, 0)
    ).rejects.toBeInstanceOf(OpenCodeWorkspaceUnavailableError)
  })

  it("lists the other Agents when one Agent row is malformed, and fails only when none can be read", async () => {
    const agent = (overrides: Record<string, unknown>) => ({
      id: "research",
      mode: "primary",
      hidden: false,
      permissions: [],
      request: {},
      ...overrides,
    })
    let agents: unknown[] = [
      agent({}),
      // An Agent's request can carry credential headers; no warning repeats it.
      agent({
        id: "broken",
        mode: "sometimes",
        request: { headers: { authorization: "Bearer fake-token" } },
      }),
      agent({ id: "verbose", description: "d".repeat(4_097) }),
    ]
    const logs = captureLogs()
    const operations = createOpenCodeWorkspaceOperations({
      client: stubClient({}, async () => ({ data: agents })),
      log: logs.logger,
    })

    const catalog = await operations.listAgents()

    expect(catalog.agents.map(({ summary }) => summary.id)).toEqual([
      "research",
    ])
    expect(
      logs.records().map(({ message, fields }) => [message, fields])
    ).toEqual([
      ["opencode.agent.skipped", { agentId: "broken" }],
      ["opencode.agent.skipped", { agentId: "verbose" }],
    ])

    agents = [agent({ id: "broken", mode: "sometimes" })]
    await expect(operations.listAgents()).rejects.toBeInstanceOf(
      OpenCodeWorkspaceUnavailableError
    )
    // What survives a skip holds no Agent a person can pick.
    agents = [
      agent({ id: "hidden", hidden: true }),
      agent({ id: "broken", mode: "sometimes" }),
    ]
    await expect(operations.listAgents()).rejects.toBeInstanceOf(
      OpenCodeWorkspaceUnavailableError
    )
  })

  it("fails closed when an invite title has multiple exact-Agent matches", async () => {
    const operations = createOpenCodeWorkspaceOperations({
      client: stubClient({
        list: async () => ({
          data: [
            session({ id: "one", title: "aos-invite:guest-1" }),
            session({ id: "two", title: "aos-invite:guest-1" }),
          ],
          cursor: {},
        }),
      }),
    })

    await expect(
      operations.resolveInvitedSession("research", "guest-1")
    ).rejects.toMatchObject({ name: "OpenCodeWorkspaceUnavailableError" })
  })

  it("shares an in-flight exact-Agent invite lookup", async () => {
    let reads = 0
    let release: (() => void) | undefined
    const listed = new Promise<void>((resolve) => {
      release = resolve
    })
    const operations = createOpenCodeWorkspaceOperations({
      client: stubClient({
        list: async () => {
          reads += 1
          await listed
          return { data: [], cursor: {} }
        },
      }),
    })

    const first = operations.resolveInvitedSession("research", "guest-3")
    const second = operations.resolveInvitedSession("research", "guest-3")
    await Promise.resolve()
    expect(reads).toBe(1)
    release?.()
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ])
  })

  it("fails closed for a missing invite even when an untrusted title-create callback is offered", async () => {
    let created = false
    const operations = createOpenCodeWorkspaceOperations({
      client: stubClient({
        list: async () => ({
          data: created
            ? [session({ id: "invited", title: "aos-invite:guest-2" })]
            : [],
          cursor: {},
        }),
      }),
      // @ts-expect-error The operations take no create callback; one offered anyway must be ignored.
      createInvitedSession: async (agentId: string, title: string) => {
        created = agentId === "research" && title === "aos-invite:guest-2"
      },
    })

    await expect(
      operations.resolveInvitedSession("research", "guest-2", {
        firstTurnInstruction: "Start safely",
      })
    ).rejects.toMatchObject({ name: "OpenCodeWorkspaceUnavailableError" })
    expect(created).toBe(false)
  })

  it("reads a token avatar from the native request body and folds only it into the revision", async () => {
    let body: Record<string, unknown> = { avatar: "ring/blue" }
    let headers: Record<string, string> = { "x-sample": "one" }
    const operations = createOpenCodeWorkspaceOperations({
      client: stubClient({}, async () => ({
        data: [
          {
            id: "agent-a",
            mode: "primary",
            hidden: false,
            permissions: [],
            request: { headers, body },
          },
        ],
      })),
    })

    const tokened = await operations.listAgents()
    expect(tokened.agents[0]).toMatchObject({
      summary: { id: "agent-a", avatar: "ring/blue" },
      avatarEditable: false,
    })

    headers = { "x-sample": "two" }
    const sameAvatar = await operations.listAgents()
    expect(sameAvatar.agents[0]!.revision).toBe(tokened.agents[0]!.revision)

    body = { avatar: "ring/green" }
    const changed = await operations.listAgents()
    expect(changed.agents[0]!.revision).not.toBe(tokened.agents[0]!.revision)

    for (const avatar of ["Not A Token", 7, "ring"]) {
      body = { avatar }
      const ignored = await operations.listAgents()
      expect(ignored.agents[0]!.summary).not.toHaveProperty("avatar")
    }
  })

  it("projects the native pin state only from Session metadata", async () => {
    const operations = createOpenCodeWorkspaceOperations({
      client: stubClient({
        list: async () => ({
          data: [
            session({ id: "pinned", metadata: { "aos.pinned": true } }),
            session({ id: "unpinned", metadata: { "native.label": "keep" } }),
            session({ id: "untracked" }),
          ],
          cursor: {},
        }),
      }),
    })

    const page = await operations.listSessions("research", 50, 0)

    expect(page.sessions.find((row) => row.id === "pinned")).toMatchObject({
      pinned: true,
    })
    expect(page.sessions.find((row) => row.id === "unpinned")).toMatchObject({
      pinned: false,
    })
    expect(
      page.sessions.find((row) => row.id === "untracked")
    ).not.toHaveProperty("pinned")
  })

  it("verifies exact Session ownership before any native mutation", async () => {
    const update = vi.fn(async () => {})
    const remove = vi.fn(async () => {})
    const operations = createOpenCodeWorkspaceOperations({
      client: stubClient({
        get: async () => session({ agent: "other" }),
        update,
        delete: remove,
      }),
    })

    await expect(
      operations.updateSession("research", "session-1", { title: "Renamed" })
    ).rejects.toMatchObject({ name: "OpenCodeWorkspaceScopeError" })
    await expect(
      operations.deleteSession("research", "session-1")
    ).rejects.toMatchObject({ name: "OpenCodeWorkspaceScopeError" })
    expect(update).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
})
