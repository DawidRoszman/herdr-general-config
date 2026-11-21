export function machineProfiles(profiles, hosts = {}) {
  const own = Object.fromEntries(Object.entries(profiles).flatMap(([name, profile]) => profile.machines.map((machine) => [machine, name])));
  const sandboxes = Object.entries(hosts).filter(([, host]) => own[host]).map(([sandbox, host]) => [sandbox, own[host]]);
  return { ...own, ...Object.fromEntries(sandboxes) };
}

export function sandboxHosts(machines) {
  return Object.fromEntries(machines.flatMap((machine) => {
    const via = machine.via === true ? /sandbox-via\.sh' '([^']+)' '([^']+)'$/.exec(machine.target ?? "") : null;
    const host = via && machines.find((other) => other.via !== true && other.target === via[1]);
    return host ? [[machine.name, host.name]] : [];
  }));
}

export function shownProfile(saved, names) {
  return names.includes(saved) ? saved : names[0] ?? null;
}

export const coordinatorKey = (profile, project) => `${profile}/${project}`;
export const coordinatorPlace = (key) => { const [profile, project] = key.split("/"); return { profile, project }; };

export function liveCoordinators(saved, profiles) {
  return Object.fromEntries(Object.entries(saved).filter(([key]) => {
    const { profile, project } = coordinatorPlace(key);
    return Boolean(profiles[profile]?.projects?.[project]?.coordinator);
  }));
}

export function spaceContext({ space, coordinators, matched }) {
  const key = Object.keys(coordinators).find((key) => coordinators[key] === space.id);
  return (key && coordinatorPlace(key).profile) ?? matched ?? null;
}

export function agentContext({ matched, spaceProfile }) {
  return matched ?? spaceProfile ?? null;
}

export function offContext(contextById, current) {
  return Object.entries(contextById).filter(([, context]) => context && context !== current).map(([id]) => id);
}
