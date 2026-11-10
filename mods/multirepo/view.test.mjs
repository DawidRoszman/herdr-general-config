import assert from "node:assert/strict";
import { pickedRepos, repoArgs, changeBadge, baseLabel, prLabel, remoteCommand, stackOrder } from "./view.js";

const names = ["helper-scripts-shop", "acme-shop-backend", "acme-shop-portal"];
const shorts = { "helper-scripts-shop": "helper-scripts-shop", "acme-shop-backend": "backend", "acme-shop-portal": "portal" };
assert.deepEqual(pickedRepos(["backend", "acme-shop-portal", "backend", "nope", "orth"], names, shorts),
  { picked: ["acme-shop-backend", "acme-shop-portal"], unknown: ["nope", "orth"], branches: {} });
assert.deepEqual(pickedRepos([], names, shorts), { picked: [], unknown: [], branches: {} });
assert.deepEqual(pickedRepos(["portal=fix/other-name", "nope=x"], names, shorts),
  { picked: ["acme-shop-portal"], unknown: ["nope=x"], branches: { "acme-shop-portal": "fix/other-name" } });
assert.deepEqual(repoArgs(["acme-shop-backend", "acme-shop-portal"], { "acme-shop-portal": "fix/x" }), ["acme-shop-backend", "acme-shop-portal=fix/x"]);
assert.equal(changeBadge({ ahead: 2, behind: 0, unpushed: 1, dirty: 3 }), "+2 ↑1 ●3");
assert.equal(changeBadge({ ahead: 0, behind: 0, unpushed: 0, dirty: 0 }), "");
assert.equal(baseLabel({ branch: "test/X-1", base: "develop" }, "feat/X-1"), "on test/X-1 · vs develop");
assert.equal(baseLabel({ branch: "feat/X-1", base: "develop" }, "feat/X-1"), "vs develop");
assert.equal(prLabel(null), "no PR");
assert.equal(prLabel({ number: 7, state: "OPEN", isDraft: true }), "PR #7 draft");
assert.equal(prLabel({ number: 7, state: "MERGED", isDraft: false }), "PR #7 merged");
assert.equal(remoteCommand(["new", "feat/x", "it's"]), `python3 - 'new' 'feat/x' 'it'\\''s'`);
// Stacks: the bottom where its first layer was, each layer after the one it builds on; recorded or found.
const task = (branch, on = null, stackedOn = on) => ({ branch, root: `/t/${branch}`, on, stackedOn });
const ordered = stackOrder([task("c", "b"), task("x"), task("a"), task("b", null, "a"), task("d", "c"), task("e", "gone")]);
assert.deepEqual(ordered.map((t) => [t.branch, t.depth, t.stack.join(" ")]), [
  ["x", 0, ""], ["a", 0, "a b c d"], ["b", 1, "a b c d"], ["c", 2, "a b c d"], ["d", 3, "a b c d"], ["e", 0, "e"]]);
assert.equal(ordered[2].parent, "a", "a parent found from git counts as one recorded");
assert.deepEqual(stackOrder([task("p", "q"), task("q", "p")]).map((t) => t.branch), ["p", "q"], "a loop of parents still lists every task");
assert.deepEqual(stackOrder([task("r"), task("s", "r"), task("t", "r")]).map((t) => t.depth), [0, 1, 1], "a fork: both under the one below");
console.log("view.js ok");
