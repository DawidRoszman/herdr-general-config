const isInside = (path, folder) => Boolean(path) && (path === folder || path.startsWith(`${folder}/`));

export function projectOf({ machine, place, folder, git }, projects) {
  const known = Object.entries(projects ?? {});
  if (!known.length) return null;
  const gitFolder = git?.repo ? JSON.parse(git.repo)[1] : null;
  const host = git?.host ?? null;
  for (const [name, project] of known) {
    for (const { machine: on, root } of project.places ?? []) {
      if (host) {
        if ((host.machine ?? null) === (on ?? null) && isInside(host.project, root)) return name;
        continue;
      }
      if ((on ?? null) !== (machine ?? null)) continue;
      if (git?.root === root || gitFolder === `${root}/.git` || isInside(place, root) || isInside(folder, root)) return name;
    }
  }
  return null;
}

export function projectsFirst(rows, names) {
  const units = [];
  for (const row of rows) {
    if (row.tree && units.length) units[units.length - 1].push(row);
    else units.push([row]);
  }
  const machines = [...new Set(units.map(([top]) => top.w.machine ?? null))];
  const rank = (top) => (names.includes(top.p) ? names.indexOf(top.p) : names.length);
  return units.map((unit, at) => ({ unit, at, machine: machines.indexOf(unit[0].w.machine ?? null), rank: rank(unit[0]) }))
    .sort((a, b) => a.machine - b.machine || a.rank - b.rank || a.at - b.at)
    .flatMap(({ unit }) => unit);
}
