// The foot of the chat as T3 Code draws it (ChatComposer.tsx, ComposerSurface.tsx): what Claude
// asks, the @ and / menu, the composer card, and the context strip under it, in the chat's lane.
// view: the ChatView (its state and actions).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Textarea } from "gpui-base";
import { panes, home } from "herdr";
import { sans, alpha, nested } from "./render-md.js";
import { modelLabel, MODES, MODEL_CHOICES, EFFORT_CHOICES, compactTokens, todoSummary, editDiff } from "./model.js";
import { diffBlock } from "./timeline.js";
import { currentPlace } from "./host.js";

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

// Files waiting to be sent (ComposerAttachmentStrip's file rows): a name and a remove button.
// ponytail: no thumbnails, as image() draws only files inside the app folder; copy them in if wanted.
function attachmentStrip(view, t) {
  return h_flex().w_full().px(12).pt(12).gap(6).flex_wrap().children(view.attachments.map((path, i) =>
    sans(h_flex().id(`attach-${i}`).h(28).pl(8).pr(4).gap(6).items_center().rounded(8).border(1).border_color(alpha(t.border, 0.8)).bg(alpha(t.foreground, 0.04))
      .child(icon("paperclip", 12, t.muted))
      .child(div().max_w(220).truncate().text_size(12).text_color(t.foreground).child(path.split("/").pop()))
      .child(div().id(`detach-${i}`).size(18).flex().items_center().justify_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { view.attachments.splice(i, 1); cx.notify(); })
        .child(icon("x", 11, t.muted))))));
}

// ComposerPrimaryActions: a round 32px button; an arrow to send, a square to stop the turn.
function primaryAction(view, t, isActive) {
  const canSend = Boolean(view.composer.value().trim()) || view.attachments.length > 0;
  const isOn = isActive || canSend;
  return div().id("chat-primary").size(32).flex_none().flex().items_center().justify_center().rounded(16)
    .bg(isOn ? t.foreground : alpha(t.foreground, 0.12))
    .when(isOn, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85))
      .on_click((_e, cx) => { if (isActive) view.interrupt(cx); else view.submit(cx); cx.notify(); }))
    .child(icon(isActive ? "square" : "arrow-up", isActive ? 12 : 16, isOn ? t.background : t.muted));
}

// A footer control (ComposerControl): 28px, rounded, its words at 14px; brighter under the pointer.
export function control(id, t, children, onClick = null) {
  const el = sans(h_flex().id(id).h(28).px(8).gap(6).flex_none().items_center().rounded(8).text_size(14).font_weight(500).text_color(alpha(t.foreground, 0.8)));
  return (onClick ? el.cursor_pointer().hover((s) => s.bg(alpha(t.foreground, 0.08))).on_click((_e, cx) => { onClick(cx); cx.notify(); }) : el).children(children);
}

// ComposerSurface: a rounded-2xl card with a hairline outline; the text, then a row of controls
// with the send button at its right. T3's glass blur is a solid fill here.
function card(view, t, isActive, controls) {
  return v_flex().w_full().rounded(16).bg(t.popover).border(1).border_color(alpha(t.foreground, view.isComposerFocused ? 0.16 : 0.1)).shadow_md()
    .when(view.attachments.length > 0, (el) => el.child(attachmentStrip(view, t)))
    .child(sans(div().w_full().px(16).pt(14).pb(4).line_height("22.75px").child(Textarea.new(view.composer).w_full().text_size(14))))
    .child(h_flex().w_full().px(8).pb(8).gap(4).items_center()
      .children(controls.left)
      .child(div().flex_1())
      .children(controls.right)
      .child(div().w(4))
      .child(primaryAction(view, t, isActive)));
}

// ComposerSurface.ContextStrip: under the card, bare; where the chat runs (machine, folder) and
// its branch. 12px, muted.
function contextStrip(view, t) {
  // Before the first message the chat has no folder of its own yet: its space's.
  const folder = view.folder ?? currentPlace(view.ownTab)?.folder ?? "";
  const name = folder === home() ? "~" : folder.slice(folder.lastIndexOf("/") + 1);
  const branch = panes().find((p) => p.tab === view.ownTab && p.branch)?.branch;
  const item = (icon_, label) => h_flex().flex_none().gap(5).items_center().child(icon(icon_, 12, t.muted)).child(div().child(label));
  return sans(h_flex().w_full().px(10).pt(8).gap(12).items_center().text_size(12).text_color(t.muted)
    .child(item(view.machine ? "server" : "monitor", view.machine ?? "This computer"))
    // The folder by its name, as T3 names a project; it gives way first when the strip is narrow.
    .child(h_flex().flex_1().min_w(0).gap(5).items_center()
      .when(Boolean(name), (el) => el.child(icon("folder", 12, t.muted)).child(div().min_w(0).truncate().child(name))))
    .when(Boolean(branch), (el) => el.child(item("git-branch", branch)))
    .when(view.chat.tokens > 0, (el) => el.child(div().flex_none().child(`${compactTokens(view.chat.tokens)} tokens`))));
}

// What stands over the card: an error (T3's ThreadErrorBanner).
function banner(text, t) {
  return sans(h_flex().w_full().px(12).py(8).gap(8).items_start().rounded(12).border(1).border_color(alpha(t.blocked, 0.3)).bg(alpha(t.blocked, 0.08))
    .text_size(12).line_height("18px").text_color(t.blocked)
    .child(div().pt(3).child(icon("alert", 12, t.blocked)))
    .child(div().flex_1().min_w(0).child(text)));
}

// A button of a panel (T3's Button): the answer that goes ahead is solid, the others outlined.
function panelButton(id, label, t, isPrimary, onClick) {
  return sans(div().id(id).flex_none().h(28).px(10).flex().items_center().rounded(8).text_size(13).font_weight(500).cursor_pointer()
    .bg(isPrimary ? t.foreground : "#00000000").text_color(isPrimary ? t.background : t.foreground)
    .border(1).border_color(isPrimary ? t.foreground : alpha(t.foreground, 0.16))
    .hover((s) => s.opacity(0.85))
    .on_click((_e, cx) => { onClick(cx); cx.notify(); })
    .child(label));
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
  return v_flex().w_full().p(12).gap(10).rounded(16).border(1).border_color(alpha(t.foreground, 0.1)).bg(t.popover).shadow_md()
    .child(sans(h_flex().gap(8).items_start().text_size(13).line_height("20px").font_weight(500).text_color(t.foreground)
      .child(div().flex_1().min_w(0).child(title))
      // What the chat can't show is answered in Claude Code's own terminal (t).
      .child(div().id("pending-terminal").flex_none().px(6).rounded(6).text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { view.toggleTerminal(); cx.notify(); }).child("Terminal"))))
    .when(Boolean(view.plan || diff || preview), (el) => el.child(div().id("pending-what").w_full().max_h(view.plan ? 380 : 260).overflow_y_scrollbar().child(what)))
    .child(h_flex().w_full().gap(8).flex_wrap().items_center().children(menu.options.map((option, i) =>
      panelButton(`menu-${option.key}`, `${option.key}. ${option.label.length > 60 ? `${option.label.slice(0, 57)}…` : option.label}`, t, i === 0, (cx) => view.answer(cx, option)))));
}

// Claude waits and the chat can't read why: its terminal answers.
function needsTerminal(view, t) {
  return sans(h_flex().w_full().px(12).py(8).gap(8).items_center().rounded(12).border(1).border_color(alpha(t.blocked, 0.3)).bg(alpha(t.blocked, 0.08)).text_size(12).text_color(t.blocked)
    .child(icon("alert", 12, t.blocked)).child(div().flex_1().child("Claude needs you in its terminal."))
    .child(panelButton("waiting-terminal", "Terminal", t, false, () => view.toggleTerminal())));
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
  const left = isLive ? [control("chat-mode", t, [div().child(MODES[view.status.mode])], (cx) => view.keys(cx, "shift+tab"))] : []; // as shift-tab: Claude Code's next mode
  const right = model ? [control("chat-model", t, [svg("icons/claude.svg").size(14).flex_none(), div().child(model), div().text_color(t.muted).child(effort.trim())],
    () => { view.isPickingModel = !view.isPickingModel; })] : [];
  return h_flex().w_full().flex_none().justify_center().px(16).pb(12)
    .child(v_flex().w(lane).flex_none().gap(8)
      .when(Boolean(view.menu), (el) => el.child(pendingPanel(view, view.menu, view.pendingTool(), t, mono)))
      .when(state === "waiting" && !view.menu, (el) => el.child(needsTerminal(view, t)))
      .when(todos.length > 0 && todos.some((e) => e.status !== "completed"), (el) => el.child(todoRow(view, todos, t)))
      .when(Boolean(view.error), (el) => el.child(banner(view.error, t)))
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
