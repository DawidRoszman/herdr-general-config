// Pure rules of the profile dialog: a profile as the form holds it (a draft: texts and lists), and
// back as profiles.json takes it. Checked by `node draft.test.mjs`.

// A secret is kept as a reference, never a value: the name of a variable, or a command as a JSON list.
export function secretText(reference) {
  if (!reference) return "";
  return reference.env ?? JSON.stringify(reference.command);
}

// The reference a secret field's text stands for; null when empty. Throws on a "[" that isn't a JSON list.
export function secretOf(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("[")) return { env: trimmed };
  let command;
  try { command = JSON.parse(trimmed); } catch { throw new Error(`a command is a JSON list, e.g. ["pass", "show", "jira"]: ${trimmed}`); }
  return { command };
}

// A folder as profiles.json should hold it: inside the app home relative, inside home with ~, so
// the file names nobody's home.
export function portableFolder(folder, appHome, home) {
  if (folder.startsWith(`${appHome}/`)) return folder.slice(appHome.length + 1);
  if (folder === home || folder.startsWith(`${home}/`)) return `~${folder.slice(home.length)}`;
  return folder;
}

export const coordinatorFolderOf = (name) => `coordinators/${name}`;

// A listed profile (profiles.py list) as the form's draft. providers: name -> { fields: { field: isSecret } }.
export function toDraft(name, profile, providers, { appHome, home }) {
  return {
    name,
    isNew: false,
    label: profile.label,
    badge: profile.badge === profile.label ? "" : profile.badge,
    color: profile.color ?? "",
    machines: [...profile.machines],
    folders: [...profile.folders], // one text each: a folder's name can hold any character, a comma too
    coordinatorFolder: profile.coordinator ? portableFolder(profile.coordinator.folder, appHome, home) : "",
    reviewer: profile.agents.reviewer ?? "",
    forbidden: [...profile.agents.forbidden],
    accounts: Object.fromEntries(Object.entries(profile.accounts).map(([provider, settings]) => [provider,
      Object.fromEntries(Object.keys(providers[provider]?.fields ?? {}).map((field) =>
        [field, providers[provider].fields[field] ? secretText(settings[field]) : settings[field] ?? ""]))])),
  };
}

export function newDraft() {
  return { name: "", isNew: true, label: "", badge: "", color: "", machines: [], folders: [], coordinatorFolder: "", reviewer: "", forbidden: [], accounts: {} };
}

// A copy to start a new profile from: what can only be one profile's (machines, folders, the
// coordinator) is left out.
export function duplicateOf(draft) {
  return { ...draft, name: "", isNew: true, label: `${draft.label} copy`, machines: [], folders: [], coordinatorFolder: "",
    forbidden: [...draft.forbidden], accounts: JSON.parse(JSON.stringify(draft.accounts)) };
}

// The draft as profiles.json's profile: only what is set. An account stays even when every field is
// empty (a Claude account with no config dir is the default one).
export function toProfile(draft, providers) {
  const profile = { label: draft.label.trim() };
  if (draft.badge.trim()) profile.badge = draft.badge.trim();
  if (draft.color) profile.color = draft.color;
  if (draft.machines.length) profile.machines = draft.machines;
  const folders = draft.folders.map((folder) => folder.trim()).filter(Boolean);
  if (folders.length) profile.folders = folders;
  if (draft.coordinatorFolder) profile.coordinator = { folder: draft.coordinatorFolder };
  const agents = {};
  if (draft.reviewer) agents.reviewer = draft.reviewer; // "": this profile uses no reviewer
  if (draft.forbidden.length) agents.forbidden = draft.forbidden;
  if (Object.keys(agents).length) profile.agents = agents;
  const accounts = Object.fromEntries(Object.entries(draft.accounts).map(([provider, settings]) => [provider,
    Object.fromEntries(Object.entries(settings).map(([field, text]) =>
      [field, providers[provider]?.fields[field] ? secretOf(text) : text.trim() || null]))]));
  if (Object.keys(accounts).length) profile.accounts = accounts;
  return profile;
}

// names with one moved by `by` places (-1: earlier), kept inside the list.
export function moved(names, name, by) {
  const from = names.indexOf(name), to = Math.max(0, Math.min(names.length - 1, from + by));
  const rest = names.filter((other) => other !== name);
  return [...rest.slice(0, to), name, ...rest.slice(to)];
}

// machine -> the other profile that has it: it can't be picked here.
export function takenMachines(profiles, name) {
  return Object.fromEntries(Object.entries(profiles).filter(([other]) => other !== name)
    .flatMap(([other, profile]) => profile.machines.map((machine) => [machine, profile.label ?? other])));
}

// "profiles: profiles.work.label: needed, a text" lines -> ["label: needed, a text"] for this profile, others whole.
export function errorLines(stderr, name) {
  return stderr.split("\n").map((line) => line.replace(/^profiles: /, "").trim()).filter(Boolean)
    .map((line) => line.replace(`profiles.${name}.`, ""));
}
