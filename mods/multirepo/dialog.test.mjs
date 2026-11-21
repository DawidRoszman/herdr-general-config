import { register } from "node:module";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./test-stubs/loader.mjs", import.meta.url);
const { state } = await import("./test-stubs/herdr.mjs");
const { default: Multirepo } = await import("./main.js");

const HOME = realpathSync(mkdtempSync(join(tmpdir(), "mr-dialog-")));
state.home = HOME;
const made = spawnSync("sh", [new URL("./test-project.sh", import.meta.url).pathname], { env: { ...process.env, HOME }, encoding: "utf8" });
assert.equal(made.status, 0, made.stderr);
const PROJECT = `${HOME}/.herdr/mr-test/AcmeShop`;
const TASKS = `${HOME}/.herdr/projects/AcmeShop`;

const pending = new Set();
const timers = [];
const cx = {
  focus_handle: () => ({ focus() {}, is_focused: () => true }),
  spawn(work) { const p = work(cx).finally(() => pending.delete(p)); pending.add(p); return p; },
  timer: { every: (_ms, fn) => timers.push(fn), after: (_ms, fn) => fn() },
  notify() {}, stop_propagation() {}, open_url(url) { state.opened = url; },
};
const settle = async () => { while (pending.size) await Promise.all([...pending]); };
const key = async (stroke) => { dialog.key({ keystroke: stroke }, cx); await settle(); };

const finishJob = async () => { for (const tick of timers) tick(cx); await settle(); };
const labels = () => dialog.items().map((item) => item.name ?? item.branch ?? item);

state.props = { machine: null, project: PROJECT, overlay: "ov1" };
const dialog = new Multirepo();
dialog.init(state.props, cx);
await settle();
assert.equal(dialog.level, "tasks", `${dialog.error} ${JSON.stringify(dialog.projects)}`);
assert.deepEqual(labels(), ["feat/SHOP-130-checkout-flow", "feat/SHOP-132-cart-ui", "fix/SHOP-7-typo-in-readme"]);
dialog.render(cx);

await key("/");
assert.equal(dialog.inputMode, "search");
dialog.input.type("cart", cx);
assert.deepEqual(labels(), ["feat/SHOP-132-cart-ui"]);
dialog.input.submit(cx);
await settle();
assert.equal(dialog.level, "repos", "enter in the search opens the match");
assert.deepEqual(labels(), ["acme-shop-backend"]);
dialog.render(cx);
await key("h");
assert.equal(dialog.level, "tasks", `${dialog.error} ${JSON.stringify(dialog.projects)}`);
assert.equal(dialog.at, 1, "back lands on the task that was open");
assert.equal(dialog.query, "", "back clears the search");

await key("n");
assert.equal(dialog.inputMode, "new");
dialog.input.set_value("feat/SHOP-140-wishlist portal nope");
dialog.input.submit(cx);
await settle();
assert.equal(dialog.level, "pick");
assert.deepEqual([...dialog.picked], ["acme-shop-portal"]);
assert.match(dialog.error, /nope/);
dialog.render(cx);
await key("space");
assert.deepEqual([...dialog.picked].sort(), ["acme-shop-backend", "acme-shop-portal"], "space ticks the first repo");
await key("a");
assert.equal(dialog.picked.size, 3, "a ticks every repo");
await key("a");
assert.equal(dialog.picked.size, 0, "a again unticks them");
await key("enter");
assert.match(dialog.error, /Tick at least one/);
await key("space");
await key("enter");
assert.ok(dialog.job, "creating runs as a job");
assert.equal(dialog.level, "tasks", `${dialog.error} ${JSON.stringify(dialog.projects)}`);
await finishJob();
assert.equal(dialog.job, null);
assert.match(dialog.notice, /Creating feat\/SHOP-140-wishlist: done/);
assert.ok(dialog.notice.includes("o opens its workspace"));
assert.ok(labels().includes("feat/SHOP-140-wishlist"));
assert.equal(labels()[dialog.at], "feat/SHOP-140-wishlist", "the new task is selected");
assert.ok(state.shared["multirepo.changed"], "the Projects tab is told");

await key("l");
assert.equal(dialog.level, "repos");
assert.deepEqual(labels(), ["acme-shop-backend"]);
assert.equal(dialog.items()[0].branch, "feat/SHOP-140-wishlist");
await key("enter");
assert.match(dialog.notice, /no PR yet/);
assert.equal(dialog.error, "");
dialog.render(cx);

await key("a");
assert.equal(dialog.level, "pick");
assert.deepEqual(labels(), ["acme-shop-portal", "helper-scripts"]);
await key("space");
await key("j");
await key("b");
assert.equal(dialog.inputMode, "branch");
assert.equal(dialog.branchFor, "helper-scripts");
dialog.render(cx);
dialog.input.set_value("feature-helpers-wishlist");
dialog.input.submit(cx);
await settle();
assert.deepEqual(dialog.pickBranches, { "helper-scripts": "feature-helpers-wishlist" });
assert.ok(dialog.picked.has("helper-scripts"), "naming its branch ticks the repo");
assert.match(dialog.rowFor("helper-scripts", {}).detail, /on feature-helpers-wishlist/);
dialog.render(cx);
await key("enter");
await finishJob();
assert.equal(dialog.level, "repos", "the picker goes back where it came from");
assert.deepEqual(labels(), ["acme-shop-backend", "acme-shop-portal", "helper-scripts"]);
assert.equal(dialog.items().find((r) => r.name === "helper-scripts").branch, "feature-helpers-wishlist");
await key("h");
assert.equal(labels()[dialog.at], "feat/SHOP-140-wishlist", "back lands on the task after its list reloaded");

await key("s");
assert.equal(dialog.stackOn.branch, "feat/SHOP-140-wishlist");
dialog.input.set_value("feat/SHOP-141-child");
dialog.input.submit(cx);
await settle();
assert.equal(dialog.level, "pick");
assert.deepEqual([...dialog.picked].sort(), ["acme-shop-backend", "acme-shop-portal", "helper-scripts"], "the parent's repos come ticked");
dialog.render(cx);
await key("h");
assert.equal(dialog.level, "tasks");
assert.equal(dialog.stackOn, null);
assert.equal(labels()[dialog.at], "feat/SHOP-140-wishlist", "leaving the picker stays on the task");

await key("x");
assert.equal(dialog.confirmRemove, `${TASKS}/feat-SHOP-140-wishlist`);
dialog.render(cx);
await key("escape");
assert.equal(dialog.confirmRemove, null);
assert.equal(state.closedOverlays.length, 0, "esc kept the dialog open");
await key("x");
await key("x");
await finishJob();
assert.match(dialog.notice, /Removing feat\/SHOP-140-wishlist: done/);
assert.ok(!labels().includes("feat/SHOP-140-wishlist"));

assert.equal(labels()[dialog.at], "feat/SHOP-130-checkout-flow");
await key("x");
await key("x");
await finishJob();
assert.match(dialog.error, /would lose work/);
assert.match(dialog.error, /shift-x removes it anyway/);
assert.ok(labels().includes("feat/SHOP-130-checkout-flow"));

await key("escape");
assert.deepEqual(state.closedOverlays, ["ov1"]);

rmSync(HOME, { recursive: true, force: true });
console.log("dialog ok");
