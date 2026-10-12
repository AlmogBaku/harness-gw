import { buildPushPayload } from "@block65/webcrypto-web-push"

import type { PushMessage, PushRegistration } from "../../protocol/push"
import {
  parsePushEndpoint,
  resolvePublicAddresses,
  type PushHostLookup,
} from "./endpoint"

/** How long a push service may hold an undelivered message. */
const TTL_SECONDS = 3_600

/** Input needs answering now; a finished run can wait behind the screen lock. */
export type PushUrgency = "normal" | "high"

export type PushSendResult = {
  result: "sent" | "gone" | "failed"
  /** The push service's status, when it answered with one. */
  status?: number
}

/** What one device the proxy sends to is addressed by. */
export type PushTarget = Pick<PushRegistration, "subscription">

export interface PushSender {
  send(
    target: PushTarget,
    message: PushMessage,
    urgency: PushUrgency
  ): Promise<PushSendResult>
}

const encoder = new TextEncoder()

/** The key every topic is an HMAC under, derived from the VAPID private key. */
export async function deriveTopicKey(privateKey: Uint8Array) {
  const material = await crypto.subtle.importKey(
    "raw",
    privateKey,
    "HKDF",
    false,
    ["deriveKey"]
  )
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: encoder.encode("harness-gw push topic v1"),
    },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"]
  )
}

/**
 * The topic a push service collapses one Session's undelivered messages by,
 * so the newest replaces the rest. It is keyed, so the vendor cannot match it
 * against ids it guesses, and cut to the 32 characters a topic may hold.
 */
export async function topicFor(
  key: CryptoKey,
  agentId: string,
  sessionId: string
) {
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(JSON.stringify([agentId, sessionId]))
  )
  return Buffer.from(mac).toString("base64url").slice(0, 32)
}

/**
 * The encryptor's plaintext limit: one 4096-byte record, less its header, the
 * padding delimiter, and the authentication tag.
 */
const MAX_PLAINTEXT_BYTES = 3_993

/** What a message past the limit gives up, in order; the ids always travel. */
const DROP_ORDER: readonly (readonly string[])[] = [
  ["requestText", "requestMore"],
  ["sessionTitle"],
  ["agentName"],
]

/** `message` with as little of its text dropped as one record needs. */
export function fitPushMessage(message: PushMessage): PushMessage {
  return DROP_ORDER.reduce(
    (fitted, fields) =>
      encoder.encode(JSON.stringify(fitted)).byteLength <= MAX_PLAINTEXT_BYTES
        ? fitted
        : (Object.fromEntries(
            Object.entries(fitted).filter(([field]) => !fields.includes(field))
          ) as PushMessage),
    message
  )
}

/** Just enough of `fetch` to post one encrypted message. */
export type PushFetch = (
  endpoint: string,
  init: {
    method: string
    headers: Record<string, string>
    body: Uint8Array
    redirect: "error"
  }
) => Promise<{ ok: boolean; status: number }>

export type PushSenderOptions = {
  vapid: {
    /** `mailto:` or `https:` contact a push service can reach an operator at. */
    subject: string
    /** The 87-character raw point derived from the private scalar. */
    publicKey: string
    privateKey: Uint8Array
  }
  fetch?: PushFetch
  lookup?: PushHostLookup
}

/** A status a push service uses to say this device is no longer subscribed. */
const GONE_STATUSES = [404, 410]

/**
 * Sends one encrypted message to one device, fitted to one record and padded
 * to its size. Every failure is a result rather than a throw, and nothing
 * derived from the endpoint, the message, or the topic reaches a caller: a
 * dispatcher logs counts, and the device either stays or is dropped.
 */
export function createPushSender({
  vapid,
  fetch: post = globalThis.fetch,
  lookup,
}: PushSenderOptions): PushSender {
  const credentials = {
    subject: vapid.subject,
    publicKey: vapid.publicKey,
    privateKey: Buffer.from(vapid.privateKey).toString("base64url"),
  }
  /** Derived once, by the first send, so a failure is a result and never a throw. */
  let topicKey: Promise<CryptoKey> | undefined

  return {
    async send({ subscription }, message, urgency) {
      try {
        const endpoint = parsePushEndpoint(subscription.endpoint)
        await resolvePublicAddresses(endpoint.hostname, lookup)
        topicKey ??= deriveTopicKey(vapid.privateKey)
        const topic = await topicFor(
          await topicKey,
          message.agentId,
          message.sessionId
        )
        const payload = await buildPushPayload(
          {
            data: fitPushMessage(message),
            options: { ttl: TTL_SECONDS, urgency, topic },
          },
          {
            endpoint: subscription.endpoint,
            expirationTime: subscription.expirationTime ?? null,
            keys: subscription.keys,
          },
          credentials
        )
        const response = await post(subscription.endpoint, {
          ...payload,
          redirect: "error",
        })
        if (response.ok) return { result: "sent" }
        return {
          result: GONE_STATUSES.includes(response.status) ? "gone" : "failed",
          status: response.status,
        }
      } catch {
        // A refused endpoint, an encryption failure, and a transport failure are
        // the same thing to a caller: this message did not reach this device.
        return { result: "failed" }
      }
    },
  }
}
