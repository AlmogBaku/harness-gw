import { redact } from "@sanity-labs/secret-scan"

/** What every field, URL credential, and credential value a log masks becomes. */
const REDACTED = "[REDACTED]"

/**
 * Every word a native field or variable name uses for a credential, lowercase
 * with separators removed (`api_key` and `apiKey` are both `apikey`).
 * `isSecretName` reads every name by this list: a logged field, a JSON key in
 * browser-bound data, and a name text assigns a value to. `code` is deliberately
 * absent: it is the classification an operator diagnoses a failure by, and the
 * only credential spelled that way is an OAuth `?code=` query value, which
 * every logged URL loses.
 */
export const SECRET_TERMS: readonly string[] = [
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "clientsecret",
  "cookie",
  "cookiejar",
  "credential",
  "credentials",
  "pass",
  "passcode",
  "passphrase",
  "passwd",
  "password",
  "privatekey",
  "pwd",
  "refreshtoken",
  "secret",
  "secretkey",
  "setcookie",
  "token",
]

/** What a masked credential reads as, wherever an operator or guest reads it. */
const MASKED = "[credential redacted]"

/**
 * Names that read like a credential but are not one, each as its words joined:
 * a count, a limit, a mode, or a word that only contains a term's letters. A
 * run of a name's words that spells one hides the terms inside it, so
 * `input_token_count` is a count, not a token.
 */
const SAFE_NAMES = new Set([
  "accesskeyrotation",
  "authmode",
  "authorizationmode",
  "bypass",
  "oauth",
  "oauthmode",
  "secretary",
  "tokencount",
  "tokenlimit",
  "tokenusage",
])
/** Names that are credentials though no word of theirs is a term. */
const SECRET_NAMES = new Set(["npmconfiguserconfig"])
/** The longest run of words a `SECRET_TERMS` or `SAFE_NAMES` entry spans. */
const MAX_RUN = 3
/** The longest name read: past it a name is no field anyone writes, and reading it costs more. */
const MAX_NAME = 128

/** A name's words, lowercase: `apiKey`, `API_KEY` and `api-key` are `api`, `key`. */
function nameWords(name: string) {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/gu)
    .filter(Boolean)
}

/** Each run of up to `MAX_RUN` adjacent words, joined, with the span it covers. */
function wordRuns(words: readonly string[]) {
  return words.flatMap((_, start) =>
    Array.from(
      { length: Math.min(MAX_RUN, words.length - start) },
      (_, length) => ({
        start,
        end: start + length + 1,
        joined: words.slice(start, start + length + 1).join(""),
      })
    )
  )
}

/**
 * Whether a field or variable name names a credential, in any case or
 * separator style: one rule for logs, JSON keys, and the names text assigns.
 * A run of up to three of its words that spells a `SECRET_TERMS` word counts
 * (`DB_PASSWORD_PROD`, `x-api-key`, `password_hash`, `token_type`), and so do
 * its letters ending in one (`PGPASSWORD`), unless a `SAFE_NAMES` run covers it.
 */
export function isSecretName(name: string) {
  const read = name.slice(0, MAX_NAME)
  const letters = read.toLowerCase().replace(/[^a-z0-9]+/gu, "")
  if (SECRET_NAMES.has(letters)) return true
  if (!SECRET_TERMS.some((term) => letters.includes(term))) return false
  const words = nameWords(read)
  const joined = words.join("")
  const runs = wordRuns(words)
  const safe = runs.filter((run) => SAFE_NAMES.has(run.joined))
  const covered = (start: number, end: number) =>
    safe.some((run) => run.start <= start && end <= run.end)
  return (
    runs.some(
      (run) => SECRET_TERMS.includes(run.joined) && !covered(run.start, run.end)
    ) ||
    (!covered(words.length - 1, words.length) &&
      SECRET_TERMS.some((term) => joined.endsWith(term)))
  )
}

/** A JWT, whole, starting where no word does: a credential wherever it stands. */
const JWT = String.raw`(?<![\w-])eyJ[\w-]+\.[\w-]+\.[\w-]+`
/** An RFC 6750 bearer token of at least 8 characters, ending in no dot. */
const BEARER_TOKEN = String.raw`[A-Za-z0-9._~+/-]{7,}[A-Za-z0-9_~+/=-]`
/** A value with no shell, glob or quote syntax, and not a path. */
const PLAIN_VALUE = String.raw`[^\s$()|&;<>\x60'"{}*?\[\]\\/.~][^\s$()|&;<>\x60'"{}*?\[\]\\]*`
/** The characters a shell word ends before. */
const WORD_END = /[\s;&|()<>"'\x60]/u
/**
 * A URL's password, after its `scheme://user:` and before its `@`, and not
 * shell syntax, so the URL still shows the host it reaches. A scheme is at
 * most 32 characters, so a long run of word characters costs one pass.
 */
const URL_PASSWORD = String.raw`\b(?<userinfo>[a-z][\w+.-]{0,31}://[^\s:/@]*:)[^\s:/@$(){}\x60'"]+(?=@)`
/** A value already masked, which neither strength masks again. */
const ALREADY_MASKED = String.raw`(?!(?:(?:basic|bearer)\s+)?\[credential redacted\])`
/** A name a value is assigned to, whole, after any flag dashes: never the tail of a longer one. */
const NAME = String.raw`(?<![\w.-])-*(?<name>\w[\w.-]{0,${MAX_NAME - 1}})`
/** Spacing that stays on its line, so a YAML parent never takes its child's name as its value. */
const INLINE_SPACE = String.raw`[^\S\r\n]*`
/**
 * A PEM private key, whole, as the scanner masks one; one with no footer is
 * masked to the end of the text. The scanner's own rule restarts at every
 * header, so text that repeats one took it minutes; masked here first, none is
 * left for it to read.
 */
const PRIVATE_KEY = String.raw`-----${INLINE_SPACE}BEGIN[ A-Z0-9_-]{0,64}?PRIVATE KEY${INLINE_SPACE}-----[\s\S]*?(?:-----${INLINE_SPACE}END[ A-Z0-9_-]{0,64}?PRIVATE KEY${INLINE_SPACE}-----|$)`

/**
 * The two strengths a credential mask comes in. Each has a pass for the
 * credentials that announce themselves by shape, then a pass for the values a
 * secret name is assigned. `broad` takes a name's value up to the next break,
 * however it is spaced or quoted, a Basic or Bearer token, and any provider key
 * prefix, for text that only describes: a preview, a title, a question, a tool's
 * data. `narrow` takes only a value glued to its name that cannot be shell
 * syntax, a token an `Authorization` header names, and a key of a real key's
 * length, for text an operator approves: a permission must still show what it
 * would run. Both take a URL's password. Every shape starts where a word does,
 * so a run of one shape repeated costs one pass, not one per repeat.
 */
const CREDENTIAL_MASKS = {
  broad: {
    shapes: new RegExp(
      String.raw`${PRIVATE_KEY}|\b(?<prefix>(?:basic|bearer)\s+)(?<token>${BEARER_TOKEN})|\b(?:gh[opsur]_|sk-|xox[baprs]-)[\w-]+|${JWT}|${URL_PASSWORD}`,
      "giu"
    ),
    name: new RegExp(
      String.raw`${NAME}(?<separator>${INLINE_SPACE}[=:]${INLINE_SPACE})`,
      "gu"
    ),
    value: new RegExp(
      String.raw`${ALREADY_MASKED}(?<prefix>(?:(?:basic|bearer)\s+)?)(?:(?<quote>["'])(?<quoted>[^"'\r\n]*)\k<quote>|(?<plain>[^\s,;]+?)(?=["']?(?:[\s,;]|$)))`,
      "iuy"
    ),
  },
  narrow: {
    shapes: new RegExp(
      String.raw`${PRIVATE_KEY}|\b(?<header>authorization\s*:\s*(?:bearer|basic)\s+)${BEARER_TOKEN}|\bgh[opsur]_[A-Za-z0-9]{30,}|(?<![\w-])sk-(?=[\w-]*\d)[\w-]{20,}|\bxox[baprs]-[\w-]+|${JWT}|${URL_PASSWORD}`,
      "giu"
    ),
    name: new RegExp(String.raw`${NAME}(?<separator>[=:])`, "gu"),
    value: new RegExp(
      String.raw`(?:(?<quote>["'])(?<quoted>${PLAIN_VALUE})\k<quote>|(?<plain>${PLAIN_VALUE}))`,
      "uy"
    ),
  },
}
export type MaskStrength = keyof typeof CREDENTIAL_MASKS

/**
 * Upper case, lower case, digits, and symbols: a token mixes at least two,
 * counted with its first letter's case ignored, so a capitalised word is prose.
 */
const TOKEN_KINDS = [/[A-Z]/u, /[a-z]/u, /[0-9]/u, /[._~+/=-]/u]

type ShapeGroups = Partial<
  Record<"prefix" | "token" | "header" | "userinfo", string>
>

function maskedShape(match: string, ...args: unknown[]) {
  const { prefix, token, header, userinfo } = args.at(-1) as ShapeGroups
  // "Basic Authentication" is prose; a token mixes kinds of character.
  if (token !== undefined) {
    const counted = token.charAt(0).toLowerCase() + token.slice(1)
    return TOKEN_KINDS.filter((kind) => kind.test(counted)).length >= 2
      ? `${prefix ?? ""}${MASKED}`
      : match
  }
  if (header !== undefined) return `${header}${MASKED}`
  if (userinfo !== undefined) return `${userinfo}${MASKED}`
  return MASKED
}

/** A value that only names a secret: `$TOKEN`, `${TOKEN}`, `<token>`, `{token}`. */
const PLACEHOLDER = /^[$<{]/u

/**
 * `text` with the value of every secret name it assigns masked, the name, its
 * separator, and the value's quotes kept. One scan: a name that is not secret
 * resumes the scan right after its separator, so its value is still read for
 * a name of its own (`user=a&token=b`), and a narrow value that does not end
 * where a shell word does is skipped whole, since every name inside it would
 * end at the same place.
 */
function maskNames(text: string, strength: MaskStrength) {
  const { name, value } = CREDENTIAL_MASKS[strength]
  let output = ""
  let copied = 0
  name.lastIndex = 0
  for (let match = name.exec(text); match; match = name.exec(text)) {
    if (!isSecretName(match.groups?.name ?? "")) continue
    value.lastIndex = name.lastIndex
    const found = value.exec(text)
    if (!found) continue
    const end = value.lastIndex
    const { prefix = "", quote = "", quoted, plain } = found.groups ?? {}
    const secret = quoted ?? plain ?? ""
    if (
      strength === "narrow" &&
      end < text.length &&
      !WORD_END.test(text[end]!)
    ) {
      name.lastIndex = end
      continue
    }
    if (PLACEHOLDER.test(secret)) continue
    output += `${text.slice(copied, name.lastIndex)}${prefix}${quote}${MASKED}${quote}`
    copied = end
    name.lastIndex = end
  }
  return output + text.slice(copied)
}

/**
 * `text` with every provider key the secret scanner knows by its shape masked.
 * Its database rules take a whole URL or only its scheme, so a URL is left to
 * the masks, which take just its password.
 */
function scanned(text: string) {
  return redact(text, (secret) =>
    secret.text.includes("://") || text.startsWith("://", secret.end)
      ? secret.text
      : MASKED
  )
}

/**
 * The longest run without whitespace the secret scanner reads whole. Inside
 * one such run its rules restart at every repeat, so 64 KiB of `eyJ-` took it
 * seconds; text that breaks lines or words, a PEM block included, it reads in
 * one pass.
 */
const SCAN_RUN = 2_048
const LONG_RUN = new RegExp(String.raw`(?<!\S)\S{${SCAN_RUN + 1},}`, "gu")

/**
 * `text` with every provider key the scanner knows masked, each run of more
 * than `SCAN_RUN` characters without whitespace read in `SCAN_RUN` pieces.
 */
function maskScanned(text: string) {
  let output = ""
  let copied = 0
  for (const run of text.matchAll(LONG_RUN)) {
    output += scanned(text.slice(copied, run.index))
    for (let start = 0; start < run[0].length; start += SCAN_RUN)
      output += scanned(run[0].slice(start, start + SCAN_RUN))
    copied = run.index + run[0].length
  }
  return output + scanned(text.slice(copied))
}

/**
 * `text` with every credential it spells out as `[credential redacted]`, at
 * the given strength: every credential a header, a key prefix, or a URL
 * announces, then every value a secret name is assigned, then every other
 * provider key the secret scanner knows by its shape. Only the value goes:
 * names, quotes, placeholders, paths, and hosts stay, so text a runtime wrote
 * for the operator still reads as written.
 */
export function maskCredentials(
  text: string,
  strength: MaskStrength = "broad"
) {
  const shaped = text.replace(CREDENTIAL_MASKS[strength].shapes, maskedShape)
  return maskScanned(maskNames(shaped, strength))
}

/** Whether `text` carries anything the broad mask would take. */
export function containsCredential(text: string) {
  return maskCredentials(text) !== text
}

/**
 * A JSON value with every credential in it masked, and the value itself back
 * when nothing was: a secret-named key keeps its name and loses its value,
 * unless that value is a boolean or `null`, which only says whether one is
 * set; every other string is masked as text.
 */
export function maskJson(value: unknown): unknown {
  if (typeof value === "string") return maskCredentials(value)
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) {
    const items = value.map(maskJson)
    return items.every((item, index) => item === value[index]) ? value : items
  }
  let changed = false
  const entries = Object.entries(value).map(([key, item]) => {
    const next =
      isSecretName(key) && typeof item !== "boolean" && item !== null
        ? MASKED
        : maskJson(item)
    if (next !== item) changed = true
    return [key, next]
  })
  return changed ? Object.fromEntries(entries) : value
}

/**
 * The names a push subscription and a VAPID pair carry, which a log masks by
 * exact name: a subscription endpoint is a bearer capability to wake one
 * device. They stay out of `SECRET_TERMS`, because as a name rule they would
 * mask ordinary provider fields such as `apiEndpoint` in browser-bound data.
 */
const PUSH_KEYS = new Set(["applicationserverkey", "endpoint", "p256dh"])

/** Whether a logged field name spells a credential, in any case or separator style. */
function isSecretKey(key: string) {
  return (
    PUSH_KEYS.has(key.toLowerCase().replace(/[-_ ]/gu, "")) || isSecretName(key)
  )
}

/**
 * A URL inside text, from its `://` on, so any scheme matches and a long run of
 * letters costs one pass. It stops only where a URL cannot go on: at
 * whitespace, a double quote, or an angle bracket, which every part of a URL
 * percent-encodes, and at a backslash, so inside a serialized JSON line it
 * never reaches past its own string. A single quote stays in, since a password
 * or a query carries one unencoded.
 */
const URL_IN_TEXT = /:\/\/[^\s"<>\\]+/gu

/**
 * `text` with every URL's userinfo, query, and fragment removed, whatever its
 * scheme: `wss://h/api/ws?token=abc` is logged as `wss://h/api/ws`. The whole
 * query goes rather than a list of credential parameters, because each native
 * server names its own.
 */
export function redactText(text: string) {
  return text.replace(URL_IN_TEXT, (url) =>
    url.replace(/:\/\/[^/?#]*@/gu, "://").replace(/[?#].*$/u, "")
  )
}

/**
 * An error as a log reads it: its name and redacted message, the `code` or
 * `reason` a native failure is classified by, and its cause chain. The stack
 * stays out: it names deployment paths and says nothing an operator acts on.
 */
function serializeError(error: Error, seen: WeakSet<object>) {
  const { code, reason } = error as { code?: unknown; reason?: unknown }
  return {
    name: error.name,
    message: redactText(error.message),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
    ...(error.cause === undefined
      ? {}
      : { cause: redactForLog(error.cause, seen) }),
  }
}

export function redactForLog(
  value: unknown,
  seen = new WeakSet<object>()
): unknown {
  if (typeof value === "string") return redactText(value)
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return REDACTED
  seen.add(value)
  if (value instanceof Error) return serializeError(value, seen)
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, seen))
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value))
    output[key] = isSecretKey(key) ? REDACTED : redactForLog(child, seen)
  return output
}

/**
 * Every credential value the gateway has read, which no log line carries
 * verbatim, whatever field, message, or error it arrives in. A value is known
 * in each form it travels in (a password and its Basic header form, say) and
 * in its JSON-escaped spelling, and a rotated value joins its predecessor
 * rather than replacing it, since a late error can still quote the old one.
 */
export class CredentialValues {
  readonly #values = new Set<string>()

  /** Wraps a credential reader so every value it reads, a re-read included, is known. */
  register<A extends unknown[], T>(
    read: (...args: A) => Promise<T>,
    forms: (value: T) => readonly string[]
  ): (...args: A) => Promise<T> {
    return async (...args) => {
      const value = await read(...args)
      for (const form of forms(value))
        if (form !== "")
          this.#values.add(form).add(JSON.stringify(form).slice(1, -1))
      return value
    }
  }

  /** `text` with every known value, longest first, as `[REDACTED]`. */
  scrub(text: string) {
    return [...this.#values]
      .sort((left, right) => right.length - left.length)
      .reduce((scrubbed, value) => scrubbed.replaceAll(value, REDACTED), text)
  }
}
