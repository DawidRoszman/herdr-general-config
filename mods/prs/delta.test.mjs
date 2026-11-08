import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { highlightDiff, parseAnsi } from "./delta.js";

// Parsing: true colors, the changed-words background, resets.
assert.deepEqual(parseAnsi("a\x1b[38;2;255;0;16mb\x1b[48;2;1;2;3mc\x1b[0md"), [
  { text: "a", color: null, isChanged: false },
  { text: "b", color: "#ff0010", isChanged: false },
  { text: "c", color: "#ff0010", isChanged: true },
  { text: "d", color: null, isChanged: false },
]);

// Against the real delta, through herdr's exec shape.
const exec = async (command, args) => {
  const r = spawnSync(command, args, { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
const rows = [
  { kind: "@", text: "@@ -1,2 +1,2 @@" },
  { kind: " ", text: "const a = 1; // hi" },
  { kind: "-", text: 'let name = format("x", 42);' },
  { kind: "+", text: 'let name = format("y", 42);' },
  { kind: "", text: "\\ No newline at end of file" },
];
const colored = await highlightDiff(rows, "src/a.ts", { exec, isDark: true });
assert.equal(colored[0].segments, undefined);
assert.equal(colored[4].segments, undefined);
for (const row of colored.slice(1, 4)) assert.equal(row.segments.map((s) => s.text).join(""), row.text);
const keyword = colored[1].segments.find((s) => s.text === "const");
const plain = colored[1].segments.find((s) => s.text.includes("a"));
assert.ok(keyword.color && keyword.color !== plain.color, "keywords get their own color");
assert.deepEqual(colored[3].segments.filter((s) => s.isChanged).map((s) => s.text), ["y"]);

// A missing delta is an error that says how to get it.
const noDelta = async () => ({ code: 127, stdout: "", stderr: "sh: delta: command not found" });
await assert.rejects(highlightDiff(rows, "a.ts", { exec: noDelta, isDark: true }), /brew install git-delta/);

console.log("delta ok");
