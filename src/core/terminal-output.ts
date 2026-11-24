import type { TerminalTurnEvent } from "./events"
import { RESTATED_TERMINAL_OUTPUT } from "./limits"

/**
 * The last `max` units of a terminal's output, from the start of a line: a
 * cut drops the line it lands in, since a credential is masked by the name
 * or the word before it on its line, which a cut inside that line may take
 * off. A tail with no line break is none: `undefined`.
 */
export function outputTail(data: string, max: number) {
  if (data.length <= max) return data
  const tail = data.slice(-max)
  const lineEnd = tail.indexOf("\n")
  return lineEnd === -1 ? undefined : tail.slice(lineEnd + 1)
}

/**
 * The output a terminal holds once `step` is folded into `held`: a
 * snapshot replaces it and a chunk appends to it, as far as
 * `RESTATED_TERMINAL_OUTPUT` reaches back, cut as `outputTail` cuts.
 */
export function foldedOutput(
  held: string | undefined,
  { data, output }: Pick<TerminalTurnEvent, "data" | "output">
) {
  const read = output ?? (data === undefined ? held : `${held ?? ""}${data}`)
  return read === undefined
    ? undefined
    : outputTail(read, RESTATED_TERMINAL_OUTPUT)
}
