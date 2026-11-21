import { appHome, readTextFile, shared, setShared } from "herdr";
import { slashes } from "./store.js";

export const REPO = "https://github.com/chappse6/herdr-blueprint-app";
const REMOTE = "https://raw.githubusercontent.com/chappse6/herdr-blueprint-app/master/mods/blueprint/mod.json";
const KEY = "blueprint.update";
const FORK = true;
const DAY = 86400000, HOUR = 3600000;

export function newer(a, b) {
  const pa = String(a ?? "").split("."), pb = String(b ?? "").split(".");
  if (!pa.every((x) => /^\d+$/.test(x)) || !pb.every((x) => /^\d+$/.test(x))) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = Number(pa[i] ?? 0) - Number(pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

export async function installedVersion() {
  try {
    const text = await readTextFile(`${slashes(appHome())}/mods/blueprint/mod.json`);
    return JSON.parse(text ?? "{}").version ?? null;
  } catch (_) {
    return null;
  }
}

export async function checkUpdate(now = Date.now()) {

  if (FORK) return { off: true };
  const known = shared(KEY) ?? {};
  if (known.off || now - (known.checked ?? 0) < DAY) return known;

  setShared(KEY, { ...known, checked: now });

  try {
    const res = await fetch(REMOTE);
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const latest = (await res.json())?.version ?? null;
    const next = { ...known, checked: now, latest, error: null };
    setShared(KEY, next);
    return next;
  } catch (err) {

    const next = { ...known, checked: now - DAY + HOUR, error: String(err?.message ?? err) };
    setShared(KEY, next);
    return next;
  }
}

export function setUpdateCheck(on) {
  const known = shared(KEY) ?? {};
  setShared(KEY, on ? { ...known, off: false, checked: 0 } : { ...known, off: true });
}

export function updatePrompt(latest, current) {
  const home = slashes(appHome());
  return `Update the Blueprint mod of this Herdr app to ${latest} (installed: ${current ?? "unknown"}). Read ${home}/AGENTS.md first. Then replace the files in ${home}/mods/blueprint with those in mods/blueprint/ of ${REPO} (branch master): it is the same mod, so overwrite it rather than adding a renamed copy, and leave keys.json and the layouts as they are. Run \`herdr-app check ${home}/mods/blueprint\`, then tell me in a few lines what changed since ${current ?? "the installed version"} (the commit history of the repository says).`;
}
