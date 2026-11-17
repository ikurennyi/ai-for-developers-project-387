// Trusted pre-model check: permit only protected, internal skill aliases.
import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs"
import { join, relative, resolve } from "node:path"

try {
  if (process.argv.length !== 3) throw new Error("Expected one candidate snapshot path")
  const candidate = resolve(process.argv[2])
  if (!lstatSync(candidate).isDirectory()) throw new Error("Snapshot root must be a directory")
  const root = realpathSync(candidate)
  function inspect(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const entry = lstatSync(path)
      const local = relative(root, path)
      if (entry.isSymbolicLink()) {
        // Both paths are under dot-directories, which model tools cannot edit.
        // No public-path aliases to policy, credentials or metadata are allowed.
        const alias = /^\.claude\/skills\/([a-z0-9][a-z0-9-]*)$/u.exec(local)
        const target = alias && join(root, ".agents/skills", alias[1])
        if (!alias || readlinkSync(path) !== `../../.agents/skills/${alias[1]}` ||
            realpathSync(path) !== target || !lstatSync(target).isDirectory()) {
          throw new Error(`Unsafe snapshot symlink: ${JSON.stringify(local)}`)
        }
      } else if (entry.isDirectory() && local !== ".git") {
        inspect(path)
      }
    }
  }
  inspect(root)
} catch (error) {
  // Do not print filesystem error details (which may include link targets).
  process.stderr.write(`${error.code ? "Snapshot filesystem validation failed" : error.message}\n`)
  process.exitCode = 1
}
