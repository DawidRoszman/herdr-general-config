// Pure helpers for the Jira board. Checked by `node board.test.mjs`.

import { adfToMarkdown } from "./adf.js";

export const JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
// acli refuses project and updated: the project comes from the key, the order from the JQL.
export const FIELDS = ["key", "summary", "status", "priority", "issuetype"];
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

// What the details panel asks acli for, and the issue shaped for it.
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

export function matches(card, query) {
  return !query || [card.key, card.summary, card.type, card.priority].join(" ").toLowerCase().includes(query);
}
