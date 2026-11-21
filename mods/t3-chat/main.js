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

  async close() {
    const editors = this.screen?.editors;
    if (editors instanceof Map) {
      for (const ed of editors.values()) ed?.release?.();
      editors.clear();
    } else if (editors && typeof editors === "object") {
      for (const ed of Object.values(editors)) ed?.release?.();
    }
  }

  render(cx) {
    return this.screen.render(cx);
  }
}
