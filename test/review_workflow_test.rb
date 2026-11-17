require "minitest/autorun"
require "yaml"
require "json"
require "open3"
require "tmpdir"
require "fileutils"

class ReviewWorkflowTest < Minitest::Test
  ROOT = File.expand_path("..", __dir__)

  def workflow
    YAML.safe_load_file(File.join(ROOT, ".github/workflows/agent-review.yml"))
  end

  def test_first_installation_skips_review_without_loading_pr_policy_or_model
    policy = workflow.fetch("jobs").fetch("policy")
    probe = policy.fetch("steps").find { |step| step["id"] == "installation" }
    Dir.mktmpdir("review-bootstrap-") do |dir|
      output = File.join(dir, "output")
      summary = File.join(dir, "summary")
      FileUtils.mkdir_p(File.join(dir, "policy"))
      _, stderr, status = Open3.capture3(
        { "GITHUB_OUTPUT" => output, "GITHUB_STEP_SUMMARY" => summary },
        "bash", "-euo", "pipefail", "-c", probe.fetch("run"), chdir: dir
      )
      assert status.success?, stderr
      assert_includes File.read(output), "ready=false"
      assert_includes File.read(summary), "NOT performed"
      assert_includes File.read(summary), "bootstrap_required"
      assert_equal "needs.policy.outputs.ready == 'true'", workflow.fetch("jobs").fetch("review").fetch("if")
      refute_includes policy.to_yaml, "secrets."

      # Once installed, a missing adapter is corruption/infra, not another
      # installation exemption.
      FileUtils.mkdir_p(File.join(dir, "policy/.github/workflows"))
      File.write(File.join(dir, "policy/.github/workflows/agent-review.yml"), "installed")
      File.write(output, "")
      _, _, status = Open3.capture3(
        { "GITHUB_OUTPUT" => output, "GITHUB_STEP_SUMMARY" => summary },
        "bash", "-euo", "pipefail", "-c", probe.fetch("run"), chdir: dir
      )
      refute status.success?
      refute_includes File.read(output), "ready=true"

      %w[tooling/agent-review.mjs tooling/agent-policy.mjs REVIEW.md
         .opencode/agents/github-review.md .opencode/agents/github-implementer.md
         tooling/agent-runner/Dockerfile tooling/agent-runner/opencode.json
         .agents/skills/implement-spec/SKILL.md].each do |file|
        path = File.join(dir, "policy", file)
        FileUtils.mkdir_p(File.dirname(path))
        File.write(path, "trusted fixture")
      end
      File.write(output, "")
      File.write(summary, "")
      _, stderr, status = Open3.capture3(
        { "GITHUB_OUTPUT" => output, "GITHUB_STEP_SUMMARY" => summary },
        "bash", "-euo", "pipefail", "-c", probe.fetch("run"), chdir: dir
      )
      assert status.success?, stderr
      assert_includes File.read(output), "ready=true"
      refute_includes File.read(summary), "bootstrap_required"
    end
  end

  def test_review_has_only_pr_and_owner_manual_entrypoints
    assert_equal %w[pull_request workflow_dispatch], workflow.fetch("on").keys.sort
    assert_equal %w[opened reopened synchronize ready_for_review], workflow.fetch("on").fetch("pull_request").fetch("types")
    assert_equal({}, workflow.fetch("permissions"))
    job = workflow.fetch("jobs").fetch("review")
    assert_equal true, job.fetch("concurrency").fetch("cancel-in-progress")
    assert_includes job.fetch("concurrency").fetch("group"), "agent-review-"
    policy = workflow.fetch("jobs").fetch("policy")
    assert_includes policy.fetch("if"), "github.repository_owner"
    assert_includes policy.fetch("if"), "github-actions[bot]"
    refute_includes policy.fetch("if"), "!= 'Bot'"
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
    assert_equal "${{ needs.policy.outputs.sha }}", trusted.fetch("with").fetch("ref")
    assert_equal "${{ github.event.repository.default_branch }}",
      workflow.fetch("jobs").fetch("policy").fetch("steps").first.fetch("with").fetch("ref")
    assert_equal "policy", trusted.fetch("with").fetch("path")
    assert_equal "${{ steps.gate.outputs.sha }}", candidate.fetch("with").fetch("ref")
    [trusted, candidate].each { |s| assert_equal false, s.fetch("with").fetch("persist-credentials") }
    model = steps.find { |s| s["id"] == "model" }
    assert_equal "policy", model.fetch("working-directory")
    assert_equal ["OPENCODE_API_KEY"], model.fetch("env").keys
    assert_includes model.fetch("run"), "$(cat REVIEW.md)"
    assert_includes model.fetch("run"), "--read-only --cap-drop ALL"
    assert_includes File.read(File.join(ROOT, "tooling/agent-runner/Dockerfile")), '"--standalone", "--archived"'
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
    assert_equal %w[external_directory read], permissions.select { |p| p["effect"] == "allow" }.map { |p| p["action"] }.uniq.sort
    assert_equal "/workspace/*", permissions.find { |p| p["action"] == "external_directory" }.fetch("resource")
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
    refute_includes workflow.to_s, "RELEASE_PLEASE_TOKEN"
    refute_includes workflow.to_s, "id-token"
    assert_includes workflow.fetch("jobs").fetch("review").fetch("name"), "agent-admission:pr-"
    publisher = steps.last
    assert_includes publisher.fetch("if"), "always()"
    assert_equal %w[CONTEXT_OUTCOME GH_TOKEN INSTALL_OUTCOME JOB_STATUS MODEL_OUTCOME MODEL_STARTED MODEL_VERDICT], publisher.fetch("env").keys.sort
    assert_includes steps.find { |s| s["id"] == "model" }.fetch("run"), "timeout --signal=TERM --kill-after=20s 10m"
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

  # Run the public workflow adapter with its actual shared policy module.
  # Replace only the external GitHub HTTP and gh process boundaries.
  def with_review_runner
    tmp_root = File.join(Dir.tmpdir, "opencode")
    FileUtils.mkdir_p(tmp_root)
    Dir.mktmpdir("review-workflow-", tmp_root) do |dir|
      policy = File.join(dir, "policy")
      FileUtils.mkdir_p([File.join(policy, "tooling"), File.join(policy, ".opencode/agents"),
                        File.join(dir, "candidate"), File.join(dir, "bin")])
      %w[agent-review.mjs agent-policy.mjs].each do |name|
        FileUtils.cp(File.join(ROOT, "tooling", name), File.join(policy, "tooling", name))
      end
      FileUtils.cp(File.join(ROOT, ".opencode/agents/github-review.md"), File.join(policy, ".opencode/agents"))
      File.write(File.join(dir, "network.mjs"), <<~JS)
        import fs from "node:fs"
        const fixtures = JSON.parse(fs.readFileSync(process.env.FIXTURE_ROUTES, "utf8"))
        globalThis.fetch = async (url, options = {}) => {
          const parsed = new URL(url)
          const key = parsed.pathname + parsed.search + (options.headers?.Accept === "application/vnd.github.diff" ? "#diff" : "")
          fs.appendFileSync(process.env.FIXTURE_REQUESTS, key + "\\n")
          if (!Object.hasOwn(fixtures, key)) throw new Error("Unexpected HTTP request: " + key)
          const fixture = fixtures[key]
          return new Response(typeof fixture.body === "string" ? fixture.body : JSON.stringify(fixture.body),
            {status: fixture.status ?? 200})
        }
      JS
      gh = File.join(dir, "bin/gh")
      File.write(gh, <<~RUBY)
        #!#{RbConfig.ruby}
        require "json"
        File.write(ENV.fetch("FIXTURE_PUBLISHED"), JSON.generate({args: ARGV, body: STDIN.read}))
      RUBY
      File.chmod(0o700, gh)
      sha = "a" * 40
      pr = {
        "state" => "open", "head" => {"sha" => sha, "ref" => "feat/example", "repo" => {"full_name" => "owner/repo"}},
        "base" => {"ref" => "main", "repo" => {"full_name" => "owner/repo"}},
        "user" => {"login" => "github-actions[bot]", "type" => "Bot"}, "changed_files" => 0
      }
      event = {"repository" => {"default_branch" => "main"}, "pull_request" => {"head" => {"sha" => sha}}}
      event_path = File.join(dir, "event.json")
      File.write(event_path, JSON.generate(event))
      routes = {"/repos/owner/repo/pulls/19" => {body: pr}}
      env = {
        "GH_REPO" => "owner/repo", "REVIEW_PR" => "19", "GITHUB_EVENT_PATH" => event_path,
        "GITHUB_EVENT_NAME" => "pull_request", "GITHUB_ACTOR" => "owner", "GITHUB_REF_NAME" => "main",
        "GITHUB_RUN_ID" => "900", "GITHUB_RUN_ATTEMPT" => "1", "RUNNER_TEMP" => dir,
        "GITHUB_OUTPUT" => File.join(dir, "output"), "GH_TOKEN" => "fixture-token",
        "FIXTURE_ROUTES" => File.join(dir, "routes.json"), "FIXTURE_REQUESTS" => File.join(dir, "requests"),
        "FIXTURE_PUBLISHED" => File.join(dir, "published.json"),
        "PATH" => "#{File.join(dir, "bin")}:#{ENV.fetch("PATH")}"
      }
      run = lambda do |command, extra = {}|
        File.write(env.fetch("FIXTURE_ROUTES"), JSON.generate(routes))
        stdout, stderr, status = Open3.capture3(env.merge(extra), "node", "--import", File.join(dir, "network.mjs"),
          File.join(policy, "tooling/agent-review.mjs"), command)
        assert status.success?, "#{command} failed:\n#{stdout}\n#{stderr}"
      end
      yield dir, policy, env, pr, routes, run
    end
  end

  def add_admission_routes(routes, attempts)
    routes["/repos/owner/repo/actions/workflows/agent-review.yml/runs?per_page=100&page=1"] = {
      body: {total_count: 1, workflow_runs: [{id: 900, run_attempt: attempts, path: ".github/workflows/agent-review.yml"}]}
    }
    (1..attempts).each do |attempt|
      routes["/repos/owner/repo/actions/runs/900/attempts/#{attempt}/jobs?per_page=100&page=1"] = {
        body: {total_count: 1, jobs: [{name: "agent-admission:pr-19:review", conclusion: attempt == attempts ? nil : "cancelled"}]}
      }
    end
  end

  def test_adapter_admits_same_repo_automation_but_rerun_four_exhausts_its_own_budget
    with_review_runner do |dir, policy, env, _pr, routes, run|
      add_admission_routes(routes, 3)
      run.call("gate", "GITHUB_RUN_ATTEMPT" => "3")
      assert_includes File.read(env.fetch("GITHUB_OUTPUT")), "run=true\nsha=#{"a" * 40}"
      assert_equal 3, JSON.parse(File.read(File.join(policy, "review-state.json"))).fetch("count")
      add_admission_routes(routes, 4)
      File.write(env.fetch("GITHUB_OUTPUT"), "")
      run.call("gate", "GITHUB_RUN_ATTEMPT" => "4")
      assert_includes File.read(env.fetch("GITHUB_OUTPUT")), "run=false"
      assert_equal "limit_exhausted", JSON.parse(File.read(File.join(policy, "review-state.json"))).fetch("decision")
      run.call("publish")
      assert_includes File.read(File.join(dir, "published.json")), "limit_exhausted"
    end
  end

  def test_adapter_rejects_forks_stale_events_and_nonowner_dispatch_without_publication
    ["fork", "stale", "nonowner"].each do |scenario|
      with_review_runner do |dir, policy, _env, pr, _routes, run|
        extra = {}
        pr.fetch("head").fetch("repo")["full_name"] = "outsider/repo" if scenario == "fork"
        pr.fetch("head")["sha"] = "b" * 40 if scenario == "stale"
        extra = {"GITHUB_EVENT_NAME" => "workflow_dispatch", "GITHUB_ACTOR" => "outsider"} if scenario == "nonowner"
        run.call("gate", extra)
        refute JSON.parse(File.read(File.join(policy, "review-state.json")))["publishAllowed"]
        run.call("publish")
        refute File.exist?(File.join(dir, "published.json"))
        assert_equal ["/repos/owner/repo/pulls/19"], File.readlines(File.join(dir, "requests"), chomp: true)
      end
    end
  end

  def test_adapter_history_failure_is_infra_before_model
    with_review_runner do |dir, policy, env, _pr, routes, run|
      routes["/repos/owner/repo/actions/workflows/agent-review.yml/runs?per_page=100&page=1"] = {
        status: 403, body: {message: "not available"}
      }
      run.call("gate")
      assert_includes File.read(env.fetch("GITHUB_OUTPUT")), "run=false"
      assert_equal "infra", JSON.parse(File.read(File.join(policy, "review-state.json"))).fetch("decision")
      run.call("publish")
      assert_includes File.read(File.join(dir, "published.json")), "infra"
    end
  end

  def test_publisher_distinguishes_setup_timeout_agent_failure_and_success
    scenarios = {
      "setup" => [{"MODEL_STARTED" => ""}, "infra"],
      "context" => [{"CONTEXT_OUTCOME" => "failure"}, "infra"],
      "install" => [{"INSTALL_OUTCOME" => "failure"}, "infra"],
      "timeout" => [{"MODEL_VERDICT" => "timeout", "MODEL_OUTCOME" => "failure"}, "timeout"],
      "failure" => [{"MODEL_VERDICT" => "agent_failed", "MODEL_OUTCOME" => "failure"}, "agent_failed"],
      "success" => [{}, "No confirmed defects found"]
    }
    scenarios.each_value do |extra, expected|
      with_review_runner do |dir, policy, _env, _pr, _routes, run|
        File.write(File.join(policy, "review-state.json"), JSON.generate({
          decision: "allow", sha: "a" * 40, publishAllowed: true
        }))
        File.write(File.join(dir, "agent-review.md"), "No confirmed defects found")
        run.call("publish", {
          "MODEL_STARTED" => "true", "MODEL_VERDICT" => "reviewed", "MODEL_OUTCOME" => "success",
          "CONTEXT_OUTCOME" => "success", "INSTALL_OUTCOME" => "success", "JOB_STATUS" => "success"
        }.merge(extra))
        published = JSON.parse(File.read(File.join(dir, "published.json")))
        assert_equal %w[pr comment 19 --repo owner/repo --body-file -], published.fetch("args")
        assert_includes published.fetch("body"), expected
        assert_includes published.fetch("body"), "a" * 40
        refute_includes published.fetch("body"), "No confirmed defects found" unless expected == "No confirmed defects found"
      end
    end
  end

  def test_publisher_drops_cancelled_and_stale_results
    ["cancelled", "stale"].each do |scenario|
      with_review_runner do |dir, policy, _env, pr, _routes, run|
        File.write(File.join(policy, "review-state.json"), JSON.generate({
          decision: "allow", sha: "a" * 40, publishAllowed: true
        }))
        pr.fetch("head")["sha"] = "b" * 40 if scenario == "stale"
        run.call("publish", "JOB_STATUS" => scenario == "cancelled" ? "cancelled" : "success")
        refute File.exist?(File.join(dir, "published.json"))
      end
    end
  end

  def test_context_collects_real_diff_and_marks_missing_approval_and_ci_as_gaps
    with_review_runner do |_dir, policy, _env, _pr, routes, run|
      File.write(File.join(policy, "review-state.json"), JSON.generate({sha: "a" * 40}))
      %w[issues/19/comments pulls/19/reviews pulls/19/comments pulls/19/files].each do |endpoint|
        routes["/repos/owner/repo/#{endpoint}?per_page=100&page=1"] = {body: []}
      end
      routes["/repos/owner/repo/pulls/19#diff"] = {body: "diff --git a/example b/example\n"}
      routes["/repos/owner/repo/commits/#{"a" * 40}/check-runs?per_page=100&page=1"] = {status: 403, body: {}}
      routes["/repos/owner/repo/commits/#{"a" * 40}/statuses?per_page=100&page=1"] = {body: []}
      routes["/repos/owner/repo/actions/runs?head_sha=#{"a" * 40}&per_page=100&page=1"] = {body: {total_count: 0, workflow_runs: []}}
      run.call("context")
      context = JSON.parse(File.read(File.join(policy, "review-context.json")))
      assert_equal "diff --git a/example b/example\n", context.fetch("diff")
      assert_includes context.fetch("gaps"), "No explicit approval-comment evidence collected"
      assert_includes context.fetch("gaps"), "No CI evidence for reviewed SHA"
      assert_includes context.fetch("gaps"), "CI checks: unavailable; do not infer success or approval"
      agent = File.read(File.join(policy, ".opencode/agents/github-review.md"))
      refute_includes agent, "__CANDIDATE_DIRECTORY__"
      assert_includes agent, "/workspace/*"
      permissions = YAML.safe_load(agent.split("---")[1]).fetch("permissions")
      assert_equal %w[external_directory read], permissions.select { |p| p["effect"] == "allow" }.map { |p| p["action"] }.uniq.sort
    end
  end

  def test_model_shell_records_timeout_and_missing_setup_without_publishing_partial_output
    script = workflow.fetch("jobs").fetch("review").fetch("steps").find { |s| s["id"] == "model" }.fetch("run")
    with_review_runner do |dir, policy, _env, _pr, _routes, _run|
      File.write(File.join(policy, "REVIEW.md"), "Explicit trusted criteria")
      File.write(File.join(policy, "review-context.json"), "{}")
      model = File.join(dir, "bin/docker")
      File.write(model, "#!/bin/sh\ntest -z \"${GH_TOKEN:-}\" || exit 99\nprintf '%s\\n' \"$@\" > \"$FIXTURE_DOCKER_ARGS\"\nprintf 'model result'\nexit \"${FIXTURE_MODEL_EXIT:-0}\"\n")
      File.chmod(0o700, model)
      timeout = File.join(dir, "bin/timeout")
      File.write(timeout, <<~SH)
        #!/bin/sh
        printf '%s\\n' "$1" "$2" "$3" > "$FIXTURE_TIMEOUT_ARGS"
        if [ "${FIXTURE_TIMEOUT_EXIT:-0}" -ne 0 ]; then exit "$FIXTURE_TIMEOUT_EXIT"; fi
        shift 3
        exec "$@"
      SH
      File.chmod(0o700, timeout)
      [
        [{}, "reviewed", true],
        [{"FIXTURE_TIMEOUT_EXIT" => "124"}, "timeout", false],
        [{"FIXTURE_MODEL_EXIT" => "1"}, "agent_failed", false],
        [{"OPENCODE_API_KEY" => nil}, "infra", false]
      ].each do |extra, expected, success|
        output = File.join(dir, "model-output")
        File.write(output, "")
        env = {
          "PATH" => "#{File.join(dir, "bin")}:/usr/bin:/bin", "OPENCODE_API_KEY" => "fixture-only",
          "OPENCODE_MODEL" => "fixture/model", "REVIEW_PR" => "19", "GH_TOKEN" => nil,
          "GITHUB_OUTPUT" => output, "RUNNER_TEMP" => dir,
          "GITHUB_WORKSPACE" => dir, "GITHUB_RUN_ID" => "700", "GITHUB_RUN_ATTEMPT" => "1",
          "FIXTURE_DOCKER_ARGS" => File.join(dir, "docker-args"),
          "FIXTURE_TIMEOUT_ARGS" => File.join(dir, "timeout-args")
        }.merge(extra)
        _stdout, stderr, status = Open3.capture3(env, "/bin/bash", "-c", script, chdir: policy)
        assert_equal success, status.success?, stderr
        values = File.read(output)
        assert_includes values, "verdict=#{expected}"
        if expected == "infra"
          refute_includes values, "started=true"
        else
          assert_includes values, "started=true"
          assert_equal ["--signal=TERM", "--kill-after=20s", "10m"], File.readlines(File.join(dir, "timeout-args"), chomp: true)
          unless extra.key?("FIXTURE_TIMEOUT_EXIT")
            args = File.read(File.join(dir, "docker-args"))
            assert_includes args, "dst=/workspace,readonly"
            assert_includes args, "--read-only"
            refute_includes args, "GH_TOKEN"
          end
        end
      end
    end
  end
end
