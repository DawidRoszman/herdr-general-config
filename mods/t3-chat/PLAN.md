# Plan: `t3-chat`, T3 Code's chat inside Herdr

Goal: the person never has to switch to the T3 Code app to chat. `mods/t3-chat` copies T3 Code's
chat view as closely as Herdr's mod API allows, on top of the existing `agent-chat` harness
(Claude Code in a terminal pane of the chat's tab; the chat reads its transcript and types into it).
`agent-chat` stays untouched and working until the person agrees to switch.

Reference: `~/src/t3code` (github.com/pingdotgg/t3code, MIT, cloned at `f12bb622`, 2026-11-10),
`apps/web/src/components/ChatView.tsx`, `ChatMarkdown.tsx`, `components/chat/*`, `index.css`.
No T3 code is copied; sizes, radii and colours are, with comments naming the T3 component.

Priority (from the person): **how T3 renders text, Markdown and HTML comes first.**

Status (2026-11-10): steps 1 to 9 are built. What differs from this plan is listed at the end, under
"As built".

---

## 1. The renderer (first priority)

### 1.1 What T3 does

Pipeline (`chat/markdownRenderer.ts`, `packages/shared/src/markdownPipeline.ts`, `ChatMarkdown.tsx`):

- `unified` + `remark-parse` (with unused syntax gated off) → `remark-gfm` (tables, task lists,
  strikethrough, autolinks, footnotes) → optional `remark-breaks` (user messages: a single newline
  is a line break) → `remark-math` (KaTeX) → own remark plugins: GitHub alerts (`> [!NOTE]`),
  list-indent normalising, Windows paths, Codex directives → `remark-rehype`
  (`allowDangerousHtml`) → `rehype-raw` only when the text has raw HTML → `rehype-sanitize` with
  its own schema → `hast-util-to-jsx-runtime` with custom React components per tag.
- Streaming: the text is split into blocks; finished blocks are parsed once and cached (LRU,
  500k chars), only the last block re-parses. New blocks fade in (opacity, 600 ms).
- Custom components: code block (`MarkdownCodeBlock`), table (`MarkdownTable`), `<details>`
  (`MarkdownDetails`), file links and inline-code paths that open in the editor
  (`MarkdownFileLink`), external links with a context menu, thread links, images with a gallery
  and zoom dialog, math, Mermaid diagrams, citation chips, ```` ```html ```` rendered in a
  sandboxed iframe (`HtmlRenderFrame`, with a dialog to enlarge).

Typography (`index.css` "Chat markdown rendering", root class in `ChatMarkdown.tsx`; rem = 16px):

| Element | T3 |
|---|---|
| Body | `text-sm` 14px, `leading-relaxed` line height 1.625 (22.75px), foreground at ~90% opacity, `overflow-wrap: anywhere` |
| Fonts | sans: `-apple-system, BlinkMacSystemFont, "Inter Variable", …` (SF Pro on macOS); mono: `ui-monospace, "SF Mono", Menlo, …` |
| Block spacing | `p, ul, ol, blockquote, pre, table`: margin 0.65rem (10.4px) top and bottom; first/last child 0 |
| Headings | weight 600, line height 1.3, margin 1.25rem 0 0.5rem (20px / 8px); h1 20px, h2 18px, h3 16px, h4–h6 14px; h6 muted |
| Bold | weight 700 |
| Lists | padding-left 1.25rem (20px); `ul` disc → circle → square; `ol` decimal → lower-alpha → lower-roman, tabular numbers, gutter widened for multi-digit markers; `li + li` margin-top 0.25rem (4px); task items: no bullet, checkbox in the gutter |
| Links | `--info-foreground` (blue), no underline; hover: dotted underline (radial-gradient dots 4×2px) |
| Inline code | mono, 0.85em (11.9px), padding 0.1em 0.35em, radius 4px, background foreground 10%, colour foreground, 1px transparent border |
| Blockquote | 2px left border (currentcolor 35%), padding-left 0.8rem (12.8px), colour inherited |
| `hr` | 1px border; muted-foreground in dark |
| Code block | card: margin 0.65rem, radius 8px (`rounded-lg`), border `border/70` (transparent in dark), background `secondary` (dark: `input/32`), `leading-snug` (1.375); header row: language or file name with file icon, mono 11px (`text-2xs`), colour code-foreground 72%; actions right: wrap toggle, run (shell), copy (12px icons, Check morph for 1.2 s); body `pre` padding 0.8rem 0.9rem (12.8px / 14.4px), horizontal scroll or wrap; code font size from a setting (`--font-size-code`); Shiki highlighting in the app theme's light/dark variant; `text`/`plain` blocks unhighlighted |
| Table | 100% width, 14px (0.875rem), collapse; cells padding 0.45rem 0.75rem (7.2px / 12px), first/last column flush with the prose, top-aligned, max-width 24rem per cell, word-boundary wrap; header weight 600, padding-block 0.55rem, bottom border `border` 60%; body rows bottom border `border` 60%; no vertical lines, no outer border; horizontal scroll when too wide; a copy button under it (as Markdown / CSV) |
| `<details>` | top and bottom border `border/60`, margin 8px; summary row: chevron 16px (rotates 90°), 14px medium, padding-block 8px; body padding-left 24px, bottom 12px |
| Footnotes | 12px, muted, top border, margin-top 1.25rem |
| Images | inline-block; standalone images as a gallery, click to zoom |
| User message text | same renderer with line breaks kept, inside the bubble (see 2.2) |

### 1.2 What Herdr has

- `TextView.markdown(id, text)` and `TextView.html(id, html)` (gpui-base): one opaque element.
  Known knobs: `.text_size()`, `.text_color()`, `.selectable()`, `.on_link_click()`. No style
  object for headings, code, tables or spacing; "CSS in HTML is not supported".
- No rich-text runs: a mod cannot put bold, code and a link inside one wrapped paragraph by
  itself. Inline formatting must go through TextView.
- `EditorState` + `Editor` (readonly): a code view with syntax highlighting (colours given as
  theme colours), line numbers, folding.
- Plain elements (`div`, flex, borders, radii, hover, `cx.write_to_clipboard`, `cx.open_url`).
- `agent-chat` today: one `TextView.markdown` per message at 13px; ```` ```html ```` fences drawn
  again below as `TextView.html` (`htmlBlocks`); user text through `typedMarkdown` (tags escaped,
  line breaks kept).

### 1.3 How t3-chat renders: T3's layout drawn natively, TextView only for inline text

A pure block splitter in `markdown.js` (covered by `markdown.test.mjs`) cuts a message into
blocks; each block is drawn by the mod with T3's exact numbers, and TextView is used only where
inline formatting is needed (a paragraph, a list, a cell). This is also what makes streaming
cheap, as in T3: block ids are stable, so only the last block changes.

| T3 | In Herdr | How close |
|---|---|---|
| Body 14px / 1.625 / 90% foreground | TextView per prose block, `.text_size(14)`, wrapper `.line_height("22.75px")`, colour `foreground` mixed 90% | Exact if TextView honours the inherited line height (probe, step 1); else TextView's own |
| Fonts | T3's stack is the system font: use `.font_family(".AppleSystemUIFont")`/SF if GPUI resolves it, else the layout's `ui_font` (Geist); mono: `settings().font_family` (T3's is SF Mono; the person's terminal font is the nearest honest match) | Close; exact only if the system font resolves (probe) |
| Block spacing 10.4px | Mod-drawn gaps between blocks | Exact |
| Headings (20/18/16/14, 600, 1.3, margins 20/8) | Own block: TextView of the heading's inline text at that size, `.font_semibold()` | Exact sizes and margins; weight exact if TextView inherits it (probe), else heading drawn as plain text when it has no inline marks, TextView otherwise |
| Paragraph inline: bold, italic, strike, links, inline code | TextView.markdown | Bold/italic/strike: TextView's. Inline code chip (11.9px, 4px radius, 10% fill) and link colour/hover dots: whatever TextView draws; not styleable. **Gap**, named in the mod |
| Lists (20px gutter, 4px between items, disc/circle/square, alpha/roman, task boxes) | First: the whole list as one TextView (its own bullets and indent). If the probe shows it far from T3: own list block (marker column 20px + TextView per item), nested by indent | Good to exact, by probe |
| Blockquote | Own: 2px left border at 35%, padding-left 12.8px, blocks inside rendered recursively | Exact |
| GitHub alerts `> [!NOTE]` | Own: the quote with T3's icon and label colour | Exact enough |
| `hr` | 1px div | Exact |
| Code block card, header, copy, wrap | Own card with T3's numbers; language label 11px mono; copy button (`cx.write_to_clipboard`, check for 1.2 s); wrap toggle | Exact chrome |
| Shiki highlighting | `Editor` readonly with theme `ansi*` syntax colours, if its line numbers and gutter can be hidden and it sizes to content (probe); else plain mono text, coloured only for `diff` fences (+/− lines) | **Partial**: tokens coloured by Herdr's grammar set, not Shiki's themes; languages Herdr lacks stay plain |
| Table | Own grid: rows of flex cells, column widths from content length (capped 24rem), T3's paddings and 60% bottom borders, header 600; each cell a TextView for inline marks; horizontal scroll when wide; copy as Markdown / CSV button | Close; column sizing is estimated, not a browser's table layout |
| `<details>` | Own collapsible: borders, chevron, summary, recursive body | Exact |
| Raw HTML in a message | Sanitised to the tags TextView.html draws; block-level HTML goes to `TextView.html`, unknown tags shown as text (as T3 does for raw HTML that survives) | Partial: no CSS, no layout beyond TextView's |
| ```` ```html ```` preview (sandboxed iframe + dialog) | Code block as above, plus "Preview" under it via `TextView.html` (agent-chat's `htmlBlocks`), and an "Open" button that opens the HTML in the Herdr browser pane (`mods/browser`) for real rendering | Partial inline; exact in the browser pane |
| Images (inline, gallery, zoom) | `image()` for transcript images and local files inside the app folder (existing `displayableImage` cache); click opens a larger overlay | Good; remote URLs are fetched to the cache first |
| File links / inline-code paths open in editor | `on_link_click`: a path opens Herdr's file viewer pane or the Files panel reveal; URLs via `cx.open_url` | Good for links; inline-code paths are not clickable (TextView reports only links) unless the splitter rewrites them into links (step 1 decides) |
| Math (KaTeX), Mermaid | Shown as code blocks; Mermaid gets an "Open in Blueprint" button if the `blueprint` mod accepts it | **Not drawn** |
| Footnotes | TextView's | As TextView draws |
| Streaming fade-in of new blocks | `.transition` on opacity for a block's first appearance | Close |
| Select and copy as Markdown | `.selectable(true)` per TextView (selection cannot span blocks); a Copy button per message copies its Markdown source | Partial |
| User text (line breaks kept, tags literal) | `typedMarkdown` kept | Same |

Probes that decide the open rows (step 1, in a throwaway view of t3-chat, screenshots beside
T3): does TextView inherit `line_height`, `font_family`, `font_weight`; how it draws inline code,
links, lists, tables; whether `Editor` can be bare and content-sized; whether the system font
resolves. The plan's table gets its final "how close" column from that, written to
`mods/t3-chat/RENDERER.md`.

---

## 2. The rest of T3's chat

### 2.1 Layout

T3: a centred lane, `--chat-content-max-width` 46rem (736px), timeline above, composer floating
at the bottom over the timeline's end, header on top (`ChatHeader`: title, project, actions).
Herdr: same lane at 736px (agent-chat's is 920). The T3 layout already has a tab bar and pane
header (`t3-pane`), so the chat's own header is dropped: title goes to the tab name (as now),
model and state move into the composer as in T3.

### 2.2 Timeline (`MessagesTimeline`, `Timeline*Row`)

| T3 | Herdr |
|---|---|
| User message: right-aligned bubble, max 80% width, `rounded-2xl` 16px, `bg-message`, 14px; long ones collapse to max-h 384px with expand; attachments grid above; on hover a row under it: time, copy, edit/rewind | Same bubble and collapse; time and copy on hover. **Rewind/edit: not possible** through the TUI harness (left out) |
| Assistant message: full lane width, `px-1 py-0.5`, the renderer above; footer with elapsed time, model chip (mono 10px pill), copy | Same; elapsed from transcript timestamps |
| Work log (`WorkLog`, `TimelineWorkGroupRows`, `TimelineWorkEntryRow`): tool calls and thinking grouped between messages into one collapsible group: header row h-6, 14px muted ("Worked for 42s · 7 steps"), entries with a 16px tool icon, heading + truncated detail on one baseline, expandable detail (`ms-7`, 14px, 80% foreground), command output panel, errors in destructive colour | Same grouping, computed in `model.js` (pure, tested): consecutive tool/thinking items between texts become one group, open while the turn runs, folded after. Icons per tool (terminal, file, search, globe, …) as SVGs. Detail: command and output in the code block card; Edit/Write shown as a diff (2.4) |
| Thinking: an entry in the work log, expandable to Markdown | Same |
| Working state: status line at the end ("Working…" with elapsed, shimmer) | `.frames`/`.loop` opacity shimmer, elapsed from the turn's first timestamp (a 1 s data timer only while working) |
| System dividers (interrupted, compaction, errors) | Same rows from transcript (`[Request interrupted`, compact summaries, API errors) |
| Timeline minimap, thread find (`cmd-f`), citations, side chats, queued runs | **Left out** at first. Find could come later (filter rows) |
| Scroll: follow end, anchor the sent message at top, "scroll to bottom" pill | Kept from agent-chat (already copies T3's follow modes). The list moves from `v_virtual_list` with estimated heights to `list()` (rows measured as drawn) if it can still be scrolled from code; else the estimates are kept and re-tuned for the new blocks (probe in step 2) |

### 2.3 Approvals, questions, plans

| T3 | Herdr |
|---|---|
| Pending approval: a panel attached to the composer top (`ComposerPendingApprovalActions`): what is asked (command, file, diff), buttons Approve / Approve for session / Decline + more | Same panel, fed by the existing `screenMenu` (Claude Code's numbered menu read off its screen): buttons are its options, first one primary; the question text gets the tool's input from the transcript (command, diff) instead of the raw screen lines when the pending tool call is known. Keys 1–9, Enter = first option |
| Questions (`ComposerPendingUserInputPanel`): options list with arrows/number keys, free-text answer | Same from `screenMenu`/chooser; multi-question forms that the screen parser cannot read fall back to "Answer in terminal" (`t`) |
| Proposed plan (`ProposedPlanCard`): card `rounded-2xl`, border, `bg-card/70`, p-4/5, title row, Markdown body collapsed to max-h 416px with fade and "Show more", actions (implement, copy, save) | Same card from `ExitPlanMode` tool input (plan Markdown), with the menu's answers as its buttons |
| Todo list (`TodoWrite`) | T3 shows it in the thread details panel; here: a compact checklist row above the composer (collapsed: "3/7 · current step"), expandable |

### 2.4 Diffs and changed files

| T3 | Herdr |
|---|---|
| `ChangedFilesTree` under a turn: card `rounded-lg bg-secondary`, sticky header (N files, +adds −dels, collapse, "View diff"), tree rows h-7 with file icon and per-file stat | Same card, computed in `model.js` from the turn's Edit/Write/MultiEdit/NotebookEdit calls (files, +/− counts from old/new strings). Not sticky. "View diff" opens the layout's Changes panel (`layout.show` + select `changes`); a row click opens that file there |
| Inline diff of an edit (`@pierre/diffs`, Shiki) | Own unified diff block: old/new strings → line diff in `model.js` (tested), drawn with +/− line backgrounds at T3's `--diff-addition/deletion` colours, mono. No word-level or syntax colours (the Changes panel has delta for that) |

### 2.5 Composer (`ChatComposer`, `ComposerSurface`, `Composer*`)

| T3 | Herdr |
|---|---|
| Surface: `rounded-2xl` 16px card, 1px outline, glass blur over the timeline, composer shadow; grows with text | Same card with a solid `popover` fill. **No backdrop blur** in gpui-kit: solid surface |
| Editor: TipTap rich text (live Markdown, code blocks with language picker, lists, mention chips) | `Textarea` (auto-grow 1–10 lines). Plain text with Markdown typed as source; **no live rich text**. Mention chips via gpui-base inline tokens (`InputContent.tokens`, `.token(render)`) if Textarea supports them (probe), else `@path` as text, as now |
| `@` mentions (files, and models/threads) and `/` commands: `ComposerCommandMenu` above the composer, max-h 288px, rows `rounded-lg`, icon 16px, name 12px medium, description 12px secondary | Same menu look; files from `git ls-files` (existing `fileMatches`), commands from the existing `COMMANDS` plus the project's `.claude/commands` and skills (listed once per chat) |
| Attachments (`ComposerAttachmentStrip`): 64px thumbnails `rounded-lg` with remove, files as rows; paste, drop, picker | Same: thumbnails for images (pasted ones are saved as today), rows for files; paste (macOS), drop; a "+" button opens no system file picker (Herdr has only a folder picker): **paste and drop only** |
| Footer controls: model picker (`ProviderModelPicker`), effort/traits, runtime mode (Supervised / Auto-accept edits / Auto / Full access), plan-mode toggle, context/usage | Model: a menu sending `/model <name>` (current model read from the transcript). Mode: a menu that cycles Claude Code's modes with `shift+tab` until the screen's mode line matches (Default / Accept edits / Plan / Auto when offered), named as T3 names them. Effort: `/effort`. Context: percentage from the transcript's last usage. Provider picking, speed traits, multi-model send, stash, voice: **left out** (one harness: Claude Code) |
| Primary action: round send button (arrow up), Stop square while running; queue a message while a turn runs | Same button; Stop sends Esc. Sending while Claude works types into Claude Code, which queues it itself (shown pending until the transcript has it) |
| Context strip under the card: environment, worktree, branch | Same strip: machine, folder, branch (from `panes()`), and the Claude account mark the other t3 mods show (`account.js`) |

### 2.6 Empty and other states

- Fresh chat (`TriageDraftHero`, `DraftHeroHeadline`): centred headline, 24–30px normal weight,
  tight tracking, project name under it at 14px, composer in the middle of the lane, moving to the
  bottom on the first message. Herdr: same headline and centred composer; it moves without the
  shared-element transition (a `.transition` on its top, if that reads well).
- Starting / trust dialog / stopped / error banners (`ThreadErrorBanner`, `ProviderStatusBanner`):
  banner rows attached above the composer, from the existing states and `this.error`.

### 2.7 Keys

T3's (`packages/shared/src/keybindings.ts`, composer): Enter send, Shift-Enter newline, Esc
stop / close menu, `@` and `/` menus (arrows, Tab/Enter accept), ArrowUp in an empty box = prompt
history, `mod+enter` alternate send, `mod+shift+o`/`mod+n` new chat, `mod+j` terminal toggle,
`mod+d` diff toggle, `mod+f` find, `mod+k` palette.

In t3-chat: Enter, Shift-Enter, Esc, menus, ArrowUp history (new, from the transcript's user
messages), Shift-Tab mode. `cmd-j` = Claude Code's terminal beside the chat (T3's terminal
toggle; today's `t`), `cmd-d` = Changes panel. agent-chat's reading keys (j/k, g/G, l/h, 1–9,
`?`) are kept: they do not clash with T3's. Not copied: `mod+f` (Herdr's terminal search),
`mod+k` (Herdr's palette), `mod+n` (New space in this layout).

---

## 3. How t3-chat opens

All of this is wired only after this plan is agreed, and only then are `keys.json`,
`layouts/herdr-t3.json` and `mods/t3-new-menu` touched.

- **New-tab menu** (`t3-new-menu`): the space rows stay; `Enter` still opens a terminal tab. Added:
  `cmd-enter` on a space (and a footer button "New chat") runs
  `tab.new { space, mod: "t3-chat", props: { view: "chat" } }`. Small diff, T3's own split between
  a thread and a terminal.
- **Key**: `"layout:herdr-t3": { "cmd-shift-j": … }`-style binding for "New chat in this space"
  through a `t3-panels` command is **not** possible without touching `t3-panels`, so the key goes
  straight to the app command: `{"command": "tab.new", "args": {"mod": "t3-chat", "props": {"view": "chat"}}}`.
  Which key is the person's call (T3's `cmd-shift-o` is taken by `wt-open`); proposal: `cmd-alt-n`.
- **T3 layout**: no structural change needed; a chat is a mod pane in a tab. `t3-pane` (the pane
  header) and the Agents/Inbox lists find the chat's Claude by `p.mod === "agent-chat"` in
  `agents-accounts` and `spaces-agents` (not t3 mods); in the T3 layout the equivalent lookups
  must also accept `t3-chat` so a click on the agent goes to the chat pane, not the hidden
  terminal. That is a one-line change in the t3 mods that resolve an agent's pane; listed as its
  own step, and done only with the go-ahead since it touches mods other than t3-chat.
- **Existing chats**: t3-chat reads the same `shared("chats.byTab")`, so a tab remembers its
  session either way. Existing agent-chat tabs stay agent-chat until the switch.
- **The switch** (later, the person's decision): `wt-dialog`'s workspace opens a t3-chat tab
  instead of `claude`, agent-chat retired.

---

## 4. Files

```
mods/t3-chat/
  main.js          entry (as agent-chat/main.js)
  chat.js          the view: wiring, keys, scroll (from agent-chat/chat.js, drawing moved out)
  host.js          IO, copied from agent-chat (image cache dir renamed to data/t3-chat)
  model.js         transcript → items, groups, changed files, diff lines, suggestions (+ model.test.mjs)
  markdown.js      Markdown → blocks (pure) (+ markdown.test.mjs)
  render-md.js     blocks → elements (T3's ChatMarkdown, MarkdownCodeBlock, MarkdownTable, MarkdownDetails)
  timeline.js      rows (TimelineUserMessageRow, TimelineAssistantRows, WorkLog, ProposedPlanCard, ChangedFilesTree)
  composer.js      ComposerSurface, command menu, attachments, controls, pending approval / input panels
  tip.js, focus.js, list.js   copied from a t3-* mod as they are
  icons/           lucide SVGs T3 uses
  RENDERER.md      what the probes found; the final "how close" table
```

`scripts/sync.sh` is named in the t3 mods' comments but is not in this repo (it lives in upstream
herdr-t3), so the shared files are copied by hand and kept byte-identical.

No dependency is added: the Markdown splitter is hand-written (blocks only: fences, tables,
headings, lists, quotes, hr, details/HTML, paragraphs), because mods cannot import npm packages
and inline parsing stays TextView's.

## 5. Steps, in order

Each step ends with: `herdr-app check mods/t3-chat`, the tests (`node mods/t3-chat/*.test.mjs`),
a screenshot of the running chat beside T3 Code showing the same content, and a report to the
coordinator. t3-chat is opened only in a scratch tab until step 9; nothing the person uses changes.

1. **Renderer probes.** Scaffold `t3-chat` as a copy of agent-chat (works as agent-chat does).
   A fixture view (`props.view: "fixture"`) renders one Markdown sample covering every element in
   1.1. Probe the open questions of 1.3; write `RENDERER.md`. Same sample pasted into T3 for the
   side-by-side.
2. **Renderer: prose.** `markdown.js` splitter + tests; paragraphs, headings, lists, quotes,
   alerts, hr, spacing, fonts, colours, links. Row heights: `list()` or re-tuned estimates.
3. **Renderer: code blocks.** Card, header, copy, wrap, highlighting (Editor or plain), diff fences.
4. **Renderer: tables, details, HTML, images.** Table grid and copy; `<details>`; raw HTML;
   ```` ```html ```` preview and open-in-browser; image zoom.
5. **Timeline.** 736px lane, user bubble (collapse, attachments, hover row), assistant row and
   footer, work-log groups with tool icons and details, thinking, dividers, working line.
6. **Diffs and changed files.** Edit/Write diffs in the work log, `ChangedFilesTree` card per
   turn, links to the Changes panel.
7. **Composer.** Surface, attachments strip, command menu (`@`, `/`), primary action, context
   strip, prompt history, mention chips if possible.
8. **Approvals, questions, plans, todos, controls.** Pending panels, plan card, todo row; model,
   mode, effort, context controls; empty/fresh state; banners; keys and `help-keys.json`.
9. **Wiring** (after a second go-ahead): new-tab menu entry, key, agent-click lookups in the T3
   layout's mods, README section. Then the person decides on the switch from agent-chat.

## 6. Decisions that are the person's

1. Key for "New chat" (proposal `cmd-alt-n`), and whether `cmd-j` / `cmd-d` may be bound inside
   the chat (`mod:t3-chat` section) for terminal / Changes.
2. Fonts: T3's system font (SF) for chat text if it resolves, or keep the layout's `ui_font`.
3. Chat width: T3's default 46rem (736px), or keep agent-chat's 920px.
4. Whether step 9 may touch the t3 mods that resolve an agent's pane (needed for clicks from
   Agents/Inbox to land on the chat).

## 7. Not possible in Herdr (summary)

Backdrop blur; Shiki's exact themes; KaTeX and Mermaid drawn inline; a real HTML/CSS frame inline
(browser pane instead); live rich-text composer; selection across blocks; message edit/rewind,
side chats, multi-provider/model send, voice, minimap, stash; system file picker for attachments.
Codex: out of scope (the transcript reader is Claude Code's).

## As built (2026-11-10)

Differences from the plan above:

- The conversation is not a Herdr list: rows are placed and scrolled by the mod (`scroll.js`), so it
  can follow a reply, stop following when the person scrolls back, and keep the view still while
  rows above it are measured. It has its own scrollbar.
- Decided by the person: key `cmd-alt-n`; no `cmd-j` / `cmd-d` in the chat and no terminal toggle
  in its UI (`t` stays as the fallback, and the "Terminal" button on what Claude asks); SF system
  font; 736px lane; the t3 mods' `zoom.js` sends a click on a chat's agent to the chat.
- Code blocks never wrap (no wrap toggle); tables copy as Markdown only; no image zoom and no
  "open in browser" for HTML previews; Mermaid and math stay code blocks.
- Diffs: line level only, flat file list instead of T3's tree.
- Composer: plain textarea (no chips, no thumbnails, no attach button), under the conversation.
- Mode control cycles (as shift-tab) instead of opening a menu. The effort menu types `/effort`,
  which Claude Code also saves as the default for new sessions.
- What Claude asks is read off its screen; the waiting tool call is in the transcript only late,
  so the preview is usually Claude Code's own (unwrapped from its narrow hidden pane). Plans are
  read from Claude Code's plan file.
- Todos: drawn from `TodoWrite`; Claude Code builds without that tool show none.
- Not built: thread find, minimap, queued-message editing, rewind, side chats, voice.
- After the plan: Claude opens as a chat everywhere (workspace openers, `scripts/start-task.mjs`),
  running Claude Code terminals are taken over in place (`scripts/chat-adopt.mjs`, `props.terminal`),
  and the chat follows Claude Code to a new session after `/clear` (`followSession`).
