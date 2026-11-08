// Multirepo: props { view: "projects" } is the Projects tab (projects.js); otherwise this dialog.
// Multirepo dialog: projects -> tasks -> repos, over the `mr` CLI (mr.py next to
// this file). Every call runs this copy of mr.py with python3 (here, or streamed over
// ssh), so the dialog never depends on what is installed on the machine; `i` installs
// it there for terminals and agents.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, spaces, focused, panes, exec, hc, appHome, run, readTextFile, nextCommand } from "herdr";
import { pickedRepos, changeBadge, baseLabel, prLabel } from "./view.js";
import { MR, mrOn, mrArgv, machinesWithThisMac, machineLabel, herdrDo, hcJson, reviewTab, openWorkspace } from "./remote.js";
import { ProjectsView } from "./projects.js";


// This view's key list, from help-keys.json in this mod's folder (the keybinds tab reads the same file).
async function loadKeys(mod, viewId) {
  try {
    const views = JSON.parse(await readTextFile(`${appHome()}/mods/${mod}/help-keys.json`)).views;
    return views.find((v) => v.id === viewId)?.sections ?? [];
  } catch (error) {
    return [{ title: `Could not read mods/${mod}/help-keys.json`, rows: [["", String(error.message ?? error)]] }];
  }
}

// The "?" key list drawn over the view (a copy of prs/keyhelp.js: mods can't import across folders).
const isHelpKey = (stroke) => stroke === "?" || stroke === "shift-/";
function keyHelp(id, title, sections, t, keyWidth = 120) {
  return div().absolute().inset_0().flex().items_center().justify_center().bg(`${t.background}cc`).p(12)
    .child(v_flex().id(id).max_w(560).w_full().max_h_full().overflow_y_scrollbar().p(16).gap(12).rounded(10)
      .bg(t.popover).border(1).border_color(t.border).shadow_lg()
      .child(h_flex().justify_between().items_center()
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child(title))
        .child(div().text_size(11).text_color(t.dim).child("? or esc closes")))
      .children(sections.map((section) => v_flex().gap(3)
        .child(div().text_size(11).font_medium().text_color(t.dim).child(section.title))
        .children(section.rows.map(([keys, what]) => h_flex().gap(10).items_start().text_size(12)
          .child(div().flex_none().w(keyWidth).text_color(t.accent).child(keys))
          .child(div().flex_1().min_w(0).text_color(t.foreground).child(what)))))));
}

// Copies mr.py to ~/.local/bin/mr and puts ~/.local/bin on PATH in the shells' rc files (once, marked).
// An empty target is this Mac: the same commands run here instead of over ssh.
const INSTALL_SCRIPT = `target="$1"; source="$2"
on() { if [ -n "$target" ]; then ssh "$target" "$1"; else sh -c "$1"; fi; }
on "mkdir -p ~/.local/bin && cat > ~/.local/bin/mr && chmod +x ~/.local/bin/mr" < "$source" || exit 1
on 'for rc in ~/.zshrc ~/.bashrc; do [ -f "$rc" ] || continue; grep -q "mr: local bin" "$rc" && continue; printf "\\n# mr: local bin\\ncase \\":\\$PATH:\\" in *\\":\\$HOME/.local/bin:\\"*) ;; *) export PATH=\\"\\$HOME/.local/bin:\\$PATH\\" ;; esac\\n" >> "$rc"; done; ~/.local/bin/mr --version'`;

export default class Multirepo extends View {
  init(_props, cx) {
    if (props()?.view === "projects") {
      this.screen = new ProjectsView(cx);
      cx.spawn(async (cx) => { for (;;) { this.screen.command(await nextCommand(), cx); cx.notify(); } });
      return;
    }
    this.handle = cx.focus_handle();
    this.keySections = [];
    cx.spawn(async (cx) => { this.keySections = await loadKeys("multirepo", "dialog"); cx.notify(); });
    this.handle.focus();
    this.listScroll = VirtualListScrollHandle.new();
    this.level = "machines"; // machines | projects | tasks | repos | clone | pick (a new task's repos)
    this.newBranch = null; // the branch of the task being made, while its repos are picked
    this.picked = new Set(); // repos ticked for it
    this.addingTo = null; // the task repos are being added to (the picker's other use)
    this.stackOn = null; // the task a new task is stacked on (its PRs target that task's branch)
    this.pickFrom = "tasks"; // the level the picker goes back to
    this.machines = undefined;
    this.machine = null;
    this.projects = undefined;
    this.project = null;
    this.tasks = undefined;
    this.task = null;
    this.repos = undefined;
    this.cloneSources = undefined;
    this.cloneSource = null;
    this.at = 0;
    this.isBusy = false;
    this.job = null; // { name, label } of a long mr command running as a local hc terminal
    this.confirmRemove = null; // task root that x was pressed on once
    this.error = "";
    this.notice = "";
    this.query = "";
    this.inputMode = null; // null | "search" | "new" | "init" | "clone-root"
    this.input = InputState.new({ value: "" });
    this.input.on("change", (_e, cx) => {
      if (this.inputMode !== "search") return;
      this.query = this.input.value().trim().toLowerCase();
      this.moveTo(0);
      cx.notify();
    });
    // Enter is taken here, not in key(), so one press never acts twice.
    this.input.on("submit", (_e, cx) => this.submitInput(cx));
    this.input.on("blur", (_e, cx) => {
      if (this.inputMode && this.inputMode !== "search") this.inputMode = null;
      else if (this.inputMode === "search") this.inputMode = "search-kept";
      cx.notify();
    });
    cx.timer.every(1000, (cx) => { if (this.job) cx.spawn(async (cx) => { await this.pollJob(); cx.notify(); }); });
    // Optional props { machine, project } plus one of (the Jira board's start work, the Projects tab):
    //   newTask: branch text   the new-task box filled in
    //   stackOn: task root     with newTask: the new task is stacked on that task
    //   addTo: task root       the picker of repos to add to that task
    //   prTask: task root      create/update its PRs at once (progress shows here)
    //   removeTask: task root  that task selected with its remove confirmation asked
    const given = props() ?? {};
    this.act(cx, async (cx) => {
      this.machines = await machinesWithThisMac();
      const space = spaces().find((s) => s.id === focused()?.space);
      // machine null is this Mac, so only a missing prop falls back to the focused space's machine.
      const wanted = "machine" in given ? given.machine : space?.machine ?? null;
      const current = this.machines.find((m) => m.name === wanted);
      if (given.machine && !current) return `${given.machine} is not a Herdr machine.`;
      if (current) await this.openMachine(current);
      if (!given.project) return "";
      const project = this.projects.find((p) => p.root === given.project);
      if (!project) return `No multirepo project at ${given.project} on ${given.machine}.`;
      await this.openProject(project);
      if (given.newTask !== undefined) {
        this.stackOn = given.stackOn ? this.tasks.find((t) => t.root === given.stackOn) : null;
        if (given.stackOn && !this.stackOn) return "That task isn't there any more.";
        this.focusInput(cx, "new", given.newTask ? `${given.newTask} ` : "");
        this.notice = "Enter picks the task's repos; then o opens its workspace.";
      }
      const task = this.tasks.find((t) => t.root === (given.addTo ?? given.prTask ?? given.removeTask));
      if ((given.addTo || given.prTask || given.removeTask) && !task) return "That task isn't there any more.";
      if (given.addTo) this.openPicker(task.branch, [], task);
      if (given.prTask) return this.startJob(`PRs for ${task.branch}`, ["pr", "--task", task.root]);
      if (given.removeTask) {
        this.moveTo(this.items().indexOf(task));
        return this.removeTask(task, false);
      }
      return "";
    });
  }

  // ---------------------------------------------------------------- mr calls

  async mr(args) {
    return mrOn(this.machine.target, args);
  }

  async mrJson(args) {
    return JSON.parse(await this.mr(args));
  }

  // Slow commands (fetch, push, clone, gh) run as a local hc terminal, polled until they finish.
  async startJob(label, args, machine = this.machine) {
    if (this.job) return "Another mr command is still running.";
    const name = `mr-job-${Date.now() % 100000}`;
    await hcJson(["run", "--json", "--name", name, "--no-parent", "--bg", "--", ...mrArgv(machine.target, args)]);
    this.job = { name, label };
    this.notice = `${label}…`;
    return "";
  }

  async pollJob() {
    const terminal = (await hcJson(["ls", "--json", "--all"])).terminals.find((t) => t.name === this.job?.name && !t.address.includes("/"));
    if (!terminal || terminal.state !== "finished") return;
    const { label, branch } = this.job;
    this.job = null;
    const output = (await hc(["read", terminal.address, "--lines", "40"])).stdout.trim().split("\n").filter(Boolean);
    await hc(["rm", terminal.address]);
    if (terminal.exit_code === 0) {
      this.notice = `${label}: done. ${output.slice(-3).join(" · ")}${branch ? " · o opens its workspace" : ""}`;
      this.error = "";
    } else {
      this.error = `${label} failed: ${output.slice(-4).join(" ").replace(/mr: /g, "")}`;
      this.notice = "";
    }
    await this.reload();
    if (branch && this.level === "tasks") this.moveTo(Math.max(0, this.items().findIndex((t) => t.branch === branch)));
  }

  // ------------------------------------------------------------- navigation

  async openMachine(machine) {
    this.machine = machine;
    this.level = "projects";
    this.projects = undefined;
    this.clearSearch();
    this.moveTo(0);
    this.projects = (await this.mrJson(["projects", "--json"])).projects;
  }

  async openProject(project) {
    this.project = project;
    this.level = "tasks";
    this.tasks = undefined;
    this.clearSearch();
    this.moveTo(0);
    const listed = await this.mrJson(["ls", "--json", "--project", project.root]);
    this.repoNames = listed.repos;
    this.shorts = listed.shorts ?? {}; // mr's short names: acme-shop-backend -> backend
    this.tasks = listed.tasks;
  }

  async openTask(task) {
    this.task = task;
    this.level = "repos";
    this.repos = undefined;
    this.clearSearch();
    this.moveTo(0);
    this.repos = (await this.mrJson(["status", "--json", "--task", task.root])).repos;
  }

  async openClone() {
    this.level = "clone";
    this.cloneSources = undefined;
    this.clearSearch();
    this.moveTo(0);
    const others = this.machines.filter((m) => m.name !== this.machine.name && m.state === "connected");
    const lists = await Promise.all(others.map(async (m) => {
      const [command, ...argv] = mrArgv(m.target, ["projects", "--json"]);
      const r = await exec(command, argv);
      return r.code === 0 ? JSON.parse(r.stdout).projects.map((p) => ({ ...p, machine: m })) : [];
    }));
    this.cloneSources = lists.flat();
  }

  short(name) {
    return this.shorts?.[name] ?? name;
  }

  // The repo picker. A new task: after its branch, every repo of the project to tick (words typed
  // after the branch come ticked). Adding to a task (task given): the repos it doesn't have yet.
  openPicker(branch, words, task = null) {
    const { picked, unknown } = pickedRepos(words, this.repoNames ?? [], this.shorts ?? {});
    this.newBranch = branch;
    this.addingTo = task;
    this.pickFrom = this.level === "repos" ? "repos" : "tasks";
    this.picked = new Set(picked);
    this.level = "pick";
    this.clearSearch();
    this.moveTo(0);
    this.error = unknown.length ? `Not a repo of ${this.project.name}: ${unknown.join(", ")}` : "";
  }

  pickable() {
    const all = this.repoNames ?? [];
    return this.addingTo ? all.filter((n) => !this.addingTo.repos.includes(n)) : all;
  }

  leavePicker() {
    this.level = this.pickFrom;
    this.addingTo = null;
    this.stackOn = null;
    this.error = "";
    this.clearSearch();
    this.moveTo(0);
  }

  togglePick(name) {
    if (this.picked.has(name)) this.picked.delete(name);
    else this.picked.add(name);
  }

  createPicked(cx) {
    if (!this.picked.size) {
      this.error = "Tick at least one repo (space).";
      return;
    }
    const branch = this.newBranch;
    // In the project's order, as mr lists them.
    const repos = this.pickable().filter((n) => this.picked.has(n));
    const task = this.addingTo;
    const stackArgs = this.stackOn ? ["--on", this.stackOn.branch] : [];
    this.leavePicker();
    if (task) {
      return this.act(cx, () => this.startJob(`Adding ${repos.map((n) => this.short(n)).join(", ")} to ${branch}`, ["add", ...repos, "--task", task.root]));
    }
    this.act(cx, async () => {
      const error = await this.startJob(`Creating ${branch}`, ["new", branch, ...repos, "--project", this.project.root, ...stackArgs]);
      if (!error) this.job.branch = branch;
      return error;
    });
  }

  back() {
    if (this.level === "pick") return this.leavePicker();
    const up = { projects: "machines", tasks: "projects", clone: "projects", repos: "tasks" }[this.level];
    if (!up) return;
    const from = { projects: this.machine, tasks: this.project, repos: this.task }[this.level];
    this.level = up;
    this.error = "";
    this.notice = "";
    this.confirmRemove = null;
    this.clearSearch();
    const list = this.items();
    this.moveTo(Math.max(0, list.indexOf(from)));
  }

  async reload() {
    if (this.level === "projects") await this.openMachine(this.machine);
    else if (this.level === "tasks") await this.openProject(this.project);
    else if (this.level === "repos") {
      const fresh = (await this.mrJson(["ls", "--json", "--project", this.project.root])).tasks.find((t) => t.root === this.task.root);
      if (fresh) await this.openTask(fresh);
      else await this.openProject(this.project); // the task was removed
    }
  }

  // ---------------------------------------------------------------- actions

  async openSpace(task) {
    await openWorkspace(task.root, this.machine.name);
    this.close();
    return "";
  }

  async removeTask(task, isForced) {
    if (this.confirmRemove !== task.root) {
      this.confirmRemove = task.root;
      this.notice = `Press x again to remove ${task.branch}${isForced ? " even with unpushed work (X)" : ""}. Branches with merged PRs are deleted, others kept.`;
      return "";
    }
    this.confirmRemove = null;
    return this.startJob(`Removing ${task.branch}`, ["rm", "--task", task.root, ...(isForced ? ["--force"] : [])]);
  }

  openPr(cx, repo) {
    if (!repo.pr) return `${this.short(repo.name)} has no PR yet. Press p to open PRs for the task.`;
    cx.open_url(repo.pr.url);
    return "";
  }

  async install() {
    const r = await exec("sh", ["-c", INSTALL_SCRIPT, "sh", this.machine.target ?? "", MR]);
    if (r.code !== 0) return `Install on ${machineLabel(this.machine)} failed: ${(r.stderr || r.stdout).trim()}`;
    this.notice = `mr ${r.stdout.trim()} installed on ${machineLabel(this.machine)} as ~/.local/bin/mr (new shells have it on PATH).`;
    return "";
  }

  startInput(mode, value = "") {
    this.inputMode = mode;
    this.input.set_value(value);
  }

  submitInput(cx) {
    const mode = this.inputMode;
    const text = this.input.value().trim();
    if (mode === "search" || mode === "search-kept") return this.pick(cx, this.at);
    this.inputMode = null;
    this.handle.focus();
    if (!text) return cx.notify();
    if (mode === "new") {
      const [branch, ...words] = text.split(/\s+/);
      // A stacked task starts with its parent's repos ticked.
      this.openPicker(branch, words.length || !this.stackOn ? words : this.stackOn.repos);
      return cx.notify();
    } else if (mode === "init") {
      this.act(cx, async () => { this.notice = (await this.mr(["init", text])).trim(); return ""; });
    } else if (mode === "clone-root") {
      const source = this.cloneSource;
      this.act(cx, async () => {
        const [command, ...argv] = mrArgv(source.machine.target, ["manifest", "--project", source.root]);
        const manifest = await exec(command, argv);
        if (manifest.code !== 0) return `Could not read ${source.name} on ${machineLabel(source.machine)}: ${manifest.stderr.trim()}`;
        this.level = "projects";
        return this.startJob(`Cloning ${source.name} into ${text}`, ["clone", manifest.stdout.trim(), text]);
      });
    }
  }

  act(cx, work) {
    if (this.isBusy) return;
    this.isBusy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.error = (await work(cx)) || "";
      } catch (error) {
        this.error = String(error.message ?? error);
      }
      this.isBusy = false;
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  clearSearch() {
    this.query = "";
    if (this.inputMode === "search" || this.inputMode === "search-kept") this.inputMode = null;
    this.input.set_value("");
  }

  moveTo(index) {
    this.at = index;
    this.listScroll.scroll_to_item(index);
  }

  // ------------------------------------------------------------------- rows

  allItems() {
    return { machines: this.machines, projects: this.projects, tasks: this.tasks, repos: this.repos, clone: this.cloneSources, pick: this.pickable() }[this.level] ?? [];
  }

  items() {
    const all = this.allItems();
    if (!this.query) return all;
    const text = (item) => JSON.stringify(item).toLowerCase();
    return all.filter((item) => text(item).includes(this.query));
  }

  pick(cx, index) {
    const item = this.items()[index];
    if (!item) return;
    this.at = index;
    this.confirmRemove = null;
    if (this.level === "machines") this.act(cx, async () => { await this.openMachine(item); return ""; });
    else if (this.level === "projects") this.act(cx, async () => { await this.openProject(item); return ""; });
    else if (this.level === "tasks") this.act(cx, async () => { await this.openTask(item); return ""; });
    else if (this.level === "repos") this.error = this.openPr(cx, item);
    else if (this.level === "pick") this.togglePick(item);
    else if (this.level === "clone") {
      this.cloneSource = item;
      this.startInput("clone-root", item.root);
      cx.timer.after(0, () => this.input.focus());
    }
  }

  // Vim keys and "/" search, like the other dialogs; letters type while an input is focused.
  key(e, cx) {
    const stroke = e.keystroke;
    const isTyping = this.inputMode && this.inputMode !== "search-kept";
    const count = this.items().length;
    const task = this.level === "repos" ? this.task : this.level === "tasks" ? this.items()[this.at] : null;
    // "?" shows this view's keys; while they show, only ? and esc do anything.
    if (this.isShowingKeys || (isHelpKey(stroke) && !(isTyping))) {
      if (!this.isShowingKeys || isHelpKey(stroke) || stroke === "escape") this.isShowingKeys = !this.isShowingKeys;
      cx.stop_propagation();
      return cx.notify();
    }
    if (isTyping) {
      if (stroke === "escape") { if (this.inputMode !== "search") this.inputMode = null; this.handle.focus(); }
      else if (stroke === "down" && count) this.moveTo((this.at + 1) % count);
      else if (stroke === "up" && count) this.moveTo((this.at + count - 1) % count);
      else return;
    }
    else if (stroke === "/") this.focusInput(cx, "search", this.query);
    else if (stroke === "escape" && this.query) { this.clearSearch(); this.moveTo(0); }
    else if (this.level === "pick" && (stroke === "space" || stroke === "x" || stroke === "l")) { if (this.items()[this.at]) this.togglePick(this.items()[this.at]); }
    else if (this.level === "pick" && stroke === "a") {
      const shown = this.items();
      const isAll = shown.every((n) => this.picked.has(n));
      for (const n of shown) { if (isAll) this.picked.delete(n); else this.picked.add(n); }
    }
    else if (this.level === "pick" && stroke === "enter") this.createPicked(cx);
    else if (this.level === "pick" && (stroke === "escape" || stroke === "h")) this.leavePicker();
    else if (stroke === "a" && task) this.openPicker(task.branch, [], task);
    else if (stroke === "escape") this.close();
    else if ((stroke === "down" || stroke === "j") && count) { this.confirmRemove = null; this.moveTo((this.at + 1) % count); }
    else if ((stroke === "up" || stroke === "k") && count) { this.confirmRemove = null; this.moveTo((this.at + count - 1) % count); }
    else if (stroke === "enter" || stroke === "l") this.pick(cx, this.at);
    else if (stroke === "h" && !this.isBusy) this.back();
    else if (stroke === "r" && this.level !== "machines") this.act(cx, async () => { await this.reload(); return ""; });
    else if (stroke === "i" && this.level === "projects") this.act(cx, () => this.install());
    else if (stroke === "n" && this.level === "projects") this.focusInput(cx, "init", panes().find((p) => p.focused)?.cwd ?? "");
    else if (stroke === "c" && this.level === "projects") this.act(cx, async () => { await this.openClone(); return ""; });
    else if (stroke === "n" && this.level === "tasks") { this.stackOn = null; this.focusInput(cx, "new"); }
    else if (stroke === "s" && task) { this.stackOn = task; this.focusInput(cx, "new"); }
    else if (stroke === "o" && task) this.act(cx, () => this.openSpace(task));
    else if (stroke === "v" && task) { run("tab.new", reviewTab(this.machine.name, this.project.root, task.branch)); this.close(); }
    else if (stroke === "p" && task) this.act(cx, () => this.startJob(`PRs for ${task.branch}`, ["pr", "--task", task.root]));
    else if ((stroke === "x" || stroke === "shift-x") && task) this.act(cx, () => this.removeTask(task, stroke === "shift-x"));
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  focusInput(cx, mode, value = "") {
    this.startInput(mode, value);
    // The box is only drawn while an input mode is on, so it can take focus after this frame.
    cx.timer.after(0, () => this.input.focus());
  }

  // ----------------------------------------------------------------- render

  rowFor(item, t) {
    const repoNames = (names) => names.map((n) => this.short(n)).join(", ");
    switch (this.level) {
      case "machines":
        return { mark: "›", color: t.dim, label: machineLabel(item), detail: `${item.target ?? "local"} · ${item.state}` };
      case "projects":
        return { mark: "›", color: t.dim, label: item.name, detail: `${item.repos.length} repos · ${item.root}` };
      case "clone":
        return { mark: "⇣", color: t.dim, label: item.name, detail: `from ${machineLabel(item.machine)} · ${item.root}` };
      case "tasks": {
        const status = item.status ?? [];
        const isDirty = status.some((s) => s.dirty || s.unpushed);
        const badges = status.map((s) => [this.short(s.name), changeBadge(s)].filter(Boolean).join(" ")).join(" · ");
        return { mark: isDirty ? "●" : "○", color: isDirty ? t.working : t.dim, label: item.branch, detail: badges || repoNames(item.repos) };
      }
      case "pick": {
        const isPicked = this.picked.has(item);
        return { mark: isPicked ? "☑" : "☐", color: isPicked ? t.accent : t.dim, label: this.short(item), detail: this.short(item) === item ? "" : item };
      }
      case "repos": {
        const color = !item.pr ? t.dim : item.pr.state === "MERGED" ? t.done : item.pr.state === "CLOSED" ? t.blocked : t.accent;
        return { mark: item.pr ? "◆" : "◇", color, label: this.short(item.name), detail: [changeBadge(item) || "clean", baseLabel(item, this.task.branch), prLabel(item.pr)].join(" · ") };
      }
    }
  }

  render(cx) {
    if (this.screen) return this.screen.render(cx);
    const t = theme();
    const items = this.items();
    const labelWidth = { tasks: 230, repos: 150 }[this.level] ?? 150;
    const rowView = (item, index) => {
      const row = this.rowFor(item, t);
      return h_flex()
        .flex_none()
        .h(34)
        .px(10)
        .gap(10)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .when(index === this.at, (el) => el.bg(t.selected))
        .when(index !== this.at, (el) => el.hover((s) => s.bg(t.hover)))
        .child(div().flex_none().w(16).text_color(row.color).child(row.mark))
        .child(div().flex_none().w(labelWidth).truncate().font_semibold().text_color(t.foreground).child(row.label))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(row.detail));
    };
    const isLoading = this.allItems() === undefined || (this.level !== "machines" && this.isBusy && !this.allItems().length);
    const title = {
      machines: "Multirepo projects on…",
      projects: `Projects on ${this.machine?.name}`,
      clone: `Clone a project onto ${this.machine?.name}`,
      tasks: `${this.project?.name} tasks`,
      repos: `${this.task?.branch}`,
      pick: this.addingTo ? `Add repos to ${this.newBranch}` : `New task ${this.newBranch}${this.stackOn ? ` on ${this.stackOn.branch}` : ""}: its repos`,
    }[this.level];
    const subtitle = {
      tasks: "A task is one branch across picked repos, in one folder; the other repos are linked in.",
      repos: this.task?.root,
      pick: this.picked.size
        ? `${this.picked.size} ticked: ${[...this.picked].map((n) => this.short(n)).join(", ")}. They get a worktree on the branch${this.addingTo ? ", replacing their link in the task" : "; the others are linked in"}.`
        : this.addingTo
          ? `Already in it: ${this.addingTo.repos.map((n) => this.short(n)).join(", ")}. Ticked repos get a worktree on ${this.newBranch}.`
          : "Tick the repos that get a worktree on the branch; the others are linked in.",
    }[this.level];
    const empty = this.query
      ? `Nothing matches "${this.query}".`
      : {
          machines: "No ssh machines in Herdr.",
          projects: "No projects here yet: n to set one up from a folder, c to clone one from another machine.",
          clone: "No projects on other machines to clone.",
          tasks: "No tasks yet: n to start one.",
          repos: "This task has no repos checked out.",
          pick: this.addingTo ? "The task has every repo of the project already." : "This project lists no repos.",
        }[this.level];
    const hint = this.job
      ? `${this.job.label}… (running in a terminal)`
      : this.isBusy
        ? "working…"
        : this.inputMode && this.inputMode !== "search-kept"
          ? "↵ confirm · ↑↓ choose · esc cancel"
          : {
              machines: "j/k · l pick · / search · esc close",
              projects: "l open · n new from folder · c clone from machine · i install mr CLI · h back · / search",
              clone: "l clone · h back · / search",
              tasks: "l repos · o open space · v review PRs · n new task · s stack a task on it · a add repos · p PRs · x remove · h back · / search",
              repos: "l open PR · o open space · v review PRs · s stack a task on it · a add repos · p create/update PRs · x remove task · h back",
              pick: `space/x tick · a all · ↵ ${this.addingTo ? "add" : "create"} (${this.picked.size}) · / search · h back`,
            }[this.level];
    const isInputShown = Boolean(this.inputMode) || Boolean(this.query);
    const prompt = {
      new: this.stackOn
        ? `New task stacked on ${this.stackOn.branch}: its branch (↵ then picks its repos; ${this.stackOn.branch}'s come ticked)`
        : "New task: its branch, e.g. feat/SHOP-130-x (↵ then picks its repos; repos typed after it come ticked)",
      init: "Folder whose children are the project's repos",
      "clone-root": `Clone ${this.cloneSource?.name} into this folder on ${this.machine?.name}`,
    }[this.inputMode];
    return v_flex()
      .id("multirepo")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .relative()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).truncate().child(title ?? ""))
      .when(Boolean(subtitle), (el) => el.child(div().text_size(12).text_color(t.muted).truncate().child(subtitle)))
      .when(Boolean(prompt), (el) => el.child(div().text_size(12).text_color(t.foreground).child(prompt)))
      .when(isInputShown, (el) =>
        el.child(
          Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1)
            .border_color(this.inputMode && this.inputMode !== "search-kept" ? t.accent : t.input)
            .bg(t.background).text_color(t.foreground),
        ),
      )
      .child(
        v_flex()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            isLoading || items.length === 0
              ? div().p(10).text_color(isLoading ? t.muted : t.dim).child(isLoading ? "…" : empty)
              : v_virtual_list("mr-list", items.length, 34, (i) => String(i), (range) => items.slice(range.start, range.end).map((item, k) => rowView(item, range.start + k)))
                  // Rows of a virtual list cannot hold handlers; the list reports which was clicked.
                  .on_item_click((key, cx) => this.pick(cx, Number(key)))
                  .track_scroll(this.listScroll)
                  .size_full(),
          )
          .child(Scrollbar.vertical("mr-list").absolute().inset_0()),
      )
      .when(Boolean(this.notice) && !this.error, (el) => el.child(div().text_size(12).text_color(t.muted).child(this.notice)))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).truncate().child(`${hint} · ? keys`))
      .when(this.isShowingKeys, (el) => el.child(keyHelp("multirepo-keys", "Multirepo keys", this.keySections, t)));
  }
}
