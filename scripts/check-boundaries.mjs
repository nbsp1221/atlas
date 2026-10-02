import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import ts from "typescript"

const sdkPrefixes = [
  "googleapis",
  "@googleapis/",
  "grammy",
  "discord.js",
  "@slack/",
  "octokit",
  "@octokit/",
  "@notionhq/",
  "nango",
  "@nangohq/",
  "composio",
  "@composio/",
]
const rules = [
  {
    directory: "packages/automation-runtime",
    forbidden: [
      "packages/db",
      "packages/automations",
      "packages/automation-simulation",
      "packages/integrations",
      "packages/ui",
      "apps/api",
    ],
    sdks: true,
  },
  {
    directory: "packages/automations",
    forbidden: [
      "packages/db",
      "packages/automation-simulation",
      "packages/integrations",
    ],
    sdks: true,
  },
  {
    directory: "apps/web",
    source: "src",
    forbidden: [
      "packages/db",
      "packages/automation-runtime",
      "packages/automations",
      "packages/automation-simulation",
      "packages/integrations",
    ],
  },
  {
    directory: "packages/ui",
    source: "src",
    forbidden: [
      "packages/domain",
      "packages/db",
      "packages/automation-runtime",
      "packages/automations",
      "packages/automation-simulation",
      "packages/integrations",
    ],
  },
]
const extensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
])
const ignored = new Set(["node_modules", "dist", "build", "coverage"])
const inside = (directory, target) =>
  target === directory || target.startsWith(directory + path.sep)
const matches = (name, prefix) =>
  prefix.endsWith("/") || prefix.endsWith("-")
    ? name.startsWith(prefix)
    : name === prefix || name.startsWith(prefix + "/")

function files(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    // Never traverse hidden/generated directories or symlinks.
    if (
      entry.name.startsWith(".") ||
      ignored.has(entry.name) ||
      entry.isSymbolicLink()
    )
      return []
    const candidate = path.join(directory, entry.name)
    return entry.isDirectory()
      ? files(candidate)
      : extensions.has(path.extname(candidate))
        ? [candidate]
        : []
  })
}

function imports(file) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
  const result = []
  const add = (expression, node) => {
    const line =
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    result.push({
      specifier:
        expression && ts.isStringLiteralLike(expression)
          ? expression.text
          : null,
      line,
    })
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier, node)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression, node)
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      add(node.argument.literal, node)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      add(node.arguments[0], node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

// Local tsconfig inheritance only: external config packages and computed bundler
// aliases are outside this lightweight gate. Refuse unsupported inheritance rather
// than silently claiming those aliases were checked.
function configAliases(file, root, seen = new Set()) {
  const full = path.resolve(file)
  if (
    !inside(root, full) ||
    path
      .relative(root, full)
      .split(path.sep)
      .some((part) => part.startsWith(".") || ignored.has(part))
  ) {
    throw new Error("config outside readable source tree: " + file)
  }
  if (seen.has(full)) throw new Error("cyclic tsconfig inheritance: " + file)
  seen = new Set([...seen, full])
  const parsed = ts.parseConfigFileTextToJson(
    full,
    fs.readFileSync(full, "utf8")
  )
  if (parsed.error) throw new Error("invalid tsconfig: " + file)
  const config = parsed.config
  let inherited = { paths: {}, baseUrl: undefined }
  for (const parent of config.extends ? [config.extends].flat() : []) {
    if (!parent.startsWith("."))
      throw new Error("unsupported non-local tsconfig extends: " + parent)
    let target = path.resolve(path.dirname(full), parent)
    if (!target.endsWith(".json")) target += ".json"
    inherited = { ...inherited, ...configAliases(target, root, seen) }
  }
  const options = config.compilerOptions ?? {}
  const baseUrl =
    options.baseUrl === undefined
      ? inherited.baseUrl
      : path.resolve(path.dirname(full), options.baseUrl)
  const paths =
    options.paths === undefined
      ? inherited.paths
      : Object.fromEntries(
          Object.entries(options.paths).map(([key, values]) => [
            key,
            values.map((value) =>
              path.resolve(baseUrl ?? path.dirname(full), value)
            ),
          ])
        )
  return { paths, baseUrl }
}

function aliasesFor(directory, root) {
  const result = []
  // Include referenced app/node configs as well as tsconfig.json. Checking the
  // union is deliberately conservative when a package has multiple configurations.
  for (
    let current = directory;
    inside(root, current);
    current = path.dirname(current)
  ) {
    for (const name of fs.existsSync(current) ? fs.readdirSync(current) : []) {
      if (/^tsconfig(?:\.[\w-]+)?\.json$/.test(name)) {
        result.push(configAliases(path.join(current, name), root))
      }
    }
    if (current === root) break
  }
  return result
}

function aliasTargets(specifier, aliases) {
  const result = []
  for (const config of aliases) {
    const patterns = Object.keys(config.paths).sort(
      (a, b) => b.replace("*", "").length - a.replace("*", "").length
    )
    const key = patterns.find((pattern) => {
      if (!pattern.includes("*")) return pattern === specifier
      const [prefix, suffix] = pattern.split("*")
      return (
        specifier.startsWith(prefix) &&
        specifier.endsWith(suffix) &&
        specifier.length >= prefix.length + suffix.length
      )
    })
    if (key) {
      const [prefix, suffix = ""] = key.split("*")
      const capture = key.includes("*")
        ? specifier.slice(prefix.length, specifier.length - suffix.length)
        : ""
      result.push(
        ...config.paths[key].map((target) => target.replace("*", capture))
      )
    } else if (
      config.baseUrl &&
      !specifier.startsWith(".") &&
      !specifier.startsWith("node:")
    ) {
      result.push(path.resolve(config.baseUrl, specifier))
    }
  }
  return result
}

function manifests(root) {
  const result = []
  const visit = (directory) => {
    for (const entry of fs.existsSync(directory)
      ? fs.readdirSync(directory, { withFileTypes: true })
      : []) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".") ||
        ignored.has(entry.name)
      )
        continue
      const full = path.join(directory, entry.name)
      const file = path.join(full, "package.json")
      if (fs.existsSync(file))
        result.push({
          directory: full,
          file,
          manifest: JSON.parse(fs.readFileSync(file, "utf8")),
        })
      else if (entry.name === "integrations") visit(full)
    }
  }
  visit(path.join(root, "packages"))
  visit(path.join(root, "apps"))
  return result
}

export function checkBoundaries(root = process.cwd()) {
  root = path.resolve(root)
  const packages = manifests(root)
  const violations = []
  for (const rule of rules) {
    const directory = path.join(root, rule.directory)
    if (!fs.existsSync(directory)) continue
    const forbiddenPaths = rule.forbidden.map((name) => path.join(root, name))
    const forbiddenNames = packages
      .filter((pkg) =>
        forbiddenPaths.some((folder) => inside(folder, pkg.directory))
      )
      .map((pkg) => pkg.manifest.name)
    // Include not-yet-installed future provider packages as well.
    forbiddenNames.push("@workspace/integration-")
    if (rule.sdks) forbiddenNames.push(...sdkPrefixes)
    const forbiddenTarget = (target) =>
      forbiddenPaths.some((folder) => inside(folder, path.resolve(target)))
    const forbiddenName = (name) =>
      forbiddenNames.some((prefix) => matches(name, prefix))
    const pkg = packages.find((item) => item.directory === directory)
    const dependencies = {
      ...pkg?.manifest.dependencies,
      ...pkg?.manifest.optionalDependencies,
      ...pkg?.manifest.devDependencies,
      ...pkg?.manifest.peerDependencies,
    }
    const dependencyTarget = (value) => {
      if (typeof value !== "string") return undefined
      const local = /^(?:workspace:|file:|link:)(\.{1,2}\/.*)$/.exec(value)
      if (local) return path.resolve(directory, local[1])
    }
    const dependencyName = (name) => {
      const value = dependencies[name]
      // npm aliases and workspace package aliases must be checked by their target.
      const alias =
        typeof value === "string" &&
        /^(?:npm:|workspace:)((?:@[^/]+\/)?[^@]+)@/.exec(value)
      return alias ? alias[1] : name
    }
    for (const [name, value] of Object.entries(dependencies)) {
      if (
        forbiddenName(dependencyName(name)) ||
        (dependencyTarget(value) && forbiddenTarget(dependencyTarget(value)))
      ) {
        violations.push(
          `${path.relative(root, pkg.file)} declares forbidden dependency ${name}`
        )
      }
    }
    const aliases = aliasesFor(directory, root)
    for (const file of files(path.join(directory, rule.source ?? ""))) {
      for (const { specifier, line } of imports(file)) {
        const location = `${path.relative(root, file)}:${line}`
        if (specifier === null) {
          violations.push(
            `${location} has a non-literal import/require that cannot be boundary-checked`
          )
          continue
        }
        // Package.json #imports and arbitrary bundler aliases need an explicit
        // resolver before use; do not silently accept opaque private imports.
        if (specifier.startsWith("#")) {
          violations.push(
            `${location} uses unsupported package import alias ${specifier}`
          )
          continue
        }
        const targets =
          specifier.startsWith(".") || path.isAbsolute(specifier)
            ? [path.resolve(path.dirname(file), specifier)]
            : aliasTargets(specifier, aliases)
        for (const targetPackage of packages) {
          if (matches(specifier, targetPackage.manifest.name))
            targets.push(targetPackage.directory)
        }
        if (
          forbiddenName(specifier) ||
          forbiddenName(dependencyName(specifier)) ||
          targets.some(forbiddenTarget)
        ) {
          violations.push(
            `${location} imports forbidden dependency ${specifier}`
          )
        }
      }
    }
  }
  return violations
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const violations = checkBoundaries()
    if (violations.length) {
      console.error("Architecture boundary violations:")
      for (const violation of violations) console.error("- " + violation)
      process.exitCode = 1
    } else {
      console.log("Architecture boundaries: PASS")
    }
  } catch (error) {
    console.error("Architecture boundary check failed:", error.message)
    process.exitCode = 1
  }
}
