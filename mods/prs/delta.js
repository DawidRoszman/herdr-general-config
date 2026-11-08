// Syntax colors and changed-word marks for diff rows, from delta (https://github.com/dandavison/delta,
// `brew install git-delta`) run on this computer.
// Copied verbatim to mods/prs/delta.js and mods/changes-multi/delta.js (a mod cannot import from
// another mod's folder): change both copies together.
//
// `delta --color-only` keeps every input line and only adds ANSI colors, so the colored output maps
// back onto the rows one to one. Changed words get a background color nobody would pick, and that
// background only marks them: the view draws its own tint there.

const CHANGED_WORDS_BACKGROUND = "#010203";
// ponytail: the diff goes to delta as an argument (exec has no stdin); bigger diffs stay uncolored.
// Pipe through a temp file if large files need colors.
const MAX_INPUT_LENGTH = 200_000;
// "$0" is the diff, "$@" delta's options.
const PIPE_TO_DELTA = 'printf "%s\\n" "$0" | delta "$@"';

export function deltaOptions(isDark) {
  return [
    "--no-gitconfig", "--color-only", "--true-color=always", isDark ? "--dark" : "--light",
    `--syntax-theme=${isDark ? "OneHalfDark" : "OneHalfLight"}`,
    ...["minus", "plus", "zero", "minus-non-emph", "plus-non-emph"].map((style) => `--${style}-style=syntax`),
    ...["minus", "plus"].map((side) => `--${side}-emph-style=syntax "${CHANGED_WORDS_BACKGROUND}"`),
  ];
}

// The rows back as diff text, under a file header so delta can tell the language from the path.
export function deltaInput(rows, path) {
  const lines = rows.map((row) => (["+", "-", " "].includes(row.kind) ? row.kind + row.text : row.text));
  return [`--- a/${path}`, `+++ b/${path}`, ...lines].join("\n");
}

const hex = (r, g, b) => `#${[r, g, b].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;

/** One colored line as [{ text, color: "#rrggbb" | null, isChanged }]; other SGR attributes are dropped. */
export function parseAnsi(line) {
  const segments = [];
  let color = null;
  let isChanged = false;
  let at = 0;
  const push = (end) => {
    if (end <= at) return;
    const text = line.slice(at, end);
    const last = segments[segments.length - 1];
    if (last && last.color === color && last.isChanged === isChanged) last.text += text;
    else segments.push({ text, color, isChanged });
  };
  for (const match of line.matchAll(/\x1b\[([\d;]*)m/g)) {
    push(match.index);
    at = match.index + match[0].length;
    const codes = match[1].split(";");
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === "" || code === "0") { color = null; isChanged = false; }
      else if (code === "39") color = null;
      else if (code === "49") isChanged = false;
      else if ((code === "38" || code === "48") && codes[i + 1] === "2") {
        const rgb = codes.slice(i + 2, i + 5);
        if (code === "38") color = hex(...rgb);
        else isChanged = hex(...rgb) === CHANGED_WORDS_BACKGROUND;
        i += 4;
      }
    }
  }
  push(line.length);
  return segments;
}

// Removes the +, - or space a code line starts with, which the rows keep apart from their text.
function withoutPrefix(segments) {
  const [first, ...rest] = segments;
  if (!first) return segments;
  return first.text.length > 1 ? [{ ...first, text: first.text.slice(1) }, ...rest] : rest;
}

/** Gives the code rows `segments` from delta's output for `deltaInput(rows, path)`. */
export function withDeltaSegments(rows, output) {
  const lines = output.replace(/\n$/, "").split("\n").slice(2);
  if (lines.length !== rows.length) throw new Error(`delta returned ${lines.length} lines for ${rows.length}`);
  return rows.map((row, i) => (["+", "-", " "].includes(row.kind) ? { ...row, segments: withoutPrefix(parseAnsi(lines[i])) } : row));
}

/**
 * One file's diff rows ({ kind: "@" | "+" | "-" | " " | "", text }) with `segments` on the code rows.
 * `exec` is herdr's. Rejects when delta is missing or fails; a diff too big to pass stays as it is.
 */
export async function highlightDiff(rows, path, { exec, isDark }) {
  const input = deltaInput(rows, path);
  if (input.length > MAX_INPUT_LENGTH) return rows;
  const result = await exec("sh", ["-c", PIPE_TO_DELTA, input, ...deltaOptions(isDark)]);
  if (result.code === 127) throw new Error("No syntax colors: delta is not installed (brew install git-delta).");
  if (result.code !== 0) throw new Error(`No syntax colors: delta failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  return withDeltaSegments(rows, result.stdout);
}
