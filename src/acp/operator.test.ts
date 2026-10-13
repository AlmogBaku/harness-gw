import { methods, RequestError } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { type SessionHistoryResponse } from "../../protocol"
import {
  HGW_METHODS,
  HGW_META_KEY,
  HGW_REPLAY_BEFORE,
  HGW_REPLAY_POSITION,
  HgwActivityNotificationSchema,
} from "../../protocol/acp"
import {
  ChildSessionStatus,
  PendingRequestKind,
  RepliesTurnInputSchema,
  TurnEventKind,
  type TurnEvent,
} from "../core/events"
import { providerSessionId, sessionId } from "../core/ids"
import { CHILD_FOLLOW_GRACE_MS } from "../core/limits"
import type { ServerTurnListener } from "../core/runtime"
import { useFakeClock } from "../../test/support/fake-clock"
import { createActivityFeed } from "./activity-feed"
import { createReadState } from "./read-state"
import {
  AGENT,
  CAPABILITIES as HARNESS_CAPABILITIES,
  CREATED,
  endedTurn,
  EventSource,
  NOW,
  SESSION,
  harness as acpHarness,
  open,
  prompt,
  sessionRow,
  settled,
  turnStarted,
  updates,
  type HarnessOptions as AcpHarnessOptions,
  type Recorder,
} from "./test-harness"
import * as translators from "./translate"

/**
 * The operator listener end to end in process: the real translators, the real ACP
 * agent, and the real Session coordinator, read state, Session rows, and
 * activity feed, composed exactly as `createOperatorAcpService` composes one
 * accepted connection, against a fake provider engine and an SDK client.
 */

const CLARIFY = "clarify-1"

/** The shared harness's provider, with a Todo projection and a deny choice. */
const CAPABILITIES = {
  ...HARNESS_CAPABILITIES,
  workspace: {
    ...HARNESS_CAPABILITIES.workspace,
    todos: {
      status: "available",
      scope: "session",
      mode: "read-only-projection",
      source: "latest-completed-todo-tool-result",
    },
  },
  interactions: {
    ...HARNESS_CAPABILITIES.interactions,
    approvals: {
      ...HARNESS_CAPABILITIES.interactions.approvals,
      choices: [
        { value: "once", scope: "request" },
        { value: "deny", scope: "request" },
      ],
    },
  },
}

const HISTORY: SessionHistoryResponse = {
  sessionId: SESSION,
  messages: [
    {
      id: "message-user",
      role: "user",
      content: [{ type: "text", text: "Summarize the notes" }],
      createdAt: NOW,
    },
    {
      id: "message-agent",
      role: "assistant",
      content: [{ type: "text", text: "Here they are" }],
      createdAt: NOW,
    },
  ],
  total: 2,
  limit: 500,
  offset: 0,
  nextOffset: 0,
}

/**
 * A clock and a manual scheduler: the read-state debounce runs only when the
 * test advances past it, so exposure never depends on wall time.
 */
function createClock(startMs: number) {
  const tasks = new Map<number, { at: number; run: () => void }>()
  let current = startMs
  let handles = 0
  return {
    now: () => current,
    pending: () => tasks.size,
    schedule(run: () => void, delayMs: number) {
      handles += 1
      tasks.set(handles, { at: current + delayMs, run })
      // Read state only hands the handle back to `cancel`, never to a timer.
      return handles as unknown as ReturnType<typeof setTimeout>
    },
    cancel(handle: ReturnType<typeof setTimeout>) {
      tasks.delete(handle as unknown as number)
    },
    advance(byMs: number) {
      current += byMs
      const due = [...tasks].sort(([, left], [, right]) => left.at - right.at)
      for (const [handle, task] of due)
        if (task.at <= current) {
          tasks.delete(handle)
          task.run()
        }
    },
  }
}

type HarnessOptions = Pick<
  AcpHarnessOptions,
  | "rows"
  | "maxSubscriberEvents"
  | "permission"
  | "question"
  | "translation"
  | "childHistory"
  | "forks"
  | "subscribeTurns"
  | "respondChild"
  | "stopChild"
> & { history?: SessionHistoryResponse }

async function harness({ history, ...options }: HarnessOptions = {}) {
  const clock = createClock(Date.parse(NOW))
  const test = await acpHarness({
    ...options,
    capabilities: CAPABILITIES,
    history: (history ?? HISTORY).messages,
    translators,
    now: clock.now,
    pagesHistory: false,
    // An operator who never answers declines, which the listener cancels.
    question: options.question ?? (async () => ({ action: "decline" })),
    compose: ({ runtimeInstance, catalog }) => ({
      readState: createReadState({
        catalog,
        relighting: runtimeInstance.runtime.translation?.relighting,
        now: clock.now,
        schedule: clock.schedule,
        cancel: clock.cancel,
        onUnreadChanged: () => undefined,
      }),
      activityFeed: createActivityFeed({
        catalog,
        coordinator: runtimeInstance.sessions,
        now: clock.now,
      }),
    }),
  })
  return {
    ...test,
    clock,
    prompt: (text: string) =>
      test.agent.request(methods.agent.session.prompt, {
        sessionId: CREATED,
        prompt: [{ type: "text", text }],
        _meta: { [HGW_META_KEY]: {} },
      }),
  }
}

type Harness = Awaited<ReturnType<typeof harness>>

/** Creates a Session, admits one turn, and returns the segment the engine opened. */
async function runningTurn(test: Harness, text: string) {
  await test.create()
  const accepted = await test.prompt(text)
  await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
  const source = test.sources[0]
  if (!source) throw new Error("The engine opened no run segment")
  return {
    source,
    messageId: accepted.messageId,
  }
}

/**
 * The one `elicitation/create` request the client received. An elicitation the
 * SDK rejects never arrives at all: the attachment reports the rejection as
 * `_hgw/error`, so this waits for whichever came first and names it.
 */
async function askedElicitation(test: Harness) {
  const asked = await test.recorder.wait(
    (entry) =>
      entry.method === methods.client.elicitation.create ||
      entry.method === HGW_METHODS.notify.error,
    "the question or the error rejecting it"
  )
  expect(asked.method).toBe(methods.client.elicitation.create)
  return asked
}

/** Run-stream updates only: `session/new` pushes commands and usage out of band. */
function turnUpdates(recorder: Recorder) {
  return updates(recorder).filter((update) => {
    const text = JSON.stringify(update)
    return (
      !text.includes("available_commands_update") &&
      !text.includes("usage_update")
    )
  })
}

/** The window readings the browser received; only a settled turn owes it one. */
function usageUpdates(recorder: Recorder) {
  return updates(recorder).filter((update) =>
    JSON.stringify(update).includes("usage_update")
  )
}

function unreadChanges(recorder: Recorder) {
  return recorder.of(HGW_METHODS.notify.activity).flatMap(({ params }) => {
    const parsed = HgwActivityNotificationSchema.safeParse(params)
    return parsed.success && parsed.data.type === "unread-changed"
      ? [parsed.data]
      : []
  })
}

/** The Session the seeded row names, as the coordinator and the routes see it. */
const SCOPE = {
  agentId: AGENT,
  providerSessionId: providerSessionId(SESSION),
  sessionId: sessionId(SESSION),
}

/**
 * A steered run this connection does not own: the coordinator holds it for a
 * REST subscriber, so a later resume replays its journal from the first event.
 * Each accepted steer publishes the `aos.steer.accepted` the browser owes.
 */
async function steeredRun(test: Harness, corrections: readonly string[]) {
  await test.coordinator.start(
    SCOPE,
    {
      turnId: "run-live",
      messageId: "message-user",
      prompt: "Summarize the notes",
    },
    {
      membershipId: "rest",
      principalId: "operator",
    }
  )
  const source = test.sources[0]
  if (!source) throw new Error("The engine opened no run segment")
  source.emit(turnStarted())
  await vi.waitFor(() => expect(test.coordinator.state(SCOPE)).toBe("running"))
  for (const [index, text] of corrections.entries())
    await test.coordinator.steer(SCOPE, {
      requestId: `steer-${index + 1}`,
      expectedTurnId: "run-live",
      text,
    })
  return source
}

/** History whose last user turn is the correction Hermes persisted mid-turn. */
function correctedHistory(text: string): SessionHistoryResponse {
  return {
    ...HISTORY,
    messages: [
      HISTORY.messages[0]!,
      {
        id: "message-correction",
        role: "user",
        content: [{ type: "text", text }],
        createdAt: NOW,
        correction: true as const,
      },
    ],
  }
}

/** Waits for the live delta that follows the replay, so a drop is observable. */
async function drainedReplay(test: Harness, source: EventSource) {
  source.emit({
    kind: TurnEventKind.MessageChunk,
    messageId: "assistant-live",
    text: "Live",
  })
  await test.recorder.wait(
    (entry) => JSON.stringify(entry.params).includes("Live"),
    "an update carrying Live"
  )
}

/** The steers a turn took, as the user messages its stream showed them as. */
function steerAccepted(recorder: Recorder) {
  const Steer = z.object({
    sessionId: z.string(),
    update: z.object({
      sessionUpdate: z.literal("user_message"),
      messageId: z.string(),
      content: z.tuple([z.object({ text: z.string() })]),
      _meta: z.object({
        [HGW_META_KEY]: z.object({ turnId: z.string(), delivery: z.string() }),
      }),
    }),
  })
  return updates(recorder).flatMap((params) => {
    const steer = Steer.safeParse(params)
    if (!steer.success) return []
    const { sessionId, update } = steer.data
    return [
      {
        sessionId,
        ...update._meta[HGW_META_KEY],
        requestId: update.messageId,
        text: update.content[0].text,
      },
    ]
  })
}

function turnEnded(): TurnEvent {
  return { kind: TurnEventKind.TurnEnded }
}

/**
 * The clarification Hermes raises: one question interrupt asking a single
 * choice, a multi-select, and a free-text question. An adapter that knows which
 * tool call is asking names it.
 */
function turnQuestioned(toolCallId?: string): TurnEvent {
  return {
    kind: TurnEventKind.TurnRequiresAction,
    requests: [
      {
        requestId: CLARIFY,
        kind: PendingRequestKind.Elicitation,
        message: "3 questions require answers",
        ...(toolCallId === undefined ? {} : { toolCallId }),
        questions: [
          {
            text: "Which environment?",
            choices: ["staging", "production"],
            multiple: false,
            custom: true,
          },
          {
            text: "Which services?",
            choices: ["api", "worker", "web"],
            multiple: true,
            custom: true,
          },
          {
            text: "Anything else to watch?",
            choices: [],
            multiple: true,
            custom: true,
          },
        ],
      },
    ],
  }
}

describe("operator ACP listener", () => {
  it("rebuilds from history a run its stream was dropped from", async () => {
    // One event of queue, so the burst below outruns the send the pump awaits.
    const test = await harness({ maxSubscriberEvents: 1 })
    const { source } = await runningTurn(test, "Summarize")
    await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("usage_update"),
      "an update carrying usage_update"
    )

    source.emit(turnStarted())
    for (const delta of ["one", "two", "three", "four"])
      source.emit({
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: delta,
      })
    source.emit(turnEnded())

    // The view is owed the Session as standard updates, from history, closed
    // by the state the Session is in.
    await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes('"state":"idle"'),
      "the closing state"
    )
    const shown = turnUpdates(test.recorder).map(
      ({ update }) => update.sessionUpdate
    )
    expect(shown.slice(shown.indexOf("user_message"))).toEqual([
      "user_message",
      "user_message",
      "agent_message",
      "agent_message_chunk",
      "state_update",
    ])
    // A dropped stream is not an outcome: the run failed nowhere, the turn this
    // browser half-saw does not end in it, and the window it did not read stays
    // at the one reading the Session opened with.
    expect(test.recorder.of(HGW_METHODS.notify.error)).toEqual([])
    expect(JSON.stringify(turnUpdates(test.recorder))).not.toContain("end_turn")
    expect(usageUpdates(test.recorder)).toHaveLength(1)
    test.close()
  })

  // ACP scopes a question to its Session and, optionally, to the tool call
  // that asked it, so a client can show it on that call.
  it("names the tool call that asked a question", async () => {
    const test = await harness()
    const { source } = await runningTurn(test, "Clarify it")

    source.emit(turnStarted())
    source.emit(turnQuestioned("call-clarify"))

    const asked = await askedElicitation(test)
    expect(asked.params).toMatchObject({
      sessionId: CREATED,
      toolCallId: "call-clarify",
      _meta: { [HGW_META_KEY]: { requestId: CLARIFY } },
    })
    source.finish()
    test.close()
  })

  // ACP v2 child Sessions: the parent announces each child it owns before any
  // traffic of the child's, which reaches the client under the child's id.
  it("announces a child before its events, which reach the client as the child's own", async () => {
    const test = await harness()
    const { source } = await runningTurn(test, "Review it")

    source.emit(turnStarted())
    source.emit({
      kind: TurnEventKind.ChildSessionUpdated,
      childSessionId: "child-1",
      toolCallId: "call-spawn",
      title: "Review the notes",
      status: ChildSessionStatus.Running,
    })
    source.emit({
      kind: TurnEventKind.ChildSessionEvent,
      childSessionId: "child-1",
      event: {
        kind: TurnEventKind.MessageChunk,
        messageId: "child-message",
        text: "Reading",
      },
    })

    await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("Reading"),
      "the child's message"
    )
    const childish = updates(test.recorder).filter((params) =>
      JSON.stringify(params).includes("child-1")
    )
    expect(childish).toMatchObject([
      {
        sessionId: CREATED,
        update: {
          sessionUpdate: "subagent_update",
          sessionId: "child-1",
          title: "Review the notes",
          state: { state: "running" },
          _meta: { [HGW_META_KEY]: { toolCallId: "call-spawn" } },
        },
      },
      {
        sessionId: "child-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "child-message",
          content: { type: "text", text: "Reading" },
        },
      },
    ])
    source.finish()
    test.close()
  })

  it("asks a child's approval on the child, and its answer continues the parent's turn", async () => {
    const test = await harness({
      permission: async () => ({
        outcome: { outcome: "selected", optionId: "once" },
      }),
    })
    const { source } = await runningTurn(test, "Review it")

    source.emit(turnStarted())
    source.emit({
      kind: TurnEventKind.ChildSessionUpdated,
      childSessionId: "child-1",
      title: "Review the notes",
    })
    source.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [
        {
          requestId: "child-approval",
          kind: PendingRequestKind.Permission,
          childSessionId: "child-1",
          message: "Read the notes?",
          responseSchema: { enum: ["once", "deny"] },
        },
      ],
    })
    source.finish()

    const asked = await test.recorder.wait(
      (entry) => entry.method === methods.client.session.requestPermission,
      "the child's approval"
    )
    expect(asked.params).toMatchObject({ sessionId: "child-1" })
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    expect(
      RepliesTurnInputSchema.parse(test.start.mock.calls[1]?.[1]).replies
    ).toMatchObject([{ requestId: "child-approval", status: "resolved" }])
    test.close()
  })

  // Only the Session that announced a child speaks for it: another Session
  // naming that child is shown nothing under the child's id.
  it("shows another Session's events and asks naming a child under that child's id never", async () => {
    const test = await harness({
      permission: async () => ({
        outcome: { outcome: "selected", optionId: "once" },
      }),
    })
    const { source: owner } = await runningTurn(test, "Review it")
    owner.emit(turnStarted())
    owner.emit({
      kind: TurnEventKind.ChildSessionUpdated,
      childSessionId: "child-1",
    })
    await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("subagent_update"),
      "the child's announcement"
    )
    await open(test, { _meta: { [HGW_META_KEY]: { agentId: AGENT } } })
    await prompt(test, "Other work", SESSION)
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    const other = test.sources[1]!

    other.emit(turnStarted())
    other.emit({
      kind: TurnEventKind.ChildSessionEvent,
      childSessionId: "child-1",
      event: {
        kind: TurnEventKind.MessageChunk,
        messageId: "stray",
        text: "Speaking for another's child",
      },
    })
    other.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [
        {
          requestId: "stray-approval",
          kind: PendingRequestKind.Permission,
          childSessionId: "child-1",
          message: "Read the notes?",
          responseSchema: { enum: ["once", "deny"] },
        },
      ],
    })

    const asked = await test.recorder.wait(
      (entry) => entry.method === methods.client.session.requestPermission,
      "the stray approval"
    )
    expect(asked.params).toMatchObject({ sessionId: SESSION })
    expect(JSON.stringify(test.recorder.entries)).not.toContain(
      "Speaking for another's child"
    )
    owner.finish()
    other.finish()
    test.close()
  })

  // A client cancels a child's work with session/cancel naming the child, only
  // where the child's capabilities offer it; a notification answers nothing.
  it.each([
    [true, ["child-1"]],
    [false, []],
  ])(
    "cancels a child through the Session that owns it only where the runtime stops it alone (%s)",
    async (cancellable, stopped) => {
      const test = await harness()
      const { source } = await runningTurn(test, "Review it")
      const stopChild = vi.fn<(childSessionId: string) => Promise<void>>(
        async () => undefined
      )
      Object.assign(source, { stopChild })
      source.emit(turnStarted())
      source.emit({
        kind: TurnEventKind.ChildSessionUpdated,
        childSessionId: "child-1",
        cancellable,
      })
      await test.recorder.wait(
        (entry) => JSON.stringify(entry.params).includes("subagent_update"),
        "the child's announcement"
      )

      await test.agent.notify(methods.agent.session.cancel, {
        sessionId: "child-1",
      })

      await vi.waitFor(() =>
        expect(stopChild.mock.calls.map(([id]) => id)).toEqual(stopped)
      )
      // The parent's own work runs on.
      expect(source.stop).not.toHaveBeenCalled()
      source.finish()
      test.close()
    }
  )

  // ACP permits a client nothing on a child its capabilities do not name, and
  // no ordinary Session's method: each is a method not available.
  it("refuses every request naming a child as a method not available", async () => {
    const test = await harness({ forks: true })
    const { source } = await runningTurn(test, "Review it")
    source.emit(turnStarted())
    source.emit({
      kind: TurnEventKind.ChildSessionUpdated,
      childSessionId: "child-1",
    })
    await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("subagent_update"),
      "the child's announcement"
    )
    const child = { sessionId: "child-1" }
    // Every request that names a Session, from the method tables, so one
    // added later fails here until it is refused for a child too. A cancel
    // is a notification, which answers nothing, and is tested on its own.
    const named: Record<string, Record<string, unknown>> = {
      [methods.agent.session.resume]: { ...child, cwd: "/" },
      [methods.agent.session.fork]: { ...child, cwd: "/" },
      [methods.agent.session.prompt]: {
        ...child,
        prompt: [{ type: "text", text: "Hi" }],
      },
      [methods.agent.session.close]: child,
      [methods.agent.session.delete]: child,
      [methods.agent.session.setConfigOption]: {
        ...child,
        configId: "model",
        type: "id",
        value: "opus",
      },
      [HGW_METHODS.session.update]: { ...child, title: "Renamed" },
      [HGW_METHODS.session.focus]: child,
      [HGW_METHODS.session.part]: child,
      [HGW_METHODS.session.steer]: { ...child, requestId: "s", text: "Hi" },
    }
    const unnamed = new Set<string>([
      methods.agent.session.new,
      methods.agent.session.list,
      methods.agent.session.cancel,
    ])
    expect(Object.keys(named).sort()).toEqual(
      [
        ...Object.values(methods.agent.session),
        ...Object.values(HGW_METHODS.session),
      ]
        .filter((method) => !unnamed.has(method))
        .sort()
    )

    for (const [method, params] of [
      ...Object.entries(named),
      // An older page names its Session as a resume does.
      [
        methods.agent.session.resume,
        {
          ...child,
          cwd: "/",
          replayFrom: { type: HGW_REPLAY_BEFORE, cursor: "MA" },
        },
      ],
    ] as [string, Record<string, unknown>][])
      await expect(
        test.agent.request(method, params),
        method
      ).rejects.toMatchObject({
        code: RequestError.methodNotFound("").code,
        data: { method },
      })
    source.finish()
    test.close()
  })

  // ACP: a child is announced before any traffic of its own, and a child id
  // is never a top-level Session's.
  it("shows nothing of a child unannounced, or of one that names a top-level Session", async () => {
    const test = await harness()
    const { source } = await runningTurn(test, "Review it")
    const said = (text: string) => ({
      kind: TurnEventKind.MessageChunk,
      messageId: "child-message",
      text,
    })

    source.emit(turnStarted())
    source.emit({
      kind: TurnEventKind.ChildSessionEvent,
      childSessionId: "early-child",
      event: said("Too early"),
    })
    // CREATED is the parent itself; SESSION is a row the catalog lists.
    for (const childSessionId of [CREATED, SESSION]) {
      source.emit({ kind: TurnEventKind.ChildSessionUpdated, childSessionId })
      source.emit({
        kind: TurnEventKind.ChildSessionEvent,
        childSessionId,
        event: said("Posing as a top-level Session"),
      })
    }
    source.emit({
      kind: TurnEventKind.MessageChunk,
      messageId: "parent-message",
      text: "Parent goes on",
    })

    await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("Parent goes on"),
      "the parent's own message"
    )
    const shown = JSON.stringify(test.recorder.entries)
    expect(shown).not.toContain("Too early")
    expect(shown).not.toContain("Posing as a top-level Session")
    expect(shown).not.toContain("subagent_update")
    source.finish()
    test.close()
  })

  // ACP's parent goes idle while background work goes on: a child still at
  // work after its turn ended reports under its own id, between turns, and
  // its requests and its cancel reach the runtime without any turn.
  describe("a child that outlives its parent's turn", () => {
    async function outlived() {
      let listener: ServerTurnListener | undefined
      const unsubscribed = vi.fn()
      const respondChild = vi.fn<
        NonNullable<AcpHarnessOptions["respondChild"]>
      >(async () => undefined)
      const stopChild = vi.fn<NonNullable<AcpHarnessOptions["stopChild"]>>(
        async () => undefined
      )
      const test = await harness({
        subscribeTurns: (_scope, subscribed) => {
          listener = subscribed
          return unsubscribed
        },
        respondChild,
        stopChild,
        permission: async () => ({
          outcome: { outcome: "selected", optionId: "once" },
        }),
      })
      const { source } = await runningTurn(test, "Review it")
      source.emit(turnStarted())
      source.emit({
        kind: TurnEventKind.ChildSessionUpdated,
        childSessionId: "child-1",
        title: "Review the notes",
        status: ChildSessionStatus.Running,
        cancellable: true,
      })
      source.emit({ kind: TurnEventKind.TurnEnded })
      source.finish()
      await test.recorder.wait(endedTurn, "the parent turn's end")
      await vi.waitFor(() => expect(listener).toBeDefined())
      const turnId = z
        .object({ turnId: z.string() })
        .parse(test.start.mock.calls[0]?.[1]).turnId
      // The runtime reports the child that outlives the turn with its state.
      listener!.onChild!(turnId, {
        kind: TurnEventKind.ChildSessionUpdated,
        childSessionId: "child-1",
        status: ChildSessionStatus.Running,
      })
      return {
        test,
        listener: listener!,
        turnId,
        respondChild,
        stopChild,
        unsubscribed,
      }
    }

    it("streams its updates under its id while its parent is idle, at no position in the parent's turn", async () => {
      const { test, listener, turnId } = await outlived()

      listener.onChild!(turnId, {
        kind: TurnEventKind.ChildSessionEvent,
        childSessionId: "child-1",
        event: {
          kind: TurnEventKind.MessageChunk,
          messageId: "child-message",
          text: "Still working.",
        },
      })
      listener.onChild!(turnId, {
        kind: TurnEventKind.ChildSessionUpdated,
        childSessionId: "child-1",
        status: ChildSessionStatus.Idle,
      })
      await test.recorder.wait(
        (entry) =>
          JSON.stringify(entry.params).includes('"state":"idle"') &&
          JSON.stringify(entry.params).includes("subagent_update"),
        "the child's final report"
      )

      const shown = updates(test.recorder)
      const chunk = shown.find(
        ({ sessionId, update }) =>
          sessionId === "child-1" &&
          update.sessionUpdate === "agent_message_chunk"
      )
      expect(chunk?.update._meta).toMatchObject({
        [HGW_META_KEY]: { turnId, background: true },
      })
      expect(
        shown
          .filter(
            ({ sessionId, update }) =>
              sessionId === CREATED &&
              update.sessionUpdate === "subagent_update"
          )
          .at(-1)?.update
      ).toMatchObject({
        sessionId: "child-1",
        state: { state: "idle", stopReason: "end_turn" },
      })
      test.close()
    })

    it("asks its request on it between turns, and answers it through the runtime", async () => {
      const { test, listener, turnId, respondChild } = await outlived()

      listener.onChildRequest!(turnId, {
        requestId: "late-approval",
        kind: PendingRequestKind.Permission,
        childSessionId: "child-1",
        message: "Read the notes?",
        responseSchema: { enum: ["once", "deny"] },
      })

      const asked = await test.recorder.wait(
        (entry) => entry.method === methods.client.session.requestPermission,
        "the child's late approval"
      )
      expect(asked.params).toMatchObject({ sessionId: "child-1" })
      await vi.waitFor(() =>
        expect(respondChild).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: sessionId(CREATED) }),
          expect.objectContaining({
            requestId: "late-approval",
            status: "resolved",
          })
        )
      )
      // Its parent ran no turn for it.
      expect(test.start).toHaveBeenCalledTimes(1)
      test.close()
    })

    // A reload or a reconnect leaves the Session unwatched for a moment: the
    // child is followed through it, and the browser back reads how it is now.
    it("keeps following it while its only viewer reconnects, and restates it to the viewer back", async () => {
      const { test, listener, turnId, unsubscribed } = await outlived()
      test.close()
      listener.onChild!(turnId, {
        kind: TurnEventKind.ChildSessionUpdated,
        childSessionId: "child-1",
        status: ChildSessionStatus.Idle,
        summary: "Notes reviewed.",
      })

      const asked = test.discover.mock.calls.length
      const back = await test.connect("connection-2")
      await back.list()
      await back.agent.request(methods.agent.session.resume, {
        sessionId: CREATED,
        cwd: "/",
        replayFrom: { type: HGW_REPLAY_POSITION },
      })
      // A turn the runtime started meanwhile had no member to adopt it as.
      await vi.waitFor(() =>
        expect(test.discover.mock.calls.length).toBeGreaterThan(asked)
      )
      const restated = await back.recorder.wait(
        (entry) =>
          JSON.stringify(entry.params).includes("subagent_update") &&
          JSON.stringify(entry.params).includes('"state":"idle"'),
        "the child's report restated"
      )

      expect(restated.params).toMatchObject({
        sessionId: CREATED,
        update: {
          sessionUpdate: "subagent_update",
          sessionId: "child-1",
          state: { state: "idle", stopReason: "end_turn" },
          _meta: {
            [HGW_META_KEY]: {
              turnId,
              background: true,
              summary: "Notes reviewed.",
            },
          },
        },
      })
      expect(unsubscribed).not.toHaveBeenCalled()
      back.close()
    })

    it("stops following it once nobody comes back within the grace", async () => {
      const { test, unsubscribed } = await outlived()
      const clock = useFakeClock()
      test.close()
      await clock.advance(CHILD_FOLLOW_GRACE_MS - 1)
      expect(unsubscribed).not.toHaveBeenCalled()

      await clock.advance(1)
      expect(unsubscribed).toHaveBeenCalledTimes(1)
    })

    // Restating a child long over would announce it to a view that may not
    // hold its turn, as if it had just been spawned.
    it("tells a member who joins later of no child over for longer than the grace", async () => {
      const { test, listener, turnId } = await outlived()
      const clock = useFakeClock()
      listener.onChild!(turnId, {
        kind: TurnEventKind.ChildSessionUpdated,
        childSessionId: "child-1",
        status: ChildSessionStatus.Idle,
      })
      await clock.advance(CHILD_FOLLOW_GRACE_MS)

      const later = await test.connect("connection-2")
      await later.list()
      await later.agent.request(methods.agent.session.resume, {
        sessionId: CREATED,
        cwd: "/",
        replayFrom: { type: HGW_REPLAY_POSITION },
      })
      await clock.advance(0)

      expect(JSON.stringify(later.recorder.entries)).not.toContain("child-1")
      later.close()
      test.close()
    })

    it("cancels it between turns through the runtime", async () => {
      const { test, stopChild } = await outlived()

      await test.agent.notify(methods.agent.session.cancel, {
        sessionId: "child-1",
      })

      await vi.waitFor(() =>
        expect(stopChild).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: sessionId(CREATED) }),
          "child-1"
        )
      )
      test.close()
    })
  })

  // ACP replays a child through its parent's from-start resume: the child's
  // announcement, then the child's own updates, under its id.
  it("replays a stored child Session from the start: its announcement, then its transcript", async () => {
    const childHistory = vi.fn(async (): Promise<SessionHistoryResponse> => ({
      sessionId: "child-1",
      messages: [
        {
          id: "child-message",
          role: "assistant",
          content: [{ type: "text", text: "Two notes were stale" }],
          createdAt: NOW,
        },
      ],
      total: 1,
      limit: 500,
      offset: 0,
      nextOffset: 0,
    }))
    const test = await harness({
      childHistory,
      history: {
        ...HISTORY,
        messages: [
          ...HISTORY.messages,
          {
            id: "child-row",
            role: "activity",
            activityType: "CHILD_SESSION",
            content: {
              childSessionId: "child-1",
              title: "Review the notes",
              status: "idle",
            },
          },
        ],
      },
    })

    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: "start" },
      _meta: { [HGW_META_KEY]: { agentId: AGENT } },
    })
    await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("Two notes were stale"),
      "the child's transcript"
    )

    const childish = updates(test.recorder).filter((params) =>
      JSON.stringify(params).includes("child-")
    )
    expect(
      childish.map(({ sessionId, update }) => [sessionId, update.sessionUpdate])
    ).toEqual([
      [SESSION, "subagent_update"],
      ["child-1", "agent_message"],
      ["child-1", "agent_message_chunk"],
    ])
    expect(childHistory).toHaveBeenCalledWith(AGENT, SESSION, "child-1")
    test.close()
  })

  // A child's own transcript names its children as the parent's names it:
  // each is announced under the child that owns it, by the same checks.
  it("replays a child's own children under it, refusing one that names a top-level Session or the child itself", async () => {
    const row = (childSessionId: string) => ({
      id: `row-${childSessionId}`,
      role: "activity" as const,
      activityType: "CHILD_SESSION" as const,
      content: { childSessionId, title: `Posing as ${childSessionId}` },
    })
    const test = await harness({
      childHistory: async () => ({
        sessionId: "child-1",
        messages: [row("grandchild-1"), row(SESSION), row("child-1")],
        total: 3,
        limit: 500,
        offset: 0,
        nextOffset: 0,
      }),
      history: {
        ...HISTORY,
        messages: [...HISTORY.messages, row("child-1")],
      },
    })

    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: "start" },
      _meta: { [HGW_META_KEY]: { agentId: AGENT } },
    })
    await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("grandchild-1"),
      "the grandchild's announcement"
    )
    await settled()

    expect(
      updates(test.recorder).flatMap(({ sessionId, update }) =>
        update.sessionUpdate === "subagent_update"
          ? [[sessionId, update.sessionId]]
          : []
      )
    ).toEqual([
      [SESSION, "child-1"],
      ["child-1", "grandchild-1"],
    ])
    // Announced, the grandchild is a child no request may name.
    await expect(
      test.agent.request(HGW_METHODS.session.focus, {
        sessionId: "grandchild-1",
      })
    ).rejects.toMatchObject({ code: RequestError.methodNotFound("").code })
    test.close()
  })

  // A reconnect is a new connection, which knows no child: one announced
  // before its cursor is announced again ahead of the events after it.
  it("announces a child again to a positioned reconnect, then streams the child's events after the cursor", async () => {
    const test = await harness()
    const { source } = await runningTurn(test, "Review it")
    const said = (text: string) => ({
      kind: TurnEventKind.ChildSessionEvent,
      childSessionId: "child-1",
      event: {
        kind: TurnEventKind.MessageChunk,
        messageId: "child-message",
        text,
      },
    })
    source.emit(turnStarted())
    source.emit({
      kind: TurnEventKind.ChildSessionUpdated,
      childSessionId: "child-1",
      title: "Review the notes",
      status: ChildSessionStatus.Running,
    })
    source.emit(said("Before the drop"))
    await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("Before the drop"),
      "the child's first words"
    )
    const { turnId } = test.coordinator.snapshot(test.scope)
    const cursor = Math.max(
      ...updates(test.recorder).flatMap(({ update }) => {
        const sequence = (
          update as { _meta?: { hgw?: { sequence?: unknown } } }
        )._meta?.hgw?.sequence
        return typeof sequence === "number" ? [sequence] : []
      })
    )

    const reconnected = await test.connect("connection-2")
    await reconnected.list()
    await reconnected.agent.request(methods.agent.session.resume, {
      sessionId: CREATED,
      cwd: "/",
      replayFrom: { type: HGW_REPLAY_POSITION, turnId, from: cursor + 1 },
    })
    source.emit(said("After the drop"))
    await reconnected.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("After the drop"),
      "the child's words after the cursor"
    )

    const childish = updates(reconnected.recorder).filter((params) =>
      JSON.stringify(params).includes("child-1")
    )
    expect(childish).toMatchObject([
      {
        sessionId: CREATED,
        update: { sessionUpdate: "subagent_update", title: "Review the notes" },
      },
      {
        sessionId: "child-1",
        update: { sessionUpdate: "agent_message_chunk" },
      },
    ])
    expect(JSON.stringify(reconnected.recorder.entries)).not.toContain(
      "Before the drop"
    )
    source.finish()
    test.close()
    reconnected.close()
  })

  it("delivers a multi-select question the SDK accepts", async () => {
    const test = await harness({
      question: async () => ({
        action: "accept",
        content: {
          q0: "production",
          q1: ["api", "the nightly billing job"],
          q2: "watch the queue depth",
        },
      }),
    })
    const { source } = await runningTurn(test, "Clarify it")

    source.emit(turnStarted())
    source.emit(turnQuestioned())
    source.finish()

    await askedElicitation(test)

    // Every answer resumes the run, including the choice no question offered.
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    const resumed = RepliesTurnInputSchema.parse(test.start.mock.calls[1]?.[1])
    expect(resumed.replies).toEqual([
      {
        requestId: CLARIFY,
        status: "resolved",
        payload: {
          answers: [
            ["production"],
            ["api", "the nightly billing job"],
            ["watch the queue depth"],
          ],
        },
      },
    ])
    test.close()
  })

  // The operator's stack masks every runtime's tool data on its way out.
  it("masks a credential in a tool call the operator is shown", async () => {
    const test = await harness()
    const { source } = await runningTurn(test, "Deploy it")
    const secret = ["token", "abcdefgh1234"].join("=")

    source.emit(turnStarted())
    source.emit({
      kind: TurnEventKind.ToolCallStarted,
      toolCallId: "call-3",
      title: `deploy --${secret}`,
    })
    source.finish()

    const shown = await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("call-3"),
      "the tool call"
    )
    expect(shown.params).toMatchObject({
      update: { title: "deploy --token=[credential redacted]" },
    })
    expect(JSON.stringify(test.recorder.entries)).not.toContain(secret)
    test.close()
  })

  it("records the answers on the tool call that asked them", async () => {
    const test = await harness({
      question: async () => ({
        action: "accept",
        content: { q0: "production", q1: ["api", "web"], q2: "the queue" },
      }),
    })
    const { source } = await runningTurn(test, "Clarify it")

    source.emit(turnStarted())
    source.emit(turnQuestioned("call-9"))
    source.finish()

    const recorded = await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("tool_call_update"),
      "an update carrying tool_call_update"
    )
    expect(recorded.params).toMatchObject({
      sessionId: CREATED,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-9",
        status: "completed",
        rawOutput: {
          status: "answered",
          responses: [
            { question: "Which environment?", answers: ["production"] },
            { question: "Which services?", answers: ["api", "web"] },
            { question: "Anything else to watch?", answers: ["the queue"] },
          ],
        },
      },
    })
    test.close()
  })

  it("acknowledges the focused Session's read state once the debounce elapses", async () => {
    const test = await harness({ rows: [sessionRow({ unread: true })] })
    await test.list()
    await test.recorder.wait(
      () => unreadChanges(test.recorder).length > 0,
      "the Session's unread change"
    )
    expect(unreadChanges(test.recorder)).toMatchObject([{ unread: true }])

    await test.agent.request(HGW_METHODS.session.focus, { sessionId: SESSION })
    await vi.waitFor(() => expect(test.clock.pending()).toBe(1))
    test.clock.advance(500)

    await vi.waitFor(() =>
      expect(test.updateSession).toHaveBeenCalledWith(AGENT, SESSION, {
        unread: false,
      })
    )
    expect(test.updateSession).toHaveBeenCalledTimes(1)
    await test.recorder.wait(
      () => unreadChanges(test.recorder).length === 2,
      "the Session's read change"
    )
    expect(unreadChanges(test.recorder)[1]).toMatchObject({
      agentId: AGENT,
      sessionId: SESSION,
      type: "unread-changed",
      unread: false,
    })
    test.close()
  })

  it("replays history before answering the resume of an idle Session", async () => {
    const test = await harness()

    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: "start" },
      _meta: { [HGW_META_KEY]: { agentId: AGENT } },
    })

    // The stored turn replays as its messages, each from empty content, and no
    // state it passed; the Session's own state closes it.
    expect(updates(test.recorder).slice(0, 5)).toMatchObject([
      {
        sessionId: SESSION,
        update: {
          sessionUpdate: "user_message",
          messageId: "message-user",
          content: [{ type: "text", text: "Summarize the notes" }],
        },
      },
      {
        sessionId: SESSION,
        update: {
          sessionUpdate: "agent_message",
          messageId: "message-agent",
          content: [],
        },
      },
      {
        sessionId: SESSION,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message-agent",
          content: { type: "text", text: "Here they are" },
        },
      },
      {
        sessionId: SESSION,
        update: { sessionUpdate: "state_update", state: "idle" },
      },
    ])
    expect(JSON.stringify(updates(test.recorder))).not.toContain(
      '"state":"running"'
    )
    test.close()
  })

  it("announces a persisted correction once on a from-start resume", async () => {
    const test = await harness({
      history: correctedHistory("Use the tables"),
      translation: { steerAck: "in-history" },
    })
    const source = await steeredRun(test, ["Use the tables"])

    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: "start" },
      _meta: { [HGW_META_KEY]: { agentId: AGENT } },
    })
    await drainedReplay(test, source)

    expect(
      turnUpdates(test.recorder).filter((update) =>
        JSON.stringify(update).includes("Use the tables")
      )
    ).toMatchObject([
      {
        sessionId: SESSION,
        update: {
          sessionUpdate: "user_message",
          messageId: "message-correction",
          content: [{ type: "text", text: "Use the tables" }],
        },
      },
    ])
    expect(steerAccepted(test.recorder)).toEqual([])
    test.close()
  })

  it("announces the correction history could not carry yet", async () => {
    const test = await harness({
      history: correctedHistory("Use the tables"),
      translation: { steerAck: "in-history" },
    })
    const source = await steeredRun(test, ["Use the tables", "And the totals"])

    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: "start" },
      _meta: { [HGW_META_KEY]: { agentId: AGENT } },
    })
    await drainedReplay(test, source)

    expect(steerAccepted(test.recorder)).toMatchObject([
      {
        sessionId: SESSION,
        turnId: "run-live",
        requestId: "steer-2",
        text: "And the totals",
        delivery: "steered",
      },
    ])
    test.close()
  })

  it("forwards every acknowledgement to a cursor resume, which replays no history", async () => {
    const test = await harness({ history: correctedHistory("Use the tables") })
    const source = await steeredRun(test, ["Use the tables", "And the totals"])

    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: HGW_REPLAY_POSITION, turnId: "run-live", from: 1 },
      _meta: { [HGW_META_KEY]: { agentId: AGENT } },
    })
    await drainedReplay(test, source)

    expect(steerAccepted(test.recorder).map((params) => params)).toMatchObject([
      { requestId: "steer-1", text: "Use the tables" },
      { requestId: "steer-2", text: "And the totals" },
    ])
    test.close()
  })
})
