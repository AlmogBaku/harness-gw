/** What a `fetch` double is called with. */
export type FetchInput = Parameters<typeof fetch>[0]

/** A `fetch` double's call signature, without Bun's `preconnect`. */
export type FetchHandler = (
  input: FetchInput,
  init?: RequestInit
) => Promise<Response>

/** `handler` as the runtime's `fetch`, whose Bun type also carries `preconnect`. */
export function asFetch(handler: FetchHandler): typeof fetch {
  return Object.assign(handler, { preconnect: () => {} })
}
