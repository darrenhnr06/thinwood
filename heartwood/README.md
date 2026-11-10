# Heartwood

Heartwood is a local context-hygiene plugin for Codex. It keeps the durable core of a long coding session while shaving down noisy shell output before that output settles into the conversation.

It is inspired by [Thinwood](https://github.com/alan-r-henry/thinwood), but it is a fresh Codex-native implementation rather than a port of Claude-specific hooks.

## What it does

1. **Trims oversized shell results before they enter history.** Heartwood keeps the head, tail, and useful error lines, folds repeated lines, saves the exact original under Codex's plugin data directory, and replaces the model-visible result with the compact preview plus the saved path.
2. **Keeps a continuity card across compaction.** Before Codex compacts, Heartwood records deterministic workspace facts (branch, working-tree status, diff summary, recent commits) and the most recent assistant handoff. After compaction, it injects that short local checkpoint as supplemental developer context.
3. **Stays local.** There are no network calls, API keys, model downloads, or third-party packages.

Heartwood deliberately does **not** replace Codex compaction. Codex's hook contract does not expose mutable old history to `PreCompact`, and official guidance treats the built-in compacted window as canonical. Heartwood therefore complements compaction instead of rewriting it.

## Requirements

- Codex in the ChatGPT desktop app or Codex CLI with lifecycle hooks enabled.
- Node.js 18 or newer available as `node`.
- A local session. Command hooks do not run in cloud-orchestrated sessions.

## Install from this checkout

From this repository root:

```sh
codex plugin marketplace add .
```

Then open `/plugins` in Codex CLI (or the Plugins Directory in the desktop app), select the **thinwood-codex** marketplace, and install **Heartwood**. Start a new chat afterward.

Codex will skip the hooks until you review them. Use `/hooks` in the CLI or **Settings > Hooks** in the desktop app, inspect the commands, and trust them if they match this checkout.

## Defaults

| Setting | Default | Meaning |
| --- | ---: | --- |
| `threshold_chars` | 6000 | Successful shell results must exceed this size before trimming. |
| `error_multiplier` | 3 | Non-zero shell results get this much extra room. |
| `head_chars` | 2600 | Approximate preview budget for the beginning. |
| `tail_chars` | 1600 | Approximate preview budget for the end. |
| `error_lines` | 20 | Maximum distinct warning/error lines rescued from the middle. |
| `retention_days` | 14 | Default age used by the maintenance skill when pruning is requested. |

Heartwood creates `config.json` in `PLUGIN_DATA` on first use. The bundled `heartwood-status` skill can locate the active data directory, report activity and storage, preview cleanup, and update supported settings.

## Data and privacy

Saved originals can contain secrets that appeared in command output. Files remain on the same machine in Codex's plugin data directory, but they are plain text. Heartwood never uploads them and never deletes them automatically.

Use the maintenance skill to preview old-file cleanup. Actual deletion happens only when you explicitly ask for it.

## Development

```sh
cd heartwood
node --test
```

The hook runner is a single dependency-free ES module. Tests use Node's built-in test runner.

## Codex-specific design notes

- `PostToolUse` can replace the model-visible result after a command completes. Heartwood uses `continue: false` so nested code-mode calls still resolve rather than being rejected as blocked.
- `PreCompact` records a checkpoint but does not attempt to mutate history.
- `SessionStart` with source `compact` restores the checkpoint before the next model request.
- Oversized non-shell results, images, and hosted tools are left alone.
- Plugin-bundled hooks require explicit trust and make this a local/manual plugin, not a public-directory package.

## License

MIT. Thinwood is a separate MIT-licensed project; Heartwood contains no copied Thinwood source.
