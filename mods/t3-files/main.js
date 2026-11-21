import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Button, Checkbox, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, checking, layout, keys } from "herdr";
import { fileManagerName, openWithDefaultApp, revealInFileManager } from "./reveal.js";
import { parentOf } from "./path.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const all = panes(), pane = f?.pane ? all.find(p => p.pane === f.pane) : null;

  const tabCwd = pane && !pane.cwd ? all.find(p => p.tab === pane.tab && p.cwd)?.cwd : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || tabCwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };

const RICH = { md: "markdown", markdown: "markdown", mdx: "markdown", html: "html", htm: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const OPENS_OUTSIDE = "opensOutside";

export function extensionOf(path) {
  const name = path.split("/").pop(), dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
}

async function directory(path, on) {
  const windowsDirectory = async () => {

    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

const findNode = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => findNode(c, id)).find(Boolean));
function isFilesVisible() {
  const root = layout(), panel = findNode(root, "panel"), body = findNode(root, "panel-body");
  return !panel || (!panel.hidden && (!body || body.active === "files"));
}
function revealKeyHint() {
  const bound = keys().find((k) => k.action === "t3-panels.reveal");
  if (!bound) return "";
  const isMac = window()?.platform === "macos";
  const mod = isMac ? { cmd: "⌘", alt: "⌥", shift: "⇧", ctrl: "⌃" } : { cmd: "Ctrl+", alt: "Alt+", shift: "Shift+", ctrl: "Ctrl+" };
  const parts = bound.keys.split("-");
  return ` · ${parts.map((p, i) => (i < parts.length - 1 ? mod[p] ?? p : p.toUpperCase())).join("")}`;
}

export default class Files extends View {
  async close() {
    this.code?.release();
    this.code = null;
  }

  init(_props, cx) {
    this.saved = new Map();
    this.opensOutside = new Set(JSON.parse(localStorage.getItem(OPENS_OUTSIDE) ?? "[]"));
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    if (checking()) return;
    if (isFilesVisible()) this.refresh(cx);
    cx.timer.every(10000, cx => { if (isFilesVisible()) this.refresh(cx); });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file, root: this.root });
      const saved = this.saved.get(next);

      this.context = { key: next, cwd, on, root: saved?.root ?? cwd }; this.root = this.context.root; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: context.root, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {

          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: context.root, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(context.root, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  goTo(root, cx) {
    this.context = { ...this.context, root }; this.root = root;
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {}; this.show(null);
    this.watched = null; this.error = null; this.limited = false; this.loading = false;
    this.refresh(cx);
    cx.notify();
  }

  folderButtons(t) {
    const parent = this.root ? parentOf(this.root) : null, home = this.context?.cwd;
    const button = (id, label, tip, to) => div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => this.goTo(to, cx)).child(label);
    return h_flex().flex_none().gap(2)
      .when(Boolean(parent), el => el.child(button("files-up", "↑", `Up to ${parent}`, parent)))
      .when(Boolean(home) && home !== this.root, el => el.child(button("files-home", "↩", `Back to ${home}`, home)));
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.rich = null; this.isShowingSource = false; this.file = path; this.fileError = null; this.hasNoPreview = false; this.isRemembering = false;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; this.hasNoPreview = true; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        const value = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        const kind = RICH[ext.toLowerCase()];

        if (kind) this.rich = { kind, text: kind === "html" ? value.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "") : value };
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true, value,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) { this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; this.hasNoPreview = true; } }
      finally { cx.notify(); }
    });
  }

  open(path, cx) {
    const ext = extensionOf(path);
    if (ext && this.opensOutside.has(ext)) openWithDefaultApp(`${this.root}/${path}`, this.on);
    else this.show(path, cx);
  }

  openOutside(cx) {
    const ext = extensionOf(this.file);
    if (this.isRemembering && ext) {
      this.opensOutside.add(ext);
      localStorage.setItem(OPENS_OUTSIDE, JSON.stringify([...this.opensOutside]));
    }
    openWithDefaultApp(`${this.root}/${this.file}`, this.on);
    this.show(null);
    cx.notify();
  }

  noPreview(t) {
    const ext = extensionOf(this.file);
    return v_flex().p(12).gap(10).text_color(t.dim).child(this.fileError)
      .when(Boolean(ext), el => el.child(Checkbox.new("files-remember").checked(this.isRemembering)
          .on_change((isChecked, cx) => { this.isRemembering = isChecked; cx.notify(); })
          .child(h_flex().gap(8).items_center().cursor_pointer().text_size(12).text_color(t.muted)
            .child(div().size(14).flex_none().flex().items_center().justify_center().rounded(4).border_1()
              .border_color(this.isRemembering ? t.accent : t.border).bg(this.isRemembering ? t.accent : t.background)
              .text_size(10).text_color(t.accent_foreground).child(this.isRemembering ? "✓" : ""))
            .child(`Always open .${ext} files in the default app`))))
        .child(Button.new("files-open-outside").on_click((_e, cx) => this.openOutside(cx))
          .child(div().px(10).h(26).flex().items_center().self_start().rounded(7).border_1().border_color(t.border)
            .bg(t.chrome).text_size(12).text_color(t.foreground).cursor_pointer().hover(s => s.bg(t.hover))
            .child("Open in the default app")));
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.open(path, cx))
        .child(entry.dir ? svg(`mods/t3-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/t3-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  formatted(t) {
    const { kind, text } = this.rich, id = `files-rich-${this.file}`;
    return div().id("files-rich-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12)
      .child((kind === "html" ? TextView.html(id, text) : TextView.markdown(id, text)).selectable(true).text_size(13).text_color(t.foreground));
  }

  sourceButton(t) {
    return div().id("files-source").px(6).h(22).flex_none().flex().items_center().rounded(6).cursor_pointer()
      .text_size(11.5).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(this.isShowingSource ? "Show formatted" : "Show the source")
      .on_click((_e, cx) => { this.isShowingSource = !this.isShowingSource; cx.notify(); })
      .child(this.isShowingSource ? "Preview" : "Source");
  }

  revealButton(t) {
    const path = this.file ? `${this.root}/${this.file}` : this.root;
    return div().id("files-reveal").p(4).flex_none().rounded(6).cursor_pointer().text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(`Open in ${fileManagerName()}${revealKeyHint()}`)
      .on_click(() => revealInFileManager(path, this.on, Boolean(this.file)))
      .child(svg("mods/t3-files/external.svg").size(14));
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Back to the file list")
          .on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().flex_none().font_semibold().child("Files"))
        .when(!this.file, el => el.child(this.folderButtons(t)))

        .child(div().id("files-where").flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_ellipsis_start().text_right().text_size(12).text_color(t.dim)
          .tooltip(this.file ? `${this.root}/${this.file}` : this.root ?? "")
          .child(this.file ?? (this.root?.split(/[\\/]/).pop() || this.root) ?? ""))
        .when(Boolean(this.rich && this.code), el => el.child(this.sourceButton(t)))
        .when(Boolean(this.root), el => el.child(this.revealButton(t))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.rich && this.code && !this.isShowingSource ? this.formatted(t)
        : this.code ? Editor.new(this.code).flex_1().min_h(0)
        : this.hasNoPreview ? this.noPreview(t) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
