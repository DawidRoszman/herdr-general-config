// The conversation's rows other than the reply's Markdown, drawn as T3 Code's timeline draws them
// (MessagesTimeline.tsx, TimelineUserMessageRow.tsx, TimelineWorkEntryRow.tsx). Each function
// returns one row's content at the lane's width, with the space under it that T3's row has.
// ctx: { t, mono, p (an id prefix), now (seconds), images (key -> path), copied (row id),
// hovered (the row id under the pointer), folder }.

import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { typedMarkdown, formatElapsed, entryLabel, toolDetail, editDiff, shortPath } from "./model.js";
import { sans, alpha, nested } from "./render-md.js";

const icon = (name, size, color) => svg(`mods/t3-chat/icons/${name}.svg`).size(size).flex_none().text_color(color);
const LEADING = "22.75px"; // text-sm leading-relaxed
// The time as 14:05 (the runtime's toLocaleTimeString takes no options).
const clock = (at) => { const d = new Date(at * 1000); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };

function thumbs(pictures, images, t) {
  return h_flex().gap(8).flex_wrap().justify_end().children(pictures.map((picture) => (images.get(picture.key)
    ? image(images.get(picture.key)).max_w(320).max_h(240).rounded(16)
    : h_flex().px(8).h(24).gap(6).items_center().rounded(8).border(1).border_color(alpha(t.border, 0.8))
      .child(icon("file-text", 12, t.dim)).child(div().text_size(11).text_color(t.dim).child("image")))));
}

// The copy control of a row: a check for a moment after (T3's MessageCopyButton).
const copyMark = (ctx, id) => icon(ctx.copied === id ? "check" : "copy", 12, ctx.copied === id ? ctx.t.done : ctx.t.muted);

// The person's message: a bubble at the right, at most 80% of the lane, rounded-2xl on T3's
// message surface; under it the time and copy, shown while the pointer is on the row; pb-4.
export function userRow(row, ctx, lane) {
  const { t } = ctx;
  return v_flex().w_full().items_end().gap(4).pb(16)
    .when(row.images.length > 0, (el) => el.child(thumbs(row.images, ctx.images, t)))
    .when(Boolean(row.text), (el) => el.child(sans(div().max_w(lane * 0.8).px(12).py(12).rounded(16).bg(alpha(t.foreground, 0.07)).line_height(LEADING)
      .when(Boolean(row.isPending), (bubble) => bubble.opacity(0.6))
      .child(TextView.markdown(`${ctx.p}u-${row.id}`, typedMarkdown(row.text)).text_size(14).text_color(t.foreground).selectable(true)))))
    .child(h_flex().h(20).pr(4).gap(8).items_center().opacity(ctx.hovered === row.id ? 1 : 0)
      .child(sans(div().text_size(12).text_color(t.muted).child(row.at ? clock(row.at) : "")))
      .child(copyMark(ctx, row.id)));
}

// "Worked for 51s ›": a run of tool calls and thinking, folded (T3's turn fold). Ruled under at
// 60% of the border; 14px muted, tabular; open, its entries follow. Live, it counts from
// the turn's start (T3's working timer) and shimmers.
export function foldRow(row, ctx, isOpen) {
  const { t } = ctx;
  const label = row.isLive ? `Working for ${formatElapsed(ctx.now - row.turnStartedAt)}` : `Worked for ${formatElapsed(row.endedAt - row.startedAt)}`;
  const words = sans(div().text_size(14).line_height(LEADING).text_color(t.muted).child(label));
  return div().w_full().pb(isOpen ? 2 : 6).cursor_pointer()
    .child(h_flex().w_full().pt(4).pb(8).px(4).gap(4).items_center().border_b(1).border_color(alpha(t.border, 0.6)).hover((s) => s.text_color(t.foreground))
      .child(row.isLive ? words.loop("opacity", { from: 0.5, to: 1, period: 1400 }) : words)
      .child(icon(isOpen ? "chevron-down" : "chevron-right", 14, t.muted)));
}

// T3's diff colours (--diff-addition / --diff-deletion): the theme's green and red.
const added = (t) => t.ansi2;
const removed = (t) => t.ansi1;

// +12 -3, mono, as T3's DiffStatLabel.
function diffStat(file, t, mono) {
  return h_flex().flex_none().gap(6).font_family(mono).text_size(12)
    .when(file.additions > 0, (el) => el.child(div().text_color(added(t)).child(`+${file.additions}`)))
    .when(file.deletions > 0, (el) => el.child(div().text_color(removed(t)).child(`-${file.deletions}`)));
}

// An edit as a unified diff: mono 12px lines on the code surface, added and removed lines tinted
// with a marker column. No word-level or syntax colours (the Changes panel has those).
const DIFF_SHOWN = 80;
export function diffBlock(diff, ctx) {
  const { t, mono } = ctx;
  const shown = diff.lines.slice(0, DIFF_SHOWN);
  return v_flex().w_full().py(6).rounded(8).bg(alpha(t.foreground, 0.035)).overflow_hidden().font_family(mono).text_size(12).line_height("18px")
    .children(shown.map((line) => (line.type === "@" ? div().h(1).my(4).bg(alpha(t.border, 0.6))
      : h_flex().w_full().items_start()
        .when(line.type === "+", (el) => el.bg(alpha(added(t), 0.14)))
        .when(line.type === "-", (el) => el.bg(alpha(removed(t), 0.14)))
        .child(div().w(24).flex_none().text_center().text_color(line.type === "+" ? added(t) : line.type === "-" ? removed(t) : t.dim).child(line.type === " " ? " " : line.type))
        .child(div().flex_1().min_w(0).pr(10).text_color(alpha(t.foreground, line.type === " " ? 0.7 : 0.95)).child(line.text || " ")))))
    .when(diff.lines.length > shown.length, (el) => el.child(div().px(12).pt(4).text_color(t.dim).child(`… ${diff.lines.length - shown.length} more lines`)));
}

// The files a turn changed (ChangedFilesTree.tsx): a card on T3's secondary surface, rounded-lg,
// 16px above; its header "2 changed files +12 -3" at 12px medium and "Open diff"; then a 28px
// row per file. Shown as a flat list of paths, not T3's tree. The card opens the Changes panel.
export function changedRow(row, ctx) {
  const { t, mono } = ctx;
  const total = row.files.reduce((sum, f) => ({ additions: sum.additions + f.additions, deletions: sum.deletions + f.deletions }), { additions: 0, deletions: 0 });
  return div().w_full().pt(16).pb(8).cursor_pointer()
    .child(v_flex().w_full().rounded(8).bg(alpha(t.foreground, 0.035))
      .child(sans(h_flex().w_full().px(12).py(8).gap(12).items_center().text_size(12).line_height("16px").font_weight(500).text_color(t.foreground)
        .child(div().flex_none().child(`${row.files.length} changed file${row.files.length === 1 ? "" : "s"}`))
        .child(diffStat(total, t, mono))
        .child(div().flex_1())
        .child(div().flex_none().px(6).py(2).rounded(6).text_color(t.muted).hover((s) => s.bg(t.hover)).child("Open diff"))))
      .child(v_flex().w_full().px(12).pb(8).children(row.files.map((file) => {
        const path = shortPath(file.path, ctx.folder);
        const cut = path.lastIndexOf("/") + 1;
        return sans(h_flex().w_full().h(28).pr(8).gap(8).items_center().rounded(6).text_size(13).hover((s) => s.bg(alpha(t.foreground, 0.05)))
          .child(icon("file-text", 14, alpha(t.muted, 0.75)))
          .child(h_flex().flex_1().min_w(0)
            .child(div().min_w(0).truncate().text_color(t.muted).child(path.slice(0, cut)))
            .child(div().flex_none().text_color(t.foreground).child(path.slice(cut))))
          .child(diffStat(file, t, mono)));
      }))));
}

// One tool call or thought of an open group: a 16px icon in a 24px column, what was done at 14px,
// and to what, muted, on one line; open, its detail 28px in (T3's `ms-7`).
export function entryRow(entry, ctx, isOpen) {
  const { t, mono } = ctx;
  const { icon: name, heading, detail } = entryLabel(entry);
  const mark = entry.status === "running" ? icon("spinner", 14, t.muted).spin(900)
    : entry.status === "error" ? icon("x", 14, t.blocked) : icon(name, 16, t.muted);
  const body = () => {
    if (entry.kind === "thinking") return sans(div().line_height(LEADING).child(TextView.markdown(`${ctx.p}th-${entry.id}`, entry.text).text_size(14).text_color(alpha(t.foreground, 0.8))));
    const diff = editDiff(entry);
    if (diff) return diffBlock(diff, ctx);
    if (entry.name !== "Bash") return div().child(TextView.markdown(`${ctx.p}tool-${entry.id}`, toolDetail(entry)).text_size(12));
    // A command and what it printed, as T3's CommandOutputPanel: mono 12px on the code surface.
    const lines = [`$ ${entry.input.command ?? entry.title}`, ...(entry.output ? entry.output.split("\n") : [])];
    const shown = lines.slice(0, 60);
    return v_flex().w_full().px(12).py(10).rounded(8).bg(alpha(t.foreground, 0.035)).overflow_hidden()
      .font_family(mono).text_size(12).line_height("18px").text_color(entry.status === "error" ? t.blocked : alpha(t.foreground, 0.8))
      .children(shown.map((line, i) => div().w_full().when(i === 0, (el) => el.text_color(t.foreground)).child(line || " ")))
      .when(lines.length > shown.length, (el) => el.child(div().text_color(t.dim).child(`… ${lines.length - shown.length} more lines`)));
  };
  return v_flex().w_full().cursor_pointer()
    .child(h_flex().w_full().min_h(24).px(4).items_center().rounded(6).hover((s) => s.bg(alpha(t.foreground, 0.04)))
      .child(h_flex().w(24).flex_none().items_center().child(mark))
      .child(sans(h_flex().flex_1().min_w(0).gap(6).items_center().text_size(14).line_height(LEADING)
        .child(div().flex_none().text_color(alpha(t.foreground, 0.8)).child(heading))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(detail ?? ""))
        .when(Boolean(editDiff(entry)), (el) => el.child(diffStat(editDiff(entry), t, mono))))))
    .when(isOpen, (el) => el.child(div().w_full().pl(32).pr(4).pt(4).pb(8).child(body())))
    .when((entry.images ?? []).length > 0 && isOpen, (el) => el.child(div().pl(32).pb(8).child(thumbs(entry.images, ctx.images, t))));
}

// After a finished turn: how long it took, and copy the reply (T3's assistant meta, shown while the
// pointer is on the row). pb-4.
export function metaRow(row, ctx) {
  const { t } = ctx;
  return div().w_full().pt(6).pb(16).cursor_pointer()
    .child(h_flex().h(20).px(4).gap(8).items_center().opacity(ctx.hovered === row.id ? 1 : 0)
      .child(copyMark(ctx, row.id))
      .child(sans(div().text_size(12).text_color(t.muted).child(formatElapsed(row.endedAt - row.startedAt)))));
}

// While Claude works and no group is live: T3's working row.
export function workingRow(row, ctx) {
  const { t } = ctx;
  return div().w_full().pb(6)
    .child(h_flex().w_full().pt(4).pb(8).px(4).border_b(1).border_color(alpha(t.border, 0.6))
      .child(sans(div().text_size(14).line_height(LEADING).text_color(t.muted).child(row.startedAt ? `Working for ${formatElapsed(ctx.now - row.startedAt)}` : "Working..."))
        .loop("opacity", { from: 0.5, to: 1, period: 1400 })));
}

// T3's system divider: a label between two rules, 12px.
export function dividerRow(label, ctx) {
  const { t } = ctx;
  return h_flex().w_full().gap(12).py(4).pb(16).items_center()
    .child(div().h(1).flex_1().bg(alpha(t.border, 0.6)))
    .child(sans(div().text_size(12).text_color(t.muted).child(label)))
    .child(div().h(1).flex_1().bg(alpha(t.border, 0.6)));
}

// What a slash command printed.
export function noticeRow(row, ctx) {
  const { t, mono } = ctx;
  return div().w_full().pb(16).child(div().px(10).py(6).rounded(8).bg(alpha(t.foreground, 0.035)).font_family(mono).text_size(12).line_height("18px").text_color(t.muted).child(row.text));
}

// A plan Claude proposes (ProposedPlanCard.tsx): a rounded-2xl card, bordered, 16px inside; its
// title row, then the plan's Markdown, folded to 416px with a fade until opened. The row toggles it.
const PLAN_FOLD = 416;
export function planRow(row, ctx, isOpen) {
  const { t } = ctx;
  const isLong = row.text.split("\n").length > 18;
  return div().w_full().pb(16).when(isLong, (el) => el.cursor_pointer())
    .child(v_flex().w_full().p(16).gap(16).rounded(16).border(1).border_color(alpha(t.border, 0.8)).bg(alpha(t.foreground, 0.03))
      .child(sans(h_flex().gap(8).items_center().text_size(14).font_weight(500).text_color(t.foreground).child(icon("file-text", 16, t.muted)).child("Proposed plan")))
      .child(div().w_full().relative().when(isLong && !isOpen, (el) => el.max_h(PLAN_FOLD).overflow_hidden())
        .child(nested(row.text, `${ctx.p}plan-${row.id}`, t)))
      .when(isLong, (el) => el.child(h_flex().w_full().justify_center()
        .child(sans(div().px(10).py(4).rounded(8).text_size(12).font_weight(500).text_color(t.muted).hover((s) => s.bg(t.hover)).child(isOpen ? "Show less" : "Show more"))))));
}
