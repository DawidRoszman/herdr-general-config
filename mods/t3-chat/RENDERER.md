# t3-chat renderer: what Herdr honours (probed 2026-11-10, Herdr at zoom 1.2)

Probed with `{ view: "fixture" }` (fixture.js, fixture.md). T3's numbers are in PLAN.md 1.1.

| Question | Found | So |
|---|---|---|
| System font | `.AppleSystemUIFont` resolves (SF), as T3's `-apple-system` | Chat text uses it; elsewhere the layout's `ui_font` |
| Bold and italic in TextView | Not drawn in Geist (the ui font has no such faces loaded); drawn in SF | Another reason for SF |
| `line_height` | Ignored on the TextView itself; inherited from a wrapper | Wrapper sets 22.75px |
| `font_weight` | Inherited from a wrapper | Headings: wrapper 600 at T3's size |
| Inline code | Mono chip with a tinted fill; not styleable | Left as TextView draws it |
| Links | Blue, underlined (T3: no underline until hover); open by themselves | Left |
| Lists | Small dot bullets, `1.` then `A.` (T3: discs, `a.`), own spacing | Drawn by the mod: gutter, markers, item gaps; an item's text is TextView's |
| Blockquote | Left border, muted text; alerts (`[!NOTE]`) not known | Drawn by the mod |
| Code fence | Square bordered box, language at the right, no colours | Drawn by the mod |
| Table | Full grid of borders | Drawn by the mod |
| `<details>`, `<kbd>`, footnotes | Details always open; kbd dropped; footnotes as plain text | Details drawn by the mod; the rest left |
| `Editor` (readonly) | Colours syntax; `line_numbers: false, folding: false` give a bare view; needs an explicit height (collapses without) | Code blocks: Editor at lines x line height |
| `list()` (measured rows) | Exact heights, but cannot be scrolled from code (no handle) | Not usable: the chat must follow the end |
| `v_virtual_list` | Scrolls from code, but needs each row's height up front and cannot say where it is | Not used: the chat places its rows itself in a clipped box and scrolls them (scroll.js); each row reports its own height (`on_size_change`) |
| Hover of a row's children | No group hover | The row hears `on_hover` and shows its controls |
| Mouse events posted to the window (tests) | Ignored by Herdr unless they come from the real pointer | Tests drive the chat by its commands (`t3-chat.press:<row>` and others), or the real pointer |

| `on_size_change` | Reports zoomed pixels (x1.2 at zoom 1.2), not the px a mod writes | Divided by `settings().zoom` |

Compared with the T3 Code app on one real reply (an existing thread, read from T3's state database
read-only into `data/t3-chat/t3-sample.md`, which git ignores): `{ view: "fixture", file, at: "end" }`.
Headings, paragraphs, lists, quotes and their spacing match. Still different: the inline code chip
(TextView's fill is fainter than T3's 10% foreground), link underlines, and the theme's colours
(T3's default dark is black; the chat uses Herdr's theme).
