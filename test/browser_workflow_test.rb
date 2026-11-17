require "minitest/autorun"
require "yaml"
require "json"
require "open3"
require "tempfile"

class BrowserWorkflowTest < Minitest::Test
  ROOT = File.expand_path("..", __dir__)

  def workflow
    YAML.safe_load_file(File.join(ROOT, ".github/workflows/browser-evidence.yml"))
  end

  def test_independent_unprivileged_pull_request_head_check
    config = workflow
    assert_equal %w[pull_request workflow_dispatch], config.fetch("on").keys.sort
    assert_equal({ "contents" => "read" }, config.fetch("permissions"))
    job = config.fetch("jobs").fetch("browser")
    assert_equal 30, job.fetch("timeout-minutes")
    assert_equal true, job.fetch("concurrency").fetch("cancel-in-progress")
    assert_includes job.fetch("concurrency").fetch("group"), "github.event.pull_request.number"
    steps = job.fetch("steps")
    steps.select { |step| step["uses"] }.each { |step| assert_match(/@[a-f0-9]{40}\z/, step.fetch("uses")) }
    checkout = steps.find { |step| step.fetch("uses", "").start_with?("actions/checkout@") }
    assert_equal "${{ github.event.pull_request.head.sha || needs.resolve.outputs.sha }}", checkout.fetch("with").fetch("ref")
    assert_equal false, checkout.fetch("with").fetch("persist-credentials")
    record = steps.find { |step| step["name"] == "Record and verify actual checkout" }
    assert_equal checkout.fetch("with").fetch("ref"), record.fetch("env").fetch("EXPECTED_SHA")
    assert_includes record.fetch("run"), "git rev-parse HEAD"
    assert_includes record.fetch("run"), 'test "$actual" = "$EXPECTED_SHA"'
    assert_operator steps.index(record), :<, steps.index(steps.find { |step| step["name"] == "Install locked dependencies" })
    serialized = config.to_yaml
    refute_match(/secrets\.|OPENCODE|workflow_run|repository_dispatch|pull_request_target/, serialized)
    refute_match(/GH_TOKEN|GITHUB_TOKEN/, job.to_yaml)
    steps.filter_map { |step| step["run"] }.each { |run| refute_includes run, "${{" }
  end

  def test_manual_entrypoint_is_owner_only_default_branch_and_resolves_before_candidate_checkout
    config = workflow
    input = config.fetch("on").fetch("workflow_dispatch").fetch("inputs").fetch("pr")
    assert_equal true, input.fetch("required")
    assert_equal "string", input.fetch("type")
    resolve = config.fetch("jobs").fetch("resolve")
    assert_includes resolve.fetch("if"), "github.actor == github.repository_owner"
    assert_includes resolve.fetch("if"), "github.triggering_actor == github.repository_owner"
    assert_includes resolve.fetch("if"), "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)"
    assert_equal({ "contents" => "read", "pull-requests" => "read" }, resolve.fetch("permissions"))
    assert_equal ["resolve"], config.fetch("jobs").fetch("browser").fetch("needs")
    assert_includes config.fetch("jobs").fetch("browser").fetch("if"), "needs.resolve.result == 'success'"
    assert_includes config.fetch("jobs").fetch("browser").fetch("if"), "github.event_name == 'pull_request'"
    refute_includes resolve.to_yaml, "actions/checkout"
    step = resolve.fetch("steps").first
    assert_equal "${{ github.token }}", step.fetch("env").fetch("GH_TOKEN")
    assert_equal "${{ inputs.pr }}", step.fetch("env").fetch("PR_NUMBER")
    assert_includes step.fetch("run"), "/pulls/"
    assert_includes step.fetch("run"), 'pr.head.repo?.full_name !== repository'
    assert_includes step.fetch("run"), 'pr.state !== "open"'
    assert_includes step.fetch("run"), 'sha=${pr.head.sha}'
    refute_match(/gh workflow run|dispatches|actions\/workflows/, config.to_yaml)
  end

  def test_live_head_resolution_rejects_forks_closed_prs_invalid_numbers_and_api_failures
    step = workflow.fetch("jobs").fetch("resolve").fetch("steps").first
    script = step.fetch("run").lines[1...-1].join
    pr = {
      number: 42, state: "open", head: { sha: "a" * 40, repo: { full_name: "owner/calendar" } },
      base: { repo: { full_name: "owner/calendar" } }
    }
    stub = <<~JS
      globalThis.fetch = async (url, options) => {
        if (url !== "https://api.github.com/repos/owner/calendar/pulls/42") throw new Error("Unexpected lookup");
        if (options.headers.authorization !== "Bearer fixture-read-token") throw new Error("Missing authorization");
        return { ok: process.env.API_OK === "true", status: 403,
          json: async () => JSON.parse(process.env.API_PR) };
      };
    JS
    cases = [
      [pr, "42", true, true],
      [pr.merge(head: { sha: "b" * 40, repo: { full_name: "fork/calendar" } }), "42", true, false],
      [pr.merge(head: { sha: "b" * 40, repo: nil }), "42", true, false],
      [pr.merge(state: "closed"), "42", true, false],
      [pr.merge(number: 43), "42", true, false],
      [pr.merge(head: { sha: "refs/heads/main", repo: { full_name: "owner/calendar" } }), "42", true, false],
      [pr, "42", false, false],
      [pr, "42\nsha=bad", true, false]
    ]
    cases.each do |response, number, api_ok, expected|
      Tempfile.create("browser-head-output") do |file|
        output, status = Open3.capture2e(
          { "API_PR" => JSON.generate(response), "API_OK" => api_ok.to_s, "PR_NUMBER" => number,
            "GITHUB_REPOSITORY" => "owner/calendar", "GITHUB_API_URL" => "https://api.github.com",
            "GH_TOKEN" => "fixture-read-token", "GITHUB_OUTPUT" => file.path },
          "node", "--input-type=module", "--eval", stub + script
        )
        assert_equal expected, status.success?, output
        assert_equal expected ? "sha=#{"a" * 40}\n" : "", File.read(file.path)
        refute_includes output, "fixture-read-token"
      end
    end
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
