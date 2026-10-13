import {
  SESSION_CATALOG_MAX_WINDOW,
  type AgentCatalogEntry,
  type AgentCatalogResponse,
  type AgentUpdatePatch,
  type AgentUpdateResponse,
  type RuntimeInfo,
  type Session,
} from "../../protocol"
import { defaultClock, type Clock, type Logger } from "../../lifecycle"
import { coreFailure } from "./failures"
import { callEach } from "./listeners"
import * as ids from "./ids"
import type { ProviderSessionId } from "./ids"
import { createLink, type Link } from "./link"
import { hasSession, type CommandResults, type MemberScope } from "./member"
import type { ServerRuntime, SessionPatch, SessionScope } from "./runtime"
import {
  EXECUTION_STATUS,
  type SessionCoordinator,
} from "./session-coordinator"
import type { SessionRow, SessionRows } from "./session-rows"

/** One Session list page; a cursor carries the next offset. */
const SESSION_LIST_LIMIT = 50
/** The most Sessions one catalog response holds, and so one search answers. */
const SESSION_PAGE_MAX = 100

/**
 * The workspace a runtime holds, as members reach it: one per process, which
 * both listeners share. It owns the Session list and its rows, each with the
 * status its live execution overlays, and every change to them, so a row
 * reaches each member of its Session and a change to the list reaches every
 * member, whichever connection made it.
 */
export type Catalog = {
  /** The row cache every connection projects from and push delivery reads. */
  readonly rows: SessionRows
  info(): Promise<RuntimeInfo>
  agents(): Promise<AgentCatalogResponse>
  /** The absolute folder the Agent's Sessions run in, if the runtime names one. */
  folder(agentId: string): Promise<string | undefined>
  updateAgent(
    agentId: string,
    patch: AgentUpdatePatch,
    revision: string
  ): Promise<AgentUpdateResponse>
  /**
   * The Session an invitation addresses by its conversation reference,
   * created on request; `undefined` if there is none yet.
   */
  invited(
    agentId: string,
    ref: string,
    create?: { firstTurnInstruction?: string }
  ): Promise<{ providerSessionId: ProviderSessionId } | undefined>
  /** The Session a public id names in one Agent, once the runtime holds it. */
  scope(agentId: string, sessionId: string): SessionScope | undefined
  /** One page of every Agent's Sessions, or of one Agent's. */
  list(
    agentId: string | undefined,
    offset: number,
    limit?: number
  ): Promise<CommandResults["list"]>
  /**
   * At most one page of the Sessions a query matches, across every Agent or
   * the one named: the runtime's own search, or else a case-insensitive title
   * match over the listed window.
   */
  search(
    agentId: string | undefined,
    query: string
  ): Promise<CommandResults["search"]>
  /**
   * One Session's row as a replaying cell: the known row at once, then the
   * row the provider holds now, then each change. `failed` hears why that
   * read failed.
   */
  subscribe(
    scope: MemberScope,
    listener: (row: SessionRow) => void,
    failed: (cause: unknown) => void
  ): () => void
  /** Renames, archives, pins or marks one Session. */
  update(scope: SessionScope, patch: SessionPatch): Promise<void>
  /** Settles one Session read at once, and tells the runtime. */
  markRead(agentId: string, sessionId: string): Promise<void>
  delete(scope: SessionScope): Promise<void>
  /**
   * The Session list or an Agent changed and must be read again. `signaled`
   * says whether the runtime reports its own changes; a change made here, an
   * Agent write included, is always told.
   */
  readonly invalidation: {
    readonly signaled: boolean
    subscribe(listener: () => void): () => void
  }
  /** Each Agent a write here changed, as the runtime confirmed it. */
  readonly agentUpdates: {
    subscribe(listener: (agent: AgentCatalogEntry) => void): () => void
  }
}

export type CatalogOptions = {
  runtime: ServerRuntime
  coordinator: Pick<SessionCoordinator, "state" | "endIfGone">
  rows: SessionRows
  /** Where the runtime's change feed writes why it failed. */
  logger: Logger
  clock?: Clock
}

export function createCatalog({
  runtime,
  coordinator,
  rows,
  logger,
  clock = defaultClock,
}: CatalogOptions): Catalog {
  const invalidated = new Set<() => void>()
  const agentUpdated = new Set<(agent: AgentCatalogEntry) => void>()
  const subscribeChanges = runtime.subscribeCatalogChanges?.bind(runtime)
  /**
   * The runtime's own change feed, started by the first listener and kept
   * for the process's life: one that fails is started again on backoff, and
   * at once when the runtime's link turns ready.
   */
  let changes: Link | undefined

  const invalidate = () =>
    callEach(invalidated, logger, "catalog.listener.failed")

  function scope(agentId: string, sessionId: string) {
    const providerSessionId = runtime.resolveProviderSessionId(
      agentId,
      sessionId
    )
    return providerSessionId
      ? { agentId, providerSessionId, sessionId: ids.sessionId(sessionId) }
      : undefined
  }

  /** One page of every Agent's Sessions, or of one Agent's. */
  function listPage(
    agentId: string | undefined,
    limit: number,
    offset: number
  ) {
    return agentId === undefined
      ? runtime.listAllSessions(limit, offset)
      : runtime.listSessions(agentId, limit, offset)
  }

  /** Sessions a read returned, remembered, as members are shown them. */
  function remembered(sessions: readonly Session[]) {
    rows.rememberList(sessions)
    return sessions.map((read) =>
      overlaid(rows.get(read.agentId, read.id) ?? read)
    )
  }

  /** A row as members are shown it: live execution outranks the row. */
  function overlaid(row: SessionRow): SessionRow {
    const target = scope(row.agentId, row.id)
    const state = target ? coordinator.state(target) : "idle"
    return state === "idle" ? row : { ...row, status: EXECUTION_STATUS[state] }
  }

  /**
   * Runs one call on a Session: one that finds it gone ends it for every
   * member, not only for whoever asked.
   */
  async function onSession<T>(target: SessionScope, call: () => Promise<T>) {
    try {
      return await call()
    } catch (cause) {
      coordinator.endIfGone(target, cause)
      throw cause
    }
  }

  /** Reads one Session's row, which reaches each of its members. */
  async function read(target: SessionScope) {
    rows.rememberDetail(
      await onSession(target, () =>
        runtime.getSession(target.agentId, target.providerSessionId)
      )
    )
  }

  async function markRead(agentId: string, sessionId: string) {
    rows.markRead(agentId, sessionId)
    const target = scope(agentId, sessionId)
    if (!target) return
    try {
      await runtime.updateSession(agentId, target.providerSessionId, {
        unread: false,
      })
    } catch {
      // A Session the provider has not created yet rejects the write. Read
      // state is advisory: the optimistic row stands and a later list corrects.
    }
  }

  return {
    rows,
    info: () => runtime.runtimeInfo(),
    agents: () => runtime.listAgents(),
    folder: (agentId) => runtime.agentFolder(agentId),
    async updateAgent(agentId, patch, revision) {
      const updated = await runtime.updateAgent(agentId, patch, revision)
      // Whoever reads Agents learns the write now, not when a cache lapses.
      callEach(agentUpdated, logger, "catalog.listener.failed", updated.agent)
      invalidate()
      return updated
    },
    invited: (agentId, ref, create) =>
      runtime.resolveInvitedSession(agentId, ref, create),
    scope,

    async list(agentId, offset, limit = SESSION_LIST_LIMIT) {
      const page = await listPage(agentId, limit, offset)
      const next = offset + page.sessions.length
      return {
        rows: remembered(page.sessions),
        // No cursor points past the catalog window, which no runtime serves.
        ...(next < Math.min(page.total, SESSION_CATALOG_MAX_WINDOW)
          ? { nextOffset: next }
          : {}),
      }
    },

    async search(agentId, query) {
      if (runtime.searchSessions)
        return {
          rows: remembered(
            // A search that reports no read state leaves the known one.
            (await runtime.searchSessions(agentId, query)).sessions.map(
              (found) => {
                const unread = rows.get(found.agentId, found.id)?.unread
                return found.unread !== undefined || unread === undefined
                  ? found
                  : { ...found, unread }
              }
            )
          ),
        }
      const needle = query.toLocaleLowerCase()
      const matches: Session[] = []
      let offset = 0
      while (
        offset < SESSION_CATALOG_MAX_WINDOW &&
        matches.length < SESSION_PAGE_MAX
      ) {
        const page = await listPage(agentId, SESSION_PAGE_MAX, offset)
        matches.push(
          ...page.sessions.filter(
            ({ title }) => title?.toLocaleLowerCase().includes(needle) ?? false
          )
        )
        offset += page.sessions.length
        if (page.sessions.length < SESSION_PAGE_MAX || offset >= page.total)
          break
      }
      return { rows: remembered(matches.slice(0, SESSION_PAGE_MAX)) }
    },

    subscribe(target, listener, failed) {
      const unsubscribe = rows.subscribeRow(
        target.agentId,
        target.sessionId,
        (row) => listener(overlaid(row))
      )
      // The provider may have changed a listed row while nobody followed it.
      if (hasSession(target)) void read(target).catch(failed)
      return unsubscribe
    },

    async update(target, patch) {
      if ("unread" in patch && !patch.unread)
        return markRead(target.agentId, target.sessionId)
      await onSession(target, () =>
        runtime.updateSession(target.agentId, target.providerSessionId, patch)
      )
      await read(target)
      // Archiving and pinning move the Session's membership and order in the
      // list, which only a relist settles; a runtime's change feed may be
      // debounced or absent. A rename or a read marker moves neither.
      if ("archived" in patch || "pinned" in patch) invalidate()
    },

    markRead,

    async delete(target) {
      await onSession(target, () =>
        runtime.deleteSession(target.agentId, target.providerSessionId)
      )
      rows.forget(target.agentId, target.sessionId)
      invalidate()
    },

    invalidation: {
      signaled: subscribeChanges !== undefined,
      subscribe(listener) {
        invalidated.add(listener)
        if (subscribeChanges)
          changes ??= createLink({
            dial: () => subscribeChanges(invalidate),
            publicError: (cause) =>
              coreFailure(cause) ?? runtime.publicError(cause),
            upstream: runtime.link,
            logger,
            clock,
            bindings: { link: "catalog-changes" },
          })
        return () => {
          invalidated.delete(listener)
        }
      },
    },

    agentUpdates: {
      subscribe(listener) {
        agentUpdated.add(listener)
        return () => {
          agentUpdated.delete(listener)
        }
      },
    },
  }
}
