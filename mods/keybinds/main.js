// Keybinds (a tab): every shortcut in keys.json, then each view's own keys from the
// help-keys.json files the views themselves read for their "?" panel.
// Opened from the command palette ("Keybinds") or keys.json.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { theme, keys, run, panes, spaces, appHome, readTextFile, settings } from "herdr";
import { keyRows, filterRows } from "./rows.js";

// The mods whose views carry a help-keys.json, in the order they are listed.
const VIEW_MODS = ["multirepo", "prs", "changes-multi", "jira", "blueprint"];
const ROW_HEIGHT = 28;

async function loadViews() {
  const views = [];
  for (const mod of VIEW_MODS) {
    try {
      views.push(...JSON.parse(await readTextFile(`${appHome()}/mods/${mod}/help-keys.json`)).views);
    } catch (error) {
      views.push({ title: `${mod}: could not read help-keys.json`, sections: [{ title: String(error.message ?? error), rows: [] }] });
    }
  }
  return views;
}

export default class Keybinds extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.ownTab = null; // learnt at the first layout: a pane is laid out only while its tab shows
    cx.timer.every(400, (cx) => this.claimKeyboard(cx));
    this.scroll = VirtualListScrollHandle.new();
    this.views = undefined;
    this.at = 0;
    // The "/" filter: esc leaves the box and keeps the filter; esc again clears it; then the tab closes.
    this.query = "";
    this.isTyping = false;
    this.input = InputState.new({ value: "" });
    this.input.on("change", (_e, cx) => {
      if (!this.isTyping) return;
      this.query = this.input.value().trim().toLowerCase();
      this.moveTo(this.firstKey());
      cx.notify();
    });
    this.input.on("blur", (_e, cx) => { this.isTyping = false; cx.notify(); });
    cx.spawn(async (cx) => { this.views = await loadViews(); this.at = this.firstKey(); cx.notify(); });
  }

  // The tab this pane is in: the shown one at its first layout (a pane is laid out only while
  // its tab shows; at init, focused() can still name the tab that was shown before).
  learnTab(cx) {
    if (this.ownTab) return;
    this.ownTab = spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id ?? null;
    this.onOwnTab?.(cx);
  }

  // Same as the PR review tab: take the keyboard when this pane becomes the focused one.
  claimKeyboard(cx) {
    const isPaneFocused = panes().some((p) => p.mod === "keybinds" && p.tab === this.ownTab && p.focused);
    const isNewlyFocused = isPaneFocused && !this.wasPaneFocused;
    this.wasPaneFocused = isPaneFocused;
    if (!isNewlyFocused || this.isTyping || this.handle.is_focused()) return;
    this.handle.focus();
    cx.notify();
  }

  rows() {
    return filterRows(keyRows(keys(), this.views ?? []), this.query);
  }

  firstKey() {
    return Math.max(0, this.rows().findIndex((r) => r.kind === "key"));
  }

  moveTo(index) {
    this.at = index;
    this.scroll.scroll_to_item(index);
  }

  // j/k step over key rows; titles are skipped.
  move(step) {
    const rows = this.rows();
    for (let i = this.at + step; i >= 0 && i < rows.length; i += step) {
      if (rows[i].kind === "key") return this.moveTo(i);
    }
  }

  key(e, cx) {
    const stroke = e.keystroke;
    if (this.isTyping) {
      if (stroke === "escape") { this.isTyping = false; this.handle.focus(); }
      else if (stroke === "down") this.move(1);
      else if (stroke === "up") this.move(-1);
      else return;
    } else if (stroke === "escape") {
      if (this.query) { this.query = ""; this.input.set_value(""); this.moveTo(this.firstKey()); }
      else run("pane.close");
    } else if (stroke === "/") {
      this.isTyping = true;
      cx.timer.after(0, () => this.input.focus());
    } else if (stroke === "j" || stroke === "down") this.move(1);
    else if (stroke === "k" || stroke === "up") this.move(-1);
    else if (stroke === "g") this.moveTo(this.firstKey());
    else if (stroke === "shift-g") this.moveTo(Math.max(0, this.rows().length - 1));
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  row(row, isSelected, t) {
    if (row.kind === "group") {
      return div().flex_none().h(ROW_HEIGHT).px(10).flex().items_end().pb(4).text_size(13).font_semibold().text_color(t.foreground).child(row.text);
    }
    if (row.kind === "section") {
      return div().flex_none().h(ROW_HEIGHT).px(10).flex().items_center().text_size(11.5).font_medium().text_color(t.dim).child(row.text);
    }
    return h_flex().flex_none().h(ROW_HEIGHT).px(10).gap(14).items_center().rounded(6)
      .when(isSelected, (el) => el.bg(t.selected))
      .when(!isSelected, (el) => el.hover((s) => s.bg(t.hover)))
      .child(div().flex_none().w(200).truncate().font_family(settings().font_family ?? "JetBrains Mono").text_size(12).text_color(t.accent).child(row.keys))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(row.what));
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const keyCount = rows.filter((r) => r.kind === "key").length;
    return v_flex().id("keybinds").on_size_change((_size, cx) => this.learnTab(cx)).track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .size_full().min_h(0).bg(t.surface).text_color(t.foreground)
      .child(h_flex().flex_none().px(16).h(48).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(14).child("Keybinds"))
        .child(div().text_size(12).text_color(t.muted).child(`${keyCount} keys${this.query ? ` matching "${this.query}"` : ""}`))
        .child(div().flex_1())
        .child(div().text_size(11.5).text_color(t.dim).child("keys.json changes show at once · views: mods/*/help-keys.json")))
      .when(this.isTyping || Boolean(this.query), (el) => el.child(div().px(16).pt(10).child(
        Input.new(this.input).h(30).px(10).items_center().rounded(6).border(1)
          .border_color(this.isTyping ? t.accent : t.input).bg(t.background).text_color(t.foreground))))
      .child(v_flex().relative().flex_1().min_h(0).px(12).py(8)
        .child(this.views === undefined
          ? div().p(8).text_color(t.muted).child("Loading…")
          : !rows.length
            ? div().p(8).text_color(t.dim).child(`Nothing matches "${this.query}".`)
            : v_virtual_list("keybinds-list", rows.length, ROW_HEIGHT, (i) => rows[i].id,
              (range) => rows.slice(range.start, range.end).map((row, k) => this.row(row, range.start + k === this.at, t)))
                // Rows of a virtual list cannot hold handlers; the list reports which was clicked.
                .on_item_click((id, cx) => {
                  const index = this.rows().findIndex((r) => r.id === id);
                  if (this.rows()[index]?.kind === "key") this.moveTo(index);
                  cx.notify();
                })
                .track_scroll(this.scroll)
                .size_full())
        .child(Scrollbar.vertical("keybinds-list").absolute().inset_0()))
      .child(div().flex_none().px(16).py(8).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child("j/k move · g / G top / bottom · / search · esc: leave search, clear it, close the tab"));
  }
}
