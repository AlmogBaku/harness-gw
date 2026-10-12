import { guestErrorDescription } from "../../auth/guest-projection"
import { publicTurnError } from "../../auth/guest-runtime-projection"
import {
  isAwaitingStopFailure,
  isRedialableFailure,
  isTurnEvent,
  TurnEventKind,
  type TurnEvent,
  type TurnEventOf,
} from "../../core/events"
import { validIdentifier } from "../../core/identifier"
import {
  promptText,
  unhandledKind,
  type MemberEvent,
  type Middleware,
} from "../../core/member"
import { appCallPassesWhole } from "./app-servers"
import { guestArtifact } from "./artifacts"

/**
 * What a guest is shown of a live turn: the conversation's own text whole,
 * under the runtime's ids, an MCP App's card, and nothing of how the turn ran.
 * Another member's prompt reaches it as its history shows a user turn.
 */

/** Passes a provider-held artifact only; guests never receive inline data. */
function projectArtifact(
  candidate: TurnEventOf<typeof TurnEventKind.ArtifactPublished>
): TurnEventOf<typeof TurnEventKind.ArtifactPublished> | undefined {
  const artifact = guestArtifact(candidate.artifact)
  return artifact && { kind: TurnEventKind.ArtifactPublished, artifact }
}

/**
 * One turn stream's projector. `shown` collects the calls whose card a guest
 * was shown, across every stream of the member; an App call from one of
 * `appServers` also passes its output, as the guest's view route hands it.
 */
export function createTurnProjector(
  shown: Set<string> = new Set(),
  appServers: readonly string[] = []
) {
  /** The shown calls whose output passes, until each finishes. */
  const whole = new Set<string>()
  /**
   * The name of every call whose start was hidden, until it finishes or its
   * turn ends. The conversation runs one turn at a time, and a failure it
   * recovers from or still has to stop leaves that turn running.
   */
  const hidden = new Map<string, string>()
  return (candidate: TurnEvent): TurnEvent | undefined => {
    if (!isTurnEvent(candidate)) return undefined
    switch (candidate.kind) {
      case TurnEventKind.TurnStarted:
        return {
          kind: TurnEventKind.TurnStarted,
          ...(candidate.startedAt ? { startedAt: candidate.startedAt } : {}),
        }
      // How the turn stopped and what the runtime asks the composer to start
      // with are the guest's; what it spent is not.
      case TurnEventKind.TurnEnded: {
        hidden.clear()
        const { stopReason, composerPrefill } = candidate
        return {
          kind: TurnEventKind.TurnEnded,
          ...(stopReason ? { stopReason } : {}),
          ...(composerPrefill === undefined ? {} : { composerPrefill }),
        }
      }
      // A subagent's prose is its tool call's output, which guests never see.
      case TurnEventKind.MessageChunk:
        return validIdentifier(candidate.messageId) &&
          candidate.subagentId === undefined
          ? {
              kind: TurnEventKind.MessageChunk,
              messageId: candidate.messageId,
              text: candidate.text,
            }
          : undefined
      // The permissions layer already took the permissions out.
      case TurnEventKind.TurnRequiresAction:
        return candidate
      case TurnEventKind.TurnFailed: {
        if (
          !isRedialableFailure(candidate) &&
          !isAwaitingStopFailure(candidate)
        )
          hidden.clear()
        const { code } = publicTurnError(candidate.code)
        return {
          kind: TurnEventKind.TurnFailed,
          code,
          message: guestErrorDescription(code),
          ...(candidate.awaitingStop ? { awaitingStop: true as const } : {}),
        }
      }
      // Only an MCP App's card, from its start to its settling: its name, no
      // arguments, and no other tool call. Its output passes when its server
      // is allowlisted; its input reaches the guest through its view alone.
      case TurnEventKind.ToolCallStarted: {
        if (candidate.subagentId !== undefined) return undefined
        const name = candidate.name ?? candidate.title
        if (!candidate.app) {
          hidden.set(candidate.toolCallId, name)
          return undefined
        }
        shown.add(candidate.toolCallId)
        if (appCallPassesWhole(name, appServers))
          whole.add(candidate.toolCallId)
        return {
          kind: TurnEventKind.ToolCallStarted,
          toolCallId: candidate.toolCallId,
          title: name,
          name,
          app: true,
        }
      }
      // A call flagged an App only at its finish shows its card there, under
      // the name its hidden start carried. Any other hidden call stays hidden.
      case TurnEventKind.ToolCallFinished: {
        const name = hidden.get(candidate.toolCallId)
        hidden.delete(candidate.toolCallId)
        const opens = candidate.app && name !== undefined
        if (opens) shown.add(candidate.toolCallId)
        else if (!shown.has(candidate.toolCallId)) return undefined
        const passes =
          whole.delete(candidate.toolCallId) ||
          (opens && appCallPassesWhole(name, appServers))
        return {
          kind: TurnEventKind.ToolCallFinished,
          toolCallId: candidate.toolCallId,
          ...(opens ? { name } : {}),
          output: passes ? candidate.output : "",
          failed: candidate.failed,
          app: true,
        }
      }
      case TurnEventKind.ToolCallOutputChunk:
        return whole.has(candidate.toolCallId) ? candidate : undefined
      case TurnEventKind.PlanUpdated:
        return { kind: TurnEventKind.PlanUpdated, todos: candidate.todos }
      case TurnEventKind.ArtifactPublished:
        return projectArtifact(candidate)
      // A correction is the conversation's own text, whoever steered.
      case TurnEventKind.SteerAccepted:
        return candidate
      // Reasoning, a call's input, any other call's output, terminals,
      // compaction, the model and subagents are never a guest's.
      case TurnEventKind.ThoughtChunk:
      case TurnEventKind.ToolCallInputChunk:
      case TurnEventKind.ToolCallInputEnded:
      case TurnEventKind.TerminalOutput:
      case TurnEventKind.CompactionUpdated:
      case TurnEventKind.ModelChanged:
      case TurnEventKind.SubagentUpdated:
        return undefined
    }
    return unhandledKind(candidate)
  }
}

export type GuestTurnsOptions = {
  /** The MCP servers whose App calls pass their output; none by default. */
  appServers?: readonly string[]
}

export function createTurnsMiddleware({
  appServers = [],
}: GuestTurnsOptions = {}): Middleware {
  /**
   * Every call whose card this guest was shown. It grows with the one invited
   * conversation alone, which is all a guest's member ever reaches.
   */
  const shown = new Set<string>()
  const project = createTurnProjector(shown, appServers)

  return {
    event(event): MemberEvent | undefined {
      switch (event.kind) {
        case "turn": {
          const projected = project(event.event)
          return projected && { ...event, event: projected }
        }
        // Another member's prompt reaches a guest as its history shows a user
        // turn: its text alone, whole.
        case "prompt": {
          if (event.own) return event
          const text = promptText(event.content)
          return text
            ? { ...event, content: [{ kind: "text", text }] }
            : undefined
        }
        // An answer settles the call that asked it, which a guest may not see.
        case "question-answered":
          return event.request.toolCallId === undefined ||
            shown.has(event.request.toolCallId)
            ? event
            : undefined
        // A question reaches a guest whole, but names only a call it was shown.
        case "request-asked": {
          const { toolCallId, ...request } = event.request
          return toolCallId === undefined || shown.has(toolCallId)
            ? event
            : { ...event, request }
        }
        // What is not a turn's passes: the feeds layer chose the readings and
        // the commands layer projects the command list.
        case "history":
        case "request-withdrawn":
        case "execution":
        case "usage":
        case "model":
        case "error":
        case "session-info":
        case "commands":
        case "notice":
        case "catalog-invalidated":
        case "activity":
          return event
      }
      return unhandledKind(event)
    },
  }
}
