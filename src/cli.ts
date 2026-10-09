import { runProxyCli } from "./cli/program"
import { createProxyLogger } from "./cli/logger"
import { installProcessHandlers } from "./cli/process-handlers"
import { CredentialValues } from "./redaction"

export { runProxyCli } from "./cli/program"

if (import.meta.main) {
  const credentials = new CredentialValues()
  // Writes a start failure before the configuration, and so its level, has loaded.
  const bootstrapLogger = createProxyLogger({ level: "info", credentials })
  installProcessHandlers(bootstrapLogger)
  void runProxyCli(process.argv, {
    createLogger: (level) => createProxyLogger({ level, credentials }),
    credentials,
    // The only reader of the real environment.
    getenv: (name: string) => process.env[name],
  }).catch((error: unknown) => {
    bootstrapLogger.error({ err: error }, "gateway.start_failed")
    process.exitCode = 1
  })
}
