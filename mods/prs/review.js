// Cross-repo PR review (a tab): one branch's PR in every repo of a multirepo project,
// with Overview, Files, Checks and Commits, and the review actions.

import { div, list, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { theme, run, settings, panes, focused, spaces, exec, shared, setShared, openOverlay, notify } from "herdr";
import { sshTarget, mr, mrArgv, mrJson, openReview, ensureTaskFolder, openBranchCheckout, askClaude } from "./host.js";
import { prKey, prState, overviewItems, checkItems, checkMark, commitItems, diffFiles, parseDiff, stackDiffs, optimisticPr, stackNeighbor, mergedWith, shortBranch, canReRequest, reviewKey, OPEN_REVIEWS, requestedLogins, shortTime, matches, machineLabel, prStateIcon, checksStatus, reviewStatus, mergeStatus, prActions, checksIcon, checkState, isSettling, hasSameHeads, threadOf, fixThreadPrompt, watchPrompt, commentAnchor, selectedRange, lineCommentRequest, withThreads, lineRange, markdownLines, age, pruneViewed, isViewed, toggleViewed } from "./model.js";
import { Search } from "./search.js";
import { ReviewerPicker } from "./reviewers.js";
import { highlightDiff } from "./delta.js";
import { isHelpKey, keyHelp, loadKeys } from "./keyhelp.js";

const TABS = ["overview", "files", "checks", "commits"];
const TAB_LABELS = { overview: "Overview", files: "Files", checks: "Checks", commits: "Commits" };
const ROW_HEIGHT = 30;
const DIFF_ROW_HEIGHT = 20;
const FILE_HEADER_HEIGHT = 34;
// The diff is a virtual list: every row's height is known before it draws. A comment card's height
// is estimated from its Markdown (markdownLines) at the diff's width; text past it is clipped.
// Cards sit CARD.left / CARD.right in from the diff's edges, CARD.pad inside their border.
const CARD = { left: 24, right: 12, pad: 12, rowPad: 6 };
const COMMENT = { head: 18, line: 20, avatar: 22, gap: 12, reply: 32, char: 7.2, collapsed: 8 };
const LINE_COMMENT_INPUT_HEIGHT = 84;
const LINE_COMMENT_ERROR_HEIGHT = 72; // three lines of GitHub's error
// The line comment box's buttons, right-aligned in its last row. A virtual list's rows can't have
// handlers of their own, so a press there is placed by its distance from the diff's right edge:
// edge is the card's inset, border and padding on that side.
const LINE_COMMENT_BUTTONS = { edge: CARD.right + 1 + CARD.pad, gap: 8, comment: 96, cancel: 72, height: 28 };
const AUTO_REFRESH_MS = 30000;
// After a text box loses the keyboard (Cancel, Esc, a click elsewhere), its typist's next letters
// must not become actions (d turns a PR into a draft): the action keys wait this long.
const TEXT_LEFT_GUARD_MS = 1500;
// The single keys that act (on GitHub, or open something); the rest only move around.
const ACTION_KEYS = new Set(["a", "x", "c", "m", "d", "s", "f", "g", "b", "w", "shift-r", "shift-w"]);
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
    this.handle.focus();
    this.ownTab = null; // learnt at the first layout: a pane is laid out only while its tab shows
    this.isStarted = false; // its loads and timers start at the first layout (start)
    this.isAutoRefreshing = false;
    this.scrolls = Object.fromEntries([...TABS, "diff"].map((name) => [name, VirtualListScrollHandle.new()]));
    this.search = new Search({ onChange: () => this.moveTo(0), onSubmit: (cx) => this.openItem(cx), onBlur: () => this.leftText() });
    this.compose = null; // the action whose body is being written
    this.reviewerPicker = null; // a ReviewerPicker while it shows
    // A GitHub-style comment box: Markdown, several lines (enter is a new line), sent with cmd/ctrl-enter.
    this.composeInput = TextareaState.new({ placeholder: "Leave a comment · Markdown: **bold**, `code`, ``` blocks, - lists, > quotes, | tables |, [links](url)" });
    this.composeInput.set_auto_grow(4, 14);
    this.composeInput.on("submit", (event, cx) => { if (event?.secondary) this.submitCompose(cx); });
    this.composeInput.on("blur", () => this.leftText());
    this.isComposePreview = false;
    // A review comment on lines of the PR's diff: the selected lines, and the box under them.
    this.lineSelection = null; // { path, anchor, focus }: indices into that file's diff rows; replaced on each change
    this.lineCommentInput = TextareaState.new({ placeholder: "Comment on these lines · Markdown · ⌘↵ comment · esc cancel" });
    this.lineCommentInput.set_rows(4);
    this.lineCommentInput.on("focus", () => { this.isLineCommentTyping = true; });
    this.lineCommentInput.on("blur", () => { this.isLineCommentTyping = false; this.leftText(); });
    this.lineCommentInput.on("submit", (event, cx) => { if (event?.secondary) this.postLineComment(cx); });
    this.lineCommentInput.on("change", (_e, cx) => cx.notify()); // Comment is enabled once there is text
    this.viewed = readViewed(); // files marked viewed, per PR (pruneViewed); kept in this copy's localStorage
    this.expandedThreads = new Set(); // long threads opened in full (their first comment's url)
    this.diffWidth = 700; // the diff's width as last laid out, for comment card heights
    this.isLineCommentTyping = false;
    this.isPostingLineComment = false;
    this.lineCommentError = "";
    this.diffPress = null; // the last left press on the diff: { isShift, fromRight }, read by the row click after it
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
    this.pendingConfirm = null; // { key, question, run(cx) }: an action that changes GitHub, waiting for Enter (askConfirm)
    this.textLeftAt = 0; // when a text box last lost the keyboard (TEXT_LEFT_GUARD_MS)
    this.isBusy = false;
    this.error = "";
    this.notice = "";
    // machine null is this Mac; project is a multirepo project's root, or with isRepo a plain repo's folder.
    const missing = ["project", "branch"].filter((name) => !props[name]).concat("machine" in props ? [] : ["machine"]);
    if (missing.length) this.error = `The review tab needs props { machine, project, branch, isRepo? }; missing ${missing.join(", ")}.`;
  }

  // Started from the first layout's cx, not the constructor's: the constructor runs inside whatever
  // opened the tab (run("tab.new") from an overlay: here.js, a toast), and that overlay closing ends
  // the tasks and timers started there, so the first load would never end.
  start(cx) {
    if (this.isStarted) return;
    this.isStarted = true;
    cx.spawn(async (cx) => { this.keySections = await loadKeys("review"); cx.notify(); });
    // focus() can't run in render, so a light timer does the claiming (no redraw).
    cx.timer.every(400, (cx) => { this.claimKeyboard(cx); this.refreshOnEnter(cx); });
    cx.timer.every(AUTO_REFRESH_MS, (cx) => this.autoRefresh(cx));
    cx.timer.every(10000, (cx) => this.retryLostLoad(cx));
    if (!this.error) this.act(cx, () => this.load());
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
    this.setViewed(pruneViewed(this.viewed, data.prs));
    if (!isKeepingDiffs) {
      this.diffs.clear();
      this.diffLoads.clear();
      this.lineSelection = null; // its rows are gone; the box's text stays for the next selection
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
    if (!this.commit) return pr.files.map((f) => ({ key: f.path, ...f, isViewed: isViewed(this.viewed, pr, f.path) }));
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
    const comments = this.commit ? [] : this.pr.inlineComments; // threads sit on the PR's diff, not a commit's
    const selection = this.lineSelection;
    if (cached?.diff === diff && cached.query === this.search.query && cached.version === this.highlightVersion
      && cached.comments === comments && cached.selection === selection && cached.viewed === this.viewed) return cached.view;
    const view = stackDiffs(this.items("files"), (file) => {
      if (file.isViewed) return []; // folded to its header
      const rows = diff.get(file.path);
      if (!rows) return [{ kind: "", text: "No text diff for this file (too large or binary)." }];
      const shown = withThreads(this.highlightedDiffs.get(rows) ?? rows, file.path, comments);
      return selection?.path === file.path ? withLineCommentBox(shown, file.path, selectedRange(rows, selection.anchor, selection.focus)) : shown;
    });
    this.stackedDiff = { diff, query: this.search.query, version: this.highlightVersion, comments, selection, viewed: this.viewed, view };
    return view;
  }

  // While a PR's checks run (or GitHub works out whether it can merge), reloads quietly. Only while
  // this tab shows, so open tabs in the background don't each poll GitHub; a hidden one catches up
  // at its first tick once shown. Diffs are kept unless a head commit moved.
  autoRefresh(cx) {
    if (this.data?.prs.some(isSettling)) this.quietRefresh(cx);
  }

  // Coming back to the tab (switched to it, or to its space) reloads quietly: it may be stale.
  refreshOnEnter(cx) {
    const isShown = this.isTabShown();
    const isEntered = isShown && !this.wasTabShown;
    this.wasTabShown = isShown;
    if (isEntered) this.quietRefresh(cx);
  }

  quietRefresh(cx) {
    if (!this.data || this.isBusy || this.pendingChanges || this.isAutoRefreshing || !this.isTabShown()) return;
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
        this.error = (await work(cx)) || "";
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

  // A click on a diff line selects it; a shift-click extends the selection from the line clicked
  // first, within its hunk. Only on the PR's diff: a commit's lines can't be commented here.
  selectLine(cx, path, fileRow, isExtending) {
    if (this.commit) {
      this.notice = "Comment on lines from the Files tab (the PR's diff), not a commit's diff.";
      return;
    }
    const selection = this.lineSelection;
    const isSameFile = selection?.path === path;
    this.lineSelection = isExtending && isSameFile ? { ...selection, focus: fileRow } : { path, anchor: fileRow, focus: fileRow };
    this.lineCommentError = "";
    cx.timer.after(0, () => this.lineCommentInput.focus());
  }

  // The keyboard goes back to the view, which keeps the action keys quiet for a moment (leftText):
  // what was being typed into the box must not land on them.
  closeLineComment() {
    this.lineSelection = null;
    this.lineCommentError = "";
    this.isLineCommentTyping = false;
    this.leftText();
    this.handle.focus();
  }

  cancelLineComment() {
    if (this.isPostingLineComment) return;
    this.lineCommentInput.set_value("");
    this.closeLineComment();
  }

  // Posts the box's text as one review comment on the selected lines at once (no pending review).
  // A failure stays in the box with the text, to fix and send again.
  postLineComment(cx) {
    const selection = this.lineSelection;
    const pr = this.pr;
    const diff = this.shownDiff();
    if (!selection || this.isPostingLineComment || !(diff instanceof Map)) return; // cmd-enter reaches the box and the view: post once
    const body = this.lineCommentInput.value().trim();
    const fail = (message) => { this.lineCommentError = message; cx.notify(); };
    if (!body) return fail("Write a comment first.");
    if (!pr.headRefOid) return fail("pr-view gave no head commit for this PR: refresh (r) and try again.");
    const rows = diff.get(selection.path);
    const request = lineCommentRequest({ body, commitId: pr.headRefOid, path: selection.path, rows, range: selectedRange(rows, selection.anchor, selection.focus) });
    this.isPostingLineComment = true;
    this.lineCommentError = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const comment = await this.sendLineComment(pr, request);
        pr.inlineComments = [...pr.inlineComments, comment];
        this.lineCommentInput.set_value("");
        this.closeLineComment();
        this.notice = `Commented on ${selection.path}:${comment.line}.`;
      } catch (error) {
        this.lineCommentError = `Could not comment: ${error.message ?? error}`;
      }
      this.isPostingLineComment = false;
      cx.notify();
    });
  }

  // The posted comment, as pr-view lists inline comments (mr pr-comment).
  sendLineComment(pr, request) {
    return mrJson(this.target, this.inProject(["pr-comment", pr.slug, String(pr.number), "--request", JSON.stringify(request)]));
  }

  // A row of the diff was clicked: a line selects (selectLine), the box's buttons act, other rows move the cursor.
  clickDiffRow(cx, key) {
    const { rows, fileStarts } = this.diffView();
    const row = rows[Number(key)];
    const press = this.diffPress ?? {};
    this.diffPress = null;
    if (row?.kind === "comment-actions") return this.pressLineCommentButton(cx, press.fromRight);
    if (row?.kind === "comment-box") return; // the text box's own: caret, selection, focus
    if (row?.kind === "thread") return this.toggleThread(row.comments);
    this.isDiffFocused = true;
    this.moveTo(Number(key));
    if (commentAnchor(row)) this.selectLine(cx, rows[fileStarts[row.fileIndex]].text, row.fileRow, Boolean(press.isShift));
    else this.handle.focus();
  }

  // The strip's right end, up to halfway into the gap, is Comment (while there is text); from there
  // across Cancel, Cancel.
  pressLineCommentButton(cx, fromRight) {
    const { edge, gap, comment, cancel } = LINE_COMMENT_BUTTONS;
    if (fromRight < 0) return;
    if (fromRight < edge + comment + gap / 2) {
      if (this.lineCommentInput.value().trim()) this.postLineComment(cx);
    } else if (fromRight < edge + comment + gap + cancel) this.cancelLineComment();
  }

  // A long thread's card opens in full, or folds back.
  toggleThread(comments) {
    if (!this.threadLayout(comments).isLong) return;
    const key = comments[0].url;
    if (!this.expandedThreads.delete(key)) this.expandedThreads.add(key);
  }

  // A stacked PR merges through GitHub's stack merge, which takes the open PRs below it along.
  merge(cx) {
    const pr = this.pr;
    const below = mergedWith(pr);
    const along = below.length ? ` with ${below.map((entry) => `#${entry.number}`).join(", ")} below it in stack #${pr.stack.number}` : "";
    this.askConfirm(cx, `merge ${prKey(pr)}`, `Merge ${pr.short} #${pr.number}${along} into ${mergeTarget(pr)} (merge commit)?`,
      (cx) => this.runAction(cx, pr.stack ? "merge-stack" : "merge"));
  }

  toggleDraft(cx) {
    const pr = this.pr;
    this.askConfirm(cx, `draft ${prKey(pr)}`, pr.isDraft ? `Mark ${pr.short} #${pr.number} ready for review?` : `Turn ${pr.short} #${pr.number} back into a draft?`,
      (cx) => this.runAction(cx, pr.isDraft ? "ready" : "draft"));
  }

  // An action that changes GitHub asks first: Enter (or its button again) does it; Esc, or any other
  // key, drops it. A stray key can then never merge, restack or draft a PR.
  askConfirm(cx, key, question, run) {
    if (this.pendingConfirm?.key === key) return this.confirmPending(cx);
    this.pendingConfirm = { key, question, run };
    this.notice = "";
  }

  confirmPending(cx) {
    const pending = this.pendingConfirm;
    this.pendingConfirm = null;
    pending?.run(cx);
  }

  leftText() {
    this.textLeftAt = Date.now();
  }

  // Rebases every open PR of the branch's stacks (in each repo) onto the one below and force-pushes
  // the ones that moved, as GitHub's "Rebase stack" does, then reloads: code changed.
  restack(cx) {
    this.askConfirm(cx, `restack ${prKey(this.pr)}`, `Rebase each open PR of ${this.props.branch}'s stacks onto the one below, and force-push the ones that move?`,
      (cx) => this.runRestack(cx));
  }

  runRestack(cx) {
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
  setViewed(viewed) {
    this.viewed = viewed;
    localStorage.setItem("viewed", JSON.stringify(viewed));
  }

  // v on the Files tab: the selected file (the one under the diff's cursor while the diff has the
  // keyboard) is marked viewed and its diff folds to its header, or it is unmarked and unfolds.
  toggleFileViewed() {
    if (this.commit) {
      this.notice = "Mark files viewed on the PR's Files tab, not in a commit's diff.";
      return;
    }
    const files = this.items("files");
    const fileIndex = this.isDiffFocused ? this.diffView().rows[this.at.diff]?.fileIndex : this.at.files;
    const file = files[fileIndex];
    if (!file) return;
    this.setViewed(toggleViewed(this.viewed, this.pr, file.path));
    this.notice = `${isViewed(this.viewed, this.pr, file.path) ? "Viewed" : "Not viewed"}: ${file.path}`;
    this.at.files = fileIndex;
    this.scrolls.files.scroll_to_item(fileIndex);
    // Its rows come or go: the cursor stays on its header.
    if (this.isDiffFocused) this.moveTo(this.diffView().fileStarts[fileIndex] ?? 0);
  }

  copy(cx, text, what) {
    cx.write_to_clipboard(text);
    this.error = "";
    this.notice = `Copied ${what}: ${text}`;
  }

  openStackNeighbor(step) {
    const neighbor = this.pr && stackNeighbor(this.pr, step);
    if (neighbor) return this.openStackEntry(neighbor);
    this.notice = this.pr?.stack ? `Nothing ${step < 0 ? "below" : "above"} #${this.pr.number} in stack #${this.pr.stack.number}.` : "This PR is in no stack.";
  }

  openStackEntry(entry) {
    const { machine, project, isRepo } = this.props;
    openReview(machine, project, entry.headRefName, isRepo, this.data?.project)
      .catch((error) => notify({ title: `Could not open ${entry.headRefName}`, body: String(error.message ?? error), level: "warning" }));
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

  // The review thread of the Overview's selected inline comment, or null.
  selectedThread() {
    if (this.tab !== "overview" || !this.pr) return null;
    const item = this.items()[this.at.overview];
    return item?.kind === "inline" ? threadOf(this.pr.inlineComments, Number(item.key.slice("inline-".length))) : null;
  }

  // Sends prompt to Claude Code in the branch's checkout (askClaude), which opens that space.
  sendToClaude(cx, prompt, sent) {
    const { machine, project, branch, isRepo } = this.props;
    this.act(cx, async (cx) => {
      const wait = (ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));
      await askClaude({ machine, project, branch, isRepo, repos: this.repoShorts() }, prompt, wait, (line) => { this.notice = line; cx.notify(); });
      this.notice = sent;
    });
  }

  fixThread(cx) {
    const thread = this.selectedThread();
    if (thread) this.sendToClaude(cx, fixThreadPrompt(this.pr, thread, this.props.isRepo), `Sent ${thread[0].path}'s thread to Claude.`);
  }

  watchPrs(cx) {
    const open = this.data.prs.filter((pr) => pr.state === "OPEN");
    if (!open.length) this.error = "No open PR to watch.";
    else this.sendToClaude(cx, watchPrompt(open), `Claude is watching ${open.map((pr) => `${pr.short} #${pr.number}`).join(", ")}.`);
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
    this.lineSelection = null;
    this.pendingConfirm = null;
    this.commit = null;
    this.isDiffFocused = false;
    this.search.clear();
    for (const name of Object.keys(this.at)) this.at[name] = 0;
  }

  // commit: the Files tab shows that commit's diff (from the Commits tab); the tab bar shows the PR's.
  selectTab(cx, tab, commit = null) {
    this.tab = tab;
    this.commit = commit;
    if (commit) this.lineSelection = null;
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
    const can = () => prActions(pr, this.data.viewer);
    // "?" shows this view's keys; while they show, only ? and esc do anything.
    if (this.isShowingKeys || (isHelpKey(stroke) && !(this.compose || this.isLineCommentTyping || this.search.isTyping || this.reviewerPicker?.search.isTyping))) {
      if (!this.isShowingKeys || isHelpKey(stroke) || stroke === "escape") this.isShowingKeys = !this.isShowingKeys;
      cx.stop_propagation();
      return cx.notify();
    }
    if (this.pendingConfirm && !this.compose && !this.isLineCommentTyping && !this.search.isTyping) {
      if (stroke === "enter") this.confirmPending(cx);
      else {
        this.pendingConfirm = null;
        this.notice = "Cancelled: nothing was changed.";
      }
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
    if (this.isLineCommentTyping) {
      if (stroke === "cmd-enter" || stroke === "ctrl-enter") this.postLineComment(cx);
      else if (stroke === "escape") this.cancelLineComment();
      else return;
    } else if (this.compose) {
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
      if (this.lineSelection) this.cancelLineComment();
      else if (this.isDiffFocused) this.isDiffFocused = false;
      else if (this.search.escape(this.handle)) this.moveTo(0);
      else if (this.commit) this.selectTab(cx, "commits");
      else run("pane.close");
    } else if (ACTION_KEYS.has(stroke) && Date.now() - this.textLeftAt < TEXT_LEFT_GUARD_MS) {
      this.notice = "Keys wait a moment after you leave a text box, so typing never turns into an action.";
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
    else if (stroke === "shift-w" && this.data?.prs.length && !this.isBusy) this.watchPrs(cx);
    else if (stroke === "f" && this.selectedThread() && !this.isBusy) this.fixThread(cx);
    else if (stroke === "g" && this.data) this.act(cx, () => this.openCheckout());
    else if (stroke === "v" && pr && this.tab === "files") this.toggleFileViewed();
    else if (stroke === "y" && pr) this.copy(cx, pr.headRefName, "the branch name");
    else if (stroke === "shift-y" && pr) this.copy(cx, pr.url, "the PR's URL");
    else if (!pr || this.isBusy) return;
    // As the header's buttons: a key whose button isn't shown does nothing (GitHub would refuse it).
    else if (stroke === "o") cx.open_url(pr.url);
    else if (stroke === "a" && can().canReview && !can().hasApproved) this.startCompose(cx, "approve");
    else if (stroke === "x" && can().canReview) this.startCompose(cx, "request-changes");
    else if (stroke === "c" && can().canComment) this.startCompose(cx, "comment");
    else if (stroke === "m" && can().canMerge) this.merge(cx);
    else if (stroke === "d" && can().canToggleDraft) this.toggleDraft(cx);
    else if (stroke === "shift-r" && pr.state === "OPEN") this.openReviewers(cx);
    else if (stroke === "s" && pr.stack && pr.state === "OPEN") this.restack(cx);
    else return;
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
    const isConfirmingMerge = this.pendingConfirm?.key === `merge ${prKey(pr)}`;
    const isConfirmingRestack = this.pendingConfirm?.key === `restack ${prKey(pr)}`;
    const isStackBehind = (pr.stack?.entries ?? []).some((entry) => entry.state === "OPEN" && entry.isBehind);
    return h_flex().flex_wrap().gap(6).items_center()
      .when(can.canReview, (el) => el
        .child(can.hasApproved
          ? this.actionButton("act-approve", "check", "Approved", () => {}, t, { isDisabled: true, tooltip: "You approved this PR" })
          : this.actionButton("act-approve", "check", "Approve", (cx) => this.startCompose(cx, "approve"), t, { isPrimary: can.isPrimaryApprove, tooltip: "Approve · a" }))
        .child(this.actionButton("act-changes", "x-circle", "Request changes", (cx) => this.startCompose(cx, "request-changes"), t, { tooltip: "Request changes · x" })))
      .when(can.canComment, (el) => el.child(this.actionButton("act-comment", "comment", "Comment", (cx) => this.startCompose(cx, "comment"), t, { tooltip: "Comment · c" })))
      .when(can.canMerge, (el) => el.child(this.actionButton("act-merge", "merge", isConfirmingMerge ? "Confirm merge" : "Merge", (cx) => this.merge(cx), t,
        { isPrimary: can.isPrimaryMerge && !isConfirmingMerge, isDanger: isConfirmingMerge, tooltip: `m: merge commit into ${mergeTarget(pr)}` })))
      .when(Boolean(pr.stack) && pr.state === "OPEN", (el) => el.child(this.actionButton("act-restack", "refresh", isConfirmingRestack ? "Confirm restack" : "Restack",
        (cx) => this.restack(cx), t, { isPrimary: isStackBehind && !isConfirmingRestack, isDanger: isConfirmingRestack,
          tooltip: `s: rebase the stack's PRs onto each other and force-push${isStackBehind ? " (a layer is behind the one below)" : ""}` })))
      .when(can.canToggleDraft, (el) => el.child(this.actionButton("act-draft", pr.isDraft ? "pull-request" : "pull-request-draft", pr.isDraft ? "Ready for review" : "To draft",
        (cx) => this.toggleDraft(cx), t, { tooltip: `${pr.isDraft ? "Ready for review" : "To draft"} · d` })))
      .child(this.actionButton("act-github", "external", "", (cx) => cx.open_url(pr.url), t, { tooltip: "Open on GitHub · o" }))
      .child(this.actionButton("act-checkout", "terminal", "", (cx) => this.act(cx, () => this.openCheckout()), t,
        { tooltip: `Open ${this.props.isRepo ? "the branch's worktree" : "the multirepo task"} in a space · g` }))
      .child(this.actionButton("act-blueprint", "edit", "", (cx) => {
        const { tab, pane } = focused() ?? {};
        this.act(cx, () => this.showBlueprint(tab, pane));
      }, t, { tooltip: "Blueprint of this branch · b" }))
      .child(this.actionButton("act-walkthrough", "eye", "", () => this.openWalkthrough(), t,
        { tooltip: `Walkthrough of ${this.data.prs.length > 1 ? `all ${this.data.prs.length} linked PRs` : "this PR"}, step by step · w` }))
      .when(this.data.prs.some((linked) => linked.state === "OPEN"), (el) => el.child(this.actionButton("act-watch", "clock", "Watch", (cx) => this.watchPrs(cx), t,
        { isDisabled: this.isBusy, tooltip: "Claude in the branch's checkout watches the open PRs: fixes failed checks and answers reviews · shift-w" })))
      .when(Boolean(this.selectedThread()), (el) => el.child(this.actionButton("act-fix-thread", "robot", "Fix thread", (cx) => this.fixThread(cx), t,
        { isPrimary: true, isDisabled: this.isBusy, tooltip: "Send the selected review thread to Claude in the branch's checkout · f" })));
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
        .child(div().id("copy-url").flex_none().px(4).rounded(5).cursor_pointer().text_size(15).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Copy the PR's URL · shift-y")
          .on_click((_e, cx) => { this.copy(cx, pr.url, "the PR's URL"); cx.notify(); })
          .child(`#${pr.number}`)))
      .child(h_flex().gap(14).items_center().text_size(12).text_color(t.muted).min_w(0)
        .child(h_flex().id("copy-branch").min_w(0).gap(5).items_center().px(4).ml(-4).rounded(5).cursor_pointer()
          .hover((s) => s.bg(t.hover)).tooltip(`Copy ${pr.headRefName} · y`)
          .on_click((_e, cx) => { this.copy(cx, pr.headRefName, "the branch name"); cx.notify(); })
          .child(this.icon("branch", 13, t.dim))
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
    return v_flex().id("pr-summary").w(280).flex_none().h_full().overflow_y_scrollbar().px(14).py(12).gap(8).border_l(1).border_color(t.border)
      .child(heading("eye", "Reviewers")
        .when(pr.state === "OPEN", (el) => el.child(div().flex_1()).child(div().id("edit-reviewers").flex_none().p(2).rounded(4).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Edit reviewers · shift-r")
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
        const [icon, color] = this.checkLook(c.outcome, t);
        return line(icon, color, c.name, c.workflow);
      }))
      .when(this.data.prs.length > 1, (el) => el.child(heading("repo", "Linked PRs"))
        .children(this.data.prs.map((linked) => {
          const state = prStateIcon(linked);
          return line(state.icon, t[state.color], `${linked.short} #${linked.number}`, checksStatus(linked).text.replace(/ checks?/, "").replace(/^No$/, "no checks"));
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
        .when(tab !== this.tab, (el) => el.hover((s) => s.text_color(t.foreground)))
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
        .when(item.kind === "inline" && isSelected, (el) => el.child(div().flex_none().text_color(t.accent).child("f fix in Claude")))
        .child(div().flex_none().text_color(t.dim).child(shortTime(item.at))))
      .child(TextView.markdown(`md-${prKey(this.pr)}-${item.key}`, item.body).text_size(13).text_color(t.foreground));
  }

  listRow(isSelected, t) {
    return h_flex().flex_none().h(ROW_HEIGHT).px(10).gap(10).items_center().rounded(6)
      .when(isSelected, (el) => el.bg(t.selected))
      .when(!isSelected, (el) => el.hover((s) => s.bg(t.hover)));
  }

  // A check's icon and colour, the same in the Checks tab and the Overview's summary.
  checkLook(outcome, t) {
    return { "✓": ["check-circle", t.done], "✗": ["x-circle", t.blocked], "–": ["minus-circle", t.dim], "●": ["clock", t.working] }[checkMark(outcome)];
  }

  checkRow(item, isSelected, t) {
    const [icon, color] = this.checkLook(item.outcome, t);
    return this.listRow(isSelected, t)
      .child(this.icon(icon, 13, color))
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
        // Narrow, the folder gives way well before the name (shrink weights 1000 to 1).
        .child(div().min_w(0).flex_shrink(1000).truncate().text_size(12).text_color(t.dim).child(parts.length ? `${parts.join("/")}/` : ""))
        .child(div().min_w(0).max_w(220).truncate().text_size(12).text_color(t.foreground).child(name)))
      .when(Boolean(file.isViewed), (el) => el.child(this.icon("check", 12, t.done)))
      .child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${file.additions}`))
      .child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${file.deletions}`));
  }

  fileHeaderRow(row, t) {
    return h_flex().w_full().h(FILE_HEADER_HEIGHT).flex_none().px(12).gap(8).items_center().bg(t.raised).border_t(1).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(row.isViewed ? t.muted : t.foreground).child(row.text))
      .when(row.isViewed, (el) => el.child(h_flex().flex_none().gap(4).items_center().text_size(11).text_color(t.dim)
        .child(this.icon("check", 12, t.done)).child("Viewed · v unfolds")))
      .child(div().flex_none().text_color(t.ansi2).child(`+${row.additions}`))
      .child(div().flex_none().text_color(t.ansi1).child(`−${row.deletions}`));
  }

  diffRowHeight(row) {
    if (row.kind === "file") return FILE_HEADER_HEIGHT;
    if (row.kind === "thread") return this.threadLayout(row.comments).height;
    // + 1: the card's top (box) or bottom (actions) border; without it the row clips the text box's bottom edge.
    if (row.kind === "comment-box") return CARD.rowPad + 1 + CARD.pad + COMMENT.head + 8 + LINE_COMMENT_INPUT_HEIGHT + (this.lineCommentError ? 8 + LINE_COMMENT_ERROR_HEIGHT : 0);
    if (row.kind === "comment-actions") return 8 + LINE_COMMENT_BUTTONS.height + CARD.pad + 1 + CARD.rowPad;
    return DIFF_ROW_HEIGHT;
  }

  // A thread card's measures: each comment's body height (clipped while folded), whether it is long
  // enough to fold, and the row's height.
  threadLayout(comments) {
    const isExpanded = this.expandedThreads.has(comments[0].url);
    const textWidth = this.diffWidth - CARD.left - CARD.right - 2 - 2 * CARD.pad - COMMENT.avatar - 10;
    const lines = comments.map((comment) => markdownLines(comment.body, (textWidth - (comment.isReply ? COMMENT.reply : 0)) / COMMENT.char));
    const isLong = lines.some((n) => n > COMMENT.collapsed);
    const bodies = lines.map((n) => (isExpanded ? n : Math.min(n, COMMENT.collapsed)) * COMMENT.line + 4);
    const height = 2 * CARD.rowPad + 2 + 2 * CARD.pad + COMMENT.head + 10
      + bodies.reduce((sum, body) => sum + COMMENT.head + 4 + body, 0) + COMMENT.gap * (comments.length - 1) + (isLong ? 10 + COMMENT.head : 0);
    return { bodies, isLong, isExpanded, height };
  }

  // Initials in a circle: GitHub's avatars are web images, and image() draws only the app's files.
  avatar(login, t, size = COMMENT.avatar) {
    const initials = (login ?? "?").replace(/\[bot\]$/, "").split(/[-_.]/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
    return div().size(size).flex_none().rounded(size / 2).bg(`${t.accent}2e`).flex().items_center().justify_center()
      .text_size(size * 0.42).font_semibold().text_color(t.accent).child(initials);
  }

  // A review thread under the line it ends on, as a card: the lines it is on, then each comment
  // (initials, author, how long ago, its Markdown), the answers indented. A long one folds; a click
  // on the card opens it.
  threadRow(row, t) {
    const { bodies, isLong, isExpanded, height } = this.threadLayout(row.comments);
    const [first] = row.comments;
    const end = { side: first.side, line: first.line };
    const range = lineRange(first.startLine ? { side: first.startSide ?? first.side, line: first.startLine } : end, end);
    return v_flex().w_full().h(height).flex_none().pl(CARD.left).pr(CARD.right).py(CARD.rowPad).bg(t.surface)
      .font_family(".AppleSystemUIFont").when(isLong, (el) => el.cursor_pointer())
      .child(v_flex().w_full().h_full().p(CARD.pad).gap(10).rounded(8).border(1).border_color(t.border).bg(t.background).overflow_hidden()
        .child(h_flex().h(COMMENT.head).gap(6).items_center().text_size(11.5).text_color(t.muted)
          .child(div().child(`${range.includes("–") ? "Lines" : "Line"} ${range}`))
          .child(div().text_color(t.dim).child(`· ${row.comments.length} comment${row.comments.length === 1 ? "" : "s"}`)))
        .child(v_flex().w_full().gap(COMMENT.gap).children(row.comments.map((comment, i) => h_flex().w_full().items_start().gap(10)
          .when(comment.isReply, (el) => el.pl(COMMENT.reply))
          .child(this.avatar(comment.author, t, comment.isReply ? 18 : COMMENT.avatar))
          .child(v_flex().flex_1().min_w(0).gap(4)
            .child(h_flex().h(COMMENT.head).gap(6).items_center().text_size(12.5)
              .child(div().flex_none().font_semibold().text_color(t.foreground).child(comment.author))
              .child(div().flex_none().text_color(t.dim).child(`${age(comment.createdAt)} ago`)))
            .child(div().w_full().h(bodies[i]).overflow_hidden()
              .child(TextView.markdown(`thread-${comment.url}`, comment.body).text_size(13).text_color(t.foreground)))))))
        .when(isLong, (el) => el.child(div().h(COMMENT.head).text_size(12).font_medium().text_color(t.accent).child(isExpanded ? "Show less" : "Show more"))));
  }

  // The box under the selected lines, as a card in two rows (the text, then its buttons): what it
  // comments on (the file's name; its path on hover), the text box, and GitHub's error when it fails.
  lineCommentBoxRow(row, t) {
    const error = this.lineCommentError;
    const name = row.path.split("/").pop();
    return v_flex().w_full().h(this.diffRowHeight(row)).flex_none().pl(CARD.left).pr(CARD.right).pt(CARD.rowPad).bg(t.surface).font_family(".AppleSystemUIFont")
      .child(v_flex().w_full().flex_1().px(CARD.pad).pt(CARD.pad).gap(8).rounded_t(8).border_t(1).border_l(1).border_r(1).border_color(t.border).bg(t.background)
        .child(h_flex().h(COMMENT.head).gap(6).items_center().text_size(12).min_w(0)
          .child(div().flex_none().font_semibold().text_color(t.foreground).child(row.label))
          .child(div().flex_none().text_color(t.dim).child("·"))
          .child(div().id(`box-path-${row.path}`).min_w(0).truncate().text_color(t.muted).tooltip(row.path).child(name)))
        .child(Textarea.new(this.lineCommentInput).w_full().h(LINE_COMMENT_INPUT_HEIGHT).px(12).py(10).rounded(8).border(1)
          .border_color(error ? t.blocked : this.isLineCommentTyping ? t.accent : t.input).bg(t.surface).text_color(t.foreground).text_size(13))
        .when(Boolean(error), (el) => el.child(h_flex().w_full().h(LINE_COMMENT_ERROR_HEIGHT).items_start().gap(8).px(10).py(6).rounded(6).bg(`${t.blocked}1a`)
          .child(div().flex_1().min_w(0).h_full().overflow_hidden().text_size(12).text_color(t.blocked).child(error.replace(/\s*\n\s*/g, " · "))))));
  }

  // The card's last row: a quiet hint, then Cancel and Comment at the right edge (pressLineCommentButton
  // tells them apart). Comment is the primary button, dim until there is text and while posting.
  lineCommentActionsRow(t) {
    const { gap, comment, cancel, height } = LINE_COMMENT_BUTTONS;
    const isPosting = this.isPostingLineComment;
    const canPost = !isPosting && Boolean(this.lineCommentInput.value().trim());
    const button = (width, label, isPrimary, isEnabled) => div().w(width).h(height).flex_none().flex().items_center().justify_center().rounded(7)
      .text_size(12.5).font_medium().cursor_pointer()
      .bg(isPrimary && isEnabled ? t.solid : t.raised).text_color(isPrimary && isEnabled ? t.solid_foreground : isEnabled ? t.foreground : t.muted)
      .when(isEnabled, (e) => e.hover((s) => s.opacity(0.88))).when(!isEnabled, (e) => e.opacity(0.6)).child(label);
    return v_flex().w_full().h(this.diffRowHeight({ kind: "comment-actions" })).flex_none().pl(CARD.left).pr(CARD.right).pb(CARD.rowPad).bg(t.surface).font_family(".AppleSystemUIFont")
      .child(h_flex().w_full().flex_1().px(CARD.pad).pt(8).pb(CARD.pad).gap(gap).items_center()
        .rounded_b(8).border_b(1).border_l(1).border_r(1).border_color(t.border).bg(t.background)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim)
          .child(isPosting ? "Posting to GitHub…" : "Markdown · ⌘↩ comment · Esc cancel · shift-click adds lines"))
        .child(button(cancel, "Cancel", false, !isPosting))
        .child(button(comment, isPosting ? "Posting…" : "Comment", true, canPost)));
  }

  diffRow(row, isSelected, t) {
    if (row.kind === "file") return this.fileHeaderRow(row, t);
    if (row.kind === "thread") return this.threadRow(row, t);
    if (row.kind === "comment-box") return this.lineCommentBoxRow(row, t);
    if (row.kind === "comment-actions") return this.lineCommentActionsRow(t);
    if (row.kind === "@") return div().w_full().px(12).h(DIFF_ROW_HEIGHT).flex_none().truncate().bg(t.raised).text_color(t.dim).child(row.text);
    // A line that takes a comment shows a + in its gutter under the pointer (and on the key cursor's line).
    const canComment = !this.commit && Boolean(commentAnchor(row)) && !row.isLineSelected;
    return h_flex().w_full().h(DIFF_ROW_HEIGHT).flex_none().items_center()
      .when(row.kind === "+", (e) => e.bg(`${t.ansi2}18`))
      .when(row.kind === "-", (e) => e.bg(`${t.ansi1}18`))
      .when(isSelected, (e) => e.bg(t.selected))
      .when(Boolean(row.isLineSelected), (e) => e.bg(`${t.accent}1f`))
      .child(div().w(3).h_full().flex_none().when(Boolean(row.isLineSelected), (e) => e.bg(t.accent)))
      .child(div().w(22).h_full().flex_none().flex().items_center().justify_center()
        .when(canComment, (e) => e.child(div().size(16).flex().items_center().justify_center().rounded(4).text_size(13).font_semibold()
          .text_color(isSelected ? t.accent_foreground : "#00000000").when(isSelected, (el) => el.bg(t.accent))
          .hover((s) => s.bg(t.accent).text_color(t.accent_foreground)).child("+"))))
      .child(div().w(40).pr(8).flex_none().text_right().text_color(row.isLineSelected ? t.accent : t.dim).child(row.number === undefined ? "" : String(row.number)))
      .child(div().w(16).flex_none().text_color(row.kind === "+" ? t.ansi2 : t.ansi1).child(row.kind === "+" || row.kind === "-" ? row.kind : ""))
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
      const heights = rows.map((row) => this.diffRowHeight(row));
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
        // At most a third of a narrow tab, so the diff and its comment box keep room.
        .child(v_flex().w(340).max_w_1_3().flex_none().h_full().p(6).border_r(1).border_color(t.border)
          .child(this.virtualList("pr-files", items, 26, (file, i) => this.fileRow(file, i === at, t), pick)))
        .child(v_flex().id("pr-diff-area").relative().flex_1().min_w(0).h_full().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5)
          .on_size_change((size, cx) => {
            const width = size.width / (settings().zoom ?? 1); // reported in zoomed pixels
            if (Math.abs(width - this.diffWidth) < 1) return;
            this.diffWidth = width;
            cx.notify();
          })
          // A press here stops before the view's own (which takes the keyboard): in the comment box it
          // must stay with the text box, which took it already. A click on any other row takes it (clickDiffRow).
          .on_mouse_down("left", (e, cx) => {
            // Positions come in zoomed pixels; the buttons are laid out in the px a mod writes.
            const fromRight = e.bounds && e.local_position ? (e.bounds.width - e.local_position.x) / (settings().zoom ?? 1) : -1;
            this.diffPress = { isShift: e.modifiers.shift, fromRight };
            cx.stop_propagation();
          })
          .on_scroll_wheel((_e, cx) => {
            this.isFollowingDiffScroll = true;
            this.scrolls.files.scroll_to_item(this.at.files);
            cx.notify();
          })
          .child(this.virtualList("pr-diff", rows, heights, (row, i) => this.diffRow(row, this.isDiffFocused && i === this.at.diff, t), (key, cx) => {
            this.clickDiffRow(cx, key);
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
    // A press in the box stays with it: the view's own press handler would take the keyboard back.
    return v_flex().id("compose-box").gap(6).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(`${action.label} ${this.pr.short} #${this.pr.number}: ${action.hint}`))
        .child(tab("compose-write", "Write", !isPreview, (cx) => this.setComposePreview(cx, false)))
        .child(tab("compose-preview", "Preview", isPreview, (cx) => this.setComposePreview(cx, true))))
      .child(isPreview
        // The frame is a wrapper: on the scroll area itself, its bottom edge scrolls with the text.
        ? div().rounded(6).border(1).border_color(t.border).bg(t.background).overflow_hidden()
          .child(div().id("compose-preview-body").min_h(90).max_h(318).overflow_y_scrollbar().px(12).py(10).child(preview))
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
            ? "j/k file · l/↵ diff · h files · v viewed · ⇥ tabs · [ ] repo · { } stack · a approve · x changes · c comment · m merge · s restack · d draft · R reviewers · o GitHub · g checkout · b Blueprint · w Walkthrough"
            : "j/k move · l/↵ open · ⇥ / 1-4 tabs · [ ] repo · / search · r refresh";
    const action = this.compose && COMPOSE[this.compose];
    const pending = this.pendingConfirm;
    const small = (id, label, isPrimary, onClick) => div().id(id).h(26).px(12).flex().items_center().rounded(6).cursor_pointer().text_size(12).font_medium()
      .bg(isPrimary ? t.blocked : t.raised).text_color(isPrimary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.88))
      .on_click((_e, cx) => { onClick(cx); cx.notify(); }).child(label);
    return v_flex().flex_none().px(16).py(8).gap(6).border_t(1).border_color(t.border)
      .when(Boolean(pending), (el) => el.child(h_flex().gap(8).items_center().px(10).py(6).rounded(8).bg(`${t.blocked}1a`).border(1).border_color(`${t.blocked}55`)
        .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(pending.question))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("↵ confirm · esc cancel"))
        .child(small("confirm-cancel", "Cancel", false, () => { this.pendingConfirm = null; }))
        .child(small("confirm-ok", "Confirm", true, (cx) => this.confirmPending(cx)))))
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
    this.start(cx);
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
    if (!isNewlyFocused || this.compose || this.isLineCommentTyping || this.search.isTyping || this.handle.is_focused()) return;
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

// One file's shown rows with the selected lines marked and the comment box under the last one.
// The box goes after the threads already on that line.
function withLineCommentBox(rows, path, range) {
  let at = rows.findIndex((row) => row.fileRow === range.end);
  while (rows[at + 1]?.kind === "thread") at++;
  const first = rows.find((row) => row.fileRow === range.start);
  const last = rows.find((row) => row.fileRow === range.end);
  const lines = lineRange(commentAnchor(first), commentAnchor(last));
  const label = range.start === range.end ? `Comment on line ${lines}` : `Comment on lines ${lines}`;
  const marked = rows.map((row) => (row.fileRow >= range.start && row.fileRow <= range.end && commentAnchor(row) ? { ...row, isLineSelected: true } : row));
  return [...marked.slice(0, at + 1), { kind: "comment-box", path, label }, { kind: "comment-actions" }, ...marked.slice(at + 1)];
}

// Where a merge lands: a stacked PR merges with the PRs below it into the stack's base.
// The viewed marks this copy kept; a store that isn't JSON (written by hand) starts empty.
function readViewed() {
  try {
    return JSON.parse(localStorage.getItem("viewed") ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function mergeTarget(pr) {
  return pr.stack?.base ?? pr.baseRefName;
}
