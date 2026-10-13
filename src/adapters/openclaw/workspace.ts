import { createHash } from "node:crypto"
import type { Logger } from "../../../lifecycle"
import type {
  AgentCatalogEntry,
  AgentCatalogResponse,
  AgentUpdatePatch,
  AgentUpdateResponse,
  Session,
  SessionCatalogResponse,
} from "../../../protocol"
import {
  AgentAvatarSchema,
  AgentCatalogEntrySchema,
  AgentUpdateResponseSchema,
  newestSessionFirst,
  SESSION_CATALOG_MAX_WINDOW,
  SessionCreateResponseSchema,
  SessionSchema,
} from "../../../protocol"
import { loggedId } from "../../core/identifier"
import { openClawInviteSessionKey } from "../../core/invite-key"
import { sessionPlatform } from "../../core/session-platform"
import * as ids from "../../core/ids"
import {
  ServerAgentUpdateUnsupportedError,
  type SessionPatch,
} from "../../core/runtime"

import { OpenClawClientRequestError, openClawConnectionFailure } from "./client"
import {
  openClawAgentAvatarPatchParams,
  openClawAgentRows,
  openClawAgentsParams,
  openClawConfigGetParams,
  openClawCreateSessionParams,
  openClawForkSessionParams,
  openClawDeleteSessionParams,
  openClawPatchSessionParams,
  openClawSessionRows,
  openClawSessionSearchParams,
  openClawSessionsParams,
  parseOpenClawAgent,
  parseOpenClawConfiguredAgents,
  parseOpenClawCreatedSession,
  parseOpenClawSession,
  parseOpenClawSessions,
  isSpawnedSession,
  type OpenClawAgent,
  type OpenClawSession,
  type OpenClawSessionPatch,
} from "./native-schemas"

const INVITATION_REFERENCE = /^[A-Za-z0-9_-]{1,128}$/u
const MAX_SESSION_PAGE = 100
const MAX_SESSION_KEY_LENGTH = 4_096
/** How many Agents a read across every Agent reads at once. */
const AGENT_FANOUT = 8
const AGENT_SKIPPED = "openclaw.agent.skipped"

/** A field of a native row not yet checked, read only to pick or name it. */
function rawField(row: unknown, key: string) {
  return typeof row === "object" && row !== null
    ? (row as Record<string, unknown>)[key]
    : undefined
}

/** A failure of the link or of authentication: the runtime's, never one Agent's. */
function isRuntimeFailure(error: unknown) {
  return (
    openClawConnectionFailure(error) !== undefined ||
    (error instanceof OpenClawClientRequestError &&
      (error.kind === "unavailable" || error.kind === "cancelled"))
  )
}

export interface OpenClawWorkspaceClient {
  request<T>(method: string, params?: unknown): Promise<T>
}

export class OpenClawWorkspaceOwnershipError extends Error {
  constructor() {
    super("OpenClaw Session ownership could not be verified")
    this.name = "OpenClawWorkspaceOwnershipError"
  }
}

export class OpenClawWorkspaceUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("OpenClaw workspace data is temporarily unavailable", options)
    this.name = "OpenClawWorkspaceUnavailableError"
  }
}

/**
 * A fork OpenClaw refused, such as of a parent past the size a fork copies;
 * the same fork is refused again.
 */
export class OpenClawForkRefusedError extends Error {
  constructor(options?: ErrorOptions) {
    super("OpenClaw refused to fork this Session", options)
    this.name = "OpenClawForkRefusedError"
  }
}

export class OpenClawWorkspaceRevisionConflictError extends Error {
  constructor() {
    super("Agent revision conflict")
    this.name = "OpenClawWorkspaceRevisionConflictError"
  }
}

function revision(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function agentName(agent: OpenClawAgent) {
  return agent.identity?.name ?? agent.name ?? agent.id
}

/**
 * OpenClaw's closed Agent summary has no field for a role, so the operator
 * installs the gateway's creator under this reserved Agent id.
 */
export const OPENCLAW_CREATOR_AGENT_ID = "aos-agent-creator"

function isVisiblePrimaryAgent(
  agent: OpenClawAgent,
  hidden: ReadonlySet<string>
) {
  return (
    agent.kind !== "system" &&
    agent.createdVia !== "agent" &&
    agent.creatorAgentId == null &&
    !hidden.has(agent.id)
  )
}

function projectAgent(agent: OpenClawAgent, configured: ReadonlySet<string>) {
  const creator = agent.id === OPENCLAW_CREATOR_AGENT_ID
  const visibility = creator ? ("hidden" as const) : ("visible" as const)
  // A stored value that is not a token (a file path, a URL) reads as none.
  const avatar = AgentAvatarSchema.safeParse(agent.identity?.avatar)
  return {
    summary: {
      kind: "ready" as const,
      id: agent.id,
      name: agentName(agent),
      ...(avatar.success ? { avatar: avatar.data } : {}),
      ...(creator ? { visibility, role: "creator" as const } : {}),
    },
    visibility,
    selectable: !creator,
    editable: false,
    // Only an Agent with its own authored entry can take a merge-by-id patch;
    // the implicit default Agent has none.
    avatarEditable: !creator && configured.has(agent.id),
    // OpenClaw has no native place to keep a mute.
    muteEditable: false,
    revision: revision(agent),
  }
}

function verifyOwnership(agentId: string, row: OpenClawSession) {
  if (row.agentId !== agentId) throw new OpenClawWorkspaceOwnershipError()
}

function isBoundedSessionKey(value: string) {
  return (
    value.length > 0 &&
    value.length <= MAX_SESSION_KEY_LENGTH &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
}

/** When the row was last active; a row that carries no time has none. */
function updatedAt(row: OpenClawSession) {
  const timestamp = row.lastInteractionAt ?? row.updatedAt
  return timestamp === undefined
    ? {}
    : { updatedAt: new Date(timestamp).toISOString() }
}

/** `SessionRowSchema` names a Session only by an optional label. */
function title(row: OpenClawSession) {
  const name = row.label ?? row.displayName
  return name === undefined ? {} : { title: name }
}

function sessionStatus(row: OpenClawSession): Session["status"] {
  return row.hasActiveRun === true || (row.activeRunIds?.length ?? 0) > 0
    ? "running"
    : "idle"
}

function projectSession(agentId: string, row: OpenClawSession): Session {
  verifyOwnership(agentId, row)
  const platform = sessionPlatform(row.channel)
  return {
    id: row.key,
    agentId,
    ...title(row),
    archived: row.archived ?? false,
    ...(row.createdAt === undefined
      ? {}
      : { createdAt: new Date(row.createdAt).toISOString() }),
    ...updatedAt(row),
    status: sessionStatus(row),
    // Absent pin state stays absent: it never overwrites a known value.
    ...(typeof row.pinned === "boolean" ? { pinned: row.pinned } : {}),
    // channel carries the external source; unknown/absent stays absent.
    ...(platform !== undefined ? { platform } : {}),
  }
}

/**
 * Maps one normalized Session intent to its proven native equivalent. `unread`
 * and every rejected body stay unavailable rather than emulated.
 */
function nativeSessionPatch(patch: SessionPatch): OpenClawSessionPatch {
  if ("title" in patch) return { label: patch.title }
  if ("archived" in patch) return { archived: patch.archived }
  if ("pinned" in patch) return { pinned: patch.pinned }
  // OpenClaw has no native read state to write.
  throw new OpenClawWorkspaceUnavailableError()
}

export function invitedOpenClawSessionKey(agentId: string, ref: string) {
  if (
    typeof agentId !== "string" ||
    agentId.length === 0 ||
    agentId.length > 4_096 ||
    !INVITATION_REFERENCE.test(ref)
  )
    throw new OpenClawWorkspaceOwnershipError()
  return openClawInviteSessionKey(agentId, ref)
}

export type OpenClawWorkspace = Readonly<{
  listAgents(): Promise<AgentCatalogResponse>
  /** The Agent's `agents.list` `workspace`, when it is absolute. */
  agentFolder(agentId: string): Promise<string | undefined>
  updateAgent(
    agentId: string,
    patch: AgentUpdatePatch,
    observedRevision: string
  ): Promise<AgentUpdateResponse>
  listSessions(
    agentId: string,
    limit: number,
    offset: number
  ): Promise<SessionCatalogResponse>
  listAllSessions(
    limit: number,
    offset: number
  ): Promise<SessionCatalogResponse>
  getSession(agentId: string, sessionKey: string): Promise<Session>
  createSession(agentId: string): Promise<unknown>
  forkSession(agentId: string, sessionKey: string): Promise<unknown>
  updateSession(
    agentId: string,
    sessionKey: string,
    patch: SessionPatch
  ): Promise<void>
  deleteSession(agentId: string, sessionKey: string): Promise<void>
  resolveProviderSessionId(
    agentId: string,
    publicSessionId: string
  ): ids.ProviderSessionId | undefined
  resolveInvitedSession(
    agentId: string,
    ref: string
  ): Promise<
    { providerSessionId: ids.ProviderSessionId; created: false } | undefined
  >
}>

export function createOpenClawWorkspace(input: {
  client: OpenClawWorkspaceClient
  hiddenAgentIds?: readonly string[]
  /** Where a row or an Agent left out of a list is told, by its ids alone. */
  log?: Logger
}): OpenClawWorkspace {
  const hidden = new Set(input.hiddenAgentIds ?? [])
  const listAgentRows = async () =>
    openClawAgentRows(
      await input.client.request("agents.list", openClawAgentsParams())
    )
  /**
   * The visible Agents, one row at a time: a malformed row costs that Agent
   * alone, leaves a warning, and counts in `skipped`.
   */
  const listVisibleAgents = async () => {
    const agents: OpenClawAgent[] = []
    let skipped = 0
    for (const row of await listAgentRows()) {
      try {
        agents.push(parseOpenClawAgent(row))
      } catch {
        skipped += 1
        input.log?.warn({ agentId: loggedId(row, "id") }, AGENT_SKIPPED)
      }
    }
    return {
      agents: agents
        .filter((agent) => isVisiblePrimaryAgent(agent, hidden))
        .sort((left, right) => left.id.localeCompare(right.id)),
      skipped,
    }
  }
  /**
   * Each visible Agent's catalog entry; one the public schema refuses is left
   * out. A skip that leaves no Agent a person can pick is an outage.
   */
  const catalogEntries = (
    visible: Awaited<ReturnType<typeof listVisibleAgents>>,
    configured: ReadonlySet<string>
  ) => {
    const entries: AgentCatalogEntry[] = []
    let skipped = visible.skipped
    for (const agent of visible.agents) {
      const entry = AgentCatalogEntrySchema.safeParse(
        projectAgent(agent, configured)
      )
      if (entry.success) entries.push(entry.data)
      else {
        skipped += 1
        input.log?.warn({ agentId: loggedId(agent, "id") }, AGENT_SKIPPED)
      }
    }
    if (skipped > 0 && !entries.some(({ selectable }) => selectable))
      throw new OpenClawWorkspaceUnavailableError()
    return entries
  }
  // `config.get` carries credentials: it is reduced on arrival and nothing
  // else from it is kept, logged, returned, or put in an error.
  const readConfiguredAgents = async () =>
    parseOpenClawConfiguredAgents(
      await input.client.request("config.get", openClawConfigGetParams())
    )
  const listAgents = async () => {
    const [agents, configured] = await Promise.all([
      listVisibleAgents(),
      // An unreadable config only means no Agent can take an avatar write.
      readConfiguredAgents().then(
        ({ agentIds }) => agentIds,
        () => new Set<string>()
      ),
    ])
    const entries = catalogEntries(agents, configured)
    return { revision: revision(entries), agents: entries }
  }
  /**
   * The one visible Agent `agentId` names. Only its own row is read, so
   * another Agent's malformed row never fails it, and its own malformed row
   * is unreadable rather than gone.
   */
  const requireVisibleAgent = async (agentId: string) => {
    const matches = (await listAgentRows())
      .filter((row) => rawField(row, "id") === agentId)
      .map(parseOpenClawAgent)
      .filter((agent) => isVisiblePrimaryAgent(agent, hidden))
    if (matches.length !== 1) throw new OpenClawWorkspaceOwnershipError()
    return matches[0]!
  }
  /** One native row as a Session of `agentId`, or `undefined` with a warning. */
  const listedSession = (agentId: string, row: unknown) => {
    try {
      const session = SessionSchema.safeParse(
        projectSession(agentId, parseOpenClawSession(row))
      )
      if (session.success) return session.data
    } catch {
      // A row OpenClaw sent that is not one of this Agent's Sessions.
    }
    input.log?.warn(
      { agentId, sessionId: loggedId(row, "key") },
      "openclaw.session.skipped"
    )
    return undefined
  }
  /**
   * The newest `prefix` Sessions of one Agent, read from its first native row
   * so that offsets count the rows kept, as the gateway's cursor does. A row
   * that is not one of the Agent's Sessions costs that row alone; the read
   * goes on by OpenClaw's own row count, and only the whole read keeping
   * nothing of the rows OpenClaw sent is unreadable. Pages keep one size, so
   * a run of skipped rows costs a page rather than a call per row, and no row
   * past the catalog window is read: with rows skipped, a readable one
   * beyond it is left unlisted, and the list ends there.
   */
  const fetchPrefix = async (agentId: string, prefix: number) => {
    const sessions: Session[] = []
    const pageLimit = Math.min(MAX_SESSION_PAGE, prefix)
    let pageOffset = 0
    let read = 0
    let hasMore = false
    while (sessions.length < prefix) {
      if (pageOffset >= SESSION_CATALOG_MAX_WINDOW) {
        hasMore = false
        break
      }
      const rows = openClawSessionRows(
        await input.client.request(
          "sessions.list",
          openClawSessionsParams(agentId, pageLimit, pageOffset)
        ),
        pageLimit
      )
      for (const row of rows) {
        // A spawned child belongs to its parent's Session, never the list.
        if (
          isSpawnedSession({
            spawnedBy: rawField(row, "spawnedBy"),
            spawnDepth: rawField(row, "spawnDepth"),
          })
        )
          continue
        read += 1
        const session = listedSession(agentId, row)
        if (session) sessions.push(session)
      }
      hasMore = rows.length === pageLimit
      if (!hasMore) break
      pageOffset += rows.length
    }
    if (read > 0 && sessions.length === 0)
      throw new OpenClawWorkspaceUnavailableError()
    return {
      sessions: sessions.slice(0, prefix),
      hasMore: hasMore || sessions.length > prefix,
    }
  }
  const requirePage = (limit: number, offset: number) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SESSION_PAGE)
      throw new OpenClawWorkspaceUnavailableError()
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset + limit > SESSION_CATALOG_MAX_WINDOW
    )
      throw new OpenClawWorkspaceUnavailableError()
  }
  const listSessions = async (
    agentId: string,
    limit: number,
    offset: number
  ) => {
    requirePage(limit, offset)
    await requireVisibleAgent(agentId)
    const { sessions, hasMore } = await fetchPrefix(agentId, offset + limit)
    return {
      sessions: sessions.slice(offset),
      total: sessions.length + (hasMore ? 1 : 0),
      limit,
      offset,
    }
  }
  /** The one native row of `agentId`'s Session `sessionKey`. */
  const sessionRow = async (agentId: string, sessionKey: string) => {
    await requireVisibleAgent(agentId)
    const page = parseOpenClawSessions(
      await input.client.request(
        "sessions.list",
        openClawSessionSearchParams(agentId, sessionKey)
      ),
      MAX_SESSION_PAGE
    )
    const matches = page.filter((row) => row.key === sessionKey)
    // A spawned child is no top-level Session, whoever names its key.
    if (matches.length !== 1 || isSpawnedSession(matches[0]!))
      throw new OpenClawWorkspaceOwnershipError()
    verifyOwnership(agentId, matches[0]!)
    return matches[0]!
  }
  const getSession = async (agentId: string, sessionKey: string) =>
    projectSession(agentId, await sessionRow(agentId, sessionKey))

  return {
    listAgents,
    async agentFolder(agentId) {
      const { workspace } = await requireVisibleAgent(agentId)
      return workspace?.startsWith("/") ? workspace : undefined
    },
    async updateAgent(agentId, patch, observedRevision) {
      // A patch that touches visibility or the mute is unsupported as a
      // whole, never half-written beside its avatar, and the avatar is
      // re-checked so no caller reaches the native write unchecked.
      const avatar = AgentAvatarSchema.nullable().safeParse(patch.avatar)
      if (
        patch.visibility !== undefined ||
        patch.muted !== undefined ||
        !avatar.success
      )
        throw new ServerAgentUpdateUnsupportedError()
      const agent = await requireVisibleAgent(agentId)
      if (agent.id === OPENCLAW_CREATOR_AGENT_ID)
        throw new ServerAgentUpdateUnsupportedError()
      if (revision(agent) !== observedRevision)
        throw new OpenClawWorkspaceRevisionConflictError()
      const configured = await readConfiguredAgents()
      if (!configured.agentIds.has(agent.id))
        throw new ServerAgentUpdateUnsupportedError()
      if (configured.hash === undefined)
        throw new OpenClawWorkspaceUnavailableError()
      await input.client.request(
        "config.patch",
        openClawAgentAvatarPatchParams(agent.id, avatar.data, configured.hash)
      )
      const confirmed = await listAgents()
      const updated = confirmed.agents.find(
        (entry) => entry.summary.id === agent.id
      )
      if (!updated || (updated.summary.avatar ?? null) !== avatar.data)
        throw new OpenClawWorkspaceUnavailableError()
      return AgentUpdateResponseSchema.parse({
        revision: confirmed.revision,
        agent: updated,
      })
    },
    listSessions,
    /**
     * Every Agent's Sessions, a few Agents at a time. One Agent whose list
     * cannot be read costs the list that Agent's rows alone and leaves a
     * warning; only every Agent failing is an outage, and a failure of the
     * link or of authentication is never one Agent's.
     */
    async listAllSessions(limit, offset) {
      requirePage(limit, offset)
      const agentIds = catalogEntries(await listVisibleAgents(), new Set()).map(
        ({ summary }) => summary.id
      )
      const prefix = offset + limit
      const pages: Array<{ sessions: Session[]; hasMore: boolean }> = []
      let unavailable: unknown
      for (let start = 0; start < agentIds.length; start += AGENT_FANOUT) {
        const batch = agentIds.slice(start, start + AGENT_FANOUT)
        const settled = await Promise.allSettled(
          batch.map((agentId) => fetchPrefix(agentId, prefix))
        )
        settled.forEach((outcome, index) => {
          if (outcome.status === "fulfilled") {
            pages.push(outcome.value)
            return
          }
          if (isRuntimeFailure(outcome.reason)) throw outcome.reason
          unavailable = outcome.reason
          input.log?.warn(
            { err: outcome.reason, agentId: batch[index] },
            "openclaw.agent.unavailable"
          )
        })
      }
      if (agentIds.length > 0 && pages.length === 0)
        throw new OpenClawWorkspaceUnavailableError({ cause: unavailable })
      const sessions = pages
        .flatMap((page) => page.sessions)
        .sort(newestSessionFirst)
      return {
        sessions: sessions.slice(offset, offset + limit),
        total: sessions.length + (pages.some((page) => page.hasMore) ? 1 : 0),
        limit,
        offset,
      }
    },
    getSession,
    async createSession(agentId) {
      await requireVisibleAgent(agentId)
      const created = parseOpenClawCreatedSession(
        await input.client.request(
          "sessions.create",
          openClawCreateSessionParams(agentId)
        )
      )
      await getSession(agentId, created.key)
      return SessionCreateResponseSchema.parse({
        session: { id: created.key, agentId },
      })
    },
    /**
     * A new Session holding `sessionKey`'s conversation so far, answered as a
     * create is; the parent is left as it is. A fork names its parent in
     * `parentSessionKey`, which no child filter reads, so it stays listed.
     */
    async forkSession(agentId, sessionKey) {
      const parent = await sessionRow(agentId, sessionKey)
      const params = openClawForkSessionParams(
        agentId,
        sessionKey,
        {
          running: sessionStatus(parent) === "running",
          title: title(parent).title ?? "Session",
          toolOverrides: parent.toolOverrides,
        },
        crypto.randomUUID()
      )
      let answer: unknown
      try {
        answer = await input.client.request("sessions.create", params)
      } catch (error) {
        if (
          error instanceof OpenClawClientRequestError &&
          error.kind === "rejected"
        )
          throw new OpenClawForkRefusedError({ cause: error })
        throw error
      }
      const created = parseOpenClawCreatedSession(answer)
      await getSession(agentId, created.key)
      return SessionCreateResponseSchema.parse({
        session: { id: created.key, agentId },
      })
    },
    async updateSession(agentId, sessionKey, patch) {
      await getSession(agentId, sessionKey)
      await input.client.request(
        "sessions.patch",
        openClawPatchSessionParams(
          agentId,
          sessionKey,
          nativeSessionPatch(patch)
        )
      )
    },
    async deleteSession(agentId, sessionKey) {
      await getSession(agentId, sessionKey)
      await input.client.request(
        "sessions.delete",
        openClawDeleteSessionParams(agentId, sessionKey)
      )
    },
    resolveProviderSessionId(_agentId, publicSessionId) {
      return isBoundedSessionKey(publicSessionId)
        ? ids.providerSessionId(publicSessionId)
        : undefined
    },
    async resolveInvitedSession(agentId, ref) {
      const sessionKey = invitedOpenClawSessionKey(agentId, ref)
      await requireVisibleAgent(agentId)
      const page = parseOpenClawSessions(
        await input.client.request(
          "sessions.list",
          openClawSessionSearchParams(agentId, sessionKey)
        ),
        MAX_SESSION_PAGE
      )
      const matches = page.filter((row) => row.key === sessionKey)
      if (!matches.length) return undefined
      if (matches.length !== 1) throw new OpenClawWorkspaceOwnershipError()
      verifyOwnership(agentId, matches[0]!)
      return {
        providerSessionId: ids.providerSessionId(sessionKey),
        created: false,
      }
    },
  }
}
