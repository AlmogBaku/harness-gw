# The harness-gw protocol

harness-gw puts one independently operated agent runtime (Hermes, OpenClaw or
OpenCode) behind ACP v2 over WebSocket, plus a small HTTP API for bytes and
discovery. Clients speak standard ACP; what ACP has no method or field for
travels in the gateway's own extension namespace, `hgw`:

- methods and notifications named `_hgw/*`;
- `_meta.hgw` on requests, responses and notifications;
- the stop reasons `_hgw_error` and `_hgw_uncertain`;
- the auth method `hgw-invite`;
- the attachment URI scheme `hgw-attachment:`.

Every shape below is defined once, in `protocol/acp.ts`, and ships as
`@harness-gw/sdk/protocol`; the browser client at the package root speaks it.
Native runtimes keep their own transports behind the gateway (`src/adapters/`);
`src/acp/` translates the gateway's turn vocabulary to ACP.

## Version

`initialize` answers ACP's `protocolVersion: 2` and, in its top-level
`_meta.hgw.version`, the version of this extension (`HGW_EXTENSION_VERSION`,
now `1`). A breaking change to anything in this document raises it; an
addition (a new method, notification, field or extension flag a client may
ignore) does not. A client that speaks another version must refuse the
connection rather than guess: the SDK client fails `initialized` with an error
naming both versions and closes without reconnecting, since a retry cannot
change the gateway's version.

`initialize`'s `info` names the gateway: `{ "name": "harness-gw", "version":
"<gateway release>" }`.

## Connection

Each listener (operator, and optionally guest) upgrades a GET request to a
WebSocket at:

- `/api/v1/acp` (`HGW_ACP_PATH`): on the operator listener, every Agent; on
  the guest listener, the one invited conversation, after `auth/login`;
- `/api/v1/acp/agents/<agentId>` (`hgwAcpAgentPath`), operator listener only:
  one Agent's Sessions, with no `_meta.hgw.agentId` to name. It scopes the
  connection to that Agent, restricts nothing beyond it, and must never be
  exposed publicly.

Which listener a request reaches, never its path, decides whether it is a
guest's. The operator listener has no authentication of its own: keep it on
loopback or a trusted private network.

A request to a socket path that is not a WebSocket handshake (RFC 6455 §4.2.1)
gets HTTP 400. An unknown Agent path gets 404; a catalog that cannot answer gets 503.

### Origins

Each listener serves an exact list of browser origins, `allowedOrigins`,
defaulting to its `publicOrigin`; the two listeners may not share one. Before
any socket or route is reached:

- a WebSocket upgrade, or any request other than GET, HEAD and OPTIONS, needs
  an `Origin` on that list; a missing, `null` or foreign one gets 403. A client
  that is no browser must still send a listed `Origin`. The one exception is
  `POST /api/v1/guest-invitations` on the operator listener, which admits a
  request with no `Origin`, for scripts.
- a GET or HEAD is never checked, so a view in an opaque-origin frame can read
  the file its pass names.
- CORS answers listed origins only (`Access-Control-Allow-Origin` with
  `Vary: Origin`), never with credentials; a preflight from any other origin
  gets 403.

The response carries an `Acp-Connection-Id` header. A client sends
`initialize` and receives capabilities in `_meta.hgw`. On reconnect, send
`initialize` again and then `session/resume` with `_meta.hgw.after` set to the
last sequence cursor observed. When the cursor is beyond bounded replay, the
same resume rebuilds the Session from history, as described under
[Response `_meta.hgw` shapes](#response-_metahgw-shapes).

The SDK client reconnects with jittered backoff starting at 250 ms, capped at
5 000 ms, and resetting once every resumed Session has rejoined or the link has
been stable for a while. A guest connection re-sends `auth/login` after every
transport recovery before resuming sessions.

Close codes the gateway sends:

| Code   | Meaning                                                                                                                                            | Client action                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `1008` | Policy violation (expired credential, rate or size exceeded)                                                                                       | No reconnect; ends connection |
| `1013` | Gateway at capacity                                                                                                                                | Backs off 30–60 s with jitter |
| `4408` | Handshake unfinished: `initialize` (and a guest's sign-in) not done within 15 s, or the oldest such socket closed past the listener's budget of 32 | Normal reconnect              |

Any other code triggers a normal reconnect.

## Handshake: `initialize` and `auth/login`

`initialize` always answers `protocolVersion: 2`, whatever the client
requested; this is ACP's version-negotiation rule, not v1 support.

The `initialize` response's `_meta.hgw` (`HgwInitializeMetaSchema`):

```json
{
  "version": 1,
  "role": "operator | guest",
  "extensions": {
    "steer": true,
    "rewind": true,
    "composerPrefill": true,
    "agents": true,
    "invalidation": true,
    "activity": true,
    "readState": true,
    "focus": true,
    "guestProjection": true,
    "historyPages": true
  }
}
```

A client advertises what it supports in `clientCapabilities._meta.hgw`
(`HgwClientCapabilitiesMetaSchema`), today only `historyPages`.

`auth/login` on the guest listener uses `methodId: "hgw-invite"`
(`HGW_AUTH_METHOD_INVITE`) and carries the invitation token in
`_meta.hgw.token` (`HgwLoginMetaSchema`).

## Guest listener

A guest connection reaches nothing but `initialize` and `auth/login` until it
redeems an invitation (`src/guest/acp.ts`). Its `initialize` omits
the runtime's title and advertises only the `hgw-invite` auth method. A
connection acts as one invitation for its whole life: a second `auth/login` is
refused with `-32000`.

From the invitation's expiry no frame passes in either direction
(`src/acp/socket.ts`): a request received after it is answered
`-32000` and the socket closes with code `1008`, and an outbound frame after it
closes the socket instead of being written. A timer also closes the connection
at expiry; it re-arms in steps of at most 2^31−1 ms, the longest delay one
timer holds (`src/guest/acp.ts`).

The guest listener advertises (`GUEST_EXTENSIONS`, `src/guest/acp.ts`):

| Extension         | Guest   |
| ----------------- | ------- |
| `steer`           | `true`  |
| `rewind`          | `true`  |
| `composerPrefill` | `true`  |
| `agents`          | `false` |
| `invalidation`    | `false` |
| `activity`        | `false` |
| `readState`       | `false` |
| `focus`           | `false` |
| `guestProjection` | `true`  |
| `historyPages`    | `true`  |

The invited Session's capabilities report slash commands, models, and context
usage unavailable, and steering as the runtime reports it.

Every method runs as a member command through the guest middleware stack in
`src/guest/middleware/` (commands, scope, history, turns,
permissions; events pass back through it in reverse). The guest addresses the
invited conversation by its reference alone; any other Session id is
`-32002`.

| Method                                                                                                               | Guest behavior                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/resume`                                                                                                     | The invited conversation only. A fresh invitation with no Session yet answers idle with nothing to replay.                                   |
| `session/prompt`                                                                                                     | Sends; the first Send creates the invited Session. Edit and Retry (`rewindSourceId`) may name only a user message this connection was shown. |
| `_hgw/session/steer`                                                                                                 | Steers the invited conversation's active turn.                                                                                               |
| `session/cancel`                                                                                                     | Stops a turn in the invited conversation only.                                                                                               |
| `session/close`                                                                                                      | Stops the Session's active work for every member, then detaches.                                                                             |
| `_hgw/session/focus`                                                                                                 | Accepted, answered `{}`, and ignored: read state is the operator's.                                                                          |
| `session/new`, `session/list`, `session/delete`, `session/set_config_option`, `_hgw/session/update`, `_hgw/agents/*` | `-32601` method not found, refused before its params are decoded.                                                                            |

`session/prompt` and `_hgw/session/steer` refuse, with `-32602`, text that
starts with `/` (after any leading whitespace or zero-width characters) and
text shaped like an invitation envelope. The text itself travels as written.

What a guest is shown:

- The conversation's text passes whole, under the runtime's ids. There are no
  inline size or count caps beyond the frame and queue limits every
  connection has; the REST byte caps still apply.
- Reasoning, tool input and output, terminals, compaction, the model, and
  subagent prose are dropped. A tool call that declares an MCP App reaches
  the guest as its card alone.
- Questions (`elicitation/create`) reach the guest unchanged, and the guest may
  answer them.
- Permission requests are never shown to a guest. One raised in a turn the
  guest started is declined for it: with `deny`, or `cancelled` when `deny` is
  not offered. One raised in another member's turn is hidden and left for the
  operator to answer.
- No feeds: no `usage_update`, no model readings, no `_hgw/activity`, no
  `session_info_update`, and no `_hgw/catalog_invalidated`.

Guest errors carry only a public code (`PUBLIC_ERRORS`,
`src/acp/validation.ts`): an error reply keeps its JSON-RPC code
with the code's public name as its message, and an `_hgw/error` notification
keeps only a public code. Any other failure reads `-31013`
`temporarily_unavailable`. In a batched reply each entry is redacted
independently; a successful entry in the same batch is unaffected.

## Session lifecycle methods

`session/new`, `session/list`, `session/resume`, `session/prompt`,
`session/cancel`, `session/close`, `session/delete`, `session/set_config_option`
(model → `category: "model"`, effort → `category: "thought_level"`).

`session/close` stops the Session's active work for every member and then
detaches this connection. `_hgw/session/part` (`HgwSessionPartRequestSchema`,
`protocol/acp.ts`) only detaches this connection; the Session's work and all other
members continue. `session/delete` of a Session not known to this connection
succeeds rather than returning not-found.

### Request `_meta.hgw` shapes

**`session/new`** request (`HgwSessionNewMetaSchema`, `protocol/acp.ts`): `{ agentId, title?, clientId? }`

`clientId` is an optional opaque id the client picks for this create. The
coordinator dedupes it: a retry with the same `clientId` returns the Session the
first create opened rather than creating a second one.

`session/new` and `session/resume` on the operator listener enforce a folder
rule: `cwd` must equal the Agent's folder exactly (folded on the string; `..`
and trailing separators are allowed, but a relative path is refused), or be
empty, which names the Agent's folder; the SDK client always sends it empty.
Any other `cwd` returns invalid params naming the folder; an Agent with no
folder returns unsupported. A non-empty `mcpServers` or `additionalDirectories`
also returns invalid params. The runtime never receives the client's `cwd`.
Every list row carries its Agent's folder. A list
with a `cwd` filter that matches no Agent's folder returns no rows. A list across
Agents skips, and logs, any Agent with no folder (`session.list.no_folder`) or an
unreadable one (`session.list.folder_read_failed`), and still lists every other
Agent's rows; a list on one Agent's address answers either as an error.
`session/delete` on the shared address for a Session this connection never
listed or resumed returns invalid params naming the per-Agent address; on an
Agent's address a Session that is already gone deletes successfully.

**`session/list`** request (`HgwSessionListMetaSchema`): `{ agentId? }`

**`session/resume`** request (`HgwSessionResumeMetaSchema`):

```json
{ "agentId?": "…", "after?": 0, "turnId?": "…" }
```

`agentId` is optional and used for deep links when the client knows the owning
Agent before listing. `after` is the last `sequence` the client observed for
`turnId`. An `after` beyond bounded replay, or a `turnId` that is no longer the
live turn, rebuilds the Session from history in the same resume.

`replayFrom` is absent (resume without replay), `{ type: "start" }`, or the
`_hgw/before` older-page variant described under
[Older history pages](#older-history-pages). As ACP asks of a receiver that
does not understand a cursor, the gateway rejects every other `replayFrom` type,
and an `_hgw/before` without a string `cursor`, with `-32602` invalid params
rather than guessing where to replay from.

**`session/prompt`** request (`HgwPromptMetaSchema`, `protocol/acp.ts`):
`{ rewindSourceId?, attachmentStageId?, clientId? }`. `clientId` becomes the
turn's `turnId`; a retry with the same `clientId` returns the first answer
unchanged. The response carries the minted user-message id as the top-level
`messageId` field (SDK 1.5.0 `PromptResponse`); the answer is sent only after
the runtime confirms it stored the prompt. Attachment content referenced by
`resource_link` blocks uses the `hgw-attachment:` URI scheme
(`HGW_ATTACHMENT_URI_SCHEME`, `protocol/acp.ts`).

### Response `_meta.hgw` shapes

**`session/new`** response: `{ sessionId }` as a top-level result field, with no
`_meta.hgw`. The Session row (`session_info_update`), capabilities
(`available_commands_update._meta.hgw.capabilities`), models, and usage arrive
as events after the answer.

**`session/resume`** response (`HgwSessionResumeResponseMetaSchema`, `protocol/acp.ts`):
`{ position?, history? }` in `_meta.hgw` — nothing else. `position` is
the turn and sequence the joined Session stands at; a later resume continues
from it. Session info (`session_info_update`), execution state (`state_update`),
capabilities (`available_commands_update._meta.hgw.capabilities`), models, and
usage arrive as events after the answer. When the journal cannot answer `after`
(`ReplayCursorLostError`, `core/channel.ts`), the gateway rebuilds the Session
from history as a `start` resume does: the retained messages arrive as standard
`session/update`s before the answer, the live turn follows them, and the answer
carries `history`. A resume that replayed carries `history`
(`HgwHistoryCursorSchema`): `{ nextCursor?, truncated? }`.

**`session_info_update`** `_meta.hgw` (`HgwSessionInfoMetaSchema`):
`{ agentId, status, archived, createdAt?, unread?, pinned? }`. `createdAt` is
the UTC ISO timestamp of when the Session was created, absent when the runtime
does not report it. `unread` and `pinned` are absent when the runtime does not
track that state or this read cannot know it; **absent never overwrites a known
value** in a client.

### Older history pages

A client that pages history advertises it in `initialize`'s
`clientCapabilities._meta.hgw.historyPages: true` (`HgwClientCapabilitiesMetaSchema`,
default `false`). To that client, a server that sets `extensions.historyPages`
(default `false`) replays only the newest page on a `start` resume and serves
older ones through
`session/resume` with the reserved variant (`HGW_REPLAY_BEFORE`,
`HgwReplayBeforeSchema`):

```json
{ "type": "_hgw/before", "cursor": "…", "_meta?": {} }
```

Any other client gets what ACP's `start` promises: every retained message,
read page by page on the server, with no `nextCursor` in the reply. The reply
still carries `truncated: true` when the reading stopped at a reach bound.

- `cursor` is the opaque `history.nextCursor` of an earlier resume, 1 to 256
  characters. The server picks the page size; offsets count back from the
  newest message, and pages break at turn starts.
- The page's messages arrive as `session/update`s before the response, each
  tagged `_meta.hgw.historyPage: { cursor }` (`HgwHistoryPageTagSchema`). The
  client keeps them out of the turn position and every live listener. A page
  never carries `plan_update`; the Todo plan and a restored failed turn come
  only with the newest page.
- The response carries only `_meta.hgw.history`
  (`HgwHistoryPageResponseMetaSchema`). A missing `nextCursor` means the
  beginning. `truncated: true` with no cursor means the gateway's bound stopped
  the reading, or the runtime's own reach did, and the thread says earlier
  messages can't be loaded.
- A page is read only for a Session this connection has resumed, whether by
  a resume, `session/new`, or a prompt, one at a time per Session. It never
  resumes, restates configuration or usage, or reports execution. A cursor that does not decode, or points past the
  history, is invalid params.
- An accepted rewind deletes the newest rows, so it marks the client's cursor
  stale and drops a page still loading; the next load resumes from `start`
  first. A resume rebuilt from history likewise returns the thread to the
  newest page.

## Run stream

Message ids are set where the message is born and are the same live and after a
reload. One prompt produces one turn: the state sequence is `running` →
`requires_action`? → `running`? → one `idle`. Stop (`session/cancel`) sends the
stop signal to the runtime; the turn continues until the runtime confirms it
ended.

On reconnect (session/resume with replay) a client with a pending prompt
receives history first, then buffered live events, then the current state, then
the stored prompt answer (if it arrived before the storage deadline).
Catch-up uses only standard ACP session updates; no `_hgw/session_invalidated`
or `_hgw/steer_accepted` is sent.

| ACP event                   | Meaning                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `agent_message_chunk`       | Streaming assistant prose                                                                                         |
| `agent_thought_chunk`       | Streaming reasoning                                                                                               |
| `tool_call_update`          | Tool lifecycle and argument deltas                                                                                |
| `state_update`              | Run state transitions                                                                                             |
| `plan_update`               | Session Todos in `_meta.hgw.todos`                                                                                |
| `usage_update`              | Context window usage                                                                                              |
| `session_info_update`       | Session metadata changes                                                                                          |
| `available_commands_update` | Slash commands and capabilities in `_meta.hgw.capabilities` (`HgwAvailableCommandsMetaSchema`, `protocol/acp.ts`) |
| `config_option_update`      | Current model and effort-level selection                                                                          |

`usage_update` carries the used and total token counts in its own fields, and
the provider's attribution and provenance in `_meta.hgw` (`source`,
`estimated`, `breakdown`). It is session-scoped rather than run-scoped: the
gateway sends one on `session/new`, on `session/resume`, after every settled turn,
and after a `session/set_config_option` that changes the model, because the
window grows with the conversation and its size belongs to the model. A provider
that cannot report usage sends none, and the last reading stands.

### Turn stream `_meta.hgw`

Every event emitted from a turn carries a base of
`{ sequence, turnId }` ().

| Event                                 | Extra `_meta.hgw` fields                                          |
| ------------------------------------- | ----------------------------------------------------------------- |
| `state_update`                        | `execution?: "stopping"`, `code?`, `message?` ()                  |
| `agent_message_chunk`/`thought_chunk` | (base only) — identical live and on replay (`HgwChunkMetaSchema`) |
| `tool_call_update`                    | `messageId`, `argsTextDelta?`, `argsText?` ()                     |
| `plan_update`                         | `sequence`, `turnId?`, `todos` ()                                 |
| `usage_update`                        | `source`, `estimated?`, `breakdown?` (); no sequence/turnId       |

Stop reasons `_hgw_error` and `_hgw_uncertain` appear in
`state_update { state: "idle" }` (`HGW_STOP_REASONS`). A
`state_update { state: "running" }` carrying `code` and `message` reports a
final failure on a run that stays active until it is stopped: a client shows
the failure and keeps Stop available, and the run's own idle update ends it.
A prompt the gateway accepted whose turn then fails to start reaches its sender
as a `running` update followed by an `_hgw_error` idle update for the same
`turnId`, carrying only a public `code`, never an `_hgw/error` notification.

## Extension methods (`_hgw/*`)

### Requests (client → server, expect a response)

| Method                | Purpose                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_hgw/session/update` | Set title, archived, or unread (exactly one intent per call; `protocol/acp.ts`)                                                                                                                      |
| `_hgw/session/part`   | Detach this connection from the Session; the Session's work and all other members continue (`HgwSessionPartRequestSchema`, `protocol/acp.ts`)                                                        |
| `_hgw/session/steer`  | Deliver a text correction to the active run                                                                                                                                                          |
| `_hgw/session/focus`  | Report the exposed Session and workspace presence; answered `{}`. An absent `sessionId` changes nothing — a client may send `{}` as its liveness probe. (`HgwFocusRequestSchema`, `protocol/acp.ts`) |
| `_hgw/agents/list`    | Fetch the agent catalog                                                                                                                                                                              |
| `_hgw/agents/update`  | Write visibility and/or avatar; compare-and-set on the observed revision (`HgwAgentUpdateRequestSchema`, `protocol/acp.ts`)                                                                          |

### Notifications (no response expected)

| Method                     | Direction     | Purpose                                                           |
| -------------------------- | ------------- | ----------------------------------------------------------------- |
| `_hgw/activity`            | server→client | Workspace-wide activity feed item (union type, `protocol/acp.ts`) |
| `_hgw/composer_prefill`    | server→client | Composer prefill text from a slash command                        |
| `_hgw/catalog_invalidated` | server→client | Agent catalog may have changed (no params)                        |
| `_hgw/error`               | server→client | Connection-level failure with no request to answer                |

#### `_hgw/activity` union ()

Every item carries `{ agentId, sessionId, occurredAt }` plus a discriminant `type`:

| `type`                | Extra fields                            |
| --------------------- | --------------------------------------- |
| `turn-started`        | `turnId`                                |
| `turn-finished`       | `turnId`                                |
| `turn-failed`         | `turnId`                                |
| `attention-requested` | `requestId`, `attentionKind: "question" | "permission"` |
| `attention-resolved`  | `requestId`                             |
| `unread-changed`      | `unread: boolean`                       |

## Artifacts

### present_artifact as an MCP App

`present_artifact` is an ordinary MCP App tool call on the wire. Its view
(`ui://aos-ui/artifact` by default, configurable) reads the file through the
file addresses the gateway grants when the view opens (see
[HTTP API](#http-api)); the tool's MCP server never opens the file.

### MEDIA: and trusted-delivery Artifacts

An Artifact from a `MEDIA:` line or a trusted native delivery receipt (such as
Hermes text-to-speech) reaches a client as an ACP `resource_link` content
block inside the turn's `agent_message_chunk` (or `user_message_chunk`), both
live and on replay (`src/acp/translate/updates.ts`):

```json
{
  "type": "resource_link",
  "uri": "artifact://ARTIFACT_ID",
  "name": "report.pdf",
  "mimeType": "application/pdf",
  "size": 48213
}
```

`uri` carries only the opaque, URI-encoded artifact id
(`HGW_ARTIFACT_URI_SCHEME`, `formatArtifactUri`, and `parseArtifactUri`,
); it never carries a native path or a route.
`mimeType` and `size` appear only when the publishing tool reported them. The
gateway-side descriptor behind it is `HgwArtifactDescriptorSchema`, whose
`source` never reaches a client.

A client fetches the bytes from the artifact route of the Session it is
viewing: `GET /api/v1/agents/:agentId/sessions/:sessionId/artifacts/:artifactId`
on its own listener, a guest with its invitation token as a Bearer
`Authorization` header. The gateway resolves the id only against that Session's
own provider history.

## Interactions: permission and elicitation

ACP delivers pending interactions as `session/request_permission` or
`elicitation/create`. The `_meta.hgw` extensions carried on these are
():

**Permission** (`HgwPermissionMetaSchema`):
`{ requestId, expiresAt?, message? }`.
The vendor permission kind `_allow_session` (`HGW_PERMISSION_KIND_SESSION`,
) represents Hermes' "allow for this session" scope.

A permission names the call it guards in `subject.toolCall` when the adapter
knows it: OpenCode from the native `source.callID`, Hermes from the one tool
still running when the approval arrives. OpenClaw approvals name no call. The
SDK client (`acp-approvals.ts`) holds each request for the connection's
lifetime. A request still pending when a client reconnects is sent again.

**Elicitation** (`HgwElicitationMetaSchema`):
`{ requestId, expiresAt?, questions[] }`. Each question carries
`{ id?, header, prompt, options[], multiple?, custom? }`. A multi-select
question must declare `items.enum` in the ACP property schema
(`src/acp/translate/requests.ts`); a free-text answer
remains valid because the response schema does not constrain values to the enum.

## JSON-RPC error codes

Every error ACP defines travels with ACP's own code, built by the SDK. The `hgw`
block covers only the failures ACP has no code for (`HGW_JSONRPC_ERRORS`,
`protocol/acp.ts`):

**ACP standard codes:**

| Code     | SDK constructor      | Meaning                                              |
| -------- | -------------------- | ---------------------------------------------------- |
| `-32000` | `authRequired()`     | Authentication required (guest: no valid invitation) |
| `-32002` | `resourceNotFound()` | Agent or Session does not exist                      |
| `-32601` | `methodNotFound()`   | Method not recognized                                |
| `-32602` | `invalidParams()`    | Request parameters failed validation                 |
| `-32800` | `requestCancelled()` | Request timed out or the transport closed            |

**Gateway codes (`HGW_JSONRPC_ERRORS`, block from -31010):**

| Code     | Name                     | Meaning                                                     |
| -------- | ------------------------ | ----------------------------------------------------------- |
| `-31010` | `turnInProgress`         | Cannot send while a turn is active                          |
| `-31011` | `staleRequest`           | Request ID no longer valid                                  |
| `-31012` | `revisionConflict`       | Observed Agent revision or source message no longer current |
| `-31013` | `temporarilyUnavailable` | Runtime not reachable; retry later                          |
| `-31014` | `uncertainMutation`      | Mutation dispatched but outcome unknown                     |
| `-31015` | `unsupported`            | Runtime cannot store a requested Agent field                |

Codes `-32001` through `-32009` are no longer used.

The machine name an error travels as — the `message` of a public reply, and the
`code` field of an `_hgw/error` notification (`HgwErrorNotificationSchema`,
`protocol/acp.ts`) — is keyed by its numeric code:

| Code     | Machine name              |
| -------- | ------------------------- |
| `-32000` | `authentication_required` |
| `-32002` | `not_found`               |
| `-32601` | `method_not_found`        |
| `-32602` | `invalid_request`         |
| `-32800` | `request_cancelled`       |
| `-31010` | `turn_in_progress`        |
| `-31011` | `stale_request`           |
| `-31012` | `revision_conflict`       |
| `-31013` | `temporarily_unavailable` |
| `-31014` | `uncertain_mutation`      |
| `-31015` | `unsupported`             |
| (other)  | `internal_error`          |

## HTTP API

Both listeners answer below `/api/v1` (`HGW_API_PREFIX`) and nothing else:
any other path is 404. A guest request authenticates with its invitation token
as a Bearer `Authorization` header and reaches only its invited Agent and
Session.

| Method   | Path                                                                | Listener | Purpose                                                     |
| -------- | ------------------------------------------------------------------- | -------- | ----------------------------------------------------------- |
| `GET`    | `/api/v1/healthz`                                                   | operator | Liveness probe (always 200; body `{status, links, gauges}`) |
| `GET`    | `/api/v1/readyz`                                                    | operator | Readiness probe                                             |
| `GET`    | `/api/v1/runtime`                                                   | both     | Runtime discovery; each listener answers its own shape      |
| `POST`   | `/api/v1/agents/:agentId/sessions/:sessionId/attachments/stage`     | both     | Stage an attachment                                         |
| `GET`    | `/api/v1/agents/:agentId/sessions/:sessionId/artifacts/:artifactId` | both     | Download an Artifact                                        |
| `POST`   | `/api/v1/agents/:agentId/audio/transcribe`                          | both     | Audio → text                                                |
| `POST`   | `/api/v1/agents/:agentId/audio/speak`                               | both     | Text → audio                                                |
| `POST`   | `/api/v1/guest-invitations`                                         | operator | Issue a guest invitation                                    |
| `GET`    | `/api/v1/push`                                                      | operator | Web Push configuration                                      |
| `PUT`    | `/api/v1/push/subscriptions`                                        | operator | Register a push subscription                                |
| `DELETE` | `/api/v1/push/subscriptions`                                        | operator | Remove a push subscription                                  |

On the guest listener the operator-only routes answer 404.

MCP App views sit below a Session, at
`/api/v1/agents/:agentId/sessions/:sessionId/tool-calls/:toolCallId/app` for a
tool call's view and `…/artifacts/:artifactId/app` for a published Artifact's:

| Method | Path below the view       | Purpose                                                          |
| ------ | ------------------------- | ---------------------------------------------------------------- |
| `GET`  | (the view itself)         | Open the view: its resource, CSP domains and file addresses      |
| `POST` | `/tools/call`             | A tool call's view calls its own server's tools                  |
| `POST` | `/resources/read`         | Read one of the view server's `ui://` resources                  |
| `POST` | `/files`                  | Renew the view's file addresses                                  |
| `GET`  | `/files/:argument?pass=…` | Read the file an argument names, with the pass its address holds |

## Client modules

`client/` is the SDK's browser client, exported from `@harness-gw/sdk`:

- `connection.ts`: `createAcpConnection`, one socket carrying every Session
- `acp-workspace-client.ts`, `acp-workspace-client-sessions.ts`,
  `acp-workspace-client-composer.ts`: the workspace client over ACP
- `acp-approvals.ts`: pending permission requests
- `acp-interactions.ts`: elicitation → questions
- `hgw-client.ts`, `hgw-notification.ts`: the HTTP API and `_hgw/*`
  notifications
- `types.ts`, `workspace.ts`: the client's own types
