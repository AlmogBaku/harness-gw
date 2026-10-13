/**
 * What OpenClaw tells of the child Sessions a run spawns: the `sessions_spawn`
 * call that spawns one, the result that names it, and its row's state. Pure
 * readers; the run engine confirms, announces and follows each child.
 */
import { ChildSessionStatus } from "../../core/events"
import { validIdentifier } from "../../core/identifier"

/** The native tool a run spawns a child Session with. */
export const SPAWN_TOOL = "sessions_spawn"

/** How deep OpenClaw nests spawns by default; nothing deeper is followed. */
export const MAX_SPAWN_DEPTH = 5

/** The most a child's title or goal carries, as its history row bounds it. */
const MAX_CHILD_TEXT = 65_536
const MAX_MODEL = 256

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function identifier(value: unknown) {
  return typeof value === "string" && validIdentifier(value) ? value : undefined
}

function bounded(value: unknown, max: number) {
  if (typeof value !== "string") return undefined
  const text = value.trim()
  return text && text.length <= max ? text : undefined
}

/** The JSON the result's text part carries, as OpenClaw's JSON results do. */
function textJson(result: Record<string, unknown>) {
  const content = Array.isArray(result.content) ? result.content : []
  const text = content
    .map((part) => {
      const item = record(part)
      return item?.type === "text" && typeof item.text === "string"
        ? item.text
        : ""
    })
    .join("")
  try {
    return record(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** A child Session's key, and the run its spawn started there. */
export type SpawnedChild = Readonly<{ key: string; runId?: string }>

/**
 * The child Session a `sessions_spawn` result names: `{status: "accepted",
 * childSessionKey, runId}`, as the result's `details` or the JSON of its text.
 * A spawn OpenClaw refused names none.
 */
export function spawnedChild(result: unknown): SpawnedChild | undefined {
  const outcome = record(result)
  if (!outcome) return undefined
  for (const candidate of [
    record(outcome.details),
    outcome,
    textJson(outcome),
  ]) {
    if (candidate?.status !== "accepted") continue
    const key = identifier(candidate.childSessionKey)
    if (!key) continue
    const runId = identifier(candidate.runId)
    return runId ? { key, runId } : { key }
  }
  return undefined
}

/** The Agent a Session key names, `agent:<agentId>:…`. */
export function keyAgentId(key: string) {
  return /^agent:([^:]+):/u.exec(key)?.[1]
}

/**
 * Why a child's own `sessions.list` row does not confirm it as a child
 * `parentKey`'s call spawned, under `agentId`, or `undefined` when it does:
 * its `spawnedBy` names that parent, its Agent is that one, and it is no
 * deeper than OpenClaw nests. Such a row is a spawn's, so no top-level
 * Session has its key. `depth` is how deep it is when its row does not say.
 */
export function childRowRefusal(
  row: Readonly<{ spawnedBy?: string; agentId?: string; spawnDepth?: number }>,
  parentKey: string,
  agentId: string,
  depth: number
) {
  if (row.spawnedBy !== parentKey) return "child-foreign-parent"
  if (row.agentId !== undefined && row.agentId !== agentId)
    return "child-foreign-agent"
  if ((row.spawnDepth ?? depth) > MAX_SPAWN_DEPTH) return "child-too-deep"
  return undefined
}

/**
 * What a child's announcement tells of it, from the arguments of the call
 * that spawned it: its label or task as its title, its task as its goal, and
 * the model it was asked to run on. The credentials middleware masks them.
 */
export function spawnFacts(args: unknown) {
  const call = record(args)
  const task = bounded(call?.task, MAX_CHILD_TEXT)
  const title = bounded(call?.label, MAX_CHILD_TEXT) ?? task
  const model = bounded(call?.model, MAX_MODEL)
  return {
    ...(title === undefined ? {} : { title }),
    ...(task === undefined ? {} : { description: task }),
    ...(model === undefined ? {} : { model }),
  }
}

/** A child's row `status` (`SessionRowSchema.status`) as its state. */
export function childRowStatus(
  status: unknown
): ChildSessionStatus | undefined {
  switch (status) {
    case "queued":
    case "running":
      return ChildSessionStatus.Running
    case "done":
      return ChildSessionStatus.Idle
    case "failed":
    case "timeout":
      return ChildSessionStatus.Failed
    case "interrupted":
    case "killed":
      return ChildSessionStatus.Cancelled
    default:
      return undefined
  }
}
