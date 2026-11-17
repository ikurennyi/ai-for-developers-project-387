require "minitest/autorun"
require "yaml"
require "open3"
require "tempfile"

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

  def test_opencode_workflow_is_command_gated_and_uses_restricted_gh_agent
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
    assert_equal "${{ github.event.repository.default_branch }}", checkout.fetch("with").fetch("ref")
    assert_includes command.fetch("run"), "(?:oc|opencode)"
    refute job.fetch("env").key?("TRIAGE_PROMPT")
    install = steps.find { |step| step["name"] == "Install OpenCode CLI" }
    assert_includes install.fetch("run"), "@opencode/cli@2.3.0"

    model = steps.find { |step| step["name"] == "Run GitHub discussion agent" }
    assert_match(/\A[^\s]+\/[^\s]+\z/, job.fetch("env").fetch("OPENCODE_MODEL"))
    assert_includes model.fetch("run"), '--model "$OPENCODE_MODEL"'
    assert_includes model.fetch("run"), "--archived"
    assert_equal %w[GH_TOKEN OPENCODE_AGENT OPENCODE_API_KEY REQUESTED_STAGE], model.fetch("env").keys.sort
    assert_equal "${{ steps.command.outputs.agent }}", model.fetch("env").fetch("OPENCODE_AGENT")
    assert_equal "${{ steps.command.outputs.stage }}", model.fetch("env").fetch("REQUESTED_STAGE")
    assert_equal "${{ github.event.issue.pull_request != null }}", command.fetch("env").fetch("IS_PULL_REQUEST")
    assert_includes model.fetch("run"), '--agent "$OPENCODE_AGENT"'

    context = steps.find { |step| step["name"] == "Collect issue and discussion context" }
    reply = steps.find { |step| step["name"] == "Reply to the discussion" }
    assert_includes context.fetch("run"), 'gh api --paginate "repos/$GH_REPO/issues/$ISSUE_NUMBER/comments?per_page=100"'
    assert_includes context.fetch("run"), 'gh api --paginate "repos/$GH_REPO/pulls/$ISSUE_NUMBER/comments?per_page=100"'
    assert_includes reply.fetch("run"), 'pulls/comments/$comment_id/replies'
    assert_includes reply.fetch("run"), 'gh issue comment "$ISSUE_NUMBER"'
    steps.drop(steps.index(command) + 1).each do |step|
      assert_equal "steps.command.outputs.run == 'true'", step.fetch("if")
    end
    refute workflow.fetch("on").key?("pull_request_target")
    assert_equal "primary", agent("github-issues").fetch("mode")
  end

  def test_compose_waits_for_final_tcp_server
    health = YAML.safe_load_file(File.join(ROOT, "compose.yml")).fetch("services").fetch("postgres").fetch("healthcheck")
    assert_includes health.fetch("test").last, "pg_isready -h 127.0.0.1"
  end

  def test_issue_triage_has_separate_model_minimal_permissions_and_shared_issue_lock
    workflow = YAML.safe_load_file(File.join(ROOT, ".github/workflows/issue-triage.yml"))
    interactive = YAML.safe_load_file(File.join(ROOT, ".github/workflows/opencode.yml"))
    assert_equal({ "issues" => { "types" => ["opened"] } }, workflow.fetch("on"))
    assert_equal({}, workflow.fetch("permissions"))
    job = workflow.fetch("jobs").fetch("triage")
    assert_includes job.fetch("if"), "github.event.issue.user.type != 'Bot'"
    assert_includes job.fetch("if"), '["OWNER","MEMBER","COLLABORATOR"]'
    assert_equal({ "contents" => "read", "issues" => "write" }, job.fetch("permissions"))
    assert_equal 15, job.fetch("timeout-minutes")
    assert_equal interactive.fetch("jobs").fetch("opencode").fetch("concurrency"), job.fetch("concurrency")
    assert_equal false, job.fetch("concurrency").fetch("cancel-in-progress")
    assert_includes job.fetch("concurrency").fetch("group"), "github.event.issue.number"
    assert_match(/\A[^\s]+\/[^\s]+\z/, job.fetch("env").fetch("OPENCODE_MODEL"))
    assert_includes job.fetch("env").fetch("TRIAGE_PROMPT"), "preliminary triage"

    steps = job.fetch("steps")
    checkout = steps.find { |step| step.fetch("uses", "").start_with?("actions/checkout@") }
    assert_match(/@[a-f0-9]{40}\z/, checkout.fetch("uses"))
    assert_equal "${{ github.event.repository.default_branch }}", checkout.fetch("with").fetch("ref")
    assert_equal false, checkout.fetch("with").fetch("persist-credentials")
    gate = steps.find { |step| step["id"] == "gate" }
    assert_includes gate.fetch("run"), 'gh issue view "$ISSUE_NUMBER"'
    assert_includes gate.fetch("run"), '.state == "OPEN"'
    %w[ready-for-agent ready-for-human agent:spec agent:ticket wontfix].each do |label|
      assert_includes gate.fetch("run"), ". == \"#{label}\""
    end
    steps.drop(steps.index(gate) + 1).each do |step|
      assert_equal "steps.gate.outputs.run == 'true'", step.fetch("if")
    end
    model = steps.find { |step| step["name"] == "Run preliminary triage agent" }
    assert_includes model.fetch("run"), '--model "$OPENCODE_MODEL"'
    assert_includes model.fetch("run"), "--archived"
    assert_equal %w[GH_TOKEN OPENCODE_API_KEY], model.fetch("env").keys.sort
    assert_includes model.fetch("run"), "--agent github-triage"
    mark = steps.find { |step| step["name"] == "Mark as awaiting triage" }
    assert_includes mark.fetch("run"), 'if [ "$state_count" = "0" ]'
    assert_includes mark.fetch("run"), 'gh issue edit "$ISSUE_NUMBER" --add-label needs-triage'
    assert_equal "primary", agent("github-triage").fetch("mode")
  end

  def test_github_runner_skills_are_versioned
    %w[triage to-spec to-tickets implement-spec].each do |id|
      path = File.join(ROOT, ".agents/skills", id, "SKILL.md")
      assert File.file?(path), "Missing runner skill #{id}"
      assert_includes File.read(path), "name: #{id}"
    end
    refute File.exist?(File.join(ROOT, "scripts/github-agent.mjs"))
  end

  def test_manual_command_filter_executes_without_interpreting_comment_text
    workflow = YAML.safe_load_file(File.join(ROOT, ".github/workflows/opencode.yml"))
    command = workflow.fetch("jobs").fetch("opencode").fetch("steps").find { |step| step["id"] == "command" }
    {
      "/oc triage" => true,
      "/OPENCODE to-spec" => true,
      "Please\n/oc continue" => true,
      "/occasion" => false,
      "hello" => false,
      '$(exit 99) /oc explain' => true
    }.each do |body, expected|
      Tempfile.create("opencode-gate") do |file|
        _, stderr, status = Open3.capture3(
          { "COMMENT_BODY" => body, "GITHUB_OUTPUT" => file.path },
          "bash", "-euo", "pipefail", "-c", command.fetch("run")
        )
        assert status.success?, stderr
        outputs = File.read(file.path).lines.to_h { |line| line.strip.split("=", 2) }
        assert_equal expected.to_s, outputs.fetch("run")
      end
    end
  end

  def test_agent_allowlists_deny_code_changes_and_unsafe_gh_options
    %w[github-issues github-triage github-discussion].each do |id|
      assert_equal "allow", permission(id, "shell", "gh issue view 9 --json body,comments")
      assert_equal "allow", permission(id, "shell", "gh issue list --state all")
      assert_equal "allow", permission(id, "skill", "to-spec")
      assert_equal "allow", permission(id, "read", "contracts/main.tsp")
      {
        "edit" => "frontend/src/main.ts",
        "subagent" => "general",
        "external_directory" => "/outside/*",
        "render_list_services" => "*",
        "read" => "backend/.env.production"
      }.each { |action, resource| assert_equal "deny", permission(id, action, resource), "#{id}: #{action} #{resource}" }
      [
        "git push", "git commit -m test", "node -e 'process.exit()'", "curl https://example.test",
        "gh api repos/owner/repo/issues --method POST", "gh pr create", "gh issue close 9",
        "gh issue delete 9 --yes", "gh issue view 9 --web", "gh issue view 9 -w"
      ].each { |resource| assert_equal "deny", permission(id, "shell", resource), "#{id}: #{resource}" }
    end
    [
      'gh issue create --title Spec --body "Agreed scope" --label ready-for-agent,agent:spec',
      'gh issue comment 9 --body "See #10"',
      'gh issue edit 9 --add-label needs-info --remove-label needs-triage'
    ].each do |command|
      assert_equal "allow", permission("github-issues", "shell", command)
      assert_equal "deny", permission("github-triage", "shell", command)
      assert_equal "deny", permission("github-discussion", "shell", command)
    end
    [
      "gh issue create --body-file /secret", "gh issue comment 9 -F/secret",
      "gh issue edit 9 --body-file=/secret", "gh issue create --editor",
      "gh issue create -e", "gh issue create -we", "gh issue create --recover secret",
      "gh issue create --template secret", "gh issue comment 9 --delete-last"
    ].each { |command| assert_equal "deny", permission("github-issues", "shell", command), command }
  end

  def test_clarification_does_not_authorize_publication_even_after_bot_recommendation
    workflow = YAML.safe_load_file(File.join(ROOT, ".github/workflows/opencode.yml"))
    command = workflow.fetch("jobs").fetch("opencode").fetch("steps").find { |step| step["id"] == "command" }
    Tempfile.create("opencode-route") do |file|
      _, stderr, status = Open3.capture3(
        {
          "COMMENT_BODY" => "/oc 1 - точка, 2 - даты/дни пока не трогаем, для доступных интервалов уберём текст Available.",
          "DISCUSSION_CONTEXT" => "Previous bot: /oc запусти скилл to-spec",
          "GITHUB_EVENT_NAME" => "issue_comment",
          "IS_PULL_REQUEST" => "false",
          "GITHUB_OUTPUT" => file.path
        },
        "bash", "-euo", "pipefail", "-c", command.fetch("run")
      )
      assert status.success?, stderr
      outputs = File.read(file.path).lines.to_h { |line| line.strip.split("=", 2) }
      assert_equal "true", outputs.fetch("run")
      assert_equal "github-discussion", outputs["agent"], "Clarification must not receive publication tools"
      assert_equal "discussion", outputs["stage"]
    end
  end

  def test_only_explicit_whole_comment_skill_requests_select_publication_tools
    {
      "/oc to-spec" => "to-spec",
      "/oc запусти скилл to-spec по обсуждению этого issue" => "to-spec",
      "/oc продолжи to-spec с учётом ответов" => "to-spec",
      "/OPENCODE run skill to-spec" => "to-spec",
      "/oc to-tickets #13" => "to-tickets",
      "/oc запусти скилл to-tickets по спецификации #13" => "to-tickets",
      "/oc continue to-tickets" => "to-tickets",
      "/oc не запускай to-spec" => "discussion",
      "/oc объясни, что такое to-spec" => "discussion",
      "/oc Спецификация согласована" => "discussion",
      "/oc продолжи" => "discussion",
      "/oc to-spec и to-tickets" => "discussion",
      "/oc to-spec\nпока не публикуй" => "discussion",
      "/oc to-tickets #0" => "discussion",
      "> /oc to-spec" => "discussion",
      "```\n/oc to-spec\n```" => "discussion",
      "Пример команды: /oc to-spec" => "discussion"
    }.each do |body, expected|
      outputs = route(body)
      assert_equal expected, outputs.fetch("stage"), body
      expected_agent = expected == "discussion" ? "github-discussion" : "github-issues"
      assert_equal expected_agent, outputs.fetch("agent"), body
      allowed = expected == "discussion" ? "deny" : "allow"
      assert_equal allowed, permission(outputs.fetch("agent"), "shell", 'gh issue create --title Spec --body Scope'), body
    end
    assert_equal "discussion", route("/oc to-spec", "GITHUB_EVENT_NAME" => "pull_request_review_comment").fetch("stage")
    assert_equal "discussion", route("/oc to-spec", "IS_PULL_REQUEST" => "true").fetch("stage")
    assert_equal "discussion", route("/oc to-spec", "IS_PULL_REQUEST" => "").fetch("stage")
  end

  def test_help_calls_are_separate_and_helper_shell_commands_stay_denied
    ["gh issue create --help", "gh issue edit --help"].each do |command|
      assert_equal "allow", permission("github-issues", "shell", command)
      assert_equal "deny", permission("github-discussion", "shell", command)
    end
    %w[github-issues github-triage github-discussion].each do |id|
      ["grep -iE parent", "echo ---", "cat file", "jq . file", "sed -n 1p file"].each do |command|
        assert_equal "deny", permission(id, "shell", command)
      end
      source = File.read(File.join(ROOT, ".opencode/agents", "#{id}.md"))
      assert_includes source, "docs/agents/github-shell.md"
    end
    instructions = File.read(File.join(ROOT, "docs/agents/github-shell.md"))
    assert_includes instructions, "one allowed `gh` command per shell tool call"
    assert_includes instructions, "After `Permission denied`"
  end

  private

  def route(body, env = {})
    workflow = YAML.safe_load_file(File.join(ROOT, ".github/workflows/opencode.yml"))
    command = workflow.fetch("jobs").fetch("opencode").fetch("steps").find { |step| step["id"] == "command" }
    Tempfile.create("opencode-route") do |file|
      _, stderr, status = Open3.capture3(
        {
          "COMMENT_BODY" => body,
          "GITHUB_EVENT_NAME" => "issue_comment",
          "IS_PULL_REQUEST" => "false",
          "GITHUB_OUTPUT" => file.path
        }.merge(env),
        "bash", "-euo", "pipefail", "-c", command.fetch("run")
      )
      assert status.success?, stderr
      File.read(file.path).lines.to_h { |line| line.strip.split("=", 2) }
    end
  end

  def agent(id)
    source = File.read(File.join(ROOT, ".opencode/agents", "#{id}.md"))
    YAML.safe_load(source.split("---", 3).fetch(1))
  end

  # Mirrors documented ordered whole-value wildcard matching, not the shell
  # scanner. Compound-command scanning is supplied by OpenCode itself.
  def permission(id, action, resource)
    agent(id).fetch("permissions").reduce("ask") do |result, rule|
      pattern = rule.fetch("resource")
      matches = File.fnmatch?(pattern, resource) ||
        (action == "shell" && pattern.end_with?(" *") && File.fnmatch?(pattern.delete_suffix(" *"), resource))
      File.fnmatch?(rule.fetch("action"), action) && matches ? rule.fetch("effect") : result
    end
  end
end
