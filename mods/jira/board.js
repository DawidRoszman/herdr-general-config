// Pure helpers for the Jira board. Checked by `node board.test.mjs`.

import { adfToMarkdown } from "./adf.js";

export const JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
export const FIELDS = ["summary", "status", "priority", "issuetype", "project", "updated"];
const CATEGORY_ORDER = { new: 0, indeterminate: 1, done: 2 };
const PRIORITY_ORDER = { Highest: 0, High: 1, Medium: 2, Low: 3, Lowest: 4 };

// Jira's issue JSON, flattened to what a card shows.
export function toCard(issue) {
  const f = issue.fields;
  return {
    key: issue.key,
    summary: f.summary,
    status: f.status.name,
    category: f.status.statusCategory?.key ?? "indeterminate",
    priority: f.priority?.name ?? "",
    type: f.issuetype?.name ?? "",
    project: f.project?.key ?? issue.key.split("-")[0],
    updated: f.updated ?? "",
  };
}

// One column per status: to do first, then in progress; cards by priority, then most recently updated.
export function columns(cards) {
  const byStatus = new Map();
  for (const card of cards) {
    if (!byStatus.has(card.status)) byStatus.set(card.status, { name: card.status, category: card.category, cards: [] });
    byStatus.get(card.status).cards.push(card);
  }
  const rank = (priority) => PRIORITY_ORDER[priority] ?? 2;
  return [...byStatus.values()]
    .sort((a, b) => (CATEGORY_ORDER[a.category] ?? 1) - (CATEGORY_ORDER[b.category] ?? 1) || a.name.localeCompare(b.name))
    .map((column) => ({ ...column, cards: column.cards.sort((a, b) => rank(a.priority) - rank(b.priority) || b.updated.localeCompare(a.updated)) }));
}

// The columns in the order the person dragged them into (status names); a status not in it yet
// goes after them, where columns() put it.
export function inOrder(board, order) {
  const at = (name) => (order.includes(name) ? order.indexOf(name) : order.length);
  return [...board].sort((a, b) => at(a.name) - at(b.name));
}

// The order once `from` is dropped on `to`, among the shown columns: past it going right, before it
// going left, as a tab lands. Statuses not shown now keep their place after them.
export function movedOrder(shown, order, from, to) {
  const names = shown.filter((name) => name !== from);
  names.splice(names.indexOf(to) + (shown.indexOf(from) < shown.indexOf(to) ? 1 : 0), 0, from);
  return [...names, ...order.filter((name) => !shown.includes(name))];
}

// SHOP-110 "Search filters" -> feat/SHOP-110-search-filters (fix/ for bugs), as mr titles PRs from it.
export function branchFor(card) {
  const ascii = card.summary.replace(/[łŁ]/g, "l").normalize("NFD").replace(/[̀-ͯ]/g, "");
  const words = ascii.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 40) break;
    slug = next;
  }
  const kind = /bug/i.test(card.type) ? "fix" : "feat";
  return `${kind}/${card.key}${slug ? `-${slug}` : ""}`;
}

// Statuses listed in config.json "hiddenStatuses" (work waiting on others) stay off the board unless asked for.
export function isShown(card, hiddenStatuses, isShowingHidden) {
  return isShowingHidden || !hiddenStatuses.includes(card.status);
}

// "21:07": a time's local hours and minutes. The app's JS engine ignores toLocaleTimeString's
// options (it gives "09:07:31 PM"), so it is built by hand.
export function clock(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// What the details panel asks Jira for, and the issue shaped for it.
export const DETAIL_FIELDS = ["summary", "status", "assignee", "reporter", "priority", "issuetype", "parent", "labels", "description", "comment", "subtasks", "issuelinks", "created", "updated"];

const person = (user) => user?.displayName ?? "Unassigned";
const ref = (issue) => ({ key: issue.key, summary: issue.fields?.summary ?? "", status: issue.fields?.status?.name ?? "" });

export function toDetails(issue) {
  const f = issue.fields;
  return {
    key: issue.key,
    summary: f.summary,
    status: f.status?.name ?? "",
    type: f.issuetype?.name ?? "",
    priority: f.priority?.name ?? "",
    assignee: person(f.assignee),
    reporter: person(f.reporter),
    created: f.created ?? "",
    updated: f.updated ?? "",
    labels: f.labels ?? [],
    parent: f.parent ? ref(f.parent) : null,
    subtasks: (f.subtasks ?? []).map(ref),
    links: (f.issuelinks ?? []).map((link) => {
      const other = link.outwardIssue ?? link.inwardIssue;
      return { relation: link.outwardIssue ? link.type?.outward : link.type?.inward, ...ref(other) };
    }),
    description: adfToMarkdown(f.description),
    comments: (f.comment?.comments ?? []).map((c) => ({ id: c.id, author: person(c.author), created: c.created, body: adfToMarkdown(c.body) })),
  };
}

// A branch named after an issue: feat/SHOP-110-search-filters is SHOP-110's, not SHOP-11's.
export const keyPattern = (key) => new RegExp(`(^|[^A-Za-z0-9])${key}(?![0-9])`, "i");

// The coordinator's board.json tasks by issue key. A missing, unreadable or other-shaped file has
// none: the board is a hint on the cards, never an error on them.
export function boardTasks(text) {
  let tasks;
  try {
    tasks = JSON.parse(text ?? "")?.tasks;
  } catch {
    return new Map();
  }
  return new Map((Array.isArray(tasks) ? tasks : []).filter((task) => typeof task?.key === "string" && task.key).map((task) => [task.key, task]));
}

// Where an issue's task runs: a space on a branch named after it, else the coordinator board's
// task's space (its folder on its machine), else that task's agent. Null when it has no task.
export function taskTarget(key, task, spaces) {
  const pattern = keyPattern(key);
  const isOnTaskMachine = (space) => (space.machine ?? null) === (task?.machine ?? null);
  const space = spaces.find((s) => s.branch && pattern.test(s.branch))
    ?? (task?.folder ? spaces.find((s) => s.folder === task.folder && isOnTaskMachine(s)) : undefined);
  if (space) return { space: space.id };
  if (task?.agent) return { agent: task.machine && !task.agent.includes("/") ? `${task.machine}/${task.agent}` : task.agent };
  return null;
}

// Where the code is for an issue: the PRs and multirepo task branches named after its key.
export function codeFor(key, prs, branches) {
  const pattern = keyPattern(key);
  return { prs: prs.filter((pr) => pattern.test(pr.branch)), hasBranch: branches.some((branch) => pattern.test(branch)) };
}

// Why an issue's Jira status disagrees with its code, or "". stage is what config.json
// "statusStages" calls the status: todo, progress, review or testing.
// prs: { state: OPEN | MERGED | CLOSED, isDraft }, as `mr prs` lists them (merged ones for 3 days).
export function codeMismatch(stage, code) {
  const open = code.prs.filter((pr) => pr.state === "OPEN");
  const isInReview = open.some((pr) => !pr.isDraft);
  const isAllMerged = code.prs.length > 0 && !open.length && code.prs.some((pr) => pr.state === "MERGED");
  if (stage === "todo" && (code.hasBranch || code.prs.length)) return "work has started in code";
  if (stage === "progress" && isInReview) return "a PR is open for review";
  if ((stage === "progress" || stage === "review") && isAllMerged) return "its PRs are merged";
  if (stage === "review" && !isInReview) return open.length ? "its PR is a draft" : "no open PR";
  if (stage === "testing" && open.length) return "a PR is still open";
  return "";
}

export function matches(card, query) {
  return !query || [card.key, card.summary, card.type, card.priority].join(" ").toLowerCase().includes(query);
}
