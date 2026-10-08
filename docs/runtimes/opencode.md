# Run the gateway with OpenCode

The gateway attaches to one separately operated OpenCode server, keeps its
Basic-auth credentials private, and scopes every Session operation to the
configured absolute OpenCode directory. It is not a client-direct OpenCode
integration. aos-ui is the first-class client.

## Prerequisites

- Bun and an OpenCode installation authenticated with the model providers you intend to use
- An absolute external worktree for OpenCode to operate in
- Private, owner-only files for the OpenCode server password and the gateway signing keys

The worktree is native runtime state. Do not point OpenCode at the harness-gw
checkout unless that is deliberately the Agent's working directory. The gateway
neither installs OpenCode nor owns its provider credentials.

## Attach a locally operated server

Start OpenCode independently, with server authentication enabled, then create a
private gateway configuration from `examples/config.opencode.example.yaml`. Set
its `runtime.baseUrl` to the server address reachable by the gateway,
`runtime.directory` to the exact absolute worktree, `runtime.username` to the
OpenCode server username, and `runtime.passwordFile` to the matching private
password file.

```bash
# Terminal 1: OpenCode owns this process and its provider credentials.
cd /absolute/path/to/external-worktree
OPENCODE_SERVER_USERNAME=aos-ui \
OPENCODE_SERVER_PASSWORD='replace-with-a-private-secret' \
  opencode serve --hostname 127.0.0.1 --port 4096

# Terminal 2: the client talks only to this gateway.
bun run serve --config /absolute/private/path/config.opencode.yaml
```

Connect aos-ui (or any ACP v2 client) to the gateway's configured `publicOrigin`.

Never put the server password, provider credentials, directory, or native URL in
a client-facing URL or configuration.

## Native model configuration and AOS UI tools

The installation prompt in aos-ui (`shared/install/PROMPT.md`) lets an agent
perform the steps below; its OpenCode reference holds the exact commands. The
manual steps follow.

OpenCode owns provider/model configuration and credentials. AOS reads the
native model catalog and can select a model for a resumed Session, but does
not choose a default model. Reasoning-effort selection is unavailable because
OpenCode reports no reasoning ladder.

Register the aos-ui tools MCP server as a remote entry in the OpenCode `mcp`
config. Run it first (see aos-ui for the `tools-mcp:serve` script and port
details), then add the entry:

```json
{
  "mcp": {
    "aos-ui": {
      "type": "remote",
      "url": "http://127.0.0.1:4110/mcp",
      "enabled": true
    }
  }
}
```

OpenCode's v2 session engine, which AOS drives, does not expose MCP tools at the
pinned `1.18.29`. The `aos-ui` tools are therefore registered but not callable
through AOS on OpenCode until upstream exposes MCP tools to that engine. When
they are, the gateway canonicalizes their names like any other harness. Charts,
maps, and stats are [MCP App](#mcp-apps) views the gateway reads from the
registered URL itself, so that URL must reach the server from the gateway as
well as from OpenCode, and each view receives a text-only result.

The `aos-agent-creator` skill can be placed at
`.opencode/skills/aos-agent-creator/SKILL.md` and the `aos-invite-link` skill
at `.opencode/skills/aos-invite-link/SKILL.md` in the worktree. The creator may
write only a new `.opencode/agents/<id>.md` file. The OpenCode adapter does not
yet report it as the creator, so AOS does not offer **New Agent** on OpenCode.

Set `AOS_RUNTIME_PROXY_URL` for an Agent using `aos-invite-link` to the
configured operator gateway origin. The skill prefers the operator invitation
endpoint over the local CLI, so it needs network access but no signing key.

## MCP Apps

AOS renders an MCP server's App views as App cards ([MCP Apps](https://github.com/AlmogBaku/aos-ui/blob/main/docs/mcp-apps.md)).
Register the App server as a remote entry in the OpenCode `mcp` config; AOS
itself needs no entry:

```json
{
  "mcp": {
    "NAME": {
      "type": "remote",
      "url": "https://apps.example.test/mcp",
      "enabled": true
    }
  }
}
```

OpenCode keeps no App views, so the gateway reads the server list from
`GET /config` and connects to each view's server with its own MCP client:

- It reaches only enabled remote servers without `headers` or OAuth. A local
  server, or one that needs credentials the gateway does not hold, shows the
  tool call's textual details.
- For a server that needs headers, give the gateway its own copy under
  `mcpApps.fallback.servers.NAME.headers` in the gateway configuration
  (`src/config.ts`). Its URL must then be `https:` or loopback.
- When the gateway reaches a server at another address than OpenCode does, set
  `mcpApps.fallback.servers.NAME.url`; the gateway connects there instead.
- OpenCode stores only a tool's text output, so the view receives a text-only
  result; the tool is never called again to recover more.
- The tool shows as `mcp__NAME__TOOL`, matched against the configured server
  names even when a name contains `_`.

MCP tools are not callable from the v2 session engine at the pinned `1.18.29`
(see above), so Apps appear once upstream exposes them. This fallback is
temporary and goes away once OpenCode serves MCP Apps itself.

## Folder

Each Agent's folder is the gateway's configured `runtime.directory`. AOS uses it
as the required `cwd` for `session/new` and `session/resume`.

## Artifacts

OpenCode 1.18.29 cannot call MCP tools, so `present_artifact` is not callable
and the App shows "Can't reach this file". `open` returns no file addresses.
There is no file read or call lookup on this runtime yet.

## Agent icons

OpenCode has no native Agent write, so every `_hgw/agents/update` call returns
the `-31015 unsupported` error and `avatarEditable` is `false` for every Agent.

An operator may hand-write an `avatar: ring/blue` key in the Agent file's
frontmatter. The gateway reads it from `request.body.avatar` and treats it as
the Agent's icon. Be aware of two effects:

- OpenCode forwards `request.body` to the model provider on every request, so
  the `avatar` key travels to the LLM API.
- An unknown frontmatter key causes OpenCode to load that Agent file with its
  legacy parser, which may change other frontmatter handling.

Agents without a stored icon receive a generated icon derived from their
position in the id-sorted roster. If the roster changes, the icon assignments
can shift. A stable icon requires writing the frontmatter key.

Session `createdAt` comes from `time.created`.

A follow-up ticket (ALM-16) will adopt `experimental.fs.write` once a released
OpenCode ships it, enabling the gateway to store icons without frontmatter.

## Capability limits

- AOS reads the native Agent catalog, creates, renames, pins, archives, and deletes Sessions, and projects Session Todos, but Agent visibility, Agent icon writes, Activity, and context accounting are unavailable when OpenCode has no exact matching operation. Voice becomes available when the gateway `voice` block is configured; see [Use voice](https://github.com/AlmogBaku/aos-ui/blob/main/docs/chat-voice.md).
- Runs support streaming, reconnect, Stop, attachments, questions, and permissions. Edit/regenerate and active-turn steering are unavailable.
- An invitation can resolve only an existing OpenCode Session titled `aos-invite:<ref>`. OpenCode cannot create that reserved Session safely because its pinned API has no title-bearing creation and a separate rename is not atomic; a new invitation therefore cannot create a Session on first Send.
- AOS never restarts OpenCode automatically. Restart it under operator control after changing its configuration, once active work has finished.

## Verify

```bash
bunx vitest run src/adapters/opencode
```

Native live acceptance has not been run. It requires approved disposable Agents and real model credentials; mocked tests do not prove a live OpenCode journey.

For connection problems, see [Troubleshooting](https://github.com/AlmogBaku/aos-ui/blob/main/docs/troubleshooting.md).
