/**
 * The browser ACP client's deadlines and backoff. Each request tier outlasts
 * the gateway deadline its work waits on, so a slow but healthy gateway answers
 * before the browser gives the transport up.
 */

/** How long a socket has to open, and then to answer `initialize`. */
export const HANDSHAKE_DEADLINE_MS = 10_000

/**
 * How long a request waits for its reply before it fails and its transport
 * is checked in with a liveness probe: short for reads and the other small requests, medium for a resume,
 * a config write and a steer, long for a prompt and a from-start resume.
 * The `probe` tier is the liveness probe deadline; focus uses it.
 */
export const REQUEST_DEADLINE_MS = {
  short: 45_000,
  medium: 45_000,
  long: 90_000,
  probe: 20_000,
} as const

export type RequestTier = keyof typeof REQUEST_DEADLINE_MS

/** How long an inbound stream may be silent while visible before a liveness probe is sent. */
export const LIVENESS_SILENCE_MS = 20_000

/** Full-jitter backoff before reopening a closed transport. */
export const RECONNECT_BACKOFF = { baseMs: 250, capMs: 5_000 }

/** A transport up this long starts the backoff over, rejoined or not. */
export const STABLE_AFTER_MS = 60_000

/**
 * A transport the gateway closes as a reader that fell behind (4409) within
 * this long of its recovery keeps the backoff that recovery started over, so a
 * reader that keeps falling behind a running turn backs off as any repeated
 * failure does, each cycle costing a rebuild and a resume of every Session.
 * The same as STABLE_AFTER_MS: until then the transport has not shown that it
 * keeps up.
 */
export const FELL_BEHIND_WINDOW_MS = STABLE_AFTER_MS

/**
 * How long an opened Session outlives its last listener before it parts, so
 * an unsubscribe a resubscribe follows at once, as Strict Mode does, costs
 * neither a close nor a resume.
 */
export const PART_GRACE_MS = 2_000

/** The window a reopen waits in after the gateway closes at capacity. */
export const CAPACITY_BACKOFF = { minMs: 30_000, maxMs: 60_000 }
