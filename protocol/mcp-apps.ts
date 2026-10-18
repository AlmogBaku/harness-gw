import {
  CallToolResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/core"
import { z } from "zod"

/**
 * MCP Apps (spec 2026-01-26) as the gateway hands them to the browser. A tool
 * declares its view with `_meta.ui.resourceUri`; the gateway resolves that
 * resource server-side and the browser only ever sees the view below, keyed
 * by the tool call that opened it, never the resource URI.
 */

export { CallToolResultSchema, ReadResourceResultSchema }
export type CallToolResult = z.infer<typeof CallToolResultSchema>
export type ReadResourceResult = z.infer<typeof ReadResourceResultSchema>

const DomainListSchema = z.array(z.string().min(1).max(2048)).max(64)

/** A UI resource's `_meta.ui.csp`: the origins its view may reach. */
export const McpUiCspSchema = z.object({
  connectDomains: DomainListSchema.optional(),
  resourceDomains: DomainListSchema.optional(),
  frameDomains: DomainListSchema.optional(),
  baseUriDomains: DomainListSchema.optional(),
})
export type McpUiCsp = z.infer<typeof McpUiCspSchema>

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
const HOST = `${LABEL}(?:\\.${LABEL})*`
const PORT = "(?::\\d{1,5})?"
/** An origin with no path or credentials, optionally one wildcard label. */
const TLS = new RegExp(`^https://(?:\\*\\.)?${HOST}${PORT}$`, "iu")
/** The same shape for a connection, which may also be a secure socket. */
const TLS_CONNECT = new RegExp(
  `^(?:https|wss)://(?:\\*\\.)?${HOST}${PORT}$`,
  "iu"
)
/** A plain-text connection only to this machine. */
const LOOPBACK_CONNECT = new RegExp(
  `^(?:http|ws)://(?:127\\.0\\.0\\.1|(?:(?:\\*|${HOST})\\.)?localhost)${PORT}$`,
  "iu"
)

/**
 * Whether a view may name this origin in the given `_meta.ui.csp` list.
 * Connections admit `https://` and `wss://` hosts, and plain `http://` or
 * `ws://` only to a loopback host; every other list admits `https://` only.
 */
export function isMcpAppCspDomain(list: keyof McpUiCsp, value: string) {
  return list === "connectDomains"
    ? TLS_CONNECT.test(value) || LOOPBACK_CONNECT.test(value)
    : TLS.test(value)
}

const PermissionSchema = z.object({})

/** A UI resource's `_meta.ui.permissions`: the device features it asks for. */
export const McpUiPermissionsSchema = z.object({
  camera: PermissionSchema.optional(),
  microphone: PermissionSchema.optional(),
  geolocation: PermissionSchema.optional(),
  clipboardWrite: PermissionSchema.optional(),
})
export type McpUiPermissions = z.infer<typeof McpUiPermissionsSchema>

/**
 * The files a view may read: a relative address, carrying its own pass, per
 * tool argument that names a file, and when the addresses expire. `open`
 * carries it only for a call with such an argument, whose path it withholds
 * from `toolInput`; `addresses` is empty where the role may read no files.
 * `POST …/app/files` renews it.
 */
export const McpAppFilesSchema = z.strictObject({
  addresses: z.record(z.string(), z.string().startsWith("/").max(8_192)),
  expiresAt: z.iso.datetime().optional(),
})
export type McpAppFiles = z.infer<typeof McpAppFilesSchema>

/**
 * A UI resource's `_meta.ui.domain`: the lowercase host name its view asks to
 * run on, a stable origin of its own. The format is the host's; the gateway
 * passes one on only when its first label is `mcpAppStableOriginKey`
 * (`@harness-gw/sdk/node`) of the URL it dialed the view's server at.
 */
export const McpUiDomainSchema = z
  .string()
  .max(253)
  .regex(new RegExp(`^${HOST}$`, "u"))

/** `GET` an MCP App view: its HTML, sandbox policy, and the call it renders. */
export const McpAppViewSchema = z.strictObject({
  html: z.string().max(5_000_000),
  csp: McpUiCspSchema.optional(),
  permissions: McpUiPermissionsSchema.optional(),
  prefersBorder: z.boolean().optional(),
  domain: McpUiDomainSchema.optional(),
  toolInput: z.record(z.string(), z.unknown()).optional(),
  toolResult: CallToolResultSchema.optional(),
  files: McpAppFilesSchema.optional(),
})
export type McpAppView = z.infer<typeof McpAppViewSchema>

/**
 * The file a viewer App shows: a published Artifact's display name and type,
 * and its `fileId` (`artifactFileId` of its path) when the runtime read it from
 * a path. The view reads it from `toolResult.structuredContent.value`, or from
 * the JSON after `Structured fallback:` in the text when it reads text alone.
 * It is the whole contract any configured viewer reads.
 */
export type ViewerFile = {
  filename: string
  mimeType?: string
  fileId?: string
}

/** A published Artifact's `toolResult`: its `ViewerFile`, as structure and as text. */
export function viewerFileResult({
  filename,
  mimeType,
  fileId,
}: ViewerFile): CallToolResult {
  const value: ViewerFile = {
    filename,
    ...(mimeType && { mimeType }),
    ...(fileId && { fileId }),
  }
  return {
    content: [
      {
        type: "text",
        text: `${filename} is ready for display.\n\nStructured fallback:\n${JSON.stringify(value)}`,
      },
    ],
    structuredContent: { value },
  }
}

/** A view's `tools/call`, answered with a `CallToolResult`. */
export const McpAppToolCallRequestSchema = z.strictObject({
  name: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()),
})
export type McpAppToolCallRequest = z.infer<typeof McpAppToolCallRequestSchema>

/** A view's `resources/read`, answered with a `ReadResourceResult`. */
export const McpAppResourceReadRequestSchema = z.strictObject({
  uri: z.string().min(1).max(2048),
})
export type McpAppResourceReadRequest = z.infer<
  typeof McpAppResourceReadRequestSchema
>

/**
 * The MCP App sandbox page: a static page that holds only the relay creating
 * the App's own frame. A host serves it from a sandbox origin of its own,
 * apart from its pages' origins as the spec requires, and frames it with
 * `allow-scripts allow-same-origin`, so the view runs on that origin with
 * storage of its own. The page is a real document rather than `srcdoc` so it
 * carries the view's own policy, `mcpAppSandboxPolicy`, as its header; the
 * view's `srcdoc` frame inherits it.
 */
export const MCP_APP_SANDBOX_PATH = "/mcp-app-sandbox.html"

/** What one view's sandbox policy is built from. */
export type McpAppSandboxPolicyInput = {
  /**
   * The exact origins of the host's own pages, the only ones that may frame
   * the sandbox page.
   */
  frameAncestors: readonly string[]
  /** The exact origin the sandbox page is served from. */
  sandboxOrigin: string
  /** The view's declared `_meta.ui.csp`. */
  csp?: McpUiCsp | undefined
  /** The call's absolute file addresses; no pass is written. */
  fileLocations?: readonly string[] | undefined
}

/**
 * An `http(s)` origin whose host CSP can name. CSP has no syntax for an IPv6
 * literal, and `URL` admits hosts holding `;` or a quote, which would end a
 * directive or a source.
 */
const POLICY_ORIGIN = new RegExp(`^https?://${HOST}${PORT}$`, "u")

/**
 * Whether a sandbox policy can name `value` as a framing page or as the
 * sandbox: an `http(s)` origin exactly as `URL` writes it, whose host is a name
 * or an IPv4 address. `mcpAppSandboxPolicy` throws for any other, so a host
 * checks its settings with this once, before it serves a view.
 */
export function isMcpAppPolicyOrigin(value: string): boolean {
  try {
    return POLICY_ORIGIN.test(value) && new URL(value).origin === value
  } catch {
    return false
  }
}

/**
 * The hosts no declared domain may name: each framing page's and the
 * sandbox's own. Throws for an origin no policy can name, and for a sandbox
 * origin among the framing pages'.
 */
function ownHosts({
  frameAncestors,
  sandboxOrigin,
}: Pick<McpAppSandboxPolicyInput, "frameAncestors" | "sandboxOrigin">) {
  const origins = [...frameAncestors, sandboxOrigin]
  const invalid = origins.find((origin) => !isMcpAppPolicyOrigin(origin))
  if (invalid !== undefined)
    throw new Error(`Not an exact origin a sandbox policy can name: ${invalid}`)
  // The spec: "The Host and the Sandbox MUST have different origins".
  if (frameAncestors.includes(sandboxOrigin))
    throw new Error(`The sandbox origin is one of the host's: ${sandboxOrigin}`)
  return new Set(origins.map((origin) => new URL(origin).host))
}

/** Whether a declared domain names one of `hosts`, its scheme aside. */
function namesHost(domain: string, hosts: ReadonlySet<string>) {
  try {
    return hosts.has(new URL(domain).host)
  } catch {
    return false
  }
}

const CSP_LISTS = McpUiCspSchema.keyof().options

/**
 * The domains a view's sandbox policy applies, per `_meta.ui.csp` list, as a
 * host reports them in `hostCapabilities.sandbox.csp`: those
 * `isMcpAppCspDomain` admits, lowercased and once each, without any that names
 * the host and port of a framing page or of the sandbox itself, whatever its
 * scheme. `undefined` when it applies none. Throws as `mcpAppSandboxPolicy`
 * does for the origins.
 */
export function appliedMcpAppCsp({
  csp,
  ...origins
}: Omit<McpAppSandboxPolicyInput, "fileLocations">): McpUiCsp | undefined {
  const own = ownHosts(origins)
  const applied: McpUiCsp = {}
  for (const list of CSP_LISTS) {
    const domains = new Set(
      (csp?.[list] ?? [])
        .filter((domain) => isMcpAppCspDomain(list, domain))
        .map((domain) => domain.toLowerCase())
        .filter((domain) => !namesHost(domain, own))
    )
    if (domains.size > 0) applied[list] = [...domains]
  }
  return Object.keys(applied).length > 0 ? applied : undefined
}

/**
 * A file location as a policy names it: its origin, one of `origins`, and its
 * path with every segment percent-encoded, a quote too, so no CSP syntax
 * reaches the header; without the query that carries its pass. `undefined` for
 * anything but an `http(s)` URL on one of `origins`, and for a path ending in
 * `/`, which would name every path below it.
 */
function policyFileLocation(value: string, origins: readonly string[]) {
  try {
    const url = new URL(value)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !origins.includes(url.origin) ||
      url.pathname.endsWith("/")
    )
      return undefined
    const path = url.pathname
      .split("/")
      .map((segment) =>
        encodeURIComponent(decodeURIComponent(segment)).replaceAll("'", "%27")
      )
      .join("/")
    return `${url.origin}${path}`
  } catch {
    return undefined
  }
}

const sources = (base: readonly string[], domains: readonly string[] = []) =>
  [...base, ...domains].join(" ") || "'none'"

/**
 * One view's sandbox policy, sent as the sandbox page's header: the MCP Apps
 * default policy (spec 2026-01-26), widened only by the domains
 * `appliedMcpAppCsp` keeps and by the call's own file locations, each by its
 * exact path, to read and to play; never allowing plugins or form posts, and
 * framed only by `frameAncestors`. Views may compile WebAssembly, as a
 * document renderer's decoders do.
 *
 * Anyone can ask for a sandbox page with any query, so every value is checked
 * before it is written: an ancestor or a sandbox origin that is no exact
 * origin (`isMcpAppPolicyOrigin`) throws, as does a sandbox origin among the
 * ancestors, and a domain or a file location its rule refuses is dropped. A
 * file location is kept only on a framing page's origin.
 */
export function mcpAppSandboxPolicy({
  fileLocations = [],
  ...view
}: McpAppSandboxPolicyInput): string {
  const applied = appliedMcpAppCsp(view) ?? {}
  // The view reads its files, and plays one that is media, at their locations.
  const files = fileLocations.flatMap(
    (location) => policyFileLocation(location, view.frameAncestors) ?? []
  )
  const resource = applied.resourceDomains ?? []
  return [
    "default-src 'none'",
    `script-src ${sources(["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"], resource)}`,
    `style-src ${sources(["'self'", "'unsafe-inline'"], resource)}`,
    `img-src ${sources(["'self'", "data:"], resource)}`,
    `font-src ${sources(["'self'", "data:"], resource)}`,
    `media-src ${sources(["'self'", "data:"], [...resource, ...files])}`,
    `connect-src ${sources(applied.connectDomains ?? [], files)}`,
    // A view authors its own workers as blob or data URLs, since the sandbox
    // fetches no script by address; both carry only text the view already ran.
    "worker-src 'self' blob: data:",
    `frame-src ${sources([], applied.frameDomains)}`,
    `base-uri ${sources([], applied.baseUriDomains)}`,
    "object-src 'none'",
    "form-action 'none'",
    `frame-ancestors ${sources([], view.frameAncestors)}`,
  ].join("; ")
}
