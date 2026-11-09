import assert from "node:assert/strict";
import {
  remoteCommand, prState, shortBranch, reviewTab, isCoveredByProject, machineLabel, groupByBranch, checksSummary, reviewSummary, commentCount, prChanges, stackNeighbor, mergedWith, reviewKey, projectSpace, spaceAt, preferredCopy, parsePlace, worktreeOf,
  parseDiff, stackDiffs, requestedLogins, reviewerChoices, reviewerChanges, reviewVerdicts, canReRequest, optimisticPr, shortTime, overviewItems, DEFAULT_FILTERS, filterOptions, matchesFilters, cycleFilter, sectionOf, sectionRows, groupTitle, prStateIcon, checksIcon, age, checksStatus, reviewStatus, mergeStatus, prActions, checkState, isSettling, hasSameHeads, checkItems, checkMark, commitItems, diffFiles,
} from "./model.js";

const pr = (over = {}) => ({
  slug: "o/backend", repo: "acme-shop-backend", short: "backend", number: 107, title: "T", branch: "feat/SHOP-110-x",
  state: "OPEN", isDraft: false, author: "bob", updatedAt: "2026-11-07T07:00:00Z", reviewDecision: "REVIEW_REQUIRED",
  isReviewRequestedFromMe: false, reviews: [], checks: "PENDING", checkCounts: { passed: 1, failed: 0, pending: 1 },
  comments: 0, inlineComments: 0, ...over,
});

assert.equal(remoteCommand(["pr-act", "o/r", 5, "comment", "--body", "it's"]), `python3 - 'pr-act' 'o/r' '5' 'comment' '--body' 'it'\\''s'`);
assert.equal(prState(pr({ isDraft: true })), "draft");
assert.equal(prState(pr({ state: "MERGED" })), "merged");
assert.equal(shortBranch("feat/SHOP-110-search-filters"), "SHOP-110");
assert.equal(shortBranch("chore/bump-deps"), "bump-deps");
assert.deepEqual(reviewTab("devbox", "/p", "feat/SHOP-1-x"), { name: "PR SHOP-1", mod: "prs", props: { view: "review", machine: "devbox", project: "/p", branch: "feat/SHOP-1-x" } });
assert.deepEqual(reviewTab("buildbox", "/r", "fix/x", true).props, { view: "review", machine: "buildbox", project: "/r", branch: "fix/x", isRepo: true });
assert.ok(isCoveredByProject("/home/u/git/Shop/backend", ["/home/u/git/Shop"]));
assert.ok(isCoveredByProject("/home/u/.herdr/projects/Shop/feat-x/backend", []));
assert.ok(!isCoveredByProject("/home/u/git/ShopOther", ["/home/u/git/Shop"]));
assert.equal(machineLabel(null), "this Mac");
assert.equal(reviewKey(null, "/p", "feat/x"), "|/p|x");
// A PR's review opens in its project's space: on its branch first, then the project's root, never another machine's.
const placeSpaces = [
  { id: "shop", machine: "devbox", folder: "/home/u/git/Shop", branch: "develop" },
  { id: "webapp", machine: "buildbox", folder: "/home/u/webapp", branch: "develop" },
  { id: "webapp-wt", machine: "buildbox", folder: "/home/u/.herdr/worktrees/webapp/feat-x", branch: "feat/x" },
  { id: "task", machine: "devbox", folder: "/home/u/.herdr/projects/Shop/feat-SHOP-1", branch: "feat/SHOP-1" },
  { id: "elsewhere", machine: "buildbox", folder: "/home/u/git/Shop", branch: "feat/SHOP-1" },
];
assert.equal(projectSpace(placeSpaces, { machine: "buildbox", root: "/home/u/webapp", name: "webapp", branch: "main" }).id, "webapp");
assert.equal(projectSpace(placeSpaces, { machine: "buildbox", root: "/home/u/webapp", name: "webapp", branch: "feat/x" }).id, "webapp-wt");
assert.equal(projectSpace(placeSpaces, { machine: "devbox", root: "/home/u/git/Shop", name: "Shop", branch: "feat/SHOP-1" }).id, "task");
assert.equal(projectSpace(placeSpaces, { machine: null, root: "/Users/me/x", name: "x", branch: "b" }), null);
// A plain repo's worktree can be anywhere (beside the repo, here): git's list says where, and its space wins.
const porcelain = "worktree /h/webapp/webapp\nHEAD 1\nbranch refs/heads/develop\n\nworktree /h/webapp/webapp.dep\nHEAD 2\nbranch refs/heads/dependabot/x\n";
assert.equal(worktreeOf(porcelain, "dependabot/x"), "/h/webapp/webapp.dep");
assert.equal(worktreeOf(porcelain, "nope"), null);
assert.equal(worktreeOf("worktree /t3/old\nHEAD abc\nbranch refs/heads/feat/z\nprunable gitdir file points to non-existent location", "feat/z"), null);
assert.equal(spaceAt([{ id: "a", machine: null, folder: "/x/repo.wt" }, { id: "b", machine: "box", folder: "/x/repo.wt/sub" }], "box", "/x/repo.wt").id, "b");
assert.equal(spaceAt([{ id: "a", machine: null, folder: "/x/repo.wt-other" }], null, "/x/repo.wt"), null);
const besides = [{ id: "main", machine: "buildbox", folder: "/h/webapp/webapp", branch: "develop" }, { id: "dep", machine: "buildbox", folder: "/h/webapp/webapp.dep", branch: null }];
assert.equal(projectSpace(besides, { machine: "buildbox", root: "/h/webapp/webapp", name: "webapp", branch: "dependabot/x", checkout: "/h/webapp/webapp.dep" }).id, "dep");
assert.equal(projectSpace(besides, { machine: "buildbox", root: "/h/webapp/webapp", name: "webapp", branch: "develop", checkout: "/h/webapp/webapp" }).id, "main");
// A project on two machines: its PR's copy comes from where you work on it.
const copies = [
  { machine: "devbox", root: "/home/u/git/Shop", project: "Shop", branch: "feat/SHOP-1" },
  { machine: null, root: "/Users/me/Shop", project: "Shop", branch: "feat/SHOP-1" },
];
const onMac = [{ machine: null, folder: "/Users/me/.herdr/projects/Shop/feat-SHOP-1", branch: null }];
assert.equal(preferredCopy(copies, onMac, "devbox").machine, null, "a space on the branch wins over focus");
assert.equal(preferredCopy(copies, [{ machine: null, folder: "/Users/me/Shop", branch: "develop" }], "devbox").machine, "devbox", "else the focused machine");
assert.equal(preferredCopy(copies, [], "elsewhere").machine, "devbox", "else the first by name");
// The focused space's place, as here.js reads it.
assert.deepEqual(parsePlace('task\n{"project": "/h/git/Shop", "branch": "feat/SHOP-1"}\n'), { root: "/h/git/Shop", branch: "feat/SHOP-1", isRepo: false, name: "Shop" });
assert.deepEqual(parsePlace("repo\n/h/webapp\nfeat/x\n"), { root: "/h/webapp", branch: "feat/x", isRepo: true, name: "webapp" });
assert.equal(parsePlace(""), null);
// Task spaces have no branch (their folder isn't a repo): the task folder named after the branch decides.
const taskSpaces = [
  { id: "shop-110", machine: "devbox", folder: "/home/u/.herdr/projects/Shop/feat-SHOP-110-calendar", branch: null },
  { id: "shop-135", machine: "devbox", folder: "/home/u/.herdr/projects/Shop/feat-SHOP-135-contact", branch: null },
];
assert.equal(projectSpace(taskSpaces, { machine: "devbox", root: "/home/u/git/Shop", name: "Shop", branch: "feat/SHOP-135-contact" }).id, "shop-135");
assert.equal(projectSpace(taskSpaces, { machine: "devbox", root: "/home/u/git/Shop", name: "Shop", branch: "feat/SHOP-110-calendar" }).id, "shop-110");
// A branch with no space of its own: the project's space (by name when it has no folder), never another task's.
assert.equal(projectSpace(taskSpaces, { machine: "devbox", root: "/home/u/git/Shop", name: "Shop", branch: "feat/SHOP-999" }), null);
assert.equal(projectSpace([...taskSpaces, { id: "project", machine: "devbox", name: "Shop", folder: "" }], { machine: "devbox", root: "/home/u/git/Shop", name: "Shop", branch: "feat/SHOP-999" }).id, "project");
assert.notEqual(reviewKey("devbox", "/p", "feat/x"), reviewKey(null, "/p", "feat/x"));

// Grouping: the branch with a review request from me first, merged work last.
const portal = pr({ slug: "o/portal", short: "portal", number: 79, isReviewRequestedFromMe: true });
const groups = groupByBranch([{ machine: "m", project: "P", root: "/p", prs: [
  pr({ number: 90, branch: "feat/SHOP-9-old", state: "MERGED", updatedAt: "2026-11-07T09:00:00Z" }),
  portal, pr(), pr({ number: 91, branch: "feat/SHOP-2-y", updatedAt: "2026-11-06T00:00:00Z" }),
] }]);
assert.deepEqual(groups.map((g) => g.branch), ["feat/SHOP-110-x", "feat/SHOP-2-y", "feat/SHOP-9-old"]);
assert.deepEqual(groups[0].prs.map((p) => p.short), ["backend", "portal"]);
// feat/X and test/X are one topic: one group, its main branch the most used, and one review tab key.
const topic = groupByBranch([{ machine: "m", project: "P", root: "/p", prs: [
  pr({ slug: "o/e2e", short: "e2e-tests", number: 24, branch: "test/SHOP-110-x" }), pr(), portal,
] }]);
assert.equal(topic.length, 1);
assert.equal(topic[0].branch, "feat/SHOP-110-x");
assert.deepEqual(topic[0].branches, ["feat/SHOP-110-x", "test/SHOP-110-x"]);
assert.equal(reviewKey("m", "/p", "test/SHOP-110-x"), reviewKey("m", "/p", "feat/SHOP-110-x"));
assert.deepEqual(reviewTab("m", "/p", "feat/SHOP-110-x", false, topic[0].branches).props.branches, ["feat/SHOP-110-x", "test/SHOP-110-x"]);
// A stack's branches stay together, bottom first, at the stack's latest update.
const stackedGroups = groupByBranch([{ machine: "m", project: "P", root: "/p", prs: [
  pr({ number: 3, branch: "top", updatedAt: "2026-11-01T00:00:00Z", stack: { number: 5, size: 2, position: 2 } }),
  pr({ number: 4, branch: "loose", updatedAt: "2026-11-03T00:00:00Z" }),
  pr({ number: 2, branch: "bottom", updatedAt: "2026-11-05T00:00:00Z", stack: { number: 5, size: 2, position: 1 } }),
] }]);
assert.deepEqual(stackedGroups.map((g) => g.branch), ["bottom", "top", "loose"]);
assert.deepEqual(sectionRows(stackedGroups, new Set(), () => "").filter((r) => r.kind === "group").map((r) => r.group.branch), ["bottom", "top", "loose"]);

assert.deepEqual(checksSummary([pr(), portal]), { state: "pending", passed: 2, failed: 0, pending: 2 });
assert.equal(checksSummary([pr({ checkCounts: { passed: 3, failed: 1, pending: 0 } })]).state, "failed");
assert.equal(checksSummary([pr({ checkCounts: undefined })]).state, "none");
assert.equal(reviewSummary([pr(), portal]), "review requested from you");
assert.equal(reviewSummary([pr({ reviewDecision: "APPROVED" })]), "approved");
assert.equal(reviewSummary([pr({ state: "MERGED" })]), "merged");
assert.equal(commentCount([pr({ comments: 2, inlineComments: 3 }), pr({ comments: 1 })]), 6);

// Changes between refreshes become notifications; the first refresh is only a baseline.
assert.deepEqual(prChanges(null, [pr()]), []);
const titles = (before, after) => prChanges(before, after).map((c) => c.title);
assert.deepEqual(titles([pr()], [pr({ checks: "SUCCESS" })]), ["Checks passed on backend #107"]);
assert.deepEqual(titles([pr()], [pr({ checks: "PENDING" })]), []);
assert.deepEqual(titles([pr({ isDraft: true })], [pr()]), ["backend #107 is ready for review"]);
assert.deepEqual(titles([pr()], [pr({ state: "MERGED" })]), ["backend #107 is merged"]);
assert.deepEqual(titles([pr()], [pr({ reviews: [{ author: "bob", state: "APPROVED" }] })]), ["bob approved backend #107"]);
assert.deepEqual(titles([pr({ comments: 1 })], [pr({ comments: 2, inlineComments: 1 })]), ["2 new comments on backend #107"]);
assert.deepEqual(titles([pr()], [pr({ isReviewRequestedFromMe: true })]), ["Review requested: backend #107"]);
assert.deepEqual(titles([], [pr()]), ["New PR: backend #107 by bob"]);
assert.deepEqual(titles([], [pr({ state: "CLOSED" })]), []);

const diff = parseDiff([
  "diff --git a/src/A.java b/src/A.java", "index 1..2 100644", "--- a/src/A.java", "+++ b/src/A.java",
  "@@ -10,3 +10,4 @@ class A", " keep", "-old", "+new", "+more", "\\ No newline at end of file",
  "diff --git a/img.png b/img.png", "Binary files a/img.png and b/img.png differ", "",
].join("\n"));
assert.deepEqual([...diff.keys()], ["src/A.java", "img.png"]);
assert.deepEqual(diff.get("src/A.java").map((r) => [r.kind, r.number]), [["@", undefined], [" ", 10], ["-", 11], ["+", 11], ["+", 12], ["", undefined]]);
assert.equal(diff.get("img.png")[0].text, "Binary file changed");
assert.deepEqual(diffFiles(diff).map((f) => [f.path, f.additions, f.deletions]), [["src/A.java", 2, 1], ["img.png", 0, 0]]);

const full = {
  url: "https://github.com/o/backend/pull/107", author: { login: "bob" }, body: "", createdAt: "2026-11-05T00:00:00Z",
  latestReviews: [], reviewRequests: [],
  comments: [{ author: { login: "a" }, body: "late", createdAt: "2026-11-06T10:00:00Z", url: "u1" }],
  reviews: [{ id: "R1", author: { login: "me" }, body: "found one", state: "COMMENTED", submittedAt: "2026-11-05T17:00:00Z" }, { id: "R2", author: { login: "me" }, body: "", state: "COMMENTED", submittedAt: "2026-11-05T17:00:01Z" }],
  inlineComments: [{ author: "me", body: "here", createdAt: "2026-11-05T17:00:00Z", url: "u2", path: "A.java", line: 4, isReply: false }],
  statusCheckRollup: [
    { __typename: "CheckRun", name: "lint", workflowName: "ci", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "d" },
    { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: "", detailsUrl: "d2" },
    { __typename: "StatusContext", context: "deploy", state: "FAILURE", targetUrl: "t" },
  ],
  commits: [{ oid: "79dd210bf0801107", messageHeadline: "feat: x", authors: [{ login: "bob" }], committedDate: "2026-11-05T15:45:31Z" }],
};
assert.deepEqual(overviewItems(full).map((i) => i.kind), ["description", "reviews", "review", "inline", "comment"]);
assert.equal(overviewItems(full)[0].body, "_No description._");
assert.deepEqual(checkItems(full).map((c) => [c.name, c.outcome, checkMark(c.outcome)]), [["lint", "SUCCESS", "✓"], ["e2e", "IN_PROGRESS", "●"], ["deploy", "FAILURE", "✗"]]);
assert.deepEqual(commitItems(full)[0], { key: "79dd210bf0801107", oid: "79dd210", headline: "feat: x", author: "bob", at: "2026-11-05T15:45:31Z" });
assert.match(shortTime("2026-11-05T15:45:31Z"), /^Nov 5, \d\d:45$/);
const mine = pr({ author: "me", viewer: "me", project: "P" });
const theirs = pr({ author: "bob", viewer: "me", project: "P", number: 2, short: "portal", reviewDecision: "APPROVED", checkCounts: { passed: 0, failed: 1, pending: 0 } });
const merged = pr({ author: "bob", viewer: "me", project: "Q", number: 3, state: "MERGED" });
const opts = filterOptions([mine, theirs, merged]);
assert.deepEqual(opts.author, ["any", "me", "bob"]);
assert.deepEqual(opts.repo, ["any", "backend", "portal"]);
assert.deepEqual(opts.project, ["any", "P", "Q"]);
assert.equal(filterOptions([mine]).project, undefined);
const only = (over) => [mine, theirs, merged].filter((p) => matchesFilters(p, { ...DEFAULT_FILTERS, ...over })).map((p) => p.number);
assert.deepEqual(only({}), [107, 2]);
assert.deepEqual(only({ status: "all" }), [107, 2, 3]);
assert.deepEqual(only({ status: "merged" }), [3]);
assert.deepEqual(only({ author: "me" }), [107]);
assert.deepEqual(only({ author: "bob", status: "all" }), [2, 3]);
assert.deepEqual(only({ review: "approved" }), [2]);
assert.deepEqual(only({ checks: "failed" }), [2]);
assert.deepEqual(only({ checks: "running" }), [107]);
assert.deepEqual(only({ repo: "portal" }), [2]);
assert.deepEqual(only({ project: "Q", status: "all" }), [3]);
assert.equal(cycleFilter(["any", "a", "b"], "b", 1), "any");
assert.equal(cycleFilter(["any", "a", "b"], "any", -1), "b");
assert.equal(cycleFilter(["any", "a", "b"], "gone", 1), "a");
// Sidebar sections.
const g = (over) => ({ key: over.key ?? "k", machine: "m", root: "/p", project: "P", branch: "b", isOpen: true, isReviewRequestedFromMe: false, updatedAt: "2026-11-07T00:00:00Z", prs: [pr({ viewer: "me", author: "bob" })], ...over });
assert.equal(sectionOf(g({ isReviewRequestedFromMe: true })), "review");
assert.equal(sectionOf(g({ prs: [pr({ viewer: "me", author: "me" })] })), "mine");
assert.equal(sectionOf(g({ prs: [pr({ viewer: "me", author: "app/dependabot" })] })), "bots");
assert.equal(sectionOf(g({})), "others");
assert.equal(sectionOf(g({ isOpen: false })), "closed");
const sec = sectionRows([
  g({ key: "a", isReviewRequestedFromMe: true }),
  g({ key: "b", root: "/q", project: "Q", isReviewRequestedFromMe: true }),
  g({ key: "c", prs: [pr({ viewer: "me", author: "app/dependabot" })] }),
], new Set(), (x) => `${x.project} · ${x.machine}`);
assert.deepEqual(sec.map((r) => r.kind === "group" ? r.id : r.kind === "place" ? r.label : `${r.section.id}${r.isFolded ? "+" : ""}`),
  ["review", "P · m", "a", "Q · m", "b", "bots+"]);
assert.deepEqual(sectionRows([g({ key: "c", prs: [pr({ author: "app/dependabot", viewer: "me" })] })], new Set(["bots"]), () => "").map((r) => r.kind), ["section", "group"]);
assert.equal(groupTitle({ branch: "b", prs: [pr({ title: "A" }), pr({ title: "B" }), pr({ title: "B" })] }), "B");
assert.deepEqual(prStateIcon(pr({ isDraft: true })), { icon: "pull-request-draft", color: "dim" });
assert.equal(checksIcon("failed").icon, "x-circle");
assert.equal(checksIcon("none"), null);
assert.equal(age("2026-11-07T00:00:00Z", Date.parse("2026-11-07T05:00:00Z")), "5h");
// Review status strip.
const reviewed = { ...full, state: "OPEN", isDraft: false, author: { login: "bob" }, reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED",
  reviewRequests: [{ login: "me" }], latestReviews: [{ author: { login: "carol" }, state: "APPROVED" }] };
assert.deepEqual(checksStatus(reviewed), { icon: "x-circle", color: "blocked", text: "1 of 3 checks failing" });
assert.equal(checksStatus({ statusCheckRollup: [] }).text, "No checks");
assert.equal(reviewStatus(reviewed, "me").text, "Your review is requested");
assert.equal(reviewStatus({ ...reviewed, reviewRequests: [], reviewDecision: "APPROVED" }, "me").text, "Approved by carol");
assert.equal(mergeStatus(reviewed).text, "Blocked: review required");
assert.equal(mergeStatus({ ...reviewed, mergeStateStatus: "DIRTY" }).text, "Conflicts with its base");
assert.equal(mergeStatus({ ...reviewed, state: "MERGED" }).text, "Merged");
assert.equal(mergeStatus({ ...reviewed, mergeStateStatus: "UNKNOWN" }).color, "dim");
const running = { ...reviewed, reviewDecision: "APPROVED", statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: "" }] };
assert.equal(mergeStatus({ ...running, mergeStateStatus: "UNSTABLE" }).text, "Mergeable once checks finish");
assert.equal(mergeStatus(running).text, "Blocked: checks running");
assert.equal(isSettling(running), true);
assert.equal(isSettling({ ...running, state: "MERGED" }), false);
assert.equal(isSettling({ ...reviewed, statusCheckRollup: [], mergeStateStatus: "CLEAN" }), false);
assert.equal(isSettling({ ...reviewed, statusCheckRollup: [], mergeStateStatus: "UNKNOWN" }), true);
const headed = (oid) => [{ ...reviewed, commits: [{ oid: "a" }, { oid }] }];
assert.equal(hasSameHeads(headed("b"), headed("b")), true);
assert.equal(hasSameHeads(headed("b"), headed("c")), false);
assert.deepEqual(prActions(reviewed, "me"), { canReview: true, hasApproved: false, canComment: true, canMerge: true, canToggleDraft: false, isPrimaryApprove: true, isPrimaryMerge: false });
assert.equal(prActions(reviewed, "carol").hasApproved, true);
assert.equal(prActions({ ...reviewed, reviewRequests: [{ login: "carol" }] }, "carol").hasApproved, false); // asked again
assert.equal(prActions(reviewed, "bob").canToggleDraft, true);
assert.equal(prActions(reviewed, "bob").canReview, false);
assert.equal(prActions({ ...reviewed, state: "MERGED" }, "me").canMerge, false);
assert.equal(checkState(reviewed), "failed");
assert.equal(checkState({ statusCheckRollup: [] }), "none");
const stacked = stackDiffs([{ path: "a.js", additions: 1, deletions: 0 }, { path: "b.js", additions: 0, deletions: 0 }],
  (file) => (file.path === "a.js" ? [{ kind: "+", text: "x" }] : []));
assert.deepEqual(stacked.fileStarts, [0, 2]);
assert.deepEqual(stacked.rows.map((r) => [r.kind, r.text, r.fileIndex, r.key]), [["file", "a.js", 0, "0"], ["+", "x", 0, "1"], ["file", "b.js", 1, "2"]]);

const askedPr = { author: { login: "me" }, reviewRequests: [{ login: "bob" }, { name: "core-team" }] };
assert.deepEqual(requestedLogins(askedPr), ["bob"]);
assert.deepEqual(reviewerChoices(["alice", "bob", "me"], askedPr), ["bob", "alice"]);
const reviewedPr = { state: "OPEN", author: { login: "me" }, reviewRequests: [{ login: "bob" }],
  latestReviews: [{ author: { login: "carol" }, state: "CHANGES_REQUESTED" }, { author: { login: "me" }, state: "COMMENTED" }, { author: { login: "gone" }, state: "APPROVED" }] };
assert.deepEqual(reviewerChoices(["alice", "bob", "carol", "me"], reviewedPr), ["bob", "carol", "gone", "alice"], "past reviewers after the requested, even ones no longer listed");
assert.deepEqual(reviewVerdicts(reviewedPr), { carol: "changes requested", gone: "approved" });
assert.ok(canReRequest(reviewedPr, "carol", "dave"));
assert.ok(!canReRequest(reviewedPr, "bob", "dave"), "already asked");
assert.ok(!canReRequest(reviewedPr, "carol", "carol"), "not yourself");
assert.ok(!canReRequest({ ...reviewedPr, state: "MERGED" }, "carol", "dave"));
assert.deepEqual(reviewerChanges(["bob"], new Set(["alice"])), { add: ["alice"], remove: ["bob"] });

const before = { url: "u", state: "OPEN", isDraft: true, comments: [], reviews: [], latestReviews: [{ author: { login: "me" }, state: "COMMENTED" }], reviewRequests: [{ login: "me" }, { name: "core" }] };
const approved = optimisticPr(before, { action: "approve", body: "lgtm" }, "me", "T");
assert.deepEqual(approved.latestReviews, [{ author: { login: "me" }, state: "APPROVED" }]);
assert.deepEqual(approved.reviews.map((r) => [r.state, r.body, r.submittedAt]), [["APPROVED", "lgtm", "T"]]);
assert.deepEqual(approved.reviewRequests, [{ name: "core" }]);
assert.equal(optimisticPr(before, { action: "comment", body: "hi" }, "me", "T").comments[0].body, "hi");
assert.equal(optimisticPr(before, { action: "merge" }, "me").state, "MERGED");
assert.equal(optimisticPr(before, { action: "ready" }, "me").isDraft, false);
assert.deepEqual(optimisticPr(before, { reviewers: ["bob"] }, "me").reviewRequests, [{ name: "core" }, { login: "bob" }]);
assert.equal(before.state, "OPEN", "the PR given is left as it was");

// Stacks: neighbors, and what a merge takes with it.
const entry = (position, state = "OPEN") => ({ position, number: 10 + position, state, headRefName: `b${position}` });
const middle = { state: "OPEN", stack: { number: 1, size: 4, position: 3, entries: [entry(1, "MERGED"), entry(2), entry(3), entry(4)] } };
assert.equal(stackNeighbor(middle, -1).headRefName, "b2");
assert.equal(stackNeighbor(middle, 1).headRefName, "b4");
assert.equal(stackNeighbor({ ...middle, stack: { ...middle.stack, position: 4 } }, 1), undefined);
assert.equal(stackNeighbor({}, 1), undefined);
assert.deepEqual(mergedWith(middle).map((e) => e.number), [12]);
assert.deepEqual(mergedWith({}), []);
const stackMerged = optimisticPr(middle, { action: "merge-stack" }, "me");
assert.deepEqual([stackMerged.state, ...stackMerged.stack.entries.map((e) => e.state)], ["MERGED", "MERGED", "MERGED", "MERGED", "OPEN"]);

console.log("model.js ok");
