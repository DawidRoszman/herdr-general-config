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

export function branchTopic(branch) {
  return branch.replace(/^[a-z]+\//, "");
}

export function shortBranch(branch) {
  return branch.match(/[A-Z][A-Z0-9]*-\d+/)?.[0] ?? branchTopic(branch);
}

export function reviewTab(machine, project, branch, isRepo = false, branches = [branch]) {
  return { name: `PR ${shortBranch(branch)}`, mod: "prs", props: { view: "review", machine, project, branch, ...(branches.length > 1 ? { branches } : {}), ...(isRepo ? { isRepo } : {}) } };
}

export const OPEN_REVIEWS = "prs.openReviews";
export function reviewKey(machine, project, branch) {
  return `${machine ?? ""}|${project}|${branchTopic(branch)}`;
}

export function projectSpace(spaces, { machine, root, name, branch, checkout = null }) {
  const here = spaces.filter((s) => (s.machine ?? null) === (machine ?? null));
  const atCheckout = checkout && checkout !== root ? spaceAt(here, machine, checkout) : null;
  if (atCheckout) return atCheckout;
  const own = here.filter((s) => isInsideProject(s.folder, root, name));
  return own.find((s) => isOnBranch(s, name, branch)) ?? own.find((s) => s.folder === root)
    ?? (name ? here.find((s) => s.name === name) : null)
    ?? own.find((s) => s.folder === root || s.folder.startsWith(`${root}/`)) ?? null;
}

export function spaceAt(spaces, machine, folder) {
  return spaces.find((s) => (s.machine ?? null) === (machine ?? null) && (s.folder === folder || Boolean(s.folder?.startsWith(`${folder}/`)))) ?? null;
}

function isInsideProject(folder, root, name) {
  return Boolean(folder) && (folder === root || folder.startsWith(`${root}/`)
    || (Boolean(name) && (folder.includes(`/.herdr/projects/${name}/`) || folder.includes(`/.herdr/worktrees/${name}/`))));
}

function isOnBranch(space, name, branch) {
  const branchFolders = name ? [`/.herdr/projects/${name}/${branchSlug(branch)}`, `/.herdr/worktrees/${name}/${branchSlug(branch)}`] : [];
  return space.branch === branch || branchFolders.some((f) => space.folder?.endsWith(f) || space.folder?.includes(`${f}/`));
}

export function preferredCopy(copies, spaces, focusedMachine) {
  const hasBranchSpace = (c) => Boolean(c.task && spaceAt(spaces, c.machine, c.task)) || spaces.some((s) => (s.machine ?? null) === (c.machine ?? null)
    && isInsideProject(s.folder, c.root, c.project) && isOnBranch(s, c.project, c.branch));
  return copies.find(hasBranchSpace) ?? copies.find((c) => (c.machine ?? null) === (focusedMachine ?? null)) ?? copies[0];
}

export function worktreeOf(porcelain, branch) {
  for (const block of String(porcelain).split("\n\n")) {
    const lines = block.split("\n");

    if (lines.includes(`branch refs/heads/${branch}`) && !lines.some((l) => l.startsWith("prunable"))) return lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? null;
  }
  return null;
}

export function parsePlace(stdout) {
  const [kind, ...rest] = String(stdout).split("\n");
  if (kind === "task") {
    const task = JSON.parse(rest.join("\n"));

    const root = task.host?.project ?? task.project;
    return { root, branch: task.branch ?? "", isRepo: false, name: root.split("/").pop(), ...(task.host ? { machine: task.host.machine } : {}) };
  }
  if (kind === "repo" && rest[0]) return { root: rest[0], branch: rest[1] ?? "", isRepo: true, name: rest[0].split("/").pop() };
  return null;
}

export function branchSlug(branch) {
  return String(branch).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

export function isCoveredByProject(repoRoot, projectRoots) {
  return repoRoot.includes("/.herdr/projects/") || projectRoots.some((root) => repoRoot === root || repoRoot.startsWith(`${root}/`));
}

export function machineLabel(machine) {
  return machine ?? "this Mac";
}

export function groupByBranch(projects) {
  const groups = new Map();
  for (const { machine, project, root, isRepo, prs } of projects) {
    for (const pr of prs) {

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

      stackKey: stacked ? `${stacked.slug}#${stacked.stack.number}` : null,
      stackPosition: stacked?.stack.position ?? 0,
    };
  });

  const stackUpdatedAt = new Map();
  for (const g of list) if (g.stackKey && !(stackUpdatedAt.get(g.stackKey) >= g.updatedAt)) stackUpdatedAt.set(g.stackKey, g.updatedAt);
  return list
    .map((g) => ({ ...g, orderAt: stackUpdatedAt.get(g.stackKey) ?? g.updatedAt }))
    .sort((a, b) => rank(a) - rank(b) || byRecency(a, b));
}

function byRecency(a, b) {
  return (b.orderAt ?? b.updatedAt).localeCompare(a.orderAt ?? a.updatedAt)
    || (a.stackKey ?? "").localeCompare(b.stackKey ?? "") || (a.stackPosition ?? 0) - (b.stackPosition ?? 0);
}

export const SECTIONS = [
  { id: "review", title: "Needs your review", icon: "eye" },
  { id: "mine", title: "Your PRs", icon: "user" },
  { id: "others", title: "Others", icon: "pull-request" },
  { id: "bots", title: "Bots", icon: "robot", isFoldedByDefault: true },
  { id: "closed", title: "Recently closed", icon: "merge", isFoldedByDefault: true },
];

const isBot = (author) => /\[bot\]$|^app\/|dependabot|renovate/i.test(author ?? "");

export function sectionOf(group) {
  if (!group.isOpen) return "closed";
  if (group.isReviewRequestedFromMe) return "review";
  if (group.prs.some((pr) => pr.author === pr.viewer)) return "mine";
  return group.prs.every((pr) => isBot(pr.author)) ? "bots" : "others";
}

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

export function groupTitle(group) {
  const counts = new Map();
  for (const pr of group.prs) counts.set(pr.title, (counts.get(pr.title) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? group.branch;
}

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

export function checkState(pr) {
  const marks = checkItems(pr).map((c) => checkMark(c.outcome));
  return marks.includes("✗") ? "failed" : marks.includes("●") ? "pending" : marks.length ? "passed" : "none";
}

export function isSettling(pr) {
  return pr.state === "OPEN" && (checkState(pr) === "pending" || !pr.mergeStateStatus || pr.mergeStateStatus === "UNKNOWN");
}

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

export function prActions(pr, viewer) {
  const isOpen = pr.state === "OPEN";
  const isMine = Boolean(viewer) && pr.author?.login === viewer;

  const isRequestedFromMe = (pr.reviewRequests ?? []).some((r) => r.login && r.login === viewer);
  const hasApproved = Boolean(viewer) && !isRequestedFromMe
    && (pr.latestReviews ?? []).some((r) => r.author?.login === viewer && r.state === "APPROVED");
  return {
    canReview: isOpen && !isMine,
    hasApproved,
    canComment: isOpen,
    canMerge: isOpen && !pr.isDraft,
    canToggleDraft: isOpen && isMine,
    isPrimaryApprove: reviewStatus(pr, viewer).color === "accent",
    isPrimaryMerge: isOpen && !pr.isDraft && ["CLEAN", "HAS_HOOKS"].includes(pr.mergeStateStatus),
  };
}

export function age(iso, now = Date.now()) {
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

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

export function requestedLogins(pr) {
  return (pr.reviewRequests ?? []).map((r) => r.login).filter(Boolean);
}

export function reviewerChoices(candidates, pr) {
  const requested = requestedLogins(pr);
  const reviewed = Object.keys(reviewVerdicts(pr)).filter((login) => !requested.includes(login));
  const others = candidates.filter((login) => login !== pr.author?.login && !requested.includes(login) && !reviewed.includes(login));
  return [...requested, ...reviewed, ...others];
}

const VERDICT_WORDS = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", COMMENTED: "commented", DISMISSED: "dismissed" };

export function reviewVerdicts(pr) {
  return Object.fromEntries((pr.latestReviews ?? [])
    .filter((r) => r.author?.login && r.author.login !== pr.author?.login)
    .map((r) => [r.author.login, VERDICT_WORDS[r.state] ?? r.state.toLowerCase()]));
}

export function canReRequest(pr, login, viewer) {
  return pr.state === "OPEN" && Boolean(login) && login !== viewer && login !== pr.author?.login && !requestedLogins(pr).includes(login);
}

export function reviewerChanges(requested, ticked) {
  return { add: [...ticked].filter((login) => !requested.includes(login)), remove: requested.filter((login) => !ticked.has(login)) };
}

const REVIEW_STATE_OF = { approve: "APPROVED", "request-changes": "CHANGES_REQUESTED" };

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

export function stackNeighbor(pr, step) {
  return pr.stack?.entries.find((entry) => entry.position === pr.stack.position + step);
}

export function mergedWith(pr) {
  return (pr.stack?.entries ?? []).filter((entry) => entry.position < pr.stack.position && entry.state === "OPEN");
}

export function stackDiffs(files, rowsOf) {
  const rows = [];
  const fileStarts = [];
  files.forEach((file, fileIndex) => {
    fileStarts.push(rows.length);
    rows.push({ kind: "file", text: file.path, additions: file.additions, deletions: file.deletions, isViewed: Boolean(file.isViewed), fileIndex, key: String(rows.length) });
    for (const row of rowsOf(file)) rows.push({ ...row, fileIndex, key: String(rows.length) });
  });
  return { rows, fileStarts };
}

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

export function checkItems(pr) {
  const latest = new Map();
  (pr.statusCheckRollup ?? []).forEach((c, i) => {
    const isRun = c.__typename === "CheckRun";
    const outcome = isRun ? (c.status === "COMPLETED" ? c.conclusion : c.status) : c.state;
    const item = { key: `check-${i}`, name: isRun ? c.name : c.context, workflow: c.workflowName ?? "", event: c.workflowEvent ?? "",
      outcome: outcome ?? "PENDING", url: isRun ? c.detailsUrl : c.targetUrl, at: c.startedAt ?? c.createdAt ?? "" };
    const run = `${item.workflow}|${item.name}|${item.event}`;
    if (!latest.has(run) || item.at >= latest.get(run).at) latest.set(run, item);
  });
  const items = [...latest.values()].sort((a, b) => Number(a.key.slice(6)) - Number(b.key.slice(6)));
  const events = new Map();
  for (const item of items) events.set(`${item.workflow}|${item.name}`, (events.get(`${item.workflow}|${item.name}`) ?? 0) + 1);
  return items.map(({ at, ...item }) => (events.get(`${item.workflow}|${item.name}`) > 1 && item.event ? { ...item, name: `${item.name} (${item.event})` } : item));
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

export function pruneViewed(viewed, prs) {
  const kept = {};
  for (const pr of prs) {
    const marks = viewed?.[prKey(pr)];
    if (pr.state === "OPEN" && marks?.head === pr.headRefOid && Array.isArray(marks.paths) && marks.paths.length) kept[prKey(pr)] = marks;
  }
  return kept;
}

export function isViewed(viewed, pr, path) {
  const marks = viewed[prKey(pr)];
  return Boolean(marks && marks.head === pr.headRefOid && marks.paths.includes(path));
}

export function toggleViewed(viewed, pr, path) {
  const marks = viewed[prKey(pr)]?.head === pr.headRefOid ? viewed[prKey(pr)].paths : [];
  const paths = marks.includes(path) ? marks.filter((p) => p !== path) : [...marks, path];
  const { [prKey(pr)]: _old, ...others } = viewed;
  return paths.length ? { ...others, [prKey(pr)]: { head: pr.headRefOid, paths } } : others;
}

export function diffFiles(diff) {
  return [...diff].map(([path, rows]) => ({
    key: path,
    path,
    changeType: "MODIFIED",
    additions: rows.filter((r) => r.kind === "+").length,
    deletions: rows.filter((r) => r.kind === "-").length,
  }));
}

export function shortTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()];
  return `${month} ${date.getDate()}, ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function matches(item, query) {
  return !query || JSON.stringify(item).toLowerCase().includes(query);
}

export const DEFAULT_FILTERS = { author: "any", status: "active", review: "any", checks: "any", repo: "any", project: "any" };
const STATUS_VALUES = ["active", "open", "draft", "merged", "closed", "all"];
const REVIEW_VALUES = ["any", "requested from me", "changes requested", "approved", "review required"];
const CHECK_VALUES = ["any", "failed", "running", "passed", "none"];

function byCount(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
}

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

export function cycleFilter(options, value, step) {
  const at = options.indexOf(value);
  return options[(Math.max(at, 0) + step + options.length) % options.length];
}

export function threadOf(comments, index) {
  let start = index, end = index + 1;
  while (start > 0 && comments[start].isReply) start--;
  while (end < comments.length && comments[end].isReply) end++;
  return comments.slice(start, end);
}

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

export function watchPrompt(prs) {
  const urls = prs.map((pr) => pr.url).join(" ");
  return `Watch ${prs.length > 1 ? "these PRs" : "this PR"}: ${urls}. Subscribe to ${prs.length > 1 ? "their" : "its"} activity, and when a check fails or a reviewer comments, look into it and fix what you can.`;
}

export function commentAnchor(row) {
  if (row?.kind === "-") return { side: "LEFT", line: row.number };
  if (row?.kind === "+" || row?.kind === " ") return { side: "RIGHT", line: row.number };
  return null;
}

const lineKey = (path, { side, line }) => `${path} ${side} ${line}`;

export function selectedRange(rows, anchor, focus) {
  const step = focus >= anchor ? 1 : -1;
  const isHunkEdge = (row) => !row || row.kind === "@" || row.kind === "file";
  let end = anchor;
  while (end !== focus && !isHunkEdge(rows[end + step])) end += step;
  while (!commentAnchor(rows[end])) end -= step;
  return step > 0 ? { start: anchor, end } : { start: end, end: anchor };
}

export function lineCommentRequest({ body, commitId, path, rows, range }) {
  const first = commentAnchor(rows[range.start]);
  const last = commentAnchor(rows[range.end]);
  if (!first || !last) throw new Error(`Rows ${range.start}-${range.end} of ${path} take no comment.`);
  const request = { body, commit_id: commitId, path, side: last.side, line: last.line };
  return range.start === range.end ? request : { ...request, start_side: first.side, start_line: first.line };
}

export function withThreads(rows, path, comments) {
  const threads = new Map();
  comments.forEach((comment, index) => {
    if (comment.isReply || comment.isOutdated || comment.path !== path || !comment.line) return;
    const key = lineKey(path, comment);
    threads.set(key, [...(threads.get(key) ?? []), threadOf(comments, index)]);
  });
  return rows.flatMap((row, fileRow) => {
    const anchor = commentAnchor(row);
    const here = (anchor && threads.get(lineKey(path, anchor))) ?? [];
    return [{ ...row, fileRow }, ...here.map((thread) => ({ kind: "thread", comments: thread }))];
  });
}

export function lineRange(first, last = first) {
  const one = ({ side, line }) => `${side === "LEFT" ? "−" : "+"}${line}`;
  return first.side === last.side && first.line === last.line ? one(first) : `${one(first)}–${one(last)}`;
}

export function markdownLines(text, columns) {
  let lines = 0;
  for (const line of text.trim().split("\n")) {
    if (/^\s*```/.test(line)) lines += 1.5;
    else lines += Math.max(1, Math.ceil(line.length / Math.max(10, columns))) * (/^\s*(?:[-*+]|\d+[.)])\s/.test(line) ? 1.45 : 1);
  }
  return Math.ceil(lines);
}
