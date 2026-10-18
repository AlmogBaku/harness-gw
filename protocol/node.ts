import { createHash } from "node:crypto"
import { posix } from "node:path"

/**
 * `@harness-gw/sdk/node`: the identities a server derives, once each, for the
 * gateway and an MCP server alike. A browser only compares them, so this entry
 * is apart from `@harness-gw/sdk/protocol`, which loads anywhere.
 */

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex")

/**
 * A URL as the gateway keeps it: its WHATWG serialization with no trailing
 * slash, so `HTTPS://Example.com:443/mcp/` reads as `https://example.com/mcp`.
 * Throws for anything that is no URL.
 */
export function canonicalUrl(url: string | URL): string {
  return new URL(url).href.replace(/\/$/u, "")
}

/**
 * The first label of an MCP App view's stable origin (`_meta.ui.domain`): the
 * first 32 hex digits of a SHA-256 of the MCP server's URL the gateway dials,
 * in its `canonicalUrl` form; for a URL already in that form, such as
 * `https://example.com/mcp`, Claude's published format. A server declares
 * `<key>.<the host's domain>`; the gateway keeps that `domain` only when its
 * first label is this key of the URL it dialed, however either wrote it.
 */
export function mcpAppStableOriginKey(url: string): string {
  return sha256Hex(canonicalUrl(url)).slice(0, 32)
}

/**
 * A file's identity in a viewer's result: the first 16 hex digits of a
 * SHA-256 of its normalized POSIX path. However a file is shown, it carries
 * the same `fileId`, and the result never carries the path.
 */
export function artifactFileId(path: string): string {
  return sha256Hex(posix.normalize(path)).slice(0, 16)
}
