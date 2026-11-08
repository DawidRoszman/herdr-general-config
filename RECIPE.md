# Herdr for Multirepo

A calm T3 Code-style window for many coding agents on several machines, built around GitHub
pull requests and multirepo projects: an Inbox of the agents that need you on the left, slim tabs
on top, framed panes, and a right side panel for Files, Changes and Pull requests.

## What you see

Left to right:

- **Sidebar** (256px, `chrome`): the brand row (40px), then either the **Inbox** (agents that
  need you as cards, working ones folded into a Working shelf, settled ones at the bottom; each
  card names another machine's agent beside a server mark; the first nine show a faint 1–9) or
  **Lists** (Spaces grouped by machine, worktree spaces and multirepo task spaces nested under
  their project's space, then Agents), and a 44px footer.
- **Work column**: a 40px tab bar (`t3-tabs`, then `t3-actions`' Add action, then `t3-panels`:
  Files, Changes, Pull requests toggles and a notification bell with an unread count), the shown
  tab's panes framed with `t3-pane` headers, and on the right a hidden 368px **panel** column whose
  `panel-body` stack holds `files`, `changes` (`changes-multi`) and `prs` (the PR monitor).
- A zero-width block, `walkthrough-watch`, that draws nothing.

## How it behaves

- Agent states as T3: working (spinner, folded into the shelf), blocked ("Needs you", top),
  done (check, top, until settled), idle. Settle with ✓ on a card or `cmd-shift-s`.
- `cmd-shift-b` switches Inbox / Lists. With the Inbox shown, `ctrl-1…9` goes to its nth row;
  with Lists, to the nth space.
- `cmd-alt-f` / `cmd-alt-c` / `cmd-alt-p` toggle the panel on Files / Changes / Pull requests (the
  tab bar buttons do the same); `cmd-n` is T3's New space (asks the machine), `cmd-shift-t` its
  New tab (asks the space), `cmd-t` a tab here. New tabs go to the end of their space.
- The bell opens the notification history; a second click closes it. Blocked agents, PR changes,
  finished walkthroughs, Blueprint and worktree messages are kept there.
- PR monitor: open and recently closed PRs grouped by branch topic; a click opens the branch's
  review tab in its project's space (a multirepo task's space, or the worktree that has the
  branch checked out), or goes to it when one is open. `cmd-shift-g` does that for the focused
  space's branch. In a review: Overview, Files, Checks, Commits, approve (reads "Approved" once
  you have), request changes, comment, merge, reviewers, stacks, `w` for a walkthrough of every
  linked PR as one change, `b` for Blueprint.
- `walkthrough-watch` stores walkthroughs that finish while their dialog is closed and posts
  "Walkthrough ready".

## Built from

- `layouts/herdr-t3.json` (`cloned_from` Herdr's `main`): the tree above; `terminal_menu: t3-menu`.
  The file and the `t3-*` mods keep the names of the Herdr T3 layout this builds on; keep them so.
- Mods, all in `mods/`: `t3-actions`, `t3-agents`, `t3-chrome`, `t3-home`, `t3-inbox`, `t3-menu`,
  `t3-new-menu`, `t3-pane`, `t3-panels`, `t3-picker`, `t3-spaces`, `t3-tabs` (the layout);
  `prs`, `multirepo` (its `mr.py` is streamed to `python3` over ssh on each machine), `mr-pull`,
  `blueprint`, `changes-multi`, `walkthrough`, `notifications`, `jira`, `browser`,
  `command-palette`, `keybinds`, `wt-dialog`, `wt-new`, `wt-open`, `wt-remove`, `port-forward`.
- Herdr's shipped mods it uses: `files`, `workspace-status`, `confirm`, `prompt`, `menu`.
- `keys.json`: a `layout:herdr-t3` section and the global keys that open the mods above.

## Watch out

- **Before adding, tell the person:** mods run programs (`git`, `gh`, `python3`, `ssh`, `hc`,
  `claude -p` for walkthroughs, `acli` for Jira, Chrome for the browser), on this computer and,
  through ssh and `hc exec`, on the machines Herdr knows. Walkthroughs read Claude Code
  transcripts in `~/.claude/projects` and write `~/.herdr/walkthrough`. No mod reaches the
  internet itself: the browser talks only to its own Chrome on 127.0.0.1, and Blueprint's
  update check is off in this fork.
- **Names matter.** Mods refer to each other by folder name (`mods/multirepo/mr.py`,
  `mod.open:prs`, `mods/notifications/icons/…`, the `t3-*` names in the layout). If a name is
  taken, don't install under a new name: ask the person, since a renamed mod breaks the others.
- **Never copy** `mods/jira/config.json` from anywhere: the person writes their own from
  `config.example.json`. On update, keep theirs.
- **Keys:** merge `keys.json`; ask before replacing a key the person already binds. The
  `layout:herdr-t3` section only applies while this layout shows.
- `herdr-app check` every mod; `check-*.cjs` files are the mods' own tests, not loaded by Herdr.

## Done when

- `herdr-app check` passes for every mod in `mods/`, and `layout.switch {name: "herdr-t3"}`
  shows the sidebar, tab bar with Files / Changes / Pull requests and the bell.
- `cmd-alt-p` opens the PR panel; it lists the person's PRs once `gh` is logged in.
- `cmd-shift-g` in a repo space on a branch with a PR opens its review tab.
- `herdr-app status` shows no errors.
