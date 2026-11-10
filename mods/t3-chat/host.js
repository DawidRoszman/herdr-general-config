// IO for the chat. The agent is Claude Code itself, in a terminal of the chat's tab: started with
// hc run, typed to with hc send / hc keys, and read back from its own transcript file.
// machine null is this Mac.

import { exec, hc, appHome, home, spaces, panes, focused, window } from "herdr";
import { Buffer } from "buffer";
import * as fs from "fs/promises";
import { imageTarget } from "./markdown.js";
import { imageSize } from "./model.js";

const IMAGE_DIR = "data/t3-chat/img";
// IMAGE_DIR only holds copies: what a chat needs is made again from its transcript or source. So
// copies made over IMAGE_KEEP_DAYS ago go, and then the oldest while the rest is over IMAGE_CAP.
const IMAGE_KEEP_DAYS = 7;
const IMAGE_CAP = 256 * 1024 * 1024; // bytes
const PRUNE_IMAGES = `cd "$1" 2>/dev/null || exit 0
find . -type f -mtime +"$2" -delete
total=0
ls -t | while IFS= read -r f; do
  size=$(stat -f %z "$f" 2>/dev/null || stat -c %s "$f"); total=$((total + size))
  [ "$total" -gt "$3" ] && rm -f "$f"
done
exit 0`;
// Pruned once per load of this module, which every chat of the window shares (the window's start,
// a reload of the mod: views are made anew then), and every copy waits for it: so a prune never
// takes a file a chat draws. A prune that fails leaves the folder as it was.
let pruned = null;
const imagesPruned = () => (pruned ??= exec("sh", ["-c", PRUNE_IMAGES, "sh", `${appHome()}/${IMAGE_DIR}`, String(IMAGE_KEEP_DAYS), String(IMAGE_CAP)]).catch(() => null));
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

// isForced: typed even while Claude Code is blocked (it answers what it asks).
export async function sendText(address, text, isForced = false) {
  await hcOk(["send", ...(isForced ? ["--force"] : []), address, text], "hc send");
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

// At most this many of the transcript's bytes per read: exec returns at most 8 MiB, and transcripts
// with screenshots grow far past that. A single line (one message) must fit in it.
export const TRANSCRIPT_PAGE = 4 * 1024 * 1024;

// Up to TRANSCRIPT_PAGE of the transcript's bytes from offset on (as text; the model keeps whole lines).
export async function readFrom(machine, path, offset) {
  const r = await exec("sh", ["-c", 'tail -c "+$1" "$2" | head -c "$3"', "sh", String(offset + 1), path, String(TRANSCRIPT_PAGE)], { on: machine });
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

// The clipboard's attachment, as a local path: a copied file (Finder's) as it is, else its image
// saved as a PNG in PASTE_DIR. macOS only (AppleScript reads the clipboard). The folder is made
// with mkdir, not fs: a mod may write only inside the app folder (the PNG is osascript's to write).
export async function pastedAttachment(now = new Date()) {
  if (window()?.platform !== "macos") throw new Error("Pasting an attachment works only on macOS for now.");
  // Only a clipboard that holds a file: text would be taken as a path too.
  const file = await exec("osascript", ["-e", "repeat with kind in (clipboard info)", "-e", "if item 1 of kind is «class furl» then return POSIX path of (the clipboard as «class furl»)", "-e", "end repeat", "-e", 'return ""']);
  if (file.code === 0 && file.stdout.trim()) return file.stdout.trim();
  const made = await exec("mkdir", ["-p", PASTE_DIR]);
  if (made.code !== 0) throw failure(made, `making ${PASTE_DIR}`);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const path = `${PASTE_DIR}/paste-${stamp}.png`;
  const r = await exec("osascript", ["-e", `set p to POSIX file "${path}"`, "-e", "set f to open for access p with write permission",
    "-e", "set eof f to 0", "-e", "write (the clipboard as «class PNGf») to f", "-e", "close access f"]);
  if (r.code !== 0) throw new Error(/PNGf|can't make/i.test(r.stderr) ? "The clipboard holds no image or file." : (r.stderr || "Couldn't save the pasted image.").trim());
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

// How much of an image's start is read for its size: a JPEG's size comes after its EXIF (thumbnail
// included, at most 64 KiB), so this covers it. Reading only the start keeps whole pictures out of
// the mods' shared heap.
const IMAGE_HEAD = 256 * 1024;

// A file in the app folder (name: its path there) as { path, width, height }; rejects for a file
// that isn't an image it can size (a web page instead of a picture, say). head: its first bytes, when known.
async function drawable(name, head = null) {
  const size = imageSize(head ?? await fileHead(`${appHome()}/${name}`));
  if (!size?.width || !size?.height) throw new Error("not a PNG, JPEG, GIF or WebP image");
  return { path: name, ...size };
}

// A file's first IMAGE_HEAD bytes. Through base64: exec's output is text.
async function fileHead(path) {
  const r = await exec("sh", ["-c", 'head -c "$1" "$2" | base64', "sh", String(IMAGE_HEAD), path]);
  if (r.code !== 0) throw failure(r, "reading the image");
  return Buffer.from(r.stdout.replace(/\s/g, ""), "base64");
}

// An image from the transcript (base64) as a file image() can draw: image() only reads inside the
// app folder, so it is written to data/t3-chat/img. Returns { path, width, height }.
export async function displayableImage(picture) {
  const extension = picture.mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  await imagesPruned();
  const name = `${IMAGE_DIR}/${fnv(picture.key)}.${extension}`;
  const target = `${appHome()}/${name}`;
  await fs.mkdir(`${appHome()}/${IMAGE_DIR}`, { recursive: true });
  if (!(await fs.exists(target))) await fs.writeFile(target, Buffer.from(picture.data, "base64"));
  // The size from the start of the base64 it has (4 characters per 3 bytes), not the file.
  return drawable(name, Buffer.from(picture.data.slice(0, Math.floor(IMAGE_HEAD / 3) * 4), "base64"));
}

// An image a reply points at (imageTarget), as a file image() can draw: a file on this computer
// copied into IMAGE_DIR (with cp: a mod's fs reads only inside home), a web image downloaded
// there. { path, width, height, open }: open is what a click hands the system (the file, or the URL). Rejects
// with why it can't be shown. ponytail: cp and curl, so macOS and Linux; the copy is named by its
// source and made once per chat view, so a file rewritten later shows as it was until the chat reopens.
export async function referencedImage(src) {
  const { url, path } = imageTarget(src, home());
  const extension = ((url ?? path).replace(/[?#].*$/, "").match(/\.(png|jpe?g|gif|webp)$/i)?.[1] ?? "png").toLowerCase().replace("jpeg", "jpg");
  await imagesPruned();
  const name = `${IMAGE_DIR}/ref-${fnv(src)}.${extension}`;
  const target = `${appHome()}/${name}`;
  await fs.mkdir(`${appHome()}/${IMAGE_DIR}`, { recursive: true });
  const r = url ? await exec("curl", ["-fsSL", "--max-time", "20", "-o", target, url]) : await exec("cp", [path, target]);
  if (r.code !== 0) {
    const why = (r.stderr || "").trim();
    throw new Error(url ? `couldn't download it: ${why || `curl exit ${r.code}`}` : /no such file/i.test(why) ? "not found" : why || "couldn't read it");
  }
  return { ...(await drawable(name)), open: url ?? `file://${encodeURI(path)}` };
}

// Device pixels per px a mod writes, at zoom 1. ponytail: no API says, so a Mac is taken as Retina
// (2) and anything else as 1; a sharper copy than needed is only a little larger.
export const deviceScale = () => (window()?.platform === "macos" ? 2 : 1);

// A picture in the app folder ({ path, width, height }) resampled to at most maxPixels on its longer
// side, to be drawn at that many device pixels: the GPU's own scaling of a much larger picture
// looks rough. The original's path when it is no bigger, or when sips (macOS) can't make the copy:
// it still draws, only less sharp. Copies are kept next to it.
export async function resampled(picture, maxPixels) {
  const pixels = Math.ceil(maxPixels);
  if (Math.max(picture.width, picture.height) <= pixels) return picture.path;
  await imagesPruned();
  const name = picture.path.replace(/(\.\w+)$/, `-${pixels}$1`);
  const target = `${appHome()}/${name}`;
  if (await fs.exists(target)) return name;
  const r = await exec("sips", ["-Z", String(pixels), `${appHome()}/${picture.path}`, "--out", target]).catch(() => null);
  return r?.code === 0 ? name : picture.path;
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
