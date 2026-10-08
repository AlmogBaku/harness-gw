import { HGW_ACP_PATH, HGW_API_PREFIX } from "../../protocol/acp"
import { createConfiguredProxy } from "../composition"
import { loadProxyConfig, nodeConfigFileAccess } from "../config-file"
import {
  startProxyServer,
  type ShutdownSettlement,
  type SocketUpgrade,
} from "../server"
import type { ProxyCliDependencies, ProxyLifecycle } from "./types"

/** A listener answers its API and nothing else: pages belong to the client. */
function listenerApp(
  api: {
    fetch(request: Request, server?: unknown): Response | Promise<Response>
  },
  apiPrefix: string
) {
  return {
    fetch(request: Request, server?: unknown) {
      return new URL(request.url).pathname.startsWith(apiPrefix)
        ? api.fetch(request, server)
        : new Response(null, { status: 404 })
    },
  }
}

export async function serveProxy(
  { config }: { config?: string },
  dependencies: ProxyCliDependencies
): Promise<ProxyLifecycle> {
  const { getenv } = dependencies
  const input = await loadProxyConfig({
    flag: config,
    getenv,
    discover: true,
    ...nodeConfigFileAccess(dependencies),
  })
  const logger = dependencies.createLogger(input.log.level)
  const configured = await createConfiguredProxy(input, {
    ...dependencies,
    logger,
  })
  const start = dependencies.start ?? startProxyServer
  const graceMs = configured.config.shutdownGraceMs
  const listenerCount = configured.guest ? 2 : 1
  let runtimeClosed: Promise<void> | undefined
  /** One runtime is shared by every listener, so every shutdown path closes it once. */
  const closeRuntime = () =>
    (runtimeClosed ??= Promise.resolve().then(() => {
      // Push delivery observes the runtime, so it stops before the runtime does.
      configured.push?.dispatcher.close()
      return configured.runtimeInstance.close()
    }))
  let shutdownAnnounced = false
  const announceShutdown = () => {
    if (shutdownAnnounced) return
    shutdownAnnounced = true
    logger.info({ graceMs }, "proxy.shutdown.started")
  }
  const exit = dependencies.exit ?? ((code: number) => process.exit(code))
  let settledListeners = 0
  let forcedShutdown = false
  /**
   * Every listener has stopped and the runtime is closed, so nothing is left to
   * serve: exiting is the only deterministic end for stray provider work that
   * outlived the grace.
   */
  const onSettled = ({ forced }: ShutdownSettlement) => {
    forcedShutdown ||= forced
    settledListeners += 1
    if (settledListeners < listenerCount) return
    if (forcedShutdown) logger.error({ graceMs }, "proxy.shutdown.forced")
    logger.info({ forced: forcedShutdown }, "proxy.shutdown.completed")
    exit(forcedShutdown ? 1 : 0)
  }
  const lifecycle = start<SocketUpgrade>({
    app: listenerApp(configured.app, HGW_API_PREFIX),
    origins: configured.origins,
    sockets: [
      {
        path: HGW_ACP_PATH,
        // Each Agent's own address sits below the shared one.
        subpaths: true,
        service: configured.acpService,
        maxPeers: configured.config.limits.operatorEventPeers,
      },
    ],
    host: configured.config.listen.host,
    port: configured.config.listen.port,
    shutdownGraceMs: graceMs,
    close: closeRuntime,
    onShutdownStarted: announceShutdown,
    onSettled,
  })
  const guestLifecycle = configured.guest
    ? start<SocketUpgrade>({
        sockets: [
          {
            path: HGW_ACP_PATH,
            service: configured.guest.acpService,
            maxPeers: configured.config.limits.operatorEventPeers,
          },
        ],
        app: listenerApp(configured.guest.app, HGW_API_PREFIX),
        origins: configured.guest.origins,
        host: configured.config.guest!.listen.host,
        port: configured.config.guest!.listen.port,
        shutdownGraceMs: graceMs,
        close: closeRuntime,
        onShutdownStarted: announceShutdown,
        onSettled,
      })
    : undefined

  logger.info(
    {
      host: configured.config.listen.host,
      port: configured.config.listen.port,
      ...(configured.config.guest
        ? {
            guestHost: configured.config.guest.listen.host,
            guestPort: configured.config.guest.listen.port,
          }
        : {}),
    },
    "proxy.started"
  )

  let shutdownPromise: Promise<void> | undefined
  return {
    server: lifecycle.server,
    ...(guestLifecycle ? { guestServer: guestLifecycle.server } : {}),
    shutdown() {
      shutdownPromise ??= (async () => {
        try {
          await Promise.all([
            lifecycle.shutdown(),
            ...(guestLifecycle ? [guestLifecycle.shutdown()] : []),
          ])
        } finally {
          await closeRuntime()
        }
      })()
      return shutdownPromise
    },
  }
}
