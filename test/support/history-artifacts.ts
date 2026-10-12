import type { SessionHistoryResponse } from "../../protocol"

/** The Artifact ids a history page's messages carry, in order. */
export function artifactIds(page: SessionHistoryResponse) {
  return page.messages.flatMap((message) =>
    message.role === "activity"
      ? []
      : message.content.flatMap((part) =>
          part.type === "data" ? [(part.data as { id: string }).id] : []
        )
  )
}
