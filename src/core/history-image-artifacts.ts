import { createHash } from "node:crypto"

import type {
  ArtifactDescriptor,
  SessionHistoryResponse,
  SessionMessage,
} from "../../protocol"
import { HISTORY_REACH, hasOlderPage } from "./channel"
import { failureOf } from "./failures"
import type { ProviderSessionId } from "./ids"
import type { ServerRuntime } from "./runtime"

/**
 * Stored user images, sent by reference. A provider that keeps an attached
 * image in its transcript as a data URL would otherwise replay those bytes over
 * the one socket every Session of the browser shares, so each such part
 * replays as an Artifact instead, and the artifact route reads its bytes back
 * from the history page that showed it.
 */

/** The prefix of every id this module mints; any other id is the runtime's. */
const ID_PREFIX = "hgw-image-"

/** The `data` part name an Artifact travels under in history. */
const ARTIFACT_PART_NAME = "hgw.artifact"

/** The image types an artifact read serves as images, with their extension. */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}

const DATA_URL_HEADER = /^data:([^;,]+);base64,/u

/** How many ids the locator remembers across every Session, newest kept. */
const MAX_LOCATIONS = 1_024

/** How many pages, newest first, a read the locator cannot place may scan. */
const SCAN_PAGES = 4

/** How long an id no scan found is answered as gone without another. */
const MISS_TTL_MS = 30_000
const MAX_MISSES = 1_024

type ImagePart = Extract<SessionMessage["content"][number], { type: "image" }>

/** Where an id was read: the page its caller asked for, and its part there. */
type Location = {
  limit: number
  offset: number
  messageId: string
  index: number
}

/** A history image no page within reach holds any more. */
class HistoryImageGoneError extends Error {
  constructor() {
    super("This image is no longer available")
    this.name = "HistoryImageGoneError"
  }
}

/** Keeps the newest `max` entries: a write moves its key to the newest end. */
function remember<V>(map: Map<string, V>, key: string, value: V, max: number) {
  map.delete(key)
  map.set(key, value)
  if (map.size > max) map.delete(map.keys().next().value!)
}

function decodedSize(base64: string) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

/**
 * The Artifact a data-URL image part reads as, and its base64 bytes. The id
 * hashes the Session, the bytes, and the part's place in its message, so it
 * is the same on every read whatever id the message carries, guesses nothing
 * from a row's position, and tells two equal images of one message apart.
 */
function storedImage(
  providerSessionId: string,
  part: ImagePart,
  index: number
) {
  const header = DATA_URL_HEADER.exec(part.image)
  if (!header) return undefined
  const type = header[1]!.toLowerCase()
  const extension = Object.hasOwn(IMAGE_EXTENSIONS, type)
    ? IMAGE_EXTENSIONS[type]
    : undefined
  const data = part.image.slice(header[0].length)
  const digest = createHash("sha256")
    .update(providerSessionId)
    .update("\0")
    .update(part.image)
    .update("\0")
    .update(String(index))
    .digest("hex")
    .slice(0, 32)
  const id = `${ID_PREFIX}${digest}`
  const descriptor: ArtifactDescriptor = {
    id,
    filename: part.filename ?? (extension ? `image.${extension}` : "image"),
    ...(extension ? { mimeType: type } : {}),
    sizeBytes: decodedSize(data),
    source: { type: "provider", reference: id },
  }
  return { descriptor, data }
}

/** Every image part of a page, as the message and place it sits at. */
function imageParts(page: SessionHistoryResponse) {
  return page.messages.flatMap((message) =>
    message.role === "activity"
      ? []
      : message.content.flatMap((part, index) =>
          part.type === "image" ? [{ messageId: message.id, part, index }] : []
        )
  )
}

/**
 * The bytes of the image `artifactId` names on this page, reading the part
 * the locator placed it at first, so a placed read hashes one image.
 */
function servedImage(
  page: SessionHistoryResponse,
  providerSessionId: string,
  artifactId: string,
  placed?: Location
) {
  const parts = imageParts(page)
  const at = (candidate: (typeof parts)[number]) =>
    candidate.messageId === placed?.messageId &&
    candidate.index === placed.index
  for (const { part, index } of [
    ...parts.filter(at),
    ...parts.filter((candidate) => !at(candidate)),
  ]) {
    const image = storedImage(providerSessionId, part, index)
    if (image?.descriptor.id !== artifactId) continue
    const { filename, mimeType } = image.descriptor
    return {
      bytes: new Uint8Array(Buffer.from(image.data, "base64")),
      ...(mimeType ? { mimeType } : {}),
      filename,
    }
  }
  return undefined
}

/**
 * Serves a runtime's stored data-URL images by reference, without touching the
 * adapter: history replays each as an Artifact, and an artifact read of one
 * re-reads the page it was shown on through the native history, single-flight
 * per page. An id the locator cannot place, as after a restart, is looked for
 * on the newest `scanPages` pages; one none of them holds is gone, and stays
 * gone for a while without another scan. Every other id is the runtime's own.
 */
export function withHistoryImageArtifacts<Runtime extends ServerRuntime>(
  native: Runtime,
  {
    scanPages = SCAN_PAGES,
    now = Date.now,
  }: { scanPages?: number; now?: () => number } = {}
): Runtime {
  const locations = new Map<string, Location>()
  const misses = new Map<string, number>()
  const reads = new Map<string, Promise<SessionHistoryResponse>>()
  const keyOf = (...parts: readonly (string | number)[]) =>
    JSON.stringify(parts)

  function read(
    agentId: string,
    providerSessionId: ProviderSessionId,
    limit: number,
    offset: number
  ) {
    const key = keyOf(agentId, providerSessionId, limit, offset)
    let pending = reads.get(key)
    if (!pending) {
      pending = native
        .history(agentId, providerSessionId, limit, offset)
        .finally(() => reads.delete(key))
      reads.set(key, pending)
    }
    return pending
  }

  async function scan(
    agentId: string,
    providerSessionId: ProviderSessionId,
    artifactId: string
  ) {
    let offset = 0
    for (let pages = 0; pages < scanPages; pages += 1) {
      const page = await read(
        agentId,
        providerSessionId,
        HISTORY_REACH.pageSize,
        offset
      )
      const found = servedImage(page, providerSessionId, artifactId)
      if (found || !hasOlderPage(page, HISTORY_REACH.maxOffset)) return found
      offset = page.nextOffset
    }
    return undefined
  }

  async function find(
    agentId: string,
    providerSessionId: ProviderSessionId,
    artifactId: string
  ) {
    const key = keyOf(agentId, providerSessionId, artifactId)
    const placed = locations.get(key)
    if (placed) {
      const page = await read(
        agentId,
        providerSessionId,
        placed.limit,
        placed.offset
      )
      const found = servedImage(page, providerSessionId, artifactId, placed)
      if (found) return found
    }
    if ((misses.get(key) ?? 0) > now()) return undefined
    const found = await scan(agentId, providerSessionId, artifactId)
    if (!found) remember(misses, key, now() + MISS_TTL_MS, MAX_MISSES)
    return found
  }

  /**
   * A child Session's transcript without its data-URL images: no Session's
   * artifact read reaches a child, so its bytes would ride the shared socket
   * whole, and one large image could pass the frame cap.
   */
  async function childHistory(
    ...[agentId, providerSessionId, childSessionId]: Parameters<
      NonNullable<ServerRuntime["childHistory"]>
    >
  ) {
    const page = await native.childHistory!(
      agentId,
      providerSessionId,
      childSessionId
    )
    const messages = page.messages.map((message) =>
      message.role === "activity"
        ? message
        : {
            ...message,
            content: message.content.filter(
              (part) => part.type !== "image" || !part.image.startsWith("data:")
            ),
          }
    )
    return { ...page, messages }
  }

  const overrides: Pick<
    ServerRuntime,
    "history" | "artifact" | "publicError" | "childHistory"
  > = {
    async history(agentId, providerSessionId, limit, offset) {
      const page = await native.history(
        agentId,
        providerSessionId,
        limit,
        offset
      )
      const messages = page.messages.map((message) => {
        if (message.role === "activity") return message
        const content = message.content.map((part, index) => {
          const image =
            part.type === "image"
              ? storedImage(providerSessionId, part, index)
              : undefined
          if (!image) return part
          remember(
            locations,
            keyOf(agentId, providerSessionId, image.descriptor.id),
            { limit, offset, messageId: message.id, index },
            MAX_LOCATIONS
          )
          return {
            type: "data" as const,
            name: ARTIFACT_PART_NAME,
            data: image.descriptor,
          }
        })
        return { ...message, content }
      })
      return { ...page, messages }
    },
    async artifact(agentId, publicSessionId, artifactId) {
      if (!artifactId.startsWith(ID_PREFIX))
        return native.artifact(agentId, publicSessionId, artifactId)
      const providerSessionId = native.resolveProviderSessionId(
        agentId,
        publicSessionId
      )
      const found =
        providerSessionId === undefined
          ? undefined
          : await find(agentId, providerSessionId, artifactId)
      if (!found) throw new HistoryImageGoneError()
      return found
    },
    publicError(cause) {
      return cause instanceof HistoryImageGoneError
        ? failureOf("gone", cause)
        : native.publicError(cause)
    },
    // A runtime that keeps no child transcript keeps reporting none.
    ...(native.childHistory ? { childHistory } : {}),
  }

  return new Proxy(native, {
    get(target, property) {
      if (Object.hasOwn(overrides, property))
        return overrides[property as keyof typeof overrides]
      // Adapters keep their state in `#private` fields, so a delegated method
      // has to stay bound to the native instance rather than to this Proxy.
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
