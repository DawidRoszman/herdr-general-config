// Pure helpers for the PR monitor and review views. Checked by `node model.test.mjs`.

// Quotes each argument for the remote shell ssh hands `python3 - <args>` to (as multirepo does).
export function remoteCommand(args) {
  return ["python3", "-", ...args.map((a) => `'${String(a).replaceAll("'", "'\\''")}'`)].join(" ");
}

export function prKey(pr) {
  return `${pr.slug}#${pr.number}`;
}

export function prState(pr) {
  if (pr.state === "OPEN") return pr.isDraft ? "draft" : "open";
  return pr.state.toLowerCase();
}

// "feat/SHOP-110-search-filters" -> "SHOP-110-search-filters": what the work is, whatever its type
// (feat/, test/, fix/…), so feat/X in one repo and test/X in another are one piece of work.
export function branchTopic(branch) {
  return branch.replace(/^[a-z]+\//, "");
}

// "feat/SHOP-110-search-filters" -> "SHOP-110", else the branch without its type prefix.
export function shortBranch(branch) {
  return branch.match(/[A-Z][A-Z0-9]*-\d+/)?.[0] ?? branchTopic(branch);
}

// project: a multirepo project's root, or with isRepo a plain repo's folder. machine null: this Mac.
// branches: every branch of the topic (feat/X, test/X), when there are several; branch is the main one.
export function reviewTab(machine, project, branch, isRepo = false, branches = [branch]) {
  return { name: `PR ${shortBranch(branch)}`, mod: "prs", props: { view: "review", machine, project, branch, ...(branches.length > 1 ? { branches } : {}), ...(isRepo ? { isRepo } : {}) } };
}

// Which branch review a tab shows, as one string: review tabs publish theirs (shared OPEN_REVIEWS) so
// a click finds the tab already open, in whichever space it is.
export const OPEN_REVIEWS = "prs.openReviews";
export function reviewKey(machine, project, branch) {
  return `${machine ?? ""}|${project}|${branchTopic(branch)}`;
}

// The space a project's PR review belongs in: one on the project's machine whose folder is the
// project (or plain repo), inside it, or one of its multirepo tasks or worktrees (~/.herdr/projects/<name>/,
// ~/.herdr/worktrees/<name>/). The one on the PR's branch first; else the project's own (its folder, else
// a space named after the project, else one inside its folder), never another branch's task; null when none.
// A multirepo task's space has no branch of its own (its folder holds the repos, it isn't one), so a
// space is also on the branch when it sits in that branch's task or worktree folder, named by branchSlug.
// `checkout`: where git has the branch checked out (a worktree anywhere, from worktreeOf), whose space is first.
export function projectSpace(spaces, { machine, root, name, branch, checkout = null }) {
  const here = spaces.filter((s) => (s.machine ?? null) === (machine ?? null));
  const atCheckout = checkout && checkout !== root ? spaceAt(here, machine, checkout) : null;
  if (atCheckout) return atCheckout;
  const own = here.filter((s) => isInsideProject(s.folder, root, name));
  return own.find((s) => isOnBranch(s, name, branch)) ?? own.find((s) => s.folder === root)
    ?? (name ? here.find((s) => s.name === name) : null)
    ?? own.find((s) => s.folder === root || s.folder.startsWith(`${root}/`)) ?? null;
}

// The space on a machine whose folder is folder or inside it, or null.
export function spaceAt(spaces, machine, folder) {
  return spaces.find((s) => (s.machine ?? null) === (machine ?? null) && (s.folder === folder || Boolean(s.folder?.startsWith(`${folder}/`)))) ?? null;
}

// A folder in a project (or plain repo), or in one of its multirepo tasks or worktrees.
function isInsideProject(folder, root, name) {
  return Boolean(folder) && (folder === root || folder.startsWith(`${root}/`)
    || (Boolean(name) && (folder.includes(`/.herdr/projects/${name}/`) || folder.includes(`/.herdr/worktrees/${name}/`))));
}

// A space on a branch: git says so, or it sits in that branch's task or worktree folder (named by branchSlug).
function isOnBranch(space, name, branch) {
  const branchFolders = name ? [`/.herdr/projects/${name}/${branchSlug(branch)}`, `/.herdr/worktrees/${name}/${branchSlug(branch)}`] : [];
  return space.branch === branch || branchFolders.some((f) => space.folder?.endsWith(f) || space.folder?.includes(`${f}/`));
}

// Which machine's copy of a PR the list shows when its project is on several machines (copies sorted by
// machine name, each with machine, root, project and branch): where you work on it, so a click and g go
// there. The machine with a space on the PR's branch in that project (or in its task folder, task from
// mr prs), else the focused space's machine, else the first by name.
export function preferredCopy(copies, spaces, focusedMachine) {
  const hasBranchSpace = (c) => Boolean(c.task && spaceAt(spaces, c.machine, c.task)) || spaces.some((s) => (s.machine ?? null) === (c.machine ?? null)
    && isInsideProject(s.folder, c.root, c.project) && isOnBranch(s, c.project, c.branch));
  return copies.find(hasBranchSpace) ?? copies.find((c) => (c.machine ?? null) === (focusedMachine ?? null)) ?? copies[0];
}

// Where `git worktree list --porcelain` has a branch checked out, or null.
export function worktreeOf(porcelain, branch) {
  for (const block of String(porcelain).split("\n\n")) {
    const lines = block.split("\n");
    // Not one whose folder is gone (prunable): git still lists it until pruned.
    if (lines.includes(`branch refs/heads/${branch}`) && !lines.some((l) => l.startsWith("prunable"))) return lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? null;
  }
  return null;
}

// What here.js's FIND_PLACE printed: a multirepo task ("task" and its .mr-task.json) or a plain repo
// ("repo", its main checkout, its branch), as openReview's arguments; null for neither.
export function parsePlace(stdout) {
  const [kind, ...rest] = String(stdout).split("\n");
  if (kind === "task") {
    const task = JSON.parse(rest.join("\n"));
    return { root: task.project, branch: task.branch ?? "", isRepo: false, name: task.project.split("/").pop() };
  }
  if (kind === "repo" && rest[0]) return { root: rest[0], branch: rest[1] ?? "", isRepo: true, name: rest[0].split("/").pop() };
  return null;
}

// A branch as a folder name, as mr.py's branch_slug: feat/SHOP-130-x -> feat-SHOP-130-x.
export function branchSlug(branch) {
  return String(branch).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

// Where a repo checkout is listed from: a plain repo in a space, unless a multirepo project or task covers it.
export function isCoveredByProject(repoRoot, projectRoots) {
  return repoRoot.includes("/.herdr/projects/") || projectRoots.some((root) => repoRoot === root || repoRoot.startsWith(`${root}/`));
}

export function machineLabel(machine) {
  return machine ?? "this Mac";
}

// ---------------------------------------------------------------- monitor

// Monitor groups: one per (machine, project, branch topic), open work first, review requests from me on top.
// branch: the topic's most used branch (feat/X over a lone test/X); branches: all of them.
export function groupByBranch(projects) {
  const groups = new Map();
  for (const { machine, project, root, isRepo, prs } of projects) {
    for (const pr of prs) {
      // topic (mr prs): the task branch a repo's own branch belongs to (test/X-1, or one named differently).
      const key = `${machine}|${root}|${branchTopic(pr.topic ?? pr.branch)}`;
      if (!groups.has(key)) groups.set(key, { key, machine, project, root, isRepo: Boolean(isRepo), prs: [] });
      groups.get(key).prs.push(pr);
    }
  }
  for (const g of groups.values()) {
    g.branches = byCount(g.prs.map((pr) => pr.branch));
    g.branch = g.branches[0];
  }
  const rank = (g) => (g.isReviewRequestedFromMe ? 0 : g.isOpen ? 1 : 2);
  const list = [...groups.values()].map((g) => {
    const prs = g.prs.sort((a, b) => a.short.localeCompare(b.short));
    const stacked = prs.find((pr) => pr.stack);
    return {
      ...g,
      prs,
      isOpen: prs.some((pr) => pr.state === "OPEN"),
      isReviewRequestedFromMe: prs.some((pr) => pr.state === "OPEN" && pr.isReviewRequestedFromMe),
      updatedAt: prs.map((pr) => pr.updatedAt).sort().at(-1),
      // The stack of the first repo's stacked PR stands for the branch's stacks (one per repo).
      stackKey: stacked ? `${stacked.slug}#${stacked.stack.number}` : null,
      stackPosition: stacked?.stack.position ?? 0,
    };
  });
  // A stack's branches sort by the stack's latest update, so they stay together.
  const stackUpdatedAt = new Map();
  for (const g of list) if (g.stackKey && !(stackUpdatedAt.get(g.stackKey) >= g.updatedAt)) stackUpdatedAt.set(g.stackKey, g.updatedAt);
  return list
    .map((g) => ({ ...g, orderAt: stackUpdatedAt.get(g.stackKey) ?? g.updatedAt }))
    .sort((a, b) => rank(a) - rank(b) || byRecency(a, b));
}

// Newest first; a stack's branches together, bottom (next to the base) first.
function byRecency(a, b) {
  return (b.orderAt ?? b.updatedAt).localeCompare(a.orderAt ?? a.updatedAt)
    || (a.stackKey ?? "").localeCompare(b.stackKey ?? "") || (a.stackPosition ?? 0) - (b.stackPosition ?? 0);
}

// ---------------------------------------------------------- sidebar sections

export const SECTIONS = [
  { id: "review", title: "Needs your review", icon: "eye" },
  { id: "mine", title: "Your PRs", icon: "user" },
  { id: "others", title: "Others", icon: "pull-request" },
  { id: "bots", title: "Bots", icon: "robot", isFoldedByDefault: true },
  { id: "closed", title: "Recently closed", icon: "merge", isFoldedByDefault: true },
];

const isBot = (author) => /\[bot\]$|^app\/|dependabot|renovate/i.test(author ?? "");

// Which section a branch's PRs belong to: what needs you first, then yours, then the rest.
export function sectionOf(group) {
  if (!group.isOpen) return "closed";
  if (group.isReviewRequestedFromMe) return "review";
  if (group.prs.some((pr) => pr.author === pr.viewer)) return "mine";
  return group.prs.every((pr) => isBot(pr.author)) ? "bots" : "others";
}

// The rows the sidebar draws: a header per section that has branches, then (unless folded) its
// branches, with a project · machine line wherever the project changes inside a section.
// folded: Set of section ids the person folded or unfolded against the default (toggled).
export function sectionRows(groups, toggled, placeLabel) {
  const rows = [];
  for (const section of SECTIONS) {
    const members = groups.filter((g) => sectionOf(g) === section.id);
    if (!members.length) continue;
    const isFolded = Boolean(section.isFoldedByDefault) !== toggled.has(section.id);
    rows.push({ kind: "section", id: `section:${section.id}`, section, count: members.length, isFolded });
    if (isFolded) continue;
    const places = new Set(members.map((g) => `${g.machine}|${g.root}`));
    let lastPlace = null;
    for (const group of [...members].sort((a, b) => a.project.localeCompare(b.project) || byRecency(a, b))) {
      const place = `${group.machine}|${group.root}`;
      if (places.size > 1 && place !== lastPlace) rows.push({ kind: "place", id: `place:${section.id}:${place}`, label: placeLabel(group) });
      lastPlace = place;
      rows.push({ kind: "group", id: group.key, group });
    }
  }
  return rows;
}

// What a branch is about: its PRs' title (the most common one), else the branch.
export function groupTitle(group) {
  const counts = new Map();
  for (const pr of group.prs) counts.set(pr.title, (counts.get(pr.title) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? group.branch;
}

// The icon and theme color of a PR's state.
export function prStateIcon(pr) {
  const state = prState(pr);
  return {
    open: { icon: "pull-request", color: "done" },
    draft: { icon: "pull-request-draft", color: "dim" },
    merged: { icon: "merge", color: "ansi5" },
    closed: { icon: "pull-request-closed", color: "blocked" },
  }[state];
}

export function checksIcon(state) {
  return { failed: { icon: "x-circle", color: "blocked" }, pending: { icon: "clock", color: "working" }, passed: { icon: "check-circle", color: "done" }, none: null }[state];
}

// ------------------------------------------------------------ review status

// The review tab's status strip: { icon, color (theme name), text } for checks, review and merging.
// failed | pending | passed | none, for a PR as the review tab has it (its check runs).
export function checkState(pr) {
  const marks = checkItems(pr).map((c) => checkMark(c.outcome));
  return marks.includes("✗") ? "failed" : marks.includes("●") ? "pending" : marks.length ? "passed" : "none";
}

// An open PR whose checks GitHub is still running, or whose mergeability it is still working out.
export function isSettling(pr) {
  return pr.state === "OPEN" && (checkState(pr) === "pending" || !pr.mergeStateStatus || pr.mergeStateStatus === "UNKNOWN");
}

// Whether the same PRs still point at the same head commits, so diffs already loaded stay right.
export function hasSameHeads(before, after) {
  const head = (pr) => `${prKey(pr)}@${pr.commits.at(-1)?.oid ?? ""}`;
  return before.length === after.length && before.every((pr, i) => head(pr) === head(after[i]));
}

export function checksStatus(pr) {
  const marks = checkItems(pr).map((c) => checkMark(c.outcome));
  const failing = marks.filter((m) => m === "✗").length;
  const running = marks.filter((m) => m === "●").length;
  if (!marks.length) return { icon: "minus-circle", color: "dim", text: "No checks" };
  if (failing) return { icon: "x-circle", color: "blocked", text: `${failing} of ${marks.length} checks failing` };
  if (running) return { icon: "clock", color: "working", text: `${running} of ${marks.length} checks running` };
  return { icon: "check-circle", color: "done", text: `All ${marks.length} checks passed` };
}

const people = (reviews, state) => reviews.filter((r) => r.state === state).map((r) => r.author?.login ?? "ghost");

export function reviewStatus(pr, viewer) {
  const reviews = pr.latestReviews ?? [];
  const isRequestedFromMe = (pr.reviewRequests ?? []).some((r) => r.login && r.login === viewer);
  if (isRequestedFromMe) return { icon: "eye", color: "accent", text: "Your review is requested" };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { icon: "x-circle", color: "blocked", text: `Changes requested by ${people(reviews, "CHANGES_REQUESTED").join(", ") || "a reviewer"}` };
  if (pr.reviewDecision === "APPROVED") return { icon: "check-circle", color: "done", text: `Approved by ${people(reviews, "APPROVED").join(", ") || "a reviewer"}` };
  if (pr.reviewDecision === "REVIEW_REQUIRED") return { icon: "clock", color: "dim", text: "Review required" };
  return { icon: "minus-circle", color: "dim", text: "No review needed" };
}

export function mergeStatus(pr) {
  const state = prState(pr);
  if (state === "merged") return { icon: "merge", color: "ansi5", text: "Merged" };
  if (state === "closed") return { icon: "pull-request-closed", color: "blocked", text: "Closed" };
  if (state === "draft") return { icon: "pull-request-draft", color: "dim", text: "Draft: not ready to merge" };
  // GitHub's UNSTABLE means checks are not all passing yet: failing, or still running.
  const checks = checkState(pr);
  const why = pr.reviewDecision === "REVIEW_REQUIRED" ? "review required" : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes requested"
    : checks === "failed" ? "checks failing" : checks === "pending" ? "checks running" : "branch protection";
  return {
    CLEAN: { icon: "check-circle", color: "done", text: "Ready to merge" },
    HAS_HOOKS: { icon: "check-circle", color: "done", text: "Ready to merge" },
    UNSTABLE: checks === "pending"
      ? { icon: "clock", color: "working", text: "Mergeable once checks finish" }
      : { icon: "alert", color: "working", text: "Mergeable, but checks are failing" },
    BEHIND: { icon: "alert", color: "working", text: "Behind its base: update the branch" },
    DIRTY: { icon: "alert", color: "blocked", text: "Conflicts with its base" },
    BLOCKED: { icon: "alert", color: "blocked", text: `Blocked: ${why}` },
  }[pr.mergeStateStatus] ?? { icon: "clock", color: "dim", text: "Checking whether it can merge…" };
}

// Which actions the review tab offers for a PR (an author can't approve their own).
export function prActions(pr, viewer) {
  const isOpen = pr.state === "OPEN";
  const isMine = Boolean(viewer) && pr.author?.login === viewer;
  // Approved by me and not asked to review again since (a re-request after new commits wants a fresh look).
  const isRequestedFromMe = (pr.reviewRequests ?? []).some((r) => r.login && r.login === viewer);
  const hasApproved = Boolean(viewer) && !isRequestedFromMe
    && (pr.latestReviews ?? []).some((r) => r.author?.login === viewer && r.state === "APPROVED");
  return {
    canReview: isOpen && !isMine,
    hasApproved,
    canComment: isOpen,
    canMerge: isOpen && !pr.isDraft,
    canToggleDraft: isOpen && isMine, // only the author turns a PR into a draft or back
    isPrimaryApprove: reviewStatus(pr, viewer).color === "accent",
    isPrimaryMerge: isOpen && !pr.isDraft && ["CLEAN", "HAS_HOOKS"].includes(pr.mergeStateStatus),
  };
}

// "3m", "5h", "2d" since an ISO time.
export function age(iso, now = Date.now()) {
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// "failed" | "pending" | "passed" | "none", with counts summed over the group's PRs.
export function checksSummary(prs) {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const pr of prs) for (const name of Object.keys(counts)) counts[name] += pr.checkCounts?.[name] ?? 0;
  const state = counts.failed ? "failed" : counts.pending ? "pending" : counts.passed ? "passed" : "none";
  return { state, ...counts };
}

export function reviewSummary(prs) {
  const open = prs.filter((pr) => pr.state === "OPEN");
  if (open.some((pr) => pr.isReviewRequestedFromMe)) return "review requested from you";
  if (open.some((pr) => pr.reviewDecision === "CHANGES_REQUESTED")) return "changes requested";
  if (open.length && open.every((pr) => pr.reviewDecision === "APPROVED")) return "approved";
  if (open.some((pr) => pr.reviewDecision === "REVIEW_REQUIRED")) return "review required";
  return open.length ? "" : prs.every((pr) => pr.state === "MERGED") ? "merged" : "closed";
}

export function commentCount(prs) {
  return prs.reduce((n, pr) => n + pr.comments + pr.inlineComments, 0);
}

const CHECK_WORDS = { SUCCESS: "passed", FAILURE: "failed", ERROR: "errored" };
const REVIEW_WORDS = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes on", COMMENTED: "reviewed", DISMISSED: "dismissed a review on" };

// What changed between two refreshes, as notifications. `before` is null on the first refresh: nothing is new then.
export function prChanges(before, after) {
  if (!before) return [];
  const previous = new Map(before.map((pr) => [prKey(pr), pr]));
  const changes = [];
  for (const pr of after) {
    const name = `${pr.short} #${pr.number}`;
    const add = (title, level = "info") => changes.push({ pr, title, body: pr.title, level });
    const old = previous.get(prKey(pr));
    if (!old) {
      if (pr.state === "OPEN") add(pr.isReviewRequestedFromMe ? `Review requested: ${name}` : `New PR: ${name} by ${pr.author}`);
      continue;
    }
    if (prState(old) !== prState(pr)) add(`${name} is ${prState(pr) === "open" ? "ready for review" : prState(pr)}`, pr.state === "MERGED" ? "success" : "info");
    if (pr.checks !== old.checks && CHECK_WORDS[pr.checks]) add(`Checks ${CHECK_WORDS[pr.checks]} on ${name}`, pr.checks === "SUCCESS" ? "success" : "error");
    if (pr.isReviewRequestedFromMe && !old.isReviewRequestedFromMe) add(`Review requested: ${name}`, "warning");
    const oldReviews = new Set(old.reviews.map((r) => `${r.author}:${r.state}`));
    for (const review of pr.reviews.filter((r) => !oldReviews.has(`${r.author}:${r.state}`))) {
      add(`${review.author} ${REVIEW_WORDS[review.state] ?? "reviewed"} ${name}`, review.state === "CHANGES_REQUESTED" ? "warning" : "info");
    }
    const newComments = commentCount([pr]) - commentCount([old]);
    if (newComments > 0) add(`${newComments} new comment${newComments > 1 ? "s" : ""} on ${name}`);
  }
  return changes;
}

// ----------------------------------------------------------------- review

// `gh pr diff` output split per file: path -> numbered rows (old/new line numbers like the Changes panel).
export function parseDiff(text) {
  const files = new Map();
  let rows = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of text.split("\n")) {
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (header) {
      rows = [];
      files.set(header[2], rows);
      continue;
    }
    if (!rows) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "@", text: line });
    } else if (rows.some((r) => r.kind === "@")) {
      const kind = line[0];
      if (kind === "+") rows.push({ kind, number: newLine++, text: line.slice(1) || " " });
      else if (kind === "-") rows.push({ kind, number: oldLine++, text: line.slice(1) || " " });
      else if (kind === " ") { oldLine++; rows.push({ kind, number: newLine++, text: line.slice(1) || " " }); }
      else if (line) rows.push({ kind: "", text: line });
    } else if (/^Binary files/.test(line)) rows.push({ kind: "", text: "Binary file changed" });
  }
  return files;
}

// The users whose review a PR asks for now (teams are left out: the reviewer picker only handles people).
export function requestedLogins(pr) {
  return (pr.reviewRequests ?? []).map((r) => r.login).filter(Boolean);
}

// The reviewer picker's people: those already requested first, then the rest as given; never the
// PR's author, whom GitHub refuses as a reviewer.
// The people asked to review first, then those who reviewed already (a tick re-requests them), then everyone else.
export function reviewerChoices(candidates, pr) {
  const requested = requestedLogins(pr);
  const reviewed = Object.keys(reviewVerdicts(pr)).filter((login) => !requested.includes(login));
  const others = candidates.filter((login) => login !== pr.author?.login && !requested.includes(login) && !reviewed.includes(login));
  return [...requested, ...reviewed, ...others];
}

const VERDICT_WORDS = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", COMMENTED: "commented", DISMISSED: "dismissed" };

// Each reviewer's latest verdict as a word, the PR's author left out: { login: "approved" }.
export function reviewVerdicts(pr) {
  return Object.fromEntries((pr.latestReviews ?? [])
    .filter((r) => r.author?.login && r.author.login !== pr.author?.login)
    .map((r) => [r.author.login, VERDICT_WORDS[r.state] ?? r.state.toLowerCase()]));
}

// Whether someone who reviewed can be asked again (GitHub's "Re-request review"): not while already asked.
export function canReRequest(pr, login, viewer) {
  return pr.state === "OPEN" && Boolean(login) && login !== viewer && login !== pr.author?.login && !requestedLogins(pr).includes(login);
}

// What the picker sends when it closes: the logins newly ticked, and the requested ones unticked.
export function reviewerChanges(requested, ticked) {
  return { add: [...ticked].filter((login) => !requested.includes(login)), remove: requested.filter((login) => !ticked.has(login)) };
}

const REVIEW_STATE_OF = { approve: "APPROVED", "request-changes": "CHANGES_REQUESTED" };

/**
 * How a PR looks right after a change, before GitHub answers: the review tab shows this at once and
 * the next reload replaces it with what GitHub says. change: { action, body } for a pr-act action,
 * or { reviewers: logins } for the requested people (teams stay as they were).
 */
export function optimisticPr(pr, change, viewer, now = new Date().toISOString()) {
  const me = { login: viewer };
  if (change.reviewers) {
    return { ...pr, reviewRequests: [...(pr.reviewRequests ?? []).filter((r) => !r.login), ...change.reviewers.map((login) => ({ login }))] };
  }
  const { action, body } = change;
  const state = REVIEW_STATE_OF[action];
  if (state) {
    return {
      ...pr,
      latestReviews: [...(pr.latestReviews ?? []).filter((r) => r.author?.login !== viewer), { author: me, state }],
      reviews: body ? [...pr.reviews, { id: `pending-${now}`, author: me, state, body, submittedAt: now }] : pr.reviews,
      reviewRequests: (pr.reviewRequests ?? []).filter((r) => r.login !== viewer),
    };
  }
  if (action === "comment") return { ...pr, comments: [...pr.comments, { author: me, body, createdAt: now, url: pr.url }] };
  if (action === "merge") return { ...pr, state: "MERGED" };
  if (action === "merge-stack") {
    const isMergedWith = (entry) => entry.position <= pr.stack.position && entry.state === "OPEN";
    const entries = pr.stack.entries.map((entry) => (isMergedWith(entry) ? { ...entry, state: "MERGED" } : entry));
    return { ...pr, state: "MERGED", stack: { ...pr.stack, entries } };
  }
  if (action === "ready" || action === "draft") return { ...pr, isDraft: action === "draft" };
  return pr;
}

// ------------------------------------------------------------------ stacks

// The PR next to this one in its GitHub stack: step -1 toward the base, +1 away; undefined at an end.
export function stackNeighbor(pr, step) {
  return pr.stack?.entries.find((entry) => entry.position === pr.stack.position + step);
}

// The open PRs a stacked PR's merge takes with it: GitHub merges every open PR below it too.
export function mergedWith(pr) {
  return (pr.stack?.entries ?? []).filter((entry) => entry.position < pr.stack.position && entry.state === "OPEN");
}

// Every file's diff rows one after another, each under a header row, as GitHub's Files changed shows
// them. Each row knows its file (fileIndex); fileStarts[i] is where file i's header row is.
export function stackDiffs(files, rowsOf) {
  const rows = [];
  const fileStarts = [];
  files.forEach((file, fileIndex) => {
    fileStarts.push(rows.length);
    rows.push({ kind: "file", text: file.path, additions: file.additions, deletions: file.deletions, fileIndex, key: String(rows.length) });
    for (const row of rowsOf(file)) rows.push({ ...row, fileIndex, key: String(rows.length) });
  });
  return { rows, fileStarts };
}

// Description, then reviews and comments (PR comments, review bodies and inline code comments) by time.
export function overviewItems(pr) {
  const conversation = [
    ...pr.comments.map((c, i) => ({ key: `comment-${i}`, kind: "comment", author: c.author?.login ?? "ghost", body: c.body, at: c.createdAt, url: c.url })),
    ...pr.reviews
      .filter((r) => r.body?.trim())
      .map((r) => ({ key: `review-${r.id}`, kind: "review", state: r.state, author: r.author?.login ?? "ghost", body: r.body, at: r.submittedAt, url: pr.url })),
    ...pr.inlineComments.map((c, i) => ({ key: `inline-${i}`, kind: "inline", author: c.author, body: c.body, at: c.createdAt, url: c.url, path: c.path, line: c.line, isReply: c.isReply })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return [
    { key: "description", kind: "description", author: pr.author?.login ?? "ghost", body: pr.body?.trim() || "_No description._", at: pr.createdAt, url: pr.url },
    { key: "reviews", kind: "reviews", reviews: pr.latestReviews, requested: pr.reviewRequests },
    ...conversation,
  ];
}

// CheckRuns and StatusContexts in one shape.
export function checkItems(pr) {
  return (pr.statusCheckRollup ?? []).map((c, i) => {
    const isRun = c.__typename === "CheckRun";
    const outcome = isRun ? (c.status === "COMPLETED" ? c.conclusion : c.status) : c.state;
    return { key: `check-${i}`, name: isRun ? c.name : c.context, workflow: c.workflowName ?? "", outcome: outcome ?? "PENDING", url: isRun ? c.detailsUrl : c.targetUrl };
  });
}

export function checkMark(outcome) {
  if (["SUCCESS", "NEUTRAL"].includes(outcome)) return "✓";
  if (["SKIPPED", "CANCELLED", "STALE"].includes(outcome)) return "–";
  if (["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(outcome)) return "✗";
  return "●";
}

export function commitItems(pr) {
  return pr.commits.map((c) => ({
    key: c.oid,
    oid: c.oid.slice(0, 7),
    headline: c.messageHeadline,
    author: c.authors?.[0]?.login || c.authors?.[0]?.name || "",
    at: c.committedDate,
  }));
}

// The Files list of a parsed diff (a commit's: GitHub's PR view lists only the PR's own files).
export function diffFiles(diff) {
  return [...diff].map(([path, rows]) => ({
    key: path,
    path,
    changeType: "MODIFIED",
    additions: rows.filter((r) => r.kind === "+").length,
    deletions: rows.filter((r) => r.kind === "-").length,
  }));
}

// "2026-11-05T15:45:31Z" -> "Nov 5, 15:45" in local time.
export function shortTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()];
  return `${month} ${date.getDate()}, ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function matches(item, query) {
  return !query || JSON.stringify(item).toLowerCase().includes(query);
}

// ---------------------------------------------------------------- filters

export const DEFAULT_FILTERS = { author: "any", status: "active", review: "any", checks: "any", repo: "any", project: "any" };
const STATUS_VALUES = ["active", "open", "draft", "merged", "closed", "all"];
const REVIEW_VALUES = ["any", "requested from me", "changes requested", "approved", "review required"];
const CHECK_VALUES = ["any", "failed", "running", "passed", "none"];

function byCount(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
}

// What each filter can be set to, from the PRs at hand (most common first). Project only when there are several.
export function filterOptions(prs) {
  const options = {
    author: ["any", "me", ...byCount(prs.filter((pr) => pr.author !== pr.viewer).map((pr) => pr.author))],
    status: STATUS_VALUES,
    review: REVIEW_VALUES,
    checks: CHECK_VALUES,
    repo: ["any", ...byCount(prs.map((pr) => pr.short))],
  };
  const projects = byCount(prs.map((pr) => pr.project));
  if (projects.length > 1) options.project = ["any", ...projects];
  return options;
}

function reviewOf(pr) {
  if (pr.isReviewRequestedFromMe) return "requested from me";
  return { CHANGES_REQUESTED: "changes requested", APPROVED: "approved", REVIEW_REQUIRED: "review required" }[pr.reviewDecision] ?? "";
}

function checksOf(pr) {
  const counts = pr.checkCounts ?? {};
  return counts.failed ? "failed" : counts.pending ? "running" : counts.passed ? "passed" : "none";
}

export function matchesFilters(pr, filters) {
  const state = prState(pr);
  const isStatusMatch = { active: state === "open" || state === "draft", all: true }[filters.status] ?? state === filters.status;
  return isStatusMatch
    && (filters.author === "any" || (filters.author === "me" ? pr.author === pr.viewer : pr.author === filters.author))
    && (filters.review === "any" || reviewOf(pr) === filters.review)
    && (filters.checks === "any" || checksOf(pr) === filters.checks)
    && (filters.repo === "any" || pr.short === filters.repo)
    && (filters.project === "any" || pr.project === filters.project);
}

// The next (or previous) value of one filter; an unknown value starts over.
export function cycleFilter(options, value, step) {
  const at = options.indexOf(value);
  return options[(Math.max(at, 0) + step + options.length) % options.length];
}

// The review thread an inline comment (its index in pr.inlineComments) is in: the comment that
// started it and the replies after it, as mr lists them (each thread's first, then its answers).
export function threadOf(comments, index) {
  let start = index, end = index + 1;
  while (start > 0 && comments[start].isReply) start--;
  while (end < comments.length && comments[end].isReply) end++;
  return comments.slice(start, end);
}

// What Claude, in the branch's checkout, is asked to do about a review thread. A multirepo task holds
// each repo in its own folder, so the file is named with its repo.
export function fixThreadPrompt(pr, thread, isRepo) {
  const [first] = thread;
  const where = `${isRepo ? "" : `the ${pr.repo} repo's `}${first.path}${first.line ? `:${first.line}` : ""}`;
  const quoted = thread.map((c) => `${c.author}: ${c.body.trim()}`.split("\n").map((line) => `> ${line}`).join("\n")).join("\n>\n");
  return [
    `Fix this review thread on PR #${pr.number} (${first.url}), about ${where}:`,
    quoted,
    `Read the code there and make the change the thread asks for. If it's unclear or you disagree, tell me why instead of changing code. Commit the fix on ${pr.headRefName}, but don't push: tell me what you changed.`,
  ].join("\n\n");
}

// Claude's own PR watching, on every linked PR of the branch.
export function watchPrompt(prs) {
  const urls = prs.map((pr) => pr.url).join(" ");
  return `Watch ${prs.length > 1 ? "these PRs" : "this PR"}: ${urls}. Subscribe to ${prs.length > 1 ? "their" : "its"} activity, and when a check fails or a reviewer comments, look into it and fix what you can.`;
}
