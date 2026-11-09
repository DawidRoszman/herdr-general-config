// The Herdr T3 tab bar's right side: Files, Changes and Pull requests toggles, each showing the
// layout's `panel` column on that child of `panel-body` (or hiding it when it is the one shown),
// and the notification bell. The work layout's status bar keeps the bell's history there; this
// layout has no status bar, so this mod does: blocked agents go into it, as status-accounts does.
// Its block is always shown, so it also takes the layout's keys (keys.json `t3-panels.<command>`):
// files, changes, prs (toggle that panel), new-space and new-tab (T3's pickers, as the sidebar's buttons),
// github (the focused pane's repo on GitHub, github.js), reveal (its folder in Finder, reveal.js).
// And, as the work layout's tab bar does, it moves a new tab to the end of its space (tab-order.js).

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, focused, keys, layout, machines, nextCommand, notify, openOverlay, run, spaces, theme } from "herdr";
import { logAgentAlerts, toggleHistory, unreadCount } from "./notifylog.js";
import { newTabsToEnd } from "./tab-order.js";
import { openRepoOnGitHub } from "./github.js";
import { revealInFileManager } from "./reveal.js";

const PANELS = [
  { id: "files", label: "Files", icon: "mods/t3-files/file.svg" },
  { id: "changes", label: "Changes", icon: "mods/changes/changes.svg" },
  { id: "prs", label: "Pull requests", icon: "mods/prs/icons/pull-request.svg" },
];

const find = (node, id) => {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
};

const NEW_MENU = "t3-new-menu";
const KEY_SYMBOLS = { cmd: "⌘", alt: "⌥", shift: "⇧", ctrl: "⌃" };

// " · ⌘⌥F" when a key runs this mod's command, so a tooltip follows keys.json.
function keyHint(command) {
  const bound = keys().find((k) => k.action === `t3-panels.${command}`);
  if (!bound) return "";
  const parts = bound.keys.split("-");
  return ` · ${parts.map((p, i) => (i < parts.length - 1 ? KEY_SYMBOLS[p] ?? p : p.toUpperCase())).join("")}`;
}

function isPanelShown(id) {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  return Boolean(panel && !panel.hidden && body?.active === id);
}

// As t3-spaces' New space: with other machines, T3's menu asks which one first.
function newSpace() {
  if (machines().length > 1) openOverlay({ mod: NEW_MENU, kind: "popup", frame: "none", at: /** @type {any} */ ("top"), offset: 96, width: 576, height: 420, props: { pick: true } });
  else run("space.new");
}

const COMMANDS = {
  ...Object.fromEntries(PANELS.map(({ id }) => [id, () => toggle(id, isPanelShown(id))])),
  "new-space": newSpace,
  "new-tab": () => run("mod.open", { name: NEW_MENU }), // pick the space, then a new tab there
  reveal: () => {
    const at = focused();
    revealInFileManager(at?.cwd, spaces().find((s) => s.id === at?.space)?.machine ?? null);
  },
  github: (cx) => openRepoOnGitHub(cx).catch((error) => notify({ title: "Open on GitHub", body: String(error.message ?? error), level: "error" })),
};

function toggle(id, isShown) {
  if (isShown) return run("layout.hide", { id: "panel" });
  run("layout.select", { stack: "panel-body", child: id });
  run("layout.show", { id: "panel" });
}

export default class T3Panels extends View {
  init(_props, cx) {
    this.agentStatuses = null; // address -> status at the last look; null before the first
    cx.timer.every(1500, () => { this.agentStatuses = logAgentAlerts(agents(), this.agentStatuses); });
    cx.spawn(async (cx) => {
      for (;;) {
        COMMANDS[String(await nextCommand()).replace(/^t3-panels\./, "")]?.(cx);
        cx.notify();
      }
    });
  }

  bell(t) {
    const unread = unreadCount();
    return h_flex().id("bell").h(24).px(6).gap(4).flex_none().items_center().rounded(8).border(1).border_color(t.border)
      .text_color(unread ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(unread ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications")
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation(); // the block drags the window
        this.bellPress = { at: Date.now(), x: e.position.x, y: e.position.y };
      })
      .on_click(() => toggleHistory(this.bellPress))
      .child(svg("mods/notifications/icons/bell.svg").size(14).flex_none().text_color(unread ? t.accent : t.muted))
      .when(unread > 0, (el) => el.child(div().px(5).h(15).flex().items_center().rounded(8).bg(t.accent)
        .text_size(10.5).font_semibold().text_color(t.accent_foreground).child(unread > 99 ? "99+" : String(unread))));
  }

  render() {
    const { moves, known } = newTabsToEnd(spaces(), this.knownTabs);
    this.knownTabs = known;
    for (const move of moves) run("tab.move", move);
    const t = theme();
    const button = ({ id, label, icon }) => {
      const isShown = isPanelShown(id);
      return h_flex().id(`panel-${id}`).h(24).px(6).gap(4).flex_none().items_center().rounded(8).border(1)
        .border_color(isShown ? t.input : t.border).bg(isShown ? t.selected : t.chrome)
        .text_size(12).text_color(isShown ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(`${isShown ? "Hide" : "Show"} ${label}${keyHint(id)}`)
        // The block drags the window; a press on a button must not.
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => toggle(id, isShown))
        .child(svg(icon).size(14).flex_none())
        .child(div().child(label));
    };
    return h_flex().size_full().gap(6).items_center().justify_end().children(PANELS.map(button)).child(this.bell(t));
  }
}
