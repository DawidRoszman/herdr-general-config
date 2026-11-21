import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView, Editor } from "gpui-base";
import { window, settings } from "herdr";
import { blocks, gapBefore, columnWidths, CODE } from "./markdown.js";
import { fitSize } from "./model.js";
import { tip, glow } from "./tip.js";

export const sans = (el) => (window()?.platform === "macos" ? el.font_family(".AppleSystemUIFont") : el);

export const alpha = (color, share) => {
  const own = color.length > 7 ? parseInt(color.slice(7, 9), 16) / 255 : 1;
  return `${color.slice(0, 7)}${Math.round(own * share * 255).toString(16).padStart(2, "0")}`;
};

const BODY = 14;
const LEADING = "22.75px";

const HEADING = [20, 18, 16, 14, 14, 14];

const body = (t) => alpha(t.foreground, 0.9);

function text(id, markdown, t, { size = BODY, leading = LEADING, color = body(t), weight = null, onOpenLink = null } = {}) {
  const wrapper = sans(div().w_full().min_w(0).line_height(leading));
  const view = TextView.markdown(id, markdown || " ").text_size(size).text_color(color).selectable(true);
  return (weight ? wrapper.font_weight(weight) : wrapper).child(onOpenLink ? view.on_link_click(onOpenLink) : view);
}

const ALERTS = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

export function nested(markdown, id, t, depth = 0, state = {}) {
  const inner = blocks(markdown);
  return v_flex().w_full().min_w(0).children(inner.map((block, i) => mdBlock(block, inner[i - 1] ?? null, `${id}-${i}`, t, { ...state, isOpen: false }, depth)));
}

const IMAGE_MAX_HEIGHT = 320;
export const IMAGE_BOX = { width: 736, height: IMAGE_MAX_HEIGHT };
function drawImage(block, id, t, picture, width, onOpenImage) {
  if (picture?.path) {
    const size = fitSize(picture, width, IMAGE_MAX_HEIGHT);
    return div().id(`img-${id}`).w(size.width).h(size.height).cursor_pointer()
      .on_click((_e, cx) => { cx.stop_propagation(); if (onOpenImage) onOpenImage(block.src); else cx.open_url(picture.open); })
      .child(image(picture.thumb ?? picture.path).w(size.width).h(size.height).rounded(8));
  }
  const note = picture?.error ? ` · ${picture.error}` : " · loading…";
  return sans(div().w_full().min_w(0).text_size(13).line_height("20px").text_color(t.muted)
    .child(div().font_family(settings().font_family ?? "JetBrains Mono").child(block.alt ? `${block.alt}: ${block.src}${note}` : `${block.src}${note}`)));
}

const GUTTER = 20;
const LINE = 22.75;

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

function drawList(block, id, t, depth, state) {
  const widest = Math.max(...block.items.map((item) => item.marker.length));
  const gutter = Math.max(GUTTER, widest * 8 + 5);
  return v_flex().w_full().children(block.items.map((item, i) => {
    const previous = block.items[i - 1];
    const gap = !previous ? 0 : block.isLoose || /\n/.test(previous.text) ? 10.4 : 4;
    return h_flex().w_full().items_start().pt(gap)
      .child(div().w(gutter).flex_none().child(listMarker(item, t, depth)))
      .child(nested(item.text, `${id}-${i}`, t, depth + 1, state));
  }));
}

function drawTable(block, id, t, lane, onOpenLink) {
  const widths = columnWidths(block, lane);
  const line = alpha(t.border, 0.6);
  const width = widths.reduce((sum, w) => sum + w, 0);
  const row = (cells, r, isHead) => h_flex().w(width).items_start().border_b(1).border_color(line)
    .children(cells.map((cell, c) => div().w(widths[c]).flex_none().py(isHead ? 8.8 : 7.2)
      .pl(c === 0 ? 0 : 12).pr(c === cells.length - 1 ? 0 : 12)
      .child(text(`${id}-${r}-${c}`, cell, t, isHead ? { weight: 600, color: t.foreground, onOpenLink } : { onOpenLink }))));
  const table = v_flex().w(width).flex_none().child(row(block.header, "h", true)).children(block.rows.map((cells, r) => row(cells, r, false)));

  return width <= lane + 0.5 ? table : div().id(`${id}-scroll`).w_full().overflow_x_scrollbar().child(table);
}

function drawDetails(block, id, t, depth, state) {
  const { isOpen } = state;
  return v_flex().w_full().border_t(1).border_b(1).border_color(alpha(t.border, 0.6)).cursor_pointer()
    .child(h_flex().w_full().py(8).gap(8).items_center()
      .child(svg(`mods/t3-chat/icons/chevron-${isOpen ? "down" : "right"}.svg`).size(16).flex_none().text_color(t.muted))
      .child(sans(div().min_w(0).text_size(BODY).line_height("20px").font_weight(500).text_color(t.foreground).child(block.summary))))
    .when(isOpen, (el) => el.child(div().w_full().pl(24).pb(12).child(nested(block.body, id, t, depth, state))));
}

function draw(block, id, t, depth, state) {
  switch (block.type) {
    case "heading": {
      const size = HEADING[block.level - 1];

      return text(id, block.text, t, { size, leading: `${size * 1.3}px`, weight: 600, color: block.level === 6 ? t.muted : t.foreground, onOpenLink: state.onOpenLink });
    }
    case "hr":
      return div().w_full().h(1).bg(t.border);
    case "quote": {

      const tone = { note: t.accent, tip: t.done, important: t.accent, warning: t.working, caution: t.blocked }[block.alert];
      return v_flex().w_full().pl(12.8).border_l(2).border_color(tone ?? alpha(t.foreground, 0.35)).gap(4)
        .when(Boolean(block.alert), (el) => el.child(sans(div().text_size(BODY).font_weight(600).text_color(tone).child(ALERTS[block.alert]))))
        .child(nested(block.text, id, t, depth, state));
    }
    case "list":
      return drawList(block, id, t, depth, state);
    case "table":
      return drawTable(block, id, t, state.width - depth * GUTTER, state.onOpenLink);
    case "details":
      return drawDetails(block, id, t, depth, state);
    case "image":
      return drawImage(block, id, t, state.pictures?.get(block.src), state.width - depth * GUTTER, state.onOpenImage);
    case "html":

      return sans(div().w_full().line_height(LEADING).child(TextView.html(id, `<div>${block.raw}</div>`).text_size(BODY).text_color(body(t))));
    default:

      return text(id, block.raw, t, { onOpenLink: state.onOpenLink });
  }
}

export function mdBlock(block, previous, id, t, state = {}, depth = 0) {
  return div().w_full().min_w(0).pt(gapBefore(previous, block)).child(draw(block, id, t, depth, { width: 736, ...state }));
}

const codeFill = (t) => (settings().dark ? alpha(t.foreground, 0.035) : t.surface);
const codeEdge = (t) => (settings().dark ? "#00000000" : alpha(t.border, 0.7));

const copyIcon = (view, id, t, isCopied) => tip(view, t, id, isCopied ? "Copied" : "Copy", h_flex().id(id).size(24).flex_none().items_center().justify_center().rounded(6)
  .hover((s) => s.bg(t.hover)).on_hover(glow(view, id))
  .child(svg(`mods/t3-chat/icons/${isCopied ? "check" : "copy"}.svg`).size(12).text_color(isCopied ? t.done : t.muted)));

export function codeHead(view, id, block, height, t, mono, isCopied) {
  const label = block.title || block.lang || "text";
  return v_flex().w_full().h(height).justify_end().cursor_pointer()
    .child(h_flex().w_full().h(CODE.head).pt(6).pr(6).pl(12).gap(8).items_center().justify_between()
      .rounded_t(8).bg(codeFill(t)).border_t(1).border_l(1).border_r(1).border_color(codeEdge(t))
      .child(div().min_w(0).truncate().font_family(mono).text_size(11).text_color(alpha(t.foreground, 0.72)).child(label))
      .child(copyIcon(view, id, t, isCopied)));
}

export function codeBody(block, height, editor, t, mono) {
  const plain = () => div().w_full().overflow_hidden().font_family(mono).text_size(CODE.size).line_height(`${CODE.line}px`).text_color(body(t))
    .children((block.text || " ").split("\n").map((line) => div().h(CODE.line).whitespace_nowrap().child(line || " ")));

  return div().w_full().h(height).pl(editor ? 7.8 : 14.4).pr(14.4).py(CODE.pad).rounded_b(8).bg(codeFill(t)).border_b(1).border_l(1).border_r(1).border_color(codeEdge(t))
    .child(div().w_full().h(block.text.split("\n").length * CODE.line).line_height(`${CODE.line}px`).child(editor ? Editor.new(editor) : plain()));
}

export function copyRow(view, id, t, isCopied) {
  return h_flex().w_full().h(26).pt(2).justify_end().cursor_pointer().child(copyIcon(view, id, t, isCopied));
}

export function htmlPreview(block, id, t) {
  return div().w_full().pt(6)
    .child(sans(div().w_full().p(12).rounded(8).border(1).border_color(alpha(t.border, 0.7)).line_height(LEADING)
      .child(TextView.html(id, `<div>${block.text}</div>`).text_size(BODY).text_color(body(t)))));
}
