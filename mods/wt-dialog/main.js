// Worktree dialog: { space, action: "new" | "open" | "remove" } or
// { folder, machine } for a repo without a space; optional { branch, tab, argv }.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, home } from "herdr";
import { notifyAndLog } from "./notifylog.js";
// Every notification also goes in the bell's history (notifylog.js).
const notify = (n) => notifyAndLog(n, "Worktrees");

// Clone of Herdr's `worktree` dialog: a new or newly opened worktree space gets
// the tabs of the `wts` tmux flow instead of a single shell.

// run() returns nothing, but `herdr-app do` answers with the ids it made,
// which the follow-up tabs need to land in the new space.
async function herdrDo(command, args) {
  const r = await exec("herdr-app", ["do", command, JSON.stringify(args)]);
  let out = {};
  try { out = JSON.parse(r.stdout); } catch { /* reported below with stderr */ }
  if (r.code !== 0 || out.error) throw new Error(out.error || r.stderr.trim() || `${command} failed`);
  return out;
}

// A new workspace's tabs, as in the `wts` tmux flow: claude, a terminal and nvim, in that order
// (new tabs go next to the selected one, so the order is set at the end). The agent-chat mod is
// not used for now. Blueprint opens on request only (cmd-shift-b). machine: a Herdr machine name, or null here.
async function openWorkspace(folder, machine) {
  const { space, tab: claude } = await herdrDo("space.new", { folder, machine: machine ?? "", tab: "claude", argv: ["claude"] });
  const { tab: terminal } = await herdrDo("tab.new", { space, folder, name: "terminal" });
  const { tab: nvim } = await herdrDo("tab.new", { space, folder, name: "nvim", argv: ["nvim"] });
  for (const [index, id] of [claude, terminal, nvim].entries()) await herdrDo("tab.move", { id, index: index + 1 });
  await herdrDo("space.select", { id: space });
  await herdrDo("tab.select", { id: claude });
}

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// New worktrees are made by wt (worktrunk) on the repo's machine, as `wts` does: the project's
// worktree-path from wt's config (else wt's default, next to the repo) and its approved hooks.
// So a checkout sits under the project's folder, where its direnv .envrc (Claude account,
// GH_TOKEN) applies; ~/.herdr/worktrees was outside it. Run in the login shell, where wt is on
// PATH. Hooks not approved yet are not approved from here (no --yes): wt says so instead.
const WT_SWITCH = 'command -v wt >/dev/null 2>&1 || exit 127; exec wt "$@"';
async function wtSwitch(top, branch, isNew, on) {
  const args = ["-C", top, "switch", ...(isNew ? ["--create", "--base", "@"] : []), branch, "--no-cd", "--format", "json"];
  const r = await exec("sh", ["-c", 'exec "${SHELL:-/bin/sh}" -lic "$0" wt "$@"', WT_SWITCH, ...args], { on });
  if (r.code === 127) return { isMissing: true };
  const json = r.stdout.split("\n").reverse().find((line) => line.trim().startsWith("{"));
  if (r.code !== 0 || !json) return { error: (r.stderr || r.stdout).trim().split("\n").slice(-4).join(" ") || "wt switch failed." };
  return { path: JSON.parse(json).path };
}
// Where wt puts a worktree by default ({{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}),
// for machines without wt.
const besideRepo = (main, branch) => `${main.replace(/\/+$/, "")}.${slug(branch)}`;
// Home as ~ (git says C:/Users/x where Windows says C:\Users\x).
const tilde = (path, userHome) => {
  const [p, h] = [path, userHome].map((s) => s.replace(/\\/g, "/"));
  return p.startsWith(h) ? `~${p.slice(h.length)}` : path;
};
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

// Every checkout of a repo (`git worktree list`), the main one first, then
// the most recently committed: { path, branch, main, at }.
async function checkouts(repo, on) {
  const list = await git(repo.main, ["worktree", "list", "--porcelain"], on);
  if (!list.ok) return [];
  const refs = await git(repo.main, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], on);
  const when = new Map(refs.out.split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
  const out = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, branch, main: out.length === 0, at: branch ? (when.get(branch) ?? 0) : 0 });
  }
  return out.sort((a, b) => b.main - a.main || b.at - a.at);
}

// The space showing a checkout: its first terminal is in it (the deepest checkout wins).
function spaceOf(path, all, on, spaceList, paneList) {
  const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
  return spaceList.find((s) => (s.machine ?? null) === (on ?? null) && (() => {
    const at = place(s, paneList)?.replace(/\\/g, "/");
    if (!at || !inside(at, path)) return false;
    return !all.some((c) => c.path !== path && c.path.length > path.length && inside(at, c.path));
  })());
}

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The submodule repos git keeps for a checkout (nested ones too, checked out
// or not): { name, dir, pinned }. `config` is the args that read its
// .gitmodules; `pinned` is the commit its parent records ("" if none).
async function modules(gitDir, config, on, out = [], parent = "") {
  const keys = await git(gitDir, ["--git-dir", gitDir, "config", ...config, "-z", "--get-regexp", "^submodule\\..*\\.path$"], on);
  if (!keys.ok) return out; // no .gitmodules, or no submodules in it
  // -z: "key\nvalue" records ended by NUL, so names and paths may hold spaces.
  for (const record of keys.out.split("\0").filter(Boolean)) {
    const at = record.indexOf("\n");
    const name = record.slice("submodule.".length, at - ".path".length);
    const dir = `${gitDir}/modules/${name}`;
    if (!(await git(gitDir, ["--git-dir", dir, "rev-parse", "--git-dir"], on)).ok) continue; // never checked out
    const pinned = await git(gitDir, ["--git-dir", gitDir, "rev-parse", `HEAD:${record.slice(at + 1)}`], on);
    // Names are only unique within their parent: nested ones carry its name.
    out.push({ name: parent + name, dir, pinned: pinned.ok ? pinned.out : "" });
    if ((await git(gitDir, ["--git-dir", dir, "cat-file", "-e", "HEAD:.gitmodules"], on)).ok) await modules(dir, ["--blob", "HEAD:.gitmodules"], on, out, `${parent + name}/`);
  }
  return out;
}

// The worktree's submodules, and the names of those with commits that exist
// nowhere else: not on a remote, and not the commit the parent pins (git
// fetches that by hash, so it is often on no remote branch here).
async function submodules(top, on) {
  const gitDir = await git(top, ["rev-parse", "--absolute-git-dir"], on);
  if (!gitDir.ok) throw new Error(gitDir.err || "git rev-parse failed.");
  const mods = await modules(gitDir.out, ["--file", `${top}/.gitmodules`], on);
  const unpushed = [];
  for (const m of mods) {
    const local = await git(gitDir.out, ["--git-dir", m.dir, "rev-list", "-n1", "--all", "--not", "--remotes", ...(m.pinned ? [m.pinned] : [])], on);
    if (!local.ok) throw new Error(local.err || `Couldn't check submodule ${m.name}.`);
    if (local.out) unpushed.push(m.name);
  }
  return { mods, unpushed };
}

// The repo a folder belongs to: its main checkout and name, and whether
// the folder is itself a linked worktree. null outside git.
async function repoOf(folder, on) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, name: main.split("/").pop(), linked: main !== top.out };
}

export default class Worktree extends View {
  init(_props, cx) {
    this.on = this.space()?.machine;
    this.userHome = this.on ? null : home();
    this.opening = props()?.action === "open";
    this.text = props()?.branch ?? "";
    this.list = undefined; // open: the checkouts, once read
    this.at = 0;
    this.input = InputState.new({ value: this.text, placeholder: this.opening ? "filter worktrees" : "branch name" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; this.at = 0; this.listScroll?.scroll_to_item(0); cx.notify(); });
    // Enter is taken here, not in key(), so one press never acts twice. In the open
    // list it opens the selected checkout; it must not create a branch named after the filter.
    this.input.on("submit", (_e, cx) => (this.opening ? this.open(this.shown()[this.at]) : this.go(cx)));
    // The open list starts in list mode (vim keys); "/" brings up the filter.
    this.inputFocused = !this.opening;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    if (!this.opening && props()?.action !== "remove") {
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
    }
    this.busy = false;
    this.error = "";
    this.repo = undefined; // undefined: looking, null: not in git
    this.dirty = false;
    this.unpushed = [];
    this.handle = cx.focus_handle();
    this.listScroll = VirtualListScrollHandle.new();
    if (this.opening || props()?.action === "remove") this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        if (this.on) {
          let result;
          try { result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on }); } catch {}
          if (!result || result.code !== 0 || !result.stdout.trim()) result = await exec("powershell.exe", ["-NoProfile", "-Command", "[Console]::Write($HOME)"], { on: this.on });
          if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not find the remote home folder.");
          this.userHome = result.stdout.trim().replace(/\\/g, "/");
        }
        this.folder = props()?.folder || place(this.space()) || this.userHome;
        // The repo is set last: Enter does nothing until the warnings it consents to are known.
        const repo = await repoOf(this.folder, this.on);
        if (repo && props().action === "remove") {
          this.dirty = (await git(repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on)).out !== "";
          this.unpushed = (await submodules(repo.top, this.on)).unpushed;
        }
        if (repo && this.opening) this.list = await checkouts(repo, this.on);
        this.repo = repo;
        cx.notify();
        if (props().branch) await this.work(cx);
      } catch (error) { this.repo = null; this.error = String(error); cx.notify(); }
    });
  }

  space() {
    const p = props() ?? {};
    return spaces().find((s) => s.id === p.space) ?? (p.folder ? { folder: p.folder, machine: p.machine ?? null, name: "" } : undefined);
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(cx) {
    if (this.busy || !this.repo) return;
    cx.spawn(async (cx) => this.work(cx));
  }

  async work(cx) {
    if (this.busy || !this.repo) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    try { this.error = props().action === "remove" ? await this.remove() : await this.create(); }
    catch (error) { this.error = String(error); }
    this.busy = false;
    if (!this.error) this.close();
    cx.notify();
  }

  async create() {
    const branch = this.text.trim();
    if (!branch) return "Type a branch name.";
    const exists = (await git(this.repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.on)).ok;
    let { path, isMissing, error } = await wtSwitch(this.repo.top, branch, !exists, this.on);
    if (error) return `wt: ${error}`;
    if (isMissing) {
      path = besideRepo(this.repo.main, branch);
      const add = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"];
      const r = await git(this.repo.top, add, this.on);
      if (!r.ok) return r.err || "git worktree add failed.";
    }
    // Leave spaces unnamed so they follow the checkout folder and nest under the repo.
    await openWorkspace(path, this.on);
    return "";
  }

  shown() {
    const f = this.text.trim().toLowerCase();
    return (this.list ?? []).filter((c) => !f || `${c.branch ?? ""} ${c.path}`.toLowerCase().includes(f));
  }

  open(c) {
    if (!c) return;
    this.close();
    const s = spaceOf(c.path, this.list, this.on, spaces(), panes());
    if (s) run("space.select", { id: s.id });
    else openWorkspace(c.path, this.on).catch((error) => notify({ title: "Opening worktree failed", body: String(error), level: "error" }));
  }

  async remove() {
    const s = this.space();
    const status = await git(this.repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on);
    if (!status.ok) return status.err || "git status failed.";
    // git refuses a worktree with submodules unless forced, because their
    // history goes with it. The popup already showed what's at risk; only
    // risk that appeared since it opened gets one more warning.
    const { mods, unpushed } = await submodules(this.repo.top, this.on);
    const changed = (status.out && !this.dirty) || unpushed.some((name) => !this.unpushed.includes(name));
    this.dirty ||= status.out !== "";
    this.unpushed = [...new Set([...this.unpushed, ...unpushed])];
    if (changed) return "It changed since this opened. Enter again removes it anyway.";
    // Terminals first: a shell sitting in the folder keeps it busy on Windows.
    run("space.close", { id: s.id, confirmed: true });
    const force = this.dirty || mods.length > 0;
    const r = await git(this.repo.main, ["worktree", "remove", ...(force ? ["--force"] : []), this.repo.top], this.on);
    return r.ok ? "" : r.err || "git worktree remove failed.";
  }

  // Vim-style, same as the port-forward dialog: j/k/l in the list, "/" starts a
  // search; while typing only arrows move and Esc goes back to the list with the
  // filter kept. Esc in the list clears a filter, then closes.
  key(e, cx) {
    if (this.opening) {
      const n = this.shown().length;
      const stroke = e.keystroke;
      if (this.inputFocused) {
        if (stroke === "escape") this.handle.focus();
        else if (stroke === "down" && n) this.moveTo((this.at + 1) % n);
        else if (stroke === "up" && n) this.moveTo((this.at + n - 1) % n);
        else return;
      }
      else if (stroke === "/") {
        // The box is only drawn while searching, so it can take focus after this frame.
        this.inputFocused = true;
        cx.timer.after(0, () => this.input.focus());
      }
      else if (stroke === "escape" && this.text) { this.input.set_value(""); this.text = ""; this.moveTo(0); }
      else if (stroke === "escape") return this.close();
      else if (stroke === "enter" || stroke === "l") this.open(this.shown()[this.at]);
      else if ((stroke === "down" || stroke === "j") && n) this.moveTo((this.at + 1) % n);
      else if ((stroke === "up" || stroke === "k") && n) this.moveTo((this.at + n - 1) % n);
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    if (e.key === "escape") return this.close();
    if (e.key === "enter" && props()?.action === "remove") return this.go(cx);
  }

  moveTo(index) {
    this.at = index;
    this.listScroll.scroll_to_item(index);
  }

  renderOpen(t) {
    const r = this.repo;
    const rows = this.shown();
    const all = this.list ?? [];
    const spaceList = spaces();
    const paneList = panes();
    const row = (c, i) => {
      const on = i === this.at;
      const there = spaceOf(c.path, all, this.on, spaceList, paneList);
      return v_flex()
        .flex_none()
        .h(44)
        .px(10)
        .justify_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.branch ?? "detached"))
            .when(c.main, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("main checkout")))
            .when(Boolean(there), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("open")))
            .when(!there && c.at > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(c.at)))),
        )
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(tilde(c.path, this.userHome ?? "")));
    };
    const count = rows.length === all.length ? `${all.length} checkouts` : `${rows.length}/${all.length} checkouts`;
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().child(div().flex_1().font_semibold().text_color(t.foreground).child(`Open worktree${r ? ` of ${r.name}` : ""}`)).child(div().text_size(11).text_color(t.dim).child(r ? count : "")))
      .when(r === undefined || (r && this.list === undefined), (el) => el.child(div().text_color(t.muted).child("\u2026")))
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${this.folder ? tilde(this.folder, this.userHome ?? "") : "This folder"} is not in a git repository.`)))
      .when(Boolean(r && this.list), (el) =>
        el
          .when(this.inputFocused || Boolean(this.text), (el) => el.child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground)))
          .child(
            v_flex()
              .relative()
              .flex_1()
              .min_h(0)
              .child(
                rows.length === 0
                  ? div().p(10).text_color(t.dim).child("No matching worktrees.")
                  : v_virtual_list("wt-list", rows.length, 44, (i) => rows[i].path, (range) => rows.slice(range.start, range.end).map((c, k) => row(c, range.start + k)))
                      // Rows of a virtual list cannot hold handlers; the list reports which was clicked.
              .on_item_click((path) => this.open(rows.find((c) => c.path === path)))
              .track_scroll(this.listScroll)
                      .size_full(),
              )
              .child(Scrollbar.vertical("wt-list").absolute().inset_0()),
          ),
      )
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child((this.inputFocused ? "type to filter · ↑↓ choose · ↵ open · esc list" : `j/k choose · l/↵ open · / search · esc ${this.text ? "clear" : "close"}`)));
  }

  render(cx) {
    const t = theme();
    if (this.opening) return this.renderOpen(t);
    const remove = props()?.action === "remove";
    const s = this.space();
    const r = this.repo;
    const title = remove ? `Remove worktree ${s?.name ?? ""}?` : `New worktree${r ? ` of ${r.name}` : ""}`;
    const detail =
      r === undefined
        ? "…"
        : r === null
          ? `${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a git repository.`
          : remove
            ? !r.linked
              ? "This is the repository's main checkout, not a worktree."
              : `Closes the space and deletes ${tilde(r.top, this.userHome)}. The branch stays.`
            : `A new space on a worktree made by wt (where your wt config says; else next to ${r.name}), so the project's direnv applies. A branch that exists is checked out; a new one starts from here.`;
    const blocked = !r || (remove && !r.linked);
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(title))
      .child(div().text_color(t.muted).child(detail))
      .when(remove && this.dirty, (el) => el.child(div().text_color(t.blocked).child("It has uncommitted changes: they will be lost.")))
      .when(remove && this.unpushed.length > 0, (el) => el.child(div().text_color(t.blocked).child(`Submodule ${this.unpushed.join(", ")} has commits that aren't pushed anywhere: they will be lost.`)))
      .when(!remove && !blocked, (el) =>
        el.child(
          Input.new(this.input)
            .h(32)
            .px(10)
            .items_center()
            .rounded(6)
            .border(1)
            .border_color(this.inputFocused ? t.accent : t.input)
            .bg(t.background)
            .text_color(t.foreground),
        ),
      )
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(
        h_flex()
          .justify_end()
          .text_size(11)
          .text_color(t.dim)
          .child(this.busy ? "working…" : blocked ? "esc close" : remove ? "↵ remove · esc cancel" : "↵ create · esc cancel"),
      );
  }
}
