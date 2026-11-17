# Real browser boundary: successful and deliberately broken Rails smoke runs.
require "json"
require "open3"
require "tmpdir"
require_relative "resource_assertions"

def assert(condition, message)
  raise message unless condition
end

root = File.expand_path("..", __dir__)
Dir.mktmpdir("browser-evidence-test-") do |directory|
  [nil, "--probe-browser-failure"].each_with_index do |mode, index|
    evidence = File.join(directory, index.to_s)
    output, status = Open3.capture2e(
      { "SMOKE_EVIDENCE_DIR" => evidence },
      "ruby", "scripts/smoke.rb", *[mode].compact, chdir: root
    )
    puts output.lines.last(12).join
    raise "unexpected smoke status:\n#{output}" unless status.success? == mode.nil?
    result = JSON.parse(File.read(File.join(evidence, "result.json")))
    raise "wrong evidence verdict" unless result.fetch("status") == (mode ? "failed" : "passed")
    traces = Dir.glob(File.join(evidence, "**", "*.trace.zip"))
    raise "missing #{mode ? 'failure' : 'success'} trace" if traces.empty?
    raise "empty trace" unless traces.all? { |path| File.size(path) > 100 }
    traces.each do |path|
      entries, zip_status = Open3.capture2("unzip", "-Z1", path)
      raise "unreadable trace" unless zip_status.success? && entries.include?(".trace")
      raise "trace missing screenshots" unless entries.include?(".jpeg")
    end
    if mode && Dir.glob(File.join(evidence, "**", "*.png")).empty?
      raise "missing failure screenshot"
    end
    raise "missing Vitest results" if Dir.glob(File.join(evidence, "**", "results.json")).empty?
    logs = Dir.glob(File.join(evidence, "logs", "*.log"))
    raise "missing diagnostics" if logs.empty?
    raise "database credential leaked" if logs.any? { |path| File.read(path).match?(/postgres(?:ql)?:\/\/[^\s]+:[^\s]+@/) }
    resources = JSON.parse(output.lines.find { |line| line.start_with?("SMOKE_RESOURCES ") }.delete_prefix("SMOKE_RESOURCES "))
    assert_clean(resources)
  end
end
puts "Browser evidence retained on success and failure; runtime resources cleaned"
