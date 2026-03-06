# agtop

An htop-like TUI for monitoring AI coding agent sessions. Tracks Claude Code and Codex sessions running on your machine, showing real-time cost, token usage, tool invocations, and OS-level metrics.

![agtop](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- **Session discovery** -- automatically finds Claude Code (`~/.claude/projects/`) and Codex (`~/.codex/sessions/`) sessions
- **Cost estimation** -- computes per-session spend using LiteLLM pricing data, with plan-aware billing (retail, max, included)
- **Two list views** -- Summary (all sessions: duration, tokens, cost, tools, model) and Live (running sessions: CPU, memory, rates)
- **Real-time rates** -- tokens/min, cost/min, tools/min over a 60-second rolling window
- **OS process metrics** -- CPU%, memory, PID count for running sessions (macOS/Linux)
- **Last active tool** -- shows what a running agent is doing right now
- **Overview charts** -- sparkline charts for aggregate spend, tokens, CPU, and memory
- **Detail view** -- full cost breakdown, token split, and per-model stats
- **Tabbed panels** -- Info (identity, cost, tokens), System (CPU/memory charts), Agent Activity
- **Mouse support** -- click to select sessions, sort by column, switch tabs; hover highlights
- **Non-interactive modes** -- list, JSON, and single-session output for scripting

## Requirements

- Node.js >= 18
- No dependencies (single-file, pure Node.js)

## Usage

```
# Interactive TUI (default)
node index.js

# List sessions
node index.js -l

# JSON output
node index.js -j

# Show specific session
node index.js -s 1

# Set refresh interval (seconds)
node index.js -d 3

# Set billing plan
node index.js -p max
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `j`/`k` or arrows | Navigate sessions |
| `Enter` | Open detail view |
| `Tab` | Cycle bottom panel tabs |
| `` ` `` | Toggle Summary/Live view |
| `1`/`2`/`3` | Switch to Info/System/Agent panel |
| `F3` or `/` | Search/filter sessions |
| `F6` or `>` | Sort-by panel |
| `P`/`M`/`T` | Sort by status/memory/cost |
| `F5` or `r` | Force refresh |
| `q` or `F10` | Quit |

## Plans

The `-p` flag controls how costs are displayed:

- `retail` (default) -- standard API pricing
- `max` / `max5` / `max20` -- Claude Max subscription (Claude usage marked as "included")
- `plus` / `pro` -- Codex Pro subscription (Codex usage marked as "included")
- `included` -- all usage marked as included

## How It Works

agtop reads JSONL transcript files written by Claude Code and Codex to extract token counts, tool invocations, and model information. It fetches current model pricing from LiteLLM (cached for 24 hours) to compute cost estimates. For running sessions, it uses `ps` and `lsof` to map OS processes back to sessions and collect CPU/memory metrics.
