# agtop

Run with:
```
npx github:ldegio/agtop
```

Your window into what your AI coding agents are actually doing. agtop is a top-style terminal dashboard that tracks every Claude Code and Codex session on your machine — spend, token usage, context pressure, CPU load, tool invocations, and more — all in one place, live.

![agtop](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![License: GPL v2](https://img.shields.io/badge/License-GPL%20v2-blue.svg)

<img src="screenshots/main-list.png" width="700" alt="Session list with live CPU and cost metrics">

## Features

- **Session discovery** -- automatically finds Claude Code (`~/.claude/projects/`) and Codex (`~/.codex/sessions/`) sessions
- **Cost tracking** -- per-session spend with hourly and daily breakdowns; plan-aware billing (retail, Max, included)
- **Context pressure** -- CTX% shows how full each agent's context window is
- **Live toggle** -- filter to running sessions with real-time CPU%, cost rates, and incremental tool counts
- **Tool Activity panel** -- scrollable per-tool invocation history with timestamps; see exactly what each agent has been doing
- **OS process metrics** -- CPU% and PID count for running sessions (macOS/Linux)
- **Overview sparklines** -- aggregate spend, tokens, and CPU charts at a glance
- **Detail view** -- full cost breakdown, token split, per-model stats, and complete tool history
- **Config panel** -- browse CLAUDE.md/AGENTS.md, memories, skills, MCP servers, and permissions per session
- **Mouse support** -- click to select, sort by column, switch tabs; hover tooltips on column headers
- **Non-interactive modes** -- table and full JSON dump for scripting

## Requirements

- Node.js >= 18
- No dependencies (single-file, pure Node.js)

## Usage

```
# Run the TUI (no install needed)
npx github:ldegio/agtop

# Or install globally
npm install -g github:ldegio/agtop

# Run the installed version
agtop

# Set refresh interval (seconds)
agtop -d 3
```

## Options

| Flag | Description |
|------|-------------|
| `-l`, `--list` | List sessions in a table and exit |
| `-j`, `--json` | Dump full session data as JSON and exit |
| `-p`, `--plan <plan>` | Billing plan for cost display (default: `retail`) |
| `-d`, `--delay <secs>` | Refresh interval in seconds (default: `2`) |
| `-h`, `--help` | Show help |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `j`/`k` or arrows | Navigate sessions |
| `Enter` | Open detail view |
| `Tab` | Cycle bottom panel tabs |
| `Shift+Tab` or `` ` `` | Toggle Live filter |
| `1`/`2`/`3`/`4` | Switch to Info/System/Tool Activity/Config panel |
| `F3` or `/` | Search/filter sessions |
| `F6` or `>` | Sort-by panel |
| `F5` or `r` | Force refresh |
| `q` or `F10` | Quit |

## JSON Output

`agtop -j` dumps comprehensive session data including:

- Session identity (provider, ID, project, model)
- Cost breakdown (total, per-category, hourly/daily rates)
- Token counts (input, output, cached, detailed splits)
- Activity metrics (tool invocations by name, skills, web fetches/searches, MCP calls)

## Screenshots

**Info panel** — session identity, wall/API time, context pressure

<img src="screenshots/panel-info.png" width="600" alt="Info panel">

**Performance** — per-session CPU and memory sparkline charts over time

<img src="screenshots/panel-performance.png" width="600" alt="Performance panel">

**Processes** — live process tree with CPU%, memory, and command lines (C++ builds, caffeinate, etc.)

<img src="screenshots/panel-processes.png" width="600" alt="Processes panel">

**Tool Activity** — per-tool invocation counts and live feed with timestamps

<img src="screenshots/panel-tool-activity.png" width="600" alt="Tool Activity panel">

**Cost breakdown** — total spend by time window, per-model token and cost split

<img src="screenshots/panel-cost.png" width="600" alt="Cost panel">

**Config** — browse CLAUDE.md, memories, skills, MCP servers, and permissions

<img src="screenshots/panel-config.png" width="600" alt="Config panel">

## How It Works

agtop reads JSONL transcript files written by Claude Code and Codex to extract token counts, tool invocations, and model information. It fetches current model pricing from LiteLLM (cached for 24 hours) to compute cost estimates. For running sessions, it uses `ps` and `lsof` to map OS processes back to sessions and collect CPU/memory metrics.
