import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, TextView, EditorState } from "gpui-base";
import { theme, run, panes, focused, settings, shared, setShared, spaces, terminals, openOverlay } from "herdr";
import { startClaude, runningSession, sessionOfTerminal, labelSession, adopt, killTerminal, sendText, pressKeys, readScreen, findTranscript, readFrom, TRANSCRIPT_PAGE, byteLength, oldChat, oldChatIds, attachmentPath, displayableImage, referencedImage, resampled, deviceScale, pastedAttachment, listFiles, machineLabel, currentPlace } from "./host.js";
import { COMMANDS, emptyChat, applyTranscript, transcriptLines, timeline, chatState, screenMenu, suggestionsFor, accepted, composerKeyRoute, chatTabRename, estimateRowHeight, historyStep, screenStatus, screenPlanPath, pendingTool, isTypedOption, typedAnswer, placeQuestion, fitSize, coverSize, isImagePath, isLoopbackUrl } from "./model.js";
import { isHelpKey, keyHelp, loadKeys } from "./keyhelp.js";
import { blocks, codeLanguage, codeBodyHeight, gapBefore, imageSources, CODE } from "./markdown.js";
import { mdBlock, codeHead, codeBody, copyRow, htmlPreview, IMAGE_BOX } from "./render-md.js";
import { userRow, foldRow, entryRow, metaRow, workingRow, dividerRow, noticeRow, changedRow, planRow, THUMB_BOX } from "./timeline.js";
import { composer, hero, PLACEHOLDER, ATTACHMENT_BOX } from "./composer.js";
import { layout, maxTop, settle, wheel, resized, visibleRange, thumb, dragged, trackPressed } from "./scroll.js";
import { appHome, readTextFile, home } from "herdr";

const POLL_MS = 400;

const UNREAD_WAITS = 2;
const ACTIVE = new Set(["starting", "working", "waiting"]);
const BY_TAB = "chats.byTab";
const EXTERNAL_WAIT = 40;
const CONTENT_WIDTH = 736;
const LANE_INSET = 16;

const COMPOSER_KEYS = [["up", "t3_chat_up", "arrows"], ["down", "t3_chat_down", "arrows"], ["tab", "t3_chat_tab", "tabs"]];

function newSessionId() {
  const hex = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const localId = (id) => id.replace(/^[^/]+\//, "");

const withoutEnter = (draft) => draft.replace(/\r?\n$/, "");
const sameTerminal = (a, b) => Boolean(a && b) && localId(a) === localId(b);

export class ChatView {
  constructor(props, cx) {
    this.props = props;
    this.machine = null;
    this.session = null;
    this.folder = null;
    this.transcript = null;
    this.offset = 0;
    this.handle = cx.focus_handle();
    this.ownTab = null;
    this.composer = TextareaState.new({ placeholder: PLACEHOLDER });
    this.composer.set_auto_grow(2, 10);
    this.historyAt = -1;

    this.composer.on("submit", (e, cx) => {
      if (e.shift) return;
      const draft = withoutEnter(this.composer.value());
      if (this.suggestions(draft).items.length) this.acceptSuggestion(cx, this.suggestAt, draft);
      else this.submit(cx);
    });

    this.composer.on("change", (_e, cx) => {
      const { token } = this.suggestions(withoutEnter(this.composer.value()));
      if (token !== this.suggestToken) this.suggestAt = 0;
      this.suggestToken = token;
      cx.notify();
    });
    this.suggestAt = 0;
    this.files = [];
    this.composer.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.isComposerFocused = false;
    this.composer.on("focus", (_e, cx) => { this.isComposerFocused = true; cx.notify(); });
    this.composer.on("blur", (_e, cx) => { this.isComposerFocused = false; cx.notify(); });
    this.chat = emptyChat();
    this.heights = new Map();
    this.editors = new Map();
    this.copied = null;
    this.parsed = new Map();
    this.status = { mode: "default", effort: null };
    this.menu = null;
    this.pending = new Map();
    this.expanded = new Set();
    this.folded = new Set();
    this.images = new Map();
    this.pictures = new Map();
    this.scannedForPictures = new Map();
    this.attachments = [];
    this.attached = new Map();
    this.isShowingTerminal = false;
    this.picked = {};
    this.questionsSeen = [];

    this.scroll = { top: 0, follow: "end" };
    this.anchorKey = null;
    this.viewportHeight = 0;
    this.viewportWidth = 0;
    this.at = -1;
    this.ticks = 0;
    this.unreadWaits = 0;
    this.presses = 0;
    this.error = "";
    this.keySections = [];
    cx.spawn(async () => { this.keySections = await loadKeys("chat"); });
    cx.bind_keys(COMPOSER_KEYS.map(([keystroke, action, flag]) => ({ keystroke, action, context: `T3ChatComposer && ${flag} > Input` })));
    cx.timer.every(POLL_MS, (cx) => this.tick(cx));
    cx.timer.every(400, (cx) => this.claimKeyboard(cx));
    this.onOwnTab = (cx) => this.act(cx, (cx) => this.open(cx));
  }

  async open(cx) {

    if (this.props.view === "fixture") {
      const text = await readTextFile(`${appHome()}/${this.props.file ?? "mods/t3-chat/fixture.md"}`);

      if (this.props.file?.endsWith(".jsonl")) applyTranscript(this.chat, transcriptLines(text, byteLength).entries);
      else this.chat.items.set("text-fixture", { kind: "text", id: "text-fixture", text, at: 0 });
      this.prepareCode();
      if (this.props.at !== "end") this.scroll.follow = "free";

      if (this.props.screen) this.menu = screenMenu(await readTextFile(`${appHome()}/${this.props.screen}`));
      this.questionsSeen = placeQuestion(this.menu, []);
      await this.loadTranscriptImages();
      this.resolvePictures(cx);
      return "";
    }
    const remembered = (shared(BY_TAB) ?? {})[this.ownTab];

    let given = remembered?.session || !this.props.session ? remembered
      : { machine: this.props.machine ?? null, session: this.props.session, folder: this.props.folder };

    if (given?.chat && !given.session) {
      const old = await oldChat(given.machine ?? null, given.chat);
      if (!old) return "This chat's Claude session isn't known any more: open a new chat.";
      given = { machine: given.machine ?? null, ...old };
    }
    if (given) {
      this.machine = given.machine ?? null;
      this.session = given.session;
      this.started = given.started ?? given.session;
      this.folder = given.folder;
    } else {
      const place = this.props.folder ? { machine: this.props.machine ?? null, folder: this.props.folder } : currentPlace(this.ownTab);
      if (!place?.folder) return "Open a terminal in the space first: the chat starts in its folder.";
      this.machine = place.machine;
      this.folder = place.folder;
      this.session = newSessionId();
      this.started = this.session;
      if (this.ownTab && !this.props.folder) run("tab.move", { id: this.ownTab, index: 1 });
    }
    if (!this.folder) return "This chat has no folder to start Claude Code in.";
    this.remember();
    this.transcript = await findTranscript(this.machine, this.session);
    await this.pull();
    this.files = await listFiles(this.machine, this.folder);
    await this.ensureRunning(cx);
    return "";
  }

  remember() {
    const mine = { machine: this.machine, session: this.session, folder: this.folder, started: this.started };
    const all = shared(BY_TAB) ?? {};
    if (this.ownTab && JSON.stringify(all[this.ownTab]) !== JSON.stringify(mine)) setShared(BY_TAB, { ...all, [this.ownTab]: mine });
  }

  async followSession() {
    const address = this.runTerminal()?.address;
    const now = address ? await sessionOfTerminal(this.machine, address) : null;
    if (!now || now === this.session) return false;
    this.session = now;
    this.transcript = null;
    this.offset = 0;
    this.pending.clear();
    this.chat.items.set(`divider-${now}`, { kind: "divider", id: `divider-${now}`, text: "New conversation", at: Date.now() / 1000 });
    this.remember();
    await labelSession(address, now);
    return true;
  }

  command(command, cx) {
    const cut = command.indexOf(":");
    const [name, value] = cut < 0 ? [command, ""] : [command.slice(0, cut), command.slice(cut + 1)];
    const option = name === "answer" && this.menu?.options.find((o) => o.key === value);
    const row = name === "press" && this.rows().find((r) => r.id === value);
    if (name === "focus") this.composer.focus();
    else if (name === "stop") this.interrupt(cx);
    else if (name === "mode") this.keys(cx, "shift+tab");
    else if (name === "model") this.isPickingModel = !this.isPickingModel;
    else if (name === "end") this.scroll.follow = "end";
    else if (name === "scroll" && this.content) this.scroll = wheel(this.scroll, -Number(value), this.content, this.viewportHeight);
    else if (name === "send") { this.composer.set_value(value); this.submit(cx); }
    else if (name === "draft") { this.composer.focus(); this.setDraft(value); }
    else if (name === "attach" && value) this.attach([value], cx);
    else if (option) this.answer(cx, option);
    else if (row) this.rowAction(row)?.(cx);
    else if (name === "show" && this.rows().some((r) => r.id === value)) this.select(this.rows().findIndex((r) => r.id === value));
    else this.error = `The chat doesn't know the command "${command}".`;
  }

  act(cx, work) {
    cx.spawn(async (cx) => {
      try {
        const failure = await work(cx);
        if (failure) this.error = failure;
      } catch (error) {
        this.error = String(error.message ?? error);
      }
      cx.notify();
    });
  }

  place() {
    const space = spaces().find((s) => s.tabs.some((t) => t.id === this.ownTab));
    return space ? { space: localId(space.id), tab: localId(this.ownTab) } : null;
  }

  liveTerminal(matches) {
    const prefix = this.machine ? `${this.machine}/` : "";
    return terminals().find((t) => t.state !== "finished" && matches(t)
      && (this.machine ? t.address.startsWith(prefix) : !t.address.includes("/")));
  }

  runTerminal() {
    if (!this.session) return undefined;
    return this.liveTerminal((t) => t.argv?.includes(this.session) || t.argv?.includes(this.started))
      ?? (this.props.terminal ? this.liveTerminal((t) => sameTerminal(t.address, this.props.terminal) && Boolean(t.status)) : undefined);
  }

  async ensureRunning(cx) {
    const place = this.place();
    if (!place) throw new Error("This chat's tab isn't known yet.");
    const live = this.runTerminal();
    if (live) {
      if (!panes().some((p) => p.tab === this.ownTab && sameTerminal(p.terminal, live.address))) await adopt(live.address, place);
      return live.address;
    }

    for (const id of await oldChatIds(this.machine, this.session)) {
      const old = this.liveTerminal((t) => t.name === `chat-${id}`.slice(0, 32));
      if (old && ["working", "blocked"].includes(old.status)) throw new Error("The old chat bridge is still answering here: Claude Code takes over once it finishes.");
      if (old) await killTerminal(old.address);
    }

    let started = await runningSession(this.machine, this.session);

    for (let i = 0; !started && this.props.external && !this.transcript && !this.hasWaited && i < EXTERNAL_WAIT; i += 1) {
      await cx.sleep(500);
      started = await runningSession(this.machine, this.session);
    }
    this.hasWaited = true;
    if (started) {
      await adopt(started, place);
      return started;
    }
    return startClaude(this.machine, this.folder, this.session, place, Boolean(this.transcript), this.props.argv ?? ["claude"]);
  }

  hideRunPane() {
    const address = this.runTerminal()?.address;
    if (!this.ownTab || !address || this.isShowingTerminal) return;
    const inTab = panes().filter((p) => p.tab === this.ownTab);
    const own = inTab.find((p) => p.mod === "t3-chat");
    const runPane = inTab.find((p) => sameTerminal(p.terminal, address));
    if (!own || !runPane || inTab.length !== 2) return;
    if (runPane.focused) run("pane.focus", { pane: own.pane });
    if (!own.zoomed) run("pane.zoom", { pane: own.pane });
  }

  toggleTerminal() {
    const inTab = panes().filter((p) => p.tab === this.ownTab);
    const own = inTab.find((p) => p.mod === "t3-chat");
    const runPane = inTab.find((p) => sameTerminal(p.terminal, this.runTerminal()?.address));
    if (!own || !runPane) return (this.error = "Claude Code isn't running: send a message to start it.");
    this.isShowingTerminal = !this.isShowingTerminal;
    if (own.zoomed === this.isShowingTerminal) run("pane.zoom", { pane: own.pane });
    run("pane.focus", { pane: this.isShowingTerminal ? runPane.pane : own.pane });
  }

  state() {
    if (this.props.view === "fixture") return this.props.state ?? "idle";
    if (!this.session) return "starting";

    const live = this.runTerminal();
    return live ? chatState(live.status ?? "unknown") : "stopped";
  }

  isWaitingUnread() {
    return this.state() === "waiting" && !this.menu && this.unreadWaits >= UNREAD_WAITS;
  }

  isVisible() {
    return focused()?.tab === this.ownTab;
  }

  tick(cx) {
    this.ticks += 1;
    const state = this.state();
    const every = ACTIVE.has(state) || this.pending.size ? 1 : this.isVisible() ? 5 : 15;
    if (!this.session || this.isPulling || this.ticks % every) return;
    cx.spawn(async (cx) => {
      const presses = this.presses;
      try {

        this.pulls = (this.pulls ?? 0) + 1;
        const isDue = state !== "working" && (this.sessionChecks > 0 || this.pulls % 10 === 0);
        if (this.sessionChecks > 0) this.sessionChecks -= 1;
        const moved = isDue && await this.followSession();
        const changed = (await this.pull()) || moved;
        if (changed) this.resolvePictures(cx);
        const address = this.runTerminal()?.address;

        const screen = address ? await readScreen(address) : "";

        if (presses !== this.presses) return changed && cx.notify();
        const menu = (state === "waiting" || state === "starting" || this.menu) && screen ? screenMenu(screen) : null;
        this.questionsSeen = placeQuestion(menu, this.questionsSeen);
        this.unreadWaits = state === "waiting" && !menu ? this.unreadWaits + 1 : 0;

        const status = screen && !menu ? screenStatus(screen) : { ...this.status, mode: this.chat.mode ?? this.status.mode };
        await this.readPlan(menu ? screenPlanPath(screen) : null);
        if (changed || JSON.stringify([menu, status, this.plan?.path]) !== JSON.stringify([this.menu, this.status, this.shownPlan])) {
          this.shownPlan = this.plan?.path;
          this.menu = menu;
          if (menu?.steps?.every((step) => !step.isDone)) this.picked = {};
          this.status = status;
          cx.notify();
        }
      } catch (error) {
        this.error = String(error.message ?? error);
        cx.notify();
      }
    });

    if ((state === "working" || state === "waiting") && this.ticks % 2 === 0) cx.notify();
  }

  async pull() {
    this.isPulling = true;
    try {
      this.transcript ??= await findTranscript(this.machine, this.session);
      if (!this.transcript) return false;
      let isChanged = false;
      for (;;) {
        const page = await readFrom(this.machine, this.transcript, this.offset);
        const { entries, bytes } = transcriptLines(page, byteLength);
        if (!bytes) {
          if (byteLength(page) >= TRANSCRIPT_PAGE) throw new Error(`A transcript line is over ${TRANSCRIPT_PAGE} bytes: the chat can't read past it.`);
          break;
        }
        this.offset += bytes;
        if (entries.length) {
          applyTranscript(this.chat, entries);
          await this.loadTranscriptImages();
          isChanged = true;
        }
      }
      if (!isChanged) return false;
      this.prepareCode();
      this.matchPending();

      const tab = spaces().flatMap((s) => s.tabs).find((t) => t.id === this.ownTab);
      const name = !this.props.terminal && !this.props.keepName ? chatTabRename(tab, this.chat.title) : null;
      if (name) run("tab.rename", { id: this.ownTab, name });
      return true;
    } finally {
      this.isPulling = false;
    }
  }

  async loadTranscriptImages() {
    for (const picture of [...this.chat.items.values()].flatMap((i) => i.images ?? []).filter((p) => !this.images.has(p.key))) {
      try {
        this.images.set(picture.key, await displayableImage(picture));
      } catch {
        this.images.set(picture.key, null);
      }

      delete picture.data;
    }
  }

  resolvePictures(cx) {
    this.sharpenPictures(cx);
    const wanted = [];
    for (const item of this.chat.items.values()) {
      if (item.kind !== "text" || this.scannedForPictures.get(item.id) === item.text) continue;
      this.scannedForPictures.set(item.id, item.text);
      wanted.push(...imageSources(item.text).filter((src) => !this.pictures.has(src) && !wanted.includes(src)));
    }
    if (!wanted.length) return;
    for (const src of wanted) this.pictures.set(src, {});
    cx.spawn(async (cx) => {
      for (const src of wanted) {
        const isElsewhere = this.machine !== null && !/^https?:\/\//i.test(src);
        try {
          this.pictures.set(src, isElsewhere ? { error: `on ${machineLabel(this.machine)}, not readable here` } : await referencedImage(src));
        } catch (error) {
          this.pictures.set(src, { error: String(error.message ?? error) });
        }
        cx.notify();
      }
      this.sharpenPictures(cx);
    });
  }

  sharpenPictures(cx) {
    if (this.isSharpening) return;
    const next = () => [...[...this.images].map(([key, shown]) => [this.images, key, shown, THUMB_BOX]),
      ...[...this.pictures].map(([src, shown]) => [this.pictures, src, shown, IMAGE_BOX]),
      ...[...this.attached].map(([path, shown]) => [this.attached, path, shown, shown?.path && coverSize(shown, ATTACHMENT_BOX.width, ATTACHMENT_BOX.height)])].find(([, , shown]) => shown?.path && !shown.thumb);
    if (!next()) return;
    this.isSharpening = true;
    cx.spawn(async (cx) => {
      try {
        for (let found = next(); found; found = next()) {
          const [map, key, shown, box] = found;

          map.set(key, await this.withThumb(shown, box).catch(() => ({ ...shown, thumb: shown.path })));
          cx.notify();
        }
      } finally {
        this.isSharpening = false;
      }
    });
  }

  async withThumb(picture, box) {
    const shown = fitSize(picture, box.width, box.height);
    const pixels = Math.max(shown.width, shown.height) * (settings().zoom ?? 1) * deviceScale();
    return { ...picture, thumb: await resampled(picture, pixels) };
  }

  gallery() {
    const items = new Map();

    const waiting = this.attachments.flatMap((path) => (this.attached.get(path)?.path ? [[path, this.attached.get(path)]] : []));
    for (const item of this.chat.items.values()) {
      for (const picture of item.images ?? []) {
        const shown = this.images.get(picture.key);
        if (!shown) continue;
        const file = `${appHome()}/${shown.path}`;
        items.set(picture.key, { ...shown, id: picture.key, name: `${item.kind === "user" ? "Pasted image" : `${item.name ?? "Tool"} image`} · ${file}`, open: `file://${encodeURI(file)}` });
      }
      if (item.kind !== "text") continue;
      for (const src of imageSources(item.text)) {
        const shown = this.pictures.get(src);
        if (shown?.path) items.set(src, { ...shown, id: src, name: src });
      }
    }
    for (const [path, shown] of waiting) items.set(path, { ...shown, id: path, name: `Attached image · ${path}` });
    return [...items.values()];
  }

  openLink(url, cx) {
    if (this.machine !== null && isLoopbackUrl(url)) openOverlay({ mod: "port-forward", kind: "dialog", width: 520, height: 440, props: { machine: this.machine, open: url } });
    else cx.open_url(url);
  }

  openImage(id) {
    const items = this.gallery().map(({ id: key, path, width, height, open, name }) => ({ id: key, path, width, height, open, name }));
    const at = items.findIndex((item) => item.id === id);
    if (at < 0) return;
    openOverlay({ mod: "t3-chat", kind: "dialog", frame: "none", width: 1, height: 1, props: { view: "lightbox", items, at } });
  }

  matchPending() {
    const users = [...this.chat.items.values()].filter((i) => i.kind === "user");
    for (const [id, text] of this.pending) {
      const found = users.find((u) => u.text.includes(text.trim().slice(0, 200)));
      if (!found) continue;
      this.pending.delete(id);
      if (this.anchorKey === `pending-${id}`) this.anchorKey = found.id;
    }
  }

  submit(cx) {
    const text = this.composer.value().trim();

    if (!text && !this.attachments.length && this.menu?.isQuestion) return this.answer(cx, this.menu.options[this.menu.cursor] ?? { keys: ["enter"] }, ["enter"]);
    if (!text && !this.attachments.length) return;
    const typed = text && this.menu?.options.find(isTypedOption);
    if (typed) return this.answerTyped(cx, typed, text);
    if (this.state() === "waiting" || this.menu) return (this.error = "Claude is waiting for an answer: pick one above, or open its terminal.");
    this.composer.set_value("");
    this.historyAt = -1;
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.pending.set(id, text);
    const files = this.attachments;
    this.attachments = [];
    this.scroll.follow = "anchor";
    this.anchorKey = `pending-${id}`;
    this.act(cx, async (cx) => {
      try {
        const address = await this.ensureRunning(cx);
        await this.refuseMenu(address, cx);
        const paths = [];
        for (const file of files) paths.push(await attachmentPath(this.machine, file, address));
        await sendText(address, [text, ...paths].filter(Boolean).join(" "));
        if (text.startsWith("/")) this.sessionChecks = 8;
        return "";
      } catch (error) {

        this.pending.delete(id);
        this.attachments = files;
        this.setDraft(text);
        throw error;
      }
    });
  }

  async refuseMenu(address, cx) {
    let before = "";
    for (let i = 0; i < 30; i += 1) {
      const screen = await readScreen(address);
      if (screen.trim() && screen === before) {
        this.menu = screenMenu(screen);
        if (this.menu) throw new Error("Claude Code asks something first: answer above, then send again.");
        return;
      }
      before = screen;
      await cx.sleep(500);
    }
  }

  suggestions(draft = this.composer.value()) {
    if (this.suggested?.draft !== draft || this.suggested.files !== this.files) {
      this.suggested = { draft, files: this.files, result: suggestionsFor(draft, COMMANDS, this.files) };
    }
    return this.suggested.result;
  }

  acceptSuggestion(cx, index, draft = this.composer.value()) {
    const { token, items } = this.suggestions(draft);
    const item = items[index];
    if (!item) return;
    const { text, caret } = accepted(draft, token, item.insert);
    this.composer.focus();
    this.setDraft(text, caret);
    this.suggestAt = 0;
    cx.notify();
  }

  setDraft(text, caret = text.length) {
    this.composer.set_value(text);
    this.composer.set_selected_range({ start: caret, end: caret });
  }

  pasteImage(cx) {
    this.act(cx, async (cx) => {
      this.attach([await pastedAttachment()], cx);
      return "";
    });
  }

  attach(paths, cx) {
    this.attachments.push(...paths);
    const images = paths.filter((path) => isImagePath(path) && !this.attached.has(path));
    for (const path of images) this.attached.set(path, {});
    cx.notify();
    if (!images.length) return;
    cx.spawn(async (cx) => {
      for (const path of images) {
        try {
          this.attached.set(path, await referencedImage(path));
        } catch (error) {
          this.attached.set(path, { error: String(error.message ?? error) });
        }
        cx.notify();
      }
      this.sharpenPictures(cx);
    });
  }

  keys(cx, ...keys) {
    const address = this.runTerminal()?.address;
    if (!address) return (this.error = "Claude Code isn't running: send a message to start it.");
    this.presses += 1;
    this.act(cx, async () => {
      await pressKeys(address, ...keys);
      this.presses += 1;
      return "";
    });
  }

  slash(cx, command) {
    if (ACTIVE.has(this.state()) || this.menu) return (this.error = "Claude is busy: change this when its turn ends.");
    const address = this.runTerminal()?.address;
    if (!address) return (this.error = "Claude Code isn't running: send a message to start it.");
    this.act(cx, async () => {
      await sendText(address, command);
      this.sessionChecks = 8;
      return "";
    });
  }

  async readPlan(path) {
    if (path === (this.plan?.path ?? null)) return;
    this.plan = path ? { path, text: await readTextFile(path.replace(/^~/, home()), { on: this.machine }) } : null;
  }

  pendingTool() {
    return pendingTool(this.chat, this.menu);
  }

  answer(cx, option, keys = option.keys) {
    if (isTypedOption(option)) return this.composer.focus();
    this.rememberPick(option);

    if (option.isChecked === null) this.menu = null;
    else option.isChecked = !option.isChecked;
    this.keys(cx, ...keys);
  }

  rememberPick(option, text = option.label) {
    const step = this.menu?.steps?.[this.menu.current];
    if (!step || step.isSubmit || option.kind === "chat" || option.isChecked !== null) return;
    const ticked = this.menu.options.filter((o) => o.isChecked).map((o) => o.label);
    this.picked[step.label] = option.kind === "step" ? ticked.join(", ") : text;
  }

  answerTyped(cx, option, text) {
    const address = this.runTerminal()?.address;
    if (!address) return (this.error = "Claude Code isn't running: send a message to start it.");
    const { keys, after } = typedAnswer(this.menu, option);
    this.rememberPick(option, text);
    this.composer.set_value("");
    this.menu = null;
    this.presses += 1;
    this.act(cx, async () => {
      if (keys.length) await pressKeys(address, ...keys);
      await sendText(address, text, true);
      if (after.length) await pressKeys(address, ...after);
      this.presses += 1;
      return "";
    });
  }

  interrupt(cx) {
    if (ACTIVE.has(this.state())) this.keys(cx, "esc");
  }

  learnTab(cx) {
    if (this.ownTab) return;
    this.ownTab = spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id ?? null;
    this.onOwnTab?.(cx);
  }

  claimKeyboard(cx) {
    const isPaneFocused = panes().some((p) => p.mod === "t3-chat" && p.tab === this.ownTab && p.focused);
    const isNewlyFocused = isPaneFocused && !this.wasPaneFocused;
    this.wasPaneFocused = isPaneFocused;
    if (isNewlyFocused) {
      this.isShowingTerminal = false;
      this.composer.focus();
      cx.notify();
    }
    this.hideRunPane();
  }

  blocksOf(item) {
    const cached = this.parsed.get(item.id);
    if (cached?.text === item.text) return cached.blocks;
    const cut = blocks(item.text);
    this.parsed.set(item.id, { text: item.text, blocks: cut });
    return cut;
  }

  prepareCode(cx) {
    const t = theme();
    const syntax = { keyword: t.ansi5, string: t.ansi2, "string.escape": t.ansi6, comment: t.dim, function: t.ansi4, type: t.ansi3,
      number: t.ansi3, constant: t.ansi6, boolean: t.ansi6, variable: t.foreground, operator: t.muted, punctuation: t.muted };
    const live = new Set();
    for (const row of this.rows()) {
      if (row.kind !== "code-body") continue;
      live.add(row.id);
      const language = codeLanguage(row.block.lang);
      const kept = this.editors.get(row.id);
      if (!language || kept?.text === row.block.text) continue;
      if (kept) kept.state.set_value(row.block.text);
      else this.editors.set(row.id, { state: EditorState.new({ language, value: row.block.text, readonly: true, line_numbers: false, folding: false,
        font_size: CODE.size, font_family: settings().font_family ?? "JetBrains Mono", syntax }) });
      this.editors.get(row.id).text = row.block.text;
    }
    for (const [id, kept] of this.editors) if (!live.has(id)) { kept.state.release(); this.editors.delete(id); }
    cx?.notify();
  }

  rowAction(row) {
    const copy = { "code-head": () => row.block.text, "table-copy": () => row.block.raw, user: () => row.text, meta: () => row.text }[row.kind];
    if (copy) return (cx) => {
      cx.write_to_clipboard(copy());
      this.copied = row.id;
      cx.timer.after(1200, (cx) => { if (this.copied === row.id) this.copied = null; cx.notify(); });
    };

    if (row.kind === "changed") return () => {
      run("layout.show", { id: "panel" });
      run("layout.select", { stack: "panel-body", child: "changes" });
    };
    if (row.kind === "work" || row.kind === "entry" || row.kind === "proposed-plan" || (row.kind === "md" && row.block.type === "details")) return () => {
      const isOpen = this.isOpen(row);
      this.expanded.delete(row.id);
      this.folded.delete(row.id);
      (isOpen ? this.folded : this.expanded).add(row.id);
    };
    return null;
  }

  isOpen(row) {
    if (this.folded.has(row.id)) return false;
    return this.expanded.has(row.id) || (row.kind === "work" && row.isLive);
  }

  textRows(item) {
    return this.blocksOf(item).flatMap((block, i, all) => {
      const row = { id: `${item.id}#${i}`, block, previous: all[i - 1] ?? null };

      if (block.type === "table") return [{ kind: "md", ...row }, { kind: "table-copy", ...row, id: `${row.id}:copy`, fixedHeight: 26 }];
      if (block.type !== "code") return [{ kind: "md", ...row }];

      return [{ kind: "code-head", ...row, id: `${row.id}:head`, fixedHeight: Math.ceil(gapBefore(row.previous, block) + CODE.head) },
        { kind: "code-body", ...row, fixedHeight: Math.ceil(codeBodyHeight(block.text)) },

        ...(block.lang === "html" && !block.isOpen && block.text.trim() ? [{ kind: "html-preview", ...row, id: `${row.id}:preview` }] : [])];
    });
  }

  rows() {

    const isWorking = ["working", "waiting"].includes(this.state());
    const rows = timeline(this.chat, { isWorking }).flatMap((item) => {
      if (item.kind === "text") return [...this.textRows(item), { kind: "text-end", id: `${item.id}:end`, fixedHeight: 8 }];
      if (item.kind === "work") return [item, ...(this.isOpen(item) ? item.entries.map((entry) => ({ kind: "entry", id: entry.id, entry })) : [])];
      return [item];
    });
    for (const [id, text] of this.pending) rows.push({ kind: "user", id: `pending-${id}`, text, images: [], isPending: true });

    if (isWorking && !rows.some((row) => row.kind === "work" && row.isLive)) rows.push({ kind: "working", id: "working", startedAt: rows.findLast((row) => row.kind === "user")?.at });
    return rows;
  }

  key(e, cx) {
    const stroke = e.keystroke;
    const isComposing = !this.handle.is_focused();
    if (this.isShowingKeys || (isHelpKey(stroke) && !isComposing)) {
      if (!this.isShowingKeys || isHelpKey(stroke) || stroke === "escape") this.isShowingKeys = !this.isShowingKeys;
      cx.stop_propagation();
      return cx.notify();
    }

    const menuKey = this.menu && (!isComposing || this.composer.value() === "") && this.menu.options.find((o) => o.key === stroke);
    if (menuKey) {
      this.answer(cx, menuKey);
    } else if (this.menu?.isQuestion && (!isComposing || this.composer.value() === "") && (stroke === "up" || stroke === "down")) {
      this.keys(cx, stroke);
    } else if (stroke === "shift-tab") {
      this.keys(cx, "shift+tab");
    } else if (isComposing) {
      if (stroke === "escape") {
        if (this.isPickingModel) this.isPickingModel = false;
        else if (ACTIVE.has(this.state())) this.interrupt(cx);
        else this.handle.focus();
      } else return;
    } else {
      const count = this.rows().length;
      if (stroke === "escape") { if (ACTIVE.has(this.state())) this.interrupt(cx); else run("pane.close"); }
      else if ((stroke === "j" || stroke === "down") && count) this.select(Math.min(count - 1, this.at + 1));
      else if ((stroke === "k" || stroke === "up") && count) this.select(Math.max(0, this.at < 0 ? count - 1 : this.at - 1));
      else if (stroke === "g") this.select(0);
      else if (stroke === "shift-g") { this.at = -1; this.scroll.follow = "end"; }
      else if ((stroke === "l" || stroke === "enter" || stroke === "h") && this.rows()[this.at]) {
        const row = this.rows()[this.at];
        if (this.isOpen(row) !== (stroke !== "h")) this.rowAction(row)?.(cx);
      }
      else if (stroke === "i" || stroke === "a") this.composer.focus();
      else if (stroke === "t") this.toggleTerminal();
      else return;
    }
    cx.stop_propagation();
    cx.notify();
  }

  composerRoute(key) {
    return composerKeyRoute(key, { hasSuggestions: this.suggestions().items.length > 0, isQuestion: Boolean(this.menu?.isQuestion),
      isEmpty: this.composer.value() === "", recalls: this.recalls() });
  }

  composerContext() {
    return ["T3ChatComposer", this.composerRoute("up") !== "box" && "arrows", this.composerRoute("tab") !== "box" && "tabs"].filter(Boolean).join(" ");
  }

  composerKey(key, cx) {
    const { token, items } = this.suggestions();
    const route = this.composerRoute(key);
    if (route === "box") return cx.propagate();
    this.suggestToken = token;
    if (route === "suggest" && key === "tab") this.acceptSuggestion(cx, this.suggestAt);
    else if (route === "suggest") this.suggestAt = (this.suggestAt + (key === "down" ? 1 : items.length - 1)) % items.length;
    else if (route === "question") this.keys(cx, key);
    else {
      const { at, text } = historyStep(this.sent(), this.historyAt, key === "up" ? 1 : -1);
      this.historyAt = at;
      this.setDraft(text);
    }
    cx.notify();
  }

  sent() {
    return [...this.chat.items.values()].filter((item) => item.kind === "user" && item.text).map((item) => item.text);
  }

  recalls() {
    const draft = this.composer.value();
    return draft === "" || (this.historyAt >= 0 && draft === historyStep(this.sent(), this.historyAt, 0).text);
  }

  select(index) {
    this.at = index;
    this.scroll = { top: Math.max(0, (this.content?.tops[index] ?? 0) - 8), follow: "free" };
  }

  drag(e, zoom) {
    if (!this.dragging) return false;
    this.scroll = dragged(this.dragging.from, (e.position.y - this.dragging.y) / zoom, this.scrollable, this.viewportHeight);
    return true;
  }

  project() {
    return spaces().find((s) => s.tabs.some((tab) => tab.id === this.ownTab))?.name ?? "";
  }

  laneWidth() {
    return Math.min(CONTENT_WIDTH, Math.max(160, this.viewportWidth - 2 * LANE_INSET));
  }

  rowHeight(row) {
    if (row.fixedHeight !== undefined) return row.fixedHeight;
    const known = this.heights.get(row.id);
    if (known !== undefined) return known;
    const width = this.laneWidth();
    if (row.kind === "md") return estimateRowHeight({ kind: "notice", text: row.block.raw }, { width });
    if (row.kind === "user") return estimateRowHeight(row, { width }) + 40;
    if (row.kind === "changed") return 60 + row.files.length * 28;
    return { work: 44, working: 44, entry: 24, meta: 42, turn: 40 }[row.kind] ?? estimateRowHeight(row, { width });
  }

  measured(row, height, cx) {
    const before = this.rowHeight(row);
    if (Math.abs(height - before) < 0.5) return;
    this.heights.set(row.id, height);
    const index = this.shown?.findIndex((r) => r.id === row.id) ?? -1;
    if (index >= 0) this.scroll = resized(this.scroll, this.content.tops[index], height - before);
    cx.notify();
  }

  icon(name, size, color) {
    return svg(`mods/t3-chat/icons/${name}.svg`).size(size).flex_none().text_color(color);
  }

  spinner(size, color) {
    return svg("mods/t3-chat/icons/spinner.svg").size(size).flex_none().text_color(color).spin(900);
  }

  item(row, t, mono) {
    const ctx = { view: this, t, mono, p: "", now: Date.now() / 1000, images: this.images, openImage: (key) => this.openImage(key), copied: this.copied, hovered: this.hovered, folder: this.folder };
    switch (row.kind) {
      case "md": return mdBlock(row.block, row.previous, `md-${row.id}`, t, { isOpen: this.isOpen(row), width: this.laneWidth(), pictures: this.pictures, onOpenImage: (src) => this.openImage(src), onOpenLink: (url, cx) => this.openLink(url, cx) });
      case "code-head": return codeHead(this, `copy-${row.id}`, row.block, row.fixedHeight, t, mono, this.copied === row.id);
      case "code-body": return codeBody(row.block, row.fixedHeight, this.editors.get(row.id)?.state, t, mono);
      case "table-copy": return copyRow(this, `copy-${row.id}`, t, this.copied === row.id);
      case "html-preview": return htmlPreview(row.block, `html-${row.id}`, t);
      case "text-end": return div().h(8);
      case "user": return userRow(row, ctx, this.laneWidth());
      case "work": return foldRow(row, ctx, this.isOpen(row));
      case "entry": return entryRow(row.entry, ctx, this.isOpen(row));
      case "meta": return metaRow(row, ctx);
      case "changed": return changedRow(row, ctx);
      case "proposed-plan": return planRow(row, ctx, this.isOpen(row));
      case "working": return workingRow(row, ctx);
      case "turn": return dividerRow("Interrupted", ctx);
      case "divider": return dividerRow(row.text, ctx);
      default: return noticeRow(row, ctx);
    }
  }

  conversation(rows, t, mono, zoom) {
    const lane = this.laneWidth();
    const heights = rows.map((row) => Math.ceil(this.rowHeight(row)));
    const content = layout(heights);
    const anchor = this.scroll.follow === "anchor" ? rows.findIndex((row) => row.id === this.anchorKey) : -1;
    this.scroll = settle(this.scroll, content, this.viewportHeight, anchor);
    this.shown = rows;
    this.content = content;
    const { top } = this.scroll;
    const { first, end } = visibleRange(content, heights, top, this.viewportHeight);
    const total = Math.max(content.total, maxTop(content, this.viewportHeight, anchor) + this.viewportHeight);
    const bar = thumb(top, total, this.viewportHeight);
    this.scrollable = total;
    return div().id("chat-rows").size_full().relative().overflow_hidden()
      .on_scroll_wheel((e, cx) => {
        cx.stop_propagation();

        this.scroll = wheel(this.scroll, e.delta.y / zoom, this.content, this.viewportHeight);
        this.at = -1;
        cx.notify();
      })
      .children(rows.slice(first, end).map((row, k) => {
        const action = this.rowAction(row);
        const placed = h_flex().id(`row-${row.id}`).absolute().left(0).right(0).top(content.tops[first + k] - top).justify_center()

          .child(div().w(lane).flex_none().rounded(6).when(first + k === this.at, (el) => el.bg(`${t.accent}14`)).child(this.item(row, t, mono)));
        const sized = row.fixedHeight !== undefined ? placed

          : placed.on_size_change((size, cx) => this.measured(row, size.height / zoom, cx));

        const heard = row.kind !== "user" && row.kind !== "meta" ? sized : sized.on_hover((isOver, cx) => {
          if (isOver) this.hovered = row.id;
          else if (this.hovered === row.id) this.hovered = null;
          cx.notify();
        });
        return action ? heard.on_click((_e, cx) => { action(cx); cx.notify(); }) : heard;
      }))

      .when(Boolean(bar), (el) => el.child(div().id("chat-scrollbar").absolute().top(0).bottom(0).right(0).w(12)
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          const y = (e.local_position?.y ?? 0) / zoom;
          if (y < bar.offset || y > bar.offset + bar.size) this.scroll = trackPressed(y, total, this.viewportHeight);
          this.dragging = { from: this.scroll.top, y: e.position.y };
          cx.notify();
        })
        .child(div().absolute().right(2).w(6).rounded(3).top(bar.offset).h(bar.size).bg(`${t.foreground}${this.dragging ? "66" : "33"}`))));
  }

  render() {
    const t = theme();
    const mono = settings().font_family ?? "JetBrains Mono";
    const rows = this.rows();
    const state = this.state();
    const isActive = ACTIVE.has(state);
    const zoom = settings().zoom ?? 1;

    const isHero = rows.length === 0;
    const foot = composer(this, t, mono, { isActive, state, lane: this.laneWidth() });
    return v_flex().id("t3-chat").on_size_change((_size, cx) => this.learnTab(cx)).track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_drop((event, cx) => this.attach(event.paths, cx))
      .on_mouse_move((e, cx) => { if (this.drag(e, zoom)) cx.notify(); })
      .on_mouse_up("left", (_e, cx) => { if (this.dragging) { this.dragging = null; cx.notify(); } })
      .size_full().min_h(0).relative().bg(t.background).text_color(t.foreground)

      .child(v_flex().relative().flex_1().min_h(0).px(LANE_INSET)
        .on_size_change((size, cx) => {
          this.viewportHeight = size.height / zoom;
          this.viewportWidth = size.width / zoom;

          cx.notify();
        })
        .child(isHero ? v_flex().size_full().justify_center().child(hero(this, t, this.project())).child(foot) : this.conversation(rows, t, mono, zoom))

        .when(this.scroll.follow === "free" && rows.length > 0, (el) => el.child(h_flex().absolute().bottom(8).left(0).right(0).justify_center()
          .child(h_flex().id("chat-latest").h(24).pl(8).pr(10).gap(4).items_center().rounded(12).bg(t.popover).border(1).border_color(t.border).shadow_md()
            .text_size(12).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.scroll.follow = "end"; this.at = -1; cx.notify(); })
            .child(this.icon("chevron-down", 12, t.muted)).child("Scroll to end")))))

      .when(!isHero, (el) => el.child(foot))
      .when(this.isShowingKeys, (el) => el.child(keyHelp("chat-keys", "Chat keys", this.keySections, t)
        .on_mouse_down("left", (_e, cx) => { this.isShowingKeys = false; cx.notify(); })));
  }
}
