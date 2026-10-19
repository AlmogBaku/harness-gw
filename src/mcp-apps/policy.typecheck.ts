/**
 * Compile-time proof that a runtime's view carries only a `domain`
 * `judgedDomain` verified. `tsconfig.gateway.json` typechecks this file;
 * nothing imports or runs it.
 */
import type { ServerMcpApps } from "../core/runtime"

type Opened = Awaited<ReturnType<ServerMcpApps["open"]>>
type ServerViewed = Awaited<
  ReturnType<NonNullable<ServerMcpApps["serverView"]>>
>

const declared = "c3d80a4ed901ee05b21755a88273b4a4.mcp-apps.example"

// @ts-expect-error A declared string is no verified domain.
export const openedAsDeclared: Opened = { html: "", domain: declared }

// @ts-expect-error Nor is it one for a view read without a call.
export const viewedAsDeclared: ServerViewed = { html: "", domain: declared }
