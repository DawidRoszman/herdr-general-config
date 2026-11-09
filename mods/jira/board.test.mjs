import assert from "node:assert/strict";
import { toCard, columns, branchFor, matches, isShown, toDetails, inOrder, movedOrder, codeFor, codeMismatch } from "./board.js";
import { adfToMarkdown } from "./adf.js";

const issue = (key, status, category, priority = "Medium", updated = "2026-11-01T00:00:00.000+0000", type = "Story") => ({
  key, fields: { summary: `Summary ${key}`, status: { name: status, statusCategory: { key: category } }, priority: { name: priority }, issuetype: { name: type }, project: { key: "SHOP" }, updated },
});

const card = toCard(issue("SHOP-1", "In Progress", "indeterminate"));
assert.deepEqual(card, { key: "SHOP-1", summary: "Summary SHOP-1", status: "In Progress", category: "indeterminate", priority: "Medium", type: "Story", project: "SHOP", updated: "2026-11-01T00:00:00.000+0000" });

const board = columns([
  issue("SHOP-1", "In Progress", "indeterminate"),
  issue("SHOP-2", "To Do", "new", "Low"),
  issue("SHOP-3", "To Do", "new", "High"),
  issue("SHOP-4", "To Do", "new", "Low", "2026-11-05T00:00:00.000+0000"),
  issue("SHOP-5", "Code Review", "indeterminate"),
].map(toCard));
assert.deepEqual(board.map((c) => c.name), ["To Do", "Code Review", "In Progress"]);
assert.deepEqual(board[0].cards.map((c) => c.key), ["SHOP-3", "SHOP-4", "SHOP-2"]);

assert.equal(branchFor({ key: "SHOP-110", summary: "Search filters", type: "Story" }), "feat/SHOP-110-search-filters");
assert.equal(branchFor({ key: "SHOP-7", summary: "Błąd: zła data (PL)!", type: "Bug" }), "fix/SHOP-7-blad-zla-data-pl");
assert.equal(branchFor({ key: "SHOP-8", summary: "a very long summary that keeps going well past forty characters", type: "Task" }), "feat/SHOP-8-a-very-long-summary-that-keeps-going");
assert.equal(branchFor({ key: "SHOP-9", summary: "ąę", type: "Task" }), "feat/SHOP-9-ae");
assert.ok(matches(card, "shop-1") && !matches(card, "nope") && matches(card, ""));
// acli's shape: no project or updated field.
const fromAcli = toCard({ key: "SHOP-3", fields: { summary: "s", status: { name: "To Do", statusCategory: { key: "new" } }, priority: null, issuetype: { name: "Task" } } });
assert.deepEqual([fromAcli.project, fromAcli.updated, fromAcli.priority], ["SHOP", "", ""]);
assert.deepEqual(columns([fromAcli, { ...fromAcli, key: "SHOP-4" }])[0].cards.map((c) => c.key), ["SHOP-3", "SHOP-4"]);
assert.equal(isShown({ status: "QA" }, ["QA"], false), false);
assert.equal(isShown({ status: "QA" }, ["QA"], true), true);
assert.equal(isShown({ status: "To Do" }, ["QA"], false), true);
const text = (t, marks) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const para = (...content) => ({ type: "paragraph", content });
const adf = { type: "doc", content: [
  { type: "heading", attrs: { level: 2 }, content: [text("Goal")] },
  para(text("Send "), text("reminders", [{ type: "strong" }]), text(" via "), text("FCM", [{ type: "link", attrs: { href: "https://x" } }])),
  { type: "bulletList", content: [
    { type: "listItem", content: [para(text("one")), { type: "bulletList", content: [{ type: "listItem", content: [para(text("nested"))] }] }] },
    { type: "listItem", content: [para(text("two"))] },
  ] },
  { type: "orderedList", attrs: { order: 3 }, content: [{ type: "listItem", content: [para(text("third"))] }] },
  { type: "codeBlock", attrs: { language: "sql" }, content: [text("select 1;")] },
  para({ type: "mention", attrs: { text: "@Zoë" } }, { type: "hardBreak" }, { type: "status", attrs: { text: "DONE" } }),
  { type: "table", content: [
    { type: "tableRow", content: [{ type: "tableHeader", content: [para(text("A"))] }, { type: "tableHeader", content: [para(text("B"))] }] },
    { type: "tableRow", content: [{ type: "tableCell", content: [para(text("1"))] }, { type: "tableCell", content: [para(text("2"))] }] },
  ] },
  { type: "mediaSingle", content: [{ type: "media" }] },
  { type: "somethingNew", content: [para(text("kept"))] },
] };
assert.equal(adfToMarkdown(adf), [
  "## Goal",
  "Send **reminders** via [FCM](https://x)",
  "- one\n  - nested\n- two",
  "3. third",
  "```sql\nselect 1;\n```",
  "**@Zoë**  \n`DONE`",
  "| A | B |\n| --- | --- |\n| 1 | 2 |",
  "_(attachment: open in Jira)_",
  "kept",
].join("\n\n"));
assert.equal(adfToMarkdown(null), "");
assert.equal(adfToMarkdown("plain"), "plain");

const details = toDetails({ key: "SHOP-130", fields: {
  summary: "S", status: { name: "To Do" }, issuetype: { name: "Subtask" }, priority: { name: "Medium" }, assignee: null,
  reporter: { displayName: "Alice" }, labels: ["x"], description: { type: "doc", content: [para(text("d"))] },
  parent: { key: "SHOP-128", fields: { summary: "P", status: { name: "In development" } } }, subtasks: [],
  issuelinks: [{ type: { inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: "SHOP-1", fields: { summary: "L", status: { name: "Done" } } } }],
  comment: { comments: [{ id: "1", author: { displayName: "Ala" }, created: "2026-11-05T10:00:00.000+0100", body: { type: "doc", content: [para(text("c"))] } }] },
} });
assert.equal(details.assignee, "Unassigned");
assert.deepEqual(details.parent, { key: "SHOP-128", summary: "P", status: "In development" });
assert.deepEqual(details.links, [{ relation: "is blocked by", key: "SHOP-1", summary: "L", status: "Done" }]);
assert.equal(details.description, "d");
assert.deepEqual(details.comments, [{ id: "1", author: "Ala", created: "2026-11-05T10:00:00.000+0100", body: "c" }]);
console.log("board.js ok");

// Columns in the dragged order; a status new to it goes after.
assert.deepEqual(inOrder(board, ["In Progress", "To Do"]).map((c) => c.name), ["In Progress", "To Do", "Code Review"]);
assert.deepEqual(inOrder(board, []).map((c) => c.name), ["To Do", "Code Review", "In Progress"]);
const shown = ["To Do", "Code Review", "In Progress"];
assert.deepEqual(movedOrder(shown, ["Blocked"], "To Do", "In Progress"), ["Code Review", "In Progress", "To Do", "Blocked"], "right: past the target");
assert.deepEqual(movedOrder(shown, [], "In Progress", "To Do"), ["In Progress", "To Do", "Code Review"], "left: before it");

// An issue's code, and when its status disagrees with it.
const prs = [{ branch: "feat/SHOP-110-search", state: "OPEN", isDraft: false }, { branch: "fix/SHOP-11", state: "MERGED", isDraft: false }];
assert.deepEqual(codeFor("SHOP-11", prs, ["feat/SHOP-110-search"]), { prs: [prs[1]], hasBranch: false });
assert.equal(codeFor("SHOP-110", prs, ["feat/SHOP-110-search"]).hasBranch, true);
const code = (hasBranch, ...states) => ({ hasBranch, prs: states.map((s) => ({ state: s.replace("DRAFT", "OPEN"), isDraft: s === "DRAFT" })) });
assert.equal(codeMismatch("todo", code(false)), "");
assert.equal(codeMismatch("todo", code(true)), "work has started in code");
assert.equal(codeMismatch("progress", code(true, "DRAFT")), "");
assert.equal(codeMismatch("progress", code(true, "OPEN")), "a PR is open for review");
assert.equal(codeMismatch("progress", code(true, "MERGED")), "its PRs are merged");
assert.equal(codeMismatch("review", code(true, "OPEN", "MERGED")), "");
assert.equal(codeMismatch("review", code(true)), "no open PR");
assert.equal(codeMismatch("review", code(true, "DRAFT")), "its PR is a draft");
assert.equal(codeMismatch("review", code(false, "MERGED", "MERGED")), "its PRs are merged");
assert.equal(codeMismatch("testing", code(false, "MERGED")), "");
assert.equal(codeMismatch("testing", code(false, "OPEN")), "a PR is still open");
assert.equal(codeMismatch(undefined, code(true, "OPEN")), "", "a status with no stage is never checked");
