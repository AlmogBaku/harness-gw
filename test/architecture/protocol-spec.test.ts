// @vitest-environment node

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  HGW_ATTACHMENT_URI_SCHEME,
  HGW_AUTH_METHOD_INVITE,
  HGW_METHODS,
  HGW_REPLAY_BEFORE,
  HGW_STOP_REASONS,
  HgwActivityNotificationSchema,
} from "../../protocol/acp"

const SPEC = join(import.meta.dirname, "../../docs/protocol.md")

/** Every string leaf of a nested constant map. */
function leaves(value: unknown): string[] {
  if (typeof value === "string") return [value]
  return Object.values(value as Record<string, unknown>).flatMap(leaves)
}

const ACTIVITY_TYPES = HgwActivityNotificationSchema.options.flatMap(
  (option) => {
    const type = option.shape.type
    return "options" in type ? type.options : [type.value]
  }
)

/** A host an example may name: reserved for documentation, or this machine. */
const SYNTHETIC_HOST =
  /(?:^|\.)(?:test|example\.com)$|^(?:localhost|127\.0\.0\.1)$/u

describe("docs/protocol.md", () => {
  it.each([
    ...leaves(HGW_METHODS),
    HGW_REPLAY_BEFORE,
    ...ACTIVITY_TYPES,
    HGW_AUTH_METHOD_INVITE,
    ...leaves(HGW_STOP_REASONS),
    HGW_ATTACHMENT_URI_SCHEME,
  ])("names %s", async (name) => {
    expect(await readFile(SPEC, "utf8")).toContain(`\`${name}\``)
  })

  it("holds no token and no real host in its examples", async () => {
    const spec = await readFile(SPEC, "utf8")
    expect(spec).not.toMatch(/eyJ[\w-]{8,}/u)
    const blocks = [...spec.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gmu)].map(
      ([, body]) => body!
    )
    const hosts = blocks.flatMap((body) =>
      [...body.matchAll(/(?:https?|wss?):\/\/([^/\s"'`:?#]+)/giu)].map(
        ([, host]) => host!
      )
    )
    expect(hosts.filter((host) => !SYNTHETIC_HOST.test(host))).toEqual([])
  })
})
