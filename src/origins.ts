/**
 * Which hosts and browser pages a listener serves, judged once for every
 * request before it reaches a socket or a route: upgrades never reach the HTTP
 * app, so the rule cannot live in it.
 */
export type OriginPolicy = {
  /**
   * The exact origins this listener's pages are served from, whose hosts are
   * the only names it answers besides loopback.
   */
  allowedOrigins: readonly string[]
}

/** The methods a page reads with; every other one changes state. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const PREFLIGHT_MAX_AGE_S = "600"
/** The ports a Host header may name or leave out for an origin on them. */
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  "http:": "80",
  "https:": "443",
}
/** This machine by name, on any port; `*.localhost` is not among them. */
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/u

function refused() {
  return new Response(null, { status: 403, headers: { vary: "Origin" } })
}

/**
 * The host and port a request is addressed to (RFC 9110 §7.2): its Host
 * header, or its URL's where it sent none, as a request made in-process does.
 */
function targetHost(request: Request) {
  const host = request.headers.get("host")
  if (host !== null) return host.toLowerCase()
  try {
    return new URL(request.url).host
  } catch {
    return undefined
  }
}

/**
 * Whether a listener answers a request addressed to `host`: the host and port
 * of one of its origins, a default port named or left out, or loopback.
 */
function servesHost(policy: OriginPolicy, host: string | undefined) {
  if (host === undefined) return false
  if (LOOPBACK_HOST.test(host)) return true
  return policy.allowedOrigins.some((origin) => {
    const url = new URL(origin)
    return (
      host === url.host ||
      (url.port === "" && host === `${url.host}:${DEFAULT_PORTS[url.protocol]}`)
    )
  })
}

/**
 * Serves `request` through `next` only when it is addressed to a host the
 * listener serves and its Origin may send it. Any other host gets 421, so a
 * proxy that sends another name's requests here, such as a sandbox origin's,
 * fails closed. A socket upgrade or a state change from a browser needs a
 * listed Origin; one with no Origin at all comes from no browser page, so it
 * passes, as a script or a non-browser ACP client sends it. A read is never
 * checked: it changes nothing, and no other origin reads its answer, since
 * CORS answers listed origins alone, and never with credentials.
 */
export async function guardOrigins(
  policy: OriginPolicy,
  request: Request,
  next: () => Promise<Response | undefined> | Response | undefined
): Promise<Response | undefined> {
  if (!servesHost(policy, targetHost(request)))
    return new Response(null, { status: 421 })
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
