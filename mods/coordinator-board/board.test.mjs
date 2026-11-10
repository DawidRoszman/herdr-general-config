import assert from "node:assert/strict";
import { boardContext, parseBoard, age, clock, agentAddress, checkItem, uncheckItem, buildView, taskSpace, prGroups } from "./board.js";

const coordinators = { work: "s-work", personal: "s-personal" };
assert.equal(boardContext({ spaceId: "s-personal", coordinators, current: "work" }), "personal");
assert.equal(boardContext({ spaceId: "s-other", coordinators, current: "work" }), "work");
assert.equal(boardContext({ spaceId: "s-other", coordinators: undefined, current: undefined }), null);

assert.equal(parseBoard(null).error, "board.json is missing");
assert.match(parseBoard("{ nope").error, /not valid JSON/);
assert.match(parseBoard("[]").error, /not an object/);
assert.match(parseBoard('{"tasks": {}}').error, /"tasks" is not a list/);
assert.deepEqual(parseBoard("{}").board, { updated: null, needsYou: [], checked: [], tasks: [], helpers: [] });
assert.match(parseBoard('{"checked": {}}').error, /"checked" is not a list/);

const now = Date.parse("2026-11-09T22:30:00Z");
assert.equal(age("2026-11-09T22:29:40Z", now), "now");
assert.equal(age("2026-11-09T22:00:00Z", now), "30m");
assert.equal(age("2026-11-09T19:10:00Z", now), "3h 20m");
assert.equal(age("2026-11-07T22:30:00Z", now), "2d");
assert.equal(age("garbage", now), null);

const local = new Date(2026, 10, 9, 7, 5, 31);
assert.equal(clock(local.toISOString()), "07:05");
assert.equal(clock("garbage"), null);
assert.equal(clock(null), null);

assert.equal(agentAddress("t7", "work-box"), "work-box/t7");
assert.equal(agentAddress("work-box/t7", "work-box"), "work-box/t7");
assert.equal(agentAddress("t7", null), "t7");
assert.equal(agentAddress(null, null), null);

const { board } = parseBoard(JSON.stringify({
  updated: "2026-11-09T22:09:24Z",
  needsYou: [{ id: "q1", task: "A-1", question: "Merge?", since: "2026-11-09T22:00:00Z" }],
  tasks: [
    { key: "A-1", machine: null, folder: "/p/a1", agent: "t1", stage: "fixing", tests: "green",
      prs: [{ repo: "be", number: 110, url: "https://x/110", base: "develop" }, { repo: "fe", number: 38, url: "https://x/38", base: "feat/a" }],
      next: { who: "agent", what: "Fix AC11" } },
    { key: "B-2", machine: "work-box", folder: "/r/b2", agent: "t9", stage: "dreaming", prs: [] },
  ],
  helpers: [{ address: "t6x", name: "fixer", purpose: "fix", state: "done" }],
}));
const status = { t1: "working", "work-box/t9": "blocked", t6x: "blocked" };
const view = buildView(board, (address) => status[address], now);
assert.deepEqual(view.tasks[0].prs.map((pr) => [pr.number, pr.base]), [[110, null], [38, "feat/a"]]);
assert.equal(view.tasks[0].status, "working");
assert.equal(view.tasks[1].agent, "work-box/t9");
assert.equal(view.tasks[1].isKnownStage, false);
assert.equal(view.tasks[1].next, null);
assert.deepEqual(view.needsYou.map((item) => [item.number, item.task, item.waited, item.agent]), [
  [1, "A-1", "30m", null],
  [2, "B-2", null, "work-box/t9"],
  [3, "fixer", null, "t6x"],
]);

const spaces = [
  { id: "s1", machine: null, folder: "/p/a1", tabs: [{ id: "tb1" }] },
  { id: "s2", machine: "work-box", folder: "", tabs: [{ id: "tb2" }] },
  { id: "s3", machine: null, folder: "/r/b2", tabs: [{ id: "tb3" }] },
];
const panes = [{ tab: "tb2", cwd: "/r/b2/backend" }, { tab: "tb3", cwd: "/r/b2" }];
assert.equal(taskSpace(view.tasks[0], spaces, panes).id, "s1");
assert.equal(taskSpace(view.tasks[1], spaces, panes).id, "s2", "matches machine, then a terminal's live folder");
assert.equal(taskSpace({ folder: "/nowhere", machine: null }, spaces, panes), null);
assert.equal(taskSpace({ folder: null, machine: null }, spaces, panes), null);

assert.deepEqual(prGroups(view.tasks[0].prs).map((g) => [g.base, g.prs.map((pr) => pr.number)]), [[null, [110]], ["feat/a", [38]]]);
assert.deepEqual(prGroups([{ number: 1, base: "b" }, { number: 2, base: "b" }]).map((g) => g.prs.length), [2]);
assert.deepEqual(prGroups([]), []);

console.log("board: ok");

// Try items: checked off and back, by id, keeping every other field.
{
  const at = "2026-11-10T21:00:00.000Z";
  const raw = {
    updated: "2026-11-10T20:00:00Z",
    note: "kept",
    needsYou: [
      { id: "d1", question: "Merge?", since: "2026-11-10T10:00:00Z" },
      { id: "t1", kind: "try", question: "Click A", since: "2026-11-10T11:00:00Z", extra: 1 },
      { id: "t2", kind: "try", question: "Click B", since: "2026-11-10T12:00:00Z" },
    ],
    tasks: [{ key: "A-1" }],
  };
  const { board: checked } = checkItem(raw, "t1", at);
  assert.deepEqual(checked.needsYou.map((item) => item.id), ["d1", "t2"]);
  assert.deepEqual(checked.checked, [{ id: "t1", kind: "try", question: "Click A", since: "2026-11-10T11:00:00Z", extra: 1, checkedAt: at }]);
  assert.equal(checked.updated, at);
  assert.equal(checked.note, "kept");
  assert.equal(checked.tasks, raw.tasks);
  assert.equal(raw.needsYou.length, 3); // the input is not changed

  assert.match(checkItem(checked, "t1", at).error, /already checked/);
  assert.match(checkItem(raw, "nope", at).error, /No item nope/);
  assert.match(checkItem(raw, "d1", at).error, /a decision/);
  assert.match(uncheckItem(raw, "t1", at).error, /not checked/);
  assert.match(uncheckItem(raw, "nope", at).error, /No checked item/);

  // Back in its place by since, without checkedAt.
  const { board: back } = uncheckItem(checked, "t1", at);
  assert.deepEqual(back.needsYou.map((item) => item.id), ["d1", "t1", "t2"]);
  assert.deepEqual(back.needsYou[1], raw.needsYou[1]);
  assert.deepEqual(back.checked, []);
  // An item with no since goes last.
  const { board: noSince } = uncheckItem({ needsYou: raw.needsYou, checked: [{ id: "t9", kind: "try", checkedAt: at }] }, "t9", at);
  assert.deepEqual(noSince.needsYou.map((item) => item.id), ["d1", "t1", "t2", "t9"]);

  const view = buildView(parseBoard(JSON.stringify(checked)).board, () => null, Date.parse(at));
  assert.deepEqual(view.needsYou.map((item) => [item.id, item.isTry, item.number]), [["d1", false, 1], ["t2", true, 2]]);
  assert.deepEqual(view.checked.map((item) => item.id), ["t1"]);
}
console.log("board: checks ok");
