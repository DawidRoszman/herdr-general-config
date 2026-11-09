// A review's pull requests read as one diff: node --test mods/walkthrough/lib/prs.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { pullRequestSections, sourceKey, describe, runGh } from "./sources.js";
import { buildDigest } from "./digest.js";
import { resolveTask } from "./task.js";

const patch = (path) => `diff --git a/${path} b/${path}
index 1..2 100644
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-old
+new
`;

const prs = [
  { number: 3, title: "API", body: "Adds the endpoint.", prefix: "api", diff: ["fake", "api"] },
  { number: 7, title: "Web", body: "", prefix: "web", diff: ["fake", "web"] },
];

test("linked PRs become one diff, each path under its repository, ids apart", async () => {
  const exec = async (_command, [repo]) => ({ code: 0, stdout: patch("src/x.ts"), stderr: "" });
  const sections = await pullRequestSections(exec, prs);
  const digest = buildDigest(sections);
  assert.deepEqual(digest.files.map((f) => f.path), ["api/src/x.ts", "web/src/x.ts"]);
  const ids = digest.files.flatMap((f) => f.hunks.map((h) => h.id));
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids[0].startsWith("pr:api:api/src/x.ts:"));
});

test("a plain repo's single PR keeps its paths", async () => {
  const exec = async () => ({ code: 0, stdout: patch("x.ts"), stderr: "" });
  const digest = buildDigest(await pullRequestSections(exec, [{ number: 1, prefix: "", diff: ["fake"] }]));
  assert.deepEqual(digest.files.map((f) => f.path), ["x.ts"]);
});

test("a PR whose diff fails names itself", async () => {
  const exec = async (_command, [repo]) => (repo === "web" ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: patch("a"), stderr: "" });
  await assert.rejects(pullRequestSections(exec, prs), /web #7: boom/);
});

test("the task is every PR's title and description; the key is the review's", () => {
  const source = { kind: "prs", key: "mac:/p:feat/x", prs };
  assert.equal(sourceKey(source), "prs:mac:/p:feat/x");
  assert.match(describe(source), /2 linked pull requests/);
  const task = resolveTask({ source });
  assert.equal(task.text, "api #3 API\n\nAdds the endpoint.\n\nweb #7 Web");
});

test("a toast names the source in a few words", async () => {
  const { shortLabel } = await import("./sources.js");
  assert.equal(shortLabel({ kind: "prs", prs }, "prs:devbox|/p|feat/x"), "api #3 · web #7");
  assert.equal(shortLabel({ kind: "branch", base: "main", head: "feat/x" }, "/code/app"), "app: feat/x vs main");
  assert.equal(shortLabel({ kind: "uncommitted" }, "/code/app"), "app: uncommitted");
});

test("gh runs in the repo's direnv environment, plain without direnv", async () => {
  const calls = [];
  const withDirenv = async (command, args) => { calls.push([command, ...args]); return { code: 0, stdout: "ok" }; };
  assert.equal((await runGh(withDirenv, "/r", ["pr", "list"])).stdout, "ok");
  assert.deepEqual(calls, [["direnv", "exec", "/r", "gh", "pr", "list"]]);
  calls.length = 0;
  const noDirenv = async (command, args) => { calls.push([command, ...args]); if (command === "direnv") throw new Error("not found"); return { code: 0 }; };
  await runGh(noDirenv, "/r", ["pr", "list"]);
  assert.deepEqual(calls.at(-1), ["gh", "pr", "list"]);
});
