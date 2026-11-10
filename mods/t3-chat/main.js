// T3 Code's chat, drawn in Herdr: { view: "chat", ... } (see chat.js). Claude Code runs in a
// terminal pane of the chat's tab, so it is a real Herdr agent of that space.
// { view: "fixture", file?, state?, screen? } draws a Markdown file (a path in the app folder; fixture.md) as one reply,
// or a .jsonl transcript; screen: a file with Claude Code's screen, to draw its question or approval.
// { view: "lightbox", items, at } (an overlay a chat opens) shows its images one by one, large.

import { View } from "gpui-kit";
import { nextCommand, props } from "herdr";
import { ChatView } from "./chat.js";
import { Lightbox } from "./lightbox.js";

export default class T3Chat extends View {
  init(_props, cx) {
    const given = props() ?? {};
    this.screen = given.view === "lightbox" ? new Lightbox(given, cx) : new ChatView(given, cx);
    cx.spawn(async (cx) => {
      for (;;) {
        this.screen.command(await nextCommand(), cx);
        cx.notify();
      }
    });
  }

  render(cx) {
    return this.screen.render(cx);
  }
}
