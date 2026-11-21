import { terminals, spaces, panes, shared, readTextFile, appHome } from "herdr";

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

const MARK = { pi: /^π - /u, opencode: /^OC \| / };
const OWN = {
  pi: (s, folder) => { s = s.replace(MARK.pi, ""); return folder && s.endsWith(` - ${folder}`) ? s.slice(0, -folder.length - 3) : s; },
  opencode: (s) => s.replace(MARK.opencode, ""),
};

const TASK_FOLDER = /\/\.herdr\/projects\/[^/]+\/([^/]+)/;

function placeOf(branch, cwd) {
  return branch || cwd.match(TASK_FOLDER)?.[1] || "";
}

const modTitles = new Map();
function modTitle(mod) {
  if (!modTitles.has(mod)) {
    modTitles.set(mod, "");
    readTextFile(`${appHome()}/mods/${mod}/mod.json`)
      .then((text) => modTitles.set(mod, (text && JSON.parse(text).title) || ""))
      .catch(() => {});
  }
  return modTitles.get(mod);
}

export const programOf = (x) => x.mod ? shared(`${x.mod}.program`) ?? null : x.program;

export const modStatus = (x) => shared(`${x.mod}.status`)?.[x.tab] ?? null;

export function namer() {
  const term = new Map(terminals().map((k) => [k.address, k]));
  const tabs = new Map(spaces().flatMap((s) => s.tabs.map((c) => [c.id, { ...c, space: s.name }])));
  const branches = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p.branch]));

  const isProgramName = (name, program) => [program?.name, program?.key].some((n) => n && n.toLowerCase() === name.toLowerCase());
  return (x) => {

    if (x.mod) {
      const tab = tabs.get(x.tab);
      return shared(`${x.mod}.titles`)?.[x.tab] || (tab?.named && tab.name) || modTitle(x.mod) || x.title;
    }
    const address = x.address ?? x.terminal;
    const tab = tabs.get(x.tab);

    const cwd = term.get(address)?.cwd ?? x.cwd ?? "";
    const folder = cwd.split(/[\\/]/).pop();
    const own = OWN[x.program?.key];

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
