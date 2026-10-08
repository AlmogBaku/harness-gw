# AOS runtime gateway V1 — completion record

> **Status: Complete** (delivered 2026-09-15). Wire protocol superseded
> 2026-09-19 by commits `92a24f2` (browser cutover), `f042380` (run
> vocabulary), `046d3bf` (ACP v2 migration; REST run plane and invalidation
> socket removed). Current normative description is
> [`aos-runtime-gateway-architecture.md`](aos-runtime-gateway-architecture.md).

---

## What V1 shipped

V1 delivered one working Hermes-backed AOS workspace:

- One Bun proxy with an operator listener and an optional guest listener.
- One configured `ServerRuntime` selected by `adapters/create-runtime.ts`.
- Hermes adapter: authenticated JSON-RPC WebSocket + HTTP, Session attachment
  registry, warm-idle release governed by `sessionIdleMs` config, reconnect
  and redial, run admission, stop and steering through `session.interrupt` /
  `session.redirect` native methods.
- AG-UI run plane over REST + SSE, posted per run to
  `/api/v1/agents/:agentId/sessions/:sessionId/runs` with `/runs/reconnect`
  and `/runs/stop` siblings, and the guest mirrors under a separate prefix, plus
  a separate operator events WebSocket that carried invalidations and reconnect
  cursors (`src/events/`). Both were replaced on 2026-09-19 by the
  single ACP v2 WebSocket (`fe69d45`, `5b81e09`, `046d3bf`).
- REST byte and discovery routes (`/api/v1/{runtime,healthz,readyz}`,
  stage, artifact, transcribe, speak).
- Guest invitations: HS256 JWT (`aos-guest-invitation+jwt`), scoped to one
  Agent and conversation reference, with expiry-driven connection close.
- `SessionCoordinator`: process-local admission, journal, replay, stop, steer
  dedup, and per-role capacity.
- Redaction, security headers, Origin checks, secret-file loading.
- Provider-neutral conformance runtime in tests, proving the adapter seam.

## Exclusions

| Item                                 | Status          |
| ------------------------------------ | --------------- |
| OpenClaw server adapter              | Later delivered |
| OpenCode server adapter              | Later delivered |
| Multiple concurrent runtimes         | Still target    |
| Multi-tenant operator authentication | Still target    |
| OIDC / SAML                          | Still target    |
| Distributed multi-worker ownership   | Still target    |

## Acceptance evidence

The following test files exist and cover the V1 acceptance criteria:

- `src/acp/agent.test.ts` — ACP protocol, guest projection
- `src/acp/operator.test.ts` — Session ownership
- `src/acp/read-state.test.ts` — read watermark, floor
- `src/acp/activity-feed.test.ts` — activity buffer
- `src/acp/socket.test.ts` — frame and rate limits
- `src/acp/service.test.ts` — Origin upgrade checks
- `src/core/session-coordinator.test.ts` — admission, capacity, conflict
- `src/core/session-rows.test.ts` — row cache, write guard
- `src/adapters/hermes/adapter.test.ts` — Hermes adapter
- `src/architecture.test.ts` — boundary invariants
- `test/architecture/adapter-boundaries.test.ts` — cross-provider imports
- `test/architecture/package-contents.test.ts` — server code out of published package

## Where each V1 rule now lives

| V1 rule                                       | Current location                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| System shape and module layout                | [Architecture §2](aos-runtime-gateway-architecture.md#2-system-shape), [§15](aos-runtime-gateway-architecture.md#15-adapter-kinds-and-selection) |
| Trust model, Origin checks, redaction         | [Architecture §3](aos-runtime-gateway-architecture.md#3-trust-boundaries)                                                                        |
| Operator and guest listeners, JWT, extensions | [Architecture §4](aos-runtime-gateway-architecture.md#4-listeners-and-roles)                                                                     |
| ACP handshake, socket, methods                | [Architecture §5](aos-runtime-gateway-architecture.md#5-the-single-acp-socket)                                                                   |
| Turn vocabulary, translation, `_meta.hgw`     | [Architecture §6](aos-runtime-gateway-architecture.md#6-turn-vocabulary-and-acp-translation)                                                     |
| Coordinator, engine, steer                    | [Architecture §7](aos-runtime-gateway-architecture.md#7-sessioncoordinator-and-adapter-ownership-split)                                          |
| Requests, questions, approvals                | [Architecture §8](aos-runtime-gateway-architecture.md#8-requests)                                                                                |
| REST byte planes, limits                      | [Architecture §9](aos-runtime-gateway-architecture.md#9-rest-byte-planes)                                                                        |
| Read state, activity                          | [Architecture §10](aos-runtime-gateway-architecture.md#10-read-state-focus-and-activity)                                                         |
| Invalidation signals                          | [Architecture §11](aos-runtime-gateway-architecture.md#11-invalidation-and-session-change-signals)                                               |
| Reconnect and replay                          | [Architecture §12](aos-runtime-gateway-architecture.md#12-reconnect-and-replay)                                                                  |
| Limits and backpressure                       | [Architecture §13](aos-runtime-gateway-architecture.md#13-limits-and-backpressure)                                                               |
| Configuration and secrets                     | [Architecture §14](aos-runtime-gateway-architecture.md#14-configuration-and-secrets)                                                             |
| Errors                                        | [Architecture §16](aos-runtime-gateway-architecture.md#16-errors)                                                                                |
| Tests and invariants                          | [Architecture §17–18](aos-runtime-gateway-architecture.md#17-tests-that-enforce-the-boundaries)                                                  |
| Hermes lifecycle detail                       | [`src/adapters/hermes/README.md`](../../src/adapters/hermes/README.md), [`TURN-LIFECYCLE.md`](../../src/adapters/hermes/TURN-LIFECYCLE.md)       |
| Adapter obligations, five lifetimes           | [`docs/development/runtime-adapter-authoring.md`](../development/runtime-adapter-authoring.md)                                                   |
| Full wire table                               | [`docs/protocol.md`](../protocol.md)                                                                                                             |

## Research basis

V1 was designed in this document (original version) against the Hermes
dashboard API. The retrospective is in
[aos-ui's Hermes V1 retrospective](https://github.com/AlmogBaku/aos-ui/blob/main/docs/development/hermes-v1-retrospective.md).
