// Pure rules for whose lists a space or an agent shows in. Checked by `node context.test.mjs`.
// Which profile a machine, a folder or an account belongs to is profiles.py's answer (match).

// machine -> the profile it is dedicated to; any other machine is shared.
export function machineProfiles(profiles) {
  return Object.fromEntries(Object.entries(profiles).flatMap(([name, profile]) => profile.machines.map((machine) => [machine, name])));
}

// The shown profile: the saved one while it exists, else the first; null without profiles.
export function shownProfile(saved, names) {
  return names.includes(saved) ? saved : names[0] ?? null;
}

// A space: its coordinator's profile, else the one matched for its machine or folder.
// Null while unknown: shown in every profile.
export function spaceContext({ space, names, coordinators, matched }) {
  return names.find((name) => coordinators[name] === space.id) ?? matched ?? null;
}

// An agent: the profile matched for its machine or its own process, else its space's.
export function agentContext({ matched, spaceProfile }) {
  return matched ?? spaceProfile ?? null;
}

// Ids whose profile is known and not the shown one: lists hide them.
export function offContext(contextById, current) {
  return Object.entries(contextById).filter(([, context]) => context && context !== current).map(([id]) => id);
}
