/**
 * A Gateway `request<T>` over `answer`. The Gateway answers with untyped wire
 * data that its caller validates, so, as the real client does, the fake hands
 * back whatever `answer` returns as the `T` its caller asked for.
 */
export function wireRequest<Params = unknown>(
  answer: (method: string, params: Params) => unknown
) {
  return async <T>(method: string, params: Params): Promise<T> =>
    (await answer(method, params)) as T
}
