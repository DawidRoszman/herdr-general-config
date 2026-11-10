// Pure state of a chat: Claude Code's own transcript (~/.claude*/projects/<folder>/<session>.jsonl)
// folded into what the view draws, and the permission menu read off its terminal's screen.
// Checked by `node model.test.mjs`.

const OUTPUT_LIMIT = 6000; // characters of a tool's output kept for the view
const INPUT_LIMIT = 4000;

// Slash commands offered while typing (the TUI runs any; these are the common ones).
export const COMMANDS = [
  ["/model", "switch the model"], ["/compact", "summarize the conversation to free context"], ["/clear", "start over in this session"],
  ["/context", "what fills the context"], ["/cost", "tokens and cost so far"], ["/review", "review a pull request"],
  ["/init", "write a CLAUDE.md"], ["/memory", "edit memory files"], ["/permissions", "allow and deny rules"],
  ["/agents", "sub-agents"], ["/mcp", "MCP servers"], ["/effort", "how long Claude thinks"],
].map(([id, detail]) => ({ id, detail }));

export function emptyChat() {
  return {
    items: new Map(), // id -> item, in transcript order (Map keeps insertion order)
    model: null,
    mode: null, // Claude Code's permission mode as the transcript last noted it
    tokens: 0, // the context the last reply was made with (input and cached tokens)
    title: "",
  };
}

const trim = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`);
const asText = (value) => (typeof value === "string" ? value : JSON.stringify(value ?? ""));

function trimInput(input) {
  if (!input || typeof input !== "object") return { value: trim(asText(input), INPUT_LIMIT) };
  // A proposed plan is shown whole (its card), so it is not cut.
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === "string" && k !== "plan" ? trim(v, INPUT_LIMIT) : v]));
}

// One line saying what a tool call does: the command, the file, the pattern.
export function toolTitle(input) {
  for (const key of ["command", "file_path", "path", "notebook_path", "pattern", "url", "query", "description", "prompt"]) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return value.trim().split("\n")[0].slice(0, 200);
  }
  return "";
}

// A user entry's text as the person wrote it; slash commands and their output come wrapped in tags.
function userText(content) {
  if (typeof content === "string") return content;
  return (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

const images = (content, key) => (Array.isArray(content) ? content : [])
  .filter((b) => b.type === "image" && b.source?.data)
  .map((b, i) => ({ key: `${key}-${i}`, data: b.source.data, mediaType: b.source.media_type ?? "image/png" }));

const tag = (text, name) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();

// Folds transcript entries in. Sub-agents' own steps (isSidechain) and Claude Code's bookkeeping
// (meta entries, api records, summaries) are left out.
export function applyTranscript(chat, entries) {
  for (const e of entries) {
    // Claude Code notes its permission mode as it changes.
    if (e.type === "permission-mode" && e.permissionMode) chat.mode = e.permissionMode === "bypassPermissions" ? "bypass" : e.permissionMode;
    if (e.isSidechain || e.isMeta || !e.message) continue;
    const at = Date.parse(e.timestamp) / 1000 || 0;
    if (e.type === "assistant") {
      if (e.message.model && e.message.model !== "<synthetic>") chat.model = e.message.model;
      const usage = e.message.usage;
      if (usage) chat.tokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      (e.message.content ?? []).forEach((block, i) => {
        const id = `${e.uuid}-${i}`;
        if (block.type === "text" && block.text?.trim()) chat.items.set(`text-${id}`, { kind: "text", id: `text-${id}`, text: block.text, at });
        else if (block.type === "thinking") chat.items.set(`thinking-${id}`, { kind: "thinking", id: `thinking-${id}`, text: block.thinking ?? "", at });
        else if (block.type === "tool_use") applyToolUse(chat, block, at);
      });
    } else if (e.type === "user") {
      const content = e.message.content;
      const results = Array.isArray(content) ? content.filter((b) => b.type === "tool_result") : [];
      for (const result of results) applyToolResult(chat, result, at);
      if (results.length) continue;
      applyUserText(chat, e, userText(content), images(content, e.uuid), at);
    }
  }
  return chat;
}

// A message another agent sent with `hc send` comes wrapped in <hc from="...">; shown as its text.
const HC_WRAP = /^<hc\b[^>]*>([\s\S]*)<\/hc>\s*$/;

function applyUserText(chat, e, wrapped, pictures, at) {
  const text = wrapped.match(HC_WRAP)?.[1] ?? wrapped;
  const command = tag(text, "command-name");
  const output = tag(text, "local-command-stdout") ?? tag(text, "local-command-stderr");
  if (output !== undefined) {
    if (output) chat.items.set(`notice-${e.uuid}`, { kind: "notice", id: `notice-${e.uuid}`, text: output, at });
    return;
  }
  if (text.startsWith("[Request interrupted")) {
    chat.items.set(`turn-${e.uuid}`, { kind: "turn", id: `turn-${e.uuid}`, state: "interrupted", at });
    return;
  }
  if (text.startsWith("Caveat:") || tag(text, "system-reminder") !== undefined && !text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()) return;
  const shown = command ? [command, tag(text, "command-args")].filter(Boolean).join(" ") : text;
  if (!shown.trim() && !pictures.length) return;
  if (!chat.title && !command) chat.title = shown.split("\n")[0].slice(0, 80);
  chat.items.set(`user-${e.uuid}`, { kind: "user", id: `user-${e.uuid}`, text: shown, images: pictures, at });
}

function applyToolUse(chat, block, at) {
  if (block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {
    chat.items.delete("plan"); // the newest plan goes to the bottom
    chat.items.set("plan", { kind: "plan", id: "plan", entries: block.input.todos.map((t) => ({ text: t.content, status: t.status })), at });
  }
  chat.items.set(`tool-${block.id}`, { kind: "tool", id: `tool-${block.id}`, name: block.name, title: toolTitle(block.input), input: trimInput(block.input), status: "running", at });
}

function applyToolResult(chat, result, at) {
  const item = chat.items.get(`tool-${result.tool_use_id}`);
  if (!item) return;
  const content = Array.isArray(result.content) ? result.content : [{ type: "text", text: asText(result.content) }];
  const output = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  chat.items.set(item.id, { ...item, status: result.is_error ? "error" : "done", endedAt: at, output: trim(output, OUTPUT_LIMIT), images: images(content, result.tool_use_id) });
}

// What the list shows: empty thinking (Claude Code keeps only its signature) left out.
export function visibleItems(chat) {
  return [...chat.items.values()].filter((item) => !(item.kind === "thinking" && !item.text?.trim()));
}

// Lines of a transcript chunk read from a byte offset: whole lines only, and how many bytes they
// took (the rest is a line still being written). byteLength: the host's UTF-8 length.
export function transcriptLines(chunk, byteLength) {
  const end = chunk.lastIndexOf("\n") + 1;
  const whole = chunk.slice(0, end);
  const entries = [];
  for (const line of whole.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a line Claude Code never finished: skipped */ }
  }
  return { entries, bytes: byteLength(whole) };
}

// The chat's state from its terminal's agent status (null: no live terminal).
export function chatState(status) {
  if (!status) return "stopped";
  return { working: "working", blocked: "waiting", done: "idle", idle: "idle" }[status] ?? "starting";
}

// Claude Code's menu at the bottom of its screen (a permission, a question, a plan, trusting a
// folder): { question, options: [{ key, label, keys }] }, or null when there is none. key: what the
// person presses in the chat; keys: what the terminal gets. Numbered options are their digit; an
// unnumbered chooser (❯ marks the choice) is moved to the option and confirmed with Enter.
const OPTION = /^[\s│|]*(?:❯|>)?\s*(\d+)\.\s+(.+?)[\s│|]*$/;
const CHOOSER = /^[\s│|]*❯\s+\S/;
const clean = (l) => l.replace(/^[\s│|╭╰─]+|[\s│|╮╯─]+$/g, "");
// What stands over the options: the question (what follows the last rule line above them, as
// one line) and its detail (the preview before that rule: a diff, a command), as the screen has it.
// Without a rule, the last lines are the question.
const RULE = /^[\s│|]*[╌─━]{6,}[\s│|]*$/;
function asked(lines, end) {
  const from = Math.max(0, end - 40);
  const rule = lines.slice(from, end).findLastIndex((l) => RULE.test(l));
  if (rule < 0) return { question: lines.slice(Math.max(0, end - 14), end).map(clean).filter(Boolean).join("\n"), detail: "" };
  const above = lines.slice(from, from + rule);
  const start = above.findLastIndex((l) => RULE.test(l)) + 1;
  return {
    question: lines.slice(from + rule + 1, end).map(clean).filter(Boolean).join(" "),
    detail: unwrapped(above.slice(start).map((l) => l.trimEnd())).join("\n").replace(/^\n+|\n+$/g, ""),
  };
}

// Lines a narrow terminal cut at its width, joined again: a line as wide as the widest is taken
// to go on in the next (less its indent and repeated diff mark). Claude Code's hidden pane can
// be a few dozen columns wide.
export function unwrapped(lines) {
  const width = Math.max(0, ...lines.map((l) => l.length));
  const out = [];
  let isCut = false;
  for (const line of lines) {
    // A numbered line (a diff preview's) always starts anew.
    if (isCut && out.length && !/^\s*\d+\s/.test(line)) out[out.length - 1] += line.replace(/^\s*[+-]?/, "");
    else out.push(line);
    isCut = width > 20 && line.length >= width;
  }
  return out;
}

// A numbered menu. A long option wraps onto lines of its own under it: they belong to its label.
const WRAPS = 16; // lines an option may wrap onto (a long path on a narrow terminal)
const isMore = (line) => /^\s{4,}\S/.test(line) && !OPTION.test(line) && !/^\s*(Esc|Enter) to /.test(line);
// Claude Code's input box (❯ over a rule line) is on screen: it asks nothing. A menu takes the
// box's place, so what looks like options above it is the conversation (a numbered list in a
// reply, an echoed message).
const hasPromptBox = (lines) => lines.some((line, i) => /^\s*❯/.test(line) && RULE.test(lines[i + 1] ?? ""));

export function screenMenu(screen) {
  const lines = screen.split("\n");
  if (hasPromptBox(lines.filter((line) => line.trim()))) return null;
  const last = lines.findLastIndex((l) => OPTION.test(l));
  if (last < 0) return chooserMenu(lines);
  // Up to option 1 (or as far as options and their wrapped lines reach).
  let first = last;
  while (lines[first].match(OPTION)[1] !== "1") {
    let up = first - 1;
    while (up >= 0 && first - up <= WRAPS && isMore(lines[up])) up -= 1;
    if (up < 0 || !OPTION.test(lines[up])) break;
    first = up;
  }
  let end = last + 1;
  while (end < lines.length && end - last <= WRAPS && isMore(lines[end])) end += 1;
  const options = [];
  for (const line of lines.slice(first, end)) {
    const m = line.match(OPTION);
    if (m) options.push({ key: m[1], label: m[2], keys: [m[1]] });
    else options[options.length - 1].label += ` ${line.trim()}`;
  }
  return { ...asked(lines, first), options };
}

// The chooser's options: the lines touching the ❯ line (a blank line ends them on each side).
// One line alone is the input prompt (❯ Try "..."), not a choice.
function chooserMenu(lines) {
  const chosen = lines.findLastIndex((l) => CHOOSER.test(l));
  if (chosen < 0) return null;
  let first = chosen;
  while (first > 0 && clean(lines[first - 1])) first -= 1;
  let last = chosen;
  while (last < lines.length - 1 && clean(lines[last + 1])) last += 1;
  if (last === first) return null;
  const options = lines.slice(first, last + 1).map((l, i) => ({
    key: String(i + 1),
    label: clean(l).replace(/^❯\s*/, ""),
    keys: [...Array(Math.abs(i - (chosen - first))).fill(i > chosen - first ? "down" : "up"), "enter"],
  }));
  return { ...asked(lines, first), options };
}

// A row's height, estimated from its text: the conversation is a virtual list (the only list that
// can be scrolled from code), which needs every row's height up front. Generous rather than exact:
// a short slot clips a row, a long one leaves a little air. width: the row's text width in px.
const LINE = 20;
const CHAR = 6.6; // average glyph width at 13px
export function estimateRowHeight(row, { isOpen = false, width = 920 } = {}) {
  const pad = 10; // the frame's bottom padding
  switch (row.kind) {
    case "user": {
      const bubble = Math.min(640, width) - 24;
      return markdownHeight(row.text ?? "", bubble) + 16 + (row.images?.length ?? 0) * 190 + pad;
    }
    case "text": return markdownHeight(row.text ?? "", width) + htmlBlocks(row.text).reduce((sum, b) => sum + markdownHeight(b, width) + 70, 0) + pad;
    case "thinking": return 22 + (isOpen ? markdownHeight(row.text ?? "", width - 16) + 8 : 0) + pad;
    case "tool": return 28 + (isOpen ? markdownHeight(toolDetail(row), width - 20) + 24 + (row.images?.length ?? 0) * 190 : 0) + pad;
    case "plan": return 36 + (row.entries?.length ?? 0) * 22 + pad;
    case "notice": return markdownHeight(row.text ?? "", width - 20) + 8 + pad;
    case "turn": return 22 + pad;
    default: return 20 + pad;
  }
}

export function markdownHeight(text, width) {
  const columns = Math.max(20, Math.floor(width / CHAR));
  let height = 12;
  let isCode = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) { isCode = !isCode; height += 14; continue; }
    if (isCode) { height += 18 * Math.max(1, Math.ceil(line.length / (columns * 1.1))); continue; }
    if (!line.trim()) { height += 10; continue; }
    if (/^#{1,6}\s/.test(line)) { height += 32; continue; }
    if (/^\s*\|/.test(line)) { height += /^\s*\|?\s*:?-{2,}/.test(line) ? 0 : 40; continue; }
    height += LINE * Math.max(1, Math.ceil(line.length / columns)) + 2;
  }
  return Math.ceil(height * 1.12);
}

// What the person wrote, as markdown that shows it as typed: tags escaped, single line breaks kept.
export function typedMarkdown(text) {
  return (text ?? "").replace(/</g, "\\<").replace(/\n/g, "  \n");
}

// ```html fences in a reply, drawn as a rendered preview under the text.
export function htmlBlocks(text) {
  return [...(text ?? "").matchAll(/```html\s*\n([\s\S]*?)```/g)].map((m) => m[1].trim()).filter(Boolean);
}

export function stateLabel(state) {
  return { starting: "Starting…", idle: "Ready", working: "Working…", waiting: "Needs you", stopped: "Stopped" }[state] ?? state;
}

// The tool call's input as a fenced block, leaving out what the title already says.
export function toolDetail(item) {
  const input = Object.fromEntries(Object.entries(item.input ?? {}).filter(([, v]) => v !== item.title));
  const parts = [];
  if (Object.keys(input).length) parts.push("```json\n" + JSON.stringify(input, null, 2) + "\n```");
  if (item.output) parts.push("```text\n" + item.output + "\n```");
  return parts.join("\n\n") || "_No output._";
}

const SUGGESTIONS = 8;

// "/rev" -> the slash commands starting with it.
export function commandMatches(commands, text) {
  if (!text.startsWith("/") || text.includes(" ")) return [];
  return commands.filter((c) => c.id.startsWith(text)).slice(0, SUGGESTIONS);
}

// "@mod/ch" -> the files matching it best: a name starting with it, then containing it, then the path containing it,
// then the letters in order (fuzzy). Shorter paths first within a rank.
export function fileMatches(files, query) {
  const q = query.toLowerCase();
  const rank = (path) => {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    if (!q) return 3;
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    if (lower.includes(q)) return 2;
    let at = 0;
    for (const ch of lower) if (ch === q[at] && ++at === q.length) return 3;
    return -1;
  };
  return files.map((path) => ({ path, rank: rank(path) })).filter((f) => f.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length).slice(0, SUGGESTIONS).map((f) => f.path);
}

// What to offer for the draft: its slash command when it is one, else files for an @word being typed at the end.
// Each item: { insert (replaces the token), label, detail }.
export function suggestionsFor(draft, commands, files) {
  const trimmed = draft.trim();
  if (trimmed.startsWith("/") && !trimmed.includes("\n")) {
    return { token: draft, items: commandMatches(commands, trimmed).map((c) => ({ insert: `${c.id} `, label: c.id, detail: c.detail ?? "" })) };
  }
  const at = draft.match(/(?:^|\s)(@[^\s@]*)$/);
  if (!at) return { token: "", items: [] };
  const query = at[1].slice(1);
  return { token: at[1], items: fileMatches(files, query).map((path) => ({ insert: `@${path} `, label: path.slice(path.lastIndexOf("/") + 1), detail: path })) };
}

// The draft with its last token replaced by the chosen suggestion.
export function accepted(draft, token, insert) {
  return draft.slice(0, draft.length - token.length) + insert;
}

// The tab name for a chat titled so (its first message).
export function chatTabName(title) {
  return `Chat: ${(title || "new").slice(0, 24)}`;
}

// The conversation as T3's timeline lays it out (MessagesTimeline): the person's messages, the
// reply's text, and between them the work (tool calls and thinking) folded into one group per run
// of work, "Worked for 51s". After a finished turn's last text comes its meta row (how long it
// took, copy). The todo list is not part of the timeline. isWorking: Claude's turn is running, so
// the last group is live and the turn has no meta yet.
export function timeline(chat, { isWorking = false } = {}) {
  const out = [];
  let group = null;
  let texts = [];
  let turnStart = 0;
  let lastAt = 0;
  let edits = []; // the turn's file-changing tool calls
  const closeGroup = () => {
    if (!group) return;
    out.push({ ...group, endedAt: lastAt });
    group = null;
  };
  const closeTurn = () => {
    const files = changedFiles(edits);
    if (texts.length && files.length) out.push({ kind: "changed", id: `changed-${texts[0].id}`, files });
    edits = [];
    if (texts.length) out.push({ kind: "meta", id: `meta-${texts[0].id}`, text: texts.map((t) => t.text).join("\n\n"), startedAt: turnStart || texts[0].at, endedAt: lastAt });
    texts = [];
  };
  for (const item of visibleItems(chat)) {
    if (item.kind === "plan" || (item.kind === "tool" && item.name === "TodoWrite")) continue;
    // A plan Claude proposes (ExitPlanMode) is a card of its own, as T3's ProposedPlanCard.
    if (item.kind === "tool" && item.name === "ExitPlanMode" && typeof item.input?.plan === "string") {
      closeGroup();
      out.push({ kind: "proposed-plan", id: `plan-${item.id}`, text: item.input.plan });
      continue;
    }
    if (item.kind === "tool" || item.kind === "thinking") {
      group ??= { kind: "work", id: `work-${item.id}`, entries: [], startedAt: item.at, turnStartedAt: turnStart || item.at, isLive: false };
      group.entries.push(item);
      if (item.kind === "tool" && item.status !== "error" && editDiff(item)) edits.push(item);
      lastAt = Math.max(lastAt, item.endedAt ?? item.at);
      continue;
    }
    if (item.kind === "user") {
      closeGroup();
      closeTurn();
      turnStart = item.at;
    } else {
      closeGroup();
      lastAt = Math.max(lastAt, item.at);
      if (item.kind === "text") texts.push(item);
    }
    out.push(item);
  }
  if (group) group.isLive = isWorking;
  closeGroup();
  if (!isWorking) closeTurn();
  return out;
}

// T3's working timer: seconds under a minute, then minutes and seconds, then hours and minutes.
export function formatElapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// A work entry's line: an icon, what was done, and to what.
const basename = (path) => path.slice(path.lastIndexOf("/") + 1);
export function entryLabel(item) {
  if (item.kind === "thinking") return { icon: "lightbulb", heading: "Thought", detail: item.text.trim().split("\n")[0] };
  const input = item.input ?? {};
  const file = input.file_path ?? input.path ?? input.notebook_path ?? "";
  switch (item.name) {
    case "Bash": return { icon: "terminal", heading: "Ran", detail: item.title };
    case "Read": return { icon: "file-text", heading: "Read", detail: basename(file) };
    case "Write": return { icon: "square-pen", heading: "Wrote", detail: basename(file) };
    case "Edit": case "MultiEdit": case "NotebookEdit": return { icon: "square-pen", heading: "Edited", detail: basename(file) };
    case "Grep": case "Glob": return { icon: "search", heading: "Searched", detail: input.pattern ?? item.title };
    case "WebFetch": return { icon: "globe", heading: "Fetched", detail: input.url ?? item.title };
    case "WebSearch": return { icon: "globe", heading: "Searched the web", detail: input.query ?? item.title };
    case "Task": case "Agent": return { icon: "bot", heading: "Agent", detail: input.description ?? item.title };
    default: return { icon: "wrench", heading: item.name.replace(/^mcp__/, "").replace(/__/g, " · "), detail: item.title };
  }
}

// The lines of old and new as a unified diff: [{ type: " " | "+" | "-", text }], by longest common
// subsequence. ponytail: O(lines²) time and memory; past LIMIT lines a side, everything old is
// removed and everything new added. Use Myers' diff if big edits need real diffs.
const DIFF_LIMIT = 600;
export function lineDiff(oldText, newText) {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const mark = (type, lines) => lines.map((text) => ({ type, text }));
  if (a.length > DIFF_LIMIT || b.length > DIFF_LIMIT) return [...mark("-", a), ...mark("+", b)];
  // common[i][j]: the longest common subsequence of a[i..] and b[j..].
  const common = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) {
    common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ type: " ", text: a[i] }); i += 1; j += 1; }
    else if (i < a.length && (j >= b.length || common[i + 1][j] >= common[i][j + 1])) { out.push({ type: "-", text: a[i] }); i += 1; }
    else { out.push({ type: "+", text: b[j] }); j += 1; }
  }
  return out;
}

// What a file-changing tool call changed: { path, lines, additions, deletions }, or null for any
// other tool. A write is all additions (the transcript doesn't keep what was there before).
// The transcript's strings are kept up to INPUT_LIMIT characters, so a long edit's diff is cut.
export function editDiff(item) {
  const input = item.input ?? {};
  const path = input.file_path ?? input.notebook_path;
  if (item.kind !== "tool" || typeof path !== "string") return null;
  const changes = item.name === "Edit" ? [[input.old_string, input.new_string]]
    : item.name === "MultiEdit" ? (input.edits ?? []).map((e) => [e.old_string, e.new_string])
      : item.name === "Write" ? [["", input.content]]
        : item.name === "NotebookEdit" ? [["", input.new_source]] : null;
  if (!changes) return null;
  const lines = changes.flatMap(([before, after], i) => [
    ...(i > 0 ? [{ type: "@", text: "" }] : []),
    ...lineDiff(typeof before === "string" ? before : "", typeof after === "string" ? after : ""),
  ]);
  return { path, lines, additions: lines.filter((l) => l.type === "+").length, deletions: lines.filter((l) => l.type === "-").length };
}

// The files a turn's edits touched, in the order first touched, with their line counts summed
// (T3's ChangedFilesTree).
export function changedFiles(edits) {
  const files = new Map();
  for (const item of edits) {
    const diff = editDiff(item);
    if (!diff) continue;
    const file = files.get(diff.path) ?? { path: diff.path, additions: 0, deletions: 0 };
    files.set(diff.path, { ...file, additions: file.additions + diff.additions, deletions: file.deletions + diff.deletions });
  }
  return [...files.values()];
}

// A path as shown in the chat: under the chat's folder it is relative to it.
export function shortPath(path, folder) {
  return folder && path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path;
}

// "claude-opus-5-5" -> "Opus 5.5", "claude-sonnet-4-5-20250929" -> "Sonnet 4.5"; else as given.
export function modelLabel(model) {
  const m = (model ?? "").match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?(\[.*\])?$/);
  if (!m) return model ?? "";
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

// The messages the person sent, for ArrowUp in an empty box (T3's prompt history): the entry
// `step` from `at` (-1: the box itself), kept inside the list. Returns { at, text }.
export function historyStep(sent, at, step) {
  const next = Math.max(-1, Math.min(sent.length - 1, at + step));
  return { at: next, text: next < 0 ? "" : sent[sent.length - 1 - next] };
}

// What Claude Code's screen says of its mode and effort (its footer lines):
// { mode: "default" | "acceptEdits" | "plan" | "auto" | "bypass", effort: "high" | ... | null }.
export function screenStatus(screen) {
  const foot = screen.split("\n").filter((line) => line.trim()).slice(-8).join("\n");
  const mode = /plan mode on/.test(foot) ? "plan" : /accept edits on/.test(foot) ? "acceptEdits" : /auto mode on/.test(foot) ? "auto"
    : /bypass permissions on/.test(foot) ? "bypass" : "default";
  return { mode, effort: foot.match(/[●◐◑◒◓◔◕○]\s*(low|medium|high|max|xhigh)\s*·/)?.[1] ?? null };
}

// Claude Code's modes under T3's names (runtimeModeConfig.ts), and plan mode.
export const MODES = { default: "Supervised", acceptEdits: "Auto-accept edits", plan: "Plan", auto: "Auto", bypass: "Full access" };

// What the model control offers: Claude Code's model aliases (`/model <alias>`) and efforts (`/effort <level>`).
export const MODEL_CHOICES = ["default", "opus", "sonnet", "haiku"];
export const EFFORT_CHOICES = ["low", "medium", "high", "max"];

// 84213 -> "84k", 1200000 -> "1.2M" (T3's compact token count).
export function compactTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

// The todo list (TodoWrite) in a line: how many are done, and the step in hand.
export function todoSummary(entries) {
  const done = entries.filter((e) => e.status === "completed").length;
  const current = entries.find((e) => e.status === "in_progress") ?? entries.find((e) => e.status !== "completed");
  return { done, total: entries.length, current: current?.text ?? "" };
}

// The tool call Claude waits on while it asks for permission: the last one still running, if the
// prompt on screen is about it (its command, or its file's name, is in the prompt). Claude Code
// writes a tool call to the transcript late, so the running one may be another, earlier call:
// then null, and the screen's own preview is shown.
export function pendingTool(chat, menu = null) {
  const tool = [...chat.items.values()].findLast((item) => item.kind === "tool" && item.status === "running" && item.name !== "TodoWrite") ?? null;
  if (!tool || !menu) return tool;
  const squeezed = (text) => (text ?? "").replace(/\s+/g, "");
  const prompt = squeezed(`${menu.detail}${menu.question}`);
  const path = tool.input?.file_path ?? tool.input?.notebook_path;
  const needle = tool.name === "Bash" ? squeezed(tool.input?.command).slice(0, 24) : typeof path === "string" ? path.slice(path.lastIndexOf("/") + 1) : "";
  return needle && prompt.includes(needle) ? tool : null;
}

// The plan file Claude Code names under a plan's approval ("ctrl+g to edit in … · ~/…/plans/x.md"),
// or null. The path may be wrapped over lines on a narrow terminal.
export function screenPlanPath(screen) {
  const tail = screen.split("\n").filter((line) => line.trim()).slice(-6).map((line) => line.trim()).join("");
  return tail.match(/(~?\/[\w.\/-]*\/plans\/[\w.-]+\.md)/)?.[1] ?? null;
}
