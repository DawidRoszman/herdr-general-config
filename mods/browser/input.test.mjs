// node input.test.mjs
import assert from "node:assert/strict";
import { keyToCdp, mouseToCdp, wheelToCdp, addressToUrl, modifierBits } from "./input.js";

assert.deepEqual(keyToCdp({ key: "a", key_char: "a", modifiers: {} }), { insertText: "a" });
assert.deepEqual(keyToCdp({ key: "a", key_char: "A", modifiers: { shift: true } }), { insertText: "A" });
const enter = keyToCdp({ key: "enter", modifiers: {} });
assert.equal(enter.events[0].type, "keyDown");
assert.equal(enter.events[0].text, "\r");
assert.equal(enter.events[1].type, "keyUp");
assert.equal(keyToCdp({ key: "backspace", modifiers: {} }).events[0].type, "rawKeyDown");
assert.deepEqual(keyToCdp({ key: "a", modifiers: { platform: true } }).events[0].commands, ["selectAll"]);
assert.deepEqual(keyToCdp({ key: "z", modifiers: { platform: true, shift: true } }).events[0].commands, ["redo"]);
assert.equal(keyToCdp({ key: "f1", modifiers: {} }), null);
assert.equal(modifierBits({ alt: true, control: true, platform: true, shift: true }), 15);

assert.deepEqual(mouseToCdp("mousePressed", { button: "left", click_count: 2, modifiers: {} }, 10, 20),
  { type: "mousePressed", x: 10, y: 20, button: "left", buttons: 1, clickCount: 2, modifiers: 0 });
assert.equal(mouseToCdp("mouseMoved", { modifiers: {} }, 1, 2).button, "none");
assert.equal(wheelToCdp({ delta: { x: 0, y: -30 }, modifiers: {} }, 5, 5).deltaY, 30);

assert.equal(addressToUrl("localhost:3000/orders"), "http://localhost:3000/orders");
assert.equal(addressToUrl("127.0.0.1:8080"), "http://127.0.0.1:8080");
assert.equal(addressToUrl("github.com/pingdotgg"), "https://github.com/pingdotgg");
assert.equal(addressToUrl("https://x.dev"), "https://x.dev");
assert.equal(addressToUrl("how to center a div"), "https://www.google.com/search?q=how%20to%20center%20a%20div");
assert.equal(addressToUrl("about:blank"), "about:blank");
console.log("input.js ok");
