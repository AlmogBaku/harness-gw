# Gateway configuration reference

The gateway reads one YAML file. Every field below maps directly to the Zod
schema in `src/config.ts`; the environment variables table maps to
`PROXY_ENV_OVERRIDES` in `src/config-file.ts`.

## File location

The gateway resolves the file path in this order:

1. `--config <path>` on the command line
2. `HARNESS_GW_CONFIG_FILE` environment variable
3. `${XDG_CONFIG_HOME:-$HOME/.config}/harness-gw/config.yaml` (auto-discovered)

An explicit path that does not exist is an error. An auto-discovered path that
is absent is treated as an empty document; any `HARNESS_GW_*` overrides still
apply.

## File security

The gateway refuses a file that is:

- not a regular file
- group- or world-writable (mode bits `0o022` set)
- not owned by the running user or by root
- larger than 1 MiB

YAML anchors and aliases are not allowed.

## Validate the file

```bash
bun run gateway config check --config /etc/harness-gw/config.yaml
```

`config check` resolves the path, applies `HARNESS_GW_*` overrides, validates
the schema, and exits without starting anything. It does not read the secret
files named by the config; `serve` reads those at start.

## Schema

### Top level

| Field             | Type                  | Default                       | Description                                                                                                                    |
| ----------------- | --------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `version`         | `1`                   | —                             | Schema version; must be `1`.                                                                                                   |
| `deploymentId`    | string                | —                             | Identifier for this deployment. Alphanumeric, dots, hyphens, underscores; 1–128 characters; must start with a letter or digit. |
| `listen`          | [Listener](#listener) | host `127.0.0.1`, port `4100` | Operator listener address.                                                                                                     |
| `publicOrigin`    | URL                   | —                             | The HTTPS or loopback HTTP origin clients connect to. No path, query, or fragment.                                             |
| `allowedOrigins`  | URL[]                 | `[publicOrigin]`              | Exact browser origins the operator listener accepts. 1–16 entries.                                                             |
| `runtime`         | [Runtime](#runtime)   | —                             | The one native runtime this gateway fronts.                                                                                    |
| `limits`          | [Limits](#limits)     | see below                     | Concurrency and queue limits.                                                                                                  |
| `guest`           | [Guest](#guest)       | absent                        | Optional separate guest listener.                                                                                              |
| `push`            | [Push](#push)         | absent                        | Optional Web Push delivery.                                                                                                    |
| `voice`           | [Voice](#voice)       | absent                        | Optional transcription and speech synthesis.                                                                                   |
| `mcpApps`         | [McpApps](#mcpapps)   | absent                        | Optional MCP App file rules and fallback server config.                                                                        |
| `log`             | `{ level }`           | `{ level: "info" }`           | Log level: `debug`, `info`, `warn`, or `error`.                                                                                |
| `shutdownGraceMs` | integer               | `5000`                        | Milliseconds the gateway drains in-flight requests before forcing shutdown. 100–300000.                                        |

### Listener

Used for both `listen` and `guest.listen`.

| Field      | Type                  | Notes                                                                                                                  |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `host`     | string                | `"127.0.0.1"` or `"::1"` for loopback. `"0.0.0.0"` or `"::"` for all interfaces; requires `exposure`.                  |
| `port`     | integer               | 1–65535.                                                                                                               |
| `exposure` | `"private-container"` | Required when `host` is `"0.0.0.0"` or `"::"`. Declares the binding is inside a private container network, not public. |

### Runtime

`runtime.kind` selects the union branch. Every branch also accepts:

| Field            | Type    | Default | Description                                                                                                                                                                                                                            |
| ---------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | string  | —       | Stable identifier for this runtime instance. Alphanumeric, dots, hyphens, underscores; 1–128 characters.                                                                                                                               |
| `mediaArtifacts` | boolean | `true`  | Whether native media deliveries (Hermes `MEDIA:` lines, OpenClaw media blocks) become Artifact records. When `false`, `MEDIA:` lines stay in the text as written. Attached images belong to the gateway's own flow and are unaffected. |

#### `kind: "hermes"`

| Field           | Type     | Default  | Description                                                                                                            |
| --------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`       | HTTP URL | —        | The `hermes serve` base URL (e.g. `http://127.0.0.1:9119`).                                                            |
| `tokenFile`     | path     | —        | Absolute path to a file containing the Hermes server token.                                                            |
| `sessionIdleMs` | integer  | `300000` | Milliseconds after the last subscriber disconnects before the gateway closes a warm Session attachment. 1000–86400000. |

#### `kind: "opencode"`

| Field          | Type     | Description                                                                   |
| -------------- | -------- | ----------------------------------------------------------------------------- |
| `baseUrl`      | HTTP URL | The OpenCode server base URL.                                                 |
| `directory`    | path     | Absolute path to the OpenCode working directory.                              |
| `username`     | string   | Basic-auth username for the OpenCode server. No colons; printable ASCII only. |
| `passwordFile` | path     | Absolute path to a file containing the Basic-auth password.                   |

#### `kind: "openclaw"`

| Field                | Type          | Description                                               |
| -------------------- | ------------- | --------------------------------------------------------- |
| `baseUrl`            | WebSocket URL | The OpenClaw Gateway WebSocket URL (`ws://` or `wss://`). |
| `deviceIdentityFile` | path          | Absolute path to the device identity file.                |
| `deviceTokenFile`    | path          | Absolute path to the device token file.                   |

### Limits

All fields have defaults and can be overridden with `HARNESS_GW_*` variables.

| Field                   | Default   | Range         | Description                                                                                |
| ----------------------- | --------- | ------------- | ------------------------------------------------------------------------------------------ |
| `activeExecutions`      | `256`     | 1–4096        | Maximum concurrent active turns across all Sessions.                                       |
| `guestActiveExecutions` | `32`      | 1–4096        | Maximum concurrent active turns for guest connections. Must not exceed `activeExecutions`. |
| `operatorEventPeers`    | `256`     | 1–4096        | Maximum concurrent operator WebSocket connections.                                         |
| `subscriberEvents`      | `512`     | 1–16384       | Maximum events buffered per connection subscriber.                                         |
| `subscriberBytes`       | `2097152` | 1024–67108864 | Maximum bytes buffered per connection subscriber (2 MiB default).                          |

### Guest

The guest block opens a second listener for invited conversations. It must use
a different origin and address from the operator listener.

| Field                          | Type                  | Description                                                                                                                                                                                                                    |
| ------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `listen`                       | [Listener](#listener) | Guest listener address.                                                                                                                                                                                                        |
| `publicOrigin`                 | URL                   | The HTTPS or loopback HTTP origin for the guest surface.                                                                                                                                                                       |
| `allowedOrigins`               | URL[]                 | Exact browser origins the guest listener accepts. Defaults to `[guest.publicOrigin]`. Must not overlap with the operator listener's origins.                                                                                   |
| `invitations.keys`             | key[]                 | 1–3 HS256 signing keys. Each entry: `{ id, secretFile }`. `id` is 1–32 alphanumeric/hyphen/underscore characters. `secretFile` is an absolute path. Keys are tried newest-first; keep at most one retired key during rotation. |
| `invitations.clockSkewSeconds` | integer               | Accepted clock skew when validating invitation tokens. 0–60, default `0`.                                                                                                                                                      |

### Push

Optional Web Push delivery. All three environment variable overrides must be
set together or not at all.

| Field                  | Type   | Description                                                                                |
| ---------------------- | ------ | ------------------------------------------------------------------------------------------ |
| `stateDir`             | path   | Absolute path to the directory where push subscriptions are stored.                        |
| `vapid.subject`        | string | VAPID contact URI: a `mailto:` address or an `https:` URL.                                 |
| `vapid.privateKeyFile` | path   | Absolute path to the VAPID private key file. The public key is derived from it at startup. |

### Voice

At least one of `transcription` or `speech` must be present.

#### Shared voice provider fields

Both `transcription` and `speech` use `provider: "openai-compatible"` and
share these fields:

| Field        | Type                         | Default      | Description                                                                                                  |
| ------------ | ---------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `provider`   | `"openai-compatible"`        | —            | Provider kind; only `"openai-compatible"` is supported.                                                      |
| `baseUrl`    | HTTP URL                     | —            | Base URL of the OpenAI-compatible API.                                                                       |
| `apiKeyFile` | path                         | absent       | Absolute path to the API key file. Required when `baseUrl` is not HTTPS or loopback.                         |
| `model`      | string                       | —            | Model identifier. 1–256 characters.                                                                          |
| `mode`       | `"fallback"` \| `"override"` | `"fallback"` | `"fallback"` uses this provider only when the runtime has no native capability; `"override"` always uses it. |
| `timeoutMs`  | integer                      | `60000`      | Provider request timeout. 1000–300000 ms.                                                                    |

#### Transcription

Inherits shared fields. Additional field:

| Field      | Type   | Description                                             |
| ---------- | ------ | ------------------------------------------------------- |
| `language` | string | BCP 47 language tag (e.g. `"en"`, `"he-IL"`). Optional. |

#### Speech

Inherits shared fields. Additional fields:

| Field    | Type                                       | Default | Description                         |
| -------- | ------------------------------------------ | ------- | ----------------------------------- |
| `voice`  | string                                     | —       | Voice identifier. 1–128 characters. |
| `format` | `"mp3"` \| `"opus"` \| `"wav"` \| `"flac"` | `"mp3"` | Audio output format.                |

### McpApps

| Field                             | Type      | Description                                                                                                                                                                                                           |
| --------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fallback.servers`                | map       | Per-server overrides for the gateway's own MCP client (used when the runtime has no native MCP Apps API). Keys are server names as the runtime reports them.                                                          |
| `fallback.servers.<name>.url`     | HTTP URL  | Override the URL the gateway connects to for this server (e.g. a Compose service name).                                                                                                                               |
| `fallback.servers.<name>.headers` | map       | Per-header secret files. Each key is an HTTP header name; each value is `{ file: "/absolute/path" }`. The file's whole content becomes the header value. `url` must be HTTPS or loopback when headers are configured. |
| `files.servers`                   | string[]  | MCP servers whose tool calls may serve files to App views. Max 64.                                                                                                                                                    |
| `files.operator`                  | FolderSet | File access rules for operator connections.                                                                                                                                                                           |
| `files.guest`                     | FolderSet | File access rules for guest connections.                                                                                                                                                                              |
| `files.viewer.server`             | string    | MCP server that serves the Artifact viewer resource.                                                                                                                                                                  |
| `files.viewer.resource`           | string    | `ui://` resource URI the viewer opens (e.g. `ui://aos-ui/artifact`).                                                                                                                                                  |

Each `FolderSet` (`files.operator` and `files.guest`) accepts:

| Field         | Type    | Description                                                       |
| ------------- | ------- | ----------------------------------------------------------------- |
| `agentFolder` | boolean | Whether the Agent's working folder is accessible.                 |
| `allow`       | path[]  | Additional allowed folders. Max 64 entries.                       |
| `deny`        | path[]  | Folders explicitly denied. Max 64 entries. Checked after `allow`. |

## Environment variable overrides

Every scalar field in the schema has a `HARNESS_GW_*` counterpart. Overrides
are applied after the file is merged, so the environment wins. Arrays and the
whole `mcpApps` block are file-only. `HARNESS_GW_CONFIG_FILE` names the file
itself (not listed below).

A `guest.*` variable applies only when the file already has a `guest` block; a
stray variable cannot open a second listener. A runtime-specific variable
(e.g. `HARNESS_GW_RUNTIME_TOKEN_FILE`) is rejected when the configured runtime
kind does not match.

| Variable                                          | Config path                          | Type                           |
| ------------------------------------------------- | ------------------------------------ | ------------------------------ |
| `HARNESS_GW_DEPLOYMENT_ID`                        | `deploymentId`                       | string                         |
| `HARNESS_GW_PUBLIC_ORIGIN`                        | `publicOrigin`                       | string                         |
| `HARNESS_GW_LISTEN_HOST`                          | `listen.host`                        | string                         |
| `HARNESS_GW_LISTEN_PORT`                          | `listen.port`                        | integer                        |
| `HARNESS_GW_LISTEN_EXPOSURE`                      | `listen.exposure`                    | string                         |
| `HARNESS_GW_RUNTIME_ID`                           | `runtime.id`                         | string                         |
| `HARNESS_GW_RUNTIME_KIND`                         | `runtime.kind`                       | string                         |
| `HARNESS_GW_RUNTIME_BASE_URL`                     | `runtime.baseUrl`                    | string                         |
| `HARNESS_GW_RUNTIME_MEDIA_ARTIFACTS`              | `runtime.mediaArtifacts`             | boolean (`true`/`false`)       |
| `HARNESS_GW_RUNTIME_TOKEN_FILE`                   | `runtime.tokenFile`                  | string (hermes only)           |
| `HARNESS_GW_RUNTIME_SESSION_IDLE_MS`              | `runtime.sessionIdleMs`              | integer (hermes only)          |
| `HARNESS_GW_RUNTIME_DIRECTORY`                    | `runtime.directory`                  | string (opencode only)         |
| `HARNESS_GW_RUNTIME_USERNAME`                     | `runtime.username`                   | string (opencode only)         |
| `HARNESS_GW_RUNTIME_PASSWORD_FILE`                | `runtime.passwordFile`               | string (opencode only)         |
| `HARNESS_GW_RUNTIME_DEVICE_IDENTITY_FILE`         | `runtime.deviceIdentityFile`         | string (openclaw only)         |
| `HARNESS_GW_RUNTIME_DEVICE_TOKEN_FILE`            | `runtime.deviceTokenFile`            | string (openclaw only)         |
| `HARNESS_GW_LIMITS_ACTIVE_EXECUTIONS`             | `limits.activeExecutions`            | integer                        |
| `HARNESS_GW_LIMITS_GUEST_ACTIVE_EXECUTIONS`       | `limits.guestActiveExecutions`       | integer                        |
| `HARNESS_GW_LIMITS_OPERATOR_EVENT_PEERS`          | `limits.operatorEventPeers`          | integer                        |
| `HARNESS_GW_LIMITS_SUBSCRIBER_EVENTS`             | `limits.subscriberEvents`            | integer                        |
| `HARNESS_GW_LIMITS_SUBSCRIBER_BYTES`              | `limits.subscriberBytes`             | integer                        |
| `HARNESS_GW_GUEST_LISTEN_HOST`                    | `guest.listen.host`                  | string (guest block required)  |
| `HARNESS_GW_GUEST_LISTEN_PORT`                    | `guest.listen.port`                  | integer (guest block required) |
| `HARNESS_GW_GUEST_LISTEN_EXPOSURE`                | `guest.listen.exposure`              | string (guest block required)  |
| `HARNESS_GW_GUEST_PUBLIC_ORIGIN`                  | `guest.publicOrigin`                 | string (guest block required)  |
| `HARNESS_GW_GUEST_INVITATIONS_CLOCK_SKEW_SECONDS` | `guest.invitations.clockSkewSeconds` | integer (guest block required) |
| `HARNESS_GW_PUSH_STATE_DIR`                       | `push.stateDir`                      | string                         |
| `HARNESS_GW_PUSH_VAPID_SUBJECT`                   | `push.vapid.subject`                 | string                         |
| `HARNESS_GW_PUSH_VAPID_PRIVATE_KEY_FILE`          | `push.vapid.privateKeyFile`          | string                         |
| `HARNESS_GW_VOICE_TRANSCRIPTION_PROVIDER`         | `voice.transcription.provider`       | string                         |
| `HARNESS_GW_VOICE_TRANSCRIPTION_BASE_URL`         | `voice.transcription.baseUrl`        | string                         |
| `HARNESS_GW_VOICE_TRANSCRIPTION_API_KEY_FILE`     | `voice.transcription.apiKeyFile`     | string                         |
| `HARNESS_GW_VOICE_TRANSCRIPTION_MODEL`            | `voice.transcription.model`          | string                         |
| `HARNESS_GW_VOICE_TRANSCRIPTION_MODE`             | `voice.transcription.mode`           | string                         |
| `HARNESS_GW_VOICE_TRANSCRIPTION_TIMEOUT_MS`       | `voice.transcription.timeoutMs`      | integer                        |
| `HARNESS_GW_VOICE_TRANSCRIPTION_LANGUAGE`         | `voice.transcription.language`       | string                         |
| `HARNESS_GW_VOICE_SPEECH_PROVIDER`                | `voice.speech.provider`              | string                         |
| `HARNESS_GW_VOICE_SPEECH_BASE_URL`                | `voice.speech.baseUrl`               | string                         |
| `HARNESS_GW_VOICE_SPEECH_API_KEY_FILE`            | `voice.speech.apiKeyFile`            | string                         |
| `HARNESS_GW_VOICE_SPEECH_MODEL`                   | `voice.speech.model`                 | string                         |
| `HARNESS_GW_VOICE_SPEECH_MODE`                    | `voice.speech.mode`                  | string                         |
| `HARNESS_GW_VOICE_SPEECH_TIMEOUT_MS`              | `voice.speech.timeoutMs`             | integer                        |
| `HARNESS_GW_VOICE_SPEECH_VOICE`                   | `voice.speech.voice`                 | string                         |
| `HARNESS_GW_VOICE_SPEECH_FORMAT`                  | `voice.speech.format`                | string                         |
| `HARNESS_GW_LOG_LEVEL`                            | `log.level`                          | string                         |
| `HARNESS_GW_SHUTDOWN_GRACE_MS`                    | `shutdownGraceMs`                    | integer                        |

Boolean overrides accept only `true` or `false`. Integer overrides must be a
whole number of at least one digit. Empty or whitespace-only values are ignored.

## Minimal example (Hermes)

```yaml
version: 1
deploymentId: example-local
listen:
  host: 127.0.0.1
  port: 4100
publicOrigin: http://127.0.0.1:3000
runtime:
  id: hermes-default
  kind: hermes
  baseUrl: http://127.0.0.1:9119
  tokenFile: /etc/harness-gw/hermes-token
shutdownGraceMs: 5000
```

Full examples for each runtime are in `examples/`.
