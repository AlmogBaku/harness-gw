import { readdirSync } from "node:fs"
import { dirname, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const adapterRoot = resolve(projectRoot, "src/adapters")
const adapters = new Set(
  readdirSync(adapterRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
)
const portable = (path) => path.split(sep).join("/")

/** The server adapter a file belongs to, if any. */
function adapterOf(filename) {
  const [name] = portable(relative(adapterRoot, filename)).split("/")
  return adapters.has(name) ? name : undefined
}

/** One server adapter never reaches into another; what they share lives above them. */
const rule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      crossAdapter:
        "Server adapters must not import one another ({{from}} → {{to}}). Share through src/core or src/adapters instead.",
    },
  },
  create(context) {
    const owner = adapterOf(context.filename)
    if (!owner) return {}
    function check(source, node) {
      const specifier =
        source?.type === "Literal"
          ? source.value
          : source?.type === "TemplateLiteral" &&
              source.expressions.length === 0
            ? source.quasis[0]?.value.cooked
            : undefined
      if (typeof specifier !== "string" || !specifier.startsWith(".")) return
      const target = adapterOf(
        resolve(dirname(context.filename), specifier.split(/[?#]/u)[0])
      )
      if (target && target !== owner)
        context.report({
          node,
          messageId: "crossAdapter",
          data: { from: owner, to: target },
        })
    }
    return {
      ImportDeclaration: (node) => check(node.source, node),
      ExportNamedDeclaration: (node) => check(node.source, node),
      ExportAllDeclaration: (node) => check(node.source, node),
      ImportExpression: (node) => check(node.source, node),
      TSImportType: (node) =>
        check(node.source ?? node.argument?.literal ?? node.argument, node),
    }
  },
}

export default { rules: { "adapter-boundaries": rule } }
