// A message's Markdown cut into blocks, so each is drawn with T3's own numbers (render-md.js) and
// is one row of the chat list. Blocks only: inline marks (bold, code, links) stay TextView's.
// Checked by `node markdown.test.mjs`.
//
// Block: { type, raw, ... }
//   heading { level, text }      prose { }
//   code { lang, title, text, isOpen }   (isOpen: the closing fence hasn't streamed in yet)
//   table { header: [cell], align: ["left" | "center" | "right"], rows: [[cell]] }
//   list { items: [{ ordered, marker, task, text }], isLoose }   (text: the item's own Markdown; task: "open" | "done" | null)
//   quote { text, alert }        (alert: "note" | "tip" | "important" | "warning" | "caution" | null)
//   details { summary, body }    html { }                  hr { }

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const HTML_BLOCK = /^ {0,3}<(?:div|p|table|pre|ul|ol|dl|h[1-6]|blockquote|section|article|figure|center|img|picture|br|hr)\b/i;
const DETAILS = /^ {0,3}<details\b/i;
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

const isBlank = (line) => !line.trim();
const isTableStart = (lines, i) => lines[i].includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes("-");

// A table row's cells: outer pipes dropped, `\|` kept as a pipe.
export function tableCells(line) {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function startsBlock(lines, i) {
  const line = lines[i];
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line)
    || DETAILS.test(line) || HTML_BLOCK.test(line) || isTableStart(lines, i);
}

export function blocks(markdown) {
  const lines = (markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const take = (type, from, to, more = {}) => out.push({ type, raw: lines.slice(from, to).join("\n"), ...more });
  while (i < lines.length) {
    const line = lines[i];
    const start = i;
    if (isBlank(line)) { i += 1; continue; }

    const fence = line.match(FENCE);
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      i += 1;
      while (i < lines.length && !closing.test(lines[i])) i += 1;
      const isOpen = i >= lines.length;
      const [lang = "", ...title] = fence[2].trim().split(/\s+/);
      take("code", start, isOpen ? i : i + 1, { lang: lang.toLowerCase(), title: title.join(" "), text: lines.slice(start + 1, i).join("\n"), isOpen });
      i += 1;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) { i += 1; take("heading", start, i, { level: heading[1].length, text: heading[2] }); continue; }

    if (HR.test(line)) { i += 1; take("hr", start, i); continue; }

    if (isTableStart(lines, i)) {
      const header = tableCells(line);
      const align = tableCells(lines[i + 1]).map((rule) => (/^:-+:$/.test(rule) ? "center" : /-:$/.test(rule) ? "right" : "left"));
      i += 2;
      const rows = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) { rows.push(tableCells(lines[i])); i += 1; }
      take("table", start, i, { header, align, rows: rows.map((row) => header.map((_, c) => row[c] ?? "")) });
      continue;
    }

    if (QUOTE.test(line)) {
      // Lazy continuation: a paragraph line right after a quote line still belongs to it.
      while (i < lines.length && !isBlank(lines[i]) && (QUOTE.test(lines[i]) || !startsBlock(lines, i))) i += 1;
      const inner = lines.slice(start, i).map((l) => l.replace(QUOTE, ""));
      const alert = inner[0].match(ALERT);
      take("quote", start, i, { text: (alert ? inner.slice(1) : inner).join("\n"), alert: alert ? alert[1].toLowerCase() : null });
      continue;
    }

    if (DETAILS.test(line)) {
      let depth = 0;
      while (i < lines.length) {
        depth += (lines[i].match(/<details\b/gi) ?? []).length - (lines[i].match(/<\/details>/gi) ?? []).length;
        i += 1;
        if (depth <= 0) break;
      }
      const raw = lines.slice(start, i).join("\n");
      const summary = raw.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1]?.trim() || "Details";
      const body = raw.replace(/^[^>]*>/, "").replace(/<summary>[\s\S]*?<\/summary>/i, "").replace(/<\/details>\s*$/i, "").trim();
      take("details", start, i, { summary, body });
      continue;
    }

    if (HTML_BLOCK.test(line)) {
      while (i < lines.length && !isBlank(lines[i])) i += 1;
      take("html", start, i);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      // A list runs over blank lines while what follows is another item or indented under one.
      for (;;) {
        while (i < lines.length && !isBlank(lines[i])) i += 1;
        let next = i;
        while (next < lines.length && isBlank(lines[next])) next += 1;
        if (next >= lines.length || !(LIST_ITEM.test(lines[next]) || /^\s{2,}\S/.test(lines[next]))) break;
        i = next;
      }
      take("list", start, i, listItems(lines.slice(start, i)));
      continue;
    }

    // A paragraph, up to a blank line or the next block. `===` / `---` under it makes it a heading.
    i += 1;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i) && !/^ {0,3}=+\s*$/.test(lines[i])) i += 1;
    const under = i < lines.length ? lines[i].match(/^ {0,3}(=+|-+)\s*$/) : null;
    if (under) {
      i += 1;
      take("heading", start, i, { level: under[1][0] === "=" ? 1 : 2, text: lines.slice(start, i - 1).join(" ").trim() });
    } else take("prose", start, i);
  }
  return out;
}

// A list's lines as items. An item starts at a marker no deeper than the first one's; the lines
// under it, less its indent, are its own Markdown (paragraphs, nested lists, fences).
const ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])(\s+)(.*)$/;
const TASK = /^\[([ xX])\]\s+/;
export function listItems(lines) {
  const base = lines[0].match(ITEM)[1].length;
  const items = [];
  let isLoose = false;
  let wasBlank = false;
  for (const line of lines) {
    const m = line.match(ITEM);
    if (m && m[1].length <= base + 1) {
      if (wasBlank) isLoose = true;
      const task = m[5].match(TASK);
      items.push({ ordered: Boolean(m[3]), marker: m[3] ? `${Number(m[3])}.` : "", task: task ? (task[1] === " " ? "open" : "done") : null,
        indent: m[1].length + m[2].length + m[4].length, lines: [task ? m[5].replace(TASK, "") : m[5]] });
    } else {
      const item = items[items.length - 1];
      const lead = line.match(/^\s*/)[0].length;
      item.lines.push(line.slice(Math.min(lead, item.indent)));
    }
    wasBlank = isBlank(line);
  }
  return { items: items.map(({ lines: own, indent, ...item }) => ({ ...item, text: own.join("\n").trim() })), isLoose };
}

// T3's block margins in px (index.css "Chat markdown rendering"): [top, bottom]. Adjacent margins
// collapse to the larger, and a message's first and last block have none.
const MARGIN = { heading: [20, 8], details: [8, 8] };
const DEFAULT_MARGIN = [10.4, 10.4];
export function gapBefore(previous, block) {
  if (!previous) return 0;
  return Math.max((MARGIN[previous.type] ?? DEFAULT_MARGIN)[1], (MARGIN[block.type] ?? DEFAULT_MARGIN)[0]);
}

// A table's column widths in px for a lane: each column as wide as its longest cell needs
// (T3 caps a cell at 24rem), shrunk together when they don't fit, stretched to fill when they do.
const CELL_CHAR = 7.4; // an average glyph at 14px
export function columnWidths(table, lane) {
  const plain = (cell) => cell.replace(/[`*_~]|\[([^\]]*)\]\([^)]*\)/g, "$1");
  const wanted = table.header.map((head, c) => {
    const longest = Math.max(plain(head).length, ...table.rows.map((row) => plain(row[c]).length));
    return Math.min(384, Math.max(40, longest * CELL_CHAR + 24));
  });
  const total = wanted.reduce((sum, w) => sum + w, 0);
  return wanted.map((w) => (w * lane) / total);
}

// A fence's language as the code view names it (Herdr's Editor); null: drawn without colours.
const LANGUAGES = { js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", javascript: "javascript",
  ts: "typescript", tsx: "tsx", typescript: "typescript", py: "python", python: "python", rb: "ruby", ruby: "ruby", rs: "rust", rust: "rust",
  go: "go", java: "java", kt: "kotlin", kotlin: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", "c++": "cpp", cs: "csharp", csharp: "csharp",
  sh: "bash", bash: "bash", zsh: "bash", shell: "bash", console: "bash", json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  html: "html", xml: "xml", css: "css", scss: "scss", sql: "sql", md: "markdown", markdown: "markdown", diff: "diff", patch: "diff",
  dockerfile: "dockerfile", lua: "lua", php: "php" };
export const codeLanguage = (lang) => LANGUAGES[lang] ?? null;

// T3's code block (MarkdownCodeBlock.tsx): a header of 6px + a 24px action, then the code at
// 13px (its default code size) and leading-snug (1.375), inside 0.8rem of padding.
export const CODE = { head: 30, pad: 12.8, size: 13, line: 13 * 1.375 };
export const codeBodyHeight = (text) => CODE.pad * 2 + Math.max(1, text.split("\n").length) * CODE.line;
