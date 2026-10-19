import { describe, expect, it, vi } from "vitest"

import { useFakeClock } from "../../test/support/fake-clock"
import { McpAppFileError } from "../mcp-apps/client"
import {
  createFileReadQueue,
  heldBody,
  type FileReadQueue,
  type FileReadTurn,
} from "./file-reads"

const unreachable = new McpAppFileError("unreachable")

/** Named asks for a turn, recording the order they got one and each refusal. */
function asks(queue: FileReadQueue) {
  const taken = new Map<string, FileReadTurn>()
  const refused = new Map<string, unknown>()
  const take = (name: string, key?: string, signal?: AbortSignal) =>
    void queue.take(key, signal).then(
      (turn) => taken.set(name, turn),
      (error: unknown) => refused.set(name, error)
    )
  return {
    taken,
    refused,
    take,
    started: () => [...taken.keys()],
    release: (name: string) => taken.get(name)!.release(),
  }
}

describe("a listener's forwarded file reads", () => {
  it("hand out at most `limit` turns, the rest in their order, each freed once however often given back", async () => {
    const clock = useFakeClock()
    const { started, take, release } = asks(
      createFileReadQueue({ limit: 2, queue: 8, waitMs: 1_000 })
    )
    for (const name of ["a", "b", "c", "d"]) take(name)

    await clock.advance(0)
    expect(started()).toEqual(["a", "b"])
    release("b")
    release("b")
    await clock.advance(0)
    expect(started()).toEqual(["a", "b", "c"])
    release("a")
    await clock.advance(0)
    expect(started()).toEqual(["a", "b", "c", "d"])
  })

  it("hold one key to `perKey`, while another key's read starts within `limit`", async () => {
    const clock = useFakeClock()
    const { started, take, release } = asks(
      createFileReadQueue({ limit: 2, perKey: 1, queue: 8, waitMs: 1_000 })
    )
    take("first", "invitation-a")
    take("second", "invitation-a")
    take("other", "invitation-b")
    take("third", "invitation-c")

    await clock.advance(0)
    expect(started()).toEqual(["first", "other"])
    // The earlier waiter takes the turn, its key free again.
    release("first")
    await clock.advance(0)
    expect(started()).toEqual(["first", "other", "second"])
    release("other")
    await clock.advance(0)
    expect(started()).toEqual(["first", "other", "second", "third"])
  })

  it("refuse one past the queue or a key's share of it at once, and one still waiting at `waitMs`", async () => {
    const clock = useFakeClock()
    const { started, refused, take, release } = asks(
      createFileReadQueue({
        limit: 2,
        perKey: 1,
        queue: 3,
        queuePerKey: 2,
        waitMs: 1_000,
      })
    )
    take("a1", "a")
    take("b1", "b")
    take("a2", "a")
    take("a3", "a")
    // A third waiter of one key is refused; another key's is accepted, until
    // the queue is full.
    take("a4", "a")
    take("b2", "b")
    take("c1", "c")

    await clock.advance(0)
    expect([...refused]).toEqual([
      ["a4", unreachable],
      ["c1", unreachable],
    ])
    await clock.advance(999)
    expect(refused.size).toBe(2)
    await clock.advance(1)
    expect([...refused.keys()]).toEqual(["a4", "c1", "a2", "a3", "b2"])
    // None of them holds a place: a freed turn goes to the next one asking.
    release("a1")
    take("a5", "a")
    await clock.advance(0)
    expect(started()).toEqual(["a1", "b1", "a5"])
  })

  it("drop a waiter whose request ended, which never takes a turn", async () => {
    const clock = useFakeClock()
    const { started, refused, take, release } = asks(
      createFileReadQueue({ limit: 1, queue: 8, waitMs: 1_000 })
    )
    const gone = new AbortController()
    take("running")
    take("gone", "", gone.signal)
    take("next")

    await clock.advance(0)
    gone.abort()
    await clock.advance(0)
    expect(refused.get("gone")).toEqual(unreachable)
    release("running")
    await clock.advance(0)
    expect(started()).toEqual(["running", "next"])
    // A request that ended before it asked is refused at once.
    take("ended", "", gone.signal)
    await clock.advance(0)
    expect(refused.get("ended")).toEqual(unreachable)
  })

  it("end a turn at `ttlMs`, aborting its signal and freeing it once", async () => {
    const clock = useFakeClock()
    const { taken, started, take, release } = asks(
      createFileReadQueue({ limit: 1, queue: 8, waitMs: 5_000, ttlMs: 1_000 })
    )
    take("held")
    take("next")
    take("after")

    await clock.advance(999)
    expect(taken.get("held")!.signal.aborted).toBe(false)
    expect(started()).toEqual(["held"])
    await clock.advance(1)
    expect(taken.get("held")!.signal.reason).toMatchObject({
      name: "TimeoutError",
    })
    expect(started()).toEqual(["held", "next"])
    // The turn is already free; giving it back again frees no other.
    release("held")
    await clock.advance(0)
    expect(started()).toEqual(["held", "next"])
  })
})

describe("a held answer", () => {
  /** Two writes' worth, so a reader can stop between them. */
  const BYTES = new Uint8Array(64 * 1024 + 1).fill(65)

  function held() {
    const ttl = new AbortController()
    const release = vi.fn()
    const body = heldBody(BYTES, { signal: ttl.signal, release }).getReader()
    return { ttl, release, body }
  }

  it("holds its turn until it is written whole, then gives it back once", async () => {
    const { release, body } = held()

    expect((await body.read()).value?.byteLength).toBe(64 * 1024)
    expect(release).not.toHaveBeenCalled()
    expect((await body.read()).value?.byteLength).toBe(1)
    expect(release).toHaveBeenCalledOnce()
    expect((await body.read()).done).toBe(true)
    await body.cancel()
    expect(release).toHaveBeenCalledOnce()
  })

  it("writes nothing ahead of its reader, so a one-write answer holds its turn until read", async () => {
    const release = vi.fn()
    const body = heldBody(new Uint8Array(1), {
      signal: new AbortController().signal,
      release,
    }).getReader()

    await new Promise((resolve) => setImmediate(resolve))
    expect(release).not.toHaveBeenCalled()
    await body.read()
    expect(release).toHaveBeenCalledOnce()
  })

  it("gives its turn back once when its reader cancels it", async () => {
    const { release, body } = held()

    await body.read()
    await body.cancel()
    await body.cancel()

    expect(release).toHaveBeenCalledOnce()
  })

  it("ends mid-write when its turn's TTL passes, and gives the turn back once", async () => {
    const { ttl, release, body } = held()

    await body.read()
    ttl.abort(new DOMException("Deadline passed", "TimeoutError"))

    await expect(body.read()).rejects.toMatchObject({ name: "TimeoutError" })
    expect(release).toHaveBeenCalledOnce()
  })
})
