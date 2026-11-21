export function secretText(reference) {
  if (!reference) return "";
  return reference.env ?? JSON.stringify(reference.command);
}

export function secretOf(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("[")) return { env: trimmed };
  let command;
  try { command = JSON.parse(trimmed); } catch { throw new Error(`a command is a JSON list, e.g. ["pass", "show", "jira"]: ${trimmed}`); }
  return { command };
}

export function portableFolder(folder, appHome, home) {
  if (folder.startsWith(`${appHome}/`)) return folder.slice(appHome.length + 1);
  if (folder === home || folder.startsWith(`${home}/`)) return `~${folder.slice(home.length)}`;
  return folder;
}

export function writtenProjects(projects, appHome, home) {
  return Object.fromEntries(Object.entries(projects ?? {}).map(([name, project]) => {
    const written = { label: project.label };
    if (project.jira.length) written.jira = [...project.jira];
    if (project.places.length) {
      written.places = project.places.map((place) => (place.machine
        ? { machine: place.machine, root: place.root } : { root: portableFolder(place.root, appHome, home) }));
    }
    if (project.coordinator) written.coordinator = { folder: portableFolder(project.coordinator.folder, appHome, home) };
    return [name, written];
  }));
}

export function projectLines(projects) {
  return Object.values(projects).map((project) => [
    project.label,
    ...(project.jira ?? []),
    (project.places ?? []).map((place) => place.machine ?? "this computer").join(", "),
    project.coordinator ? "coordinator" : "no coordinator",
  ].filter(Boolean).join(" · "));
}

export function toDraft(name, profile, providers, { appHome, home }) {
  return {
    name,
    isNew: false,
    label: profile.label,
    badge: profile.badge === profile.label ? "" : profile.badge,
    color: profile.color ?? "",
    machines: [...profile.machines],
    folders: [...profile.folders],
    projects: writtenProjects(profile.projects, appHome, home),
    reviewer: profile.agents.reviewer ?? "",
    agentMachines: Object.fromEntries(Object.entries(profile.agents.machines ?? {}).map(([machine, allowed]) => [machine, [...allowed]])),
    accounts: Object.fromEntries(Object.entries(profile.accounts).map(([provider, settings]) => [provider,
      Object.fromEntries(Object.keys(providers[provider]?.fields ?? {}).map((field) =>
        [field, providers[provider].fields[field] ? secretText(settings[field]) : settings[field] ?? ""]))])),
  };
}

export function newDraft() {
  return { name: "", isNew: true, label: "", badge: "", color: "", machines: [], folders: [], projects: {}, reviewer: "", agentMachines: {}, accounts: {} };
}

export const LOCAL_MACHINE = "local";

export function duplicateOf(draft) {
  return { ...draft, name: "", isNew: true, label: `${draft.label} copy`, machines: [], folders: [], projects: {},
    agentMachines: ownAgentMachines({ ...draft, machines: [] }),
    accounts: JSON.parse(JSON.stringify(draft.accounts)) };
}

export function ownAgentMachines(draft) {
  const own = new Set([LOCAL_MACHINE, ...draft.machines]);
  return Object.fromEntries(Object.entries(draft.agentMachines ?? {}).filter(([machine]) => own.has(machine)).map(([machine, allowed]) => [machine, [...allowed]]));
}

export function toProfile(draft, providers) {
  const profile = { label: draft.label.trim() };
  if (draft.badge.trim()) profile.badge = draft.badge.trim();
  if (draft.color) profile.color = draft.color;
  if (draft.machines.length) profile.machines = draft.machines;
  const folders = draft.folders.map((folder) => folder.trim()).filter(Boolean);
  if (folders.length) profile.folders = folders;
  if (Object.keys(draft.projects).length) profile.projects = draft.projects;
  const agents = {};
  if (draft.reviewer) agents.reviewer = draft.reviewer;

  const agentMachines = ownAgentMachines(draft);
  if (Object.keys(agentMachines).length) agents.machines = agentMachines;
  if (Object.keys(agents).length) profile.agents = agents;
  const accounts = Object.fromEntries(Object.entries(draft.accounts).map(([provider, settings]) => [provider,
    Object.fromEntries(Object.entries(settings).map(([field, text]) =>
      [field, providers[provider]?.fields[field] ? secretOf(text) : text.trim() || null]))]));
  if (Object.keys(accounts).length) profile.accounts = accounts;
  return profile;
}

export function moved(names, name, by) {
  const from = names.indexOf(name), to = Math.max(0, Math.min(names.length - 1, from + by));
  const rest = names.filter((other) => other !== name);
  return [...rest.slice(0, to), name, ...rest.slice(to)];
}

export function takenMachines(profiles, name) {
  return Object.fromEntries(Object.entries(profiles).filter(([other]) => other !== name)
    .flatMap(([other, profile]) => profile.machines.map((machine) => [machine, profile.label ?? other])));
}

export function errorLines(stderr, name) {
  return stderr.split("\n").map((line) => line.replace(/^profiles: /, "").trim()).filter(Boolean)
    .map((line) => line.replace(`profiles.${name}.`, ""));
}
