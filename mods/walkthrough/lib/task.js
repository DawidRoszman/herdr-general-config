import { unwrap } from "./turns.js";
import { hash } from "./hash.js";

export const MAX_TASK_CHARS = 6000;
export const MAX_MESSAGE_CHARS = 2000;

export const MAX_MESSAGES = 20;

export const MAX_CONTEXT = 3;
export const MAX_CONTEXT_CHARS = 1500;

export const TASK_MODES = [
  { key: "auto", name: "Found", about: "The prompt, pull request description or commit message this change came with" },
  { key: "own", name: "Your own", about: "Write what the change should do, and it is matched against that" },
  { key: "off", name: "Off", about: "No task: the walkthrough only orders and explains" },
];

export function taskChoice(saved) {
  const mode = TASK_MODES.some((m) => m.key === saved?.mode) ? saved.mode : "auto";
  return { mode, text: typeof saved?.text === "string" ? saved.text.slice(0, MAX_TASK_CHARS) : "" };
}

export const projectSlug = (path) => String(path ?? "").replace(/[^A-Za-z0-9]/g, "-");

export function isNoise(text) {
  const t = String(text ?? "").trim();
  if (!t) return true;
  if (/^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr|task-notification|user-memory-input)>/.test(t)) return true;
  if (/^Caveat: The messages below were generated/i.test(t)) return true;
  if (/^\[Request interrupted by user/i.test(t)) return true;
  if (/^\/[\w:.-]+$/.test(t)) return true;
  return false;
}

export function clip(text, max) {
  const t = String(text ?? "").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((b) => b?.type === "tool_result")) return "";
  return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

export function parseTranscript(text, { top = null, since = 0 } = {}) {
  const out = [];
  const seen = new Set();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j?.type !== "user" || j.isSidechain || j.isMeta || j.isCompactSummary || j.isVisibleInTranscriptOnly) continue;

    if (j.origin?.kind && j.origin.kind !== "human") continue;
    const cwd = typeof j.cwd === "string" ? j.cwd : "";
    if (top && cwd !== top && !cwd.startsWith(`${top}/`)) continue;
    const at = Date.parse(j.timestamp ?? "") || 0;
    if (at < since) continue;
    const body = unwrap(contentText(j.message?.content).trim()).trim();
    if (isNoise(body)) continue;
    const id = j.uuid ?? `${at}\n${body}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ at, text: body, session: j.sessionId ?? null });
  }
  return out.sort((a, b) => a.at - b.at);
}

export function joinMessages(messages, max = MAX_TASK_CHARS) {
  const items = messages.map((m) => clip(m.text, MAX_MESSAGE_CHARS)).filter(Boolean);
  if (items.length <= 1) return items[0] ?? "";
  const block = (text, i) => `Message ${i + 1}:\n${text}`;
  const all = items.map(block).join("\n\n");
  if (all.length <= max && items.length <= MAX_MESSAGES) return all;
  const first = block(items[0], 0);
  const kept = [];
  let room = max - first.length - 60;
  for (let i = items.length - 1; i > 0 && kept.length < MAX_MESSAGES - 1; i--) {
    const b = block(items[i], i);
    if (b.length + 2 > room) break;
    kept.unshift(b);
    room -= b.length + 2;
  }
  const left = items.length - 1 - kept.length;
  return [first, left ? `(${left} message${left === 1 ? "" : "s"} in between left out)` : "", ...kept].filter(Boolean).join("\n\n");
}

export function cleanDescription(body) {
  return String(body ?? "")
    .replace(/<!--\s*walkthrough\s*-->[\s\S]*?(<!--\s*\/walkthrough\s*-->|$)/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const MERGE_SUBJECT = /^Merge (pull request #\d+ from \S+|(remote-tracking )?branch '[^']*'( of \S+)?( into \S+)?|branches .+|commit '[^']*'( into \S+)?|tag '[^']*'( into \S+)?)$/;

export function cleanCommitMessage(message) {
  let lines = String(message ?? "").replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (MERGE_SUBJECT.test(lines[0]?.trim() ?? "")) lines = lines.slice(1);
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length > 1 && /^[A-Za-z][\w-]*: .+/.test(lines[lines.length - 1]) && /^(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|change-id|reported-by|suggested-by|helped-by|cc|fixes|closes|refs|generated-by)$/i.test(lines[lines.length - 1].split(":")[0])) lines.pop();
  return lines.join("\n").trim();
}

export function resolveTask({ mode = "auto", own = "", source = null, turn = null, turns = [], pr = null, commit = null, prompts = null, since = "the last commit" } = {}) {
  if (mode === "off") return null;
  const task = (from, label, short, about, text, context = "") => {
    const t = clip(text, MAX_TASK_CHARS);
    return t ? { from, label, short, about, text: t, context } : null;
  };
  if (mode === "own") return task("own", "Your own words", "yours", "the reader's own description of what the change should do", own);
  switch (source?.kind) {
    case "turn": {
      const prompt = turn?.prompt ?? source.prompt ?? "";
      if (isNoise(prompt)) return null;

      const earlier = turn?.session
        ? turns.filter((t) => t.session === turn.session && t.id !== turn.id && t.started < turn.started && !isNoise(t.prompt)).sort((a, b) => a.started - b.started).slice(-MAX_CONTEXT)
        : [];
      const context = earlier.map((t) => clip(t.prompt, MAX_CONTEXT_CHARS)).join("\n\n");
      return task("turn", "The turn's prompt", "prompt", "the prompt the coding agent was answering while it made this change", prompt, context);
    }
    case "pr": {
      if (!pr) return null;
      const body = cleanDescription(pr.body);
      const text = [String(pr.title ?? "").trim(), body].filter(Boolean).join("\n\n");
      return task("pr", `The description of #${pr.number ?? source.number}`, "PR description", "the pull request's title and description", text);
    }
    case "prs": {
      const prs = source.prs ?? [];
      const text = prs.map((p) => [`${p.prefix ? `${p.prefix} ` : ""}#${p.number} ${String(p.title ?? "").trim()}`, cleanDescription(p.body)].filter(Boolean).join("\n\n")).join("\n\n");
      if (prs.length === 1) return task("pr", `The description of #${prs[0].number}`, "PR description", "the pull request's title and description", text);
      return task("pr", `The descriptions of ${prs.length} linked pull requests`, "PR descriptions", "the linked pull requests' titles and descriptions, one per repository", text);
    }
    case "commit":
      return task("commit", "The commit message", "commit message", "the commit's message", cleanCommitMessage(commit));
    case "uncommitted": case "staged": case "unstaged": case "branch": {
      const list = (prompts ?? []).filter((p) => !isNoise(p.text));
      if (!list.length) return null;
      const n = list.length;
      return task("prompts", `${n} prompt${n === 1 ? "" : "s"} sent to agents since ${since}`, `${n} prompt${n === 1 ? "" : "s"}`,
        `the prompts sent to coding agents in this repository while the change was made (since ${since}), oldest first`, joinMessages(list));
    }
    default:
      return null;
  }
}

export const taskKey = (task) => (task ? hash(`${task.from}\n${task.text}\n${task.context ?? ""}`) : "");

export const taskCacheKey = (task) => (!task ? "" : task.from === "prompts" ? "prompts" : taskKey(task));

export const jsonPath = (path) => JSON.stringify(String(path ?? "")).slice(1, -1);

export const TRANSCRIPTS = `root="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
[ -d "$root" ] || exit 0
for d in "$root/$0"*; do
  [ -d "$d" ] || continue
  for f in "$d"/*.jsonl; do
    [ -f "$f" ] || continue
    m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null) || continue
    [ "\${m:-0}" -ge "$1" ] 2>/dev/null || continue
    grep -h '"type":"user"' "$f" 2>/dev/null | grep -F -e "\\"cwd\\":\\"$2\\"" -e "\\"cwd\\":\\"$2/" | grep -v -e '"tool_result"' -e '"isSidechain":true' -e '"isMeta":true' | sed -e 's|"data":"[A-Za-z0-9+/=]*"|"data":""|g'
  done
done | tail -c 4000000
exit 0`;
