// @vitest-environment node

import { describe, expect, it } from "vitest"

import { createGuestBudget } from "./budget"

const NOW = 1_700_000_000_000
const WINDOW_MS = 600_000
const REF = "guest_ref"
const OTHER_REF = "other_guest_ref"

function harness(limits: { maxInFlight?: number; maxOps?: number } = {}) {
  let current = NOW
  return {
    advance(ms: number) {
      current += ms
    },
    budget: createGuestBudget({
      now: () => current,
      windowMs: WINDOW_MS,
      maxInFlight: limits.maxInFlight ?? 2,
      maxOps: limits.maxOps ?? 60,
    }),
  }
}

function spend(budget: ReturnType<typeof harness>["budget"], ref: string) {
  const release = budget.acquire(ref)
  release?.()
  return release !== undefined
}

describe("guest budget", () => {
  it("refuses a third concurrent operation and frees the slot on release", () => {
    const { budget } = harness()

    const first = budget.acquire(REF)
    const second = budget.acquire(REF)

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(budget.acquire(REF)).toBeUndefined()

    first?.()

    expect(budget.acquire(REF)).toBeDefined()
    expect(budget.acquire(REF)).toBeUndefined()
  })

  it("refuses an operation past the windowed allowance and forgets it once the window passes", () => {
    const { advance, budget } = harness()

    for (let index = 0; index < 60; index += 1)
      expect(spend(budget, REF), `operation ${index + 1}`).toBe(true)

    // Nothing is in flight: the refusal is the spend ceiling, not concurrency.
    expect(budget.acquire(REF)).toBeUndefined()

    advance(WINDOW_MS + 1)

    expect(spend(budget, REF)).toBe(true)
  })

  it("keeps a completed operation counted for the rest of its window", () => {
    const { advance, budget } = harness({ maxOps: 2 })

    expect(spend(budget, REF)).toBe(true)
    advance(WINDOW_MS / 2)
    expect(spend(budget, REF)).toBe(true)
    expect(budget.acquire(REF)).toBeUndefined()

    // Only the first operation has aged out of the window.
    advance(WINDOW_MS / 2 + 1)

    expect(spend(budget, REF)).toBe(true)
    expect(budget.acquire(REF)).toBeUndefined()
  })

  it("budgets each conversation separately", () => {
    const { budget } = harness({ maxOps: 1 })

    expect(budget.acquire(REF)).toBeDefined()
    expect(budget.acquire(REF)).toBeUndefined()

    expect(budget.acquire(OTHER_REF)).toBeDefined()
    expect(budget.acquire(OTHER_REF)).toBeUndefined()
  })

  it("ignores a repeated release", () => {
    const { budget } = harness()

    const first = budget.acquire(REF)
    expect(budget.acquire(REF)).toBeDefined()
    first?.()
    first?.()

    expect(budget.acquire(REF)).toBeDefined()
    expect(budget.acquire(REF)).toBeUndefined()
  })
})
