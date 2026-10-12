import { PUSH_TEXT_LIMITS } from "../../protocol/push"
import { maskCredentials } from "../redaction"
import { PendingRequestKind, type PendingRequest } from "./events"

/**
 * The words of a pending request as they leave the gateway. The ask card
 * shows them whole and masked; a notification or an activity item shows one
 * masked line of them, cut to fit.
 */

/** Embeddings, overrides, and isolates, which reorder the text around them. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/gu
/**
 * C0, DEL, and C1 controls other than whitespace, which collapses instead,
 * and a surrogate with no partner: in a `u` pattern a pair is one code point.
 */
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\uD800-\uDFFF]/gu

/** Text as the ask card shows it: line breaks and length kept, nothing reordered. */
export function maskRequestText(text: string) {
  return maskCredentials(text.replace(BIDI_CONTROLS, ""))
}

/** One printable line: no controls, no reordering, single spaces. */
function oneLine(value: string) {
  return value
    .replace(UNPRINTABLE, "")
    .replace(BIDI_CONTROLS, "")
    .replace(/\s+/gu, " ")
    .trim()
}

/** At most `max` UTF-16 units, cut between code points and ending in "…". */
function cut(line: string, max: number) {
  if (!line) return undefined
  if (line.length <= max) return line
  const end = max - 1
  const high = line.charCodeAt(end - 1)
  const kept = line.slice(0, high >= 0xd800 && high <= 0xdbff ? end - 1 : end)
  return `${kept.trimEnd()}…`
}

/** `value` as one line of at most `max` UTF-16 units; empty is `undefined`. */
export function previewText(value: string, max: number) {
  return cut(oneLine(value), max)
}

/**
 * One masked line of what `request` asks: a permission's operation, else its
 * message; an elicitation's first question, else its message. `more` counts
 * the questions after the first. The line is masked after it is flattened, so
 * no control or reordering character can split a credential past the mask.
 */
export function requestPreview(
  request: PendingRequest
): { text: string; more?: number } | undefined {
  const questions = request.questions ?? []
  const title = request.responseSchema?.title
  const source =
    request.kind === PendingRequestKind.Permission
      ? typeof title === "string"
        ? title
        : request.message
      : (questions[0]?.text ?? questions[0]?.label ?? request.message)
  const text =
    source === undefined
      ? undefined
      : cut(maskCredentials(oneLine(source)), PUSH_TEXT_LIMITS.requestText)
  if (text === undefined) return undefined
  return questions.length > 1 ? { text, more: questions.length - 1 } : { text }
}
