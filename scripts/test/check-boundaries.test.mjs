import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { checkBoundaries } from "../check-boundaries.mjs"

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-boundaries-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (name, value) => {
    const target = path.join(root, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(
      target,
      typeof value === "string" ? value : JSON.stringify(value)
    )
  }
  for (const [directory, name] of [
    ["packages/automation-runtime", "@workspace/automation-runtime"],
    ["packages/automations", "@workspace/automations"],
    ["packages/automation-simulation", "@workspace/automation-simulation"],
    ["packages/domain", "@workspace/domain"],
    ["packages/db", "@workspace/db"],
    ["packages/ui", "@workspace/ui"],
    ["packages/integrations/google", "@workspace/integration-google"],
    ["apps/api", "api"],
    ["apps/web", "web"],
  ])
    write(directory + "/package.json", { name })
  return { root, write, check: () => checkBoundaries(root) }
}

for (const [title, source, extension = "ts"] of [
  ["named ES import", 'import { db } from "@workspace/db"'],
  ["side effect import", 'import "@workspace/db"'],
  ["re-export", 'export * from "@workspace/db/schema"'],
  [
    "dynamic import with comment",
    'void import(/* boundary */ "@workspace/db")',
  ],
  ["literal template import", "void import(`@workspace/db`)"],
  ["CommonJS require", 'const db = require("@workspace/db")', "cjs"],
  ["TypeScript import equals", 'import db = require("@workspace/db")', "cts"],
  ["import type expression", 'type DB = import("@workspace/db").Database'],
  ["relative cross-package import", 'import { db } from "../../db/src/client"'],
  ["relative API import", 'import "../../../apps/api/src/index"'],
  ["named API import", 'import "api"'],
  ["UI import", 'import "@workspace/ui/components/button"'],
  ["provider source import", 'import "../../integrations/google/src/index"'],
  ["provider SDK import", 'import "googleapis"'],
]) {
  test("rejects " + title, (t) => {
    const f = fixture(t)
    f.write("packages/automation-runtime/src/probe." + extension, source)
    assert.equal(f.check().length, 1)
    assert.match(f.check()[0], /imports forbidden dependency/)
  })
}

test("allows valid dependencies and ignores import-looking comments and strings", (t) => {
  const f = fixture(t)
  f.write(
    "packages/automation-runtime/src/valid.ts",
    `
    import { contract } from "@workspace/domain"
    import "./local"
    import "googleapis-helper"
    // import "@workspace/db"
    const example = 'require("@workspace/db")'
  `
  )
  f.write(
    "apps/web/src/valid.ts",
    'import "@workspace/ui"; import "@workspace/domain"'
  )
  f.write("packages/ui/src/valid.ts", 'import "react"')
  f.write(
    "packages/automation-runtime/.fixture-cache/example.ts",
    'import "@workspace/db"'
  )
  assert.deepEqual(f.check(), [])
})

for (const field of [
  "dependencies",
  "optionalDependencies",
  "devDependencies",
  "peerDependencies",
]) {
  test("checks " + field, (t) => {
    const f = fixture(t)
    f.write("packages/automation-runtime/package.json", {
      name: "@workspace/automation-runtime",
      [field]: { "@workspace/db": "workspace:*" },
    })
    assert.match(f.check()[0], /declares forbidden dependency/)
  })
}

for (const [name, value] of [
  ["storage", "workspace:@workspace/db@*"],
  ["storage", "workspace:../db"],
  ["storage", "link:../db"],
  ["google-client", "npm:googleapis@1"],
]) {
  test("checks dependency alias " + value, (t) => {
    const f = fixture(t)
    f.write("packages/automation-runtime/package.json", {
      name: "@workspace/automation-runtime",
      dependencies: { [name]: value },
    })
    assert.match(f.check()[0], /declares forbidden dependency/)
  })
}

test("resolves exact and wildcard tsconfig paths with local inheritance", (t) => {
  const f = fixture(t)
  f.write("tsconfig.json", {
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@storage": ["packages/db/src/index.ts"],
        "@storage/*": ["packages/db/src/*"],
      },
    },
  })
  f.write("packages/automation-runtime/tsconfig.json", {
    extends: "../../tsconfig.json",
  })
  f.write(
    "packages/automation-runtime/src/probe.ts",
    'import "@storage"; import "@storage/client"'
  )
  assert.equal(f.check().length, 2)
})

test("resolves referenced-style app config aliases without baseUrl", (t) => {
  const f = fixture(t)
  f.write("apps/web/tsconfig.app.json", {
    compilerOptions: { paths: { "@db/*": ["../../packages/db/src/*"] } },
  })
  f.write("apps/web/src/probe.ts", 'import "@db/client"')
  assert.equal(f.check().length, 1)
})

test("resolves baseUrl-only imports", (t) => {
  const f = fixture(t)
  f.write("packages/automation-runtime/tsconfig.json", {
    compilerOptions: { baseUrl: ".." },
  })
  f.write("packages/automation-runtime/src/probe.ts", 'import "db/src/client"')
  assert.equal(f.check().length, 1)
})

test("allows same-package and domain tsconfig aliases", (t) => {
  const f = fixture(t)
  f.write("packages/automation-runtime/tsconfig.json", {
    compilerOptions: {
      paths: {
        "@local/*": ["src/*"],
        "@domain/*": ["../domain/src/*"],
      },
    },
  })
  f.write(
    "packages/automation-runtime/src/probe.ts",
    'import "@local/helper"; import "@domain/value"'
  )
  assert.deepEqual(f.check(), [])
})

test("fails closed for computed import targets", (t) => {
  const f = fixture(t)
  f.write(
    "packages/automation-runtime/src/probe.ts",
    "void import(target); require(target)"
  )
  assert.equal(f.check().length, 2)
  assert.ok(f.check().every((message) => message.includes("non-literal")))
})

test("fails closed for unsupported config inheritance", (t) => {
  const f = fixture(t)
  f.write("packages/automation-runtime/tsconfig.json", {
    extends: "@third-party/config",
  })
  assert.throws(f.check, /unsupported non-local tsconfig/)
})

test("covers web and UI restrictions", (t) => {
  const f = fixture(t)
  f.write("apps/web/src/probe.ts", 'import "@workspace/automation-runtime"')
  f.write("packages/ui/src/probe.tsx", 'import "@workspace/domain"')
  assert.equal(f.check().length, 2)
})

test("fails closed for package.json private import aliases", (t) => {
  const f = fixture(t)
  f.write("packages/automation-runtime/package.json", {
    name: "@workspace/automation-runtime",
    imports: { "#db": "@workspace/db" },
  })
  f.write("packages/automation-runtime/src/probe.ts", 'import "#db"')
  assert.match(f.check()[0], /unsupported package import alias/)
})

test("CLI returns nonzero for violations and zero for allowed sources", (t) => {
  const f = fixture(t)
  const checker = fileURLToPath(
    new URL("../check-boundaries.mjs", import.meta.url)
  )
  const run = () =>
    spawnSync(process.execPath, [checker], { cwd: f.root, encoding: "utf8" })
  f.write(
    "packages/automation-runtime/src/probe.ts",
    'import "../../db/src/client"'
  )
  const rejected = run()
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /imports forbidden dependency/)
  f.write(
    "packages/automation-runtime/src/probe.ts",
    'import "@workspace/domain"'
  )
  const allowed = run()
  assert.equal(allowed.status, 0)
  assert.match(allowed.stdout, /Architecture boundaries: PASS/)
})
