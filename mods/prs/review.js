// Cross-repo PR review (a tab): one branch's PR in every repo of a multirepo project,
// with Overview, Files, Checks and Commits, and the review actions.

import { div, list, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { theme, run, settings, panes, focused, spaces, exec, shared, setShared, openOverlay } from "herdr";
import { sshTarget, mr, mrArgv, mrJson, openReview, ensureTaskFolder, openBranchCheckout } from "./host.js";
import { prKey, prState, overviewItems, checkItems, checkMark, commitItems, diffFiles, parseDiff, stackDiffs, optimisticPr, stackNeighbor, mergedWith, shortBranch, canReRequest, reviewKey, OPEN_REVIEWS, requestedLogins, shortTime, matches, machineLabel, prStateIcon, checksStatus, reviewStatus, mergeStatus, prActions, checksIcon, checkState, isSettling, hasSameHeads } from "./model.js";
import { Search } from "./search.js";
import { ReviewerPicker } from "./reviewers.js";
import { highlightDiff } from "./delta.js";
import { isHelpKey, keyHelp, loadKeys } from "./keyhelp.js";

const TABS = ["overview", "files", "checks", "commits"];
const TAB_LABELS = { overview: "Overview", files: "Files", checks: "Checks", commits: "Commits" };
const ROW_HEIGHT = 30;
const DIFF_ROW_HEIGHT = 20;
const FILE_HEADER_HEIGHT = 34;
const AUTO_REFRESH_MS = 30000;
const REFRESH_FAILED = "Could not refresh";
// A first load still unanswered after this is lost (a command started as Herdr came up never reports
// back): the shown tab starts it again rather than say "Loading" for ever.
const LOST_LOAD_MS = 90000;
const COMPOSE = {
  approve: { label: "Approve", hint: "optional comment", isBodyRequired: false },
  "request-changes": { label: "Request changes", hint: "what has to change", isBodyRequired: true },
  comment: { label: "Comment", hint: "your comment", isBodyRequired: true },
};

export class Review {
  constructor(props, cx) {
    this.props = props;
    this.handle = cx.focus_handle();
    // Its key list lives in help-keys.json (also read by the keybinds tab), loaded once.
    this.keySections = [];
    cx.spawn(async (cx) => { this.keySections = await loadKeys("review"); cx.notify(); });
    this.handle.focus();
    this.ownTab = null; // learnt at the first layout: a pane is laid out only while its tab shows
    // focus() can't run in render, so a light timer does the claiming (no redraw).
    cx.timer.every(400, (cx) => this.claimKeyboard(cx));
    cx.timer.every(AUTO_REFRESH_MS, (cx) => this.autoRefresh(cx));
    cx.timer.every(10000, (cx) => this.retryLostLoad(cx));
    this.isAutoRefreshing = false;
    this.scrolls = Object.fromEntries([...TABS, "diff"].map((name) => [name, VirtualListScrollHandle.new()]));
    this.search = new Search({ onChange: () => this.moveTo(0), onSubmit: (cx) => this.openItem(cx) });
    this.compose = null; // the action whose body is being written
    this.reviewerPicker = null; // a ReviewerPicker while it shows
    // A GitHub-style comment box: Markdown, several lines (enter is a new line), sent with cmd/ctrl-enter.
    this.composeInput = TextareaState.new({ placeholder: "Leave a comment · Markdown: **bold**, `code`, ``` blocks, - lists, > quotes, | tables |, [links](url)" });
    this.composeInput.set_auto_grow(4, 14);
    this.composeInput.on("submit", (event, cx) => { if (event?.secondary) this.submitCompose(cx); });
    this.isComposePreview = false;
    this.previewVersion = 0; // a new id for each preview, so the Markdown view never shows an older text
    this.data = undefined; // { branch, task, prs }
    this.prIndex = 0;
    this.tab = "overview";
    this.at = { overview: 0, files: 0, checks: 0, commits: 0, diff: 0 };
    this.isDiffFocused = false;
    this.commit = null; // { oid, headline }: the Files tab shows this commit's diff instead of the PR's
    this.diffs = new Map(); // diffKey -> Map(path -> rows) | Error
    this.diffLoads = new Map(); // diffKey -> the request filling this.diffs, so asking twice waits for one
    this.reviewerCandidates = new Map(); // slug -> who can review there, asked once per tab
    this.pendingChanges = 0; // changes sent and not answered yet; a reload meanwhile would undo them on screen
    this.highlightedDiffs = new WeakMap(); // a file's parsed rows -> the same rows colored by delta
    this.highlightedPrDiffs = new WeakSet(); // a PR's diff whose files delta is coloring or colored
    this.highlightVersion = 0; // counts colored files, so the stacked diff is rebuilt with their colors
    this.stackedDiff = null; // { diff, query, version, view }: diffView()'s last answer
    this.diffTop = 0; // the first diff row on screen, as the list last laid out
    this.isFollowingDiffScroll = false; // the diff was scrolled by hand: the file list follows it
    this.confirming = null; // "merge <prKey>" or "restack <prKey>": the action pressed once, to press again
    this.isBusy = false;
    this.error = "";
    this.notice = "";
    // machine null is this Mac; project is a multirepo project's root, or with isRepo a plain repo's folder.
    const missing = ["project", "branch"].filter((name) => !props[name]).concat("machine" in props ? [] : ["machine"]);
    if (missing.length) this.error = `The review tab needs props { machine, project, branch, isRepo? }; missing ${missing.join(", ")}.`;
    else this.act(cx, () => this.load());
  }

  command(name) {
    if (name === "focus") this.handle.focus();
  }

  // ------------------------------------------------------------------- data

  get pr() {
    return this.data?.prs[this.prIndex];
  }

  async fetchView() {
    if (this.target === undefined) this.target = await sshTarget(this.props.machine);
    return mrJson(this.target, ["pr-view", ...(this.props.branches ?? [this.props.branch]), this.props.isRepo ? "--repo" : "--project", this.props.project]);
  }

  // An mr command that names only a repo slug, run with the project's direnv environment (mr --in), so
  // gh acts as the account the project's .envrc picks, as pr-view does with --project.
  inProject(args) {
    return ["--in", this.props.project, ...args];
  }

  // Shows what pr-view answered, on the same PR as before. A change's reload keeps the diffs: actions
  // here don't change code, and loading them again would blank the Files tab.
  showView(data, { isKeepingDiffs = false } = {}) {
    const shown = this.pr && prKey(this.pr);
    this.data = data;
    this.prIndex = Math.max(0, data.prs.findIndex((pr) => prKey(pr) === shown));
    if (!isKeepingDiffs) {
      this.diffs.clear();
      this.diffLoads.clear();
    }
  }

  async load() {
    this.showView(await this.fetchView());
    if (!this.data.prs.length) return `No PR for ${this.props.branch} in any repo of the project.`;
    const diffLoad = this.loadDiff(); // fetched ahead, so the Files tab opens at once
    if (this.tab === "files") await diffLoad;
    return "";
  }

  // What the Files tab shows: the PR's diff, or one commit's (this.commit).
  diffKey() {
    return this.commit ? `${prKey(this.pr)}@${this.commit.oid}` : prKey(this.pr);
  }

  shownDiff() {
    return this.pr ? this.diffs.get(this.diffKey()) : undefined;
  }

  // The shown diff, requested once; asking again while it loads waits for the same request.
  loadDiff() {
    const pr = this.pr;
    if (!pr) return Promise.resolve();
    const key = this.diffKey();
    if (!this.diffLoads.has(key)) {
      const args = this.commit ? ["commit-diff", pr.slug, this.commit.oid] : ["pr-diff", pr.slug, String(pr.number)];
      this.diffLoads.set(key, mr(this.target, this.inProject(args))
        .then((text) => this.diffs.set(key, parseDiff(text)), (error) => this.diffs.set(key, error)));
    }
    return this.diffLoads.get(key);
  }

  // The Files list: the PR's files, or the shown commit's once its diff is here.
  fileItems(pr) {
    if (!this.commit) return pr.files.map((f) => ({ key: f.path, ...f }));
    const diff = this.shownDiff();
    return diff instanceof Map ? diffFiles(diff) : [];
  }

  items(tab = this.tab) {
    const pr = this.pr;
    if (!pr) return [];
    const all = { overview: overviewItems, files: (p) => this.fileItems(p), checks: checkItems, commits: commitItems }[tab](pr);
    return all.filter((item) => matches(item, this.search.query));
  }

  // The listed files' diffs stacked, each under its header; rebuilt when the diff, the search or the colors change.
  diffView() {
    const diff = this.shownDiff();
    const note = (text) => ({ rows: [{ kind: "", text, key: "0" }], fileStarts: [] });
    if (diff === undefined) return note("Loading diff…");
    if (diff instanceof Error) return note(`Could not load the diff: ${diff.message}`);
    const cached = this.stackedDiff;
    if (cached?.diff === diff && cached.query === this.search.query && cached.version === this.highlightVersion) return cached.view;
    const view = stackDiffs(this.items("files"), (file) => {
      const rows = diff.get(file.path);
      return rows ? this.highlightedDiffs.get(rows) ?? rows : [{ kind: "", text: "No text diff for this file (too large or binary)." }];
    });
    this.stackedDiff = { diff, query: this.search.query, version: this.highlightVersion, view };
    return view;
  }

  // While a PR's checks run (or GitHub works out whether it can merge), reloads quietly. Only while
  // this tab shows, so open tabs in the background don't each poll GitHub; a hidden one catches up
  // at its first tick once shown. Diffs are kept unless a head commit moved.
  autoRefresh(cx) {
    if (!this.data?.prs.some(isSettling) || this.isBusy || this.pendingChanges || this.isAutoRefreshing || !this.isTabShown()) return;
    this.isAutoRefreshing = true;
    cx.spawn(async (cx) => {
      try {
        const data = await this.fetchView();
        if (!this.isBusy && !this.pendingChanges) {
          this.showView(data, { isKeepingDiffs: hasSameHeads(this.data.prs, data.prs) });
          this.loadDiff();
          if (this.error.startsWith(REFRESH_FAILED)) this.error = "";
        }
      } catch (error) {
        this.error ||= `${REFRESH_FAILED}: ${error.message ?? error}`;
      }
      this.isAutoRefreshing = false;
      cx.notify();
    });
  }

  retryLostLoad(cx) {
    if (this.data || !this.isBusy || Date.now() - this.busySince < LOST_LOAD_MS || !this.isTabShown()) return;
    this.isBusy = false;
    this.act(cx, () => this.load());
  }

  isTabShown() {
    return Boolean(this.ownTab) && spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id === this.ownTab;
  }

  // ---------------------------------------------------------------- actions

  act(cx, work) {
    if (this.isBusy) return;
    this.isBusy = true;
    this.busySince = Date.now();
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.error = (await work()) || "";
      } catch (error) {
        this.error = String(error.message ?? error);
      }
      this.isBusy = false;
      cx.notify();
    });
  }

  // Shows the change at once (optimisticPr), sends it, then reloads in the background. A failure
  // shows its error, and the reload puts back what GitHub has.
  sendChange(cx, pr, change, mrArgs, label) {
    const index = this.data.prs.findIndex((p) => prKey(p) === prKey(pr));
    if (index >= 0) this.data.prs[index] = optimisticPr(pr, change, this.data.viewer);
    const name = `${pr.short} #${pr.number}`;
    this.notice = `${name}: ${label}…`;
    this.error = "";
    this.pendingChanges++;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await mr(this.target, this.inProject(mrArgs));
        this.notice = `${name}: ${label} done.`;
      } catch (error) {
        this.notice = "";
        this.error = `${name}: ${label} failed: ${error.message ?? error}`;
      }
      this.pendingChanges--;
      cx.notify();
      if (this.pendingChanges) return; // the last change to answer reloads
      try {
        const data = await this.fetchView();
        if (!this.pendingChanges) this.showView(data, { isKeepingDiffs: true });
      } catch (error) {
        this.error ||= `Could not reload: ${error.message ?? error}`;
      }
      cx.notify();
    });
  }

  runAction(cx, action, body = "") {
    const pr = this.pr;
    this.sendChange(cx, pr, { action, body }, ["pr-act", pr.slug, String(pr.number), action, ...(body ? ["--body", body] : [])], action.replace("-", " "));
  }

  openReviewers(cx) {
    const pr = this.pr;
    if (pr.state !== "OPEN") {
      this.notice = "Only an open PR takes reviewers.";
      return;
    }
    const picker = new ReviewerPicker(pr, (cx) => this.submitReviewers(cx));
    this.reviewerPicker = picker;
    if (this.reviewerCandidates.has(pr.slug)) return picker.setCandidates(this.reviewerCandidates.get(pr.slug));
    cx.spawn(async (cx) => {
      try {
        const candidates = await mrJson(this.target, this.inProject(["pr-candidates", pr.slug]));
        this.reviewerCandidates.set(pr.slug, candidates);
        picker.setCandidates(candidates);
      } catch (error) {
        picker.error = `Could not list who can review: ${error.message ?? error}`;
      }
      cx.notify();
    });
  }

  // GitHub's "Re-request review": asks someone who reviewed already to review again.
  reRequestReview(cx, pr, login) {
    const reviewers = [...requestedLogins(pr), login];
    this.sendChange(cx, pr, { reviewers }, ["pr-reviewers", pr.slug, String(pr.number), "--add", login], `re-request ${login}`);
  }

  submitReviewers(cx) {
    const { pr } = this.reviewerPicker;
    const { add, remove } = this.reviewerPicker.changes();
    this.reviewerPicker = null;
    this.handle.focus();
    if (!add.length && !remove.length) return;
    const reviewers = [...requestedLogins(pr).filter((login) => !remove.includes(login)), ...add];
    this.sendChange(cx, pr, { reviewers }, ["pr-reviewers", pr.slug, String(pr.number), ...(add.length ? ["--add", add.join(",")] : []), ...(remove.length ? ["--remove", remove.join(",")] : [])], "reviewers");
  }

  startCompose(cx, action) {
    this.compose = action;
    this.isComposePreview = false;
    this.composeInput.set_value("");
    cx.timer.after(0, () => this.composeInput.focus());
  }

  // Write or Preview: the preview is the text as GitHub will show it.
  setComposePreview(cx, isPreview) {
    this.isComposePreview = isPreview;
    if (isPreview) {
      this.previewVersion++;
      this.handle.focus();
    } else cx.timer.after(0, () => this.composeInput.focus());
  }

  closeCompose() {
    this.compose = null;
    this.isComposePreview = false;
    this.handle.focus();
  }

  submitCompose(cx) {
    const action = this.compose;
    if (!action) return; // cmd-enter reaches both the box and the view: send once
    const body = this.composeInput.value().trim();
    if (COMPOSE[action].isBodyRequired && !body) {
      this.error = `${COMPOSE[action].label} needs a message.`;
      return cx.notify();
    }
    this.closeCompose();
    this.runAction(cx, action, body);
  }

  // A stacked PR merges through GitHub's stack merge, which takes the open PRs below it along.
  merge(cx) {
    const pr = this.pr;
    if (!this.isConfirmed("merge", pr)) {
      const below = mergedWith(pr);
      const along = below.length ? ` with ${below.map((entry) => `#${entry.number}`).join(", ")} below it in stack #${pr.stack.number}` : "";
      this.notice = `Press m again to merge ${pr.short} #${pr.number}${along} into ${mergeTarget(pr)} (merge commit).`;
      return;
    }
    this.runAction(cx, pr.stack ? "merge-stack" : "merge");
  }

  // Actions that rewrite or merge ask once: true on the second press in a row, else remembers this one.
  isConfirmed(action, pr) {
    const asked = `${action} ${prKey(pr)}`;
    const isSecondPress = this.confirming === asked;
    this.confirming = isSecondPress ? null : asked;
    return isSecondPress;
  }

  // Rebases every open PR of the branch's stacks (in each repo) onto the one below and force-pushes
  // the ones that moved, as GitHub's "Rebase stack" does, then reloads: code changed.
  restack(cx) {
    const pr = this.pr;
    if (!this.isConfirmed("restack", pr)) {
      this.notice = `Press s again to rebase each open PR of ${this.props.branch}'s stacks onto the one below and force-push the ones that move.`;
      return;
    }
    const { branch, isRepo, project } = this.props;
    this.notice = `Restacking ${branch}…`;
    this.act(cx, async () => {
      const report = (await mr(this.target, ["restack", branch, isRepo ? "--repo" : "--project", project])).trim();
      const error = await this.load();
      this.notice = report.replaceAll("\n", " · ");
      return error;
    });
  }

  // The PR below (step -1) or above (+1) this one in its stack, in that branch's review tab.
  openStackNeighbor(step) {
    const neighbor = this.pr && stackNeighbor(this.pr, step);
    if (neighbor) return this.openStackEntry(neighbor);
    this.notice = this.pr?.stack ? `Nothing ${step < 0 ? "below" : "above"} #${this.pr.number} in stack #${this.pr.stack.number}.` : "This PR is in no stack.";
  }

  openStackEntry(entry) {
    const { machine, project, isRepo } = this.props;
    openReview(machine, project, entry.headRefName, isRepo, this.data?.project);
  }

  // The multirepo task's folder, the task made quietly when missing (ensureTaskFolder).
  async ensureTask() {
    if (this.data.task) return this.data.task;
    const { machine, project, branch } = this.props;
    await ensureTaskFolder(machine, project, branch, this.repoShorts(), (line) => { this.notice = line; });
    await this.load();
    if (!this.data.task) throw new Error(`pr-view lists no task for ${branch} after making it.`);
    return this.data.task;
  }

  repoShorts() {
    return this.data.prs.map((pr) => pr.short);
  }

  // Blueprint beside this review, on the branch's checkout (the multirepo task, ensureTask).
  // With no agent in this tab, Blueprint has a headless Claude draw it.
  async showBlueprint(tab, pane) {
    const { machine, project, branch, isRepo } = this.props;
    // A plain repo has no task to make: Blueprint uses whichever of its worktrees has the branch.
    if (!this.data.task && isRepo) return `Blueprint needs ${branch} checked out in ${project} (or one of its worktrees) on ${machineLabel(machine)}.`;
    await this.ensureTask();
    const existing = panes().find((p) => p.mod === "blueprint" && p.tab === tab);
    if (existing) run("pane.focus", { pane: existing.pane });
    else {
      const about = `Reviewing ${branch}: ${this.data.prs.map((pr) => `${pr.short} PR #${pr.number} "${pr.title}" into ${pr.baseRefName}`).join("; ")}. `
        + "Draw what this branch changes and the code it touches, across these repos.";
      run("pane.split", { direction: "right", pane, mod: "blueprint", props: { machine, folder: this.data.task, branch, about, draw: true } });
    }
    this.notice = "";
    return "";
  }

  // The branch's checkout in a space (openBranchCheckout).
  async openCheckout() {
    const { machine, project, branch, isRepo } = this.props;
    await openBranchCheckout({ machine, project, branch, isRepo, repos: this.repoShorts() }, (line) => { this.notice = line; });
    this.notice = "";
  }

  // The walkthrough mod over every PR of this review, read as one change: a plain repo's PR, or
  // each linked repo's with paths under the repo's name. It reads the diffs with mr pr-diff, as
  // the Files tab does, so a project on another machine works too.
  openWalkthrough() {
    const { machine, project, branch, isRepo } = this.props;
    const prs = this.data.prs.map((pr) => ({
      number: pr.number, title: pr.title, body: pr.body ?? "", head: pr.headRefName, base: pr.baseRefName,
      prefix: isRepo ? "" : pr.short, diff: mrArgv(this.target, this.inProject(["pr-diff", pr.slug, String(pr.number)])),
    }));
    openOverlay({
      mod: "walkthrough", kind: "dialog", modal: true, width: 0.74, height: 0.8,
      props: { pullRequests: { key: reviewKey(machine, project, branch), name: this.data.project, branch, prs } },
    });
  }

  // ------------------------------------------------------------- navigation

  selectPr(index) {
    this.prIndex = index;
    this.confirming = null;
    this.commit = null;
    this.isDiffFocused = false;
    this.search.clear();
    for (const name of Object.keys(this.at)) this.at[name] = 0;
  }

  // commit: the Files tab shows that commit's diff (from the Commits tab); the tab bar shows the PR's.
  selectTab(cx, tab, commit = null) {
    this.tab = tab;
    this.commit = commit;
    this.isDiffFocused = false;
    this.search.clear();
    if (tab === "files") this.act(cx, async () => { await this.loadDiff(); return ""; });
  }

  moveTo(index) {
    const list = this.isDiffFocused ? "diff" : this.tab;
    this.at[list] = index;
    this.scrolls[list].scroll_to_item(index);
    this.isFollowingDiffScroll = false;
    if (list === "files") {
      this.at.diff = this.diffView().fileStarts[index] ?? 0;
      this.scrolls.diff.scroll_to_item(this.at.diff);
      this.diffTop = this.at.diff;
    } else if (list === "diff") {
      this.diffTop = index;
      this.at.files = this.diffView().rows[index]?.fileIndex ?? this.at.files;
      this.scrolls.files.scroll_to_item(this.at.files);
    }
  }

  move(step) {
    const count = this.isDiffFocused ? this.diffView().rows.length : this.items().length;
    if (!count) return;
    const at = this.at[this.isDiffFocused ? "diff" : this.tab];
    this.moveTo(this.isDiffFocused ? Math.min(count - 1, Math.max(0, at + step)) : (at + step + count) % count);
  }

  // Colors the shown PR's files one by one in the background, in diff order; each shows uncolored until delta answers.
  // ponytail: one delta run per file; batch files into one run if big PRs color too slowly.
  highlightShownPr(cx) {
    const diff = this.shownDiff();
    if (!(diff instanceof Map) || this.highlightedPrDiffs.has(diff)) return;
    this.highlightedPrDiffs.add(diff);
    cx.spawn(async (cx) => {
      try {
        for (const [path, rows] of diff) {
          this.highlightedDiffs.set(rows, await highlightDiff(rows, path, { exec, isDark: Boolean(settings().dark) }));
          this.highlightVersion++;
          cx.notify();
        }
      } catch (error) {
        this.error = error.message;
        cx.notify();
      }
    });
  }

  openItem(cx) {
    const item = this.items()[this.at[this.tab]];
    if (!item) return;
    if (this.tab === "files") {
      this.isDiffFocused = true;
      this.moveTo(this.diffTop);
      return cx.notify();
    }
    if (this.tab === "commits") {
      this.selectTab(cx, "files", { oid: item.key, headline: item.headline });
      return cx.notify();
    }
    cx.open_url(item.url ?? this.pr.url);
  }

  key(e, cx) {
    const stroke = e.keystroke;
    const pr = this.pr;
    // "?" shows this view's keys; while they show, only ? and esc do anything.
    if (this.isShowingKeys || (isHelpKey(stroke) && !(this.compose || this.search.isTyping || this.reviewerPicker?.search.isTyping))) {
      if (!this.isShowingKeys || isHelpKey(stroke) || stroke === "escape") this.isShowingKeys = !this.isShowingKeys;
      cx.stop_propagation();
      return cx.notify();
    }
    if (this.reviewerPicker) {
      const result = this.reviewerPicker.key(stroke, this.handle, cx);
      if (!result) return;
      if (result === "close") this.reviewerPicker = null;
      if (result === "submit") this.submitReviewers(cx);
      cx.stop_propagation();
      return cx.notify();
    }
    if (this.compose) {
      if (stroke === "cmd-enter" || stroke === "ctrl-enter") this.submitCompose(cx);
      else if (stroke === "ctrl-shift-p") this.setComposePreview(cx, !this.isComposePreview);
      else if (stroke === "escape") this.closeCompose();
      else return;
    } else if (this.search.isTyping) {
      if (stroke === "escape") this.search.escape(this.handle);
      else if (stroke === "down") this.move(1);
      else if (stroke === "up") this.move(-1);
      else return;
    } else if (stroke === "escape") {
      if (this.isDiffFocused) this.isDiffFocused = false;
      else if (this.search.escape(this.handle)) this.moveTo(0);
      else if (this.commit) this.selectTab(cx, "commits");
      else run("pane.close");
    } else if (stroke === "/") this.search.open(cx);
    else if (stroke === "j" || stroke === "down") this.move(1);
    else if (stroke === "k" || stroke === "up") this.move(-1);
    else if (stroke === "shift-j" || stroke === "pagedown") this.move(15);
    else if (stroke === "shift-k" || stroke === "pageup") this.move(-15);
    else if (stroke === "l" || stroke === "enter") this.openItem(cx);
    else if (stroke === "h") this.isDiffFocused = false;
    else if (stroke === "tab" || stroke === "shift-tab") {
      const step = stroke === "tab" ? 1 : TABS.length - 1;
      this.selectTab(cx, TABS[(TABS.indexOf(this.tab) + step) % TABS.length]);
    } else if (/^[1-4]$/.test(stroke)) this.selectTab(cx, TABS[Number(stroke) - 1]);
    else if ((stroke === "]" || stroke === "[") && this.data?.prs.length) {
      const count = this.data.prs.length;
      this.selectPr((this.prIndex + (stroke === "]" ? 1 : count - 1)) % count);
      if (this.tab === "files") this.act(cx, async () => { await this.loadDiff(); return ""; });
    } else if (stroke === "{" || stroke === "shift-[") this.openStackNeighbor(-1);
    else if (stroke === "}" || stroke === "shift-]") this.openStackNeighbor(1);
    else if (stroke === "r") this.act(cx, () => this.load());
    else if (stroke === "b" && this.data) {
      const { tab, pane } = focused() ?? {};
      this.notice = "Opening Blueprint…";
      this.act(cx, () => this.showBlueprint(tab, pane));
    }
    else if (stroke === "w" && this.data?.prs.length) this.openWalkthrough();
    else if (stroke === "g" && this.data) this.act(cx, () => this.openCheckout());
    else if (!pr || this.isBusy) return;
    else if (stroke === "o") cx.open_url(pr.url);
    else if (stroke === "a" && !prActions(pr, this.data.viewer).hasApproved) this.startCompose(cx, "approve");
    else if (stroke === "x") this.startCompose(cx, "request-changes");
    else if (stroke === "c") this.startCompose(cx, "comment");
    else if (stroke === "m") this.merge(cx);
    else if (stroke === "d") this.runAction(cx, pr.isDraft ? "ready" : "draft");
    else if (stroke === "shift-r") this.openReviewers(cx);
    else if (stroke === "s" && pr.stack && pr.state === "OPEN") this.restack(cx);
    else return;
    if (stroke !== "m" && stroke !== "s") this.confirming = null;
    cx.stop_propagation();
    cx.notify();
  }

  // ----------------------------------------------------------------- render

  icon(name, size, color) {
    return svg(`mods/prs/icons/${name}.svg`).size(size).flex_none().text_color(color);
  }

  stateBadge(pr, t) {
    const look = prStateIcon(pr);
    const color = t[look.color];
    return h_flex().flex_none().px(8).h(24).gap(5).items_center().rounded(12).bg(`${color}26`).text_color(color)
      .child(this.icon(look.icon, 13, color))
      .child(div().text_size(12).font_semibold().child(prState(pr).replace(/^./, (c) => c.toUpperCase())));
  }

  // A header button: an icon and a label; primary is filled, danger red.
  actionButton(id, icon, label, onClick, t, { isPrimary = false, isDanger = false, isDisabled = false, tooltip = "" } = {}) {
    const fill = isDanger ? t.blocked : isPrimary ? t.solid : t.raised;
    const text = isDisabled ? t.muted : isDanger || isPrimary ? t.solid_foreground : t.foreground;
    return h_flex().id(id).flex_none().h(28).px(10).gap(6).items_center().rounded(7)
      .bg(fill).text_color(text).border(1).border_color(isDanger ? t.blocked : isPrimary ? t.solid : t.input)
      .when(isDisabled, (el) => el.opacity(0.6))
      .when(!isDisabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => { onClick(cx); cx.notify(); }))
      .when(Boolean(tooltip), (el) => el.tooltip(tooltip))
      .child(this.icon(icon, 14, text))
      .when(Boolean(label), (el) => el.child(div().text_size(12.5).font_medium().child(label)));
  }

  actionBar(pr, t) {
    const can = prActions(pr, this.data.viewer);
    const isConfirmingMerge = this.confirming === `merge ${prKey(pr)}`;
    const isConfirmingRestack = this.confirming === `restack ${prKey(pr)}`;
    const isStackBehind = (pr.stack?.entries ?? []).some((entry) => entry.state === "OPEN" && entry.isBehind);
    return h_flex().flex_wrap().gap(6).items_center()
      .when(can.canReview, (el) => el
        .child(can.hasApproved
          ? this.actionButton("act-approve", "check", "Approved", () => {}, t, { isDisabled: true, tooltip: "You approved this PR" })
          : this.actionButton("act-approve", "check", "Approve", (cx) => this.startCompose(cx, "approve"), t, { isPrimary: can.isPrimaryApprove, tooltip: "a" }))
        .child(this.actionButton("act-changes", "x-circle", "Request changes", (cx) => this.startCompose(cx, "request-changes"), t, { tooltip: "x" })))
      .when(can.canComment, (el) => el.child(this.actionButton("act-comment", "comment", "Comment", (cx) => this.startCompose(cx, "comment"), t, { tooltip: "c" })))
      .when(can.canMerge, (el) => el.child(this.actionButton("act-merge", "merge", isConfirmingMerge ? "Confirm merge" : "Merge", (cx) => this.merge(cx), t,
        { isPrimary: can.isPrimaryMerge && !isConfirmingMerge, isDanger: isConfirmingMerge, tooltip: `m: merge commit into ${mergeTarget(pr)}` })))
      .when(Boolean(pr.stack) && pr.state === "OPEN", (el) => el.child(this.actionButton("act-restack", "refresh", isConfirmingRestack ? "Confirm restack" : "Restack",
        (cx) => this.restack(cx), t, { isPrimary: isStackBehind && !isConfirmingRestack, isDanger: isConfirmingRestack,
          tooltip: `s: rebase the stack's PRs onto each other and force-push${isStackBehind ? " (a layer is behind the one below)" : ""}` })))
      .when(can.canToggleDraft, (el) => el.child(this.actionButton("act-draft", pr.isDraft ? "pull-request" : "pull-request-draft", pr.isDraft ? "Ready for review" : "To draft",
        (cx) => this.runAction(cx, pr.isDraft ? "ready" : "draft"), t, { tooltip: "d" })))
      .child(this.actionButton("act-github", "external", "", (cx) => cx.open_url(pr.url), t, { tooltip: "Open on GitHub · o" }))
      .child(this.actionButton("act-checkout", "terminal", "", (cx) => this.act(cx, () => this.openCheckout()), t,
        { tooltip: `Open ${this.props.isRepo ? "the branch's worktree" : "the multirepo task"} in a space · g` }))
      .child(this.actionButton("act-blueprint", "edit", "", (cx) => {
        const { tab, pane } = focused() ?? {};
        this.act(cx, () => this.showBlueprint(tab, pane));
      }, t, { tooltip: "Blueprint of this branch · b" }))
      .child(this.actionButton("act-walkthrough", "eye", "", () => this.openWalkthrough(), t,
        { tooltip: `Walkthrough of ${this.data.prs.length > 1 ? `all ${this.data.prs.length} linked PRs` : "this PR"}, step by step · w` }));
  }

  statusChip(id, status, t) {
    const color = t[status.color] ?? t.dim;
    return h_flex().id(id).flex_none().h(24).px(8).gap(6).items_center().rounded(6).bg(`${color}1f`)
      .child(this.icon(status.icon, 13, color))
      .child(div().text_size(12).text_color(status.color === "dim" ? t.muted : color).child(status.text));
  }

  header(pr, t) {
    return v_flex().flex_none().px(16).pt(14).pb(10).gap(10).border_b(1).border_color(t.border)
      .child(h_flex().gap(10).items_center().min_w(0)
        .child(this.stateBadge(pr, t))
        .child(div().flex_1().min_w(0).truncate().text_size(17).font_semibold().text_color(t.foreground).child(pr.title))
        .child(div().flex_none().text_size(15).text_color(t.dim).child(`#${pr.number}`)))
      .child(h_flex().gap(14).items_center().text_size(12).text_color(t.muted).min_w(0)
        .child(h_flex().min_w(0).gap(5).items_center().child(this.icon("branch", 13, t.dim))
          .child(div().min_w(0).truncate().font_family(settings().font_family ?? "JetBrains Mono").child(`${pr.headRefName} → ${pr.baseRefName}`)))
        .child(h_flex().flex_none().gap(5).items_center().child(this.icon("user", 13, t.dim)).child(pr.author?.login ?? "ghost"))
        .child(div().flex_1())
        .child(div().flex_none().text_color(t.ansi2).child(`+${pr.additions}`))
        .child(div().flex_none().text_color(t.ansi1).child(`−${pr.deletions}`))
        .child(div().flex_none().text_color(t.dim).child(`${pr.changedFiles} files`)))
      .child(h_flex().gap(6).flex_wrap().items_center()
        .child(this.statusChip("status-checks", checksStatus(pr), t))
        .child(this.statusChip("status-review", reviewStatus(pr, this.data.viewer), t))
        .child(this.statusChip("status-merge", mergeStatus(pr), t)))
      .child(this.actionBar(pr, t))
      .when(Boolean(pr.stack), (el) => el.child(this.stackBar(pr, t)))
      .when(this.data.prs.length > 1, (el) => el.child(h_flex().gap(6).items_center().flex_wrap()
        .child(h_flex().gap(4).items_center().mr(2).child(this.icon("repo", 12, t.dim)).child(div().text_size(11.5).text_color(t.dim).child("Linked PRs")))
        .children(this.data.prs.map((linked, index) => {
          const isShown = index === this.prIndex;
          const state = prStateIcon(linked);
          const checks = checksIcon(checkState(linked));
          return h_flex().id(`chip-${prKey(linked)}`).h(26).px(8).gap(6).items_center().rounded(7).border(1).cursor_pointer()
            .border_color(isShown ? t.accent : t.border).bg(isShown ? t.selected : t.background)
            .hover((s) => s.bg(t.hover)).tooltip(`${linked.title} · [ ] switch`)
            .on_click((_e, cx) => {
              this.selectPr(index);
              if (this.tab === "files") this.act(cx, async () => { await this.loadDiff(); return ""; });
              cx.notify();
            })
            .child(this.icon(state.icon, 13, t[state.color]))
            .child(div().text_size(12).text_color(isShown ? t.foreground : t.muted).child(`${linked.short} #${linked.number}`))
            .when(Boolean(checks), (el) => el.child(this.icon(checks.icon, 12, t[checks.color])));
        }))));
  }

  // The shown PR's GitHub stack, base first; a click opens that layer's review.
  stackBar(pr, t) {
    const entries = [...pr.stack.entries].sort((a, b) => a.position - b.position);
    return h_flex().gap(6).items_center().flex_wrap()
      .child(h_flex().gap(4).items_center().mr(2).child(this.icon("stack", 12, t.dim))
        .child(div().text_size(11.5).text_color(t.dim).child(`Stack #${pr.stack.number} on ${pr.stack.base}`)))
      .children(entries.map((entry) => {
        const isShown = entry.number === pr.number;
        const state = prStateIcon(entry);
        return h_flex().id(`stack-${entry.number}`).h(26).px(8).gap(6).items_center().rounded(7).border(1).cursor_pointer()
          .border_color(isShown ? t.accent : t.border).bg(isShown ? t.selected : t.background)
          .hover((s) => s.bg(t.hover)).tooltip(`${entry.title}${entry.state === "OPEN" && entry.isBehind ? " · behind the PR below: s restacks" : ""} · { } move down or up the stack`)
          .on_click((_e, cx) => { if (!isShown) this.openStackEntry(entry); cx.notify(); })
          .child(this.icon(state.icon, 13, t[state.color]))
          .child(div().text_size(12).text_color(isShown ? t.foreground : t.muted).child(`${entry.position}. #${entry.number} ${shortBranch(entry.headRefName)}`))
          .when(entry.state === "OPEN" && entry.isBehind, (el) => el.child(this.icon("alert", 12, t.working)));
      }));
  }

  // Overview's right column: who reviews, what checks say, the other repos' PRs, the size.
  summary(pr, t) {
    const heading = (icon, text) => h_flex().gap(6).items_center().pt(4)
      .child(this.icon(icon, 13, t.dim)).child(div().text_size(11.5).font_semibold().text_color(t.muted).child(text));
    const line = (icon, color, text, detail = "") => h_flex().gap(6).items_center().min_w(0).text_size(12)
      .child(this.icon(icon, 12, color))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(text))
      .when(Boolean(detail), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(detail)));
    const reviewLook = { APPROVED: ["check-circle", t.done, "approved"], CHANGES_REQUESTED: ["x-circle", t.blocked, "changes"], COMMENTED: ["comment", t.muted, "commented"], DISMISSED: ["minus-circle", t.dim, "dismissed"] };
    const checks = checkItems(pr);
    const markLook = { "✓": ["check-circle", t.done], "✗": ["x-circle", t.blocked], "–": ["minus-circle", t.dim], "●": ["clock", t.working] };
    return v_flex().id("pr-summary").w(280).flex_none().h_full().overflow_y_scrollbar().px(14).py(12).gap(8).border_l(1).border_color(t.border)
      .child(heading("eye", "Reviewers")
        .when(pr.state === "OPEN", (el) => el.child(div().flex_1()).child(div().id("edit-reviewers").flex_none().p(2).rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { if (!this.isBusy) this.openReviewers(cx); cx.notify(); })
          .child(this.icon("edit", 12, t.dim)))))
      .children((pr.latestReviews ?? []).map((r) => {
        const [icon, color, word] = reviewLook[r.state] ?? ["comment", t.muted, r.state.toLowerCase()];
        const login = r.author?.login;
        return line(icon, color, login ?? "ghost", word)
          .when(canReRequest(pr, login, this.data.viewer), (el) => el.child(div().id(`re-request-${login}`).flex_none().p(2).rounded(4).cursor_pointer()
            .hover((s) => s.bg(t.hover)).tooltip(`Re-request ${login}'s review`)
            .on_click((_e, cx) => { if (!this.isBusy) this.reRequestReview(cx, pr, login); cx.notify(); })
            .child(this.icon("refresh", 12, t.dim))));
      }))
      .children((pr.reviewRequests ?? []).map((r) => line("clock", r.login === this.data.viewer ? t.accent : t.dim, r.login ?? r.name ?? "team", r.login === this.data.viewer ? "you · requested" : "requested")))
      .when(!(pr.latestReviews ?? []).length && !(pr.reviewRequests ?? []).length, (el) => el.child(div().text_size(12).text_color(t.dim).child("Nobody yet")))
      .child(heading("check-circle", `Checks · ${checks.length}`))
      .children(checks.map((c) => {
        const [icon, color] = markLook[checkMark(c.outcome)];
        return line(icon, color, c.name, c.workflow);
      }))
      .when(this.data.prs.length > 1, (el) => el.child(heading("repo", "Linked PRs"))
        .children(this.data.prs.map((linked) => {
          const state = prStateIcon(linked);
          return line(state.icon, t[state.color], `${linked.short} #${linked.number}`, checksStatus(linked).text.replace(/ checks?/, ""));
        })))
      .child(heading("edit", "Size"))
      .child(div().text_size(12).text_color(t.muted).child(`${pr.changedFiles} files · ${pr.commits.length} commits · +${pr.additions} −${pr.deletions}`));
  }

  tabBar(pr, t) {
    const counts = { overview: "", files: this.commit ? this.items("files").length : pr.changedFiles, checks: checkItems(pr).length, commits: pr.commits.length };
    return h_flex().flex_none().px(16).h(36).gap(18).items_end().border_b(1).border_color(t.border)
      .children(TABS.map((tab) => h_flex().id(`tab-${tab}`).h_full().gap(5).items_center().cursor_pointer()
        .border_b(2).border_color(tab === this.tab ? t.accent : "#00000000")
        .on_click((_e, cx) => { this.selectTab(cx, tab); cx.notify(); })
        .child(div().text_size(12.5).font_medium().text_color(tab === this.tab ? t.foreground : t.muted).child(TAB_LABELS[tab]))
        .when(counts[tab] !== "", (el) => el.child(div().text_size(11).text_color(t.dim).child(String(counts[tab]))))));
  }

  overviewCard(item, isSelected, t) {
    const card = v_flex().w_full().p(12).gap(6).rounded(8).border(1).border_color(isSelected ? t.accent : t.border).bg(t.background);
    if (item.kind === "reviews") {
      const lines = [
        ...item.reviews.map((r) => ({ who: r.author?.login ?? "ghost", what: r.state.toLowerCase().replace("_", " "), color: r.state === "APPROVED" ? t.done : r.state === "CHANGES_REQUESTED" ? t.blocked : t.muted })),
        ...item.requested.map((r) => ({ who: r.login ?? r.name ?? "team", what: "review requested", color: t.accent })),
      ];
      return card.child(div().text_size(12).font_semibold().text_color(t.muted).child("Reviews"))
        .when(!lines.length, (el) => el.child(div().text_size(12).text_color(t.dim).child("No reviews yet.")))
        .children(lines.map((l) => h_flex().gap(8).text_size(12.5)
          .child(div().w(220).truncate().text_color(t.foreground).child(l.who))
          .child(div().text_color(l.color).child(l.what))));
    }
    const what = {
      description: "opened this PR",
      comment: "commented",
      review: { APPROVED: "approved", CHANGES_REQUESTED: "requested changes", COMMENTED: "reviewed", DISMISSED: "review dismissed" }[item.state] ?? "reviewed",
      inline: `${item.isReply ? "replied" : "commented"} on ${item.path}${item.line ? `:${item.line}` : ""}`,
    }[item.kind];
    return card
      .child(h_flex().gap(6).text_size(12).min_w(0)
        .child(div().flex_none().font_semibold().text_color(t.foreground).child(item.author))
        .child(div().flex_1().min_w(0).truncate().text_color(item.kind === "inline" ? t.accent : t.muted).child(what))
        .child(div().flex_none().text_color(t.dim).child(shortTime(item.at))))
      .child(TextView.markdown(`md-${prKey(this.pr)}-${item.key}`, item.body).text_size(13).text_color(t.foreground));
  }

  listRow(isSelected, t) {
    return h_flex().flex_none().h(ROW_HEIGHT).px(10).gap(10).items_center().rounded(6)
      .when(isSelected, (el) => el.bg(t.selected))
      .when(!isSelected, (el) => el.hover((s) => s.bg(t.hover)));
  }

  checkRow(item, isSelected, t) {
    const mark = checkMark(item.outcome);
    const color = { "✓": t.done, "✗": t.blocked, "–": t.dim, "●": t.working }[mark];
    return this.listRow(isSelected, t)
      .child(div().flex_none().w(14).text_color(color).child(mark))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(item.name))
      .child(div().flex_none().text_size(11.5).text_color(t.dim).child([item.workflow, item.outcome.toLowerCase().replace("_", " ")].filter(Boolean).join(" · ")));
  }

  commitRow(item, isSelected, t) {
    return this.listRow(isSelected, t)
      .child(div().flex_none().w(64).font_family(settings().font_family ?? "JetBrains Mono").text_size(12).text_color(t.accent).child(item.oid))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(item.headline))
      .child(div().flex_none().text_size(11.5).text_color(t.dim).child(`${item.author} · ${shortTime(item.at)}`));
  }

  fileRow(file, isSelected, t) {
    const parts = file.path.split("/");
    const name = parts.pop();
    const letter = { ADDED: "A", DELETED: "D", RENAMED: "R", COPIED: "C" }[file.changeType] ?? "M";
    return this.listRow(isSelected, t).h(26).gap(6)
      .when(isSelected && this.isDiffFocused, (el) => el.bg(t.hover))
      .child(div().flex_none().w(12).text_size(11).text_color(letter === "A" ? t.ansi2 : letter === "D" ? t.ansi1 : t.working).child(letter))
      .child(h_flex().flex_1().min_w(0)
        .child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(parts.length ? `${parts.join("/")}/` : ""))
        .child(div().flex_none().max_w(220).truncate().text_size(12).text_color(t.foreground).child(name)))
      .child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${file.additions}`))
      .child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${file.deletions}`));
  }

  fileHeaderRow(row, t) {
    return h_flex().w_full().h(FILE_HEADER_HEIGHT).flex_none().px(12).gap(8).items_center().bg(t.raised).border_t(1).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(row.text))
      .child(div().flex_none().text_color(t.ansi2).child(`+${row.additions}`))
      .child(div().flex_none().text_color(t.ansi1).child(`−${row.deletions}`));
  }

  diffRow(row, isSelected, t) {
    if (row.kind === "file") return this.fileHeaderRow(row, t);
    if (row.kind === "@") return div().w_full().px(12).h(DIFF_ROW_HEIGHT).flex_none().truncate().bg(t.raised).text_color(t.dim).child(row.text);
    return h_flex().w_full().h(DIFF_ROW_HEIGHT).flex_none().gap(10)
      .when(row.kind === "+", (e) => e.bg(`${t.ansi2}18`))
      .when(row.kind === "-", (e) => e.bg(`${t.ansi1}18`))
      .when(isSelected, (e) => e.bg(t.selected))
      .child(div().w(40).flex_none().text_right().text_color(t.dim).child(row.number === undefined ? "" : String(row.number)))
      .child(div().w(10).flex_none().text_color(row.kind === "+" ? t.ansi2 : t.ansi1).child(row.kind === "+" || row.kind === "-" ? row.kind : ""))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().children((row.segments ?? [{ text: row.text }]).map((segment) => this.codeSegment(segment, row.kind, t))));
  }

  codeSegment({ text, color, isChanged }, lineKind, t) {
    return div().flex_none().when(Boolean(color), (e) => e.text_color(color))
      .when(isChanged, (e) => e.rounded(2).bg(`${lineKind === "+" ? t.ansi2 : t.ansi1}48`))
      .child(text);
  }

  // A virtual list with its scrollbar, rows built inside the list's callback.
  virtualList(id, items, height, rowFor, onClick, onLayout = () => {}) {
    return v_flex().relative().flex_1().min_h(0).min_w(0)
      .child(v_virtual_list(id, items.length, height, (i) => items[i].key ?? String(i), (range) => {
        onLayout(range);
        return items.slice(range.start, range.end).map((item, k) => rowFor(item, range.start + k));
      })
        .on_item_click((key, cx) => onClick(key, cx))
        .track_scroll(this.scrolls[id === "pr-diff" ? "diff" : this.tab])
        .size_full())
      .child(Scrollbar.vertical(id).absolute().inset_0());
  }

  body(t, cx) {
    const items = this.items();
    const at = this.at[this.tab];
    const pick = (key, cx) => {
      this.isDiffFocused = false;
      this.moveTo(Math.max(0, items.findIndex((item) => item.key === key)));
      cx.notify();
    };
    if (!items.length) return div().p(16).text_color(t.dim).child(this.search.query ? `Nothing matches "${this.search.query}".` : "Nothing here.");
    if (this.tab === "overview") {
      return h_flex().flex_1().min_h(0)
        .child(v_flex().relative().flex_1().min_w(0).h_full().px(16).py(10)
          .child(list("pr-overview", items.length, (i) => items[i].key, (i) => div().pb(10).max_w(860).child(this.overviewCard(items[i], i === at, t)))
            .on_item_click(pick)
            .track_scroll(this.scrolls.overview)
            .size_full())
          .child(Scrollbar.vertical("pr-overview").absolute().inset_0()))
        .child(this.summary(this.pr, t));
    }
    if (this.tab === "files") {
      this.highlightShownPr(cx);
      const { rows, fileStarts } = this.diffView();
      const stickyHeader = rows[fileStarts[rows[this.diffTop]?.fileIndex]];
      const heights = rows.map((row) => (row.kind === "file" ? FILE_HEADER_HEIGHT : DIFF_ROW_HEIGHT));
      // A layout can't redraw the file list, so a wheel event does: it shows the file the last layout found on top.
      const followScroll = (range) => {
        this.diffTop = range.start;
        if (this.isFollowingDiffScroll) this.at.files = rows[range.start]?.fileIndex ?? this.at.files;
      };
      return v_flex().flex_1().min_h(0)
        .when(Boolean(this.commit), (el) => el.child(h_flex().flex_none().h(30).px(16).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(12)
          .child(div().flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_color(t.accent).child(this.commit.oid.slice(0, 7)))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(this.commit.headline))
          .child(div().flex_none().text_color(t.dim).child("esc: back to Commits · Files tab: the whole PR"))))
        .child(h_flex().flex_1().min_h(0)
        .child(v_flex().w(340).flex_none().h_full().p(6).border_r(1).border_color(t.border)
          .child(this.virtualList("pr-files", items, 26, (file, i) => this.fileRow(file, i === at, t), pick)))
        .child(v_flex().id("pr-diff-area").relative().flex_1().min_w(0).h_full().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5)
          .on_scroll_wheel((_e, cx) => {
            this.isFollowingDiffScroll = true;
            this.scrolls.files.scroll_to_item(this.at.files);
            cx.notify();
          })
          .child(this.virtualList("pr-diff", rows, heights, (row, i) => this.diffRow(row, this.isDiffFocused && i === this.at.diff, t), (key, cx) => {
            this.isDiffFocused = true;
            this.moveTo(Number(key));
            cx.notify();
          }, followScroll))
          // The shown file's header stays on top, like GitHub's; it has no handlers, so the wheel still reaches the list.
          .when(Boolean(stickyHeader), (el) => el.child(div().absolute().top(0).left(0).right(0).child(this.fileHeaderRow(stickyHeader, t))))));
    }
    const rowFor = this.tab === "checks" ? (item, i) => this.checkRow(item, i === at, t) : (item, i) => this.commitRow(item, i === at, t);
    return v_flex().flex_1().min_h(0).p(8).child(this.virtualList(`pr-${this.tab}`, items, ROW_HEIGHT, rowFor, (key, cx) => {
      pick(key, cx);
      this.openItem(cx);
    }));
  }

  // The comment box: Write (Markdown source, growing with it) and Preview tabs, and a send button.
  composer(action, t) {
    const isPreview = this.isComposePreview;
    const body = this.composeInput.value();
    const tab = (id, label, isShown, onClick) => div().id(id).h(24).px(10).flex().items_center().rounded(5).cursor_pointer().text_size(12)
      .bg(isShown ? t.selected : t.background).text_color(isShown ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { onClick(cx); cx.notify(); }).child(label);
    const preview = body.trim()
      ? TextView.markdown(`compose-preview-${this.previewVersion}`, body).text_size(13).text_color(t.foreground)
      : div().text_size(12.5).text_color(t.dim).child("Nothing to preview");
    return v_flex().gap(6)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(`${action.label} ${this.pr.short} #${this.pr.number}: ${action.hint}`))
        .child(tab("compose-write", "Write", !isPreview, (cx) => this.setComposePreview(cx, false)))
        .child(tab("compose-preview", "Preview", isPreview, (cx) => this.setComposePreview(cx, true))))
      .child(isPreview
        ? div().id("compose-preview-body").min_h(92).max_h(320).overflow_y_scrollbar().px(12).py(10).rounded(6).border(1).border_color(t.border).bg(t.background).child(preview)
        : Textarea.new(this.composeInput).w_full().px(10).py(8).rounded(6).border(1).border_color(t.accent).bg(t.background).text_color(t.foreground).text_size(13))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child("Markdown supported, as on GitHub"))
        .child(div().id("compose-cancel").h(26).px(10).flex().items_center().rounded(6).cursor_pointer().text_size(12).text_color(t.muted)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.closeCompose(); cx.notify(); }).child("Cancel"))
        .child(div().id("compose-send").h(26).px(12).flex().items_center().rounded(6).cursor_pointer().text_size(12).font_medium()
          .bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.88))
          .on_click((_e, cx) => { this.submitCompose(cx); cx.notify(); }).child(action.label)));
  }

  footer(t) {
    const hint = this.isBusy
      ? "working…"
      : this.compose
        ? "⌘↵ send · ↵ new line · ⌃⇧P write / preview · esc cancel"
        : this.search.isTyping
          ? "↵ open · ↑↓ choose · esc keep filter"
          : this.tab === "files"
            ? "j/k file · l/↵ diff · h files · ⇥ tabs · [ ] repo · { } stack · a approve · x changes · c comment · m merge · s restack · d draft · R reviewers · o GitHub · g checkout · b Blueprint · w Walkthrough"
            : "j/k move · l/↵ open · ⇥ / 1-4 tabs · [ ] repo · / search · r refresh · ? all keys";
    const action = this.compose && COMPOSE[this.compose];
    return v_flex().flex_none().px(16).py(8).gap(6).border_t(1).border_color(t.border)
      .when(Boolean(action), (el) => el.child(this.composer(action, t)))
      .when(this.search.isShown, (el) => el.child(Input.new(this.search.input).h(28).px(8).items_center().rounded(6).border(1)
        .border_color(this.search.isTyping ? t.accent : t.input).bg(t.background).text_color(t.foreground).text_size(12)))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .when(Boolean(this.notice) && !this.error, (el) => el.child(div().text_size(12).text_color(t.muted).child(this.notice)))
      .child(div().text_size(11).text_color(t.dim).truncate().child(`? keys · ${hint}`));
  }

  // Tells openReview this tab shows this branch; entries of tabs that are gone are dropped.
  publishTab() {
    const { machine, project, branch } = this.props;
    const tabs = new Set(spaces().flatMap((s) => s.tabs.map((t) => t.id)));
    const kept = Object.entries(shared(OPEN_REVIEWS) ?? {}).filter(([tab]) => tabs.has(tab) && tab !== this.ownTab);
    setShared(OPEN_REVIEWS, Object.fromEntries([...kept, [this.ownTab, reviewKey(machine, project, branch)]]));
  }

  // The tab this pane is in: the shown one at its first layout (a pane is laid out only while
  // its tab shows; at init, focused() can still name the tab that was shown before).
  learnTab(cx) {
    if (this.ownTab) return;
    this.ownTab = spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id ?? null;
    if (this.ownTab) this.publishTab();
    this.onOwnTab?.(cx);
  }

  // A new pane is Herdr's focused pane but doesn't hold the keyboard until clicked: take it
  // when this pane becomes the focused one (opened, switched to). Only on that change: a
  // palette or dialog opened over it leaves the pane focused and must keep its typing; when
  // it closes Herdr sends "focus" (mod.json focusable), which hands the keyboard back.
  claimKeyboard(cx) {
    const isPaneFocused = panes().some((p) => p.mod === "prs" && p.tab === this.ownTab && p.focused);
    const isNewlyFocused = isPaneFocused && !this.wasPaneFocused;
    this.wasPaneFocused = isPaneFocused;
    if (!isNewlyFocused || this.compose || this.search.isTyping || this.handle.is_focused()) return;
    this.handle.focus();
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const pr = this.pr;
    const root = v_flex().id("pr-review").on_size_change((_size, cx) => this.learnTab(cx)).track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .size_full().min_h(0).relative().bg(t.surface).text_size(13).text_color(t.foreground);
    if (!pr) {
      return root.child(v_flex().flex_1().p(16).gap(6)
        .child(div().font_semibold().child(this.props.branch ?? "Pull request"))
        .child(div().text_color(this.error ? t.blocked : t.muted).child(this.error || `Loading PRs from ${machineLabel(this.props.machine)}…`)));
    }
    return root.child(this.header(pr, t)).child(this.tabBar(pr, t)).child(this.body(t, cx)).child(this.footer(t))
      .when(Boolean(this.reviewerPicker), (el) => el.child(this.reviewerPicker.render(t)))
      .when(this.isShowingKeys, (el) => el.child(keyHelp("pr-review-keys", "PR review keys", this.keySections, t, 150)));
  }
}

// Where a merge lands: a stacked PR merges with the PRs below it into the stack's base.
function mergeTarget(pr) {
  return pr.stack?.base ?? pr.baseRefName;
}
