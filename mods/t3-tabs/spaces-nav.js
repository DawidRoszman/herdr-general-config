export function resolveSpaceTargets({ spaces, homeId, context, publishedRows }) {
  const currentProfile = context?.current ?? null;
  const offSpaces = new Set(context?.offSpaces ?? []);
  const byId = new Map(spaces.map((s) => [s.id, s]));

  if (publishedRows?.profile === currentProfile && Array.isArray(publishedRows.order) && publishedRows.order.length) {
    return publishedRows.order.filter((item) =>
      item?.kind === "coordinator"
        ? Boolean(item.key)
        : item?.kind === "space" && item.id !== homeId && byId.has(item.id) && !offSpaces.has(item.id)
    );
  }

  return spaces
    .filter((s) => s.id !== homeId && !offSpaces.has(s.id))
    .map((s) => ({ kind: "space", id: s.id }));
}

export function pickSpaceTarget(targets, index) {
  if (!Number.isInteger(index) || index < 1) return null;
  return targets[index - 1] ?? null;
}

export function pickAdjacentSpace({ targets, spaces, coordinators, by }) {
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const live = [];
  const seen = new Set();

  for (const item of targets) {
    const id = item.kind === "coordinator" ? coordinators?.[item.key] : item.id;
    const space = id ? byId.get(id) : null;
    if (space && !seen.has(space.id)) {
      seen.add(space.id);
      live.push(space);
    }
  }

  if (!live.length) return null;
  const activeIndex = live.findIndex((s) => s.active);
  const nextIndex = activeIndex < 0
    ? (by > 0 ? 0 : live.length - 1)
    : (activeIndex + by + live.length) % live.length;
  return live[nextIndex];
}
