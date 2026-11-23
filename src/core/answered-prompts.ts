import type { SessionHistoryResponse } from "../../protocol"

/** How many prompts answered before their receipt are remembered, in all. */
export const MAX_ANSWERED_PROMPTS = 1_000

/**
 * The prompts a coordinator answered before their provider proved it stored
 * them, each with the id the provider later stored it under. ACP has a
 * replayed prompt keep the id its `session/prompt` answer returned, so a
 * history page shows each under its answer's id, and a rewind that names
 * that id reaches the provider as the provider's own. Held in memory, by
 * Session key, the newest `limit` of them.
 */
export class AnsweredPrompts {
  /** Each, by Session key and the provider's id. */
  readonly #answered = new Map<string, { key: string; answeredId: string }>()
  /** The provider's id of each, by Session key and the answer's id. */
  readonly #stored = new Map<string, string>()
  readonly #limit: number

  constructor(limit = MAX_ANSWERED_PROMPTS) {
    this.#limit = limit
  }

  /** Remembers that Session `key` answered `answeredId` for `storedId`. */
  remember(key: string, storedId: string, answeredId: string) {
    if (storedId === answeredId) return
    this.#answered.set(pair(key, storedId), { key, answeredId })
    this.#stored.set(pair(key, answeredId), storedId)
    for (const [oldest, prompt] of this.#answered) {
      if (this.#answered.size <= this.#limit) break
      this.#answered.delete(oldest)
      this.#stored.delete(pair(prompt.key, prompt.answeredId))
    }
  }

  /** `page` with each prompt Session `key` answered under its answer's id. */
  page(key: string, page: SessionHistoryResponse): SessionHistoryResponse {
    if (this.#answered.size === 0) return page
    return {
      ...page,
      messages: page.messages.map((message) => {
        const answered =
          message.role === "user"
            ? this.#answered.get(pair(key, message.id))
            : undefined
        return answered ? { ...message, id: answered.answeredId } : message
      }),
    }
  }

  /** The provider's own id of the prompt Session `key` answered as `id`. */
  storedId(key: string, id: string) {
    return this.#stored.get(pair(key, id)) ?? id
  }

  /** Forgets every prompt of Session `key`, which is gone. */
  forget(key: string) {
    for (const [entry, prompt] of this.#answered)
      if (prompt.key === key) {
        this.#answered.delete(entry)
        this.#stored.delete(pair(key, prompt.answeredId))
      }
  }
}

/** One Session key and one message id, as both maps key them. */
function pair(key: string, messageId: string) {
  return `${key}\u0001${messageId}`
}
