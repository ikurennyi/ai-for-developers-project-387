import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { canonicalAdvisoryId, normalizeAuditReport } from "../tooling/npm-audit-report.mjs"

const audit = (overrides = {}) => ({
  auditReportVersion: 2,
  vulnerabilities: {
    example: {
      severity: "high",
      range: "<2.0.0",
      via: [{ source: 123, url: "https://github.com/advisories/GHSA-2345-6789-CFGH" }],
      fixAvailable: { name: "example", version: "2.0.0", isSemVerMajor: true }
    }
  },
  ...overrides
})

test("normalizes every severity and produces stable finding keys", () => {
  const report = normalizeAuditReport(audit(), "real")
  assert.deepEqual(report.advisories, [{
    mode: "real",
    project: "frontend",
    package: "example",
    severity: "high",
    vulnerable_range: "<2.0.0",
    advisory_id: "GHSA-2345-6789-CFGH",
    fixed_version: "2.0.0",
    key: "real:frontend:example:GHSA-2345-6789-CFGH",
    is_candidate: true
  }])

  const changed = audit({
    vulnerabilities: {
      example: {
        severity: "critical",
        range: "<3.0.0",
        via: [{ source: 123, url: "https://github.com/advisories/GHSA-2345-6789-CFGH" }],
        fixAvailable: { version: "3.0.0" }
      }
    }
  })
  const changedFinding = normalizeAuditReport(changed).advisories[0]
  assert.equal(changedFinding.key, report.advisories[0].key)
  assert.notEqual(changedFinding.vulnerable_range, report.advisories[0].vulnerable_range)
  assert.notEqual(changedFinding.severity, report.advisories[0].severity)
  assert.notEqual(changedFinding.fixed_version, report.advisories[0].fixed_version)
})

test("uses npm source id when GHSA is absent and records missing fix explicitly", () => {
  assert.equal(canonicalAdvisoryId({ source: 42 }), "npm-42")
  const report = normalizeAuditReport(audit({
    vulnerabilities: {
      example: {
        severity: "moderate",
        range: ">=1 <2",
        via: [{ source: 42 }],
        fixAvailable: false
      }
    }
  }))
  assert.equal(report.advisories[0].advisory_id, "npm-42")
  assert.equal(report.advisories[0].fixed_version, null)
  assert.equal(report.advisories[0].is_candidate, false)
})

test("retains all advisory severities and identifies only high and critical candidates", () => {
  const severities = ["info", "low", "moderate", "high", "critical"]
  const report = normalizeAuditReport(audit({
    vulnerabilities: Object.fromEntries(severities.map((severity, index) => [
      `package-${index}`,
      {
        severity,
        range: "<1",
        via: [{ source: index + 1 }],
        fixAvailable: false
      }
    ]))
  }))
  assert.deepEqual(report.advisories.map(({ severity }) => severity), severities)
  assert.deepEqual(report.advisories.map(({ is_candidate }) => is_candidate),
    [false, false, false, true, true])
  assert.deepEqual(normalizeAuditReport(audit()), normalizeAuditReport(audit()))
})

test("does not duplicate meta-vulnerability references as standalone advisories", () => {
  const report = normalizeAuditReport(audit({
    vulnerabilities: {
      example: {
        severity: "high",
        range: "<1",
        via: ["underlying-package"],
        fixAvailable: false
      }
    }
  }))
  assert.deepEqual(report.advisories, [])
})

test("training fixture is synthetic and keeps a separate high-severity key", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/npm-audit-training.json", import.meta.url),
    "utf8"
  ))
  const finding = normalizeAuditReport(fixture, "training").advisories[0]

  assert.equal(fixture.vulnerabilities["training-example-package"].via[0].url,
    "https://example.invalid/training-advisory")
  assert.match(fixture.vulnerabilities["training-example-package"].via[0].title, /synthetic/i)
  assert.equal(finding.severity, "high")
  assert.equal(finding.key, "training:frontend:training-example-package:npm-987654321")
  assert.equal(finding.is_candidate, true)
  assert.notEqual(finding.key, "real:frontend:training-example-package:npm-987654321")
})

test("rejects invalid, incomplete and ambiguous audit input", () => {
  for (const input of [
    null,
    {},
    audit({ auditReportVersion: "2" }),
    audit({ vulnerabilities: { example: { severity: "high" } } }),
    audit({ vulnerabilities: { example: {
      severity: "high", range: "<1", via: [{ title: "missing id" }]
    } } })
  ]) assert.throws(() => normalizeAuditReport(input))
  assert.throws(() => normalizeAuditReport(audit(), "unknown"))
})
