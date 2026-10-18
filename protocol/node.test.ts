import { describe, expect, it } from "vitest"

import { artifactFileId, mcpAppStableOriginKey } from "./node"

describe("MCP App stable origin key", () => {
  it("is the first 32 hex digits of the URL's SHA-256, as written", () => {
    // Claude's own example server, from the ext-apps CSP and CORS guide.
    expect(mcpAppStableOriginKey("https://example.com/mcp")).toBe(
      "c3d80a4ed901ee05b21755a88273b4a4"
    )
    // Never normalized: another spelling of the same URL is another key.
    expect(mcpAppStableOriginKey("https://Example.com:443/mcp")).not.toBe(
      "c3d80a4ed901ee05b21755a88273b4a4"
    )
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

  it("names another file apart", () => {
    expect(artifactFileId("/home/user/reports/q4/index.html")).not.toBe(
      "69749e306120414a"
    )
  })
})
