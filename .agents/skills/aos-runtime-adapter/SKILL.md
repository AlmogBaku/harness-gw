---
name: aos-runtime-adapter
description: Add, audit, or debug how the harness-gw gateway adapts a native harness onto the ACP v2 wire: native client → ServerRuntime/ServerTurnEngine → SessionCoordinator → ACP translation → client.
---

# Work on a harness-gw runtime adapter

Read `AGENTS.md`, `docs/development/runtime-adapter-authoring.md`, and the
selected runtime's guide before proposing changes. Treat the gateway
architecture doc as normative. Consult `src/adapters/hermes/README.md`
and `TURN-LIFECYCLE.md` for a worked example.

## Pipeline and file ownership

| Layer                                                         | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native transport, identity, retention, validation, conversion | `src/adapters/<kind>/`: `adapter.ts`, `factory.ts`, `capabilities.ts`, `client.ts` / `dashboard-client.ts`, `content.ts`, `history.ts`, `interactions.ts`, `run.ts`, `workspace.ts`, `native-schemas.ts`; Hermes also has `run-attach.ts`, `run-failures.ts`, `run-frames.ts`, `run-native.ts`, `run-settlement.ts`, `run-state.ts`, `slash-commands.ts`, `attachment-registry.ts`, `media-lines.ts`, `vendor/`                                                                                                                                                                                                                                                 |
| Seam                                                          | `src/core/runtime.ts` (`ServerRuntime`, `ServerTurnEngine`, `ServerTurnHandle` with `stop`/`steer?`/`recoveryPosition`, `SessionScope`); vocabulary `src/core/events.ts`; coordination `src/core/session-coordinator.ts`; rows `src/core/session-rows.ts`; stages `src/core/attachment-stages.ts`                                                                                                                                                                                                                                                                                                                                                               |
| ACP adapter                                                   | `src/acp/agent.ts` (method handlers, `GUEST_METHODS`, connect-time hydration), `src/acp/agent-sessions.ts` (per-connection ownership, list cursor), `src/acp/member-encoder.ts` (`_hgw/*` emission; each membership's `reportExecution`/`reportUsage`/`reissuePending` live in `src/core/channel.ts`), `src/acp/translate/turn-events.ts`, `src/acp/translate/history.ts`, `src/acp/translate/requests.ts`, `src/acp/translate/updates.ts` (pure reducers from turn vocabulary to ACP), `src/acp/config-options.ts`, `src/acp/read-state.ts`, `src/acp/activity-feed.ts`, `src/acp/service.ts`/`src/acp/socket.ts`, `src/acp/validation.ts`, `src/acp/types.ts` |
| Contract                                                      | `protocol/acp.ts` (`_meta.hgw` schemas, `HGW_METHODS`, error codes); client consumer `client/*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## ACP surface coverage

| ACP surface                                                                                | Turn-vocabulary / seam input                                                                                                                                      | Adapter obligation                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/update` text / reasoning / tool chunks                                            | `TurnEvent` kinds (`message-chunk`, `thought-chunk`, `tool-call-*`)                                                                                               | Emit the correct kinds from `run.ts`                                                                                                                                                                       |
| `plan_update` `_meta.hgw.todos`                                                            | `plan-updated` carrying Todos                                                                                                                                     | Populate the plan payload                                                                                                                                                                                  |
| `tool_call_update` `kind` / `locations` / `diff` content, `_meta.hgw` timing and subagent  | `tool-call-started` `name`, `toolKind`, `locations`, `startedAt`, `subagent`; `tool-call-finished` `diffs`, `completedAt`, `durationMs`                           | Canonical name always; kind from it; absolute paths; the same facts in history                                                                                                                             |
| `tool_call_content_chunk`, `terminal_update` / `terminal_output_chunk`                     | `tool-call-output-chunk`, `terminal-output`                                                                                                                       | Partial output and command output after the owning call                                                                                                                                                    |
| `compaction_update`, `config_option_update`                                                | `compaction-updated`, `model-changed`                                                                                                                             | Stable compaction id; model id from the Session catalog                                                                                                                                                    |
| `state_update` idle `stopReason` / `usage`, `_meta.hgw.cost`, failure `provider` / `model` | `turn-ended` `stopReason`, `usage`, `cost`; `turn-failed` `provider`, `model`                                                                                     | Fill when the provider reports them; never guess                                                                                                                                                           |
| `usage_update`                                                                             | `SessionContextResponse` (`src/core/channel.ts` `reportUsage`)                                                                                                    | Implement `context(agentId, publicSessionId)` (`src/core/runtime.ts`) or declare unavailable                                                                                                               |
| `session/request_permission` / `elicitation/create`                                        | `PendingRequest` (`src/acp/translate/requests.ts`, incl. `HGW_PERMISSION_KIND_SESSION`, multi-select `items.enum`)                                                | Emit `PendingRequest` from `interactions.ts`                                                                                                                                                               |
| `resource_link` `artifact://<id>` chunk                                                    | `artifact-published` event with `HgwArtifactDescriptor` (`src/acp/translate/turn-events.ts`); history `data` part `aos.artifact` (`src/acp/translate/history.ts`) | Emit from `run.ts`/`history.ts` on a native `MEDIA:` line or a trusted delivery receipt; implement `artifact()` (`src/core/runtime.ts`); `present_artifact` is an MCP App and no longer emits a descriptor |
| `_hgw/steer_accepted`                                                                      | `steer` handle + `steer-accepted` event (`src/core/session-coordinator.ts`)                                                                                       | Implement `handle.steer`                                                                                                                                                                                   |
| `session_info_update` `{status, archived, unread}`                                         | Catalog rows (`SessionRows`)                                                                                                                                      | Implement `getSession` / `listSessions`                                                                                                                                                                    |
| `_hgw/catalog_invalidated`                                                                 | `subscribeCatalogChanges` callback                                                                                                                                | Implement `subscribeCatalogChanges` on `ServerRuntime`                                                                                                                                                     |
| `_hgw/session/update` intents                                                              | `sessionTitle` / `sessionArchival` / `sessionDeletion` capabilities                                                                                               | Route to `mutateSession(agentId, runtimeSessionId, "PATCH" \| "DELETE", body?)` (`src/core/runtime.ts`; called from `src/acp/agent-sessions.ts`) gated by those capabilities                               |
| Read state                                                                                 | `sessionReadState` capability + `unread` field on session row                                                                                                     | Write `{ unread: false }` via `mutateSession(agentId, runtimeSessionId, "PATCH", { unread: false })` (`src/acp/read-state.ts`)                                                                             |
| `session/set_config_option`                                                                | `models` / `thoughtLevel` capabilities                                                                                                                            | Implement `updateModel(agentId, publicSessionId, patch: SessionModelUpdateRequest)` (`src/core/runtime.ts`); response carries the settled model state                                                      |

Note: `_hgw/session_invalidated` is defined in the protocol but is not emitted
by the gateway.

## Register a new adapter

One new runtime kind = one `RuntimeConfig` variant added to
`src/config.ts` + one adapter package + one `case` in
`src/adapters/create-runtime.ts`.
`src/architecture.test.ts` fails until all three exist and the
selector file is the only file with the `case`.

## Preserve ownership

Keep connection topology, live identities, attachment, retention, payload
validation, and native recovery inside the adapter. Keep admission, normalized
turn state, control serialization, subscriber fanout, and turn segment identity
in the coordinator. Emit the gateway-owned turn vocabulary (`src/core/events.ts`);
extend the vocabulary there only for behavior it cannot yet express.

## Classify failures and own the link

Every failure the adapter raises is `gone`, `unavailable`, `uncertain`, or a
caller error (`invalid_request`, `revision_conflict`,
`runtime_authentication_required`), each built with `failureOf` or
`publicFailure` from `src/core/failures.ts`. The native error
travels as `cause`. A write past `ADAPTER_CALL_MS` (15 s,
`src/core/limits.ts`) is `uncertain`; a read past it is
`unavailable`.

Each adapter owns one `createLink` owner per native link
(`src/core/link.ts`): it reconnects with jittered backoff and a
circuit breaker, stops on `gone` or `runtime_authentication_required`, and
exposes `Link.held()` for callers that want to know the breaker is open. Call
`link.dispose()` on every exit path — normal close, error, and cancellation.

Two conformance suites must pass before the adapter is considered complete:

- `runServerRuntimeContract` (`src/core/runtime-contract.ts`) in the
  adapter's own `contract.test.ts` — failure taxonomy, recovery token, link
  contract.
- `runWireContract` (`src/acp/wire-contract.ts`) in the adapter's own
  `wire-contract.test.ts` — drives the real gateway over the adapter's native fake
  via an in-memory WebSocket, proving what a plain ACP v2 client reads. Rows the
  adapter cannot express are named in `gaps`. Each adapter's fake lives beside its
  source, not in a shared test helper.

## Attachments and Artifacts

Treat attachment and media planes as different public concepts:

| Native input                                                                                                                                | Public projection                           | Read authority                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| User attachment/context envelope such as Hermes `@file:`                                                                                    | User message attachment                     | The adapter's admitted, Session-scoped attachment record                                     |
| `aos-ui` `present_artifact` call (MCP App; result `{ok, type: "aos.presentation", kind: "present_artifact", value: {filename, mimeType?}}`) | MCP App card with live file view            | Gateway file pass via `mcpApps` file route; folder rules govern which paths                  |
| Harness `MEDIA:/absolute/path` line (Hermes, OpenClaw)                                                                                      | Assistant Artifact; line removed from prose | The line, after `safeArtifactPath`; `MediaLineFilter` (`src/adapters/hermes/media-lines.ts`) |
| Successful delivery tool output such as Hermes text-to-speech                                                                               | Assistant Artifact                          | The trusted native tool receipt                                                              |
| Path mentioned in prose, or an unclaimed `MEDIA:` line                                                                                      | Nothing, or `[Media unavailable]`           | None                                                                                         |

Parse attachment envelopes server-side. Preserve authorship and safe filename,
MIME, size, and opaque identity; remove native paths, injected context,
filesystem warnings, and private retrieval URLs.

An Artifact from `MEDIA:` or a trusted delivery tool reaches the client as a
`resource_link` content block whose `uri` is `artifact://<id>`, and is fetched
over `GET /api/v1/agents/:agentId/sessions/:sessionId/artifacts/:artifactId`
(`src/routes/content.ts`). Keep the reference in a private
Agent-and-Session-scoped mapping; expose a deterministic opaque Artifact ID.
`artifact()` resolves the id only within that Session, reads through the
harness's own file interface, and caps bytes at `MAX_ARTIFACT_BYTES` (25 MiB).
Pass every native tool name through `canonicalAosToolName`
(`src/core/aos-tool-names.ts`) so prefixed `aos-ui` MCP tools reach the client as
`render_chart`, `render_map`, `render_stats`, and `present_artifact`; all four
are MCP Apps, flagged at call start by `withMcpApps`. When the
harness loads MCP servers per Session, enable `aos-ui` inside the adapter before
each turn and fail the turn if that fails (OpenClaw `#enableAosTools`,
`src/adapters/openclaw/run.ts`).
For Hermes text-to-speech, grant an Artifact only when a successful
`text_to_speech` result lists the same supported audio reference in `file_path`
or `file_paths` **and** its `media_tag`. Redact paths from the public tool
result. Buffer fragmented `MEDIA:` lines across deltas; suppress a trusted
delivery marker and never grant authority to an unmatched one.

## Choose the work path

- **Add:** implement one observable operation end to end, beginning with a
  focused provider-neutral behavior test.
- **Audit:** compare every in-scope capability and lifecycle transition with
  native sources, then report concrete mismatches and protecting tests.
- **Debug:** trace one failing operation across native input → adapter
  conversion (`run.ts`/`history.ts`) → coordinator journal
  (`subscribeExecutions`/`snapshot`) → ACP outbound (`src/acp/translate/*`,
  `src/acp/member-encoder.ts`) → client projection
  (`client/acp-workspace-client.ts`). Test the first
  boundary where actual state diverges from expected state.

For mutations, identify admission, acknowledgement, and uncertainty before
coding. Reconnect reconciles authoritative state and never resends an uncertain
mutation.

## Complete the work

Run the focused adapter tests and the affected provider-neutral conformance and
client tests. Test suites by boundary: `src/adapters/<kind>/*.test.ts`,
`src/core/session-coordinator.test.ts`, `src/acp/translate/*.test.ts`,
`src/acp/agent.test.ts`, `client/*.test.ts`.

Confirm: capability fidelity across both roles (guest projection in
`src/guest/acp.ts` and `src/auth/guest-runtime-projection.ts`),
`_meta.hgw.sequence` monotonic on replay, reconnect via `session/resume`
`after` without prompt replay (a lost cursor rebuilds from history in the same
resume), and the `vendor/` + `UPSTREAM.md` +
snapshot-test rule for vendored native clients. For attachments or delivered
media, cover split stream markers, history restoration, exact receipt
correlation, opaque retrieval, untrusted and mismatched paths both with and
without a delivered Artifact, failed receipts, and missing bytes. Report native
evidence, changed mappings, verification, and any capability left unavailable.
