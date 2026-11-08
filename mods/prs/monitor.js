// PR monitor (sidebar block): every PR of every multirepo project on this Mac and every connected
// machine, and of every plain git repo open in a space, grouped by branch, refreshed every minute;
// changes become Herdr notifications. Each machine asks GitHub with its own gh login.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, Input } from "gpui-base";
import { theme, run, shared, setShared, exec, spaces, panes, focused } from "herdr";
import { notifyAndLog } from "./notifylog.js";
// Every notification also goes in the bell's history (notifylog.js).
const notify = (n) => notifyAndLog(n, "Pull requests");
import { THIS_MAC, connectedMachines, mrJson, openReview, reviewCommand, openBranchCheckout } from "./host.js";
import {
  groupByBranch, checksSummary, reviewSummary, commentCount, prChanges, prKey, prState, matches, isCoveredByProject, machineLabel,
  DEFAULT_FILTERS, filterOptions, matchesFilters, cycleFilter, sectionRows, groupTitle, prStateIcon, checksIcon, age, preferredCopy,
} from "./model.js";
import { Search } from "./search.js";
import { isHelpKey, keyHelp, loadKeys } from "./keyhelp.js";

const REFRESH_MS = 60000;
// Row heights by kind (the virtual list places rows by these).
const HEIGHTS = { section: 30, place: 22, group: 64 };
const ICONS = "mods/prs/icons";
// The checkout button sits at a branch row's right edge. Rows of a virtual list can't hold handlers,
// so a press this close to the list's right edge (its padding, the row's, the button) counts as on it.
const CHECKOUT_BUTTON_ZONE = 40;
const MAX_NOTIFICATIONS = 5;
// Open review requests, shown as a badge on the sidebar's Pull requests tab (sidebar-tabs mod).
const BADGE_KEY = "prs.reviewRequested";
// Filter chips: key to cycle (shift: back), label.
const FILTERS = [
  { name: "author", key: "a", label: "Author" },
  { name: "status", key: "s", label: "Status" },
  { name: "review", key: "v", label: "Review" },
  { name: "checks", key: "c", label: "Checks" },
  { name: "repo", key: "p", label: "Repo" },
  { name: "project", key: "o", label: "Project" },
];

export class Monitor {
  constructor(cx) {
    this.handle = cx.focus_handle();
    // Its key list lives in help-keys.json (also read by the keybinds tab), loaded once.
    this.keySections = [];
    cx.spawn(async (cx) => { this.keySections = await loadKeys("monitor"); cx.notify(); });
    this.listScroll = VirtualListScrollHandle.new();
    this.search = new Search({ onChange: () => this.moveTo(0), onSubmit: (cx) => this.open(cx) });
    this.projects = new Map(); // "machine|root" -> { machine, project, root, isRepo, viewer, prs }
    this.before = null; // every PR at the last refresh, to tell what changed
    this.knownScopes = new Set(); // "machine|root" of every scope listed at the last refresh
    this.errors = [];
    this.at = 0;
    // Sections folded or unfolded against their default (Bots and Recently closed start folded).
    this.toggledSections = new Set(JSON.parse(localStorage.getItem("toggledSections") ?? "[]"));
    this.isShowingFilters = false;
    this.filters = { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem("filters") ?? "{}") };
    this.isRefreshing = false;
    this.refreshedAt = null;
    this.isPressOnCheckout = false; // the last press in the list was on a row's checkout button
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  command(name, cx) {
    if (name === "focus") this.handle.focus();
    else if (name === "refresh") this.refresh(cx);
  }

  refresh(cx) {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    cx.spawn(async (cx) => {
      const errors = [];
      // Rebuilt each time, so a closed space's repo drops out; one whose refresh failed keeps its last data.
      const next = new Map();
      try {
        const machines = [THIS_MAC, ...(await connectedMachines()).sort((a, b) => a.name.localeCompare(b.name))];
        await Promise.all(machines.map((m) => this.refreshMachine(m, errors, next)));
      } catch (error) {
        errors.push(String(error.message ?? error));
      }
      this.projects = next;
      this.errors = errors;
      this.isRefreshing = false;
      this.refreshedAt = new Date();
      this.announce();
      cx.notify();
    });
  }

  async refreshMachine(machine, errors, next) {
    const where = machineLabel(machine.name);
    let projects;
    try {
      projects = (await mrJson(machine.target, ["projects", "--json"])).projects;
    } catch (error) {
      errors.push(`${where}: ${error.message}`);
      return;
    }
    const repos = await this.spaceRepos(machine, projects.map((p) => p.root));
    const scopes = [
      ...projects.map((p) => ({ args: ["--project", p.root], root: p.root, name: p.name })),
      ...repos.map((root) => ({ args: ["--repo", root], root, name: root.split("/").pop() })),
    ];
    await Promise.all(scopes.map(async (scope) => {
      const key = `${machine.name}|${scope.root}`;
      try {
        const data = await mrJson(machine.target, ["prs", ...scope.args]);
        // A repo GitHub refused this time keeps its last PRs: gone and back would read as new.
        const failed = new Set(data.failed ?? []);
        const kept = failed.size ? (this.projects.get(key)?.prs ?? []).filter((pr) => failed.has(pr.slug)) : [];
        // The reason first: the line is cut to the sidebar's width (its tooltip has it all).
        const why = [...new Set(Object.values(data.failedWhy ?? {}))].join(" · ") || "no reason given";
        if (failed.size) errors.push(`${where}: GitHub didn't answer (${why}); last PRs kept for ${[...failed].join(", ")}`);
        next.set(key, { machine: machine.name, project: data.project, root: scope.root, isRepo: Boolean(data.isRepo), viewer: data.viewer, prs: [...data.prs, ...kept] });
      } catch (error) {
        errors.push(`${scope.name} on ${where}: ${error.message}`);
        if (this.projects.has(key)) next.set(key, this.projects.get(key));
      }
    }));
  }

  // The git checkouts open in this machine's spaces (by their panes' live folders), one per repo
  // (worktrees share it), leaving out what a multirepo project or task already covers.
  async spaceRepos(machine, projectRoots) {
    const tabs = new Set(spaces().filter((s) => (s.machine ?? null) === machine.name).flatMap((s) => s.tabs.map((t) => t.id)));
    const folders = [...new Set(panes().filter((p) => tabs.has(p.tab) && p.cwd).map((p) => p.cwd))];
    const byRepo = new Map(); // git common dir -> one checkout of it
    for (const folder of folders) {
      const r = await exec("git", ["-C", folder, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { on: machine.name });
      if (r.code !== 0) continue; // not a git folder: nothing to watch
      const [top, common] = r.stdout.trim().split("\n");
      if (!isCoveredByProject(top, projectRoots) && !byRepo.has(common)) byRepo.set(common, top);
    }
    return [...byRepo.values()];
  }

  // One entry per PR: a project cloned on several machines lists its PRs once, from the machine you
  // work on it on (preferredCopy), so a click and g go there.
  allPrs() {
    const copies = new Map(); // prKey -> the PR on each machine that has its project, by machine name
    for (const p of [...this.projects.values()].sort((a, b) => machineLabel(a.machine).localeCompare(machineLabel(b.machine)))) {
      for (const pr of p.prs) {
        if (!copies.has(prKey(pr))) copies.set(prKey(pr), []);
        copies.get(prKey(pr)).push({ ...pr, machine: p.machine, project: p.project, root: p.root, isRepo: p.isRepo, viewer: p.viewer });
      }
    }
    const all = spaces();
    const focusedMachine = all.find((s) => s.id === focused()?.space)?.machine ?? null;
    return [...copies.values()].map((list) => (list.length === 1 ? list[0] : preferredCopy(list, all, focusedMachine)));
  }

  // A scope not listed last time (a machine that was disconnected, a space just opened) is learnt
  // silently: its PRs are not news.
  announce() {
    const now = this.allPrs();
    const changes = prChanges(this.before, now.filter((pr) => this.knownScopes.has(`${pr.machine}|${pr.root}`)));
    this.before = now;
    this.knownScopes = new Set(this.projects.keys());
    const requested = now.filter((pr) => pr.state === "OPEN" && pr.isReviewRequestedFromMe).length;
    if (shared(BADGE_KEY) !== requested) setShared(BADGE_KEY, requested);
    for (const change of changes.slice(0, MAX_NOTIFICATIONS)) {
      const { pr } = change;
      notify({ title: change.title, body: change.body, level: change.level, action: reviewCommand(pr.machine, pr.root, pr.branch, pr.isRepo, pr.project) });
    }
    if (changes.length > MAX_NOTIFICATIONS) notify({ title: `${changes.length - MAX_NOTIFICATIONS} more PR changes`, body: "See the PR list.", level: "info" });
  }

  groups() {
    const byProject = new Map();
    for (const pr of this.allPrs().filter((pr) => matchesFilters(pr, this.filters))) {
      const key = `${pr.machine}|${pr.root}`;
      if (!byProject.has(key)) byProject.set(key, { machine: pr.machine, project: pr.project, root: pr.root, isRepo: pr.isRepo, prs: [] });
      byProject.get(key).prs.push(pr);
    }
    return groupByBranch([...byProject.values()]).filter((g) => matches({ branch: g.branches, project: g.project, prs: g.prs.map((pr) => [pr.short, pr.number, pr.title, pr.author]) }, this.search.query));
  }

  setFilter(name, step) {
    const options = filterOptions(this.allPrs())[name];
    if (!options) return;
    this.filters[name] = cycleFilter(options, this.filters[name], step);
    localStorage.setItem("filters", JSON.stringify(this.filters));
    this.moveTo(0);
  }

  resetFilters() {
    this.filters = { ...DEFAULT_FILTERS };
    localStorage.setItem("filters", JSON.stringify(this.filters));
    this.moveTo(0);
  }

  moveTo(index) {
    this.at = index;
    this.listScroll.scroll_to_item(index);
  }

  // The sidebar's rows: section headers, project lines, branches (see sectionRows).
  rows() {
    return sectionRows(this.groups(), this.toggledSections, (g) => `${g.project} · ${machineLabel(g.machine)}`);
  }

  // A branch opens its review; a section header folds or unfolds.
  open(cx, index = this.at) {
    const row = this.rows()[index];
    if (!row) return;
    this.moveTo(index);
    if (row.kind === "group") openReview(row.group.machine, row.group.root, row.group.branch, row.group.isRepo, row.group.project, row.group.branches);
    else if (row.kind === "section") this.toggleSection(row.section.id);
    cx.notify();
  }

  clickRow(cx, index) {
    if (this.isPressOnCheckout && this.rows()[index]?.kind === "group") {
      this.moveTo(index);
      this.openCheckout(index);
      return cx.notify();
    }
    this.open(cx, index);
  }

  // The selected branch's checkout in a space (openBranchCheckout); slow steps and failures are notifications.
  openCheckout(index = this.at) {
    const group = this.rows()[index]?.group;
    if (!group) return;
    const { machine, root, branch, isRepo, prs } = group;
    const repos = prs.filter((pr) => pr.branch === branch).map((pr) => pr.short);
    openBranchCheckout({ machine, project: root, branch, isRepo, repos }, (line) => notify({ title: "Pull requests", body: line, level: "info" }))
      .catch((error) => notify({ title: `Could not open ${branch}`, body: String(error.message ?? error), level: "warning" }));
  }

  toggleSection(id) {
    if (this.toggledSections.has(id)) this.toggledSections.delete(id);
    else this.toggledSections.add(id);
    localStorage.setItem("toggledSections", JSON.stringify([...this.toggledSections]));
  }

  key(e, cx) {
    const stroke = e.keystroke;
    const count = this.rows().length;
    // "?" shows this view's keys; while they show, only ? and esc do anything.
    if (this.isShowingKeys || (isHelpKey(stroke) && !(this.search.isTyping))) {
      if (!this.isShowingKeys || isHelpKey(stroke) || stroke === "escape") this.isShowingKeys = !this.isShowingKeys;
      cx.stop_propagation();
      return cx.notify();
    }
    if (this.search.isTyping) {
      if (stroke === "escape") this.search.escape(this.handle);
      else if (stroke === "down" && count) this.moveTo((this.at + 1) % count);
      else if (stroke === "up" && count) this.moveTo((this.at + count - 1) % count);
      else return;
    } else if (stroke === "/") this.search.open(cx);
    else if (stroke === "escape") {
      if (this.search.escape(this.handle)) this.moveTo(0);
      else run("pane.go", { direction: "right" });
    } else if ((stroke === "j" || stroke === "down") && count) this.moveTo((this.at + 1) % count);
    else if ((stroke === "k" || stroke === "up") && count) this.moveTo((this.at + count - 1) % count);
    else if (stroke === "l" || stroke === "enter") this.open(cx);
    else if (stroke === "h") run("pane.go", { direction: "right" });
    else if (stroke === "r") this.refresh(cx);
    else if (stroke === "g") this.openCheckout();
    else if (stroke === "x") this.resetFilters();
    else if (stroke === "f") this.isShowingFilters = !this.isShowingFilters;
    else if (FILTERS.some((f) => stroke === f.key || stroke === `shift-${f.key}`)) {
      const filter = FILTERS.find((f) => stroke.endsWith(f.key));
      this.setFilter(filter.name, stroke.startsWith("shift-") ? -1 : 1);
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  // Click: next value; right click: previous. Changed filters are drawn in the accent color.
  filterChips(t) {
    const options = filterOptions(this.allPrs());
    return h_flex().flex_none().flex_wrap().px(12).pb(8).gap(4)
      .children(FILTERS.filter((f) => options[f.name]).map((f) => {
        const value = this.filters[f.name];
        const isChanged = value !== DEFAULT_FILTERS[f.name];
        return h_flex().id(`filter-${f.name}`).h(22).px(7).gap(4).items_center().rounded(5).border(1).cursor_pointer()
          .border_color(isChanged ? t.accent : t.border).bg(isChanged ? t.selected : t.chrome)
          .hover((s) => s.bg(t.hover))
          .tooltip(`${f.label}: click or ${f.key} for next, right-click or shift-${f.key} for previous`)
          .on_click((_e, cx) => { this.setFilter(f.name, 1); cx.notify(); })
          .on_mouse_down("right", (_e, cx) => { this.setFilter(f.name, -1); cx.notify(); })
          .child(div().text_size(11).text_color(t.dim).child(f.label))
          .child(div().max_w(110).truncate().text_size(11).text_color(isChanged ? t.foreground : t.muted).child(value));
      }))
      .child(div().id("filter-reset").h(22).px(7).flex().items_center().rounded(5).cursor_pointer()
        .text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.resetFilters(); cx.notify(); })
        .child("reset · x"));
  }

  icon(name, size, color) {
    return svg(`${ICONS}/${name}.svg`).size(size).flex_none().text_color(color);
  }

  sectionRow(row, isSelected, t) {
    const isReview = row.section.id === "review";
    // An id: this UI kit applies hover styles only to elements that have one.
    return h_flex().id(row.id).flex_none().h(HEIGHTS.section).px(6).gap(6).items_center().rounded(6).cursor_pointer()
      .when(isSelected, (el) => el.bg(t.selected))
      .when(!isSelected, (el) => el.hover((s) => s.bg(t.hover)))
      .child(this.icon(row.isFolded ? "chevron-right" : "chevron-down", 12, t.dim))
      .child(this.icon(row.section.icon, 13, isReview ? t.accent : t.muted))
      .child(div().text_size(11.5).font_semibold().text_color(isReview ? t.accent : t.muted).child(row.section.title))
      .child(div().px(5).h(15).flex().items_center().rounded(8).bg(isReview ? t.accent : t.raised)
        .text_color(isReview ? t.accent_foreground : t.dim).text_size(10).font_semibold().child(String(row.count)));
  }

  placeRow(row, t) {
    return h_flex().flex_none().h(HEIGHTS.place).pl(26).gap(5).items_center()
      .child(this.icon("folder", 11, t.dim))
      .child(div().truncate().text_size(10.5).text_color(t.dim).child(row.label));
  }

  groupRow(group, isSelected, t) {
    const lead = group.prs.find((pr) => pr.state === "OPEN") ?? group.prs[0];
    const state = prStateIcon(lead);
    const review = reviewSummary(group.prs);
    const comments = commentCount(group.prs);
    const reviewLook = {
      "review requested from you": { icon: "eye", color: t.accent, text: "Review requested" },
      "changes requested": { icon: "x-circle", color: t.blocked, text: "Changes requested" },
      approved: { icon: "check-circle", color: t.done, text: "Approved" },
      "review required": { icon: "clock", color: t.dim, text: "Review required" },
    }[review];
    const details = v_flex().flex_1().min_w(0).gap(3)
      // Title, with the lead PR's state.
      .child(h_flex().h(18).flex_none().gap(6).items_center().min_w(0)
        .child(this.icon(state.icon, 13, t[state.color]))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(group.isOpen ? t.foreground : t.muted).child(groupTitle(group)))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(age(group.updatedAt))))
      // Each repo's PR with its checks.
      .child(h_flex().h(16).flex_none().pl(19).gap(9).items_center().overflow_hidden()
        .children(group.prs.map((pr) => {
          const checks = checksIcon(checksSummary([pr]).state);
          return h_flex().flex_none().gap(3).items_center()
            .when(Boolean(checks), (el) => el.child(this.icon(checks.icon, 11, t[checks.color])))
            .child(div().text_size(11).text_color(t.muted).child(`${pr.short} #${pr.number}`))
            .when(Boolean(pr.stack), (el) => el.child(this.icon("stack", 10, t.dim))
              .child(div().text_size(10.5).text_color(t.dim).child(`${pr.stack.position}/${pr.stack.size}`)));
        })))
      // Review state and conversation.
      .child(h_flex().h(16).flex_none().pl(19).gap(6).items_center()
        .when(Boolean(reviewLook), (el) => el.child(this.icon(reviewLook.icon, 11, reviewLook.color))
          .child(div().text_size(11).text_color(reviewLook.color).child(reviewLook.text)))
        .child(div().flex_1())
        .when(comments > 0, (el) => el.child(this.icon("comment", 11, t.dim)).child(div().text_size(11).text_color(t.dim).child(String(comments)))));
    // Ids: this UI kit applies hover styles only to elements that have one.
    return h_flex().id(group.key).flex_none().h(HEIGHTS.group).pl(8).pr(8).py(6).gap(6).items_center().rounded(7).cursor_pointer()
      .when(isSelected, (el) => el.bg(t.selected))
      .when(!isSelected, (el) => el.hover((s) => s.bg(t.hover)))
      .child(details)
      // Clicked through the list's on_item_click (see CHECKOUT_BUTTON_ZONE).
      .child(div().id(`checkout-${group.key}`).flex_none().size(24).flex().items_center().justify_center().rounded(5)
        .hover((s) => s.bg(t.raised)).tooltip("Open the checkout in a space · g")
        .child(this.icon("terminal", 13, t.dim)));
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const isLoading = this.before === null;
    const filtered = FILTERS.filter((f) => this.filters[f.name] !== DEFAULT_FILTERS[f.name]).length;
    const branches = rows.filter((r) => r.kind === "group").length + rows.filter((r) => r.kind === "section" && r.isFolded).reduce((n, r) => n + r.count, 0);
    const button = (id, icon, tooltip, onClick, isOn = false) => h_flex().id(id).h(22).px(5).gap(3).items_center().rounded(5).cursor_pointer()
      .bg(isOn ? t.selected : t.chrome).hover((s) => s.bg(t.hover)).tooltip(tooltip).on_click((_e, cx) => { onClick(cx); cx.notify(); })
      .child(this.icon(icon, 13, isOn ? t.accent : t.dim));
    return v_flex()
      .id("pr-monitor")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .size_full()
      .min_h(0)
      .relative()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .child(h_flex().px(12).h(38).pt(8).flex_none().gap(4).items_center()
        .child(div().flex_1().text_size(11.5).font_medium().text_color(t.dim).child(`${branches} branch${branches === 1 ? "" : "es"}`))
        .child(button("pr-filter", "filter", `Filter · f${filtered ? ` (${filtered} on)` : ""}`, () => { this.isShowingFilters = !this.isShowingFilters; }, this.isShowingFilters || filtered > 0)
          .when(filtered > 0, (el) => el.child(div().text_size(10).font_semibold().text_color(t.accent).child(String(filtered)))))
        .child(button("pr-refresh", "refresh", this.refreshedAt ? `Refreshed ${this.refreshedAt.toLocaleTimeString()} · r` : "Refresh · r", (cx) => this.refresh(cx))
          .when(this.isRefreshing, (el) => el.opacity(0.5)))
        .child(div().id("pr-keys").h(22).w(20).flex().items_center().justify_center().rounded(5).cursor_pointer().text_size(12).text_color(t.dim)
          .hover((s) => s.bg(t.hover)).tooltip("Keys · ?").on_click((_e, cx) => { this.isShowingKeys = !this.isShowingKeys; cx.notify(); }).child("?")))
      .when(this.isShowingFilters, (el) => el.child(this.filterChips(t)))
      .when(this.search.isShown, (el) => el.child(div().px(8).pb(6).child(
        Input.new(this.search.input).h(28).px(8).items_center().rounded(6).border(1)
          .border_color(this.search.isTyping ? t.accent : t.input).bg(t.background).text_color(t.foreground).text_size(12))))
      .child(v_flex().relative().flex_1().min_h(0).px(6)
        // Fires before the row's click: where the press was decides between the row and its checkout button.
        .on_mouse_down("left", (e) => {
          this.isPressOnCheckout = Boolean(e.local_position && e.bounds) && e.local_position.x >= e.bounds.width - CHECKOUT_BUTTON_ZONE;
        })
        .child(isLoading || !rows.length
          ? div().px(8).text_size(12).text_color(t.dim).child(isLoading ? "Loading PRs…" : this.search.query ? `Nothing matches "${this.search.query}".` : "No PRs match these filters.")
          : v_virtual_list("pr-groups", rows.length, rows.map((r) => HEIGHTS[r.kind]), (i) => rows[i].id, (range) => rows.slice(range.start, range.end).map((row, k) => {
            const index = range.start + k;
            if (row.kind === "section") return this.sectionRow(row, index === this.at, t);
            if (row.kind === "place") return this.placeRow(row, t);
            return this.groupRow(row.group, index === this.at, t);
          }))
            // Rows of a virtual list cannot hold handlers; the list reports which was clicked.
            .on_item_click((key, cx) => this.clickRow(cx, this.rows().findIndex((r) => r.id === key)))
            .track_scroll(this.listScroll)
            .size_full())
        .child(Scrollbar.vertical("pr-groups").absolute().inset_0()))
      .when(this.errors.length > 0, (el) => el.child(div().id("pr-errors").px(16).py(6).text_size(11).text_color(t.blocked).truncate()
        .tooltip(this.errors.join("\n")).child(this.errors.join(" · "))))
      .when(this.isShowingKeys, (el) => el.child(keyHelp("pr-monitor-keys", "Pull request list keys", this.keySections, t, 90)));
  }
}
