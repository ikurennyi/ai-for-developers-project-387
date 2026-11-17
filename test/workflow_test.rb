require "minitest/autorun"
require "yaml"

class WorkflowTest < Minitest::Test
  ROOT = File.expand_path("..", __dir__)

  def test_workflow_security_and_environment_contract
    workflow = YAML.safe_load_file(File.join(ROOT, ".github/workflows/application-check.yml"))
    assert_equal %w[pull_request push], workflow.fetch("on").keys.sort
    assert_equal({ "contents" => "read" }, workflow.fetch("permissions"))
    job = workflow.fetch("jobs").fetch("check")
    image = job.fetch("services").fetch("postgres").fetch("image")
    assert_equal YAML.safe_load_file(File.join(ROOT, "compose.yml")).fetch("services").fetch("postgres").fetch("image"), image
    steps = job.fetch("steps")
    steps.select { |step| step.key?("uses") }.each do |step|
      assert_match(/@[a-f0-9]{40}\z/, step.fetch("uses"))
    end
    checkout = steps.find { |step| step.fetch("uses", "").start_with?("actions/checkout@") }
    assert_equal 0, checkout.fetch("with").fetch("fetch-depth")
    assert_equal false, checkout.fetch("with").fetch("persist-credentials")
    mise = steps.find { |step| step.fetch("uses", "").start_with?("jdx/mise-action@") }
    fetch_before = steps.find { |step| step["name"] == "Fetch previous push commit when missing" }
    commit_check = steps.find { |step| step.fetch("run", "").include?("mise run commits:check") }
    assert_equal "github.event_name == 'push'", fetch_before.fetch("if")
    assert_equal "node tooling/fetch-push-before.mjs", fetch_before.fetch("run")
    assert_operator steps.index(mise), :<, steps.index(fetch_before)
    assert_operator steps.index(fetch_before), :<, steps.index(commit_check)
    runs = steps.filter_map { |step| step["run"] }.join("\n")
    assert_includes runs, "mise run check"
    assert_includes runs, "install --with-deps chromium"
    assert_includes runs, "mise run commits:check"
    assert_includes runs, "mise run ci:validate"
    refute_includes runs, "${{"
    aggregate = steps.find { |step| step["run"] == "mise run check" }
    assert_equal "true", aggregate.fetch("env").fetch("CI")
    assert_equal "postgresql://ci:ci-ephemeral@127.0.0.1:${{ job.services.postgres.ports['5432'] }}/scaffold_ci", aggregate.fetch("env").fetch("DATABASE_URL")
  end

  def test_opencode_workflow_is_command_gated_trusted_and_read_only
    workflow = YAML.safe_load_file(File.join(ROOT, ".github/workflows/opencode.yml"))
    assert_equal(
      {
        "issue_comment" => { "types" => ["created"] },
        "pull_request_review_comment" => { "types" => ["created"] }
      },
      workflow.fetch("on")
    )
    assert_equal({}, workflow.fetch("permissions"))

    job = workflow.fetch("jobs").fetch("opencode")
    assert_includes job.fetch("if"), "github.event.comment.user.type != 'Bot'"
    assert_includes job.fetch("if"), "OWNER"
    assert_includes job.fetch("if"), "MEMBER"
    assert_includes job.fetch("if"), "COLLABORATOR"
    assert_equal 15, job.fetch("timeout-minutes")
    assert_equal false, job.fetch("concurrency").fetch("cancel-in-progress")
    assert_equal(
      { "contents" => "read", "issues" => "write", "pull-requests" => "write" },
      job.fetch("permissions")
    )

    steps = job.fetch("steps")
    steps.select { |step| step.key?("uses") }.each do |step|
      assert_match(/@[a-f0-9]{40}\z/, step.fetch("uses"))
    end
    checkout = steps.find { |step| step.fetch("uses", "").start_with?("actions/checkout@") }
    assert_equal false, checkout.fetch("with").fetch("persist-credentials")

    command = steps.find { |step| step["name"] == "Check for an OpenCode command" }
    assert_includes command.fetch("run"), "(?:oc|opencode)"
    install = steps.find { |step| step["name"] == "Install OpenCode CLI" }
    assert_includes install.fetch("run"), "@opencode/cli@2.3.0"

    model = steps.find { |step| step["name"] == "Run read-only OpenCode agent" }
    assert_includes model.fetch("run"), "opencode/big-pickle"
    assert_includes model.fetch("run"), "--archived"
    assert_equal ["OPENCODE_API_KEY"], model.fetch("env").keys
    refute model.fetch("env").key?("GH_TOKEN")

    token_steps = steps.select { |step| step.fetch("env", {}).key?("GH_TOKEN") }
    assert_equal 2, token_steps.length
    token_steps.each { |step| refute step.fetch("env").key?("OPENCODE_API_KEY") }

    context = steps.find { |step| step["name"] == "Collect issue and discussion context" }
    reply = steps.find { |step| step["name"] == "Reply to the discussion" }
    assert_includes context.fetch("run"), "issues/$ISSUE_NUMBER/comments"
    assert_includes reply.fetch("run"), "pulls/comments/$COMMENT_ID/replies"
    refute workflow.key?("pull_request_target")

    agent_source = File.read(File.join(ROOT, ".opencode/agents/github-explainer.md"))
    frontmatter = agent_source.split("---", 3).fetch(1)
    agent = YAML.safe_load(frontmatter)
    assert_equal "primary", agent.fetch("mode")
    assert_equal(
      [
        { "action" => "*", "resource" => "*", "effect" => "deny" },
        { "action" => "read", "resource" => "*", "effect" => "allow" },
        { "action" => "glob", "resource" => "*", "effect" => "allow" },
        { "action" => "grep", "resource" => "*", "effect" => "allow" },
        { "action" => "skill", "resource" => "*", "effect" => "allow" }
      ],
      agent.fetch("permissions")
    )
  end

  def test_compose_waits_for_final_tcp_server
    health = YAML.safe_load_file(File.join(ROOT, "compose.yml")).fetch("services").fetch("postgres").fetch("healthcheck")
    assert_includes health.fetch("test").last, "pg_isready -h 127.0.0.1"
  end
end
