import {
  client,
  methods,
  RequestError,
  type AgentApp,
  type AnyWireMessage,
  type ClientConnection,
  type ClientContext,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ParamsParser,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SendRequestOptions,
  type WireStream,
} from "@agentclientprotocol/sdk/experimental/v2"
import {
  createWebSocketStream,
  type WebSocketConstructor,
} from "@agentclientprotocol/sdk/experimental/ws-client"
import { z } from "zod"

import {
  backoffDelay,
  createOwner,
  Deadline,
  defaultClock,
  fromAbortable,
  ownerSetup,
  type Clock,
  type Logger,
  type Owner,
} from "../lifecycle"
import {
  ACP_PROTOCOL_VERSION,
  HGW_AUTH_METHOD_INVITE,
  HGW_EXTENSION_VERSION,
  HGW_JSONRPC_ERRORS,
  HGW_MAX_FRAME_BYTES,
  HGW_METHODS,
  HGW_META_KEY,
  HGW_REPLAY_BEFORE,
  HGW_REPLAY_POSITION,
  HgwActivityNotificationSchema,
  HgwAgentUpdateResponseSchema,
  HgwAgentsListResponseSchema,
  HgwChunkMetaSchema,
  HgwComposerPrefillNotificationSchema,
  HgwErrorNotificationSchema,
  HgwHistoryPageResponseMetaSchema,
  HgwHistoryPageTagSchema,
  HgwInitializeMetaSchema,
  HgwSessionResumeResponseMetaSchema,
  HgwSessionSearchMetaSchema,
  HgwSessionSearchResponseSchema,
  HgwSteerResponseSchema,
  type HgwHistoryCursor,
  type HgwInitializeMeta,
} from "../protocol/acp"

import { AcpConnectionClosedError, AgentUpdateError } from "./workspace"
import {
  CAPACITY_BACKOFF,
  HANDSHAKE_DEADLINE_MS,
  LIVENESS_SILENCE_MS,
  PART_GRACE_MS,
  RECONNECT_BACKOFF,
  REQUEST_DEADLINE_MS,
  STABLE_AFTER_MS,
  type RequestTier,
} from "./limits"
import { callEach, loggedId, loggedStream } from "./log"
import type {
  AcpConnection,
  AcpConnectionOutage,
  AcpConnectionStatus,
  AcpHistoryPage,
  AcpPendingRequest,
  AcpSessionListener,
  AcpSessionState,
} from "./types"

/**
 * The browser end of one ACP v2 connection to the gateway: the hgw extension
 * handlers, the handshake, the agent-side calls, and transport recovery.
 * Everything above this module consumes `AcpConnection`, never the SDK.
 */

/** The close codes the gateway ends a connection with on purpose. */
const TRY_AGAIN_LATER = 1013
const POLICY_VIOLATION = 1008

/** Where the client logs when its caller passes no logger. */
export const SILENT_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => SILENT_LOGGER,
}

/**
 * The `cwd` every new or resumed Session names: empty, which the gateway reads
 * as the Agent's own folder, the only one a Session may run in.
 */
const AGENT_CWD = ""

/** An ACP payload's `_meta`, keyed by extension; only AOS's half is read. */
const HgwEnvelopeSchema = z.object({
  [HGW_META_KEY]: z.record(z.string(), z.unknown()),
})

/** Session-scoped elicitations name their Session; request-scoped ones do not. */
const ElicitationScopeSchema = z.object({ sessionId: z.string().min(1) })

const NOTIFICATION_PARSERS: Readonly<Record<string, ParamsParser<unknown>>> = {
  [HGW_METHODS.notify.activity]: HgwActivityNotificationSchema,
  [HGW_METHODS.notify.composerPrefill]: HgwComposerPrefillNotificationSchema,
  [HGW_METHODS.notify.catalogInvalidated]: z.unknown().optional(),
  [HGW_METHODS.notify.error]: HgwErrorNotificationSchema,
}

/**
 * What the connection hears of the page it runs in. A visible page probes a
 * quiet transport at once, and a hidden one stops probing until it shows
 * again; coming back online probes too.
 */
export type PageSignals = {
  visible(): boolean
  /** Calls `listener` on each change; returns the unsubscribe function. */
  subscribe(listener: (change: "visibility" | "online") => void): () => void
}

/** A page that is always visible and never changes: no page at all. */
const NO_PAGE: PageSignals = { visible: () => true, subscribe: () => () => {} }

/** The inspector xstate hands each owner's actor, as `createOwner` takes it. */
export type OwnerInspector = NonNullable<
  Parameters<typeof createOwner>[1]["inspect"]
>

export type AcpConnectionOptions = {
  /** Sent as `initialize` `info`. */
  clientInfo: { name: string; version: string }
  /** Times every deadline and backoff; tests fake it. */
  clock?: Clock
  /**
   * Where the connection logs its owner's transitions and every wire frame;
   * silent by default.
   */
  logger?: Logger
  /** The page the connection runs in; none by default. */
  page?: PageSignals
  /**
   * Loads an inspector for the connection's owner before it opens; one that
   * fails to load leaves the owner uninspected.
   */
  inspector?: () => Promise<OwnerInspector | undefined>
} & (
  | {
      /** The gateway's ACP WebSocket URL; see `acpSocketUrl`. */
      url: string
      /** Defaults to `globalThis.WebSocket`; tests inject a fake. */
      socketConstructor?: WebSocketConstructor
      connectAgent?: never
    }
  | {
      /** Pairs in process with an agent app instead of opening a socket. */
      connectAgent: AgentApp
      url?: never
      socketConstructor?: never
    }
)

/** ACP's code for a request that needs authentication, as the SDK builds it. */
const AUTHENTICATION_REQUIRED = RequestError.authRequired().code
/** ACP's code for a Session the provider no longer has. */
const RESOURCE_NOT_FOUND = RequestError.resourceNotFound().code
/** The code an `_hgw/error` names a Session the provider no longer has with. */
const NOT_FOUND_NOTICE = "not_found"

function codeOf(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined
}

/** Whether the proxy refused an invitation it cannot redeem. */
export function isAuthenticationRequired(error: unknown) {
  return codeOf(error) === AUTHENTICATION_REQUIRED
}

/** Whether the proxy answered that the Session no longer exists. */
function isGone(error: unknown) {
  return codeOf(error) === RESOURCE_NOT_FOUND
}

/**
 * The codes of a join refusal that resending on the same transport cannot
 * change: a request the gateway rejects as malformed or not permitted, or a
 * member or runtime that needs authenticating again.
 */
const REFUSED_ON_TRANSPORT = new Set<unknown>([
  RequestError.invalidRequest().code,
  RequestError.methodNotFound("").code,
  RequestError.invalidParams().code,
  AUTHENTICATION_REQUIRED,
])

/** Whether a join failed for good on this transport, its answer included. */
function isRefused(error: unknown) {
  return error instanceof z.ZodError || REFUSED_ON_TRANSPORT.has(codeOf(error))
}

/** What a Session owner's state shows as; any other one is still joining. */
const SESSION_STATES = new Map<unknown, AcpSessionState>([
  ["joined", "joined"],
  ["unavailable", "unavailable"],
  ["refused", "unavailable"],
  ["gone", "gone"],
])

/** The Agent update refusals a caller can act on, as typed errors. */
function agentUpdateError(error: unknown) {
  // ACP's invalid params: a field this runtime cannot take.
  if (codeOf(error) === RequestError.invalidParams().code)
    return new AgentUpdateError(
      "unsupported",
      "This runtime cannot store that Agent field"
    )
  if (codeOf(error) === HGW_JSONRPC_ERRORS.revisionConflict)
    return new AgentUpdateError("conflict", "The Agent changed; reload it")
  return error
}

/** `_meta.hgw` of an ACP payload, when it carries one. */
function hgwMetaOf(meta: unknown): Record<string, unknown> | undefined {
  const parsed = HgwEnvelopeSchema.safeParse(meta)
  return parsed.success ? parsed.data[HGW_META_KEY] : undefined
}

/** One of the gateway's ACP listener paths as a WebSocket URL from `base`. */
export function acpSocketUrl(path: string, base: string) {
  const url = new URL(path, base)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

/**
 * The cursor a rejoin resumes from: the first event of the live turn the
 * Session's listeners have not seen, as ACP's inclusive cursors name it, or
 * none for a view that saw no turn event, which the gateway positions itself.
 */
function rejoinCursor(position: { turnId: string; after: number } | undefined) {
  return {
    type: HGW_REPLAY_POSITION,
    ...(position === undefined
      ? {}
      : { turnId: position.turnId, from: position.after + 1 }),
  }
}

function subscribeTo<Listener>(listeners: Set<Listener>, listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function subscribeKeyed<Listener>(
  listeners: Map<string, Set<Listener>>,
  key: string,
  listener: Listener
) {
  const keyed = listeners.get(key) ?? new Set<Listener>()
  keyed.add(listener)
  listeners.set(key, keyed)
  return () => {
    keyed.delete(listener)
    if (!keyed.size) listeners.delete(key)
  }
}

/**
 * Adds an `onReceived` callback on every inbound frame, used to drive the
 * inbound-silence timer without coupling logging to liveness tracking.
 */
function trackedInbound(
  stream: WireStream,
  onReceived: () => void
): WireStream {
  return {
    readable: stream.readable.pipeThrough(
      new TransformStream<AnyWireMessage, AnyWireMessage>({
        transform(frame, controller) {
          onReceived()
          controller.enqueue(frame)
        },
      })
    ),
    writable: stream.writable,
  }
}

/** One opened transport; a reconnect replaces it with another. */
type Transport = {
  connection: ClientConnection
  /** Settles once the proxy answers `initialize`. */
  ready: Promise<void>
}

/**
 * Whether a request failed because `transport` closed under it: it rejected
 * with the transport's own close reason, not with an answer or a deadline of
 * its own. Only an unanswered liveness probe closes a transport with its
 * deadline, which then is every request's reason on it, the probe's too.
 */
function closedUnder({ connection }: Transport, error: unknown) {
  return connection.signal.aborted && error === connection.signal.reason
}

/**
 * Which requests go out again once their transport closes under them: every
 * read, once a transport has recovered, and a request for an opened Session,
 * once that Session has rejoined, with the same params and so the same client
 * id. Each waits for the same before it first goes out; one for a Session
 * that is not open waits for a transport to recover, and goes out once, as
 * any other request does.
 */
type Resend = "read" | { sessionId: string }

type ConnectionEvent =
  | { type: "closed"; code: number | undefined }
  | { type: "close" }

/**
 * What a Session owner hears: its connection's transport becoming usable or
 * lost, a from-start replay asked for, and the provider reporting it gone.
 */
type SessionEvent =
  | { type: "ready" }
  | { type: "lost" }
  | { type: "replay" }
  | { type: "gone" }

/** The updates of one older page, in arrival order. */
type PageUpdates = AcpHistoryPage["updates"][number][]

/**
 * The constructor a transport opens its socket with. It reports the open and
 * the close code, which the SDK drops, and its listeners run before the ones
 * the SDK attaches once the socket is constructed.
 */
function observedSocket(
  Socket: WebSocketConstructor,
  onOpen: () => void,
  onClose: (code: number | undefined) => void
): WebSocketConstructor {
  return class extends Socket {
    constructor(...args: ConstructorParameters<WebSocketConstructor>) {
      super(...args)
      this.addEventListener?.("open", onOpen)
      this.addEventListener?.("close", (event) =>
        onClose(event instanceof CloseEvent ? event.code : undefined)
      )
    }
  }
}

/** What the connection's machine calls out to, as its connection wires it. */
export type ConnectionMachineDeps = {
  /** Opens a transport as the live one; settles once its socket is open. */
  open(): Promise<void>
  /** Settles once the live transport's handshake is answered. */
  handshake(): Promise<unknown>
  /** Rejoins every opened Session over the transport now ready. */
  recover(): Promise<void>
  /** In-process pairing, which has no transport to reopen. */
  inProcess: boolean
  /** Closes the live transport, which recovers as a dropped one does. */
  closeTransport(): void
  markReady(): void
  /** The transport is gone: every Session loses it, and the status says why. */
  lose(status: "reconnecting" | "capacity"): void
  logger: Logger
  clock: Clock
}

/**
 * One connection's lifecycle: opening a transport, its handshake, ready while
 * it serves, and after a close, reconnecting on backoff, waiting out a full
 * gateway, or closed for good.
 */
export function connectionMachine({
  open,
  handshake,
  recover,
  inProcess,
  closeTransport,
  markReady,
  lose,
  logger,
  clock,
}: ConnectionMachineDeps) {
  const actors = {
    open: fromAbortable(() => open()),
    handshake: fromAbortable(() => handshake()),
    recover: fromAbortable(() => recover()),
  }
  const connectionSetup = ownerSetup<
    { generation: number; attempt: number },
    ConnectionEvent,
    typeof actors
  >("connection", logger, clock, actors)
  /** Where a closed transport leaves the connection, by its close code. */
  const onTransportClosed = [
    { guard: "inProcess", target: "closed" },
    { guard: "policyViolation", target: "closed" },
    { guard: "tryAgainLater", target: "capacity" },
    { target: "reconnecting" },
  ] as const
  return connectionSetup
    .extend({
      delays: {
        handshake: HANDSHAKE_DEADLINE_MS,
        stable: STABLE_AFTER_MS,
        reconnect: ({ context }) =>
          backoffDelay(context.attempt, RECONNECT_BACKOFF),
        capacity: () =>
          CAPACITY_BACKOFF.minMs +
          Math.floor(
            Math.random() * (CAPACITY_BACKOFF.maxMs - CAPACITY_BACKOFF.minMs)
          ),
      },
      guards: {
        inProcess: () => inProcess,
        policyViolation: ({ event }) =>
          event.type === "closed" && event.code === POLICY_VIOLATION,
        tryAgainLater: ({ event }) =>
          event.type === "closed" && event.code === TRY_AGAIN_LATER,
      },
      actions: {
        // A handshake or replay that cannot complete leaves an unusable
        // transport; closing it recovers as a dropped one does.
        closeTransport: () => closeTransport(),
        markReady: () => markReady(),
        lose: (_, { status }: { status: "reconnecting" | "capacity" }) =>
          lose(status),
        countAttempt: connectionSetup.assign({
          attempt: ({ context }) => context.attempt + 1,
        }),
        resetAttempts: connectionSetup.assign({ attempt: 0 }),
      },
    })
    .createMachine({
      context: { generation: 0, attempt: 0 },
      initial: "connecting",
      on: { close: ".closed" },
      states: {
        connecting: {
          entry: "bumpGeneration",
          invoke: { src: "open", onDone: "handshaking" },
          on: { closed: onTransportClosed },
          after: { handshake: { actions: "closeTransport" } },
        },
        handshaking: {
          invoke: {
            src: "handshake",
            onDone: "ready",
            onError: { actions: "closeTransport" },
          },
          on: { closed: onTransportClosed },
          after: { handshake: { actions: "closeTransport" } },
        },
        ready: {
          entry: "markReady",
          // Every Session rejoined, or a transport up long enough, starts the
          // backoff over.
          invoke: {
            src: "recover",
            onDone: { actions: "resetAttempts" },
            onError: { actions: "closeTransport" },
          },
          on: { closed: onTransportClosed },
          after: { stable: { actions: "resetAttempts" } },
        },
        reconnecting: {
          meta: { log: "info" },
          entry: { type: "lose", params: { status: "reconnecting" } },
          after: {
            reconnect: { target: "connecting", actions: "countAttempt" },
          },
        },
        // The gateway is full: the wait is long, and the status says why.
        capacity: {
          meta: { log: "info" },
          entry: { type: "lose", params: { status: "capacity" } },
          after: { capacity: "connecting" },
        },
        closed: { type: "final", meta: { log: "info" } },
      },
    })
}

/** What one Session owner's machine calls out to, as its connection wires it. */
export type SessionMachineDeps = {
  join(sessionId: string, signal: AbortSignal): Promise<unknown>
  /** Whether the Session owes a from-start replay its join has not given. */
  replayOwed(sessionId: string): boolean
  oweReplay(sessionId: string): void
  /** Whether the connection's transport is not ready. */
  transportLost(): boolean
  /** Holds a join the transport refused, and tells the Session why. */
  refuse(sessionId: string, error: unknown): void
  logger: Logger
  clock: Clock
}

/**
 * One opened Session's owner. It joins while the transport is ready, waits
 * out a failed join on its own backoff, holds one the transport refuses
 * until the next transport, rejoins after a reconnect, and ends for good
 * once the provider reports the Session gone.
 */
export function sessionMachine(
  {
    join,
    replayOwed,
    oweReplay,
    transportLost,
    refuse,
    logger,
    clock,
  }: SessionMachineDeps,
  sessionId: string,
  initial: "joining" | "joined" | "detached"
) {
  const sessionActors = {
    join: fromAbortable((signal, sessionId: string) => join(sessionId, signal)),
  }
  const sessionOwnerSetup = ownerSetup<
    { generation: number; attempt: number; sessionId: string },
    SessionEvent,
    typeof sessionActors
  >("session-owner", logger, clock, sessionActors)
  return sessionOwnerSetup
    .extend({
      delays: {
        retry: ({ context }) =>
          backoffDelay(context.attempt, RECONNECT_BACKOFF),
      },
      guards: {
        replayOwed: ({ context }) => replayOwed(context.sessionId),
        transportLost: () => transportLost(),
      },
      actions: {
        oweReplay: ({ context }) => oweReplay(context.sessionId),
        countAttempt: sessionOwnerSetup.assign({
          attempt: ({ context }) => context.attempt + 1,
        }),
        resetAttempts: sessionOwnerSetup.assign({ attempt: 0 }),
      },
    })
    .createMachine({
      context: { generation: 0, attempt: 0, sessionId },
      initial,
      on: { replay: { actions: "oweReplay" }, gone: ".gone" },
      states: {
        joining: {
          entry: "bumpGeneration",
          invoke: {
            src: "join",
            input: ({ context }) => context.sessionId,
            onDone: [
              { guard: "replayOwed", target: "joining", reenter: true },
              { target: "joined", actions: "resetAttempts" },
            ],
            onError: [
              { guard: ({ event }) => isGone(event.error), target: "gone" },
              { guard: "transportLost", target: "detached" },
              {
                guard: ({ event }) => isRefused(event.error),
                target: "refused",
                actions: ({ context, event }) =>
                  refuse(context.sessionId, event.error),
              },
              { target: "unavailable" },
            ],
          },
          on: { lost: "detached" },
        },
        joined: {
          on: {
            lost: "detached",
            replay: { target: "joining", actions: "oweReplay" },
          },
        },
        unavailable: {
          meta: { log: "info" },
          after: { retry: { target: "joining", actions: "countAttempt" } },
          on: { lost: "detached" },
        },
        refused: { meta: { log: "info" }, on: { lost: "detached" } },
        detached: { on: { ready: "joining" } },
        gone: { type: "final", meta: { log: "info" } },
      },
    })
}

/**
 * The entries of a list answer, each read on its own: one this client cannot
 * read is left out, and `skipped` hears it. Entries none of which can be read
 * reject as a whole, since that is a gateway this client does not understand
 * rather than one bad entry.
 */
function readEach<T>(
  entries: readonly unknown[],
  schema: z.ZodType<T>,
  skipped: (entry: unknown) => void
): T[] {
  const kept: T[] = []
  let unreadable: unknown
  for (const entry of entries) {
    const read = schema.safeParse(entry)
    if (read.success) kept.push(read.data)
    else {
      unreadable = read.error
      skipped(entry)
    }
  }
  if (entries.length > 0 && kept.length === 0) throw unreadable
  return kept
}

const AgentsListEntriesSchema = HgwAgentsListResponseSchema.extend({
  agents: z.array(z.unknown()).max(1_000),
})
const SessionSearchEntriesSchema = HgwSessionSearchResponseSchema.extend({
  sessions: z.array(z.unknown()),
})

/** Room a request's JSON-RPC envelope takes in its frame beside the params. */
const FRAME_ENVELOPE_BYTES = 1_024
const frameEncoder = new TextEncoder()

/**
 * Refuses params whose frame the gateway's socket would not take. An
 * oversized frame closes the tab's one socket, and the transport would send
 * the same frame again on every reconnect, so one large prompt would take
 * every Session down with it; refused here, it costs only its own call.
 */
function assertFrameFits(params: unknown) {
  const bytes = frameEncoder.encode(JSON.stringify(params)).byteLength
  if (bytes > HGW_MAX_FRAME_BYTES - FRAME_ENVELOPE_BYTES)
    throw new RequestError(
      HGW_JSONRPC_ERRORS.requestTooLarge,
      "Request too large to send"
    )
}

export function createAcpConnection(
  options: AcpConnectionOptions
): AcpConnection {
  const {
    clientInfo,
    connectAgent,
    clock = defaultClock,
    logger = SILENT_LOGGER,
    page = NO_PAGE,
  } = options
  const notificationListeners = new Map<
    string,
    Set<(params: unknown) => void>
  >()
  const pendingListeners = new Set<(request: AcpPendingRequest) => void>()
  const statusListeners = new Set<(status: AcpConnectionStatus) => void>()
  const outageListeners = new Set<
    (outage: AcpConnectionOutage | undefined) => void
  >()
  /**
   * One `subscribe` call: a listener subscribed twice holds the Session until
   * each of its subscriptions leaves.
   */
  type Subscription = { readonly listener: AcpSessionListener }
  /**
   * One opened Session: whoever listens, the owner that joins it, and what a
   * rejoin and a page read need, all dropped once it parts.
   */
  type OpenSession = {
    readonly listeners: Set<Subscription>
    owner?: Owner<ReturnType<typeof sessionMachine>>
    state: AcpSessionState
    /** Where the live turn was last seen, which a rejoin resumes from. */
    position?: { turnId: string; after: number }
    /** What the latest from-start replay reported of older history. */
    history?: HgwHistoryCursor
    /** The updates of the page read in flight. */
    page?: PageUpdates
    /** Whether a join has replayed it from the start yet. */
    replayed: boolean
    /** A from-start replay is owed: asked for, or one that did not complete. */
    replayOwed: boolean
    /** The from-start replay in flight and the settle callbacks it owes. */
    replaying?: {
      settles: ((replayed: boolean) => void)[]
      delivered: boolean
    }
    waiters?: PromiseWithResolvers<void>
    /** Why the transport refused the join, while the Session stays refused. */
    refusal?: unknown
    grace?: unknown
  }
  const sessions = new Map<string, OpenSession>()
  // The gateway answers `notFound` for a Session a fresh connection has not
  // listed or created, so every resume names the Agent that owns it.
  const owners = new Map<string, string>()

  let status: AcpConnectionStatus = "connecting"
  let outage: AcpConnectionOutage | undefined
  let started = false
  /** Settles once the inspector has loaded and the owner opened. */
  let inspecting: Promise<void> | undefined
  let ended = false
  /** Opens, recovers and ends transports; `start` creates it. */
  let owner: Owner<typeof machine> | undefined
  let live: Transport | undefined
  /** Set once a transport is lost, until a replacement recovers. */
  let recovering = false
  /** Whether a Session opened now may join at once, the transport recovered. */
  let joinable = false
  /** What reads waiting for a transport to recover wait on, while one does. */
  let recovery: PromiseWithResolvers<void> | undefined
  // The guest listener's principal, replayed when a new transport redeems it.
  let invitation: string | undefined
  // The last presence report, replayed whenever a new transport recovers.
  let lastFocus:
    | { sessionId: string | null; foreground: boolean; idle: boolean }
    | undefined
  /** The handle for the running inbound-silence timer; replaced on every inbound frame. */
  let silenceTimer: unknown = undefined
  let settleInitialized: ((meta: HgwInitializeMeta) => void) | undefined
  let failInitialized: ((error: Error) => void) | undefined
  const initialized = new Promise<HgwInitializeMeta>((resolve, reject) => {
    settleInitialized = resolve
    failInitialized = reject
  })
  // Closing before the handshake settles must not raise an unhandled rejection
  // in a consumer that never awaited it.
  initialized.catch((err: unknown) =>
    logger.warn({ err }, "acp.connection.initialized_failed")
  )

  function setStatus(next: AcpConnectionStatus) {
    if (status === next) return
    status = next
    callEach(statusListeners, logger, "acp.listener.failed", next)
  }

  function setOutage(next: AcpConnectionOutage | undefined) {
    if (outage === next) return
    outage = next
    callEach(outageListeners, logger, "acp.listener.failed", next)
  }

  function emitPending(request: AcpPendingRequest) {
    for (const listener of pendingListeners)
      try {
        listener(request)
      } catch {
        // A consumer that cannot show one request must not fail it for the
        // others: an unanswered request stays pending for the gateway to
        // re-issue, which never answers the runtime on the operator's behalf.
      }
  }

  /**
   * (Re)arms the inbound-silence timer after each received frame. When the
   * page is not visible the timer is cleared; the `visibilitychange` handler
   * probes at once when the page becomes visible again.
   */
  function armSilenceTimer() {
    clock.clearTimeout(silenceTimer)
    silenceTimer = undefined
    if (!page.visible() || ended) return
    silenceTimer = clock.setTimeout(() => {
      silenceTimer = undefined
      sendLivenessProbeAsync()
    }, LIVENESS_SILENCE_MS)
  }

  /** When the gateway was last heard from, on any transport. */
  let lastInboundAt = Number.NEGATIVE_INFINITY

  /** Called on every inbound frame; resets the silence window. */
  function onInbound() {
    lastInboundAt = clock.now()
    armSilenceTimer()
  }

  /**
   * Sends `_hgw/session/focus` as a request. A reply within the probe
   * deadline is the liveness acknowledgement; no reply closes the transport
   * and the connection reconnects. Re-reports the last known focused Session
   * if any, or `{}` when no focus has been reported yet.
   */
  function sendLivenessProbeAsync() {
    const params = lastFocus ?? {}
    request("probe", (agent, options) =>
      agent.request(HGW_METHODS.session.focus, params, options)
    ).catch((err: unknown) => {
      logger.debug({ err }, "acp.liveness.failed")
    })
  }

  /**
   * Holds one request open until it is answered or withdrawn. A withdrawn one
   * rejects with the abort's reason, the SDK's `requestCancelled`, so the SDK
   * answers it as cancelled and releases it.
   */
  function held<Response>(
    signal: AbortSignal,
    emit: (respond: (response: Response) => void) => void
  ) {
    return new Promise<Response>((respond, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      })
      emit(respond)
    })
  }

  function permissionRequest(
    request: RequestPermissionRequest,
    signal: AbortSignal
  ) {
    return held<RequestPermissionResponse>(signal, (respond) => {
      emitPending({
        kind: "permission",
        sessionId: request.sessionId,
        request,
        respond,
        signal,
      })
    })
  }

  function elicitationRequest(
    request: CreateElicitationRequest,
    signal: AbortSignal
  ) {
    const scope = ElicitationScopeSchema.safeParse(request)
    return held<CreateElicitationResponse>(signal, (respond) => {
      emitPending({
        kind: "elicitation",
        sessionId: scope.success ? scope.data.sessionId : undefined,
        request,
        respond,
        signal,
      })
    })
  }

  const app = client({ name: clientInfo.name })
    .onNotification(methods.client.session.update, ({ params }) => {
      // Every `_meta.hgw` the protocol defines for an update belongs to the
      // update itself, not to the notification carrying it.
      const meta = hgwMetaOf(params.update._meta)
      const open = sessions.get(params.sessionId)
      if (!open) return
      // An older page's updates belong to the page read alone: its turns are
      // long over, so a live listener or the rejoin position would take its
      // state markers for the running turn's.
      if (HgwHistoryPageTagSchema.safeParse(meta).data?.historyPage) {
        open.page?.push({ update: params.update, meta })
        return
      }
      // Every turn meta extends the chunk meta, and reads drop unknown keys,
      // so the chunk schema positions any of them.
      const position = HgwChunkMetaSchema.safeParse(meta)
      if (position.success)
        open.position = {
          turnId: position.data.turnId,
          after: position.data.sequence,
        }
      if (open.replaying) open.replaying.delivered = true
      for (const { listener } of open.listeners)
        callEach(
          listener.update ? [listener.update] : [],
          logger,
          "acp.listener.failed",
          params.update,
          meta
        )
    })
    .onRequest(methods.client.session.requestPermission, ({ params, signal }) =>
      permissionRequest(params, signal)
    )
    .onRequest(methods.client.elicitation.create, ({ params, signal }) =>
      elicitationRequest(params, signal)
    )
  for (const [method, parser] of Object.entries(NOTIFICATION_PARSERS))
    app.onNotification(method, parser, ({ params }) => {
      if (method === HGW_METHODS.notify.error) noticeGone(params)
      callEach(
        notificationListeners.get(method) ?? [],
        logger,
        "acp.listener.failed",
        params
      )
    })

  /** An opened Session the proxy reports as not found is gone for good. */
  function noticeGone(params: unknown) {
    const notice = HgwErrorNotificationSchema.safeParse(params).data
    if (notice?.code !== NOT_FOUND_NOTICE || notice.sessionId === undefined)
      return
    sessions.get(notice.sessionId)?.owner?.actor.send({ type: "gone" })
  }

  /** The live transport, its handshake answered or not; fails while none is. */
  async function liveTransport(): Promise<Transport> {
    // React commits children before their parent, so a consumer's effect can
    // reach the wire before the effect that owns the transport. The first call
    // opens it; `start` stays the only place that decides to.
    start()
    // In a debug dev build the owner exists once the inspector has loaded.
    if (inspecting) await inspecting
    if (ended || !live)
      throw new AcpConnectionClosedError("The ACP connection is not open")
    return live
  }

  async function readyTransport(): Promise<Transport> {
    const current = await liveTransport()
    await current.ready
    return current
  }

  /**
   * Settles once a transport has recovered: its handshake answered and, after
   * a reconnect, its invitation redeemed, so a Session may join it. Rejects
   * only once the connection has ended.
   */
  function recovered(): Promise<void> {
    start()
    if (ended) return Promise.reject(new AcpConnectionClosedError())
    if (joinable) return Promise.resolve()
    recovery ??= Promise.withResolvers()
    return recovery.promise
  }

  type Send<Response> = (
    agent: ClientContext,
    options: SendRequestOptions
  ) => Promise<Response>

  /**
   * Sends one request on the live transport. One that `resend` names waits
   * until it may go out, and goes out again once its transport closes under
   * it, while its Session, if it names one, stays open. Any other request a
   * transport closes under fails as `AcpConnectionClosedError`, never with
   * the transport's own reason, which a failed socket leaves a DOM `Event`.
   */
  async function request<Response>(
    tier: RequestTier,
    send: Send<Response>,
    resend?: Resend
  ): Promise<Response> {
    const sessionId = resend === "read" ? undefined : resend?.sessionId
    for (;;) {
      if (sessionId !== undefined && sessions.has(sessionId))
        await joined(sessionId)
      else if (resend) await recovered()
      const transport = await liveTransport()
      try {
        await transport.ready
        return await requestOn(transport, tier, send)
      } catch (error) {
        if (!closedUnder(transport, error)) throw error
        const again =
          resend === "read" ||
          (sessionId !== undefined && sessions.has(sessionId))
        if (!again)
          throw new AcpConnectionClosedError(undefined, { cause: error })
        // Once its close is handled, the transport has been lost: a read
        // waits for the next one to recover, a Session for its rejoin.
        await transport.connection.closed.catch((err: unknown) =>
          logger.warn({ err }, "acp.connection.closed_with_error")
        )
      }
    }
  }

  /**
   * Sends one request on `transport` under its tier's deadline. A reply that
   * never comes fails the request and checks the transport in with a liveness
   * probe; only an unanswered probe closes it, so a slow gateway costs no
   * reconnect. A request `parent` aborts leaves the transport as it is.
   */
  async function requestOn<Response>(
    { connection }: Transport,
    tier: RequestTier,
    send: Send<Response>,
    parent?: AbortSignal
  ) {
    const deadline = new Deadline(REQUEST_DEADLINE_MS[tier], clock, parent)
    const sentAt = clock.now()
    try {
      return await deadline.run((cancellationSignal) =>
        send(connection.agent, { cancellationSignal })
      )
    } catch (error) {
      if (deadline.signal.aborted && !parent?.aborted) {
        // An unanswered probe proves a dead transport only if nothing else
        // arrived either: frames still coming mean its reply is queued
        // behind them, say one Session's long replay.
        if (tier !== "probe") sendLivenessProbeAsync()
        else if (lastInboundAt <= sentAt) connection.close(error)
      }
      throw error
    }
  }

  /**
   * Notifications have no reply; the gateway reports failures as `_hgw/error`.
   * One for an open Session waits until it is joined.
   */
  function notifyAgent(
    send: (agent: ClientContext) => Promise<void>,
    sessionId?: string
  ) {
    void (async () => {
      if (sessionId !== undefined && sessions.has(sessionId))
        await joined(sessionId)
      const { connection } = await readyTransport()
      await send(connection.agent)
    })().catch((err: unknown) => {
      logger.debug({ err, sessionId }, "acp.notify.failed")
    })
  }

  async function handshake(connection: ClientConnection) {
    const response = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      info: clientInfo,
      // The question composer answers form elicitations, so the gateway asks
      // this client its Session's questions. This client pages older history
      // itself, so a from-start resume may replay only the newest page.
      capabilities: {
        elicitation: { form: {} },
        _meta: { [HGW_META_KEY]: { historyPages: true } },
      },
    })
    const announced = hgwMetaOf(response._meta)
    // A retry cannot change the gateway's version, so a mismatch ends the
    // connection instead of reconnecting against it.
    if (announced?.version !== HGW_EXTENSION_VERSION) {
      const error = new Error(
        `The gateway speaks hgw extension version ${String(announced?.version)}; this client speaks version ${HGW_EXTENSION_VERSION}`
      )
      failInitialized?.(error)
      failInitialized = undefined
      settleInitialized = undefined
      closeConnection()
      throw error
    }
    const meta = HgwInitializeMetaSchema.parse(announced)
    settleInitialized?.(meta)
    settleInitialized = undefined
    failInitialized = undefined
  }

  async function login(token: string) {
    await request("short", (agent, options) =>
      agent.request(
        methods.agent.auth.login,
        {
          methodId: HGW_AUTH_METHOD_INVITE,
          _meta: { [HGW_META_KEY]: { token } },
        },
        options
      )
    )
    invitation = token
  }

  /**
   * Redeems the invitation on a recovered transport. A refused one stays
   * refused, so the connection ends instead of reconnecting against it.
   */
  async function reloginOrClose(token: string) {
    try {
      await login(token)
      return true
    } catch (error) {
      if (!isAuthenticationRequired(error)) throw error
      closeConnection()
      return false
    }
  }

  /**
   * One `session/resume` of an opened Session: from the start when none has
   * replayed it yet or one is owed, else from its position. `signal` aborts
   * once its owner leaves `joining`, and then nothing is recorded.
   */
  async function joinOnce(sessionId: string, signal: AbortSignal) {
    const transport = await readyTransport()
    // Read once the transport is ready, so every listener that subscribed in
    // the same turn as the first one names the Agent and takes the replay.
    const open = sessions.get(sessionId)
    if (!open) throw notOpen()
    if (signal.aborted) return
    const fromStart = !open.replayed || open.replayOwed
    open.replayOwed = false
    const named = [...open.listeners].find(({ listener }) => listener.agentId)
    const agentId = named?.listener.agentId ?? owners.get(sessionId)
    // A from-start replay resends the whole Session, and its turns arrive as
    // chunks: whoever projects this one drops what the replay replaces first,
    // or every part it already holds is appended to a second time.
    const replaying = fromStart
      ? { settles: [...open.listeners].flatMap(settleOf), delivered: false }
      : undefined
    open.replaying = replaying
    let replayed = false
    try {
      const response = await requestOn(
        transport,
        fromStart ? "long" : "medium",
        (agent, options) =>
          agent.request(
            methods.agent.session.resume,
            {
              sessionId,
              cwd: AGENT_CWD,
              replayFrom: fromStart
                ? { type: "start" }
                : rejoinCursor(open.position),
              _meta: {
                [HGW_META_KEY]: agentId === undefined ? {} : { agentId },
              },
            },
            options
          ),
        signal
      )
      const meta = HgwSessionResumeResponseMetaSchema.parse(
        hgwMetaOf(response._meta)
      )
      if (signal.aborted) return
      if (agentId !== undefined) owners.set(sessionId, agentId)
      // Recorded before the replay settles, so whoever it settles reads the
      // cursor of the transcript it now holds.
      if (meta.history) open.history = meta.history
      if (fromStart) {
        open.replayed = true
        replayed = true
      }
    } finally {
      // A from-start replay that did not complete is still owed: its
      // listeners may already hold part of it.
      if (fromStart && !replayed) open.replayOwed = true
      if (open.replaying === replaying) open.replaying = undefined
      for (const settle of replaying?.settles ?? []) settle(replayed)
    }
  }

  /** The Agent catalog, an entry at a time: one bad entry costs that Agent. */
  async function listAgents() {
    const response = AgentsListEntriesSchema.parse(
      await request(
        "short",
        (agent, options) =>
          agent.request(HGW_METHODS.agents.list, undefined, options),
        "read"
      )
    )
    return {
      ...response,
      agents: readEach(
        response.agents,
        HgwAgentsListResponseSchema.shape.agents.element,
        (entry) =>
          logger.warn(
            { id: loggedId(entry, "summary", "id") },
            "agents.entry_skipped"
          )
      ),
    }
  }

  /** A listener's part in a from-start replay: its settle callback, if any. */
  function settleOf({ listener }: Subscription) {
    const settle = listener.replay?.()
    return settle ? [settle] : []
  }

  function notOpen() {
    return new Error("The Session is not open on this ACP connection")
  }

  /** Holds a Session its transport refused until the next transport. */
  function refuse(sessionId: string, error: unknown) {
    logger.warn({ err: error, sessionId }, "acp.session.refused")
    const open = sessions.get(sessionId)
    if (open) open.refusal = error
  }

  function joined(sessionId: string) {
    const open = sessions.get(sessionId)
    if (!open) return Promise.reject(notOpen())
    if (open.state === "joined") return Promise.resolve()
    if (open.state === "gone")
      return Promise.reject(RequestError.resourceNotFound())
    if (open.refusal !== undefined) return Promise.reject(open.refusal)
    if (!open.waiters) {
      open.waiters = Promise.withResolvers()
      // A part or close with nobody waiting is no unhandled rejection.
      open.waiters.promise.catch((err: unknown) =>
        logger.warn({ err }, "acp.session.waiter_failed")
      )
    }
    return open.waiters.promise
  }

  function replay(sessionId: string) {
    const open = sessions.get(sessionId)
    if (!open) return Promise.reject(notOpen())
    const served = open.replaying
      ? !open.replaying.delivered
      : !open.replayed || open.replayOwed
    if (!served) open.owner?.actor.send({ type: "replay" })
    return joined(sessionId)
  }

  /** Mirrors the owner's state onto the record and its listeners. */
  function mirror(open: OpenSession, value: unknown) {
    if (value !== "refused") open.refusal = undefined
    const next = SESSION_STATES.get(value) ?? "joining"
    if (next === open.state) return
    open.state = next
    const failure =
      next === "gone" ? RequestError.resourceNotFound() : open.refusal
    if (next === "joined") open.waiters?.resolve()
    if (failure !== undefined) open.waiters?.reject(failure)
    if (next === "joined" || failure !== undefined) open.waiters = undefined
    for (const { listener } of open.listeners)
      callEach(
        listener.state ? [listener.state] : [],
        logger,
        "acp.listener.failed",
        next
      )
  }

  function subscribe(sessionId: string, listener: AcpSessionListener) {
    if (ended) return () => {}
    // A Session opened before the transport joins once it is ready.
    start()
    const subscription = { listener }
    const known = sessions.get(sessionId)
    if (known) {
      clock.clearTimeout(known.grace)
      known.grace = undefined
      known.listeners.add(subscription)
      // Nothing of the replay under way has arrived, so it carries the
      // Session whole to this listener too.
      if (known.replaying && !known.replaying.delivered)
        known.replaying.settles.push(...settleOf(subscription))
      return () => leave(sessionId, known, subscription)
    }
    const open = openSession(sessionId, [subscription], false)
    return () => leave(sessionId, open, subscription)
  }

  /**
   * Records an opened Session and starts its owner: one `session/new` just
   * joined is joined already and has nothing to replay; any other joins once
   * the transport is ready.
   */
  function openSession(
    sessionId: string,
    listeners: Subscription[],
    created: boolean
  ) {
    const open: OpenSession = {
      listeners: new Set(listeners),
      state: "joining",
      replayed: created,
      replayOwed: false,
    }
    sessions.set(sessionId, open)
    const initial = !joinable ? "detached" : created ? "joined" : "joining"
    const owner = createOwner(sessionMachine(sessionDeps, sessionId, initial), {
      logger,
      clock,
      bindings: { sessionId },
    })
    open.owner = owner
    owner.actor.subscribe((snapshot) => mirror(open, snapshot.value))
    mirror(open, owner.actor.getSnapshot().value)
    return open
  }

  function leave(
    sessionId: string,
    open: OpenSession,
    subscription: Subscription
  ) {
    if (!open.listeners.delete(subscription) || open.listeners.size > 0) return
    if (sessions.get(sessionId) !== open) return
    open.grace = clock.setTimeout(() => part(sessionId, open), PART_GRACE_MS)
  }

  /**
   * Drops a Session no listener came back to, and tells the gateway so. Its
   * work goes on: `session/close` would stop it.
   */
  function part(sessionId: string, open: OpenSession) {
    sessions.delete(sessionId)
    owners.delete(sessionId)
    open.owner?.dispose()
    open.waiters?.reject(notOpen())
    open.waiters = undefined
    if (open.state === "gone") return
    request("short", (agent, options) =>
      agent.request(HGW_METHODS.session.part, { sessionId }, options)
    ).catch((err: unknown) => {
      logger.debug({ err, sessionId }, "acp.session.part.failed")
    })
  }

  async function resumePage(
    sessionId: string,
    cursor: string
  ): Promise<AcpHistoryPage> {
    const open = sessions.get(sessionId)
    if (!open) throw notOpen()
    let updates: PageUpdates = []
    try {
      // The gateway reads a page only for a Session this connection has
      // joined, which a recovered transport has not done until it rejoins.
      const response = await request(
        "medium",
        (agent, options) => {
          // Each send reads the page whole, so one sent again starts over.
          updates = []
          open.page = updates
          return agent.request(
            methods.agent.session.resume,
            {
              sessionId,
              cwd: AGENT_CWD,
              replayFrom: { type: HGW_REPLAY_BEFORE, cursor },
            },
            options
          )
        },
        { sessionId }
      )
      const { history } = HgwHistoryPageResponseMetaSchema.parse(
        hgwMetaOf(response._meta)
      )
      return { updates, history }
    } finally {
      if (open.page === updates) open.page = undefined
    }
  }

  /**
   * What a transport owes once it is ready: a recovered one redeems the
   * invitation and restates presence first. Then every opened Session joins
   * on its own, and the transport is done once each has joined, gone, or
   * parted.
   */
  async function recover() {
    if (recovering) {
      recovering = false
      // The new transport is unauthenticated, so a guest connection redeems
      // its invitation again before anything that login authorizes.
      if (invitation !== undefined && !(await reloginOrClose(invitation)))
        return
      // A closed connection loses its presence; the liveness probe re-reports
      // it, and the Sessions join without waiting for its answer.
      sendLivenessProbeAsync()
    }
    joinable = true
    // The connection is back. Each Session's rejoin is its own state, so one
    // slow resume holds up no other Session's view of the connection.
    setOutage(undefined)
    recovery?.resolve()
    recovery = undefined
    const opened = [...sessions.keys()]
    for (const open of sessions.values())
      open.owner?.actor.send({ type: "ready" })
    await Promise.allSettled(opened.map(joined))
  }

  /** Hands the owner an event; an ended connection has none left to take. */
  function deliver(event: ConnectionEvent) {
    if (!ended) owner?.actor.send(event)
  }

  /** Opens a transport as the live one; settles once its socket is open. */
  function openTransport() {
    const opened = Promise.withResolvers<void>()
    let closeCode: number | undefined
    const connection = options.connectAgent
      ? app.connect(options.connectAgent)
      : app.connect(
          loggedStream(
            trackedInbound(
              createWebSocketStream<AnyWireMessage>(options.url, {
                WebSocket: observedSocket(
                  options.socketConstructor ?? globalThis.WebSocket,
                  () => opened.resolve(),
                  (code) => {
                    closeCode = code
                  }
                ),
              }),
              onInbound
            ),
            logger
          )
        )
    // In-process pairing has no socket to wait for.
    if (connectAgent) opened.resolve()
    const transport = { connection, ready: handshake(connection) }
    // Whoever waits on the handshake hears its failure; the owner hears of
    // the close that causes it.
    transport.ready.catch((err: unknown) =>
      logger.warn({ err }, "acp.transport.handshake_failed")
    )
    live = transport
    const onClosed = () => {
      if (live !== transport) return
      live = undefined
      deliver({ type: "closed", code: closeCode })
    }
    connection.closed.then(onClosed, onClosed)
    return opened.promise
  }

  const machine = connectionMachine({
    open: openTransport,
    handshake: readyTransport,
    recover,
    inProcess: connectAgent !== undefined,
    closeTransport: () => live?.connection.close(),
    markReady() {
      setStatus("ready")
    },
    lose(next) {
      recovering = true
      joinable = false
      setStatus(next)
      setOutage(next)
      for (const open of sessions.values())
        open.owner?.actor.send({ type: "lost" })
    },
    logger,
    clock,
  })
  const sessionDeps: SessionMachineDeps = {
    join: joinOnce,
    replayOwed: (sessionId) => sessions.get(sessionId)?.replayOwed === true,
    oweReplay(sessionId) {
      const open = sessions.get(sessionId)
      if (open) open.replayOwed = true
    },
    transportLost: () => status !== "ready",
    refuse,
    logger,
    clock,
  }

  /**
   * Opens the transport, once. Creating a connection performs no I/O, so a
   * render React discards leaves no socket behind, and a closed connection
   * stays closed. Recovery after a close belongs to the owner.
   */
  function start() {
    if (started || ended) return
    started = true
    if (options.inspector)
      inspecting = options
        .inspector()
        .catch((err: unknown) => {
          logger.debug({ err }, "acp.inspector.load_failed")
          return undefined
        })
        .then(openOwner)
    else openOwner(undefined)
  }

  function openOwner(inspect: Parameters<typeof createOwner>[1]["inspect"]) {
    if (ended) return
    owner = createOwner(machine, { logger, clock, bindings: {}, inspect })
    owner.stack.defer(shutdown)
    const unsubscribePage = page.subscribe((change) => {
      if (change === "visibility" && !page.visible()) {
        // Disarm while hidden; the page becoming visible probes at once.
        clock.clearTimeout(silenceTimer)
        silenceTimer = undefined
      } else if (status === "ready") {
        sendLivenessProbeAsync()
      }
    })
    owner.stack.defer(() => {
      clock.clearTimeout(silenceTimer)
      silenceTimer = undefined
      unsubscribePage()
    })
  }

  /** Ends the connection for good: nothing reconnects, and every waiter fails. */
  function shutdown() {
    if (ended) return
    ended = true
    setStatus("closed")
    setOutage(undefined)
    failInitialized?.(new AcpConnectionClosedError())
    failInitialized = undefined
    settleInitialized = undefined
    recovery?.reject(new AcpConnectionClosedError())
    recovery = undefined
    for (const open of sessions.values()) {
      clock.clearTimeout(open.grace)
      open.owner?.dispose()
      open.waiters?.reject(new AcpConnectionClosedError())
    }
    sessions.clear()
    live?.connection.close()
    live = undefined
  }

  function closeConnection() {
    if (owner) deliver({ type: "close" })
    else shutdown()
  }

  return {
    get status() {
      return status
    },
    start,
    initialized,
    subscribeStatus: (listener) => subscribeTo(statusListeners, listener),
    get outage() {
      return outage
    },
    subscribeOutage: (listener) => subscribeTo(outageListeners, listener),

    login,

    async newSession(meta) {
      const { sessionId } = await request("short", (agent, options) =>
        agent.request(
          methods.agent.session.new,
          { cwd: AGENT_CWD, _meta: { [HGW_META_KEY]: meta } },
          options
        )
      )
      owners.set(sessionId, meta.agentId)
      // It parts in its grace unless a listener comes to it.
      if (!sessions.has(sessionId)) {
        const open = openSession(sessionId, [], true)
        open.grace = clock.setTimeout(
          () => part(sessionId, open),
          PART_GRACE_MS
        )
      }
      return { sessionId }
    },

    async listSessions(meta, cursor) {
      const response = await request(
        "short",
        (agent, options) =>
          agent.request(
            methods.agent.session.list,
            {
              ...(cursor === undefined ? {} : { cursor }),
              _meta: { [HGW_META_KEY]: meta },
            },
            options
          ),
        "read"
      )
      return {
        sessions: response.sessions,
        ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
      }
    },

    /** Search results, one at a time: one bad result costs that result. */
    async searchSessions(meta) {
      const response = SessionSearchEntriesSchema.parse(
        await request(
          "short",
          (agent, options) =>
            agent.request(
              HGW_METHODS.sessions.search,
              {
                _meta: {
                  [HGW_META_KEY]: HgwSessionSearchMetaSchema.parse(meta),
                },
              },
              options
            ),
          "read"
        )
      )
      return {
        ...response,
        sessions: readEach(
          response.sessions,
          HgwSessionSearchResponseSchema.shape.sessions.element,
          (entry) =>
            logger.warn(
              { id: loggedId(entry, "sessionId") },
              "sessions.result_skipped"
            )
        ),
      }
    },

    subscribe,
    joined,
    replay,
    sessionState: (sessionId) => sessions.get(sessionId)?.state,
    resumePage,
    history: (sessionId) => sessions.get(sessionId)?.history,

    async prompt(sessionId, blocks: ContentBlock[], meta) {
      const params = {
        sessionId,
        prompt: blocks,
        _meta: { [HGW_META_KEY]: meta },
      }
      assertFrameFits(params)
      const response = await request(
        "long",
        (agent, options) =>
          agent.request(methods.agent.session.prompt, params, options),
        { sessionId }
      )
      return { messageId: response.messageId }
    },

    cancel(sessionId) {
      notifyAgent(
        (agent) => agent.notify(methods.agent.session.cancel, { sessionId }),
        sessionId
      )
    },

    async setConfigOption(sessionId, configId, value) {
      const response = await request(
        "medium",
        (agent, options) =>
          agent.request(
            methods.agent.session.setConfigOption,
            { sessionId, configId, type: "id", value },
            options
          ),
        { sessionId }
      )
      return response.configOptions
    },

    async deleteSession(sessionId) {
      await request("short", (agent, options) =>
        agent.request(methods.agent.session.delete, { sessionId }, options)
      )
    },

    async updateSession(update) {
      await request("short", (agent, options) =>
        agent.request(HGW_METHODS.session.update, update, options)
      )
    },

    async steer(steer) {
      assertFrameFits(steer)
      return HgwSteerResponseSchema.parse(
        await request(
          "medium",
          (agent, options) =>
            agent.request(HGW_METHODS.session.steer, steer, options),
          { sessionId: steer.sessionId }
        )
      )
    },

    focus(sessionId, presence) {
      const report = {
        sessionId,
        foreground: presence.foreground,
        idle: presence.idle,
      }
      lastFocus = report
      // The focus request is also the liveness probe: no reply in 20 s, and
      // nothing else heard meanwhile, closes the transport; the reconnect
      // re-reports it via sendLivenessProbeAsync.
      request("probe", (agent, options) =>
        agent.request(HGW_METHODS.session.focus, report, options)
      ).catch((err: unknown) => {
        logger.debug({ err }, "acp.focus.failed")
      })
    },

    listAgents,

    async updateAgent(update) {
      const response = await request("short", (agent, options) =>
        agent.request(HGW_METHODS.agents.update, update, options)
      ).catch((error: unknown) => {
        throw agentUpdateError(error)
      })
      return HgwAgentUpdateResponseSchema.parse(response)
    },

    subscribeNotification: (method, listener) =>
      subscribeKeyed(notificationListeners, method, listener),
    subscribePendingRequests: (listener) =>
      subscribeTo(pendingListeners, listener),

    close: closeConnection,
  }
}
