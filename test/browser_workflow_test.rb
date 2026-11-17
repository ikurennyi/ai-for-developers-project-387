require "minitest/autorun"
require "yaml"

class BrowserWorkflowTest < Minitest::Test
  ROOT = File.expand_path("..", __dir__)

  def workflow
    YAML.safe_load_file(File.join(ROOT, ".github/workflows/browser-evidence.yml"))
  end

  def test_independent_unprivileged_pull_request_head_check
    config = workflow
    assert_equal({ "pull_request" => nil }, config.fetch("on"))
    assert_equal({ "contents" => "read" }, config.fetch("permissions"))
    job = config.fetch("jobs").fetch("browser")
    assert_equal 30, job.fetch("timeout-minutes")
    assert_equal true, job.fetch("concurrency").fetch("cancel-in-progress")
    assert_includes job.fetch("concurrency").fetch("group"), "github.event.pull_request.number"
    steps = job.fetch("steps")
    steps.select { |step| step["uses"] }.each { |step| assert_match(/@[a-f0-9]{40}\z/, step.fetch("uses")) }
    checkout = steps.find { |step| step.fetch("uses", "").start_with?("actions/checkout@") }
    assert_equal "${{ github.event.pull_request.head.sha }}", checkout.fetch("with").fetch("ref")
    assert_equal false, checkout.fetch("with").fetch("persist-credentials")
    record = steps.find { |step| step["name"] == "Record and verify actual checkout" }
    assert_equal "${{ github.event.pull_request.head.sha }}", record.fetch("env").fetch("EXPECTED_SHA")
    assert_includes record.fetch("run"), "git rev-parse HEAD"
    assert_includes record.fetch("run"), 'test "$actual" = "$EXPECTED_SHA"'
    assert_operator steps.index(record), :<, steps.index(steps.find { |step| step["name"] == "Install locked dependencies" })
    serialized = config.to_yaml
    refute_match(/secrets\.|OPENCODE|GH_TOKEN|GITHUB_TOKEN|workflow_dispatch|workflow_run|repository_dispatch|pull_request_target/, serialized)
    steps.filter_map { |step| step["run"] }.each { |run| refute_includes run, "${{" }
  end

  def test_disposable_database_and_unconditional_sha_specific_evidence
    job = workflow.fetch("jobs").fetch("browser")
    image = YAML.safe_load_file(File.join(ROOT, "compose.yml")).fetch("services").fetch("postgres").fetch("image")
    assert_equal image, job.fetch("services").fetch("postgres").fetch("image")
    steps = job.fetch("steps")
    smoke = steps.find { |step| step["run"] == "mise run smoke" }
    assert_equal "true", smoke.fetch("env").fetch("CI")
    assert_includes smoke.fetch("env").fetch("DATABASE_URL"), "job.services.postgres.ports['5432']"
    assert_equal "${{ github.workspace }}/browser-evidence", smoke.fetch("env").fetch("SMOKE_EVIDENCE_DIR")
    upload = steps.find { |step| step.fetch("uses", "").start_with?("actions/upload-artifact@") }
    assert_equal "always()", upload.fetch("if")
    assert_equal "browser-evidence/", upload.fetch("with").fetch("path")
    assert_equal "error", upload.fetch("with").fetch("if-no-files-found")
    assert_includes upload.fetch("with").fetch("name"), "github.event.pull_request.head.sha"
    assert_includes upload.fetch("with").fetch("name"), "github.run_attempt"
    docs = File.read(File.join(ROOT, "docs/browser-evidence.md"))
    assert_includes docs, "GITHUB_TOKEN"
    assert_includes docs, "current PR head"
    assert_includes docs, "re-run"
    assert_includes docs, "does not update"
  end
end
