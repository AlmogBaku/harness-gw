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

## Run the gateway

The gateway reads one YAML file, named by `--config`, by
`HARNESS_GW_CONFIG_FILE`, or found at
`${XDG_CONFIG_HOME:-$HOME/.config}/harness-gw/config.yaml`. Start from an
example in `examples/`; secrets stay in the files it points at. The file must
be owned by the user the gateway runs as (or root) and never group- or
world-writable.

```bash
bun run gateway config check --config /etc/harness-gw/config.yaml
bun run serve --config /etc/harness-gw/config.yaml
```

The image runs the same CLI:

```bash
docker build --tag harness-gw .
docker run --rm -v /etc/harness-gw:/config:ro harness-gw \
  config check --config /config/config.yaml
```

`config check` validates the file, its `HARNESS_GW_*` overrides and the
schema, and starts nothing; it does not read the secret files, which `serve`
reads at start. The operator listener has no authentication of its own: keep
it on loopback or a trusted private network, behind the client's own web
server. The wire and HTTP API are specified in [docs/protocol.md](docs/protocol.md).

## Release

A `v*` tag matching `package.json`'s version runs `release.yml`: after a
reviewer approves the `release` environment, it publishes `@harness-gw/sdk` to
npm through trusted publishing with provenance, and pushes the gateway image to
GHCR with a build attestation.
