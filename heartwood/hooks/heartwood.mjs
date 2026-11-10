#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULTS = Object.freeze({
  threshold_chars: 6000,
  error_multiplier: 3,
  head_chars: 2600,
  tail_chars: 1600,
  error_lines: 20,
  retention_days: 14,
});

const CONFIG_KEYS = new Set(Object.keys(DEFAULTS));
const standaloneDataDir = process.argv[3] === "--data" ? process.argv[4] : undefined;

function dataRoot() {
  return path.resolve(
    process.env.PLUGIN_DATA ||
      process.env.HEARTWOOD_DATA ||
      standaloneDataDir ||
      path.join(process.cwd(), ".heartwood-dev-data"),
  );
}

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function readEvent() {
  const raw = readStdin().trim();
  return raw ? JSON.parse(raw) : {};
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safePart(value, fallback = "unknown") {
  const clean = String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return clean.slice(0, 100) || fallback;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    // Some Windows sandbox providers allow file writes but reject rename.
    if (!error || !["EPERM", "EACCES", "EXDEV"].includes(error.code)) throw error;
    fs.writeFileSync(file, content, "utf8");
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The completed target is authoritative; a stranded temp file is harmless.
    }
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  const root = dataRoot();
  const file = path.join(root, "config.json");
  ensureDir(root);
  if (!fs.existsSync(file)) writeAtomic(file, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
  const stored = readJson(file, {});
  const config = { ...DEFAULTS };
  for (const key of CONFIG_KEYS) {
    if (Number.isFinite(stored[key]) && stored[key] >= 0) config[key] = stored[key];
  }
  return config;
}

function appendLog(record) {
  const file = path.join(dataRoot(), "heartwood-log.jsonl");
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
  try {
    const stat = fs.statSync(file);
    if (stat.size > 512_000) {
      const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-500);
      writeAtomic(file, `${lines.join("\n")}\n`);
    }
  } catch {
    // Logging must never break a Codex tool call.
  }
}

function responseText(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value, null, 2);
}

function containsNonText(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsNonText);
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  if (["image", "audio", "resource", "resource_link", "blob"].includes(type)) return true;
  return Object.values(value).some(containsNonText);
}

function isErrorResponse(value) {
  if (!value || typeof value !== "object") return false;
  if (value.isError === true || value.is_error === true) return true;
  const code = value.exit_code ?? value.exitCode ?? value.status;
  return typeof code === "number" && code !== 0;
}

function normalizeLines(text) {
  const withoutAnsi = text.replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
  const progressCollapsed = withoutAnsi
    .split("\n")
    .map((line) => line.split("\r").at(-1))
    .map((line) =>
      line.length > 1200 ? `${line.slice(0, 800)} … [long line clipped: ${line.length} chars]` : line,
    );

  const folded = [];
  for (let i = 0; i < progressCollapsed.length; ) {
    let j = i + 1;
    while (j < progressCollapsed.length && progressCollapsed[j] === progressCollapsed[i]) j += 1;
    const count = j - i;
    if (count <= 3) {
      for (let n = 0; n < count; n += 1) folded.push(progressCollapsed[i]);
    } else {
      folded.push(progressCollapsed[i]);
      folded.push(`[Heartwood folded ${count - 1} repeated lines]`);
    }
    i = j;
  }
  return folded.join("\n");
}

function edgeSlice(text, count, fromEnd = false) {
  if (text.length <= count) return text;
  const slice = fromEnd ? text.slice(-count) : text.slice(0, count);
  const newline = fromEnd ? slice.indexOf("\n") : slice.lastIndexOf("\n");
  if (newline < 0) return slice;
  return fromEnd ? slice.slice(newline + 1) : slice.slice(0, newline);
}

function buildPreview(original, config) {
  const normalized = normalizeLines(original);
  const head = edgeSlice(normalized, config.head_chars);
  const tail = edgeSlice(normalized, config.tail_chars, true);
  const middleStart = Math.min(head.length, normalized.length);
  const middleEnd = Math.max(middleStart, normalized.length - tail.length);
  const middle = normalized.slice(middleStart, middleEnd);
  const seen = new Set();
  const diagnostics = [];
  for (const line of middle.split("\n")) {
    if (!/\b(error|warning|warn|failed|failure|exception|fatal|traceback)\b/i.test(line)) continue;
    const clipped = line.length > 500 ? `${line.slice(0, 500)} …` : line;
    if (!seen.has(clipped)) {
      seen.add(clipped);
      diagnostics.push(clipped);
    }
    if (diagnostics.length >= config.error_lines) break;
  }

  const sections = [head];
  sections.push(`\n[Heartwood removed ${Math.max(0, original.length - head.length - tail.length)} middle characters]`);
  if (diagnostics.length) sections.push(`\nMiddle diagnostics:\n${diagnostics.join("\n")}`);
  if (tail && tail !== head) sections.push(`\nTail:\n${tail}`);
  return sections.join("\n").trim();
}

function sessionDir(event) {
  return path.join(dataRoot(), "sessions", safePart(event.session_id));
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 4000,
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function capLines(text, count = 80) {
  const lines = String(text || "").split("\n");
  if (lines.length <= count) return lines.join("\n");
  return `${lines.slice(0, count).join("\n")}\n… ${lines.length - count} more lines`;
}

function workspaceDigest(cwd) {
  const root = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return { cwd, git: false };
  return {
    cwd,
    git: true,
    root,
    branch: runGit(cwd, ["branch", "--show-current"]) || "detached",
    status: capLines(runGit(cwd, ["status", "--short", "--untracked-files=normal"])),
    diff_stat: capLines(runGit(cwd, ["diff", "--stat"]), 40),
    recent_commits: capLines(runGit(cwd, ["log", "-5", "--oneline", "--decorate"]), 5),
  };
}

function renderCheckpoint(state) {
  const workspace = state.workspace || {};
  const lines = [
    "Heartwood continuity card (supplemental; verify changing facts with tools):",
    `Captured: ${state.updated_at}`,
    `Working directory: ${state.cwd}`,
  ];
  if (workspace.git) {
    lines.push(`Git root: ${workspace.root}`);
    lines.push(`Branch: ${workspace.branch}`);
    lines.push("Working tree:");
    lines.push(workspace.status || "clean");
    if (workspace.diff_stat) lines.push(`Diff summary:\n${workspace.diff_stat}`);
    if (workspace.recent_commits) lines.push(`Recent commits:\n${workspace.recent_commits}`);
  } else {
    lines.push("Git: no repository detected");
  }
  if (state.last_assistant_message) {
    lines.push(`Latest assistant handoff:\n${state.last_assistant_message.slice(-3200)}`);
  }
  return lines.join("\n").slice(0, 5800);
}

function trim(event) {
  const config = loadConfig();
  if (containsNonText(event.tool_response)) return;
  const original = responseText(event.tool_response);
  const limit = config.threshold_chars * (isErrorResponse(event.tool_response) ? config.error_multiplier : 1);
  if (original.length <= limit) return;

  const dir = path.join(dataRoot(), "trimmed-results", safePart(event.session_id));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${safePart(event.tool_use_id)}-${stamp}.txt`);
  try {
    writeAtomic(file, original);
  } catch (error) {
    appendLog({ event: "trim_skipped", reason: "save_failed", error: String(error) });
    return;
  }

  const preview = buildPreview(original, config);
  const saved = `\n\n[Heartwood trimmed ${original.length} characters to ${preview.length}. Exact original: ${file}]`;
  appendLog({
    event: "trimmed",
    session_id: event.session_id,
    tool_use_id: event.tool_use_id,
    original_chars: original.length,
    preview_chars: preview.length,
    saved: file,
  });
  emit({ continue: false, stopReason: `${preview}${saved}` });
}

function observe(event) {
  const file = path.join(sessionDir(event), "state.json");
  const previous = readJson(file, {});
  const state = {
    ...previous,
    session_id: event.session_id,
    cwd: event.cwd || process.cwd(),
    updated_at: new Date().toISOString(),
    workspace: workspaceDigest(event.cwd || process.cwd()),
    last_assistant_message:
      typeof event.last_assistant_message === "string"
        ? event.last_assistant_message.slice(-5000)
        : previous.last_assistant_message || "",
  };
  writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
  emit({});
}

function checkpoint(event) {
  const dir = sessionDir(event);
  const stateFile = path.join(dir, "state.json");
  const previous = readJson(stateFile, {});
  const state = {
    ...previous,
    session_id: event.session_id,
    cwd: event.cwd || process.cwd(),
    updated_at: new Date().toISOString(),
    trigger: event.trigger || "unknown",
    workspace: workspaceDigest(event.cwd || process.cwd()),
  };
  writeAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  writeAtomic(path.join(dir, "checkpoint.md"), `${renderCheckpoint(state)}\n`);
  appendLog({ event: "checkpoint", session_id: event.session_id, trigger: state.trigger });
  emit({});
}

function restore(event) {
  const file = path.join(sessionDir(event), "checkpoint.md");
  if (!fs.existsSync(file)) {
    emit({});
    return;
  }
  const content = fs.readFileSync(file, "utf8").trim();
  appendLog({ event: "restored", session_id: event.session_id, chars: content.length });
  emit({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: content,
    },
  });
}

function walkFiles(dir, output = []) {
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, output);
    else if (entry.isFile()) output.push(full);
  }
  return output;
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function status() {
  const root = dataRoot();
  const resultFiles = walkFiles(path.join(root, "trimmed-results"));
  const checkpointFiles = walkFiles(path.join(root, "sessions"));
  const size = [...resultFiles, ...checkpointFiles].reduce((sum, file) => sum + fs.statSync(file).size, 0);
  const logs = fs.existsSync(path.join(root, "heartwood-log.jsonl"))
    ? fs.readFileSync(path.join(root, "heartwood-log.jsonl"), "utf8").trim().split("\n").filter(Boolean)
    : [];
  const counts = {};
  for (const line of logs) {
    try {
      const event = JSON.parse(line).event || "unknown";
      counts[event] = (counts[event] || 0) + 1;
    } catch {
      counts.invalid = (counts.invalid || 0) + 1;
    }
  }
  process.stdout.write(
    [
      `Heartwood data: ${root}`,
      `Saved tool results: ${resultFiles.length}`,
      `Session state files: ${checkpointFiles.length}`,
      `Stored size: ${humanBytes(size)}`,
      `Events: ${JSON.stringify(counts)}`,
      `Config: ${JSON.stringify(loadConfig())}`,
    ].join("\n") + "\n",
  );
}

function prune(args) {
  const config = loadConfig();
  const dryRun = args.includes("--dry-run");
  const daysIndex = args.indexOf("--days");
  const days = daysIndex >= 0 ? Number(args[daysIndex + 1]) : config.retention_days;
  if (!Number.isFinite(days) || days < 0) throw new Error("--days must be a non-negative number");
  const cutoff = Date.now() - days * 86_400_000;
  const files = walkFiles(path.join(dataRoot(), "trimmed-results")).filter(
    (file) => fs.statSync(file).mtimeMs < cutoff,
  );
  let bytes = 0;
  for (const file of files) {
    bytes += fs.statSync(file).size;
    if (!dryRun) fs.unlinkSync(file);
  }
  process.stdout.write(
    `${dryRun ? "Would remove" : "Removed"} ${files.length} saved result(s), ${humanBytes(bytes)}, older than ${days} day(s).\n`,
  );
}

function configure(args) {
  const [key, rawValue] = args;
  if (!CONFIG_KEYS.has(key)) throw new Error(`Unknown setting: ${key || "(missing)"}`);
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) throw new Error("Setting value must be a non-negative number");
  const config = { ...loadConfig(), [key]: value };
  writeAtomic(path.join(dataRoot(), "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write(`${key}=${value}\n`);
}

function main() {
  const [action = "status", ...args] = process.argv.slice(2);
  if (["trim", "observe", "checkpoint", "restore"].includes(action)) {
    const event = readEvent();
    if (action === "trim") trim(event);
    else if (action === "observe") observe(event);
    else if (action === "checkpoint") checkpoint(event);
    else restore(event);
    return;
  }
  if (action === "status") status();
  else if (action === "prune") prune(args);
  else if (action === "config") configure(args);
  else throw new Error(`Unknown action: ${action}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Heartwood: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
