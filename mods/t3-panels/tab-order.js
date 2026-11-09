// New tabs go last. Herdr puts a new tab right after the shown one; the tab bar moves it to the end
// of its space. Copied verbatim into each layout's tab bar mod (tabs-claude-first, t3-panels): a mod
// can't import from another mod's folder, so change the copies together.

/**
 * A tab someone opened since `known`, when it isn't last yet, as tab.move arguments, and the ids
 * known now. Opened means one new tab in a space that already had known ones: a space that arrives
 * with its tabs (a machine's layout loading, this Mac's spaces restored after a restart) keeps its
 * order. The first look (known null) only learns the tabs.
 * @returns {{ moves: { id: string, index: number }[], known: Set<string> }}
 */
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
