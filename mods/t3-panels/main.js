import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { focused, keys, layout, machines, nextCommand, notify, openOverlay, props, run, settings, setShared, shared, spaces, theme, window } from "herdr";
import { toggleHistory, unreadCount } from "./notifylog.js";
import { newTabsToEnd } from "./tab-order.js";
import { openRepoOnGitHub } from "./github.js";
import { revealInFileManager } from "./reveal.js";

const PANELS = [
  { id: "files", label: "Files", icon: "mods/t3-files/file.svg" },
  { id: "changes", label: "Changes", icon: "mods/changes/changes.svg" },
  { id: "prs", label: "Pull requests", icon: "mods/prs/icons/pull-request.svg" },
];

const COMPACT = "panels.compact";

const BOARD = { id: "board", label: "Board", icon: "mods/t3-chrome/icons/layout-list.svg" };
const JIRA = { id: "jira", label: "Jira", icon: "mods/jira/jira.svg" };
const COORDINATOR_PANELS = [BOARD, JIRA];

function isCoordinatorSpace() {
  const id = spaces().find((s) => s.active)?.id;
  return Boolean(id) && Object.values(shared("context")?.coordinators ?? {}).includes(id);
}

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

function keyHint(command) {
  const bound = keys().find((k) => k.action === `t3-panels.${command}`);
  if (!bound) return "";
  const isMac = window()?.platform === "macos";
  const symbols = isMac
    ? { cmd: "⌘", alt: "⌥", shift: "⇧", ctrl: "⌃" }
    : { cmd: "Ctrl+", alt: "Alt+", shift: "Shift+", ctrl: "Ctrl+" };
  const parts = bound.keys.split("-");
  return ` · ${parts.map((p, i) => (i < parts.length - 1 ? symbols[p] ?? p : p.toUpperCase())).join("")}`;
}

function isPanelShown(id) {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  return Boolean(panel && !panel.hidden && body?.active === id);
}

function newSpace() {
  const offMachines = new Set(shared("context")?.offMachines ?? []);
  const visibleMachines = machines().filter((m) => !m.name || !offMachines.has(m.name));
  if (visibleMachines.length > 1) openOverlay({ mod: NEW_MENU, kind: "popup", frame: "none", at:  ("top"), offset: 96, width: 576, height: 420, props: { pick: true } });
  else run("space.new");
}

const CHAT_ENABLED = "t3-chat.enabled";
const isChatEnabled = () => shared(CHAT_ENABLED) !== false;

const COMMANDS = {
  ...Object.fromEntries([...PANELS, ...COORDINATOR_PANELS].map(({ id }) => [id, () => toggle(id, isPanelShown(id))])),

  jira: () => (isCoordinatorSpace() ? toggle(JIRA.id, isPanelShown(JIRA.id)) : run("tab.new", { name: "Jira", mod: "jira" })),
  "new-space": newSpace,
  "new-tab": () => run("mod.open", { name: NEW_MENU }),
  "new-claude": () => run("tab.new", { name: "claude", ...(isChatEnabled() ? { mod: "t3-chat", props: { view: "chat" } } : { argv: ["claude"] }) }),
  "toggle-chat": () => {
    setShared(CHAT_ENABLED, !isChatEnabled());
    notify({ title: "Claude chat", body: isChatEnabled() ? "On: Claude opens as a chat" : "Off: Claude opens in a terminal" });
  },
  reveal: () => {
    const at = focused();
    revealInFileManager(at?.cwd, spaces().find((s) => s.id === at?.space)?.machine ?? null);
  },
  github: (cx) => openRepoOnGitHub(cx).catch((error) => notify({ title: "Open on GitHub", body: String(error.message ?? error), level: "error" })),
};

function showPanel(id) {
  run("layout.select", { stack: "panel-body", child: id });
  run("layout.show", { id: "panel" });
}

function toggle(id, isShown) {
  if (!isShown) return showPanel(id);
  if (id !== BOARD.id && isCoordinatorSpace()) return showPanel(BOARD.id);
  run("layout.hide", { id: "panel" });
}

export default class T3Panels extends View {
  init(_props, cx) {
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
        cx.stop_propagation();
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

    const isCoordinator = isCoordinatorSpace();
    if (isCoordinator !== this.wasCoordinator) {
      if (isCoordinator) showPanel(BOARD.id);
      else if (this.wasCoordinator !== undefined && COORDINATOR_PANELS.some(({ id }) => isPanelShown(id))) run("layout.hide", { id: "panel" });
      this.wasCoordinator = isCoordinator;
    }
    const t = theme();
    const shown = isCoordinator ? [...PANELS, JIRA] : PANELS;

    const isCompact = shown.length > PANELS.length;
    if (shared(COMPACT) !== isCompact) setShared(COMPACT, isCompact);
    const button = ({ id, label, icon }) => {
      const isShown = isPanelShown(id);
      return h_flex().id(`panel-${id}`).h(24).px(6).gap(4).flex_none().items_center().rounded(8).border(1)
        .border_color(isShown ? t.input : t.border).bg(isShown ? t.selected : t.chrome)
        .text_size(12).text_color(isShown ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(`${isShown ? "Hide" : "Show"} ${label}${keyHint(id)}`)

        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => toggle(id, isShown))
        .child(svg(icon).size(14).flex_none())
        .when(!isCompact, (el) => el.child(div().child(label)));
    };
    return h_flex().size_full().items_center().justify_end()
      .child(h_flex().id("panels-fit").flex_none().gap(6).items_center().on_size_change((size) => this.fit(size)).children(shown.map(button)).child(this.bell(t)));
  }

  fit(size) {
    const id = props()?.block, px = Math.ceil(size.width / (Number(settings()?.zoom) || 1));
    if (!id || px === this.fitted) return;
    this.fitted = px;
    run("layout.resize", { id, px });
  }
}
