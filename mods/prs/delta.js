const CHANGED_WORDS_BACKGROUND = "#010203";

const MAX_INPUT_LENGTH = 200_000;

const PIPE_TO_DELTA = 'printf "%s\\n" "$0" | delta "$@"';

export function deltaOptions(isDark) {
  return [
    "--no-gitconfig", "--color-only", "--true-color=always", isDark ? "--dark" : "--light",
    `--syntax-theme=${isDark ? "OneHalfDark" : "OneHalfLight"}`,
    ...["minus", "plus", "zero", "minus-non-emph", "plus-non-emph"].map((style) => `--${style}-style=syntax`),
    ...["minus", "plus"].map((side) => `--${side}-emph-style=syntax "${CHANGED_WORDS_BACKGROUND}"`),
  ];
}

export function deltaInput(rows, path) {
  const lines = rows.map((row) => (["+", "-", " "].includes(row.kind) ? row.kind + row.text : row.text));
  return [`--- a/${path}`, `+++ b/${path}`, ...lines].join("\n");
}

const hex = (r, g, b) => `#${[r, g, b].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;

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

function withoutPrefix(segments) {
  const [first, ...rest] = segments;
  if (!first) return segments;
  return first.text.length > 1 ? [{ ...first, text: first.text.slice(1) }, ...rest] : rest;
}

export function withDeltaSegments(rows, output) {
  const lines = output.replace(/\n$/, "").split("\n").slice(2);
  if (lines.length !== rows.length) throw new Error(`delta returned ${lines.length} lines for ${rows.length}`);
  return rows.map((row, i) => (["+", "-", " "].includes(row.kind) ? { ...row, segments: withoutPrefix(parseAnsi(lines[i])) } : row));
}

export async function highlightDiff(rows, path, { exec, isDark }) {
  const input = deltaInput(rows, path);
  if (input.length > MAX_INPUT_LENGTH) return rows;
  const result = await exec("sh", ["-c", PIPE_TO_DELTA, input, ...deltaOptions(isDark)]);
  if (result.code === 127) throw new Error("No syntax colors: delta is not installed (brew install git-delta).");
  if (result.code !== 0) throw new Error(`No syntax colors: delta failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  return withDeltaSegments(rows, result.stdout);
}
