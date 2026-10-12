import type { Logger } from "../../lifecycle"
import {
  categoryOf,
  COALESCE_WINDOW_MS,
  PRESENCE_CLOSED_GRACE_MS,
  PRESENCE_GRACE_MS,
  PUSH_TEXT_LIMITS,
  PushMessageSchema,
  type PushCategory,
  type PushMessage,
} from "../../protocol/push"
import { previewText, requestPreview } from "../core/request-text"
import type { AgentFacts } from "./agent-facts"
import type { RuntimeInstance } from "../core/runtime"
import type { SessionRows } from "../core/session-rows"
import {
  createPushCoalescer,
  defaultSchedule,
  sessionKey,
  type CoalescedSession,
  type PresenceVerdict,
  type SuppressionReason,
} from "./coalescer"
import type { PresenceRegistry } from "./presence"
import type { PushRegistrations, StoredRegistration } from "./registrations"
import type { PushSender, PushUrgency } from "./sender"

/** Input and failures interrupt; a finished turn can wait for the next look. */
const URGENCY: Readonly<Record<PushCategory, PushUrgency>> = {
  input: "high",
  failure: "high",
  completion: "normal",
}

/** A device registered this recently is told what a Session is about. */
const CONTENT_FRESH_MS = 30 * 86_400_000

/**
 * How long a Session's last push guards it against an older one: no window
 * stays open longer than the longest window and one grace.
 */
const LAST_SENT_TTL_MS =
  Math.max(...Object.values(COALESCE_WINDOW_MS)) + PRESENCE_GRACE_MS

/** What a fresh device is told beyond the ids, each field only when known. */
type PushContent = Pick<
  PushMessage,
  "agentName" | "sessionTitle" | "requestText" | "requestMore"
>

export type PushDispatcherOptions = {
  runtimeInstance: RuntimeInstance
  /** The same rows the ACP listener maintains, so read state gates delivery. */
  sessionRows: SessionRows
  registrations: PushRegistrations
  presence: PresenceRegistry
  sender: PushSender
  /** Which principal one Agent's events notify. */
  principalOf(agentId: string): string
  /** What a push needs to know of its Agent; never rejects. */
  agentFacts?: (agentId: string) => Promise<AgentFacts>
  logger?: Logger
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => () => void
}

export interface PushDispatcher {
  close(): void
}

/**
 * Turns the coordinator's execution events into device pushes: one window per
 * principal and category, gated by what the workspace already shows, then one
 * push per Session to every device that asked for that category. A quiet
 * Agent, muted or hidden and not the creator, sends none. A device registered
 * in the last 30 days is also told the Agent's name, the Session's title, and
 * what is asked; the lines this writes name none of them, and no Agent,
 * device, or Session either.
 */
export function createPushDispatcher({
  runtimeInstance,
  sessionRows,
  registrations,
  presence,
  sender,
  principalOf,
  agentFacts = async () => ({ quiet: false }),
  logger,
  now = Date.now,
  schedule = defaultSchedule,
}: PushDispatcherOptions): PushDispatcher {
  /** The newest event each Session was last pushed about. */
  const lastSent = new Map<string, number>()

  /**
   * One line for Sessions a window held back: a count, the reason, and for a
   * read decision the two moments it turned on. The gate reports a window it
   * emptied; delivery reports every Session it skips. Timestamps identify
   * nothing, and they are the only way to tell a read that really came after
   * the event from a stamp that merely looks newer than one.
   */
  const suppressed = (
    category: PushCategory,
    reason: SuppressionReason | "quiet" | "stale",
    sessions: number,
    decision?: { readAtMs: number; occurredAtMs: number }
  ) => {
    logger?.info({ category, reason, sessions, ...decision }, "push.suppressed")
  }

  /**
   * Whether the operator has already seen *this event*. A Session read after the
   * event happened owes nothing, and neither does one on screen right now. Read
   * state is compared by time, not as a boolean: the cache learns "read" while
   * the operator is looking, and only a browser that is still connected can ever
   * report it unread again — so a boolean would silence every event that arrives
   * once the workspace is closed, which is exactly when a push is owed.
   */
  const filter = (
    principalId: string,
    category: PushCategory,
    sessions: CoalescedSession[]
  ) => {
    /** The read decision worth reporting: the one that held back the oldest event. */
    let read: { readAtMs: number; occurredAtMs: number } | undefined
    let exposed = false
    const kept = sessions.filter(({ agentId, sessionId, occurredAtMs }) => {
      const readAtMs = sessionRows.get(agentId, sessionId)?.readAt
      if (readAtMs !== undefined && readAtMs >= occurredAtMs) {
        if (!read || occurredAtMs < read.occurredAtMs)
          read = { readAtMs, occurredAtMs }
        return false
      }
      if (presence.exposed(principalId, sessionId)) {
        exposed = true
        return false
      }
      return true
    })
    if (kept.length === 0 && sessions.length > 0) {
      // A Session on screen is the stronger reason to stay quiet, so it is the
      // one reported when a window was emptied by both.
      if (exposed) suppressed(category, "exposed", sessions.length)
      else suppressed(category, "read", sessions.length, read)
    }
    return kept
  }

  /**
   * Presence, or the grace an operator who has just left still holds. An
   * operator who is away — backgrounded, hidden or idle — keeps the full window;
   * one whose last connection closed gets only long enough for a reload to
   * reconnect and say so.
   */
  const verdict = (principalId: string): PresenceVerdict => {
    if (presence.present(principalId)) return { state: "present" }
    const lastPresentAt = presence.lastPresentAt(principalId)
    if (lastPresentAt === undefined) return { state: "absent" }
    const untilMs =
      lastPresentAt +
      (presence.connected(principalId)
        ? PRESENCE_GRACE_MS
        : PRESENCE_CLOSED_GRACE_MS)
    return untilMs > now() ? { state: "grace", untilMs } : { state: "absent" }
  }

  /**
   * The Sessions with news newer than their last push, each recorded as sent:
   * a later-closing window of another category must not tell a device about
   * an event older than one it was already told about.
   */
  const unsent = (sessions: CoalescedSession[]) => {
    for (const [key, newestAtMs] of lastSent)
      if (newestAtMs < now() - LAST_SENT_TTL_MS) lastSent.delete(key)
    return sessions.filter((session) => {
      const sentAtMs = lastSent.get(sessionKey(session))
      if (sentAtMs !== undefined && session.newestAtMs <= sentAtMs) return false
      lastSent.set(sessionKey(session), session.newestAtMs)
      return true
    })
  }

  const contentOf = (
    { agentId, sessionId, request }: CoalescedSession,
    name: string | undefined
  ): PushContent => {
    const title = previewText(
      sessionRows.get(agentId, sessionId)?.title ?? "",
      PUSH_TEXT_LIMITS.sessionTitle
    )
    const preview = request && requestPreview(request)
    return {
      ...(name ? { agentName: name } : {}),
      ...(title ? { sessionTitle: title } : {}),
      ...(preview ? { requestText: preview.text } : {}),
      ...(preview?.more ? { requestMore: preview.more } : {}),
    }
  }

  const fresh = (device: StoredRegistration) =>
    now() - Date.parse(device.createdAt) <= CONTENT_FRESH_MS

  const deliver = async (
    principalId: string,
    category: PushCategory,
    candidates: CoalescedSession[]
  ) => {
    await registrations
      .prune()
      .catch((err: unknown) =>
        logger?.warn({ err }, "push.device.prune_failed")
      )
    const devices = registrations
      .list(principalId)
      .filter((device) => device.categories[category])
    if (devices.length === 0) return
    const facts = new Map(
      await Promise.all(
        [...new Set(candidates.map(({ agentId }) => agentId))].map(
          async (agentId) => [agentId, await agentFacts(agentId)] as const
        )
      )
    )
    const heard = candidates.filter(({ agentId }) => !facts.get(agentId)?.quiet)
    if (heard.length < candidates.length)
      suppressed(category, "quiet", candidates.length - heard.length)
    const sessions = unsent(heard)
    if (sessions.length < heard.length)
      suppressed(category, "stale", heard.length - sessions.length)
    if (sessions.length === 0) return
    const told = devices.some(fresh)
    const messages = sessions.map((session) => ({
      ids: {
        v: 2 as const,
        category,
        agentId: session.agentId,
        sessionId: session.sessionId,
        occurredAt: new Date(session.newestAtMs).toISOString(),
      },
      content: told ? contentOf(session, facts.get(session.agentId)?.name) : {},
    }))
    const settled = await Promise.allSettled(
      messages.flatMap(({ ids, content }) =>
        devices.map(async (device) => ({
          device,
          outcome: await sender.send(
            device,
            PushMessageSchema.parse({
              ...ids,
              ...(fresh(device) ? content : {}),
              locale: device.locale,
            }),
            URGENCY[category]
          ),
        }))
      )
    )

    const statuses: Record<string, number> = {}
    const departed = new Set<string>()
    let sent = 0
    let gone = 0
    let failed = 0
    for (const entry of settled) {
      if (entry.status === "rejected") {
        failed += 1
        continue
      }
      const { device, outcome } = entry.value
      if (outcome.status !== undefined) {
        const key = String(outcome.status)
        statuses[key] = (statuses[key] ?? 0) + 1
      }
      if (outcome.result === "sent") sent += 1
      else if (outcome.result === "gone") {
        gone += 1
        departed.add(device.subscription.endpoint)
      } else failed += 1
    }
    // A push service that reports a device gone has unsubscribed it for good.
    for (const endpoint of departed)
      await registrations
        .remove(principalId, endpoint)
        .catch((err: unknown) =>
          logger?.warn({ err }, "push.device.remove_failed")
        )

    logger?.info(
      {
        category,
        count: sessions.length,
        devices: devices.length,
        sent,
        gone,
        failed,
        statuses,
      },
      "push.dispatched"
    )
  }

  const coalescer = createPushCoalescer({
    now,
    schedule,
    windowMs: COALESCE_WINDOW_MS,
    graceMs: PRESENCE_GRACE_MS,
    filter,
    presence: verdict,
    emit: (principalId, category, sessions) => {
      deliver(principalId, category, sessions).catch((err: unknown) =>
        logger?.warn({ err }, "push.deliver.failed")
      )
    },
    onSuppressed: (_principalId, category, reason, sessions) => {
      suppressed(category, reason, sessions)
    },
  })

  const unsubscribe = runtimeInstance.sessions.subscribeExecutions((event) => {
    const category = categoryOf(event.kind)
    if (!category) return
    // A timestamp the provider left unreadable must not silence a notification.
    const parsedMs = Date.parse(event.occurredAt)
    const occurredAtMs = Number.isNaN(parsedMs) ? now() : parsedMs
    coalescer.add(principalOf(event.agentId), category, {
      agentId: event.agentId,
      sessionId: event.sessionId,
      occurredAtMs,
      newestAtMs: occurredAtMs,
      ...(event.kind === "attention-requested"
        ? { request: event.request }
        : {}),
    })
  })

  return {
    close() {
      unsubscribe()
      coalescer.close()
    },
  }
}
