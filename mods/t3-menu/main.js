import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec, shared, appHome, home, notify, checking, window } from "herdr";

const PROFILES_PY = `${appHome()}/mods/t3-context/profiles.py`;

function profileItem(space) {
  const context = shared("context");
  const isOffered = space && !space.machine && Object.keys(context?.profiles ?? {}).length > 0
    && !Object.values(context.coordinators ?? {}).includes(space.id) && place(space);
  return isOffered ? [["Profile…", "profile.menu", { kind: "folder", value: place(space) }]] : [];
}

const expanded = (folder) => (folder === "~" || folder.startsWith("~/") ? home() + folder.slice(1) : folder).replace(/\/+$/, "");

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

function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

async function checkout(folder, on) {
  const r = await exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { cwd: folder, on });
  if (r.code !== 0) return null;
  const [top, common] = r.stdout.trim().split("\n");
  if (!top || !common) return null;
  return common === `${top}/.git` ? "main" : "linked";
}

async function branchOf(folder, on) {
  const task = await exec("cat", [`${folder}/.mr-task.json`], { on });
  if (task.code === 0) {
    try { const branch = JSON.parse(task.stdout).branch; if (branch) return branch; } catch {  }
  }
  const head = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: folder, on });
  return head.code === 0 ? head.stdout.trim() || null : null;
}

function items(p, git, branch) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {

      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      const isModelPane = panes().some((x) => x.pane === tg.pane);

      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      return [
        ...(isModelPane
          ? [
              ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
              ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
              ["Zoom", "pane.zoom", { pane: tg.pane }],
            ]
          : []),
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ...(isModelPane ? [["Close pane", "pane.close", { pane: tg.pane }]] : []),
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
        ...(branch ? [["Copy branch", "copy-branch", { branch }]] : []),
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
  const name = command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "copy-branch" ? "branch" : command === "app.help" ? "terminal" : command === "app.theme" || command.startsWith("profile.") ? "settings" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

function shortcut(name, args) {

  const value = args && Object.values(args)[0];
  const actions = [name, `${name}:${value}`];
  if (name === "tab.close") actions.push("t3-tabs.close-tab");
  else if (name === "pane.close") actions.push("t3-tabs.close-pane");
  const bound = keys();
  const layoutSection = shared("layout") ? `layout:${shared("layout")}` : null;
  const k = (layoutSection && bound.find((b) => b.section === layoutSection && actions.includes(b.action)))
    ?? bound.find((b) => b.section === "global" && actions.includes(b.action));
  if (!k?.keys) return "";
  const isMac = window()?.platform === "macos";
  const mod = isMac ? { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" } : { cmd: "Ctrl+", ctrl: "Ctrl+", alt: "Alt+", shift: "Shift+" };
  const parts = k.keys.split("-");
  return parts.map((p, i) => (i < parts.length - 1 ? mod[p] ?? `${p}+` : p.toUpperCase())).join("");
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.branch = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder && !checking())
      cx.spawn(async (cx) => {
        const [git, branch] = await Promise.all([
          checkout(folder, space.machine).catch(() => null),
          branchOf(folder, space.machine).catch(() => null),
        ]);
        this.git = git;
        this.branch = branch;
        cx.notify();
      });
  }

  choose(i, cx) {
    const it =  (items(props(), this.git, this.branch)[i]);
    if (!it) return;
    if (it[1] === "copy-branch") {
      cx.write_to_clipboard(it[2].branch);
      notify({ title: "Branch copied", body: it[2].branch, timeout: 3000 });
      closeOverlay(props()?.overlay);
      return;
    }
    closeOverlay(props()?.overlay);
    if (it[1] === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
    else if (it[1] === "profile.menu") openOverlay({ mod: "t3-menu", kind: "popup", width: 220, height: 260, props: { tab: "profile", target: it[2] } });
    else if (it[1] === "profile.assign") assignProfile(it[2]);

    else if (it[1] === "tab.close") run(`t3-tabs.close-tab:${it[2].id}`);
    else if (it[1] === "pane.close") run(`t3-tabs.close-pane:${it[2].pane}`);
    else run(it[1], it[2]);
  }

  render() {
    const t = theme();
    const list = items(props(), this.git, this.branch);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(4)
      .bg(t.popover)
      .text_size(14)
      .on_key_down((e, cx) => {
        if (e.key === "down" && list.length) this.at = (this.at + 1) % list.length;
        else if (e.key === "up" && list.length) this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") { cx.stop_propagation(); closeOverlay(props().overlay); return; }
        else return;
        cx.stop_propagation();
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
            .on_click((_e, cx) => this.choose(i, cx))

            .child(svg(menuIcon(it[1])).size(16).mx(-2).flex_none().text_color(t.muted))
            .child(div().flex_1().min_w(0).truncate().child(it[0]))
            .child(div().flex_none().text_size(12).font_medium().text_color(t.dim).child(shortcut(it[1], it[2])))),
        ),
      );
  }
}
