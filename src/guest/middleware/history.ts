import { z } from "zod"

import {
  SessionHistoryResponseSchema,
  type SessionHistoryResponse,
  type SessionMessage,
} from "../../../protocol"
import { guestErrorDescription } from "../../auth/guest-projection"
import {
  isFirstTurnEnvelope,
  publicTurnError,
} from "../../auth/guest-runtime-projection"
import {
  CommandRefusedError,
  unhandledKind,
  type MemberEvent,
  type Middleware,
} from "../../core/member"
import { appCallPassesWhole } from "./app-servers"
import { refusedText } from "./commands"
import { ARTIFACT_PART_NAME, guestArtifact } from "./artifacts"
import type { GuestGrant } from "./index"

/**
 * What a guest reads of the invited conversation's history: every page it is
 * shown, validated and projected by main's guest history rules, and the only
 * user messages an Edit or Retry of its may name.
 */

/**
 * A replay from the start may join every page of the Session, each already
 * bounded as it was read, so only the page's own size limit is lifted.
 */
const ProjectedHistorySchema = SessionHistoryResponseSchema.extend({
  messages: z.array(SessionHistoryResponseSchema.shape.messages.element),
})

export function projectGuestHistory(
  history: SessionHistoryResponse,
  publicSessionId = history.sessionId,
  appServers: readonly string[] = []
) {
  const messages: unknown[] = []
  /**
   * A turn the provider started on its own, whose first message a guest is not
   * shown (its thought), so the next one it is shown opens it instead.
   */
  let opensTurn = false
  for (const message of history.messages) {
    if (message.role === "system") continue
    // Pages count back from the newest, so the setup turn may open any page.
    if (message.role === "user" && isFirstTurnEnvelope(message.content))
      continue
    // Only the plan of the Session's activity is shown to a guest: any other
    // kind, compaction among them, stays hidden until it is allowed here.
    if (message.role === "activity") {
      if (message.activityType === "PLAN") messages.push(message)
      continue
    }
    const content = message.content.flatMap(
      (part): SessionMessage["content"] => {
        // An MCP App reaches a guest as its card, with its result when its
        // server is allowlisted; its input travels only through the
        // invitation's own view route, which withholds the host paths it names.
        if (part.type === "tool-call")
          return part.app
            ? [
                {
                  type: "tool-call" as const,
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  args: {},
                  argsText: "",
                  ...(part.result !== undefined &&
                  appCallPassesWhole(part.toolName, appServers)
                    ? { result: part.result }
                    : {}),
                  ...(part.isError ? { isError: true } : {}),
                  app: true as const,
                },
              ]
            : []
        // A published Artifact replays as it streamed live.
        if (part.type === "data" && part.name === ARTIFACT_PART_NAME) {
          const artifact = guestArtifact(part.data)
          return artifact
            ? [{ type: "data", name: ARTIFACT_PART_NAME, data: artifact }]
            : []
        }
        return part.type === "text" ? [{ type: "text", text: part.text }] : []
      }
    )
    // A turn the provider failed reaches a guest as a failed turn, never as an
    // ordinary reply: its public text is projected like any other, and its
    // status carries the guest catalogue's description of the mapped failure.
    const failure =
      message.role === "assistant" && message.status?.type === "incomplete"
        ? publicTurnError(message.turnErrorCode)
        : undefined
    opensTurn ||= message.opensTurn === true
    if (
      content.length === 0 &&
      failure === undefined &&
      !message.attachments?.length
    )
      continue
    messages.push({
      id: message.id,
      role: message.role,
      content,
      createdAt: message.createdAt,
      // The notice naming what started it is a data part, which a guest is not
      // shown; the turn it heads still stands apart.
      ...(opensTurn && message.role === "assistant"
        ? { opensTurn: true as const }
        : {}),
      ...(message.role === "user" && message.attachments?.length
        ? { attachments: message.attachments }
        : {}),
      ...(failure
        ? {
            status: {
              type: "incomplete" as const,
              reason: "error" as const,
              error: guestErrorDescription(failure.code),
            },
          }
        : {}),
    })
    opensTurn = false
  }
  return ProjectedHistorySchema.parse({
    sessionId: publicSessionId,
    messages,
    total: history.total,
    limit: history.limit,
    offset: history.offset,
    nextOffset: history.nextOffset,
    ...(history.execution === undefined
      ? {}
      : {
          execution: {
            status: history.execution.status,
            ...(history.execution.turnId === undefined
              ? {}
              : { turnId: history.execution.turnId }),
          },
        }),
  })
}

export type GuestHistoryOptions = {
  grant: GuestGrant
  /** The MCP servers whose App calls keep their result; none by default. */
  appServers?: readonly string[]
}

export function createHistoryMiddleware({
  grant,
  appServers = [],
}: GuestHistoryOptions): Middleware {
  /**
   * Every user message this guest was shown, in history or as a prompt under
   * the id its provider stored it as, so an Edit or Retry never names the
   * hidden setup turn or anything unseen. Each records whether its text is one
   * a guest may not send, which a Retry would send again as written.
   */
  const shown = new Map<string, boolean>()
  const show = (id: string, texts: readonly string[]) =>
    shown.set(id, texts.some(refusedText))
  return {
    commands: {
      send: async (command, next) => {
        const { rewindSourceId, text } = command
        if (rewindSourceId === undefined) return next(command)
        const refused = shown.get(rewindSourceId)
        // An Edit sends its own text, which the commands layer checked.
        if (refused === undefined || (refused && !text))
          throw new CommandRefusedError("invalid")
        return next(command)
      },
    },
    event(event): MemberEvent | undefined {
      switch (event.kind) {
        // The authoritative page is validated before anything reads it.
        case "history": {
          const page = projectGuestHistory(
            ProjectedHistorySchema.parse(event.page),
            grant.ref,
            appServers
          )
          for (const message of page.messages)
            if (message.role === "user")
              show(
                message.id,
                message.content.flatMap((part) =>
                  part.type === "text" ? [part.text] : []
                )
              )
          return { ...event, page }
        }
        case "prompt":
          show(
            event.messageId,
            event.content.flatMap((part) =>
              part.kind === "text" ? [part.text] : []
            )
          )
          return event
        case "turn":
        case "child":
        case "request-asked":
        case "request-withdrawn":
        case "question-answered":
        case "execution":
        case "usage":
        case "model":
        case "session-info":
        case "commands":
        case "notice":
        case "error":
        case "catalog-invalidated":
        case "activity":
          return event
      }
      return unhandledKind(event)
    },
  }
}
