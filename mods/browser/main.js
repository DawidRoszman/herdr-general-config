// A browser pane. It shows the shared headless Chrome on the space's machine (launch.sh starts it
// on 127.0.0.1:9333) as a live screencast; clicks, typing and scrolling go to the page. Agents
// drive the same browser through chrome-devtools-mcp (setup.sh), so you and they see one page:
// when an agent opens a tab, the pane follows it.
//
// props: { machine? } (null: this computer; omitted: the focused space's machine).
// A remote machine's browser is reached through an ssh tunnel (ssh -f -L) to a local port.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { exec, hc, appHome, readTextFile, theme, spaces, focused, props, settings, panes, run } from "herdr";
import { writeFile, unlink, mkdir } from "fs/promises";
import { Cdp, decodeBase64 } from "./cdp.js";
import { keyToCdp, mouseToCdp, wheelToCdp, addressToUrl } from "./input.js";

const BROWSER_PORT = 9333; // launch.sh's, on every machine
const TUNNEL_PORTS = { first: 19300, count: 600 };
// Herdr reloads a changed image only under mods/, and a file written in a mod's own folder reloads
// the mod: so a folder of its own under mods/ that is no mod (no main.js).
const FRAMES = "mods/browser-frames";
// Frame files rewritten in turn, all drawn, newest on top: Herdr reloads a rewritten image a moment
// later, so the oldest is rewritten while the newer ones cover it (no flicker), and the image cache
// holds this many images, not one per frame.
const FRAME_SLOTS = ["a", "b", "c", "d"];
// At most one frame this often: each file then stays unchanged for FRAME_MS × the other slots
// (~250 ms), long enough for Herdr to reload it; faster, every slot is mid-reload and the view blinks.
const FRAME_MS = 80;
const LIST_MS = 1000; // how often the tab list (and an agent's new tab) is looked at
const MOVE_MS = 30; // mouse moves sent at most this often
const WHEEL_MS = 33; // wheel ticks (a trackpad sends ~120 a second) summed and sent at most this often
// While the page moves, frames stream small (remote ones cross an ssh tunnel); once it has been still
// for SETTLE_MS, one full-size screenshot replaces them, so a still page is sharp.
const MOVING_FRAMES = { local: { scale: 1, quality: 55 }, remote: { scale: 0.75, quality: 45 } };
const STILL_QUALITY = 85;
const SETTLE_MS = 300;
// Frames right after that screenshot are its own echo (taking it repaints): not shown, so the sharp
// frame stays, and not counted as movement, so it isn't taken again and again.
const ECHO_MS = 400;
// Decoding a frame in the mod's JavaScript takes ~30 ms of Herdr's own thread; base64(1) does it in
// another process. The frame goes as an argument, so it must fit one (macOS: 1 MiB for them all).
const DECODE = 'printf %s "$1" | base64 -D > "$2.part" && mv "$2.part" "$2"';
const MAX_NATIVE_FRAME = 900_000;

function shownMachine() {
  const id = focused()?.space;
  return spaces().find((s) => s.id === id)?.machine ?? null;
}

async function sshTarget(machine) {
  const r = await hc(["machine", "ls", "--json"]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc machine ls failed");
  const found = JSON.parse(r.stdout).machines.find((m) => m.name === machine);
  if (!found) throw new Error(`${machine} is not a Herdr machine.`);
  return found.target;
}

// The same local port for a machine every time, so a tunnel made earlier is found again.
function tunnelPort(machine) {
  let hash = 0;
  for (const c of machine) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return TUNNEL_PORTS.first + (hash % TUNNEL_PORTS.count);
}

async function isListening(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
  } catch (_) {
    return false;
  }
}

export default class Browser extends View {
  init(_props, cx) {
    const given = props() ?? {};
    this.machine = "machine" in given ? given.machine : shownMachine();
    this.id = Math.random().toString(36).slice(2, 8); // this pane's frame files
    this.handle = cx.focus_handle();
    this.address = InputState.new({ placeholder: "Search or type a URL (localhost:3000 opens over http)" });
    this.address.on("submit", (_e, cx) => this.navigate(cx, addressToUrl(this.address.value())));
    this.isEditingAddress = false;
    this.address.on("focus", () => { this.isEditingAddress = true; });
    this.address.on("blur", () => { this.isEditingAddress = false; });
    this.port = null; // where this machine's browser answers, here
    this.pages = []; // the browser's tabs, from /json/list
    this.seenPages = null; // ids already listed: a new one (an agent's) is followed
    this.targetId = null;
    this.cdp = null;
    this.frames = []; // the last two frames' paths, older first: both drawn, newest on top
    this.frameCount = 0;
    this.pendingFrame = null;
    this.isWritingFrame = false;
    this.viewSize = null;
    this.pressedButton = "none";
    this.lastMoveAt = 0;
    this.wheel = null; // { x, y, deltaX, deltaY } waiting to be sent
    this.status = "Starting the browser…";
    this.notice = ""; // what "Connect agents" answered
    this.error = "";
    cx.spawn(async (cx) => {
      try {
        await mkdir(`${appHome()}/${FRAMES}`, { recursive: true });
        this.port = await this.startBrowser();
        this.status = "";
        await this.refreshPages(cx);
      } catch (error) {
        this.error = String(error.message ?? error);
      }
      cx.notify();
    });
    cx.timer.every(LIST_MS, (cx) => { if (this.port) cx.spawn(async (cx) => this.refreshPages(cx)); });
  }

  get machineLabel() {
    return this.machine ?? "this computer";
  }

  // Starts (or finds) the browser on the machine, and for a remote one, the tunnel to it.
  async startBrowser() {
    const script = await readTextFile(`${appHome()}/mods/browser/launch.sh`);
    const started = await exec("sh", ["-c", script], { on: this.machine ?? undefined });
    if (started.code !== 0) throw new Error(started.stderr.trim() || `launch.sh failed on ${this.machineLabel}`);
    if (this.machine === null) return BROWSER_PORT;
    const port = tunnelPort(this.machine);
    if (await isListening(port)) return port;
    this.status = `Connecting to ${this.machine}'s browser…`;
    const target = await sshTarget(this.machine);
    // -f puts ssh in the background once the tunnel is up; its output is dropped so exec returns.
    const tunnel = `ssh -f -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L 127.0.0.1:${port}:127.0.0.1:${BROWSER_PORT} "$1" >/dev/null 2>&1 </dev/null`;
    await exec("sh", ["-c", tunnel, "sh", target]);
    if (!(await isListening(port))) throw new Error(`Could not reach ${this.machine}'s browser through ssh (port ${port}).`);
    return port;
  }

  async listPages() {
    const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
    return list.filter((t) => t.type === "page");
  }

  // The tabs; follows a tab that just appeared (an agent opened it) or a closed shown one.
  async refreshPages(cx) {
    let pages;
    try {
      pages = await this.listPages();
    } catch (error) {
      this.error = `${this.machineLabel}'s browser stopped answering: ${error.message ?? error}`;
      return cx.notify();
    }
    const isFirstList = this.seenPages === null;
    const fresh = isFirstList ? [] : pages.filter((p) => !this.seenPages.has(p.id));
    this.seenPages = new Set(pages.map((p) => p.id));
    this.pages = pages;
    if (!pages.length) {
      await this.newTab(cx);
      return;
    }
    const shown = pages.find((p) => p.id === this.targetId);
    const next = fresh.at(-1) ?? (shown ? null : pages[0]);
    if (next) await this.attach(cx, next);
    else if (shown && !this.isEditingAddress && this.address.value() !== shown.url) this.address.set_value(shown.url);
    cx.notify();
  }

  async attach(cx, page) {
    this.detach();
    this.targetId = page.id;
    this.address.set_value(page.url);
    this.error = "";
    const url = page.webSocketDebuggerUrl.replace(/\/\/[^/]+\//, `//127.0.0.1:${this.port}/`);
    const cdp = await Cdp.connect(url);
    this.cdp = cdp;
    cx.spawn(async (cx) => {
      await cdp.run();
      if (this.cdp !== cdp) return; // replaced on purpose (another tab, a resize)
      // Closed under us (the tab crashed or closed, Chrome restarted): attach again, to the same
      // tab if it is still there; the next tab list does it otherwise.
      this.cdp = null;
      const again = (await this.listPages().catch(() => [])).find((p) => p.id === this.targetId);
      if (again) await this.attach(cx, again).catch((error) => { this.error = String(error.message ?? error); });
      else this.targetId = null;
      cx.notify();
    });
    cdp.on("Page.screencastFrame", (frame) => {
      cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      if (Date.now() - (this.stillAt ?? 0) < ECHO_MS) return;
      this.queueFrame(cx, frame.data);
      this.settle(cx);
    });
    cdp.on("Page.frameNavigated", ({ frame }) => {
      if (!frame.parentId && !this.isEditingAddress) this.address.set_value(frame.url);
      cx.notify();
    });
    await cdp.send("Page.enable");
    await this.fitPage(cx);
  }

  detach() {
    if (!this.cdp) return;
    this.cdp.send("Page.stopScreencast").catch(() => {});
    this.cdp.close();
    this.cdp = null;
  }

  // The browser window sized so the page is as big as the pane, and frames to match. Headless
  // Chrome screencasts its window (an emulated viewport isn't streamed), so the agent sees the
  // same viewport you do.
  async fitPage(cx) {
    const cdp = this.cdp;
    if (!cdp || !this.viewSize) return;
    const width = Math.max(200, Math.round(this.viewSize.width));
    const height = Math.max(150, Math.round(this.viewSize.height));
    try {
      const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: this.targetId });
      const { result } = await cdp.send("Runtime.evaluate", { expression: "outerHeight - innerHeight", returnByValue: true });
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width, height: height + (result.value ?? 0) } });
      await cdp.send("Page.stopScreencast");
      const { scale, quality } = MOVING_FRAMES[this.machine === null ? "local" : "remote"];
      await cdp.send("Page.startScreencast", { format: "jpeg", quality, maxWidth: Math.round(width * scale), maxHeight: Math.round(height * scale) });
      this.settle(cx);
    } catch (error) {
      this.error = String(error.message ?? error);
    }
  }

  // A full-size screenshot once nothing has changed for SETTLE_MS (each new frame starts the wait again).
  settle(cx) {
    const token = (this.settleToken = (this.settleToken ?? 0) + 1);
    cx.timer.after(SETTLE_MS, () => {
      const cdp = this.cdp;
      if (token !== this.settleToken || !cdp) return;
      cx.spawn(async (cx) => {
        this.stillAt = Date.now();
        const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: STILL_QUALITY }).catch(() => null);
        this.stillAt = Date.now();
        if (shot && token === this.settleToken && this.cdp === cdp) this.queueFrame(cx, shot.data);
      });
    });
  }

  // Frames arrive faster than files get written: only the newest waiting one is written.
  queueFrame(cx, data) {
    this.pendingFrame = data;
    if (this.isWritingFrame) return;
    this.isWritingFrame = true;
    cx.spawn(async (cx) => {
      try {
        while (this.pendingFrame) {
          const data = this.pendingFrame;
          this.pendingFrame = null;
          const n = ++this.frameCount;
          const startedAt = Date.now();
          // The slot not on top; the one under it is written while the top one covers it.
          const path = `${FRAMES}/${this.id}-${FRAME_SLOTS[n % FRAME_SLOTS.length]}.jpg`;
          await this.writeFrame(`${appHome()}/${path}`, data);
          const wait = FRAME_MS - (Date.now() - startedAt);
          this.frames = [...this.frames.filter((f) => f !== path), path].slice(-FRAME_SLOTS.length);
          cx.notify();
          if (wait > 0) await new Promise((resolve) => cx.timer.after(wait, () => resolve()));
        }
      } catch (error) {
        this.error = `Could not show a frame: ${error.message ?? error}`;
      } finally {
        this.isWritingFrame = false;
      }
    });
  }

  async writeFrame(file, data) {
    if (data.length <= MAX_NATIVE_FRAME) {
      const r = await exec("sh", ["-c", DECODE, "sh", data, file]);
      if (r.code === 0) return;
    }
    await writeFile(file, decodeBase64(data));
  }

  send(method, params) {
    this.cdp?.send(method, params).then(() => { this.error = ""; }, (error) => { this.error = String(error.message ?? error); });
  }

  navigate(cx, url) {
    this.isEditingAddress = false;
    this.handle.focus();
    this.send("Page.navigate", { url });
    cx.notify();
  }

  async goHistory(step) {
    const cdp = this.cdp;
    if (!cdp) return;
    const { currentIndex, entries } = await cdp.send("Page.getNavigationHistory");
    const entry = entries[currentIndex + step];
    if (entry) await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
  }

  async newTab(cx) {
    const page = await (await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: "PUT" })).json();
    this.seenPages?.add(page.id);
    await this.attach(cx, page);
    cx.timer.after(0, () => this.address.focus());
  }

  async closeTab(cx, page) {
    await fetch(`http://127.0.0.1:${this.port}/json/close/${page.id}`);
    if (page.id === this.targetId) this.detach();
    await this.refreshPages(cx);
  }

  // Registers the browser as chrome-devtools-mcp for the machine's Claude Code and Codex (setup.sh).
  connectAgents(cx) {
    this.notice = `Connecting ${this.machineLabel}'s agents…`;
    cx.spawn(async (cx) => {
      try {
        const [setup, launch] = await Promise.all(["setup.sh", "launch.sh"].map((name) => readTextFile(`${appHome()}/mods/browser/${name}`)));
        const r = await exec("sh", ["-c", setup, "sh", launch], { on: this.machine ?? undefined });
        this.notice = r.code === 0 ? `${r.stdout.trim()}. New agent sessions get the browser tools.` : "";
        if (r.code !== 0) this.error = `Connecting agents failed: ${(r.stderr || r.stdout).trim()}`;
      } catch (error) {
        this.notice = "";
        this.error = `Connecting agents failed: ${error.message ?? error}`;
      }
      cx.notify();
    });
  }

  async paste() {
    const r = await exec("pbpaste", []);
    if (r.code === 0 && r.stdout) this.send("Input.insertText", { text: r.stdout });
  }

  key(e, cx) {
    if (!this.handle.is_focused()) return;
    const m = e.modifiers ?? {};
    const chord = m.platform && !m.control && !m.alt ? e.key : null;
    if (chord === "l") cx.timer.after(0, () => this.address.focus());
    else if (chord === "r") this.send("Page.reload", {});
    else if (chord === "[") this.goHistory(-1).catch(() => {});
    else if (chord === "]") this.goHistory(1).catch(() => {});
    else if (chord === "v") this.paste().catch(() => {});
    else if (chord === "t") cx.spawn(async (cx) => this.newTab(cx));
    else {
      const input = keyToCdp(e, true);
      if (!input) return;
      if (input.insertText) this.send("Input.insertText", { text: input.insertText });
      else for (const event of input.events) this.send("Input.dispatchKeyEvent", event);
    }
    cx.stop_propagation();
  }

  // ----------------------------------------------------------------- render

  icon(name, t) {
    return svg(`mods/browser/icons/${name}.svg`).size(14).flex_none().text_color(t.muted);
  }

  button(id, iconName, tip, onClick, t) {
    return div().id(id).size(26).flex().flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip(tip)
      .on_click((_e, cx) => { onClick(cx); cx.notify(); })
      .child(this.icon(iconName, t));
  }

  toolbar(t) {
    return h_flex().flex_none().h(38).px(8).gap(4).items_center().border_b(1).border_color(t.border)
      .child(this.button("back", "chevron-left", "Back · cmd-[", () => this.goHistory(-1).catch(() => {}), t))
      .child(this.button("forward", "chevron-right", "Forward · cmd-]", () => this.goHistory(1).catch(() => {}), t))
      .child(this.button("reload", "refresh", "Reload · cmd-r", () => this.send("Page.reload", {}), t))
      .child(Input.new(this.address).flex_1().h(28).px(10).items_center().rounded(7).border(1).border_color(t.input)
        .bg(t.background).text_color(t.foreground).text_size(12.5))
      .child(div().id("connect-agents").flex_none().h(26).px(8).flex().items_center().rounded(6).cursor_pointer().text_size(12).text_color(t.muted)
        .hover((s) => s.bg(t.hover)).tooltip(`Let ${this.machineLabel}'s Claude Code and Codex use this browser (chrome-devtools-mcp)`)
        .on_click((_e, cx) => { this.connectAgents(cx); cx.notify(); }).child("Connect agents"))
      .child(div().flex_none().pl(2).text_size(11.5).text_color(t.dim).child(this.machineLabel));
  }

  tabs(t) {
    return h_flex().flex_none().h(32).px(8).gap(4).items_center().border_b(1).border_color(t.border).overflow_hidden()
      .children(this.pages.map((page) => {
        const isShown = page.id === this.targetId;
        return h_flex().id(`tab-${page.id}`).h(24).pl(10).pr(4).gap(4).items_center().rounded(6).cursor_pointer().flex_shrink(1)
          .min_w(60).max_w(200).bg(isShown ? t.selected : t.background).hover((s) => s.bg(t.hover)).tooltip(page.url)
          .on_click((_e, cx) => { if (!isShown) cx.spawn(async (cx) => this.attach(cx, page)); })
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(isShown ? t.foreground : t.muted).child(page.title || page.url))
          .child(div().id(`close-${page.id}`).size(18).flex().flex_none().items_center().justify_center().rounded(4)
            .hover((s) => s.bg(t.raised)).tooltip("Close tab")
            .on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(async (cx) => this.closeTab(cx, page)); })
            .child(svg("mods/browser/icons/x.svg").size(11).text_color(t.dim)));
      }))
      .child(this.button("new-tab", "plus", "New tab · cmd-t", (cx) => cx.spawn(async (cx) => this.newTab(cx)), t));
  }

  // Where a pointer event is in page pixels (the page is laid out at the view's size).
  at(e) {
    return e.local_position ? { x: Math.round(e.local_position.x), y: Math.round(e.local_position.y) } : null;
  }

  // A browser opened as its own tab (cmd-alt-i, the palette) becomes the space's second tab, after
  // the chat. Learnt at the first layout: a pane is laid out only while its tab shows. A browser
  // split beside another pane stays where it is.
  settleTab() {
    const tab = spaces().find((s) => s.active)?.tabs.find((t) => t.active);
    if (!tab) return;
    const inTab = panes().filter((p) => p.tab === tab.id);
    if (inTab.length === 1 && inTab[0].mod === "browser") run("tab.move", { id: tab.id, index: 2 });
  }

  view(t) {
    // Over the page only while there is no page to show; otherwise errors sit in a bar above it.
    const message = this.frames.length ? "" : this.error || this.status || "Waiting for the page…";
    return div().id("browser-view").relative().flex_1().min_h(0).overflow_hidden().bg("#ffffff").track_focus(this.handle)
      .on_size_change((size, cx) => {
        if (!this.viewSize) this.settleTab();
        if (this.viewSize?.width === size.width && this.viewSize?.height === size.height) return;
        this.viewSize = size;
        cx.spawn(async (cx) => this.fitPage(cx));
      })
      .on_mouse_down("left", (e, cx) => this.press(e, cx))
      .on_mouse_down("right", (e, cx) => this.press(e, cx))
      .on_mouse_up("left", (e) => this.release(e))
      .on_mouse_up("right", (e) => this.release(e))
      .on_mouse_move((e) => {
        const now = Date.now();
        const p = this.at(e);
        if (!p || now - this.lastMoveAt < MOVE_MS) return;
        this.lastMoveAt = now;
        this.send("Input.dispatchMouseEvent", mouseToCdp("mouseMoved", e, p.x, p.y, this.pressedButton));
      })
      .on_scroll_wheel((e, cx) => this.scroll(e, cx))
      .when(Boolean(this.viewSize), (el) => el.children(this.frames.map((path) =>
        image(path).absolute().top(0).left(0).w(this.viewSize.width).h(this.viewSize.height))))
      .when(Boolean(message), (el) => el.child(div().absolute().inset_0().flex().items_center().justify_center().p(20).bg(t.background)
        .child(div().text_size(12.5).text_color(this.error ? t.blocked : t.muted).child(message))));
  }

  // Sums wheel ticks and sends them together, so a fast scroll is a few events, not hundreds.
  scroll(e, cx) {
    const p = this.at(e);
    if (!p) return;
    const tick = wheelToCdp(e, p.x, p.y);
    if (this.wheel) {
      this.wheel.deltaX += tick.deltaX;
      this.wheel.deltaY += tick.deltaY;
      return;
    }
    this.wheel = tick;
    cx.timer.after(WHEEL_MS, () => {
      const wheel = this.wheel;
      this.wheel = null;
      if (wheel && (wheel.deltaX || wheel.deltaY)) this.send("Input.dispatchMouseEvent", wheel);
    });
  }

  press(e, cx) {
    this.handle.focus();
    this.isEditingAddress = false;
    const p = this.at(e);
    if (!p) return;
    this.pressedButton = e.button ?? "left";
    this.send("Input.dispatchMouseEvent", mouseToCdp("mousePressed", e, p.x, p.y));
    cx.notify();
  }

  release(e) {
    const p = this.at(e);
    this.pressedButton = "none";
    if (p) this.send("Input.dispatchMouseEvent", mouseToCdp("mouseReleased", e, p.x, p.y));
  }

  render() {
    const t = theme();
    return v_flex().id("browser").size_full().bg(t.background).text_color(t.foreground)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(this.toolbar(t))
      .child(this.tabs(t))
      .when(Boolean(this.notice || (this.error && this.frames.length)), (el) => el.child(div().flex_none().px(12).py(4).text_size(11.5)
        .text_color(this.error ? t.blocked : t.muted).border_b(1).border_color(t.border).child(this.error || this.notice)))
      .child(this.view(t));
  }

  async close() {
    const cdp = this.cdp;
    if (cdp) {
      cdp.send("Page.stopScreencast").catch(() => {});
      cdp.close();
    }
    for (const slot of FRAME_SLOTS) await unlink(`${appHome()}/${FRAMES}/${this.id}-${slot}.jpg`).catch(() => {});
  }
}
