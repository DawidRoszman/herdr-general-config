// Projects tab: a multirepo project's tasks on the left, the selected task's repos on the right
// (branch state and PR per repo) with its actions. Reads through `mr`; steps that need typing,
// a confirmation or progress open the multirepo dialog at that step (props addTo, prTask, ...).
// props: { view: "projects" }. One per space: a second one hands over to the first.

import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { theme, run, spaces, panes, openOverlay, shared, setShared } from "herdr";
import { mrJsonOn, machinesWithThisMac, machineLabel, reviewTab, openWorkspace, workspaceOf } from "./remote.js";
import { stackOrder, CHANGED } from "./view.js";
import { icon, taskRow, repoRow, branchParts, TASK_ROW } from "./rows.js";

const REFRESH_MS = 30000;
const DIALOG = { mod: "multirepo", kind: "dialog", width: 760, height: 480 };
const PULL = { mod: "mr-pull", kind: "dialog", width: 460, height: 240 };
// Shared: the tabs holding a Projects view (panes() can't tell one multirepo pane from another).
const PROJECTS_TABS = "multirepo.projectsTabs";
// Shared: tab -> the title its pane header shows (t3-pane reads "<mod>.titles"), so it says Projects, not the mod's name.
const TITLES = "multirepo.titles";

export class ProjectsView {
  constructor(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.ownTab = null;
    this.listScroll = VirtualListScrollHandle.new();
    this.places = undefined; // [{ key, machine: { name, target }, project: { name, root, repos } }]
    this.placeKey = localStorage.getItem("place");
    this.listing = undefined; // mr ls --json of the shown project
    this.details = new Map(); // task root -> { repos } | { error } | { isLoading }
    this.shownDetails = new Map(); // the last loaded ones: shown while a refresh loads, so nothing flickers
    this.at = 0;
    this.error = "";
    this.notice = ""; // what the last action did (a copy), until the next one
    this.query = "";
    this.isTyping = false;
    this.input = InputState.new({ value: "", placeholder: "Search tasks" });
    this.input.on("change", (_e, cx) => { if (!this.isTyping) return; this.query = this.input.value().trim().toLowerCase(); this.moveTo(0); cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.isTyping = false; cx.notify(); });
    this.seenChange = shared(CHANGED);
    cx.timer.every(400, (cx) => { this.claimKeyboard(cx); this.followDialog(cx); this.followWorkspaces(cx); });
    cx.timer.every(REFRESH_MS, (cx) => { if (this.isShown()) this.loadTasks(cx); });
    this.loadedAt = 0;
    this.loadPlaces(cx);
  }

  command(name) {
    if (name === "focus") this.handle.focus();
  }

  // ------------------------------------------------------------------- data

  act(cx, work) {
    cx.spawn(async (cx) => {
      try {
        this.error = (await work(cx)) || "";
      } catch (error) {
        this.error = String(error.message ?? error);
      }
      cx.notify();
    });
  }

  loadPlaces(cx) {
    this.act(cx, async (cx) => {
      const machines = (await machinesWithThisMac()).filter((m) => m.state === "connected");
      const failed = [];
      const lists = await Promise.all(machines.map(async (m) => {
        try {
          return (await mrJsonOn(m.target, ["projects", "--json"])).projects.map((project) => ({ key: `${m.name}|${project.root}`, machine: m, project }));
        } catch (error) {
          failed.push(`${machineLabel(m)}: ${error.message ?? error}`);
          return [];
        }
      }));
      this.places = lists.flat();
      this.placesError = failed.length ? `Could not list projects on ${failed.join("; ")}` : "";
      if (!this.places.some((p) => p.key === this.placeKey)) this.placeKey = this.places[0]?.key ?? null;
      await this.loadTasks(cx);
      return "";
    });
  }

  place() {
    return this.places?.find((p) => p.key === this.placeKey) ?? null;
  }

  async loadTasks(cx) {
    const place = this.place();
    if (!place || this.isLoadingTasks) return;
    this.isLoadingTasks = true;
    const selectedRoot = this.selected()?.root;
    try {
      this.listing = await mrJsonOn(place.machine.target, ["ls", "--json", "--project", place.project.root]);
      this.ordered = stackOrder(this.listing.tasks);
      this.loadedAt = Date.now();
      this.error = "";
      this.refreshDetails();
      const roots = new Set(this.listing.tasks.map((x) => x.root));
      for (const root of this.shownDetails.keys()) if (!roots.has(root)) this.shownDetails.delete(root);
      // The same task stays selected when one was made or removed above it.
      const found = this.tasks().findIndex((x) => x.root === selectedRoot);
      const at = found === -1 ? Math.min(this.at, Math.max(0, this.tasks().length - 1)) : found;
      if (at !== this.at) this.moveTo(at);
      this.loadDetail(cx);
    } catch (error) {
      this.error = String(error.message ?? error);
    } finally {
      this.isLoadingTasks = false;
      cx.notify();
    }
  }

  tasks() {
    const all = this.listing ? this.ordered : [];
    return this.query ? all.filter((t) => `${t.branch} ${t.repos.join(" ")}`.toLowerCase().includes(this.query)) : all;
  }

  selected() {
    return this.tasks()[this.at] ?? null;
  }

  // The selected task's repos with their PRs (mr status asks GitHub, so it's loaded on demand).
  loadDetail(cx) {
    const task = this.selected();
    const place = this.place();
    if (!task || !place || this.details.has(task.root)) return;
    this.details.set(task.root, { isLoading: true });
    cx.spawn(async (cx) => {
      let detail;
      try {
        detail = { repos: (await mrJsonOn(place.machine.target, ["status", "--json", "--task", task.root])).repos };
      } catch (error) {
        detail = { error: String(error.message ?? error) };
      }
      this.details.set(task.root, detail);
      this.shownDetails.set(task.root, detail);
      cx.notify();
    });
  }

  // Details load again (mr status asks GitHub); the old ones stay on screen until then.
  refreshDetails() {
    this.details.clear();
  }

  detailOf(task) {
    const detail = this.details.get(task.root);
    return detail && !detail.isLoading ? detail : this.shownDetails.get(task.root) ?? { isLoading: true };
  }

  short(name) {
    return this.listing?.shorts?.[name] ?? name;
  }

  // ---------------------------------------------------------------- actions

  // The task's workspace: the space already on its folder, else a new one (openWorkspace).
  openTask(cx, task) {
    const place = this.place();
    this.act(cx, async () => { await openWorkspace(task.root, place.machine.name); return ""; });
  }

  review(task) {
    const place = this.place();
    run("tab.new", reviewTab(place.machine.name, place.project.root, task.branch));
  }

  dialog(extra) {
    const place = this.place();
    openOverlay({ ...DIALOG, props: { machine: place.machine.name, project: place.project.root, ...extra } });
  }

  copyBranch(cx, task) {
    cx.write_to_clipboard(task.branch);
    this.notice = `Copied the branch name: ${task.branch}`;
  }

  // The mr-pull mod's popup, on this task instead of the focused terminal's.
  pull(task) {
    openOverlay({ ...PULL, props: { machine: this.place().machine.name, folder: task.root } });
  }

  openPr(cx, repo) {
    if (repo.pr?.url) cx.open_url(repo.pr.url);
  }

  selectPlace(cx, key) {
    this.placeKey = key;
    localStorage.setItem("place", key);
    this.listing = undefined;
    this.shownDetails.clear();
    this.moveTo(0);
    this.loadTasks(cx);
  }

  moveTo(index, cx) {
    if (index !== this.at) this.notice = "";
    this.at = index;
    this.listScroll.scroll_to_item(index);
    if (cx) this.loadDetail(cx);
  }

  refresh(cx) {
    this.refreshDetails();
    this.loadTasks(cx);
  }

  // ------------------------------------------------------------------- keys

  isShown() {
    return spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id === this.ownTab;
  }

  // Its tab, learnt at the first layout (focused() can lag right after tab.new); a second
  // Projects tab in the same space hands over to the earlier one and closes (the earlier one stays,
  // so two copies learning at once, after a reload, never close each other).
  learnTab(cx) {
    if (this.ownTab) return;
    this.ownTab = spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id ?? null;
    const space = spaces().find((s) => s.tabs.some((t) => t.id === this.ownTab));
    const isLive = (id) => panes().some((p) => p.tab === id && p.mod === "multirepo");
    const titles = Object.entries(shared(TITLES) ?? {}).filter(([id]) => id !== this.ownTab && isLive(id));
    if (this.ownTab) setShared(TITLES, Object.fromEntries([...titles, [this.ownTab, "Projects"]]));
    const others = (shared(PROJECTS_TABS) ?? []).filter((id) => id !== this.ownTab && isLive(id));
    setShared(PROJECTS_TABS, [...others, this.ownTab]);
    const position = (id) => space?.tabs.findIndex((t) => t.id === id) ?? -1;
    const earlier = others.find((id) => position(id) !== -1 && position(id) < position(this.ownTab));
    if (earlier) {
      run("tab.select", { id: earlier });
      run("tab.close", { id: this.ownTab, confirmed: true });
    }
  }

  // The dialog stamps CHANGED when a task was made, changed or removed: the list and details reload.
  // So do they when the tab is shown again after missing a refresh while hidden (tasks made in a shell).
  followDialog(cx) {
    const stamp = shared(CHANGED);
    const isShown = this.isShown();
    const isStale = isShown && !this.wasShown && Date.now() - this.loadedAt > REFRESH_MS;
    this.wasShown = isShown;
    if (stamp === this.seenChange && !isStale) return;
    this.seenChange = stamp;
    this.refreshDetails();
    this.loadTasks(cx);
  }

  // A workspace opened or closed elsewhere: the dots and the open button follow.
  followWorkspaces(cx) {
    const open = (this.listing?.tasks ?? []).filter((x) => this.isOpen(x)).map((x) => x.root).join("\n");
    if (open === this.openRoots) return;
    this.openRoots = open;
    cx.notify();
  }

  claimKeyboard(cx) {
    const isPaneFocused = panes().some((p) => p.mod === "multirepo" && p.tab === this.ownTab && p.focused);
    const isNewlyFocused = isPaneFocused && !this.wasPaneFocused;
    this.wasPaneFocused = isPaneFocused;
    if (!isNewlyFocused || this.isTyping || this.handle.is_focused()) return;
    this.handle.focus();
    cx.notify();
  }

  key(e, cx) {
    const stroke = e.keystroke;
    const count = this.tasks().length;
    const task = this.selected();
    if (this.isTyping) {
      if (stroke === "escape") { this.isTyping = false; this.handle.focus(); }
      else if (stroke === "down" && count) this.moveTo((this.at + 1) % count, cx);
      else if (stroke === "up" && count) this.moveTo((this.at + count - 1) % count, cx);
      else return;
    } else if (stroke === "/") {
      this.isTyping = true;
      cx.timer.after(0, () => this.input.focus());
    } else if (stroke === "escape" && this.query) {
      this.query = "";
      this.input.set_value("");
      this.moveTo(0, cx);
    } else if ((stroke === "j" || stroke === "down") && count) this.moveTo((this.at + 1) % count, cx);
    else if ((stroke === "k" || stroke === "up") && count) this.moveTo((this.at + count - 1) % count, cx);
    else if ((stroke === "]" || stroke === "[") && this.places?.length > 1) {
      const at = this.places.findIndex((p) => p.key === this.placeKey);
      this.selectPlace(cx, this.places[(at + (stroke === "]" ? 1 : this.places.length - 1)) % this.places.length].key);
    } else if (stroke === "n" && this.place()) this.dialog({ newTask: "" });
    else if (stroke === "r") this.refresh(cx);
    else if (!task) return;
    else if (stroke === "enter" || stroke === "o" || stroke === "l") this.openTask(cx, task);
    else if (stroke === "v") this.review(task);
    else if (stroke === "y") this.copyBranch(cx, task);
    else if (stroke === "u") this.pull(task);
    else if (stroke === "p") this.dialog({ prTask: task.root });
    else if (stroke === "a") this.dialog({ addTo: task.root });
    else if (stroke === "s") this.dialog({ newTask: "", stackOn: task.root });
    else if (stroke === "x") this.dialog({ removeTask: task.root });
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ----------------------------------------------------------------- render

  button(id, iconName, label, onClick, t, { isPrimary = false, isDanger = false, tooltip = "" } = {}) {
    const text = isPrimary ? t.solid_foreground : isDanger ? t.blocked : t.foreground;
    return h_flex().id(id).flex_none().h(28).px(10).gap(6).items_center().rounded(7).cursor_pointer()
      .bg(isPrimary ? t.solid : t.raised).border(1).border_color(isPrimary ? t.solid : isDanger ? `${t.blocked}80` : t.input)
      .text_color(text).hover((s) => s.opacity(0.88)).when(Boolean(tooltip), (el) => el.tooltip(tooltip))
      .on_click((_e, cx) => { onClick(cx); cx.notify(); })
      .child(icon(iconName, 14, text))
      .when(Boolean(label), (el) => el.child(div().text_size(12.5).font_medium().child(label)));
  }

  isOpen(task) {
    return Boolean(workspaceOf(task.root, this.place()?.machine.name ?? null));
  }

  // The task's stack, bottom first: a chip per layer that selects it, and what it builds on and is under.
  stackPanel(task, t) {
    const layers = task.stack;
    const isListed = (branch) => this.ordered.some((x) => x.branch === branch);
    const above = this.ordered.filter((x) => x.parent === task.branch).map((x) => x.branch);
    const words = [
      `Layer ${layers.indexOf(task.branch) + 1} of ${layers.length}`,
      task.parent ? `on ${task.parent}${isListed(task.parent) ? "" : " (no task here)"}` : "the bottom",
      above.length ? `under ${above.join(", ")}` : "the top",
    ].join(" · ");
    const chip = (branch) => {
      const { ticket, rest } = branchParts(branch);
      const isThis = branch === task.branch;
      return h_flex().id(`layer-${branch}`).flex_none().h(24).px(8).items_center().rounded(6).border(1).cursor_pointer()
        .border_color(isThis ? t.accent : t.border).bg(isThis ? t.selected : t.background).hover((s) => s.bg(t.hover))
        .tooltip(isThis ? branch : `Select ${branch}`)
        .on_click((_e, cx) => { this.selectBranch(cx, branch); cx.notify(); })
        .child(div().text_size(11.5).text_color(isThis ? t.foreground : t.muted).child(ticket || rest));
    };
    return v_flex().gap(6).pt(4)
      .child(h_flex().gap(5).items_center().min_w(0).child(icon("stack", 12, t.accent))
        .child(div().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(words)))
      .child(h_flex().gap(4).flex_wrap().items_center()
        .children(layers.flatMap((branch, n) => [...(n ? [icon("chevron-right", 11, t.dim)] : []), chip(branch)])))
      .when(!task.on && Boolean(task.stackedOn), (el) => el.child(div().text_size(11).text_color(t.dim)
        .child("Found from its branches, not recorded in the task: p opens new PRs into the base branch and doesn't link them into the GitHub stack.")));
  }

  selectBranch(cx, branch) {
    if (!this.tasks().some((x) => x.branch === branch)) { this.query = ""; this.input.set_value(""); }
    this.moveTo(this.tasks().findIndex((x) => x.branch === branch), cx);
  }

  detail(task, t) {
    const place = this.place();
    const detail = this.detailOf(task);
    const linked = (this.listing?.repos ?? []).filter((n) => !task.repos.includes(n));
    return v_flex().id("projects-detail").flex_1().min_w(0).h_full().overflow_y_scrollbar().px(20).py(16).gap(14)
      .child(v_flex().gap(4)
        .child(h_flex().id("copy-branch").min_w(0).px(4).ml(-4).rounded(5).cursor_pointer()
          .hover((s) => s.bg(t.hover)).tooltip(`Copy ${task.branch} · y`)
          .on_click((_e, cx) => { this.copyBranch(cx, task); cx.notify(); })
          .child(div().min_w(0).text_size(17).font_semibold().text_color(t.foreground).truncate().child(task.branch)))
        .child(div().text_size(11.5).text_color(t.dim).truncate().child(`${machineLabel(place.machine)} · ${task.root}`))
        .when(task.stack.length > 0, (el) => el.child(this.stackPanel(task, t))))
      .child(h_flex().gap(6).flex_wrap()
        .child(this.button("act-open", "terminal", this.isOpen(task) ? "Go to workspace" : "Open workspace", (cx) => this.openTask(cx, task), t, { isPrimary: true, tooltip: "o / enter" }))
        .child(this.button("act-review", "eye", "Review PRs", () => this.review(task), t, { tooltip: "v" }))
        .child(this.button("act-pull", "chevron-down", "Pull", () => this.pull(task), t, { tooltip: "u: fast-forward every repo of the task from its upstream" }))
        .child(this.button("act-pr", "send", "Create / update PRs", () => this.dialog({ prTask: task.root }), t, { tooltip: "p: push, open missing PRs, cross-link them" }))
        .child(this.button("act-add", "plus", "Add repos", () => this.dialog({ addTo: task.root }), t, { tooltip: "a" }))
        .child(this.button("act-stack", "stack", "Stack task", () => this.dialog({ newTask: "", stackOn: task.root }), t, { tooltip: "s: a new task on this one; its PRs target this branch, in a GitHub stack" }))
        .child(this.button("act-remove", "trash", "Remove", () => this.dialog({ removeTask: task.root }), t, { isDanger: true, tooltip: "x: asks first; keeps unpushed work" })))
      .child(h_flex().gap(6).items_center().child(icon("repo", 13, t.dim))
        .child(div().text_size(12).font_semibold().text_color(t.muted).child(`Repos on the branch · ${task.repos.length}`)))
      .child(detail.repos
        ? v_flex().gap(6).children(detail.repos.map((repo) => repoRow(repo, task.branch, { short: (n) => this.short(n), onOpenPr: (cx, r) => this.openPr(cx, r) }, t)))
        : div().text_size(12).text_color(detail.error ? t.blocked : t.dim).child(detail.error ?? "Loading each repo's state and PR…"))
      .when(linked.length > 0, (el) => el.child(v_flex().gap(6)
        .child(div().text_size(12).font_semibold().text_color(t.muted).child(`Linked in from the project · ${linked.length}`))
        .child(h_flex().gap(6).flex_wrap().items_center()
          .children(linked.map((name) => h_flex().id(`linked-${name}`).h(24).px(8).gap(5).items_center().rounded(6).border(1).border_color(t.border).bg(t.background)
            .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`Add ${this.short(name)} to the task: a worktree on the branch`)
            .on_click(() => this.dialog({ addTo: task.root, addRepos: [name] }))
            .child(icon("repo", 12, t.dim))
            .child(div().text_size(11.5).text_color(t.muted).child(this.short(name))))))
        .child(div().text_size(11).text_color(t.dim).child("Links to the project's checkouts · click one to work on it in this task"))));
  }

  render() {
    const t = theme();
    const tasks = this.tasks();
    const task = this.selected();
    const place = this.place();
    return v_flex().id("projects").on_size_change((_s, cx) => this.learnTab(cx)).track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().h(52).px(16).gap(10).items_center().border_b(1).border_color(t.border)
        .child(icon("folder", 16, t.muted))
        .child(div().text_size(15).font_semibold().child("Projects"))
        .child(h_flex().flex_1().min_w(0).gap(6).items_center().overflow_hidden().children((this.places ?? []).map((p) => {
          const isOn = p.key === this.placeKey;
          return h_flex().id(`place-${p.key}`).flex_none().h(26).px(9).gap(6).items_center().rounded(13).border(1).cursor_pointer()
            .border_color(isOn ? t.accent : t.border).bg(isOn ? t.selected : t.background).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.selectPlace(cx, p.key))
            .child(div().text_size(12.5).font_medium().text_color(isOn ? t.foreground : t.muted).child(p.project.name))
            .child(div().text_size(11).text_color(t.dim).child(machineLabel(p.machine)));
        })))
        .when(Boolean(place), (el) => el.child(this.button("act-new", "plus", "New task", () => this.dialog({ newTask: "" }), t, { isPrimary: true, tooltip: "n" })))
        .child(this.button("act-project", "folder", place ? "" : "Add project", () => openOverlay(DIALOG), t, { tooltip: "Projects on a machine: set one up from a folder of repos, or clone one from another machine" }))
        .child(this.button("act-refresh", "refresh", "", (cx) => this.refresh(cx), t, { tooltip: "Refresh · r" })))
      .child(h_flex().flex_1().min_h(0)
        // Tasks.
        .child(v_flex().w(380).max_w_2_5().flex_none().h_full().border_r(1).border_color(t.border)
          .child(h_flex().flex_none().h(36).px(14).items_center().gap(6)
            .child(div().flex_1().text_size(11.5).font_medium().text_color(t.dim).child(this.listing ? `${tasks.length} task${tasks.length === 1 ? "" : "s"}` : "")))
          .when(this.isTyping || Boolean(this.query), (el) => el.child(div().px(10).pb(6).child(
            Input.new(this.input).h(28).px(8).items_center().rounded(6).border(1).border_color(this.isTyping ? t.accent : t.input).bg(t.background).text_size(12.5))))
          .child(v_flex().relative().flex_1().min_h(0).px(6)
            .child(!this.listing || !tasks.length
              ? div().p(10).text_size(12.5).text_color(t.dim).child(this.places === undefined || (place && !this.listing) ? "Loading…" : this.query ? `Nothing matches "${this.query}".` : place ? "No tasks yet: New task (n) starts one." : "")
              : v_virtual_list("projects-tasks", tasks.length, TASK_ROW, (i) => tasks[i].root, (range) => tasks.slice(range.start, range.end).map((x, k) =>
                taskRow(x, { isSelected: range.start + k === this.at, isOpen: this.isOpen(x), short: (n) => this.short(n) }, t)))
                .on_item_click((root, cx) => { this.moveTo(this.tasks().findIndex((x) => x.root === root), cx); cx.notify(); })
                .track_scroll(this.listScroll)
                .size_full())
            .child(Scrollbar.vertical("projects-tasks").absolute().inset_0())))
        // The selected task.
        .child(task && place ? this.detail(task, t) : div().flex_1().p(20).text_size(12.5).text_color(t.dim)
          .child(place ? "Pick a task." : this.places?.length === 0 ? "No multirepo projects on any connected machine yet. Add project (top right) sets one up from a folder of git repos, or clones one from another machine." : "")))
      .when(Boolean(this.notice) && !this.error, (el) => el.child(div().flex_none().px(16).py(6).text_size(12).text_color(t.muted).truncate().child(this.notice)))
      .when(Boolean(this.error || this.placesError), (el) => el.child(div().flex_none().px(16).py(6).text_size(12).text_color(t.blocked).child([this.error, this.placesError].filter(Boolean).join(" · "))))
      .child(div().flex_none().px(16).py(8).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child("j/k task · o/↵ open (or go to) workspace · v review PRs · y copy branch · u pull · p PRs · a add repos · s stack task · x remove · n new task · [ ] project · / search · r refresh"));
  }
}
