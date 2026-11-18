import assert from "node:assert/strict"
import { test } from "node:test"
import {
  decideAuditFinding,
  formatAuditStateMarker,
  latestPublishedAuditState,
  parseAuditStateMarker
} from "../tooling/npm-audit-report.mjs"

const finding = {
  key: "real:frontend:example:GHSA-2345-6789-CFGH",
  severity: "high",
  fixed_version: "2.0.0",
  is_candidate: true
}

test("state marker round-trips, rejects malformed values, and reads the last valid marker", () => {
  const marker = formatAuditStateMarker(finding)
  assert.deepEqual(parseAuditStateMarker(`issue\n${marker}`), {
    key: finding.key,
    severity: "high",
    fixed_version: "2.0.0"
  })
  assert.equal(parseAuditStateMarker("not a marker"), null)
  assert.equal(parseAuditStateMarker("<!-- npm-audit-state {broken} -->"), null)
  assert.throws(() => formatAuditStateMarker({ ...finding, severity: "urgent" }))
})

test("latest comment state takes precedence over the original body regardless of order", () => {
  const body = formatAuditStateMarker({ ...finding, severity: "moderate" })
  const older = {
    createdAt: "2026-01-01T00:00:00Z",
    body: formatAuditStateMarker({ ...finding, fixed_version: null })
  }
  const newer = {
    createdAt: "2026-01-02T00:00:00Z",
    body: formatAuditStateMarker(finding)
  }
  assert.deepEqual(latestPublishedAuditState(body, [newer, older]), {
    key: finding.key,
    severity: "high",
    fixed_version: "2.0.0"
  })
  assert.equal(latestPublishedAuditState(body, [] ).severity, "moderate")
})

test("finding decisions create once, comment only on published-state changes, and fail closed on ambiguity", () => {
  assert.deepEqual(decideAuditFinding([], finding), { action: "create" })
  assert.deepEqual(decideAuditFinding([finding], finding), { action: "unchanged" })
  assert.deepEqual(decideAuditFinding(
    [{ ...finding, severity: "critical" }], finding
  ), { action: "comment" })
  assert.deepEqual(decideAuditFinding(
    [{ ...finding, fixed_version: "1.9.0" }], finding
  ), { action: "comment" })
  assert.deepEqual(decideAuditFinding([finding, finding], finding), { action: "ambiguous" })
  assert.deepEqual(decideAuditFinding([], { ...finding, severity: "moderate", is_candidate: false }),
    { action: "ignore" })
})

test("range-only differences do not affect the stored-state decision", () => {
  assert.deepEqual(decideAuditFinding(
    [{ ...finding, vulnerable_range: "<1.0.0" }],
    { ...finding, vulnerable_range: "<2.0.0" }
  ), { action: "unchanged" })
})
