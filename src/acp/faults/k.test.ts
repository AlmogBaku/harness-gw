import { methods } from "@agentclientprotocol/sdk/experimental/v2/unstable"
import { describe, expect, it } from "vitest"

import { harness, open, SESSION, type Recorded } from "../test-harness"

const modelOptions = (entry: Recorded) =>
  JSON.stringify(entry.params).includes("config_option_update")

/** How many times the runtime was asked the Session's model options. */
function modelReads(test: Awaited<ReturnType<typeof harness>>) {
  return test.faults.calls("models").length
}

describe("membership faults", () => {
  it("gives a late joiner the model options its Session last read, without reading them again", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    await open(test)
    await test.recorder.wait(modelOptions, "the first browser's model options")
    const other = await test.connect("connection-2")
    await other.list()

    const resumed = await other.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
    })
    await other.recorder.wait(modelOptions, "the late joiner's model options")

    // Its answer carries the options the Session holds, read once for both.
    expect(resumed.configOptions).toEqual([
      expect.objectContaining({ configId: "model" }),
    ])
    expect(modelReads(test)).toBe(1)
    test.close()
    other.close()
  })
})
