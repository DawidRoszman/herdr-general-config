// T3 Code's chat, drawn in Herdr: { view: "chat", ... } (see chat.js). Claude Code runs in a
// terminal pane of the chat's tab, so it is a real Herdr agent of that space.
// { view: "fixture", file? } draws a Markdown file (a path in the app folder; fixture.md) as one reply.

import { View } from "gpui-kit";
import { nextCommand, props } from "herdr";
import { ChatView } from "./chat.js";

export default class T3Chat extends View {
  init(_props, cx) {
    this.screen = new ChatView(props() ?? {}, cx);
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
