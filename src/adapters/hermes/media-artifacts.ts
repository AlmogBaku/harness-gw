import { createHash } from "node:crypto"
import { safeArtifactPath } from "../../core/artifact-path"
import { MediaLineFilter } from "./media-lines"
import {
  containsPrivateValue,
  isRecord,
  rowText,
  trimmedText,
  utf8BytesWithin,
} from "./native"
import { parseJsonOrValue } from "../todos"

/** Whether the deployment turns the media Hermes delivers into Artifacts. */
export type HermesMediaOptions = { mediaArtifacts?: boolean }

export type HermesMediaArtifact = {
  reference: string
  descriptor: {
    id: string
    filename: string
    mimeType?: string
    source: { type: "provider"; reference: string }
  }
}

const AUDIO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mp4: "audio/mp4",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  webm: "audio/webm",
}

/** The image types Hermes itself accepts for an attachment upload. */
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
}

/** Every type an assistant MEDIA line may deliver; anything else goes untyped. */
const MEDIA_LINE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ...AUDIO_MIME_BY_EXTENSION,
  ...IMAGE_MIME_BY_EXTENSION,
  csv: "text/csv",
  html: "text/html",
  json: "application/json",
  md: "text/markdown",
  mp4: "video/mp4",
  pdf: "application/pdf",
  svg: "image/svg+xml",
  txt: "text/plain",
  webm: "video/webm",
  zip: "application/zip",
}

function extensionOf(filename: string) {
  return filename.match(/\.([A-Za-z0-9]+)$/u)?.[1]?.toLowerCase()
}

/**
 * The public filename and media type of a native reference, or `undefined` when
 * the reference is unusable or names a type the given map does not cover. One
 * rule for every media kind: the native path itself never becomes public.
 */
function safeMediaReference(
  reference: string,
  mimeByExtension: Readonly<Record<string, string>>
) {
  if (
    reference !== reference.trim() ||
    !reference ||
    utf8BytesWithin(reference, 4_096) === undefined ||
    [...reference].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
    return undefined
  const filename = reference.split(/[\\/]/u).at(-1)
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    utf8BytesWithin(filename, 255) === undefined
  )
    return undefined
  const extension = extensionOf(filename)
  const mimeType = extension ? mimeByExtension[extension] : undefined
  return mimeType ? { filename, mimeType } : undefined
}

function artifactId(scope: string, reference: string) {
  const digest = createHash("sha256")
    .update(scope)
    .update("\0")
    .update(reference)
    .digest("hex")
    .slice(0, 32)
  return `hermes-media-${digest}`
}

/**
 * One opaque artifact over a native reference. The public `source.reference` is
 * the artifact id, never the path, so a content read resolves the path back from
 * authoritative history instead of trusting the browser for it.
 */
function mediaArtifact(
  scope: string,
  reference: string,
  media: { filename: string; mimeType?: string }
): HermesMediaArtifact {
  const id = artifactId(scope, reference)
  return {
    reference,
    descriptor: { id, ...media, source: { type: "provider", reference: id } },
  }
}

// ---------------------------------------------------------------------------
// Attached images on a durable user row
// ---------------------------------------------------------------------------

/**
 * Hermes persists an uploaded image as an `@image:<path>` directive line on the
 * user row it was sent with (`tui_gateway/session_history.py`). The line is
 * native authority for bytes the provider still holds, and never text an
 * operator should read: it names a gateway-local path.
 */
const IMAGE_DIRECTIVE_LINE =
  /^\s*@image:(?:`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))\s*$/u

/**
 * The model-only form of the same attachment, `_build_image_ref_message` in
 * `tui_gateway/session_history.py`. Hermes never persists it on purpose, but
 * a compaction during the turn rewrites the row from its model payload, so
 * the directive is lost and this pair of lines stands in its place.
 */
const IMAGE_REF_BLOCK =
  /^\[The user attached an image: [^\r\n]*\]\r?\n\[Examine it with the vision_analyze tool using image_url: ([^\r\n]+)\]$/gmu

/** The scope every attached-image id is derived under; no tool call owns one. */
const ATTACHED_IMAGE_SCOPE = "hermes:attached-image"

/**
 * The artifact an attached image's native path reads as, or `undefined` when
 * the path is unusable. A staged upload and the directive its row later
 * persists derive the same id, so the live echo and history show one image.
 */
export function hermesAttachedImageArtifact(reference: string) {
  const image = safeMediaReference(reference, IMAGE_MIME_BY_EXTENSION)
  return image && mediaArtifact(ATTACHED_IMAGE_SCOPE, reference, image)
}

/**
 * Split a durable user row's text into the prose the operator wrote and the
 * images it attached. Every directive line leaves the text whether or not its
 * reference is usable, so a marker never reaches the browser as prose.
 */
export function projectHermesAttachedImages(text: string) {
  const prose: string[] = []
  const artifacts: HermesMediaArtifact[] = []
  const seen = new Set<string>()
  const attach = (reference: string) => {
    const artifact = hermesAttachedImageArtifact(reference)
    if (!artifact || seen.has(reference)) return
    seen.add(reference)
    artifacts.push(artifact)
  }
  const rest = text.replace(IMAGE_REF_BLOCK, (_, reference: string) => {
    attach(reference)
    return ""
  })
  for (const line of rest.split(/\r?\n/u)) {
    const reference = IMAGE_DIRECTIVE_LINE.exec(line)?.slice(1).find(Boolean)
    if (reference === undefined) prose.push(line)
    else attach(reference)
  }
  return { text: prose.join("\n").trim(), artifacts }
}

// ---------------------------------------------------------------------------
// Assistant MEDIA lines
// ---------------------------------------------------------------------------

/**
 * The scope every MEDIA-line id is derived under. Neither the live run nor the
 * durable history knows the other's message id, so the reference alone keys
 * the id: the same line reads as the same artifact streaming and after refresh.
 */
const MEDIA_LINE_SCOPE = "hermes:media-line"

/** The artifact one assistant MEDIA line delivers, if its path may be read. */
function mediaLineArtifact(reference: string) {
  const path = safeArtifactPath(reference)
  const filename = path?.split("/").at(-1)
  if (!path || !filename || !safeArtifactToken(filename, 255)) return undefined
  const extension = extensionOf(filename)
  const mimeType = extension
    ? MEDIA_LINE_MIME_BY_EXTENSION[extension]
    : undefined
  return mediaArtifact(MEDIA_LINE_SCOPE, path, {
    filename,
    ...(mimeType ? { mimeType } : {}),
  })
}

/**
 * Incrementally removes Hermes MEDIA lines without exposing paths. A readable
 * line becomes an artifact.
 */
export class HermesMediaTextFilter {
  readonly #published = new Set<string>()
  #artifacts: HermesMediaArtifact[] = []
  readonly #lines?: MediaLineFilter

  /**
   * With `mediaArtifacts` off the deployment publishes no media, so the text
   * passes through as Hermes wrote it, MEDIA lines included.
   */
  constructor({ mediaArtifacts = true }: HermesMediaOptions = {}) {
    if (mediaArtifacts)
      this.#lines = new MediaLineFilter((reference) => this.#claim(reference))
  }

  write(value: string) {
    return this.#lines ? this.#lines.write(value) : value
  }

  finish() {
    return this.#lines?.finish() ?? ""
  }

  /** The artifacts the lines filtered since the last call delivered. */
  takeArtifacts() {
    const artifacts = this.#artifacts
    this.#artifacts = []
    return artifacts
  }

  #claim(reference: string) {
    const artifact = mediaLineArtifact(reference)
    if (!artifact) return false
    if (!this.#published.has(artifact.descriptor.id)) {
      this.#published.add(artifact.descriptor.id)
      this.#artifacts.push(artifact)
    }
    return true
  }
}

export function projectHermesMediaText(
  text: string,
  options: HermesMediaOptions = {}
) {
  if (options.mediaArtifacts === false) return { text, artifacts: [] }
  const filter = new HermesMediaTextFilter()
  const projected = `${filter.write(text)}${filter.finish()}`
  return {
    text: projected.replace(/\n$/u, ""),
    artifacts: filter.takeArtifacts(),
  }
}

// ---------------------------------------------------------------------------
// Published `hgw.artifact` receipts
// ---------------------------------------------------------------------------

function safeArtifactToken(value: string, maxLength: number) {
  return (
    value.length <= maxLength &&
    !/[\\/]/u.test(value) &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    }) &&
    value !== "." &&
    value !== ".." &&
    !containsPrivateValue(value)
  )
}

/** The media a durable row delivers, keyed by the artifact id each one reads as. */
function rowMedia(row: Record<string, unknown>): HermesMediaArtifact[] {
  if (trimmedText(row.display_kind)) return []
  const text = rowText(row, parseJsonOrValue(row.content))
  // The directive the operator's own turn persisted is authority for the image
  // it attached, and an assistant's MEDIA line for the file it delivered: only a
  // reference this Session's transcript still carries can be read back.
  if (row.role === "user") return projectHermesAttachedImages(text).artifacts
  if (row.role === "assistant") return projectHermesMediaText(text).artifacts
  return []
}

/**
 * Resolve one already-published artifact id to its native reference by scanning
 * authoritative history newest-first. Only an attached image or an assistant
 * MEDIA line grants authority, and every reference it resolves to
 * is an absolute path {@link safeArtifactPath} accepts.
 */
export function publishedArtifact(
  rows: readonly unknown[],
  artifactId: string
) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (!isRecord(row)) continue
    const media = rowMedia(row).find(
      ({ descriptor }) => descriptor.id === artifactId
    )
    if (media)
      return { reference: media.reference, filename: media.descriptor.filename }
  }
  return undefined
}
