// Is there a newer Blueprint? At most once a day one Blueprint reads the
// version in the repository's mod.json (one small GET to GitHub, nothing sent
// but the request) and every Blueprint shares the answer in shared state.
// Updating is left to the person's agent (see updatePrompt): it reads the new
// files before it puts them in, as Herdr has agents do for any mod.
//
//   herdr-app do blueprint.update-check-off   never ask GitHub again
//   herdr-app do blueprint.update-check-on    ask again (and now)

import { appHome, readTextFile, shared, setShared } from "herdr";
import { slashes } from "./store.js";

export const REPO = "https://github.com/chappse6/herdr-blueprint-app";
const REMOTE = "https://raw.githubusercontent.com/chappse6/herdr-blueprint-app/master/mods/blueprint/mod.json";
const KEY = "blueprint.update";
const FORK = true;
const DAY = 86400000, HOUR = 3600000;

/** a > b, comparing dotted numbers ("0.10.0" > "0.9.2"); junk is never newer. */
export function newer(a, b) {
  const pa = String(a ?? "").split("."), pb = String(b ?? "").split(".");
  if (!pa.every((x) => /^\d+$/.test(x)) || !pb.every((x) => /^\d+$/.test(x))) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = Number(pa[i] ?? 0) - Number(pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** This copy's version, from its own mod.json. */
export async function installedVersion() {
  try {
    const text = await readTextFile(`${slashes(appHome())}/mods/blueprint/mod.json`);
    return JSON.parse(text ?? "{}").version ?? null;
  } catch (_) {
    return null;
  }
}

/** The shared answer: { checked, latest, off }. Asks GitHub when a day old. */
export async function checkUpdate(now = Date.now()) {
  // FORK: this copy adds remote-machine support (store.js, main.js "FORK"); an
  // upstream update would replace it, so the check never runs.
  if (FORK) return { off: true };
  const known = shared(KEY) ?? {};
  if (known.off || now - (known.checked ?? 0) < DAY) return known;
  // Marked as checked first, so other Blueprints starting now don't ask too.
  setShared(KEY, { ...known, checked: now });
  // Why the last check failed stays in `error`, for whoever wonders why no
  // button shows (herdr-app's shared state, key blueprint.update).
  try {
    const res = await fetch(REMOTE);
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const latest = (await res.json())?.version ?? null;
    const next = { ...known, checked: now, latest, error: null };
    setShared(KEY, next);
    return next;
  } catch (err) {
    // A failed request is asked again in an hour, not a day.
    const next = { ...known, checked: now - DAY + HOUR, error: String(err?.message ?? err) };
    setShared(KEY, next);
    return next;
  }
}

export function setUpdateCheck(on) {
  const known = shared(KEY) ?? {};
  setShared(KEY, on ? { ...known, off: false, checked: 0 } : { ...known, off: true });
}

/** What the agent is asked when the person clicks the update button. */
export function updatePrompt(latest, current) {
  const home = slashes(appHome());
  return `Update the Blueprint mod of this Herdr app to ${latest} (installed: ${current ?? "unknown"}). Read ${home}/AGENTS.md first. Then replace the files in ${home}/mods/blueprint with those in mods/blueprint/ of ${REPO} (branch master): it is the same mod, so overwrite it rather than adding a renamed copy, and leave keys.json and the layouts as they are. Run \`herdr-app check ${home}/mods/blueprint\`, then tell me in a few lines what changed since ${current ?? "the installed version"} (the commit history of the repository says).`;
}
