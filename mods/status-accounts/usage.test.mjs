// node usage.test.mjs: Claude's usage endpoint and Codex's session logs, as limits.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTokenScript, parseClaudeAccounts, claudeAccountFor, claudeAccountsOfProfiles, DEFAULT_CLAUDE_ACCOUNTS, parseClaudeUsage, parseClaudeCredentials, parseCodexLogs, fetchClaudeUsage, fetchCodexUsage, usageColor, percentText, windowLine, shouldRefresh, retryAtFrom, REFRESH_MS } from "./usage.js";

const claude = parseClaudeUsage({
  five_hour: { utilization: 42.0, resets_at: "2026-11-10T11:10:00.719877+00:00" },
  seven_day: { utilization: 61.0, resets_at: "2026-11-13T11:00:00.719894+00:00" },
  seven_day_opus: null,
});
assert.deepEqual(claude.fiveHour, { percent: 42, resetsAt: Date.parse("2026-11-10T11:10:00.719Z") });
assert.equal(claude.week.percent, 61);
assert.throws(() => parseClaudeUsage({ five_hour: null }), /no 5-hour or weekly/);

const now = Date.parse("2026-11-10T10:00:00Z");
const creds = (o) => JSON.stringify({ claudeAiOauth: { accessToken: "sk-test", refreshToken: "rt", ...o } });
assert.equal(parseClaudeCredentials(creds({ expiresAt: now + 1000 }), now), "sk-test");
assert.throws(() => parseClaudeCredentials(creds({ expiresAt: now - 1 }), now), /expired/);
assert.throws(() => parseClaudeCredentials("nope"), /isn't JSON/);
assert.throws(() => parseClaudeCredentials("{}"), /no Claude Code sign-in/);

const line = (timestamp, primary, secondary) => JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", rate_limits: { primary, secondary } } });
const resets = (s) => Date.parse(s) / 1000;
const logs = [
  line("2026-11-10T09:20:39.040Z", { used_percent: 33, window_minutes: 300, resets_at: resets("2026-11-10T12:00:00Z") }, { used_percent: 73, window_minutes: 10080, resets_at: resets("2026-11-14T00:00:00Z") }),
  '{"timestamp":"2026-11-10T09:59', // cut mid-write
  line("2026-11-09T09:00:00.000Z", { used_percent: 90, window_minutes: 300, resets_at: resets("2026-11-09T12:00:00Z") }, null),
].join("\n");
const codex = parseCodexLogs(logs, now);
assert.equal(codex.at, Date.parse("2026-11-10T09:20:39.040Z"), "the newest turn wins, whatever file order");
assert.equal(codex.fiveHour.percent, 33);
assert.equal(codex.week.percent, 73);
const later = parseCodexLogs(logs, Date.parse("2026-11-10T13:00:00Z"));
assert.equal(later.fiveHour.isReset, true, "a window reset since the last turn has no figure");
assert.equal(percentText(later.fiveHour), "—");
assert.match(windowLine("5h", later.fiveHour), /no Codex turn here since/);
assert.throws(() => parseCodexLogs("", now), /no Codex turn/);
// Swapped windows still land by length.
const swapped = parseCodexLogs(line("2026-11-10T09:00:00Z", { used_percent: 5, window_minutes: 10080, resets_at: resets("2026-11-14T00:00:00Z") }, { used_percent: 9, window_minutes: 300, resets_at: resets("2026-11-10T12:00:00Z") }), now);
assert.deepEqual([swapped.fiveHour.percent, swapped.week.percent], [9, 5]);

const t = { dim: "dim", muted: "muted", ansi3: "warn", blocked: "blocked" };
assert.deepEqual([null, 10, 79.6, 80, 99, 100].map((p) => usageColor(t, p)), ["dim", "muted", "muted", "warn", "warn", "blocked"]);

// Fetching: the token goes only into the request header, and failures say why.
const seen = [];
const fakeFetch = async (url, options) => { seen.push({ url, options }); return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 1, resets_at: null }, seven_day: null }) }; };
const okExec = async () => ( { code: 0, stdout: creds({ expiresAt: Date.now() + 60000 }), stderr: "" });
const usage = await fetchClaudeUsage("~/.claude-alt", { exec: okExec, fetch: fakeFetch });
assert.equal(usage.fiveHour.percent, 1);
assert.equal(seen[0].options.headers.Authorization, "Bearer sk-test");
assert.ok(!JSON.stringify(usage).includes("sk-test"), "no token in what the bar keeps");
await assert.rejects(fetchClaudeUsage(null, { exec: async () => ({ code: 44, stdout: "", stderr: "" }), fetch: fakeFetch }), /no Claude Code sign-in/);
await assert.rejects(fetchClaudeUsage(null, { exec: okExec, fetch: async () => ({ ok: false, status: 429 }) }), /HTTP 429/);
assert.equal((await fetchCodexUsage({ exec: async () => ({ code: 0, stdout: logs }) })).week.percent, 73);

// The keychain item Claude Code uses per config dir: run the real script with a stand-in `security`.
const bin = mkdtempSync(join(tmpdir(), "usage-test-"));
writeFileSync(join(bin, "security"), '#!/bin/sh\necho "$3"\n', { mode: 0o755 });
// A temp home: the hash is of the absolute dir, "<home>/.claude-alt".
const home = join(bin, "home");
mkdirSync(home);
const service = (dir) => execFileSync("sh", ["-c", claudeTokenScript(dir)], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home } }).toString().trim();
const expected = createHash("sha256").update(`${home}/.claude-alt`).digest("hex").slice(0, 8);
assert.equal(service("~/.claude-alt"), `Claude Code-credentials-${expected}`);
assert.equal(service(`${home}/.claude-alt`), `Claude Code-credentials-${expected}`, "~ and the absolute dir are one item");
assert.equal(service(null), "Claude Code-credentials");
// Pinned: the first 8 hex chars of sha256("/home/someone/.claude-alt").
assert.equal(service("/home/someone/.claude-alt"), "Claude Code-credentials-7b2a66d8");

// config.json: context -> config dir; none means the default account alone.
assert.equal(parseClaudeAccounts(null), DEFAULT_CLAUDE_ACCOUNTS);
const accounts = parseClaudeAccounts('{"claudeConfigDirs":{"work":"~/.claude-alt","personal":null}}');
assert.deepEqual(claudeAccountFor("work", accounts), { name: "work", configDir: "~/.claude-alt" });
assert.deepEqual(claudeAccountFor("personal", accounts), { name: "personal", configDir: null });
assert.equal(claudeAccountFor("unknown", accounts), null, "two accounts and none for this context");
assert.equal(claudeAccountFor(undefined, accounts), null);
assert.deepEqual(claudeAccountFor("work", DEFAULT_CLAUDE_ACCOUNTS), { name: "default", configDir: null }, "one account serves every context");
assert.throws(() => parseClaudeAccounts("{"), /isn't JSON/);
assert.throws(() => parseClaudeAccounts("{}"), /needs "claudeConfigDirs"/);
assert.throws(() => parseClaudeAccounts('{"claudeConfigDirs":{"work":1}}'), /needs "claudeConfigDirs"/);

// Profiles: each one's Claude config dir; a profile without a Claude account has no usage to show.
const profiles = { work: { accounts: { claude: { configDir: "~/.claude-alt" } } }, personal: { accounts: { claude: { configDir: null } } }, client: { accounts: {} } };
assert.deepEqual(claudeAccountsOfProfiles(profiles), { work: "~/.claude-alt", personal: null });
assert.equal(claudeAccountFor("client", claudeAccountsOfProfiles(profiles)), null);
assert.equal(claudeAccountsOfProfiles({ client: { accounts: {} } }), null, "no Claude account declared: config.json's map");
assert.equal(claudeAccountsOfProfiles(undefined), null);

// One copy asks; the others wait for its answer, a 429's wait, or the refresh interval.
{
  const now = 10_000_000;
  assert.equal(shouldRefresh(undefined, now), true);
  assert.equal(shouldRefresh({ at: now - REFRESH_MS + 1000 }, now), false, "fresh enough");
  assert.equal(shouldRefresh({ at: now - REFRESH_MS }, now), true, "stale");
  assert.equal(shouldRefresh({ at: now - REFRESH_MS, claimedAt: now - 5000 }, now), false, "another copy is asking");
  assert.equal(shouldRefresh({ at: now - REFRESH_MS, claimedAt: now - 120_000 }, now), true, "a claim left by a closed copy expires");
  assert.equal(shouldRefresh({ at: now - REFRESH_MS, retryAt: now + 1000 }, now), false, "a 429 wait still runs");
  assert.equal(retryAtFrom("30", now), now + 30_000);
  assert.equal(retryAtFrom(null, now), null);
  assert.equal(retryAtFrom(new Date(now + 60_000).toUTCString(), now) >= now + 59_000, true);
  let thrown;
  try {
    await fetchClaudeUsage("/x", { exec: async () => ({ code: 0, stdout: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }) }),
      fetch: async () => ({ ok: false, status: 429, headers: { get: () => "120" } }) });
  } catch (error) { thrown = error; }
  assert.ok(thrown?.retryAt > Date.now() + 100_000, "a 429 carries its Retry-After");
}

console.log("usage.js ok");
