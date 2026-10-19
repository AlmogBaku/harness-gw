import { Deadline, defaultClock, type Clock } from "../../lifecycle"
import { McpAppFileError } from "../mcp-apps/client"

/**
 * How long one forwarded file read may hold its turn, from taking it to its
 * answer's last byte written.
 */
export const FILE_READ_TTL_MS = 120_000

/** The operator listener's forwarded file reads: four at once. */
export const OPERATOR_FILE_READS = { limit: 4, queue: 32, waitMs: 30_000 }

/**
 * The guest listener's: two at once, one per invitation, and at most two of
 * an invitation's waiting.
 */
export const GUEST_FILE_READS = {
  limit: 2,
  perKey: 1,
  queue: 32,
  queuePerKey: 2,
  waitMs: 30_000,
}

/** The bytes one write of a held answer takes. */
const CHUNK_BYTES = 64 * 1024

/**
 * One forwarded file read's turn. Its `signal` aborts when the turn's TTL
 * passes, which gives the turn back; `release` gives it back sooner, once
 * however often it is called.
 */
export type FileReadTurn = { signal: AbortSignal; release: () => void }

const unreachable = () => new McpAppFileError("unreachable")

/**
 * The forwarded file reads one listener runs at once. Each holds its whole
 * file in memory, so at most `limit` hold a turn, and at most `perKey` under
 * one key, taken in the order they asked. One that cannot start waits behind
 * at most `queue` others, `queuePerKey` of them under its key, for at most
 * `waitMs` and while its request lasts; past any, it fails as `unreachable`,
 * which a view offers to retry. A turn lasts at most `ttlMs`.
 */
export function createFileReadQueue({
  limit,
  perKey = limit,
  queue,
  queuePerKey = queue,
  waitMs,
  ttlMs = FILE_READ_TTL_MS,
  clock = defaultClock,
}: {
  limit: number
  perKey?: number
  queue: number
  queuePerKey?: number
  waitMs: number
  ttlMs?: number
  clock?: Clock
}) {
  let running = 0
  const held = new Map<string, number>()
  const waiting: { key: string; start: () => void }[] = []
  const free = (key: string) => running < limit && (held.get(key) ?? 0) < perKey

  function giveBack(key: string) {
    running -= 1
    const left = (held.get(key) ?? 1) - 1
    if (left > 0) held.set(key, left)
    else held.delete(key)
    // The earliest waiters whose keys are free start, in their order.
    for (const waiter of [...waiting])
      if (free(waiter.key)) {
        waiting.splice(waiting.indexOf(waiter), 1)
        waiter.start()
      }
  }

  /** A turn under `key`, taken now; its TTL gives it back if nothing does. */
  function turn(key: string): FileReadTurn {
    running += 1
    held.set(key, (held.get(key) ?? 0) + 1)
    const ttl = new Deadline(ttlMs, clock)
    let released = false
    const release = () => {
      if (released) return
      released = true
      ttl.clear()
      giveBack(key)
    }
    ttl.signal.addEventListener("abort", release, { once: true })
    return { signal: ttl.signal, release }
  }

  return {
    /** A turn under `key`, once one is free and while `signal` holds. */
    take(key = "", signal?: AbortSignal): Promise<FileReadTurn> {
      if (signal?.aborted) return Promise.reject(unreachable())
      if (free(key)) return Promise.resolve(turn(key))
      const queued = waiting.filter((waiter) => waiter.key === key).length
      if (waiting.length >= queue || queued >= queuePerKey)
        return Promise.reject(unreachable())
      return new Promise((resolve, reject) => {
        const settle = () => {
          clock.clearTimeout(timer)
          signal?.removeEventListener("abort", leave)
        }
        const leave = () => {
          settle()
          waiting.splice(waiting.indexOf(waiter), 1)
          reject(unreachable())
        }
        const waiter = {
          key,
          start: () => {
            settle()
            resolve(turn(key))
          },
        }
        const timer = clock.setTimeout(leave, waitMs)
        signal?.addEventListener("abort", leave, { once: true })
        waiting.push(waiter)
      })
    },
  }
}

/** One listener's forwarded file reads. */
export type FileReadQueue = ReturnType<typeof createFileReadQueue>

/**
 * `bytes` as a body written within `turn`: it gives the turn back once it is
 * written whole, cancelled, or ended because the turn's TTL passed, and drops
 * the bytes then, so no answer outlives its turn.
 */
export function heldBody(
  bytes: Uint8Array,
  turn: FileReadTurn
): ReadableStream<Uint8Array> {
  let left: Uint8Array | undefined = bytes
  const end = () => {
    left = undefined
    turn.release()
  }
  // Nothing is written ahead of its reader, so the turn ends with the last
  // byte the reader takes.
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        turn.signal.addEventListener(
          "abort",
          () => {
            end()
            controller.error(turn.signal.reason)
          },
          { once: true }
        )
      },
      pull(controller) {
        if (!left) return
        controller.enqueue(left.subarray(0, CHUNK_BYTES))
        left = left.subarray(CHUNK_BYTES)
        if (left.byteLength > 0) return
        controller.close()
        end()
      },
      cancel: end,
    },
    { highWaterMark: 0 }
  )
}
