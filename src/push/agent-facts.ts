import type { Logger } from "../../lifecycle"
import type { AgentCatalogEntry } from "../../protocol"
import { PUSH_TEXT_LIMITS } from "../../protocol/push"
import type { Catalog } from "../core/catalog"
import { previewText } from "../core/request-text"
import { defaultSchedule } from "./coalescer"

/** How long one catalog read answers for every Agent a push asks about. */
const CATALOG_TTL_MS = 60_000
/** How long a push waits for a new read before the last one answers. */
const LOOKUP_TIMEOUT_MS = 1_000

/** What a push needs to know about the Agent it is for. */
export type AgentFacts = {
  /** The name a lock screen may show, when the Agent has one to show. */
  name?: string
  /** The Agent sends no push: it is muted, or hidden and not the creator. */
  quiet: boolean
}

/**
 * An Agent the catalog does not hold, or a catalog never read: its push goes,
 * unnamed. A creator's Session, or one an Agent being created holds, does too.
 */
function factsOf(entry: AgentCatalogEntry | undefined): AgentFacts {
  if (!entry) return { quiet: false }
  const { visibility, selectable, summary } = entry
  const creator = summary.role === "creator"
  const quiet = summary.muted === true || (visibility === "hidden" && !creator)
  const name =
    !quiet && visibility === "visible" && selectable && !creator
      ? previewText(summary.name, PUSH_TEXT_LIMITS.agentName)
      : undefined
  return name ? { name, quiet } : { quiet }
}

export type AgentFactsOptions = {
  catalog: Pick<Catalog, "agents" | "agentUpdates">
  logger?: Logger
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => () => void
}

/**
 * What every push asks of its Agent. One catalog read answers for a minute; a
 * push waits at most a second for a new one, and a slow or failed read leaves
 * the last read that succeeded to answer, however old. An Agent write lands in
 * it at once, so a mute or an unmute holds from the next push even while reads
 * fail. The line a failure writes names neither the Agent nor the cause, which
 * may quote the catalog.
 */
export function createAgentFacts({
  catalog,
  logger,
  now = Date.now,
  schedule = defaultSchedule,
}: AgentFactsOptions) {
  /** The last read that succeeded, with every write since patched in. */
  let known: { at: number; agents: Map<string, AgentCatalogEntry> } | undefined
  let reading: Promise<"read" | "error"> | undefined
  /** Writes in order, so a read that began before one cannot undo it. */
  let writes = 0
  const written = new Map<string, { entry: AgentCatalogEntry; write: number }>()

  catalog.agentUpdates.subscribe((entry) => {
    writes += 1
    written.set(entry.summary.id, { entry, write: writes })
    // With nothing read yet, the write alone answers until a read succeeds.
    known ??= { at: -Infinity, agents: new Map() }
    known.agents.set(entry.summary.id, entry)
  })

  const read = () => {
    if (!reading) {
      const since = writes
      reading = Promise.resolve()
        .then(() => catalog.agents())
        .then(
          ({ agents }) => {
            const fresh = new Map(
              agents.map((entry) => [entry.summary.id, entry])
            )
            for (const [id, { entry, write }] of written)
              if (write > since) fresh.set(id, entry)
              else written.delete(id)
            known = { at: now(), agents: fresh }
            return "read" as const
          },
          () => "error" as const
        )
        .finally(() => {
          reading = undefined
        })
    }
    return reading
  }

  return async (agentId: string): Promise<AgentFacts> => {
    if (!known || now() - known.at >= CATALOG_TTL_MS) {
      let cancel = () => {}
      const timeout = new Promise<"timeout">((resolve) => {
        cancel = schedule(() => resolve("timeout"), LOOKUP_TIMEOUT_MS)
      })
      const outcome = await Promise.race([read(), timeout])
      cancel()
      if (outcome !== "read")
        logger?.warn({ reason: outcome }, "push.agent_facts.failed")
    }
    return factsOf(known?.agents.get(agentId))
  }
}
