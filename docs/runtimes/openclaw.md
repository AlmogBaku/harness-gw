# Run the gateway with OpenClaw

The gateway connects to one independently operated OpenClaw Gateway over
WebSocket, using its device identity and device token from private files. There
is no client-side Gateway route and the gateway does not manage OpenClaw or
model credentials. aos-ui is the first-class client.

## Prerequisites

- A reachable, already configured OpenClaw Gateway
- Private, owner-only files containing the Gateway device identity and device token
- A private guest-invitation signing-key file when the guest listener is enabled

Start from `examples/config.openclaw.example.yaml`. Set `runtime.baseUrl` to
the Gateway WebSocket URL reachable by the gateway and set
`runtime.deviceIdentityFile` and `runtime.deviceTokenFile` to the corresponding
private files. The example's `ws://host.docker.internal:18789` is for a Gateway
running on the same host; replace it when your topology differs.

## Run locally

```bash
bun run serve --config /absolute/private/path/config.openclaw.yaml
```

Connect aos-ui (or any ACP v2 client) to the gateway's configured `publicOrigin`.

## Register the AOS UI tools

The installation prompt in aos-ui (`shared/install/PROMPT.md`) lets an agent
perform the steps below; its OpenClaw reference holds the exact commands. The
manual steps follow.

aos-ui ships its own stateless MCP server with `render_chart`, `render_map`,
`render_stats`, and `present_artifact({path, title?, mimeType?})`. All four are
[MCP Apps](#mcp-apps) and render only while the Gateway has
`mcp.apps.enabled: true`. Run it on the Gateway host bound to loopback (see
aos-ui for the `tools-mcp:serve` script and port details).

Register it in OpenClaw as `aos-ui`, disabled by default, so it loads only in
Sessions the gateway enables it for:

```bash
openclaw mcp add aos-ui --url http://127.0.0.1:4110/mcp \
  --transport streamable-http --disabled
```

That writes this entry under `mcp.servers` in `openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "aos-ui": {
        "url": "http://127.0.0.1:4110/mcp",
        "transport": "streamable-http",
        "enabled": false
      }
    }
  }
}
```

Run `openclaw mcp reload` so the next turn uses the new configuration.

The gateway enables the server per Session: it creates Sessions with
`toolOverrides.mcpServers["aos-ui"] = true` and, before each new turn, patches
the same override onto a Session created elsewhere. OpenClaw admits
`toolOverrides` only from a device holding `operator.admin`, which the gateway
requests; a turn whose patch fails does not start. OpenClaw names the tools
`aos-ui__render_chart` and so on, and the gateway canonicalizes those names.

### MCP Apps

OpenClaw serves MCP Apps natively, and AOS renders them as App cards
([MCP Apps](https://github.com/AlmogBaku/aos-ui/blob/main/docs/mcp-apps.md)). Register the App server under `mcp.servers` like
any other MCP server, and turn MCP Apps on in the Gateway:

```bash
openclaw mcp add NAME --url https://apps.example.test/mcp \
  --transport streamable-http
openclaw config set mcp.apps.enabled true
openclaw config validate
openclaw mcp reload
```

The gateway finds a view in the tool result's `details.mcpAppPreview`, opens it
with `mcp.app.view`, and relays the view's requests through `mcp.app.callTool`
and `mcp.app.readResource`. OpenClaw caps a view's HTML at 2 MiB. A view the
Gateway no longer holds, or any view while `mcp.apps.enabled` is off, shows
the tool call's textual details. The tool shows as `mcp__NAME__TOOL`, resolved
against the Session's `tools.effective` list. The gateway's `mcpApps` headers
block does not apply to OpenClaw.

### Creator Agent

OpenClaw's Agent summary has no field for a role, so AOS treats the Agent with
the reserved id `aos-agent-creator` as the creator behind **New Agent** and
keeps it out of the roster. Create it with `openclaw agents add` and give its
workspace a copy of the `aos-agent-creator` skill. After the user confirms a
definition, the creator runs `openclaw agents add` as the skill's
`reference/harness-openclaw.md` describes, so it needs OpenClaw's command
execution tool.

### MCP App file reads

The gateway reads a file named by a `present_artifact` App view through the
Control UI's media route:
`GET <basePath>/__openclaw__/assistant-media?source=<path>&sessionKey=<key>&agentId=<id>`.
The request carries the device token as Bearer, `Accept: application/octet-stream`,
`Accept-Encoding: identity`, and follows no redirects. The base path comes
from `gateway.controlUi.basePath`, read through `config.get`; a changed base
path takes effect only after the Gateway restarts. File reads are only available
when both the Gateway origin and a device token are configured.

OpenClaw checks its own roots against the path. The gateway's operator rules and
deny list judge only the written path, so a symbolic link inside OpenClaw's
roots can reach a file those rules would otherwise deny. Guests get
no file addresses on OpenClaw. A sandboxed Session, or one running on another
machine, answers 404. A call is not found when its assistant row exceeds
128 KiB. OpenClaw stores a redacted copy of the arguments, so a path that
looks like a secret reads masked (404).

To look up the call's input, the gateway scans the paged history from
`chat.history`. A tool name counts as an MCP call only when `tools.effective`
lists it by its exact name.

OpenClaw's own native media is read through `artifacts.download` and appears
after the Session is reloaded, not while the turn streams.

## Agent icons

Each Agent's icon is stored in the `identity.avatar` field of the Agent's own
authored entry in `agents.list` inside the config.

The gateway writes an icon only for a non-creator Agent (never `aos-agent-creator`)
that has its own `agents.list` entry whose `id` exactly matches. An Agent with
no authored entry cannot take a write; its `avatarEditable` is `false`. The
implicit default Agent (no entry) stays unsaved for the same reason.

The write reads the current config hash with `config.get`, then sends one
`config.patch` with that `baseHash` and exactly
`{agents:{list:[{id, identity:{avatar}}]}}`, then re-lists to confirm.
It requires `operator.admin`.

The `config.get` payload may carry credentials. The gateway keeps only the config
hash and the set of authored Agent ids, and logs or returns nothing else from
it. Every catalog read also calls `config.get` to refresh the authorized set,
so the credential-bearing payload passes through gateway memory on each read
before that reduction; the device's `operator.admin` scope can read it anyway.
OpenClaw merges the patch into `agents.list` by id, refuses one that would drop
an entry, and applies an `agents` change without restarting the Gateway.

Visibility changes are unsupported for OpenClaw; a patch that includes
`visibility` is rejected as a whole.

OpenClaw's own Control UI reads `identity.avatar` as a file path, so after AOS
writes a token such as `ring/blue` that field may show as a broken or default
avatar in the Control UI.

Session `createdAt` comes from the native millisecond timestamp in `createdAt`.

The first workspace open after the gateway is upgraded saves an icon for every
Agent with an authored entry.

## Folder

Each Agent's folder is the `workspace` field on its `agents.list` row. AOS
uses it as the required `cwd` for `session/new` and `session/resume`.

## Capability limits

- AOS reads provider Agents, Sessions, history, model catalog, context usage, runs, questions, permissions, and supported image/file attachments through the negotiated Gateway policy.
- Session creation, rename, pin, archive, delete, and Artifacts are available. Todos, Activity, edit/regenerate, steering, visibility changes, and read state are unavailable because the pinned Gateway leaves do not prove matching native operations. Avatar writes are available for Agents with an authored config entry. Voice becomes available when the gateway `voice` block is configured; see [Use voice](https://github.com/AlmogBaku/aos-ui/blob/main/docs/chat-voice.md).
- An invitation can resolve only a pre-existing reserved OpenClaw Session. The adapter does not create a Session for a new guest invitation because the pinned Gateway leaves do not prove equivalent native creation semantics.
- Device identity and tokens are server-only. Treat pairing/authentication failures as private gateway configuration problems, never as client credentials.
- The gateway requests device token scopes `operator.read`, `operator.write`, `operator.approvals`, `operator.questions`, and `operator.admin`. Admin scope is what lets it enable the `aos-ui` MCP server per Session; pair the gateway device with it.
- A `pairing-required` error is terminal unless the Gateway responds with `pauseReconnect: false` or `recommendedNextStep: "wait_then_retry"`, in which case the adapter retries.

## Verify

Run the gateway checks for the selected deployment and verify the Gateway is reachable from the gateway host:

```bash
bunx vitest run src/adapters/openclaw
```

Confirm the Gateway is reachable and the device identity and token files are correct:

```bash
bun run serve --config /absolute/private/path/config.openclaw.yaml
curl --fail --silent --show-error http://127.0.0.1:4100/api/v1/readyz
```

Native live acceptance has not been run; mocked protocol tests do not prove a paired live OpenClaw journey.

For connection problems, see [Troubleshooting](https://github.com/AlmogBaku/aos-ui/blob/main/docs/troubleshooting.md).
