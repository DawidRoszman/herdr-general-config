// node markdown.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blocks, gapBefore, tableCells, columnWidths, codeLanguage, codeBodyHeight, imageLine, imageSources, imageTarget } from "./markdown.js";

const types = (text) => blocks(text).map((b) => b.type);

assert.deepEqual(types("one\ntwo\n\nthree"), ["prose", "prose"]);
assert.equal(blocks("one\ntwo\n\nthree")[0].raw, "one\ntwo");

// Headings: ATX, closing hashes, setext.
assert.deepEqual(blocks("## Title ##").map((b) => [b.level, b.text]), [[2, "Title"]]);
assert.deepEqual(blocks("Title\n===\nbody").map((b) => b.type), ["heading", "prose"]);
assert.deepEqual(blocks("Title\n---").map((b) => [b.type, b.level]), [["heading", 2]]);
assert.deepEqual(types("#hashtag"), ["prose"]);

// Rules, and a paragraph interrupted by a heading.
assert.deepEqual(types("a\n\n---\n\nb"), ["prose", "hr", "prose"]);
assert.deepEqual(types("a\n# b"), ["prose", "heading"]);

// Fences: language, title, content with blank lines and inner fences of the other kind, unclosed.
const code = blocks("```js file.js\nconst a = 1;\n\n~~~\n```\nafter")[0];
assert.deepEqual([code.lang, code.title, code.text, code.isOpen], ["js", "file.js", "const a = 1;\n\n~~~", false]);
assert.equal(blocks("````md\n```js\nx\n```\n````")[0].text, "```js\nx\n```");
assert.deepEqual(blocks("text\n```py\nprint(1)").map((b) => [b.type, b.isOpen]), [["prose", undefined], ["code", true]]);

// Lists: nested, loose, a fence inside an item, ended by a paragraph.
assert.deepEqual(types("- a\n  - b\n\n- c\n\n  more\n\nparagraph"), ["list", "prose"]);
assert.deepEqual(types("1. a\n2. b\n\ntext"), ["list", "prose"]);
assert.deepEqual(types("intro:\n- a\n- b"), ["prose", "list"]);
assert.deepEqual(types("- a\n  ```js\n  x\n  ```\n- b"), ["list"]);

// A list's items: markers, tasks, own Markdown without the item's indent, loose or tight.
const list = blocks("- a\n  - b\n  - c\n- [x] done\n- [ ] open")[0];
assert.deepEqual(list.items, [
  { ordered: false, marker: "", task: null, text: "a\n- b\n- c" },
  { ordered: false, marker: "", task: "done", text: "done" },
  { ordered: false, marker: "", task: "open", text: "open" },
]);
assert.equal(list.isLoose, false);
const numbered = blocks("9. a\n\n   more\n\n10. b\n    ```js\n    x\n    ```")[0];
assert.deepEqual(numbered.items.map((i) => [i.marker, i.text]), [["9.", "a\n\nmore"], ["10.", "b\n```js\nx\n```"]]);
assert.equal(numbered.isLoose, true);
assert.deepEqual(blocks(numbered.items[1].text).map((b) => b.type), ["prose", "code"]);

// Tables: cells, alignment, short rows padded, escaped pipes.
const table = blocks("| A | B |\n|:--|--:|\n| 1 | x \\| y |\n| only |\n\nafter")[0];
assert.deepEqual(table.header, ["A", "B"]);
assert.deepEqual(table.align, ["left", "right"]);
assert.deepEqual(table.rows, [["1", "x | y"], ["only", ""]]);
assert.deepEqual(tableCells("a | b"), ["a", "b"]);
// Column widths fill the lane, in proportion to what each column needs, capped at 24rem.
const widths = columnWidths({ header: ["id", "Notes"], rows: [["1", "a much longer cell of text"]] }, 600);
assert.equal(Math.round(widths[0] + widths[1]), 600);
assert.ok(widths[1] > widths[0] * 3);
const capped = columnWidths({ header: ["a", "b"], rows: [["x".repeat(500), "y".repeat(500)]] }, 600);
assert.deepEqual(capped.map(Math.round), [300, 300]);
// In a narrow lane a short column keeps its header word whole; one that can't fit makes the table wider than the lane.
const narrowTable = columnWidths({ header: ["Column one", "Three"], rows: [["a/very/long/path/in/a/table/cell.js", "3"]] }, 260);
assert.ok(narrowTable[1] >= 5 * 9 + 24 && Math.round(narrowTable[0] + narrowTable[1]) === 260);
const tooWide = columnWidths({ header: ["Alpha", "Bravo", "Charlie"], rows: [] }, 100);
assert.ok(tooWide.reduce((a, b) => a + b, 0) > 100);

// Code: the view's language, and a body's height from its line count.
assert.deepEqual([codeLanguage("ts"), codeLanguage("zsh"), codeLanguage("text"), codeLanguage("")], ["typescript", "bash", null, null]);
assert.equal(codeBodyHeight("a\nb"), 12.8 * 2 + 2 * 13 * 1.375);
assert.deepEqual(types("a | b\nnot a table"), ["prose"]);

// Quotes and GitHub alerts.
const quote = blocks("> one\n> two\nlazy\n\nafter")[0];
assert.deepEqual([quote.type, quote.text, quote.alert], ["quote", "one\ntwo\nlazy", null]);
assert.deepEqual(blocks("> [!WARNING]\n> careful").map((b) => [b.alert, b.text]), [["warning", "careful"]]);

// Details and raw HTML.
const details = blocks("<details><summary>More</summary>\n\nHidden **body**.\n\n</details>\n\nafter");
assert.deepEqual(details.map((b) => b.type), ["details", "prose"]);
assert.deepEqual([details[0].summary, details[0].body], ["More", "Hidden **body**."]);
assert.equal(blocks("<details>\nx\n</details>")[0].summary, "Details");
assert.deepEqual(types("<div align=\"center\">\n<img src=\"a.png\">\n</div>\n\ntext"), ["html", "prose"]);
assert.deepEqual(types("Raw <kbd>K</kbd> inline"), ["prose"]);

// Margins collapse as in T3's CSS.
const [h, p, d] = [{ type: "heading" }, { type: "prose" }, { type: "details" }];
assert.equal(gapBefore(null, h), 0);
assert.equal(gapBefore(p, h), 20);
assert.equal(gapBefore(h, p), 10.4);
assert.equal(gapBefore(p, p), 10.4);
assert.equal(gapBefore(d, d), 8);

// The fixture covers every block type, and nothing of it is lost.
const fixture = readFileSync(new URL("./fixture.md", import.meta.url), "utf8");
assert.deepEqual([...new Set(types(fixture))].sort(), ["code", "details", "heading", "hr", "list", "prose", "quote", "table"]);
assert.equal(blocks(fixture).map((b) => b.raw).join("\n").replace(/\s+/g, ""), fixture.replace(/\s+/g, ""));

console.log("markdown.js ok");

// Images: Markdown images, and a local image path alone on its line (in backticks or not).
{
  const image = (src, alt = "") => ({ type: "image", src, alt });
  const pick = (text) => blocks(text).map((b) => (b.type === "image" ? image(b.src, b.alt) : { type: b.type, raw: b.raw }));
  assert.deepEqual(pick("/tmp/a b/x.png"), [{ type: "prose", raw: "/tmp/a b/x.png" }], "a path with spaces is text");
  assert.deepEqual(pick("/tmp/shot.png"), [image("/tmp/shot.png")]);
  assert.deepEqual(pick("`~/Desktop/Shot.JPEG`"), [image("~/Desktop/Shot.JPEG")]);
  assert.deepEqual(pick("/tmp/notes.txt"), [{ type: "prose", raw: "/tmp/notes.txt" }]);
  assert.deepEqual(pick("see /tmp/shot.png here"), [{ type: "prose", raw: "see /tmp/shot.png here" }], "inside a sentence stays text");
  assert.deepEqual(pick("![A shot](https://x.io/a.png)"), [image("https://x.io/a.png", "A shot")]);
  assert.deepEqual(pick("![](<file:///tmp/a b.png>) ![b](/tmp/b.gif)"), [image("file:///tmp/a b.png"), image("/tmp/b.gif", "b")]);
  assert.deepEqual(pick("Before\n/tmp/a.png\nafter: ![x](/tmp/b.webp) done"),
    [{ type: "prose", raw: "Before" }, image("/tmp/a.png"), { type: "prose", raw: "after:  done" }, image("/tmp/b.webp", "x")]);
  assert.equal(imageLine("text"), null);
  assert.deepEqual(imageSources("- /tmp/a.png\n- `/tmp/b.png`\n\n> ![q](/tmp/c.png)\n\n```\n/tmp/code.png\n```\n\n/tmp/a.png"),
    ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"]);
}
assert.deepEqual(imageTarget("https://x.io/a.png?s=2", "/Users/me"), { url: "https://x.io/a.png?s=2" });
assert.deepEqual(imageTarget("file:///tmp/a%20b.png", "/Users/me"), { path: "/tmp/a b.png" });
assert.deepEqual(imageTarget("~/Desktop/x.png", "/Users/me"), { path: "/Users/me/Desktop/x.png" });
assert.deepEqual(imageTarget("/tmp/x.png", "/Users/me"), { path: "/tmp/x.png" });
console.log("images ok");
