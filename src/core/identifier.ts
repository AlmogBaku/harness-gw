/** A public identifier: 1 to 256 characters, none of them a control character. */
export function validIdentifier(value: string) {
  return (
    value.length >= 1 &&
    value.length <= 256 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )
}

/** The most of an id read off a rejected row that a warning carries. */
const LOGGED_ID_LENGTH = 256

/**
 * The id at `path` in a row not yet checked, bounded for a warning. A warning
 * about a rejected row names it by this alone, never by its content.
 */
export function loggedId(row: unknown, ...path: string[]) {
  let value = row
  for (const key of path)
    value =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined
  return typeof value === "string" && value.length > 0
    ? value.slice(0, LOGGED_ID_LENGTH)
    : undefined
}
