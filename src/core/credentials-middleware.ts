import type { SessionHistoryResponse } from "../../protocol"
import {
  containsCredential,
  maskCredentials,
  maskJson,
  type Json,
} from "../redaction"
import {
  PendingRequestKind,
  ReplyStatus,
  TurnEventKind,
  type ChildTurnEvent,
  type OwnTurnEvent,
  type PendingQuestion,
  type PendingRequest,
  type ToolDiff,
  type ToolLocation,
  type TurnEvent,
} from "./events"
import type { Middleware, MemberCommands, MemberEvent } from "./member"
import { answeredChoice, askText, distinctChoices } from "./request-text"

/**
 * The one place the gateway masks credentials in what a member is shown: every
 * runtime's tool data, live and replayed, and its run failures, on the operator
 * listener and the guest one alike. Text is masked, and a path or a patch that
 * a mask would break is dropped instead. An adapter masks nothing. A question
 * reaches the operator as the runtime wrote it, since they must read what they
 * answer, and so does the call of the tool that asked it, with their answers;
 * a guest is shown it masked, and its answer reaches the runtime as the choice
 * the runtime wrote. A permission reaches the operator alone, whole.
 */

/** The canonical name of the tool a runtime asks its operator questions with. */
const QUESTION_TOOL = "question"
/** The most question calls one Session keeps noted; past it the oldest goes. */
const QUESTION_CALLS_PER_SESSION = 10

/** The most of a terminal's output a browser keeps: its last 256 KiB. */
const TERMINAL_TAIL = 262_144

/**
 * The last `TERMINAL_TAIL` units of a terminal's output, masked. A cut inside
 * a word drops that word, so a name's or a key's end is never read whole.
 */
function maskedTerminalData(data: string) {
  if (data.length <= TERMINAL_TAIL) return maskCredentials(data)
  const tail = data.slice(-TERMINAL_TAIL)
  return maskCredentials(tail.slice(tail.search(/\s/u) + 1))
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
 * A tool's arguments or result as a member is shown them: JSON masked by key
 * and value, and sent as written when nothing in it was a credential; any
 * other text masked as text.
 */
function maskedToolValue(text: string) {
  const json = parsedJson(text)
  if (json === undefined) return maskCredentials(text)
  const masked = maskJson(json)
  return masked === json ? text : JSON.stringify(masked)
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

/** The paths that carry no credential: masked, a path names no file. */
function publicPaths(paths: readonly string[]) {
  return paths.filter((path) => !containsCredential(path))
}

/** What a child Session's report, live or stored, says in prose and files. */
type ChildFacts = {
  title?: string
  description?: string
  summary?: string
  filesRead?: string[]
  filesWritten?: string[]
}

/**
 * A child Session's report with its prose masked and every file carrying a
 * credential dropped, since masked a path names no file.
 */
function publicChild<Facts extends ChildFacts>(facts: Facts): Facts {
  const { title, description, summary, filesRead, filesWritten } = facts
  return {
    ...facts,
    ...(title === undefined ? {} : { title: maskCredentials(title) }),
    ...(description === undefined
      ? {}
      : { description: maskCredentials(description) }),
    ...(summary === undefined ? {} : { summary: maskCredentials(summary) }),
    ...(filesRead === undefined ? {} : { filesRead: publicPaths(filesRead) }),
    ...(filesWritten === undefined
      ? {}
      : { filesWritten: publicPaths(filesWritten) }),
  }
}

/** A turn event with its tool data and failure masked; every other event as it is. */
function maskedTurnEvent(event: TurnEvent): TurnEvent {
  switch (event.kind) {
    case TurnEventKind.ToolCallStarted:
      return {
        ...event,
        title: maskCredentials(event.title),
        ...(event.locations
          ? { locations: publicLocations(event.locations) }
          : {}),
      }
    case TurnEventKind.ToolCallInputChunk:
      return { ...event, delta: maskedToolValue(event.delta) }
    case TurnEventKind.ToolCallOutputChunk:
      return { ...event, text: maskCredentials(event.text) }
    case TurnEventKind.ToolCallFinished:
      return {
        ...event,
        output: maskedToolValue(event.output),
        ...(event.diffs ? { diffs: publicDiffs(event.diffs) } : {}),
        ...(event.locations
          ? { locations: publicLocations(event.locations) }
          : {}),
      }
    case TurnEventKind.TerminalOutput: {
      const { command, cwd, data, ...rest } = event
      return {
        ...rest,
        ...(command === undefined ? {} : { command: maskCredentials(command) }),
        ...(cwd === undefined || containsCredential(cwd) ? {} : { cwd }),
        ...(data === undefined ? {} : { data: maskedTerminalData(data) }),
      }
    }
    case TurnEventKind.ChildSessionUpdated:
      return publicChild(event)
    // A child's own event is masked as the same event of its parent would be.
    case TurnEventKind.ChildSessionEvent:
      return {
        ...event,
        event: maskedTurnEvent(event.event) as OwnTurnEvent,
      }
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
 * and a failed turn's error masked as its live failure was. The operator reads
 * a question tool's call as written.
 */
function maskedHistoryMessage(
  message: HistoryMessage,
  guest: boolean
): HistoryMessage {
  // A stored child is masked as its live report was.
  if (message.role === "activity" && message.activityType === "CHILD_SESSION")
    return { ...message, content: publicChild(message.content) }
  if (message.role !== "assistant") return message
  const { status } = message
  return {
    ...message,
    ...(status?.type === "incomplete"
      ? { status: { ...status, error: maskCredentials(status.error) } }
      : {}),
    content: message.content.map((part) =>
      part.type !== "tool-call" || (!guest && part.toolName === QUESTION_TOOL)
        ? part
        : {
            ...part,
            args: maskJson(part.args),
            argsText: maskedToolValue(part.argsText),
            ...(part.result === undefined
              ? {}
              : {
                  result:
                    typeof part.result === "string"
                      ? maskedToolValue(part.result)
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

/**
 * A guest's answer as the runtime takes it: a choice it was shown masked is
 * the choice the runtime wrote, and free text goes as typed.
 */
function nativeAnswer(
  command: MemberCommands["answer"]
): MemberCommands["answer"] {
  const { answers, request, reply } = command
  const questions = request.questions
  if (!answers || !questions || reply.status !== ReplyStatus.Resolved)
    return command
  const native = answers.map((values, index) => {
    const question = questions[index]
    if (!question) return values
    const shown = shownToGuest(question)
    return values.map((value) => answeredChoice(question.choices, shown, value))
  })
  return { ...command, reply: { ...reply, payload: { answers: native } } }
}

/**
 * Turn events every member is shown, masked once: each member's stack reads
 * the same event, so a second tab or a guest costs the masker nothing more.
 */
const maskedTurnEvents = new WeakMap<TurnEvent, TurnEvent>()

function maskedOnce(event: TurnEvent) {
  const known = maskedTurnEvents.get(event)
  if (known) return known
  const masked = maskedTurnEvent(event)
  maskedTurnEvents.set(event, masked)
  return masked
}

/**
 * The credentials middleware, one per member. A guest's member also masks the
 * questions it is shown and the answers echoed back to it, and maps its answers
 * back to the runtime's own choices.
 */
export function createCredentialsMiddleware({
  guest = false,
}: { guest?: boolean } = {}): Middleware {
  /**
   * Each Session's question calls this member saw start and not yet finish. A
   * call is forgotten when it finishes, every one when its turn ends cleanly,
   * and the oldest past `QUESTION_CALLS_PER_SESSION`; a forgotten call is
   * masked, never shown. A failed turn forgets none, since it can resume.
   */
  const questionCalls = new Map<string, Set<string>>()

  /** Whether `event` is part of a question tool's call, which the operator reads as written. */
  function askedByTool(sessionId: string, event: TurnEvent) {
    const calls = questionCalls.get(sessionId)
    switch (event.kind) {
      case TurnEventKind.ToolCallStarted: {
        if (event.name !== QUESTION_TOOL) return false
        const noted = calls ?? new Set<string>()
        const [oldest] = noted
        if (noted.size >= QUESTION_CALLS_PER_SESSION && oldest !== undefined)
          noted.delete(oldest)
        questionCalls.set(sessionId, noted.add(event.toolCallId))
        return true
      }
      case TurnEventKind.ToolCallInputChunk:
      case TurnEventKind.ToolCallOutputChunk:
        return calls?.has(event.toolCallId) ?? false
      case TurnEventKind.ToolCallFinished: {
        const asked = calls?.delete(event.toolCallId) ?? false
        if (calls?.size === 0) questionCalls.delete(sessionId)
        return asked || event.name === QUESTION_TOOL
      }
      case TurnEventKind.TurnEnded:
        questionCalls.delete(sessionId)
        return false
      default:
        return false
    }
  }

  return {
    event(event: MemberEvent): MemberEvent {
      switch (event.kind) {
        case "turn":
          return !guest && askedByTool(event.sessionId, event.event)
            ? event
            : { ...event, event: maskedOnce(event.event) }
        // A child's own question tool reaches the operator as written, as its
        // parent's does; everything else a child reports is masked.
        case "child": {
          const reported = event.event
          return !guest &&
            reported.kind === TurnEventKind.ChildSessionEvent &&
            askedByTool(event.sessionId, reported.event)
            ? event
            : { ...event, event: maskedOnce(reported) as ChildTurnEvent }
        }
        case "history":
        case "child-history":
          return {
            ...event,
            page: {
              ...event.page,
              messages: event.page.messages.map((message) =>
                maskedHistoryMessage(message, guest)
              ),
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
