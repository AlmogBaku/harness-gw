import type { Logger } from "../../lifecycle"

/**
 * Calls every listener with `args`, each on its own: one that throws is
 * logged as `event` and costs only itself, never the listeners after it nor
 * the caller that fanned out to them.
 */
export function callEach<Args extends readonly unknown[]>(
  listeners: Iterable<(...args: Args) => void>,
  logger: Logger | undefined,
  event: string,
  ...args: Args
) {
  for (const listener of [...listeners])
    try {
      listener(...args)
    } catch (err) {
      logger?.warn({ err }, event)
    }
}
