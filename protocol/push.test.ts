import { describe, expect, it } from "vitest"

import {
  categoryOf,
  PUSH_TEXT_LIMITS,
  PushMessageSchema,
  PushRegistrationSchema,
} from "./push"

const base = {
  v: 2,
  category: "input",
  agentId: "agent",
  sessionId: "session",
  occurredAt: "2026-09-20T10:00:00.000Z",
  locale: "en",
} as const

describe("push contract", () => {
  it("maps lifecycle events to the three categories and ignores the rest", () => {
    expect(categoryOf("attention-requested")).toBe("input")
    expect(categoryOf("turn-failed")).toBe("failure")
    expect(categoryOf("agent-activation-failed")).toBe("failure")
    expect(categoryOf("turn-finished")).toBe("completion")
    expect(categoryOf("agent-ready")).toBe("completion")
    expect(categoryOf("turn-started")).toBeUndefined()
    expect(categoryOf("attention-resolved")).toBeUndefined()
  })

  it.each([
    ["the ids alone", base, true],
    [
      "every text field at its limit",
      {
        ...base,
        agentName: "a".repeat(PUSH_TEXT_LIMITS.agentName),
        sessionTitle: "t".repeat(PUSH_TEXT_LIMITS.sessionTitle),
        requestText: "q".repeat(PUSH_TEXT_LIMITS.requestText),
        requestMore: 2,
      },
      true,
    ],
    ["a count", { ...base, count: 1 }, false],
    ["the first version", { ...base, v: 1 }, false],
    ["no Session id", { ...base, sessionId: undefined }, false],
    [
      "a title past its limit",
      { ...base, sessionTitle: "t".repeat(PUSH_TEXT_LIMITS.sessionTitle + 1) },
      false,
    ],
    ["an empty name", { ...base, agentName: "" }, false],
    ["no further question", { ...base, requestMore: 0 }, false],
    ["a field it does not define", { ...base, title: "leak" }, false],
  ])(
    "accepts only a v2 message about one Session: %s",
    (_case, message, valid) => {
      expect(PushMessageSchema.safeParse(message).success).toBe(valid)
    }
  )

  it("accepts a browser subscription with device preferences", () => {
    const registration = {
      subscription: {
        endpoint: "https://push.example/abc",
        keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
      },
      locale: "he",
      categories: { input: true, failure: true, completion: false },
    }
    expect(PushRegistrationSchema.safeParse(registration).success).toBe(true)
    expect(
      PushRegistrationSchema.safeParse({ ...registration, locale: "fr" })
        .success
    ).toBe(false)
  })
})
