/**
 * A JSON value, such as a history data part's `data`, as an object whose fields
 * a test can read; `undefined` when the value is not an object.
 */
export function jsonObject(
  value: unknown
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
