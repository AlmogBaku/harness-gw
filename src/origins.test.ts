// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import { guardOrigins, type OriginPolicy } from "./origins"
import { isInvitationCreation } from "./routes/invitations"

const OPERATOR = "https://aos.example.test"
const GUEST = "https://guest.example.test"
const FOREIGN = "https://attacker.example.test"
/** Each lane's policy, as the composition builds it. */
const LANES: Record<"operator" | "guest", OriginPolicy> = {
  operator: { allowedOrigins: [OPERATOR], admitsMissing: isInvitationCreation },
  guest: { allowedOrigins: [GUEST] },
}

function request(
  lane: keyof typeof LANES,
  path: string,
  init: { method?: string; origin?: string; headers?: Record<string, string> }
) {
  const base = lane === "operator" ? OPERATOR : GUEST
  return new Request(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.origin === undefined ? {} : { origin: init.origin }),
      ...init.headers,
    },
  })
}

async function served(
  lane: keyof typeof LANES,
  ...args: Parameters<typeof request> extends [unknown, ...infer Rest]
    ? Rest
    : never
) {
  const next = vi.fn(() => new Response(null, { status: 204 }))
  const response = await guardOrigins(LANES[lane], request(lane, ...args), next)
  return { response, reached: next.mock.calls.length > 0 }
}

const STAGE = "/api/v1/agents/a/sessions/s/attachments/stage"
const UPGRADE = { upgrade: "websocket", "sec-websocket-key": "a2V5" }

describe("origin guard", () => {
  it.each([
    ["operator", OPERATOR],
    ["guest", GUEST],
  ] as const)(
    "on the %s listener admits a state change or upgrade from a listed page only",
    async (lane, own) => {
      const other = lane === "operator" ? GUEST : OPERATOR
      const outcomes: Record<string, number | "reached"> = {}
      for (const [name, origin] of [
        ["own", own],
        ["missing", undefined],
        ["null", "null"],
        ["foreign", FOREIGN],
        ["other lane", other],
      ] as const)
        for (const [kind, init] of [
          ["post", { method: "POST" }],
          ["upgrade", { headers: UPGRADE }],
        ] as const) {
          const path = kind === "post" ? STAGE : "/api/v1/acp"
          const { response, reached } = await served(lane, path, {
            ...init,
            ...(origin === undefined ? {} : { origin }),
          })
          outcomes[`${kind} ${name}`] = reached ? "reached" : response!.status
        }

      expect(outcomes).toEqual({
        "post own": "reached",
        "upgrade own": "reached",
        "post missing": 403,
        "upgrade missing": 403,
        "post null": 403,
        "upgrade null": 403,
        "post foreign": 403,
        "upgrade foreign": 403,
        "post other lane": 403,
        "upgrade other lane": 403,
      })
    }
  )

  it("admits a missing Origin only on the operator's invitation creation", async () => {
    const invite = { method: "POST" }
    expect(
      (await served("operator", "/api/v1/guest-invitations", invite)).reached
    ).toBe(true)
    expect(
      (await served("guest", "/api/v1/guest-invitations", invite)).reached
    ).toBe(false)
    expect(
      (
        await served("operator", "/api/v1/guest-invitations", {
          ...invite,
          origin: FOREIGN,
        })
      ).reached
    ).toBe(false)
  })

  it("answers CORS for a listed origin alone, varying by Origin and never with credentials", async () => {
    const preflight = {
      method: "OPTIONS",
      headers: {
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    }
    const listed = await served("operator", STAGE, {
      ...preflight,
      origin: OPERATOR,
    })
    expect(listed.reached).toBe(false)
    expect(listed.response!.status).toBe(204)
    expect(
      Object.fromEntries(
        [...listed.response!.headers].filter(([name]) =>
          name.startsWith("access-control-allow-")
        )
      )
    ).toEqual({
      "access-control-allow-origin": OPERATOR,
      "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
      "access-control-allow-headers": "content-type",
    })
    expect(listed.response!.headers.get("vary")).toBe("Origin")

    const foreign = await served("operator", STAGE, {
      ...preflight,
      origin: FOREIGN,
    })
    expect(foreign.response!.status).toBe(403)
    expect(foreign.response!.headers.has("access-control-allow-origin")).toBe(
      false
    )

    const read = await served("operator", "/api/v1/runtime", {
      origin: OPERATOR,
    })
    expect(read.response!.headers.get("access-control-allow-origin")).toBe(
      OPERATOR
    )
    expect(read.response!.headers.get("vary")).toBe("Origin")
  })

  it("serves a read from any page, adding no grant for a foreign one", async () => {
    for (const origin of [FOREIGN, "null"]) {
      const { response, reached } = await served(
        "operator",
        "/api/v1/runtime",
        {
          origin,
        }
      )
      expect(reached, origin).toBe(true)
      expect(response!.headers.has("access-control-allow-origin"), origin).toBe(
        false
      )
    }
  })

  it("keeps the grant a pass-bearing file answer gave its opaque-origin view", async () => {
    const response = await guardOrigins(
      LANES.operator,
      request("operator", "/api/v1/file?pass=p", { origin: "null" }),
      () =>
        new Response("bytes", {
          headers: { "access-control-allow-origin": "null" },
        })
    )

    expect(response!.headers.get("access-control-allow-origin")).toBe("null")
  })
})
