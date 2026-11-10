// Loads the menu in a fake `herdr`: a tab's and a pane's Close go through the tab bar; the rest is Herdr's own.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const el = () => new Proxy({}, { get: (_o, k) => (k === "when" ? (c, f) => (c ? f(p) : p) : () => p) }), p = el();
let target = {}, calls = [], context_ = null;
const context = vm.createContext({
  View: class {}, div: el, svg: el, v_flex: el, h_flex: el,
  run: (name, args) => calls.push(args === undefined ? [name] : [name, args]), props: () => target, closeOverlay() {}, openOverlay() {},
  theme: () => ({}), keys: () => [], terminals: () => [{ address: "t1", labels: {} }], spaces: () => [], panes: () => [], exec: async () => ({ code: 1 }),
  shared: (key) => (key === "context" ? context_ : null), appHome: () => "/app", home: () => "/home/me", notify() {},
});
const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8").replace(/^import .*;\r?\n/gm, "").replace("export default class", "globalThis.Menu = class");
vm.runInContext(src, context);
const menu = new context.Menu();
const choose = (props, label) => {
  target = props; calls = [];
  const i = vm.runInContext("items", context)(props, null).findIndex((it) => it[0] === label);
  menu.choose(i);
  return JSON.parse(JSON.stringify(calls));
};

assert.deepEqual(choose({ tab: "tab", target: { id: "b1", space: "s1" } }, "Close"), [["t3-tabs.close-tab:b1"]], "a tab's Close asks and leaves first");
assert.deepEqual(choose({ tab: "pane", target: { pane: "p1", terminal: "t1" } }, "Close pane"), [["t3-tabs.close-pane:p1"]], "so does a pane's");
assert.deepEqual(choose({ tab: "tab", target: { id: "b1", space: "s1" } }, "Rename"), [["tab.rename", { id: "b1" }]], "the rest is Herdr's");
assert.deepEqual(choose({ tab: "space", target: { id: "s1" } }, "Close"), [["space.close", { id: "s1" }]], "a space's Close is Herdr's, which asks itself");
context_ = { profiles: { work: { label: "Work", machines: ["box"], folders: ["~/work"] }, home: { label: "Home", machines: [], folders: ["/srv/home/"] } } };
const labels = (target) => vm.runInContext("items", context)({ tab: "profile", target }, null).map((it) => it[0]).join(" | ");
assert.deepEqual(labels({ kind: "folder", value: "/home/me/work/app" }), ["Work ✓", "Home", "No profile (by its accounts)"].join(" | "), "a folder's profile is marked, ~ expanded");
assert.deepEqual(labels({ kind: "folder", value: "/srv/home" }), ["Work", "Home ✓", "No profile (by its accounts)"].join(" | "), "the folder itself too");
assert.deepEqual(labels({ kind: "folder", value: "/home/me/workshop" }), ["Work", "Home", "No profile (by its accounts)"].join(" | "), "not a folder that only starts alike");
assert.deepEqual(labels({ kind: "machine", value: "box" }), ["Work ✓", "Home", "Shared (no profile)"].join(" | "), "a machine's profile is marked");
console.log("ok menu");
