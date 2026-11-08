import assert from "node:assert/strict";
import { describe, keyRows, filterRows } from "./rows.js";

assert.equal(describe("mod.open:multirepo"), "Open Multirepo dialog");
assert.equal(describe("tab.select:3"), "tab select 3");
assert.equal(describe("send:\u001bb"), 'type "\\u001bb"');
assert.equal(describe('{"command":"tab.new","args":{"name":"Jira","mod":"jira"}}'), "Open Jira in a new tab");
assert.equal(describe({ command: "pane.split", args: { direction: "right", mod: "blueprint" } }), "Open blueprint beside the focused pane");

const rows = keyRows(
  [{ section: "global", keys: "cmd-shift-j", action: "mod.open:x" }, { section: "terminal", keys: "cmd-c", action: "terminal.copy" }],
  [{ title: "Jira board", sections: [{ title: "Board", rows: [["s", "start work"], ["r", "refresh"]] }] }],
);
assert.deepEqual(rows.map((r) => r.kind === "key" ? r.keys : `${r.kind}:${r.text}`),
  ["group:Shortcuts (keys.json)", "section:Everywhere", "cmd-shift-j", "section:In a terminal", "cmd-c", "group:Jira board", "section:Board", "s", "r"]);
assert.deepEqual(filterRows(rows, "start").map((r) => r.text ?? r.keys), ["Jira board", "Board", "s"]);
assert.deepEqual(filterRows(rows, "jira").filter((r) => r.kind === "key").map((r) => r.keys), ["s", "r"]);
assert.equal(filterRows(rows, "").length, rows.length);
console.log("rows.js ok");
