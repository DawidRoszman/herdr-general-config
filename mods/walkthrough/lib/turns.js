export function parseHook(text) {
  const s = String(text ?? "");
  let j = null;
  try { j = JSON.parse(s); } catch { j = null; }
  const get = (name) => {
    if (j && typeof j[name] === "string") return j[name];

    const m = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(s);
    if (!m) return null;
    try { return JSON.parse(`"${m[1].replace(/\\(u[0-9a-fA-F]{0,3})?$/, "")}"`); } catch { return m[1]; }
  };
  return { prompt: unwrap(get("prompt") ?? ""), session: get("session_id"), cwd: get("cwd"), event: get("hook_event_name") };
}

export const unwrap = (prompt) => /^<hc from="[^"]*">([\s\S]*?)(?:<\/hc>\s*)?$/.exec(prompt)?.[1] ?? prompt;

export function parseMeta(text) {
  const out = {};
  for (const line of String(text ?? "").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

const SHA = /^[0-9a-f]{40,64}$/;

export const RECORD = "\x1e", FILE = "\x1f";

const lines = (text) => (text == null ? [] : String(text).split("\n").filter(Boolean));

export function parseListing(out, folder) {
  const turns = [];
  for (const record of String(out ?? "").split(RECORD).slice(1)) {
    const nl = record.indexOf("\n");
    const id = (nl < 0 ? record : record.slice(0, nl)).trim();
    if (!/^\d+-\d+$/.test(id)) continue;
    const files = {};
    for (const part of (nl < 0 ? "" : record.slice(nl + 1)).split(FILE).slice(1)) {
      const at = part.indexOf("\n");
      files[at < 0 ? part : part.slice(0, at)] = at < 0 ? "" : part.slice(at + 1);
    }
    const start = parseMeta(files["start.meta"]), end = parseMeta(files["end.meta"]);
    if (!SHA.test(start.tree ?? "")) continue;
    const hook = parseHook(files["start.json"]);
    turns.push({
      id, dir: `${folder}/${id}`,
      started: Number(start.started) * 1000 || Number(id.split("-")[0]) * 1000,
      ended: SHA.test(end.tree ?? "") ? Number(end.ended) * 1000 || null : null,
      startTree: start.tree, endTree: SHA.test(end.tree ?? "") ? end.tree : null, frozen: end.interrupted === "1",
      startBig: lines(files["start.big"]), endBig: lines(files["end.big"]),
      session: start.session || hook.session || null, terminal: start.terminal || null, prompt: hook.prompt,
    });
  }
  return sortTurns(turns);
}

export const sortTurns = (turns) => [...turns].sort((a, b) => b.started - a.started || b.id.localeCompare(a.id));

export const HOOK_TIMEOUT = 30;
export const HOOK_WAIT = HOOK_TIMEOUT * 1000 + 15_000;

export const QUIET = HOOK_WAIT;
export const UNKNOWN = 12 * 3600_000;

export function resolveEnds(turns, { idleSince = () => undefined, now = Date.now() } = {}) {
  const sorted = sortTurns(turns);
  return sorted.map((t, i) => {
    if (t.endTree) return { ...t, endDir: t.dir, state: t.frozen ? "interrupted" : "done" };
    const next = sorted.slice(0, i).reverse().find((n) => (t.session && n.session === t.session) || (t.terminal && n.terminal === t.terminal));
    if (next) return { ...t, endTree: next.startTree, endDir: next.dir, endBig: next.startBig, ended: next.started, state: "interrupted" };
    const since = t.terminal ? idleSince(t.terminal) : undefined;
    const over = typeof since === "number" ? now - Math.max(since, t.started) > QUIET : since === undefined && now - t.started > UNKNOWN;
    return { ...t, endDir: null, endBig: null, state: over ? "stale" : "running" };
  });
}

export const isOpen = (t) => t.state === "running" || t.state === "stale";

export const autoWritable = (t) => Boolean(t) && !isOpen(t) && !t.frozen;

export function keepTurn(turns, shown, pinned, terminal = null) {
  const kept = pinned && shown ? turns.find((t) => t.id === shown.id) : null;
  return kept ? { turn: kept, pinned: true } : { turn: pickTurn(turns, terminal), pinned: false };
}

export function pickTurn(turns, terminal = null) {
  return (terminal && turns.find((t) => t.terminal === terminal)) || turns[0] || null;
}

export function lastFinished(turns, terminals = null) {
  const mine = terminals ? turns.filter((t) => terminals.includes(t.terminal)) : turns;
  return mine[0] && !isOpen(mine[0]) ? mine[0] : null;
}

export function firstLine(prompt, max = 80) {
  const line = String(prompt ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export const turnSource = (t) => ({
  kind: "turn", id: t.id, dir: t.dir, startTree: t.startTree, endTree: isOpen(t) ? null : t.endTree, endDir: t.endDir,
  startBig: t.startBig ?? [], endBig: isOpen(t) ? null : t.endBig ?? [], prompt: t.prompt,
});

export const LISTING = `cd "$0" 2>/dev/null || exit 0
for d in $(ls -1 | grep -E '^[0-9]+-[0-9]+$'); do
  printf '\\036%s\\n' "$d"
  for f in start.meta end.meta start.big end.big; do [ -f "$d/$f" ] && { printf '\\037%s\\n' "$f"; cat "$d/$f"; }; done
  [ -f "$d/start.json" ] && { printf '\\037start.json\\n'; head -c 65536 "$d/start.json"; }
done
exit 0`;

export function hookSettings(script, { compact = false } = {}) {
  const command = (event) => `sh "${script}" ${event}`;
  if (compact) {
    const line = (event) => `[{ "hooks": [{ "type": "command", "command": ${JSON.stringify(command(event))}, "timeout": ${HOOK_TIMEOUT} }] }]`;
    return `{\n  "hooks": {\n    "UserPromptSubmit": ${line("start")},\n    "Stop": ${line("stop")}\n  }\n}`;
  }
  const hook = (event) => [{ hooks: [{ type: "command", command: command(event), timeout: HOOK_TIMEOUT }] }];
  return JSON.stringify({ hooks: { UserPromptSubmit: hook("start"), Stop: hook("stop") } }, null, 2);
}
