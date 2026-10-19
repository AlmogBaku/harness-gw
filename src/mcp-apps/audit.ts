import type { Logger } from "../../lifecycle"
import type { McpUiCsp } from "../../protocol/mcp-apps"
import type { SessionScope } from "../core/runtime"

/**
 * The line each view the gateway opens leaves for security review, as MCP Apps
 * 2026-01-26 asks ("Host SHOULD log CSP configurations for security review"):
 * the view's server and tool where the runtime names them, and the domains its
 * `_meta.ui.csp` declares, `{}` for none. Never its HTML, nor the call's
 * arguments or result.
 */
export function logViewOpened(
  logger: Logger | undefined,
  scope: SessionScope,
  view: { toolCallId?: string; server?: string; tool?: string; csp?: McpUiCsp }
) {
  logger?.info(
    {
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      ...view,
      csp: view.csp ?? {},
    },
    "mcp_app.view.opened"
  )
}
