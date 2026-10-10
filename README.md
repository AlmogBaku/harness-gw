# harness-gw

[![npm](https://img.shields.io/npm/v/@harness-gw/sdk)](https://www.npmjs.com/package/@harness-gw/sdk)
[![CI](https://github.com/AlmogBaku/harness-gw/actions/workflows/ci.yml/badge.svg)](https://github.com/AlmogBaku/harness-gw/actions/workflows/ci.yml)
[![Image](https://img.shields.io/badge/image-ghcr.io%2Falmogbaku%2Fharness--gw-blue)](https://github.com/AlmogBaku/harness-gw/pkgs/container/harness-gw)
[![License](https://img.shields.io/github/license/AlmogBaku/harness-gw)](LICENSE)

> One [Agent Client Protocol](https://agentclientprotocol.com) surface over
> Hermes, OpenClaw and OpenCode, and the browser SDK that speaks it.

Each agent harness has its own native API. harness-gw attaches to one of them
and gives every client the same thing: an ACP v2 WebSocket for Sessions and
turns, and a small HTTP API for the bytes ACP does not carry (attachments,
Artifacts, voice, push). The harness stays the owner of its Agents, Sessions and
history; the gateway adds no database.

```text
browser ── @harness-gw/sdk ──► /api/v1/acp (WebSocket) ─┐
                             └► /api/v1/*   (HTTP)    ──┤ harness-gw ──► Hermes | OpenClaw | OpenCode
guest   ── invite link ──────► guest listener ──────────┘     │
                                                              └─ MCP ──► MCP Apps servers
```

[AOS-ui](https://github.com/AlmogBaku/aos-ui) is its first client.

## Features

- **One protocol for three harnesses.** Standard ACP methods, plus a declared
  and versioned `hgw` extension (`_hgw/*` methods, `_meta.hgw` payloads) for
  what ACP has no word for yet: Agent catalogs, steering, rewind, read state,
  activity and history pages.
- **Operator and guest lanes.** A second listener serves restricted guests who
  arrive with a signed, expiring invitation scoped to one Agent.
- **Approvals and questions** from the harness reach the client as ACP
  permission requests and elicitations, and answer back the same way.
- **MCP Apps.** Tool results that carry a `ui://` view are served to the client
  through the gateway, scoped to the tool call's own Session.
- **Attachments, Artifacts, voice and Web Push** over plain HTTP routes.
- **A framework-free browser SDK.** No React, no browser globals: location,
  storage, page visibility and logging arrive as options.
- **Origin-checked by default.** Each listener admits only its listed browser
  origins for state changes and socket upgrades.

## Quick start

You need a running harness. Hermes is the primary one; see
[docs/runtimes](docs/runtimes) for each harness's prerequisites.

1. Copy an example configuration and point it at your harness:

   ```bash
   cp examples/config.hermes.example.yaml config.yaml
   ```

   Secrets never go in this file. It names secret files instead, such as the
   Hermes token at `/run/secrets/hermes-token`. Drop the `guest` block to start
   without a guest listener, or mount its signing key too.

2. Check it with the published image. `config check` validates the file, its
   `HARNESS_GW_*` overrides and every secret file it names, then exits:

   ```bash
   docker run --rm \
     -v "$PWD/config.yaml:/run/harness-gw/config.yaml:ro" \
     -v "$PWD/hermes-token:/run/secrets/hermes-token:ro" \
     ghcr.io/almogbaku/harness-gw:0.1.3 \
     config check --config /run/harness-gw/config.yaml
   ```

3. Serve it, published on loopback only:

   ```bash
   docker run --rm -p 127.0.0.1:4100:4100 \
     -v "$PWD/config.yaml:/run/harness-gw/config.yaml:ro" \
     -v "$PWD/hermes-token:/run/secrets/hermes-token:ro" \
     ghcr.io/almogbaku/harness-gw:0.1.3 \
     serve --config /run/harness-gw/config.yaml
   ```

   `curl http://127.0.0.1:4100/api/v1/healthz` answers once it is up.

> [!IMPORTANT]
> The operator listener has no authentication of its own. Keep it on loopback
> or a trusted private network, behind the client's own web server, and never
> publish it directly. Only the guest listener is meant to face strangers, and
> it admits only invitation holders.

> [!NOTE]
> The configuration file must be owned by the user the gateway runs as (`bun`
> in the image) or by root, and must not be group- or world-writable. The
> gateway refuses to start otherwise.

Without Docker, run the same CLI from a checkout with `bun run serve --config
<file>`. With no `--config`, the gateway reads `HARNESS_GW_CONFIG_FILE`, then
`${XDG_CONFIG_HOME:-$HOME/.config}/harness-gw/config.yaml`.

## Use the SDK

```bash
npm install @harness-gw/sdk @agentclientprotocol/sdk @modelcontextprotocol/sdk zod
```

```ts
import { acpSocketUrl, createAcpConnection } from "@harness-gw/sdk"
import { HGW_ACP_PATH } from "@harness-gw/sdk/protocol"

const connection = createAcpConnection({
  url: acpSocketUrl(HGW_ACP_PATH, location.href),
  clientInfo: { name: "my-app", version: "1.0.0" },
})
connection.start()

const { sessionId } = await connection.newSession({ agentId: "assistant" })
connection.subscribe(sessionId, { update: (update) => console.log(update) })
await connection.joined(sessionId)
await connection.prompt(sessionId, [{ type: "text", text: "Hello" }], {})
```

The package has two entry points:

| Import                     | What it holds                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@harness-gw/sdk`          | The ACP connection with reconnect and backoff, the workspace client (Agents, Sessions, read state, activity), approvals, questions, and `HgwRemoteClient` for the HTTP routes |
| `@harness-gw/sdk/protocol` | The wire alone: `_hgw/*` method names, the `_meta.hgw` zod schemas and their types, route paths and `HGW_EXTENSION_VERSION`. It loads without the client                      |

The client checks the gateway's extension version during `initialize`. On a
mismatch it fails `initialized` with both versions named and stops instead of
reconnecting.

## CLI

The image's entrypoint is the `harness-gw` CLI; from a checkout, prefix it
with `bun run gateway`.

| Command                        | What it does                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve [--config FILE]`        | Start the operator listener, and the guest listener when configured                                                                                                                             |
| `config check [--config FILE]` | Validate the configuration and its secret files, then exit                                                                                                                                      |
| `invite --agent NAME`          | Print a guest invitation link. Options: `--expires-in` (default `72h`), `--prefill`, `--instruction`, `--lang en\|he`, and the page's `--name`, `--logo`, `--accent`, `--title` and `--message` |

## Documentation

| Document                                                                                       | Covers                                                                                         |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [docs/protocol.md](docs/protocol.md)                                                           | The wire: ACP methods, the `hgw` extension, close codes, the version rule and every HTTP route |
| [docs/configuration.md](docs/configuration.md)                                                 | Every configuration field and `HARNESS_GW_*` override                                          |
| [docs/runtimes/hermes.md](docs/runtimes/hermes.md)                                             | Running against Hermes, the primary harness                                                    |
| [docs/runtimes/openclaw.md](docs/runtimes/openclaw.md)                                         | Running against OpenClaw                                                                       |
| [docs/runtimes/opencode.md](docs/runtimes/opencode.md)                                         | Running against OpenCode                                                                       |
| [docs/development/runtime-adapter-authoring.md](docs/development/runtime-adapter-authoring.md) | Writing an adapter for another harness                                                         |
| [docs/design](docs/design)                                                                     | The gateway's architecture and its V1 design                                                   |

## Develop

Use [Bun](https://bun.sh).

```bash
bun install
bun run typecheck
bun run lint
bun run test        # unit and integration
bun run test:gate   # build and packaging checks
bun run build       # the SDK's dist/
```

| Path         | Holds                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `src/`       | The gateway: listeners, routes, auth, guest lane, MCP Apps, push, voice, and one adapter per harness under `src/adapters/` |
| `client/`    | The browser SDK                                                                                                            |
| `protocol/`  | The wire schemas and constants                                                                                             |
| `lifecycle/` | Clock, deadline, retry and logging primitives the gateway and the SDK share                                                |
| `examples/`  | A configuration per harness                                                                                                |

A `v*` tag matching `package.json`'s version runs `release.yml`. After the
protected `release` environment is approved, it publishes `@harness-gw/sdk` to
npm with provenance and pushes a multi-arch image to GHCR with a build
attestation.
