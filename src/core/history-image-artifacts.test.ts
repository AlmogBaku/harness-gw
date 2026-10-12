// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import type { SessionMessage } from "../../protocol"
import { useFakeClock } from "../../test/support/fake-clock"
import { artifactIds } from "../../test/support/history-artifacts"
import { withHistoryImageArtifacts } from "./history-image-artifacts"
import * as ids from "./ids"
import type { ServerRuntime } from "./runtime"

const AGENT = "researcher"
const STORED = ids.providerSessionId("stored-1")
const PNG = "data:image/png;base64,iVBORw0KGgo="
const PNG_BYTES = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

function userMessage(
  id: string,
  content: SessionMessage["content"]
): SessionMessage {
  return { id, role: "user", content, createdAt: "2026-10-13T09:00:00.000Z" }
}

/**
 * A runtime holding `messages`, oldest first, one to a page as a provider may
 * page them.
 */
function nativeRuntime(messages: SessionMessage[]) {
  const history = vi.fn<ServerRuntime["history"]>(
    async (_agentId, providerSessionId, limit, offset) => ({
      sessionId: providerSessionId,
      messages: messages.slice(
        Math.max(0, messages.length - offset - 1),
        Math.max(0, messages.length - offset)
      ),
      total: messages.length,
      limit,
      offset,
      nextOffset: Math.min(offset + 1, messages.length),
    })
  )
  const native = {
    history,
    resolveProviderSessionId: (_agentId: string, publicSessionId: string) =>
      ids.providerSessionId(publicSessionId),
    publicError: () => undefined,
  } as unknown as ServerRuntime
  return { native, history }
}

describe("withHistoryImageArtifacts", () => {
  it("replays each stored data-URL image as an Artifact whose id no message id moves", async () => {
    const message = userMessage("hermes-history-0", [
      { type: "text", text: "Compare these" },
      { type: "image", image: PNG, filename: "chart.png" },
      { type: "image", image: PNG },
      { type: "image", image: "data:image/svg+xml;base64,PHN2Zy8+" },
    ])
    const messages = [message]
    const runtime = withHistoryImageArtifacts(nativeRuntime(messages).native)

    const page = await runtime.history(AGENT, STORED, 50, 0)

    const [named, unnamed, untyped] = artifactIds(page)
    expect(page.messages).toEqual([
      {
        ...message,
        content: [
          { type: "text", text: "Compare these" },
          ...[
            { id: named, filename: "chart.png", mimeType: "image/png" },
            { id: unnamed, filename: "image.png", mimeType: "image/png" },
          ].map((artifact) => ({
            type: "data",
            name: "hgw.artifact",
            data: {
              ...artifact,
              sizeBytes: PNG_BYTES.length,
              source: { type: "provider", reference: artifact.id },
            },
          })),
          // A type outside the image allowlist is served as bytes alone.
          {
            type: "data",
            name: "hgw.artifact",
            data: {
              id: untyped,
              filename: "image",
              sizeBytes: 6,
              source: { type: "provider", reference: untyped },
            },
          },
        ],
      },
    ])
    expect(named).toMatch(/^hgw-image-[a-f0-9]{32}$/u)
    // Two equal images of one message stay two Artifacts.
    expect(unnamed).not.toBe(named)
    expect(JSON.stringify(page)).not.toContain("base64")

    // A row's positional id moves as rows arrive; its images' ids do not.
    messages[0] = { ...message, id: "hermes-history-1" }
    expect(artifactIds(await runtime.history(AGENT, STORED, 50, 0))).toEqual([
      named,
      unnamed,
      untyped,
    ])
  })

  it("reads a placed image's page once for every image on it, under whatever id its message returns", async () => {
    const message = userMessage("hermes-history-0", [
      { type: "image", image: PNG, filename: "chart.png" },
      { type: "image", image: "data:image/gif;base64,R0lG" },
    ])
    const messages = [message]
    const { native, history } = nativeRuntime(messages)
    const runtime = withHistoryImageArtifacts(native)
    const [chart, gif] = artifactIds(
      await runtime.history(AGENT, STORED, 50, 0)
    )
    messages[0] = { ...message, id: "hermes-history-1" }
    history.mockClear()

    await expect(
      Promise.all([
        runtime.artifact(AGENT, STORED, chart!),
        runtime.artifact(AGENT, STORED, gif!),
      ])
    ).resolves.toEqual([
      { bytes: PNG_BYTES, mimeType: "image/png", filename: "chart.png" },
      {
        bytes: Uint8Array.of(0x47, 0x49, 0x46),
        mimeType: "image/gif",
        filename: "image.gif",
      },
    ])
    expect(history).toHaveBeenCalledOnce()
    expect(history).toHaveBeenCalledWith(AGENT, STORED, 50, 0)
  })

  it("looks for an id it cannot place on the newest pages alone, and answers one they lack as gone until the miss ages", async () => {
    const clock = useFakeClock()
    const { native, history } = nativeRuntime([
      userMessage("u0", [
        { type: "image", image: "data:image/gif;base64,R0lG" },
      ]),
      userMessage("u1", [{ type: "image", image: PNG, filename: "near.png" }]),
      userMessage("u2", [{ type: "text", text: "Newest" }]),
    ])
    const [beyond] = artifactIds(
      await withHistoryImageArtifacts(native).history(AGENT, STORED, 1, 2)
    )
    const [near] = artifactIds(
      await withHistoryImageArtifacts(native).history(AGENT, STORED, 1, 1)
    )
    // A restarted gateway has placed nothing yet.
    const runtime = withHistoryImageArtifacts(native, { scanPages: 2 })
    history.mockClear()

    await expect(runtime.artifact(AGENT, STORED, near!)).resolves.toMatchObject(
      { filename: "near.png" }
    )
    const missed = () =>
      runtime.artifact(AGENT, STORED, beyond!).catch((error: unknown) => error)
    expect(runtime.publicError(await missed())).toMatchObject({
      kind: "gone",
      code: "not_found",
    })
    expect(history.mock.calls.map(([, , , offset]) => offset)).toEqual([
      0, 1, 0, 1,
    ])

    history.mockClear()
    await missed()
    expect(history).not.toHaveBeenCalled()

    await clock.advance(30_000)
    await missed()
    expect(history).toHaveBeenCalledTimes(2)
  })
})
