export const REFRESH_MS = 5 * 60 * 1000;

export const USAGE_SHARED_KEY = "status-accounts.usage";

const CLAIM_MS = 60 * 1000;

export function shouldRefresh(entry, now) {
  if (!entry) return true;
  if (entry.claimedAt && now - entry.claimedAt < CLAIM_MS) return false;
  if (entry.retryAt && now < entry.retryAt) return false;
  return !entry.at || now - entry.at >= REFRESH_MS;
}

export function retryAtFrom(header, now) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return now + seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : date;
}
export const WARN_AT = 80;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export const DEFAULT_CLAUDE_ACCOUNTS = { default: null };

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

export function claudeAccountsOfProfiles(profiles) {
  const declared = Object.entries(profiles ?? {}).filter(([, profile]) => profile.accounts?.claude);
  return declared.length ? Object.fromEntries(declared.map(([name, profile]) => [name, profile.accounts.claude.configDir ?? null])) : null;
}

export function claudeAccountFor(context, accounts) {
  if (context && Object.hasOwn(accounts, context)) return { name: context, configDir: accounts[context] };
  const names = Object.keys(accounts);
  return names.length === 1 ? { name: names[0], configDir: accounts[names[0]] } : null;
}

export const CLAUDE_TOKEN_SCRIPT = `
case "$1" in
  "~") dir="$HOME" ;;
  "~/"*) dir="$HOME/\${1#~/}" ;;
  *) dir="$1" ;;
esac
if [ "$(uname -s)" != "Darwin" ]; then
  cred="\${dir:-$HOME/.claude}/.credentials.json"
  [ -r "$cred" ] && cat "$cred" && exit 0
  exit 44
fi
service="Claude Code-credentials"
if [ -n "$dir" ]; then
  hash=$(printf %s "$dir" | (command -v shasum >/dev/null && shasum -a 256 || sha256sum) | cut -c1-8)
  service="$service-$hash"
fi
security find-generic-password -s "$service" -w
`;
export const claudeTokenScript = () => CLAUDE_TOKEN_SCRIPT;

export const CODEX_SCRIPT = `
find "$HOME/.codex/sessions" -name 'rollout-*.jsonl' -mtime -7 -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -5 |
while IFS= read -r f; do grep '"rate_limits":{' "$f" | tail -1; done
`;

const limit = (percent, resetsAt) => ({ percent, resetsAt });

export function parseClaudeUsage(body) {
  const pick = (w) => (w && Number.isFinite(w.utilization) ? limit(w.utilization, Date.parse(w.resets_at) || null) : null);
  const out = { fiveHour: pick(body?.five_hour), week: pick(body?.seven_day) };
  if (!out.fiveHour && !out.week) throw new Error("the usage endpoint returned no 5-hour or weekly limit");
  return out;
}

export function parseClaudeCredentials(text, now = Date.now()) {
  let oauth;
  try { oauth = JSON.parse(text).claudeAiOauth; } catch { throw new Error("Claude Code's keychain item isn't JSON"); }
  if (!oauth?.accessToken) throw new Error("no Claude Code sign-in in the keychain for this account");
  if (oauth.expiresAt && oauth.expiresAt <= now) {
    throw new Error("Claude Code's sign-in token expired; any Claude Code session on this account renews it");
  }
  return oauth.accessToken;
}

export function parseCodexLogs(text, now = Date.now()) {
  let newest = null;
  for (const line of text.split("\n")) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const limits = entry?.payload?.rate_limits;
    const at = Date.parse(entry?.timestamp);
    if (limits && at && (!newest || at > newest.at)) newest = { limits, at };
  }
  if (!newest) throw new Error("no Codex turn in ~/.codex/sessions this week");

  const windows = [newest.limits.primary, newest.limits.secondary].filter(Boolean);
  const find = (minutes) => {
    const w = windows.find((x) => x.window_minutes === minutes);
    if (!w || !Number.isFinite(w.used_percent)) return null;
    const resetsAt = w.resets_at ? w.resets_at * 1000 : null;

    return resetsAt && resetsAt <= now ? { ...limit(null, resetsAt), isReset: true } : limit(w.used_percent, resetsAt);
  };
  const out = { fiveHour: find(300), week: find(10080), at: newest.at };
  if (!out.fiveHour && !out.week) throw new Error("Codex's last turn logged no 5-hour or weekly limit");
  return out;
}

export async function fetchClaudeUsage(configDir, { exec, fetch }) {
  const r = await exec("sh", ["-c", CLAUDE_TOKEN_SCRIPT, "sh", configDir ?? ""], { timeout: 10000 });
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

export function usageColor(t, percent) {
  if (percent === null || percent === undefined) return t.dim;
  return percent >= 100 ? t.blocked : percent >= WARN_AT ? t.ansi3 : t.muted;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function clock(ms) {
  const d = new Date(ms), two = (n) => String(n).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export const percentText = (w) => (w && w.percent !== null ? `${Math.round(w.percent)}%` : "—");

export function windowLine(name, w) {
  if (!w) return `${name}: not reported`;
  if (w.isReset) return `${name}: reset at ${clock(w.resetsAt)}; no Codex turn here since`;
  return `${name}: ${percentText(w)} used${w.resetsAt ? `, resets ${clock(w.resetsAt)}` : ""}`;
}

export const asOf = (ms) => `as of ${clock(ms)}`;
