import assert from "node:assert/strict";
import { pickedRepos, changeBadge, prLabel, remoteCommand } from "./view.js";

const names = ["helper-scripts-shop", "acme-shop-backend", "acme-shop-portal"];
const shorts = { "helper-scripts-shop": "helper-scripts-shop", "acme-shop-backend": "backend", "acme-shop-portal": "portal" };
assert.deepEqual(pickedRepos(["backend", "acme-shop-portal", "backend", "nope", "orth"], names, shorts),
  { picked: ["acme-shop-backend", "acme-shop-portal"], unknown: ["nope", "orth"] });
assert.deepEqual(pickedRepos([], names, shorts), { picked: [], unknown: [] });
assert.equal(changeBadge({ ahead: 2, behind: 0, unpushed: 1, dirty: 3 }), "+2 ↑1 ●3");
assert.equal(changeBadge({ ahead: 0, behind: 0, unpushed: 0, dirty: 0 }), "");
assert.equal(prLabel(null), "no PR");
assert.equal(prLabel({ number: 7, state: "OPEN", isDraft: true }), "PR #7 draft");
assert.equal(prLabel({ number: 7, state: "MERGED", isDraft: false }), "PR #7 merged");
assert.equal(remoteCommand(["new", "feat/x", "it's"]), `python3 - 'new' 'feat/x' 'it'\\''s'`);
console.log("view.js ok");
