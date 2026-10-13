# The harness-gw protocol

harness-gw puts one independently operated agent runtime (Hermes, OpenClaw or
OpenCode) behind ACP v2 over WebSocket, plus a small HTTP API for bytes and
discovery. Clients speak standard ACP; what ACP has no method or field for
travels in the gateway's own extension namespace, `hgw`:

- methods and notifications named `_hgw/*`;
- `_meta.hgw` on requests, responses and notifications;
- the `replayFrom` cursors `_hgw/position` and `_hgw/before`;
- the auth method `hgw-invite`;
- the attachment URI scheme `hgw-attachment:`.

Every shape below is defined once, in `protocol/acp.ts`, and ships as
`@harness-gw/sdk/protocol`; the browser client at the package root speaks it.
Native runtimes keep their own transports behind the gateway (`src/adapters/`);
`src/acp/` translates the gateway's turn vocabulary to ACP.

## Version

`initialize` answers ACP's `protocolVersion: 2` and, in its top-level
`_meta.hgw.version`, the version of this extension (`HGW_EXTENSION_VERSION`,
now `2`). A breaking change to anything in this document raises it; an
addition (a new method, notification, field or extension flag a client may
ignore) does not. A client that speaks another version must refuse the
connection rather than guess: the SDK client fails `initialized` with an error
naming both versions and closes without reconnecting, since a retry cannot
change the gateway's version.

The extension version covers the ACP wire only. A Web Push message carries
its own `v` (see [Web Push payload](#web-push-payload)), because a service
worker reads it long after any connection has closed.

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
  an `Origin` on that list when it carries one; a `null` or foreign one gets 403. A request with no `Origin` comes from no browser page, so it is
  admitted: a script or a non-browser ACP client needs no `Origin`.
- a GET or HEAD is never checked, so a view in an opaque-origin frame can read
  the file its pass names.
- CORS answers listed origins only (`Access-Control-Allow-Origin` with
  `Vary: Origin`), never with credentials; a preflight from any other origin
  gets 403.

The response carries an `Acp-Connection-Id` header. A client sends
`initialize` and receives capabilities in `_meta.hgw`. On reconnect, send
`initialize` again and then `session/resume` with the `_hgw/position` cursor
naming the first sequence not yet observed. When the cursor is beyond bounded
replay, the same resume rebuilds the Session from history, as described under
[Response `_meta.hgw` shapes](#response-_metahgw-shapes).

The SDK client reconnects with jittered backoff starting at 250 ms, capped at
5 000 ms, and resetting once every resumed Session has rejoined or the link has
been stable for a while. A guest connection re-sends `auth/login` after every
transport recovery before resuming sessions. A read (`_hgw/agents/list`,
`session/list`, `_hgw/sessions/search`) that its transport closes under, or
that is made while the client reconnects, goes out again once a transport has
recovered. A history page, prompt, config write or steer for an opened Session
goes out again once that Session has rejoined, a prompt with the same client
id. Any other request its transport closes under fails as
`AcpConnectionClosedError`, as does every request once the connection has
ended; a request's own deadline still fails it.

Close codes the gateway sends:

| Code   | Meaning                                                                                                                                            | Client action                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `1008` | Policy violation (expired credential, rate or frame size exceeded, or another protocol limit the ACP SDK enforces)                                 | No reconnect; ends connection |
| `1013` | Gateway at capacity                                                                                                                                | Backs off 30–60 s with jitter |
| `4408` | Handshake unfinished: `initialize` (and a guest's sign-in) not done within 15 s, or the oldest such socket closed past the listener's budget of 32 | Normal reconnect              |
| `4409` | Reader fell behind: the client read none of a full output buffer (8 MiB) for 60 s, or its waiting requests passed that buffer                       | Normal reconnect              |

Any other code triggers a normal reconnect.

A frame over `HGW_MAX_FRAME_BYTES` (1 100 000 bytes) is closed by the server
itself before the gateway reads it, so the client never sends one: it refuses
an oversized prompt or steer locally with `requestTooLarge`.

## Handshake: `initialize` and `auth/login`

`initialize` always answers `protocolVersion: 2`, whatever the client
requested; this is ACP's version-negotiation rule, not v1 support.

The `initialize` response's `_meta.hgw` (`HgwInitializeMetaSchema`):

```json
{
  "version": 2,
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

A guest connection reaches nothing but `initialize`, `auth/login` and
`auth/logout` until it redeems an invitation (`src/guest/acp.ts`). Its
`initialize` omits the runtime's title and advertises only the `hgw-invite`
auth method. A connection acts as one invitation at a time: a second
`auth/login` while one is redeemed is refused with `-32000`.

`auth/logout` answers `{}` and keeps the connection open. The guest leaves its
Sessions: nothing more of them reaches it, the questions it was asked are
withdrawn, and an answer that arrives after is dropped. Every later gated
request answers `-32000` until an `auth/login`, which may redeem another
invitation; that connection then acts for it alone. A command still held when
the logout came, a login still verifying among them, acts for nobody. A logout
that ended a login puts the socket back in its handshake: the 15 s deadline
starts again, and the socket counts toward the listener's budget of 32. A
logout that ended nothing extends neither. Logout ends the connection's use of
the invitation; it does not revoke it. The operator listener authenticates its
upgrade instead, so it answers `auth/logout` with `-32601`.

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
usage unavailable, and steering and rewind as the runtime reports them.

Every method runs as a member command through the guest middleware stack in
`src/guest/middleware/` (commands, scope, history, turns,
permissions; events pass back through it in reverse). The guest addresses the
invited conversation by its reference alone; any other Session id is
`-32002`.

| Method                                                                                                                                       | Guest behavior                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/resume`                                                                                                                             | The invited conversation only. A fresh invitation with no Session yet answers idle with nothing to replay.                                   |
| `session/prompt`                                                                                                                             | Sends; the first Send creates the invited Session. Edit and Retry (`rewindSourceId`) may name only a user message this connection was shown, and a Retry, which resends its source as written, may not name one whose text the guest could not send. They rewind as an operator's do. |
| `_hgw/session/steer`                                                                                                                         | Steers the invited conversation's active turn.                                                                                               |
| `session/cancel`                                                                                                                             | Stops a turn in the invited conversation only.                                                                                               |
| `session/close`                                                                                                                              | Stops the Session's active work for every member, then detaches.                                                                             |
| `_hgw/session/focus`                                                                                                                         | Accepted, answered `{}`, and ignored: read state is the operator's.                                                                          |
| `auth/logout` | Leaves the invited conversation and keeps the connection open for another `auth/login`; see [Guest listener](#guest-listener). |
| `session/new`, `session/list`, `session/delete`, `session/fork`, `session/set_config_option`, `_hgw/session/update`, `_hgw/sessions/search`, `_hgw/agents/*` | `-32601` method not found, refused before its params are decoded: ACP's code for a method that "does not exist or is not available", which these are to a guest, though the session capability promises `session/new` and `session/list`. |

`session/prompt` and `_hgw/session/steer` refuse, with `-32602`, text that
starts with `/` (after any leading whitespace or zero-width characters) and
text shaped like an invitation envelope. The text itself travels as written.

What a guest is shown:

- The conversation's text passes whole, under the runtime's ids. There are no
  inline size or count caps beyond the frame and queue limits every
  connection has; the REST byte caps still apply.
- Reasoning, tool input and output, terminals, compaction, the model, and
  child Sessions are dropped. A tool call that declares an MCP App reaches
  the guest as its card; when its server is in `guest.appServers` (default
  `aos-ui`), its result passes whole too, as the guest's own view route would
  hand it. Arguments never pass, since they may name host paths.
- A published Artifact the provider holds reaches the guest by its id alone,
  live and in a replay alike; inline Artifact data never does.
- Questions (`elicitation/create`) reach the guest whole, and the guest may
  answer them. A question names its tool call only when the guest was shown
  that call.
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
Any other `cwd` returns invalid params naming the folder, and so does any `cwd`
for an Agent with no folder. A non-empty `mcpServers` or `additionalDirectories`
also returns invalid params. The runtime never receives the client's `cwd`.
Every list row carries its Agent's folder. A list
with a `cwd` filter that matches no Agent's folder returns no rows. A list across
Agents skips, and logs, any Agent with no folder (`session.list.no_folder`) or an
unreadable one (`session.list.folder_read_failed`), and still lists every other
Agent's rows; a list on one Agent's address answers either as an error.
`session/delete` on the shared address for a Session this connection never
listed or resumed returns invalid params naming the per-Agent address; on an
Agent's address a Session that is already gone deletes successfully.

**`session/fork`** (operator listener only): answers `{ sessionId }` of a new
Session holding the conversation so far, and joins the connection to it as
`session/new` joins its creator; the original Session is left as it is. It
follows `session/new`'s `cwd`, `mcpServers` and `additionalDirectories` rules,
and a Session the connection was not told about answers `-32002`. `initialize`
advertises `capabilities.session.fork` only where the runtime forks, and a fork
elsewhere answers `-32601`. A guest is never offered it.

**`session/list`** request (`HgwSessionListMetaSchema`): `{ agentId? }`

**`session/resume`** request (`HgwSessionResumeMetaSchema`):

```json
{ "agentId?": "…" }
```

`agentId` is optional and used for deep links when the client knows the owning
Agent before listing. A position in `_meta.hgw` (version 1's `after` and
`turnId`) answers `-32602` invalid params.

`replayFrom` is one of:

- absent: nothing is replayed, as ACP asks. The view follows the live turn from
  its next event, and is never rebuilt from history.
- `{ type: "start" }`: the whole Session is replayed.
- `{ type: "_hgw/position", turnId?, from? }` (`HGW_REPLAY_POSITION`,
  `HgwReplayPositionSchema`): the reconnect cursor. `from` is the first
  `sequence` of `turnId` the client still needs, inclusive as every ACP cursor
  is. A `from` beyond bounded replay, or a `turnId` that is no longer the live
  turn, rebuilds the Session from history in the same resume. With neither
  field, the live turn replays from its first event, or the Session is rebuilt
  from history when the journal no longer holds that.
- the `_hgw/before` older-page variant described under
  [Older history pages](#older-history-pages).

As ACP asks of a receiver that does not understand a cursor, the gateway
rejects every other `replayFrom` type, and an `_hgw/before` without a string
`cursor`, with `-32602` invalid params rather than guessing where to replay
from.

**`session/prompt`** request (`HgwPromptMetaSchema`, `protocol/acp.ts`):
`{ rewindSourceId?, attachmentStageId?, clientId? }`. `rewindSourceId` names
the user message an Edit or Retry replaces; a Session offers it only where its
capabilities report `interactions.rewind` available, since what a rewind undoes
with the turns, such as restored files, is the runtime's. `clientId` becomes the
turn's `turnId`; a retry with the same `clientId` returns the first answer
unchanged. The response carries the minted user-message id as the top-level
`messageId` field (SDK 1.5.0 `PromptResponse`). As ACP reads an error answer
as a prompt never inserted, the answer waits for the runtime's storage receipt
and names the id it stored the prompt under. A prompt the runtime may have
stored without proving it, because its receipt outlasted the admission
deadline, its turn ended first, or its start went unanswered, is answered
under the id the gateway minted. An unanswered start then reports the
`unknown` state until a recover confirms the turn or its deadline ends it.
Only a turn its adapter knows stored nothing is answered with an error.
A `$/cancel_request` for the prompt answers `-32800` only while the start has
not reached the runtime. From then on the prompt may stand, so its answer
follows the rules above, and only `session/cancel` stops its turn.
Attachment content referenced by
`resource_link` blocks uses the `hgw-attachment:` URI scheme
(`HGW_ATTACHMENT_URI_SCHEME`, `protocol/acp.ts`).

A prompt carries `text` and `resource_link` blocks. The gateway advertises no
prompt capability, so an `image`, `audio` or `resource` block answers `-32602`
invalid params. A block of a type ACP has not defined, an `_`-prefixed extension
or a later variant, is skipped and the rest of the prompt is sent.

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
usage arrive as events after the answer. When the journal cannot answer `from`
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

A compaction the provider stored replays as the completed `compaction_update`
its live turn showed, under the same `compactionId`, with the summary where the
provider keeps one (OpenCode does; Hermes does not). History carries it as an
`{ role: "activity", activityType: "COMPACTION" }` row
(`SessionCompactionActivityMessageSchema`, `protocol/index.ts`). A resume while
the turn still runs shows that compaction once, from the turn's replay. A guest
is shown no compaction, live or in history: of the Session's activity, its
history passes the plan alone.

| ACP event                   | Meaning                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `agent_message_chunk`       | Streaming assistant prose                                                                                         |
| `agent_thought_chunk`       | Streaming reasoning                                                                                               |
| `tool_call_update`          | Tool lifecycle and argument deltas                                                                                |
| `state_update`              | Run state transitions                                                                                             |
| `plan_update`               | Session Todos in `_meta.hgw.todos`                                                                                |
| `compaction_update`         | The provider compacted the conversation's context, with its summary once completed where the provider keeps one  |
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

A failed turn ends with ACP's `state_update { state: "idle", stopReason:
"error" }`. Its `error` is the public error: `-32603` and, as its `message`,
the failure's machine code (`internal_error` for a stored failure that kept
none). The provider's own words travel only as `_meta.hgw.message`, beside the
same `code`.

A turn the gateway can no longer observe, after a lost connection or an
uncertain send, Stop or answer, reports ACP's `state_update { state: "unknown"
}` with its `code`. It is not an outcome: a recover that confirms the turn
streams it on, and a turn none confirms by the uncertainty deadline ends with
`error` and the code `HGW_OUTCOME_UNKNOWN`. A prompt sent meanwhile answers
`-31010` turn in progress.

A `state_update { state: "requires_action" }` carrying `code` and `message`
reports a final failure on a run that stays active until it is stopped: a
client shows the failure and keeps Stop available, and the run's own idle
update ends it. A prompt the gateway accepted whose turn then fails to start
reaches its sender as a `running` update followed by an `error` idle update for
the same `turnId`, carrying only a public `code`, never an `_hgw/error`
notification.

## Extension methods (`_hgw/*`)

### Requests (client → server, expect a response)

| Method                 | Purpose                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_hgw/session/update`  | Set title, archived, or unread (exactly one intent per call; `protocol/acp.ts`)                                                                                                                      |
| `_hgw/session/part`    | Detach this connection from the Session; the Session's work and all other members continue (`HgwSessionPartRequestSchema`, `protocol/acp.ts`)                                                        |
| `_hgw/session/steer`   | Deliver a text correction to the active run                                                                                                                                                          |
| `_hgw/session/focus`   | Report the exposed Session and workspace presence; answered `{}`. An absent `sessionId` changes nothing — a client may send `{}` as its liveness probe. (`HgwFocusRequestSchema`, `protocol/acp.ts`) |
| `_hgw/sessions/search` | Find Sessions matching a query; see [Session search](#session-search) (`HgwSessionSearchMetaSchema`, `protocol/acp.ts`)                                                                              |
| `_hgw/agents/list`     | Fetch the agent catalog                                                                                                                                                                              |
| `_hgw/agents/update`   | Write visibility, avatar and/or `muted`; compare-and-set on the observed revision (`HgwAgentUpdateRequestSchema`, `protocol/acp.ts`)                                                                 |

#### Session search

`_hgw/sessions/search` is operator-only; the guest listener refuses it as
method not found. The request carries `_meta.hgw` `{ agentId?, query }`
(`HgwSessionSearchMetaSchema`): `query` is 1 to 512 characters, and an absent
`agentId` searches every Agent. The response is `{ sessions }`
(`HgwSessionSearchResponseSchema`): at most 100 `session/list` entries, newest
first, each carrying its Agent's folder and the same `_meta.hgw` a list row
carries, with no cursor. Like a list across Agents, it leaves out a Session
whose Agent has no folder.

```json
{ "_meta": { "hgw": { "agentId": "researcher", "query": "release" } } }
```

Hermes answers from its own search, which matches Session ids and message
content; its rows carry no read state, so a Session's known `unread` stands.
Every other runtime matches titles, ignoring case: OpenCode over its own
Sessions, and OpenClaw over the first 1000 Sessions the list serves.

#### Agent updates and mute

`_hgw/agents/update` takes `{ agentId, revision }` and at least one of
`visibility`, `avatar` (`null` clears it) and `muted` (`AgentUpdateFields`,
`protocol/index.ts`); any field alone is a valid update. `muted: true` mutes
the Agent's Web Push notifications and `muted: false` unmutes them. A runtime
that cannot store a field it is sent refuses the whole update with `-32602`
invalid params rather than writing the rest; the SDK client reads that as an
`AgentUpdateError` with the code `unsupported`.

Every `_hgw/agents/list` entry carries `muteEditable`, whether the runtime can
store a mute for that Agent, beside `editable` and `avatarEditable`. Its
`summary` carries `muted: true` while the Agent is muted, and no `muted` key
when it is not. Only Hermes stores a mute; see
[the runtime notes](runtimes/hermes.md#agent-icons-and-mute).

A successful update tells every operator connection
`_hgw/catalog_invalidated`, and push delivery applies it from the next
notification (see [Web Push payload](#web-push-payload)).

### Notifications (no response expected)

| Method                     | Direction     | Purpose                                                           |
| -------------------------- | ------------- | ----------------------------------------------------------------- |
| `_hgw/activity`            | server→client | Workspace-wide activity feed item (union type, `protocol/acp.ts`) |
| `_hgw/composer_prefill`    | server→client | Composer prefill text from a slash command                        |
| `_hgw/catalog_invalidated` | server→client | Agent catalog may have changed (no params)                        |
| `_hgw/error`               | server→client | Connection-level failure with no request to answer                |

#### `_hgw/activity` union ()

Every item carries `{ agentId, sessionId, occurredAt }` plus a discriminant
`type`. An item the gateway re-sends on connect, from the Session list and the
coordinator's snapshots, also carries `replayed: true` and the row's own time
as `occurredAt`; a live item carries no `replayed`.

| `type`                | Extra fields                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `turn-started`        | `turnId`                                                                                        |
| `turn-finished`       | `turnId`                                                                                        |
| `turn-failed`         | `turnId`                                                                                        |
| `attention-requested` | `requestId`, `attentionKind: "question" \| "permission"`, optional `requestText`, `requestMore` |
| `attention-resolved`  | `requestId`                                                                                     |
| `unread-changed`      | `unread: boolean`                                                                               |

`requestText` is one line of what the request asks: a permission's operation
or message, or an elicitation's first question. It is stripped of
bidirectional controls, collapsed to single spaces, masked (see
[Credential masking](#credential-masking)), and cut to 200 UTF-16 units
ending in `…`. `requestMore` counts the questions after the first. Both are
absent when there is nothing to show. The ask card itself, the
`session/request_permission` or `session/elicitation` request, keeps the full
text as written, line breaks included.

#### Credential masking

The gateway masks a credential as `[credential redacted]`, and only its value:
a name, the value's quotes, a `Basic` or `Bearer` word, a URL's scheme, user
and host, and a value that only names a secret (one that starts with `$`, `<`
or `{`, such as `$TOKEN`) stay. One masker (`maskCredentials` in
`src/redaction.ts`) does it everywhere it is done.

| Where                                                                 | Masked                                                                                                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A tool call, live and replayed, on both listeners, for every runtime  | its title, arguments, result, content, streamed output, and its terminal's command and output                                                        |
| A child Session, live and replayed                                    | its title, description and summary, and its own tool calls and failures as a turn's are                                                              |
| A failed turn, live and replayed                                      | its message                                                                                                                                          |
| A question a guest is shown                                           | its prompt, header, and choices; a guest's answer reaches the runtime as the choice it wrote, and an answer echoed back to a guest is masked        |
| `requestText` in `_hgw/activity`, and every Web Push text             | the one line it shows                                                                                                                                |
| An MCP App view                                                       | its tool input and result                                                                                                                            |

The ask card is not masked: a question and a permission reach the operator as
the runtime wrote them, since the one asked must read exactly what they answer
or approve, and the answers the operator gave are echoed as given. The call of
the tool that asked (canonical name `question`, Hermes's `clarify`) is part of
the question, so it reaches the operator as written too, live and replayed. A
guest never sees a permission. The credentials middleware
(`src/core/credentials-middleware.ts`), the innermost layer of every member's
stack, masks what passes a member; Activity and Web Push, which leave the
conversation, and the MCP App view route, which no member's stack carries,
call the same masker.

Text is masked; a path or a patch that carries a credential is dropped rather
than masked, since masked it would name no file or no longer apply: a
location, a diff that names one, a terminal's working directory, and a file a
child Session read or wrote.

A name is secret when a run of up to three of its words spells a word of
`SECRET_TERMS` (`src/redaction.ts`), or when its letters end in one. Its words
split at a change of case and at any character that is not a letter or a
digit, so `api_key`, `apiKey` and `API-KEY` read alike: `DB_PASSWORD`,
`DB_PASSWORD_PROD`, `x-api-key`, `password_hash`, `token_type` and
`PGPASSWORD` are secret. A safe name covers the terms inside it, so
`token_count`, `input_token_count`, `token_limit`, `token_usage`,
`auth_mode`, `authorization_mode`, `oauth`, `secretary`, `bypass` and
`access_key_rotation` are not; `npm_config_userconfig` is, though no word of
it is a term. A flag's leading `-` are not part of its name (`--token=`). One
rule reads every name: a name text assigns, a JSON key, and a logged field.

The masker takes:

- the value a secret name is given with `=` or `:` and any spacing on its
  line (so a YAML parent's value is never its child's name): a quoted value
  inside its quotes, any other up to whitespace, `,` or `;`, or up to a
  closing quote before one; a `Basic` or `Bearer` word before the value stays;
- after `Basic` or `Bearer`, a bearer token: at least 8 characters of
  `[A-Za-z0-9._~+/-]` whose last may also be `=` and is never `.`, that mixes
  at least two of upper case, lower case, digits and symbols, counted with its
  first letter's case ignored; so `Basic authentication` and `Enable Basic
  Authentication?` stay;
- a provider key by its prefix: `ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `sk-`,
  `xoxb-`, `xoxa-`, `xoxp-`, `xoxr-` or `xoxs-` and the word characters and
  `-` after it;
- a PEM private key, whole, from its `BEGIN … PRIVATE KEY` line through its
  body to its `END` line; one cut short, through its last body line. A header
  with no body is no key and stays;
- a JWT (`eyJ…` in three dot-separated parts);
- a URL's password: in `scheme://user:password@host`, a password with no
  whitespace and none of ``: / @ $ ( ) { } ` ' "``;
- then, every provider key
  [`@sanity-labs/secret-scan`](https://github.com/sanity-labs/secret-scan)
  knows by its shape, whole, its rules taken from TruffleHog's detectors. A
  match that is a URL or a URL's scheme stays, because the scanner's database
  rules take the whole URL or only its scheme. The scanner reads text in
  pieces of at most 2,048 characters that end at a line's end when one is in
  reach, so its work stays in proportion to the text; a key that straddles
  two pieces is left to the rules above.

A value already `[credential redacted]` is never masked again, so masking text
twice leaves one placeholder per credential.

Tool data is JSON-aware: a JSON value, and text that parses as one, is masked
by key and by value, a secret-named key keeping its name and losing any value
but a boolean or `null`; JSON with nothing to mask is sent as written, and
streamed output is masked as plain text, never re-encoded. A terminal's output
keeps its last 262,144 UTF-16 units, the most a browser keeps of one, without
the word the cut lands in; nothing else is cut. Each turn event is masked
once, however many members are shown it. An MCP App view's files are served from
the stored call, never from its masked input.

Masking finds a credential by its name, URL position, or known shape. One with
none of these is sent as written, and a credential split across two streamed
pieces of output is masked piece by piece.

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

### Stored user images

A user image the provider stored inline in its transcript replays as an
Artifact `resource_link` on its `user_message_chunk`, never as an ACP `image`
block, so no image's bytes travel on the shared socket
(`src/core/history-image-artifacts.ts`). The images are a Hermes `image_url`
part or an OpenCode prompt file, stored as a `data:` URL.

- **Id:** `hgw-image-` and 32 hex characters of a SHA-256 over the provider
  Session id, the data URL, and the part's place in its message.
- **Name and type:** `name` is the part's own filename or `image.<ext>`.
  `mimeType` appears only for PNG, JPEG, GIF, WebP, and BMP.
- **Reading:** a client reads the bytes from the same Artifact route. The
  gateway re-reads the history page that showed the image, or the newest four
  pages when it has not placed the id. It answers 404 `not_found` for an image
  none of them holds.
- **Hermes:** a row that also carries the image's `@image:` directive replays
  that directive's Artifact instead.
- **Size:** a stored history image may be up to 35,000,000 characters as a
  data URL, the same cap as a staged attachment.

On the guest listener, Artifact reads share a per-invitation budget of 16 in
flight and 600 per 10 minutes, on every guest path that reads an Artifact.
Past it, the route answers 503 `turn_capacity_exceeded`.

## Child Sessions

A subagent a turn spawns is an ACP v2 child Session. The parent announces each
child with `subagent_update` on its own Session before any traffic of the
child's: the outer `sessionId` is the parent, `update.sessionId` the child.
Later reports patch it.

- `title` and `description` are the runtime's display text for the child, and
  `state` mirrors its work: `running`, `requires_action`, or `idle` with
  `end_turn`, `cancelled` or `error`.
- A child still at work when its parent's turn ends is background activity,
  as ACP's idle state allows: the parent goes idle and takes prompts, and the
  child's reports, updates and requests keep arriving under its id between
  turns. Each carries the `_meta.hgw` of the turn that spawned it, with
  `background: true`, so no reader takes it as a position in that turn's
  stream; its requests are answered, and its `cancel` honored, without any
  turn. A child nobody watches past its turn, or one its runtime cannot
  follow, is reported `unknown`, with `capabilities` `{}`.
- `capabilities` is `{ cancel: {} }` only where the runtime stops the child
  alone, and `{}` otherwise; ACP replaces it whole.
- `_meta.hgw` (`HgwChildSessionMetaSchema`, `protocol/acp.ts`) carries what ACP
  has no field for: `toolCallId`, the parent's call that spawned the child, and
  the child's `model`, `filesRead`, `filesWritten`, `durationMs` and `summary`.

The child's own updates arrive under its id on the same connection, numbered
in the parent turn's sequence, and its tokens in its own idle usage. Its
approvals and questions are asked with the child's `sessionId`, and an answer
settles the parent turn's wait. A Hermes child asks a client nothing: it has
no question callback, Hermes decides its approvals by its own
`delegation.subagent_auto_approve` setting, and a sudo or secret prompt is one
the gateway holds unrendered for every Session. `session/cancel` naming the child stops its
work, where `cancel` is offered, through the Session that owns it; any other
cancel naming one does nothing. Every other request naming a child answers
`-32601`: a child permits a client nothing its capabilities do not name. A
child id is never a top-level Session's, and nothing of a child is shown
before its announcement.

A child's events share the parent turn's journal and sequence, so a
positioned resume replays them with the parent's, a child that finished during
the gap included. A reconnect is a new connection that knows no child, so the
resume first announces again, merged, each child the turn reported up to the
cursor. History stores a child as an `{ role: "activity", activityType:
"CHILD_SESSION" }` row (`SessionChildActivityMessageSchema`,
`protocol/index.ts`). A from-start replay or a rebuild announces it in its
final state, then sends the child's whole transcript under its id, where the
runtime keeps one (`ServerRuntime.childHistory`); a child's transcript is never
paged. A resume while the turn runs leaves its children to the turn's replay.

A guest is shown nothing of a child: no announcement, event, question,
approval, stored row or transcript. A child's approval or question in a turn
the guest started waits for an operator, who sees it on the child. Child reports and events pass the
credentials middleware like any turn's tool data, and a child's question tool
call reaches the operator as written, as its parent's does.

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
`{ requestId, expiresAt?, questions[] }`. A question is scoped to its Session,
plus the `toolCallId` that asked it when the adapter knows the call. It never
uses ACP's request scope, which names a JSON-RPC request outside any Session,
so its id rides only in `_meta.hgw.requestId`. Each question carries
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
| `-32601` | `methodNotFound()`   | Method does not exist, or is not available here      |
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
| `-31016` | `requestTooLarge`        | Params too large for one frame (`HGW_MAX_FRAME_BYTES`)      |

`requestTooLarge` is raised by the client before a prompt or steer is sent,
so one oversized request fails alone instead of closing the shared socket. The
gateway never sends it, and it has no machine name below.

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

### Web Push payload

A configured deployment sends one Web Push message per Session when a
notification window closes: input after 3 s, a failure after 5 s, a finished
turn after 20 s. Nothing is sent while the operator is at the workspace, and a
Session on screen, or read after its event, is left out. The decrypted payload
is JSON matching `PushMessageSchema` (`protocol/push.ts`):

| Field          | Type                                   | Presence                      |
| -------------- | -------------------------------------- | ----------------------------- |
| `v`            | `2`                                    | always                        |
| `category`     | `"input" \| "failure" \| "completion"` | always                        |
| `agentId`      | identifier                             | always                        |
| `sessionId`    | identifier                             | always                        |
| `occurredAt`   | ISO 8601, the Session's newest event   | always                        |
| `locale`       | `"en" \| "he"`                         | always, the device's own      |
| `agentName`    | string, 1–64 UTF-16 units              | fresh device, visible Agent   |
| `sessionTitle` | string, 1–120 UTF-16 units             | fresh device, titled Session  |
| `requestText`  | string, 1–200 UTF-16 units             | fresh device, input only      |
| `requestMore`  | integer ≥ 1                            | with `requestText`, when more |

`v` versions the payload on its own, apart from `HGW_EXTENSION_VERSION`.
Version 2 replaced, without compatibility, version 1's one counted message per
category, which named no Session when it counted several.

- **Text.** Every text field is one line: control and bidirectional
  characters removed, whitespace collapsed, credentials masked (see
  [Credential masking](#credential-masking)), and cut at a code-point
  boundary ending in `…`. An Agent's name travels only for a visible,
  selectable Agent that is not the creator.
- **Quiet Agents.** No message is sent for an Agent that is muted, or hidden
  and not the creator. A creator's Session, and an Agent the catalog does not
  hold, still send, unnamed. The gateway learns this from the Agent catalog on
  every delivery: one read answers for 60 s, a delivery waits at most 1 s for
  a new one, and a slow or failed read leaves the last read that succeeded to
  answer, however old. With no read ever succeeded, the message goes without
  a name. An Agent update made through the gateway applies from the next
  delivery, even while reads fail. A skipped Session is logged with its count
  only, never its Agent.
- **Fresh devices.** Only a registration stored in the last 30 days receives
  `agentName`, `sessionTitle`, `requestText` and `requestMore`; an older one
  receives the ids alone until the browser registers it again with
  `PUT /push/subscriptions`. A registration older than 90 days is removed,
  on startup and before each delivery.
- **Size.** Every message is padded to 4096 bytes. A payload past the
  encryptor's 3993-byte plaintext limit drops `requestText` and
  `requestMore`, then `sessionTitle`, then `agentName`; the ids always
  travel.
- **Topic.** The `Topic` header is per Session and keyed: the first 32
  characters of base64url(HMAC-SHA256(key, UTF-8 of the JSON array
  `[agentId, sessionId]`)), where the key is HKDF-SHA256 over the VAPID
  private key with an empty salt and the info `harness-gw push topic v1`. A
  push service can collapse a Session's undelivered messages into the newest
  without learning which Session it is. A Session is not sent a message
  whose newest event is no newer than one it was already sent.

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
