/**
 * The child Sessions this gateway saw each Session's turns spawn, so a reload
 * announces them again. Hermes stores each child as a Session of its own, with
 * `parent_session_id` naming its parent, but nothing in the parent's rows
 * names the child (`delegate_task`'s result carries none), and it offers no
 * way to list a Session's children. A child is therefore known only from the
 * live `subagent.*` frames that announced it: a restarted gateway, or one
 * that never watched the turn, forgets it. The newest Sessions are kept.
 */
import type { SessionChildActivityMessage } from "../../../protocol"

/** What a reload replays a child as: its announcement in its final state. */
export type HermesChildReport = SessionChildActivityMessage["content"]

type Scope = { agentId: string; providerSessionId: string }

type ChildEntry = {
  report: HermesChildReport
  /** The child that spawned this one; absent for a child of the turn's own. */
  parent?: string
}

const MAX_SESSIONS = 256
const MAX_CHILDREN_PER_SESSION = 256

const keyOf = (scope: Scope) =>
  JSON.stringify([scope.agentId, scope.providerSessionId])

/** The history row a child is replayed from. */
export function childActivity(
  report: HermesChildReport
): SessionChildActivityMessage {
  return {
    id: `hermes-child:${report.childSessionId}`,
    role: "activity",
    activityType: "CHILD_SESSION",
    content: report,
  }
}

export class HermesChildSessions {
  readonly #sessions = new Map<string, Map<string, ChildEntry>>()

  /**
   * Folds a report of one child of a Session's turns into what is known of
   * it; a later report restates only what changed.
   */
  record(scope: Scope, report: HermesChildReport, parent?: string) {
    const key = keyOf(scope)
    const children = this.#sessions.get(key) ?? new Map<string, ChildEntry>()
    // The Session touched last is the newest.
    this.#sessions.delete(key)
    this.#sessions.set(key, children)
    if (this.#sessions.size > MAX_SESSIONS)
      this.#sessions.delete(this.#sessions.keys().next().value!)
    const known = children.get(report.childSessionId)
    children.set(report.childSessionId, {
      report: { ...known?.report, ...report },
      ...((known?.parent ?? parent) === undefined
        ? {}
        : { parent: known?.parent ?? parent }),
    })
    if (children.size > MAX_CHILDREN_PER_SESSION)
      children.delete(children.keys().next().value!)
  }

  /**
   * The children `parent` spawned in a Session's turns, in the order they were
   * announced: the turns' own children when `parent` is absent.
   */
  childrenOf(scope: Scope, parent?: string): HermesChildReport[] {
    const children = this.#sessions.get(keyOf(scope))
    return [...(children?.values() ?? [])].flatMap((entry) =>
      entry.parent === parent ? [entry.report] : []
    )
  }

  /** Whether a Session's turns spawned `childSessionId`, at any depth. */
  knows(scope: Scope, childSessionId: string) {
    return this.#sessions.get(keyOf(scope))?.has(childSessionId) === true
  }
}
