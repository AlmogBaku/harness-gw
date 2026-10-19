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
and `mcp.app.readResource`. A view's `ui/update-model-context` goes to
`mcp.app.updateModelContext` when `mcp.app.view` reports
`updateModelContextSupported`, and answers `unsupported` otherwise; OpenClaw
hands it to the Session's next turn but a heartbeat, out of the transcript.
OpenClaw caps a view's HTML at 2 MiB. A view's
read of its own file address is never relayed and answers `unavailable` (see
[Reading a view's files](../protocol.md#reading-a-views-files)). A view the
Gateway no longer holds, or any view while `mcp.apps.enabled` is off, shows
the tool call's textual details. The tool shows as `mcp__NAME__TOOL`, resolved
against the Session's `tools.effective` list. The gateway's `mcpApps` headers
block does not apply to OpenClaw.

### Agent metadata

OpenClaw's closed Agent summary has no place for a client's own metadata, so an
OpenClaw Agent's summary carries no `_meta`. The gateway treats no Agent id
specially: an Agent named `aos-agent-creator` is listed, selectable, and
writable like any other.

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

The gateway writes an icon only for an Agent that has its own `agents.list`
entry whose `id` exactly matches. An Agent with no authored entry cannot take a
write; its `avatarEditable` is `false`. The implicit default Agent (no entry)
stays unsaved for the same reason.

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

Visibility changes and mutes are unsupported for OpenClaw: a patch that
includes `visibility` or `muted` is rejected as a whole, so no mute is
dropped beside an avatar that is written, and `muteEditable` is `false` for
every Agent.

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
- A question's answer is held only to OpenClaw's own rules: no empty value, blank text only for a secret or form question, one value unless the question is multi-select, and typed text only where the question takes it. OpenClaw bounds no answer's length, and question text and option labels are read up to 512 KiB a field.
- Session creation, rename, pin, archive, delete, fork, edit/regenerate, and Artifacts are available. Todos, Activity, steering, and visibility changes are unavailable because the pinned Gateway leaves do not prove matching native operations. Avatar writes are available for Agents with an authored config entry. Voice becomes available when the gateway `voice` block is configured; see [Use voice](https://github.com/AlmogBaku/aos-ui/blob/main/docs/chat-voice.md).
- Read state is available when the Gateway's hello advertises `session-unread-ack-contract`: AOS reads a Session row's `unread` and writes `{ unread }` through `sessions.patch`. Without it, AOS neither reads nor writes read state.
- The gateway calls `sessions.subscribe` and sends operator connections `_hgw/catalog_invalidated` once per burst of `sessions.changed`, the first change opening a one-second window. It subscribes again on each new Gateway connection.
- Edit and Retry rewind with `sessions.rewind`, then send. Those are two writes: a send that fails after the rewind is reported as an uncertain send. The rewound message must be within the Session's last 200 history rows, its attachments are not restored, and an empty Retry of a message that had attachments is refused.
- Fork uses `sessions.create` with `fork: true`, from the last completed turn while the Session is running. OpenClaw refuses to fork a Session past about 100k tokens.
- A Session `sessions_spawn` starts is a child Session of the turn. It stays out of the Session list, is followed live, and Stop on it sends `sessions.abort`. `sessions_spawn` returns at once, so a child usually outlives its parent's own run: while someone has the Session open, it goes on as background activity, the parent's turn ends and the parent takes new prompts, and the child keeps streaming into its card, asks its approvals on it, and can still be stopped. A reload or a reconnect within a minute finds it still followed; with nobody watching for longer, it is reported as no longer followed, and a reload reads what it did since. Approvals are taken only from children the gateway registered under the same Agent. A child's questions are not shown. A reload reads its transcript up to 500 rows, without media.
- Compactions do not show again on reload (ALM-42).
- An invitation can resolve only a pre-existing reserved OpenClaw Session. The invitation's first-turn instruction is never applied there, since that Session is not created for it; write any setup into the reserved Session itself. The adapter does not create a Session for a new guest invitation because the pinned Gateway leaves do not prove equivalent native creation semantics.
- Device identity and tokens are server-only. Treat pairing/authentication failures as private gateway configuration problems, never as client credentials.
- The gateway requests device token scopes `operator.read`, `operator.write`, `operator.approvals`, `operator.questions`, and `operator.admin`. Admin scope is what lets it enable the `aos-ui` MCP server per Session; pair the gateway device with it.
- A `pairing-required` error is terminal unless the Gateway responds with `pauseReconnect: false` or `recommendedNextStep: "wait_then_retry"`, in which case the adapter retries.
- Every turn is sent with `suppressCommandInterpretation: true`, so OpenClaw never interprets typed text as one of its own chat commands. AOS runs its own commands in the browser.

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
