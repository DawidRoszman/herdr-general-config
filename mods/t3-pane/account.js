import { div } from "gpui-kit";
import { shared } from "herdr";
import { tipMark } from "./tip.js";

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
