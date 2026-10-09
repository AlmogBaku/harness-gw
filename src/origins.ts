/**
 * Which browser pages a listener serves, judged once for every request before
 * it reaches a socket or a route: upgrades never reach the HTTP app, so the
 * rule cannot live in it.
 */
export type OriginPolicy = {
  /** The exact origins this listener's pages are served from. */
  allowedOrigins: readonly string[]
}

/** The methods a page reads with; every other one changes state. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const PREFLIGHT_MAX_AGE_S = "600"

function refused() {
  return new Response(null, { status: 403, headers: { vary: "Origin" } })
}

/**
 * Serves `request` through `next` only when its Origin may send it. A socket
 * upgrade or a state change from a browser needs a listed Origin; one with no
 * Origin at all comes from no browser page, so it passes, as a script or a
 * non-browser ACP client sends it. A read is never checked, so
 * a view in an opaque-origin frame still reads the file its pass names. CORS
 * answers listed origins alone, and never with credentials.
 */
export async function guardOrigins(
  policy: OriginPolicy,
  request: Request,
  next: () => Promise<Response | undefined> | Response | undefined
): Promise<Response | undefined> {
  const origin = request.headers.get("origin")
  const listed = origin !== null && policy.allowedOrigins.includes(origin)
  if (
    request.method === "OPTIONS" &&
    request.headers.has("access-control-request-method")
  ) {
    if (!listed) return refused()
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
        "access-control-allow-headers":
          request.headers.get("access-control-request-headers") ?? "",
        "access-control-max-age": PREFLIGHT_MAX_AGE_S,
        vary: "Origin",
      },
    })
  }
  const checked =
    !READ_METHODS.has(request.method) || request.headers.has("upgrade")
  if (checked && origin !== null && !listed) return refused()
  const response = await next()
  if (!response) return response
  const answered = new Response(response.body, response)
  answered.headers.append("vary", "Origin")
  if (listed) answered.headers.set("access-control-allow-origin", origin)
  return answered
}
