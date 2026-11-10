// The "?" key list drawn over a view (a copy of prs/keyhelp.js: mods can't import across folders).
// Sections: [{ title, rows: [[keys, what]] }], read from this mod's help-keys.json.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, readTextFile } from "herdr";

export const isHelpKey = (stroke) => stroke === "?" || stroke === "shift-/";

export async function loadKeys(viewId) {
  try {
    const views = JSON.parse(await readTextFile(`${appHome()}/mods/t3-chat/help-keys.json`)).views;
    return views.find((v) => v.id === viewId)?.sections ?? [];
  } catch (error) {
    return [{ title: "Could not read mods/t3-chat/help-keys.json", rows: [["", String(error.message ?? error)]] }];
  }
}

export function keyHelp(id, title, sections, t, keyWidth = 130) {
  return div().absolute().inset_0().flex().items_center().justify_center().bg(`${t.background}cc`).p(12)
    .child(v_flex().id(id).max_w(560).w_full().max_h_full().overflow_y_scrollbar().p(16).gap(12).rounded(10)
      .bg(t.popover).border(1).border_color(t.border).shadow_lg()
      .child(h_flex().justify_between().items_center()
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child(title))
        .child(div().text_size(11).text_color(t.dim).child("? or esc closes")))
      .children(sections.map((section) => v_flex().gap(3)
        .child(div().text_size(11).font_medium().text_color(t.dim).child(section.title))
        .children(section.rows.map(([keys, what]) => h_flex().gap(10).items_start().text_size(12)
          .child(div().flex_none().w(keyWidth).text_color(t.accent).child(keys))
          .child(div().flex_1().min_w(0).text_color(t.foreground).child(what)))))));
}
