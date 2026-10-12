import { describe, expect, it } from "vitest"

import type { PendingRequest } from "./events"
import { maskRequestText, previewText, requestPreview } from "./request-text"

const ENUM = { type: "string", enum: ["once", "deny"] }

function question(text?: string, label?: string) {
  return {
    ...(text === undefined ? {} : { text }),
    ...(label === undefined ? {} : { label }),
    choices: [],
    multiple: false,
    custom: true,
  }
}

/** The approval OpenClaw raises for a shell command, its header built in two parts. */
const curl = `curl -H '${["Authorization", "Bearer ghp_leaked"].join(": ")}' https://api.example.test/repos`

describe("requestPreview", () => {
  it.each<[string, PendingRequest, ReturnType<typeof requestPreview>]>([
    [
      "a permission by its operation",
      {
        requestId: "r",
        kind: "permission",
        message: "Write to AGENTS.md.",
        responseSchema: { ...ENUM, title: "write AGENTS.md" },
      },
      { text: "write AGENTS.md" },
    ],
    [
      "a permission with no operation by its message",
      {
        requestId: "r",
        kind: "permission",
        message: "Run the deploy?",
        responseSchema: ENUM,
      },
      { text: "Run the deploy?" },
    ],
    [
      "an elicitation by its first question, counting the rest",
      {
        requestId: "r",
        kind: "elicitation",
        message: "3 questions require answers",
        questions: [question("Which region?"), question("Why?"), question()],
      },
      { text: "Which region?", more: 2 },
    ],
    [
      "a question with no words by its label",
      {
        requestId: "r",
        kind: "elicitation",
        questions: [question(undefined, "Region")],
      },
      { text: "Region" },
    ],
    [
      "an elicitation with no questions by its message",
      { requestId: "r", kind: "elicitation", message: "Name the branch." },
      { text: "Name the branch." },
    ],
    [
      "a shell command with its credential masked",
      { requestId: "r", kind: "permission", message: curl },
      {
        text: "curl -H '[credential redacted] https://api.example.test/repos",
      },
    ],
    [
      "a credential split by a reordering character, still masked",
      {
        requestId: "r",
        kind: "permission",
        message: "use ghp\u202E_leaked now",
      },
      { text: "use [credential redacted] now" },
    ],
    [
      "nothing at all as no preview",
      { requestId: "r", kind: "permission" },
      undefined,
    ],
  ])("previews %s", (_case, request, expected) => {
    expect(requestPreview(request)).toEqual(expected)
  })
})

describe("previewText", () => {
  it("flattens line breaks, reordering, and lone surrogates, and keeps template-like text inert", () => {
    expect(
      previewText(
        "Approve\n\n\u202Ethe $' {question}\uD800 release\u0007?  ",
        200
      )
    ).toBe("Approve the $' {question} release?")
  })

  it.each([
    ["fits", "a".repeat(200), "a".repeat(200)],
    ["one unit over", "a".repeat(201), `${"a".repeat(199)}…`],
    // 199 units would end inside a pair, so the cut backs off by one.
    ["pairs over", "\u{1F600}".repeat(150), `${"\u{1F600}".repeat(99)}…`],
    ["only whitespace", " \n\t ", undefined],
  ])("cuts to 200 UTF-16 units when the text %s", (_case, value, expected) => {
    const preview = previewText(value, 200)
    expect(preview).toBe(expected)
    expect(preview?.length ?? 0).toBeLessThanOrEqual(200)
    expect(preview?.isWellFormed() ?? true).toBe(true)
  })
})

describe("maskRequestText", () => {
  it("keeps every line and the full length, masking only the credential and reordering", () => {
    const text = `Run this:\n${curl}\n\n${"step ".repeat(100)}\u202Edone`

    expect(maskRequestText(text)).toBe(
      `Run this:\ncurl -H '[credential redacted] https://api.example.test/repos\n\n${"step ".repeat(100)}done`
    )
  })
})
