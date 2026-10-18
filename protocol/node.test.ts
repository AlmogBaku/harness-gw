import { describe, expect, it } from "vitest"

import { artifactFileId, mcpAppStableOriginKey } from "./node"

describe("MCP App stable origin key", () => {
  it.each([
    // Claude's own example server, from the ext-apps CSP and CORS guide.
    "https://example.com/mcp",
    "https://example.com/mcp/",
    "https://EXAMPLE.com/mcp",
    "https://example.com:443/mcp",
  ])("is the first 32 hex digits of the canonical URL's SHA-256: %s", (url) => {
    expect(mcpAppStableOriginKey(url)).toBe("c3d80a4ed901ee05b21755a88273b4a4")
  })
})

describe("artifact file id", () => {
  it.each([
    "/home/user/reports/q3/index.html",
    "/home/user/reports/./q3//index.html",
    "/home/user/reports/drafts/../q3/index.html",
  ])(
    "is the first 16 hex digits of the normalized path's SHA-256: %s",
    (path) => {
      expect(artifactFileId(path)).toBe("69749e306120414a")
    }
  )
})
