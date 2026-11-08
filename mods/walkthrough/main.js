// Walkthrough: a change read in the order it makes sense. Claude groups the
// diff's hunks into steps, orders them, and explains each one; the code of
// each step is shown under its explanation.
//
// Opened with `mod.open:walkthrough` as a dialog over the shown space, or as a
// pane: `pane.split {direction: "right", mod: "walkthrough", props: {folder?, scope?}}`.
// With props { watch: true } it is the watcher instead (watch.js): it draws nothing.

import { View } from "gpui-kit";
import { props } from "herdr";
import { Walkthrough as Panel } from "./view.js";
import { Watcher } from "./watch.js";

export default class Walkthrough extends View {
  init(_props, cx) {
    this.panel = props()?.watch ? new Watcher() : new Panel();
    this.panel.init(cx);
  }

  render(cx) {
    return this.panel.render(cx);
  }
}
