// The coordinator's board beside its chat: what needs the person, each task's state, the helpers.
//
// It reads <coordinator folder>/board.json (shape: that folder's CLAUDE.md, section Board) of the
// profile whose coordinator space holds this pane (or is shown, for the layout's panel), else the
// shown profile (t3-context's shared "context", which also has each profile's folder), and joins
// herdr's live agent status. The T3 layout shows it in its side panel (`board`, t3-panels opens it
// in a coordinator's space), so the chat's tab keeps only the chat and Claude Code.
// Its one write: a try item ticked off (or back), moved between "needsYou" and "checked" in
// board.json (board.js checkItem / uncheckItem).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, agents, panes, theme, run, props, shared, home, exec, notify, readTextFile, writeTextFile, watchFolder } from "herdr";
import { boardContext, parseBoard, buildView, taskSpace, prGroups, age, clock, checkItem, uncheckItem } from "./board.js";

// Kept in step with mods/journal/main.js (the key that opens it from anywhere).
const JOURNAL = `${home()}/work/daily-reports/journal.html`;
const RELOAD_MS = 20000; // fallback for a missed watch event; also ages the "waited" times
const WHO_LABEL = { you: "you", agent: "agent", coordinator: "coordinator" };

export default class CoordinatorBoard extends View {
  init(_props, cx) {
    this.folder = null; // the folder whose board.json is shown
    this.text = undefined; // board.json as last read; undefined until read
    this.error = null;
    this.hasJournal = false;
    this.pendingIds = new Set(); // try items being ticked or unticked
    this.failures = new Map(); // item id -> why its last tick wasn't saved
    this.checkJournal(cx);
    cx.timer.every(RELOAD_MS, (cx) => { this.reload(cx); this.checkJournal(cx); cx.notify(); });
  }

  checkJournal(cx) {
    cx.spawn(async (cx) => {
      const hasJournal = (await readTextFile(JOURNAL).catch(() => null)) !== null;
      if (hasJournal !== this.hasJournal) { this.hasJournal = hasJournal; cx.notify(); }
    });
  }

  // cx.open_url takes only http(s) URLs, so the system's `open` shows the file in the default browser.
  openJournal() {
    exec("open", [JOURNAL]).then((result) => {
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

  // The context of this pane's space (a panel's: the shown space), else the shown one.
  context() {
    const published = shared("context") ?? {};
    const tab = panes().find((pane) => pane.pane === props()?.pane)?.tab;
    const spaceId = spaces().find((space) => (tab ? space.tabs.some((t) => t.id === tab) : space.active))?.id;
    return boardContext({ spaceId, coordinators: published.coordinators, current: published.current ?? props()?.context });
  }

  // Reloads on every change in the folder until the shown folder changes.
  watch(folder, cx) {
    cx.spawn(async (cx) => {
      while (folder === this.folder) {
        try {
          await watchFolder(folder);
        } catch (error) {
          this.error = `Watching ${folder}: ${error.message ?? error}`;
          cx.notify();
          return; // the timer still reloads
        }
        await this.reload(cx);
      }
    });
  }

  async reload(cx) {
    const folder = this.folder;
    if (!folder) return;
    try {
      const text = await readTextFile(`${folder}/board.json`);
      if (folder !== this.folder || text === this.text) return;
      this.text = text;
    } catch (error) {
      this.text = null;
      this.error = `Reading ${folder}/board.json: ${error.message ?? error}`;
    }
    cx.notify();
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

  // Moves a try item (checkItem / uncheckItem) in board.json as the file is now: the coordinator
  // rewrites it often, so never from what this panel last read. writeTextFile replaces the file
  // atomically and refuses if it changed since the read; then it is read again.
  moveItem(id, move, cx) {
    const file = `${this.folder}/board.json`;
    this.pendingIds.add(id);
    this.failures.delete(id);
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
        this.failures.set(id, `Not saved: ${error.message ?? error}`);
      }
      this.pendingIds.delete(id);
      cx.notify();
    });
  }

  // The round button a try item is ticked (or unticked) with.
  checkButton(t, item, isChecked) {
    const isPending = this.pendingIds.has(item.id);
    return div().id(`check-${item.id}`).flex_none().size(20).rounded_full().border_1().flex().items_center().justify_center()
      .text_size(11).font_semibold()
      .border_color(isChecked ? t.accent : t.input).bg(isChecked ? t.accent : t.surface)
      // The tick shows on hover only, so an unchecked circle reads as empty.
      .text_color(isChecked ? t.accent_foreground : t.surface)
      .when(isPending, (el) => el.opacity(0.5))
      .when(!isPending, (el) => el.cursor_pointer()
        .hover((s) => (isChecked ? s.opacity(0.8) : s.border_color(t.accent).text_color(t.accent)))
        .tooltip(isChecked ? "Not tried yet: put it back" : "Mark as tried")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.moveItem(item.id, isChecked ? uncheckItem : checkItem, cx); }))
      .child("✓");
  }

  failure(t, item) {
    const failure = this.failures.get(item.id);
    return failure ? div().text_size(11).text_color(t.blocked).child(failure) : null;
  }

  needsYou(t, view) {
    const items = view.needsYou;
    // Only things to try wait: no alarm, the accent colour; a decision or a blocked agent: red.
    const tone = items.some((item) => !item.isTry) ? t.blocked : items.length ? t.accent : null;
    const box = v_flex().id("needs-you").gap(6).p(10).rounded(10).border_1()
      .border_color(tone ?? t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center().text_size(12).font_semibold()
        .text_color(tone ?? t.muted)
        .child(items.length ? `NEEDS YOU · ${items.length}` : "NEEDS YOU"));
    return box.when(!items.length, (el) => el.child(div().text_size(13).text_color(t.dim).child("Nothing waits on you.")))
      .children(items.map((item) => {
      const task = view.tasks.find((task) => task.key === item.task);
      const canGo = Boolean(item.agent || task);
      const failure = this.failure(t, item);
      return h_flex().id(`need-${item.id ?? item.number}`).gap(10).items_start().p(6).rounded(7)
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
            .child([item.isTry ? "to try" : null, item.task ?? "general", item.waited ? `waiting ${item.waited}` : null].filter(Boolean).join(" · ")))
          .when(Boolean(failure), (el) => el.child(failure)));
    }))
      .when(view.checked.length > 0, (el) => el
        .child(div().pt(4).text_size(11).font_semibold().text_color(t.dim).child(`CHECKED · ${view.checked.length}`))
        .children(view.checked.map((item) => {
          const failure = this.failure(t, item);
          return h_flex().id(`checked-${item.id}`).gap(10).items_start().px(6).py(3)
            .child(this.checkButton(t, item, true))
            .child(v_flex().flex_1().min_w(0).gap(2)
              .child(div().id(`checked-text-${item.id}`).truncate().text_size(12.5).text_color(t.dim).tooltip(item.text).child(item.text))
              .when(Boolean(failure), (el) => el.child(failure)));
        })));
  }

  taskRow(t, task) {
    const statusText = task.status === "blocked" ? "blocked" : task.status === "done" ? "done" : task.status === "working" ? "working" : null;
    const prLink = (pr) => div().id(`pr-${task.key}-${pr.repo}-${pr.number}`).text_size(12).text_color(t.accent)
      .when(Boolean(pr.url), (el) => el.cursor_pointer().hover((s) => s.underline())
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(pr.url); }))
      .when(Boolean(pr.repo), (el) => el.tooltip(`${pr.repo} #${pr.number}`))
      .child(`#${pr.number}`);
    const prs = prGroups(task.prs).map((group, index) => h_flex().id(`prs-${task.key}-${index}`).gap(6).items_center()
      .children(group.prs.map(prLink))
      .when(Boolean(group.base), (el) => el.child(div().text_size(11).text_color(t.blocked).child(`→ ${group.base}`))));
    const who = task.next?.who;
    return v_flex().id(`task-${task.key}`).gap(3).p(8).rounded(8).cursor_pointer().hover((s) => s.bg(t.hover))
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
      .when(Boolean(task.summary), (el) => el.child(div().id(`summary-${task.key}`).pl(20).text_size(12).text_color(t.muted).truncate()
        .tooltip(task.summary).child(task.summary)))
      // One line: the full test notes are in its tooltip.
      .when(Boolean(task.tests), (el) => el.child(div().id(`tests-${task.key}`).pl(20).text_size(11).text_color(t.dim).truncate()
        .tooltip(`tests: ${task.tests}`).child(`tests: ${task.tests}`)))
      .when(Boolean(task.next), (el) => el.child(h_flex().pl(20).gap(6).items_start().text_size(12)
        .child(div().flex_none().font_semibold().text_color(who === "you" ? t.blocked : who === "agent" ? t.working : t.accent)
          .child(`${WHO_LABEL[who] ?? who}:`))
        .child(div().flex_1().min_w(0).text_color(t.foreground).child(task.next.what))));
  }

  // The task's key; with its Jira URL, a link to the issue.
  keyLink(t, task) {
    return div().id(`key-${task.key}`).flex_none().text_size(13).font_semibold().text_color(t.foreground)
      .when(Boolean(task.url), (el) => el.cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).hover((s) => s.underline()).tooltip(`Open ${task.key} in Jira`)
        .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(task.url); }))
      .child(task.key);
  }

  // The agent's status; with an agent, a click peeks at its screen without leaving this space.
  agentMark(t, task) {
    return div().id(`agent-${task.key}`).size(18).flex_none().flex().items_center().justify_center().rounded(5).mx(-3)
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

  render(cx) {
    const t = theme();
    const context = this.context();
    const profiles = shared("context")?.profiles, profile = profiles?.[context];
    const folder = profile?.coordinator?.folder ?? null;
    if (folder !== this.folder) {
      this.folder = folder;
      this.text = undefined;
      if (folder) {
        cx.spawn(async (cx) => this.reload(cx)); // a task's own cx: render's must not be used after an await
        this.watch(folder, cx);
      }
    }
    const parsed = this.text === undefined ? null : parseBoard(this.text);
    const statusById = new Map(agents().map((agent) => [agent.address, agent.status]));
    const view = parsed?.board ? buildView(parsed.board, (address) => statusById.get(address), Date.now()) : null;
    const problem = this.error ?? parsed?.error ?? (!folder && profiles ? `No coordinator folder for "${context}" in profiles.json` : null);

    const updatedAt = clock(view?.updated), updatedAgo = age(view?.updated, Date.now());
    // A card with a 42 px header, as the panel's Files and Changes.
    return v_flex().id("coordinator-board").size_full().min_h(0).rounded(10).overflow_hidden().border_1().border_color(t.border)
      .bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().h(42).px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().flex_none().font_semibold().child(`Board · ${profile?.label ?? context ?? "?"}`))
        .child(div().id("board-updated").flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim)
          .when(Boolean(updatedAgo), (el) => el.tooltip(updatedAgo === "now" ? "Updated just now" : `Updated ${updatedAgo} ago`))
          .child(updatedAt ? `updated ${updatedAt}` : ""))
        .child(this.journalLink(t)))
      .when(Boolean(problem), (el) => el.child(div().flex_none().mx(10).mt(8).p(8).rounded(7).border_1().border_color(t.blocked)
        .text_size(12).text_color(t.blocked).child(problem)))
      .when(!view && !problem, (el) => el.child(div().p(12).text_size(12).text_color(t.dim).child("Reading board.json…")))
      .when(Boolean(view), (el) => el.child(v_flex().id("board-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(6)
        .child(this.needsYou(t, view))
        .child(this.sectionTitle(t, "TASKS", view.tasks.length))
        .when(!view.tasks.length, (el) => el.child(div().px(8).text_size(12).text_color(t.dim).child("No tasks.")))
        .children(view.tasks.map((task) => this.taskRow(t, task)))
        .when(view.helpers.length > 0, (el) => el
          .child(this.sectionTitle(t, "HELPERS", view.helpers.length))
          .children(view.helpers.map((helper) => this.helperRow(t, helper))))));
  }
}
