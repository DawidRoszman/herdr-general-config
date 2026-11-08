// New tabs go last. Herdr puts a new tab right after the shown one; the tab bar moves it to the end
// of its space. Copied verbatim into each layout's tab bar mod (tabs-claude-first, t3-panels): a mod
// can't import from another mod's folder, so change the copies together.

/**
 * The tabs that appeared since `known` and aren't last yet, as tab.move arguments, and the ids
 * known now. The first look (known null) only learns the tabs: nothing from before is moved.
 * @returns {{ moves: { id: string, index: number }[], known: Set<string> }}
 */
export function newTabsToEnd(spaces, known) {
  const ids = new Set(spaces.flatMap((s) => s.tabs.map((t) => t.id)));
  if (!known) return { moves: [], known: ids };
  const moves = spaces.flatMap((s) => s.tabs
    .filter((t, i) => !known.has(t.id) && i < s.tabs.length - 1)
    .map((t) => ({ id: t.id, index: s.tabs.length })));
  return { moves, known: ids };
}
