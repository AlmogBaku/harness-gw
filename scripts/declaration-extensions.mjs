/**
 * Gives every relative specifier in the emitted declarations the `.js` path
 * Node's ESM resolution needs. `tsc` keeps a declaration's specifiers as the
 * source wrote them, and the source imports extensionless (`"./types"`,
 * `"../protocol"`), which only `moduleResolution: bundler` resolves; a
 * `node16` or `nodenext` consumer needs `"./types.js"` and
 * `"../protocol/index.js"`. A specifier that names no emitted declaration
 * fails the build rather than ship a broken import.
 *
 * Usage: `bun scripts/declaration-extensions.mjs dist`
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import process from "node:process"

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.\.?\/[^"']*)\2/gu

/** The `.js` path `specifier` names, from the declaration at `file`. */
function withExtension(file, specifier) {
  if (specifier.endsWith(".js")) return specifier
  const target = join(dirname(file), specifier)
  if (existsSync(`${target}.d.ts`)) return `${specifier}.js`
  if (existsSync(join(target, "index.d.ts"))) return `${specifier}/index.js`
  throw new Error(
    `${relative(process.cwd(), file)}: "${specifier}" names no emitted declaration`
  )
}

const root = process.argv[2]
if (!root) throw new Error("usage: declaration-extensions.mjs <dist directory>")

for (const entry of readdirSync(root, { recursive: true })) {
  if (!entry.endsWith(".d.ts")) continue
  const file = join(root, entry)
  const text = readFileSync(file, "utf8")
  const rewritten = text.replace(
    SPECIFIER,
    (_match, keyword, quote, specifier) =>
      `${keyword}${quote}${withExtension(file, specifier)}${quote}`
  )
  if (rewritten !== text) writeFileSync(file, rewritten)
}
