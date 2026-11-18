import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const severities = new Set(["info", "low", "moderate", "high", "critical"])
const ghsaPattern = /\bGHSA-[23456789CFGHJMPQRVWX]{4}-[23456789CFGHJMPQRVWX]{4}-[23456789CFGHJMPQRVWX]{4}\b/iu

export function canonicalAdvisoryId(advisory) {
  const ghsa = [advisory.url, advisory.title, advisory.name]
    .map((value) => typeof value === "string" ? ghsaPattern.exec(value)?.[0] : undefined)
    .find(Boolean)
  if (ghsa) return ghsa.toUpperCase()

  if (Number.isSafeInteger(advisory.source) && advisory.source > 0) {
    return `npm-${advisory.source}`
  }
  throw new Error("Advisory has neither a GHSA id nor a valid npm source id")
}

function normalizeVulnerability(name, vulnerability, mode) {
  if (!name || typeof name !== "string" || name !== name.toLowerCase()) {
    throw new Error(`Invalid or non-normalized package name: ${String(name)}`)
  }
  if (!vulnerability || typeof vulnerability !== "object" ||
      !severities.has(vulnerability.severity) ||
      typeof vulnerability.range !== "string" || vulnerability.range.length === 0 ||
      !Array.isArray(vulnerability.via) ||
      vulnerability.via.some((item) => typeof item !== "string" && (!item || typeof item !== "object"))) {
    throw new Error(`Incomplete npm audit vulnerability for ${name}`)
  }

  const advisories = vulnerability.via.filter((item) => item && typeof item === "object")
  if (advisories.length === 0) {
    if (vulnerability.via.length > 0) return []
    throw new Error(`No advisory details found for vulnerable package ${name}`)
  }

  return advisories.map((advisory) => {
    const advisoryId = canonicalAdvisoryId(advisory)
    const fixedVersion = vulnerability.fixAvailable &&
      typeof vulnerability.fixAvailable === "object" &&
      typeof vulnerability.fixAvailable.version === "string"
      ? vulnerability.fixAvailable.version
      : null
    return {
      mode,
      project: "frontend",
      package: name,
      severity: vulnerability.severity,
      vulnerable_range: vulnerability.range,
      advisory_id: advisoryId,
      fixed_version: fixedVersion,
      key: `${mode}:frontend:${name}:${advisoryId}`,
      is_candidate: ["high", "critical"].includes(vulnerability.severity)
    }
  })
}

export function normalizeAuditReport(input, mode = "real") {
  if (!["real", "training"].includes(mode)) {
    throw new Error(`Unsupported audit mode: ${mode}`)
  }
  if (!input || typeof input !== "object" ||
      !Number.isInteger(input.auditReportVersion) ||
      !input.vulnerabilities || typeof input.vulnerabilities !== "object" ||
      Array.isArray(input.vulnerabilities) || input.error) {
    throw new Error("Invalid or incomplete npm audit JSON report")
  }

  const advisories = Object.entries(input.vulnerabilities)
    .flatMap(([name, vulnerability]) => normalizeVulnerability(name, vulnerability, mode))

  return {
    schema_version: 1,
    mode,
    project: "frontend",
    advisories
  }
}

export const auditStateMarker = "<!-- npm-audit-state "

export function formatAuditStateMarker({ key, severity, fixed_version }) {
  if (typeof key !== "string" || key.length === 0 ||
      !severities.has(severity) ||
      (fixed_version !== null && typeof fixed_version !== "string")) {
    throw new Error("Invalid npm audit state")
  }
  return `${auditStateMarker}${JSON.stringify({ key, severity, fixed_version })} -->`
}

export function parseAuditStateMarker(text) {
  if (typeof text !== "string") return null
  const matches = [...text.matchAll(/<!-- npm-audit-state (\{[^\n]*\}) -->/gu)]
  if (matches.length === 0) return null
  try {
    const state = JSON.parse(matches.at(-1)[1])
    if (typeof state.key !== "string" || !severities.has(state.severity) ||
        (state.fixed_version !== null && typeof state.fixed_version !== "string")) return null
    return state
  } catch {
    return null
  }
}

export function latestPublishedAuditState(body, comments = []) {
  const candidates = comments
    .filter((comment) => comment && typeof comment.createdAt === "string")
    .map((comment) => ({ state: parseAuditStateMarker(comment.body), createdAt: comment.createdAt }))
    .filter(({ state }) => state)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return candidates.at(-1)?.state ?? parseAuditStateMarker(body)
}

export function decideAuditFinding(matches, finding) {
  if (!finding || !finding.is_candidate || !["high", "critical"].includes(finding.severity)) {
    return { action: "ignore" }
  }
  if (!Array.isArray(matches)) throw new Error("Issue matches must be an array")
  if (matches.length > 1) return { action: "ambiguous" }
  if (matches.length === 0) return { action: "create" }
  const previous = matches[0]
  if (!previous || previous.key !== finding.key) return { action: "ambiguous" }
  if (previous.severity === finding.severity && previous.fixed_version === finding.fixed_version) {
    return { action: "unchanged" }
  }
  return { action: "comment" }
}

async function main() {
  const [inputPath, outputPath, mode = "real"] = process.argv.slice(2)
  if (!inputPath || !outputPath) {
    throw new Error("Usage: node tooling/npm-audit-report.mjs <input.json> <output.json> [real|training]")
  }
  const input = JSON.parse(await readFile(inputPath, "utf8"))
  const report = normalizeAuditReport(input, mode)
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
