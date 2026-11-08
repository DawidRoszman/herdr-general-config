// Pure helpers for the keybinds tab. Checked by `node rows.test.mjs`.

// Friendlier names for dialogs that keys open with mod.open.
const MOD_NAMES = {
  multirepo: "Multirepo dialog", "port-forward": "Port forward", simulator: "Simulator", picker: "Go to space or tab",
  "wt-new": "New worktree", "wt-open": "Open worktree", "wt-remove": "Remove worktree",
};
const SECTION_TITLES = { global: "Everywhere", terminal: "In a terminal" };

// What a keys.json action does, in words (Herdr's help words for plain commands).
export function describe(action) {
  const binding = typeof action === "string" && action.startsWith("{") ? JSON.parse(action) : action;
  if (binding && typeof binding === "object") {
    const { command, args = {} } = binding;
    if (command === "tab.new" && args.mod) return `Open ${args.name ?? args.mod} in a new tab`;
    if (command === "pane.split" && args.mod) return `Open ${args.mod} beside the focused pane`;
    return `${command.replace(/[._]/g, " ")} ${JSON.stringify(args)}`;
  }
  if (action.startsWith("send:")) return `type ${JSON.stringify(action.slice(5))}`;
  const [name, arg] = action.split(/:(.*)/s);
  if (name === "mod.open") return `Open ${MOD_NAMES[arg] ?? arg}`;
  const words = name.replace(/[._]/g, " ");
  return arg ? `${words} ${arg}` : words;
}

// One flat list: Herdr's keys.json sections first, then each view's own keys.
// Row kinds: "group" (a source), "section" (a part of it), "key".
export function keyRows(bound, views) {
  const rows = [];
  const sections = [...new Set(bound.map((k) => k.section))];
  if (sections.length) rows.push({ kind: "group", text: "Shortcuts (keys.json)" });
  for (const section of sections) {
    const title = SECTION_TITLES[section] ?? section.replace(/^(layout|mod):/, (_m, kind) => (kind === "layout" ? "Layout " : "Mod "));
    rows.push({ kind: "section", text: title });
    for (const k of bound.filter((b) => b.section === section)) rows.push({ kind: "key", keys: k.keys, what: describe(k.action) });
  }
  for (const view of views) {
    rows.push({ kind: "group", text: view.title });
    for (const section of view.sections) {
      rows.push({ kind: "section", text: section.title });
      for (const [keys, what] of section.rows) rows.push({ kind: "key", keys, what });
    }
  }
  return rows.map((row, i) => ({ ...row, id: String(i) }));
}

// Key rows matching the query, each kept under its group and section titles.
export function filterRows(rows, query) {
  if (!query) return rows;
  const out = [];
  let group = null;
  let section = null;
  for (const row of rows) {
    if (row.kind === "group") { group = row; section = null; continue; }
    if (row.kind === "section") { section = row; continue; }
    if (!`${row.keys} ${row.what} ${group?.text ?? ""} ${section?.text ?? ""}`.toLowerCase().includes(query)) continue;
    if (group && !out.includes(group)) out.push(group);
    if (section && !out.includes(section)) out.push(section);
    out.push(row);
  }
  return out;
}
