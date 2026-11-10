// The Claude account an agent really runs as (from its process's CLAUDE_CONFIG_DIR, published by
// status-accounts in shared "accounts.agents"; in T3 its { publish: true } block), as a chip with
// the badge and colour of the profile that account belongs to (t3-context's shared "context":
// byAgent and profiles). An account of no profile is named by its organization, uncoloured.
// Mods can't share code: t3-pane, t3-agents and t3-inbox carry this same file, as pane-accounts and spaces-agents
// carry the older badge.
import { div } from "gpui-kit";
import { shared } from "herdr";
import { tipMark } from "./tip.js";

// null when the agent's account isn't known (yet). Without an id (a leaving ghost row) it has no hover label.
// isOnlyOtherProfile: none for an agent of the shown profile, whose name the switch already says (agent lists).
export function accountChip(view, t, id, address, { isOnlyOtherProfile = false } = {}) {
  const account = (shared("accounts.agents") ?? {})[address];
  if (!account?.email) return null;
  const context = shared("context");
  if (isOnlyOtherProfile && context?.current && context.byAgent?.[address] === context.current) return null;
  const profile = context?.profiles?.[context.byAgent?.[address]];
  const color = t[profile?.color] ?? t.dim;
  const chip = div().flex_none().px(5).h(16).flex().items_center().rounded(8).bg(`${color}26`).text_color(color).text_size(10).font_semibold()
    .child(profile?.badge ?? (account.org || account.email));
  return id ? tipMark(view, t, id, `Claude: ${account.email} (${account.configDir})`, chip) : chip;
}
