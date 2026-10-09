import type { ConfiguredGatewayDependencies } from "../composition"
import type { GatewayLogLevel } from "../config"
import type { GatewayConfigFileAccess } from "../config-file"
import type { startGatewayServer } from "../server"

export type GatewayCliDependencies = Omit<ConfiguredGatewayDependencies, "logger"> &
  Partial<GatewayConfigFileAccess> & {
    /** Builds the proxy log once the configuration has named its level. */
    createLogger: (
      level: GatewayLogLevel
    ) => ConfiguredGatewayDependencies["logger"]
    start?: typeof startGatewayServer
    /**
     * Required: the only `process.env`-backed reader is built in `cli.ts`, so a
     * test can never discover the operator's own configuration file.
     */
    getenv: (name: string) => string | undefined
    randomBytes?: (size: number) => Uint8Array
    clock?: () => number
    writeOut?: (value: string) => void
    writeErr?: (value: string) => void
    /** Ends the process once every listener has shut down. */
    exit?: (code: number) => void
  }

export type GatewayLifecycle = {
  server: unknown
  guestServer?: unknown
  shutdown(): Promise<void>
}
