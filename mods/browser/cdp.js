// A Chrome DevTools Protocol client over one WebSocket: send(method, params) answers with the
// result, on(method, handler) gets events. run(cx) reads messages until the socket closes.

import { WebSocket } from "websocket";

export class Cdp {
  static async connect(url) {
    return new Cdp(await WebSocket.connect(url));
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, method }
    this.handlers = new Map(); // event method -> handler(params)
    this.isClosed = false;
    this.writes = Promise.resolve(); // one message on the socket at a time: overlapping writes break the stream
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  send(method, params = {}) {
    if (this.isClosed) return Promise.reject(new Error("The browser connection is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      const message = JSON.stringify({ id, method, params });
      this.writes = this.writes.then(() => this.socket.write(message)).catch((error) => {
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  // Reads until the socket closes; then fails what is still waiting and resolves.
  async run() {
    try {
      for (;;) {
        const raw = await this.socket.read();
        const message = JSON.parse(typeof raw === "string" ? raw : decodeUtf8(raw));
        if (message.id !== undefined) {
          const waiting = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) waiting?.reject(new Error(`${waiting.method}: ${message.error.message}`));
          else waiting?.resolve(message.result);
        } else this.handlers.get(message.method)?.(message.params);
      }
    } catch (error) {
      this.closeError = error;
    } finally {
      this.isClosed = true;
      for (const { reject } of this.pending.values()) reject(new Error("The browser connection closed."));
      this.pending.clear();
    }
  }

  close() {
    if (this.isClosed) return;
    this.isClosed = true;
    this.socket.close().catch(() => {});
  }
}

// A binary message as text. Not String.fromCharCode(...bytes): a screencast frame is hundreds of
// kilobytes, past how many arguments a call may take.
export function decodeUtf8(bytes) {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
  let text = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    const size = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    let code = size === 1 ? b : b & (0xff >> (size + 1));
    for (let k = 1; k < size; k++) code = (code << 6) | (bytes[i + k] & 0x3f);
    text += String.fromCodePoint(code);
    i += size;
  }
  return text;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALUE = new Uint8Array(128);
for (let i = 0; i < ALPHABET.length; i++) VALUE[ALPHABET.charCodeAt(i)] = i;

// Base64 (a screencast frame) to bytes; the runtime has no atob.
export function decodeBase64(text) {
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((text.length * 3) / 4 - padding);
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    const n = (VALUE[text.charCodeAt(i)] << 18) | (VALUE[text.charCodeAt(i + 1)] << 12) | (VALUE[text.charCodeAt(i + 2)] << 6) | VALUE[text.charCodeAt(i + 3)];
    if (at < bytes.length) bytes[at++] = n >> 16;
    if (at < bytes.length) bytes[at++] = (n >> 8) & 255;
    if (at < bytes.length) bytes[at++] = n & 255;
  }
  return bytes;
}
