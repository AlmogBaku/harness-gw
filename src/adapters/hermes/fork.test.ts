import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useFakeClock } from "../../../test/support/fake-clock"
import { captureLogs } from "../../../test/support/log-capture"
import { StopReason, TurnEventKind, type TurnEvent } from "../../core/events"
import { stubUnreachableTransports, until } from "../../core/runtime-contract"
import { composeHermesRuntime } from "./factory"
import { fakeHermes, fakeHermesGateway } from "./test-utils/fake-hermes"

/** The Hermes runtime over its fake, as the contracts compose it. */
function hermesRuntime() {
  const hermes = fakeHermes()
  const { logger } = captureLogs()
  const { runtime, close } = composeHermesRuntime({
    transport: fakeHermesGateway(hermes, logger),
    logger,
    sessionIdleMs: 300_000,
  })
  return { hermes, runtime, close }
}

describe("Hermes typed branch over its fake", () => {
  beforeEach(stubUnreachableTransports)
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(["/branch", "/fork"])(
    "forks a typed %s as the fork action does, leaving the original as it was",
    async (text) => {
      const clock = useFakeClock()
      const { hermes, runtime, close } = hermesRuntime()
      const { scope } = hermes
      try {
        // A settled turn, so the Session has something to branch.
        const first = await until(
          clock,
          runtime.turns.start(scope, {
            turnId: "turn-1",
            messageId: "user-1",
            prompt: "List the files",
          })
        )
        const drained = Array.fromAsync(first.events)
        await hermes.progress()
        await hermes.finish()
        await until(clock, drained)
        await until(clock, first.settled)

        const handle = await until(
          clock,
          runtime.turns.start(scope, {
            turnId: "turn-2",
            messageId: "user-2",
            prompt: text,
          })
        )
        const events: TurnEvent[] = []
        await until(
          clock,
          (async () => {
            for await (const event of handle.events) events.push(event)
          })()
        )

        // It answers like any command that completes: an agent message naming
        // the new Session, the turn ended cleanly, and no stored prompt row.
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: TurnEventKind.MessageChunk,
            text: 'Forked this Session into "Contract Session #2" (fork-1).',
          })
        )
        const ended = events.at(-1)
        expect(ended).toMatchObject({ kind: TurnEventKind.TurnEnded })
        expect(
          ended?.kind === TurnEventKind.TurnEnded ? ended.stopReason : "none"
        ).toBeOneOf([undefined, StopReason.EndTurn])
        expect(handle.stored).toBeUndefined()
        // The slash worker, whose `/branch` ends the original, never ran.
        expect(hermes.branches()).toHaveLength(1)
        expect(hermes.received()).not.toContain("slash.exec")
        expect(hermes.received()).not.toContain("command.dispatch")
        await expect(
          until(
            clock,
            runtime.getSession(scope.agentId, scope.providerSessionId)
          )
        ).resolves.toMatchObject({ id: scope.sessionId })
        const listed = await until(
          clock,
          runtime.listSessions(scope.agentId, 100, 0)
        )
        expect(listed.sessions.map(({ id }) => id)).toEqual(
          expect.arrayContaining([scope.sessionId, "fork-1"])
        )
      } finally {
        await close()
      }
    }
  )
})
