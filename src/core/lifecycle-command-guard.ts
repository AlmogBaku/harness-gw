import { CommandRefusedError, type Middleware } from "./member"

/** Leading whitespace, and the invisible characters `trimStart` keeps. */
export const LEADING_PADDING = /^[\s\u200B\u2060\uFEFF]+/u

/**
 * The commands that end or switch a Session. The client runs them itself; sent
 * as a prompt, a runtime would run one on the Session every member shares.
 */
const LIFECYCLE_COMMANDS: ReadonlySet<string> = new Set([
  "/new",
  "/reset",
  "/clear",
  "/resume",
  "/sessions",
  "/quit",
  "/exit",
])

/**
 * Whether `text` opens with a lifecycle command, in any case and however
 * padded: its first word is the command's name exactly, so `/resetx` is not.
 */
function opensLifecycleCommand(text: string) {
  const [name = ""] = text.replace(LEADING_PADDING, "").split(/\s/u, 1)
  return LIFECYCLE_COMMANDS.has(name.toLowerCase())
}

function refuseLifecycleCommand(texts: readonly string[]) {
  if (texts.some(opensLifecycleCommand))
    throw new CommandRefusedError(
      "invalid",
      "Session commands run in the client, not as a prompt."
    )
}

/**
 * Refuses a send or a steer whose text, or any text part, opens with a command
 * that ends or switches the Session. Every other command passes unchanged.
 */
export function createLifecycleCommandGuard(): Middleware {
  return {
    commands: {
      send: async (command, next) => {
        refuseLifecycleCommand([
          command.text,
          ...command.content.flatMap((part) =>
            part.kind === "text" ? [part.text] : []
          ),
        ])
        return next(command)
      },
      steer: async (command, next) => {
        refuseLifecycleCommand([command.text])
        return next(command)
      },
    },
  }
}
