// A Markdown block (markdown.js) drawn as T3 Code draws it: the numbers are T3's index.css
// "Chat markdown rendering" and ChatMarkdown.tsx (rem = 16px). Inline marks are TextView's.
// No handlers in here: blocks are rows of the chat's virtual list (one click action per row).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, Editor } from "gpui-base";
import { window, settings } from "herdr";
import { blocks, gapBefore, columnWidths, CODE } from "./markdown.js";

// T3's --font-sans starts with -apple-system: the system font. Elsewhere the layout's ui font.
export const sans = (el) => (window()?.platform === "macos" ? el.font_family(".AppleSystemUIFont") : el);
// A theme colour at a share of its own opacity (#rrggbb or #rrggbbaa).
export const alpha = (color, share) => {
  const own = color.length > 7 ? parseInt(color.slice(7, 9), 16) / 255 : 1;
  return `${color.slice(0, 7)}${Math.round(own * share * 255).toString(16).padStart(2, "0")}`;
};

const BODY = 14; // text-sm
const LEADING = "22.75px"; // leading-relaxed: 14 * 1.625
// h1..h6: font size, at line height 1.3.
const HEADING = [20, 18, 16, 14, 14, 14];
// ChatMarkdown's root: text-foreground at 90%.
const body = (t) => alpha(t.foreground, 0.9);

// Inline Markdown at T3's body size. TextView takes line height and weight from its wrapper only.
function text(id, markdown, t, { size = BODY, leading = LEADING, color = body(t), weight = null } = {}) {
  const wrapper = sans(div().w_full().min_w(0).line_height(leading));
  return (weight ? wrapper.font_weight(weight) : wrapper)
    .child(TextView.markdown(id, markdown || " ").text_size(size).text_color(color).selectable(true));
}

const ALERTS = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

// Markdown inside a block (a quote, a list item): its own blocks with their margins.
export function nested(markdown, id, t, depth = 0) {
  const inner = blocks(markdown);
  return v_flex().w_full().min_w(0).children(inner.map((block, i) => mdBlock(block, inner[i - 1] ?? null, `${id}-${i}`, t, {}, depth)));
}

// ul / ol: a 1.25rem gutter with the marker outside the text; disc, circle, square by depth; 0.25rem
// between items (0.65rem when an item ends in a block of its own or the list is loose, as the
// margins collapse in T3). Ordered markers are tabular and widen the gutter past two characters.
const GUTTER = 20;
const LINE = 22.75;
// ol: decimal, then lower-alpha, then lower-roman.
const ALPHA = (n) => (n > 26 ? ALPHA(Math.floor((n - 1) / 26)) : "") + String.fromCharCode(97 + ((n - 1) % 26));
const ROMAN = (n) => [[10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]].reduce((out, [value, mark]) => { while (n >= value) { out += mark; n -= value; } return out; }, "");
const ordinal = (marker, depth) => {
  const n = parseInt(marker, 10);
  return `${depth === 0 || !(n > 0) ? n : depth === 1 ? ALPHA(n) : ROMAN(n)}.`;
};

function listMarker(item, t, depth) {
  const box = (el) => h_flex().w_full().h(LINE).items_center().justify_center().pr(6).child(el);
  if (item.task) {
    const isDone = item.task === "done";
    return box(div().size(13).rounded(3).border(1).border_color(isDone ? t.accent : t.input).when(isDone, (el) => el.bg(t.accent))
      .flex().items_center().justify_center()
      .when(isDone, (el) => el.child(div().text_size(9).line_height("9px").font_weight(700).text_color(t.accent_foreground).child("✓"))));
  }
  if (item.ordered) return sans(div().w_full().h(LINE).pr(5).text_right().text_size(BODY).line_height(`${LINE}px`).text_color(body(t)).child(ordinal(item.marker, depth)));
  const dot = div().size(5).flex_none();
  if (depth === 0) return box(dot.rounded(2.5).bg(body(t)));
  if (depth === 1) return box(dot.rounded(2.5).border(1).border_color(body(t)));
  return box(dot.bg(body(t)));
}

function drawList(block, id, t, depth) {
  const widest = Math.max(...block.items.map((item) => item.marker.length));
  const gutter = Math.max(GUTTER, widest * 8 + 5);
  return v_flex().w_full().children(block.items.map((item, i) => {
    const previous = block.items[i - 1];
    const gap = !previous ? 0 : block.isLoose || /\n/.test(previous.text) ? 10.4 : 4;
    return h_flex().w_full().items_start().pt(gap)
      .child(div().w(gutter).flex_none().child(listMarker(item, t, depth)))
      .child(nested(item.text, `${id}-${i}`, t, depth + 1));
  }));
}

// table: 14px, no outer border or vertical lines; cells 0.45rem x 0.75rem, the first and last
// flush with the prose; the header 600 with 0.55rem above and below; every row underlined at 60%
// of the border.
function drawTable(block, id, t, lane) {
  const widths = columnWidths(block, lane);
  const line = alpha(t.border, 0.6);
  const row = (cells, r, isHead) => h_flex().w_full().items_start().border_b(1).border_color(line)
    .children(cells.map((cell, c) => div().w(widths[c]).flex_none().py(isHead ? 8.8 : 7.2)
      .pl(c === 0 ? 0 : 12).pr(c === cells.length - 1 ? 0 : 12)
      .child(text(`${id}-${r}-${c}`, cell, t, isHead ? { weight: 600, color: t.foreground } : {}))));
  return v_flex().w_full().child(row(block.header, "h", true)).children(block.rows.map((cells, r) => row(cells, r, false)));
}

// <details> (MarkdownDetails.tsx): ruled above and below at 60%, a 16px chevron and the summary
// at 14px medium with 8px above and below; the body 24px in, 12px under. The row is the toggle.
function drawDetails(block, id, t, depth, isOpen) {
  return v_flex().w_full().border_t(1).border_b(1).border_color(alpha(t.border, 0.6)).cursor_pointer()
    .child(h_flex().w_full().py(8).gap(8).items_center()
      .child(svg(`mods/t3-chat/icons/chevron-${isOpen ? "down" : "right"}.svg`).size(16).flex_none().text_color(t.muted))
      .child(sans(div().min_w(0).text_size(BODY).line_height("20px").font_weight(500).text_color(t.foreground).child(block.summary))))
    .when(isOpen, (el) => el.child(div().w_full().pl(24).pb(12).child(nested(block.body, id, t, depth))));
}

function draw(block, id, t, depth, state) {
  switch (block.type) {
    case "heading": {
      const size = HEADING[block.level - 1];
      // h6 is muted in T3; the rest use the full foreground.
      return text(id, block.text, t, { size, leading: `${size * 1.3}px`, weight: 600, color: block.level === 6 ? t.muted : t.foreground });
    }
    case "hr":
      return div().w_full().h(1).bg(t.border);
    case "quote": {
      // blockquote: 2px border at 35% of the text colour, 0.8rem inside; an alert names its kind first.
      const tone = { note: t.accent, tip: t.done, important: t.accent, warning: t.working, caution: t.blocked }[block.alert];
      return v_flex().w_full().pl(12.8).border_l(2).border_color(tone ?? alpha(t.foreground, 0.35)).gap(4)
        .when(Boolean(block.alert), (el) => el.child(sans(div().text_size(BODY).font_weight(600).text_color(tone).child(ALERTS[block.alert]))))
        .child(nested(block.text, id, t, depth));
    }
    case "list":
      return drawList(block, id, t, depth);
    case "table":
      return drawTable(block, id, t, state.width - depth * GUTTER);
    case "details":
      return drawDetails(block, id, t, depth, state.isOpen);
    case "html":
      // Raw HTML: what TextView's HTML draws of it (no CSS).
      return sans(div().w_full().line_height(LEADING).child(TextView.html(id, `<div>${block.raw}</div>`).text_size(BODY).text_color(body(t))));
    default:
      // prose (and a fence inside a list item or a quote: TextView's own box).
      return text(id, block.raw, t);
  }
}

// One block as a list row's content: its collapsed top margin, then the block.
// depth: how many lists it is nested in. state: { isOpen (a details block), width (the lane's) }.
export function mdBlock(block, previous, id, t, state = {}, depth = 0) {
  return div().w_full().min_w(0).pt(gapBefore(previous, block)).child(draw(block, id, t, depth, { width: 736, ...state }));
}

// T3's code block card: `bg-secondary` with a 70% border in light, `bg-input/32` and no border in
// dark (white at 11% x 32%), rounded-lg. Two rows of the list, so the header can be its copy button.
const codeFill = (t) => (settings().dark ? alpha(t.foreground, 0.035) : t.surface);
const codeEdge = (t) => (settings().dark ? "#00000000" : alpha(t.border, 0.7));

// The header: language (mono 11px, 72% foreground) left; copy right, a check for a moment after.
// The whole row is the button (one click action per row).
// height: the row's, margin above included; the header fills what is under the margin.
export function codeHead(block, height, t, mono, isCopied) {
  const label = block.title || block.lang || "text";
  return v_flex().w_full().h(height).justify_end().cursor_pointer()
    .child(h_flex().w_full().h(CODE.head).pt(6).pr(6).pl(12).gap(8).items_center().justify_between()
      .rounded_t(8).bg(codeFill(t)).border_t(1).border_l(1).border_r(1).border_color(codeEdge(t))
      .child(div().min_w(0).truncate().font_family(mono).text_size(11).text_color(alpha(t.foreground, 0.72)).child(label))
      .child(h_flex().size(24).flex_none().items_center().justify_center().rounded(6).hover((s) => s.bg(t.hover))
        .child(svg(`mods/t3-chat/icons/${isCopied ? "check" : "copy"}.svg`).size(12).text_color(isCopied ? t.done : t.muted))));
}

// The code: Herdr's code view when the language is known (editor: its retained state, made
// outside render), else plain mono lines. Never wrapped: the view scrolls sideways, and its
// height is known without measuring.
export function codeBody(block, height, editor, t, mono) {
  const plain = () => div().w_full().overflow_hidden().font_family(mono).text_size(CODE.size).line_height(`${CODE.line}px`).text_color(body(t))
    .children((block.text || " ").split("\n").map((line) => div().h(CODE.line).whitespace_nowrap().child(line || " ")));
  // The code view has about 6.6px inside its own left edge.
  return div().w_full().h(height).pl(editor ? 7.8 : 14.4).pr(14.4).py(CODE.pad).rounded_b(8).bg(codeFill(t)).border_b(1).border_l(1).border_r(1).border_color(codeEdge(t))
    .child(div().w_full().h(block.text.split("\n").length * CODE.line).line_height(`${CODE.line}px`).child(editor ? Editor.new(editor) : plain()));
}

// Under a table, at the right: copy it (as Markdown). T3's `mt-0.5` and an icon-xs button.
export function copyRow(t, isCopied) {
  return h_flex().w_full().h(26).pt(2).justify_end().cursor_pointer()
    .child(h_flex().size(24).items_center().justify_center().rounded(6).hover((s) => s.bg(t.hover))
      .child(svg(`mods/t3-chat/icons/${isCopied ? "check" : "copy"}.svg`).size(12).text_color(isCopied ? t.done : t.muted)));
}

// ```html drawn under its source. T3 renders it in a sandboxed frame; here it is what TextView's
// HTML draws: structure and text, no CSS.
export function htmlPreview(block, id, t) {
  return div().w_full().pt(6)
    .child(sans(div().w_full().p(12).rounded(8).border(1).border_color(alpha(t.border, 0.7)).line_height(LEADING)
      .child(TextView.html(id, `<div>${block.text}</div>`).text_size(BODY).text_color(body(t)))));
}
