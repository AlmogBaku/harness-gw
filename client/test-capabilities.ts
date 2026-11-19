import { INTERACTION_PROTOCOL } from "../protocol"

import type { HgwWorkspaceCapabilities } from "./hgw-client"

type Capabilities = HgwWorkspaceCapabilities

const unavailable = { status: "unavailable", reason: "not-supported" } as const

/**
 * A Session's capability snapshot as `session/resume` reports it: every
 * capability unavailable except the ones a test names. Approvals and
 * questions have no unavailable form, so each test names its own.
 */
export function sessionCapabilities({
  workspace,
  interactions,
  content,
}: {
  workspace?: Partial<Capabilities["workspace"]>
  interactions: Pick<Capabilities["interactions"], "approvals" | "questions"> &
    Partial<Capabilities["interactions"]>
  content?: Partial<Capabilities["content"]>
}): Capabilities {
  return {
    workspace: {
      slashCommands: unavailable,
      models: unavailable,
      context: unavailable,
      todos: unavailable,
      activity: unavailable,
      ...workspace,
    },
    interactions: {
      steering: unavailable,
      rewind: { status: "available", scope: "user-turn" },
      reactions: unavailable,
      ...interactions,
    },
    content: {
      attachments: unavailable,
      artifacts: unavailable,
      mcpApps: unavailable,
      transcription: unavailable,
      speech: unavailable,
      ...content,
    },
  }
}

/**
 * A Session that reports its models and context, and takes steering, Edit
 * and Retry, approvals, and questions.
 */
export function composerCapabilities(): Capabilities {
  return sessionCapabilities({
    workspace: {
      models: {
        status: "available",
        scope: "session",
        selection: "native-session",
        choices: "provider-reported",
      },
      context: {
        status: "available",
        scope: "session",
        source: "provider-usage-or-estimate",
        breakdown: "provider-categories",
      },
    },
    interactions: {
      steering: {
        status: "available",
        scope: "active-turn",
        semantics: "visible-user-message",
        input: "text",
        fallback: "provider-queue",
      },
      rewind: { status: "available", scope: "user-turn" },
      approvals: {
        status: "available",
        protocol: INTERACTION_PROTOCOL,
        scope: "turn",
        choices: [{ value: "once", scope: "request" }],
        maxPending: 8,
      },
      questions: {
        status: "available",
        protocol: INTERACTION_PROTOCOL,
        scope: "turn",
        answerModes: ["single", "multiple", "free-text"],
        cancellation: "native-empty-answer",
        maxQuestions: 8,
        maxChoicesPerQuestion: 8,
        maxAnswerValuesPerQuestion: 8,
        maxStringBytes: 4_096,
      },
    },
  })
}
