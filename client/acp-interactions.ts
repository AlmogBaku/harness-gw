import { HGW_META_KEY, HgwElicitationMetaSchema } from "../protocol/acp"
import type {
  RuntimeInteractionAdapter,
  RuntimeQuestion,
  RuntimeQuestionRequest,
} from "./workspace"
import type { AcpConnection, AcpPendingRequest } from "./types"

/**
 * Projects ACP's elicitations onto the shared question composer, carrying the
 * lossless questions the gateway put in `_meta.hgw`. One pending request per
 * Session, replaced by the next one the gateway sends. Permissions are tool
 * approvals instead, answered on the card of the call they guard
 * (`acp-approvals.ts`).
 *
 * Every UI with the Session open receives the same request. When another UI
 * answers it, or Stop ends the wait, the gateway withdraws this UI's copy with
 * `$/cancel_request`, which aborts the request's own signal.
 */

type ElicitationRequest = Extract<AcpPendingRequest, { kind: "elicitation" }>

type PendingEntry = {
  request: RuntimeQuestionRequest
  pending: ElicitationRequest
}

/**
 * Elicitation answers travel under the `q0..qn` property keys the gateway puts
 * in `requestedSchema`: one string per single-select question, the full array
 * for a multi-select one.
 */
function elicitationContent(
  questions: readonly RuntimeQuestion[],
  answers: readonly string[][]
) {
  const content: Record<string, string | string[]> = {}
  questions.forEach((question, index) => {
    const answer = answers[index] ?? []
    content[`q${index}`] = question.multiple ? [...answer] : (answer[0] ?? "")
  })
  return content
}

export function createAcpInteractions({
  connection,
}: {
  connection: Pick<AcpConnection, "subscribePendingRequests">
}): RuntimeInteractionAdapter {
  const entries = new Map<string, PendingEntry>()
  const listeners = new Map<string, Set<() => void>>()

  function notify(sessionId: string) {
    listeners.get(sessionId)?.forEach((listener) => listener())
  }

  /**
   * The composer's view of one elicitation, or `undefined` when the gateway's
   * projection cannot be read. It carries its questions only in `_meta.hgw`,
   * so a payload this contract rejects has nothing to render; failing here
   * instead would answer the runtime on the operator's behalf.
   * The request stays pending for the re-issue a later resume performs.
   */
  function project(
    pending: ElicitationRequest,
    sessionId: string
  ): RuntimeQuestionRequest | undefined {
    const meta = HgwElicitationMetaSchema.safeParse(
      pending.request._meta?.[HGW_META_KEY]
    )
    if (!meta.success) return undefined
    return {
      kind: "question",
      requestId: meta.data.requestId,
      sessionId,
      questions: meta.data.questions,
    }
  }

  function drop(sessionId: string) {
    entries.delete(sessionId)
    notify(sessionId)
  }

  function take(request: RuntimeQuestionRequest) {
    const entry = entries.get(request.sessionId)
    if (!entry || entry.request.requestId !== request.requestId) return
    drop(request.sessionId)
    return entry.pending
  }

  connection.subscribePendingRequests((pending) => {
    if (pending.kind !== "elicitation") return
    // Request-scoped elicitations belong to no Session the operator can see.
    const sessionId = pending.sessionId
    if (sessionId === undefined) return
    const request = project(pending, sessionId)
    if (request === undefined) return
    entries.set(sessionId, { request, pending })
    notify(sessionId)
    // A withdrawn request leaves the Session only while it is still the one
    // shown there; a newer request has replaced it otherwise.
    pending.signal.addEventListener(
      "abort",
      () => {
        if (entries.get(sessionId)?.pending === pending) drop(sessionId)
      },
      { once: true }
    )
  })

  return {
    async respond(request, response) {
      const pending = take(request)
      if (!pending) return
      pending.respond({
        action: "accept",
        content: elicitationContent(request.questions, response.answers),
      })
    },

    async reject(request) {
      const pending = take(request)
      pending?.respond({ action: "cancel" })
    },

    dismiss(request) {
      take(request)
    },

    getPending(sessionId) {
      return entries.get(sessionId)?.request
    },

    subscribe(sessionId, listener) {
      const existing = listeners.get(sessionId) ?? new Set<() => void>()
      existing.add(listener)
      listeners.set(sessionId, existing)
      return () => {
        existing.delete(listener)
        if (existing.size === 0) listeners.delete(sessionId)
      }
    },
  }
}
