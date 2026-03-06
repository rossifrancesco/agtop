#!/usr/bin/env node
/**
 * Estimate the token-based cost of local Codex and Claude Code sessions.
 *
 * The script reads recent session metadata from:
 * - ~/.codex/sessions
 * - ~/.claude/projects
 *
 * It presents a single combined session picker and computes an estimated cost
 * using built-in pricing tables for the detected models.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  statSync,
  createReadStream,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join, basename, sep } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME = homedir();
const CODEX_SESSIONS_ROOT = join(HOME, ".codex", "sessions");
const CLAUDE_PROJECTS_ROOT = join(HOME, ".claude", "projects");
const UUID_RE = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const FULL_UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SESSION_DATA_CACHE = new Map();
const COST_CACHE_DIR = join(HOME, ".cache", "agtop");
const COST_CACHE_FILE = join(COST_CACHE_DIR, "cost-cache.json");
const PRICING_CACHE_FILE = join(COST_CACHE_DIR, "litellm-pricing.json");
const UI_PREFS_FILE = join(COST_CACHE_DIR, "ui-prefs.json");
const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PRICING_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Pricing tables
// ---------------------------------------------------------------------------

const CODEX_PRICING = {
  "gpt-5.3-codex": {
    input_per_million: 1.75,
    cached_input_per_million: 0.175,
    output_per_million: 14.0,
  },
  "codex-mini-latest": {
    input_per_million: 1.5,
    cached_input_per_million: 0.375,
    output_per_million: 6.0,
  },
};

const CLAUDE_PRICING = {
  "claude-opus-4-6": {
    input_per_million: 5.0,
    cache_write_5m_per_million: 6.25,
    cache_write_1h_per_million: 10.0,
    cache_read_per_million: 0.5,
    output_per_million: 25.0,
  },
  "claude-opus-4-5-20251101": {
    input_per_million: 5.0,
    cache_write_5m_per_million: 6.25,
    cache_write_1h_per_million: 10.0,
    cache_read_per_million: 0.5,
    output_per_million: 25.0,
  },
  "claude-sonnet-4-6": {
    input_per_million: 3.0,
    cache_write_5m_per_million: 3.75,
    cache_write_1h_per_million: 6.0,
    cache_read_per_million: 0.3,
    output_per_million: 15.0,
  },
  "claude-sonnet-4-5-20250929": {
    input_per_million: 3.0,
    cache_write_5m_per_million: 3.75,
    cache_write_1h_per_million: 6.0,
    cache_read_per_million: 0.3,
    output_per_million: 15.0,
  },
  "claude-haiku-4-5-20251001": {
    input_per_million: 1.0,
    cache_write_5m_per_million: 1.25,
    cache_write_1h_per_million: 2.0,
    cache_read_per_million: 0.1,
    output_per_million: 5.0,
  },
};

// ---------------------------------------------------------------------------
// Plan tables
// ---------------------------------------------------------------------------

const PLAN_ALIASES = {
  retail: "retail",
  default: "retail",
  max: "max",
  "claude-max": "max",
  included: "included",
  enterprise: "included",
  "not-billed": "included",
};

const PLAN_CHOICES = {
  codex: [
    ["retail", "API"],
    ["plus", "ChatGPT Plus"],
    ["pro", "ChatGPT Pro"],
    ["business", "ChatGPT Business (flex pricing)"],
    ["enterprise_edu", "ChatGPT Enterprise / Edu (flex pricing)"],
    ["included", "Not Billed"],
  ],
  claude: [
    ["retail", "API / Usage-based"],
    ["claude_pro", "Claude Pro"],
    ["max5", "Claude Max 5x"],
    ["max20", "Claude Max 20x"],
    ["team", "Claude Team"],
    ["enterprise_contract", "Claude Enterprise"],
    ["included", "Not Billed"],
  ],
};

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

class SessionCostError extends Error {}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseCliArgs() {
  const args = process.argv.slice(2);
  let session = null;
  let listSessions = false;
  let json = false;
  let plan = "retail";
  let delay = 5;
  let help = false;

  const takeValue = (i, flag) => {
    const value = args[i + 1];
    if (value === undefined || value.startsWith("-")) {
      process.stderr.write(`error: ${flag} requires a value\n`);
      process.exit(1);
    }
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "-l" || arg === "--list-sessions") {
      listSessions = true;
    } else if (arg === "-j" || arg === "--json") {
      json = true;
    } else if (arg === "-s" || arg === "--session") {
      const value = takeValue(i, arg);
      session = parseInt(value, 10);
      if (Number.isNaN(session)) {
        process.stderr.write("error: --session must be a number\n");
        process.exit(1);
      }
      i++;
    } else if (arg.startsWith("--session=")) {
      session = parseInt(arg.slice("--session=".length), 10);
      if (Number.isNaN(session)) {
        process.stderr.write("error: --session must be a number\n");
        process.exit(1);
      }
    } else if (arg === "-p" || arg === "--plan") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        plan = "select";
      } else {
        plan = next;
        i++;
      }
    } else if (arg.startsWith("--plan=")) {
      plan = arg.slice("--plan=".length) || "select";
    } else if (arg === "-d" || arg === "--delay") {
      const value = takeValue(i, arg);
      delay = parseFloat(value);
      if (Number.isNaN(delay) || delay < 1) {
        process.stderr.write("error: --delay must be a number >= 1 (seconds)\n");
        process.exit(1);
      }
      i++;
    } else if (arg.startsWith("--delay=")) {
      delay = parseFloat(arg.slice("--delay=".length));
      if (Number.isNaN(delay) || delay < 1) {
        process.stderr.write("error: --delay must be a number >= 1 (seconds)\n");
        process.exit(1);
      }
    } else {
      process.stderr.write(`error: unknown option '${arg}'\n`);
      process.exit(1);
    }
  }

  if (help) {
    process.stdout.write(
      `Usage: agtop [options]

Estimate the cost of local Codex and Claude Code sessions.

Options:
  -s, --session <n>    Select session by number
  -l, --list-sessions  List available sessions and exit
  -j, --json           Emit the session list as JSON and exit
  -d, --delay <secs>   Refresh interval in seconds (default: 5)
  -p, --plan [plan]    Billing plan: retail, max, included, enterprise
  -h, --help           Show this help
`
    );
    process.exit(0);
  }

  if (plan !== "select") {
    const normalized = PLAN_ALIASES[plan.toLowerCase()];
    if (normalized === undefined) {
      process.stderr.write(
        `error: unsupported plan '${plan}'; use one of: ${Object.keys(PLAN_ALIASES).sort().join(", ")}\n`
      );
      process.exit(1);
    }
    plan = normalized;
  }

  return {
    session,
    listSessions,
    json,
    plan,
    delay,
  };
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function forEachJsonl(filePath, callback) {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNum = 0;
  try {
    for await (const raw of rl) {
      lineNum++;
      const line = raw.trim();
      if (!line) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch (err) {
        throw new SessionCostError(
          `Invalid JSON in ${filePath} at line ${lineNum}: ${err.message}`
        );
      }
      callback(item);
    }
  } catch (err) {
    if (err instanceof SessionCostError) throw err;
    throw new SessionCostError(`Unable to read ${filePath}: ${err.message}`);
  }
}

function dirExists(p) {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDir(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/** Recursively find all .jsonl files under a directory. */
function rglob(dir, pattern = /\.jsonl$/) {
  const results = [];
  const walk = (d) => {
    for (const entry of listDir(d)) {
      const full = join(d, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (st.isFile() && pattern.test(entry)) results.push(full);
      } catch {
        /* skip inaccessible */
      }
    }
  };
  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function money(value) {
  return value.toFixed(6);
}

function usd(value) {
  return `$${value}`;
}

function compactUsd(value) {
  if (value === null || value === undefined) return "n/a";
  if (value === "included") return "incl";
  return `$${parseFloat(value).toFixed(2)}`;
}

function compactTokens(value) {
  if (value === null || value === undefined) return "n/a";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}G`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function compactBytes(value) {
  if (value === null || value === undefined || value === 0) return "";
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)}G`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}M`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)}K`;
  return `${value}B`;
}

function fitText(value, width) {
  const text = value || "unknown";
  if (text.length <= width) return text.padEnd(width);
  if (width <= 3) return text.slice(0, width);
  return text.slice(0, width - 3) + "...";
}

function clipLine(text, width) {
  if (width <= 0 || text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return text.slice(0, width - 3) + "...";
}

function displayWidth() {
  return Math.max(60, process.stdout.columns || 100);
}

function tokenCost(tokens, ratePerMillion) {
  return (tokens * ratePerMillion) / 1_000_000;
}

function numberWithCommas(n) {
  return n.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

function parseTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function relativeAge(value, now) {
  const parsed = parseTimestamp(value);
  if (!parsed) return "n/a";
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  if (seconds < 2592000) return `${Math.floor(seconds / 604800)}w`;
  if (seconds < 31536000) return `${Math.floor(seconds / 2592000)}mo`;
  return `${Math.floor(seconds / 31536000)}y`;
}

// ---------------------------------------------------------------------------
// Path abbreviation
// ---------------------------------------------------------------------------

function pathParts(value) {
  if (!value) return [];
  return value
    .split(sep === "\\" ? /[\\/]/ : "/")
    .filter((p) => p && p !== "/");
}

function abbreviatePaths(values) {
  // Strip HOME prefix before splitting into parts
  const homeParts = pathParts(HOME);
  const partsList = values.map((v) => {
    const parts = pathParts(v);
    // Remove leading HOME components if they match
    if (parts.length >= homeParts.length &&
        homeParts.every((hp, i) => parts[i] === hp)) {
      const rest = parts.slice(homeParts.length);
      return rest.length ? rest : ["~"];
    }
    return parts;
  });

  // Start with just the leaf name (width=1), expand only on collision
  const widths = partsList.map((p) => (p.length ? 1 : 0));

  while (true) {
    let changed = false;
    const groups = {};
    for (let i = 0; i < partsList.length; i++) {
      const parts = partsList[i];
      if (!parts.length) continue;
      const label = parts.slice(-widths[i]).join("/");
      if (!groups[label]) groups[label] = [];
      groups[label].push(i);
    }
    for (const indices of Object.values(groups)) {
      if (indices.length < 2) continue;
      for (const idx of indices) {
        if (widths[idx] < partsList[idx].length) {
          widths[idx]++;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  return partsList.map((parts, i) =>
    parts.length ? parts.slice(-widths[i]).join("/") : "unknown"
  );
}

// ---------------------------------------------------------------------------
// Codex sessions
// ---------------------------------------------------------------------------

function summarizeCodexSession(filePath) {
  // Codex session files are small — use readFirstLines for metadata.
  let sessionId = null;
  let startedAt = null;
  let lastActive = null;
  let model = null;
  let cwd = null;

  const m = UUID_RE.exec(basename(filePath, ".jsonl"));
  if (m) sessionId = m[1];

  for (const item of readFirstLines(filePath, 50)) {
    const ts = item.timestamp;
    if (ts) lastActive = ts;
    const type = item.type;
    const payload = item.payload || {};
    if (type === "session_meta") {
      sessionId = payload.id || sessionId;
      startedAt = payload.timestamp || item.timestamp || startedAt;
      cwd = payload.cwd || cwd;
    } else if (type === "turn_context") {
      model = payload.model || model;
    }
    if (sessionId && startedAt && model && cwd) break;
  }

  // Use file mtime for lastActive in case the file is longer than 50 lines.
  const mt = fileMtime(filePath);
  if (mt) {
    const mtIso = mt.toISOString();
    if (!lastActive || mtIso > lastActive) lastActive = mtIso;
  }

  return {
    provider: "codex",
    session_id: sessionId,
    started_at: startedAt,
    last_active: lastActive || startedAt,
    model,
    label_source: cwd,
    data_file: filePath,
  };
}

function listCodexSessions() {
  if (!dirExists(CODEX_SESSIONS_ROOT)) return [];
  const sessions = [];
  for (const filePath of rglob(CODEX_SESSIONS_ROOT).sort().reverse()) {
    try {
      sessions.push(summarizeCodexSession(filePath));
    } catch (err) {
      if (err instanceof SessionCostError) continue;
      throw err;
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Claude sessions
// ---------------------------------------------------------------------------

function claudeTranscriptFiles(transcriptPath) {
  const files = [transcriptPath];
  const stem = transcriptPath.replace(/\.jsonl$/, "");
  const subagentsDir = join(stem, "subagents");
  if (dirExists(subagentsDir)) {
    for (const entry of listDir(subagentsDir).sort()) {
      if (entry.endsWith(".jsonl")) {
        files.push(join(subagentsDir, entry));
      }
    }
  }
  return files;
}

function formatTimestampForSession(d) {
  return d
    ? d.toISOString().replace(/\.\d{3}Z$/, ".000000Z").replace(/\.000000Z$/, "Z")
    : null;
}

function readFirstLines(filePath, maxLines) {
  let text;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const items = [];
  let start = 0;
  let count = 0;
  while (count < maxLines && start < text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    const line = text.substring(start, end).trim();
    start = end + 1;
    if (!line) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      /* skip malformed */
    }
    count++;
  }
  return items;
}

function fileMtime(filePath) {
  try {
    return statSync(filePath).mtime;
  } catch {
    return null;
  }
}

function collectClaudeSessionSummary(transcriptPath) {
  let earliest = null;
  let model = null;
  let cwd = null;

  // Read only the first 30 lines for startedAt, cwd, and model.
  for (const item of readFirstLines(transcriptPath, 30)) {
    const parsed = parseTimestamp(item.timestamp);
    if (parsed && (!earliest || parsed < earliest)) earliest = parsed;
    if (!cwd && item.cwd) cwd = item.cwd;
    if (!model && item.type === "assistant") {
      const candidate = (item.message || {}).model;
      if (candidate && candidate !== "<synthetic>") model = candidate;
    }
  }

  // Use file mtime for lastActive (append-only files).
  let latest = fileMtime(transcriptPath);
  for (const filePath of claudeTranscriptFiles(transcriptPath).slice(1)) {
    const mt = fileMtime(filePath);
    if (mt && (!latest || mt > latest)) latest = mt;
  }

  return {
    startedAt: formatTimestampForSession(earliest),
    lastActive: latest ? formatTimestampForSession(latest) : null,
    model,
    cwd,
  };
}

function summarizeClaudeSession(transcriptPath) {
  const sessionId = basename(transcriptPath, ".jsonl");
  const summary = collectClaudeSessionSummary(transcriptPath);
  return {
    provider: "claude",
    session_id: sessionId,
    started_at: summary.startedAt,
    last_active: summary.lastActive || summary.startedAt,
    model: summary.model,
    label_source: summary.cwd,
    data_file: transcriptPath,
  };
}

function listClaudeSessions() {
  if (!dirExists(CLAUDE_PROJECTS_ROOT)) return [];
  const sessions = [];
  for (const projectName of listDir(CLAUDE_PROJECTS_ROOT)) {
    const projectDir = join(CLAUDE_PROJECTS_ROOT, projectName);
    if (!dirExists(projectDir)) continue;
    for (const entry of listDir(projectDir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const stem = entry.replace(/\.jsonl$/, "");
      if (!FULL_UUID_RE.test(stem)) continue;
      try {
        const s = summarizeClaudeSession(join(projectDir, entry));
        if (!s.model) continue; // skip empty/abandoned sessions
        sessions.push(s);
      } catch (err) {
        if (err instanceof SessionCostError) continue;
        throw err;
      }
    }
  }
  sessions.sort((a, b) => (b.started_at || "").localeCompare(a.started_at || ""));
  return sessions;
}

function listAllSessions() {
  return [listCodexSessions(), listClaudeSessions()];
}

// ---------------------------------------------------------------------------
// Plan helpers
// ---------------------------------------------------------------------------

function planMode(plan, provider) {
  if (provider === "codex") {
    if (["plus", "pro", "included"].includes(plan)) return "included";
    return "retail";
  }
  if (provider === "claude") {
    if (["claude_pro", "max", "max5", "max20", "included"].includes(plan))
      return "included";
    return "retail";
  }
  return "retail";
}

function planIncludesProvider(plan, provider) {
  return planMode(plan, provider) === "included";
}

function resolveProviderPlans(plan) {
  if (plan === "retail") return ["retail", "retail"];
  if (plan === "max") return ["retail", "max"];
  if (plan === "included") return ["included", "included"];
  throw new SessionCostError(`Unsupported plan mode: ${plan}`);
}

function applyCurrentDirectoryOverride(sessions) {
  if (!sessions.length) return;
  const cwd = process.cwd();
  for (const s of sessions) {
    if (s.provider === "codex") {
      s.label_source = cwd;
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Metrics helpers
// ---------------------------------------------------------------------------

function emptyMetrics() {
  return {
    tool_count: 0, tools: {},
    mcp_tool_count: 0, mcp_tools: [],
    skill_count: 0, skills: {},
    web_fetch_count: 0, web_fetches: [],
    web_search_count: 0, web_searches: [],
  };
}

function safeMetrics(data) {
  return (data && data.metrics) || emptyMetrics();
}

// ---------------------------------------------------------------------------
// Cost extraction
// ---------------------------------------------------------------------------

function resolveCodexPricing(model) {
  if (model && CODEX_PRICING[model]) return CODEX_PRICING[model];
  // Try LiteLLM fallback
  const entry = findLitellmEntry(model, _litellmPricing);
  if (entry) return litellmToCodexPricing(entry);
  const available = Object.keys(CODEX_PRICING).sort().join(", ") || "(none)";
  throw new SessionCostError(
    `No pricing known for Codex model '${model || "unknown"}'. Built-in profiles: ${available}`
  );
}

async function extractCodexSessionData(sessionFile) {
  let model = null;
  const totals = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  let sawLastUsage = false;
  const metrics = emptyMetrics();
  const seenCallIds = new Set();
  const seenQueries = new Set();

  await forEachJsonl(sessionFile, (item) => {
    if (item.type === "turn_context") {
      model = (item.payload || {}).model || model;
    } else if (item.type === "event_msg") {
      const payload = item.payload || {};
      if (payload.type === "token_count") {
        const lastUsage = (payload.info || {}).last_token_usage || {};
        if (Object.keys(lastUsage).length) {
          sawLastUsage = true;
          for (const key of Object.keys(totals)) {
            totals[key] += parseInt(lastUsage[key] || 0, 10) || 0;
          }
        }
      }
    }

    // --- Tool/function call extraction ---
    const payload = item.payload || {};
    const itemType = item.type;
    // Handle both top-level and response_item-wrapped function_call
    const effectiveType = itemType === "response_item" ? (payload.type || "") : itemType;
    const effectivePayload = itemType === "response_item" ? payload : payload;

    if (effectiveType === "function_call" || effectiveType === "custom_tool_call") {
      const callId = effectivePayload.call_id || null;
      if (callId && seenCallIds.has(callId)) return;
      if (callId) seenCallIds.add(callId);
      const name = effectivePayload.name || "unknown";
      if (effectiveType === "custom_tool_call") {
        metrics.mcp_tool_count++;
        if (!metrics.mcp_tools.includes(name)) metrics.mcp_tools.push(name);
      }
      metrics.tools[name] = (metrics.tools[name] || 0) + 1;
      metrics.tool_count++;
    } else if (effectiveType === "web_search_call") {
      const action = effectivePayload.action || {};
      const query = action.query || "";
      if (query && seenQueries.size < 50 && !seenQueries.has(query)) {
        seenQueries.add(query);
        metrics.web_searches.push(query);
        metrics.web_search_count++;
      }
    }
  });

  if (!sawLastUsage)
    throw new SessionCostError(
      `No token_count usage events found in ${sessionFile}`
    );

  const pricing = resolveCodexPricing(model);
  const inputTokens = totals.input_tokens;
  const cachedInputTokens = totals.cached_input_tokens;
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const outputTokens = totals.output_tokens;
  const reasoningOutputTokens = totals.reasoning_output_tokens;
  const totalTokens = totals.total_tokens;

  const inputCost = tokenCost(uncachedInputTokens, pricing.input_per_million);
  const cachedInputCost = tokenCost(
    cachedInputTokens,
    pricing.cached_input_per_million
  );
  const outputCost = tokenCost(outputTokens, pricing.output_per_million);
  const totalCost = inputCost + cachedInputCost + outputCost;

  return {
    provider: "codex",
    session_id: null,
    model,
    tokens: {
      input: uncachedInputTokens,
      input_total: inputTokens,
      cached_input: cachedInputTokens,
      output: outputTokens,
      reasoning_output: reasoningOutputTokens,
      total: totalTokens,
    },
    costs: {
      input: money(inputCost),
      cached_input: money(cachedInputCost),
      output: money(outputCost),
      total: money(totalCost),
    },
    rates: {
      input: String(pricing.input_per_million),
      cached_input: String(pricing.cached_input_per_million),
      output: String(pricing.output_per_million),
    },
    metrics,
  };
}

function resolveClaudePricing(model) {
  if (CLAUDE_PRICING[model]) return CLAUDE_PRICING[model];
  // Try LiteLLM fallback
  const entry = findLitellmEntry(model, _litellmPricing);
  if (entry) return litellmToClaudePricing(entry);
  const available = Object.keys(CLAUDE_PRICING).sort().join(", ") || "(none)";
  throw new SessionCostError(
    `No pricing known for Claude model '${model}'. Built-in profiles: ${available}`
  );
}

function requestKey(item, message) {
  if (item.requestId) return String(item.requestId);
  if (message.id) return String(message.id);
  return null;
}

async function extractClaudeSessionData(transcriptPath) {
  const tokenTotals = {
    input: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
    output: 0,
  };
  const costTotals = {
    input: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
    output: 0,
  };
  const models = {};
  const metrics = emptyMetrics();
  const seenToolIds = new Set();
  const seenUrls = new Set();
  const seenQueries = new Set();
  const CMD_RE = /<command-name>\/?([^<]+)<\/command-name>/g;

  for (const filePath of claudeTranscriptFiles(transcriptPath)) {
    const seen = new Set();
    await forEachJsonl(filePath, (item) => {
      // --- User branch: scan for skill/slash commands ---
      if (item.type === "user") {
        const content = (item.message || {}).content;
        const texts = [];
        if (typeof content === "string") texts.push(content);
        else if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "string") texts.push(block);
            else if (block && typeof block.text === "string") texts.push(block.text);
          }
        }
        for (const text of texts) {
          for (const m of text.matchAll(CMD_RE)) {
            const name = m[1].trim();
            if (name) {
              metrics.skills[name] = (metrics.skills[name] || 0) + 1;
              metrics.skill_count++;
            }
          }
        }
        return;
      }

      if (item.type !== "assistant") return;
      const message = item.message || {};

      // --- Tool scanning (independent of token dedup) ---
      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== "tool_use" || !block.name) continue;
          if (block.id && seenToolIds.has(block.id)) continue;
          if (block.id) seenToolIds.add(block.id);

          const name = block.name;
          if (name.startsWith("mcp__")) {
            metrics.mcp_tool_count++;
            if (!metrics.mcp_tools.includes(name)) metrics.mcp_tools.push(name);
          }
          metrics.tools[name] = (metrics.tools[name] || 0) + 1;
          metrics.tool_count++;

          // Web fetch/search extraction
          const input = block.input || {};
          if (name === "WebFetch" && input.url && seenUrls.size < 50) {
            if (!seenUrls.has(input.url)) {
              seenUrls.add(input.url);
              metrics.web_fetches.push(input.url);
              metrics.web_fetch_count++;
            }
          } else if (name === "WebSearch" && input.query && seenQueries.size < 50) {
            if (!seenQueries.has(input.query)) {
              seenQueries.add(input.query);
              metrics.web_searches.push(input.query);
              metrics.web_search_count++;
            }
          }
        }
      }

      // --- Token / cost accounting (existing logic) ---
      const usage = message.usage;
      if (!usage) return;

      const key = requestKey(item, message);
      if (key !== null && seen.has(key)) return;

      const inputTokens = parseInt(usage.input_tokens || 0, 10) || 0;
      const cacheReadTokens =
        parseInt(usage.cache_read_input_tokens || 0, 10) || 0;
      const outputTokens = parseInt(usage.output_tokens || 0, 10) || 0;
      const cacheCreation = usage.cache_creation || {};
      let cacheWrite5mTokens =
        parseInt(cacheCreation.ephemeral_5m_input_tokens || 0, 10) || 0;
      let cacheWrite1hTokens =
        parseInt(cacheCreation.ephemeral_1h_input_tokens || 0, 10) || 0;
      const totalCacheWriteTokens =
        parseInt(usage.cache_creation_input_tokens || 0, 10) || 0;
      const remainder =
        totalCacheWriteTokens - (cacheWrite5mTokens + cacheWrite1hTokens);
      if (remainder > 0) cacheWrite5mTokens += remainder;

      if (
        inputTokens === 0 &&
        cacheReadTokens === 0 &&
        outputTokens === 0 &&
        cacheWrite5mTokens === 0 &&
        cacheWrite1hTokens === 0
      )
        return;

      if (key !== null) seen.add(key);

      const model = message.model;
      if (!model || model === "<synthetic>")
        throw new SessionCostError(
          `Encountered billable Claude usage with unknown model in ${filePath}`
        );

      const pricing = resolveClaudePricing(model);
      models[model] = (models[model] || 0) + 1;

      tokenTotals.input += inputTokens;
      tokenTotals.cache_write_5m += cacheWrite5mTokens;
      tokenTotals.cache_write_1h += cacheWrite1hTokens;
      tokenTotals.cache_read += cacheReadTokens;
      tokenTotals.output += outputTokens;

      costTotals.input += tokenCost(inputTokens, pricing.input_per_million);
      costTotals.cache_write_5m += tokenCost(
        cacheWrite5mTokens,
        pricing.cache_write_5m_per_million
      );
      costTotals.cache_write_1h += tokenCost(
        cacheWrite1hTokens,
        pricing.cache_write_1h_per_million
      );
      costTotals.cache_read += tokenCost(
        cacheReadTokens,
        pricing.cache_read_per_million
      );
      costTotals.output += tokenCost(
        outputTokens,
        pricing.output_per_million
      );
    });
  }

  if (!Object.keys(models).length)
    throw new SessionCostError(
      `No assistant usage records found in ${transcriptPath}`
    );

  const totalCost = Object.values(costTotals).reduce((a, b) => a + b, 0);
  const totalTokens = Object.values(tokenTotals).reduce((a, b) => a + b, 0);

  return {
    provider: "claude",
    models: Object.keys(models).sort(),
    tokens: { ...tokenTotals, total: totalTokens },
    costs: {
      input: money(costTotals.input),
      cache_write_5m: money(costTotals.cache_write_5m),
      cache_write_1h: money(costTotals.cache_write_1h),
      cache_read: money(costTotals.cache_read),
      output: money(costTotals.output),
      total: money(totalCost),
    },
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Disk-based cost cache
// ---------------------------------------------------------------------------

let _diskCache = null;
let _diskCacheDirty = false;

function loadDiskCache() {
  if (_diskCache) return _diskCache;
  try {
    _diskCache = JSON.parse(readFileSync(COST_CACHE_FILE, "utf-8"));
  } catch {
    _diskCache = {};
  }
  return _diskCache;
}

function saveDiskCache() {
  if (!_diskCacheDirty) return;
  try {
    mkdirSync(COST_CACHE_DIR, { recursive: true });
    writeFileSync(COST_CACHE_FILE, JSON.stringify(_diskCache));
  } catch {
    /* best effort */
  }
}

function loadUiPrefs() {
  try {
    return JSON.parse(readFileSync(UI_PREFS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveUiPrefs(prefs) {
  try {
    mkdirSync(COST_CACHE_DIR, { recursive: true });
    writeFileSync(UI_PREFS_FILE, JSON.stringify(prefs));
  } catch { /* best effort */ }
}

function diskCacheKey(filePath) {
  try {
    const st = statSync(filePath);
    return `${filePath}|${st.size}|${st.mtimeMs}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LiteLLM dynamic pricing
// ---------------------------------------------------------------------------

let _litellmPricing = null;

async function fetchLitellmPricing() {
  // Try disk cache first
  try {
    const raw = readFileSync(PRICING_CACHE_FILE, "utf-8");
    const cached = JSON.parse(raw);
    const age = Date.now() - (cached._fetchedAt || 0);
    if (age < PRICING_CACHE_MAX_AGE_MS && cached.data) {
      _litellmPricing = cached.data;
      return _litellmPricing;
    }
    // Stale — try network, fall back to stale data below
  } catch {
    /* no cache */
  }

  // Fetch from network
  try {
    const resp = await fetch(LITELLM_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    // Save to disk cache
    try {
      mkdirSync(COST_CACHE_DIR, { recursive: true });
      writeFileSync(
        PRICING_CACHE_FILE,
        JSON.stringify({ _fetchedAt: Date.now(), data })
      );
    } catch { /* best effort */ }
    _litellmPricing = data;
    return _litellmPricing;
  } catch {
    // Network failed — try stale cache
    try {
      const raw = readFileSync(PRICING_CACHE_FILE, "utf-8");
      const cached = JSON.parse(raw);
      if (cached.data) {
        _litellmPricing = cached.data;
        return _litellmPricing;
      }
    } catch { /* no stale cache either */ }
    return null;
  }
}

function findLitellmEntry(modelName, data) {
  if (!data || !modelName) return null;
  // Exact match
  if (data[modelName]) return data[modelName];
  // With anthropic. prefix
  if (data["anthropic." + modelName]) return data["anthropic." + modelName];
  // Partial match: find first key containing the model name
  for (const key of Object.keys(data)) {
    if (key.includes(modelName)) return data[key];
  }
  return null;
}

function litellmToClaudePricing(entry) {
  const inputPerMillion = (entry.input_cost_per_token || 0) * 1_000_000;
  return {
    input_per_million: inputPerMillion,
    cache_write_5m_per_million: inputPerMillion * 1.25,
    cache_write_1h_per_million: inputPerMillion * 2.0,
    cache_read_per_million:
      (entry.cache_read_input_token_cost || 0) * 1_000_000,
    output_per_million: (entry.output_cost_per_token || 0) * 1_000_000,
  };
}

function litellmToCodexPricing(entry) {
  return {
    input_per_million: (entry.input_cost_per_token || 0) * 1_000_000,
    cached_input_per_million:
      (entry.cache_read_input_token_cost || 0) * 1_000_000,
    output_per_million: (entry.output_cost_per_token || 0) * 1_000_000,
  };
}

// ---------------------------------------------------------------------------
// Annotation
// ---------------------------------------------------------------------------

// Track mtime for each in-memory cache entry so we can detect changes.
const SESSION_DATA_MTIME = new Map();

function fileMtimeMs(filePath) {
  try { return statSync(filePath).mtimeMs; } catch { return 0; }
}

async function safeExtractSessionData(session) {
  if (!session.data_file) return null;
  const memKey = `${session.provider}:${session.data_file}`;

  // For Claude sessions, check max mtime across ALL transcript files
  // (main + subagent files) so cache invalidates when subagents are active.
  const effectiveMtime = session.provider === "claude"
    ? claudeTranscriptFiles(session.data_file).reduce(
        (mx, f) => Math.max(mx, fileMtimeMs(f)), 0)
    : fileMtimeMs(session.data_file);

  // Check in-memory cache, but verify mtime hasn't changed.
  if (SESSION_DATA_CACHE.has(memKey)) {
    const cachedMtime = SESSION_DATA_MTIME.get(memKey) || 0;
    if (effectiveMtime === cachedMtime) {
      return SESSION_DATA_CACHE.get(memKey);
    }
    // File changed — invalidate
    SESSION_DATA_CACHE.delete(memKey);
    SESSION_DATA_MTIME.delete(memKey);
  }

  // Check disk cache (diskCacheKey includes mtime, so stale entries auto-miss).
  // Also force re-extraction if cached entry lacks metrics (old cache format).
  const cache = loadDiskCache();
  const dKey = diskCacheKey(session.data_file);
  if (dKey && cache[dKey] && cache[dKey].metrics) {
    SESSION_DATA_CACHE.set(memKey, cache[dKey]);
    SESSION_DATA_MTIME.set(memKey, effectiveMtime);
    return cache[dKey];
  }

  try {
    let data = null;
    if (session.provider === "codex") {
      data = await extractCodexSessionData(session.data_file);
    } else if (session.provider === "claude") {
      data = await extractClaudeSessionData(session.data_file);
    }
    SESSION_DATA_CACHE.set(memKey, data);
    SESSION_DATA_MTIME.set(memKey, effectiveMtime);
    if (dKey && data) {
      cache[dKey] = data;
      _diskCacheDirty = true;
    }
    return data;
  } catch (err) {
    if (err instanceof SessionCostError) return null;
    throw err;
  }
}

async function annotateListCosts(sessions, plan) {
  await Promise.all(
    sessions.map(async (session) => {
      const data = await safeExtractSessionData(session);
      if (data) {
        const t = data.tokens || {};
        session.list_input_tokens =
          (t.input || 0) +
          (t.cached_input || 0) +
          (t.cache_read || 0) +
          (t.cache_write_5m || 0) +
          (t.cache_write_1h || 0);
        session.list_output_tokens = t.output || 0;
        const m = safeMetrics(data);
        session.list_tool_count = m.tool_count;
      }
      if (planIncludesProvider(plan, session.provider || "")) {
        session.list_total_cost = "included";
      } else if (data) {
        session.list_total_cost = data.costs.total;
      }
    })
  );
}

// ---------------------------------------------------------------------------
// Last active tool extraction (for live sessions — reads file tail)
// ---------------------------------------------------------------------------

/**
 * Read the last ~16KB of a file and return the lines (most recent last).
 */
function readFileTail(filePath, bytes) {
  try {
    const st = statSync(filePath);
    const size = st.size;
    const readBytes = Math.min(bytes || 16384, size);
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(readBytes);
    readSync(fd, buf, 0, readBytes, Math.max(0, size - readBytes));
    closeSync(fd);
    return buf.toString("utf-8").split("\n");
  } catch {
    return [];
  }
}

/**
 * Extract the last tool_use name from a Claude or Codex transcript.
 * Only called for sessions with a running process.
 */
function extractLastToolName(session) {
  if (!session || !session.data_file) return "";
  try {
    // For Claude, check all transcript files (main + subagent), use the one with latest mtime
    let targetFile = session.data_file;
    if (session.provider === "claude") {
      const files = claudeTranscriptFiles(session.data_file);
      let maxMt = 0;
      for (const f of files) {
        const mt = fileMtimeMs(f);
        if (mt > maxMt) { maxMt = mt; targetFile = f; }
      }
    }

    const lines = readFileTail(targetFile, 32768);
    let lastTool = "";

    // Scan from end to find the most recent tool_use
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const item = JSON.parse(line);
        if (session.provider === "claude") {
          // Claude: assistant message with content[] containing tool_use blocks
          if (item.type === "assistant" && item.message && item.message.content) {
            const content = item.message.content;
            for (let j = content.length - 1; j >= 0; j--) {
              if (content[j].type === "tool_use") {
                return content[j].name || "";
              }
            }
          }
        } else {
          // Codex: function_call or custom_tool_call at top level
          if (item.type === "function_call" || item.type === "custom_tool_call") {
            return (item.payload && item.payload.name) || "";
          }
          if (item.type === "response_item" && item.payload) {
            if (item.payload.type === "function_call") {
              return item.payload.name || "";
            }
          }
        }
      } catch {
        continue;
      }
    }
    return lastTool;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Per-session rate tracking (tokens/min, cost/min)
// ---------------------------------------------------------------------------

const _rateHistory = new Map(); // session key → [{ts, tokens, cost, tools}, ...]
const RATE_WINDOW_MS = 60_000; // 60-second window

function updateSessionRates(sessions) {
  const now = Date.now();
  for (const s of sessions) {
    const key = `${s.provider}:${s.session_id}`;
    const tokens = (s.list_input_tokens || 0) + (s.list_output_tokens || 0);
    const cost = s.list_total_cost === "included" ? 0 : parseFloat(s.list_total_cost || 0) || 0;
    const tools = s.list_tool_count || 0;

    if (!_rateHistory.has(key)) _rateHistory.set(key, []);
    const hist = _rateHistory.get(key);
    hist.push({ ts: now, tokens, cost, tools });

    // Trim entries older than window
    while (hist.length > 1 && hist[0].ts < now - RATE_WINDOW_MS) hist.shift();

    // Compute rates
    if (hist.length >= 2) {
      const oldest = hist[0];
      const elapsed = (now - oldest.ts) / 60_000; // minutes
      if (elapsed > 0.01) {
        s.list_tokens_per_min = (tokens - oldest.tokens) / elapsed;
        s.list_cost_per_min = (cost - oldest.cost) / elapsed;
        s.list_tools_per_min = (tools - oldest.tools) / elapsed;
      } else {
        s.list_tokens_per_min = 0;
        s.list_cost_per_min = 0;
        s.list_tools_per_min = 0;
      }
    } else {
      s.list_tokens_per_min = 0;
      s.list_cost_per_min = 0;
      s.list_tools_per_min = 0;
    }
  }
}

// Session duration helper
function sessionDuration(s) {
  const start = parseTimestamp(s.started_at);
  const end = parseTimestamp(s.last_active) || start;
  if (!start || !end) return "";
  const secs = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d`;
  return `${Math.floor(secs / 604800)}w`;
}

// ---------------------------------------------------------------------------
// ANSI / Terminal constants
// ---------------------------------------------------------------------------

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const MOUSE_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h"; // SGR mouse + any-event tracking
const MOUSE_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

// btop-style color palette — dark bg, vibrant accents, rounded box borders
const C = {
  // Panel borders and titles
  border: "\x1b[38;5;60m",     // muted blue-gray for box borders
  borderHi: "\x1b[38;5;75m",   // brighter blue for active panel border
  panelTitle: "\x1b[1;38;5;75m", // bold bright blue for panel titles
  // Labels and values
  hdrLabel: "\x1b[1;38;5;75m", // bold blue for labels
  hdrValue: "\x1b[1;37m",      // bold white for values
  hdrCyan: "\x1b[1;36m",       // bold cyan for Claude counts
  hdrGreen: "\x1b[1;32m",      // bold green for Codex counts
  hdrYellow: "\x1b[1;33m",     // bold yellow for spend
  hdrDim: "\x1b[38;5;245m",    // gray for secondary text
  // Column headers: dark blue bg, bold white text (btop style)
  colHdrBg: "\x1b[1;37;48;5;236m", // bold white on dark gray
  // Selected row: subtle highlight
  selBg: "\x1b[48;5;236m",     // dark gray bg
  selFg: "\x1b[1;37m",         // bold white text
  // Footer: btop-style
  footerKey: "\x1b[1;30;48;5;75m", // bold black on blue
  footerLabel: "\x1b[38;5;245;40m", // gray on black
  footerBg: "\x1b[40m",        // black bg
  // Provider colors
  provClaude: "\x1b[38;5;141m",  // purple-ish
  provCodex: "\x1b[38;5;114m",   // green-ish
  // Cost colors
  costGreen: "\x1b[38;5;114m",
  costYellow: "\x1b[38;5;221m",
  costRed: "\x1b[1;38;5;203m",
  // Chart colors (for strip charts)
  chartBar: "\x1b[38;5;75m",     // blue bars
  chartBarHi: "\x1b[38;5;203m",  // red for high values
  chartBarMed: "\x1b[38;5;221m", // yellow for medium
  chartBarLow: "\x1b[38;5;114m", // green for low
  // Misc
  dimText: "\x1b[38;5;245m",   // gray
  normalFg: "\x1b[37m",        // white
  searchFg: "\x1b[1;36m",      // bold cyan
  accent: "\x1b[38;5;75m",     // accent blue
};

// ---------------------------------------------------------------------------
// Box-drawing helpers (btop-style rounded corners)
// ---------------------------------------------------------------------------

const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

/** Draw a box top edge: ╭─ Title ──────────╮ */
function boxTop(width, title, highlight) {
  const bc = highlight ? C.borderHi : C.border;
  const tc = C.panelTitle;
  if (!title) {
    return bc + BOX.tl + BOX.h.repeat(width - 2) + BOX.tr + RESET;
  }
  const label = ` ${title} `;
  const after = Math.max(0, width - 3 - label.length);
  return bc + BOX.tl + BOX.h + RESET + tc + label + RESET + bc + BOX.h.repeat(after) + BOX.tr + RESET;
}

/** Draw a box bottom edge: ╰──────────────╯ */
function boxBottom(width, highlight) {
  const bc = highlight ? C.borderHi : C.border;
  return bc + BOX.bl + BOX.h.repeat(width - 2) + BOX.br + RESET;
}

/** Wrap content in box side borders: │ content │ */
function boxLine(content, width, highlight) {
  const bc = highlight ? C.borderHi : C.border;
  // visible: │ + space + inner + space + │ = width
  const inner = width - 4;
  const clipped = ansiSlice(content, 0, inner);
  return bc + BOX.v + RESET + " " + clipped + " " + bc + BOX.v + RESET;
}

/** Render an empty box-bordered line */
function boxEmpty(width, highlight) {
  return boxLine("", width, highlight);
}

// ---------------------------------------------------------------------------
// Strip chart (sparkline-style bar chart for time series)
// ---------------------------------------------------------------------------

const SPARK_STYLES = {
  blocks:  [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
  braille: [" ", "⡀", "⡄", "⡆", "⡇", "⡧", "⡷", "⡿", "⣿"],
  shades:  [" ", "░", "░", "▒", "▒", "▓", "▓", "█", "█"],
  dots:    [" ", "·", "·", "•", "•", "●", "●", "●", "●"],
};

// History buffers for CPU/memory (keyed by session)
const _cpuHistory = new Map();   // sessionKey → number[]
const _memHistory = new Map();   // sessionKey → number[]
const HISTORY_MAX = 60;

function pushHistory(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  const arr = map.get(key);
  arr.push(value);
  if (arr.length > HISTORY_MAX) arr.shift();
}

// btop-style smooth gradient: green(114) → teal(79) → yellow(221) → red(203)
function sparkColor(ratio) {
  if (ratio <= 0.01) return "\x1b[38;5;238m"; // near-zero: dark gray
  if (ratio <= 0.30) return "\x1b[38;5;71m";  // low: muted green
  if (ratio <= 0.50) return "\x1b[38;5;114m"; // medium-low: green
  if (ratio <= 0.70) return "\x1b[38;5;186m"; // medium: yellow-green
  if (ratio <= 0.85) return "\x1b[38;5;221m"; // medium-high: yellow
  return "\x1b[38;5;203m";                     // high: red
}

// Accent-only gradient (blue/cyan tones, no red) for non-CPU metrics
function sparkColorAccent(ratio) {
  if (ratio <= 0.01) return "\x1b[38;5;238m"; // near-zero: dark gray
  if (ratio <= 0.25) return "\x1b[38;5;60m";  // low: muted blue
  if (ratio <= 0.50) return "\x1b[38;5;68m";  // medium-low: steel blue
  if (ratio <= 0.75) return "\x1b[38;5;75m";  // medium: bright blue
  return "\x1b[38;5;117m";                     // high: cyan
}

/**
 * Render a sparkline chart.
 *  maxVal > 0  → fixed scale (e.g. CPU 0-100)
 *  maxVal = 0  → auto-range: scale to [min..max] of visible values
 *                so even small variations produce visible bars
 */
function renderSparkline(values, width, maxVal, colorMode, style) {
  const colorFn = colorMode === "cpu" ? sparkColor : sparkColorAccent;
  const chars = SPARK_STYLES[style || "blocks"];

  if (!values.length) {
    return " ".repeat(width);
  }
  const start = Math.max(0, values.length - width);
  const visible = values.slice(start);

  let lo, hi, isFlat = false;
  if (maxVal > 0) {
    lo = 0;
    hi = maxVal;
  } else {
    lo = Math.min(...visible);
    hi = Math.max(...visible);
    const range = hi - lo;
    if (range < hi * 0.01) {
      isFlat = true;
      lo = 0;
      hi = hi > 0 ? hi * 2 : 1;
    } else {
      hi += range * 0.1;
    }
  }

  let out = "";

  // Leading empty area — just spaces
  if (visible.length < width) {
    out += " ".repeat(width - visible.length);
  }

  const span = hi - lo || 1;
  for (const v of visible) {
    if (v <= 0) {
      out += " ";
      continue;
    }
    if (isFlat) {
      out += colorFn(0.15) + chars[1] + RESET;
      continue;
    }
    const ratio = Math.max(0, Math.min(1, (v - lo) / span));
    const idx = Math.max(1, Math.min(8, Math.round(ratio * 7) + 1));
    out += colorFn(ratio) + chars[idx] + RESET;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const LIST_TABS = ["Summary", "Live"];

// Shared column defs
const COL_STATUS = {
  key: "status", label: " ", width: 1, align: "left",
  render: (s) => s.process ? "●" : "○",
  compare: (a, b) => (a.process ? 1 : 0) - (b.process ? 1 : 0),
};
const COL_LAST = {
  key: "active", label: "LAST", width: 5, align: "right",
  render: (s, now) => relativeAge(s.last_active, now),
  compare: (a, b) => (b.last_active || "").localeCompare(a.last_active || ""),
};
const COL_DURATION = {
  key: "duration", label: "DUR", width: 6, align: "right",
  render: (s) => sessionDuration(s),
  compare: (a, b) => {
    const da = (parseTimestamp(a.last_active) || parseTimestamp(a.started_at) || new Date()).getTime() - (parseTimestamp(a.started_at) || new Date()).getTime();
    const db = (parseTimestamp(b.last_active) || parseTimestamp(b.started_at) || new Date()).getTime() - (parseTimestamp(b.started_at) || new Date()).getTime();
    return da - db;
  },
};
const COL_TOKENS = {
  key: "tokens", label: "TOK", width: 8, align: "right",
  render: (s) => compactTokens((s.list_input_tokens || 0) + (s.list_output_tokens || 0)),
  compare: (a, b) => ((a.list_input_tokens || 0) + (a.list_output_tokens || 0)) - ((b.list_input_tokens || 0) + (b.list_output_tokens || 0)),
};
const COL_COST = {
  key: "cost", label: "$", width: 9, align: "right",
  render: (s) => compactUsd(s.list_total_cost),
  compare: (a, b) => {
    const ca = a.list_total_cost === "included" ? -1 : parseFloat(a.list_total_cost || 0);
    const cb = b.list_total_cost === "included" ? -1 : parseFloat(b.list_total_cost || 0);
    return ca - cb;
  },
};
const COL_TOOLS = {
  key: "tools", label: "TOOLS", width: 6, align: "right",
  render: (s) => s.list_tool_count > 0 ? String(s.list_tool_count) : "",
  compare: (a, b) => (a.list_tool_count || 0) - (b.list_tool_count || 0),
};
const COL_TOK_RATE = {
  key: "tok_rate", label: "TOK/m", width: 7, align: "right",
  render: (s) => s.list_tokens_per_min > 0 ? compactTokens(Math.round(s.list_tokens_per_min)) : "",
  compare: (a, b) => (a.list_tokens_per_min || 0) - (b.list_tokens_per_min || 0),
};
const COL_COST_RATE = {
  key: "cost_rate", label: "$/m", width: 6, align: "right",
  render: (s) => s.list_cost_per_min > 0.001 ? `$${s.list_cost_per_min.toFixed(2)}` : "",
  compare: (a, b) => (a.list_cost_per_min || 0) - (b.list_cost_per_min || 0),
};
const COL_CPU = {
  key: "cpu", label: "CPU%", width: 5, align: "right",
  render: (s) => s.process ? `${s.process.cpu}` : "",
  compare: (a, b) => ((a.process && a.process.cpu) || 0) - ((b.process && b.process.cpu) || 0),
};
const COL_MEM = {
  key: "mem", label: "MEM", width: 6, align: "right",
  render: (s) => s.process ? compactBytes(s.process.memory) : "",
  compare: (a, b) => ((a.process && a.process.memory) || 0) - ((b.process && b.process.memory) || 0),
};
const COL_TOOLS_RATE = {
  key: "tools_rate", label: "TL/m", width: 6, align: "right",
  render: (s) => s.list_tools_per_min > 0.1 ? s.list_tools_per_min.toFixed(1) : "",
  compare: (a, b) => (a.list_tools_per_min || 0) - (b.list_tools_per_min || 0),
};
const COL_MODEL = {
  key: "model", label: "MODEL", width: 12, align: "left",
  render: (s) => {
    const m = s.model || "";
    // Shorten common prefixes for readability
    return m.replace(/^claude-/, "c-").replace(/^gpt-/, "g-");
  },
  compare: (a, b) => (a.model || "").localeCompare(b.model || ""),
};
const COL_IN_TOKENS = {
  key: "in_tokens", label: "IN", width: 7, align: "right",
  render: (s) => compactTokens(s.list_input_tokens || 0),
  compare: (a, b) => (a.list_input_tokens || 0) - (b.list_input_tokens || 0),
};
const COL_OUT_TOKENS = {
  key: "out_tokens", label: "OUT", width: 7, align: "right",
  render: (s) => compactTokens(s.list_output_tokens || 0),
  compare: (a, b) => (a.list_output_tokens || 0) - (b.list_output_tokens || 0),
};
const COL_LAST_TOOL = {
  key: "last_tool", label: "LAST TOOL", width: 14, align: "left",
  render: (s) => {
    const t = s.list_last_tool || "";
    // Strip common prefixes for compactness
    return t.replace(/^mcp__[^_]+__/, "mcp:");
  },
  compare: (a, b) => (a.list_last_tool || "").localeCompare(b.list_last_tool || ""),
};
const COL_PROJECT = {
  key: "project", label: "PROJECT", width: 0, align: "left", flex: true,
  render: (s) => s._abbrevLabel || s.label_source || "unknown",
  compare: (a, b) => (a.label_source || "").localeCompare(b.label_source || ""),
};

const SUMMARY_COLUMNS = [
  COL_STATUS, COL_LAST, COL_DURATION, COL_MODEL, COL_IN_TOKENS, COL_OUT_TOKENS, COL_COST, COL_TOOLS, COL_PROJECT,
];

const LIVE_COLUMNS = [
  COL_STATUS, COL_LAST, COL_CPU, COL_MEM, COL_TOK_RATE, COL_COST_RATE, COL_TOOLS_RATE, COL_LAST_TOOL, COL_PROJECT,
];

/** Get active column set based on list tab */
function activeColumns(state) {
  return state.listTab === 1 ? LIVE_COLUMNS : SUMMARY_COLUMNS;
}

// Back-compat alias used by non-interactive output
const COLUMNS = SUMMARY_COLUMNS;

// ---------------------------------------------------------------------------
// Tier 2: OS process metrics (posix backend)
// ---------------------------------------------------------------------------

const TIER2_INTERVAL_TICKS = 3; // collect every 3rd loadSessions tick
const LSOF_CHUNK_SIZE = 50;
const PID_TREE_TTL_MS = 15_000; // cache subtree PIDs for 15s

// Minimal pidusage: runs ps to get CPU% and RSS for a set of PIDs.
function pidusage(pids) {
  if (!pids.length) return Promise.resolve(new Map());
  const isDarwin = process.platform === "darwin";
  const args = isDarwin
    ? ["-p", pids.join(","), "-o", "pid=,pcpu=,rss="]
    : ["-p", pids.join(","), "-o", "pid=,pcpu=,rss="];
  return new Promise((resolve) => {
    const proc = spawn("ps", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (chunk) => { out += chunk; });
    proc.on("close", () => {
      const result = new Map();
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const pid = parseInt(parts[0], 10);
          const cpu = parseFloat(parts[1]) || 0;
          const rss = (parseInt(parts[2], 10) || 0) * 1024; // KB → bytes
          if (pid > 0) result.set(pid, { cpu, memory: rss });
        }
      }
      resolve(result);
    });
    proc.on("error", () => resolve(new Map()));
  });
}

// Run a single ps to get a full snapshot of all processes.
function psSnapshot() {
  const isDarwin = process.platform === "darwin";
  const args = isDarwin
    ? ["-Aww", "-o", "pid=,ppid=,args="]
    : ["-eo", "pid=,ppid=,args=", "ww"];
  return new Promise((resolve) => {
    const proc = spawn("ps", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (chunk) => { out += chunk; });
    proc.on("close", () => {
      const procs = new Map(); // pid → { ppid, args }
      for (const line of out.split("\n")) {
        const trimmed = line.trimStart();
        const sp1 = trimmed.indexOf(" ");
        if (sp1 < 0) continue;
        const pid = parseInt(trimmed.slice(0, sp1), 10);
        const rest = trimmed.slice(sp1).trimStart();
        const sp2 = rest.indexOf(" ");
        if (sp2 < 0) continue;
        const ppid = parseInt(rest.slice(0, sp2), 10);
        const args = rest.slice(sp2).trimStart();
        if (pid > 0) procs.set(pid, { ppid, args });
      }
      resolve(procs);
    });
    proc.on("error", () => resolve(new Map()));
  });
}

// BFS to collect all descendant PIDs from a childrenByPpid map.
function bfsDescendants(rootPid, childrenByPpid) {
  const result = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    const children = childrenByPpid.get(pid);
    if (children) {
      for (const child of children) {
        if (!result.has(child)) {
          result.add(child);
          queue.push(child);
        }
      }
    }
  }
  return result;
}

// Extract session UUID from Claude/Codex command line args.
const RESUME_UUID_RE = /--resume\s+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/;
const CLAUDE_CMD_RE = /\bclaude\b/;
const CODEX_CMD_RE = /\bcodex\b/;

// lsof-based fallback: find session UUID by checking open files.
let _lsofCache = new Map(); // pid → { uuid, ts }
let _lsofCacheTs = 0;

function lsofLookup(pids) {
  if (!pids.length) return Promise.resolve(new Map());
  // Chunk pids to avoid ARG_MAX
  const chunks = [];
  for (let i = 0; i < pids.length; i += LSOF_CHUNK_SIZE) {
    chunks.push(pids.slice(i, i + LSOF_CHUNK_SIZE));
  }
  return new Promise((resolve) => {
    const result = new Map();
    let pending = chunks.length;
    if (pending === 0) { resolve(result); return; }
    for (const chunk of chunks) {
      const args = ["-p", chunk.join(","), "-Fn"];
      const proc = spawn("lsof", args, { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      proc.stdout.on("data", (d) => { out += d; });
      proc.on("close", () => {
        let currentPid = null;
        for (const line of out.split("\n")) {
          if (line.startsWith("p")) currentPid = parseInt(line.slice(1), 10) || null;
          else if (line.startsWith("n") && currentPid) {
            const path = line.slice(1);
            // Look for UUID in path (Claude session files)
            const m = path.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/);
            if (m) result.set(currentPid, m[1]);
          }
        }
        if (--pending === 0) resolve(result);
      });
      proc.on("error", () => { if (--pending === 0) resolve(result); });
    }
  });
}

async function collectProcessMetrics(sessions) {
  if (process.platform === "win32") return new Map();

  const snapshot = await psSnapshot();
  if (snapshot.size === 0) return new Map();

  // Build childrenByPpid
  const childrenByPpid = new Map();
  for (const [pid, info] of snapshot) {
    const list = childrenByPpid.get(info.ppid);
    if (list) list.push(pid);
    else childrenByPpid.set(info.ppid, [pid]);
  }

  // Identify root processes (Claude/Codex) and extract session UUID from argv
  const rootPids = new Map(); // sessionKey → rootPid
  const unmappedClaude = []; // PIDs where Claude process found but no --resume UUID
  const unmappedCodex = [];

  for (const [pid, info] of snapshot) {
    const args = info.args || "";
    const isClaudeProc = CLAUDE_CMD_RE.test(args);
    const isCodexProc = CODEX_CMD_RE.test(args);
    if (!isClaudeProc && !isCodexProc) continue;

    const resumeMatch = args.match(RESUME_UUID_RE);
    if (resumeMatch) {
      const uuid = resumeMatch[1];
      const provider = isCodexProc ? "codex" : "claude";
      const key = `${provider}:${uuid}`;
      rootPids.set(key, pid);
    } else {
      if (isClaudeProc) unmappedClaude.push(pid);
      else unmappedCodex.push(pid);
    }
  }

  // lsof fallback for unmapped Claude PIDs (check open files for UUID)
  if (unmappedClaude.length > 0) {
    const now = Date.now();
    // Only re-run lsof if cache is stale
    const needsLsof = unmappedClaude.filter((pid) => {
      const cached = _lsofCache.get(pid);
      return !cached || (now - cached.ts > PID_TREE_TTL_MS);
    });
    if (needsLsof.length > 0) {
      const lsofResult = await lsofLookup(needsLsof);
      for (const [pid, uuid] of lsofResult) {
        _lsofCache.set(pid, { uuid, ts: now });
      }
    }
    for (const pid of unmappedClaude) {
      const cached = _lsofCache.get(pid);
      if (cached && cached.uuid) {
        const key = `claude:${cached.uuid}`;
        if (!rootPids.has(key)) rootPids.set(key, pid);
      }
    }
  }

  // Build descendant sets for each session
  const sessionPids = new Map(); // sessionKey → Set<pid>
  for (const [key, rootPid] of rootPids) {
    sessionPids.set(key, bfsDescendants(rootPid, childrenByPpid));
  }

  // Collect all PIDs that need usage info
  const allPids = new Set();
  for (const pids of sessionPids.values()) {
    for (const pid of pids) allPids.add(pid);
  }

  // Get CPU/memory for all PIDs in one batched call
  const usage = await pidusage([...allPids]);

  // Aggregate per session
  const result = new Map();
  for (const [key, pids] of sessionPids) {
    let totalCpu = 0;
    let totalMemory = 0;
    for (const pid of pids) {
      const u = usage.get(pid);
      if (u) {
        totalCpu += u.cpu;
        totalMemory += u.memory;
      }
    }
    const rootPid = rootPids.get(key);
    const rootInfo = snapshot.get(rootPid);
    result.set(key, {
      pids: pids.size,
      cpu: Math.round(totalCpu * 10) / 10,
      memory: totalMemory,
      command: rootInfo ? rootInfo.args : "",
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// TUI state
// ---------------------------------------------------------------------------

function createState() {
  return {
    sessions: [],
    filtered: [],
    sortCol: "active",
    sortAsc: true,
    scrollOffset: 0,
    hScroll: 0,
    selectedRow: 0,
    searchQuery: "",
    mode: "list", // "list" | "detail" | "search" | "help" | "sortby"
    sortbyIdx: 0, // cursor position in sort-by sidebar
    detailSession: null,
    detailData: null,
    panelData: null,
    _panelSessionId: null,
    _needsPanelLoad: false,
    codexPlan: "retail",
    claudePlan: "retail",
    stats: null,
    dirty: true,
    quit: false,
    headerLines: 4, // number of header lines (boxTop + 2 content + boxBottom)
    _processMetrics: new Map(),
    _tier2Tick: TIER2_INTERVAL_TICKS - 1,
    bottomTab: 0, // 0=Info, 1=System, 2=Agent
    hoverTab: -1, // tab index being hovered, -1 = none
    listTab: 0, // 0=Summary, 1=Live
    hoverListTab: -1, // list tab hover, -1 = none
  };
}

// ---------------------------------------------------------------------------
// Stats computation
// ---------------------------------------------------------------------------

function computeStats(sessions) {
  let totalClaude = 0, totalCodex = 0;
  let active1h = 0, active24h = 0, active7d = 0;
  let totalInput = 0, totalOutput = 0;
  let spendClaude = 0, spendCodex = 0;
  const models = {};
  let oldestStart = null;
  const now = Date.now();
  const h1 = 3600_000, h24 = 86400_000, d7 = 604800_000;

  let totalCpu = 0, totalMemory = 0, totalTools = 0;

  for (const s of sessions) {
    if (s.provider === "claude") totalClaude++;
    else totalCodex++;

    const lastActive = parseTimestamp(s.last_active);
    if (lastActive) {
      const age = now - lastActive.getTime();
      if (age < h1) active1h++;
      if (age < h24) active24h++;
      if (age < d7) active7d++;
    }

    const started = parseTimestamp(s.started_at);
    if (started && (!oldestStart || started < oldestStart)) oldestStart = started;

    totalInput += s.list_input_tokens || 0;
    totalOutput += s.list_output_tokens || 0;
    totalTools += s.list_tool_count || 0;

    if (s.process) {
      totalCpu += s.process.cpu || 0;
      totalMemory += s.process.memory || 0;
    }

    const cost = s.list_total_cost;
    if (cost && cost !== "included") {
      const v = parseFloat(cost);
      if (!isNaN(v)) {
        if (s.provider === "claude") spendClaude += v;
        else spendCodex += v;
      }
    }

    if (s.model) {
      // Shorten model name for stats display
      const short = s.model.replace(/^claude-/, "").replace(/-202\d+$/, "");
      models[short] = (models[short] || 0) + 1;
    }
  }

  let uptime = "n/a";
  if (oldestStart) {
    const secs = Math.floor((now - oldestStart.getTime()) / 1000);
    if (secs < 3600) uptime = `${Math.floor(secs / 60)}m`;
    else if (secs < 86400) uptime = `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
    else uptime = `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
  }

  return {
    total: sessions.length,
    totalClaude, totalCodex,
    active1h, active24h, active7d,
    totalInput, totalOutput,
    totalCpu: Math.round(totalCpu * 10) / 10,
    totalMemory,
    totalTools,
    spendTotal: spendClaude + spendCodex,
    spendClaude, spendCodex,
    models,
    uptime,
  };
}

// ---------------------------------------------------------------------------
// Sorting and filtering
// ---------------------------------------------------------------------------

function applySortAndFilter(state) {
  let list = state.sessions;

  // Live tab: only show sessions with a running process
  if (state.listTab === 1) {
    list = list.filter((s) => !!s.process);
  }

  // Filter by search query
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    list = list.filter((s) => {
      const project = (s.label_source || "").toLowerCase();
      const model = (s.model || "").toLowerCase();
      const provider = (s.provider || "").toLowerCase();
      const sid = (s.session_id || "").toLowerCase();
      return project.includes(q) || model.includes(q) || provider.includes(q) || sid.includes(q);
    });
  }

  // Sort using active column set
  const cols = activeColumns(state);
  const col = cols.find((c) => c.key === state.sortCol);
  if (col) {
    list = [...list].sort((a, b) => {
      const cmp = col.compare(a, b);
      return state.sortAsc ? cmp : -cmp;
    });
  }

  // Abbreviate project labels
  const labels = abbreviatePaths(list.map((s) => s.label_source));
  for (let i = 0; i < list.length; i++) {
    list[i]._abbrevLabel = labels[i];
  }

  state.filtered = list;
  state.stats = computeStats(state.sessions);

  // Clamp selection
  if (state.selectedRow >= list.length) state.selectedRow = Math.max(0, list.length - 1);
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function costColor(value) {
  if (value === null || value === undefined || value === "included") return C.dimText;
  const v = parseFloat(value);
  if (isNaN(v)) return C.dimText;
  if (v < 1) return C.costGreen;
  if (v < 10) return C.costYellow;
  return C.costRed;
}

/** Slice an ANSI-colored string by visible column range [start, start+len). */
function ansiSlice(str, start, len) {
  let vis = 0;       // visible column position
  let i = 0;         // string index
  let out = "";
  let collecting = false;  // inside the visible window
  const end = start + len;

  while (i < str.length && vis < end) {
    // ANSI escape sequence — zero width, always include if we're past start
    if (str[i] === "\x1b") {
      const mEnd = str.indexOf("m", i);
      if (mEnd !== -1) {
        const seq = str.substring(i, mEnd + 1);
        if (vis >= start) out += seq;
        i = mEnd + 1;
        continue;
      }
    }
    if (vis >= start && vis < end) {
      collecting = true;
      out += str[i];
    }
    vis++;
    i++;
  }
  // If line was shorter than requested, pad with spaces
  const outVis = out.replace(/\x1b\[[^m]*m/g, "").length;
  if (outVis < len) out += " ".repeat(len - outVis);
  return out;
}

function padOrClip(text, width, align) {
  if (text.length > width) {
    return width <= 3 ? text.slice(0, width) : text.slice(0, width - 1) + "…";
  }
  return align === "right" ? text.padStart(width) : text.padEnd(width);
}

// ---------------------------------------------------------------------------
// Render: header area
// ---------------------------------------------------------------------------

// Global history for overview sparklines
const _globalCpuHist = [];
const _globalMemHist = [];
const _globalSpendDeltaHist = [];
const _globalTokenDeltaHist = [];
let _prevSpendTotal = null;
let _prevTokenTotal = null;
let _deltaWarmup = 0;

function pushGlobalHistory(arr, value) {
  arr.push(value);
  if (arr.length > HISTORY_MAX) arr.shift();
}

/** Push sparkline history — call once per data refresh tick, not per render. */
function updateOverviewHistory(stats) {
  const curSpend = stats.spendTotal || 0;
  const curTokens = (stats.totalInput || 0) + (stats.totalOutput || 0);

  _deltaWarmup = (_deltaWarmup || 0) + 1;
  if (_prevSpendTotal !== null && _deltaWarmup > 3) {
    pushGlobalHistory(_globalSpendDeltaHist, Math.max(0, curSpend - _prevSpendTotal));
    pushGlobalHistory(_globalTokenDeltaHist, Math.max(0, curTokens - _prevTokenTotal));
  }
  _prevSpendTotal = curSpend;
  _prevTokenTotal = curTokens;

  pushGlobalHistory(_globalCpuHist, stats.totalCpu || 0);
  pushGlobalHistory(_globalMemHist, (stats.totalMemory || 0) / (1024 * 1024));
}

function renderHeader(stats, width) {
  const lines = [];
  lines.push(boxTop(width, "Overview"));

  const curSpend = stats.spendTotal || 0;
  const curTokens = (stats.totalInput || 0) + (stats.totalOutput || 0);
  const memMB = (stats.totalMemory || 0) / (1024 * 1024);

  const inner = width - 4; // inside box borders
  // Two columns: each has label + chart, separated by a gap
  const gap = 2;
  const colW = Math.floor((inner - gap) / 2);
  const labelW = 18;
  const chartW = Math.max(4, colW - labelW - 1);

  // Row 1: Spend + CPU
  const spendLabel = `${C.hdrLabel}Total Spend${RESET} ${C.hdrYellow}$${curSpend.toFixed(2)}${RESET}`;
  const spendChart = renderSparkline(_globalSpendDeltaHist, chartW, 0, "accent", "braille");
  const cpuLabel = `${C.hdrLabel}Total CPU${RESET} ${C.hdrValue}${stats.totalCpu}%${RESET}`;
  const cpuChart = renderSparkline(_globalCpuHist, chartW, 100, "cpu", "dots");
  const row1Left = buildOverviewCell(spendLabel, spendChart, labelW, chartW, colW);
  const row1Right = buildOverviewCell(cpuLabel, cpuChart, labelW, chartW, colW);
  lines.push(boxLine(row1Left + " ".repeat(gap) + row1Right, width));

  // Row 2: Tokens + Memory
  const tokLabel = `${C.hdrLabel}Total Tokens${RESET} ${C.hdrValue}${compactTokens(curTokens)}${RESET}`;
  const tokChart = renderSparkline(_globalTokenDeltaHist, chartW, 0, "accent", "blocks");
  const memLabel = `${C.hdrLabel}Total Mem${RESET} ${C.hdrValue}${memMB.toFixed(0)} MB${RESET}`;
  const memChart = renderSparkline(_globalMemHist, chartW, 0, "accent", "shades");
  const row2Left = buildOverviewCell(tokLabel, tokChart, labelW, chartW, colW);
  const row2Right = buildOverviewCell(memLabel, memChart, labelW, chartW, colW);
  lines.push(boxLine(row2Left + " ".repeat(gap) + row2Right, width));

  lines.push(boxBottom(width));
  return lines;
}

/** Build one cell: label padded to labelW, then sparkline, total padded to cellW */
function buildOverviewCell(label, chart, labelW, chartW, cellW) {
  const labelPlain = label.replace(/\x1b\[[^m]*m/g, "");
  const pad = Math.max(1, labelW - labelPlain.length);
  const content = label + " ".repeat(pad) + chart;
  const contentLen = labelPlain.length + pad + chartW;
  const trailing = Math.max(0, cellW - contentLen);
  return content + " ".repeat(trailing);
}

// ---------------------------------------------------------------------------
// Render: column headers
// ---------------------------------------------------------------------------

function renderColumnHeaders(state, width) {
  const cols = activeColumns(state);
  const totalW = columnsFullWidth(width, cols);
  let line = C.colHdrBg + " ";
  let used = 1;

  for (const col of cols) {
    const w = col.flex ? Math.max(8, totalW - used) : col.width;
    let label = col.label;
    if (col.key === state.sortCol) {
      label += state.sortAsc ? "▲" : "▼";
    }
    label = padOrClip(label, w, col.align);
    line += label;
    used += w;
    if (!col.flex && used < totalW) { line += " "; used++; }
  }

  return C.colHdrBg + ansiSlice(line, state.hScroll, width) + RESET;
}

/** Total width of all columns (flex column gets at least its content width). */
function columnsFullWidth(termWidth, cols) {
  cols = cols || SUMMARY_COLUMNS;
  let fixed = 0;
  for (const col of cols) {
    if (!col.flex) fixed += col.width + 1; // +1 separator
  }
  return Math.max(termWidth, fixed + 40);
}

// ---------------------------------------------------------------------------
// Render: session row
// ---------------------------------------------------------------------------

function renderSessionRow(session, index, isSelected, width, now, hScroll, state) {
  const cols = state ? activeColumns(state) : SUMMARY_COLUMNS;
  const totalW = columnsFullWidth(width, cols);
  const bg = isSelected ? C.selBg : "";
  const fg = isSelected ? C.selFg : "";
  let line = bg + fg + " ";
  let used = 1;

  for (const col of cols) {
    const w = col.flex ? Math.max(8, totalW - used) : col.width;
    let text = col.render(session, now, index);
    text = padOrClip(text, w, col.align);

    // Color provider badge
    if (col.key === "status") {
      const color = session.process ? C.chartBarLow : C.dimText;
      line += color + text + RESET + bg;
    } else if (!isSelected && col.key === "cost") {
      line += costColor(session.list_total_cost) + text + RESET + bg;
    } else if (!isSelected && col.key === "cpu") {
      const cpu = session.process ? session.process.cpu : 0;
      const color = cpu > 80 ? C.chartBarHi : cpu > 40 ? C.chartBarMed : cpu > 0 ? C.chartBarLow : C.dimText;
      line += color + text + RESET + bg;
    } else {
      line += text;
    }

    used += w;
    if (!col.flex && used < totalW) { line += " "; used++; }
  }

  return bg + ansiSlice(line, hScroll, width) + RESET;
}

// ---------------------------------------------------------------------------
// Render: footer
// ---------------------------------------------------------------------------

function renderFooter(state, width) {
  const items = [
    ["F1", "Help"], ["F3", "Search"], ["F5", "Refresh"],
    ["F6", "SortBy"], ["Tab", "Panel"], ["`", "View"], ["F10", "Quit"],
  ];
  let line = "";
  for (const [key, label] of items) {
    line += C.footerKey + key + RESET + C.footerLabel + label + " " + RESET;
  }
  if (state.searchQuery) {
    line += C.searchFg + " Filter: " + state.searchQuery + " " + RESET;
  }
  const plain = line.replace(/\x1b\[[^m]*m/g, "");
  const pad = Math.max(0, width - plain.length);
  return line + C.footerBg + " ".repeat(pad) + RESET;
}

// ---------------------------------------------------------------------------
// Render: detail view
// ---------------------------------------------------------------------------

function renderDetailView(session, data, plan, width, height) {
  const lines = [];

  const prov = session.provider === "claude" ? "Claude" : "Codex";
  lines.push(boxTop(width - 1, `Session Detail — ${prov} ${session.session_id || "unknown"}`));
  lines.push("");

  if (data) {
    if (session.provider === "codex") {
      const incl = planIncludesProvider(plan, "codex");
      if (incl) {
        lines.push(`  Billable cost: Not Billed (plan: ${plan})`);
        lines.push(`  Retail-equivalent: ${usd(data.costs.total)}`);
      } else {
        lines.push(`  ${BOLD}Total cost: ${C.costYellow}${usd(data.costs.total)}${RESET}`);
      }
      lines.push(`  Breakdown: input ${usd(data.costs.input)} | cached ${usd(data.costs.cached_input)} | output ${usd(data.costs.output)}`);
      lines.push("");
      lines.push(`  Model: ${data.model || "unknown"}`);
      lines.push(`  Plan: ${plan}`);
      lines.push(`  Project: ${session.label_source || "unknown"}`);
      lines.push("");
      lines.push("  Tokens:");
      lines.push(`    Input (uncached):  ${numberWithCommas(data.tokens.input)}`);
      lines.push(`    Input (total):     ${numberWithCommas(data.tokens.input_total)}`);
      lines.push(`    Cached input:      ${numberWithCommas(data.tokens.cached_input)}`);
      lines.push(`    Output:            ${numberWithCommas(data.tokens.output)}`);
      lines.push(`    Reasoning output:  ${numberWithCommas(data.tokens.reasoning_output)}`);
      lines.push(`    Total:             ${numberWithCommas(data.tokens.total)}`);
      lines.push("");
      lines.push(`  Rates (USD / 1M tokens):`);
      lines.push(`    Input: $${data.rates.input}  Cached: $${data.rates.cached_input}  Output: $${data.rates.output}`);
    } else if (session.provider === "claude") {
      const incl = planIncludesProvider(plan, "claude");
      if (incl) {
        lines.push(`  Billable cost: Not Billed (plan: ${plan})`);
        lines.push(`  Retail-equivalent: ${usd(data.costs.total)}`);
      } else {
        lines.push(`  ${BOLD}Total cost: ${C.costYellow}${usd(data.costs.total)}${RESET}`);
      }
      lines.push(`  Breakdown: input ${usd(data.costs.input)} | cache write 5m ${usd(data.costs.cache_write_5m)} | cache write 1h ${usd(data.costs.cache_write_1h)} | cache read ${usd(data.costs.cache_read)} | output ${usd(data.costs.output)}`);
      lines.push("");
      lines.push(`  Model${data.models.length > 1 ? "s" : ""}: ${data.models.join(", ")}`);
      lines.push(`  Plan: ${plan}`);
      lines.push(`  Project: ${session.label_source || "unknown"}`);
      lines.push("");
      lines.push("  Tokens:");
      lines.push(`    Input:           ${numberWithCommas(data.tokens.input)}`);
      lines.push(`    Cache write 5m:  ${numberWithCommas(data.tokens.cache_write_5m)}`);
      lines.push(`    Cache write 1h:  ${numberWithCommas(data.tokens.cache_write_1h)}`);
      lines.push(`    Cache read:      ${numberWithCommas(data.tokens.cache_read)}`);
      lines.push(`    Output:          ${numberWithCommas(data.tokens.output)}`);
      lines.push(`    Total:           ${numberWithCommas(data.tokens.total)}`);
      lines.push("");
      lines.push("  Rates (USD / 1M tokens):");
      for (const model of data.models) {
        const p = resolveClaudePricing(model);
        lines.push(`    ${model}:`);
        lines.push(`      Input: $${p.input_per_million}  Cache write 5m: $${p.cache_write_5m_per_million}  Cache write 1h: $${p.cache_write_1h_per_million}  Cache read: $${p.cache_read_per_million}  Output: $${p.output_per_million}`);
      }
    }

    // --- Metrics section ---
    const m = safeMetrics(data);
    if (m.tool_count > 0 || m.skill_count > 0 || m.web_fetch_count > 0 || m.web_search_count > 0 || m.mcp_tool_count > 0) {
      lines.push("");
      lines.push(BOLD + "  Activity Metrics:" + RESET);

      if (m.tool_count > 0) {
        lines.push(`    Tool invocations: ${numberWithCommas(m.tool_count)}`);
        const sorted = Object.entries(m.tools)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 15);
        for (const [name, count] of sorted) {
          lines.push(`      ${count.toString().padStart(6)}x  ${name}`);
        }
      }

      if (m.skill_count > 0) {
        lines.push(`    Skill invocations: ${numberWithCommas(m.skill_count)}`);
        for (const [name, count] of Object.entries(m.skills).sort((a, b) => b[1] - a[1])) {
          lines.push(`      ${count.toString().padStart(6)}x  /${name}`);
        }
      }

      if (m.web_fetch_count > 0) {
        lines.push(`    Web fetches: ${m.web_fetch_count}`);
        for (const url of m.web_fetches.slice(0, 10)) {
          lines.push(`      - ${url}`);
        }
      }

      if (m.web_search_count > 0) {
        lines.push(`    Web searches: ${m.web_search_count}`);
        for (const q of m.web_searches.slice(0, 10)) {
          lines.push(`      - "${q}"`);
        }
      }

      if (m.mcp_tool_count > 0) {
        lines.push(`    MCP tool calls: ${m.mcp_tool_count}`);
        for (const name of m.mcp_tools.slice(0, 10)) {
          lines.push(`      - ${name}`);
        }
      }
    }

    // --- Process metrics (Tier 2) ---
    if (session.process) {
      const pm = session.process;
      const memMB = (pm.memory / (1024 * 1024)).toFixed(1);
      lines.push("");
      lines.push(BOLD + "  Process:" + RESET);
      lines.push(`    CPU:     ${pm.cpu}%`);
      lines.push(`    Memory:  ${memMB} MB`);
      lines.push(`    PIDs:    ${pm.pids}`);
      if (pm.command) lines.push(`    Command: ${pm.command}`);
    }
  } else {
    lines.push("  (No cost data available for this session)");
  }

  lines.push("");
  lines.push(C.dimText + "  Press q, Esc, or ← to return to list" + RESET);

  // Pad to fill screen
  while (lines.length < height - 1) lines.push("");
  return lines.slice(0, height - 1);
}

// ---------------------------------------------------------------------------
// Render: bottom panels (btop-style three-column layout)
// ---------------------------------------------------------------------------

const MIN_PANEL = 10;
const MAX_PANEL = 16;

/**
 * Build content lines for each of the three bottom panels, then merge
 * them side-by-side with box borders into composite screen lines.
 */
const BOTTOM_TABS = ["Info", "System", "Agent Activity"];

function renderBottomPanels(session, data, plan, width, panelHeight, activeTab, hoverTab) {
  const bc = C.border;
  const innerW = width - 4; // content inside │ ... │
  const innerH = panelHeight - 3; // top border + tab/rule line + bottom border

  // Build tab positions first (shared between top border and rule line)
  // Layout: ╭─ Session  System  Agent Activity ──────────╮
  //         │  ───────━━━━━━━━──────────────────────────  │
  const tabParts = []; // [{col, len, idx}]
  let col = 3; // after "╭─ " or "│  "
  for (let i = 0; i < BOTTOM_TABS.length; i++) {
    if (i > 0) col += 2; // 2-space gap
    tabParts.push({ col, len: BOTTOM_TABS[i].length, idx: i });
    col += BOTTOM_TABS[i].length;
  }
  const labelsEnd = col; // first char after last label

  // --- Top border with tab labels ---
  let topLine = bc + BOX.tl + BOX.h + " " + RESET;
  for (let i = 0; i < BOTTOM_TABS.length; i++) {
    if (i > 0) topLine += "  ";
    const name = BOTTOM_TABS[i];
    if (i === activeTab) {
      topLine += "\x1b[1;38;5;255m" + name + RESET;
    } else if (i === hoverTab) {
      topLine += "\x1b[4;38;5;255m" + name + RESET; // underline + bright white on hover
    } else {
      topLine += "\x1b[38;5;245m" + name + RESET;
    }
  }
  topLine += " ";
  const remaining = Math.max(0, width - labelsEnd - 2);
  topLine += bc + BOX.h.repeat(remaining) + BOX.tr + RESET;

  // --- Underline rule: bright under active tab, dim elsewhere ---
  const dimRule = "\x1b[38;5;238m";
  let ruleLine = bc + BOX.v + RESET + dimRule + "──" + RESET;
  for (let i = 0; i < BOTTOM_TABS.length; i++) {
    if (i > 0) ruleLine += dimRule + "──" + RESET;
    const name = BOTTOM_TABS[i];
    if (i === activeTab) {
      ruleLine += C.borderHi + "━".repeat(name.length) + RESET;
    } else if (i === hoverTab) {
      ruleLine += "\x1b[38;5;245m" + "━".repeat(name.length) + RESET; // subtle underline on hover
    } else {
      ruleLine += dimRule + "─".repeat(name.length) + RESET;
    }
  }
  ruleLine += dimRule + "─" + RESET;
  const ruleRemain = Math.max(0, width - labelsEnd - 2);
  ruleLine += dimRule + "─".repeat(ruleRemain) + RESET + bc + BOX.v + RESET;

  // --- Content ---
  let contentLines;
  switch (activeTab) {
    case 0: contentLines = renderSessionInfoPanel(session, data, plan, width, innerH); break;
    case 1: contentLines = renderSystemPanel(session, data, width, innerH); break;
    case 2: contentLines = renderAgentPanel(session, data, width, innerH); break;
    default: contentLines = renderSessionInfoPanel(session, data, plan, width, innerH);
  }

  const result = [];
  result.push(topLine);
  result.push(ruleLine);
  for (let i = 0; i < innerH; i++) {
    result.push(boxLine(contentLines[i] || "", width));
  }
  result.push(boxBottom(width));
  return result;
}

/** Info panel: session identity, model, project, cost, tokens */
function renderSessionInfoPanel(session, data, plan, panelW, rows) {
  const lines = [];
  const w = panelW - 4; // inner content width
  const dimRule = "\x1b[38;5;238m";

  if (!session) {
    lines.push(C.dimText + "No session selected" + RESET);
    while (lines.length < rows) lines.push("");
    return lines;
  }
  if (!data) {
    lines.push(C.dimText + "Loading..." + RESET);
    while (lines.length < rows) lines.push("");
    return lines;
  }

  session._copyTargets = [];
  const prov = session.provider === "claude" ? "Claude" : "Codex";
  const sid = session.session_id || "unknown";
  const shortSid = sid.length > w - 10 ? sid.slice(0, w - 13) + "..." : sid;
  const pm = session.process;
  const now = Date.now();

  // Helper: copy icon with flash
  function copyIcon(field) {
    const flash = session._copyFlash === field && session._copyFlashTs && (now - session._copyFlashTs < 1500);
    return flash ? `\x1b[38;5;114m✓${RESET}` : `\x1b[38;5;60m⧉${RESET}`;
  }

  // Helper: register a copyable line (icon near label)
  function addCopyLine(label, value, fullValue, field, labelW) {
    const lw = labelW || 5;
    // "Label ⧉" then pad to labelW+2, then value
    const labelWithIcon = `${C.hdrLabel}${label}${RESET} ${copyIcon(field)}`;
    const padNeeded = Math.max(0, lw - label.length - 1); // -1 for icon char width
    lines.push(`${labelWithIcon}${" ".repeat(padNeeded)} ${C.hdrValue}${value}${RESET}`);
    session._copyTargets.push({ line: lines.length - 1, field, value: fullValue || value });
  }

  // ── Identity ──
  lines.push(`${C.hdrLabel}Type${RESET}       ${C.hdrValue}${prov}${RESET}  ${C.hdrLabel}Model${RESET} ${C.hdrValue}${(data.models || [data.model])[0] || "?"}${RESET}`);
  addCopyLine("ID", shortSid, sid, "id", 9);
  if (pm && pm.command) {
    const maxCmdW = w - 12;
    const cmd = pm.command.length > maxCmdW ? pm.command.slice(0, maxCmdW - 3) + "..." : pm.command;
    addCopyLine("Cmd", cmd, pm.command, "cmd", 9);
  }

  // ── Location ──
  const proj = session.label_source || "unknown";
  const shortProj = proj.length > w - 12 ? "…" + proj.slice(-(w - 13)) : proj;
  addCopyLine("Dir", shortProj, proj, "dir", 9);

  // Started
  if (session.started_at) {
    const d = parseTimestamp(session.started_at);
    const started = d ? d.toLocaleString() : session.started_at;
    lines.push(`${C.hdrLabel}Started${RESET}    ${C.hdrValue}${started}${RESET}`);
  }

  // ── Separator ──
  if (lines.length < rows - 4) {
    lines.push(dimRule + "─".repeat(Math.min(w, 40)) + RESET);
  }

  // ── Cost ──
  const incl = planIncludesProvider(plan, session.provider);
  const costVal = incl ? "included" : usd(data.costs.total);
  const costColor = incl ? C.hdrValue : C.costYellow;
  const costRate = (session.list_cost_per_min > 0.001)
    ? `  ${C.hdrLabel}rate${RESET} ${costColor}$${session.list_cost_per_min.toFixed(2)}/m${RESET}`
    : "";
  lines.push(`${C.hdrLabel}Cost${RESET}       ${costColor}${costVal}${RESET}${costRate}`);

  // ── Tokens ──
  const tokIn = compactTokens((data.tokens.input || 0) + (data.tokens.cache_read || data.tokens.cached_input || 0));
  const tokOut = compactTokens(data.tokens.output);
  const tokTotal = compactTokens(data.tokens.total);
  const tokRate = (session.list_tokens_per_min > 0)
    ? `  ${C.hdrLabel}rate${RESET} ${C.hdrValue}${compactTokens(Math.round(session.list_tokens_per_min))}/m${RESET}`
    : "";
  lines.push(`${C.hdrLabel}Tokens${RESET}     ${C.hdrValue}${tokTotal}${RESET}  ${C.hdrLabel}in${RESET} ${C.hdrValue}${tokIn}${RESET}  ${C.hdrLabel}out${RESET} ${C.hdrValue}${tokOut}${RESET}${tokRate}`);

  while (lines.length < rows) lines.push("");
  return lines.slice(0, rows);
}

/** Center panel: CPU, memory, PIDs with strip charts */
function renderSystemPanel(session, data, panelW, rows) {
  const lines = [];
  const chartW = panelW - 20; // space for chart after labels

  if (!session) {
    lines.push(C.dimText + "No session selected" + RESET);
    while (lines.length < rows) lines.push("");
    return lines;
  }

  const pm = session.process;

  if (!pm) {
    lines.push(C.dimText + "System data is only available for running sessions" + RESET);
    while (lines.length < rows) lines.push("");
    return lines;
  }

  const sessionKey = `${session.provider}:${session.session_id}`;

  // Update history
  pushHistory(_cpuHistory, sessionKey, pm.cpu);
  pushHistory(_memHistory, sessionKey, pm.memory / (1024 * 1024)); // MB

  const cpuHist = _cpuHistory.get(sessionKey) || [];
  const memHist = _memHistory.get(sessionKey) || [];

  // CPU
  const cpuVal = `${pm.cpu}%`;
  const cpuColor = pm.cpu > 80 ? C.chartBarHi : pm.cpu > 40 ? C.chartBarMed : C.hdrValue;
  lines.push(`${C.hdrLabel}CPU${RESET}  ${cpuColor}${cpuVal.padStart(6)}${RESET}`);
  if (chartW > 8) {
    lines.push(renderSparkline(cpuHist, Math.min(chartW, panelW - 6), 100, "cpu"));
  }

  lines.push("");

  // Memory
  const memVal = `${(pm.memory / (1024 * 1024)).toFixed(1)} MB`;
  const memMax = memHist.length > 0 ? Math.max(...memHist) * 1.2 : 100;
  lines.push(`${C.hdrLabel}Mem${RESET}  ${C.hdrValue}${memVal.padStart(10)}${RESET}`);
  if (chartW > 8) {
    lines.push(renderSparkline(memHist, Math.min(chartW, panelW - 6), memMax, "accent"));
  }

  lines.push("");

  // PIDs
  lines.push(`${C.hdrLabel}PIDs${RESET} ${C.hdrValue}${pm.pids}${RESET}`);

  while (lines.length < rows) lines.push("");
  return lines.slice(0, rows);
}

/** Right panel: tool invocations, skills, web activity, MCP */
function renderAgentPanel(session, data, panelW, rows) {
  const lines = [];

  if (!session || !data) {
    if (session) lines.push(C.dimText + "Loading..." + RESET);
    while (lines.length < rows) lines.push("");
    return lines;
  }

  const m = safeMetrics(data);
  const w = panelW - 4;

  // Tools breakdown
  if (m.tool_count > 0) {
    lines.push(`${C.hdrLabel}Tools${RESET} ${C.hdrValue}${m.tool_count}${RESET} ${C.hdrDim}total${RESET}`);
    const sorted = Object.entries(m.tools)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.min(6, rows - 4));
    const maxCount = sorted.length > 0 ? sorted[0][1] : 1;
    for (const [name, count] of sorted) {
      const barW = Math.max(0, Math.min(w - 16, Math.floor((count / maxCount) * (w - 16))));
      const bar = C.accent + "█".repeat(barW) + RESET;
      const cnt = String(count).padStart(4);
      const shortName = name.length > 10 ? name.slice(0, 9) + "…" : name.padEnd(10);
      lines.push(`${C.hdrDim}${shortName}${RESET} ${cnt} ${bar}`);
    }
  } else {
    lines.push(`${C.hdrLabel}Tools${RESET} ${C.hdrDim}none${RESET}`);
  }

  // Skills
  if (m.skill_count > 0 && lines.length < rows - 2) {
    lines.push("");
    const skillList = Object.entries(m.skills)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([n, c]) => `${C.hdrValue}${c}${RESET}${C.hdrDim}×/${n}${RESET}`)
      .join(" ");
    lines.push(`${C.hdrLabel}Skills${RESET} ${skillList}`);
  }

  // Web
  if ((m.web_fetch_count > 0 || m.web_search_count > 0) && lines.length < rows - 1) {
    lines.push("");
    const parts = [];
    if (m.web_fetch_count > 0) parts.push(`${C.hdrValue}${m.web_fetch_count}${RESET} ${C.hdrDim}fetches${RESET}`);
    if (m.web_search_count > 0) parts.push(`${C.hdrValue}${m.web_search_count}${RESET} ${C.hdrDim}searches${RESET}`);
    lines.push(`${C.hdrLabel}Web${RESET}   ${parts.join("  ")}`);
  }

  // MCP
  if (m.mcp_tool_count > 0 && lines.length < rows - 1) {
    const names = m.mcp_tools.slice(0, 3).map(n => {
      const short = n.replace(/^mcp__/, "");
      return C.hdrDim + short + RESET;
    }).join(" ");
    lines.push(`${C.hdrLabel}MCP${RESET}   ${C.hdrValue}${m.mcp_tool_count}${RESET} ${names}`);
  }

  while (lines.length < rows) lines.push("");
  return lines.slice(0, rows);
}

// ---------------------------------------------------------------------------
// Render: help view
// ---------------------------------------------------------------------------

function renderHelpView(width, height) {
  const lines = [];
  lines.push(boxTop(width - 1, "Help"));
  lines.push("");
  lines.push(BOLD + "  Navigation:" + RESET);
  lines.push("    ↑/k, ↓/j        Move cursor up/down");
  lines.push("    ←, →            Scroll left/right");
  lines.push("    PgUp, PgDn       Scroll page up/down");
  lines.push("    Home, End        Jump to first/last session");
  lines.push("    Enter, l         Open session detail");
  lines.push("");
  lines.push(BOLD + "  Sorting:" + RESET);
  lines.push("    F6, >, <         Open sort-by panel");
  lines.push("    P                Sort by status");
  lines.push("    M                Sort by memory");
  lines.push("    T                Sort by cost");
  lines.push("    Click header     Sort by that column");
  lines.push("");
  lines.push(BOLD + "  Tabs:" + RESET);
  lines.push("    Tab              Cycle bottom panel tabs");
  lines.push("    1, 2, 3          Switch to Info/System/Agent");
  lines.push("    ` (backtick)     Toggle Summary/Live view");
  lines.push("");
  lines.push(BOLD + "  Other:" + RESET);
  lines.push("    /, F3            Search / filter sessions");
  lines.push("    F5, r            Refresh session data");
  lines.push("    F1, ?, h         Show this help");
  lines.push("    q, F10           Quit");
  lines.push("    Ctrl+C           Quit");
  lines.push("");
  lines.push(BOLD + "  Mouse:" + RESET);
  lines.push("    Click row        Select session");
  lines.push("    Click header     Sort by column");
  lines.push("    Click tab        Switch tab");
  lines.push("    Scroll wheel     Scroll up/down");
  lines.push("    Shift+drag       Select text for copy");
  lines.push("");
  lines.push(C.dimText + "  Press any key to return" + RESET);

  while (lines.length < height - 1) lines.push("");
  return lines.slice(0, height - 1);
}

// ---------------------------------------------------------------------------
// Render: sort-by sidebar (htop-style)
// ---------------------------------------------------------------------------

function renderSortBySidebar(state, width, height) {
  const sortableColumns = activeColumns(state);
  const sidebarW = 28;
  const boxLeft = Math.floor((width - sidebarW) / 2);

  const lines = [];
  for (let row = 0; row < height; row++) lines.push("");

  // Title row
  const titleRow = 1;
  const title = " Sort by ";
  const titleLine = C.colHdrBg + BOLD + " " + title + " ".repeat(Math.max(0, sidebarW - title.length - 2)) + " " + RESET;

  // Build sidebar rows
  const startRow = titleRow + 1;
  const items = [];
  for (let i = 0; i < sortableColumns.length; i++) {
    const col = sortableColumns[i];
    const isActive = col.key === state.sortCol;
    const isCursor = i === state.sortbyIdx;
    let label = col.label;
    if (isActive) label += state.sortAsc ? " ▲" : " ▼";
    label = padOrClip(label, sidebarW - 2, "left");
    if (isCursor) {
      items.push(C.selBg + " " + label + " " + RESET);
    } else if (isActive) {
      items.push(C.hdrCyan + " " + label + " " + RESET);
    } else {
      items.push(C.normalFg + " " + label + " " + RESET);
    }
  }

  // Footer hint
  const hint = C.dimText + " Enter=select Esc=cancel " + RESET;

  return { boxLeft, sidebarW, titleLine, items, hint };
}

// ---------------------------------------------------------------------------
// Session list tab bar (posting.sh style)
// ---------------------------------------------------------------------------

function renderListTabBar(state, width) {
  const bc = C.border;
  const activeTab = state.listTab;
  const hoverTab = state.hoverListTab;
  const list = state.filtered;
  const countLabel = ` (${list.length})`;

  // Tab positions: ╭─ Summary  Live ── (count) ──────╮
  const tabParts = [];
  let col = 3; // after "╭─ "
  for (let i = 0; i < LIST_TABS.length; i++) {
    if (i > 0) col += 2;
    tabParts.push({ col, len: LIST_TABS[i].length, idx: i });
    col += LIST_TABS[i].length;
  }
  const labelsEnd = col;

  // Top border with tab labels
  let topLine = bc + BOX.tl + BOX.h + " " + RESET;
  for (let i = 0; i < LIST_TABS.length; i++) {
    if (i > 0) topLine += "  ";
    const name = LIST_TABS[i];
    if (i === activeTab) {
      topLine += "\x1b[1;38;5;255m" + name + RESET;
    } else if (i === hoverTab) {
      topLine += "\x1b[4;38;5;255m" + name + RESET;
    } else {
      topLine += "\x1b[38;5;245m" + name + RESET;
    }
  }
  // Session count after tabs
  topLine += "\x1b[38;5;245m" + countLabel + RESET + " ";
  const remaining = Math.max(0, width - labelsEnd - countLabel.length - 2);
  topLine += bc + BOX.h.repeat(remaining) + BOX.tr + RESET;
  return topLine;
}

/** Given a 1-based column, return which list tab index was clicked, or -1. */
function listTabAtX(col) {
  let pos = 4; // skip ╭─ + space (1-based)
  for (let i = 0; i < LIST_TABS.length; i++) {
    if (i > 0) pos += 2;
    const w = LIST_TABS[i].length;
    if (col >= pos && col < pos + w) return i;
    pos += w;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Master render
// ---------------------------------------------------------------------------

function render(state) {
  const width = process.stdout.columns || 100;
  const height = process.stdout.rows || 24;
  let buf = SYNC_START + "\x1b[H"; // move cursor to top-left

  if (state.mode === "help") {
    const lines = renderHelpView(width, height);
    for (const line of lines) buf += line + "\x1b[K\n";
    buf += renderFooter(state, width);
    buf += SYNC_END;
    process.stdout.write(buf);
    return;
  }

  if (state.mode === "detail") {
    const plan = state.detailSession.provider === "codex" ? state.codexPlan : state.claudePlan;
    const lines = renderDetailView(state.detailSession, state.detailData, plan, width, height);
    for (const line of lines) buf += line + "\x1b[K\n";
    buf += renderFooter(state, width);
    buf += SYNC_END;
    process.stdout.write(buf);
    return;
  }

  // --- List mode (also used as background for sortby mode) ---
  // boxW = width - 1 to prevent terminal right-edge wrapping
  const boxW = width - 1;

  // Overview panel (top)
  const headerLines = renderHeader(state.stats || computeStats([]), boxW);

  // Collect all screen lines
  const screenLines = [];
  for (const line of headerLines) screenLines.push(line);

  // Bottom panels height (adaptive)
  const usedByHeader = headerLines.length;
  const totalBody = height - usedByHeader - 1; // -1 footer
  const panelHeight = Math.min(MAX_PANEL, Math.max(MIN_PANEL, Math.floor(totalBody * 0.45)));
  const listAreaH = Math.max(3, totalBody - panelHeight);
  // List area = boxTop(1) + colHeader(1) + rows + boxBottom(1)
  const listHeight = Math.max(1, listAreaH - 3);
  const now = new Date();
  const list = state.filtered;

  // Adjust scroll to keep selection visible
  if (state.selectedRow < state.scrollOffset) {
    state.scrollOffset = state.selectedRow;
  } else if (state.selectedRow >= state.scrollOffset + listHeight) {
    state.scrollOffset = state.selectedRow - listHeight + 1;
  }

  // Session list box with tabs
  state._listTabBarRow = screenLines.length + 1; // 1-based row
  screenLines.push(renderListTabBar(state, boxW));
  screenLines.push(renderColumnHeaders(state, width));

  if (list.length === 0 && state.listTab === 1) {
    // Empty Live tab
    const emptyMsg = C.dimText + "  No active sessions running" + RESET;
    screenLines.push(emptyMsg);
    for (let i = 1; i < listHeight; i++) screenLines.push("");
  } else {
    for (let i = 0; i < listHeight; i++) {
      const idx = state.scrollOffset + i;
      if (idx < list.length) {
        const isSelected = idx === state.selectedRow;
        screenLines.push(renderSessionRow(list[idx], idx, isSelected, width, now, state.hScroll, state));
      } else {
        screenLines.push("");
      }
    }
  }
  screenLines.push(boxBottom(boxW));

  // Bottom detail panels (tabbed)
  const selected = list[state.selectedRow] || null;
  const panelPlan = selected ? (selected.provider === "codex" ? state.codexPlan : state.claudePlan) : null;
  state._tabBarRow = screenLines.length + 1; // 1-based row of the tab bar
  const bottomLines = renderBottomPanels(selected, state.panelData, panelPlan, boxW, panelHeight, state.bottomTab, state.hoverTab);
  for (const pl of bottomLines) screenLines.push(pl);

  // Overlay sort-by sidebar if in sortby mode
  if (state.mode === "sortby") {
    const sb = renderSortBySidebar(state, width, height);
    // Center the sidebar vertically
    const totalH = 1 + sb.items.length + 1; // title + items + hint
    const startRow = Math.max(0, Math.floor((screenLines.length - totalH) / 2));

    for (let r = 0; r < screenLines.length; r++) {
      const relRow = r - startRow;
      if (relRow >= 0 && relRow < totalH) {
        let overlay;
        if (relRow === 0) {
          overlay = sb.titleLine;
        } else if (relRow <= sb.items.length) {
          overlay = sb.items[relRow - 1];
        } else {
          overlay = sb.hint;
        }
        // Splice the sidebar into the line
        const bgLine = screenLines[r] || "";
        const bgPlain = bgLine.replace(/\x1b\[[^m]*m/g, "");
        const left = ansiSlice(bgLine, 0, sb.boxLeft);
        const ovPlain = overlay.replace(/\x1b\[[^m]*m/g, "");
        const rightStart = sb.boxLeft + sb.sidebarW;
        const right = rightStart < bgPlain.length
          ? ansiSlice(bgLine, rightStart, width - rightStart)
          : " ".repeat(Math.max(0, width - rightStart));
        screenLines[r] = left + overlay + right + RESET;
      }
    }
  }

  // Write all lines
  for (const line of screenLines) buf += line + "\x1b[K\n";

  // Footer
  buf += renderFooter(state, width);
  buf += SYNC_END;
  process.stdout.write(buf);
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function parseInputSequence(buf) {
  // SGR mouse: \x1b[<btn;col;row[Mm]
  const mouseMatch = buf.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (mouseMatch) {
    const btn = parseInt(mouseMatch[1], 10);
    const col = parseInt(mouseMatch[2], 10);
    const row = parseInt(mouseMatch[3], 10);
    const release = mouseMatch[4] === "m";
    if (btn === 64) return { type: "scroll_up" };
    if (btn === 65) return { type: "scroll_down" };
    if (btn === 0 && !release) return { type: "click", col, row };
    if (btn === 35) return { type: "hover", col, row }; // motion, no button
    return null;
  }

  // F-keys
  if (buf === "\x1bOP" || buf === "\x1b[11~") return { type: "f1" };
  if (buf === "\x1bOR" || buf === "\x1b[13~") return { type: "f3" };
  if (buf === "\x1b[15~") return { type: "f5" };
  if (buf === "\x1b[17~") return { type: "f6" };
  if (buf === "\x1b[21~") return { type: "f10" };

  // Arrow keys
  if (buf === "\x1b[A") return { type: "up" };
  if (buf === "\x1b[B") return { type: "down" };
  if (buf === "\x1b[C") return { type: "right" };
  if (buf === "\x1b[D") return { type: "left" };

  // Page Up/Down, Home/End
  if (buf === "\x1b[5~") return { type: "pageup" };
  if (buf === "\x1b[6~") return { type: "pagedown" };
  if (buf === "\x1b[H" || buf === "\x1b[1~") return { type: "home" };
  if (buf === "\x1b[F" || buf === "\x1b[4~") return { type: "end" };

  // Escape
  if (buf === "\x1b") return { type: "escape" };

  // Single characters
  if (buf.length === 1) {
    const ch = buf.charCodeAt(0);
    if (ch === 3) return { type: "ctrl_c" };  // Ctrl+C
    if (ch === 9) return { type: "tab" };      // Tab
    if (ch === 13 || ch === 10) return { type: "enter" };
    if (ch === 127 || ch === 8) return { type: "backspace" };
    return { type: "char", char: buf };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Event dispatch
// ---------------------------------------------------------------------------

function columnAtX(x, hScroll, state) {
  const cols = state ? activeColumns(state) : SUMMARY_COLUMNS;
  const adjusted = x + (hScroll || 0);
  let pos = 1; // 1-based terminal columns
  for (const col of cols) {
    const w = col.flex ? 999 : col.width + 1; // +1 for space separator
    if (adjusted >= pos && adjusted < pos + w) return col.key;
    pos += w;
  }
  return null;
}

/** Given a 1-based column, return which tab index (0-2) was clicked, or -1. */
function tabAtX(col) {
  let pos = 4; // skip ╭─ + space (1-based)
  for (let i = 0; i < BOTTOM_TABS.length; i++) {
    if (i > 0) pos += 2; // 2-space gap between tabs
    const w = BOTTOM_TABS[i].length;
    if (col >= pos && col < pos + w) return i;
    pos += w;
  }
  return -1;
}

/** Copy text to system clipboard. Uses pbcopy on macOS, OSC 52 as fallback. */
function copyToClipboard(text) {
  if (process.platform === "darwin") {
    try {
      const { execSync } = require("child_process");
      execSync("pbcopy", { input: text, stdio: ["pipe", "ignore", "ignore"] });
      return;
    } catch {}
  }
  // OSC 52 fallback (works in many modern terminals)
  const b64 = Buffer.from(text).toString("base64");
  process.stdout.write(`\x1b]52;c;${b64}\x07`);
}

function handleEvent(event, state) {
  if (!event) return;

  // --- Search mode ---
  if (state.mode === "search") {
    if (event.type === "escape" || event.type === "enter") {
      state.mode = "list";
      state.dirty = true;
      return;
    }
    if (event.type === "backspace") {
      state.searchQuery = state.searchQuery.slice(0, -1);
      applySortAndFilter(state);
      state.dirty = true;
      return;
    }
    if (event.type === "char") {
      state.searchQuery += event.char;
      applySortAndFilter(state);
      state.dirty = true;
      return;
    }
    return;
  }

  // --- Help mode ---
  if (state.mode === "help") {
    state.mode = "list";
    state.dirty = true;
    return;
  }

  // --- Sort-by mode ---
  if (state.mode === "sortby") {
    const sortableColumns = activeColumns(state);
    const count = sortableColumns.length;
    if (event.type === "escape" || event.type === "f6") {
      state.mode = "list";
      state.dirty = true;
      return;
    }
    if (event.type === "up" || (event.type === "char" && event.char === "k")) {
      state.sortbyIdx = (state.sortbyIdx - 1 + count) % count;
      state.dirty = true;
      return;
    }
    if (event.type === "down" || (event.type === "char" && event.char === "j")) {
      state.sortbyIdx = (state.sortbyIdx + 1) % count;
      state.dirty = true;
      return;
    }
    if (event.type === "enter") {
      const col = sortableColumns[state.sortbyIdx];
      if (state.sortCol === col.key) {
        state.sortAsc = !state.sortAsc;
      } else {
        state.sortCol = col.key;
        state.sortAsc = true;
      }
      applySortAndFilter(state);
      state.mode = "list";
      state.dirty = true;
      return;
    }
    if (event.type === "ctrl_c" || event.type === "f10") { state.quit = true; return; }
    if (event.type === "char" && event.char === "q") { state.quit = true; return; }
    return;
  }

  // --- Detail mode ---
  if (state.mode === "detail") {
    if (event.type === "char" && event.char === "q") { state.mode = "list"; state.dirty = true; return; }
    if (event.type === "escape" || event.type === "left") { state.mode = "list"; state.dirty = true; return; }
    if (event.type === "ctrl_c" || event.type === "f10") { state.quit = true; return; }
    return;
  }

  // --- List mode ---
  const listLen = state.filtered.length;
  const bodyHeight = Math.max(1, (process.stdout.rows || 24) - (state.headerLines + 2));

  switch (event.type) {
    case "ctrl_c":
    case "f10":
      state.quit = true;
      return;

    case "char":
      switch (event.char) {
        case "q": state.quit = true; return;
        case "k": event.type = "up"; break;
        case "j": event.type = "down"; break;
        case "l": event.type = "enter"; break;
        case "/": state.mode = "search"; state.dirty = true; return;
        case "?": case "h": state.mode = "help"; state.dirty = true; return;
        case ">": openSortBy(state); return;
        case "<": openSortBy(state); return;
        case "r": state._needsRefresh = true; return;
        case "P": setSortColumn(state, "status"); return;
        case "M": setSortColumn(state, "mem"); return;
        case "T": setSortColumn(state, "cost"); return;
        case "1": state.bottomTab = 0; state.dirty = true; saveUiPrefs({ bottomTab: 0, listTab: state.listTab }); return;
        case "2": state.bottomTab = 1; state.dirty = true; saveUiPrefs({ bottomTab: 1, listTab: state.listTab }); return;
        case "3": state.bottomTab = 2; state.dirty = true; saveUiPrefs({ bottomTab: 2, listTab: state.listTab }); return;
        case "`": switchListTab(state); return;
        default: return;
      }
      break; // fall through for remapped keys (k->up, j->down, l->enter)

    case "tab":
      state.bottomTab = (state.bottomTab + 1) % BOTTOM_TABS.length;
      state.dirty = true;
      saveUiPrefs({ bottomTab: state.bottomTab, listTab: state.listTab });
      return;
    case "f1": state.mode = "help"; state.dirty = true; return;
    case "f3": state.mode = "search"; state.dirty = true; return;
    case "f5": state._needsRefresh = true; return;
    case "f6": openSortBy(state); return;
  }

  // Navigation
  switch (event.type) {
    case "up":
      if (state.selectedRow > 0) {
        state.selectedRow--;
        state.dirty = true;
      }
      return;
    case "down":
      if (state.selectedRow < listLen - 1) {
        state.selectedRow++;
        state.dirty = true;
      }
      return;
    case "pageup":
      state.selectedRow = Math.max(0, state.selectedRow - bodyHeight);
      state.dirty = true;
      return;
    case "pagedown":
      state.selectedRow = Math.min(listLen - 1, state.selectedRow + bodyHeight);
      state.dirty = true;
      return;
    case "home":
      state.selectedRow = 0;
      state.hScroll = 0;
      state.dirty = true;
      return;
    case "end":
      state.selectedRow = Math.max(0, listLen - 1);
      state.dirty = true;
      return;
    case "left":
      if (state.hScroll > 0) {
        state.hScroll = Math.max(0, state.hScroll - 4);
        state.dirty = true;
      }
      return;
    case "right": {
      state.hScroll += 4;
      state.dirty = true;
      return;
    }
    case "scroll_up":
      if (state.selectedRow > 0) { state.selectedRow--; state.dirty = true; }
      return;
    case "scroll_down":
      if (state.selectedRow < listLen - 1) { state.selectedRow++; state.dirty = true; }
      return;

    case "enter":
      if (listLen > 0 && state.filtered[state.selectedRow]) {
        state.detailSession = state.filtered[state.selectedRow];
        state.mode = "detail";
        state.dirty = true;
        // Data will be loaded asynchronously in the event loop
        state._needsDetailLoad = true;
      }
      return;

    case "click": {
      // Check if click is on the list tab bar
      if (state._listTabBarRow && event.row === state._listTabBarRow) {
        const ltIdx = listTabAtX(event.col);
        if (ltIdx >= 0 && ltIdx !== state.listTab) {
          state.listTab = ltIdx;
          state.selectedRow = 0;
          state.scrollOffset = 0;
          const cols = activeColumns(state);
          if (!cols.find((c) => c.key === state.sortCol)) {
            state.sortCol = "active";
            state.sortAsc = true;
          }
          applySortAndFilter(state);
          state.dirty = true;
          saveUiPrefs({ bottomTab: state.bottomTab, listTab: state.listTab });
          return;
        }
      }
      // Check if click is on the bottom tab bar (top border row or underline row)
      if (state._tabBarRow && (event.row === state._tabBarRow || event.row === state._tabBarRow + 1)) {
        const tabIdx = tabAtX(event.col);
        if (tabIdx >= 0) {
          state.bottomTab = tabIdx;
          state.dirty = true;
          saveUiPrefs({ bottomTab: state.bottomTab, listTab: state.listTab });
          return;
        }
      }
      // Check if click is on a copy icon (⧉) in the Info panel
      if (state.bottomTab === 0 && state._tabBarRow) {
        const selected = state.filtered[state.selectedRow];
        if (selected && selected._copyTargets) {
          for (const target of selected._copyTargets) {
            const screenRow = state._tabBarRow + 2 + target.line; // +2 for tab bar + rule
            if (event.row === screenRow && event.col >= 5 && event.col <= 10) {
              copyToClipboard(target.value);
              selected._copyFlash = target.field;
              selected._copyFlashTs = Date.now();
              state.dirty = true;
              return;
            }
          }
        }
      }
      const headerCount = (state.stats ? renderHeader(state.stats, process.stdout.columns || 100).length : 6);
      const colHeaderRow = headerCount + 2; // 1-based: header + boxTop + colHeader
      if (event.row === colHeaderRow) {
        // Click on column header → sort
        const colKey = columnAtX(event.col, state.hScroll, state);
        if (colKey) setSortColumn(state, colKey);
      } else if (event.row > colHeaderRow) {
        // Click on session row
        const rowIdx = state.scrollOffset + (event.row - colHeaderRow - 1);
        if (rowIdx >= 0 && rowIdx < listLen) {
          state.selectedRow = rowIdx;
          state.dirty = true;
        }
      }
      return;
    }

    case "hover": {
      // Track hover over bottom tab bar
      let newHover = -1;
      if (state._tabBarRow && (event.row === state._tabBarRow || event.row === state._tabBarRow + 1)) {
        const idx = tabAtX(event.col);
        if (idx >= 0) newHover = idx;
      }
      // Track hover over list tab bar
      let newListHover = -1;
      if (state._listTabBarRow && event.row === state._listTabBarRow) {
        const idx = listTabAtX(event.col);
        if (idx >= 0) newListHover = idx;
      }
      if (newHover !== state.hoverTab || newListHover !== state.hoverListTab) {
        state.hoverTab = newHover;
        state.hoverListTab = newListHover;
        state.dirty = true;
      }
      return;
    }
  }
}

function switchListTab(state) {
  state.listTab = (state.listTab + 1) % LIST_TABS.length;
  state.selectedRow = 0;
  state.scrollOffset = 0;
  // Reset sort if current column doesn't exist in the new tab
  const cols = activeColumns(state);
  if (!cols.find((c) => c.key === state.sortCol)) {
    state.sortCol = "active";
    state.sortAsc = true;
  }
  applySortAndFilter(state);
  state.dirty = true;
  saveUiPrefs({ bottomTab: state.bottomTab, listTab: state.listTab });
}

function openSortBy(state) {
  const cols = activeColumns(state);
  const idx = cols.findIndex((c) => c.key === state.sortCol);
  state.sortbyIdx = idx >= 0 ? idx : 0;
  state.mode = "sortby";
  state.dirty = true;
}

function setSortColumn(state, key) {
  if (state.sortCol === key) {
    state.sortAsc = !state.sortAsc;
  } else {
    state.sortCol = key;
    state.sortAsc = true;
  }
  applySortAndFilter(state);
  state.dirty = true;
}

// ---------------------------------------------------------------------------
// Non-interactive output (preserved for -l, -j, -s flags)
// ---------------------------------------------------------------------------

function formatSessionLine(index, session, label, width) {
  const now = new Date();
  const prefix = `${index}. `;
  const fixedWidth = prefix.length + 4 + 2 + 4 + 2 + 6 + 2 + 6 + 2 + 8 + 2;
  const remaining = Math.max(16, width - fixedWidth);

  const modelWidth = Math.min(22, Math.max(8, Math.floor(remaining / 3)));
  let labelWidth = Math.max(8, remaining - modelWidth - 2);
  if (labelWidth + modelWidth + 2 > remaining)
    labelWidth = Math.max(8, remaining - modelWidth - 2);

  const line =
    prefix +
    relativeAge(session.started_at, now).padStart(4) +
    "  " +
    relativeAge(session.last_active, now).padStart(4) +
    "  " +
    compactTokens(session.list_input_tokens).padStart(6) +
    "  " +
    compactTokens(session.list_output_tokens).padStart(6) +
    "  " +
    compactUsd(session.list_total_cost).padStart(8) +
    "  " +
    fitText(label, labelWidth) +
    "  " +
    fitText(session.model, modelWidth);

  return clipLine(line, width);
}

function renderGroupedLines(codexSessions, claudeSessions, codexPlan, claudePlan) {
  const width = displayWidth();
  let label = "cost";
  if (
    planMode(codexPlan, "codex") === "retail" &&
    planMode(claudePlan, "claude") === "retail"
  )
    label = "est";

  const lines = [];
  lines.push("Codex:");
  if (!codexSessions.length) {
    lines.push("  (none)");
  } else {
    lines.push(
      `    start  last     in    out      ${label.padStart(5)}  session                        model`
    );
    const labels = abbreviatePaths(codexSessions.map((s) => s.label_source));
    for (let i = 0; i < codexSessions.length; i++) {
      lines.push(formatSessionLine(i + 1, codexSessions[i], labels[i], width));
    }
  }
  lines.push("");
  lines.push("Claude:");
  if (!claudeSessions.length) {
    lines.push("  (none)");
  } else {
    lines.push(
      `    start  last     in    out      ${label.padStart(5)}  session                        model`
    );
    const labels = abbreviatePaths(claudeSessions.map((s) => s.label_source));
    for (let i = 0; i < claudeSessions.length; i++) {
      lines.push(formatSessionLine(
        codexSessions.length + i + 1,
        claudeSessions[i],
        labels[i],
        width
      ));
    }
  }
  return lines;
}

function printMetricsSummary(data) {
  const m = safeMetrics(data);
  if (m.tool_count === 0 && m.skill_count === 0 && m.web_fetch_count === 0 && m.web_search_count === 0 && m.mcp_tool_count === 0) return;
  console.log();
  console.log("Activity:");
  if (m.tool_count > 0) {
    const top = Object.entries(m.tools).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c]) => `${c}x${n}`).join(", ");
    console.log(`  Tools: ${m.tool_count} total (${top})`);
  }
  if (m.skill_count > 0) {
    const top = Object.entries(m.skills).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${c}x/${n}`).join(", ");
    console.log(`  Skills: ${m.skill_count} total (${top})`);
  }
  if (m.web_fetch_count > 0) console.log(`  Web fetches: ${m.web_fetch_count}`);
  if (m.web_search_count > 0) console.log(`  Web searches: ${m.web_search_count}`);
  if (m.mcp_tool_count > 0) console.log(`  MCP calls: ${m.mcp_tool_count} (${m.mcp_tools.slice(0, 5).join(", ")})`);
}

function printCodexCost(session, data, plan) {
  if (planIncludesProvider(plan, "codex")) {
    console.log(`Billable cost: Not Billed (plan: ${plan})`);
    console.log(`Retail-equivalent estimate: ${usd(data.costs.total)}`);
    console.log(
      `Retail breakdown: input ${usd(data.costs.input)} | cached input ${usd(data.costs.cached_input)} | output ${usd(data.costs.output)}`
    );
  } else {
    console.log(`Total cost: ${usd(data.costs.total)}`);
    console.log(
      `Cost breakdown: input ${usd(data.costs.input)} | cached input ${usd(data.costs.cached_input)} | output ${usd(data.costs.output)}`
    );
  }
  console.log();
  console.log(`Provider: Codex`);
  console.log(`Plan: ${plan}`);
  console.log(`Session: ${session.session_id || "unknown"}`);
  console.log(`Detected model: ${data.model || "unknown"}`);
  console.log(
    `Tokens: input (uncached) ${numberWithCommas(data.tokens.input)} | input (total) ${numberWithCommas(data.tokens.input_total)} | cached input ${numberWithCommas(data.tokens.cached_input)} | output ${numberWithCommas(data.tokens.output)} | reasoning output ${numberWithCommas(data.tokens.reasoning_output)} | total ${numberWithCommas(data.tokens.total)}`
  );
  console.log(
    `Rates (USD / 1M tokens): input ${usd(data.rates.input)} | cached input ${usd(data.rates.cached_input)} | output ${usd(data.rates.output)}`
  );
  printMetricsSummary(data);
}

function printClaudeCost(session, data, plan) {
  if (planIncludesProvider(plan, "claude")) {
    console.log(`Billable cost: Not Billed (plan: ${plan})`);
    console.log(`Retail-equivalent estimate: ${usd(data.costs.total)}`);
    console.log(
      `Retail breakdown: input ${usd(data.costs.input)} | cache write 5m ${usd(data.costs.cache_write_5m)} | cache write 1h ${usd(data.costs.cache_write_1h)} | cache read ${usd(data.costs.cache_read)} | output ${usd(data.costs.output)}`
    );
  } else {
    console.log(`Total cost: ${usd(data.costs.total)}`);
    console.log(
      `Cost breakdown: input ${usd(data.costs.input)} | cache write 5m ${usd(data.costs.cache_write_5m)} | cache write 1h ${usd(data.costs.cache_write_1h)} | cache read ${usd(data.costs.cache_read)} | output ${usd(data.costs.output)}`
    );
  }
  console.log();
  console.log(`Provider: Claude`);
  console.log(`Plan: ${plan}`);
  console.log(`Session: ${session.session_id || "unknown"}`);
  console.log(`Project: ${session.label_source || "unknown"}`);
  console.log(
    `Detected model${data.models.length > 1 ? "s" : ""}: ${data.models.join(", ")}`
  );
  console.log(
    `Tokens: input ${numberWithCommas(data.tokens.input)} | cache write 5m ${numberWithCommas(data.tokens.cache_write_5m)} | cache write 1h ${numberWithCommas(data.tokens.cache_write_1h)} | cache read ${numberWithCommas(data.tokens.cache_read)} | output ${numberWithCommas(data.tokens.output)} | total ${numberWithCommas(data.tokens.total)}`
  );
  console.log("Rates (USD / 1M tokens):");
  for (const model of data.models) {
    const pricing = resolveClaudePricing(model);
    console.log(
      `  ${model}: input ${usd(String(pricing.input_per_million))} | cache write 5m ${usd(String(pricing.cache_write_5m_per_million))} | cache write 1h ${usd(String(pricing.cache_write_1h_per_million))} | cache read ${usd(String(pricing.cache_read_per_million))} | output ${usd(String(pricing.output_per_million))}`
    );
  }
  printMetricsSummary(data);
}

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

function tuiStartup() {
  process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE + MOUSE_ON);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf-8");
}

function tuiShutdown() {
  process.stdout.write(MOUSE_OFF + CURSOR_SHOW + ALT_SCREEN_OFF);
  try { process.stdin.setRawMode(false); } catch { /* may already be closed */ }
  saveDiskCache();
}

// ---------------------------------------------------------------------------
// Session loading
// ---------------------------------------------------------------------------

async function loadSessions(state) {
  const [codexSessions, claudeSessions] = listAllSessions();
  applyCurrentDirectoryOverride(codexSessions);
  await annotateListCosts(codexSessions, state.codexPlan);
  await annotateListCosts(claudeSessions, state.claudePlan);
  state.sessions = [...codexSessions, ...claudeSessions];

  // Tier 2: collect OS process metrics periodically
  state._tier2Tick = (state._tier2Tick || 0) + 1;
  if (process.platform !== "win32" && state._tier2Tick >= TIER2_INTERVAL_TICKS) {
    state._tier2Tick = 0;
    try {
      state._processMetrics = await collectProcessMetrics(state.sessions);
    } catch { /* best effort */ }
  }
  // Attach process metrics to sessions
  for (const s of state.sessions) {
    const key = `${s.provider}:${s.session_id}`;
    const pm = state._processMetrics.get(key);
    s.process = pm || null;
  }

  // Extract last active tool for running sessions
  for (const s of state.sessions) {
    if (s.process) {
      s.list_last_tool = extractLastToolName(s);
    } else {
      s.list_last_tool = "";
    }
  }

  updateSessionRates(state.sessions);
  applySortAndFilter(state);
  state.stats = computeStats(state.sessions);
  updateOverviewHistory(state.stats);
  state.dirty = true;
}

// ---------------------------------------------------------------------------
// Plan selection helpers (for non-interactive and TUI modes)
// ---------------------------------------------------------------------------

function resolveProviderPlansFromArg(plan) {
  if (plan === "select") return null; // needs interactive selection
  return resolveProviderPlans(plan);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs();

  // Fetch LiteLLM pricing (best effort, uses 24h disk cache)
  await fetchLitellmPricing();

  // Non-interactive modes: -l, -j, -s
  if (args.listSessions || args.json || args.session !== null) {
    try {
      const plans = resolveProviderPlansFromArg(args.plan);
      if (!plans) {
        process.stderr.write("error: -p select requires interactive mode (no -l/-j/-s)\n");
        return 1;
      }
      const [codexPlan, claudePlan] = plans;
      const [codexSessions, claudeSessions] = listAllSessions();
      applyCurrentDirectoryOverride(codexSessions);
      await annotateListCosts(codexSessions, codexPlan);
      await annotateListCosts(claudeSessions, claudePlan);
      const allSessions = [...codexSessions, ...claudeSessions];

      if (args.listSessions) {
        for (const line of renderGroupedLines(codexSessions, claudeSessions, codexPlan, claudePlan))
          console.log(line);
        saveDiskCache();
        return 0;
      }

      if (args.json) {
        const jsonSessions = await Promise.all(allSessions.map(async (s) => {
          const data = await safeExtractSessionData(s);
          const m = safeMetrics(data);
          return {
            provider: s.provider,
            session_id: s.session_id,
            started_at: s.started_at,
            last_active: s.last_active,
            model: s.model,
            project: s.label_source,
            input_tokens: s.list_input_tokens ?? null,
            output_tokens: s.list_output_tokens ?? null,
            cost: s.list_total_cost ?? null,
            tool_count: m.tool_count,
            skill_count: m.skill_count,
            web_fetch_count: m.web_fetch_count,
            web_search_count: m.web_search_count,
            mcp_tool_count: m.mcp_tool_count,
          };
        }));
        console.log(JSON.stringify(jsonSessions, null, 2));
        saveDiskCache();
        return 0;
      }

      if (args.session !== null) {
        if (!allSessions.length) throw new SessionCostError("No sessions found.");
        if (args.session < 1 || args.session > allSessions.length)
          throw new SessionCostError(
            `Session index ${args.session} is out of range (1-${allSessions.length}).`
          );
        const selectedSession = allSessions[args.session - 1];
        if (!selectedSession.data_file)
          throw new SessionCostError("Selected session is missing a data file.");
        const selectedData = await safeExtractSessionData(selectedSession);
        if (!selectedData)
          throw new SessionCostError("Selected session could not be parsed.");
        if (selectedSession.provider === "codex") {
          printCodexCost(selectedSession, selectedData, codexPlan);
        } else {
          printClaudeCost(selectedSession, selectedData, claudePlan);
        }
        saveDiskCache();
        return 0;
      }
    } catch (err) {
      if (err instanceof SessionCostError) {
        process.stderr.write(`error: ${err.message}\n`);
        saveDiskCache();
        return 1;
      }
      throw err;
    }
    return 0;
  }

  // --- TUI mode ---
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("error: TUI requires a TTY. Use -l, -j, or -s flags.\n");
    return 1;
  }

  const state = createState();

  // Load persisted UI preferences
  const _savedPrefs = loadUiPrefs();
  if (typeof _savedPrefs.bottomTab === "number") state.bottomTab = _savedPrefs.bottomTab;
  if (typeof _savedPrefs.listTab === "number") state.listTab = _savedPrefs.listTab;

  // Resolve plans
  if (args.plan === "select") {
    // Default to retail for TUI mode (plan selection is for CLI mode)
    state.codexPlan = "retail";
    state.claudePlan = "retail";
  } else {
    const [cp, clp] = resolveProviderPlans(args.plan);
    state.codexPlan = cp;
    state.claudePlan = clp;
  }

  tuiStartup();

  // Clean shutdown on signals
  const cleanup = () => { tuiShutdown(); process.exit(0); };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Handle resize
  process.stdout.on("resize", () => { state.dirty = true; renderIfDirty(state); });

  // Initial load
  try {
    await loadSessions(state);
  } catch (err) {
    tuiShutdown();
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  }

  // Load panel data for the initially selected session
  const initSel = state.filtered[state.selectedRow];
  if (initSel) {
    state._panelSessionId = initSel.session_id;
    state.panelData = await safeExtractSessionData(initSel);
  }

  render(state);
  state.dirty = false;

  // Auto-refresh timer
  const delayMs = args.delay * 1000;
  const doRefresh = async () => {
    await loadSessions(state);
    // Re-load panel data for current selection
    state._panelSessionId = null;
    const panelSel = state.filtered[state.selectedRow];
    if (panelSel) {
      state._panelSessionId = panelSel.session_id;
      state.panelData = await safeExtractSessionData(panelSel);
    }
    if (state.dirty) {
      render(state);
      state.dirty = false;
    }
  };
  const refreshTimer = setInterval(() => {
    doRefresh().catch(() => {}); // best-effort, ignore errors
  }, delayMs);

  // Event loop
  const onData = async (buf) => {
    const event = parseInputSequence(buf);
    handleEvent(event, state);

    if (state.quit) {
      clearInterval(refreshTimer);
      tuiShutdown();
      process.exit(0);
    }

    // Load detail data if needed
    if (state._needsDetailLoad) {
      state._needsDetailLoad = false;
      state.detailData = await safeExtractSessionData(state.detailSession);
      state.dirty = true;
    }

    // Load panel data when selection changes
    const panelSel = state.filtered[state.selectedRow];
    if (panelSel && panelSel.session_id !== state._panelSessionId) {
      state._panelSessionId = panelSel.session_id;
      state.panelData = null; // show "Loading..." immediately
      render(state);
      state.dirty = false;
      state.panelData = await safeExtractSessionData(panelSel);
      state.dirty = true;
    }

    // Manual refresh (F5 / r key)
    if (state._needsRefresh) {
      state._needsRefresh = false;
      await doRefresh();
    }

    if (state.dirty) {
      render(state);
      state.dirty = false;
    }
  };

  process.stdin.on("data", onData);

  // Keep process alive
  await new Promise(() => {});
}

function renderIfDirty(state) {
  if (state.dirty) {
    render(state);
    state.dirty = false;
  }
}

main().then((code) => process.exit(code));
