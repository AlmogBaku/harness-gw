# harness-gw

A gateway that puts Hermes, OpenClaw, and OpenCode behind one ACP WebSocket
and one HTTP API, and `@harness-gw/sdk`, the browser client and protocol SDK
for it.

- `src/` is the gateway, a Bun server. It serves the API under `/api/v1` and
  nothing else.
- `@harness-gw/sdk` is the framework-free browser client: the ACP connection,
  the workspace client, approvals, questions, and the HTTP client.
- `@harness-gw/sdk/protocol` is the wire alone: the `_hgw/*` method names, the
  `_meta.hgw` schemas and their types, and `HGW_EXTENSION_VERSION`. It loads
  without the client.

The client reads no browser global: the page's visibility, the socket URL,
the origin, and the logger all arrive as options.

## Develop

```bash
bun install
bun run typecheck
bun run lint
bun run test
bun run test:gate
bun run build
```
