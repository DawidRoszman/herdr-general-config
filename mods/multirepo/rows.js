// The rows the Projects tab and the multirepo dialog both draw, so they look alike: a task, one of a
// task's repos, and a plain item (a machine, a project, a repo to pick). Drawing only: no IO, no state.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { settings } from "herdr";
import { changeBadge, baseLabel, prLabel } from "./view.js";

const ICONS = "mods/prs/icons";
export const TASK_ROW = 58;
export const REPO_ROW = 44;
export const ITEM_ROW = 34;
const TREE_STEP = 18; // a stack layer's indent under the one it builds on

export const icon = (name, size, color) => svg(`${ICONS}/${name}.svg`).size(size).flex_none().text_color(color);

// "feat/SHOP-110-search-filters" -> { ticket: "SHOP-110", rest: "search filters" }
export function branchParts(branch) {
  const m = branch.match(/^(?:[a-z]+\/)?([A-Z][A-Z0-9]*-\d+)-?(.*)$/);
  return m ? { ticket: m[1], rest: m[2].replace(/-/g, " ") } : { ticket: "", rest: branch.replace(/^[a-z]+\//, "").replace(/-/g, " ") };
}

// task: one of stackOrder's (its depth draws it under the layer it builds on, as the sidebar nests spaces).
// short: a repo's short name (mr ls's "shorts"). isOpen: a space already works in the task's folder.
// chipColor: the repo chips' background, one that stands out from what the row sits on.
export function taskRow(task, { isSelected, isOpen, short, chipColor = null }, t) {
  const { ticket, rest } = branchParts(task.branch);
  const status = task.status ?? [];
  const isDirty = status.some((s) => s.dirty);
  const unpushed = status.reduce((n, s) => n + s.unpushed, 0);
  const depth = task.depth ?? 0;
  return v_flex().flex_none().h(TASK_ROW).pl(10 + Math.max(0, depth - 1) * TREE_STEP).pr(10).py(7).gap(4).rounded(8).cursor_pointer()
    .when(isSelected, (el) => el.bg(t.selected))
    .when(!isSelected, (el) => el.hover((s) => s.bg(t.hover)))
    .child(h_flex().h(18).gap(6).items_center().min_w(0)
      // An elbow from the layer below, drawn rather than typed so no font can break it.
      .when(depth > 0, (el) => el.child(div().flex_none().w(TREE_STEP - 6).h(9).mb(7).border_l(1).border_b(1).border_color(t.dim)))
      .child(icon(task.stack?.length ? "stack" : "branch", 13, isDirty ? t.working : t.dim))
      .when(Boolean(ticket), (el) => el.child(div().flex_none().text_size(12.5).font_semibold().text_color(t.accent).child(ticket)))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(rest || task.branch))
      .when(isOpen, (el) => el.child(div().flex_none().size(6).rounded_full().bg(t.accent)))
      .when(isDirty, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.working).child("● changes")))
      .when(unpushed > 0, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.ansi4).child(`↑${unpushed}`))))
    .child(h_flex().h(16).pl(19 + (depth > 0 ? TREE_STEP : 0)).gap(6).items_center().overflow_hidden()
      .children(task.repos.map((name) => div().flex_none().px(6).h(16).flex().items_center().rounded(4)
        .bg(isSelected ? t.background : chipColor ?? t.raised).text_size(10.5).text_color(t.muted).child(short(name)))));
}

// onOpenPr: makes the PR chip a button (rows of a virtual list can't hold handlers, so the dialog leaves it out).
export function repoRow(repo, taskBranch, { short, onOpenPr = null }, t) {
  const pr = repo.pr;
  const prLook = !pr ? null : pr.state === "MERGED" ? ["merge", t.ansi5] : pr.state === "CLOSED" ? ["pull-request-closed", t.blocked] : pr.isDraft ? ["pull-request-draft", t.dim] : ["pull-request", t.done];
  const badge = changeBadge(repo);
  const prChip = () => {
    const chip = h_flex().flex_none().h(26).px(8).gap(6).items_center().rounded(6).bg(t.raised)
      .child(icon(prLook[0], 13, prLook[1]))
      .child(div().text_size(12).text_color(t.foreground).child(prLabel(pr).replace(/^PR /, "")));
    if (!onOpenPr) return chip;
    return chip.id(`repo-pr-${repo.name}`).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`${pr.title} · open on GitHub`)
      .on_click((_e, cx) => onOpenPr(cx, repo))
      .child(icon("external", 11, t.dim));
  };
  return h_flex().flex_none().h(REPO_ROW).px(12).gap(10).items_center().rounded(8).border(1).border_color(t.border).bg(t.background)
    .child(icon("repo", 15, t.dim))
    .child(v_flex().w(170).flex_shrink(1).min_w(60)
      .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(short(repo.name)))
      .child(div().truncate().text_size(11).text_color(t.dim).child(baseLabel(repo, taskBranch))))
    .child(div().flex_1().min_w(0).truncate().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .text_color(badge ? (repo.dirty ? t.working : t.muted) : t.dim).child(badge || "clean"))
    .when(Boolean(pr), (el) => el.child(prChip()))
    .when(!pr, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child("no PR yet")));
}

// A machine, a project or a repo to pick. iconName null draws an empty ring (a repo not ticked).
export function itemRow({ iconName, iconColor, label, detail, isSelected, isDim = false, labelWidth = 150 }, t) {
  return h_flex().flex_none().h(ITEM_ROW).px(10).gap(10).items_center().rounded(8).cursor_pointer()
    .when(isSelected, (el) => el.bg(t.selected))
    .when(!isSelected, (el) => el.hover((s) => s.bg(t.hover)))
    .child(iconName ? icon(iconName, 14, iconColor ?? t.dim) : div().flex_none().size(14).rounded_full().border(1).border_color(t.dim))
    .child(div().flex_none().w(labelWidth).truncate().text_size(13).font_semibold().text_color(isDim ? t.dim : t.foreground).child(label))
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(detail));
}
