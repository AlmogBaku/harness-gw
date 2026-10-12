// @vitest-environment node

import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  type webcrypto,
} from "node:crypto"

type JsonWebKey = webcrypto.JsonWebKey
import { beforeAll, describe, expect, it, vi } from "vitest"

import type { PushMessage } from "../../protocol/push"
import {
  createPushSender,
  deriveTopicKey,
  fitPushMessage,
  topicFor,
  type PushFetch,
  type PushSenderOptions,
  type PushTarget,
} from "./sender"
import { deriveVapidPublicKey } from "./vapid"

/** The P-256 scalar of a freshly generated pair; no key is ever committed. */
function privateScalar() {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  })
  const { d } = privateKey.export({ format: "jwk" }) as JsonWebKey
  return new Uint8Array(Buffer.from(d ?? "", "base64url"))
}

let vapid: PushSenderOptions["vapid"]
let target: PushTarget

beforeAll(() => {
  const serverKey = privateScalar()
  vapid = {
    subject: "mailto:ops@example.test",
    publicKey: deriveVapidPublicKey(serverKey),
    privateKey: serverKey,
  }
  target = {
    subscription: {
      endpoint: "https://push.example/subscription-id",
      keys: {
        p256dh: deriveVapidPublicKey(privateScalar()),
        auth: randomBytes(16).toString("base64url"),
      },
    },
  }
})

const MESSAGE: PushMessage = {
  v: 2,
  category: "input",
  agentId: "researcher",
  sessionId: "session-1",
  occurredAt: "2026-09-20T10:00:00.000Z",
  locale: "en",
}

const publicLookup = vi.fn(async () => [{ address: "8.8.8.8" }])

function sender(post: PushFetch) {
  return createPushSender({ vapid, fetch: post, lookup: publicLookup })
}

function accepting(status: number) {
  return vi.fn<PushFetch>(async () => ({ ok: status < 300, status }))
}

describe("push sender", () => {
  it("reports an accepted message as sent, with the options a push service reads", async () => {
    const post = accepting(201)

    await expect(sender(post).send(target, MESSAGE, "high")).resolves.toEqual({
      result: "sent",
    })

    expect(post).toHaveBeenCalledOnce()
    const [endpoint, init] = post.mock.calls[0]!
    expect(endpoint).toBe(target.subscription.endpoint)
    expect(init.method).toBe("post")
    expect(init.redirect).toBe("error")
    expect(init.headers).toMatchObject({
      ttl: "3600",
      urgency: "high",
      topic: await topicFor(
        await deriveTopicKey(vapid.privateKey),
        MESSAGE.agentId,
        MESSAGE.sessionId
      ),
      "content-encoding": "aes128gcm",
    })
    // The vendor pads every message to one size, so nothing about the
    // notification leaks through its length.
    expect(init.body.byteLength).toBe(4_096)
  })

  it("reports an unsubscribed device as gone and any other status as failed", async () => {
    await expect(
      sender(accepting(404)).send(target, MESSAGE, "high")
    ).resolves.toEqual({ result: "gone", status: 404 })
    await expect(
      sender(accepting(410)).send(target, MESSAGE, "high")
    ).resolves.toEqual({ result: "gone", status: 410 })
    await expect(
      sender(accepting(500)).send(target, MESSAGE, "normal")
    ).resolves.toEqual({ result: "failed", status: 500 })
  })

  it("reports a transport that throws as failed, without rethrowing", async () => {
    const post = vi.fn<PushFetch>(async () => {
      throw new Error(`redirected to ${target.subscription.endpoint}`)
    })

    await expect(sender(post).send(target, MESSAGE, "high")).resolves.toEqual({
      result: "failed",
    })
  })

  it("never posts to an endpoint that resolves inside the deployment", async () => {
    const post = accepting(201)
    const privateSender = createPushSender({
      vapid,
      fetch: post,
      lookup: vi.fn(async () => [{ address: "10.0.0.5" }]),
    })

    await expect(privateSender.send(target, MESSAGE, "high")).resolves.toEqual({
      result: "failed",
    })
    expect(post).not.toHaveBeenCalled()
  })

  it("never posts to an endpoint that is not a public https URL", async () => {
    const post = accepting(201)

    await expect(
      sender(post).send(
        {
          subscription: {
            ...target.subscription,
            endpoint: "http://push.example/x",
          },
        },
        MESSAGE,
        "high"
      )
    ).resolves.toEqual({ result: "failed" })
    expect(post).not.toHaveBeenCalled()
  })

  it("fits the largest message the contract allows into one record, dropping its request first", async () => {
    const post = accepting(201)
    // A lone surrogate is JSON-escaped to six bytes; an emoji is four bytes in two units.
    const id = "\uD800".repeat(256)
    const wide = (units: number) => "\u{1F600}".repeat(units / 2)
    const largest: PushMessage = {
      ...MESSAGE,
      agentId: id,
      sessionId: id,
      agentName: wide(64),
      sessionTitle: wide(120),
      requestText: wide(200),
      requestMore: 7,
    }
    const fitted: PushMessage = { ...largest }
    delete fitted.requestText
    delete fitted.requestMore

    expect(fitPushMessage(largest)).toStrictEqual(fitted)
    expect(fitPushMessage(MESSAGE)).toStrictEqual(MESSAGE)
    await expect(sender(post).send(target, largest, "high")).resolves.toEqual({
      result: "sent",
    })
    expect(post.mock.calls[0]![1].body.byteLength).toBe(4_096)
  })

  it("derives one keyed topic per Session that names neither id", async () => {
    const key = await deriveTopicKey(vapid.privateKey)
    const topic = await topicFor(key, "researcher", "session-1")

    expect(topic).toMatch(/^[\w-]{32}$/u)
    expect(await topicFor(key, "researcher", "session-1")).toBe(topic)
    expect(await topicFor(key, "researcher", "session-2")).not.toBe(topic)
    expect(
      await topicFor(
        await deriveTopicKey(privateScalar()),
        "researcher",
        "session-1"
      )
    ).not.toBe(topic)
    const unkeyed = createHash("sha256")
      .update(JSON.stringify(["researcher", "session-1"]))
      .digest("base64url")
      .slice(0, 32)
    expect(topic).not.toBe(unkeyed)
    expect(topic).not.toContain("researcher")
    expect(topic).not.toContain("session-1")
  })
})
