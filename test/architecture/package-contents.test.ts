import { execFileSync, spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as clientSource from "../../client/index"
import * as protocolSource from "../../protocol/sdk"

const root = join(import.meta.dirname, "../..")
const manifest = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8")
) as {
  name: string
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
}

let consumer: string
let files: string[]

/**
 * The imports, as `<specifier> from <declaration>`, that `tsc
 * --traceResolution` could not resolve from inside the installed package.
 */
function unresolvedImports(trace: string, packageName: string) {
  const unresolved: string[] = []
  let from = ""
  for (const line of trace.split("\n")) {
    const resolving = /^=+ Resolving module '(.+)' from '(.+)'\. =+$/u.exec(
      line
    )
    if (resolving) from = resolving[2]!
    const failed = /^=+ Module name '(.+)' was not resolved\. =+$/u.exec(line)
    if (failed && from.includes(`/node_modules/${packageName}/`)) {
      unresolved.push(`${failed[1]} from ${from.split(`/${packageName}/`)[1]}`)
    }
  }
  return unresolved
}

/**
 * Builds and packs the package, then installs the tarball into a throwaway
 * consumer: the package extracted under `node_modules`, and its dependencies
 * and peers linked from this checkout so no network is needed.
 */
beforeAll(() => {
  consumer = mkdtempSync(join(tmpdir(), "hgw-consumer-"))
  execFileSync("bun", ["run", "build"], { cwd: root, stdio: "pipe" })
  const [pack] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", consumer], {
      cwd: root,
      encoding: "utf8",
    })
  ) as [{ filename: string; files: { path: string }[] }]
  files = pack.files.map(({ path }) => path).sort()

  const installed = join(consumer, "node_modules", manifest.name)
  mkdirSync(installed, { recursive: true })
  execFileSync("tar", [
    "-xzf",
    join(consumer, pack.filename),
    "-C",
    installed,
    "--strip-components=1",
  ])
  for (const name of Object.keys({
    ...manifest.dependencies,
    ...manifest.peerDependencies,
  })) {
    const link = join(consumer, "node_modules", name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(join(root, "node_modules", name), link)
  }
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" })
  )
})

afterAll(() => rmSync(consumer, { recursive: true, force: true }))

describe("@harness-gw/sdk package", () => {
  /**
   * Only the two built entry points, their shared chunk, and their types ship:
   * no source, test, test helper, gateway code, or example.
   */
  it("ships the built entries and their types, and nothing else", () => {
    expect(files.filter((path) => path.endsWith(".js"))).toEqual([
      "dist/chunks/index.js",
      "dist/client/index.js",
      "dist/protocol/sdk.js",
    ])
    expect(files.filter((path) => !path.startsWith("dist/"))).toEqual([
      "LICENSE",
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

  /**
   * The bundle keeps every value its entry exports. Bun before 1.4.1 drops a
   * module an entry re-exports by name from a side-effect-free package, which
   * is why `sideEffects` names the two entries.
   */
  it.each([
    ["client/index.js", clientSource],
    ["protocol/sdk.js", protocolSource],
  ])("dist/%s exports every value its source does", async (entry, source) => {
    const built = (await import(
      pathToFileURL(
        join(consumer, "node_modules", manifest.name, "dist", entry)
      ).href
    )) as object
    expect(Object.keys(built).sort()).toEqual(Object.keys(source).sort())
  })

  /**
   * The declarations resolve under Node's own ESM resolution as well as a
   * bundler's. An import a declaration cannot resolve reads as `any` rather
   * than an error, so the trace is searched for one, and a few entry types
   * are held to not being `any`. Checking the libraries' own declarations
   * would add seconds and prove nothing about this package.
   */
  it.each([
    ["nodenext", "nodenext"],
    ["bundler", "esnext"],
  ])("typechecks for a %s consumer", (moduleResolution, module) => {
    writeFileSync(
      join(consumer, "index.ts"),
      [
        `import { HgwRemoteClient, type AcpConnection, type Logger } from "${manifest.name}"`,
        `import { type HgwInitializeMeta } from "${manifest.name}/protocol"`,
        "type IsAny<T> = 0 extends 1 & T ? true : false",
        "export const resolved: [",
        "  IsAny<AcpConnection>, IsAny<Logger>, IsAny<HgwInitializeMeta>, IsAny<HgwRemoteClient>",
        "] = [false, false, false, false]",
      ].join("\n")
    )
    writeFileSync(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module,
          moduleResolution,
          target: "es2022",
          lib: ["es2024", "esnext.disposable", "dom"],
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        files: ["index.ts"],
      })
    )
    const tsc = spawnSync(
      join(root, "node_modules/.bin/tsc"),
      ["-p", consumer, "--traceResolution"],
      { encoding: "utf8" }
    )
    expect(
      tsc.stdout.split("\n").filter((line) => /error TS/u.test(line))
    ).toEqual([])
    expect(unresolvedImports(tsc.stdout, manifest.name)).toEqual([])
    expect(tsc.status).toBe(0)
  })
})
