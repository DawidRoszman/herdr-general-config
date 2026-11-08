// Pull requests across a multirepo project's repos. One mod, two views chosen by props:
//   { view: "monitor" }                         the sidebar list (layout block)
//   { view: "review", machine, project, branch } a branch's linked PRs (a tab, see host.openReview)
//   opened as an overlay (mod.open:prs)            opens the focused space's PR review (here.js)

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
