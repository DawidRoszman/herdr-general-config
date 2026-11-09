import assert from "node:assert/strict";
import { pickedRepos, repoArgs, changeBadge, baseLabel, prLabel, remoteCommand } from "./view.js";

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
console.log("view.js ok");
