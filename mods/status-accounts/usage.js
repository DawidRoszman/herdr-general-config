// Claude and Codex usage limits (5-hour and weekly) for the status bar (main.js).
// No herdr import: exec and fetch are passed in, so `node usage.test.mjs` checks it.
//
// Claude: Claude Code's own OAuth usage endpoint (what its /usage shows), read with the access
// token Claude Code keeps in the macOS keychain for that config dir. A GET that reports usage,
// it doesn't spend any. The token is never refreshed here (that would rotate Claude Code's
// refresh token under it): an expired one is reported until Claude Code refreshes it.
// Codex: the rate_limits Codex writes with every turn into ~/.codex/sessions/**/rollout-*.jsonl
// (what its /status shows): local, no token, as fresh as the last Codex turn on this Mac.

// The Claude usage endpoint answers 429 when asked more often (Claude Code asks it too).
export const REFRESH_MS = 5 * 60 * 1000;
// Every copy of the bar (one per window) reads one cache in shared state; one copy asks, the rest wait.
export const USAGE_SHARED_KEY = "status-accounts.usage";
// A copy that claimed a refresh and never finished (closed mid-request) holds it no longer than this.
const CLAIM_MS = 60 * 1000;

/** Whether this copy should ask now: nothing fresh, nobody else asking, and no 429 wait still running. */
export function shouldRefresh(entry, now) {
  if (!entry) return true;
  if (entry.claimedAt && now - entry.claimedAt < CLAIM_MS) return false;
  if (entry.retryAt && now < entry.retryAt) return false;
  return !entry.at || now - entry.at >= REFRESH_MS;
}

/** A 429's Retry-After (seconds or an HTTP date) as a time, or null. */
export function retryAtFrom(header, now) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return now + seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : date;
}
export const WARN_AT = 80;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

// The Claude accounts whose usage the bar shows: a profile name (T3's switch, else accounts.py's
// kind: work | personal) -> its Claude config dir, null for Claude Code's default (~/.claude).
// From the profiles (claudeAccountsOfProfiles); in a setup without profiles from config.json
// "claudeConfigDirs" beside this file (see config.example.json), else the default account alone.
export const DEFAULT_CLAUDE_ACCOUNTS = { default: null };

/** config.json's text (null: no file) as the accounts map. */
export function parseClaudeAccounts(text) {
  if (!text) return DEFAULT_CLAUDE_ACCOUNTS;
  let config;
  try { config = JSON.parse(text); } catch (error) { throw new Error(`config.json isn't JSON: ${error.message}`); }
  const dirs = config?.claudeConfigDirs;
  const isValid = dirs && typeof dirs === "object" && !Array.isArray(dirs) && Object.keys(dirs).length > 0
    && Object.values(dirs).every((dir) => dir === null || typeof dir === "string");
  if (!isValid) throw new Error('config.json needs "claudeConfigDirs": { "<context>": "<config dir>" or null }');
  return dirs;
}

/** The accounts map from profiles (t3-context's shared "context".profiles): each profile's Claude
 *  config dir. null when no profile declares a Claude account: config.json's map is used then. */
export function claudeAccountsOfProfiles(profiles) {
  const declared = Object.entries(profiles ?? {}).filter(([, profile]) => profile.accounts?.claude);
  return declared.length ? Object.fromEntries(declared.map(([name, profile]) => [name, profile.accounts.claude.configDir ?? null])) : null;
}

/** The account shown for a context: its own, else the only one there is; null when neither. */
export function claudeAccountFor(context, accounts) {
  if (context && Object.hasOwn(accounts, context)) return { name: context, configDir: accounts[context] };
  const names = Object.keys(accounts);
  return names.length === 1 ? { name: names[0], configDir: accounts[names[0]] } : null;
}

// Claude Code names its keychain item after the config dir: no suffix for the default, else the
// first 8 hex chars of sha256(absolute dir).
export const claudeTokenScript = (configDir) => `
dir=${configDir ? `"${configDir.replace(/^~/, "$HOME")}"` : ""}
service="Claude Code-credentials"
[ -n "$dir" ] && service="$service-$(printf %s "$dir" | shasum -a 256 | cut -c1-8)"
security find-generic-password -s "$service" -w
`;

// The last rate_limits line of each of the 5 most recently written Codex sessions of the past week.
export const CODEX_SCRIPT = `
find "$HOME/.codex/sessions" -name 'rollout-*.jsonl' -mtime -7 -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -5 |
while IFS= read -r f; do grep '"rate_limits":{' "$f" | tail -1; done
`;

const limit = (percent, resetsAt) => ({ percent, resetsAt });

/** The usage endpoint's body as { fiveHour, week }: percent 0..100, resetsAt ms. */
export function parseClaudeUsage(body) {
  const pick = (w) => (w && Number.isFinite(w.utilization) ? limit(w.utilization, Date.parse(w.resets_at) || null) : null);
  const out = { fiveHour: pick(body?.five_hour), week: pick(body?.seven_day) };
  if (!out.fiveHour && !out.week) throw new Error("the usage endpoint returned no 5-hour or weekly limit");
  return out;
}

/** The keychain item's JSON as the bits we need; never the refresh token. */
export function parseClaudeCredentials(text, now = Date.now()) {
  let oauth;
  try { oauth = JSON.parse(text).claudeAiOauth; } catch { throw new Error("Claude Code's keychain item isn't JSON"); }
  if (!oauth?.accessToken) throw new Error("no Claude Code sign-in in the keychain for this account");
  if (oauth.expiresAt && oauth.expiresAt <= now) {
    throw new Error("Claude Code's sign-in token expired; any Claude Code session on this account renews it");
  }
  return oauth.accessToken;
}

/** The newest of the session log lines (CODEX_SCRIPT's output) as { fiveHour, week, at }. */
export function parseCodexLogs(text, now = Date.now()) {
  let newest = null;
  for (const line of text.split("\n")) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // a line cut mid-write
    const limits = entry?.payload?.rate_limits;
    const at = Date.parse(entry?.timestamp);
    if (limits && at && (!newest || at > newest.at)) newest = { limits, at };
  }
  if (!newest) throw new Error("no Codex turn in ~/.codex/sessions this week");
  // By window length, not by name ("primary"/"secondary" say nothing about which is which).
  const windows = [newest.limits.primary, newest.limits.secondary].filter(Boolean);
  const find = (minutes) => {
    const w = windows.find((x) => x.window_minutes === minutes);
    if (!w || !Number.isFinite(w.used_percent)) return null;
    const resetsAt = w.resets_at ? w.resets_at * 1000 : null;
    // Reset since that turn: the logged figure is gone and nothing newer was logged here.
    return resetsAt && resetsAt <= now ? { ...limit(null, resetsAt), isReset: true } : limit(w.used_percent, resetsAt);
  };
  const out = { fiveHour: find(300), week: find(10080), at: newest.at };
  if (!out.fiveHour && !out.week) throw new Error("Codex's last turn logged no 5-hour or weekly limit");
  return out;
}

export async function fetchClaudeUsage(configDir, { exec, fetch }) {
  const r = await exec("sh", ["-c", claudeTokenScript(configDir)], { timeout: 10000 });
  if (r.code !== 0) throw new Error("no Claude Code sign-in in the keychain for this account");
  const token = parseClaudeCredentials(r.stdout);
  const res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" } });
  if (!res.ok) {
    const error = new Error(`the usage endpoint answered HTTP ${res.status}`);
    if (res.status === 429) error.retryAt = retryAtFrom(res.headers?.get?.("retry-after"), Date.now());
    throw error;
  }
  return { ...parseClaudeUsage(await res.json()), at: Date.now() };
}

export async function fetchCodexUsage({ exec }) {
  const r = await exec("sh", ["-c", CODEX_SCRIPT], { timeout: 10000 });
  return parseCodexLogs(r.stdout);
}

/** A limit's colour: muted, the warning yellow from WARN_AT, blocked at 100. */
export function usageColor(t, percent) {
  if (percent === null || percent === undefined) return t.dim;
  return percent >= 100 ? t.blocked : percent >= WARN_AT ? t.ansi3 : t.muted;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// "Tue 14:05", local time (no Intl in every mod runtime).
export function clock(ms) {
  const d = new Date(ms), two = (n) => String(n).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export const percentText = (w) => (w && w.percent !== null ? `${Math.round(w.percent)}%` : "—");

/** One limit's tooltip line: "5h 42%, resets Tue 14:00". */
export function windowLine(name, w) {
  if (!w) return `${name}: not reported`;
  if (w.isReset) return `${name}: reset at ${clock(w.resetsAt)}; no Codex turn here since`;
  return `${name}: ${percentText(w)} used${w.resetsAt ? `, resets ${clock(w.resetsAt)}` : ""}`;
}

export const asOf = (ms) => `as of ${clock(ms)}`;
