// IO for the chat. The agent is Claude Code itself, in a terminal of the chat's tab: started with
// hc run, typed to with hc send / hc keys, and read back from its own transcript file.
// machine null is this Mac.

import { exec, hc, appHome, home, spaces, panes, focused, window } from "herdr";
import { Buffer } from "buffer";
import * as fs from "fs/promises";

const IMAGE_DIR = "data/t3-chat/img";
// Pasted images are kept as files (as T3 Code does), so the agent and the person can use them later (a PR, a doc).
const PASTE_DIR = `${home()}/.herdr/attachments`;

export const machineLabel = (machine) => machine ?? "this Mac";

function failure(r, what) {
  return new Error((r.stderr || r.stdout || `${what} failed (exit ${r.code})`).trim());
}

async function hcOk(args, what) {
  const r = await hc(args);
  if (r.code !== 0) throw failure(r, what);
  return r.stdout;
}

// Claude Code in the person's login shell with the folder's direnv (.zshrc runs `direnv export`),
// so it gets the account and PATH a terminal there gets. exec: the shell becomes claude.
// The command is `claude`, or what the chat was given to start it with (props.argv: an account
// set by env, say), with the session's flags after it.
const IN_LOGIN_SHELL = 'exec "${SHELL:-/bin/sh}" -lic \'exec "$@"\' sh "$@"';

// The label a chat's Claude Code carries: its session id (scripts/start-task.mjs sets it too).
const SESSION_LABEL = "t3-chat.session";

// Starts the session's Claude Code: a new session with that id, or the transcript's session resumed.
// place: { space, tab } ids on the machine. Labelled into the chat's tab, Herdr shows it as a pane
// there, so it is that space's agent (status, sounds, agent lists); the chat hides it by zooming.
export async function startClaude(machine, folder, session, place, isResume, argv = ["claude"]) {
  const out = await hcOk(["run", "--bg", "--json", "--no-parent",
    "--label", `herdr.space=${place.space}`, "--label", `herdr.tab=${place.tab}`, "--label", `${SESSION_LABEL}=${session}`, ...(machine ? ["--on", machine] : []),
    "--cwd", folder, "--", "sh", "-c", IN_LOGIN_SHELL, "sh", ...argv, isResume ? "--resume" : "--session-id", session], "hc run");
  return JSON.parse(out).address;
}

// A live Claude Code started for the session elsewhere (another tab, before a restart) moves here.
export async function adopt(address, place) {
  await hcOk(["label", address, `herdr.space=${place.space}`, `herdr.tab=${place.tab}`], "hc label");
}

// The live terminal running the session's Claude Code, as herdr-core knows now (the app's own
// list of terminals can be a moment behind a terminal that just started), or null.
// Found by the label every Claude Code started for a chat carries (SESSION_LABEL).
export async function runningSession(machine, session) {
  const { terminals } = JSON.parse(await hcOk(["ls", "--json", "--label", `${SESSION_LABEL}=${session}`], "hc ls"));
  const prefix = machine ? `${machine}/` : "";
  return terminals.find((t) => t.state === "live" && (machine ? t.address.startsWith(prefix) : !t.address.includes("/")))?.address ?? null;
}

// The session the terminal's Claude Code is on now: /clear starts a new one in the same process.
// Claude Code keeps it in <config>/sessions/<pid>.json. null when it can't be read (Claude Code
// isn't the process in front, or has ended).
const SESSION_OF = 'for pid in "$@"; do for f in "$HOME"/.claude*/sessions/"$pid".json ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"/sessions/"$pid".json}; do [ -f "$f" ] && { cat "$f"; exit 0; }; done; done; exit 0';
export async function sessionOfTerminal(machine, address) {
  const info = JSON.parse(await hcOk(["get", address, "--json"], "hc get"));
  const pids = [info.foreground?.pid, info.pid].filter(Boolean).map(String);
  if (!pids.length) return null;
  const r = await exec("sh", ["-c", SESSION_OF, "sh", ...pids], { on: machine });
  if (r.code !== 0 || !r.stdout.trim()) return null;
  return JSON.parse(r.stdout).sessionId ?? null;
}

// The session label follows the terminal's session (see runningSession).
export async function labelSession(address, session) {
  await hcOk(["label", address, `${SESSION_LABEL}=${session}`], "hc label");
}

export async function sendText(address, text) {
  await hcOk(["send", address, text], "hc send");
}

export async function pressKeys(address, ...keys) {
  await hcOk(["keys", address, ...keys], "hc keys");
}

export async function readScreen(address) {
  return hcOk(["read", address], "hc read");
}

// The session's transcript path on the machine: Claude Code keeps it under its config folder
// (~/.claude, or another account's ~/.claude-*), or null before the first message.
const FIND = 'for f in "$HOME"/.claude*/projects/*/"$1".jsonl ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"/projects/*/"$1".jsonl}; do [ -f "$f" ] && { echo "$f"; exit 0; }; done; exit 0';
export async function findTranscript(machine, session) {
  const r = await exec("sh", ["-c", FIND, "sh", session], { on: machine });
  if (r.code !== 0) throw failure(r, "finding the transcript");
  return r.stdout.trim() || null;
}

// The transcript's bytes from offset on (as text; the model keeps whole lines).
// ponytail: the first read takes the whole file; page it if transcripts with many images get slow.
export async function readFrom(machine, path, offset) {
  const r = await exec("tail", ["-c", `+${offset + 1}`, path], { on: machine });
  if (r.code !== 0) throw failure(r, "reading the transcript");
  return r.stdout;
}

export const byteLength = (text) => Buffer.byteLength(text);

// A chat made by the old headless bridge (~/.herdr/chats/<id>/meta.json): its Claude session and folder.
export async function oldChat(machine, id) {
  const r = await exec("sh", ["-c", 'cat "$HOME/.herdr/chats/$1/meta.json"', "sh", id], { on: machine });
  if (r.code !== 0) return null;
  const meta = JSON.parse(r.stdout);
  return meta.sessionId ? { session: meta.sessionId, folder: meta.folder, title: meta.title ?? "" } : null;
}

// A file to send with a prompt, as a path on the agent's machine (copied there next to its terminal).
export async function attachmentPath(machine, localPath, address) {
  if (machine === null) return localPath;
  const out = (await hcOk(["put", address, localPath, "--json"], "hc put")).trim();
  try {
    const parsed = JSON.parse(out);
    return parsed.path ?? parsed.landed ?? parsed;
  } catch {
    return out;
  }
}

// The clipboard's image saved as a PNG in PASTE_DIR; its path. macOS only (AppleScript reads the clipboard).
export async function savePastedImage(now = new Date()) {
  if (window()?.platform !== "macos") throw new Error("Pasting an image works only on macOS for now.");
  await fs.mkdir(PASTE_DIR, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const path = `${PASTE_DIR}/paste-${stamp}.png`;
  const r = await exec("osascript", ["-e", `set p to POSIX file "${path}"`, "-e", "set f to open for access p with write permission",
    "-e", "set eof f to 0", "-e", "write (the clipboard as «class PNGf») to f", "-e", "close access f"]);
  if (r.code !== 0) throw new Error(/PNGf|can't make/i.test(r.stderr) ? "The clipboard holds no image." : (r.stderr || "Couldn't save the pasted image.").trim());
  return path;
}

// The files of the chat's folder for @ mentions: git's view when it is a repository, else every file (capped).
const LIST_FILES = 'cd "$1" && { git ls-files -co --exclude-standard 2>/dev/null || find . -type f -not -path "*/.git/*" | sed "s#^\\./##"; } | head -n 20000';
export async function listFiles(machine, folder) {
  const r = await exec("sh", ["-c", LIST_FILES, "sh", folder], { on: machine });
  if (r.code !== 0) throw failure(r, "listing files");
  return r.stdout.split("\n").filter(Boolean);
}

// FNV-1a: a stable short name for a cached image.
function fnv(text) {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h.toString(16);
}

// An image from the transcript (base64) as a file image() can draw: image() only reads inside the
// app folder, so it is written to data/t3-chat/img. Returns that path.
export async function displayableImage(picture) {
  const extension = picture.mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const name = `${IMAGE_DIR}/${fnv(picture.key)}.${extension}`;
  const target = `${appHome()}/${name}`;
  await fs.mkdir(`${appHome()}/${IMAGE_DIR}`, { recursive: true });
  if (!(await fs.exists(target))) await fs.writeFile(target, Buffer.from(picture.data, "base64"));
  return name;
}

// Where a new chat starts: a space's machine and the folder of its focused (else first) terminal.
// The space is the one holding tabId when given (a chat tab knows its own; focused() can lag
// right after a tab opens), else the shown one.
export function currentPlace(tabId = null) {
  const space = (tabId && spaces().find((s) => s.tabs.some((t) => t.id === tabId)))
    ?? spaces().find((s) => s.id === focused()?.space) ?? spaces().find((s) => s.active);
  if (!space) return null;
  const tabs = new Set(space.tabs.map((t) => t.id));
  const all = panes().filter((p) => tabs.has(p.tab) && p.cwd);
  const pane = all.find((p) => p.focused) ?? all.find((p) => p.tab === space.tabs.find((t) => t.active)?.id) ?? all[0];
  return { machine: space.machine ?? null, folder: pane?.cwd ?? space.folder ?? null, space: space.name };
}

export async function killTerminal(address) {
  await hcOk(["kill", address], "hc kill");
}

// The old bridge's chats (~/.herdr/chats/<id>) on that session: their runs must end before Claude Code resumes it.
export async function oldChatIds(machine, session) {
  const r = await exec("sh", ["-c", 'grep -l -F -- "$1" "$HOME"/.herdr/chats/*/meta.json 2>/dev/null | while read -r f; do basename "$(dirname "$f")"; done; exit 0', "sh", session], { on: machine });
  return r.stdout.split("\n").filter(Boolean);
}
