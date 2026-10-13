import type {
  SessionUpdate,
  StateUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"

import { HGW_META_KEY, type HgwChildSessionMeta } from "../../../protocol/acp"
import {
  ChildSessionStatus,
  type TurnEventKind,
  type TurnEventOf,
} from "../../core/events"
import { maskRequestText } from "../../core/request-text"
import type { Built, TranslateContext } from "../types"
import { turnError, turnMeta } from "./updates"

/** A child's work as ACP's state snapshot mirrors it on its parent. */
const CHILD_STATES = {
  [ChildSessionStatus.Running]: { state: "running" },
  [ChildSessionStatus.WaitingForInput]: { state: "requires_action" },
  [ChildSessionStatus.Idle]: { state: "idle", stopReason: "end_turn" },
  [ChildSessionStatus.Cancelled]: { state: "idle", stopReason: "cancelled" },
  [ChildSessionStatus.Failed]: {
    state: "idle",
    stopReason: "error",
    error: turnError(undefined),
  },
} as const satisfies Record<ChildSessionStatus, Built<StateUpdate>>

/**
 * Text a runtime wrote about a child, as the operator is shown request text:
 * credentials masked, nothing else rewritten.
 */
function shown(text: string, maxChars: number) {
  return maskRequestText(text, "broad").slice(0, maxChars)
}

/**
 * One report of a child Session the turn spawned, as ACP's `subagent_update`
 * on its parent: a patch, which the first report of an id makes the child's
 * announcement. ACP replaces a child's capabilities whole and permits nothing
 * where they are unset, so `cancel` is offered only where the runtime stops
 * the child alone.
 */
export function translateChildUpdate(
  event: TurnEventOf<typeof TurnEventKind.ChildSessionUpdated>,
  context: TranslateContext
): Built<SessionUpdate> {
  const { title, description, status, cancellable, summary } = event
  const meta: HgwChildSessionMeta = {
    ...turnMeta(context),
    ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
    ...(event.model === undefined ? {} : { model: event.model }),
    ...(event.filesRead === undefined ? {} : { filesRead: event.filesRead }),
    ...(event.filesWritten === undefined
      ? {}
      : { filesWritten: event.filesWritten }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(summary === undefined ? {} : { summary: shown(summary, 65_536) }),
  }
  return {
    sessionUpdate: "subagent_update",
    sessionId: event.childSessionId,
    ...(title === undefined ? {} : { title: shown(title, 4_096) }),
    ...(description === undefined
      ? {}
      : { description: shown(description, 4_096) }),
    ...(cancellable === undefined
      ? {}
      : { capabilities: cancellable ? { cancel: {} } : {} }),
    ...(status === undefined ? {} : { state: CHILD_STATES[status] }),
    _meta: { [HGW_META_KEY]: meta },
  }
}
