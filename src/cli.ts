import { runGatewayCli } from "./cli/program"
import { createGatewayLogger } from "./cli/logger"
import { installProcessHandlers } from "./cli/process-handlers"
import { CredentialValues } from "./redaction"

export { runGatewayCli } from "./cli/program"

if (import.meta.main) {
  const credentials = new CredentialValues()
  // Writes a start failure before the configuration, and so its level, has loaded.
  const bootstrapLogger = createGatewayLogger({ level: "info", credentials })
  installProcessHandlers(bootstrapLogger)
  void runGatewayCli(process.argv, {
    createLogger: (level) => createGatewayLogger({ level, credentials }),
    credentials,
    // The only reader of the real environment.
    getenv: (name: string) => process.env[name],
  }).catch((error: unknown) => {
    bootstrapLogger.error({ err: error }, "gateway.start_failed")
    process.exitCode = 1
  })
}
