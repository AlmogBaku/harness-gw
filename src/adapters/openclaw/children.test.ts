import { describe, expect, it } from "vitest"

import {
  childRowStatus,
  keyAgentId,
  spawnFacts,
  spawnedChild,
} from "./children"

const CHILD = "agent:research:subagent:3f0c"

describe("OpenClaw child Sessions", () => {
  it("reads the child a spawn result names, from its details or its JSON text", () => {
    const accepted = { status: "accepted", childSessionKey: CHILD, runId: "r1" }

    expect(spawnedChild({ content: [], details: accepted })).toEqual({
      key: CHILD,
      runId: "r1",
    })
    expect(
      spawnedChild({
        content: [{ type: "text", text: JSON.stringify(accepted) }],
      })
    ).toEqual({ key: CHILD, runId: "r1" })
    expect(
      spawnedChild({ status: "accepted", childSessionKey: CHILD })
    ).toEqual({ key: CHILD })
  })

  it("reads no child from a spawn OpenClaw refused or a result naming none", () => {
    expect(
      spawnedChild({ details: { status: "forbidden", childSessionKey: CHILD } })
    ).toBeUndefined()
    expect(
      spawnedChild({ details: { status: "accepted", childSessionKey: "" } })
    ).toBeUndefined()
    expect(spawnedChild({ content: [{ type: "text", text: "{" }] })).toBe(
      undefined
    )
    expect(spawnedChild("accepted")).toBeUndefined()
  })

  it("names the Agent a Session key belongs to", () => {
    expect(keyAgentId(CHILD)).toBe("research")
    expect(keyAgentId("main")).toBeUndefined()
  })

  it("announces a child by its spawn's label or task, its goal, and its model", () => {
    expect(
      spawnFacts({
        task: "  Count the names.  ",
        label: "Counter",
        model: "m1",
      })
    ).toEqual({
      title: "Counter",
      description: "Count the names.",
      model: "m1",
    })
    expect(spawnFacts({ task: "Count the names." })).toEqual({
      title: "Count the names.",
      description: "Count the names.",
    })
    expect(spawnFacts({ task: 7, model: "" })).toEqual({})
  })

  it("reads a child row's status as its state", () => {
    expect(
      [
        "queued",
        "running",
        "done",
        "failed",
        "timeout",
        "interrupted",
        "killed",
      ].map(childRowStatus)
    ).toEqual([
      "running",
      "running",
      "idle",
      "failed",
      "failed",
      "cancelled",
      "cancelled",
    ])
    expect(childRowStatus(undefined)).toBeUndefined()
  })
})
