// The "/" filter every list here has. Esc leaves the box and keeps the filter; esc again
// clears it; after that the owner closes (escape() returns false).

import { InputState } from "gpui-base";

export class Search {
  constructor({ onChange, onSubmit }) {
    this.query = "";
    this.isTyping = false;
    this.input = InputState.new({ value: "" });
    this.input.on("change", (_e, cx) => {
      if (!this.isTyping) return;
      this.query = this.input.value().trim().toLowerCase();
      onChange(cx);
      cx.notify();
    });
    // Enter is taken here, not in the owner's key handler, so one press never acts twice.
    this.input.on("submit", (_e, cx) => onSubmit(cx));
    this.input.on("blur", (_e, cx) => {
      this.isTyping = false;
      cx.notify();
    });
  }

  get isShown() {
    return this.isTyping || Boolean(this.query);
  }

  open(cx) {
    this.isTyping = true;
    // The box is drawn only while shown, so it can take focus after this frame.
    cx.timer.after(0, () => this.input.focus());
  }

  escape(ownerHandle) {
    if (this.isTyping) {
      this.isTyping = false;
      ownerHandle.focus();
      return true;
    }
    if (this.query) {
      this.clear();
      return true;
    }
    return false;
  }

  clear() {
    this.query = "";
    this.isTyping = false;
    this.input.set_value("");
  }
}
