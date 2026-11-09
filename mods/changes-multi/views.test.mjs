// node --test mods/changes-multi/views.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { statusFiles, nameStatusFiles, diffSides } from "./views.js";

// staged a.js, edited b.js, both c.js, new d.js, conflict e.js
const STATUS = ["M  a.js", " M b.js", "MM c.js", "?? d.js", "UU e.js", "D  f.js"].join("\0") + "\0";
const paths = (view) => statusFiles(view, STATUS).map((f) => `${f.status} ${f.path}`);

test("each view lists its side of git status", () => {
  assert.deepEqual(paths("all"), ["M a.js", "M b.js", "M c.js", "A d.js", "U e.js", "D f.js"]);
  assert.deepEqual(paths("staged"), ["M a.js", "M c.js", "U e.js", "D f.js"]);
  assert.deepEqual(paths("unstaged"), ["M b.js", "M c.js", "A d.js", "U e.js"]);
  assert.deepEqual(paths("branch"), ["A d.js"], "only the untracked: the branch's diff lists the rest");
});

test("a branch diff's files", () => {
  assert.deepEqual(nameStatusFiles("A\0new.js\0M\0x.js\0D\0old.js\0"), [
    { path: "new.js", status: "A", fresh: false }, { path: "x.js", status: "M", fresh: false }, { path: "old.js", status: "D", fresh: false }]);
});

test("what each view diffs against", () => {
  assert.deepEqual(diffSides("all", true).against, ["HEAD"]);
  assert.deepEqual(diffSides("all", false).numstats, [["--cached"], []]);
  assert.deepEqual(diffSides("staged", true).against, ["--cached"]);
  assert.deepEqual(diffSides("unstaged", true).against, []);
  assert.deepEqual(diffSides("branch", true, "abc").against, ["abc"]);
});
