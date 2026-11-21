import { View } from "gpui-kit";
import { nextCommand, props } from "herdr";
import { Monitor } from "./monitor.js";
import { Review } from "./review.js";
import { OpenHere } from "./here.js";

export default class Prs extends View {
  init(_props, cx) {
    const given = props() ?? {};
    this.screen = given.view === "monitor" ? new Monitor(cx) : given.overlay ? new OpenHere(given, cx) : new Review(given, cx);
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
