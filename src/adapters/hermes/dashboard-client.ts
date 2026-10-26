import { randomUUID } from "node:crypto"

import { z } from "zod"

import { SPEECH_CALL_MS } from "../../core/limits"
import type { SessionPatch } from "../../core/runtime"
import { HermesHttpError } from "./http"

/**
 * The counters Hermes fences a Session write on
 * (`hermes_cli/web_routers/sessions.py:586`). A stored Session always has an
 * execution generation; an absent one answers `exists: false`.
 */
const MutationSnapshotSchema = z.object({
  exists: z.boolean(),
  runtime_revision: z.number().int().nonnegative(),
  runtime_generation: z.number().int().nonnegative().nullable(),
})

/**
 * Hermes holds the Session but refused the write as not found. Its REST
 * authority edits an unrouted row only under a source one of its own local
 * surfaces writes (`hermes_state_mutation_binding.py` `authorize_history`),
 * so a Session created under any other label, `aos-ui` among them, takes no
 * fenced write.
 */
export class HermesSessionWriteRefusedError extends Error {
  constructor(options?: ErrorOptions) {
    super("Hermes refused a write to a Session it holds", options)
    this.name = "HermesSessionWriteRefusedError"
  }
}

export type HermesDashboardHttp = (
  path: string,
  init?: {
    method?: string
    body?: unknown
    maxResponseBytes?: number
    timeoutMs?: number
  }
) => Promise<unknown>

export type HermesNativeSessionPage = {
  sessions: unknown[]
  total?: unknown
  [key: string]: unknown
}

export type HermesNativeSession = Record<string, unknown>

export type HermesNativeMessagePage = {
  session_id: unknown
  messages: unknown[]
  pagination?: unknown
  [key: string]: unknown
}

/** Thin server-side wrapper for the Hermes dashboard HTTP routes AOS uses. */
export class HermesDashboardClient {
  constructor(private readonly http: HermesDashboardHttp) {}

  listSessions(profile: string, limit: number, offset: number) {
    const query = new URLSearchParams({
      profile,
      limit: String(limit),
      offset: String(offset),
      order: "recent",
      archived: "include",
      exclude_sources: "cron,tool,kanban",
    })
    return this.http(
      `/api/sessions?${query}`
    ) as Promise<HermesNativeSessionPage>
  }

  /**
   * Hermes' search of one profile: id matches first, then message content,
   * one row per conversation. Answers `{ results }`, at most `limit` rows.
   * A delegated child's Session is no conversation of the list, so its
   * `subagent` source is left out too.
   */
  searchSessions(profile: string, query: string, limit: number) {
    const params = new URLSearchParams({
      q: query,
      profile,
      limit: String(limit),
      exclude_sources: "cron,tool,kanban,subagent",
    })
    return this.http(`/api/sessions/search?${params}`)
  }

  getSession(profile: string, storedId: string) {
    return this.http(
      `/api/sessions/${encodeURIComponent(storedId)}?profile=${encodeURIComponent(profile)}`
    ) as Promise<HermesNativeSession>
  }

  getSessionMessages(
    profile: string,
    storedId: string,
    limit: number,
    offset: number
  ) {
    const query = new URLSearchParams({
      profile,
      limit: String(limit),
      offset: String(offset),
      order: "latest",
      include_compacted: "true",
    })
    return this.http(
      `/api/sessions/${encodeURIComponent(storedId)}/messages?${query}`
    ) as Promise<HermesNativeMessagePage>
  }

  updateSession(profile: string, storedId: string, patch: SessionPatch) {
    return this.mutateSession(profile, storedId, "PATCH", {
      ...patch,
      profile,
    })
  }

  deleteSession(profile: string, storedId: string) {
    return this.mutateSession(profile, storedId, "DELETE")
  }

  readArtifactDataUrl(
    profile: string,
    storedId: string,
    path: string,
    maxResponseBytes: number
  ) {
    const query = new URLSearchParams({
      path,
      profile,
      session_id: storedId,
    })
    return this.http(`/api/fs/read-data-url?${query}`, { maxResponseBytes })
  }

  getAudioConfig(
    profile: string,
    kind: "stt" | "tts",
    maxResponseBytes: number
  ) {
    const query = new URLSearchParams({ profile })
    return this.http(`/api/tools/toolsets/${kind}/config?${query}`, {
      maxResponseBytes,
    })
  }

  transcribe(
    profile: string,
    request: { data_url: string; mime_type: string },
    maxResponseBytes: number
  ) {
    const query = new URLSearchParams({ profile })
    return this.http(`/api/audio/transcribe?${query}`, {
      method: "POST",
      body: request,
      maxResponseBytes,
    })
  }

  speak(profile: string, text: string, maxResponseBytes: number) {
    const query = new URLSearchParams({ profile })
    return this.http(`/api/audio/speak?${query}`, {
      method: "POST",
      body: { text },
      maxResponseBytes,
      timeoutMs: SPEECH_CALL_MS,
    })
  }

  /** The profile's configured MCP servers, credentials redacted by Hermes. */
  listMcpServers(profile: string) {
    const query = new URLSearchParams({ profile })
    return this.http(`/api/mcp/servers?${query}`)
  }

  /**
   * Hermes commits a Session write only against the revision and execution
   * generation it was prepared on, under the writer's own request id, and
   * refuses one without them as a stale client (409,
   * `hermes_cli/web_server_sessions.py:269`). The fence is read just before
   * the write, as Hermes' own client does, so a change in between still
   * refuses it as a conflict.
   */
  private async mutateSession(
    profile: string,
    storedId: string,
    method: "PATCH" | "DELETE",
    body?: Record<string, unknown>
  ) {
    const path = `/api/sessions/${encodeURIComponent(storedId)}`
    const scope = `profile=${encodeURIComponent(profile)}`
    const snapshot = MutationSnapshotSchema.parse(
      await this.http(`${path}/mutation-snapshot?${scope}`)
    )
    // Gone since the caller read it, as the write itself would answer.
    if (!snapshot.exists || snapshot.runtime_generation === null)
      throw new HermesHttpError(404)
    const fence = {
      request_id: randomUUID(),
      expected_revision: snapshot.runtime_revision,
      expected_generation: snapshot.runtime_generation,
    }
    try {
      if (method === "PATCH")
        return await this.http(`${path}?${scope}`, {
          method,
          body: { ...body, ...fence },
        })
      // A DELETE carries its fence in the query (`sessions.py:847`).
      const query = new URLSearchParams({
        profile,
        request_id: fence.request_id,
        expected_revision: String(fence.expected_revision),
        expected_generation: String(fence.expected_generation),
      })
      return await this.http(`${path}?${query}`, { method })
    } catch (error) {
      if (error instanceof HermesHttpError && error.status === 404)
        throw new HermesSessionWriteRefusedError({ cause: error })
      throw error
    }
  }
}
