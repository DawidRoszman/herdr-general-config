import { InputState } from "gpui-base";

export class Search {
  constructor({ onChange, onSubmit, onBlur = () => {} }) {
    this.query = "";
    this.isTyping = false;
    this.input = InputState.new({ value: "" });
    this.input.on("change", (_e, cx) => {
      if (!this.isTyping) return;
      this.query = this.input.value().trim().toLowerCase();
      onChange(cx);
      cx.notify();
    });

    this.input.on("submit", (_e, cx) => onSubmit(cx));
    this.input.on("blur", (_e, cx) => {
      this.isTyping = false;
      onBlur();
      cx.notify();
    });
  }

  get isShown() {
    return this.isTyping || Boolean(this.query);
  }

  open(cx) {
    this.isTyping = true;

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
