import { AGENT_METHODS, agent } from "@agentclientprotocol/sdk/experimental/v2"
import { afterEach, describe, expect, it } from "bun:test"
import { request } from "node:http"
import { connect } from "node:net"

import { HGW_ACP_PATH } from "../protocol/acp"
import { createAcpService } from "./acp/service"
import type { AcpConnectionContext, ActivityFeed, ReadState } from "./acp/types"
import { OPERATOR_PRINCIPAL } from "./core/principal"
import { heldBody } from "./routes/file-reads"
import { startGatewayServer } from "./server"

const ORIGIN = "https://aos.example.test"
const lifecycles: Array<ReturnType<typeof startGatewayServer>> = []

afterEach(async () => {
  await Promise.all(lifecycles.splice(0).map(({ shutdown }) => shutdown()))
})

function portOf(lifecycle: ReturnType<typeof startGatewayServer>) {
  return (lifecycle.server as unknown as { port: number }).port
}

function connectionContext(
  connectionId: string,
  principalId: string
): AcpConnectionContext {
  return {
    connectionId,
    principalId,
    role: "operator",
    publicError: () => undefined,
    catalog: {} as AcpConnectionContext["catalog"],
    readState: {} as ReadState,
    activityFeed: {} as ActivityFeed,
    translators: {} as AcpConnectionContext["translators"],
    channels: {} as AcpConnectionContext["channels"],
    attachmentStages: {} as AcpConnectionContext["attachmentStages"],
    logger: {} as AcpConnectionContext["logger"],
  }
}

/** A spec-only ACP agent app: it answers `initialize` and nothing else. */
function initializeOnlyAgent() {
  return agent({ name: "spec" }).onRequest(AGENT_METHODS.initialize, () => ({
    protocolVersion: 2,
    info: { name: "spec", version: "0" },
  }))
}

function acpGateway(handshakeDeadlineMs?: number) {
  const lifecycle = startGatewayServer({
    app: { fetch: () => new Response("not found", { status: 404 }) },
    origins: { allowedOrigins: [ORIGIN] },
    sockets: [
      {
        path: HGW_ACP_PATH,
        service: createAcpService({
          role: "operator",
          principalId: OPERATOR_PRINCIPAL,
          agent: initializeOnlyAgent,
          connection: connectionContext,
          handshakeDeadlineMs,
        }),
      },
    ],
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 1_000,
    installSignalHandlers: false,
  })
  lifecycles.push(lifecycle)
  return lifecycle
}

describe("real Bun WebSocket upgrade", () => {
  it("refuses a foreign Origin before upgrade, sends frames, and cleans up on peer close", async () => {
    let opened = 0
    let closed = 0
    let resolveClosed!: () => void
    const peerClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    const lifecycle = startGatewayServer({
      app: { fetch: () => new Response("not found", { status: 404 }) },
      origins: { allowedOrigins: [ORIGIN] },
      sockets: [
        {
          path: HGW_ACP_PATH,
          service: {
            // Admits any upgrade, so only the listener's own check refuses one.
            authorizeUpgrade: async () => ({
              principalId: "operator",
              connectionId: "connection-1",
            }),
            open: (_authorization, peer) => {
              opened += 1
              peer.send(JSON.stringify({ jsonrpc: "2.0", method: "opened" }))
              return {
                async receive(raw) {
                  if (raw === "notify")
                    peer.send(
                      JSON.stringify({ jsonrpc: "2.0", method: "notified" })
                    )
                },
                close() {
                  closed += 1
                  resolveClosed()
                },
              }
            },
          },
        },
      ],
      host: "127.0.0.1",
      port: 0,
      shutdownGraceMs: 1_000,
      installSignalHandlers: false,
    })
    lifecycles.push(lifecycle)
    const port = portOf(lifecycle)

    // A plain request is no WebSocket handshake.
    const denied = await fetch(`http://127.0.0.1:${port}${HGW_ACP_PATH}`)
    expect(denied.status).toBe(400)
    expect(opened).toBe(0)

    const foreign = new WebSocket(`ws://127.0.0.1:${port}${HGW_ACP_PATH}`, {
      headers: { Origin: "https://attacker.example.test" },
    })
    await new Promise<void>((resolve) => {
      foreign.addEventListener("open", () => resolve())
      foreign.addEventListener("error", () => resolve())
    })
    expect(foreign.readyState).not.toBe(WebSocket.OPEN)
    expect(opened).toBe(0)

    const frames: unknown[] = []
    const socket = new WebSocket(`ws://127.0.0.1:${port}${HGW_ACP_PATH}`, {
      headers: { Origin: ORIGIN },
    })
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        frames.push(JSON.parse(String(event.data)))
        if (frames.length === 1) socket.send("notify")
        if (frames.length === 2) resolve()
      })
      socket.addEventListener("error", reject)
    })

    expect(frames).toEqual([
      { jsonrpc: "2.0", method: "opened" },
      { jsonrpc: "2.0", method: "notified" },
    ])
    expect(opened).toBe(1)
    socket.close()
    await peerClosed
    expect(closed).toBe(1)
  })

  it("answers an ACP initialize first frame over the hosted socket", async () => {
    const port = portOf(acpGateway())

    // A plain request is no WebSocket handshake.
    const denied = await fetch(`http://127.0.0.1:${port}${HGW_ACP_PATH}`)
    expect(denied.status).toBe(400)

    const socket = new WebSocket(`ws://127.0.0.1:${port}${HGW_ACP_PATH}`, {
      headers: { Origin: ORIGIN },
    })
    const frames: unknown[] = []
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () =>
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: 2,
              info: { name: "spec-client", version: "0" },
            },
          })
        )
      )
      socket.addEventListener("message", (event) => {
        frames.push(JSON.parse(String(event.data)))
        resolve()
      })
      socket.addEventListener("error", reject)
    })

    expect(frames[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 2, info: { name: "spec", version: "0" } },
    })
    socket.close()
  })

  it("carries the ACP connection id on the 101 response", async () => {
    const port = portOf(acpGateway())

    const switching = await new Promise<{
      status: number | undefined
      headers: Record<string, string | string[] | undefined>
    }>((resolve, reject) => {
      const upgrade = request({
        hostname: "127.0.0.1",
        port,
        path: HGW_ACP_PATH,
        headers: {
          Origin: ORIGIN,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      })
      const settle = (
        response: {
          statusCode?: number | undefined
          headers: Record<string, string | string[] | undefined>
        },
        peer?: { destroy(): void }
      ) => {
        peer?.destroy()
        resolve({ status: response.statusCode, headers: response.headers })
      }
      upgrade.on("upgrade", (response, peer) => settle(response, peer))
      upgrade.on("response", (response) => settle(response))
      upgrade.on("error", reject)
      upgrade.end()
    })

    expect(switching.status).toBe(101)
    expect(switching.headers["acp-connection-id"]).toMatch(/^[0-9a-f-]{36}$/u)
  })
  it("closes a socket that never sends initialize with 4408 at the handshake deadline", async () => {
    const port = portOf(acpGateway(100))
    const socket = new WebSocket(`ws://127.0.0.1:${port}${HGW_ACP_PATH}`, {
      headers: { Origin: ORIGIN },
    })
    const code = await new Promise<number>((resolve, reject) => {
      socket.addEventListener("close", (event) => resolve(event.code))
      socket.addEventListener("error", reject)
    })
    expect(code).toBe(4408)
  })
})

/** Polls `done` every 20 ms for at most 5 s. */
async function until(done: () => boolean) {
  for (let waited = 0; !done() && waited < 5_000; waited += 20)
    await new Promise((resolve) => setTimeout(resolve, 20))
}

describe("a held file answer through the real Bun server", () => {
  /** Far more than the socket buffers between Bun and a stalled reader. */
  const TOTAL = 16 * 1024 * 1024

  it.each(["reads the rest", "goes away"] as const)(
    "keeps its turn while its reader stalls, and gives it back once the reader %s",
    async (ending) => {
      let released = 0
      let pulled = 0
      const lifecycle = startGatewayServer({
        app: {
          fetch: () => {
            const body = heldBody(new Uint8Array(TOTAL), {
              signal: new AbortController().signal,
              release: () => (released += 1),
            }).getReader()
            // Counts what Bun pulls, one pull of the held body for each.
            const counted = new ReadableStream<Uint8Array>(
              {
                async pull(controller) {
                  const { done, value } = await body.read()
                  if (done) return controller.close()
                  pulled += value.byteLength
                  controller.enqueue(value)
                },
                cancel: (reason) => body.cancel(reason),
              },
              { highWaterMark: 0 }
            )
            return new Response(counted)
          },
        },
        origins: { allowedOrigins: [ORIGIN] },
        host: "127.0.0.1",
        port: 0,
        shutdownGraceMs: 1_000,
        installSignalHandlers: false,
      })
      lifecycles.push(lifecycle)
      const port = portOf(lifecycle)
      const socket = connect(port, "127.0.0.1")
      let received = 0
      const first = new Promise<void>((resolve) =>
        socket.once("data", (chunk) => {
          received += chunk.length
          socket.pause()
          resolve()
        })
      )
      socket.write(
        `GET /api/v1/file HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`
      )
      await first

      // Bun pulls only as the socket drains, so its pulls stop, for ten polls
      // in a row, well short of the whole answer, and the turn stays held.
      let seen = -1
      let quiet = 0
      await until(() => {
        quiet = pulled === seen ? quiet + 1 : 0
        seen = pulled
        return quiet >= 10
      })
      expect(pulled).toBeLessThan(TOTAL)
      expect(released).toBe(0)
      if (ending === "reads the rest") {
        socket.on("data", (chunk) => (received += chunk.length))
        socket.resume()
      } else socket.destroy()
      await until(() => released > 0)

      expect(released).toBe(1)
      if (ending === "reads the rest") {
        await until(() => received > TOTAL)
        expect(received).toBeGreaterThan(TOTAL)
      }
      socket.destroy()
    }
  )
})
