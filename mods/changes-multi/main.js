// Herdr's Changes panel (cloned from changes) that also covers multirepo folders (the `mr` CLI's):
// inside a task (.mr-task.json above the folder) it shows the changes of every repo of the task,
// at a project's root (.mr.json there) those of every repo of the project; elsewhere one git repo,
// as before. Each file belongs to its repo: its diff comes from there, and Commit commits every
// repo that has changes with the one message. What it shows is a view (views.js): All, Unstaged, Staged,
// or Branch (the branch's work against its base: each repo's own, or a branch typed in).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, appHome, nextCommand } from "herdr";
import { highlightDiff } from "./delta.js";
import { VIEWS, statusFiles, nameStatusFiles, diffSides } from "./views.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
// Where the multirepo markers are, from the folder up: "task\n<root>\n<.mr-task.json>",
// "project\n<root>\n<.mr.json>" (only at the folder itself), else "none".
const FIND_MR = `d="$1"
while :; do
  if [ -f "$d/.mr-task.json" ]; then printf 'task\\n%s\\n' "$d"; cat "$d/.mr-task.json"; exit 0; fi
  if [ "$d" = "$1" ] && [ -f "$d/.mr.json" ]; then printf 'project\\n%s\\n' "$d"; cat "$d/.mr.json"; exit 0; fi
  [ "$d" = / ] && break
  d=$(dirname "$d")
done
echo none`;

// The repos the panel covers: a multirepo task's or project's, else the git repo of cwd.
// [{ name, root, bases }]: name is "" for a lone repo, so its paths show as before. bases: the branches
// Branch compares with, first found wins (a stacked task's parent, then the project's base for the repo,
// as mr's Task.base); a lone repo has none and uses origin's default.
async function reposOf(cwd, on) {
  const found = await exec("sh", ["-c", FIND_MR, "sh", cwd], { on });
  const [kind, root, ...rest] = found.code === 0 ? found.stdout.split("\n") : ["none"];
  if (kind === "task" || kind === "project") {
    const meta = JSON.parse(rest.join("\n"));
    const project = kind === "task" ? JSON.parse(await readTextFile(`${meta.project}/.mr.json`, { on }).catch(() => null) ?? "{\"repos\":[]}") : meta;
    const baseOf = (name) => project.repos.find((r) => r.name === name)?.base;
    const names = kind === "task" ? meta.repos : meta.repos.map((r) => r.name);
    const repos = names.map((name) => ({ name, root: `${root}/${name}`, bases: [meta.on, baseOf(name)].filter(Boolean) }));
    return { kind, label: kind === "task" ? meta.branch : meta.name, root, repos };
  }
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
  if (top.code !== 0) return null;
  return { kind: "repo", root: top.stdout.trim(), repos: [{ name: "", root: top.stdout.trim(), bases: [] }] };
}

// "acme-shop-backend" -> "backend": the dash-ended prefix all shown repos share.
function shortNames(names) {
  if (names.length < 2) return Object.fromEntries(names.map((n) => [n, n]));
  let prefix = names[0];
  for (const name of names) while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  prefix = prefix.slice(0, prefix.lastIndexOf("-") + 1);
  return Object.fromEntries(names.map((n) => [n, n.slice(prefix.length) || n]));
}

// The "?" key list (a copy of prs/keyhelp.js: mods can't import across folders), from help-keys.json.
const isHelpKey = (stroke) => stroke === "?" || stroke === "shift-/";
async function loadKeys() {
  try {
    return JSON.parse(await readTextFile(`${appHome()}/mods/changes-multi/help-keys.json`)).views[0].sections;
  } catch (error) {
    return [{ title: "Could not read mods/changes-multi/help-keys.json", rows: [["", String(error.message ?? error)]] }];
  }
}
function keyHelp(sections, t) {
  return div().absolute().inset_0().flex().items_center().justify_center().bg(`${t.background}cc`).p(12)
    .child(v_flex().id("changes-keys").max_w(480).w_full().max_h_full().overflow_y_scrollbar().p(16).gap(12).rounded(10)
      .bg(t.popover).border(1).border_color(t.border).shadow_lg()
      .child(h_flex().justify_between().items_center()
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Changes keys"))
        .child(div().text_size(11).text_color(t.dim).child("? or esc closes")))
      .children(sections.map((section) => v_flex().gap(3)
        .child(div().text_size(11).font_medium().text_color(t.dim).child(section.title))
        .children(section.rows.map(([keys, what]) => h_flex().gap(10).items_start().text_size(12)
          .child(div().flex_none().w(110).text_color(t.accent).child(keys))
          .child(div().flex_1().min_w(0).text_color(t.foreground).child(what)))))));
}
const ROW = { header: 26, file: 28 };
const DIFF_ROW_HEIGHT = 20;
const FILE_HEADER_HEIGHT = 34; // expand all: a file's header in the diff, as the PR review draws it

// Which cached diff is a file's: a new one when its status or line counts change. An untracked
// file has no counts (git numstat skips it), so its edits show when it is picked or staged.
const diffSignature = (f) => (f.fresh ? `${f.root}|${f.rel}|fresh` : `${f.root}|${f.rel}|${f.against.join(" ")}|${f.status}|${f.add}|${f.del}`);
const DIFF_PAGE = 15; // lines ctrl-d / ctrl-u move the diff

const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.listScroll = VirtualListScrollHandle.new();
    this.diffScroll = VirtualListScrollHandle.new();
    this.diffTop = 0;
    // Expand all: every shown file's diff stacked under its header, instead of the picked file's.
    this.isExpanded = localStorage.getItem("changes.expanded") === "1";
    this.diffCache = new Map(); // diffSignature(file) -> { shown, rows }; a changed file gets a new signature
    // root|rel -> the file's last diff: shown while a changed file's new one loads, so a refresh never blanks it
    this.lastDiffs = new Map();
    this.cacheVersion = 0; // counts cache writes, so the stacked rows are rebuilt only then
    this.stacked = null; // { key, rows, heights, starts, width }: stackedRows()'s last answer
    this.isLoadingAll = false;
    this.isFollowingDiffScroll = false; // the diff was scrolled by hand: the file list follows it
    this.folded = new Set(); // expand all: files whose diff is folded under their header (click it)
    this.query = "";
    this.isSearching = false;
    this.search = InputState.new({ placeholder: "Filter files" });
    this.search.on("change", (_e, cx) => { if (!this.isSearching) return; this.query = this.search.value().trim().toLowerCase(); cx.notify(); });
    this.search.on("submit", (_e, cx) => { this.isSearching = false; this.handle.focus(); this.step(cx, 0); });
    this.search.on("blur", (_e, cx) => { this.isSearching = false; cx.notify(); });
    this.view = localStorage.getItem("changes.view") ?? "all";
    this.baseOverride = localStorage.getItem("changes.base") ?? ""; // Branch's base typed in; "" is each repo's own
    this.bases = []; // Branch: the bases its repos were compared with, at the last refresh
    this.baseInput = InputState.new({ value: this.baseOverride, placeholder: "each repo's base" });
    this.baseInput.on("submit", (_e, cx) => { this.setBase(this.baseInput.value().trim(), cx); this.handle.focus(); });
    this.baseInput.on("focus", (_e, cx) => { this.isTypingBase = true; cx.notify(); });
    this.baseInput.on("blur", (_e, cx) => { this.isTypingBase = false; cx.notify(); });
    this.keySections = [];
    cx.spawn(async () => { this.keySections = await loadKeys(); });
    // focusable (mod.json): pane.go brings the keyboard here with "focus".
    cx.spawn(async (cx) => { for (;;) { if (await nextCommand() === "focus") this.handle.focus(); cx.notify(); } });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null; this.repoFilter = "";
      this.diffCache.clear(); this.lastDiffs.clear(); this.cacheVersion++;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    const view = this.view, viewKey = this.viewKey();
    cx.spawn(async (cx) => {
      try {
        const scope = await reposOf(cwd, on);
        if (key() !== context || this.viewKey() !== viewKey) return;
        if (!scope) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const shorts = shortNames(scope.repos.map((r) => r.name));
        const files = [], bases = [], problems = [];
        let total = 0;
        for (const repo of scope.repos) {
          let listed;
          // A repo Branch can't compare (no such base there) is left out and said, the others still show.
          try { listed = await this.repoFiles(repo, on, view); }
          catch (e) { if (view !== "branch") throw e; problems.push(String(e.message ?? e)); continue; }
          if (listed.base) bases.push(listed.base);
          total += listed.total;
          const prefix = repo.name ? `${shorts[repo.name]}/` : "";
          files.push(...listed.files.map((f) => ({ ...f, repo: repo.name, repoLabel: shorts[repo.name] ?? "", root: repo.root, rel: f.path, path: prefix + f.path })));
        }
        if (key() !== context || this.viewKey() !== viewKey) return;
        this.bases = [...new Set(bases)];
        if (view === "branch") this.note = problems.join(" · ") || null;
        this.root = scope.root; this.on = on; this.scope = scope; this.shorts = shorts; this.files = files.slice(0, 1000); this.limited = total > 1000; this.error = null;
        this.watch(scope.root, cx);
        if (this.open && !this.files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && this.files.length) this.open = this.files[0].path;
        // Stacked diffs: gone files leave the cache; the picked file reloads, as it does alone
        // (an untracked file keeps its signature while it is edited).
        const signatures = new Set(this.files.map(diffSignature));
        for (const signature of this.diffCache.keys()) if (!signatures.has(signature)) this.diffCache.delete(signature);
        const paths = new Set(this.files.map((f) => `${f.root}|${f.rel}`));
        for (const path of this.lastDiffs.keys()) if (!paths.has(path)) this.lastDiffs.delete(path);
        const openFile = this.files.find((f) => f.path === this.open);
        if (this.isExpanded && openFile) { this.diffCache.delete(diffSignature(openFile)); this.cacheVersion++; }
        if (this.open && !this.isExpanded) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context && this.viewKey() === viewKey) this.error = String(e); }
      finally {
        this.loading = false;
        if (this.viewKey() !== viewKey) this.refresh(cx); // the view changed while this one loaded
        cx.notify();
      }
    });
  }

  viewKey() {
    return `${this.view}|${this.baseOverride}`;
  }

  // Another view, or Branch's base: its files and diffs are another list.
  showView(cx) {
    this.files = []; this.open = null; this.closed = false; this.note = null; this.error = null; this.bases = [];
    this.setLines([]); this.diffCache.clear(); this.lastDiffs.clear(); this.cacheVersion++;
    this.refresh(cx);
    cx.notify();
  }

  setView(view, cx) {
    if (view === this.view) return;
    this.view = view;
    localStorage.setItem("changes.view", view);
    this.showView(cx);
  }

  setBase(base, cx) {
    if (base === this.baseOverride) return;
    this.baseOverride = base;
    localStorage.setItem("changes.base", base);
    this.showView(cx);
  }

  // Branch's base in a repo, as a ref: the branch typed in, else the repo's own, else origin's default
  // (origin/HEAD); origin's copy of a branch before a local one. null when the repo has none of them.
  async branchBase(repo, git) {
    const names = this.baseOverride ? [this.baseOverride] : [...repo.bases, "HEAD"];
    for (const name of names) {
      for (const ref of name === "HEAD" ? ["origin/HEAD"] : [`origin/${name}`, name]) {
        if ((await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code !== 0) continue;
        if (ref !== "origin/HEAD") return ref;
        const named = await git(["rev-parse", "--abbrev-ref", ref]); // origin/HEAD -> origin/main
        return named.code === 0 ? named.stdout.trim() : ref;
      }
    }
    return null;
  }

  async repoFiles(repo, on, view) {
    const git = (args) => exec("git", [...READ, ...args], { cwd: repo.root, on });
    const label = repo.name || repo.root;
    const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
    if (status.code !== 0) throw new Error(`${label}: ${status.stderr.trim()}`);
    const hasHead = (await git(["rev-parse", "--verify", "HEAD"])).code === 0;
    let listed = statusFiles(view, status.stdout), base = null, mergeBase = null;
    if (view === "branch") {
      base = await this.branchBase(repo, git);
      if (!base) throw new Error(`${label}: no ${this.baseOverride || "base"} branch to compare with`);
      const forked = await git(["merge-base", base, "HEAD"]);
      if (forked.code !== 0) throw new Error(`${label}: ${base} shares no history with HEAD`);
      mergeBase = forked.stdout.trim();
      const changed = await git(["diff", mergeBase, "--name-status", "-z", "--no-renames"]);
      if (changed.code !== 0) throw new Error(`${label}: ${changed.stderr.trim()}`);
      listed = [...nameStatusFiles(changed.stdout), ...listed];
    }
    const { numstats, against } = diffSides(view, hasHead, mergeBase);
    const stats = {};
    for (const args of numstats) {
      const result = await git(["diff", ...args, "--numstat", "-z", "--no-renames"]);
      if (result.code !== 0) throw new Error(result.stderr);
      for (const entry of result.stdout.split("\0")) {
        const [a, d, ...parts] = entry.split("\t");
        if (!parts.length) continue;
        const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
        stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
      }
    }
    const files = listed.slice(0, 1000).map((f) => ({ ...f, hasHead, against, ...(stats[f.path] ?? { add: 0, del: 0 }) }));
    return { files, total: listed.length, base };
  }

  // One file's diff as rows, colored by delta: the picked file's (load) or each stacked one's (loadAll).
  async diffOf(file) {
    const on = this.on, root = file.root;
    let lines;
    if (file.fresh || (!file.hasHead && file.status === "A" && !file.against.length)) {
      const text = await readTextFile(`${root}/${file.rel}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...file.against, "--no-ext-diff", "--no-textconv", "--no-color", "--", file.rel], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    const shown = lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line);
    let rows = diffRows(shown);
    try { rows = await highlightDiff(rows, file.rel, { exec, isDark: Boolean(settings().dark) }); }
    catch (e) { this.note = e.message; }
    return { shown, rows };
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path);
    if (!file) return;
    const { shown, rows } = await this.diffOf(file);
    if (key() === context && this.open === path) this.setLines(shown, rows);
  }

  // Expand all: the shown files' missing diffs, one after another; each shows as it comes.
  loadAll(cx) {
    if (this.isLoadingAll) return;
    const context = this.context;
    this.isLoadingAll = true;
    cx.spawn(async (cx) => {
      try {
        for (const file of this.shownFiles()) {
          if (key() !== context || !this.isExpanded) return;
          const signature = diffSignature(file);
          if (this.diffCache.has(signature)) continue;
          let diff;
          try { diff = await this.diffOf(file); }
          catch (e) { diff = { shown: [], rows: [{ kind: "", text: `Cannot preview this diff (too large or unreadable): ${e}` }] }; }
          this.diffCache.set(signature, diff);
          this.lastDiffs.set(`${file.root}|${file.rel}`, diff);
          this.cacheVersion++;
          cx.notify();
        }
      } finally { this.isLoadingAll = false; cx.notify(); }
    });
  }

  // Expand all's rows: a header per shown file, then its diff (or a loading line); starts: path -> its header's row.
  stackedRows() {
    const shown = this.shownFiles();
    const cacheKey = `${this.cacheVersion}|${[...this.folded].join("\n")}|${shown.map((f) => f.path).join("\n")}`;
    if (this.stacked?.key === cacheKey) return this.stacked;
    const rows = [], starts = new Map();
    let width = 300;
    for (const f of shown) {
      starts.set(f.path, rows.length);
      const isFolded = this.folded.has(f.path);
      rows.push({ kind: "file", text: f.path, status: f.status, add: f.add, del: f.del, path: f.path, isFolded });
      if (isFolded) continue;
      const diff = this.diffCache.get(diffSignature(f)) ?? this.lastDiffs.get(`${f.root}|${f.rel}`);
      if (!diff) { rows.push({ kind: "", text: "Loading…", path: f.path }); continue; }
      for (const row of diff.rows) rows.push({ ...row, path: f.path });
      width = Math.max(width, ...diff.shown.map((line) => line.length * 7 + 50));
    }
    const heights = rows.map((row) => (row.kind === "file" ? FILE_HEADER_HEIGHT : DIFF_ROW_HEIGHT));
    this.stacked = { key: cacheKey, rows, heights, starts, width };
    return this.stacked;
  }

  // What the diff area lists now: the stacked diffs, or the picked file's.
  shownRows() {
    return this.isExpanded ? this.stackedRows().rows : this.rows;
  }

  toggleFold(path, cx) {
    if (this.folded.has(path)) this.folded.delete(path);
    else this.folded.add(path);
    this.open = path; this.closed = false; this.isFollowingDiffScroll = false;
    cx.notify();
  }

  toggleExpanded(cx) {
    this.isExpanded = !this.isExpanded;
    localStorage.setItem("changes.expanded", this.isExpanded ? "1" : "0");
    this.diffTop = 0;
    if (this.isExpanded) { if (this.open) this.diffScroll.scroll_to_item(this.stackedRows().starts.get(this.open) ?? 0, "top"); }
    else if (this.open) {
      const path = this.open, context = this.context;
      this.setLines([]);
      cx.spawn(async (cx) => {
        try { await this.load(path, context); }
        catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
        cx.notify();
      });
    }
    cx.notify();
  }

  setLines(lines, rows = diffRows(lines)) {
    this.diffTop = 0;
    this.rows = rows;
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pick(path, cx) {
    if (this.isExpanded) {
      this.open = path; this.closed = false; this.isFollowingDiffScroll = false;
      this.diffTop = this.stackedRows().starts.get(path) ?? 0;
      this.diffScroll.scroll_to_item(this.diffTop, "top");
      return cx.notify();
    }
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  // The files shown: all repos', or the selected repo's, matching the filter.
  shownFiles() {
    const files = this.repoFilter ? this.files.filter((f) => f.root === this.repoFilter) : this.files;
    return this.query ? files.filter((f) => f.path.toLowerCase().includes(this.query)) : files;
  }

  // The list's rows: in All (multirepo), a header before each repo's files.
  fileRows() {
    const shown = this.shownFiles();
    const isMulti = Boolean(this.scope && this.scope.kind !== "repo");
    const rows = [];
    let lastRoot = null;
    for (const f of shown) {
      if (isMulti && !this.repoFilter && f.root !== lastRoot) rows.push({ header: f.repoLabel, root: f.root, key: `head:${f.root}`, count: shown.filter((x) => x.root === f.root).length });
      lastRoot = f.root;
      rows.push({ ...f, key: f.path });
    }
    return rows;
  }

  // j/k: the next / previous file (headers skipped), its diff shown, kept in view. 0: the current or first.
  step(cx, delta) {
    const rows = this.fileRows();
    const files = rows.filter((r) => r.header === undefined);
    if (!files.length) return;
    const at = files.findIndex((f) => f.path === this.open);
    // Nothing open yet: j and k start at the first file, G at the last.
    const target = at < 0 ? (delta === Infinity ? files.length - 1 : 0) : Math.min(files.length - 1, Math.max(0, at + delta));
    const next = files[target];
    if (next.path !== this.open) this.show(next.path, cx);
    this.listScroll.scroll_to_item(rows.findIndex((r) => r.key === next.path));
  }

  show(path, cx) {
    if (this.open === path) return;
    this.pick(path, cx);
  }

  scrollDiff(delta) {
    this.diffTop = Math.min(Math.max(0, this.shownRows().length - 1), Math.max(0, this.diffTop + delta));
    this.diffScroll.scroll_to_item(this.diffTop, "top");
  }

  // h/l: the previous / next repo chip (All first).
  stepRepo(cx, delta) {
    const roots = ["", ...(this.scope?.repos ?? []).map((r) => r.root)];
    if (roots.length < 2) return;
    const at = roots.indexOf(this.repoFilter ?? "");
    const next = roots[(at + delta + roots.length) % roots.length];
    if (next) this.selectRepo(next, cx);
    else this.repoFilter = "";
    this.step(cx, 0);
  }

  key(e, cx) {
    const stroke = e.keystroke;
    if (this.typing || this.isTypingBase) {
      if (stroke !== "escape") return; // the commit message (or Branch's base) has the keys
      this.typing = this.isTypingBase = false;
      this.handle.focus();
    } else if (this.isShowingKeys || isHelpKey(stroke)) {
      if (!this.isShowingKeys || isHelpKey(stroke) || stroke === "escape") this.isShowingKeys = !this.isShowingKeys;
    } else if (this.isSearching) {
      if (stroke === "escape") { this.isSearching = false; this.handle.focus(); }
      else if (stroke === "down") this.step(cx, 1);
      else if (stroke === "up") this.step(cx, -1);
      else return;
    } else if (stroke === "j" || stroke === "down") this.step(cx, 1);
    else if (stroke === "k" || stroke === "up") this.step(cx, -1);
    else if (stroke === "g") this.step(cx, -Infinity);
    else if (stroke === "shift-g") this.step(cx, Infinity);
    else if (stroke === "l" || stroke === "right") this.stepRepo(cx, 1);
    else if (stroke === "h" || stroke === "left") this.stepRepo(cx, -1);
    else if (stroke === "ctrl-d") this.scrollDiff(DIFF_PAGE);
    else if (stroke === "ctrl-u") this.scrollDiff(-DIFF_PAGE);
    else if (stroke === "shift-j") this.scrollDiff(1);
    else if (stroke === "shift-k") this.scrollDiff(-1);
    else if (stroke === "/") { this.isSearching = true; cx.timer.after(0, () => this.search.focus()); }
    else if (stroke === "escape" && this.query) { this.query = ""; this.search.set_value(""); this.step(cx, 0); }
    else if (stroke === "c" || stroke === "i") this.input.focus();
    else if (stroke === "e") this.toggleExpanded(cx);
    else if (stroke === "m") this.setView(VIEWS[(VIEWS.findIndex((v) => v.id === this.view) + 1) % VIEWS.length].id, cx);
    else if (stroke === "b") { if (this.view !== "branch") this.setView("branch", cx); cx.timer.after(0, () => this.baseInput.focus()); }
    else if (stroke === "r") this.refresh(cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  selectRepo(root, cx) {
    this.repoFilter = this.repoFilter === root ? "" : root;
    const shown = this.shownFiles();
    if (this.open && !shown.some((f) => f.path === this.open)) {
      this.open = null;
      this.setLines([]);
      if (shown.length) this.pick(shown[0].path, cx);
    }
    cx.notify();
  }

  // The repo chips (multirepo only): All, then each repo of the task or project with its changed files.
  repoChips(t) {
    const counts = new Map();
    for (const f of this.files) counts.set(f.root, (counts.get(f.root) ?? 0) + 1);
    const repos = (this.scope?.repos ?? []).map((r) => ({ root: r.root, label: this.shorts?.[r.name] ?? r.name, count: counts.get(r.root) ?? 0 }));
    const chip = (id, label, count, isOn, onClick) => h_flex().id(id).flex_none().h(24).px(8).gap(5).items_center().rounded(12).border(1).cursor_pointer()
      .border_color(isOn ? t.accent : t.border).bg(isOn ? t.selected : t.background).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => onClick(cx))
      .child(div().text_size(11.5).text_color(isOn ? t.foreground : count ? t.muted : t.dim).child(label))
      .child(div().text_size(10.5).text_color(count ? t.accent : t.dim).child(String(count)));
    return h_flex().flex_none().flex_wrap().gap(5).px(10).py(8).border_b(1).border_color(t.border)
      .child(chip("repo-all", "All", this.files.length, !this.repoFilter, (cx) => { this.repoFilter = ""; cx.notify(); }))
      .children(repos.map((r) => chip(`repo-${r.root}`, r.label, r.count, this.repoFilter === r.root, (cx) => this.selectRepo(r.root, cx))));
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key() || this.view === "branch") return;
    // Staged commits the index as it is; the other views commit everything uncommitted.
    const steps = this.view === "staged" ? [] : [["add", "-A"]];
    const on = this.on, context = this.context, message = this.message.trim();
    const roots = [...new Map(this.shownFiles().map((f) => [f.root, f.repoLabel || f.root])).entries()];
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const [root, label] of roots) {
          for (const args of [...steps, ["commit", "-m", message]]) {
            const r = await exec("git", args, { cwd: root, on });
            if (r.code !== 0) throw new Error(`${roots.length > 1 ? `${label}: ` : ""}${(r.stderr || r.stdout).trim()}`);
          }
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // All · Unstaged · Staged · Branch, and in Branch its base: typed in, or each repo's own (shown).
  viewBar(t) {
    const tab = (v) => {
      const isOn = this.view === v.id;
      return div().id(`view-${v.id}`).h(22).px(8).flex().items_center().rounded(6).border(1).cursor_pointer().text_size(11)
        .border_color(isOn ? t.accent : t.border).bg(isOn ? t.selected : t.background).text_color(isOn ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).tooltip(`${v.label} · m cycles`).on_click((_e, cx) => this.setView(v.id, cx)).child(v.label);
    };
    const shownBases = this.bases.map((b) => b.replace(/^origin\//, "")).join(", ");
    return v_flex().flex_none().px(10).py(6).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(4).items_center().children(VIEWS.map(tab)))
      .when(this.view === "branch", (e) => e.child(h_flex().gap(6).items_center().text_size(11)
        .child(div().text_color(t.dim).child("vs"))
        .child(div().id("changes-base").w(140).h(22).px(6).flex().items_center().rounded(6).border_1().cursor_text()
          .border_color(this.isTypingBase ? t.accent : t.border).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.baseInput).h_full().text_size(11).text_color(t.foreground)))
        .when(Boolean(shownBases), (e) => e.child(div().min_w(0).truncate().text_color(t.dim).child(this.baseOverride ? "" : shownBases)))));
  }

  // A file's header in the stacked diff (and the sticky one on top), as the PR review's Files tab.
  fileHeaderRow({ text, status, add, del, path, isFolded }, t) {
    const statusColor = status === "A" ? t.ansi2 : status === "D" || status === "U" ? t.ansi1 : t.blocked;
    return h_flex().w_full().h(FILE_HEADER_HEIGHT).flex_none().px(12).gap(8).items_center().cursor_pointer().bg(this.open === path ? t.selected : t.raised).border_t(1).border_b(1).border_color(t.border)
      .child(div().w(10).flex_none().text_color(t.dim).child(isFolded ? "▸" : "▾"))
      .child(div().w(12).flex_none().text_color(statusColor).child(status))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(text))
      .child(div().flex_none().text_color(t.ansi2).child(`+${add}`))
      .child(div().flex_none().text_color(t.ansi1).child(`−${del}`));
  }

  diffRow(row, t) {
    const { kind, number, text, segments } = row;
    if (kind === "file") return this.fileHeaderRow(row, t);
    if (kind === "@") return div().w_full().px(12).h(DIFF_ROW_HEIGHT).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(DIFF_ROW_HEIGHT).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(40).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(10).flex_none().text_color(kind === "+" ? t.ansi2 : t.ansi1).child(kind === "+" || kind === "-" ? kind : ""))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().children((segments ?? [{ text }]).map((segment) => this.codeSegment(segment, kind, t))));
  }

  codeSegment({ text, color, isChanged }, lineKind, t) {
    return div().flex_none().when(Boolean(color), (e) => e.text_color(color))
      .when(isChanged, (e) => e.rounded(2).bg((lineKind === "+" ? t.ansi2 : t.ansi1) + "48"))
      .child(text);
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading && this.view !== "branch");
    const shown = this.shownFiles();
    const add = shown.reduce((n, f) => n + f.add, 0), del = shown.reduce((n, f) => n + f.del, 0);
    const changedRepos = new Set(shown.map((f) => f.root)).size;
    const isMulti = Boolean(this.scope && this.scope.kind !== "repo");
    const selectedLabel = this.repoFilter && shown[0]?.repoLabel;
    const commitWhat = this.view === "staged" ? "Commit staged" : "Commit";
    const commitLabel = changedRepos > 1 ? `${commitWhat} · ${changedRepos} repos` : selectedLabel ? `${commitWhat} · ${selectedLabel}` : commitWhat;
    const emptyText = this.view === "branch" && this.bases.length ? `No changes against ${this.bases.join(", ")}` : VIEWS.find((v) => v.id === this.view)?.empty;
    const fileRows = this.fileRows();
    if (this.isExpanded && !this.isLoadingAll && shown.some((f) => !this.diffCache.has(diffSignature(f)))) this.loadAll(cx);
    const diffRowsShown = this.shownRows();
    const stacked = this.isExpanded ? this.stackedRows() : null;
    const diffWidth = stacked ? stacked.width : this.diffWidth;
    const diffHeights = stacked ? stacked.heights : DIFF_ROW_HEIGHT;
    const stickyHeader = stacked ? stacked.rows[stacked.starts.get(stacked.rows[this.diffTop]?.path)] : null;
    // A layout can't redraw the file list, so the wheel event does: it shows the file the last layout found on top.
    const followScroll = (range) => {
      this.diffTop = range.start;
      if (stacked && this.isFollowingDiffScroll) this.open = stacked.rows[range.start]?.path ?? this.open;
    };
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .relative()
      .on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${shown.length} file${shown.length === 1 ? "" : "s"}`))
        .when(this.scope && this.scope.kind !== "repo", (e) => e.child(div().min_w(0).truncate().text_size(11).text_color(t.dim)
          .child(`${this.scope.kind} ${this.scope.label} · ${this.scope.repos.length} repos`)))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))
        .child(div().id("expand-all").h(22).px(7).flex().items_center().rounded(6).border(1).cursor_pointer().text_size(10.5)
          .border_color(this.isExpanded ? t.accent : t.border).bg(this.isExpanded ? t.selected : t.background).text_color(this.isExpanded ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover)).tooltip(this.isExpanded ? "Show one file at a time · e" : "Expand all diffs · e")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.toggleExpanded(cx))
          .child(this.isExpanded ? "All diffs" : "Expand all")))
      .child(this.viewBar(t))
      .when(isMulti, (e) => e.child(this.repoChips(t)))
      .when(this.isSearching || Boolean(this.query), (e) => e.child(div().px(10).pt(8).child(
        Input.new(this.search).h(28).px(8).items_center().rounded(6).border(1).border_color(this.isSearching ? t.accent : t.input).bg(t.background).text_size(12))))
      // Expand all: the file headers in the diff are the list, so the list above goes.
      .when(!this.isExpanded || !shown.length, (e) => e.child(v_flex().relative().flex_none().h(Math.min(isMulti ? 260 : 200, Math.max(44, fileRows.reduce((n, r) => n + (r.header !== undefined ? ROW.header : ROW.file), 0) + 12))).p(6).border_b(1).border_color(t.border)
        .child(!shown.length
          ? div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.query ? `No file matches "${this.query}"` : this.root ? emptyText : "No folder"))
          : v_virtual_list("changes-list", fileRows.length, fileRows.map((r) => (r.header !== undefined ? ROW.header : ROW.file)), (i) => fileRows[i].key,
            (range) => fileRows.slice(range.start, range.end).map((f) => {
              if (f.header !== undefined) {
                return h_flex().h(ROW.header).flex_none().px(6).gap(6).items_center().rounded(6).cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .child(svg("mods/prs/icons/repo.svg").size(12).text_color(t.dim))
                  .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(f.header))
                  .child(div().text_size(10.5).text_color(t.dim).child(String(f.count)));
              }
              const parts = f.rel.split("/"), name = parts.pop();
              return h_flex().h(ROW.file).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
                .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
                .child(h_flex().flex_1().min_w(0)
                  .child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
                .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
            }))
            // Rows of a virtual list cannot hold handlers: a header picks its repo, a file shows its diff.
            .on_item_click((key, cx) => {
              this.handle.focus();
              if (key.startsWith("head:")) this.selectRepo(key.slice(5), cx);
              else this.pick(key, cx);
            })
            .track_scroll(this.listScroll)
            .size_full())
        .child(Scrollbar.vertical("changes-list").absolute().inset_0())))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .on_scroll_wheel((_e, cx) => {
          if (!stacked) return;
          this.isFollowingDiffScroll = true;
          this.listScroll.scroll_to_item(Math.max(0, fileRows.findIndex((r) => r.key === this.open)));
          cx.notify();
        })
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(diffWidth).h_full().child(v_virtual_list("changes-diff", diffRowsShown.length, diffHeights, (i) => (diffRowsShown[i].kind === "file" ? `file:${diffRowsShown[i].path}` : String(i)),
            (range) => { followScroll(range); return diffRowsShown.slice(range.start, range.end).map((row) => this.diffRow(row, t)); })
            // Rows of a virtual list cannot hold handlers: a file's header folds or unfolds its diff.
            .on_item_click((key, cx) => { this.handle.focus(); if (key.startsWith("file:")) this.toggleFold(key.slice(5), cx); })
            .track_scroll(this.diffScroll).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        // The shown file's header stays on top, like GitHub's; it has no handlers, so the wheel still reaches the list.
        .when(Boolean(stickyHeader), (e) => e.child(div().absolute().top(0).left(0).right(0).child(this.fileHeaderRow(stickyHeader, t))))
        .when(!this.isExpanded && !this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("changes-help").h(32).w(24).flex().items_center().justify_center().rounded(8).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover)).tooltip("Keys · ?").on_click((_e, cx) => { this.isShowingKeys = !this.isShowingKeys; cx.notify(); }).child("?"))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : commitLabel)))
      .when(this.isShowingKeys, (e) => e.child(keyHelp(this.keySections, t)));
  }
}
