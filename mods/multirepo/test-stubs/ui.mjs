// gpui-kit and gpui-base for tests: every element builder is a chain that accepts anything, inputs keep a value.

const chain = () => new Proxy(function () {}, { get: (_t, key) => (key === "then" ? undefined : () => chain()), apply: () => chain() });

export class View {}
export const div = chain;
export const svg = chain;
export const v_flex = chain;
export const h_flex = chain;
export const v_virtual_list = chain;
export const Scrollbar = { vertical: chain };
export const Input = { new: chain };
export const VirtualListScrollHandle = { new: () => ({ scroll_to_item() {} }) };

export class InputState {
  static new({ value = "" } = {}) { return new InputState(value); }
  constructor(value) { this.text = value; this.handlers = {}; this.isFocused = false; }
  value() { return this.text; }
  set_value(next) { this.text = String(next); }
  on(event, handler) { (this.handlers[event] ??= []).push(handler); return true; }
  focus() { this.isFocused = true; }
  // Test helpers: what the person does in the box.
  type(text, cx) { this.text = text; for (const h of this.handlers.change ?? []) h({}, cx); }
  submit(cx) { for (const h of this.handlers.submit ?? []) h({}, cx); }
  blur(cx) { this.isFocused = false; for (const h of this.handlers.blur ?? []) h({}, cx); }
}
