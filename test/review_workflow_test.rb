require "minitest/autorun"
require "yaml"

class ReviewWorkflowTest < Minitest::Test
  ROOT = File.expand_path("..", __dir__)

  def workflow
    YAML.safe_load_file(File.join(ROOT, ".github/workflows/agent-review.yml"))
  end

  def test_review_has_only_pr_and_owner_manual_entrypoints
    assert_equal %w[pull_request workflow_dispatch], workflow.fetch("on").keys.sort
    assert_equal %w[opened reopened synchronize ready_for_review], workflow.fetch("on").fetch("pull_request").fetch("types")
    assert_equal({}, workflow.fetch("permissions"))
    job = workflow.fetch("jobs").fetch("review")
    assert_equal true, job.fetch("concurrency").fetch("cancel-in-progress")
    assert_includes job.fetch("concurrency").fetch("group"), "agent-review-"
    assert_includes job.fetch("if"), "github.repository_owner"
    assert_includes job.fetch("if"), "github-actions[bot]"
    refute_includes job.fetch("if"), "!= 'Bot'"
    assert_equal 15, job.fetch("timeout-minutes")
  end

  def test_candidate_cannot_supply_policies_or_model_tools_and_secret
    job = workflow.fetch("jobs").fetch("review")
    assert_equal({
      "contents" => "read", "issues" => "read", "actions" => "read",
      "checks" => "read", "statuses" => "read", "pull-requests" => "write"
    }, job.fetch("permissions"))
    steps = job.fetch("steps")
    trusted, candidate = steps.select { |s| s.fetch("uses", "").start_with?("actions/checkout@") }
    assert_equal "${{ github.event.repository.default_branch }}", trusted.fetch("with").fetch("ref")
    assert_equal "policy", trusted.fetch("with").fetch("path")
    assert_equal "${{ steps.gate.outputs.sha }}", candidate.fetch("with").fetch("ref")
    [trusted, candidate].each { |s| assert_equal false, s.fetch("with").fetch("persist-credentials") }
    model = steps.find { |s| s["id"] == "model" }
    assert_equal "policy", model.fetch("working-directory")
    assert_equal ["OPENCODE_API_KEY"], model.fetch("env").keys
    assert_includes model.fetch("run"), "$(cat REVIEW.md)"
    assert_includes model.fetch("run"), "--standalone --archived"
    refute_includes model.fetch("run"), "--session"
    refute_includes model.fetch("run"), "github run"
    steps.each do |s|
      refute_includes s.fetch("run", ""), "${{"
      next if s == model
      refute_includes s.fetch("env", {}).values.join, "secrets."
    end
    agent = File.read(File.join(ROOT, ".opencode/agents/github-review.md")).split("---")[1]
    permissions = YAML.safe_load(agent).fetch("permissions")
    assert_equal({"action" => "*", "resource" => "*", "effect" => "deny"}, permissions.first)
    assert_equal %w[external_directory glob grep read], permissions.select { |p| p["effect"] == "allow" }.map { |p| p["action"] }.uniq.sort
    assert_equal "__CANDIDATE_DIRECTORY__/*", permissions.find { |p| p["action"] == "external_directory" }.fetch("resource")
  end

  def test_shared_budget_and_no_automatic_cascade_are_enforced_before_model
    steps = workflow.fetch("jobs").fetch("review").fetch("steps")
    gate = steps.find { |s| s["id"] == "gate" }
    install = steps.find { |s| s["name"] == "Install OpenCode CLI" }
    assert_operator steps.index(gate), :<, steps.index(install)
    steps.select { |s| ["Install OpenCode CLI", "Independent read-only model session", "Check out inert candidate"].include?(s["name"]) }.each do |s|
      assert_equal "steps.gate.outputs.run == 'true'", s.fetch("if")
    end
    adapter = File.read(File.join(ROOT, "tooling/agent-review.mjs"))
    assert_includes adapter, 'import { github, collectBudget, trustedPullRequest } from "./agent-policy.mjs"'
    assert_includes adapter, 'mode: "review", scope: `pr-${number}`, workflowPath: ".github/workflows/agent-review.yml"'
    assert_includes adapter, 'budget.decision === "allow"'
    assert_includes adapter, "pr.head.sha !== state.sha"
    assert_includes adapter, 'process.env.JOB_STATUS === "cancelled"'
    assert_includes adapter, 'process.env.GITHUB_ACTOR !== owner'
    refute_includes adapter, "dispatches"
    refute_includes adapter, "child_process"
    refute_includes workflow.to_s, "RELEASE_PLEASE_TOKEN"
    refute_includes workflow.to_s, "id-token"
    assert_includes workflow.fetch("jobs").fetch("review").fetch("name"), "agent-admission:pr-"
    publisher = steps.last
    assert_includes publisher.fetch("if"), "always()"
    assert_equal ["GH_TOKEN", "JOB_STATUS", "MODEL_OUTCOME"], publisher.fetch("env").keys.sort
  end

  def test_review_criteria_and_pr_template_make_evidence_and_recovery_explicit
    criteria = File.read(File.join(ROOT, "REVIEW.md"))
    ["Occupied intervals", "available/disabled", "color alone", "decorative", "keyboard focus",
     "No confirmed defects found", "failing", "consequences", "resolved findings"].each do |term|
      assert_includes criteria, term
    end
    template = File.read(File.join(ROOT, ".github/pull_request_template.md"))
    ["Source", "Specification", "Tickets", "approval-comment", "SHA", "rollback",
     "restores", "data", "GITHUB_TOKEN"].each { |term| assert_includes template, term }
  end
end
