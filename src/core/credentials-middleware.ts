import type { SessionHistoryResponse } from "../../protocol"
import {
  containsCredential,
  maskCredentials,
  maskJson,
  type Json,
} from "../redaction"
import {
  PendingRequestKind,
  TurnEventKind,
  type PendingQuestion,
  type PendingRequest,
  type Subagent,
  type ToolDiff,
  type ToolLocation,
  type TurnEvent,
} from "./events"
import type { Middleware, MemberCommands, MemberEvent } from "./member"
import { askText, distinctChoices } from "./request-text"

/**
 * The one place the gateway masks credentials in what a member is shown: every
 * runtime's tool data, live and replayed, and its run failures, on the operator
 * listener and the guest one alike. An adapter masks nothing. A question
 * reaches the operator as the runtime wrote it, since they must read what they
 * answer; a guest is shown it masked, and its answer reaches the runtime as the
 * choice the runtime wrote. A permission reaches the operator alone, whole.
 */

/**
 * The most text one tool field carries, which is also the most a browser keeps
 * of a terminal: plain text is cut to it before it is masked, so one huge
 * output costs the masker no more than this.
 */
const MAX_TOOL_TEXT = 262_144

/**
 * The first, or for a terminal the last, `MAX_TOOL_TEXT` units of `text`. A
 * tail cut inside a word drops that word, so a name's or a key's end is never
 * read as a whole.
 */
function bounded(text: string, keep: "head" | "tail") {
  if (text.length <= MAX_TOOL_TEXT) return text
  if (keep === "head") return text.slice(0, MAX_TOOL_TEXT)
  const tail = text.slice(-MAX_TOOL_TEXT)
  return tail.slice(tail.search(/\s/u) + 1)
}

/** Text that reads as a JSON object, array, or string, parsed; anything else `undefined`. */
function parsedJson(text: string): Json | undefined {
  if (!/^\s*[[{"]/u.test(text)) return undefined
  try {
    return JSON.parse(text) as Json
  } catch {
    return undefined
  }
}

/**
 * A tool's text as a member is shown it. JSON is masked by key and value, and
 * sent as written when nothing in it was a credential, then bounded; any other
 * text is bounded, then masked.
 */
function maskedToolText(text: string, keep: "head" | "tail" = "head") {
  const json = parsedJson(text)
  if (json === undefined) return maskCredentials(bounded(text, keep))
  const masked = maskJson(json)
  return bounded(masked === json ? text : JSON.stringify(masked), keep)
}

/** A text that carries a credential is dropped where masking it would mislead. */
function withoutCredential(text: string | undefined) {
  return text === undefined || containsCredential(text) ? undefined : text
}

/** The locations whose path carries no credential: masked, a path names no file. */
function publicLocations(locations: readonly ToolLocation[]) {
  return locations.filter((location) => !containsCredential(location.path))
}

/**
 * The diffs that name no path carrying a credential, each without a patch that
 * carries one, since masked a patch no longer applies.
 */
function publicDiffs(diffs: readonly ToolDiff[]) {
  return diffs.flatMap((diff) => {
    const named = diff.changes.flatMap((change) =>
      Object.values(change).filter((value) => typeof value === "string")
    )
    if (named.some(containsCredential)) return []
    if (diff.patch === undefined || !containsCredential(diff.patch))
      return [diff]
    return [{ changes: diff.changes }]
  })
}

/**
 * A subagent's report without a goal, summary, or file that carries a
 * credential: its prose is the subagent's own account, so a credential in it
 * drops it rather than leave a sentence with a hole.
 */
function publicSubagent(subagent: Subagent): Subagent {
  const { goal, summary, filesRead, filesWritten, ...rest } = subagent
  const files = (paths: readonly string[]) =>
    paths.filter((path) => !containsCredential(path))
  const publicGoal = withoutCredential(goal)
  const publicSummary = withoutCredential(summary)
  return {
    ...rest,
    ...(publicGoal === undefined ? {} : { goal: publicGoal }),
    ...(publicSummary === undefined ? {} : { summary: publicSummary }),
    ...(filesRead === undefined ? {} : { filesRead: files(filesRead) }),
    ...(filesWritten === undefined
      ? {}
      : { filesWritten: files(filesWritten) }),
  }
}

/** A turn event with its tool data and failure masked; every other event as it is. */
function maskedTurnEvent(event: TurnEvent): TurnEvent {
  switch (event.kind) {
    case TurnEventKind.ToolCallStarted:
      return {
        ...event,
        title: maskedToolText(event.title),
        ...(event.locations
          ? { locations: publicLocations(event.locations) }
          : {}),
        ...(event.subagent ? { subagent: publicSubagent(event.subagent) } : {}),
      }
    case TurnEventKind.ToolCallInputChunk:
      return { ...event, delta: maskedToolText(event.delta) }
    case TurnEventKind.ToolCallOutputChunk:
      return { ...event, text: maskedToolText(event.text) }
    case TurnEventKind.ToolCallFinished:
      return {
        ...event,
        output: maskedToolText(event.output),
        ...(event.diffs ? { diffs: publicDiffs(event.diffs) } : {}),
        ...(event.locations
          ? { locations: publicLocations(event.locations) }
          : {}),
      }
    case TurnEventKind.TerminalOutput: {
      const { command, cwd, data, ...rest } = event
      const publicCwd = withoutCredential(cwd)
      return {
        ...rest,
        ...(command === undefined ? {} : { command: maskedToolText(command) }),
        ...(publicCwd === undefined ? {} : { cwd: publicCwd }),
        ...(data === undefined ? {} : { data: maskedToolText(data, "tail") }),
      }
    }
    case TurnEventKind.SubagentUpdated:
      return { ...event, subagent: publicSubagent(event.subagent) }
    case TurnEventKind.TurnFailed:
      return event.message === undefined
        ? event
        : { ...event, message: maskCredentials(event.message) }
    default:
      return event
  }
}

type HistoryMessage = SessionHistoryResponse["messages"][number]

/**
 * A history message with every tool call it holds masked as its live call was,
 * and a failed turn's error masked as its live failure was.
 */
function maskedHistoryMessage(message: HistoryMessage): HistoryMessage {
  if (message.role !== "assistant") return message
  const { status } = message
  return {
    ...message,
    ...(status?.type === "incomplete"
      ? { status: { ...status, error: maskCredentials(status.error) } }
      : {}),
    content: message.content.map((part) =>
      part.type !== "tool-call"
        ? part
        : {
            ...part,
            args: maskJson(part.args),
            argsText: maskedToolText(part.argsText),
            ...(part.result === undefined
              ? {}
              : {
                  result:
                    typeof part.result === "string"
                      ? maskedToolText(part.result)
                      : maskJson(part.result),
                }),
            ...(part.diffs ? { diffs: publicDiffs(part.diffs) } : {}),
            ...(part.locations
              ? { locations: publicLocations(part.locations) }
              : {}),
          }
    ),
  }
}

/** A question as a guest is shown it: its words masked, its choices still telling which. */
function guestQuestion(question: PendingQuestion): PendingQuestion {
  const { label, text } = question
  return {
    ...question,
    ...(label === undefined ? {} : { label: maskCredentials(askText(label)) }),
    ...(text === undefined ? {} : { text: maskCredentials(askText(text)) }),
    choices: shownToGuest(question),
  }
}

/** A question's choices as a guest is shown them, in the runtime's order. */
function shownToGuest(question: PendingQuestion) {
  return distinctChoices(
    question.choices.map((choice) => maskCredentials(askText(choice)))
  )
}

/** A question request as a guest is shown it; any other request as it is. */
function guestRequest(request: PendingRequest): PendingRequest {
  if (request.kind !== PendingRequestKind.Elicitation) return request
  const { message, questions } = request
  return {
    ...request,
    ...(message === undefined
      ? {}
      : { message: maskCredentials(askText(message)) }),
    ...(questions ? { questions: questions.map(guestQuestion) } : {}),
  }
}

/** Whether `value` is one list of answers per question. */
function isAnswerSets(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.every(
      (values) =>
        Array.isArray(values) &&
        values.every((answer) => typeof answer === "string")
    )
  )
}

/** The answers a reply carries, when it carries a question's. */
function replyAnswers(payload: unknown) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("answers" in payload)
  )
    return undefined
  return isAnswerSets(payload.answers) ? payload.answers : undefined
}

/**
 * A guest's answer as the runtime takes it: a choice it was shown masked is
 * the choice the runtime wrote, and free text goes as typed.
 */
function nativeAnswer(
  command: MemberCommands["answer"]
): MemberCommands["answer"] {
  const answers = replyAnswers(command.reply.payload)
  const questions = command.request.questions
  if (!answers || !questions) return command
  const native = answers.map((values, index) => {
    const question = questions[index]
    if (!question) return values
    const shown = shownToGuest(question)
    return values.map(
      (value) => question.choices[shown.indexOf(value)] ?? value
    )
  })
  return {
    ...command,
    reply: { ...command.reply, payload: { answers: native } },
  }
}

/**
 * The credentials middleware, one per member. A guest's member also masks the
 * questions it is shown and the answers echoed back to it, and maps its answers
 * back to the runtime's own choices.
 */
export function createCredentialsMiddleware({
  guest = false,
}: { guest?: boolean } = {}): Middleware {
  return {
    event(event: MemberEvent): MemberEvent {
      switch (event.kind) {
        case "turn":
          return { ...event, event: maskedTurnEvent(event.event) }
        case "history":
          return {
            ...event,
            page: {
              ...event.page,
              messages: event.page.messages.map(maskedHistoryMessage),
            },
          }
        case "request-asked":
          return guest
            ? { ...event, request: guestRequest(event.request) }
            : event
        case "question-answered":
          return guest
            ? {
                ...event,
                request: guestRequest(event.request),
                answers: event.answers.map((values) =>
                  values.map((value) => maskCredentials(value))
                ),
              }
            : event
        default:
          return event
      }
    },
    ...(guest
      ? {
          commands: {
            answer: (command, next) => next(nativeAnswer(command)),
          },
        }
      : {}),
  }
}
