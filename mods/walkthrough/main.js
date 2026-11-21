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
