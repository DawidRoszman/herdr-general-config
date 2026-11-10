// The reviewer picker drawn over the review tab, for the shown PR: its requested reviewers come
// ticked, then those who reviewed already (ticking one re-requests their review), then everyone
// who can review in its repo. j/k move, space/x/click tick, / searches
// (enter there ticks), enter sends the changes, esc cancels.

import { div } from "gpui-kit";
import { v_flex, h_flex, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { Search } from "./search.js";
import { requestedLogins, reviewerChoices, reviewerChanges, reviewVerdicts } from "./model.js";

const ROW_HEIGHT = 28;

export class ReviewerPicker {
  // Needs live host calls (input and scroll state), so it is made in a handler, never in render.
  constructor(pr, onSubmit) {
    this.pr = pr;
    this.onSubmit = onSubmit;
    this.requested = requestedLogins(pr);
    this.verdicts = reviewVerdicts(pr); // who reviewed already: ticking them asks again
    this.ticked = new Set(this.requested);
    this.choices = null; // null while the repo's people load
    this.error = "";
    this.at = 0;
    this.scroll = VirtualListScrollHandle.new();
    this.search = new Search({ onChange: () => this.moveTo(0), onSubmit: () => this.toggle(this.shown()[this.at]) });
  }

  setCandidates(candidates) {
    this.choices = reviewerChoices(candidates, this.pr);
  }

  shown() {
    return (this.choices ?? []).filter((login) => login.toLowerCase().includes(this.search.query));
  }

  changes() {
    return reviewerChanges(this.requested, this.ticked);
  }

  moveTo(index) {
    this.at = index;
    this.scroll.scroll_to_item(index);
  }

  move(step) {
    const count = this.shown().length;
    if (count) this.moveTo((this.at + step + count) % count);
  }

  toggle(login) {
    if (!login) return;
    if (this.ticked.has(login)) this.ticked.delete(login);
    else this.ticked.add(login);
  }

  // "close", "submit", true when the key was used, false to let it through (typing in the search).
  // Keys it doesn't know are used up, so review actions (m, d, …) never fire under the picker.
  key(stroke, ownerHandle, cx) {
    if (this.search.isTyping) {
      if (stroke === "escape") this.search.escape(ownerHandle);
      else if (stroke === "down") this.move(1);
      else if (stroke === "up") this.move(-1);
      else return false;
      return true;
    }
    if (stroke === "escape") return this.search.escape(ownerHandle) ? true : "close";
    if (stroke === "enter") return "submit";
    if (stroke === "j" || stroke === "down") this.move(1);
    else if (stroke === "k" || stroke === "up") this.move(-1);
    else if (stroke === "space" || stroke === "x") this.toggle(this.shown()[this.at]);
    else if (stroke === "/") this.search.open(cx);
    return true;
  }

  row(login, isSelected, t) {
    const isTicked = this.ticked.has(login);
    return h_flex().id(`reviewer-${login}`).w_full().h(ROW_HEIGHT).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(isSelected, (el) => el.bg(t.selected))
      .when(!isSelected, (el) => el.hover((s) => s.bg(t.hover)))
      .child(div().flex_none().w(16).h(16).rounded(4).border(1).border_color(isTicked ? t.accent : t.input)
        .when(isTicked, (el) => el.bg(t.accent)).flex().items_center().justify_center()
        .child(div().text_size(11).text_color(t.accent_foreground).child(isTicked ? "✓" : "")))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(login))
      .when(this.requested.includes(login) || Boolean(this.verdicts[login]), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim)
        .child(this.requested.includes(login) ? "requested" : `${this.verdicts[login]} · tick to re-request`)));
  }

  render(t) {
    const shown = this.shown();
    const { add, remove } = this.changes();
    const status = this.error || (this.choices === null ? "Loading who can review…" : shown.length ? "" : "Nobody matches.");
    return div().absolute().inset_0().flex().items_center().justify_center().bg(`${t.background}cc`).p(12)
      .child(v_flex().id("pr-reviewers").w(380).h(440).max_h_full().p(14).gap(8).rounded(10)
        .bg(t.popover).border(1).border_color(t.border).shadow_lg()
        .child(h_flex().justify_between().items_center()
          .child(div().text_size(13).font_semibold().text_color(t.foreground).child(`Reviewers · ${this.pr.short} #${this.pr.number}`))
          .child(div().text_size(11).text_color(t.dim).child(add.length || remove.length ? `+${add.length} −${remove.length}` : "")))
        .when(this.search.isShown, (el) => el.child(Input.new(this.search.input).h(28).px(8).items_center().rounded(6).border(1)
          .border_color(this.search.isTyping ? t.accent : t.input).bg(t.background).text_color(t.foreground).text_size(12)))
        .child(status
          ? div().flex_1().text_size(12).text_color(this.error ? t.blocked : t.dim).child(status)
          : v_flex().relative().flex_1().min_h(0)
            .child(v_virtual_list("pr-reviewer-list", shown.length, ROW_HEIGHT, (i) => shown[i], (range) => shown.slice(range.start, range.end).map((login, k) => this.row(login, range.start + k === this.at, t)))
              .on_item_click((login, cx) => {
                this.at = Math.max(0, shown.indexOf(login));
                this.toggle(login);
                cx.notify();
              })
              .track_scroll(this.scroll)
              .size_full())
            .child(Scrollbar.vertical("pr-reviewer-list").absolute().inset_0()))
        .child(h_flex().justify_between().items_center()
          .child(div().text_size(11).text_color(t.dim).child("space tick · / search · enter save · esc cancel"))
          .child(div().id("pr-reviewers-save").px(10).h(26).flex().items_center().rounded(6).cursor_pointer().bg(t.solid).hover((s) => s.opacity(0.88))
            .on_click((_e, cx) => { this.onSubmit(cx); cx.notify(); })
            .child(div().text_size(12).text_color(t.solid_foreground).child("Save")))));
  }
}
