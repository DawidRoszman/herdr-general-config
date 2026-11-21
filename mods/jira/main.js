import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input, TextView } from "gpui-base";
import { theme, exec, run, appHome, readTextFile, openOverlay, panes, spaces, settings, shared, notify, checking, layout } from "herdr";
import { signIn } from "./account.js";
import { JQL, FIELDS, DETAIL_FIELDS, toCard, toDetails, columns, branchFor, matches, isShown, inOrder, movedOrder, codeFor, codeMismatch, clock, projectPlaces, boardTasks, taskTarget } from "./board.js";
import { projectCode } from "./code.js";

const ORDER_KEY = "columns.order";

const REFRESH_MS = 5 * 60000;
const BOARD_MS = 30000;
const CARD_HEIGHT = 90;

const NARROW_PX = 820;

async function loadKeys(mod, viewId) {
  try {
    const views = JSON.parse(await readTextFile(`${appHome()}/mods/${mod}/help-keys.json`)).views;
    return views.find((v) => v.id === viewId)?.sections ?? [];
  } catch (error) {
    return [{ title: `Could not read mods/${mod}/help-keys.json`, rows: [["", String(error.message ?? error)]] }];
  }
}

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

function shownProjects() {
  const context = shared("context");
  return context?.profiles?.[context?.current]?.projects ?? {};
}

function boardFiles() {
  return Object.values(shownProjects()).map((project) => project.coordinator?.folder).filter(Boolean).map((folder) => `${folder}/board.json`);
}

async function readConfig() {
  const path = `${appHome()}/mods/jira/config.json`;
  const text = await readTextFile(path);
  if (!text) throw new Error(`${path} is missing: copy config.example.json beside it to config.json and fill in your site.`);
  return { projects: {}, hiddenStatuses: [], statusStages: {}, ...JSON.parse(text) };
}

const account = (config) => signIn({ config, profile: shared("context")?.current ?? null, profilesPy: `${appHome()}/mods/t3-context/profiles.py`, exec });

function jiraError(text) {
  try {
    const body = JSON.parse(text);
    return [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})].join("; ") || text;
  } catch {
    return text;
  }
}

const findNode = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => findNode(c, id)).find(Boolean));

async function jira(config, path, auth = null) {
  const { site, authorization, from } = auth ?? await account(config);
  let response;
  try {
    response = await fetch(`https://${site}/rest/api/3/${path}`, { headers: { Authorization: authorization, Accept: "application/json" } });
  } catch (error) {
    throw new Error(`Could not reach ${site}: ${error.message ?? error}`);
  }
  const text = await response.text();
  if (response.status === 401) throw new Error(`Jira refused the token (401): check ${from}.`);
  if (!response.ok) throw new Error(`Jira answered ${response.status}: ${jiraError(text).trim()}`);
  return JSON.parse(text);
}

async function searchIssues(config, auth = null) {
  const issues = [];
  let pageToken = "";
  do {
    const page = await jira(config, `search/jql?jql=${encodeURIComponent(JQL)}&fields=${FIELDS.join(",")}&maxResults=100${pageToken ? `&nextPageToken=${encodeURIComponent(pageToken)}` : ""}`, auth);
    issues.push(...page.issues);
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return issues.map(toCard);
}

export default class Jira extends View {
  init(given, cx) {
    this.handle = cx.focus_handle();
    this.keySections = [];
    cx.spawn(async (cx) => { this.keySections = await loadKeys("jira", "board"); cx.notify(); });

    this.isPanel = Boolean(given?.panel);
    this.isNarrow = false;
    if (!this.isPanel) this.handle.focus();
    this.ownTab = null;

    if (!this.isPanel && !checking()) cx.timer.every(400, (cx) => this.claimKeyboard(cx));
    this.scrolls = new Map();
    this.details = new Map();
    this.isShowingDetails = false;
    this.detailKey = null;
    this.cards = undefined;
    this.code = new Map();
    this.codeError = "";
    this.config = null;
    this.site = null;
    this.column = 0;
    this.at = 0;
    this.order = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]");

    this.pressedColumn = null;
    this.overColumn = null;
    this.error = "";
    this.isLoading = false;
    this.loadedAt = null;

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
    this.boardTasks = new Map();
    this.loadedProfile = undefined;
    if (checking()) return;
    cx.timer.every(REFRESH_MS, (cx) => { if (this.isVisible()) this.load(cx); });
    cx.timer.every(BOARD_MS, (cx) => { if (this.isVisible()) this.readBoard(cx); });
    if (this.isVisible()) {
      this.load(cx);
      this.readBoard(cx);
    }
  }

  isVisible() {
    if (!this.isPanel) return true;
    const root = layout(), panel = findNode(root, "panel"), body = findNode(root, "panel-body");
    return Boolean(!panel || (!panel.hidden && (!body || body.active === "jira")));
  }

  load(cx, shouldNotify = true) {
    if (this.isLoading) return;
    this.isLoading = true;
    this.loadedProfile = shared("context")?.current ?? null;
    if (shouldNotify) cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.config = await readConfig();
        const auth = await account(this.config);
        this.site = auth.site;
        this.cards = await searchIssues(this.config, auth);
        this.details.clear();
        if (this.isShowingDetails && this.detailKey) this.loadDetails(cx, this.detailKey);
        for (const column of columns(this.cards)) if (!this.scrolls.has(column.name)) this.scrolls.set(column.name, VirtualListScrollHandle.new());
        this.loadedAt = new Date();
        this.error = "";
        this.loadCode(cx);
      } catch (error) {
        this.cards = [];
        this.error = String(error.message ?? error);
      }
      this.isLoading = false;
      cx.notify();
    });
  }

  readBoard(cx) {
    cx.spawn(async (cx) => {
      const texts = await Promise.all(boardFiles().map((file) => readTextFile(file).catch(() => null)));
      const read = JSON.stringify(texts);
      if (read === this.boardText) return;
      this.boardText = read;
      this.boardTasks = new Map(texts.flatMap((text) => [...boardTasks(text)]));
      cx.notify();
    });
  }

  loadCode(cx) {
    cx.spawn(async (cx) => {
      const errors = [];
      await Promise.all(Object.entries(this.places()).map(async ([key, places]) => {
        try {
          this.code.set(key, await projectCode(places));
        } catch (error) {
          errors.push(`${key}: ${error.message ?? error}`);
        }
      }));
      this.codeError = errors.length ? `Could not compare with the code: ${errors.join(" · ")}` : "";
      cx.notify();
    });
  }

  places() {
    return projectPlaces(this.config?.projects, shownProjects());
  }

  mismatch(card) {
    const code = this.code.get(card.project);
    const stage = this.config?.statusStages[card.status];
    return code && stage ? codeMismatch(stage, codeFor(card.key, code.prs, code.branches)) : "";
  }

  board() {
    const hidden = this.config?.hiddenStatuses ?? [];
    return inOrder(columns((this.cards ?? []).filter((card) => isShown(card, hidden, this.isShowingHidden) && matches(card, this.query))), this.order);
  }

  reorder(from, to) {
    const board = this.board(), selected = board[this.column]?.name;
    if (from === to || !board.some((c) => c.name === from) || !board.some((c) => c.name === to)) return;
    this.order = movedOrder(board.map((c) => c.name), this.order, from, to);
    localStorage.setItem(ORDER_KEY, JSON.stringify(this.order));
    this.column = Math.max(0, this.board().findIndex((c) => c.name === selected));
  }

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
        const issue = await jira(this.config, `issue/${encodeURIComponent(key)}?fields=${DETAIL_FIELDS.join(",")}`);
        this.details.set(key, { issue: toDetails(issue) });
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

  toggleHidden() {
    this.isShowingHidden = !this.isShowingHidden;
    this.column = 0;
    this.moveTo(0);
  }

  copyBranch(cx, key = this.shownKey()) {
    const issue = this.issue(key);
    if (!issue) return;
    const branch = branchFor(issue);
    cx.write_to_clipboard(branch);
    notify({ title: "Branch copied", body: branch, timeout: 3000 });
  }

  taskOf(key) {
    return key ? taskTarget(key, this.boardTasks.get(key), spaces()) : null;
  }

  goToTask(key = this.shownKey()) {
    const target = this.taskOf(key);
    if (target?.space) run("space.select", { id: target.space });
    else if (target?.agent) run("agent.focus", { terminal: target.agent });
    else if (key) notify({ title: `${key} has no task yet`, body: "s starts one.", timeout: 3000 });
  }

  openIssue(cx, key = this.selected()?.key) {
    if (!key) return;
    cx.open_url(`https://${this.site}/browse/${key}`);
  }

  shownKey() {
    return this.isShowingDetails ? this.detailKey : this.selected()?.key;
  }

  issue(key) {
    const issue = this.cards?.find((card) => card.key === key) ?? this.details.get(key)?.issue;
    return issue && { ...issue, project: issue.project ?? key.split("-")[0] };
  }

  startWork(key = this.shownKey()) {
    const issue = this.issue(key);
    if (!issue) return "";
    const target = this.places()[issue.project]?.[0];
    if (!target) return `No multirepo project for ${issue.project}: give a project "jira": ["${issue.project}"] and its "places" in profiles.json.`;
    openOverlay({ mod: "multirepo", kind: "dialog", width: 760, height: 480, props: { machine: target.machine, project: target.root, newTask: branchFor(issue) } });
    return "";
  }

  key(e, cx) {
    const stroke = e.keystroke;

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
      else if (!this.isPanel) run("pane.close");
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
    else if (stroke === "o") this.openIssue(cx, this.shownKey());
    else if (stroke === "s") this.error = this.startWork();
    else if (stroke === "y") this.copyBranch(cx);
    else if (stroke === "g") this.goToTask();
    else if (stroke === "r") this.load(cx);
    else if (stroke === "a") this.toggleHidden();
    else return;

    if (this.isShowingDetails && ["j", "k", "h", "l", "up", "down", "left", "right"].includes(stroke)) this.showDetails(cx);
    cx.stop_propagation();
    cx.notify();
  }

  card(card, isSelected, t) {
    const priorityColor = { Highest: t.blocked, High: t.blocked, Medium: t.working, Low: t.dim, Lowest: t.dim }[card.priority] ?? t.dim;
    const mismatch = this.mismatch(card), stage = this.boardTasks.get(card.key)?.stage;
    return div().flex_none().h(CARD_HEIGHT).pb(6).child(
      v_flex().size_full().p(10).gap(4).rounded(8).border(1).cursor_pointer()
        .border_color(isSelected ? t.accent : t.border).bg(isSelected ? t.selected : t.background)
        .when(!isSelected, (el) => el.hover((s) => s.bg(t.hover)))
        .child(h_flex().gap(8).items_center().text_size(11.5)
          .child(div().flex_none().font_semibold().text_color(t.accent).child(card.key))

          .when(Boolean(stage), (el) => el.child(div().flex_none().px(5).rounded(5).border_1().border_color(t.input).text_size(11).text_color(t.muted).child(stage)))
          .when(Boolean(mismatch), (el) => el.child(svg("mods/jira/alert.svg").size(13).flex_none().text_color(t.working)))
          .child(div().flex_1().min_w(0).truncate().text_color(mismatch ? t.working : t.dim).child(mismatch ? `Not ${card.status}? ${mismatch}` : card.type))
          .child(div().flex_none().text_color(priorityColor).child(card.priority)))
        .child(div().h(40).overflow_hidden().text_size(12.5).line_height("20px").text_color(t.foreground).child(card.summary)));
  }

  detailsPanel(t) {
    const key = this.detailKey;
    const state = this.details.get(key) ?? { isLoading: true };
    const task = this.taskOf(key);
    const panel = (this.isNarrow ? v_flex().flex_1().min_w(0) : v_flex().w(540).flex_none().border_l(1).border_color(t.border)).h_full().bg(t.background);

    const top = h_flex().flex_none().px(16).h(42).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_none().font_semibold().text_color(t.accent).child(key))
      .when(Boolean(state.issue), (el) => el
        .when(!this.isNarrow, (el) => el.child(div().text_size(12).text_color(t.dim).child(state.issue.type)))
        .child(div().id("jira-details-status").min_w(0).px(7).h(20).flex().items_center().rounded(10).bg(t.raised).text_size(11.5).text_color(t.foreground)
          .tooltip(state.issue.status).child(div().truncate().child(state.issue.status)))
        .when(!this.isNarrow, (el) => el.child(div().text_size(12).text_color(t.dim).child(state.issue.priority))))
      .child(div().flex_1())

      .when(Boolean(state.issue), (el) => el.child(task
        ? this.detailsButton(t, "jira-details-go", "Go to task", `Go to its task's ${task.space ? "space" : "agent"} · g`, () => this.goToTask(key))
        : this.detailsButton(t, "jira-details-start", "Start task", "Start a multirepo task on its branch · s",
          (cx) => { this.error = this.startWork(key); cx.notify(); })))
      .child(div().id("jira-details-web").flex_none().text_size(12).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .tooltip("Open in Jira · o").on_click((_e, cx) => this.openIssue(cx, key)).child(this.isNarrow ? "Jira ↗" : "open in Jira ↗"))
      .child(div().id("jira-details-close").flex_none().w(22).h(22).flex().items_center().justify_center().rounded(6).border(1).border_color(t.border).bg(t.raised).text_size(15).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Close · esc").on_click((_e, cx) => { this.isShowingDetails = false; cx.notify(); }).child("×"));
    if (!state.issue) {
      return panel.child(top).child(div().p(16).text_size(12.5).text_color(state.error ? t.blocked : t.muted).child(state.error ?? "Loading…"));
    }
    const issue = state.issue, branch = branchFor(this.issue(key));
    const when = (iso) => iso ? iso.slice(0, 16).replace("T", " ") : "";
    const fact = (label, value) => h_flex().gap(10).text_size(12.5).items_start()
      .child(div().flex_none().w(84).text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).text_color(t.foreground).child(value));

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
      .when(this.isNarrow, (el) => el.child(fact("Type", `${issue.type} · ${issue.priority} priority`)))
      .child(fact("Assignee", issue.assignee))
      .child(fact("Reporter", issue.reporter))
      .when(issue.labels.length > 0, (el) => el.child(fact("Labels", issue.labels.join(", "))))
      .child(fact("Updated", `${when(issue.updated)} · created ${when(issue.created)}`))
      .child(h_flex().gap(10).text_size(12.5).items_center()
        .child(div().flex_none().w(84).text_color(t.dim).child("Branch"))
        .child(div().id("jira-details-branch").flex_1().min_w(0).truncate().text_color(t.foreground).tooltip(branch).child(branch))
        .child(this.detailsButton(t, "jira-details-copy", "Copy", "Copy the branch name · y", (cx) => this.copyBranch(cx, key))))
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

  detailsButton(t, id, label, tooltip, onClick) {
    return div().id(id).flex_none().h(22).px(7).flex().items_center().rounded(6).border(1).border_color(t.border).bg(t.background)
      .text_size(11.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tooltip).on_click((_e, cx) => onClick(cx)).child(label);
  }

  learnTab(cx) {
    if (this.ownTab) return;
    this.ownTab = spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id ?? null;
    this.onOwnTab?.(cx);
  }

  claimKeyboard(cx) {
    const isPaneFocused = panes().some((p) => p.mod === "jira" && p.tab === this.ownTab && p.focused);
    const isNewlyFocused = isPaneFocused && !this.wasPaneFocused;
    this.wasPaneFocused = isPaneFocused;
    if (!isNewlyFocused || this.isTyping || this.handle.is_focused()) return;
    this.handle.focus();
    cx.notify();
  }

  columnList(column, columnIndex, t) {
    const isColumnSelected = columnIndex === this.column;
    const listId = `jira-col-${columnIndex}`;
    const list = v_virtual_list(listId, column.cards.length, CARD_HEIGHT, (i) => column.cards[i].key,
      (range) => column.cards.slice(range.start, range.end).map((card, k) => this.card(card, isColumnSelected && range.start + k === this.at, t)))

      .on_item_click((key, cx) => {
        this.column = columnIndex;
        this.moveTo(this.board()[columnIndex].cards.findIndex((c) => c.key === key));
        this.showDetails(cx, key);
      })
      .size_full();
    const scroll = this.scrolls.get(column.name);
    return v_flex().relative().flex_1().min_h(0)
      .child(scroll ? list.track_scroll(scroll) : list)
      .child(Scrollbar.vertical(listId).absolute().inset_0());
  }

  wideBoard(board, t) {
    return h_flex().flex_1().min_h(0).child(h_flex().id("jira-columns").flex_1().min_w(0).h_full().p(12).gap(12).overflow_x_scrollbar()
      .children(board.map((column, columnIndex) => {
        const isColumnSelected = columnIndex === this.column;
        const pressedAt = board.findIndex((c) => c.name === this.pressedColumn);
        const isDropTarget = pressedAt >= 0 && this.overColumn === column.name && pressedAt !== columnIndex;
        return v_flex().id(`jira-column-${column.name}`).relative().flex_1().min_w(260).max_w(420).h_full().gap(8)

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
          .child(this.columnList(column, columnIndex, t));
      }))
      .when(this.isShowingDetails && Boolean(this.detailKey), (el) => el.child(this.detailsPanel(t))));
  }

  narrowBoard(board, t) {
    if (this.isShowingDetails && this.detailKey) return h_flex().flex_1().min_h(0).child(this.detailsPanel(t));
    const column = board[this.column];
    return v_flex().flex_1().min_h(0).p(12).gap(10)
      .child(h_flex().flex_none().flex_wrap().gap(6)
        .children(board.map((c, columnIndex) => {
          const isSelected = columnIndex === this.column;
          return h_flex().id(`jira-chip-${c.name}`).h(24).px(8).gap(6).items_center().rounded(12).border(1).cursor_pointer()
            .border_color(isSelected ? t.accent : t.border).bg(isSelected ? t.selected : t.background)
            .text_size(12).text_color(isSelected ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.moveColumn(columnIndex - this.column); cx.notify(); })
            .child(c.name)
            .child(div().text_size(11).text_color(t.dim).child(String(c.cards.length)));
        })))
      .when(Boolean(column), (el) => el.child(this.columnList(column, this.column, t)));
  }

  sized(size, cx) {
    this.learnTab(cx);
    const isNarrow = size.width < NARROW_PX;
    if (isNarrow === this.isNarrow) return;
    this.isNarrow = isNarrow;
    cx.notify();
  }

  render(cx) {
    const currentProfile = shared("context")?.current ?? null;
    if (!checking() && this.isVisible() && this.loadedProfile !== currentProfile) {
      this.load(cx, false);
      this.readBoard(cx);
    }
    const t = theme();
    const board = this.board();
    this.column = Math.min(this.column, Math.max(0, board.length - 1));
    const title = this.site && !this.isNarrow ? `Jira · ${this.site}` : "Jira";
    const count = this.cards?.length;
    const shownCount = board.reduce((n, column) => n + column.cards.length, 0);
    const isEmpty = this.cards !== undefined && !board.length;
    const hiddenCount = this.hiddenCount();

    return v_flex().id("jira").on_size_change((size, cx) => this.sized(size, cx)).track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.handle.focus())

      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .on_hover((isOver, cx) => { if (!isOver) this.endDrag(cx); })
      .size_full().min_h(0).relative().bg(t.surface).text_size(13).text_color(t.foreground)

      .when(this.isPanel, (el) => el.rounded(10).overflow_hidden().border_1().border_color(t.border).bg(t.background))
      .child(h_flex().flex_none().px(this.isPanel ? 14 : 16).h(this.isPanel ? 42 : 48).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().font_semibold().child(title))

        .when(count !== undefined, (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(this.isNarrow ? `${shownCount} mine` : `${shownCount} open issue${shownCount === 1 ? "" : "s"} assigned to me`)))
        .when(hiddenCount > 0, (el) => el.child(div().id("jira-hidden").min_w(0).truncate().px(4).rounded(5).text_size(12).text_color(t.dim)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(`${this.isShowingHidden ? "Hide" : "Show"} ${this.config.hiddenStatuses.join(", ")} · a`)
          .on_click((_e, cx) => { this.toggleHidden(); cx.notify(); })
          .child(`${this.isShowingHidden ? "incl. " : ""}${hiddenCount} hidden${this.isNarrow ? "" : ` (${this.config.hiddenStatuses.join(", ")})`}`)))
        .child(div().flex_1())
        .child(div().id("jira-refresh").flex_none().px(4).rounded(5).text_size(12).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(this.loadedAt ? `Loaded at ${clock(this.loadedAt)} · refresh · r` : "Refresh · r")
          .on_click((_e, cx) => this.load(cx))
          .when(this.isLoading, (el) => el.frames(["◐", "◓", "◑", "◒"], 160))
          .when(!this.isLoading, (el) => el.child(this.loadedAt ? `↻ ${clock(this.loadedAt)}` : "↻"))))
      .when(this.isTyping || Boolean(this.query), (el) => el.child(div().px(16).pt(10).child(
        Input.new(this.input).h(30).px(10).items_center().rounded(6).border(1)
          .border_color(this.isTyping ? t.accent : t.input).bg(t.background).text_color(t.foreground))))
      .child(this.cards === undefined || isEmpty
        ? div().flex_1().p(16).text_color(t.dim).child(this.cards === undefined ? (this.error ? "" : "Loading issues…") : this.query ? `Nothing matches "${this.query}".` : "Nothing assigned to you is open.")
        : this.isNarrow ? this.narrowBoard(board, t) : this.wideBoard(board, t))
      .when(Boolean(this.error), (el) => el.child(div().flex_none().px(16).py(6).text_size(12).text_color(t.blocked).child(this.error)))
      .when(Boolean(this.codeError), (el) => el.child(div().flex_none().px(16).py(6).text_size(12).text_color(t.working).child(this.codeError)))
      .child(div().flex_none().px(16).py(8).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(this.isNarrow
          ? "? keys · h/l column · j/k issue · ↵ details · s start work · / search"
          : "? keys · h/l column · drag a header or H/L to move it · j/k issue · click/↵ details · o open in Jira · s start work (multirepo task) · a hidden statuses · / search · r refresh"))
      .when(this.isShowingKeys, (el) => el.child(keyHelp("jira-keys", "Jira board keys", this.keySections, t)));
  }
}
