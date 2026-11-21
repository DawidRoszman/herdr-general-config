export function newTabsToEnd(spaces, known) {
  const ids = new Set(spaces.flatMap((s) => s.tabs.map((t) => t.id)));
  if (!known) return { moves: [], known: ids };
  const moves = spaces.flatMap((s) => {
    const fresh = s.tabs.filter((t) => !known.has(t.id));
    const isSeen = fresh.length < s.tabs.length;
    if (fresh.length !== 1 || !isSeen || s.tabs.at(-1) === fresh[0]) return [];
    return [{ id: fresh[0].id, index: s.tabs.length }];
  });
  return { moves, known: ids };
}
