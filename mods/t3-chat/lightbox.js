// A chat's images, one at a time, as large as the window allows (never past one image pixel per
// device pixel, so never blurred by scaling up): an overlay the chat opens (ChatView.openImage) with
// props { items: [{ id, path, width, height, open, name }], at }. Esc, a click beside the image
// or × closes it; ← → (and the side buttons) step through the images; "Open in viewer" hands the
// image to the system (or the browser, for a web image).

import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, settings, closeOverlay } from "herdr";
import { resampled, deviceScale } from "./host.js";
import { fitSize } from "./model.js";
import { sans } from "./render-md.js";

const BAR = 56; // the name and buttons under the image
const MARGIN = 48; // around the image, room for the side buttons

export class Lightbox {
  constructor(props, cx) {
    this.items = props.items ?? [];
    this.at = Math.max(0, Math.min(this.items.length - 1, props.at ?? 0));
    this.overlay = props.overlay;
    this.size = null; // the overlay's size in px, once laid out
    this.sharp = new Map(); // "id@pixels" -> a copy resampled for that size (host.resampled)
    this.handle = cx.focus_handle();
    cx.timer.after(0, () => this.handle.focus());
  }

  command(name) {
    if (name === "focus") this.handle.focus();
  }

  close() {
    closeOverlay(this.overlay);
  }

  step(by) {
    if (this.items.length > 1) this.at = (this.at + by + this.items.length) % this.items.length;
  }

  // The shown image's size: fitted in the room left, at most its own pixels on this screen.
  shownSize(item) {
    const perPixel = (settings().zoom ?? 1) * deviceScale();
    const room = { width: (this.size?.width ?? 1200) - 2 * MARGIN, height: (this.size?.height ?? 800) - BAR - 2 * MARGIN };
    return fitSize(item, Math.min(room.width, item.width / perPixel), Math.min(room.height, item.height / perPixel));
  }

  // A copy resampled to the shown size, made in the background; the original shows until it is.
  sharpPath(item, cx) {
    const shown = this.shownSize(item);
    const pixels = Math.ceil(Math.max(shown.width, shown.height) * (settings().zoom ?? 1) * deviceScale());
    const key = `${item.id}@${pixels}`;
    if (!this.sharp.has(key)) {
      this.sharp.set(key, item.path);
      cx.spawn(async (cx) => {
        this.sharp.set(key, await resampled(item, pixels));
        cx.notify();
      });
    }
    return this.sharp.get(key);
  }

  key(e, cx) {
    const stroke = e.keystroke;
    if (stroke === "escape" || stroke === "q") this.close();
    else if (stroke === "left" || stroke === "h" || stroke === "k") this.step(-1);
    else if (stroke === "right" || stroke === "l" || stroke === "j" || stroke === "space") this.step(1);
    else if (stroke === "o" && this.items[this.at]) cx.open_url(this.items[this.at].open);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // A round button over the dark backdrop; its press stops there, so the backdrop doesn't close.
  button(id, icon, onClick) {
    return div().id(id).size(36).flex_none().rounded(18).bg("#ffffff1f").hover((s) => s.bg("#ffffff33")).cursor_pointer()
      .flex().items_center().justify_center()
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); })
      .child(svg(`mods/t3-chat/icons/${icon}.svg`).size(16).text_color("#ffffff"));
  }

  render(cx) {
    const t = theme();
    const item = this.items[this.at];
    const zoom = settings().zoom ?? 1;
    const root = v_flex().id("lightbox").size_full().bg("#000000d9").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => { this.size = { width: size.width / zoom, height: size.height / zoom }; cx.notify(); })
      .on_click(() => this.close());
    if (!item) return root.items_center().justify_center().child(div().text_color("#ffffff").child("No image"));
    const shown = this.shownSize(item);
    const many = this.items.length > 1;
    return root
      .child(h_flex().w_full().flex_1().min_h(0).items_center().justify_between().px(12)
        .child(many ? this.button("lightbox-prev", "chevron-left", () => this.step(-1)) : div().size(36))
        .child(div().id("lightbox-image").w(shown.width).h(shown.height).flex_none().on_click((_e, cx) => cx.stop_propagation())
          .child(image(this.sharpPath(item, cx)).w(shown.width).h(shown.height).rounded(6)))
        .child(many ? this.button("lightbox-next", "chevron-right", () => this.step(1)) : div().size(36)))
      .child(sans(h_flex().w_full().h(BAR).flex_none().px(20).gap(12).items_center().on_click((_e, cx) => cx.stop_propagation())
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color("#ffffffcc").child(item.name))
        .when(many, (el) => el.child(div().flex_none().text_size(12).text_color("#ffffff99").child(`${this.at + 1} / ${this.items.length}`)))
        .child(div().id("lightbox-open").flex_none().h(30).px(12).rounded(8).bg("#ffffff1f").hover((s) => s.bg("#ffffff33")).cursor_pointer()
          .flex().items_center().text_size(12.5).text_color("#ffffff")
          .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(item.open); }).child("Open in viewer"))
        .child(this.button("lightbox-close", "x", () => this.close()))));
  }
}
