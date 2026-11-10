import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const script = path.resolve("hooks/heartwood.mjs");

function tempDir(t) {
  const root = path.resolve(".test-tmp");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "heartwood-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(action, data, input = {}) {
  return spawnSync(process.execPath, [script, action], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, PLUGIN_DATA: data },
  });
}

test("short tool output passes through untouched", (t) => {
  const result = run("trim", tempDir(t), {
    session_id: "s1",
    tool_use_id: "tool1",
    tool_response: { output: "short", exit_code: 0 },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("large output is saved exactly and replaced with a bounded preview", (t) => {
  const data = tempDir(t);
  const original = `HEAD\n${"same line\n".repeat(900)}warning: keep this\nTAIL`;
  const result = run("trim", data, {
    session_id: "session/unsafe",
    tool_use_id: "tool:1",
    tool_response: original,
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.continue, false);
  assert.match(response.stopReason, /Heartwood folded/);
  assert.match(response.stopReason, /Exact original:/);
  assert.ok(response.stopReason.length < original.length);

  const savedDir = path.join(data, "trimmed-results", "session-unsafe");
  const saved = fs.readdirSync(savedDir);
  assert.equal(saved.length, 1);
  assert.equal(fs.readFileSync(path.join(savedDir, saved[0]), "utf8"), original);
});

test("non-zero command output gets the larger error allowance", (t) => {
  const data = tempDir(t);
  const output = "x".repeat(7000);
  const result = run("trim", data, {
    session_id: "s2",
    tool_use_id: "tool2",
    tool_response: { output, exit_code: 1 },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("checkpoint round-trip restores local continuity context", (t) => {
  const data = tempDir(t);
  const cwd = tempDir(t);
  let result = run("observe", data, {
    session_id: "s3",
    cwd,
    last_assistant_message: "Implemented the parser; tests are green.",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});

  result = run("checkpoint", data, { session_id: "s3", cwd, trigger: "manual" });
  assert.equal(result.status, 0, result.stderr);

  result = run("restore", data, { session_id: "s3", cwd, source: "compact" });
  assert.equal(result.status, 0, result.stderr);
  const restored = JSON.parse(result.stdout);
  assert.equal(restored.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(restored.hookSpecificOutput.additionalContext, /Implemented the parser/);
  assert.match(restored.hookSpecificOutput.additionalContext, /Working directory:/);
});

test("prune previews before deleting", (t) => {
  const data = tempDir(t);
  const dir = path.join(data, "trimmed-results", "s4");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "old.txt");
  fs.writeFileSync(file, "old");
  const old = new Date(Date.now() - 30 * 86_400_000);
  fs.utimesSync(file, old, old);

  let result = spawnSync(process.execPath, [script, "prune", "--dry-run", "--days", "14"], {
    encoding: "utf8",
    env: { ...process.env, PLUGIN_DATA: data },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Would remove 1/);
  assert.ok(fs.existsSync(file));

  result = spawnSync(process.execPath, [script, "prune", "--days", "14"], {
    encoding: "utf8",
    env: { ...process.env, PLUGIN_DATA: data },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Removed 1/);
  assert.ok(!fs.existsSync(file));
});
