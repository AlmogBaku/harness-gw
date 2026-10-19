import { defaultClock, type Clock } from "../../lifecycle"
import { McpAppFileError } from "../mcp-apps/client"

/** The operator listener's forwarded file reads: four at once. */
export const OPERATOR_FILE_READS = { limit: 4, queue: 32, waitMs: 30_000 }

/** The guest listener's: two at once, and one per invitation. */
export const GUEST_FILE_READS = {
  limit: 2,
  perKey: 1,
  queue: 32,
  waitMs: 30_000,
}

/**
 * The forwarded file reads one listener runs at once. Each holds its whole
 * file while it runs, so at most `limit` run, and at most `perKey` under one
 * key, started in the order they arrived. A read that cannot start waits
 * behind at most `queue` others for at most `waitMs`, and past either fails
 * as `unreachable`, which a view offers to retry.
 */
export function createFileReadQueue({
  limit,
  perKey = limit,
  queue,
  waitMs,
  clock = defaultClock,
}: {
  limit: number
  perKey?: number
  queue: number
  waitMs: number
  clock?: Clock
}) {
  let running = 0
  const held = new Map<string, number>()
  const waiting: { key: string; start: () => void }[] = []
  const free = (key: string) => running < limit && (held.get(key) ?? 0) < perKey
  const take = (key: string) => {
    running += 1
    held.set(key, (held.get(key) ?? 0) + 1)
  }

  function release(key: string) {
    running -= 1
    const left = (held.get(key) ?? 1) - 1
    if (left > 0) held.set(key, left)
    else held.delete(key)
    // The earliest waiters whose keys are free start, in their order.
    for (const waiter of [...waiting])
      if (free(waiter.key)) {
        waiting.splice(waiting.indexOf(waiter), 1)
        take(waiter.key)
        waiter.start()
      }
  }

  function turn(key: string) {
    if (waiting.length >= queue)
      return Promise.reject(new McpAppFileError("unreachable"))
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        key,
        start: () => {
          clock.clearTimeout(timer)
          resolve()
        },
      }
      const timer = clock.setTimeout(() => {
        waiting.splice(waiting.indexOf(waiter), 1)
        reject(new McpAppFileError("unreachable"))
      }, waitMs)
      waiting.push(waiter)
    })
  }

  return {
    /** `read` in its turn, under `key` where one caller may hold only `perKey`. */
    async run<T>(read: () => Promise<T>, key = ""): Promise<T> {
      if (free(key)) take(key)
      else await turn(key)
      try {
        return await read()
      } finally {
        release(key)
      }
    },
  }
}

/** One listener's forwarded file reads. */
export type FileReadQueue = ReturnType<typeof createFileReadQueue>
