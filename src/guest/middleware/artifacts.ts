import {
  ArtifactDescriptorSchema,
  type ArtifactDescriptor,
} from "../../../protocol"
import { validIdentifier } from "../../core/identifier"

/** The data part a stored Artifact travels in, as the history translation names it. */
export const ARTIFACT_PART_NAME = "hgw.artifact"

/**
 * What a guest is shown of a published Artifact, live or replayed: one the
 * provider holds, by its id alone, and never inline data.
 */
export function guestArtifact(value: unknown): ArtifactDescriptor | undefined {
  const parsed = ArtifactDescriptorSchema.safeParse(value)
  if (!parsed.success) return undefined
  const { id, filename, mimeType, sizeBytes, source } = parsed.data
  if (
    !validIdentifier(id) ||
    source.type !== "provider" ||
    source.reference !== id
  )
    return undefined
  return {
    id,
    filename,
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    source: { type: "provider", reference: id },
  }
}
