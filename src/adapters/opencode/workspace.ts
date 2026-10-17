import type { Logger } from "../../../lifecycle"
import {
  AgentCatalogEntrySchema,
  AgentCatalogResponseSchema,
  newestSessionFirst,
  SessionCatalogResponseSchema,
  SessionCreateResponseSchema,
  SessionSchema,
  type AgentCatalogEntry,
  type AgentCatalogResponse,
  type Session,
  type SessionCatalogResponse,
} from "../../../protocol"
import * as ids from "../../core/ids"
import { loggedId } from "../../core/identifier"
import { inviteSessionKey } from "../../core/invite-key"
import type { SessionPatch } from "../../core/runtime"
import {
  isOpenCodeChildSession,
  openCodeAgentAvatar,
  parseOpenCodeAgent,
  parseOpenCodeAgentCatalog,
  parseOpenCodeSession,
  parseOpenCodeSessionCatalog,
  type OpenCodeAgent,
} from "./native-schemas"

const MAX_PAGE_SIZE = 100
const MAX_CATALOG_WINDOW = 1_000

export class OpenCodeWorkspaceScopeError extends Error {
  constructor() {
    super("Session is not available in this Agent scope")
    this.name = "OpenCodeWorkspaceScopeError"
  }
}

export class OpenCodeWorkspaceUnavailableError extends Error {
  constructor() {
    super("OpenCode workspace operation is temporarily unavailable")
    this.name = "OpenCodeWorkspaceUnavailableError"
  }
}

type OpenCodeWorkspaceClient = {
  catalog: { agents(signal?: AbortSignal): Promise<unknown> }
  sessions: {
    list(options?: {
      limit?: number
      cursor?: string
      signal?: AbortSignal
    }): Promise<unknown>
    get(sessionId: string, signal?: AbortSignal): Promise<unknown>
    create(input?: { agent?: string }, signal?: AbortSignal): Promise<unknown>
    update(
      sessionId: string,
      input: {
        title?: string
        time?: { archived?: number }
        metadata?: Record<string, unknown>
      },
      signal?: AbortSignal
    ): Promise<void>
    delete(sessionId: string, signal?: AbortSignal): Promise<void>
  }
}

/** AOS owns this one native metadata key; OpenCode has no native pin flag. */
export const OPENCODE_PIN_METADATA_KEY = "aos.pinned"

export type OpenCodeWorkspaceOperations = ReturnType<
  typeof createOpenCodeWorkspaceOperations
>

function timestamp(value: number) {
  return new Date(value < 10_000_000_000 ? value * 1_000 : value).toISOString()
}

function revision(parts: readonly string[]) {
  let hash = 2_166_136_261
  for (const part of parts.join("\u0000")) {
    hash ^= part.charCodeAt(0)
    hash = Math.imul(hash, 16_777_619)
  }
  return `oc-${(hash >>> 0).toString(36)}`
}

/** The most Sessions one search answers: one catalog page. */
const SEARCH_LIMIT = 100

/** One native Agent as its catalog entry. */
function catalogEntry(agent: OpenCodeAgent) {
  const avatar = openCodeAgentAvatar(agent.request)
  const visibility = agent.hidden ? ("hidden" as const) : ("visible" as const)
  return {
    summary: {
      kind: "ready" as const,
      id: agent.id,
      name: agent.id,
      ...(agent.description ? { description: agent.description } : {}),
      ...(avatar ? { avatar } : {}),
      status: "unknown" as const,
      activity: "unknown" as const,
      visibility,
    },
    visibility,
    selectable: !agent.hidden,
    editable: false,
    avatarEditable: false,
    muteEditable: false,
    revision: revision([
      agent.id,
      agent.description ?? "",
      String(agent.hidden),
      avatar ?? "",
    ]),
  }
}

function validPage(limit: number, offset: number) {
  return (
    Number.isSafeInteger(limit) &&
    Number.isSafeInteger(offset) &&
    limit >= 1 &&
    limit <= MAX_PAGE_SIZE &&
    offset >= 0 &&
    offset + limit <= MAX_CATALOG_WINDOW
  )
}

function projectSession(
  value: ReturnType<typeof parseOpenCodeSession>["data"],
  agentId: string
): Session {
  if (!value || value.agent !== agentId) throw new OpenCodeWorkspaceScopeError()
  const parsed = SessionSchema.safeParse({
    id: value.id,
    agentId,
    title: value.title,
    archived: value.time.archived !== undefined,
    createdAt: timestamp(value.time.created),
    updatedAt: timestamp(value.time.updated ?? value.time.created),
    status: "idle",
    // Only a metadata-bearing row proves the pin state; absence stays absent.
    ...(value.metadata
      ? { pinned: value.metadata[OPENCODE_PIN_METADATA_KEY] === true }
      : {}),
  })
  if (!parsed.success) throw new OpenCodeWorkspaceUnavailableError()
  return parsed.data
}

/** A listed native row as its owner's Session, or `undefined` when it is not one. */
function listedSession(
  value: NonNullable<ReturnType<typeof parseOpenCodeSession>["data"]>
) {
  try {
    return projectSession(value, value.agent!)
  } catch {
    return undefined
  }
}

export function createOpenCodeWorkspaceOperations(input: {
  client: OpenCodeWorkspaceClient
  /** Where a row left out of a list is told, by its id alone. */
  log?: Logger
}) {
  /**
   * Every Session an Agent owns, of every Agent, newest first, one native row
   * at a time. A row that is not one, or repeats one's id, is left out with a
   * warning and counted in `skipped`; only rows none of which can be read are
   * an outage. A Session no Agent owns is no one's, and a child Session is its
   * parent's work, not a top-level Session; neither is a bad row.
   */
  async function allSessions() {
    const sessions: Session[] = []
    const seenCursors = new Set<string>()
    const seenIds = new Set<string>()
    let rows = 0
    let skipped = 0
    let cursor: string | undefined
    do {
      const parsed = parseOpenCodeSessionCatalog(
        await input.client.sessions.list({
          limit: MAX_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        })
      )
      if (!parsed.success) throw new OpenCodeWorkspaceUnavailableError()
      for (const row of parsed.data.data) {
        if (isOpenCodeChildSession(row)) continue
        const native = parseOpenCodeSession(row)
        if (native.success && native.data.agent === undefined) continue
        const session = native.success ? listedSession(native.data) : undefined
        if (!session || seenIds.has(session.id)) {
          skipped += 1
          input.log?.warn(
            { sessionId: loggedId(row, "id") },
            "opencode.session.skipped"
          )
          continue
        }
        seenIds.add(session.id)
        sessions.push(session)
      }
      rows += parsed.data.data.length
      cursor = parsed.data.cursor.next
      if (cursor && seenCursors.has(cursor))
        throw new OpenCodeWorkspaceUnavailableError()
      if (cursor) seenCursors.add(cursor)
      if (rows > MAX_CATALOG_WINDOW)
        throw new OpenCodeWorkspaceUnavailableError()
    } while (cursor)
    if (skipped > 0 && sessions.length === 0)
      throw new OpenCodeWorkspaceUnavailableError()
    return { sessions: sessions.sort(newestSessionFirst), skipped }
  }

  async function owned(agentId: string) {
    return (await allSessions()).sessions.filter(
      (session) => session.agentId === agentId
    )
  }

  /** Every Session an Agent owns, of every Agent, newest first. */
  async function everyOwned() {
    return (await allSessions()).sessions
  }

  /** One authoritative read that both projects and proves exact ownership. */
  async function readSession(agentId: string, sessionId: string) {
    const row = await input.client.sessions.get(sessionId)
    // A child belongs to the Session that spawned it, so no Agent holds it
    // as one of its own, as no list shows it.
    if (isOpenCodeChildSession(row)) throw new OpenCodeWorkspaceScopeError()
    const parsed = parseOpenCodeSession(row)
    if (!parsed.success) throw new OpenCodeWorkspaceUnavailableError()
    return {
      native: parsed.data,
      session: projectSession(parsed.data, agentId),
    }
  }

  async function updateSession(
    agentId: string,
    sessionId: string,
    patch: SessionPatch
  ) {
    const { native } = await readSession(agentId, sessionId)
    if ("title" in patch)
      return input.client.sessions.update(sessionId, { title: patch.title })
    if ("archived" in patch)
      // An empty native `time` is the only unarchive the pinned SDK can
      // express: it types `time.archived` as a bare number and offers no
      // unarchive route. Unverified until a live OpenCode acceptance run.
      return input.client.sessions.update(sessionId, {
        time: patch.archived ? { archived: Date.now() } : {},
      })
    if ("pinned" in patch)
      // Merge, never replace: foreign native metadata keys must survive.
      return input.client.sessions.update(sessionId, {
        metadata: {
          ...native.metadata,
          [OPENCODE_PIN_METADATA_KEY]: patch.pinned,
        },
      })
    // `unread` has no native read state to write, so it stays unavailable.
    throw new OpenCodeWorkspaceUnavailableError()
  }

  type InviteResolution =
    | { providerSessionId: ids.ProviderSessionId; created: false }
    | undefined
  const invitedResolutions = new Map<string, Promise<InviteResolution>>()

  async function resolveInvite(
    agentId: string,
    ref: string,
    create?: { firstTurnInstruction?: string }
  ): Promise<InviteResolution> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(ref))
      throw new OpenCodeWorkspaceUnavailableError()
    const title = inviteSessionKey(ref)
    const { sessions, skipped } = await allSessions()
    // A skipped row may be the invited Session: none found is then unknown.
    if (skipped > 0) throw new OpenCodeWorkspaceUnavailableError()
    const matches = sessions.filter(
      (session) => session.agentId === agentId && session.title === title
    )
    if (matches.length > 1) throw new OpenCodeWorkspaceUnavailableError()
    if (matches.length === 1)
      return {
        providerSessionId: ids.providerSessionId(matches[0]!.id),
        created: false,
      }
    if (!create) return undefined
    // OpenCode v2 creates only an unmarked Session, and the reserved invitation
    // title would need a second, non-atomic rename that can leave an untitled
    // Session behind. Invited creation therefore stays unavailable.
    throw new OpenCodeWorkspaceUnavailableError()
  }

  return {
    capabilities: () => ({
      models: {
        status: "available" as const,
        scope: "session" as const,
        selection: "native-session" as const,
        choices: "provider-reported" as const,
      },
      context: {
        status: "unavailable" as const,
        reason: "native-context-accounting-unavailable",
      },
      // OpenCode owns the list: the native Todo route restores it and the
      // native Todo tool's own input publishes every change during a run.
      todos: {
        status: "available" as const,
        scope: "session" as const,
        mode: "read-only-projection" as const,
        source: "latest-completed-todo-tool-result" as const,
      },
      activity: {
        status: "unavailable" as const,
        reason: "native-activity-unavailable",
      },
      agentVisibility: {
        status: "unavailable" as const,
        reason: "native-agent-catalog-read-only",
      },
    }),

    async listAgents(): Promise<AgentCatalogResponse> {
      const parsed = parseOpenCodeAgentCatalog(
        await input.client.catalog.agents()
      )
      if (!parsed.success) throw new OpenCodeWorkspaceUnavailableError()
      // One row at a time: a malformed Agent costs that Agent alone.
      const agents: AgentCatalogEntry[] = []
      let skipped = 0
      for (const row of parsed.data.data) {
        const native = parseOpenCodeAgent(row)
        const entry = native.success
          ? AgentCatalogEntrySchema.safeParse(catalogEntry(native.data))
          : undefined
        if (!entry?.success) {
          skipped += 1
          input.log?.warn(
            { agentId: loggedId(row, "id") },
            "opencode.agent.skipped"
          )
          continue
        }
        agents.push(entry.data)
      }
      // A skip that leaves no Agent a person can pick is an outage.
      if (skipped > 0 && !agents.some(({ selectable }) => selectable))
        throw new OpenCodeWorkspaceUnavailableError()
      agents.sort((left, right) =>
        left.summary.id.localeCompare(right.summary.id)
      )
      return AgentCatalogResponseSchema.parse({
        revision: revision(agents.map((agent) => agent.revision)),
        agents,
      })
    },

    async listSessions(
      agentId: string,
      limit: number,
      offset: number
    ): Promise<SessionCatalogResponse> {
      if (!validPage(limit, offset))
        throw new OpenCodeWorkspaceUnavailableError()
      const sessions = await owned(agentId)
      return SessionCatalogResponseSchema.parse({
        sessions: sessions.slice(offset, offset + limit),
        total: sessions.length,
        limit,
        offset,
      })
    },

    async listAllSessions(
      limit: number,
      offset: number
    ): Promise<SessionCatalogResponse> {
      if (!validPage(limit, offset))
        throw new OpenCodeWorkspaceUnavailableError()
      const sessions = await everyOwned()
      return SessionCatalogResponseSchema.parse({
        sessions: sessions.slice(offset, offset + limit),
        total: sessions.length,
        limit,
        offset,
      })
    },

    /** OpenCode has no content search; titles are what it can match. */
    async searchSessions(
      agentId: string | undefined,
      query: string
    ): Promise<SessionCatalogResponse> {
      const needle = query.toLocaleLowerCase()
      const sessions = (
        agentId === undefined ? await everyOwned() : await owned(agentId)
      )
        .filter(
          ({ title }) => title?.toLocaleLowerCase().includes(needle) ?? false
        )
        .slice(0, SEARCH_LIMIT)
      return SessionCatalogResponseSchema.parse({
        sessions,
        total: sessions.length,
        limit: SEARCH_LIMIT,
        offset: 0,
      })
    },

    async getSession(agentId: string, sessionId: string) {
      return (await readSession(agentId, sessionId)).session
    },

    updateSession,

    async deleteSession(agentId: string, sessionId: string) {
      await readSession(agentId, sessionId)
      await input.client.sessions.delete(sessionId)
    },

    async createSession(agentId: string) {
      const created = parseOpenCodeSession(
        await input.client.sessions.create({ agent: agentId })
      )
      if (!created.success) throw new OpenCodeWorkspaceUnavailableError()
      const session = projectSession(created.data, agentId)
      return SessionCreateResponseSchema.parse({
        session: { id: session.id, agentId },
      })
    },

    resolveInvitedSession(
      agentId: string,
      ref: string,
      create?: { firstTurnInstruction?: string }
    ) {
      const key = `${agentId}\u0000${ref}`
      const existing = invitedResolutions.get(key)
      if (existing) return existing
      const pending = resolveInvite(agentId, ref, create)
      invitedResolutions.set(key, pending)
      const release = () => {
        if (invitedResolutions.get(key) === pending)
          invitedResolutions.delete(key)
      }
      pending.then(release, release)
      return pending
    },
  }
}
