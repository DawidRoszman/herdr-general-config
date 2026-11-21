const OUTPUT_LIMIT = 6000;
const INPUT_LIMIT = 4000;

export const COMMANDS = [
  ["/model", "switch the model"], ["/compact", "summarize the conversation to free context"], ["/clear", "start over in this session"],
  ["/context", "what fills the context"], ["/cost", "tokens and cost so far"], ["/review", "review a pull request"],
  ["/init", "write a CLAUDE.md"], ["/memory", "edit memory files"], ["/permissions", "allow and deny rules"],
  ["/agents", "sub-agents"], ["/mcp", "MCP servers"], ["/effort", "how long Claude thinks"],
].map(([id, detail]) => ({ id, detail }));

export function emptyChat() {
  return {
    items: new Map(),
    model: null,
    mode: null,
    tokens: 0,
    title: "",
  };
}

const trim = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`);
const asText = (value) => (typeof value === "string" ? value : JSON.stringify(value ?? ""));

function trimInput(input) {
  if (!input || typeof input !== "object") return { value: trim(asText(input), INPUT_LIMIT) };

  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === "string" && k !== "plan" ? trim(v, INPUT_LIMIT) : v]));
}

export function toolTitle(input) {
  for (const key of ["command", "file_path", "path", "notebook_path", "pattern", "url", "query", "description", "prompt"]) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return value.trim().split("\n")[0].slice(0, 200);
  }
  return "";
}

function userText(content) {
  if (typeof content === "string") return content;
  return (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

const images = (content, key) => (Array.isArray(content) ? content : [])
  .filter((b) => b.type === "image" && b.source?.data)
  .map((b, i) => ({ key: `${key}-${i}`, data: b.source.data, mediaType: b.source.media_type ?? "image/png" }));

const tag = (text, name) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();

export function applyTranscript(chat, entries) {
  for (const e of entries) {

    if (e.type === "permission-mode" && e.permissionMode) chat.mode = e.permissionMode === "bypassPermissions" ? "bypass" : e.permissionMode;
    const at = Date.parse(e.timestamp) / 1000 || 0;

    const queued = e.attachment?.type === "queued_command" && e.attachment.commandMode === "prompt" ? e.attachment.prompt : null;
    if (typeof queued === "string" && !e.isSidechain) {
      applyUserText(chat, e, queued, [], at);
      continue;
    }
    if (e.isSidechain || e.isMeta || !e.message) continue;
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
    chat.items.delete("plan");
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

export function visibleItems(chat) {
  return [...chat.items.values()].filter((item) => !(item.kind === "thinking" && !item.text?.trim()));
}

export function transcriptLines(chunk, byteLength) {
  const end = chunk.lastIndexOf("\n") + 1;
  const whole = chunk.slice(0, end);
  const entries = [];
  for (const line of whole.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {  }
  }
  return { entries, bytes: byteLength(whole) };
}

export function chatState(status) {
  if (!status) return "stopped";
  return { working: "working", blocked: "waiting", done: "idle", idle: "idle" }[status] ?? "starting";
}

const OPTION = /^[\s│|]*(?:❯|>)?\s*(\d+)\.\s+(.+?)[\s│|]*$/;
const CHOOSER = /^[\s│|]*❯\s+\S/;
const clean = (l) => l.replace(/^[\s│|╭╰─]+|[\s│|╮╯─]+$/g, "");

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

export function unwrapped(lines) {
  const width = Math.max(0, ...lines.map((l) => l.length));
  const out = [];
  let isCut = false;
  for (const line of lines) {

    if (isCut && out.length && !/^\s*\d+\s/.test(line)) out[out.length - 1] += line.replace(/^\s*[+-]?/, "");
    else out.push(line);
    isCut = width > 20 && line.length >= width;
  }
  return out;
}

const WRAPS = 16;

const STEP = /^[\s❯]*(Next|Submit)$/;
const isStep = (line) => STEP.test(line);
const isMore = (line) => /^\s{4,}\S/.test(line) && !OPTION.test(line) && !/^\s*(Esc|Enter) to /.test(line) && !isStep(line);

const hasPromptBox = (lines) => lines.some((line, i) => /^\s*❯/.test(line) && RULE.test(lines[i + 1] ?? "") && /^\s*[╌─━]{3,}/.test(lines[i - 1] ?? ""));

const QUESTION_TABS = /^\s*(?:←.*→|[☐☒]\s+[^☐☒✔→]+)\s*$/;

export const isTypedOption = (option) => option.kind === "typed";

export function screenMenu(screen) {
  const lines = screen.split("\n");
  if (hasPromptBox(lines.filter((line) => line.trim()))) return null;
  const last = lines.findLastIndex((l) => OPTION.test(l));
  if (last < 0) return chooserMenu(lines);

  let first = last;
  while (lines[first].match(OPTION)[1] !== "1") {
    let up = first - 1;
    while (up >= 0 && first - up <= WRAPS && (isMore(lines[up]) || RULE.test(lines[up]) || isStep(lines[up]))) up -= 1;
    if (up < 0 || !OPTION.test(lines[up])) break;
    first = up;
  }
  let end = last + 1;
  while (end < lines.length && end - last <= WRAPS && isMore(lines[end])) end += 1;
  const options = [];
  let cursor = 0;
  for (const line of lines.slice(first, end)) {
    const m = line.match(OPTION);
    if ((m || isStep(line)) && /^[\s│|]*❯/.test(line)) cursor = options.length;
    if (m) options.push({ key: m[1], label: m[2], keys: [m[1]], more: [] });
    else if (isStep(line)) options.push({ key: "→", label: line.match(STEP)[1], keys: [], more: [] });
    else if (isMore(line)) options[options.length - 1].more.push(line.trim());
  }
  const tabs = lines.slice(0, first).findLastIndex((l) => QUESTION_TABS.test(l));
  if (tabs >= 0) return questionMenu(lines.slice(tabs, first), options, cursor);

  return { ...asked(lines, first), options: options.map(({ more, ...o }) => ({ ...o, label: [o.label, ...more].join(" ") })) };
}

function questionMenu(head, options, cursor) {
  const steps = [...head[0].matchAll(/([☐☒✔])\s+(.+?)(?=\s+[☐☒✔→]|\s*$)/g)].map(([, mark, label]) => ({ label: label.trim(), isDone: mark === "☒", isSubmit: mark === "✔" }));
  const words = head.slice(1).map(clean).filter(Boolean);
  const isReview = words[0] === "Review your answers";
  const review = [];
  for (const [i, word] of words.entries()) if (isReview && word.startsWith("●") && words[i + 1]?.startsWith("→")) review.push({ question: word.slice(1).trim(), answer: words[i + 1].slice(1).trim().replace(/\s*\(Recommended\)$/, "") });

  const moves = (to) => Array(Math.abs(to - cursor)).fill(to > cursor ? "down" : "up");
  const shown = options.map((option, i) => {
    const box = option.label.match(/^\[(.)\]\s*/);
    const label = (box ? option.label.slice(box[0].length) : option.label).replace(/\s*\(Recommended\)$/, "");
    const kind = option.key === "→" ? "step" : /^Type something\.?$/.test(label) ? "typed" : label === "Chat about this" ? "chat" : "answer";
    return { key: option.key, label, description: option.more.join(" "), keys: kind === "step" ? [...moves(i), "enter"] : option.keys, kind,
      isChecked: box ? box[1] !== " " : null, isRecommended: /\(Recommended\)$/.test(option.label), isCursor: i === cursor };
  });
  const isSteps = steps.filter((step) => !step.isSubmit).length > 1;
  return {
    isQuestion: true, question: isReview ? words[0] : words.join(" "), detail: "", review,
    steps: isSteps ? steps : [], current: isSteps ? (isReview ? steps.findIndex((step) => step.isSubmit) : steps.findIndex((step) => !step.isDone && !step.isSubmit)) : -1,
    options: shown, cursor,
  };
}

export function placeQuestion(menu, seen) {
  if (!menu?.steps?.length || menu.review.length) return seen;
  const fresh = menu.steps.every((step) => !step.isDone);
  const now = fresh ? [] : seen.length ? seen : Array(Math.max(0, menu.current)).fill(null);
  const next = now.includes(menu.question) ? now : [...now, menu.question];
  menu.current = next.indexOf(menu.question);
  return next;
}

export function typedAnswer(menu, option) {
  if (option.isChecked === null) return { keys: option.keys, after: [] };
  const at = menu.options.indexOf(option), from = menu.cursor ?? 0;
  return { keys: Array(Math.abs(at - from)).fill(at > from ? "down" : "up"), after: ["enter"] };
}

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

const LINE = 20;
const CHAR = 6.6;
export function estimateRowHeight(row, { isOpen = false, width = 920 } = {}) {
  const pad = 10;
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

export function typedMarkdown(text) {
  return (text ?? "").replace(/</g, "\\<").replace(/\n/g, "  \n");
}

export function htmlBlocks(text) {
  return [...(text ?? "").matchAll(/```html\s*\n([\s\S]*?)```/g)].map((m) => m[1].trim()).filter(Boolean);
}

export function stateLabel(state) {
  return { starting: "Starting…", idle: "Ready", working: "Working…", waiting: "Needs you", stopped: "Stopped" }[state] ?? state;
}

export function toolDetail(item) {
  const input = Object.fromEntries(Object.entries(item.input ?? {}).filter(([, v]) => v !== item.title));
  const parts = [];
  if (Object.keys(input).length) parts.push("```json\n" + JSON.stringify(input, null, 2) + "\n```");
  if (item.output) parts.push("```text\n" + item.output + "\n```");
  return parts.join("\n\n") || "_No output._";
}

const SUGGESTIONS = 8;

export function commandMatches(commands, text) {
  if (!text.startsWith("/") || text.includes(" ")) return [];
  return commands.filter((c) => c.id.startsWith(text)).slice(0, SUGGESTIONS);
}

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

  const order = (a, b) => a.rank - b.rank || a.path.length - b.path.length;
  const best = [];
  for (const path of files) {
    const match = { path, rank: rank(path) };
    if (match.rank < 0 || (best.length === SUGGESTIONS && order(match, best[SUGGESTIONS - 1]) >= 0)) continue;
    let at = best.length;
    while (at > 0 && order(match, best[at - 1]) < 0) at--;
    best.splice(at, 0, match);
    if (best.length > SUGGESTIONS) best.pop();
  }
  return best.map((f) => f.path);
}

export function suggestionsFor(draft, commands, files) {

  const head = draft.trimStart();
  if (head.startsWith("/") && !/\s/.test(head)) {
    return { token: draft, items: commandMatches(commands, head).map((c) => ({ insert: `${c.id} `, label: c.id, detail: c.detail ?? "" })) };
  }
  const at = draft.match(/(?:^|\s)(@[^\s@]*)$/);
  if (!at) return { token: "", items: [] };
  const query = at[1].slice(1);
  return { token: at[1], items: fileMatches(files, query).map((path) => ({ insert: `@${path} `, label: path.slice(path.lastIndexOf("/") + 1), detail: path })) };
}

export function accepted(draft, token, insert) {
  const start = draft.length - token.length;
  return { text: draft.slice(0, start) + insert, caret: start + insert.length };
}

export function composerKeyRoute(key, { hasSuggestions, isQuestion, isEmpty, recalls }) {
  if (hasSuggestions) return "suggest";
  if (key === "tab") return "box";
  if (isQuestion && isEmpty) return "question";
  return recalls ? "history" : "box";
}

export const isLoopbackUrl = (url) => /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i.test(url);
export const isImagePath = (path) => /\.(png|jpe?g|gif|webp)$/i.test(path);

export function chatTabName(title) {
  return (title || "new").slice(0, 30);
}

export function chatTabRename(tab, title) {
  if (!tab || !title) return null;
  const name = chatTabName(title);
  const isChats = !tab.named || tab.name === "claude" || tab.name === `Chat: ${title.slice(0, 24)}`;
  return isChats && tab.name !== name ? name : null;
}

export function timeline(chat, { isWorking = false } = {}) {
  const out = [];
  let group = null;
  let texts = [];
  let turnStart = 0;
  let lastAt = 0;
  let edits = [];
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

export function formatElapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const basename = (path) => path.slice(path.lastIndexOf("/") + 1);
export function entryLabel(item) {
  if (item.kind === "thinking") return { icon: "lightbulb", heading: "Thought", detail: item.text.trim().split("\n")[0] };
  const input = item.input ?? {};
  const file = input.file_path ?? input.path ?? input.notebook_path ?? "";
  switch (item.name) {

    case "Bash": return { icon: "terminal", heading: "Ran", detail: item.title.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*(?=\S)/, "") };
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

const DIFF_LIMIT = 600;
export function lineDiff(oldText, newText) {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const mark = (type, lines) => lines.map((text) => ({ type, text }));
  if (a.length > DIFF_LIMIT || b.length > DIFF_LIMIT) return [...mark("-", a), ...mark("+", b)];

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

export function shortPath(path, folder) {
  return folder && path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path;
}

export function modelLabel(model) {
  const m = (model ?? "").match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?(\[.*\])?$/);
  if (!m) return model ?? "";
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

export function historyStep(sent, at, step) {
  const next = Math.max(-1, Math.min(sent.length - 1, at + step));
  return { at: next, text: next < 0 ? "" : sent[sent.length - 1 - next] };
}

export function screenStatus(screen) {
  const foot = screen.split("\n").filter((line) => line.trim()).slice(-8).join("\n");
  const mode = /plan mode on/.test(foot) ? "plan" : /accept edits on/.test(foot) ? "acceptEdits" : /auto mode on/.test(foot) ? "auto"
    : /bypass permissions on/.test(foot) ? "bypass" : "default";
  return { mode, effort: foot.match(/[●◐◑◒◓◔◕○]\s*(low|medium|high|max|xhigh)\s*·/)?.[1] ?? null };
}

export const MODES = { default: "Supervised", acceptEdits: "Auto-accept edits", plan: "Plan", auto: "Auto", bypass: "Full access" };

export const MODEL_CHOICES = ["default", "opus", "sonnet", "haiku"];
export const EFFORT_CHOICES = ["low", "medium", "high", "max"];

export function compactTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

export function todoSummary(entries) {
  const done = entries.filter((e) => e.status === "completed").length;
  const current = entries.find((e) => e.status === "in_progress") ?? entries.find((e) => e.status !== "completed");
  return { done, total: entries.length, current: current?.text ?? "" };
}

export function pendingTool(chat, menu = null) {
  const tool = [...chat.items.values()].findLast((item) => item.kind === "tool" && item.status === "running" && item.name !== "TodoWrite") ?? null;
  if (!tool || !menu) return tool;
  const squeezed = (text) => (text ?? "").replace(/\s+/g, "");
  const prompt = squeezed(`${menu.detail}${menu.question}`);
  const path = tool.input?.file_path ?? tool.input?.notebook_path;
  const needle = tool.name === "Bash" ? squeezed(tool.input?.command).slice(0, 24) : typeof path === "string" ? path.slice(path.lastIndexOf("/") + 1) : "";
  return needle && prompt.includes(needle) ? tool : null;
}

export function screenPlanPath(screen) {
  const tail = screen.split("\n").filter((line) => line.trim()).slice(-6).map((line) => line.trim()).join("");
  return tail.match(/(~?\/[\w.\/-]*\/plans\/[\w.-]+\.md)/)?.[1] ?? null;
}

export function imageSize(bytes) {
  const at = (i) => bytes[i] ?? 0;
  const be16 = (i) => (at(i) << 8) | at(i + 1);
  const le16 = (i) => at(i) | (at(i + 1) << 8);
  const le24 = (i) => le16(i) | (at(i + 2) << 16);
  const ascii = (i, n) => String.fromCharCode(...Array.from({ length: n }, (_, k) => at(i + k)));
  if (ascii(1, 3) === "PNG") return { width: (be16(16) << 16) + be16(18), height: (be16(20) << 16) + be16(22) };
  if (ascii(0, 4) === "GIF8") return { width: le16(6), height: le16(8) };
  if (at(0) === 0xff && at(1) === 0xd8) {

    for (let i = 2; i + 9 < bytes.length;) {
      if (at(i) !== 0xff) return null;
      const marker = at(i + 1);
      if (marker === 0xff) { i += 1; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: be16(i + 7), height: be16(i + 5) };
      i += 2 + be16(i + 2);
    }
    return null;
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (chunk === "VP8L") return { width: 1 + (((at(22) & 0x3f) << 8) | at(21)), height: 1 + (((at(24) & 0xf) << 10) | (at(23) << 2) | ((at(22) & 0xc0) >> 6)) };
    if (chunk === "VP8X") return { width: 1 + le24(24), height: 1 + le24(27) };
  }
  return null;
}

export function coverSize({ width, height }, boxWidth, boxHeight) {
  const scale = Math.max(boxWidth / width, boxHeight / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function fitSize({ width, height }, maxWidth, maxHeight) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
