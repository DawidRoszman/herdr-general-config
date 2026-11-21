import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, props, updates, layout, shared, spaces, window, settings } from "herdr";
import { tip, glow } from "./tip.js";
import { stopsInit, stopsEnd, stop, focusRoot } from "./focus.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const inboxShown = () => find(layout(), "sidebar-lists")?.active === "inbox";
export default class WorkspaceChrome extends View {
  async close() { stopsEnd(this); }

  init(_props, cx) {
    stopsInit(this, cx);
  }

  render() {
    const t = theme();
    const lit = (id, color = t.dim) => (this.hot === id ? t.foreground : color);
    if (props()?.footer) {

      const ready = updates().app.ready;

      const n = shared("t3-inbox.notice");

      const notice = n && Date.now() - n.at < 6000 && h_flex().id(`undo-notice-${n.gen}`).flex_1().min_w(0).h(24).justify_end().gap(4).items_center()
        .text_size(11).text_color(t.dim).opacity(n.shown ? 1 : 0).transition("opacity", { duration: 200, easing: "ease-out" })
        .child(div().min_w(0).truncate().child(`${n.action}${n.count === 1 ? "" : ` ${n.count}`},`))

        .child(h_flex().id("undo-notice-undo").flex_none().h(24).items_center().font_medium().text_color(t.foreground)
          .when(n.live && Date.now() - n.at < 5000, (el) => el.hover((s) => s.underline()).role("button").accessibility_label(`Undo: ${n.action} ${n.count} agent${n.count === 1 ? "" : "s"}`)
            .on_click(() => run("t3-tabs.undo")))
          .child("Undo")
          .when(n.live && Date.now() - n.at < 5000, (el) => stop(this, t, "undo-notice-undo", el, 4)));
      const button = (id, glyph, label, action, key) => tip(this, t, id, label, stop(this, t, id, div().id(id).size(32).flex_none().flex().items_center().justify_center().rounded(8)
        .text_color(lit(id)).hover(s => s.bg(t.hover)).on_hover(glow(this, id))
        .role("button").accessibility_label(label)

        .on_click((_e, cx) => { this.hot = null; action(); cx.notify(); })
        .child(glyph), 8), { action: key });

      return focusRoot(this, div().size_full().bg(t.chrome).px(8).pt(4).child(h_flex().h(32).gap(4).items_center()
        .child(button("settings", svg("mods/t3-chrome/icons/settings.svg").size(16), "Settings", () => run("app.settings"), "app.settings"))
        .child(button("add-machine", svg("mods/t3-chrome/icons/server.svg").size(16), "Add machine", () => run("mod.open", { name: "machine-add" })))
        .child(notice || div().flex_1())
        .when(Boolean(ready), el => el.child(tip(this, t, "app-update", `Update ${ready} downloaded. Click to restart`, stop(this, t, "app-update", div().id("app-update").h(32).px(12).flex_none().flex().items_center()
          .rounded_full().bg(t.accent + "26").text_size(12).text_color(t.accent).hover(s => s.bg(t.accent + "40")).on_hover(glow(this, "app-update"))
          .role("button").accessibility_label(`Restart into Herdr ${ready}`)
          .on_click(() => run("app.update")).child("Update"), 16))))));
    }

    const inbox = inboxShown(), w = window();

    const left = w?.platform === "macos" && !w?.fullscreen ? (68 + 16 - 2) / (settings().zoom || 1) - 6 : 8, on = this.hot === "home"

      || spaces().some((s) => s.active && s.id === shared("t3-home.space"));
    return focusRoot(this, h_flex().id("brand").size_full().bg(t.chrome).pl(left).pr(8).items_center()
      .child(stop(this, t, "home", h_flex().id("home").h(28).min_w(0).px(6).gap(8).items_center().rounded(8)
        .text_size(14).font_medium().text_color(on ? t.foreground : t.muted).hover(s => s.bg(t.hover)).on_hover(glow(this, "home"))
        .role("button").accessibility_label("Home")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("t3-tabs.home"))
        .child(image("frame/welcome/herdr.png").size(20).flex_none().rounded(5).opacity(on ? 1 : 0.7))
        .child(div().min_w(0).truncate().child("Herdr")), 8))
      .child(div().flex_1())

      .child(tip(this, t, "sidebar-mode", inbox ? "Show lists" : "Show inbox", stop(this, t, "sidebar-mode", div().id("sidebar-mode").size(28).flex_none().flex().items_center().justify_center().rounded(8)
        .text_color(lit("sidebar-mode")).hover(s => s.bg(t.hover)).on_hover(glow(this, "sidebar-mode"))
        .role("button").accessibility_label(inbox ? "Show lists" : "Show inbox")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("t3-tabs.sidebar"))

        .child(svg(`mods/t3-chrome/icons/${inbox ? "layout-list" : "inbox"}.svg`).size(14)), 8), { action: "t3-tabs.sidebar", below: true }))
      .child(tip(this, t, "sidebar-toggle", "Hide sidebar", stop(this, t, "sidebar-toggle", div().id("sidebar-toggle").size(28).flex_none().flex().items_center().justify_center().rounded(8)
        .text_color(lit("sidebar-toggle")).hover(s => s.bg(t.hover)).on_hover(glow(this, "sidebar-toggle"))
        .role("button").accessibility_label("Hide sidebar")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())

        .on_click(() => { this.hot = null; run("layout.toggle", { id: "sidebar" }); })
        .child(svg("mods/t3-chrome/icons/panel-left.svg").size(14)), 8), { action: "layout.toggle:sidebar", below: true })));
  }
}
