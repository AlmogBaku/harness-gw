import { isAosToolName, isAosUiServerName } from "../../core/aos-tool-names"
import { splitCanonicalMcpName } from "../../mcp-apps/policy"

/**
 * Whether an App call of `toolName` reaches a guest whole: its result as the
 * operator sees it, which the guest's own view route hands it anyway. `servers`
 * is the guest listener's allowlist of MCP servers, where `aos-ui` names the
 * bare `aos-ui` tools and any other server its `mcp__<server>__<tool>` calls.
 * Arguments never pass, whatever the server, since they may name host paths.
 */
export function appCallPassesWhole(
  toolName: string,
  servers: readonly string[]
): boolean {
  if (isAosToolName(toolName)) return servers.some(isAosUiServerName)
  return splitCanonicalMcpName(toolName, servers) !== undefined
}
