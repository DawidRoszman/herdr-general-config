import { exec, hc, appHome, home, spaces, panes, focused, window } from "herdr";
import { Buffer } from "buffer";
import * as fs from "fs/promises";
import { imageTarget } from "./markdown.js";
import { imageSize } from "./model.js";

const IMAGE_DIR = "data/t3-chat/img";

const IMAGE_KEEP_DAYS = 7;
const IMAGE_CAP = 256 * 1024 * 1024;
const PRUNE_IMAGES = `cd "$1" 2>/dev/null || exit 0
find . -type f -mtime +"$2" -delete
total=0
ls -t | while IFS= read -r f; do
  size=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f"); total=$((total + size))
  [ "$total" -gt "$3" ] && rm -f "$f"
done
exit 0`;

let pruned = null;
const imagesPruned = () => (pruned ??= exec("sh", ["-c", PRUNE_IMAGES, "sh", `${appHome()}/${IMAGE_DIR}`, String(IMAGE_KEEP_DAYS), String(IMAGE_CAP)]).catch(() => null));

const PASTE_DIR = `${home()}/.herdr/attachments`;

export const machineLabel = (machine) => machine ?? (window()?.platform === "macos" ? "this Mac" : "this computer");

function failure(r, what) {
  return new Error((r.stderr || r.stdout || `${what} failed (exit ${r.code})`).trim());
}

async function hcOk(args, what) {
  const r = await hc(args);
  if (r.code !== 0) throw failure(r, what);
  return r.stdout;
}

const IN_LOGIN_SHELL = 'exec "${SHELL:-/bin/sh}" -lic \'exec "$@"\' sh "$@"';

const SESSION_LABEL = "t3-chat.session";

export async function startClaude(machine, folder, session, place, isResume, argv = ["claude"]) {
  const out = await hcOk(["run", "--bg", "--json", "--no-parent",
    "--label", `herdr.space=${place.space}`, "--label", `herdr.tab=${place.tab}`, "--label", `${SESSION_LABEL}=${session}`, ...(machine ? ["--on", machine] : []),
    "--cwd", folder, "--", "sh", "-c", IN_LOGIN_SHELL, "sh", ...argv, isResume ? "--resume" : "--session-id", session], "hc run");
  return JSON.parse(out).address;
}

export async function adopt(address, place) {
  await hcOk(["label", address, `herdr.space=${place.space}`, `herdr.tab=${place.tab}`], "hc label");
}

export async function runningSession(machine, session) {
  const { terminals } = JSON.parse(await hcOk(["ls", "--json", "--label", `${SESSION_LABEL}=${session}`], "hc ls"));
  const prefix = machine ? `${machine}/` : "";
  return terminals.find((t) => t.state === "live" && (machine ? t.address.startsWith(prefix) : !t.address.includes("/")))?.address ?? null;
}

const SESSION_OF = 'for pid in "$@"; do for f in "$HOME"/.claude*/sessions/"$pid".json ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"/sessions/"$pid".json}; do [ -f "$f" ] && { cat "$f"; exit 0; }; done; done; exit 0';
export async function sessionOfTerminal(machine, address) {
  const info = JSON.parse(await hcOk(["get", address, "--json"], "hc get"));
  const pids = [info.foreground?.pid, info.pid].filter(Boolean).map(String);
  if (!pids.length) return null;
  const r = await exec("sh", ["-c", SESSION_OF, "sh", ...pids], { on: machine });
  if (r.code !== 0 || !r.stdout.trim()) return null;
  return JSON.parse(r.stdout).sessionId ?? null;
}

export async function labelSession(address, session) {
  await hcOk(["label", address, `${SESSION_LABEL}=${session}`], "hc label");
}

export async function sendText(address, text, isForced = false) {
  await hcOk(["send", ...(isForced ? ["--force"] : []), address, text], "hc send");
}

export async function pressKeys(address, ...keys) {
  await hcOk(["keys", address, ...keys], "hc keys");
}

export async function readScreen(address) {
  return hcOk(["read", address], "hc read");
}

const FIND = 'for f in "$HOME"/.claude*/projects/*/"$1".jsonl ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"/projects/*/"$1".jsonl}; do [ -f "$f" ] && { echo "$f"; exit 0; }; done; exit 0';
export async function findTranscript(machine, session) {
  const r = await exec("sh", ["-c", FIND, "sh", session], { on: machine });
  if (r.code !== 0) throw failure(r, "finding the transcript");
  return r.stdout.trim() || null;
}

export const TRANSCRIPT_PAGE = 4 * 1024 * 1024;

export async function readFrom(machine, path, offset) {
  const r = await exec("sh", ["-c", 'tail -c "+$1" "$2" | head -c "$3"', "sh", String(offset + 1), path, String(TRANSCRIPT_PAGE)], { on: machine });
  if (r.code !== 0) throw failure(r, "reading the transcript");
  return r.stdout;
}

export const byteLength = (text) => Buffer.byteLength(text);

export async function oldChat(machine, id) {
  const r = await exec("sh", ["-c", 'cat "$HOME/.herdr/chats/$1/meta.json"', "sh", id], { on: machine });
  if (r.code !== 0) return null;
  const meta = JSON.parse(r.stdout);
  return meta.sessionId ? { session: meta.sessionId, folder: meta.folder, title: meta.title ?? "" } : null;
}

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

const LINUX_PASTE_IMAGE = `
if command -v wl-paste >/dev/null 2>&1; then
  types=$(wl-paste --list-types 2>/dev/null)
  if printf '%s\\n' "$types" | grep -qx 'text/uri-list'; then
    uri=$(wl-paste --type text/uri-list 2>/dev/null | grep -m1 '^file://')
    if [ -n "$uri" ]; then printf 'file:%s\\n' "$uri"; exit 0; fi
  fi
  if printf '%s\\n' "$types" | grep -qx 'image/png'; then
    wl-paste --type image/png > "$1" && printf 'png\\n' && exit 0
  fi
  exit 2
elif command -v xclip >/dev/null 2>&1; then
  types=$(xclip -selection clipboard -t TARGETS -o 2>/dev/null)
  if printf '%s\\n' "$types" | grep -qx 'text/uri-list'; then
    uri=$(xclip -selection clipboard -t text/uri-list -o 2>/dev/null | grep -m1 '^file://')
    if [ -n "$uri" ]; then printf 'file:%s\\n' "$uri"; exit 0; fi
  fi
  if printf '%s\\n' "$types" | grep -qx 'image/png'; then
    xclip -selection clipboard -t image/png -o > "$1" && printf 'png\\n' && exit 0
  fi
  exit 2
fi
echo "Install wl-clipboard (Wayland) or xclip (X11) to paste images." >&2
exit 3
`;

export async function pastedAttachment(now = new Date()) {
  const platform = window()?.platform;
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const path = `${PASTE_DIR}/paste-${stamp}.png`;
  if (platform === "linux") {
    const made = await exec("mkdir", ["-p", PASTE_DIR]);
    if (made.code !== 0) throw failure(made, `making ${PASTE_DIR}`);
    const r = await exec("sh", ["-c", LINUX_PASTE_IMAGE, "sh", path]);
    if (r.code === 0) {
      const out = r.stdout.trim();
      if (out.startsWith("file:file://")) return decodeURIComponent(out.slice("file:file://".length));
      if (out === "png") return path;
    }
    if (r.code === 2) throw new Error("The clipboard holds no image or file.");
    throw new Error((r.stderr || "Couldn't read the clipboard.").trim());
  }
  if (platform !== "macos") throw new Error("Pasting an attachment works only on macOS and Linux for now.");

  const file = await exec("osascript", ["-e", "repeat with kind in (clipboard info)", "-e", "if item 1 of kind is «class furl» then return POSIX path of (the clipboard as «class furl»)", "-e", "end repeat", "-e", 'return ""']);
  if (file.code === 0 && file.stdout.trim()) return file.stdout.trim();
  const made = await exec("mkdir", ["-p", PASTE_DIR]);
  if (made.code !== 0) throw failure(made, `making ${PASTE_DIR}`);
  const r = await exec("osascript", ["-e", `set p to POSIX file "${path}"`, "-e", "set f to open for access p with write permission",
    "-e", "set eof f to 0", "-e", "write (the clipboard as «class PNGf») to f", "-e", "close access f"]);
  if (r.code !== 0) throw new Error(/PNGf|can't make/i.test(r.stderr) ? "The clipboard holds no image or file." : (r.stderr || "Couldn't save the pasted image.").trim());
  return path;
}

const LIST_FILES = `cd "$1" || exit 1
if git rev-parse --git-dir >/dev/null 2>&1; then git ls-files -co --exclude-standard
else
  for f in *; do
    if [ -e "$f/.git" ]; then git -C "$f" ls-files -co --exclude-standard | sed "s#^#$f/#"
    elif [ -d "$f" ]; then find "$f" -type f -not -path "*/.git/*" -not -path "*/node_modules/*"
    elif [ -f "$f" ]; then echo "$f"; fi
  done
fi | head -n 20000`;
export async function listFiles(machine, folder) {
  const r = await exec("sh", ["-c", LIST_FILES, "sh", folder], { on: machine });
  if (r.code !== 0) throw failure(r, "listing files");
  return r.stdout.split("\n").filter(Boolean);
}

function fnv(text) {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h.toString(16);
}

const IMAGE_HEAD = 256 * 1024;

async function drawable(name, head = null) {
  const size = imageSize(head ?? await fileHead(`${appHome()}/${name}`));
  if (!size?.width || !size?.height) throw new Error("not a PNG, JPEG, GIF or WebP image");
  return { path: name, ...size };
}

async function fileHead(path) {
  const r = await exec("sh", ["-c", 'head -c "$1" "$2" | base64', "sh", String(IMAGE_HEAD), path]);
  if (r.code !== 0) throw failure(r, "reading the image");
  return Buffer.from(r.stdout.replace(/\s/g, ""), "base64");
}

export async function displayableImage(picture) {
  const extension = picture.mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  await imagesPruned();
  const name = `${IMAGE_DIR}/${fnv(picture.key)}.${extension}`;
  const target = `${appHome()}/${name}`;
  await fs.mkdir(`${appHome()}/${IMAGE_DIR}`, { recursive: true });
  if (!(await fs.exists(target))) await fs.writeFile(target, Buffer.from(picture.data, "base64"));

  return drawable(name, Buffer.from(picture.data.slice(0, Math.floor(IMAGE_HEAD / 3) * 4), "base64"));
}

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

export const deviceScale = () => (window()?.platform === "macos" ? 2 : 1);

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

export async function oldChatIds(machine, session) {
  const r = await exec("sh", ["-c", 'grep -l -F -- "$1" "$HOME"/.herdr/chats/*/meta.json 2>/dev/null | while read -r f; do basename "$(dirname "$f")"; done; exit 0', "sh", session], { on: machine });
  return r.stdout.split("\n").filter(Boolean);
}
