// Projects tab: a multirepo project's tasks on the left, the selected task's repos on the right
// (branch state and PR per repo) with its actions. Reads through `mr`; steps that need typing,
// a confirmation or progress open the multirepo dialog at that step (props addTo, prTask, ...).
// props: { view: "projects" }. One per space: a second one hands over to the first.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { theme, run, spaces, panes, openOverlay, settings } from "herdr";
import { mrJsonOn, machinesWithThisMac, machineLabel, reviewTab, openWorkspace } from "./remote.js";
import { changeBadge, prLabel } from "./view.js";

const ICONS = "mods/prs/icons";
const TASK_ROW = 58;
const REFRESH_MS = 30000;
const DIALOG = { mod: "multirepo", kind: "dialog", width: 760, height: 480 };

const icon = (name, size, color) => svg(`${ICONS}/${name}.svg`).size(size).flex_none().text_color(color);
// "feat/SHOP-110-search-filters" -> { ticket: "SHOP-110", rest: "search filters" }
function branchParts(branch) {
  const m = branch.match(/^(?:[a-z]+\/)?([A-Z][A-Z0-9]*-\d+)-?(.*)$/);
  return m ? { ticket: m[1], rest: m[2].replace(/-/g, " ") } : { ticket: "", rest: branch.replace(/^[a-z]+\//, "").replace(/-/g, " ") };
}

export class ProjectsView {
  constructor(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.ownTab = null;
    this.listScroll = VirtualListScrollHandle.new();
    this.places = undefined; // [{ key, machine: { name, target }, project: { name, root, repos } }]
    this.placeKey = localStorage.getItem("place");
    this.listing = undefined; // mr ls --json of the shown project
    this.details = new Map(); // task root -> { at, repos } | { error }
    this.at = 0;
    this.error = "";
    this.query = "";
    this.isTyping = false;
    this.input = InputState.new({ value: "" });
    this.input.on("change", (_e, cx) => { if (!this.isTyping) return; this.query = this.input.value().trim().toLowerCase(); this.moveTo(0); cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.isTyping = false; cx.notify(); });
    cx.timer.every(400, (cx) => this.claimKeyboard(cx));
    cx.timer.every(REFRESH_MS, (cx) => { if (this.isShown()) this.loadTasks(cx); });
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
      const lists = await Promise.all(machines.map(async (m) => {
        try {
          return (await mrJsonOn(m.target, ["projects", "--json"])).projects.map((project) => ({ key: `${m.name}|${project.root}`, machine: m, project }));
        } catch {
          return []; // a machine without python3 or ssh access has no projects to show
        }
      }));
      this.places = lists.flat();
      if (!this.places.some((p) => p.key === this.placeKey)) this.placeKey = this.places[0]?.key ?? null;
      await this.loadTasks(cx);
      return this.places.length ? "" : "No multirepo projects on any connected machine: set one up with the multirepo dialog (n on a folder of repos).";
    });
  }

  place() {
    return this.places?.find((p) => p.key === this.placeKey) ?? null;
  }

  async loadTasks(cx) {
    const place = this.place();
    if (!place || this.isLoadingTasks) return;
    this.isLoadingTasks = true;
    try {
      this.listing = await mrJsonOn(place.machine.target, ["ls", "--json", "--project", place.project.root]);
      this.details.clear();
      this.loadDetail(cx);
    } catch (error) {
      this.error = String(error.message ?? error);
    } finally {
      this.isLoadingTasks = false;
      cx.notify();
    }
  }

  tasks() {
    const all = this.listing?.tasks ?? [];
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
      try {
        this.details.set(task.root, { repos: (await mrJsonOn(place.machine.target, ["status", "--json", "--task", task.root])).repos });
      } catch (error) {
        this.details.set(task.root, { error: String(error.message ?? error) });
      }
      cx.notify();
    });
  }

  short(name) {
    return this.listing?.shorts?.[name] ?? name;
  }

  // ---------------------------------------------------------------- actions

  // The task's workspace: the space already on its folder, else a new one (claude, terminal, nvim).
  openTask(cx, task) {
    const place = this.place();
    const tabs = new Map(spaces().filter((s) => s.machine === place.machine.name).flatMap((s) => s.tabs.map((t) => [t.id, s])));
    const pane = panes().find((p) => p.cwd?.startsWith(task.root) && tabs.has(p.tab));
    if (pane) {
      run("space.select", { id: tabs.get(pane.tab).id });
      return;
    }
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

  openPr(cx, repo) {
    if (repo.pr?.url) cx.open_url(repo.pr.url);
  }

  selectPlace(cx, key) {
    this.placeKey = key;
    localStorage.setItem("place", key);
    this.listing = undefined;
    this.moveTo(0);
    this.loadTasks(cx);
  }

  moveTo(index, cx) {
    this.at = index;
    this.listScroll.scroll_to_item(index);
    if (cx) this.loadDetail(cx);
  }

  // ------------------------------------------------------------------- keys

  isShown() {
    return spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id === this.ownTab;
  }

  // Its tab, learnt at the first layout (focused() can lag right after tab.new); a second
  // Projects tab in the same space hands over to the first one and closes.
  learnTab(cx) {
    if (this.ownTab) return;
    this.ownTab = spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id ?? null;
    const space = spaces().find((s) => s.tabs.some((t) => t.id === this.ownTab));
    const other = panes().find((p) => p.mod === "multirepo" && p.tab !== this.ownTab && space?.tabs.some((t) => t.id === p.tab));
    if (other) {
      run("tab.select", { id: other.tab });
      run("tab.close", { id: this.ownTab, confirmed: true });
    }
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
    } else if (stroke === "escape") {
      if (this.query) { this.query = ""; this.input.set_value(""); this.moveTo(0, cx); }
      else run("pane.close");
    } else if ((stroke === "j" || stroke === "down") && count) this.moveTo((this.at + 1) % count, cx);
    else if ((stroke === "k" || stroke === "up") && count) this.moveTo((this.at + count - 1) % count, cx);
    else if ((stroke === "]" || stroke === "[") && this.places?.length > 1) {
      const at = this.places.findIndex((p) => p.key === this.placeKey);
      this.selectPlace(cx, this.places[(at + (stroke === "]" ? 1 : this.places.length - 1)) % this.places.length].key);
    } else if (stroke === "n" && this.place()) this.dialog({ newTask: "" });
    else if (stroke === "r") { this.details.clear(); this.loadTasks(cx); }
    else if (!task) return;
    else if (stroke === "enter" || stroke === "o" || stroke === "l") this.openTask(cx, task);
    else if (stroke === "v") this.review(task);
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

  taskRow(task, isSelected, t) {
    const { ticket, rest } = branchParts(task.branch);
    const status = task.status ?? [];
    const isDirty = status.some((s) => s.dirty);
    const unpushed = status.reduce((n, s) => n + s.unpushed, 0);
    return v_flex().flex_none().h(TASK_ROW).px(10).py(7).gap(4).rounded(8).cursor_pointer()
      .when(isSelected, (el) => el.bg(t.selected))
      .when(!isSelected, (el) => el.hover((s) => s.bg(t.hover)))
      .child(h_flex().h(18).gap(6).items_center().min_w(0)
        .child(icon("branch", 13, isDirty ? t.working : t.dim))
        .when(Boolean(ticket), (el) => el.child(div().flex_none().text_size(12.5).font_semibold().text_color(t.accent).child(ticket)))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(rest || task.branch))
        .when(isDirty, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.working).child("● changes")))
        .when(unpushed > 0, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.ansi4).child(`↑${unpushed}`))))
      .child(h_flex().h(16).pl(19).gap(6).items_center().overflow_hidden()
        .children(task.repos.map((name) => div().flex_none().px(6).h(16).flex().items_center().rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child(this.short(name)))));
  }

  repoRow(repo, t) {
    const pr = repo.pr;
    const prLook = !pr ? null : pr.state === "MERGED" ? ["merge", t.ansi5] : pr.state === "CLOSED" ? ["pull-request-closed", t.blocked] : pr.isDraft ? ["pull-request-draft", t.dim] : ["pull-request", t.done];
    const badge = changeBadge(repo);
    return h_flex().id(`repo-${repo.name}`).h(44).px(12).gap(10).items_center().rounded(8).border(1).border_color(t.border).bg(t.background)
      .child(icon("repo", 15, t.dim))
      .child(v_flex().w(170).flex_none().min_w(0)
        .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(this.short(repo.name)))
        .child(div().truncate().text_size(11).text_color(t.dim).child(`vs ${repo.base}`)))
      .child(div().flex_1().min_w(0).truncate().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
        .text_color(badge ? (repo.dirty ? t.working : t.muted) : t.dim).child(badge || "clean"))
      .when(Boolean(pr), (el) => el.child(h_flex().id(`repo-pr-${repo.name}`).flex_none().h(26).px(8).gap(6).items_center().rounded(6).cursor_pointer()
        .bg(t.raised).hover((s) => s.bg(t.hover)).tooltip(`${pr.title} · open on GitHub`)
        .on_click((_e, cx) => this.openPr(cx, repo))
        .child(icon(prLook[0], 13, prLook[1]))
        .child(div().text_size(12).text_color(t.foreground).child(prLabel(pr).replace(/^PR /, "")))
        .child(icon("external", 11, t.dim))))
      .when(!pr, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child("no PR yet")));
  }

  detail(task, t) {
    const place = this.place();
    const detail = this.details.get(task.root) ?? { isLoading: true };
    const linked = (this.listing?.repos ?? []).filter((n) => !task.repos.includes(n));
    return v_flex().id("projects-detail").flex_1().min_w(0).h_full().overflow_y_scrollbar().px(20).py(16).gap(14)
      .child(v_flex().gap(4)
        .child(div().text_size(17).font_semibold().text_color(t.foreground).truncate().child(task.branch))
        .child(div().text_size(11.5).text_color(t.dim).truncate().child(`${task.root} · ${machineLabel(place.machine)}`)))
      .child(h_flex().gap(6).flex_wrap()
        .child(this.button("act-open", "terminal", "Open workspace", (cx) => this.openTask(cx, task), t, { isPrimary: true, tooltip: "o / enter" }))
        .child(this.button("act-review", "eye", "Review PRs", () => this.review(task), t, { tooltip: "v" }))
        .child(this.button("act-pr", "send", "Create / update PRs", () => this.dialog({ prTask: task.root }), t, { tooltip: "p: push, open missing PRs, cross-link them" }))
        .child(this.button("act-add", "plus", "Add repos", () => this.dialog({ addTo: task.root }), t, { tooltip: "a" }))
        .child(this.button("act-stack", "plus", "Stack task", () => this.dialog({ newTask: "", stackOn: task.root }), t, { tooltip: "s: a new task on this one; its PRs target this branch, in a GitHub stack" }))
        .child(this.button("act-remove", "trash", "Remove", () => this.dialog({ removeTask: task.root }), t, { isDanger: true, tooltip: "x: asks first; keeps unpushed work" })))
      .child(h_flex().gap(6).items_center().child(icon("repo", 13, t.dim))
        .child(div().text_size(12).font_semibold().text_color(t.muted).child(`Repos on the branch · ${task.repos.length}`)))
      .child(detail.repos
        ? v_flex().gap(6).children(detail.repos.map((repo) => this.repoRow(repo, t)))
        : div().text_size(12).text_color(detail.error ? t.blocked : t.dim).child(detail.error ?? "Loading each repo's state and PR…"))
      .when(linked.length > 0, (el) => el.child(v_flex().gap(4)
        .child(div().text_size(12).font_semibold().text_color(t.muted).child(`Linked in from the project · ${linked.length}`))
        .child(div().text_size(11.5).text_color(t.dim).child(`${linked.map((n) => this.short(n)).join(", ")} (a, Add repos, gives one a worktree on the branch)`))));
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
        .child(this.button("act-refresh", "refresh", "", (cx) => { this.details.clear(); this.loadTasks(cx); }, t, { tooltip: "r" })))
      .child(h_flex().flex_1().min_h(0)
        // Tasks.
        .child(v_flex().w(380).flex_none().h_full().border_r(1).border_color(t.border)
          .child(h_flex().flex_none().h(36).px(14).items_center().gap(6)
            .child(div().flex_1().text_size(11.5).font_medium().text_color(t.dim).child(this.listing ? `${tasks.length} task${tasks.length === 1 ? "" : "s"}` : "")))
          .when(this.isTyping || Boolean(this.query), (el) => el.child(div().px(10).pb(6).child(
            Input.new(this.input).h(28).px(8).items_center().rounded(6).border(1).border_color(this.isTyping ? t.accent : t.input).bg(t.background).text_size(12.5))))
          .child(v_flex().relative().flex_1().min_h(0).px(6)
            .child(!this.listing || !tasks.length
              ? div().p(10).text_size(12.5).text_color(t.dim).child(this.places === undefined || (place && !this.listing) ? "Loading…" : this.query ? `Nothing matches "${this.query}".` : place ? "No tasks yet: New task (n) starts one." : "")
              : v_virtual_list("projects-tasks", tasks.length, TASK_ROW, (i) => tasks[i].root, (range) => tasks.slice(range.start, range.end).map((x, k) => this.taskRow(x, range.start + k === this.at, t)))
                .on_item_click((root, cx) => { this.moveTo(this.tasks().findIndex((x) => x.root === root), cx); cx.notify(); })
                .track_scroll(this.listScroll)
                .size_full())
            .child(Scrollbar.vertical("projects-tasks").absolute().inset_0())))
        // The selected task.
        .child(task && place ? this.detail(task, t) : div().flex_1().p(20).text_size(12.5).text_color(t.dim).child(place ? "Pick a task." : "")))
      .when(Boolean(this.error), (el) => el.child(div().flex_none().px(16).py(6).text_size(12).text_color(t.blocked).child(this.error)))
      .child(div().flex_none().px(16).py(8).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child("j/k task · o/↵ open workspace · v review PRs · p PRs · a add repos · x remove · n new task · [ ] project · / search · r refresh"));
  }
}
