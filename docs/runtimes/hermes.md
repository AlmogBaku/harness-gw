# Run the gateway with Hermes

The gateway connects to an independently operated `hermes serve` HTTP/WebSocket
API. Hermes owns profiles, Sessions, runs, tools, credentials, and durable
history. Clients connect over ACP v2 WebSocket at `/api/v1/acp`. aos-ui is the
first-class client.

## Prerequisites

- An authenticated Hermes server reachable from the gateway
- A Hermes server token in a private, owner-readable file
- Bun

The minimum supported Hermes revision is `v2026.9.24`.

## Start Hermes independently

Install and configure Hermes outside the harness-gw checkout, then start its
native server:

```bash
hermes serve
```

The example gateway configuration expects Hermes at
`http://host.docker.internal:9119`. Keep native profile state and credentials
outside the gateway checkout.

## Create private configuration

Copy the example outside the checkout:

```bash
cp examples/config.hermes.example.yaml /absolute/private/path/config.yaml
chmod 600 /absolute/private/path/config.yaml
```

The gateway accepts the file when it is owned by the user running it at mode
0600 or 0640, or owned by root at mode 0644; it refuses any group- or
world-writable mode.

Set these fields in the private copy:

- `listen` and `publicOrigin` for the trusted operator listener;
- `runtime.baseUrl` and `runtime.tokenFile` for the one selected Hermes runtime;
- optionally, a distinct `guest.listen`, `guest.publicOrigin`, and invitation
  signing key.

The operator listener has no application login. Anyone who can reach it can
operate every visible Agent and Session, so bind it to loopback or a trusted
private network. State-changing client requests must still use the exact
configured origin.

Secret files must be regular, non-symlinked, owner-only files. Generate each
32-byte base64url key with:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Write the Hermes token exactly as supplied by Hermes, with at most one trailing
newline. Never put it in an environment variable or a client-facing URL.

## Run locally

```bash
bun run serve --config /absolute/private/path/config.yaml
```

The gateway listens on the `listen` address and port from the config.
Connect aos-ui (or any ACP v2 client) to the gateway's `publicOrigin`.

## Create a guest invitation

```bash
bun run gateway invite --config /absolute/private/path/config.yaml --agent default
```

The installed `aos-invite-link` skill uses `curl` against the operator gateway's
`/api/v1/guest-invitations` endpoint. Set `AOS_GATEWAY_URL` to a
reachable configured operator origin in the Hermes environment. This works
for native Hermes without exposing the invitation signing key.

The command prints a link, defaults to 72 hours, and generates a stable
conversation reference. Add `--ref`, `--instruction`, `--prefill`, `--title`,
`--message`, `--lang`, or `--expires-in` only when needed. Creating or opening
the link does not contact Hermes or create a Session; the first guest Send
atomically reuses or creates `aos-invite:<reference>`.

Before issuing a link, follow the [invited-chat guide](https://github.com/AlmogBaku/aos-ui/blob/main/docs/invite-chat.md) to
prepare a dedicated, narrowly skilled Hermes profile and restrict its native
tools, filesystem, network, credentials, and approval behavior for the guest
workflow.

Hermes owns native recovery policy, including auto-continue. The gateway
reattaches without submitting a new prompt. Disconnecting a client does not stop
work. After a terminal Session has no subscribers or pending interaction, the
gateway keeps it warm for five minutes and then closes only that Session
attachment. The shared Hermes socket stays open.

## Register the AOS UI tools

The installation prompt in aos-ui (`shared/install/PROMPT.md`) lets an agent
perform the steps below; its Hermes reference holds the exact commands. The
manual steps follow.

aos-ui ships its own stateless MCP server with four tools: `render_chart`,
`render_map`, `render_stats`, and `present_artifact({path, title?, mimeType?})`,
where `path` is an absolute path. The first three are
[MCP Apps](https://github.com/AlmogBaku/aos-ui/blob/main/docs/mcp-apps.md) whose views draw the chart, map, or stats in the
message; `present_artifact` has an App view that shows the file; the gateway
reads it through Hermes. Each tool's description carries its usage guidance;
there is no AOS system prompt to install.

Run the tools MCP server on the Hermes host, bound to loopback (see aos-ui for
the `tools-mcp:serve` script and port details).

Register it in each profile that should use the tools. Hermes reads
`mcp_servers` from the profile's own `config.yaml`
(`~/.hermes/profiles/PROFILE/config.yaml`, or `~/.hermes/config.yaml` for the
default profile):

```yaml
mcp_servers:
  aos-ui:
    url: http://127.0.0.1:4110/mcp
```

`hermes -p PROFILE mcp add aos-ui --url http://127.0.0.1:4110/mcp` writes the
same entry interactively after probing the server; answer that it needs no
authentication. Check the connection with `hermes -p PROFILE mcp test aos-ui`.

The tools reach the model as `mcp__aos_ui__render_chart` and so on; the gateway
canonicalizes those names, so the client renders them as AOS tools. Hermes
keeps no App views, so the gateway reads the chart, map, and stats views from
the URL the profile registers ([MCP Apps](#mcp-apps)). A gateway running in a
separate process from Hermes must override that URL with its own address for the
server under `mcpApps.fallback.servers.aos-ui.url` in `src/config.ts`; the
example config sets `http://tools-mcp:4110/mcp` when running alongside a
separate tools-mcp process. The server loads on every platform the profile
serves, messaging channels such as Telegram included.

A running `hermes serve` connects a newly added server within about a minute
and refreshes a Session's tool list between turns, so no restart is needed.
When `aos-ui` is the profile's first MCP server, run `/reload-mcp` in the
Session, or start a new Session, to pick the tools up.

### Skills

AOS UI's skills are plain Hermes skills: `shared/invite-link` (the
`aos-invite-link` skill) and `shared/agent-creator` (the `aos-agent-creator`
skill). Either copy a skill's directory into the profile's `skills/` directory,
or list a directory that holds them; Hermes finds every `SKILL.md` below each
listed directory:

```yaml
skills:
  external_dirs:
    - /absolute/path/to/aos-ui/shared
```

External directories are read-only and lose a name collision to the profile's
own skills. Hermes caches the skills index of a running server, so restart
`hermes serve` after adding a skill.

## MCP Apps

Any MCP server whose tool declares an App view renders as an App card in AOS
([MCP Apps](https://github.com/AlmogBaku/aos-ui/blob/main/docs/mcp-apps.md)). Register the server in the profile like any other
MCP server; AOS itself needs no entry:

```bash
hermes -p PROFILE config set mcp_servers.NAME.url https://apps.example.test/mcp
hermes -p PROFILE mcp test NAME
```

Hermes drops a tool's `_meta.ui` and has no API to read an MCP resource, so the
gateway reads the view itself. It lists the profile's servers through
`GET /api/mcp/servers?profile=PROFILE` and connects to their URLs with its own
MCP client:

- It reaches only enabled Streamable HTTP servers. A stdio server, or one that
  needs credentials the gateway does not hold, shows the tool call's textual
  details instead.
- For a server that needs headers, give the gateway its own copy under
  `mcpApps.fallback.servers.NAME.headers` in the gateway configuration
  (`src/config.ts`). Its URL must then be `https:` or loopback.
- When the gateway reaches a server at another address than Hermes does, set
  `mcpApps.fallback.servers.NAME.url`; the gateway connects there instead of the
  URL the profile registers.
- The tool shows as `mcp__NAME__TOOL` with the server's original name, even
  where Hermes sanitizes or shortens it.
- The server list is cached for about 5 minutes; a tool from a server added
  since is picked up within 30 seconds.

This fallback is temporary and goes away once Hermes serves MCP Apps itself.

## Sessions and Artifacts

Sessions the gateway creates carry `source: "aos-ui"`. An Artifact is published
by an assistant `MEDIA:/absolute/path` line, Hermes's own delivery convention.
The gateway removes each `MEDIA:` line from the prose, validates the path, and
reads the bytes through `GET /api/fs/read-data-url`. A path that is relative,
traverses, or names a credential file such as `.env` or `auth.json` is refused.

Set `runtime.mediaArtifacts: false` to turn this off. A `MEDIA:` line then
stays in the message text as written, so every reader of the Session, guests
included, sees the file's native path, and a text-to-speech receipt publishes no
audio Artifact. Images attached to a user message stay Artifacts either way,
because they belong to the gateway's own attachment flow rather than to Hermes's
delivery convention.

### MCP App file reads

To read a file named by a `present_artifact` call's App view, the gateway
first lists the file's folder with
`GET /api/files?path=<folder>&profile=<profile>&session_id=<sessionId>`. The
listing entry's `path` is the real path — every link followed — and that is the
path the gateway's folder rules (`src/config.ts`) judge. A listing that answers
400 is a link loop or a non-folder path (`listing_invalid`); 403 means the
folder is outside a locked root or Hermes may not read it (`listing_refused`);
404 is a missing folder (`listing_missing`); 500 is a broken link
(`listing_failed`). If the real path cannot be determined because the file is
not listed, the gateway logs `hermes.file.real_path_unknown` with reason
`not_listed`. A broken or looping link anywhere in the folder makes the whole
listing fail, blocking every file in it. A folder outside a locked Hermes root
cannot be served. On Python 3.13+ a link loop answers 500 instead of 400.

Once the real path passes, the gateway streams bytes with
`GET /api/fs/download?path=<realPath>&profile=<profile>&session_id=<sessionId>`.

To look up the call's input when the App opens, the gateway pages the stored raw
rows with `GET /api/sessions/:id/messages`. Hermes stores a call's row before
the tool runs, so a call whose turn is still live is found.

## Creator profile

The creator behind **New Agent** is an ordinary profile, conventionally
`aos-agent-creator`, that loads the `aos-agent-creator` skill. Its marker lives
in its `profile.yaml`, and no `hermes` command sets it; the gateway keeps the
marked profile out of the Agent roster and management surfaces:

```yaml
ui_meta:
  aos:
    role: creator
  hermes-bots:
    hidden: true
```

The marker grants no authority. After the user confirms a definition, the
creator writes the new profile with `hermes profile create` and the other
steps in the skill's `reference/harness-hermes.md`, so it needs Hermes's
terminal tool. AOS shows the new Agent once Hermes lists it, and the draft
**New Agent** row resolves into it. A freshly provisioned profile has no
credentials for its model: Hermes copies a new profile's model block but not
its credential pool, so sign it in with `hermes -p <name> auth add`. Never copy
another profile's tokens into it.

## Agent icons

Each Agent's icon is an opaque `silhouette/tone` token stored in
`ui_meta.aos.avatar` of the profile. A stored value that does not match
`/^[a-z0-9-]{1,32}\/[a-z0-9-]{1,32}$/` reads as no icon.

The Agent revision used for the compare-and-set is composite:
`hermes-bots:N,aos:M`, where `N` and `M` are the per-namespace CAS counters
that `profiles.list` returns in `ui_meta_revisions`.

`_hgw/agents/update` writes the avatar (and optionally visibility) with one
`profiles.configure` call. That call sends only the `ui_meta` namespaces the
patch touches, each paired with its current `ui_meta_expected_revisions` entry,
so unrelated `aos` keys such as `role` survive intact. Passing `null` for the
avatar removes the key.

`avatarEditable` equals `editable` for every profile. The creator profile is
never writable.

Session `createdAt` comes from the Session row's `started_at` (epoch seconds).

The first time the workspace opens after the gateway is upgraded, it saves an
icon for every visible, editable Agent: one `ui_meta.aos.avatar` key per
profile, written through the same compare-and-set `profiles.configure` call
visibility uses.

## Operational behavior

- Native profiles form the AOS Agent catalog and can expose Agent updates (visibility and avatar).
- Native CLI or cron Sessions may appear in AOS even when the client did not create them.
- Activity is workspace-wide: the feed covers every Session the connection may observe.
- ACP v2 starts or resumes a run and carries its server-to-client event stream.
  Stop (`session/cancel`) and steering (`_hgw/session/steer`) travel over the
  same ACP socket; neither creates another run.
- Stop uses native `session.interrupt`.
- Text-only active-turn steering uses native `session.redirect`. Hermes may
  report the correction as immediately redirected or accepted into its native
  build-window queue; both outcomes mean the gateway must not submit another copy.
- A steering redirect seals the current assistant generation, preserves
  completed tool results, presents the visible correction at that boundary,
  and continues under the same logical run until Hermes is authoritatively
  idle.
- Questions, approvals, attachments, edit/regenerate, Artifacts, and Todos are projected from native Hermes interfaces when present. The `aos-ui` tools appear only in profiles that register the MCP server.
- AOS needs `display.tool_progress` left at its default (`all`). With `off`, live tool calls are withheld from the tui gateway stream and appear only after a reload. `display.show_reasoning` gates nothing AOS reads; it only makes the messaging gateway prepend reasoning to chat replies.
- Each served profile needs an existing `terminal.cwd` that is neither `.`, `auto`, `cwd`, nor a missing directory; the gateway reads it with `config.get project` and lists it as the Agent's folder. If the launch profile or `TERMINAL_CWD` sets a different path at runtime, the listed folder may not match where the Session actually runs. A named SSH profile needs a remote `terminal.cwd` that is an absolute path (`~/…` yields no folder), or AOS cannot list, start, or resume its Sessions.
- The listed folder is the Agent's. A resumed Session runs in the folder Hermes stored on its own row, which can differ.
- When Hermes compacts a conversation, the carried-forward messages receive new row ids. History reads after a compaction return the new ids; live ids before it remain in the client until the page reloads.
- Session rename, pin, archive, delete, and provider-owned read state (`unread` catalog row; PATCH `{unread:false}`) are available. `runtime.sessionIdleMs` controls how long the gateway keeps a warm Session attachment after the last subscriber disconnects before closing only that Session.
- Voice controls appear for native STT/TTS interfaces and when the gateway `voice` block is configured; see [Use voice](https://github.com/AlmogBaku/aos-ui/blob/main/docs/chat-voice.md).
- The gateway authenticates the `/api/ws` WebSocket with `?token=` in the URL.
  This is upstream Hermes behavior; Hermes accepts the token query parameter
  only on loopback or when started with `--insecure`; do not expose a
  `--insecure` Hermes instance beyond a trusted private network.
  Hermes closes with 4401 on token rejection and with 4403 on host or origin
  denial. AOS treats 4401 as `runtime_authentication_required` (latches auth
  until re-credential) and 4403 as `unavailable` (logged, retried). Treat an
  immediate WebSocket close after dial with either code as an authentication
  problem and check the Hermes server log.
- Hermes refusals keep Hermes' own words as the failure's second line. A
  Session another Hermes window owns fails with `HGW_SESSION_IN_USE`; Hermes'
  active-Session limit fails with `HGW_SESSION_LIMIT`; a prompt sent while a
  turn still runs is refused with the ACP turn-in-progress error, before
  Hermes stores it. A reattach Hermes fences while it settles a
  disconnect, and an unreadable ownership registry, are retried for a few
  seconds without a visible error, then fail with `HGW_PROVIDER_UNAVAILABLE`.
  A question Hermes no longer holds open fails with `HGW_INTERACTION_EXPIRED`.
- A Session AOS finds `waiting` whose open request Hermes does not re-deliver
  within about two seconds, while nothing else changes, reports
  `HGW_INTERACTION_LOST`. The turn stays running so Stop remains available;
  Stop interrupts it natively and the Session then accepts a new prompt.
- A Hermes restart resets every active run once: the next attach produces
  `HGW_RESET_REQUIRED`, which clears the in-progress indicator and reloads
  history from the Hermes transcript. No prompt is re-sent.

## Native routes the gateway calls

When placing an egress allowlist between the gateway and Hermes, allow these
Hermes-native routes from the gateway host:

- `GET /api/sessions` — session list
- `GET /api/sessions/:id`, `PATCH /api/sessions/:id`, `DELETE /api/sessions/:id` — session detail and mutations
- `GET /api/sessions/:id/messages` — message history
- `GET /api/fs/read-data-url` — artifact byte reads
- `GET /api/mcp/servers?profile=` — MCP server list for tool names and MCP Apps
- `GET /api/tools/toolsets/{stt,tts}/config` — audio configuration
- `POST /api/audio/transcribe`, `POST /api/audio/speak` — transcription and speech
- `GET /api/ws` (WebSocket upgrade) — gateway connection for profiles, runs, questions, and events

## Live operator checks

These checks require a disposable Session and real credentials. Run them
against a new pin or before confirming a deployment.

- **Network cut 5 s mid-turn**: sever the gateway-to-Hermes connection for 5
  seconds while a long run is in progress, then restore it. The client should
  show no error; the run should resume and complete normally. The
  `HGW_CONNECTION_INTERRUPTED` event should not reach the client.
- **Network cut 30 s mid-turn**: sever for 30 seconds (beyond the 20 s heal
  grace). The adapter should produce one `HGW_RESET_REQUIRED` and reload
  history. No prompt should be re-sent.
- **Hermes restart mid-turn**: stop and restart `hermes serve` while a run is
  active. The adapter should attach to the restarted instance and emit
  `HGW_RESET_REQUIRED` exactly once. The run indicator should clear; history
  should reload.
- **Clarify and approval with mid-question reload**: start a Session that asks
  a question or approval. Reload the client mid-question. The interrupt
  should reconstruct from history. Answer the question; the run should
  continue.
- **Invalid token**: set a wrong token in the config and start the gateway.
  Connection should fail immediately with a recognizable authentication error
  in the server log. No token value should appear in any client-facing
  response.
- **Confirm close code on auth rejection**: supply a bad token and observe the
  WebSocket close code. Expect 4401, which latches the auth failure state in
  the gateway. 4403 (host/origin denial) retries silently; check the Hermes log
  if the gateway never comes up.

## Verify

```bash
bunx vitest run src/adapters/hermes
```

Live acceptance requires an approved profile, disposable Session, and real credentials. If authentication, WebSocket attachment, or profile discovery fails, see [Troubleshooting](https://github.com/AlmogBaku/aos-ui/blob/main/docs/troubleshooting.md).
