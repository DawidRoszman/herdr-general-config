// Drives the Projects tab's keys against a real mr.py on a throwaway project (test-project.sh in a
// temporary HOME): node projects.test.mjs. The app's modules are stood in for by test-stubs/.
import { register } from "node:module";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./test-stubs/loader.mjs", import.meta.url);
const { state } = await import("./test-stubs/herdr.mjs");
const { CHANGED } = await import("./view.js");
const { default: Multirepo } = await import("./main.js");

const HOME = realpathSync(mkdtempSync(join(tmpdir(), "mr-projects-")));
state.home = HOME;
const made = spawnSync("sh", [new URL("./test-project.sh", import.meta.url).pathname], { env: { ...process.env, HOME }, encoding: "utf8" });
assert.equal(made.status, 0, made.stderr);
const PROJECT = `${HOME}/.herdr/mr-test/AcmeShop`;
const TASKS = `${HOME}/.herdr/projects/AcmeShop`;

// The view's command loop (nextCommand) never ends, so "settled" is: no task finished for a while.
let finished = 0;
const timers = [];
const cx = {
  focus_handle: () => ({ focus() {}, is_focused: () => true }),
  spawn(work) { return work(cx).finally(() => { finished += 1; }); },
  timer: { every: (_ms, fn) => timers.push(fn), after: (_ms, fn) => fn() },
  notify() {}, stop_propagation() {}, open_url(url) { state.opened = url; },
};
const settle = async () => { for (let seen = -1; seen !== finished;) { seen = finished; await new Promise((r) => setTimeout(r, 60)); } };
const tick = async () => { for (const fn of timers) fn(cx); await settle(); };
const key = async (stroke) => { view.key({ keystroke: stroke }, cx); await settle(); };
const branches = () => view.tasks().map((t) => t.branch);
const lastOverlay = () => state.overlays.at(-1).props;

state.props = { view: "projects" };
const tab = new Multirepo();
tab.init(state.props, cx);
const view = tab.screen;
await settle();
assert.equal(view.place().project.name, "AcmeShop");
assert.deepEqual(branches(), ["feat/SHOP-130-checkout-flow", "feat/SHOP-132-cart-ui", "fix/SHOP-7-typo-in-readme"]);
assert.equal(view.listing.tasks[1].on, "feat/SHOP-130-checkout-flow", "a stacked task says what it is on");
assert.ok(view.details.get(view.selected().root)?.repos, "the selected task's repos are loaded");
tab.render(cx);

// j/k move and load the task's detail; the stacked task's detail renders.
await key("j");
assert.equal(view.selected().branch, "feat/SHOP-132-cart-ui");
assert.deepEqual(view.details.get(view.selected().root).repos.map((r) => r.name), ["acme-shop-backend"]);
tab.render(cx);
await key("k");
assert.equal(view.at, 0);
await key("k");
assert.equal(view.at, 2, "k wraps around");

// Search narrows; esc clears it, esc again closes the tab.
await key("/");
assert.ok(view.isTyping);
view.input.type("typo", cx);
assert.deepEqual(branches(), ["fix/SHOP-7-typo-in-readme"]);
await key("escape");
assert.ok(!view.isTyping && view.query === "typo", "esc leaves the box, keeps the filter");
await key("escape");
assert.equal(view.query, "");
assert.equal(state.runs.length, 0);
await key("escape");
assert.deepEqual(state.runs.at(-1), ["pane.close", undefined]);

// Each action opens the dialog at its step, on this project.
const task = view.selected();
await key("n");
assert.deepEqual(lastOverlay(), { machine: null, project: PROJECT, newTask: "" });
await key("s");
assert.deepEqual(lastOverlay(), { machine: null, project: PROJECT, newTask: "", stackOn: task.root });
await key("a");
assert.equal(lastOverlay().addTo, task.root);
await key("p");
assert.equal(lastOverlay().prTask, task.root);
await key("x");
assert.equal(lastOverlay().removeTask, task.root);
await key("v");
assert.deepEqual(state.runs.at(-1), ["tab.new", { name: "PR SHOP-130", mod: "prs", props: { view: "review", machine: null, project: PROJECT, branch: task.branch } }]);

// o opens the task's workspace: a space on its folder with claude, a terminal and nvim.
await key("o");
assert.deepEqual(state.herdrDo.map(([command]) => command), ["space.new", "tab.new", "tab.new", "tab.move", "tab.move", "tab.move", "space.select", "tab.select"]);
assert.equal(state.herdrDo[0][1].folder, task.root);

// The dialog's change stamp reloads the list: a task made meanwhile shows up.
spawnSync("python3", [new URL("./mr.py", import.meta.url).pathname, "new", "feat/SHOP-150-made-elsewhere", "portal", "--project", PROJECT], { env: { ...process.env, HOME }, encoding: "utf8" });
assert.equal(branches().length, 3);
state.shared[CHANGED] = Date.now();
await tick();
assert.equal(branches().length, 4);
assert.ok(view.details.get(view.selected().root)?.repos, "details are loaded again after a reload");
tab.render(cx);

// r reloads too; [ and ] do nothing with one project.
await key("r");
assert.equal(branches().length, 4);
await key("]");
assert.equal(view.place().project.name, "AcmeShop");

rmSync(HOME, { recursive: true, force: true });
console.log("projects ok");
