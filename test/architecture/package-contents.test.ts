import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "../..")

/** The paths `npm pack` would put in the tarball, after a fresh build. */
function packedFiles() {
  execFileSync("bun", ["run", "build"], { cwd: root, stdio: "pipe" })
  const [pack] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8",
    })
  ) as [{ files: { path: string }[] }]
  return pack.files.map(({ path }) => path).sort()
}

describe("@harness-gw/sdk package", () => {
  /**
   * Only the two built entry points, their shared chunk, and their types ship:
   * no source, test, test helper, gateway code, or example.
   */
  it("ships the built entries and their types, and nothing else", () => {
    const files = packedFiles()

    expect(files.filter((path) => path.endsWith(".js"))).toEqual([
      "dist/chunks/index.js",
      "dist/client/index.js",
      "dist/protocol/sdk.js",
    ])
    expect(files.filter((path) => !path.startsWith("dist/"))).toEqual([
      "README.md",
      "package.json",
    ])
    const types = files.filter((path) => path.endsWith(".d.ts"))
    expect(types).toContain("dist/client/index.d.ts")
    expect(types).toContain("dist/protocol/sdk.d.ts")
    expect(
      types.filter(
        (path) =>
          !/^dist\/(?:client|protocol|lifecycle)\/[\w-]+\.d\.ts$/u.test(path) ||
          /(?:^|\/)test-|\.test\./u.test(path)
      )
    ).toEqual([])
    expect(
      files.filter(
        (path) =>
          path.startsWith("dist/") &&
          !path.endsWith(".js") &&
          !path.endsWith(".d.ts")
      )
    ).toEqual([])
  })
})
