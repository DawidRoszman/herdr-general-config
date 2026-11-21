import { parseJson } from "./walkthrough.js";

export const MODELS = [
  { key: "haiku", name: "Haiku", about: "Fast and cheap; fine for most changes" },
  { key: "sonnet", name: "Sonnet", about: "Better grouping on large or subtle changes" },
  { key: "opus", name: "Opus", about: "The most careful reading, the highest cost" },
];
export const DEFAULT_MODEL = "haiku";
export const modelOf = (key) => MODELS.find((m) => m.key === key) ?? MODELS[0];

export const CLAUDE_FLAGS = [
  "-p", "--output-format", "json", "--tools", "", "--no-session-persistence",
  "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands",
];

export const isRunCommand = (command) => ["--json-schema", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands"].every((flag) => String(command).includes(flag));

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function jobScript() {
  return `#!/bin/sh
# One walkthrough generation. Written by the walkthrough mod for Herdr.
cd "$(dirname "$0")" || exit 1
claude ${CLAUDE_FLAGS.map(shellQuote).join(" ")} --model "$1" --json-schema "$(cat schema.json)" --system-prompt "$(cat system.txt)" < prompt.txt > out.json 2> err.txt &
pid=$!
echo $pid > pid
( waited=0
  while kill -0 $pid 2>/dev/null; do
    if [ $waited -ge "\${2:-900}" ]; then echo "Stopped after $2 seconds without an answer." >> err.txt; kill $pid; exit 0; fi
    sleep 3; waited=$((waited + 3))
  done ) &
wait $pid
echo $? > code.tmp && mv code.tmp code
`;
}

export function readOutcome({ out, err, code }) {
  let answer = null;
  try { answer = out ? JSON.parse(out) : null; } catch { answer = null; }
  if (!answer) {
    const why = String(err ?? "").trim().split("\n").filter(Boolean).slice(-3).join(" ") || `claude exited with ${String(code ?? "?").trim()}`;
    throw Object.assign(new Error(why), { code: "failed" });
  }
  if (answer.is_error || (answer.subtype && answer.subtype !== "success")) {
    const why = typeof answer.result === "string" && answer.result.trim() ? answer.result.trim() : answer.subtype ?? "claude reported an error";
    throw Object.assign(new Error(why), { code: /log ?in/i.test(why) ? "login" : "failed" });
  }
  const raw = answer.structured_output ?? parseJson(answer.result);
  return { raw, cost: typeof answer.total_cost_usd === "number" ? answer.total_cost_usd : null };
}
