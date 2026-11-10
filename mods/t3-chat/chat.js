// One chat (a tab): a Claude Code session drawn as messages, tool calls and its questions, with a
// box to write in. Claude Code itself runs in a terminal pane of the same tab (hidden behind the
// chat by zoom), so Herdr sees a real agent in the tab's space; the chat reads its transcript and
// types into it. props: { view: "chat", agent: "claude", folder?, machine? } for a new chat (in that
// folder, else the tab's space's), or { view: "chat", machine, session, folder, terminal? } for a
// session; terminal: a Claude Code already running that session in this tab (one started as a
// plain terminal, taken over as it is: nothing is restarted); external: true when whoever made
// the tab starts the session's Claude Code itself (scripts/start-task.mjs), so the chat waits for it;
// argv: the command that starts Claude Code when it isn't plain `claude` (a coordinator's, with
// its account in env); keepName: the tab keeps its name instead of being named by the first message.
// Which session a tab shows is kept in shared "chats.byTab" (tab id -> { machine, session, folder,
// started }), so the tab shows it again after a restart. started: the session its Claude Code was
// started on (in its argv); session moves on when Claude Code does (/clear), see followSession.

import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, TextView, EditorState } from "gpui-base";
import { theme, run, panes, focused, settings, shared, setShared, spaces, terminals, openOverlay } from "herdr";
import { startClaude, runningSession, sessionOfTerminal, labelSession, adopt, killTerminal, sendText, pressKeys, readScreen, findTranscript, readFrom, TRANSCRIPT_PAGE, byteLength, oldChat, oldChatIds, attachmentPath, displayableImage, referencedImage, resampled, deviceScale, pastedAttachment, listFiles, machineLabel, currentPlace } from "./host.js";
import { COMMANDS, emptyChat, applyTranscript, transcriptLines, timeline, chatState, screenMenu, suggestionsFor, accepted, composerKeyRoute, chatTabRename, estimateRowHeight, historyStep, screenStatus, screenPlanPath, pendingTool, isTypedOption, typedAnswer, placeQuestion, fitSize, coverSize, isImagePath } from "./model.js";
import { isHelpKey, keyHelp, loadKeys } from "./keyhelp.js";
import { blocks, codeLanguage, codeBodyHeight, gapBefore, imageSources, CODE } from "./markdown.js";
import { mdBlock, codeHead, codeBody, copyRow, htmlPreview, IMAGE_BOX } from "./render-md.js";
import { userRow, foldRow, entryRow, metaRow, workingRow, dividerRow, noticeRow, changedRow, planRow, THUMB_BOX } from "./timeline.js";
import { composer, hero, PLACEHOLDER, ATTACHMENT_BOX } from "./composer.js";
import { layout, maxTop, settle, wheel, resized, visibleRange, thumb, dragged, trackPressed } from "./scroll.js";
import { appHome, readTextFile, home } from "herdr";

const POLL_MS = 400; // while Claude works; slower when idle or hidden (see tick)
// Reads in a row that saw Claude wait with no menu the chat can draw, before it sends the person
// to the terminal: right after an answer from here Claude can still be blocked on the next step,
// or its status a moment behind its screen.
const UNREAD_WAITS = 2;
const ACTIVE = new Set(["starting", "working", "waiting"]);
const BY_TAB = "chats.byTab";
const EXTERNAL_WAIT = 40; // half seconds a chat waits for a Claude Code its maker starts
const CONTENT_WIDTH = 736; // T3's --chat-content-max-width: 46rem
const LANE_INSET = 16; // the conversation's side padding
// The box takes Up, Down and Tab for itself (the caret, the focus) before the chat hears them:
// bindings of the chat's own in the box's context come first (ChatView.composerKey). They apply
// only while the box's context says the chat wants the key (composerContext), so the box keeps
// its own keys otherwise: Up and Down move the caret over a draft's lines.
const COMPOSER_KEYS = [["up", "t3_chat_up", "arrows"], ["down", "t3_chat_down", "arrows"], ["tab", "t3_chat_tab", "tabs"]];

// A session id Claude Code accepts (a v4 UUID). Not a secret: Math.random is enough.
function newSessionId() {
  const hex = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const localId = (id) => id.replace(/^[^/]+\//, "");
// The draft less the newline the box put in for the Enter it is about to report as a submit.
const withoutEnter = (draft) => draft.replace(/\r?\n$/, "");
const sameTerminal = (a, b) => Boolean(a && b) && localId(a) === localId(b);

export class ChatView {
  constructor(props, cx) {
    this.props = props;
    this.machine = null;
    this.session = null; // the Claude Code session id
    this.folder = null;
    this.transcript = null; // its path on the machine, once Claude Code wrote it
    this.offset = 0;
    this.handle = cx.focus_handle();
    this.ownTab = null; // learnt at the first layout: a pane is laid out only while its tab shows
    this.composer = TextareaState.new({ placeholder: PLACEHOLDER });
    this.composer.set_auto_grow(2, 10);
    this.historyAt = -1; // which sent message ArrowUp has put in the box (-1: none)
    // Enter takes the highlighted suggestion while the / or @ menu is open (as T3), else sends.
    // The box has put the Enter's newline in by then: the menu is read without it.
    this.composer.on("submit", (e, cx) => {
      if (e.shift) return;
      const draft = withoutEnter(this.composer.value());
      if (this.suggestions(draft).items.length) this.acceptSuggestion(cx, this.suggestAt, draft);
      else this.submit(cx);
    });
    // The highlight starts over for another token, not for the Enter's newline.
    this.composer.on("change", (_e, cx) => {
      const { token } = this.suggestions(withoutEnter(this.composer.value()));
      if (token !== this.suggestToken) this.suggestAt = 0;
      this.suggestToken = token;
      cx.notify();
    });
    this.suggestAt = 0; // the highlighted suggestion (slash commands, @files) under the box
    this.files = []; // the chat folder's files, for @ mentions
    this.composer.on("paste_other", (_e, cx) => this.pasteImage(cx)); // a paste without text: a file or an image, if any
    this.isComposerFocused = false;
    this.composer.on("focus", (_e, cx) => { this.isComposerFocused = true; cx.notify(); });
    this.composer.on("blur", (_e, cx) => { this.isComposerFocused = false; cx.notify(); });
    this.chat = emptyChat();
    this.heights = new Map(); // row id -> its height as last laid out (rows report their own)
    this.editors = new Map(); // code row id -> { text, state }: the code views' retained states
    this.copied = null; // the row whose text was just copied
    this.parsed = new Map(); // text item id -> { text, blocks }: a message is cut into blocks once per text
    this.status = { mode: "default", effort: null }; // Claude Code's mode and effort, read off its screen
    this.menu = null; // Claude Code's numbered menu while it waits for the person (read off its screen)
    this.pending = new Map(); // message id -> text, until the transcript shows it
    this.expanded = new Set(); // rows opened by hand: work groups, their entries, details
    this.folded = new Set(); // rows folded by hand (a live work group is open otherwise)
    this.images = new Map(); // picture key -> path image() can draw
    this.pictures = new Map(); // an image a reply points at (its src) -> { path, open } | { error } | {} while it loads
    this.scannedForPictures = new Map(); // text item id -> the text its images were looked for in
    this.attachments = []; // local paths dropped or pasted on the chat, sent with the next message
    this.attached = new Map(); // an attachment that is an image (its path) -> { path, thumb?, width, height, open } | { error } | {} while it loads
    this.isShowingTerminal = false; // the person asked to see Claude Code's own terminal
    this.picked = {}; // a question's step header -> what was picked for it here (its screen doesn't say)
    this.questionsSeen = []; // the question's texts in the order shown (placeQuestion)
    // Where the conversation is scrolled to and how it moves with the content (scroll.js).
    this.scroll = { top: 0, follow: "end" };
    this.anchorKey = null; // the sent message's row id while anchored
    this.viewportHeight = 0;
    this.viewportWidth = 0;
    this.at = -1; // selected item, for j/k
    this.ticks = 0;
    this.unreadWaits = 0; // see UNREAD_WAITS
    this.presses = 0; // keys sent from here, counted as they go and as they land (see tick)
    this.error = "";
    this.keySections = [];
    cx.spawn(async () => { this.keySections = await loadKeys("chat"); });
    cx.bind_keys(COMPOSER_KEYS.map(([keystroke, action, flag]) => ({ keystroke, action, context: `T3ChatComposer && ${flag} > Input` })));
    cx.timer.every(POLL_MS, (cx) => this.tick(cx));
    cx.timer.every(400, (cx) => this.claimKeyboard(cx));
    this.onOwnTab = (cx) => this.act(cx, (cx) => this.open(cx));
  }

  // Which session this tab shows: given, remembered, an old bridge chat's, else a new one.
  async open(cx) {
    // The renderer's sample as one assistant message, without a session (RENDERER.md).
    if (this.props.view === "fixture") {
      const text = await readTextFile(`${appHome()}/${this.props.file ?? "mods/t3-chat/fixture.md"}`);
      // A .jsonl is a Claude Code transcript; anything else is one reply's Markdown.
      if (this.props.file?.endsWith(".jsonl")) applyTranscript(this.chat, transcriptLines(text, byteLength).entries);
      else this.chat.items.set("text-fixture", { kind: "text", id: "text-fixture", text, at: 0 });
      this.prepareCode();
      if (this.props.at !== "end") this.scroll.follow = "free";
      // screen: a file holding Claude Code's screen, so its question or approval is drawn too.
      if (this.props.screen) this.menu = screenMenu(await readTextFile(`${appHome()}/${this.props.screen}`));
      this.questionsSeen = placeQuestion(this.menu, []);
      await this.loadTranscriptImages();
      this.resolvePictures(cx);
      return "";
    }
    const remembered = (shared(BY_TAB) ?? {})[this.ownTab];
    // What the tab remembers is newer than what it was opened with (the session may have moved on).
    let given = remembered?.session || !this.props.session ? remembered
      : { machine: this.props.machine ?? null, session: this.props.session, folder: this.props.folder };
    // A tab from the headless bridge (chat: its id there): its Claude session, resumed in a terminal.
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

  // Commands for this mod (keys.json `t3-chat.<command>`, or `herdr-app do t3-chat.<command>:<value>`):
  // focus, stop, mode (Claude Code's next mode), model (its menu), end, answer:<n>, scroll:<px> (down; negative is back), send:<text>, draft:<text> (puts it in the box), attach:<path> (a file for the next message), press:<row id>,
  // show:<row id> (scrolls to it).
  remember() {
    const mine = { machine: this.machine, session: this.session, folder: this.folder, started: this.started };
    const all = shared(BY_TAB) ?? {};
    if (this.ownTab && JSON.stringify(all[this.ownTab]) !== JSON.stringify(mine)) setShared(BY_TAB, { ...all, [this.ownTab]: mine });
  }

  // Claude Code moved to another session in the same process (/clear): the chat goes with it.
  // What was said before stays above a divider until the chat is opened anew. True when it moved.
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
        if (failure) this.error = failure; // a failure stays until dismissed: a later success doesn't hide it
      } catch (error) {
        this.error = String(error.message ?? error);
      }
      cx.notify();
    });
  }

  // The chat's tab and its space, as ids on the chat's machine (Herdr shows remote ones as machine/id).
  place() {
    const space = spaces().find((s) => s.tabs.some((t) => t.id === this.ownTab));
    return space ? { space: localId(space.id), tab: localId(this.ownTab) } : null;
  }

  // A live core terminal on the chat's machine that matches, or undefined.
  liveTerminal(matches) {
    const prefix = this.machine ? `${this.machine}/` : "";
    return terminals().find((t) => t.state !== "finished" && matches(t)
      && (this.machine ? t.address.startsWith(prefix) : !t.address.includes("/")));
  }

  // The session's live Claude Code terminal (started with the session id in its argv), or undefined.
  // Or the terminal the chat was given (props.terminal), while Claude Code still runs in it: once
  // it ends there, its shell must never be typed into. An agent reports a status for as long as
  // it runs (also while a command of its own is in front); a shell reports none.
  runTerminal() {
    if (!this.session) return undefined;
    return this.liveTerminal((t) => t.argv?.includes(this.session) || t.argv?.includes(this.started))
      ?? (this.props.terminal ? this.liveTerminal((t) => sameTerminal(t.address, this.props.terminal) && Boolean(t.status)) : undefined);
  }

  // Claude Code running for this session, in this tab: the live one (moved here when it is
  // elsewhere), else a new one. Never while the old bridge still drives the same session.
  async ensureRunning(cx) {
    const place = this.place();
    if (!place) throw new Error("This chat's tab isn't known yet.");
    const live = this.runTerminal();
    if (live) {
      if (!panes().some((p) => p.tab === this.ownTab && sameTerminal(p.terminal, live.address))) await adopt(live.address, place);
      return live.address;
    }
    // A chat made by the old headless bridge may still drive this session: never two Claudes on one.
    for (const id of await oldChatIds(this.machine, this.session)) {
      const old = this.liveTerminal((t) => t.name === `chat-${id}`.slice(0, 32));
      if (old && ["working", "blocked"].includes(old.status)) throw new Error("The old chat bridge is still answering here: Claude Code takes over once it finishes.");
      if (old) await killTerminal(old.address);
    }
    // Never a second Claude Code on the session: one that just started (a task's, started by
    // scripts/start-task.mjs) may not be in the app's list yet, so herdr-core is asked.
    let started = await runningSession(this.machine, this.session);
    // A tab whose maker starts Claude Code (props.external) may show before it has: wait for it once.
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

  // While the tab holds only the chat and Claude Code, the chat stays zoomed so the terminal is
  // hidden, unless the person asked to see it.
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

  // Claude Code's terminal beside the chat (to answer something the chat can't show), or hidden again.
  toggleTerminal() {
    const inTab = panes().filter((p) => p.tab === this.ownTab);
    const own = inTab.find((p) => p.mod === "t3-chat");
    const runPane = inTab.find((p) => sameTerminal(p.terminal, this.runTerminal()?.address));
    if (!own || !runPane) return (this.error = "Claude Code isn't running: send a message to start it.");
    this.isShowingTerminal = !this.isShowingTerminal;
    if (own.zoomed === this.isShowingTerminal) run("pane.zoom", { pane: own.pane });
    run("pane.focus", { pane: this.isShowingTerminal ? runPane.pane : own.pane });
  }

  // ------------------------------------------------------------------ data

  state() {
    if (this.props.view === "fixture") return this.props.state ?? "idle";
    if (!this.session) return "starting";
    // A live terminal that reports no status yet is Claude Code starting (it may ask to trust the folder).
    const live = this.runTerminal();
    return live ? chatState(live.status ?? "unknown") : "stopped";
  }

  // Claude waits for something the chat can't draw: its terminal answers.
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
        // Between turns, and soon after a slash command: is Claude Code still on this session?
        this.pulls = (this.pulls ?? 0) + 1;
        const isDue = state !== "working" && (this.sessionChecks > 0 || this.pulls % 10 === 0);
        if (this.sessionChecks > 0) this.sessionChecks -= 1;
        const moved = isDue && await this.followSession();
        const changed = (await this.pull()) || moved;
        if (changed) this.resolvePictures(cx);
        const address = this.runTerminal()?.address;
        // Claude Code asks before it reports a status too (trusting a folder): read while starting.
        const screen = address ? await readScreen(address) : "";
        // Keys went in since: this screen can be from before them, and bring back what they answered.
        if (presses !== this.presses) return changed && cx.notify();
        const menu = (state === "waiting" || state === "starting" || this.menu) && screen ? screenMenu(screen) : null;
        this.questionsSeen = placeQuestion(menu, this.questionsSeen);
        this.unreadWaits = state === "waiting" && !menu ? this.unreadWaits + 1 : 0;
        // A menu covers Claude Code's footer: its mode is as it was.
        const status = screen && !menu ? screenStatus(screen) : { ...this.status, mode: this.chat.mode ?? this.status.mode };
        await this.readPlan(menu ? screenPlanPath(screen) : null);
        if (changed || JSON.stringify([menu, status, this.plan?.path]) !== JSON.stringify([this.menu, this.status, this.shownPlan])) {
          this.shownPlan = this.plan?.path;
          this.menu = menu;
          if (menu?.steps?.every((step) => !step.isDone)) this.picked = {}; // a new question
          this.status = status;
          cx.notify();
        }
      } catch (error) {
        this.error = String(error.message ?? error);
        cx.notify();
      }
    });
    // The working timer counts seconds.
    if ((state === "working" || state === "waiting") && this.ticks % 2 === 0) cx.notify();
  }

  // New transcript lines folded in; true when something changed (the caller redraws with its live cx).
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
          await this.loadTranscriptImages(); // page by page, so the images' base64 goes before the next page
          isChanged = true;
        }
      }
      if (!isChanged) return false;
      this.prepareCode();
      this.matchPending();
      // A chat's tab is named by its first message, unless the person named it; a tab taken over
      // with its terminal keeps its name.
      const tab = spaces().flatMap((s) => s.tabs).find((t) => t.id === this.ownTab);
      const name = !this.props.terminal && !this.props.keepName ? chatTabRename(tab, this.chat.title) : null;
      if (name) run("tab.rename", { id: this.ownTab, name });
      return true;
    } finally {
      this.isPulling = false;
    }
  }

  // The images in the transcript itself (pasted ones, a tool's screenshots) as files image() can draw.
  async loadTranscriptImages() {
    for (const picture of [...this.chat.items.values()].flatMap((i) => i.images ?? []).filter((p) => !this.images.has(p.key))) {
      try {
        this.images.set(picture.key, await displayableImage(picture));
      } catch {
        this.images.set(picture.key, null); // shown as a label instead
      }
      // The image is a file now: its base64 (screenshots run to megabytes each) would otherwise
      // stay in memory for the chat's life, and big chats ran the mods' shared heap out.
      delete picture.data;
    }
  }

  // The images replies point at (paths, URLs), made drawable in a task of their own, so a slow
  // download doesn't hold up the transcript. A path on another machine can't be read here.
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

  // Sharp copies (withThumb) of the pictures shown without one yet, one at a time in the
  // background: they draw from the original until then, and the transcript never waits for them.
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
          // A copy that can't be made leaves the original drawn (only less sharp); the loop moves on.
          map.set(key, await this.withThumb(shown, box).catch(() => ({ ...shown, thumb: shown.path })));
          cx.notify();
        }
      } finally {
        this.isSharpening = false;
      }
    });
  }

  // A picture with a sharp copy (thumb) for the largest it is drawn: box, at this zoom, in device pixels.
  async withThumb(picture, box) {
    const shown = fitSize(picture, box.width, box.height);
    const pixels = Math.max(shown.width, shown.height) * (settings().zoom ?? 1) * deviceScale();
    return { ...picture, thumb: await resampled(picture, pixels) };
  }

  // Every image the chat shows, in order: pasted and tool images, and those its replies point at.
  // id: a transcript picture's key, or a reply image's src.
  gallery() {
    const items = new Map();
    // The images waiting in the composer come last, after the conversation's.
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

  // The chat's images in a lightbox over the window, at the one clicked.
  openImage(id) {
    const items = this.gallery().map(({ id: key, path, width, height, open, name }) => ({ id: key, path, width, height, open, name }));
    const at = items.findIndex((item) => item.id === id);
    if (at < 0) return;
    openOverlay({ mod: "t3-chat", kind: "dialog", frame: "none", width: 1, height: 1, props: { view: "lightbox", items, at } });
  }

  // A sent message leaves the pending list once the transcript has it (the anchor moves with it).
  matchPending() {
    const users = [...this.chat.items.values()].filter((i) => i.kind === "user");
    for (const [id, text] of this.pending) {
      const found = users.find((u) => u.text.includes(text.trim().slice(0, 200)));
      if (!found) continue;
      this.pending.delete(id);
      if (this.anchorKey === `pending-${id}`) this.anchorKey = found.id;
    }
  }

  // ---------------------------------------------------------------- actions

  submit(cx) {
    const text = this.composer.value().trim();
    // Enter in an empty box takes the question's row Claude Code's cursor is on.
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
        if (text.startsWith("/")) this.sessionChecks = 8; // /clear starts a new session
        return "";
      } catch (error) {
        // Not sent (Claude Code asks something first, say): the message goes back to the composer.
        this.pending.delete(id);
        this.attachments = files;
        this.setDraft(text);
        throw error;
      }
    });
  }

  // A just-started Claude Code may ask something before its prompt (trusting the folder): typing
  // into that would answer it. Waits for its screen to settle, then fails on a menu (shown by tick).
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
    return suggestionsFor(draft, COMMANDS, this.files);
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

  // The box's text, with the caret at `caret` (a UTF-16 offset), by default its end: set_value
  // alone puts the caret at the start.
  setDraft(text, caret = text.length) {
    this.composer.set_value(text);
    this.composer.set_selected_range({ start: caret, end: caret });
  }

  // A pasted file, or image (kept as a file in ~/.herdr/attachments), is an attachment of the next message.
  pasteImage(cx) {
    this.act(cx, async (cx) => {
      this.attach([await pastedAttachment()], cx);
      return "";
    });
  }

  // Files become attachments of the next message; the images among them are shown as thumbnails
  // (copied into the app folder, where image() draws from, and sharpened as the replies' are).
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
          this.attached.set(path, { error: String(error.message ?? error) }); // drawn as a file chip
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

  // A slash command typed into Claude Code (the model and effort menu), when it is free to take one.
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

  // The plan Claude asks to approve, read from the file its screen names (the transcript gets
  // the plan only once it is answered).
  async readPlan(path) {
    if (path === (this.plan?.path ?? null)) return;
    this.plan = path ? { path, text: await readTextFile(path.replace(/^~/, home()), { on: this.machine }) } : null;
  }

  pendingTool() {
    return pendingTool(this.chat, this.menu);
  }

  // A question's "Type something." is answered from the box: picking it only puts the keyboard there.
  // keys: what picks it, when not its own (Enter on the cursor's row).
  answer(cx, option, keys = option.keys) {
    if (isTypedOption(option)) return this.composer.focus();
    this.rememberPick(option);
    // A multi-select's box only ticks: Claude Code still asks, so the question stays (ticked as the
    // screen will be). Anything else answers it: the panel goes until the screen shows what follows.
    if (option.isChecked === null) this.menu = null;
    else option.isChecked = !option.isChecked;
    this.keys(cx, ...keys);
  }

  // What was picked for the question shown, for its step chip (a multi-select's ticks, as it moves on).
  rememberPick(option, text = option.label) {
    const step = this.menu?.steps?.[this.menu.current];
    if (!step || step.isSubmit || option.kind === "chat" || option.isChecked !== null) return;
    const ticked = this.menu.options.filter((o) => o.isChecked).map((o) => o.label);
    this.picked[step.label] = option.kind === "step" ? ticked.join(", ") : text;
  }

  // What the person wrote, as the question's own answer: the cursor goes to its field, which is
  // typed into (forced: Claude Code is blocked on the question) and confirmed.
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

  // The tab this pane is in: the shown one at its first layout (a pane is laid out only while
  // its tab shows; at init, focused() can still name the tab that was shown before).
  learnTab(cx) {
    if (this.ownTab) return;
    this.ownTab = spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id ?? null;
    this.onOwnTab?.(cx);
  }

  // A new pane is Herdr's focused pane but doesn't hold the keyboard until clicked: give it to
  // the box when this pane becomes the focused one (only on that change, so a palette keeps it).
  // Coming back to the chat hides Claude Code's terminal again.
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

  // ------------------------------------------------------------------- keys

  // A message's blocks, each a row of its own (as T3 streams a message block by block).
  blocksOf(item) {
    const cached = this.parsed.get(item.id);
    if (cached?.text === item.text) return cached.blocks;
    const cut = blocks(item.text);
    this.parsed.set(item.id, { text: item.text, blocks: cut });
    return cut;
  }

  // Code views keep state, which can't be made while rendering: made here, after the transcript
  // changed (from a task), and kept up with a block that is still streaming.
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

  // What a click on a row does: copy (a code block, a table, a message, a reply), or fold and
  // unfold (a work group, one of its entries, a details block). null: the row isn't a button.
  rowAction(row) {
    const copy = { "code-head": () => row.block.text, "table-copy": () => row.block.raw, user: () => row.text, meta: () => row.text }[row.kind];
    if (copy) return (cx) => {
      cx.write_to_clipboard(copy());
      this.copied = row.id;
      cx.timer.after(1200, (cx) => { if (this.copied === row.id) this.copied = null; cx.notify(); }); // T3's copied state: 1.2s
    };
    // The changed files open in the layout's Changes panel (the T3 layout's `panel` and its stack).
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

  // A work group is open while it is live, unless folded by hand; everything else is open once opened.
  isOpen(row) {
    if (this.folded.has(row.id)) return false;
    return this.expanded.has(row.id) || (row.kind === "work" && row.isLive);
  }

  // The reply's Markdown, a row per block (as T3 streams a message block by block).
  textRows(item) {
    return this.blocksOf(item).flatMap((block, i, all) => {
      const row = { id: `${item.id}#${i}`, block, previous: all[i - 1] ?? null };
      // A table's copy button is a row of its own under it (T3's MarkdownTable).
      if (block.type === "table") return [{ kind: "md", ...row }, { kind: "table-copy", ...row, id: `${row.id}:copy`, fixedHeight: 26 }];
      if (block.type !== "code") return [{ kind: "md", ...row }];
      // A code block is its header (the copy button) and its body, both of known height.
      // Whole pixels, so the two halves of the card meet without a seam.
      return [{ kind: "code-head", ...row, id: `${row.id}:head`, fixedHeight: Math.ceil(gapBefore(row.previous, block) + CODE.head) },
        { kind: "code-body", ...row, fixedHeight: Math.ceil(codeBodyHeight(block.text)) },
        // ```html is also drawn, under its source (T3 renders it in a frame).
        ...(block.lang === "html" && !block.isOpen && block.text.trim() ? [{ kind: "html-preview", ...row, id: `${row.id}:preview` }] : [])];
    });
  }

  // ponytail: built on every render from the whole chat; cache per transcript change if long chats get slow.
  rows() {
    // A turn that waits for an answer is still running: its work group stays live and keeps counting.
    const isWorking = ["working", "waiting"].includes(this.state());
    const rows = timeline(this.chat, { isWorking }).flatMap((item) => {
      if (item.kind === "text") return [...this.textRows(item), { kind: "text-end", id: `${item.id}:end`, fixedHeight: 8 }]; // T3: pb-2 under a reply's text
      if (item.kind === "work") return [item, ...(this.isOpen(item) ? item.entries.map((entry) => ({ kind: "entry", id: entry.id, entry })) : [])];
      return [item];
    });
    for (const [id, text] of this.pending) rows.push({ kind: "user", id: `pending-${id}`, text, images: [], isPending: true });
    // T3's working row, unless a live group already says so.
    if (isWorking && !rows.some((row) => row.kind === "work" && row.isLive)) rows.push({ kind: "working", id: "working", startedAt: rows.findLast((row) => row.kind === "user")?.at });
    return rows;
  }

  key(e, cx) {
    const stroke = e.keystroke;
    const isComposing = !this.handle.is_focused(); // the box has the keyboard
    if (this.isShowingKeys || (isHelpKey(stroke) && !isComposing)) {
      if (!this.isShowingKeys || isHelpKey(stroke) || stroke === "escape") this.isShowingKeys = !this.isShowingKeys;
      cx.stop_propagation();
      return cx.notify();
    }
    // A digit answers what Claude asks, also from the box while nothing is written in it.
    const menuKey = this.menu && (!isComposing || this.composer.value() === "") && this.menu.options.find((o) => o.key === stroke);
    if (menuKey) {
      this.answer(cx, menuKey);
    } else if (this.menu?.isQuestion && (!isComposing || this.composer.value() === "") && (stroke === "up" || stroke === "down")) {
      this.keys(cx, stroke); // Claude Code's cursor over the question's rows
    } else if (stroke === "shift-tab") {
      this.keys(cx, "shift+tab"); // Claude Code's next mode
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

  // What the box's keys would do now (composerKeyRoute).
  composerRoute(key) {
    return composerKeyRoute(key, { hasSuggestions: this.suggestions().items.length > 0, isQuestion: Boolean(this.menu?.isQuestion),
      isEmpty: this.composer.value() === "", recalls: this.recalls() });
  }

  // The box's key context: its name, and which of its keys the chat takes now (COMPOSER_KEYS).
  composerContext() {
    return ["T3ChatComposer", this.composerRoute("up") !== "box" && "arrows", this.composerRoute("tab") !== "box" && "tabs"].filter(Boolean).join(" ");
  }

  // Up, Down or Tab in the box (COMPOSER_KEYS): the / and @ menu's highlight, a question's rows,
  // or the messages sent before (T3's prompt history).
  composerKey(key, cx) {
    const { token, items } = this.suggestions();
    const route = this.composerRoute(key);
    if (route === "box") return cx.propagate();
    this.suggestToken = token; // the highlight moved for this token (the change handler keeps it)
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

  // The person's sent messages, oldest first.
  sent() {
    return [...this.chat.items.values()].filter((item) => item.kind === "user" && item.text).map((item) => item.text);
  }

  // Whether the arrows walk the history: the box is empty, or still holds what they put there.
  recalls() {
    const draft = this.composer.value();
    return draft === "" || (this.historyAt >= 0 && draft === historyStep(this.sent(), this.historyAt, 0).text);
  }

  select(index) {
    this.at = index;
    this.scroll = { top: Math.max(0, (this.content?.tops[index] ?? 0) - 8), follow: "free" };
  }

  // The scrollbar's thumb follows the pointer while the button is held anywhere over the chat.
  // ponytail: a release outside the chat isn't heard; the next press or release over it ends the drag.
  drag(e, zoom) {
    if (!this.dragging) return false;
    this.scroll = dragged(this.dragging.from, (e.position.y - this.dragging.y) / zoom, this.scrollable, this.viewportHeight);
    return true;
  }

  // The chat's project, as T3 names it: its space's name.
  project() {
    return spaces().find((s) => s.tabs.some((tab) => tab.id === this.ownTab))?.name ?? "";
  }

  laneWidth() {
    return Math.min(CONTENT_WIDTH, Math.max(160, this.viewportWidth - 2 * LANE_INSET)); // never wider than a narrow pane
  }

  // A row's height: known for some, else as it was last laid out, else an estimate until it is.
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

  // A row laid out at another height than it was placed with: while reading back, what is on
  // screen stays where it is (scroll.js).
  measured(row, height, cx) {
    const before = this.rowHeight(row);
    if (Math.abs(height - before) < 0.5) return;
    this.heights.set(row.id, height);
    const index = this.shown?.findIndex((r) => r.id === row.id) ?? -1;
    if (index >= 0) this.scroll = resized(this.scroll, this.content.tops[index], height - before);
    cx.notify();
  }

  // ----------------------------------------------------------------- render
  // Drawn as the other panels are (jira, prs, browser): 44px header, 12-13px text, 7-10px radii,
  // tinted pills for states, raised chips for actions.

  icon(name, size, color) {
    return svg(`mods/t3-chat/icons/${name}.svg`).size(size).flex_none().text_color(color);
  }

  spinner(size, color) {
    return svg("mods/t3-chat/icons/spinner.svg").size(size).flex_none().text_color(color).spin(900);
  }

  // A row's content at the lane's width.
  item(row, t, mono) {
    const ctx = { view: this, t, mono, p: "", now: Date.now() / 1000, images: this.images, openImage: (key) => this.openImage(key), copied: this.copied, hovered: this.hovered, folder: this.folder };
    switch (row.kind) {
      case "md": return mdBlock(row.block, row.previous, `md-${row.id}`, t, { isOpen: this.isOpen(row), width: this.laneWidth(), pictures: this.pictures, onOpenImage: (src) => this.openImage(src) });
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

  // The conversation: rows placed by their heights in a clipped box that this view scrolls
  // (scroll.js), only those near the viewport drawn. Each row reports the height it was laid out at.
  conversation(rows, t, mono, zoom) {
    const lane = this.laneWidth();
    const heights = rows.map((row) => Math.ceil(this.rowHeight(row))); // whole pixels: rows meet without seams
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
        // From the scroll as it is now: a trackpad sends several events between two renders.
        this.scroll = wheel(this.scroll, e.delta.y / zoom, this.content, this.viewportHeight);
        this.at = -1;
        cx.notify();
      })
      .children(rows.slice(first, end).map((row, k) => {
        const action = this.rowAction(row);
        const placed = h_flex().id(`row-${row.id}`).absolute().left(0).right(0).top(content.tops[first + k] - top).justify_center()
          // The row the keys are on (j/k): tinted, inside the lane.
          .child(div().w(lane).flex_none().rounded(6).when(first + k === this.at, (el) => el.bg(`${t.accent}14`)).child(this.item(row, t, mono)));
        const sized = row.fixedHeight !== undefined ? placed
          // Sizes are reported in zoomed pixels; rows are placed in the px a mod writes.
          : placed.on_size_change((size, cx) => this.measured(row, size.height / zoom, cx));
        // Rows that show controls under the pointer (T3's group-hover) hear it come and go.
        const heard = row.kind !== "user" && row.kind !== "meta" ? sized : sized.on_hover((isOver, cx) => {
          if (isOver) this.hovered = row.id;
          else if (this.hovered === row.id) this.hovered = null;
          cx.notify();
        });
        return action ? heard.on_click((_e, cx) => { action(cx); cx.notify(); }) : heard;
      }))
      // The scrollbar: a 12px track at the right; press it to jump there, drag to move (drag()).
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
    // A new chat has its composer in the middle of the pane, under T3's headline.
    const isHero = rows.length === 0;
    const foot = composer(this, t, mono, { isActive, state, lane: this.laneWidth() });
    return v_flex().id("t3-chat").on_size_change((_size, cx) => this.learnTab(cx)).track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_drop((event, cx) => this.attach(event.paths, cx))
      .on_mouse_move((e, cx) => { if (this.drag(e, zoom)) cx.notify(); })
      .on_mouse_up("left", (_e, cx) => { if (this.dragging) { this.dragging = null; cx.notify(); } })
      .size_full().min_h(0).relative().bg(t.background).text_color(t.foreground)
      // The conversation.
      .child(v_flex().relative().flex_1().min_h(0).px(LANE_INSET)
        .on_size_change((size, cx) => {
          this.viewportHeight = size.height / zoom;
          this.viewportWidth = size.width / zoom;
          // A lane of another width wraps rows anew: those that change height report it. The
          // known heights stay, as a row whose height doesn't change reports nothing.
          cx.notify();
        })
        .child(isHero ? v_flex().size_full().justify_center().child(hero(this, t, this.project())).child(foot) : this.conversation(rows, t, mono, zoom))
        // T3's "Scroll to end": a pill over the conversation's foot, while reading back.
        .when(this.scroll.follow === "free" && rows.length > 0, (el) => el.child(h_flex().absolute().bottom(8).left(0).right(0).justify_center()
          .child(h_flex().id("chat-latest").h(24).pl(8).pr(10).gap(4).items_center().rounded(12).bg(t.popover).border(1).border_color(t.border).shadow_md()
            .text_size(12).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.scroll.follow = "end"; this.at = -1; cx.notify(); })
            .child(this.icon("chevron-down", 12, t.muted)).child("Scroll to end")))))
      // What Claude asks, the @ and / menu, the composer.
      .when(!isHero, (el) => el.child(foot))
      .when(this.isShowingKeys, (el) => el.child(keyHelp("chat-keys", "Chat keys", this.keySections, t)
        .on_mouse_down("left", (_e, cx) => { this.isShowingKeys = false; cx.notify(); })));
  }
}
