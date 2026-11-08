// The notification history (a popup the status bar's bell opens): every notification the mods
// posted through notifyAndLog and every agent alert (status-accounts records those), newest first.
// Opening it marks them read; a click runs what the notification's own click would (go to the
// agent, open the PR) and closes the popup.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, shared, setShared } from "herdr";
import { NOTIFICATIONS, HISTORY_CLOSED } from "./notifylog.js";

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };

// "now", "5m", "3h", "2d" since an ISO time.
function age(iso, now = Date.now()) {
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export default class Notifications extends View {
  close() { setShared(HISTORY_CLOSED, Date.now()); }

  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    const all = shared(NOTIFICATIONS) ?? [];
    this.unreadIds = new Set(all.filter((entry) => !entry.isRead).map((entry) => entry.id)); // still marked while it shows
    if (this.unreadIds.size) setShared(NOTIFICATIONS, all.map((entry) => (entry.isRead ? entry : { ...entry, isRead: true })));
  }

  open(entry) {
    if (entry.action?.name) run(entry.action.name, entry.action.args ?? {});
    closeOverlay(props()?.overlay);
  }

  row(entry, t) {
    const isNew = this.unreadIds.has(entry.id);
    return h_flex().id(`n-${entry.id}`).w_full().px(12).py(8).gap(10).items_start().rounded(7)
      .when(Boolean(entry.action), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
      .when(isNew, (el) => el.bg(t.selected))
      .on_click(() => this.open(entry))
      .child(div().mt(5).size(8).flex_none().rounded(4).bg(t[DOT[entry.level] ?? "accent"]))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(entry.title))
        .when(Boolean(entry.body), (el) => el.child(div().text_size(12).text_color(t.muted).child(entry.body)))
        .child(div().text_size(11).text_color(t.dim).child(`${entry.source} · ${age(entry.at)}`)));
  }

  render() {
    const t = theme();
    const all = shared(NOTIFICATIONS) ?? [];
    return v_flex().id("notifications").track_focus(this.handle).w(400).h(480).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { closeOverlay(props()?.overlay); cx.stop_propagation(); }
      })
      .child(h_flex().flex_none().h(40).px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/notifications/icons/bell.svg").size(14).text_color(t.muted))
        .child(div().flex_1().text_size(13).font_semibold().child("Notifications"))
        .when(all.length > 0, (el) => el.child(div().id("clear").h(24).px(8).flex().items_center().rounded(6).cursor_pointer()
          .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { setShared(NOTIFICATIONS, []); cx.notify(); })
          .child("Clear all"))))
      .child(all.length
        ? v_flex().id("notification-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2).children(all.map((entry) => this.row(entry, t)))
        : div().flex_1().flex().items_center().justify_center().text_size(12.5).text_color(t.dim).child("No notifications yet"));
  }
}
