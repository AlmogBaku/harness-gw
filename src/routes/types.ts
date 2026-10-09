import type { Hono } from "hono"

export type GatewayRouteApp = Hono<{ Variables: { requestId: string } }>
