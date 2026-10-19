import { describe, expect, it } from "vitest"

import { useFakeClock } from "../../test/support/fake-clock"
import { McpAppFileError } from "../mcp-apps/client"
import { createFileReadQueue } from "./file-reads"

/**
 * Reads that each hold their turn until the test ends them, recording the
 * order they started and how each settled.
 */
function reads(queue: ReturnType<typeof createFileReadQueue>) {
  const started: string[] = []
  const settled = new Map<string, unknown>()
  const ends = new Map<string, PromiseWithResolvers<string>>()
  const start = (name: string, key?: string) => {
    const end = Promise.withResolvers<string>()
    ends.set(name, end)
    queue
      .run(() => {
        started.push(name)
        return end.promise
      }, key)
      .then(
        (value) => settled.set(name, value),
        (error: unknown) => settled.set(name, error)
      )
  }
  return { started, settled, start, end: (name: string) => ends.get(name)! }
}

describe("a listener's forwarded file reads", () => {
  it("run at most `limit` at once, the rest in their order as each ends", async () => {
    const clock = useFakeClock()
    const { started, settled, start, end } = reads(
      createFileReadQueue({ limit: 2, queue: 8, waitMs: 1_000 })
    )
    for (const name of ["a", "b", "c", "d"]) start(name)

    await clock.advance(0)
    expect(started).toEqual(["a", "b"])
    // A failed read frees its turn as a finished one does.
    end("b").reject(new Error("synthetic failure"))
    await clock.advance(0)
    expect(started).toEqual(["a", "b", "c"])
    end("a").resolve("a read")
    await clock.advance(0)
    expect(started).toEqual(["a", "b", "c", "d"])
    expect(settled.get("a")).toBe("a read")
  })

  it("hold one key to `perKey`, while another key's read starts within `limit`", async () => {
    const clock = useFakeClock()
    const { started, start, end } = reads(
      createFileReadQueue({ limit: 2, perKey: 1, queue: 8, waitMs: 1_000 })
    )
    start("first", "invitation-a")
    start("second", "invitation-a")
    start("other", "invitation-b")
    start("third", "invitation-c")

    await clock.advance(0)
    expect(started).toEqual(["first", "other"])
    // The earlier waiter takes the turn, its key free again.
    end("first").resolve("done")
    await clock.advance(0)
    expect(started).toEqual(["first", "other", "second"])
    end("other").resolve("done")
    await clock.advance(0)
    expect(started).toEqual(["first", "other", "second", "third"])
  })

  it("refuse one past the queue at once, and one still waiting at `waitMs`, as unreachable", async () => {
    const clock = useFakeClock()
    const { started, settled, start, end } = reads(
      createFileReadQueue({ limit: 1, queue: 1, waitMs: 1_000 })
    )
    const unreachable = new McpAppFileError("unreachable")
    start("running")
    start("waiting")
    start("past the queue")

    await clock.advance(0)
    expect([...settled]).toEqual([["past the queue", unreachable]])
    await clock.advance(999)
    expect(settled.has("waiting")).toBe(false)
    await clock.advance(1)
    expect(settled.get("waiting")).toEqual(unreachable)
    // Neither held a turn: the running read's end lets the next one start.
    end("running").resolve("done")
    start("next")
    await clock.advance(0)
    expect(started).toEqual(["running", "next"])
  })
})
