// Herdr's key and mouse events as CDP Input commands. Pure: checked by `node input.test.mjs`.

// GPUI key names -> [DOM key, DOM code, Windows virtual key code, text it types].
const SPECIAL = {
  enter: ["Enter", "Enter", 13, "\r"],
  backspace: ["Backspace", "Backspace", 8],
  tab: ["Tab", "Tab", 9],
  escape: ["Escape", "Escape", 27],
  delete: ["Delete", "Delete", 46],
  left: ["ArrowLeft", "ArrowLeft", 37],
  right: ["ArrowRight", "ArrowRight", 39],
  up: ["ArrowUp", "ArrowUp", 38],
  down: ["ArrowDown", "ArrowDown", 40],
  home: ["Home", "Home", 36],
  end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33],
  pagedown: ["PageDown", "PageDown", 34],
};

// Editing chords the page can't get from a headless key event alone: Chrome's own commands.
const COMMANDS = { a: "selectAll", z: "undo", "shift-z": "redo", x: "cut", c: "copy" };

// CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
export function modifierBits(m = {}) {
  return (m.alt ? 1 : 0) | (m.control ? 2 : 0) | (m.platform ? 4 : 0) | (m.shift ? 8 : 0);
}

/**
 * What one key press sends: { insertText } for typed text, or { events: [CDP Input.dispatchKeyEvent
 * params] } for keys and chords, or null when the page has no use for it.
 */
export function keyToCdp(event, isMac = true) {
  const m = event.modifiers ?? {};
  const isCommandChord = isMac ? m.platform : m.control;
  const special = SPECIAL[event.key];
  if (!special && !isCommandChord && !m.control && event.key_char) return { insertText: event.key_char };
  const modifiers = modifierBits(m);
  if (special) {
    const [key, code, keyCode, text] = special;
    const down = { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text ? { text, unmodifiedText: text } : {}) };
    return { events: [down, { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers }] };
  }
  const letter = event.key?.length === 1 ? event.key.toLowerCase() : null;
  const command = isCommandChord && letter ? COMMANDS[`${m.shift ? "shift-" : ""}${letter}`] : null;
  if (!letter) return null;
  const keyCode = letter.toUpperCase().charCodeAt(0);
  const code = /[a-z]/.test(letter) ? `Key${letter.toUpperCase()}` : /[0-9]/.test(letter) ? `Digit${letter}` : "";
  const down = { type: "rawKeyDown", key: letter, code, windowsVirtualKeyCode: keyCode, modifiers, ...(command ? { commands: [command] } : {}) };
  return { events: [down, { type: "keyUp", key: letter, code, windowsVirtualKeyCode: keyCode, modifiers }] };
}

const BUTTONS = { left: "left", right: "right", middle: "middle" };

// A press, release or move at (x, y) in page pixels.
export function mouseToCdp(type, event, x, y, pressedButton = "none") {
  const button = type === "mouseMoved" ? pressedButton : BUTTONS[event.button] ?? "left";
  return { type, x, y, button, buttons: button === "none" ? 0 : 1, clickCount: event.click_count ?? (type === "mouseMoved" ? 0 : 1), modifiers: modifierBits(event.modifiers) };
}

// A wheel or trackpad scroll: GPUI's delta is how far the content moves, CDP's how far the view does.
export function wheelToCdp(event, x, y) {
  return { type: "mouseWheel", x, y, deltaX: -event.delta.x, deltaY: -event.delta.y, modifiers: modifierBits(event.modifiers) };
}

// What the address bar's text opens: a URL as typed, local addresses over http, else a search.
export function addressToUrl(text) {
  const typed = text.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(typed) && !/^(localhost|[\d.]+):\d/i.test(typed)) return typed;
  if (/^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(typed) || /^[\w.-]+:\d+(\/|$)/.test(typed)) return `http://${typed}`;
  if (/^[^\s]+\.[a-z]{2,}(\/|$|:)/i.test(typed)) return `https://${typed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(typed)}`;
}
