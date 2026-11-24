import {
  unhandledKind,
  type MemberEvent,
  type Middleware,
} from "../../core/member"

/**
 * The readings a guest is shown: its Session's execution, and its commands,
 * which say what the guest can do. Usage, models, the Session row, the
 * runtime's notices, the Session's background work, the Session list's
 * invalidation and the workspace's activity belong to the operator's
 * workspace, so a guest is given none of them: no state it is shown carries a
 * background list, which leaves the list unreported rather than empty. Every
 * event that is not a reading passes. An operator is given every reading by
 * having no such layer.
 */
/** `event` without the Session's background list. */
function unlisted<Event extends { background?: unknown }>(event: Event) {
  const shown = { ...event }
  delete shown.background
  return shown
}

export function createFeedsMiddleware(): Middleware {
  return {
    event(event): MemberEvent | undefined {
      switch (event.kind) {
        case "usage":
        case "model":
        case "session-info":
        case "notice":
        case "background":
        case "catalog-invalidated":
        case "activity":
          return undefined
        case "execution":
        case "turn":
          return unlisted(event)
        case "commands":
        case "child":
        case "terminal":
        case "child-history":
        case "prompt":
        case "history":
        case "replay-complete":
        case "request-asked":
        case "request-withdrawn":
        case "question-answered":
        case "error":
          return event
      }
      return unhandledKind(event)
    },
  }
}
