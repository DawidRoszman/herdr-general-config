// The Claude account an agent really runs as (from its process's CLAUDE_CONFIG_DIR), published
// by status-accounts in shared "accounts.agents" (in T3 its { publish: true } block). Amber: work.
// Mods can't share code: t3-pane, t3-agents and t3-inbox carry this same file, as pane-accounts and spaces-agents
// carry the same badge.
import { div } from "gpui-kit";
import { shared } from "herdr";
import { tipMark } from "./tip.js";

// null when the agent's account isn't known (yet). Without an id (a leaving ghost row) it has no hover label.
export function accountChip(view, t, id, address) {
  const account = (shared("accounts.agents") ?? {})[address];
  if (!account?.email) return null;
  const isWork = account.kind === "work";
  const color = isWork ? t.ansi3 : t.ansi4;
  const chip = div().flex_none().px(5).h(16).flex().items_center().rounded(8).bg(`${color}26`).text_color(color).text_size(10).font_semibold()
    .child(isWork ? account.org || "work" : "personal");
  return id ? tipMark(view, t, id, `Claude: ${account.email} (${account.configDir})`, chip) : chip;
}
