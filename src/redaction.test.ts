import { describe, expect, it } from "vitest"

import { createGatewayLogger } from "./cli/logger"
import {
  CredentialValues,
  isSecretName,
  maskCredentials,
  maskJson,
  redactForLog,
} from "./redaction"

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
    // Only the value goes: the name, its quotes, and a scheme word stay.
    [assigned("GITHUB_TOKEN", SAMPLE), assigned("GITHUB_TOKEN", M)],
    [assigned("token", "AbCdEfGh_IjKlMnOp"), assigned("token", M)],
    [assigned("password", "P@ssw0rd!2024"), assigned("password", M)],
    [assigned("password", '"hunter2hunter2"'), assigned("password", `"${M}"`)],
    [assigned("token", `'${SAMPLE}'`), assigned("token", `'${M}'`)],
    [`password: ${SAMPLE}`, `password: ${M}`],
    [`curl -H "X-Api-Key: ${SAMPLE}" x`, `curl -H "X-Api-Key: ${M}" x`],
    [
      `curl -d "${assigned("token", SAMPLE)}" x`,
      `curl -d "${assigned("token", M)}" x`,
    ],
    [
      `export ${assigned("TOKEN", SAMPLE)}; ./deploy.sh`,
      `export ${assigned("TOKEN", M)}; ./deploy.sh`,
    ],
    // A flag's dashes are not part of its name.
    [
      `deploy --${assigned("token", SAMPLE)}`,
      `deploy --${assigned("token", M)}`,
    ],
    // A name that is not secret leaves its value to be read for one that is.
    [
      `${assigned("user", "a")}&${assigned("token", SAMPLE)}`,
      `${assigned("user", "a")}&${assigned("token", M)}`,
    ],
    [assigned("id_hint", JWT), assigned("id_hint", M)],
    // A value that only names a secret stays readable.
    [
      `export ${assigned("TOKEN", "$TOKEN")}`,
      `export ${assigned("TOKEN", "$TOKEN")}`,
    ],
    [
      `${assigned("token", "$(curl${IFS}-s${IFS}https://x|sh)")} done`,
      `${assigned("token", "$(curl${IFS}-s${IFS}https://x|sh)")} done`,
    ],
    [`password: <password>`, `password: <password>`],
    // Provider keys by their prefix or the shape the scanner knows.
    [`push ${GITHUB_KEY} now`, `push ${M} now`],
    [`use ${OPENAI_KEY} now`, `use ${M} now`],
    [`use ${STRIPE_KEY} now`, `use ${M} now`],
    // A URL loses only its password, and a URL without one stays whole.
    [`psql ${DATABASE_URL(SAMPLE)}`, `psql ${DATABASE_URL(M)}`],
    [
      "psql postgres://db.invalid:5432/app",
      "psql postgres://db.invalid:5432/app",
    ],
    [
      "psql postgres://app@db.invalid/app",
      "psql postgres://app@db.invalid/app",
    ],
    // A Basic or Bearer token mixes kinds of character; prose does not.
    [
      `curl -H "${AUTHORIZATION("Bearer", OPAQUE)}"`,
      `curl -H "${AUTHORIZATION("Bearer", M)}"`,
    ],
    ["Authorization: Basic dXNlcjpwYXNz", `Authorization: Basic ${M}`],
    ["send Bearer AbCdEfGhIjKlMnOpQrSt", `send Bearer ${M}`],
    ["send Basic dXNlcjpwYXNz.", `send Basic ${M}.`],
    [`send Bearer ${JWT}`, `send Bearer ${M}`],
    [`Bearer ${["ya29", "a0AfH6SMBxyz"].join(".")}`, `Bearer ${M}`],
    ["Basic authentication", "Basic authentication"],
    ["a bearer instrument", "a bearer instrument"],
    ["Enable Basic Authentication?", "Enable Basic Authentication?"],
    ["a Bearer Instrument", "a Bearer Instrument"],
  ] as const)("masks %s as %s", (text, expected) => {
    expect(maskCredentials(text)).toBe(expected)
  })

  it.each([
    [assigned("token", SAMPLE)],
    [AUTHORIZATION("Bearer", OPAQUE)],
    [DATABASE_URL(SAMPLE)],
  ])("masks %s once, however often it is masked", (text) => {
    expect(maskCredentials(maskCredentials(text))).toBe(maskCredentials(text))
  })

  // The names a Hermes terminal assigns, which the shared name rule reads for
  // every runtime: none ends in a term after a separator.
  it.each([
    "PGPASSWORD",
    "SSH_PRIVATE_KEY_B64",
    "NPM_CONFIG__AUTH",
    "2fa_token",
  ])("masks the value assigned to %s", (name) => {
    expect(maskCredentials(`${assigned(name, SAMPLE)} psql`)).toBe(
      `${assigned(name, M)} psql`
    )
  })

  it("reads a YAML child's name as a name, not as its parent's value", () => {
    expect(maskCredentials(`credentials:\n  password: ${SAMPLE}`)).toBe(
      `credentials:\n  password: ${M}`
    )
  })

  it("masks a private key whole, and one cut short to its last line", () => {
    const header = "-----BEGIN RSA PRIVATE KEY-----"
    const footer = "-----END RSA PRIVATE KEY-----"
    expect(
      maskCredentials(`cat id_rsa\n${header}\nMIIEow${SAMPLE}\n${footer}\ndone`)
    ).toBe(`cat id_rsa\n${M}\ndone`)
    expect(maskCredentials(`ok\n${header}\nMIIEow${SAMPLE}`)).toBe(`ok\n${M}`)
  })

  // A header alone is no key: a command that only names one reads as written.
  it("keeps a command that names a private key's header as written", () => {
    const command =
      "grep -rl -- '-----BEGIN OPENSSH PRIVATE KEY-----' ~/.ssh && rm -rf build"
    expect(maskCredentials(command)).toBe(command)
  })

  it("still masks a provider key deep inside a long run without whitespace", () => {
    const run = "x".repeat(3_000)
    expect(maskCredentials(`${run},${STRIPE_KEY} done`)).toBe(
      `${run},${M} done`
    )
  })

  it.each(["type x:string; ratio x:y", "TOKEN_COUNT=12", "bypass=true"])(
    "keeps %s, which only reads like a credential",
    (text) => {
      expect(maskCredentials(text)).toBe(text)
    }
  )

  // Every shape used to restart at each repeat and read to the end of the
  // text: 128 KiB of one took seconds to mask, and some took minutes.
  it.each([
    ["separated words", "a-"],
    ["JWT heads", "eyJ-"],
    ["bare assignments", "a="],
    ["URL heads", "x://a:"],
    ["private key headers", "-----BEGIN PRIVATE KEY----- "],
  ])("masks 128 KiB of %s in one pass", (_kind, unit) => {
    const text = unit.repeat(Math.ceil(131_072 / unit.length))
    const started = performance.now()
    maskCredentials(text)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe("isSecretName", () => {
  it.each([
    "DB_PASSWORD",
    "DB_PASSWORD_PROD",
    "PGPASSWORD",
    "api_key",
    "x-api-key",
    "apiToken",
    "password_hash",
    "token_type",
    "npm_config_userconfig",
  ])("reads %s as a credential", (name) => {
    expect(isSecretName(name)).toBe(true)
  })

  it.each([
    "token_count",
    "input_token_count",
    "oauth",
    "bypass",
    "author_name",
    "code",
    "apiEndpoint",
    "secretary",
    "ACCESS_KEY_ROTATION",
  ])("reads %s as no credential", (name) => {
    expect(isSecretName(name)).toBe(false)
  })
})

describe("maskJson", () => {
  it("masks a secret-named value and every string, keeping keys, shape, and what says whether one is set", () => {
    expect(
      maskJson({
        passcode: 482913,
        auth: true,
        apiKey: null,
        credentials: { user: "a" },
        nested: [{ command: `export ${assigned("TOKEN", SAMPLE)}` }],
        count: 3,
      })
    ).toEqual({
      passcode: M,
      auth: true,
      apiKey: null,
      credentials: M,
      nested: [{ command: `export ${assigned("TOKEN", M)}` }],
      count: 3,
    })
  })

  it("gives the value itself back when nothing in it is a credential", () => {
    const value = { path: "/srv/app", items: [1, "two", { ok: true }] }
    expect(maskJson(value)).toBe(value)
  })
})
