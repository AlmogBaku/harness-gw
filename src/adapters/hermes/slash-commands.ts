import {
  MAX_SLASH_COMMANDS,
  SlashCommandSchema,
  type SlashCommand,
} from "../../../protocol"
import {
  HermesRpcRejectedError,
  HermesUnavailableError,
  type HermesRpcTransport,
} from "./gateway"
import { isRecord } from "./native"

const MAX_CATALOG_RESPONSE_BYTES = 2_097_152
const MAX_COMMAND_RESPONSE_BYTES = 1_048_576

/** The catalog category holding the TUI's own extras, which run only there. */
const TUI_CATEGORY = "TUI"

/** Where AOS takes a native command: listed, typed only, or not at all. */
type SlashDisposition = "offered" | "hidden" | "dropped"

/**
 * What AOS reads of Hermes' `commands.catalog`. `commands` holds each
 * command's surface by its `/name`, aliases included; a skill or a quick
 * command may have none. `tui` names the TUI category's commands. A catalog
 * without either says nothing about where a command runs.
 */
type NativeCatalog = {
  pairs: readonly unknown[]
  canon: Readonly<Record<string, unknown>> | undefined
  commands: Readonly<Record<string, unknown>>
  tui: ReadonlySet<string>
}

async function nativeCatalog(
  transport: HermesRpcTransport,
  params: Readonly<Record<string, unknown>>
): Promise<NativeCatalog> {
  const value = await transport.request("commands.catalog", params, {
    maxResponseBytes: MAX_CATALOG_RESPONSE_BYTES,
  })
  if (!isRecord(value) || !Array.isArray(value.pairs))
    throw new Error("Invalid Hermes command catalog")
  const { canon, commands, categories } = value
  if (canon !== undefined && !isRecord(canon))
    throw new Error("Invalid Hermes command catalog")
  return {
    pairs: value.pairs,
    canon,
    commands: isRecord(commands) ? commands : {},
    tui: tuiCommands(categories),
  }
}

/** The command names the catalog's TUI category lists, if it has one. */
function tuiCommands(categories: unknown): ReadonlySet<string> {
  const tui = Array.isArray(categories)
    ? categories.find(
        (category) => isRecord(category) && category.name === TUI_CATEGORY
      )
    : undefined
  const pairs = isRecord(tui) && Array.isArray(tui.pairs) ? tui.pairs : []
  return new Set(
    pairs.flatMap((pair) =>
      Array.isArray(pair) && typeof pair[0] === "string" ? [pair[0]] : []
    )
  )
}

/**
 * Where AOS takes the command `name`, by Hermes' own `desktop` disposition: a
 * command whose surface is elsewhere (`terminal`, `messaging`, `advanced`,
 * `settings`, `composer-voice`) or that the TUI adds of its own is dropped; a
 * `hidden` one runs when typed but is not listed. A name the catalog says
 * nothing about, such as a skill, is offered.
 */
function disposition(catalog: NativeCatalog, name: string): SlashDisposition {
  const key = `/${name}`
  if (catalog.tui.has(key)) return "dropped"
  const entry = Object.hasOwn(catalog.commands, key)
    ? catalog.commands[key]
    : undefined
  const desktop = isRecord(entry) ? entry.desktop : undefined
  if (desktop === "hidden") return "hidden"
  return typeof desktop === "string" ? "dropped" : "offered"
}

function parsedSlashInvocation(text: string) {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/u.exec(text)
  if (!match) return undefined
  return { name: match[1]!, args: match[2]?.trim() ?? "" }
}

/** The commands AOS lists: every offered one, in catalog order. */
export async function nativeSlashCommands(
  transport: HermesRpcTransport,
  params: Readonly<Record<string, unknown>>
): Promise<SlashCommand[]> {
  const catalog = await nativeCatalog(transport, params)
  const commands: SlashCommand[] = []
  const seen = new Set<string>()
  for (const pair of catalog.pairs) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string"
    )
      continue
    const parsed = SlashCommandSchema.safeParse({
      name: pair[0].replace(/^\//u, ""),
      description:
        typeof pair[1] === "string" ? pair[1].slice(0, 4_096) : pair[1],
    })
    if (
      !parsed.success ||
      seen.has(parsed.data.name) ||
      disposition(catalog, parsed.data.name) !== "offered"
    )
      continue
    seen.add(parsed.data.name)
    commands.push(parsed.data)
    if (commands.length === MAX_SLASH_COMMANDS) break
  }
  return commands
}

/**
 * The native command `text` invokes, under its catalog name, or `undefined`
 * when it names none. A `dropped` one is recognized only to be refused.
 */
export async function nativeSlashInvocation(
  transport: HermesRpcTransport,
  params: Readonly<Record<string, unknown>>,
  text: string
) {
  const invocation = parsedSlashInvocation(text)
  if (!invocation) return undefined
  const catalog = await nativeCatalog(transport, params)
  const { pairs, canon } = catalog
  const invoking = (name: string) => ({
    ...invocation,
    name,
    disposition: disposition(catalog, name),
  })
  const canonicalKey = `/${invocation.name}`.toLowerCase()
  const canonicalValue =
    canon && Object.hasOwn(canon, canonicalKey)
      ? canon[canonicalKey]
      : undefined
  if (canonicalValue !== undefined) {
    const canonical = SlashCommandSchema.safeParse({
      name:
        typeof canonicalValue === "string"
          ? canonicalValue.replace(/^\//u, "")
          : canonicalValue,
    })
    if (!canonical.success) throw new Error("Invalid Hermes command catalog")
    return invoking(canonical.data.name)
  }
  const recognized = pairs.find((pair): pair is [string, ...unknown[]] => {
    if (!Array.isArray(pair) || typeof pair[0] !== "string") return false
    const command = SlashCommandSchema.safeParse({
      name: pair[0].replace(/^\//u, ""),
    })
    return (
      command.success &&
      command.data.name.toLowerCase() === invocation.name.toLowerCase()
    )
  })
  if (!recognized) return undefined
  return invoking(recognized[0].replace(/^\//u, ""))
}

/**
 * What one native command execution produced. A `completion` answered the user
 * in band and no native turn follows; an `expanded` execution produced the
 * prompt text the caller submits, which is the only part a refused write may
 * repeat.
 */
export type HermesSlashExecution =
  | { kind: "completion"; output: string; composerPrefill?: string }
  | { kind: "expanded"; text: string }

/**
 * Execute one recognized native command and report what it produced; the
 * expansion is submitted by the caller, so this function performs no
 * `prompt.submit` of its own. `slash.exec` is the current native entry point;
 * `command.dispatch` is attempted only when Hermes states the method is
 * unsupported, and alias traversal is bounded. No dispatched write is ever
 * retried.
 */
export async function executeSlashCommand(
  transport: HermesRpcTransport,
  liveSessionId: string,
  name: string,
  args: string,
  signal?: AbortSignal,
  depth = 0
): Promise<HermesSlashExecution> {
  if (depth >= 4) throw new HermesUnavailableError()
  const options = { signal, maxResponseBytes: MAX_COMMAND_RESPONSE_BYTES }
  let result: unknown
  try {
    result = await transport.request(
      "slash.exec",
      {
        command: `${name}${args ? ` ${args}` : ""}`,
        session_id: liveSessionId,
      },
      options
    )
  } catch (error) {
    if (
      !(error instanceof HermesRpcRejectedError) ||
      (error.code !== -32601 && error.code !== 4018)
    )
      throw error
    result = await transport.request(
      "command.dispatch",
      { session_id: liveSessionId, name, arg: args },
      options
    )
  }
  if (!isRecord(result)) throw new HermesUnavailableError()
  if (result.type === "alias") {
    const target =
      typeof result.target === "string"
        ? /^\/?([^\s/]+)(?:\s+([\s\S]*))?$/u.exec(result.target)
        : undefined
    if (!target) throw new HermesUnavailableError()
    return executeSlashCommand(
      transport,
      liveSessionId,
      target[1]!,
      [target[2], args].filter(Boolean).join(" "),
      signal,
      depth + 1
    )
  }
  if (result.type === "send" || result.type === "skill") {
    if (typeof result.message !== "string" || !result.message.trim())
      throw new HermesUnavailableError()
    return { kind: "expanded", text: result.message }
  }
  if (result.type === "prefill") {
    if (
      typeof result.message !== "string" ||
      !result.message ||
      Buffer.byteLength(result.message, "utf8") > MAX_COMMAND_RESPONSE_BYTES ||
      (result.notice !== undefined && typeof result.notice !== "string")
    )
      throw new HermesUnavailableError()
    return {
      kind: "completion",
      output: typeof result.notice === "string" ? result.notice : "",
      composerPrefill: result.message,
    }
  }
  if (
    result.type !== "exec" &&
    result.type !== "plugin" &&
    typeof result.output !== "string" &&
    typeof result.warning !== "string"
  )
    throw new HermesUnavailableError()
  return {
    kind: "completion",
    output: [result.warning, result.output]
      .filter((value): value is string => typeof value === "string" && !!value)
      .join("\n"),
  }
}
