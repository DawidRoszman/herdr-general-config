// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead.
// t3-menu: Herdr's menu (mod.clone), with a tab's and a pane's Close going through the tab bar (t3-tabs), which asks first
// while a program runs and leaves first, so Herdr's pick of a neighbour never shows. Only choose() and T3's measures differ from the shipped one.
// And profiles (t3-context): a space's menu has "Profile…", which opens this menu again with
// props { tab: "profile", target: { kind: "folder" | "machine", value } }: one row per profile and
// one for none. Choosing one runs profiles.py's `assign`. A machine's row opens that menu directly.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec, shared, appHome, home, notify } from "herdr";

const PROFILES_PY = `${appHome()}/mods/t3-context/profiles.py`;

// "Profile…" for a space: where there are profiles, on this computer (declared folders are its),
// and not for a coordinator's space, which is its profile's whatever its folder.
function profileItem(space) {
  const context = shared("context");
  const isOffered = space && !space.machine && Object.keys(context?.profiles ?? {}).length > 0
    && !Object.values(context.coordinators ?? {}).includes(space.id) && place(space);
  return isOffered ? [["Profile…", "profile.menu", { kind: "folder", value: place(space) }]] : [];
}

// A profile's folder as a path ("~/work" is the home's).
const expanded = (folder) => (folder === "~" || folder.startsWith("~/") ? home() + folder.slice(1) : folder).replace(/\/+$/, "");

// The profiles to give a machine or a folder to, the one that has it marked, and none.
function profileItems(target) {
  const profiles = shared("context")?.profiles ?? {};
  const has = (profile) => target.kind === "machine" ? profile.machines.includes(target.value)
    : profile.folders.some((folder) => target.value === expanded(folder) || target.value.startsWith(`${expanded(folder)}/`));
  return [
    ...Object.entries(profiles).map(([name, profile]) => [`${profile.label}${has(profile) ? " ✓" : ""}`, "profile.assign", { ...target, profile: name }]),
    [target.kind === "machine" ? "Shared (no profile)" : "No profile (by its accounts)", "profile.assign", { ...target, profile: "-" }],
  ];
}

async function assignProfile({ kind, value, profile }) {
  const r = await exec("python3", [PROFILES_PY, "assign", kind, value, profile]).catch((error) => ({ code: 1, stderr: String(error.message ?? error), stdout: "" }));
  if (r.code !== 0) notify({ title: `Couldn't change the profile of ${value}`, body: (r.stderr || r.stdout).trim().replace(/^profiles: /gm, ""), level: "error" });
}

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

function items(p, git) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      return [
        ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
        ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
        ["Zoom", "pane.zoom", { pane: tg.pane }],
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ["Close pane", "pane.close", { pane: tg.pane }],
      ];
    }
    case "tab":
      return [
        ["Rename", "tab.rename", { id: tg.id }],
        ["New tab", "tab.new", { space: tg.space }],
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "space":
      return [
        ["Rename", "space.rename", { id: tg.id }],
        ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ...profileItem(spaces().find((s) => s.id === tg.id)),
        ["Close", "space.close", { id: tg.id }],
      ];
    case "profile":
      return profileItems(tg);
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

function menuIcon(command) {
  const name = command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" || command.startsWith("profile.") ? "settings" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });
  }

  choose(i) {
    const it = /** @type {any} */ (items(props(), this.git)[i]);
    if (!it) return;
    closeOverlay(props()?.overlay);
    if (it[1] === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
    else if (it[1] === "profile.menu") openOverlay({ mod: "t3-menu", kind: "popup", width: 220, height: 260, props: { tab: "profile", target: it[2] } });
    else if (it[1] === "profile.assign") assignProfile(it[2]);
    // The item keeps Herdr's command, for its icon, its divider and its key; only where it goes changes.
    else if (it[1] === "tab.close") run(`t3-tabs.close-tab:${it[2].id}`);
    else if (it[1] === "pane.close") run(`t3-tabs.close-pane:${it[2].pane}`);
    else run(it[1], it[2]);
  }

  render() {
    const t = theme();
    const list = items(props(), this.git);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(4)
      .bg(t.popover)
      .text_size(14)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && (it[1].endsWith(".close") || it[1] === "app.help" || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme")), el => el.child(div().mx(8).my(4).h(1).bg(t.border)))
            .child(h_flex()
            .id(`mi-${i}`)
            .h(28)
            .px(8)
            .gap(8)
            .rounded(4)
            .items_center()
            .justify_between()
            .text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click(() => this.choose(i))
            // As T3's MenuItem: the icon hangs 2px into each side's padding and gap.
            .child(svg(menuIcon(it[1])).size(16).mx(-2).flex_none().text_color(t.muted))
            .child(div().flex_1().min_w(0).truncate().child(it[0]))
            .child(div().flex_none().text_size(12).font_medium().text_color(t.dim).child(shortcut(it[1], it[2])))),
        ),
      );
  }
}
