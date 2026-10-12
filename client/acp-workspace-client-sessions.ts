import {
  SessionUpdate,
  StateUpdate,
  type SessionInfo,
} from "@agentclientprotocol/sdk/experimental/v2"

import {
  HGW_META_KEY,
  HGW_METHODS,
  HgwActivityNotificationSchema,
  HgwPlanMetaSchema,
  HgwSessionInfoMetaSchema,
  type HgwActivityNotification,
  type HgwSessionInfoMeta,
} from "../protocol/acp"

import type {
  SessionMetadata,
  SessionStatus,
  TodoItem,
  WorkspaceActivityEvent,
} from "./workspace"
import { subscribeHgwNotification } from "./hgw-notification"
import type { AcpConnection } from "./types"

/**
 * Everything the workspace learns by subscribing to the connection: the Session row
 * cache, execution status, Session Todos, workspace activity, and read state.
 * Writes live in the client facade; this module only reads and publishes.
 */

type MetadataListener = (metadata: SessionMetadata[]) => void
type MetadataSubscription = {
  sessionIds: ReadonlySet<string>
  listener: MetadataListener
}

export type AcpSessionStoreOptions = {
  connection: AcpConnection
  now?: () => number
  /** A live turn of a subscribed Session just stopped, however it ended. */
  onTurnFinished?: (sessionId: string) => void
}

/** The one place a `state_update` becomes a Session status. */
function statusFromState(update: StateUpdate): SessionStatus {
  if (StateUpdate.isRunning(update)) return "running"
  if (StateUpdate.isRequiresAction(update)) return "waiting-for-input"
  // A turn nothing observes may have failed, and offers no Stop.
  if (StateUpdate.isUnknown(update)) return "failed"
  if (!StateUpdate.isIdle(update)) return "unknown"
  return update.stopReason === "error" ? "failed" : "idle"
}

/**
 * The status a feed event moves a Session to. A resolved request means the
 * turn runs on only once no other request of the Session is open.
 */
const FEED_STATUS: Readonly<
  Partial<Record<HgwActivityNotification["type"], SessionStatus>>
> = {
  "turn-started": "running",
  "attention-requested": "waiting-for-input",
  "attention-resolved": "running",
  "turn-finished": "idle",
  "turn-failed": "failed",
}

/**
 * Workspace events as the feed sent them, a request's preview and the replay
 * mark included; read state travels as a row change instead.
 */
function activityEventOf(
  notification: HgwActivityNotification,
  marksReplays: boolean
): WorkspaceActivityEvent | undefined {
  const { agentId, sessionId, occurredAt, type, replayed } = notification
  if (type === "unread-changed") return undefined
  const key =
    "turnId" in notification
      ? notification.turnId
      : "requestId" in notification
        ? notification.requestId
        : occurredAt
  const base = {
    id: `${sessionId}:${key}:${type}`,
    agentId,
    sessionId,
    occurredAt,
    ...(replayed && marksReplays ? { replayed } : {}),
  }
  if (type === "attention-requested") {
    const { requestText, requestMore } = notification
    return {
      ...base,
      type,
      requestId: notification.requestId,
      attentionKind: notification.attentionKind,
      ...(requestText === undefined ? {} : { requestText }),
      ...(requestMore === undefined ? {} : { requestMore }),
    }
  }
  if (type === "attention-resolved")
    return { ...base, type, requestId: notification.requestId }
  return { ...base, type, turnId: notification.turnId }
}

function sameRow(left: SessionMetadata | undefined, right: SessionMetadata) {
  return (
    left !== undefined &&
    left.agentId === right.agentId &&
    left.updatedAt === right.updatedAt &&
    left.status === right.status &&
    left.archived === right.archived &&
    left.unread === right.unread &&
    left.pinned === right.pinned &&
    left.createdAt === right.createdAt &&
    left.platform === right.platform
  )
}

export function createAcpSessionStore({
  connection,
  now = Date.now,
  onTurnFinished,
}: AcpSessionStoreOptions) {
  const rows = new Map<string, SessionMetadata>()
  const titles = new Map<string, string>()
  const todos = new Map<string, TodoItem[]>()
  /** Sessions mid-replay, with the newest status that replay has sent. */
  const replaying = new Map<string, SessionStatus | undefined>()
  const subscriptions = new Set<MetadataSubscription>()
  /** How many holders subscribe each Session; its own stream outranks the feed. */
  const subscribed = new Map<string, number>()
  /** Every Session's open requests, as the feed reports them. */
  const openRequests = new Map<string, Set<string>>()
  /**
   * Only the first connection's catch-up is old news to this client: a later
   * one may re-send what happened while the socket was down.
   */
  let marksReplays = true
  const todoListeners = new Map<string, Set<(todos: TodoItem[]) => void>>()
  const activityListeners = new Set<(event: WorkspaceActivityEvent) => void>()
  const invalidationListeners = new Map<string, Set<() => void>>()

  function rowsFor(sessionIds: Iterable<string>) {
    return [...sessionIds].flatMap((sessionId) => {
      const row = rows.get(sessionId)
      return row ? [{ ...row }] : []
    })
  }

  /**
   * A snapshot answers for every Session it was asked about. One that omits a
   * Session the catalog has not reached yet — a reloaded deep link naming a
   * Session past page one — would read as a Session the workspace does not
   * have, so the read that resolves it publishes instead.
   */
  function notify(subscription: MetadataSubscription) {
    for (const sessionId of subscription.sessionIds)
      if (!rows.has(sessionId)) return
    subscription.listener(rowsFor(subscription.sessionIds))
  }

  function publish(sessionId: string) {
    for (const subscription of subscriptions)
      if (subscription.sessionIds.has(sessionId)) notify(subscription)
  }

  function write(sessionId: string, next: SessionMetadata) {
    if (sameRow(rows.get(sessionId), next)) return
    rows.set(sessionId, next)
    publish(sessionId)
  }

  /**
   * `unread`, `pinned`, and `createdAt` are absent when unknowable on this
   * read and never overwrite; `archived` is on every provider read of a Session.
   * A row older than what is already stored (by `updatedAt`) is silently
   * dropped: a live event that arrived before a list page must not be
   * overwritten by the stale page.
   */
  function put(
    sessionId: string,
    info: HgwSessionInfoMeta,
    updatedAt?: string | null
  ) {
    const previous = rows.get(sessionId)
    const incomingUpdatedAt =
      updatedAt !== undefined && updatedAt !== null ? updatedAt : undefined
    // Refuse a list row whose timestamp is behind a live event the store
    // already folded in: the live event is the more current truth.
    if (
      incomingUpdatedAt !== undefined &&
      previous?.updatedAt !== undefined &&
      Date.parse(incomingUpdatedAt) < Date.parse(previous.updatedAt)
    )
      return
    const unread = info.unread ?? previous?.unread
    const pinned = info.pinned ?? previous?.pinned
    const createdAt = info.createdAt ?? previous?.createdAt
    const platform = info.platform ?? previous?.platform
    write(sessionId, {
      sessionId,
      agentId: info.agentId,
      updatedAt:
        updatedAt ?? previous?.updatedAt ?? new Date(now()).toISOString(),
      status: info.status,
      archived: info.archived,
      ...(unread === undefined ? {} : { unread }),
      ...(pinned === undefined ? {} : { pinned }),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(platform === undefined ? {} : { platform }),
    })
  }

  function patch(sessionId: string, change: Partial<SessionMetadata>) {
    const previous = rows.get(sessionId)
    if (previous) write(sessionId, { ...previous, ...change })
  }

  function setTodos(sessionId: string, next: TodoItem[]) {
    todos.set(sessionId, next)
    for (const listener of todoListeners.get(sessionId) ?? [])
      listener(next.map((todo) => ({ ...todo })))
  }

  function emitActivity(event: WorkspaceActivityEvent) {
    for (const listener of activityListeners) listener(event)
  }

  /** Tells a Session's listeners to re-read what the provider now holds. */
  function invalidate(sessionId: string) {
    for (const listener of invalidationListeners.get(sessionId) ?? [])
      listener()
  }

  /** An update whose `_meta.hgw` does not parse carries nothing to publish. */
  function acceptUpdate(
    sessionId: string,
    update: SessionUpdate,
    meta: Record<string, unknown> | undefined
  ) {
    if (SessionUpdate.isStateUpdate(update)) {
      const status = statusFromState(update)
      if (replaying.has(sessionId)) return void replaying.set(sessionId, status)
      const previous = rows.get(sessionId)?.status
      patch(sessionId, { status })
      if (
        (previous === "running" || previous === "waiting-for-input") &&
        (status === "idle" || status === "failed")
      )
        onTurnFinished?.(sessionId)
      return
    }
    if (SessionUpdate.isSessionInfoUpdate(update)) {
      if (update.title && update.title !== titles.get(sessionId)) {
        titles.set(sessionId, update.title)
        invalidate(sessionId)
      }
      const info = HgwSessionInfoMetaSchema.safeParse(meta)
      if (info.success) put(sessionId, info.data, update.updatedAt)
      return
    }
    if (!SessionUpdate.isPlanUpdate(update)) return
    const plan = HgwPlanMetaSchema.safeParse(meta)
    if (plan.success) setTodos(sessionId, plan.data.todos)
  }

  /**
   * A replay resends every stored turn's running and idle, and a row that
   * followed each one would repaint every surface showing it per turn. It
   * takes only the status the replay ends on.
   */
  function holdReplayedStatus(sessionId: string) {
    replaying.set(sessionId, undefined)
    return () => {
      const status = replaying.get(sessionId)
      replaying.delete(sessionId)
      if (status) patch(sessionId, { status })
    }
  }

  /**
   * A subscribed Session streams its own status, Todos, and row changes until
   * the returned release; its Todos go with it, its row stays in the catalog.
   */
  function subscribe(sessionId: string, agentId?: string) {
    const leave = connection.subscribe(sessionId, {
      ...(agentId === undefined ? {} : { agentId }),
      update: (update, meta) => acceptUpdate(sessionId, update, meta),
      replay: () => holdReplayedStatus(sessionId),
    })
    subscribed.set(sessionId, (subscribed.get(sessionId) ?? 0) + 1)
    return () => {
      leave()
      const holders = (subscribed.get(sessionId) ?? 1) - 1
      if (holders > 0) subscribed.set(sessionId, holders)
      else subscribed.delete(sessionId)
      todos.delete(sessionId)
      replaying.delete(sessionId)
    }
  }

  /**
   * Keeps a held row's status live from the feed, for the Sessions nobody
   * subscribes to: a subscribed Session's own `state_update` is authoritative,
   * and a turn it ends must still read as an end. Open requests are counted
   * for every Session, so one that stops being subscribed counts right.
   */
  function noteActivity(notification: HgwActivityNotification) {
    const { sessionId, type } = notification
    const open = openRequests.get(sessionId) ?? new Set<string>()
    if (type === "attention-requested") open.add(notification.requestId)
    else if (type === "attention-resolved") open.delete(notification.requestId)
    else if (type === "turn-finished" || type === "turn-failed") open.clear()
    if (open.size > 0) openRequests.set(sessionId, open)
    else openRequests.delete(sessionId)
    const status = FEED_STATUS[type]
    if (!status || subscribed.has(sessionId)) return
    if (type === "attention-resolved" && open.size > 0) return
    patch(sessionId, { status })
  }

  const leaveActivity = subscribeHgwNotification(
    connection,
    HGW_METHODS.notify.activity,
    HgwActivityNotificationSchema,
    (notification) => {
      if (notification.type === "unread-changed")
        return patch(notification.sessionId, { unread: notification.unread })
      noteActivity(notification)
      const event = activityEventOf(notification, marksReplays)
      if (event) emitActivity(event)
    }
  )

  return {
    subscribe,
    dispose() {
      leaveActivity()
    },
    /**
     * A connection that starts over re-sends every request still open as it
     * catches up, so one the old connection left open and the new one does
     * not name was settled while nobody was listening; and what it re-sends
     * is no longer marked as already seen.
     */
    startOver() {
      openRequests.clear()
      marksReplays = false
    },
    put,
    rowsFor,
    /** The provider's title, as a list page or a subscribed Session reports it. */
    setTitle: (sessionId: string, title: string) =>
      titles.set(sessionId, title),
    /** The proxy's read state, or the operator's own optimistic ack. */
    setUnread: (sessionId: string, unread: boolean) =>
      patch(sessionId, { unread }),
    /** The operator's own optimistic pin; `undefined` restores a refused one. */
    setPinned: (sessionId: string, pinned: boolean | undefined) =>
      patch(sessionId, { pinned }),
    setStatus: (sessionId: string, status: SessionStatus) =>
      patch(sessionId, { status }),
    knows: (sessionId: string) => rows.has(sessionId),
    agentIdOf: (sessionId: string) => rows.get(sessionId)?.agentId,
    /** The newest title the provider reported, for the thread list to stream. */
    title: (sessionId: string) => titles.get(sessionId),
    status: (sessionId: string): SessionStatus =>
      rows.get(sessionId)?.status ?? "unknown",

    subscribeMetadata(
      sessionIds: readonly string[],
      listener: MetadataListener
    ) {
      const subscription = { sessionIds: new Set(sessionIds), listener }
      subscriptions.add(subscription)
      queueMicrotask(() => {
        if (subscriptions.has(subscription)) notify(subscription)
      })
      return () => subscriptions.delete(subscription)
    },

    subscribeStatus(sessionId: string, listener: () => void) {
      const subscription = {
        sessionIds: new Set([sessionId]),
        listener: () => listener(),
      }
      subscriptions.add(subscription)
      return () => subscriptions.delete(subscription)
    },

    subscribeTodos(sessionId: string, listener: (todos: TodoItem[]) => void) {
      const listeners = todoListeners.get(sessionId) ?? new Set()
      listeners.add(listener)
      todoListeners.set(sessionId, listeners)
      queueMicrotask(() => {
        if (listeners.has(listener))
          listener((todos.get(sessionId) ?? []).map((todo) => ({ ...todo })))
      })
      return () => {
        listeners.delete(listener)
        if (!listeners.size) todoListeners.delete(sessionId)
      }
    },

    emitActivity,

    subscribeActivity(listener: (event: WorkspaceActivityEvent) => void) {
      activityListeners.add(listener)
      return () => activityListeners.delete(listener)
    },

    subscribeInvalidation(sessionId: string, listener: () => void) {
      const listeners = invalidationListeners.get(sessionId) ?? new Set()
      listeners.add(listener)
      invalidationListeners.set(sessionId, listeners)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) invalidationListeners.delete(sessionId)
      }
    },
  }
}

/** One `session/list` entry as a workspace row. */
export function rowOf(session: SessionInfo) {
  return {
    sessionId: session.sessionId,
    info: HgwSessionInfoMetaSchema.parse(session._meta?.[HGW_META_KEY]),
    updatedAt: session.updatedAt,
    title: session.title,
  }
}
