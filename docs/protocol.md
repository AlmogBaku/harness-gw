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
now `3`). A breaking change to anything in this document raises it; an
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

- a request whose `Host` names neither the host and port of one of those
  origins, a default port named or left out, nor `localhost`, `127.0.0.1` or
  `[::1]` on any port gets 421. A proxy must keep the browser's `Host`, and a
  non-browser caller reaches the gateway on loopback or by a listed name: one
  that uses another, such as `aos-invite-link` with an `AOS_GATEWAY_URL` naming
  a container or host, is refused. `*.localhost` is not loopback here, so a
  request for an MCP App sandbox origin such as `http://sandbox.localhost:3000`
  is refused too.
- a WebSocket upgrade, or any request other than GET, HEAD and OPTIONS, needs
  an `Origin` on that list when it carries one; a `null` or foreign one gets 403. A request with no `Origin` comes from no browser page, so it is
  admitted: a script or a non-browser ACP client needs no `Origin`.
- a GET or HEAD is never checked: it changes nothing, and no other origin
  reads its answer.
- CORS answers listed origins only (`Access-Control-Allow-Origin` with
  `Vary: Origin`), never with credentials; a preflight from any other origin
  gets 403. A file answer is no exception: a view reads its file through its
  server (see [Reading a view's files](#reading-a-views-files)).

The response carries an `Acp-Connection-Id` header. A client sends
`initialize` and receives capabilities in `_meta.hgw`. On reconnect, send
`initialize` again and then `session/resume` with the `_hgw/position` cursor
naming the first sequence not yet observed: a Session is active only on the
connection that created or resumed it (see
[Session lifecycle methods](#session-lifecycle-methods)), so nothing is
prompted or configured on the new one before its resume. When the cursor is beyond bounded
replay, the same resume rebuilds the Session from history, as described under
[Response `_meta.hgw` shapes](#response-_metahgw-shapes).

The SDK client reconnects with jittered backoff starting at 250 ms, capped at
5 000 ms, and resetting once every resumed Session has rejoined or the link has
been stable for a while. A `4409` within 60 s of that rejoin
(`FELL_BEHIND_WINDOW_MS`) takes the reset back, so a reader that keeps falling
behind a running turn backs off as any repeated failure does. A guest connection re-sends `auth/login` after every
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
| `4409` | Reader fell behind: the client read none of a full output buffer (8 MiB) for 60 s, its waiting requests passed that buffer, or a Session left it behind | Normal reconnect; within 60 s of a rejoin, the backoff grows |

Any other code triggers a normal reconnect.

What bounds a slow reader is the socket and each Session's stream, never a
deadline on a Session it holds. The ACP SDK holds output once 8 MiB is unsent
and closes a reader that drains none of it for 60 s. A Session streams each
member through a queue of `limits.subscriberEvents` events and
`limits.subscriberBytes` bytes: a member whose queue overflows is rebuilt from
history in standard updates, once per turn. One that overflows the same turn
again, or whose view cannot be rebuilt, is not kept on the Session: the
gateway closes its connection with `4409`, which ends every Session's activity
on it, and the client reconnects and resumes each one.

A frame over `HGW_MAX_FRAME_BYTES` (1 100 000 bytes) is closed by the server
itself before the gateway reads it, so the client never sends one: it refuses
an oversized prompt or steer locally with `requestTooLarge`.

ACP uses no JSON-RPC batches. A frame holding a JSON array is answered with one
`-32600` Invalid Request error whose `id` is `null`, and none of its messages
runs; a frame that is not JSON gets `-32700` Parse error, `id` `null` too. ACP
v2 request ids are strings or integers: a request whose id is `null` or a
number that is no integer gets the same `-32600` under `id` `null`, and does
not run. The gateway answers the non-integer one itself once `initialize` was
sent, before the ACP SDK sees it (`src/acp/socket.ts`), as the SDK would
otherwise hold a record of each such request until the socket closed. A
guest reads each of these answers as it reads every error reply (see
[Guest listener](#guest-listener)): `malformed_request` and `parse_error`. The
gateway writes no batch either; one written all the same reaches a guest with
each entry made public as a lone reply is.

## Handshake: `initialize` and `auth/login`

`initialize` always answers `protocolVersion: 2`, whatever the client
requested; this is ACP's version-negotiation rule, not v1 support.

The `initialize` response's `_meta.hgw` (`HgwInitializeMetaSchema`):

```json
{
  "version": 3,
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
| `session/prompt`                                                                                                                             | Sends, once the guest resumed the invited conversation; the first Send creates the invited Session. Edit and Retry (`rewindSourceId`) may name only a user message this connection was shown, and a Retry, which resends its source as written, may not name one whose text the guest could not send. They rewind as an operator's do. |
| `_hgw/session/steer`                                                                                                                         | Steers the invited conversation's active turn.                                                                                               |
| `session/cancel`                                                                                                                             | Stops a turn in the invited conversation only.                                                                                               |
| `session/close`                                                                                                                              | Stops the invited conversation's turn for every member, then detaches. Unlike an operator's close, it stops no background work: a guest is told no `background` list, and can neither see nor stop the operator's background work. |
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
`temporarily_unavailable`. No reply keeps `data`, but a `-32002`: it carries
`data: { sessionId }`, the `sessionId` the guest's own request named, when
that was a string, and nothing the gateway wrote (`src/acp/socket.ts`), so a
guest is shown its invitation's reference and never the native id behind it.
Only a request the ACP SDK answers under its own id is remembered for this:
one with the `jsonrpc: "2.0"` envelope, an integer id or a string one, and a
`sessionId`, each string at most 1024 characters, and at most 64 of them
unanswered on one socket; a request past that bound is answered without
`data`.

## Session lifecycle methods

`session/new`, `session/list`, `session/resume`, `session/prompt`,
`session/cancel`, `session/close`, `session/delete`, `session/set_config_option`
(model → `category: "model"`, effort → `category: "thought_level"`).

A Session's config options are two selects, the model and the selected
model's thought level:

- A `session/set_config_option` names one of them, `type: "id"`, and a `value` it offers now: as
  the Session's model reading holds it while a member follows the Session and
  nothing changed since, or else as one read of the runtime. Any other
  `configId`, `type` or `value` answers `-32602` and changes nothing.
- The writing connection is sent the write's `config_option_update`, the
  complete list the answer carries, before the answer. Every other member is
  sent the options read afresh once the answer is written, and every member
  then the `usage_update` whose window the model moved. The writer is not sent
  the same options again.
- Each `currentValue` is one of its option's values, each value listed once. A
  current model the catalog does not list, as a switch a turn reports mid-turn
  may name, leads in a group of its own (`groupId: "current"`,
  `name: "Current"`) under its id. Thought levels go from lowest to highest,
  as ACP asks: a current one off the model's ladder, whose rank is unknown,
  follows the ladder under its id; the provider's own default, which reports
  no effort, is `""` (`name: "Default"`), leads it, and is offered only while
  it holds.

A Session is **active** on a connection from a `session/new`, `session/fork`
or `session/resume` there that succeeded until `session/close`,
`_hgw/session/part`, or the connection's end; a resume that fails leaves a
Session it found inactive as it was. `session/prompt` and
`session/set_config_option` need the Session active, and answer `-32002` with
`data.sessionId` otherwise, before anything else is checked: a client resumes a
Session, on every new connection too, before it prompts it or changes its
model or thought level. A guest's resume of a fresh invitation makes it
active, and its first prompt then creates the conversation; one that never
resumed it creates nothing. A busy Session still refuses a prompt with
`-31010` once it is active. `session/cancel` of a Session not active here is
ignored, and `_hgw/session/steer` and an older page answer `-32002`;
`session/fork`, `session/delete`, `_hgw/session/update` and
`_hgw/session/focus` act on any Session the connection was told of by a list,
search, create, or resume, active or not.

`session/close` stops the Session's active work for every member and then
detaches this connection: its turn, as `session/cancel` does, and then its
background work, everything in the latest `background` list this connection
was shown (see [Background work](#background-work)). The closer is shown how a
turn it stopped ended, its final updates and its idle `state_update` with
`stopReason: "cancelled"`, before the answer; closing an idle Session sends no
idle of its own. The whole close, its Stop, the wait for the turn's end, and
its background stops, shares one 30 s deadline (`CLOSE_DEADLINE_MS`), well
under the SDK client's 45 s request deadline. A close whose Stop fails answers
that failure, and one the runtime does not confirm within the deadline answers
`-31014` `uncertain_mutation`: either way the Session stays active on the
connection, which is shown the turn's end once it comes, and the close may be
sent again. Freeing an unprompted Session (below) holds the answer only until
the deadline, as the closer has left. Closing is idempotent: a close of a Session not active on this
connection, already closed, gone, or never known answers `{}`, as a close of a
fresh invitation does, which only detaches it. `_hgw/session/part`
(`HgwSessionPartRequestSchema`, `protocol/acp.ts`) only detaches this
connection; the Session's work and all other members continue.

`session/delete` closes the Session first, as a close on every connection
would: it stops the turn and waits, as a close does, until each member was
shown how it ended, and stops every background child still at work; then the
runtime deletes the Session, and once it holds it no longer, deleted or
already gone, this connection is detached, as its close would detach it, and
every other member is told it is gone with an `_hgw/error` `not_found` and
detached. The whole delete, its close and the runtime's delete, shares one
30 s deadline (`CLOSE_DEADLINE_MS`). The deleter, if a member, is shown how a
turn the delete stopped ended, its final updates and its idle `state_update`
with `stopReason: "cancelled"`, before the answer, within that deadline, as
its close would show it. It waits for each other member to be shown the
turn's end for at most 5 s (`DELETE_SHOWN_MS`) and then goes on without it,
so one member's slow socket never fails another's delete: such a member is
told the Session is gone without the turn's updates it was not yet written.
A delete whose Stop fails, or goes unconfirmed, answers as a close would and
deletes nothing; one the runtime refuses answers that failure, and one whose
runtime delete is not confirmed within the deadline answers `-31014`; in each
case the Session stays active on the connection, as after a failed close, so
the delete may be sent again, and a delete that lands after its `-31014`
tells this connection the Session is gone as it tells every other member. A deleted Session that was
unprompted is not discarded afterwards: nothing is left to free, and a resume
or a prompt of it answers `-32002` from then on, as one discarded does
(below). A Session a prompt reached is left to the runtime's own answer once
deleted, since a runtime may make a conversation anew under its key itself, as
an OpenClaw channel does. A delete of
a Session not known to this connection succeeds rather than returning
not-found. The SDK client parts a Session its last listener left, after a
2 s grace, and closes one only when asked (`closeSession`): no grace parts it
while the close is out, and it forgets the Session, with no part, once the
close succeeded, while a close that fails leaves it opened and joined, so it
may be closed again. A delete (`deleteSession`) does the same, and once it
succeeded, the gateway having told the deleter nothing, the Session's
listeners hear it `gone`, as for a Session the gateway reports gone, before it
is forgotten. As ACP asks, it takes a `-32002` answer to `session/close` or
`session/delete` as success.

A Session a `session/new` created is **unprompted** until the first prompt is
sent to its runtime, whether or not the runtime confirms the start, or until
an `_hgw/session/update` of it (a rename, pin, archive, or read mark)
succeeds: an operator who acts on a Session keeps it. Only the create that
ran marks it, never a repeat of its `clientId`, and the mark is the
native Session's, so a member of either listener counts. Forked and invited
Sessions are never marked. While marked, it is left out of `session/list` and
`_hgw/sessions/search`, so a draft is no History row even on a runtime that
lists a Session from its create. Once nothing holds it, at once after
`session/close` and otherwise once no member has been on it for the idle
window (the Hermes `runtime.sessionIdleMs`, 300 s by default and on every
other runtime), the gateway discards it in one checked step: it reads the mark
and that no member, joining or joined, of either listener, is on the Session,
and takes it as discarding in the same turn. From then on a resume or a prompt
of it answers `-32002`, and a client that still wants it creates a new one. The
runtime then frees it (`discardSession`): Hermes, which lists no Session before
its first turn, closes its live Session, and deletes the empty row a resume of
its key may have written; OpenCode and OpenClaw delete it only
after their own read shows no message and no running turn, and keep any other,
which is listed again. A Session the runtime already reports gone counts as
discarded. Once the discard settles the mark ends. A discarded Session, and
an unprompted one deleted, stays `-32002` here however long after, among the
last 4096 the gateway discarded or deleted so (`DISCARDED_REFUSALS`), and out
of every list: OpenCode and OpenClaw answer
not found for it themselves, but Hermes makes a server-minted draft anew for
any resume of its key, so the gateway's own answer is what keeps a client
that held one from bringing it back. A discard that fails for any other
reason leaves the Session marked for its next idle window, three attempts in all
(`DISCARD_ATTEMPTS`), after which the gateway leaves it be and lists it. A
gateway restart forgets every mark, so it can leave a Session behind, never
delete one.

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
listed or resumed cannot tell which Agent owns it, so it deletes nothing and
succeeds silently, as ACP has a delete of a Session that never existed do; on
an Agent's address a Session that is already gone deletes successfully.

**`session/fork`** (operator listener only): answers the `sessionId` and setup
(see [Response `_meta.hgw` shapes](#response-_metahgw-shapes)) of a new
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
  its next event, and is never rebuilt from history. The SDK client resumes so
  a Session it opened with `subscribe(sessionId, listener, { replay: false })`,
  as a send from outside the Session's view does, while no subscription asks
  for a replay; one that then asks has it replayed from `start`.
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

A resume with a `start` or `_hgw/position` cursor ends its replay with ACP's
`replay_complete` update before its answer, once, also when it replays
nothing; a resume with no cursor sends none. Only replayed history precedes
it: the stored messages, and a running turn's events up to the replay's cut,
which is what the turn's journal held when the resume followed the turn. From
the request on, the gateway holds everything else for the Session (the turn's
later events, a notice, a reading, the Session's row, a request it asks) and
sends it after `replay_complete`, in the order it came, then the Session's
current `state_update`, then the answer. A failure's `_hgw/error` and a
request's withdrawal are not held. Each child Session the replay announces
gets its own `replay_complete` on the child's id, after its announcement and
its transcript, and one first announced after the replay completed and before
the answer gets one right after its announcement. A replay that cannot finish
sends no `replay_complete`, and its resume answers an error. An `_hgw/before`
page read is a resume with a cursor too, and closes the same way (see
[Older history pages](#older-history-pages)).

**`session/prompt`** request (`HgwPromptMetaSchema`, `protocol/acp.ts`):
`{ rewindSourceId?, attachmentStageId?, clientId? }`. `rewindSourceId` names
the user message an Edit or Retry replaces; a Session offers it only where its
capabilities report `interactions.rewind` available, since what a rewind undoes
with the turns, such as restored files, is the runtime's. As ACP allows no empty
`prompt`, a rewind resends the blocks of the message it replaces, an Edit with
its new text in place of the old. Its files are the replaced row's, which the
runtime re-attaches where it can, so a rewind takes no `resource_link` but
those into a stage its `attachmentStageId` names, and one left with no text is
a Retry. `clientId` becomes the turn's `turnId`; a retry with the same
`clientId` returns the first answer unchanged. The response carries the minted
user-message id as the top-level `messageId` field (SDK 1.5.0
`PromptResponse`). As ACP reads an error answer
as a prompt never inserted, the answer waits for the runtime's storage receipt
and names the id it stored the prompt under. A prompt the runtime may have
stored without proving it, because its receipt outlasted the admission
deadline, its turn ended first, or its start went unanswered, is answered
under the id the gateway minted. As ACP has a replayed prompt keep the id its
answer returned, a receipt that lands after that answer makes every later
replay and older page name the prompt by the minted id, and a rewind naming
it reach the runtime by the runtime's own; the gateway keeps that in memory,
so a restart forgets it, and a prompt whose turn ended, or whose start went
unanswered, before any receipt replays under whatever id the runtime stored.
An unanswered start then reports the
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

On the operator listener, a prompt or steer any of whose text blocks opens with
one of the Session commands `/new`, `/reset`, `/clear`, `/resume`, `/sessions`,
`/quit`, or `/exit` (case-insensitive, leading whitespace and invisible
characters stripped) is refused with `-32602`, message `Invalid params: Session
commands run in the client, not as a prompt.` A client runs those itself, so
`available_commands_update` never lists them. `/branch` and `/fork` are not
refused: on Hermes the gateway runs them as the fork. The guest listener refuses
every prompt or steer any of whose text blocks starts with `/`, however padded, with `-32602`
before this rule applies.

### Response `_meta.hgw` shapes

**Setup answers.** The `session/new`, `session/fork`, and `session/resume`
answers carry the Session's setup, as ACP v2 asks of a setup response: its
config options (model and effort) in `configOptions`, its slash commands in
`availableCommands`, and the capabilities beyond those commands in
`_meta.hgw.capabilities` (`HgwSessionSetupResponseMetaSchema`,
`protocol/acp.ts`), the same shape `available_commands_update._meta.hgw`
carries beside its commands. Every resume answer carries them, a `_hgw/before`
page read's included, as ACP has every `session/resume` answer do whether or
not it replays. Each is the reading passed through the member's own stack as
the `model` or `commands` event it is, so it tells a member only what its
stream would show: a guest's answer has no `configOptions`, and its commands
and capabilities are the guest projection, with none of the operator's
commands. A field the stack hides, or a reading the gateway does not hold, is
left out, never `null`, and so is an empty list, as ACP serializes one
("omission or `[]` means none"); an update still carries `[]`, which clears
its list. Each reading is read at most once for the answer, one
read at a time with any other read of it, and a resume reads it beside its
replay; the member's readings take that value when its join lands rather than
asking the runtime again, unless a change was reported while it was read. The
answer waits on a read 2 s at most (`SETUP_READ_MS`): one still in flight then,
or one that fails, answers what the gateway already holds, or leaves the field
out; the one in flight still lands, as an update after the answer, and a
failed one's update follows once a later read succeeds. The OpenCode adapter reads a
Session's models only once its native row names a model, which a new Session's
may not yet, and then its answer has no `configOptions`. The same readings still follow every answer as
`config_option_update` and `available_commands_update` updates, for every
member, and each later change arrives as one of them, replacing its whole
list. As ACP has a client do, the SDK client applies answers and updates in
the order they arrive, each replacing the lists it names, and reads a list an
answer omits as none. `capabilities` are this gateway's own: an answer without
them, or with ones the client cannot read, leaves those it holds. It hands the
setup it holds to each listener that subscribes later
(`AcpSessionListener.setup`), so a Session subscribed to in its creation's
grace shows its models and commands at once.

**`session/new`** response: `sessionId` as a top-level result field and the
setup above. The creator's join lands once the answer is written, so the
Session row (`session_info_update`), usage, and each reading again arrive as
events after the answer, never before it; `session/fork` answers the same way.

**`session/resume`** response (`HgwSessionResumeResponseMetaSchema`, `protocol/acp.ts`):
the setup above, and `{ position?, history? }` beside the capabilities in
`_meta.hgw`. `position` is
the turn and sequence the joined Session stands at; a later resume continues
from it. As ACP has a resume synchronize current state before its answer, the
Session's current `state_update` and then the row the gateway holds of it
(`session_info_update`) arrive before the answer, after any replay. The row is
the one the gateway already holds, so a rejoin still asks the provider nothing
first: a row it does not hold yet, and a change the read after the join
finds, arrive after the answer, and so does usage. When the journal cannot answer `from`
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
  never carries `plan_update`: the Todo plan comes only with the newest page.
- The response carries `_meta.hgw.history`
  (`HgwHistoryPageResponseMetaSchema`) beside the Session's setup, as every
  resume answer does (see [Response `_meta.hgw` shapes](#response-_metahgw-shapes)). A missing `nextCursor` means the
  beginning. `truncated: true` with no cursor means the gateway's bound stopped
  the reading, or the runtime's own reach did, and the thread says earlier
  messages can't be loaded.
- A page is read only for a Session this connection has resumed, whether by
  a resume, `session/new`, or a prompt, one at a time per Session. It never
  resumes or restates usage. A cursor that does not decode, or points past the
  history, is invalid params.
- As ACP closes every resume with a cursor, a page ends with its own
  `replay_complete`, tagged as the page's, after the page's updates and each
  child transcript's (each child's tagged on the child's id), and then the
  Session's current `state_update` and, as ACP has current session info
  follow a replay, its `session_info_update` with the row the gateway holds,
  both untagged, before the response. That state is the one this
  connection's stream of the Session last showed it, said again as a
  repeated snapshot with the list as it stands and without the turn's usage
  or cost, so no update the page held back, such as the end of a turn that
  ended during the read, is overtaken by a newer state. Until the
  page's `replay_complete` the gateway holds the Session's other updates, as
  a resume's replay does, and sends them after it. The client hands the page
  its tagged updates, the `replay_complete` among them, and its live
  listeners the state, which a reader applies as any current state.
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
receives history first, then the live turn's buffered events up to the
replay's cut, then `replay_complete`, then what was held meanwhile and the
current state, then the stored prompt answer (if it arrived before the storage
deadline).
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
| `state_update`              | Run state transitions, each with the Session's `background` list                                                  |
| `plan_update`               | Session Todos in `_meta.hgw.todos`                                                                                |
| `compaction_update`         | The provider compacted the conversation's context, with its summary once completed where the provider keeps one  |
| `usage_update`              | Context window usage                                                                                              |
| `session_info_update`       | Session metadata changes                                                                                          |
| `available_commands_update` | Slash commands and capabilities in `_meta.hgw.capabilities` (`HgwAvailableCommandsMetaSchema`, `protocol/acp.ts`) |
| `config_option_update`      | Current model and effort-level selection                                                                          |

A setup answer carries the Session's config options and commands (see
[Response `_meta.hgw` shapes](#response-_metahgw-shapes)); `config_option_update`
and `available_commands_update` restate them after it and report each change.

`usage_update` carries the used and total token counts in its own fields, and
the provider's attribution and provenance in `_meta.hgw` (`source`,
`estimated`, `breakdown`). It is session-scoped rather than run-scoped: the
gateway sends one on `session/new`, on `session/resume`, after every settled turn,
and after a `session/set_config_option` that changes the model, because the
window grows with the conversation and its size belongs to the model. A provider
that cannot report usage sends none, and the last reading stands.

### Background work

Every `state_update` an operator is shown on a Session carries its
`background` list, as ACP's background work has it: `[]` when nothing runs
past its turn, and never omitted. The gateway lists a child, as
`{ "type": "subagent", "sessionId" }` (see [Child Sessions](#child-sessions)),
once no foreground work waits on it: the tool call that spawned it returned
while it still runs, during the turn, or the turn that spawned it ended. A
child its call waits on is that turn's foreground work, and one that ends
before its call returns is never listed. A child stays listed while its state is not idle, as ACP
lists a detached child: at work, waiting on input, or `unknown`, which nothing
follows any more and may still run, so it stays listed until a report says
how it ended; a close stops an `unknown` one only where its runtime still can
(see each runtime's page). A child known only from a stored row, which a
from-start resume or an older page replays, is listed by the state the row
names, under the same rule: a row at work, waiting or `unknown` lists it once
the row announced it, and it stays listed until a report of its runtime says
it is over, while a close asks it stopped where the runtime still can; a row
that is over, or that names no state, lists nothing. A report of the live
Session's always outranks a stored row. A view positioned in a turn replays no
row, so it lists only what the Session's reports name.

A process a tool call leaves running is listed as its terminal,
`{ "type": "terminal", "terminalId" }`, from the call's return, during the turn,
until its `terminal_update` reports `exitStatus`: with the exit code where the
runtime knows it, and as `{}`, exited with no known status, where the runtime
no longer holds the process. Its call is never listed, since a listed
terminal is all the work it has. Its output keeps arriving after the turn, as
`terminal_output_chunk` on the Session, with the `_meta.hgw` of the turn that
started it and `background: true`; the call already carries the terminal, so
nothing is added to its content. No runtime here reports a tool call that
outlives its turn without a process, so none is listed; each runtime's page
under `docs/runtimes/` says what it reports of such work.

- An item is announced before the first list that names it: a child's
  `subagent_update` at work, or a terminal's `terminal_update`, comes first,
  whatever its runtime first reports of it, output alone included, and a child
  this connection could not announce is never listed. A child's
  report that it is over (idle, cancelled or failed), or a terminal's
  `exitStatus`, comes before the list that drops it.
- When the list changes, the Session's state is said again with the new list:
  the state this connection was last shown, a repeated snapshot that moves
  nothing. It carries that state's stop reason, but not the turn's `usage` or
  its `_meta.hgw.cost`, which a client counts once.
- Every resume, from any cursor and on a connection that holds the Session
  already too, rebuilds the list from where the work is kept: the Session's
  channel for work that outlived its turns, the live turn's journal for work
  its calls left running before the replay's cut, and what the replay then
  shows. It restates each listed child and terminal the replay did not show
  before the state that closes it, which carries the list, so no list
  reaches a resuming view ahead of the state its resume closes with, or
  names work it was not told of. A terminal is restated as its command
  and folder, its exit where it has one, and the latest of its output the
  gateway holds as ACP's replacement `output` snapshot: what it printed after
  its turn, its last 16,384 characters (`RESTATED_TERMINAL_OUTPUT`), or what
  its runtime's read gives, masked as its live output is. A Session nobody
  held is first asked of its runtime how each process its turns left running
  stands, which the resume's state waits for up to 2 s (`SETUP_READ_MS`); a
  read slower than that lands as updates after it.
- A child's own `state_update`s, and the state its parent's `subagent_update`
  mirrors, carry `background: []`: the gateway follows no background work of a
  child's own, so a child shown idle is over.
- `session/cancel` leaves listed work running; `session/close` stops
  everything in the latest list its connection was shown, each child through
  the runtime's own stop of one and each terminal by stopping its process,
  whose exit the terminal then reports. A guest is told no list on any state,
  not even `[]`, is shown no terminal, during its turn or after it, and its
  close stops nothing in the background.

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

A failed turn ends live with ACP's `state_update { state: "idle", stopReason:
"error" }`. Its `error` is the public error: `-32603` and, as its `message`,
the failure's machine code (`internal_error` when it has none). The provider's
own words travel only as `_meta.hgw.message`, beside the same `code`.

A replay sends no past `state_update`, as ACP asks, so a turn the provider
stored as failed replays its failure on the message it ended: after that
message's own parts, one `agent_message` upsert for the same `messageId`
carries `_meta.hgw.failure: { message, code?, at? }`
(`HgwMessageFailureMetaSchema`, `protocol/acp.ts`). It leaves the content the
parts streamed; a turn that failed before any output replays as this upsert
alone, with `content: []`. `message` is what the reader is shown of the
failure, masked as its live form is: the provider's words for an operator, the
public description of the failure's class for a guest. `code` is the
normalized code the runtime stored, which a guest is never sent. `at` is when
the turn failed. The same form arrives on the newest page and on every older
one, and a live failure never takes it. Both forms reach a reader for one turn
only when the turn fails while that reader resumes, its row stored before the
replay read it and its live end following the replay: the upsert names the
message, under `turnId: "history"`, and the live `state_update` names the
turn's own `turnId`, so a reader marks the message failed from the one and
ends the turn from the other, and the failure reads once.

Two refusals end a prompt before anything is stored, so `session/prompt` itself
answers `-32602` with the refusal's code as the error's `data.code`, for the
client to word: `HGW_COMMAND_WITH_ATTACHMENTS` ("Slash commands cannot be sent
with attachments.") for a Hermes command sent with file or image attachments,
and `HGW_COMMAND_UNSUPPORTED` ("This command is not available here.") for a
Hermes command Hermes reserves for other clients: one it marks with any desktop
reason other than hidden, or one of the TUI's own commands.

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
| `_hgw/session/update`  | Set title, archived, pinned, or unread (exactly one intent per call; `protocol/acp.ts`); see [Read state](#read-state)                                                                               |
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

#### Read state

`_hgw/session/update` with `unread: false` marks a Session read at once and
tells the runtime. With `unread: true` it marks the Session unread once the
runtime takes the write; a refused write changes nothing. A runtime whose
`sessionReadState` is unavailable refuses `unread: true`.

While a connection's `_hgw/session/focus` names a Session, the gateway
acknowledges it to the runtime, so activity there does not leave it unread.
A Session the connection marks unread while it shows it stays unread until
that connection's focus moves to another Session or to none and back, or the
connection sends the Session a prompt or a steer or marks it read. A report
that changes only `foreground` or `idle` does not read it. Another connection
that shows the Session still reads it.

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

A `summary` may also carry `_meta`, the harness's native metadata for the
Agent, passed through whole: the gateway neither checks nor interprets the
copy. It is unvalidated harness data, so a client must not trust
it as it trusts `avatar`, which the gateway checks is a token. Hermes sends
`_meta.aos`, the profile's `ui_meta.aos` as stored (see
[the runtime notes](runtimes/hermes.md#agent-metadata)); OpenClaw and OpenCode
send no `_meta`.

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
| A tool call, live and replayed, on both listeners, for every runtime  | its title, arguments, result, content, streamed output, and its terminal's command and output, during its turn and after it                        |
| A child Session, live and replayed                                    | its title, description and summary, and its own tool calls and failures as a turn's are                                                              |
| A failed turn, live and replayed                                      | its message                                                                                                                                          |
| A runtime's `notice`, on the operator listener (a guest is shown none) | its title and description, which a background process's completion names its command in                                                            |
| A question a guest is shown                                           | its prompt, header, and choices; a guest's answer reaches the runtime as the choice it wrote, and an answer echoed back to a guest is masked        |
| `requestText` in `_hgw/activity`, and every Web Push text             | the one line it shows                                                                                                                                |
| An MCP App view                                                       | its tool input and result                                                                                                                            |

A `background` list names ids alone, so it passes unmasked; every event kind
the middleware passes as it is, it names, so a kind added later fails to
compile until its masking is decided, and one that arrives anyway is not
shown.

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
streamed output is masked as plain text, never re-encoded. A terminal's output,
a chunk or a restated `output` snapshot, keeps its last 262,144 UTF-16 units,
the most a browser keeps of one, without the word the cut lands in, and so does
every shorter tail the gateway or a runtime keeps of it; nothing else is cut. Each turn event is masked
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
[HTTP API](#http-api)), with `resources/read` (see
[Reading a view's files](#reading-a-views-files)); the tool's MCP server
never opens the file, and reads it only from the file route.

### MEDIA: Artifacts

An Artifact from a `MEDIA:` line in the Agent's reply reaches a client as an
ACP `resource_link` content block inside the turn's `agent_message_chunk` (or
`user_message_chunk`), both live and on replay (`src/acp/translate/updates.ts`):

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

A client opens such an Artifact in the configured viewer
(`mcpApps.files.viewer`) at `…/artifacts/:artifactId/app` (see
[HTTP API](#http-api)). The view's `toolResult` is `viewerFileResult`: the
Artifact's `filename`, its `mimeType`, and its `fileId` where the runtime read
it from a path. `fileId` is `artifactFileId(path)` from `@harness-gw/sdk/node`,
the first 16 hex digits of a SHA-256 of the normalized POSIX path, so a Hermes
`MEDIA:` file carries the same `fileId` as a `present_artifact` call for the
same path, while the path itself never leaves the adapter. A file read from no
path, such as OpenClaw's, carries none.

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
  turn. The parent first reports each child that outlives its turn as
  `running`. Each one still at work is in the parent's `background` list
  (see [Background work](#background-work)). As ACP has it, `session/cancel`
  of the parent asks nothing of such a child (a runtime may still end it with
  the turn, as Hermes does), and `session/close` of the parent stops each one
  in the latest list the closing connection was shown, through the runtime's
  own stop of a child, as a `cancel` of the child would; a child the runtime
  cannot stop alone runs on. A guest's close stops none, whatever its connection was told: a
  guest is told of no child, and its stack's close asks no background work
  stopped. A Session nobody watches any longer still follows its children
  for a minute, so a reload or a reconnect comes back to them followed: a
  connection that joins is told each one's latest report, and each open
  request, including those of a child that ended in that minute. No turn's
  journal keeps a child's updates between turns, so a positioned resume
  while the Session follows one is answered as a lost cursor is: the view is
  rebuilt from history, with each child's saved transcript, which may not yet
  hold a message the child is still writing. A child nobody watches as its
  turn ends, or past that minute, or one its runtime cannot follow, is
  reported `unknown`, with `capabilities` `{}`.
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
Whichever way a resume's replay announces a child, it ends the child's replay
with `replay_complete` on the child's id, as ACP has each announced child's
(see [Request `_meta.hgw` shapes](#request-_metahgw-shapes)); a guest, told of
no child, is sent none.

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

| Code     | SDK constructor                           | Meaning                                              |
| -------- | ----------------------------------------- | ---------------------------------------------------- |
| `-32000` | `authRequired()`                          | Authentication required (guest: no valid invitation) |
| `-32002` | `sessionNotFound()`, `resourceNotFound()` | Session or Agent does not exist, or Session inactive |
| `-32601` | `methodNotFound()`                        | Method does not exist, or is not available here      |
| `-32602` | `invalidParams()`                         | Request parameters failed validation                 |
| `-32800` | `requestCancelled()`                      | Request timed out or the transport closed            |

A `-32002` answering a request that names a Session carries
`data: { sessionId }`, the id the request named, whatever it was that could
not be found; one answering any other request carries no `data`.

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
| `-32700` | `parse_error`             |
| `-32600` | `malformed_request`       |
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

| Method | Path below the view        | Purpose                                                                                                                   |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | (the view itself)          | Open the view: its resource, CSP domains and file addresses                                                               |
| `POST` | `/tools/call`              | A tool call's view calls its own server's tools                                                                           |
| `POST` | `/resources/read`          | Read one of the view server's `ui://` resources, or one of the view's own file addresses through that server              |
| `POST` | `/ui/update-model-context` | A tool call's view sets what the model reads of it (see [A view's context for the model](#a-views-context-for-the-model)) |
| `POST` | `/files`                   | Renew the view's file addresses                                                                                           |
| `GET`  | `/files/:argument?pass=…`  | Read the file an argument names, with the pass its address holds                                                          |

### Hosting MCP App views

A UI shows a view as the spec's sandbox proxy does, with
`@harness-gw/sdk/protocol`:

1. Serve its sandbox page, the relay that creates the view's own `srcdoc`
   frame, at `MCP_APP_SANDBOX_PATH` from a sandbox origin of its own: another
   name, or the UI's name on another port. On loopback, use a `*.localhost`
   name such as `http://sandbox.localhost:3000`: the gateway answers
   `localhost`, `127.0.0.1` and `[::1]` on every port, so a loopback sandbox on
   another port, such as `http://127.0.0.1:3001`, would still reach it. That
   origin serves the page and its script alone. Never send its `/api/v1` to the
   gateway, which answers a host it does not serve 421 (see
   [Origins](#origins)), and never list it in `allowedOrigins`.
2. Frame the page at that origin with
   `sandbox="allow-scripts allow-same-origin"`, so the view runs on the sandbox
   origin with storage of its own.
3. Answer the page with the view's own policy as its `Content-Security-Policy`
   header, and `Cache-Control: no-store`, since the policy follows the view.
   Report the domains it applies to the view as `hostCapabilities.sandbox.csp`:

   ```ts
   const origins = {
     frameAncestors: ["https://agents.example"], // the UI's own exact origins
     sandboxOrigin: "https://sandbox.agents.example",
   }
   mcpAppSandboxPolicy({
     ...origins,
     csp: view.csp,
     fileLocations: Object.values(view.files?.addresses ?? {}),
   })
   appliedMcpAppCsp({ ...origins, csp: view.csp })
   ```

   `view` here is as the SDK client's `openMcpApp` returns it, its file
   addresses absolute; a plain `GET` of the view answers them relative to the
   listener, so resolve them against its origin first.
4. Bind the view from the host page too, as the spec's "Host MUST block
   connections to undeclared domains" needs: a view shares its sandbox page's
   origin, so it can navigate that frame.
   - Send `frame-src <the sandbox origin>` in the host page's own policy, so
     the frame loads nothing else.
   - Drop a view whose sandbox frame loads a second time, as it does when the
     view sends it to another sandbox query, and so another policy.
   - Show no views while the host page is at the sandbox origin, or at an
     address `frameAncestors` does not name.

The policy is the spec's default, widened only by the view's declared domains
and its own file locations, and framed only by `frameAncestors`. Anyone can ask
for a sandbox page with any query, so every value is checked before it is
written. An ancestor or sandbox origin that is not an exact `http(s)` origin
(lowercase, with no default port, path, or IPv6 literal) throws, as does a
sandbox origin that is one of the ancestors, since the spec requires the host
and the sandbox to have different origins. `isMcpAppPolicyOrigin` is that
exact-origin rule alone, so a host can refuse a setting before it serves a view.
A declared domain `isMcpAppCspDomain` refuses, or one naming the host and port
of a framing page or the sandbox, is dropped. A file location is kept only on a
framing page's origin, as that origin and its path without the pass, every
segment percent-encoded with quotes included, so whitespace, `;`, `,` and
quotes reach the header only encoded; one ending in `/`, which would name every
path below it, is dropped. Send locations without their passes when they travel
in a URL.

As the spec's "Host SHOULD log CSP configurations for security review" asks,
the gateway logs each view it opens once, at `info`, as
`mcp_app.view.opened`: the Agent, Session and tool call, the view's server and
tool where the runtime names them, and the domains its `_meta.ui.csp`
declares (`{}` for none). It never logs the view's HTML or the call's
arguments and result.

### Reading a view's files

A view reads its file the MCP Apps way, with `resources/read` (the ext-apps
SDK's `readServerResource`) on one of its own file addresses, and never
fetches the address itself: its sandbox origin may sit on a network the
listener does not. The host sends the read to `POST …/app/resources/read`
like any other, and the gateway forwards it to the view's own server, which
reads the file route server to server
(`src/routes/mcp-apps.ts`, `isOwnFileAddress` in `src/routes/app-files.ts`).

- **What is forwarded:** a `uri` that is an absolute `http(s)` URL whose path
  is the view's own file route and one argument, encoded as `open` wrote it:
  `/api/v1/agents/:agentId/sessions/:sessionId/tool-calls/:toolCallId/app/files/:argument`
  for a tool call's view, and `…/artifacts/:artifactId/app/files/path` for a
  published Artifact's, with the request's own Agent, Session and subject.
  Only the path is matched: the origin is whatever the browser used, and the
  query, pass included, goes on unread. A listener serving no files forwards
  none. Any other `uri` keeps the rule above: one of the view server's `ui://`
  resources is read, and anything else answers 403.
- **Where it goes:** a plain `resources/read` with the same `uri`, to the
  server that owns the view: the call's own, or the configured viewer for an
  Artifact (`ServerMcpApps.fileResource`). The gateway does not judge the
  pass, and logs the address's path, never its query. The server reaches the
  lane the address's origin names, at the internal route it is configured
  with for that origin, sends the pass, refuses an address without one, and
  answers the bytes as a `blob`. A pass is bound to its listener's role, so
  an address aimed at the other lane is refused there.
- **Turns:** each read holds its whole file, so the operator listener
  forwards at most 4 at once, and the guest listener 2, with 1 per invitation
  (`src/routes/file-reads.ts`). A turn covers the read, its parse and its
  answer's write: the answer streams, and gives the turn back once its last
  byte is written, or when its reader cancels it. The rest wait their turn in
  arrival order, at most 32 waiting, 2 of them per invitation on the guest
  listener, and each for at most 30 s; a read past any answers
  `unreachable`. A waiter whose request ends leaves, and a read whose request
  ends stops, writes nothing, and answers `unreachable`; only its own MCP
  request is cancelled, and the connection every other request to that
  server shares stays open.
- **TTL:** a turn lasts at most 120 s (`FILE_READ_TTL_MS`), from taking it to
  its answer's last byte. Past it, a read still running stops and answers
  `unreachable`, and an answer still writing ends unfinished; either way the
  turn is free and its buffers are dropped.
- **Size:** up to 64 MiB of decoded file content (`MAX_MCP_APP_FILE_BYTES`),
  so a `blob` of at most 4·⌈64 MiB / 3⌉ base64 characters. Every other read
  keeps its 2 MiB.
- **Failure:** the view's server fails a read with a JSON-RPC error whose
  `data` is `{ "reason": … }` (`McpAppFileReadErrorDataSchema`). The gateway
  passes that reason on; an error without one, or with one it does not know,
  reads as `unavailable`.

A failed read answers with the listener's usual error body plus the
`reason` (`McpAppFileReadFailureSchema`, `ErrorResponseSchema`), on both
listeners:

```json
{
  "error": {
    "code": "forbidden",
    "description": "You do not have permission to do that.",
    "reason": "denied"
  }
}
```

| `reason`      | Status | `code`                    | Meaning                                                                                                                                 |
| ------------- | ------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `denied`      | 403    | `forbidden`               | The file route refused the read: it answered the server 403                                                                             |
| `tooLarge`    | 403    | `forbidden`               | The file is past `MAX_MCP_APP_FILE_BYTES`, by the server's count or the gateway's                                                       |
| `unreachable` | 503    | `temporarily_unavailable` | The view's server could not reach the file route, or the read found no turn on the listener, or outlasted its turn or its request       |
| `unavailable` | 503    | `temporarily_unavailable` | The gateway could not forward it: a runtime that forwards none (OpenClaw's native relay), no server or viewer it may dial, or no answer |

No other answer names a `reason`. The SDK client's `readMcpAppResource`
rejects such an answer with `McpAppFileReadError`, an `HgwClientError` that
carries the `reason`.

### A view's context for the model

A tool call's view sends `ui/update-model-context` (MCP Apps 2026-01-26) as
`POST …/tool-calls/:toolCallId/app/ui/update-model-context`, with the request's
params as its body (`McpAppModelContextRequestSchema`): `content`, MCP content
blocks, and `structuredContent`, an object, both optional. The answer is the
spec's empty result, `{}`. The SDK client's
`updateMcpAppModelContext(sessionId, toolCallId, request)` sends it.

- **Replaces:** each update replaces what the call's view sent before; one with
  neither field clears it.
- **When the model reads it:** once, with the Session's next turn, and only
  the last update sent before it, as the spec's "If multiple updates are
  received before the next user message, Host SHOULD only send the last update"
  asks. On Hermes that turn is the next user prompt, and any other turn leaves
  it waiting; on OpenClaw it is the next turn but a heartbeat. It stays out of
  the visible transcript.
- **Who keeps it:** the runtime, never the gateway. Hermes keeps it when it
  hosts the view itself (`mcp.app.update_model_context`), and hands it to the
  model as the MCP server's untrusted output. OpenClaw keeps it
  (`mcp.app.updateModelContext`) for a view whose `mcp.app.view` reports
  `updateModelContextSupported`.
- **Unsupported:** a runtime with nowhere to put it out of sight answers `400`
  with code `unsupported`, and the SDK client rejects with an `HgwClientError`
  carrying that `code`, which the host returns to the view as its error. That
  is OpenCode, whose prompt API takes no text its transcript leaves out, a
  Hermes that does not host views itself, and an OpenClaw view that may send
  none.
- **Guests:** the guest listener takes it under the invitation's message
  permission, as a view's tool call, and answers `unsupported` the same way.

### Stable origins

A view may ask for an origin of its own with `_meta.ui.domain` (MCP Apps
2026-01-26, "Dedicated origin for view"), whose format each host defines. The
gateway passes on one format. A host that opts in serves such a view's sandbox
page from that domain, on a scheme and port of its choosing, by the steps
above; one that has not ignores `domain`, however well its key matches, and
keeps its sandbox origin.

- **Format:** `<key>.<the host's domain>`, a lowercase host name of at most
  253 characters (`McpUiDomainSchema`). `<key>` is
  `mcpAppStableOriginKey(url)` from `@harness-gw/sdk/node`: the first 32 hex
  digits of a SHA-256 of the MCP server's URL in its `canonicalUrl` form. For
  a URL already in that form, such as `https://example.com/mcp`, that is
  Claude's published format.
- **The URL the gateway dials:** `mcpApps.fallback.servers.<name>.url` where
  the operator set one, else the URL the runtime reports. Either is hashed in
  its canonical form, the WHATWG URL serialization with no trailing slash (the
  form the configuration keeps a URL in), so `https://Example.com:443/mcp/`
  and `https://example.com/mcp` give one key. A server that declares `domain`
  computes its key with the same function, from the URL the gateway dials it
  at, however written.
- **Both locations,** as the draft spec's "Metadata Location" requires: the
  gateway takes `_meta.ui` whole from the `resources/read` content item, and
  only when the item declares none, whole from the resource's `resources/list`
  entry. It never merges the two, and sanitizes either alike. The listing is
  cached per server and URL as `tools/list` is, at 3 s a page and 20 pages.
  One that fails or times out is skipped and logged as
  `mcp_app.resources.list_failed`, and the view opens without it.
- **Checked on every view:** a tool call's, and the viewer a published
  Artifact opens in. `domain` stays only when its first label is the key of the
  URL the gateway dialed. Otherwise it is dropped and logged as
  `mcp_app.domain.dropped` with the server's name and a `reason`: `mismatch`,
  with the declared label, or `malformed`, with nothing it declared; never the
  URL. A server named `aos-ui` that the gateway dials elsewhere cannot claim the
  tools server's origin. A view Hermes reads for the gateway is judged the
  same way, by the URL the gateway would dial its server at, whether or not it
  may: one whose server names no URL keeps none. A view OpenClaw serves
  (`mcp.app.view`) carries none.
- **Strict schema:** `McpAppViewSchema` refuses unknown fields, so an SDK
  client from 0.12.0 or earlier refuses a view that carries `domain`. Upgrade
  the gateway and its clients together.

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
  selectable Agent.
- **Quiet Agents.** A muted or hidden Agent sends no push. An Agent the
  catalog does not hold still sends, unnamed. The gateway learns this from the
  Agent catalog on every delivery: one read answers for 60 s, a delivery waits
  at most 1 s for a new one, and a slow or failed read leaves the last read that
  succeeded to answer, however old. With no read ever succeeded, the message
  goes without a name. An Agent update made through the gateway applies from
  the next delivery, even while reads fail. A skipped Session is logged with its
  count only, never its Agent.
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

`protocol/node.ts` is the server-only `@harness-gw/sdk/node`: the ids a server
derives, `mcpAppStableOriginKey` and `artifactFileId`, with Node's own crypto,
and `canonicalUrl`, the form the key hashes. No other protocol module imports
it, so `@harness-gw/sdk/protocol` still loads in a browser.
