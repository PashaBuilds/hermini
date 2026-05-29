#!/usr/bin/env node
// scripts/refresh-signal.mjs
//
// Scans local Hermes cron output and writes the most useful recent signal to
// data/current-signal.json. Never crashes — always emits a valid JSON file.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUTPUT_PATH = path.join(PROJECT_ROOT, 'data', 'current-signal.json');
const FIXTURE_PATH = path.join(PROJECT_ROOT, 'data', 'cron-agent-signals.json');
const HERMES_OUTPUT_DIR = path.join(os.homedir(), '.hermes', 'cron', 'output');

const MAX_CANDIDATES = 200;
const MAX_RAW_EXCERPT = 800;
const MAX_SUMMARY = 220;

const SILENT_MARKER = /\[SILENT\]/i;
const BOILERPLATE_FAIL_RE = /^(cron (job )?failed|no output|stderr only)\.?$/i;

// Hermes cron .md files often have this shape:
//   # Cron Job: <name>
//   **Job ID:** ...
//   ## Prompt
//   ... (orchestrator prompt — skip)
//   ## Script Output
//   ... (machine-readable pre-run data — usually skip)
//   ## Response
//   ... (agent's actual output — this is the real signal)
const RESPONSE_HEADER_RE = /^#{1,6}\s*(response|output|report|result|final response)\b/im;
const SECTION_HEADER_RE = /^#{1,6}\s+/m;

const KIND_KEYWORDS = {
  'x-radar': [
    /\bx[- ]?radar\b/i,
    /\btwitter\b/i,
    /\bpashabuilds\b/i,
    /\btweet\b/i,
    /\bquote\s*tweet\b/i,
    /\breply\b/i,
    /\bviral\b/i,
    /\bhook\b/i,
  ],
  'ai-radar': [
    /\bai[- ]?radar\b/i,
    /\bclaude\b/i,
    /\bopenai\b/i,
    /\banthropic\b/i,
    /\bgrok\b/i,
    /\bmcp\b/i,
    /\binference\b/i,
    /\blocal model\b/i,
    /\bhermes (setup|agent|cron)\b/i,
    /\bagent\b/i,
  ],
  wiki: [
    /\bwiki\b/i,
    /\bpashapedia\b/i,
    /\bllm[- ]?wiki\b/i,
    /\bknowledge base\b/i,
    /\blint(er|ing)?\b/i,
  ],
  system: [
    /\bcron (failed|failure|error)\b/i,
    /\bauth (issue|failure|error)\b/i,
    /\bprovider (failure|error)\b/i,
    /\bscheduler (error|failure)\b/i,
    /\bsystem health\b/i,
    /\b(401|403|429|5\d\d)\b/,
    /\bsync_failed\b/i,
    /\bconnection refused\b/i,
    /\burlopen error\b/i,
    /\btraceback\b/i,
  ],
};

const PRIORITY_HIGH = [
  /\bdo this now\b/i,
  /\baction\b/i,
  /\burgent\b/i,
  /\bfırsat\b/i,
  /\bstrong signal\b/i,
  /\bhigh[- ]priority\b/i,
  /\bbreaking\b/i,
  /\bauth (failed|broken)\b/i,
  /\bdraft\b/i,
  /\bpost (now|asap)\b/i,
];

const PRIORITY_MEDIUM = [
  /\bidea\b/i,
  /\bopportunity\b/i,
  /\bdiscovery\b/i,
  /\bworkflow\b/i,
  /\bproject\b/i,
  /\bproduct\b/i,
  /\bangle\b/i,
];

function safeStringify(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function makeFallbackSignal(reason) {
  return {
    id: `fallback-${crypto.randomBytes(4).toString('hex')}`,
    title: 'All quiet, Pasha',
    summary: 'No strong signal right now.',
    source: 'Tiny Hermes',
    sourcePath: '',
    url: null,
    kind: 'generic',
    priority: 'low',
    timestamp: new Date().toISOString(),
    rawExcerpt: reason ? `(${reason})` : '',
  };
}

async function writeSignal(signal) {
  try {
    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, safeStringify(signal), 'utf8');
  } catch (err) {
    // last resort — try once more without throwing
    try {
      await fs.writeFile(OUTPUT_PATH, safeStringify(makeFallbackSignal('write-error')), 'utf8');
    } catch {
      /* swallow */
    }
  }
}

async function listMarkdownFiles(rootDir) {
  /** @type {{file: string, mtime: number}[]} */
  const found = [];
  /** @type {string[]} */
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          const stat = await fs.stat(full);
          found.push({ file: full, mtime: stat.mtimeMs });
        }
      } catch {
        // skip unreadable entries silently
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, MAX_CANDIDATES);
}

function stripFrontmatter(text) {
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      return text.slice(end + 4).replace(/^\s*\n/, '');
    }
  }
  return text;
}

function cleanInlineMarkdown(s) {
  return s.replace(/[*_`]+/g, '').trim();
}

function extractTitle(text, fallback) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let cleaned;
    if (trimmed.startsWith('#')) {
      cleaned = trimmed.replace(/^#+\s*/, '').trim();
    } else {
      cleaned = trimmed;
    }
    cleaned = cleanInlineMarkdown(cleaned);
    if (!cleaned) continue;
    // Strip trailing punctuation that reads as "more follows" (colon, dash).
    cleaned = cleaned.replace(/[:\-—]+\s*$/, '').trim();
    return cleaned.slice(0, 120);
  }
  return fallback;
}

function extractSummary(text, title) {
  const stripped = stripFrontmatter(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('---'));

  const normalizedTitle = title
    ? cleanInlineMarkdown(title.replace(/^#+\s*/, ''))
        .replace(/[:\-—]+\s*$/, '')
        .toLowerCase()
    : null;

  // Build candidate summary lines: skip the title and any heading lines, but
  // *do* allow bullets — their content makes for great summaries.
  const candidates = [];
  for (const line of stripped) {
    const isHeading = line.startsWith('#');
    if (isHeading) continue;
    const bare = cleanInlineMarkdown(line.replace(/^[-*•>]\s+/, ''));
    if (!bare) continue;
    if (normalizedTitle && bare.toLowerCase().replace(/[:\-—]+\s*$/, '') === normalizedTitle) {
      continue;
    }
    if (bare.length >= 24) {
      candidates.push(bare);
    }
  }

  const picked = candidates[0];
  if (picked) {
    return picked.length > MAX_SUMMARY ? picked.slice(0, MAX_SUMMARY - 1) + '…' : picked;
  }

  // Last resort: first non-empty non-title line.
  for (const line of stripped) {
    if (line.startsWith('#')) continue;
    const bare = cleanInlineMarkdown(line.replace(/^[-*•>]\s+/, ''));
    if (!bare) continue;
    if (normalizedTitle && bare.toLowerCase().replace(/[:\-—]+\s*$/, '') === normalizedTitle) {
      continue;
    }
    return bare.length > MAX_SUMMARY ? bare.slice(0, MAX_SUMMARY - 1) + '…' : bare;
  }
  return '';
}

function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s<>()"']+/i);
  return match ? match[0] : null;
}

function classifyKind(text, sourceHint) {
  const haystack = `${sourceHint}\n${text}`;
  const hint = sourceHint.toLowerCase();
  if (/\b(wiki|pashapedia|llm[- ]?wiki|knowledge base)\b/.test(hint)) return 'wiki';
  if (/c5555b494ae2/.test(hint)) return 'x-radar';
  if (/\b(x[- ]?radar|twitter|tweet)\b/.test(hint)) return 'x-radar';
  if (/\b(ai[- ]?scout|ai[- ]?radar|agent[- ]?radar)\b/.test(hint)) return 'ai-radar';
  if (/\b(github[- ]?tracker|system|scheduler|health|sync)\b/.test(hint)) return 'system';
  for (const [kind, patterns] of Object.entries(KIND_KEYWORDS)) {
    if (patterns.some((re) => re.test(haystack))) {
      return kind;
    }
  }
  return 'generic';
}

function classifyPriority(text, kind) {
  if (PRIORITY_HIGH.some((re) => re.test(text))) return 'high';
  if (kind === 'system') return 'high';
  if (PRIORITY_MEDIUM.some((re) => re.test(text))) return 'medium';
  return 'low';
}

// Extract just the agent-response section of a Hermes cron output file.
// Returns null if the file appears to be only prompt boilerplate, log header,
// or marked silent/empty.
function extractResponseBody(text) {
  const stripped = stripFrontmatter(text);

  // Silent-status markers used in Hermes cron logs.
  if (/\*\*status:\*\*\s*silent\b/i.test(stripped)) return null;
  if (/silent\s*\(empty output\)/i.test(stripped)) return null;
  if (/"action"\s*:\s*"silent"/i.test(stripped) && !RESPONSE_HEADER_RE.test(stripped)) {
    return null;
  }

  const match = stripped.match(RESPONSE_HEADER_RE);
  if (match) {
    const start = match.index + match[0].length;
    const after = stripped.slice(start);
    const nextHeader = after.search(/^#{1,6}\s+/m);
    const body = (nextHeader === -1 ? after : after.slice(0, nextHeader)).trim();
    return body;
  }

  // No explicit Response section. Reject anything that contains a Prompt block.
  if (/^#{1,6}\s*prompt\b/im.test(stripped)) return null;

  // Strip metadata bullets (lines like **Job ID:** ..., **Run Time:** ...) and
  // see if anything substantive remains.
  const lines = stripped.split(/\r?\n/);
  const meaningfulLines = lines.filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (/^\*\*[^*]+:\*\*/.test(t)) return false; // metadata bullet
    if (/^#{1,6}\s+cron\s+job:/i.test(t)) return false; // header
    return true;
  });
  const body = meaningfulLines.join('\n').trim();
  // Need at least one substantive sentence — short header-only files get dropped.
  if (body.length < 24) return null;
  return body;
}

function isMeaningfulResponse(body) {
  if (!body) return false;
  const trimmed = body.trim();
  if (!trimmed) return false;
  // pure [SILENT]
  if (/^\[SILENT\]$/i.test(trimmed)) return false;
  // strip silent markers and check what's left
  const withoutSilent = trimmed.replace(SILENT_MARKER, '').trim();
  if (!withoutSilent) return false;
  if (withoutSilent.length < 8) return false;
  const firstLine = withoutSilent.split(/\r?\n/)[0].trim();
  if (BOILERPLATE_FAIL_RE.test(firstLine) && withoutSilent.split(/\r?\n/).length === 1) {
    return false;
  }
  return true;
}

function fileJobName(filePath, fullText) {
  // Try to use the "# Cron Job: <name>" header for source labelling.
  const m = fullText.match(/^#\s*cron\s+job:\s*([^\n]+)/im);
  if (m) return m[1].trim().slice(0, 80);
  return path.basename(path.dirname(filePath));
}

function deriveSourceLabel(filePath) {
  // /Users/.../.hermes/cron/output/<jobId>/<file>.md
  const parts = filePath.split(path.sep);
  const outputIdx = parts.lastIndexOf('output');
  if (outputIdx !== -1 && parts.length > outputIdx + 1) {
    const jobId = parts[outputIdx + 1];
    return `hermes:${jobId.slice(0, 8)}`;
  }
  return 'hermes';
}

function shortenPath(filePath) {
  const home = os.homedir();
  if (filePath.startsWith(home)) {
    return '~' + filePath.slice(home.length);
  }
  return filePath;
}

function buildIdFor(filePath, text) {
  const hash = crypto.createHash('sha1').update(filePath + '\n' + text).digest('hex');
  return hash.slice(0, 12);
}

function fixturePriority(entry) {
  const priority = entry?.priority;
  if (priority === 'high' || priority === 'medium' || priority === 'low') return priority;
  if (entry?.status === 'warning') return 'high';
  if (entry?.status === 'fixed' || entry?.status === 'signal') return 'medium';
  return 'low';
}

function buildSignalFromFixture(kind, entry, generatedAt) {
  const timestamp = entry.lastRunAt || generatedAt || new Date().toISOString();
  const sourcePath = entry.sourcePath || '';
  const rawExcerpt = entry.rawExcerpt || entry.detail || entry.summary || '';
  return {
    id: buildIdFor(`${kind}:${entry.jobId || entry.cronJobName || sourcePath}`, JSON.stringify(entry)),
    title: entry.title || `${entry.label || kind} signal`,
    summary: entry.summary || entry.detail || 'Hermes yeni bir sinyal yakaladı.',
    bubble: entry.bubble || entry.summary || entry.title || entry.detail || '',
    source: entry.jobId ? `hermes:${entry.jobId.slice(0, 8)}` : entry.cronJobName || 'hermes',
    sourcePath,
    url: entry.sourceUrl || null,
    kind,
    priority: fixturePriority(entry),
    timestamp: new Date(timestamp).toISOString(),
    rawExcerpt,
    status: entry.status || 'signal',
    detail: entry.detail || '',
    recommendedAction: entry.recommendedAction || null,
    sourceHandle: entry.sourceHandle || null,
    score: typeof entry.score === 'number' ? entry.score : null,
    draft: entry.draft || null,
  };
}

function buildActivityFromFixture(kind, entry, generatedAt) {
  const timestamp = entry.lastRunAt || generatedAt || new Date().toISOString();
  return {
    jobName: publicActivityName(kind, entry.cronJobName || kind),
    source: entry.jobId ? `hermes:${entry.jobId.slice(0, 8)}` : entry.cronJobName || 'hermes',
    sourcePath: entry.sourcePath || '',
    kind,
    timestamp: new Date(timestamp).toISOString(),
  };
}

function pickPrimaryKindFromFixture(byKind) {
  const priorityRank = { high: 3, medium: 2, low: 1 };
  const statusRank = { signal: 4, warning: 3, fixed: 2, quiet: 1 };
  let picked = null;
  let pickedScore = -Infinity;
  let pickedTime = -Infinity;

  for (const kind of AGENT_KINDS) {
    const signal = byKind[kind];
    if (!signal) continue;
    const score =
      (priorityRank[signal.priority] ?? 0) * 1000 +
      (statusRank[signal.status] ?? 0) * 100 +
      (typeof signal.score === 'number' ? signal.score : 0);
    const time = new Date(signal.timestamp).getTime() || 0;
    if (score > pickedScore || (score === pickedScore && time > pickedTime)) {
      picked = kind;
      pickedScore = score;
      pickedTime = time;
    }
  }

  return picked;
}

async function pickSignalsFromFixture() {
  let raw;
  try {
    raw = await fs.readFile(FIXTURE_PATH, 'utf8');
  } catch {
    return null;
  }

  let fixture;
  try {
    fixture = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!fixture || typeof fixture !== 'object' || !fixture.signals) return null;

  const generatedAt = fixture.generatedAt || new Date().toISOString();
  const byKind = {};
  const activityByKind = {};
  let latestActivity = null;
  let latestTime = -Infinity;

  for (const kind of AGENT_KINDS) {
    const entry = fixture.signals[kind];
    if (!entry || typeof entry !== 'object') continue;
    byKind[kind] = buildSignalFromFixture(kind, entry, generatedAt);
    activityByKind[kind] = buildActivityFromFixture(kind, entry, generatedAt);
    const t = new Date(activityByKind[kind].timestamp).getTime() || 0;
    if (t > latestTime) {
      latestTime = t;
      latestActivity = activityByKind[kind];
    }
  }

  if (Object.keys(byKind).length === 0) return null;

  return {
    byKind,
    primaryKind: pickPrimaryKindFromFixture(byKind) ?? AGENT_KINDS.find((kind) => byKind[kind]),
    activityByKind,
    latestActivity,
  };
}

// Detect single-line log-junk bodies: `key=value error=<...>`, JSON dumps,
// pure tracebacks, errno-only lines. These are technically "meaningful"
// (non-silent, non-empty) but make for a terrible demo signal.
function isLowValueLogLine(body) {
  const trimmed = body.trim();
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());

  // Multi-line bodies are usually narrative enough.
  if (lines.length >= 3) return false;

  if (lines.length === 1) {
    const line = lines[0];
    // sync_failed key=value style
    if (/^[a-z_]+(_failed|_error|_warn|_warning)\s+\w+=/i.test(line)) return true;
    // bare errno wrapper
    if (/\[errno \d+\]/i.test(line) && line.length < 240) return true;
    // pure traceback head
    if (/^traceback\b/i.test(line)) return true;
    // JSON / dict dump only
    if (/^[\[{].*[\]}]\s*$/.test(line)) return true;
    // multiple `key=value` pairs and nothing else
    if (/^(\w+=\S+\s+){2,}\w+=\S+\s*$/.test(line)) return true;
    // very short single line (likely a header echo)
    if (line.length < 60) return true;
  }

  // Two short lines that look like an error + trace pair.
  if (lines.length === 2 && trimmed.length < 200) {
    if (/\berror\b|\bexception\b|\bfail/i.test(trimmed)) return true;
  }

  return false;
}

// Higher score = more narrative / demo-worthy content.
function narrativeScore(body) {
  const text = body.trim();
  if (!text) return 0;
  let score = 0;

  // sentence-ish endings followed by capital letter or end-of-text
  const sentenceHits = text.match(/[.!?…]([\s)\]"'`]+|$)/g);
  score += sentenceHits ? Math.min(sentenceHits.length, 12) : 0;

  // bullets
  const bullets = text.match(/^\s*[-*•]\s+\S/gm);
  if (bullets) score += Math.min(bullets.length, 6);

  // headings
  const headings = text.match(/^\s*#{1,6}\s+\S/gm);
  if (headings) score += Math.min(headings.length, 5) * 2;

  // paragraph breaks
  const paragraphs = text.match(/\n\s*\n/g);
  if (paragraphs) score += Math.min(paragraphs.length, 4) * 2;

  // length bonuses
  if (text.length > 200) score += 2;
  if (text.length > 500) score += 2;
  if (text.length > 1200) score += 2;

  // multi-line bonus
  const realLines = text.split(/\r?\n/).filter((l) => l.trim()).length;
  if (realLines >= 4) score += 2;
  if (realLines >= 10) score += 2;

  return score;
}

function buildSignal(file, mtime, body, raw) {
  const sourceHint = `${file}\n${fileJobName(file, raw)}`;
  const title = extractTitle(body, 'Pasha, yeni bir Hermes sinyali var');
  const summary = extractSummary(body, title) || 'Hermes bir şey yakaladı.';
  const url = extractUrl(body);
  const kind = classifyKind(body, sourceHint);
  const priority = classifyPriority(body, kind);
  const rawExcerpt = body.trim().slice(0, MAX_RAW_EXCERPT);

  return {
    id: buildIdFor(file, body),
    title,
    summary,
    bubble: summary,
    source: deriveSourceLabel(file),
    sourcePath: shortenPath(file),
    url,
    kind,
    priority,
    timestamp: new Date(mtime).toISOString(),
    rawExcerpt,
  };
}

function publicActivityName(kind, jobName) {
  if (kind === 'x-radar') return 'x-radar-tweet-scan';
  if (kind === 'ai-radar') return 'ai-radar-scout';
  if (kind === 'wiki') return 'pashapedia-health-check';
  if (kind === 'system') return 'system-daily-sync';
  return jobName;
}

function buildActivity(file, mtime, raw) {
  const jobName = fileJobName(file, raw);
  const sourceHint = `${file}\n${jobName}`;
  const kind = classifyKind(raw, sourceHint);
  return {
    jobName: publicActivityName(kind, jobName),
    source: deriveSourceLabel(file),
    sourcePath: shortenPath(file),
    kind,
    timestamp: new Date(mtime).toISOString(),
  };
}

const MIN_NARRATIVE_SCORE = 4;
const FRESH_LOG_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
// Stale alerts should not keep a mascot panicking forever. If a cron keeps
// running silently after an old high-signal report, the mascot should return to
// its calm "last job ran" state instead of surfacing a 2-day-old alarm.
const SIGNAL_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const FRESH_ACTIVITY_FOCUS_MS = 30 * 60 * 1000; // 30 minutes

// One dedicated mascot per kind. Each gets its own freshest meaningful signal.
const AGENT_KINDS = ['x-radar', 'ai-radar', 'wiki', 'system'];
const PRIORITY_RANK = { high: 3, medium: 2, low: 1 };

// Scan the cron output once and collect, for EACH kind, the best (highest
// narrative score, then newest) meaningful signal. Returns a per-kind map plus
// the primary kind to foreground by default.
async function pickSignalsByKind() {
  try {
    const stat = await fs.stat(HERMES_OUTPUT_DIR);
    if (!stat.isDirectory()) {
      return { byKind: {}, primaryKind: null, activityByKind: {}, latestActivity: null };
    }
  } catch {
    return { byKind: {}, primaryKind: null, activityByKind: {}, latestActivity: null };
  }

  let candidates;
  try {
    candidates = await listMarkdownFiles(HERMES_OUTPUT_DIR);
  } catch {
    return { byKind: {}, primaryKind: null, activityByKind: {}, latestActivity: null };
  }
  if (candidates.length === 0) {
    return { byKind: {}, primaryKind: null, activityByKind: {}, latestActivity: null };
  }

  const now = Date.now();
  /** @type {Record<string, any>} */
  const byKind = {};
  /** @type {Record<string, any>} */
  const activityByKind = {};
  let latestActivity = null;
  // Track each kind's best score so a stronger later candidate can replace a
  // weaker earlier one. (candidates are sorted newest-first.)
  const bestScore = {};
  /** @type {Record<string, {sig:any, score:number}>} */
  const borderlineByKind = {};

  for (const { file, mtime } of candidates) {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const activity = buildActivity(file, mtime, raw);
    if (!latestActivity) latestActivity = activity;
    if (AGENT_KINDS.includes(activity.kind) && !activityByKind[activity.kind]) {
      activityByKind[activity.kind] = activity;
    }

    const body = extractResponseBody(raw);
    if (!isMeaningfulResponse(body)) continue;

    const ageMs = now - mtime;
    if (ageMs > SIGNAL_STALE_MS) continue;
    if (isLowValueLogLine(body) && ageMs > FRESH_LOG_WINDOW_MS) continue;

    const sig = buildSignal(file, mtime, body, raw);
    const kind = sig.kind;
    if (!AGENT_KINDS.includes(kind)) continue; // generic etc. have no mascot

    const score = narrativeScore(body);
    if (score >= MIN_NARRATIVE_SCORE) {
      // Keep the newest qualifying per kind (first seen wins, since sorted).
      if (!byKind[kind]) {
        byKind[kind] = sig;
        bestScore[kind] = score;
      }
    } else if (!borderlineByKind[kind] || score > borderlineByKind[kind].score) {
      borderlineByKind[kind] = { sig, score };
    }
  }

  // Fill kinds with no qualifying signal from their best borderline candidate.
  for (const kind of AGENT_KINDS) {
    if (!byKind[kind] && borderlineByKind[kind]) {
      byKind[kind] = borderlineByKind[kind].sig;
    }
  }

  // Primary = highest priority, then newest timestamp.
  let primaryKind = null;
  let bestRank = -1;
  let bestTime = -1;
  for (const kind of AGENT_KINDS) {
    const s = byKind[kind];
    if (!s) continue;
    const rank = PRIORITY_RANK[s.priority] ?? 0;
    const t = new Date(s.timestamp).getTime() || 0;
    if (rank > bestRank || (rank === bestRank && t > bestTime)) {
      bestRank = rank;
      bestTime = t;
      primaryKind = kind;
    }
  }

  if (
    latestActivity &&
    AGENT_KINDS.includes(latestActivity.kind) &&
    now - (new Date(latestActivity.timestamp).getTime() || 0) <= FRESH_ACTIVITY_FOCUS_MS
  ) {
    primaryKind = latestActivity.kind;
  }

  return { byKind, primaryKind, activityByKind, latestActivity };
}

async function main() {
  let result;
  try {
    result = (await pickSignalsFromFixture()) ?? (await pickSignalsByKind());
  } catch {
    result = { byKind: {}, primaryKind: null, activityByKind: {}, latestActivity: null };
  }

  const { byKind, primaryKind, activityByKind, latestActivity } = result;
  const primary = primaryKind ? byKind[primaryKind] : makeFallbackSignal('all quiet');

  // schema 2: per-kind signals for the 4 mascots, plus the primary spread at
  // top level for backward compatibility with any single-signal reader.
  const out = {
    schema: 2,
    primaryKind: primaryKind ?? primary.kind,
    byKind: {
      'x-radar': byKind['x-radar'] ?? null,
      'ai-radar': byKind['ai-radar'] ?? null,
      wiki: byKind['wiki'] ?? null,
      system: byKind['system'] ?? null,
    },
    activityByKind: {
      'x-radar': activityByKind?.['x-radar'] ?? null,
      'ai-radar': activityByKind?.['ai-radar'] ?? null,
      wiki: activityByKind?.wiki ?? null,
      system: activityByKind?.system ?? null,
    },
    latestActivity: latestActivity ?? null,
    ...primary,
  };

  await writeSignal(out);
}

main().catch(async () => {
  await writeSignal(makeFallbackSignal('top-level failure'));
});
