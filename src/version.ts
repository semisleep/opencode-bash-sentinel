import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The host process loads this plugin from source with no build step, and it
// never hot-reloads: a running server keeps evaluating the code it started
// with. The build id must therefore be captured ONCE at module load — a
// per-write lookup would stamp a stale process with the current HEAD.
function resolveBuildId(): string {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  )
  try {
    const head = execSync("git rev-parse --short HEAD", {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 2000,
    }).trim()
    if (!/^[0-9a-f]{7,40}$/.test(head)) throw new Error("unexpected HEAD")
    const dirty = execSync("git status --porcelain -- src index.ts", {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 2000,
    }).trim()
    return dirty ? `${head}+dirty` : head
  } catch {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(root, "package.json"), "utf8"),
      ) as { version?: string }
      return pkg.version ?? "unknown"
    } catch {
      return "unknown"
    }
  }
}

export const BUILD_ID = resolveBuildId()
