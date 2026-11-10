// What a terminal is on, one rule for Inbox cards, the agents list, tabs and pane headers:
// its Pi session while Pi runs, then (agents only) a tab someone named (more than the program's name), then (agents only) what it works on
// (placeOf), then a telling terminal title, then (agents only) its space, else the program.
// A terminal with no title of its own reports its address (t9) as one: that tells nothing.
import { terminals, spaces, panes, shared, readTextFile, appHome } from "herdr";

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
// Agents' own title marks, by program (the key their status report names): Pi's "π - <session> - <folder>",
// OpenCode's "OC | <session>". Only theirs come off: another agent's title that happens to look alike stays.
const MARK = { pi: /^π - /u, opencode: /^OC \| / };
const OWN = {
  pi: (s, folder) => { s = s.replace(MARK.pi, ""); return folder && s.endsWith(` - ${folder}`) ? s.slice(0, -folder.length - 3) : s; },
  opencode: (s) => s.replace(MARK.opencode, ""),
};

// A multirepo task's folder, as mr.py makes it: ~/.herdr/projects/<project>/<branch slug>.
const TASK_FOLDER = /\/\.herdr\/projects\/[^/]+\/([^/]+)/;

// What an agent works on, so several of one program tell apart: its checkout's branch, else the multirepo
// task its folder is in (named as its folder). A multirepo project's root has neither: its space, named
// after the project, comes in later.
function placeOf(branch, cwd) {
  return branch || cwd.match(TASK_FOLDER)?.[1] || "";
}

// A mod's "title" from its mod.json, read once per mod (a handful); "" until read or without one.
const modTitles = new Map();
function modTitle(mod) {
  if (!modTitles.has(mod)) {
    modTitles.set(mod, "");
    readTextFile(`${appHome()}/mods/${mod}/mod.json`)
      .then((text) => modTitles.set(mod, (text && JSON.parse(text).title) || ""))
      .catch(() => {}); // no mod.json or no title: the pane keeps Herdr's title
  }
  return modTitles.get(mod);
}

// What a pane runs, for its icon: its program, or for a mod pane what its mod gives in shared("<mod>.program") ({ icon, tint }).
export const programOf = (x) => x.mod ? shared(`${x.mod}.program`) ?? null : x.program;

// What a mod pane reports of its tab in shared("<mod>.status"), as the word an agent would.
export const modStatus = (x) => shared(`${x.mod}.status`)?.[x.tab] ?? null;

// Snapshot once per render; the returned function takes an agent or a pane (status set = an agent).
export function namer() {
  const term = new Map(terminals().map((k) => [k.address, k]));
  const tabs = new Map(spaces().flatMap((s) => s.tabs.map((c) => [c.id, { ...c, space: s.name }])));
  const branches = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p.branch]));
  // A program's own name, as a tab opened for it is often called ("claude"): it says what the icon does.
  const isProgramName = (name, program) => [program?.name, program?.key].some((n) => n && n.toLowerCase() === name.toLowerCase());
  return (x) => {
    // A mod pane goes by the title its mod gives it in shared("<mod>.titles"), keyed by its tab; else its tab's name
    // when someone gave it one; else the title in its mod.json. Never the mod's id, which is what Herdr gives as its title.
    if (x.mod) {
      const tab = tabs.get(x.tab);
      return shared(`${x.mod}.titles`)?.[x.tab] || (tab?.named && tab.name) || modTitle(x.mod) || x.title;
    }
    const address = x.address ?? x.terminal;
    const tab = tabs.get(x.tab);
    // A title that only names the folder (Codex's project, Pi with no session) says what the space already does.
    const cwd = term.get(address)?.cwd ?? x.cwd ?? "";
    const folder = cwd.split(/[\\/]/).pop();
    const own = OWN[x.program?.key];
    // An agent's session and title outlive it: lazygit, started after Pi in the same shell, sets no title and
    // would read as Pi's session. Not an agent and in an agent's marks, the title is one left behind.
    const left = !x.program?.agent && Object.values(MARK).some((m) => m.test(clean(x.title)));
    const live = left ? "" : own ? own(clean(x.title), folder) : clean(x.title);
    const telling = live && live !== x.program?.name && live.toLowerCase() !== x.program?.key
      && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live !== address
      && live !== folder && live !== (x.space_name ?? tab?.space);
    const isAgent = x.status != null;
    return (x.program?.key === "pi" && term.get(address)?.labels?.["pi.session"]) || (isAgent && tab?.named && !isProgramName(tab.name, x.program) && tab.name)
      || (isAgent && placeOf(x.branch ?? branches.get(address), cwd)) || (telling && live)
      || (isAgent && (x.space_name ?? tab?.space)) || x.program?.name || address || "shell";
  };
}
