import type { Logger } from "../../lifecycle"
import type { Catalog } from "../core/catalog"
import type { ServerRuntimeTranslation } from "../core/runtime"
import type { ReadState } from "./types"

/** Collapses a burst of exposure and activity into one watermark write. */
export const FOCUS_DEBOUNCE_MS = 400
/** Least time between two watermark writes for the same Session. */
export const REACK_FLOOR_MS = 5_000

type TimerHandle = ReturnType<typeof setTimeout>

type Target = { agentId: string; sessionId: string }

export type ReadStateOptions = {
  catalog: Pick<Catalog, "info" | "rows" | "markRead">
  /** The execution events after which the runtime marks a Session unread. */
  relighting?: ServerRuntimeTranslation["relighting"]
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => TimerHandle
  cancel?: (handle: TimerHandle) => void
  /** Projects the settled row to this connection. */
  onUnreadChanged: (agentId: string, sessionId: string, unread: boolean) => void
  logger?: Logger
}

function sameTarget(left: Target, right: Target) {
  return left.agentId === right.agentId && left.sessionId === right.sessionId
}

export function createReadState({
  catalog,
  relighting,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  onUnreadChanged,
  logger,
}: ReadStateOptions): ReadState {
  const { rows } = catalog
  const writtenAt = new Map<string, number>()
  let focused: Target | undefined
  let releaseFocus: (() => void) | undefined
  /** The focused Session is one this connection marked unread. */
  let kept = false
  let pending:
    | {
        handle: TimerHandle
        target: Target
        forced: boolean
      }
    | undefined
  let tracked: Promise<boolean> | undefined
  let closed = false

  const keyOf = ({ agentId, sessionId }: Target) =>
    `${agentId}\u0000${sessionId}`

  /**
   * Whether the runtime keeps a read watermark, which only some do. Only an
   * answer is kept: a failed read is asked again on the next write.
   */
  const tracks = () => {
    tracked ??= catalog.info().then(
      ({ capabilities }) =>
        capabilities.sessionReadState?.status === "available",
      () => {
        tracked = undefined
        return false
      }
    )
    return tracked
  }

  const clearPending = () => {
    if (!pending) return
    cancel(pending.handle)
    pending = undefined
  }

  const write = async (target: Target, forced: boolean) => {
    if (closed) return
    const key = keyOf(target)
    const last = writtenAt.get(key)
    if (!forced && last !== undefined && now() - last < REACK_FLOOR_MS) {
      // The floor only spaces the writes out: a Session still in focus is
      // acknowledged once it passes, or its re-lit row would stand until the
      // next exposure.
      if (focused && sameTarget(focused, target))
        arm(target, false, last + REACK_FLOOR_MS - now())
      return
    }
    if (!(await tracks()) || closed) return
    writtenAt.set(key, now())
    const written = catalog.markRead(target.agentId, target.sessionId)
    onUnreadChanged(target.agentId, target.sessionId, false)
    await written
  }

  /**
   * Restarts the debounce. A forced write survives a re-arm so an exposure
   * never loses its acknowledgement to a floored re-ack.
   */
  function arm(target: Target, force: boolean, delayMs = FOCUS_DEBOUNCE_MS) {
    if (closed) return
    const forced =
      force ||
      (pending !== undefined &&
        sameTarget(pending.target, target) &&
        pending.forced)
    clearPending()
    const handle = schedule(() => {
      pending = undefined
      write(target, forced).catch((err: unknown) =>
        logger?.warn({ err }, "read.state.write_failed")
      )
    }, delayMs)
    pending = { handle, target, forced }
  }

  const release = () => {
    releaseFocus?.()
    releaseFocus = undefined
    clearPending()
  }

  const unfocus = () => {
    focused = undefined
    kept = false
    release()
  }

  const keeps = (target: Target) =>
    kept && focused !== undefined && sameTarget(focused, target)

  /** Starts an exposure of the Session: held read, and acknowledged. */
  function expose(target: Target) {
    unfocus()
    focused = target
    /*
     * A provider re-lights a Session for activity the operator is already
     * reading, and only a list read reports it. An operator who wants it
     * unread marks it so, which ends this hold: an `unread` on a held row is
     * always the provider's, so the row stays read and the provider gets the
     * acknowledgement instead of the browser a flash.
     */
    releaseFocus = rows.holdRead(target.agentId, target.sessionId, () =>
      arm(target, false)
    )
    // A watermark that moves only on a write needs one acknowledgement per
    // exposure, even for a row that already reads read.
    if (relighting || rows.get(target.agentId, target.sessionId)?.unread)
      arm(target, true)
  }

  return {
    focus(agentId, sessionId) {
      const target = { agentId, sessionId }
      // A presence change re-reports the Session this connection marked
      // unread; only looking away and back reads it again.
      if (!keeps(target)) expose(target)
    },

    keepUnread(agentId, sessionId) {
      if (!focused || !sameTarget(focused, { agentId, sessionId })) return
      release()
      kept = true
    },

    prompted(agentId, sessionId) {
      const target = { agentId, sessionId }
      if (keeps(target)) expose(target)
    },

    blur: unfocus,

    onExecution(event) {
      if (!focused || kept || !sameTarget(focused, event)) return
      if (!relighting?.includes(event.kind)) return
      arm(focused, false)
    },

    close() {
      closed = true
      unfocus()
    },
  }
}
