// Jira board (a tab): my open issues, one column per status.
// s starts work on an issue: the multirepo dialog opens on the issue's project with
// the task branch filled in (config.json maps Jira project keys to multirepo projects).
//
// Issues come from Atlassian's CLI, signed in with OAuth (some organizations block API tokens):
//   brew tap atlassian/homebrew-acli && brew install acli && acli jira auth login --web

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input, TextView } from "gpui-base";
import { theme, exec, run, appHome, readTextFile, openOverlay, panes, spaces, settings } from "herdr";
import { JQL, FIELDS, DETAIL_FIELDS, toCard, toDetails, columns, branchFor, matches, isShown, inOrder, movedOrder } from "./board.js";

const ORDER_KEY = "columns.order"; // localStorage: the status names in the order they were dragged into

const REFRESH_MS = 5 * 60000;
const CARD_HEIGHT = 90;

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

async function readConfig() {
  const path = `${appHome()}/mods/jira/config.json`;
  const text = await readTextFile(path);
  if (!text) throw new Error(`${path} is missing: copy config.example.json beside it to config.json and fill in your Jira site and projects.`);
  const config = JSON.parse(text);
  if (!config.site) throw new Error(`${path} needs "site", e.g. "your-company.atlassian.net".`);
  return { projects: {}, hiddenStatuses: [], ...config };
}

async function searchIssues() {
  let r;
  try {
    r = await exec("acli", ["jira", "workitem", "search", "--jql", JQL, "--fields", FIELDS.join(","), "--json", "--paginate"]);
  } catch {
    throw new Error("acli is not installed: brew tap atlassian/homebrew-acli && brew install acli, then acli jira auth login --web");
  }
  if (r.code !== 0 || !r.stdout.trim().startsWith("[")) {
    const why = (r.stderr || r.stdout).trim().replace(/^✗ Error: /, "");
    throw new Error(`acli could not search Jira: ${why}. Signed out? Run: acli jira auth login --web`);
  }
  return JSON.parse(r.stdout).map(toCard);
}

export default class Jira extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.keySections = [];
    cx.spawn(async (cx) => { this.keySections = await loadKeys("jira", "board"); cx.notify(); });
    this.handle.focus();
    this.ownTab = null; // learnt at the first layout: a pane is laid out only while its tab shows
    // focus() can't run in render, so a light timer does the claiming (no redraw).
    cx.timer.every(400, (cx) => this.claimKeyboard(cx));
    this.scrolls = new Map(); // status -> VirtualListScrollHandle, made when data arrives (never in render)
    this.details = new Map(); // issue key -> { isLoading } | { issue } | { error }
    this.isShowingDetails = false;
    this.detailKey = null;
    this.cards = undefined;
    this.config = null;
    this.column = 0;
    this.at = 0;
    this.order = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]");
    // A column's header pressed (its status) and, once it moved 6px, the column it's over: dragged as a tab is.
    this.pressedColumn = null;
    this.overColumn = null;
    this.error = "";
    this.isLoading = false;
    this.loadedAt = null;
    // The "/" filter: esc leaves the box and keeps the filter; esc again clears it; then the tab closes.
    this.query = "";
    this.isTyping = false;
    this.input = InputState.new({ value: "" });
    this.input.on("change", (_e, cx) => {
      if (!this.isTyping) return;
      this.query = this.input.value().trim().toLowerCase();
      this.moveTo(0);
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.showDetails(cx));
    this.input.on("blur", (_e, cx) => { this.isTyping = false; cx.notify(); });
    cx.timer.every(REFRESH_MS, (cx) => this.load(cx));
    this.load(cx);
  }

  load(cx) {
    if (this.isLoading) return;
    this.isLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.config = await readConfig();
        this.cards = await searchIssues();
        this.details.clear();
        if (this.isShowingDetails && this.detailKey) this.loadDetails(cx, this.detailKey);
        for (const column of columns(this.cards)) if (!this.scrolls.has(column.name)) this.scrolls.set(column.name, VirtualListScrollHandle.new());
        this.loadedAt = new Date();
        this.error = "";
      } catch (error) {
        this.error = String(error.message ?? error);
      }
      this.isLoading = false;
      cx.notify();
    });
  }

  board() {
    const hidden = this.config?.hiddenStatuses ?? [];
    return inOrder(columns((this.cards ?? []).filter((card) => isShown(card, hidden, this.isShowingHidden) && matches(card, this.query))), this.order);
  }

  // Drops column `from` on `to`; the selection stays on the column it was on.
  reorder(from, to) {
    const board = this.board(), selected = board[this.column]?.name;
    if (from === to || !board.some((c) => c.name === from) || !board.some((c) => c.name === to)) return;
    this.order = movedOrder(board.map((c) => c.name), this.order, from, to);
    localStorage.setItem(ORDER_KEY, JSON.stringify(this.order));
    this.column = Math.max(0, this.board().findIndex((c) => c.name === selected));
  }

  // shift-h / shift-l: the selected column one place left or right.
  shiftColumn(step) {
    const board = this.board(), from = board[this.column]?.name, to = board[this.column + step]?.name;
    if (from && to) this.reorder(from, to);
  }

  endDrag(cx) {
    if (this.pressedColumn === null) return;
    this.pressedColumn = this.overColumn = null;
    cx.notify();
  }

  hiddenCount() {
    const hidden = this.config?.hiddenStatuses ?? [];
    return (this.cards ?? []).filter((card) => !isShown(card, hidden, false)).length;
  }

  // ---------------------------------------------------------------- details

  // The panel shows the selected issue, or a related one picked inside it (parent, subtask, link).
  showDetails(cx, key = this.selected()?.key) {
    if (!key) return;
    this.isShowingDetails = true;
    this.detailKey = key;
    this.loadDetails(cx, key);
    cx.notify();
  }

  loadDetails(cx, key) {
    if (this.details.has(key)) return;
    this.details.set(key, { isLoading: true });
    cx.spawn(async (cx) => {
      try {
        const r = await exec("acli", ["jira", "workitem", "view", key, "--json", "--fields", DETAIL_FIELDS.join(",")]);
        if (r.code !== 0 || !r.stdout.trim().startsWith("{")) throw new Error((r.stderr || r.stdout).trim().replace(/^✗ Error: /, "") || `acli exit ${r.code}`);
        this.details.set(key, { issue: toDetails(JSON.parse(r.stdout)) });
      } catch (error) {
        this.details.set(key, { error: `Could not load ${key}: ${error.message ?? error}` });
      }
      cx.notify();
    });
  }

  selected() {
    return this.board()[this.column]?.cards[this.at];
  }

  moveTo(index) {
    this.at = index;
    const column = this.board()[this.column];
    if (column) this.scrolls.get(column.name)?.scroll_to_item(index);
  }

  moveColumn(step) {
    const count = this.board().length;
    if (!count) return;
    this.column = Math.min(count - 1, Math.max(0, this.column + step));
    this.moveTo(Math.min(this.at, this.board()[this.column].cards.length - 1));
  }

  move(step) {
    const count = this.board()[this.column]?.cards.length ?? 0;
    if (count) this.moveTo((this.at + step + count) % count);
  }

  openIssue(cx, key = this.selected()?.key) {
    if (!key) return;
    cx.open_url(`https://${this.config.site}/browse/${key}`);
  }

  startWork() {
    const card = this.selected();
    if (!card) return "";
    const target = this.config.projects[card.project];
    if (!target) return `No multirepo project for ${card.project}: add "${card.project}": { "machine", "root" } under "projects" in mods/jira/config.json.`;
    openOverlay({ mod: "multirepo", kind: "dialog", width: 760, height: 480, props: { machine: target.machine, project: target.root, newTask: branchFor(card) } });
    return "";
  }

  key(e, cx) {
    const stroke = e.keystroke;
    // "?" shows this view's keys; while they show, only ? and esc do anything.
    if (this.isShowingKeys || (isHelpKey(stroke) && !(this.isTyping))) {
      if (!this.isShowingKeys || isHelpKey(stroke) || stroke === "escape") this.isShowingKeys = !this.isShowingKeys;
      cx.stop_propagation();
      return cx.notify();
    }
    if (this.isTyping) {
      if (stroke === "escape") { this.isTyping = false; this.handle.focus(); }
      else if (stroke === "down") this.move(1);
      else if (stroke === "up") this.move(-1);
      else return;
    } else if (stroke === "escape") {
      if (this.isShowingDetails) this.isShowingDetails = false;
      else if (this.query) { this.query = ""; this.input.set_value(""); this.moveTo(0); }
      else run("pane.close");
    } else if (stroke === "/") {
      this.isTyping = true;
      cx.timer.after(0, () => this.input.focus());
    } else if (stroke === "j" || stroke === "down") this.move(1);
    else if (stroke === "k" || stroke === "up") this.move(-1);
    else if (stroke === "shift-h") this.shiftColumn(-1);
    else if (stroke === "shift-l") this.shiftColumn(1);
    else if (stroke === "h" || stroke === "left") this.moveColumn(-1);
    else if (stroke === "l" || stroke === "right") this.moveColumn(1);
    else if (stroke === "enter") this.showDetails(cx);
    else if (stroke === "o") this.openIssue(cx, this.isShowingDetails ? this.detailKey : undefined);
    else if (stroke === "s") this.error = this.startWork();
    else if (stroke === "r") this.load(cx);
    else if (stroke === "a") { this.isShowingHidden = !this.isShowingHidden; this.column = 0; this.moveTo(0); }
    else return;
    // Browsing with the panel open: it follows the selection.
    if (this.isShowingDetails && ["j", "k", "h", "l", "up", "down", "left", "right"].includes(stroke)) this.showDetails(cx);
    cx.stop_propagation();
    cx.notify();
  }

  card(card, isSelected, t) {
    const priorityColor = { Highest: t.blocked, High: t.blocked, Medium: t.working, Low: t.dim, Lowest: t.dim }[card.priority] ?? t.dim;
    return div().flex_none().h(CARD_HEIGHT).pb(6).child(
      v_flex().size_full().p(10).gap(4).rounded(8).border(1).cursor_pointer()
        .border_color(isSelected ? t.accent : t.border).bg(isSelected ? t.selected : t.background)
        .when(!isSelected, (el) => el.hover((s) => s.bg(t.hover)))
        .child(h_flex().gap(8).items_center().text_size(11.5)
          .child(div().flex_none().font_semibold().text_color(t.accent).child(card.key))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(card.type))
          .child(div().flex_none().text_color(priorityColor).child(card.priority)))
        .child(div().h(40).overflow_hidden().text_size(12.5).line_height("20px").text_color(t.foreground).child(card.summary)));
  }

  detailsPanel(t) {
    const key = this.detailKey;
    const state = this.details.get(key) ?? { isLoading: true };
    const panel = v_flex().w(540).flex_none().h_full().border_l(1).border_color(t.border).bg(t.background);
    const top = h_flex().flex_none().px(16).h(42).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().text_color(t.accent).child(key))
      .when(Boolean(state.issue), (el) => el
        .child(div().text_size(12).text_color(t.dim).child(state.issue.type))
        .child(div().px(7).h(20).flex().items_center().rounded(10).bg(t.raised).text_size(11.5).text_color(t.foreground).child(state.issue.status))
        .child(div().text_size(12).text_color(t.dim).child(state.issue.priority)))
      .child(div().flex_1())
      .child(div().id("jira-details-web").text_size(12).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => this.openIssue(cx, key)).child("open in Jira ↗"))
      .child(div().id("jira-details-close").text_size(14).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.isShowingDetails = false; cx.notify(); }).child("×"));
    if (!state.issue) {
      return panel.child(top).child(div().p(16).text_size(12.5).text_color(state.error ? t.blocked : t.muted).child(state.error ?? "Loading…"));
    }
    const issue = state.issue;
    const when = (iso) => iso ? iso.slice(0, 16).replace("T", " ") : "";
    const fact = (label, value) => h_flex().gap(10).text_size(12.5).items_start()
      .child(div().flex_none().w(84).text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).text_color(t.foreground).child(value));
    // A related issue: click shows it here.
    const related = (id, item, prefix = "") => h_flex().id(id).gap(8).py(3).px(6).rounded(6).items_center().cursor_pointer().text_size(12.5)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.showDetails(cx, item.key))
      .when(Boolean(prefix), (el) => el.child(div().flex_none().text_color(t.dim).child(prefix)))
      .child(div().flex_none().text_color(t.accent).child(item.key))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(item.summary))
      .child(div().flex_none().text_size(11.5).text_color(t.dim).child(item.status));
    const section = (title) => div().pt(6).text_size(11.5).font_medium().text_color(t.dim).child(title);
    return panel.child(top).child(v_flex().id(`jira-details-${key}`).flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(8)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(issue.summary))
      .child(fact("Assignee", issue.assignee))
      .child(fact("Reporter", issue.reporter))
      .when(issue.labels.length > 0, (el) => el.child(fact("Labels", issue.labels.join(", "))))
      .child(fact("Updated", `${when(issue.updated)} · created ${when(issue.created)}`))
      .when(Boolean(issue.parent), (el) => el.child(section("Parent")).child(related("jira-parent", issue.parent)))
      .when(issue.subtasks.length > 0, (el) => el.child(section(`Subtasks · ${issue.subtasks.length}`))
        .children(issue.subtasks.map((item) => related(`jira-sub-${item.key}`, item))))
      .when(issue.links.length > 0, (el) => el.child(section("Links"))
        .children(issue.links.map((item, i) => related(`jira-link-${i}`, item, item.relation))))
      .child(section("Description"))
      .child(issue.description
        ? TextView.markdown(`jira-desc-${key}`, issue.description).text_size(13).text_color(t.foreground)
        : div().text_size(12.5).text_color(t.dim).child("No description."))
      .child(section(`Comments · ${issue.comments.length}`))
      .when(!issue.comments.length, (el) => el.child(div().text_size(12.5).text_color(t.dim).child("No comments.")))
      .children(issue.comments.map((c) => v_flex().gap(4).p(10).rounded(8).border(1).border_color(t.border)
        .child(h_flex().gap(8).text_size(12)
          .child(div().font_semibold().text_color(t.foreground).child(c.author))
          .child(div().text_color(t.dim).child(when(c.created))))
        .child(TextView.markdown(`jira-comment-${key}-${c.id}`, c.body || "_(empty)_").text_size(13).text_color(t.foreground)))));
  }

  // The tab this pane is in: the shown one at its first layout (a pane is laid out only while
  // its tab shows; at init, focused() can still name the tab that was shown before).
  learnTab(cx) {
    if (this.ownTab) return;
    this.ownTab = spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id ?? null;
    this.onOwnTab?.(cx);
  }

  // A new pane is Herdr's focused pane but doesn't hold the keyboard until clicked: take it
  // when this pane becomes the focused one (opened, switched to). Only on that change: a
  // palette or dialog opened over it leaves the pane focused and must keep its typing; when
  // it closes Herdr sends "focus" (mod.json focusable), which hands the keyboard back.
  claimKeyboard(cx) {
    const isPaneFocused = panes().some((p) => p.mod === "jira" && p.tab === this.ownTab && p.focused);
    const isNewlyFocused = isPaneFocused && !this.wasPaneFocused;
    this.wasPaneFocused = isPaneFocused;
    if (!isNewlyFocused || this.isTyping || this.handle.is_focused()) return;
    this.handle.focus();
    cx.notify();
  }

  render() {
    const t = theme();
    const board = this.board();
    this.column = Math.min(this.column, Math.max(0, board.length - 1));
    const title = this.config ? `Jira · ${this.config.site}` : "Jira";
    const count = this.cards?.length;
    const isEmpty = this.cards !== undefined && !board.length;
    return v_flex().id("jira").on_size_change((_size, cx) => this.learnTab(cx)).track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      // A release anywhere ends a drag; Herdr reports none outside the pane, so leaving it does too.
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .on_hover((isOver, cx) => { if (!isOver) this.endDrag(cx); })
      .size_full().min_h(0).relative().bg(t.surface).text_size(13).text_color(t.foreground)
      .child(h_flex().flex_none().px(16).h(48).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child(title))
        .when(count !== undefined, (el) => el.child(div().text_size(12).text_color(t.muted).child(`${count} open issue${count === 1 ? "" : "s"} assigned to me`)))
        .when(this.hiddenCount() > 0, (el) => el.child(div().text_size(12).text_color(t.dim)
          .child(this.isShowingHidden ? `incl. ${this.hiddenCount()} waiting on others · a hides them` : `${this.hiddenCount()} hidden (${this.config.hiddenStatuses.join(", ")}) · a shows them`)))
        .child(div().flex_1())
        .child(div().id("jira-refresh").text_size(12).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.load(cx))
          .when(this.isLoading, (el) => el.frames(["◐", "◓", "◑", "◒"], 160))
          .when(!this.isLoading, (el) => el.child(this.loadedAt ? `↻ ${this.loadedAt.toLocaleTimeString()}` : "↻"))))
      .when(this.isTyping || Boolean(this.query), (el) => el.child(div().px(16).pt(10).child(
        Input.new(this.input).h(30).px(10).items_center().rounded(6).border(1)
          .border_color(this.isTyping ? t.accent : t.input).bg(t.background).text_color(t.foreground))))
      .child(this.cards === undefined || isEmpty
        ? div().flex_1().p(16).text_color(t.dim).child(this.cards === undefined ? (this.error ? "" : "Loading issues…") : this.query ? `Nothing matches "${this.query}".` : "Nothing assigned to you is open.")
        : h_flex().flex_1().min_h(0).child(h_flex().id("jira-columns").flex_1().min_w(0).h_full().p(12).gap(12).overflow_x_scrollbar()
          .children(board.map((column, columnIndex) => {
            const isColumnSelected = columnIndex === this.column;
            const listId = `jira-col-${columnIndex}`;
            const list = v_virtual_list(listId, column.cards.length, CARD_HEIGHT, (i) => column.cards[i].key,
              (range) => column.cards.slice(range.start, range.end).map((card, k) => this.card(card, isColumnSelected && range.start + k === this.at, t)))
              // Rows of a virtual list cannot hold handlers; the list reports which was clicked.
              .on_item_click((key, cx) => {
                this.column = columnIndex;
                this.moveTo(this.board()[columnIndex].cards.findIndex((c) => c.key === key));
                this.showDetails(cx, key);
              })
              .size_full();
            const scroll = this.scrolls.get(column.name);
            const pressedAt = board.findIndex((c) => c.name === this.pressedColumn);
            const isDropTarget = pressedAt >= 0 && this.overColumn === column.name && pressedAt !== columnIndex;
            return v_flex().id(`jira-column-${column.name}`).relative().flex_1().min_w(260).max_w(420).h_full().gap(8)
              // Dragged as a tab is: the source fades, a line on the side it lands shows where.
              .when(pressedAt === columnIndex && this.overColumn !== null && this.overColumn !== column.name, (el) => el.opacity(0.5))
              .when(isDropTarget, (el) => el.child(div().absolute().top(0).bottom(0).w(2).rounded(1).bg(t.accent)
                .when(pressedAt < columnIndex, (line) => line.right(-7)).when(pressedAt > columnIndex, (line) => line.left(-7))))
              .on_mouse_move((e, cx) => {
                if (this.pressedColumn === null || this.overColumn === column.name) return;
                if (this.overColumn === null && Math.hypot(e.position.x - this.pressAt.x, e.position.y - this.pressAt.y) < 6 * settings().zoom) return;
                this.overColumn = column.name;
                cx.notify();
              })
              .on_mouse_up("left", (_e, cx) => {
                if (this.overColumn !== null) this.reorder(this.pressedColumn, this.overColumn);
                this.endDrag(cx);
              })
              .child(h_flex().id(`jira-head-${column.name}`).flex_none().gap(6).items_center().px(2).cursor_pointer()
                .on_mouse_down("left", (e) => { this.pressedColumn = column.name; this.overColumn = null; this.pressAt = e.position; })
                .child(div().text_size(12).font_semibold().text_color(isColumnSelected ? t.foreground : t.muted).child(column.name))
                .child(div().text_size(11).text_color(t.dim).child(String(column.cards.length))))
              .child(v_flex().relative().flex_1().min_h(0)
                .child(scroll ? list.track_scroll(scroll) : list)
                .child(Scrollbar.vertical(listId).absolute().inset_0()));
          }))
          .when(this.isShowingDetails && Boolean(this.detailKey), (el) => el.child(this.detailsPanel(t)))))
      .when(Boolean(this.error), (el) => el.child(div().flex_none().px(16).py(6).text_size(12).text_color(t.blocked).child(this.error)))
      .child(div().flex_none().px(16).py(8).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child("? keys · h/l column · drag a header or H/L to move it · j/k issue · click/↵ details · o open in Jira · s start work (multirepo task) · a hidden statuses · / search · r refresh"))
      .when(this.isShowingKeys, (el) => el.child(keyHelp("jira-keys", "Jira board keys", this.keySections, t)));
  }
}
