import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, agents, panes, theme, run, props, shared, home, exec, notify, readTextFile, writeTextFile, watchFolder, checking, window } from "herdr";
import { boardScope, boardSources, combineViews, parseBoard, buildView, taskSpace, prGroups, age, clock, checkItem, uncheckItem } from "./board.js";

const JOURNAL = `${home()}/work/daily-reports/journal.html`;
const RELOAD_MS = 20000;
const WHO_LABEL = { you: "you", agent: "agent", coordinator: "coordinator" };

export default class CoordinatorBoard extends View {
  init(_props, cx) {
    this.folders = [];
    this.texts = new Map();
    this.errors = new Map();
    this.hasJournal = false;
    this.pendingIds = new Set();
    this.failures = new Map();
    this.watching = new Set();
    if (checking()) return;
    this.checkJournal(cx);
    cx.timer.every(RELOAD_MS, (cx) => { this.reload(cx); this.checkJournal(cx); cx.notify(); });
  }

  checkJournal(cx) {
    cx.spawn(async (cx) => {
      const hasJournal = (await readTextFile(JOURNAL).catch(() => null)) !== null;
      if (hasJournal !== this.hasJournal) { this.hasJournal = hasJournal; cx.notify(); }
    });
  }

  openJournal() {
    const opener = window()?.platform === "macos" ? "open" : "xdg-open";
    exec(opener, [JOURNAL]).then((result) => {
      if (result.code !== 0) notify({ title: "Couldn't open the journal", body: result.stderr.trim() || JOURNAL, level: "error" });
    }, (error) => notify({ title: "Couldn't open the journal", body: String(error.message ?? error), level: "error" }));
  }

  journalLink(t) {
    if (!this.hasJournal) return div().flex_none().text_size(11).text_color(t.dim).tooltip(JOURNAL).child("no journal");
    return h_flex().id("journal").flex_none().gap(4).items_center().px(6).py(2).rounded(5).cursor_pointer()
      .text_size(12).text_color(t.accent).hover((s) => s.bg(t.hover)).tooltip(JOURNAL)
      .on_click(() => this.openJournal())
      .child("Journal ↗");
  }

  scope() {
    const published = shared("context") ?? {};
    const tab = panes().find((pane) => pane.pane === props()?.pane)?.tab;
    const spaceId = spaces().find((space) => (tab ? space.tabs.some((t) => t.id === tab) : space.active))?.id;
    return boardScope({ spaceId, coordinators: published.coordinators, current: published.current ?? props()?.context });
  }

  watch(folder, cx) {
    if (this.watching.has(folder)) return;
    this.watching.add(folder);
    cx.spawn(async (cx) => {
      try {
        while (this.folders.includes(folder)) {
          try {
            await watchFolder(folder);
          } catch (error) {
            this.errors.set(folder, `Watching ${folder}: ${error.message ?? error}`);
            cx.notify();
            return;
          }
          await this.reload(cx);
        }
      } finally {
        this.watching.delete(folder);
      }
    });
  }

  async reload(cx) {
    let hasChanged = false;
    await Promise.all(this.folders.map(async (folder) => {
      let text = null, error = null;
      try {
        text = await readTextFile(`${folder}/board.json`);
      } catch (failure) {
        error = `Reading ${folder}/board.json: ${failure.message ?? failure}`;
      }
      if (!this.folders.includes(folder) || (this.texts.has(folder) && text === this.texts.get(folder) && !error)) return;
      this.texts.set(folder, text);
      error ? this.errors.set(folder, error) : this.errors.delete(folder);
      hasChanged = true;
    }));
    if (hasChanged) cx.notify();
  }

  follow(sources, cx) {
    const folders = sources.map((source) => source.folder);
    if (folders.join("\n") === this.folders.join("\n")) return;
    const added = folders.filter((folder) => !this.folders.includes(folder));
    this.folders = folders;
    for (const known of [...this.texts.keys()]) if (!folders.includes(known)) { this.texts.delete(known); this.errors.delete(known); }
    cx.spawn(async (cx) => this.reload(cx));
    for (const folder of added) this.watch(folder, cx);
  }

  goToTask(task) {
    const space = taskSpace(task, spaces(), panes());
    if (space) run("space.select", { id: space.id });
    else if (task.agent) run("agent.focus", { terminal: task.agent });
  }

  statusMark(t, status) {
    if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900);
    const color = status === "blocked" ? t.blocked : status === "done" ? t.accent : status === "idle" ? t.ansi2 : t.dim;
    return div().size(7).rounded_full().bg(color);
  }

  sectionTitle(t, text, count) {
    return h_flex().gap(6).items_center().pt(6).pb(2).text_size(11).font_semibold().text_color(t.dim)
      .child(text).when(count !== undefined, (el) => el.child(div().text_color(t.muted).child(String(count))));
  }

  moveItem({ id, uid, folder }, move, cx) {
    const file = `${folder}/board.json`;
    this.pendingIds.add(uid);
    this.failures.delete(uid);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        for (let attempt = 1; ; attempt++) {
          const text = await readTextFile(file);
          if (text === null) throw new Error("board.json is missing");
          const result = move(JSON.parse(text), id, new Date().toISOString());
          if (result.error) throw new Error(result.error);
          try {
            await writeTextFile(file, `${JSON.stringify(result.board, null, 2)}\n`, text);
            break;
          } catch (error) {
            if (attempt >= 3) throw error;
          }
        }
        await this.reload(cx);
      } catch (error) {
        this.failures.set(uid, `Not saved: ${error.message ?? error}`);
      }
      this.pendingIds.delete(uid);
      cx.notify();
    });
  }

  checkButton(t, item, isChecked) {
    const isPending = this.pendingIds.has(item.uid);
    return div().id(`check-${item.uid}`).flex_none().size(20).rounded_full().border_1().flex().items_center().justify_center()
      .text_size(11).font_semibold()
      .border_color(isChecked ? t.accent : t.input).bg(isChecked ? t.accent : t.surface)

      .text_color(isChecked ? t.accent_foreground : t.surface)
      .when(isPending, (el) => el.opacity(0.5))
      .when(!isPending, (el) => el.cursor_pointer()
        .hover((s) => (isChecked ? s.opacity(0.8) : s.border_color(t.accent).text_color(t.accent)))
        .tooltip(isChecked ? "Not tried yet: put it back" : "Mark as tried")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.moveItem(item, isChecked ? uncheckItem : checkItem, cx); }))
      .child("✓");
  }

  failure(t, item) {
    const failure = this.failures.get(item.uid);
    return failure ? div().text_size(11).text_color(t.blocked).child(failure) : null;
  }

  needsYou(t, view, isMany) {
    const items = view.needsYou;

    const tone = items.some((item) => !item.isTry) ? t.blocked : items.length ? t.accent : null;
    const box = v_flex().id("needs-you").gap(6).p(10).rounded(10).border_1()
      .border_color(tone ?? t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center().text_size(12).font_semibold()
        .text_color(tone ?? t.muted)
        .child(items.length ? `NEEDS YOU · ${items.length}` : "NEEDS YOU"));
    return box.when(!items.length, (el) => el.child(div().text_size(13).text_color(t.dim).child("Nothing waits on you.")))
      .children(items.map((item) => {
      const task = item.taskRef;
      const canGo = Boolean(item.agent || task);
      const failure = this.failure(t, item);
      return h_flex().id(`need-${item.uid}`).gap(10).items_start().p(6).rounded(7)
        .when(canGo, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => {
          if (item.agent) run("agent.focus", { terminal: item.agent });
          else this.goToTask(task);
        }))
        .child(item.isTry && item.id ? this.checkButton(t, item, false)
          : div().flex_none().size(20).rounded_full().bg(t.blocked).flex().items_center().justify_center()
            .text_size(11).font_semibold().text_color(t.background).child(String(item.number)))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(14).text_color(t.foreground).child(item.text))
          .child(div().text_size(11).text_color(t.dim)
            .child([item.isTry ? "to try" : null, isMany ? item.project : null, item.task ?? (isMany ? null : "general"), item.waited ? `waiting ${item.waited}` : null].filter(Boolean).join(" · ")))
          .when(Boolean(failure), (el) => el.child(failure)));
    }))
      .when(view.checked.length > 0, (el) => el
        .child(div().pt(4).text_size(11).font_semibold().text_color(t.dim).child(`CHECKED · ${view.checked.length}`))
        .children(view.checked.map((item) => {
          const failure = this.failure(t, item);
          return h_flex().id(`checked-${item.uid}`).gap(10).items_start().px(6).py(3)
            .child(this.checkButton(t, item, true))
            .child(v_flex().flex_1().min_w(0).gap(2)
              .child(div().id(`checked-text-${item.uid}`).truncate().text_size(12.5).text_color(t.dim).tooltip(item.text).child(item.text))
              .when(Boolean(failure), (el) => el.child(failure)));
        })));
  }

  taskRow(t, task) {
    const statusText = task.status === "blocked" ? "blocked" : task.status === "done" ? "done" : task.status === "working" ? "working" : null;
    const prLink = (pr) => div().id(`pr-${task.uid}-${pr.repo}-${pr.number}`).text_size(12).text_color(t.accent)
      .when(Boolean(pr.url), (el) => el.cursor_pointer().hover((s) => s.underline())
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(pr.url); }))
      .when(Boolean(pr.repo), (el) => el.tooltip(`${pr.repo} #${pr.number}`))
      .child(`#${pr.number}`);
    const prs = prGroups(task.prs).map((group, index) => h_flex().id(`prs-${task.uid}-${index}`).gap(6).items_center()
      .children(group.prs.map(prLink))
      .when(Boolean(group.base), (el) => el.child(div().text_size(11).text_color(t.blocked).child(`→ ${group.base}`))));
    const who = task.next?.who;
    return v_flex().id(`task-${task.uid}`).gap(3).p(8).rounded(8).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => this.goToTask(task))
      .child(h_flex().gap(8).items_center()
        .child(this.agentMark(t, task))
        .child(this.keyLink(t, task))
        .child(div().flex_none().px(6).rounded(5).bg(t.raised).text_size(11)
          .text_color(task.isKnownStage ? t.muted : t.blocked).child(task.stage))
        .when(Boolean(statusText), (el) => el.child(div().flex_none().text_size(11)
          .text_color(task.status === "blocked" ? t.blocked : t.dim).child(statusText)))
        .child(div().flex_1()))
      .when(prs.length > 0, (el) => el.child(h_flex().pl(20).gap(12).flex_wrap().children(prs)))
      .when(Boolean(task.summary), (el) => el.child(div().id(`summary-${task.uid}`).pl(20).text_size(12).text_color(t.muted).truncate()
        .tooltip(task.summary).child(task.summary)))

      .when(Boolean(task.tests), (el) => el.child(div().id(`tests-${task.uid}`).pl(20).text_size(11).text_color(t.dim).truncate()
        .tooltip(`tests: ${task.tests}`).child(`tests: ${task.tests}`)))
      .when(Boolean(task.next), (el) => el.child(h_flex().pl(20).gap(6).items_start().text_size(12)
        .child(div().flex_none().font_semibold().text_color(who === "you" ? t.blocked : who === "agent" ? t.working : t.accent)
          .child(`${WHO_LABEL[who] ?? who}:`))
        .child(div().flex_1().min_w(0).text_color(t.foreground).child(task.next.what))));
  }

  keyLink(t, task) {
    return div().id(`key-${task.uid}`).flex_none().text_size(13).font_semibold().text_color(t.foreground)
      .when(Boolean(task.url), (el) => el.cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).hover((s) => s.underline()).tooltip(`Open ${task.key} in Jira`)
        .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(task.url); }))
      .child(task.key);
  }

  agentMark(t, task) {
    return div().id(`agent-${task.uid}`).size(18).flex_none().flex().items_center().justify_center().rounded(5).mx(-3)
      .child(this.statusMark(t, task.status))
      .when(Boolean(task.agent), (el) => el.cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).hover((s) => s.bg(t.raised))
        .tooltip(`Peek at the agent (${task.agent}${task.status ? `, ${task.status}` : ""})`)
        .on_click((_e, cx) => { cx.stop_propagation(); run("terminal.peek", { terminal: task.agent }); }));
  }

  helperRow(t, helper) {
    return h_flex().id(`helper-${helper.address ?? helper.name}`).gap(8).items_center().px(8).py(4).rounded(7)
      .when(Boolean(helper.address), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => run("terminal.peek", { terminal: helper.address })))
      .when(Boolean(helper.purpose || helper.address), (el) => el.tooltip([helper.purpose, helper.address].filter(Boolean).join(" · ")))
      .child(div().w(12).flex_none().flex().items_center().justify_center().child(this.statusMark(t, helper.status)))
      .child(div().flex_none().text_size(12).text_color(t.foreground).child(helper.name))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(helper.state));
  }

  projectSection(t, { source, view, problem, isRead }, isMany) {

    const note = problem ? null : !isRead ? "Reading board.json…" : !view ? "No board yet: its coordinator writes it once it has started a task." : !view.tasks.length ? "No tasks." : null;
    return v_flex().id(`project-${source.project}`).gap(6)
      .child(this.sectionTitle(t, isMany ? source.label.toUpperCase() : "TASKS", view?.tasks.length))
      .when(Boolean(problem), (el) => el.child(div().mx(8).p(8).rounded(7).border_1().border_color(t.blocked).text_size(12).text_color(t.blocked).child(problem)))
      .when(Boolean(note), (el) => el.child(div().px(8).text_size(12).text_color(t.dim).child(note)))
      .children((view?.tasks ?? []).map((task) => this.taskRow(t, task)))
      .when((view?.helpers.length ?? 0) > 0, (el) => el
        .child(this.sectionTitle(t, "HELPERS", view.helpers.length))
        .children(view.helpers.map((helper) => this.helperRow(t, helper))));
  }

  render(cx) {
    const t = theme();
    const { profile: context, project: only } = this.scope();
    const profiles = shared("context")?.profiles, profile = profiles?.[context];
    const sources = boardSources(profile, only), isMany = sources.length > 1;

    const title = sources.length === 1 ? sources[0].label : profile?.label ?? context ?? "?";
    this.follow(sources, cx);
    const statusById = new Map(agents().map((agent) => [agent.address, agent.status]));
    const sections = sources.map((source) => {
      const isRead = this.texts.has(source.folder), text = this.texts.get(source.folder);
      const parsed = isRead && text !== null ? parseBoard(text) : null;
      const view = parsed?.board ? buildView(parsed.board, (address) => statusById.get(address), Date.now()) : null;

      if (view) view.tasks = view.tasks.map((task) => ({ ...task, uid: `${source.project}/${task.key}` }));
      return { source, view, isRead, problem: this.errors.get(source.folder) ?? parsed?.error ?? null };
    });
    const combined = combineViews(sections);
    const none = profiles && !sources.length
      ? `No project of ${profile?.label ?? context ?? "this profile"} has a coordinator yet: give one a "coordinator" folder in profiles.json.` : null;

    const updatedAt = clock(combined.updated), updatedAgo = age(combined.updated, Date.now());

    return v_flex().id("coordinator-board").size_full().min_h(0).rounded(10).overflow_hidden().border_1().border_color(t.border)
      .bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().h(42).px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().flex_none().font_semibold().child(`Board · ${title}`))
        .child(div().id("board-updated").flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim)
          .when(Boolean(updatedAgo), (el) => el.tooltip(updatedAgo === "now" ? "Updated just now" : `Updated ${updatedAgo} ago`))
          .child(updatedAt ? `updated ${updatedAt}` : ""))
        .when(!context || context === "work", (el) => el.child(this.journalLink(t))))
      .when(Boolean(none), (el) => el.child(div().p(12).text_size(12).text_color(t.dim).child(none)))
      .when(sources.length > 0, (el) => el.child(v_flex().id("board-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(6)
        .child(this.needsYou(t, combined, isMany))
        .children(sections.map((section) => this.projectSection(t, section, isMany)))));
  }
}
