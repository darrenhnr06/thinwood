---
name: heartwood-status
description: Inspect Heartwood's local context-trimming activity, storage, checkpoints, and settings, or preview and perform requested cleanup of saved tool results. Use only for an installed Heartwood Codex plugin.
---

# Heartwood status

Locate Heartwood's active plugin-data directory before running maintenance. Prefer a path already present in a Heartwood trim marker. Otherwise search the local Codex data roots for `heartwood-log.jsonl` or a `config.json` whose parent also contains `trimmed-results` or `sessions`. Do not search outside Codex-owned data locations.

Run the bundled helper with an explicit data path so it reads the installed instance:

```sh
HEARTWOOD_DATA="<data-path>" node "<plugin-root>/hooks/heartwood.mjs" status
```

Use the platform's equivalent environment-variable syntax on Windows.

- Report the data path, saved-result count, checkpoint count, stored size, event totals, and current configuration concisely.
- To change a setting, confirm the requested key and value, then run `config <key> <number>` with the same `HEARTWOOD_DATA` value. Supported keys are `threshold_chars`, `error_multiplier`, `head_chars`, `tail_chars`, `error_lines`, and `retention_days`.
- For cleanup, always run `prune --dry-run [--days N]` first and report the count and size. Delete only when the user explicitly asks to prune/delete and the preview matches the requested scope; then run `prune [--days N]`.
- Never display saved tool-result contents unless the user asks for a specific saved file. Those files may contain secrets.
- If no active data directory is found, explain that Heartwood may not have run yet or its hooks may still need trust; do not create a fake status directory.
