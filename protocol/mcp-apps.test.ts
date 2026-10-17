import { describe, expect, it } from "vitest"

import {
  appliedMcpAppCsp,
  isMcpAppPolicyOrigin,
  mcpAppSandboxPolicy,
} from "./mcp-apps"

const LANE = "https://aos.example.invalid"
const LOOPBACK_LANE = "http://127.0.0.1:3000"
const SANDBOX = "https://sandbox.example.invalid"
/** A lane reached by name and on loopback, and its sandbox origin. */
const ORIGINS = {
  frameAncestors: [LANE, LOOPBACK_LANE],
  sandboxOrigin: SANDBOX,
}
const FILE = `${LANE}/api/v1/agents/a/sessions/s/tool-calls/c/app/files/path`
const DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "media-src",
  "connect-src",
  "worker-src",
  "frame-src",
  "base-uri",
  "object-src",
  "form-action",
  "frame-ancestors",
]

/** A policy's sources by directive name. */
function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ")
      return [name, values]
    })
  )
}

describe("MCP App sandbox policy", () => {
  it("widens the default policy by the view's declared domains and its own files, framed only by the host's pages", () => {
    expect(
      mcpAppSandboxPolicy({
        ...ORIGINS,
        csp: {
          connectDomains: ["https://api.example.invalid"],
          resourceDomains: ["https://cdn.example.invalid"],
        },
        fileLocations: [`${FILE}?pass=p`],
      })
    ).toBe(
      [
        "default-src 'none'",
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.example.invalid",
        "style-src 'self' 'unsafe-inline' https://cdn.example.invalid",
        "img-src 'self' data: https://cdn.example.invalid",
        "font-src 'self' data: https://cdn.example.invalid",
        `media-src 'self' data: https://cdn.example.invalid ${FILE}`,
        `connect-src https://api.example.invalid ${FILE}`,
        "worker-src 'self' blob: data:",
        "frame-src 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "form-action 'none'",
        `frame-ancestors ${LANE} ${LOOPBACK_LANE}`,
      ].join("; ")
    )
  })

  it.each([
    ["a second directive", `${LANE}; frame-ancestors *`],
    ["a second source", `${LANE} https://evil.example.invalid`],
    ["a quoted keyword", "'self'"],
    ["a quoted origin", `"${LANE}"`],
    ["a path", `${LANE}/workspace`],
    ["a trailing slash", `${LANE}/`],
    ["a default port", `${LANE}:443`],
    ["capitals", "https://AOS.example.invalid"],
    ["a host URL admits but CSP cannot name", "https://aos;x.example.invalid"],
    ["an IPv6 literal", "http://[::1]:3000"],
    ["a wildcard", "*"],
    ["the opaque origin", "null"],
    ["a socket origin", "wss://aos.example.invalid"],
  ])("refuses %s as a framing page or the sandbox origin", (_, origin) => {
    expect(isMcpAppPolicyOrigin(origin)).toBe(false)
    expect(() =>
      mcpAppSandboxPolicy({
        frameAncestors: [LANE, origin],
        sandboxOrigin: SANDBOX,
      })
    ).toThrow(origin)
    expect(() =>
      mcpAppSandboxPolicy({ frameAncestors: [LANE], sandboxOrigin: origin })
    ).toThrow(origin)
  })

  it("refuses a sandbox origin that is one of the framing pages', as the spec requires", () => {
    for (const sandboxOrigin of ORIGINS.frameAncestors) {
      expect(isMcpAppPolicyOrigin(sandboxOrigin)).toBe(true)
      expect(() => mcpAppSandboxPolicy({ ...ORIGINS, sandboxOrigin })).toThrow(
        sandboxOrigin
      )
      expect(() => appliedMcpAppCsp({ ...ORIGINS, sandboxOrigin })).toThrow(
        sandboxOrigin
      )
    }
  })

  it("applies only the declared domains the shared rule admits, never one naming a framing page's or the sandbox's host", () => {
    const csp = {
      connectDomains: [
        "https://api.example.invalid",
        "https://API.example.invalid",
        "wss://live.example.invalid",
        "http://127.0.0.1:4100",
        // The shared rule refuses these two.
        "http://api.example.invalid",
        "https://api.example.invalid; script-src *",
        // These name a framing page or the sandbox, however spelled.
        "wss://aos.example.invalid",
        "https://aos.example.invalid:443",
        "ws://127.0.0.1:3000",
        SANDBOX,
      ],
      resourceDomains: [
        "https://cdn.example.invalid",
        "https://*.tiles.example.invalid",
        "https://cdn.example.invalid/scripts",
        SANDBOX,
      ],
      frameDomains: [LANE],
      baseUriDomains: [`${SANDBOX}:443`],
    }

    const applied = {
      connectDomains: [
        "https://api.example.invalid",
        "wss://live.example.invalid",
        "http://127.0.0.1:4100",
      ],
      resourceDomains: [
        "https://cdn.example.invalid",
        "https://*.tiles.example.invalid",
      ],
    }
    expect(appliedMcpAppCsp({ ...ORIGINS, csp })).toEqual(applied)
    const policy = directives(mcpAppSandboxPolicy({ ...ORIGINS, csp }))
    expect(policy["connect-src"]).toEqual(applied.connectDomains)
    expect(policy["script-src"]).toEqual([
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      ...applied.resourceDomains,
    ])
    expect(policy["frame-src"]).toEqual(["'none'"])
    expect(policy["base-uri"]).toEqual(["'none'"])
    expect(
      appliedMcpAppCsp({ ...ORIGINS, csp: { frameDomains: [LANE] } })
    ).toBeUndefined()
  })

  it("names a file only by its exact path on a framing page's origin, CSP syntax encoded, and drops every other location", () => {
    const kept = [
      FILE,
      `${LOOPBACK_LANE}/files/r%C3%A9sum%C3%A9.pdf`,
      `${LANE}/files/a%2Fb.pdf`,
      `${FILE}%3B%20frame-ancestors%20*`,
      `${FILE}%20https%3A//evil.example.invalid`,
      `${FILE}%2C`,
      `${LANE}/files/it%27s.pdf`,
      `${LANE}/files/%22q%22.pdf`,
    ]

    const policy = mcpAppSandboxPolicy({
      ...ORIGINS,
      fileLocations: [
        `${FILE}?pass=p#page=2`,
        `${LOOPBACK_LANE}/files/résumé.pdf`,
        `${LANE}/files/a%2Fb.pdf`,
        // CSP syntax, which reaches the header only encoded.
        `${FILE}; frame-ancestors *`,
        `${FILE} https://evil.example.invalid`,
        `${FILE},`,
        `${LANE}/files/it's.pdf`,
        `${LANE}/files/"q".pdf`,
        // No file on a framing page's origin.
        "https://files.invalid/report.pdf",
        `${SANDBOX}/report.pdf`,
        `${LANE}/`,
        `${LANE}/files/`,
        `blob:${LANE}/1f0c`,
        "/api/v1/agents/a/sessions/s/tool-calls/c/app/files/path",
        `${LANE}/files/%E0%A4%A.pdf`,
      ],
    })

    expect(
      policy.split("; ").map((directive) => directive.split(" ")[0])
    ).toEqual(DIRECTIVES)
    const named = directives(policy)
    expect(named["connect-src"]).toEqual(kept)
    expect(named["media-src"]).toEqual(["'self'", "data:", ...kept])
    expect(named["frame-ancestors"]).toEqual(ORIGINS.frameAncestors)
  })
})
