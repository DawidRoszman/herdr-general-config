// The foot of the chat as T3 Code draws it (ChatComposer.tsx, ComposerSurface.tsx): what Claude
// asks, the @ and / menu, the composer card, and the context strip under it, in the chat's lane.
// view: the ChatView (its state and actions).

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Textarea } from "gpui-base";
import { panes, home, spaces } from "herdr";
import { sans, alpha, nested } from "./render-md.js";
import { modelLabel, MODES, MODEL_CHOICES, EFFORT_CHOICES, compactTokens, todoSummary, editDiff, coverSize } from "./model.js";
import { diffBlock } from "./timeline.js";
import { currentPlace } from "./host.js";
import { tip, tipMark, glow } from "./tip.js";

const icon = (name, size, color) => svg(`mods/t3-chat/icons/${name}.svg`).size(size).flex_none().text_color(color);

// T3's composer placeholder, less the `$ skills` it has no counterpart for.
export const PLACEHOLDER = "Ask anything. @ files, / commands";

// ComposerCommandMenu: the @ files and / commands above the card; rows rounded-lg with a 16px
// icon, the name at 12px medium and what it is at 12px, muted. T3's is 288px tall at most and
// scrolls; this one shows the best eight.
function commandMenu(view, items, t, mono) {
  return v_flex().w_full().p(6).rounded(16).border(1).border_color(alpha(t.foreground, 0.1)).bg(t.popover).shadow_lg()
    .children(items.map((item, i) => h_flex().id(`suggest-${i}`).w_full().h(32).px(10).gap(8).items_center().rounded(8).cursor_pointer()
      .when(i === view.suggestAt, (row) => row.bg(alpha(t.foreground, 0.08)))
      .hover((s) => s.bg(alpha(t.foreground, 0.06)))
      .on_click((_e, cx) => view.acceptSuggestion(cx, i))
      .child(icon(item.insert.startsWith("/") ? "terminal" : "file-text", 16, t.muted))
      .child(sans(div().flex_none().max_w(330).truncate().text_size(12).font_weight(500).text_color(t.foreground).child(item.label)))
      .child(sans(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(item.detail)))));
}

// Files waiting to be sent (ComposerAttachmentStrip): an image as a thumbnail filling its tile (its name on hover,
// a click opens it large), anything else as a chip with its name; each with a remove button.
// Several wrap onto more rows. What is sent stays the files' paths (ChatView.submit).
export const ATTACHMENT_BOX = { width: 56, height: 56 };
function attachmentStrip(view, t) {
  const remove = (i, isOverImage) => tip(view, t, `detach-${i}`, "Remove", div().id(`detach-${i}`).size(18).flex().items_center().justify_center().rounded(9).cursor_pointer()
    .when(isOverImage, (el) => el.bg(t.popover).border(1).border_color(alpha(t.foreground, 0.16)).shadow_md())
    .hover((s) => s.bg(t.hover)).on_hover(glow(view, `detach-${i}`))
    .on_click((_e, cx) => { cx.stop_propagation(); view.attachments.splice(i, 1); cx.notify(); })
    .child(icon("x", 11, isOverImage ? t.foreground : t.muted)));
  const name = (path) => path.split("/").pop();
  return h_flex().w_full().px(12).pt(12).gap_x(6).gap_y(10).flex_wrap().items_center().children(view.attachments.map((path, i) => {
    const shown = view.attached.get(path);
    if (shown && !shown.error) {
      const fit = shown.path ? coverSize(shown, ATTACHMENT_BOX.width, ATTACHMENT_BOX.height) : null;
      const tile = div().id(`attach-${i}`).relative().size(ATTACHMENT_BOX.width).flex_none().flex().items_center().justify_center().rounded(8).overflow_hidden()
        .border(1).border_color(alpha(t.border, 0.8)).bg(alpha(t.foreground, 0.04))
        .child(fit ? image(shown.thumb ?? shown.path).w(fit.width).h(fit.height).flex_none()
          : svg("mods/t3-chat/icons/spinner.svg").size(14).text_color(t.muted).spin(900))
        .when(Boolean(fit), (el) => el.cursor_pointer().on_hover(glow(view, `attach-${i}`)).on_click((_e, cx) => { view.openImage(path); cx.notify(); }));
      return div().relative().flex_none().child(tip(view, t, `attach-${i}`, name(path), tile))
        .child(div().absolute().top(-6).right(-6).child(remove(i, true)));
    }
    return sans(h_flex().id(`attach-${i}`).h(28).pl(8).pr(4).gap(6).items_center().rounded(8).border(1).border_color(alpha(t.border, 0.8)).bg(alpha(t.foreground, 0.04))
      .child(icon("paperclip", 12, t.muted))
      .child(div().max_w(220).truncate().text_size(12).text_color(t.foreground).child(name(path)))
      .child(remove(i, false)));
  }));
}

// ComposerPrimaryActions: a round 32px button; an arrow to send, a square to stop the turn.
function primaryAction(view, t, isActive) {
  const canSend = Boolean(view.composer.value().trim()) || view.attachments.length > 0;
  const isOn = isActive || canSend;
  const button = div().id("chat-primary").size(32).flex_none().flex().items_center().justify_center().rounded(16)
    .bg(isOn ? t.foreground : alpha(t.foreground, 0.12))
    .on_hover(glow(view, "chat-primary"))
    .when(isOn, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85))
      .on_click((_e, cx) => { if (isActive) view.interrupt(cx); else view.submit(cx); cx.notify(); }))
    .child(icon(isActive ? "square" : "arrow-up", isActive ? 12 : 16, isOn ? t.background : t.muted));
  return tip(view, t, "chat-primary", isActive ? "Stop (Escape)" : "Send (Enter)", button);
}

// A footer control (ComposerControl): 28px, rounded, its words at 14px; brighter under the pointer;
// label: what it does, on hover.
function control(view, id, t, label, children, onClick) {
  const el = sans(h_flex().id(id).h(28).px(8).gap(6).flex_none().items_center().rounded(8).text_size(14).font_weight(500).text_color(alpha(t.foreground, 0.8)))
    .cursor_pointer().hover((s) => s.bg(alpha(t.foreground, 0.08))).on_hover(glow(view, id)).on_click((_e, cx) => { onClick(cx); cx.notify(); }).children(children);
  return tip(view, t, id, label, el);
}

// ComposerSurface: a rounded-2xl card with a hairline outline; the text, then a row of controls
// with the send button at its right. T3's glass blur is a solid fill here.
function card(view, t, isActive, controls) {
  return v_flex().w_full().rounded(16).bg(t.popover).border(1).border_color(alpha(t.foreground, view.isComposerFocused ? 0.16 : 0.1)).shadow_md()
    .when(view.attachments.length > 0, (el) => el.child(attachmentStrip(view, t)))
    .child(sans(div().w_full().px(16).pt(14).pb(4).line_height("22.75px").key_context(view.composerContext())
      .on_action("t3_chat_up", (_e, cx) => view.composerKey("up", cx))
      .on_action("t3_chat_down", (_e, cx) => view.composerKey("down", cx))
      .on_action("t3_chat_tab", (_e, cx) => view.composerKey("tab", cx))
      .child(Textarea.new(view.composer).w_full().text_size(14))))
    .child(h_flex().w_full().px(8).pb(8).gap(4).items_center()
      .children(controls.left)
      .child(div().flex_1())
      .children(controls.right)
      .child(div().w(4))
      .child(primaryAction(view, t, isActive)));
}

// ComposerSurface.ContextStrip: under the card, bare; the chat's folder, its branch and its context
// size. 12px, muted. The status bar already names the machine and the Claude account (that of the
// chat's Claude Code while the chat is shown): the machine is named here only when the chat runs
// on another machine than its space's.
function contextStrip(view, t) {
  // Before the first message the chat has no folder of its own yet: its space's.
  const folder = view.folder ?? currentPlace(view.ownTab)?.folder ?? "";
  const name = folder === home() ? "~" : folder.slice(folder.lastIndexOf("/") + 1);
  const branch = panes().find((p) => p.tab === view.ownTab && p.branch)?.branch;
  const spaceMachine = spaces().find((s) => s.tabs.some((tab) => tab.id === view.ownTab))?.machine ?? null;
  const isElsewhere = Boolean(view.folder) && (view.machine ?? null) !== spaceMachine; // the chat's machine is known once it has a folder
  return sans(h_flex().w_full().px(10).pt(8).gap(12).items_center().text_size(12).text_color(t.muted)
    .when(isElsewhere, (el) => el.child(h_flex().flex_none().gap(5).items_center().child(icon(view.machine ? "server" : "monitor", 12, t.muted)).child(div().child(view.machine ?? "This computer"))))
    // The folder by its name, as T3 names a project; it gives way first when the strip is narrow.
    .child(h_flex().flex_1().min_w(0).gap(5).items_center()
      .when(Boolean(name), (el) => el.child(icon("folder", 12, t.muted)).child(div().min_w(0).truncate().child(name))))
    // A branch's start tells it apart (its ticket); cut, the whole name is on hover.
    .when(Boolean(branch), (el) => el.child(tipMark(view, t, "chat-branch", branch, h_flex().max_w(220).gap(5).items_center()
      .child(icon("git-branch", 12, t.muted)).child(div().min_w(0).truncate().child(branch)))))
    .when(view.chat.tokens > 0, (el) => el.child(tipMark(view, t, "chat-tokens", "Context of the last reply", div().child(`${compactTokens(view.chat.tokens)} tokens`)))));
}

// What stands over the card: an error (T3's ThreadErrorBanner), until dismissed.
function banner(view, t) {
  return sans(h_flex().w_full().pl(12).pr(6).py(6).gap(8).items_start().rounded(12).border(1).border_color(alpha(t.blocked, 0.3)).bg(alpha(t.blocked, 0.08))
    .text_size(12).line_height("18px").text_color(t.blocked)
    .child(div().pt(5).child(icon("alert", 12, t.blocked)))
    .child(div().flex_1().min_w(0).py(2).child(view.error))
    .child(tip(view, t, "chat-error-close", "Dismiss", div().id("chat-error-close").size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(alpha(t.blocked, 0.12))).on_hover(glow(view, "chat-error-close"))
      .on_click((_e, cx) => { view.error = ""; cx.notify(); })
      .child(icon("x", 12, t.blocked)))));
}

// A button of a panel (T3's Button): the answer that goes ahead is solid, the others outlined.
// A label past LABEL_MAX, or wider than the panel, is cut; the whole label is on hover.
const LABEL_MAX = 60;
function panelButton(view, id, label, t, isPrimary, onClick) {
  const isLong = label.length > LABEL_MAX;
  // In px: a percentage max width isn't honoured in the wrapping row. 26: the panel's padding and border.
  const button = sans(div().id(id).min_w(0).max_w(view.laneWidth() - 26).h(28).px(10).flex().items_center().rounded(8).text_size(13).font_weight(500).cursor_pointer()
    .bg(isPrimary ? t.foreground : "#00000000").text_color(isPrimary ? t.background : t.foreground)
    .border(1).border_color(isPrimary ? t.foreground : alpha(t.foreground, 0.16))
    .hover((s) => s.opacity(0.85))
    .on_hover(glow(view, id))
    .on_click((_e, cx) => { onClick(cx); cx.notify(); })
    .child(div().min_w(0).truncate().child(isLong ? `${label.slice(0, LABEL_MAX - 3)}…` : label)));
  return isLong ? tip(view, t, id, label, button) : button;
}

// What Claude asks, standing on the composer (ComposerPendingApprovalActions, ComposerPendingUserInputPanel):
// what it wants to do (the command or the diff of the waiting tool call when known, else its
// screen's words), then one button per answer; the digit answers too.
function pendingPanel(view, menu, tool, t, mono) {
  const diff = tool ? editDiff(tool) : null;
  const command = tool?.name === "Bash" ? tool.input.command : null;
  // Claude Code's own preview (a diff, a command) as its screen has it, when the transcript doesn't
  // have the waiting tool call yet (it is written once answered).
  const preview = command ? `$ ${command}` : menu.detail || (menu.question.includes("\n") ? menu.question : "");
  // A plan to approve is shown as its Markdown (T3's ProposedPlanCard), from Claude Code's plan file.
  const what = view.plan ? div().w_full().px(4).child(nested(view.plan.text, "pending-plan", t))
    : diff ? diffBlock(diff, { t, mono })
    : v_flex().w_full().px(12).py(10).rounded(8).bg(alpha(t.foreground, 0.035)).font_family(mono).text_size(12).line_height("18px").text_color(alpha(t.foreground, 0.85))
      .children(preview.split("\n").map((line) => div().w_full().child(line || " ")));
  const title = menu.question && !menu.question.includes("\n") ? menu.question : "Claude needs an answer";
  return pendingCard(t)
    .child(pendingTitle(view, title, t))
    .when(Boolean(view.plan || diff || preview), (el) => el.child(div().id("pending-what").w_full().max_h(view.plan ? 380 : 260).overflow_y_scrollbar().child(what)))
    .child(h_flex().w_full().gap(8).flex_wrap().items_center().children(menu.options.map((option, i) =>
      panelButton(view, `menu-${option.key}`, `${option.key}. ${option.label}`, t, i === 0, (cx) => view.answer(cx, option)))));
}

const pendingCard = (t) => v_flex().w_full().p(12).gap(10).rounded(16).border(1).border_color(alpha(t.foreground, 0.1)).bg(t.popover).shadow_md();

// What Claude asks, as one line, with the way to its own terminal (t) for what the chat can't show.
const TERMINAL_TIP = "Show Claude Code's terminal";
function pendingTitle(view, title, t) {
  return sans(h_flex().gap(8).items_start().text_size(13).line_height("20px").font_weight(500).text_color(t.foreground)
    .child(div().flex_1().min_w(0).child(title))
    .child(tip(view, t, "pending-terminal", TERMINAL_TIP, div().id("pending-terminal").flex_none().px(6).rounded(6).text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_hover(glow(view, "pending-terminal"))
      .on_click((_e, cx) => { view.toggleTerminal(); cx.notify(); }).child("Terminal"))));
}

// A question's steps (T3's pending user input progress): a chip per question by its header, the
// one shown outlined, the answered ones ticked with what was picked here, and Submit.
function questionSteps(view, menu, t) {
  return sans(h_flex().w_full().gap(6).flex_wrap().children(menu.steps.map((step, i) => {
    const isCurrent = i === menu.current;
    const picked = view.picked[step.label];
    return h_flex().id(`step-${i}`).h(24).px(8).gap(5).flex_none().items_center().rounded(12).text_size(12).border(1)
      .border_color(alpha(t.foreground, isCurrent ? 0.35 : 0.1)).bg(isCurrent ? alpha(t.foreground, 0.08) : "#00000000")
      .text_color(isCurrent || step.isDone ? t.foreground : t.muted)
      .when(step.isDone, (el) => el.child(icon("circle-check", 12, t.done)))
      .child(div().font_weight(500).child(step.label))
      .when(step.isDone && Boolean(picked), (el) => el.child(div().max_w(180).truncate().text_color(t.muted).child(picked)));
  })));
}

// The mark at a question row's left: its digit (the key that picks it), or a multi-select's box.
function rowMark(option, t) {
  if (option.isChecked === null) {
    return div().size(20).flex_none().flex().items_center().justify_center().rounded(6).border(1).border_color(alpha(t.foreground, 0.16))
      .text_size(11).font_weight(500).text_color(t.muted).child(option.key);
  }
  return div().size(16).mt(2).mx(2).flex_none().flex().items_center().justify_center().rounded(4).border(1)
    .border_color(option.isChecked ? t.foreground : alpha(t.foreground, 0.3)).bg(option.isChecked ? t.foreground : "#00000000")
    .when(option.isChecked, (el) => el.child(icon("check", 11, t.background)));
}

// One answer as a row: its mark, the label in bold (a Recommended badge after it), and its
// description under it, wrapped. The row Claude Code's cursor is on is lit.
function questionRow(view, option, t, { label = option.label, description = option.description } = {}) {
  return sans(h_flex().id(`menu-${option.key}`).w_full().px(10).py(8).gap(10).items_start().rounded(10).cursor_pointer()
    .when(option.isCursor, (el) => el.bg(alpha(t.foreground, 0.06)))
    .hover((s) => s.bg(alpha(t.foreground, 0.08)))
    .on_click((_e, cx) => { view.answer(cx, option); cx.notify(); })
    .child(rowMark(option, t))
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(div().text_size(13).line_height("20px").font_weight(600).text_color(t.foreground).child(label))
        .when(option.isRecommended, (el) => el.child(div().px(6).h(18).flex().items_center().rounded(9).bg(alpha(t.done, 0.14))
          .text_size(11).font_weight(500).text_color(t.done).child("Recommended"))))
      .when(Boolean(description), (el) => el.child(div().w_full().text_size(12).line_height("18px").text_color(t.muted).child(description)))));
}

// What Claude asks with AskUserQuestion (T3's ComposerPendingUserInputPanel): its steps, the
// question, a row per answer, one for an answer of one's own (written in the box), and under them
// "Chat about this" (quiet: it answers nothing) and the step on. Its last step lists the answers
// and submits them.
function questionPanel(view, menu, t) {
  const of = (kind) => menu.options.filter((o) => o.kind === kind);
  const [typed] = of("typed"), [step] = of("step"), [chat] = of("chat");
  const isReview = menu.review.length > 0;
  const footer = sans(h_flex().w_full().gap(8).items_center()
    .when(Boolean(chat), (el) => el.child(div().id("menu-chat").px(4).text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { view.answer(cx, chat); cx.notify(); }).child("Chat about this")))
    .child(div().flex_1())
    .when(Boolean(step), (el) => el.child(panelButton(view, "menu-step", `${step.label} →`, t, true, (cx) => view.answer(cx, step)))));
  return pendingCard(t)
    .when(menu.steps.length > 0, (el) => el.child(questionSteps(view, menu, t)))
    .child(pendingTitle(view, menu.question, t))
    .when(isReview, (el) => el.child(sans(v_flex().w_full().gap(6).px(2).children(menu.review.map((r, i) => v_flex().id(`review-${i}`).gap(1)
      .child(div().text_size(12).text_color(t.muted).child(r.question))
      .child(div().text_size(13).font_weight(500).text_color(t.foreground).child(r.answer)))))))
    .child(isReview
      ? h_flex().w_full().gap(8).children(of("answer").map((o, i) => panelButton(view, `menu-${o.key}`, o.label, t, i === 0, (cx) => view.answer(cx, o))))
      : v_flex().w_full().gap(2).children(of("answer").map((o) => questionRow(view, o, t)))
        .when(Boolean(typed), (el) => el.child(questionRow(view, typed, t, { label: "Your own answer", description: "Write it in the box below and press Enter." }))))
    .when(Boolean(chat || step), (el) => el.child(footer));
}

// Claude waits and the chat can't read why: its terminal answers.
function needsTerminal(view, t) {
  return sans(h_flex().w_full().px(12).py(8).gap(8).items_center().rounded(12).border(1).border_color(alpha(t.blocked, 0.3)).bg(alpha(t.blocked, 0.08)).text_size(12).text_color(t.blocked)
    .child(icon("alert", 12, t.blocked)).child(div().flex_1().child("Claude needs you in its terminal."))
    .child(tip(view, t, "waiting-terminal", TERMINAL_TIP, panelButton(view, "waiting-terminal", "Terminal", t, false, () => view.toggleTerminal()))));
}

// Claude's todo list (TodoWrite) over the composer: one line, "2/5 · the step in hand"; open, every step.
function todoRow(view, entries, t) {
  const { done, total, current } = todoSummary(entries);
  const mark = (status) => (status === "completed" ? icon("circle-check", 13, t.done) : status === "in_progress" ? icon("spinner", 13, t.working).spin(900) : icon("square", 13, t.dim));
  return sans(v_flex().id("chat-todos").w_full().px(12).py(8).gap(6).rounded(12).border(1).border_color(alpha(t.foreground, 0.1)).bg(alpha(t.foreground, 0.03)).cursor_pointer()
    .on_click((_e, cx) => { view.isTodosOpen = !view.isTodosOpen; cx.notify(); })
    .child(h_flex().gap(8).items_center().text_size(12).text_color(t.muted)
      .child(div().flex_none().font_weight(500).text_color(t.foreground).child(`${done}/${total}`))
      .child(div().flex_1().min_w(0).truncate().child(done === total ? "All steps done" : current))
      .child(icon(view.isTodosOpen ? "chevron-down" : "chevron-right", 12, t.muted)))
    .when(Boolean(view.isTodosOpen), (el) => el.children(entries.map((entry) => h_flex().gap(8).items_center().text_size(12).line_height("18px")
      .text_color(entry.status === "completed" ? t.dim : t.foreground).child(mark(entry.status)).child(div().flex_1().min_w(0).child(entry.text))))));
}

// The model control's menu (T3's ProviderModelPicker, for one provider): Claude Code's model
// aliases and efforts; a choice types `/model <alias>` or `/effort <level>` into Claude Code.
function modelMenu(view, t) {
  const choice = (id, label, isOn, command) => sans(h_flex().id(id).h(28).px(10).gap(8).items_center().rounded(8).text_size(13).cursor_pointer()
    .text_color(t.foreground).when(isOn, (el) => el.bg(alpha(t.foreground, 0.08))).hover((s) => s.bg(alpha(t.foreground, 0.06)))
    .on_click((_e, cx) => { view.isPickingModel = false; view.slash(cx, command); cx.notify(); })
    .child(div().flex_1().child(label)).when(isOn, (el) => el.child(icon("check", 12, t.muted))));
  const heading = (text) => sans(div().px(10).pt(6).pb(2).text_size(12).font_weight(500).text_color(t.muted).child(text));
  const current = (view.chat.model ?? "").toLowerCase();
  return h_flex().w_full().justify_end().child(v_flex().w(220).p(6).rounded(16).border(1).border_color(alpha(t.foreground, 0.1)).bg(t.popover).shadow_lg()
    .child(heading("Model"))
    .children(MODEL_CHOICES.map((m) => choice(`model-${m}`, `${m[0].toUpperCase()}${m.slice(1)}`, current.includes(m), `/model ${m}`)))
    .child(heading("Effort"))
    .children(EFFORT_CHOICES.map((e) => choice(`effort-${e}`, `${e[0].toUpperCase()}${e.slice(1)}`, view.status.effort === e, `/effort ${e}`))));
}

// The whole foot, centred at the lane's width: what Claude asks, its todo list, the @ and / menu,
// the card with its controls (mode at the left; model and effort at the right), the context strip.
export function composer(view, t, mono, { isActive, state, lane }) {
  const suggestions = view.suggestions().items;
  const model = modelLabel(view.chat.model);
  const effort = view.status.effort ? ` ${view.status.effort[0].toUpperCase()}${view.status.effort.slice(1)}` : "";
  const todos = [...view.chat.items.values()].find((item) => item.kind === "plan")?.entries ?? [];
  const isLive = state !== "stopped" && state !== "starting";
  const left = isLive ? [control(view, "chat-mode", t, "Next mode (⇧Tab)", [div().child(MODES[view.status.mode])], (cx) => view.keys(cx, "shift+tab"))] : []; // as shift-tab: Claude Code's next mode
  const right = model ? [control(view, "chat-model", t, "Model and effort", [svg("icons/claude.svg").size(14).flex_none(), div().child(model), div().text_color(t.muted).child(effort.trim())],
    () => { view.isPickingModel = !view.isPickingModel; })] : [];
  return h_flex().w_full().flex_none().justify_center().px(16).pb(12)
    .child(v_flex().w(lane).flex_none().gap(8)
      .when(Boolean(view.menu), (el) => el.child(view.menu.isQuestion ? questionPanel(view, view.menu, t) : pendingPanel(view, view.menu, view.pendingTool(), t, mono)))
      .when(view.isWaitingUnread(), (el) => el.child(needsTerminal(view, t)))
      .when(todos.length > 0 && todos.some((e) => e.status !== "completed"), (el) => el.child(todoRow(view, todos, t)))
      .when(Boolean(view.error), (el) => el.child(banner(view, t)))
      .when(suggestions.length > 0, (el) => el.child(commandMenu(view, suggestions, t, mono)))
      .when(Boolean(view.isPickingModel), (el) => el.child(modelMenu(view, t)))
      .child(v_flex().w_full().child(card(view, t, isActive, { left, right })).child(contextStrip(view, t))));
}

// A new chat (TriageDraftHero, DraftHeroHeadline): the question at 24px, normal weight, tight,
// over the composer in the middle of the pane.
export function hero(view, t, project) {
  return sans(v_flex().w_full().items_center().pb(20)
    .child(div().text_size(24).line_height("32px").text_color(t.foreground).child(project ? `What should we build in ${project}?` : "What should we build?"))
    .when(Boolean(view.folder), (el) => el.child(div().pt(6).text_size(14).line_height("20px").text_color(t.muted).child("Claude Code, with your own settings and permissions"))));
}
