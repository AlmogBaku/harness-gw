import type { Logger } from "../../lifecycle"
import type { AgentCatalogEntry, AgentCatalogResponse } from "../../protocol"
import { PUSH_TEXT_LIMITS } from "../../protocol/push"
import { previewText } from "../core/request-text"
import { defaultSchedule } from "./coalescer"

/** How long one catalog read answers for every name a push asks about. */
const CATALOG_TTL_MS = 60_000
/** How long a push waits for the catalog before it goes without a name. */
const LOOKUP_TIMEOUT_MS = 1_000

export type AgentNamesOptions = {
  catalog: { agents(): Promise<AgentCatalogResponse> }
  logger?: Logger
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => () => void
}

/** Only an Agent the operator's roster shows has a name a lock screen may show. */
const shown = ({ visibility, selectable, summary }: AgentCatalogEntry) =>
  visibility === "visible" && selectable && summary.role !== "creator"

/**
 * The name a push may carry for an Agent, or `undefined`. One catalog read
 * answers for a minute; a push waits at most a second for it, and a slow or
 * failed read sends the push without a name. The line a failure writes names
 * neither the Agent nor the cause, which may quote the catalog.
 */
export function createAgentNames({
  catalog,
  logger,
  now = Date.now,
  schedule = defaultSchedule,
}: AgentNamesOptions) {
  let cached: { at: number; read: Promise<AgentCatalogResponse> } | undefined

  const read = () => {
    if (!cached || now() - cached.at >= CATALOG_TTL_MS) {
      const read = catalog.agents()
      cached = { at: now(), read }
      // A failed read is not kept: the next push asks again.
      read.catch(() => {
        if (cached?.read === read) cached = undefined
      })
    }
    return cached.read
  }

  return async (agentId: string): Promise<string | undefined> => {
    let cancel = () => {}
    const timeout = new Promise<"timeout">((resolve) => {
      cancel = schedule(() => resolve("timeout"), LOOKUP_TIMEOUT_MS)
    })
    try {
      const response = await Promise.race([read(), timeout])
      if (response === "timeout") {
        logger?.warn({ reason: "timeout" }, "push.agent_name.failed")
        return undefined
      }
      const entry = response.agents.find(
        ({ summary }) => summary.id === agentId
      )
      return entry && shown(entry)
        ? previewText(entry.summary.name, PUSH_TEXT_LIMITS.agentName)
        : undefined
    } catch {
      logger?.warn({ reason: "error" }, "push.agent_name.failed")
      return undefined
    } finally {
      cancel()
    }
  }
}
