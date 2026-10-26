import { describe, expect, it, vi } from "vitest"

import { SPEECH_CALL_MS } from "../../core/limits"
import {
  HermesDashboardClient,
  HermesSessionWriteRefusedError,
  type HermesDashboardHttp,
} from "./dashboard-client"
import { HermesHttpError } from "./http"

describe("Hermes dashboard client", () => {
  it("wraps the dashboard Session routes without adding adapter behavior", async () => {
    const http = vi.fn(async () => ({ ok: true }))
    const client = new HermesDashboardClient(http)

    await client.listSessions("research profile", 50, 10)
    await client.getSession("research profile", "stored/1")
    await client.getSessionMessages("research profile", "stored/1", 200, 20)

    expect(http.mock.calls).toEqual([
      [
        "/api/sessions?profile=research+profile&limit=50&offset=10&order=recent&archived=include&exclude_sources=cron%2Ctool%2Ckanban",
      ],
      ["/api/sessions/stored%2F1?profile=research%20profile"],
      [
        "/api/sessions/stored%2F1/messages?profile=research+profile&limit=200&offset=20&order=latest&include_compacted=true",
      ],
    ])
  })

  it("fences each Session write with the counters Hermes reports and a fresh request id", async () => {
    const http = vi.fn<HermesDashboardHttp>(async (path) =>
      path.includes("/mutation-snapshot")
        ? {
            session_id: "stored/1",
            exists: true,
            runtime_revision: 7,
            runtime_generation: 3,
          }
        : { ok: true }
    )
    const client = new HermesDashboardClient(http)

    await client.updateSession("research profile", "stored/1", {
      title: "Renamed",
    })
    await client.deleteSession("research profile", "stored/1")

    const [snapshot, patch, , remove] = http.mock.calls
    expect(snapshot).toEqual([
      "/api/sessions/stored%2F1/mutation-snapshot?profile=research%20profile",
    ])
    expect(patch).toEqual([
      "/api/sessions/stored%2F1?profile=research%20profile",
      {
        method: "PATCH",
        body: {
          title: "Renamed",
          profile: "research profile",
          request_id: expect.any(String),
          expected_revision: 7,
          expected_generation: 3,
        },
      },
    ])
    // A DELETE has no body, so its fence rides in the query.
    const url = new URL(remove![0], "http://hermes.test")
    expect(url.pathname).toBe("/api/sessions/stored%2F1")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      profile: "research profile",
      request_id: expect.any(String),
      expected_revision: "7",
      expected_generation: "3",
    })
    expect(remove![1]).toEqual({ method: "DELETE" })
    // Hermes refuses a reused id whose write differs.
    expect(url.searchParams.get("request_id")).not.toBe(
      (patch![1]!.body as { request_id: string }).request_id
    )
  })

  it("sends no write to a Session gone since it was read", async () => {
    const http = vi.fn(async () => ({
      session_id: "stored/1",
      exists: false,
      runtime_revision: 0,
      runtime_generation: null,
    }))
    const client = new HermesDashboardClient(http)

    await expect(
      client.deleteSession("research profile", "stored/1")
    ).rejects.toMatchObject({ status: 404 })
    expect(http).toHaveBeenCalledTimes(1)
  })

  it("tells a write Hermes refuses for a Session it holds apart from a gone Session", async () => {
    const http = vi.fn<HermesDashboardHttp>(async (path) => {
      if (path.includes("/mutation-snapshot"))
        return { exists: true, runtime_revision: 0, runtime_generation: 0 }
      throw new HermesHttpError(404)
    })
    const client = new HermesDashboardClient(http)

    await expect(
      client.updateSession("research profile", "stored/1", { pinned: true })
    ).rejects.toBeInstanceOf(HermesSessionWriteRefusedError)
  })

  it("wraps artifact and native audio routes with response bounds", async () => {
    const http = vi.fn(async () => ({ ok: true }))
    const client = new HermesDashboardClient(http)

    await client.readArtifactDataUrl(
      "research profile",
      "stored/1",
      "reports/result.txt",
      123
    )
    await client.getAudioConfig("research profile", "stt", 234)
    await client.transcribe(
      "research profile",
      { data_url: "data:audio/wav;base64,YQ==", mime_type: "audio/wav" },
      345
    )
    await client.speak("research profile", "hello", 456)

    expect(http.mock.calls).toEqual([
      [
        "/api/fs/read-data-url?path=reports%2Fresult.txt&profile=research+profile&session_id=stored%2F1",
        { maxResponseBytes: 123 },
      ],
      [
        "/api/tools/toolsets/stt/config?profile=research+profile",
        { maxResponseBytes: 234 },
      ],
      [
        "/api/audio/transcribe?profile=research+profile",
        {
          method: "POST",
          body: {
            data_url: "data:audio/wav;base64,YQ==",
            mime_type: "audio/wav",
          },
          maxResponseBytes: 345,
        },
      ],
      [
        "/api/audio/speak?profile=research+profile",
        {
          method: "POST",
          body: { text: "hello" },
          maxResponseBytes: 456,
          // Synthesis renders the whole answer before Hermes replies.
          timeoutMs: SPEECH_CALL_MS,
        },
      ],
    ])
  })
})
