import { Command, CommanderError } from "commander"

import { createInvitationLink, type InviteFlags } from "./invite"
import { loadServeConfig, serveProxy } from "./serve"
import type { ProxyCliDependencies, ProxyLifecycle } from "./types"

export async function runProxyCli(
  argv: string[],
  dependencies: ProxyCliDependencies
): Promise<ProxyLifecycle | undefined> {
  let result: ProxyLifecycle | undefined
  const writeOut =
    dependencies.writeOut ?? ((value: string) => process.stdout.write(value))
  const command = new Command()
    .name("harness-gw")
    .description(
      "Serve the harness gateway and create restricted guest invitations"
    )
    .exitOverride()
    .configureOutput({
      writeOut,
      writeErr:
        dependencies.writeErr ??
        ((value: string) => process.stderr.write(value)),
    })

  command
    .command("serve")
    .description("Run the gateway")
    .option(
      "--config <path>",
      "configuration file; discovered under XDG_CONFIG_HOME when omitted"
    )
    .action(async ({ config }: { config?: string }) => {
      result = await serveProxy({ config }, dependencies)
    })

  command
    .command("config")
    .description("Inspect the gateway configuration")
    .command("check")
    .description(
      "Validate the configuration file and its overrides, then exit; secret files are read only at start"
    )
    .option(
      "--config <path>",
      "configuration file; discovered under XDG_CONFIG_HOME when omitted"
    )
    .action(async ({ config }: { config?: string }) => {
      await loadServeConfig({ config }, dependencies)
      writeOut("configuration is valid\n")
    })

  command
    .command("invite")
    .usage("--agent NAME [flags]")
    .description("Create an expiring guest invitation")
    .addHelpText(
      "after",
      `
The command runs locally and does not contact the native runtime. Keep the printed link
private: it is a reusable bearer credential until it expires.

Examples:
  harness-gw invite --config /etc/harness-gw/config.yaml --agent interviewer \
    --expires-in 72h --prefill "Hey, Almog sent me here!" \
    --instruction "Load the interview skill for Dan." --lang en

  harness-gw invite --agent interviewer --ref returning-guest \
    --instruction "Continue the scheduled interview."
`
    )
    .option("--config <path>", "proxy configuration file (required)")
    .requiredOption("--agent <name>", "Native Agent ID (required)")
    .option(
      "--ref <reference>",
      "Stable conversation reference; generated when omitted"
    )
    .option("--expires-in <duration>", "Invitation lifetime", "72h")
    .option("--prefill <text>", "Editable first-message draft")
    .option("--instruction <text>", "Inline first-turn Agent instruction")
    .option("--lang <language>", "Default UI language: en or he")
    .option("--name <name>", "Guest header brand name")
    .option("--logo <url>", "HTTPS guest brand logo URL")
    .option("--accent <color>", "Guest accent color, for example #2563eb")
    .option("--title <title>", "Conversation title")
    .option("--message <text>", "Visible welcome note")
    .action(async (flags: InviteFlags) => {
      const link = await createInvitationLink(flags, dependencies)
      writeOut(`${link}\n`)
    })

  try {
    await command.parseAsync(argv)
    return result
  } catch (error) {
    if (
      error instanceof CommanderError &&
      error.code === "commander.helpDisplayed"
    )
      return undefined
    throw error
  }
}
