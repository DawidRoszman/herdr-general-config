# Herdr for Multirepo

A [Herdr](https://herdr.dev) desktop layout for working with many coding agents across several
machines, on GitHub pull requests and multirepo projects (one feature branch spread over several
sibling repositories). It builds on the [Herdr T3](https://github.com/JinJieBeWater/herdr-t3)
layout, whose file and mod names it keeps (`layouts/herdr-t3.json`, `t3-*`), and adds:

- **Pull requests** in a side panel, with a review tab per branch across every repo of a
  multirepo project: overview, files (GitHub-style diff), checks, commits, approve, request
  changes, merge, reviewers, GitHub stacks. `cmd-shift-g` opens the PR of the space you're in.
- **Multirepo projects** (`mr`, `cmd-shift-m`): tasks are one branch across several repos,
  checked out together as worktrees; task spaces sit under their project's space in the sidebar.
- **Walkthrough** (`cmd-shift-k`, or `w` in a PR review): Claude explains a diff step by step,
  a PR or every linked PR of a multirepo branch read as one change.
- **Side panels** for Files, Changes (multirepo-aware) and Pull requests, toggled from the tab bar
  or `cmd-alt-f` / `cmd-alt-c` / `cmd-alt-p`, and a notification bell with a history.
- **Inbox** with machine names on each card and `ctrl-1…9` to jump between its items.
- **Agents you can tell apart:** each is named after its branch or multirepo task, with a chip
  for the Claude Code account it really runs as (work or personal, from its `CLAUDE_CONFIG_DIR`).
- **Checkouts from PRs:** `g` in a PR review or the PR list opens the branch's multirepo task or
  worktree in a space, making it when missing.
- **Jira** board (`cmd-shift-j`), a **browser** pane shared with your agents (`cmd-shift-i`),
  **Blueprint** flowcharts, **worktree** dialogs, **port forwarding**, a **command palette**
  (`cmd-shift-p`).

`layouts/`, `mods/` and `keys.json` are exported from the maintainer's own Herdr config, so
changes to them are made there and exported again; issues and ideas are welcome here.

## Install

In Herdr, ask your agent:

> Read ~/.config/herdr-app/AGENTS.md, then add this layout: <this repo's URL>

It follows [`RECIPE.md`](RECIPE.md): copies `layouts/herdr-t3.json` and every mod into your
Herdr home, merges `keys.json` into yours (asking before it replaces a key you use) and switches
to the layout. Your own settings, theme and layouts stay as they are; `cmd-shift-l` switches back.

### What you need

| For | Program | On |
| --- | --- | --- |
| Pull requests, multirepo | `gh` (logged in), `git`, `python3` | every machine with projects |
| Coloured diffs (optional) | [`delta`](https://github.com/dandavison/delta) | this computer |
| Walkthrough | Claude Code (`claude`, logged in) | this computer |
| Jira | Atlassian's `acli` (`acli jira auth login --web`) | this computer |
| Browser | Chrome or Chromium, Node.js | each machine you browse from |

On Windows, install [Git for Windows](https://gitforwindows.org) with its `usr\bin` on `PATH`
(the mods run helper scripts with `sh`) and Python's `py` launcher.

Other machines: add them in Herdr (Settings → Machines, or `hc machine add`). The PR list, `mr`
and the browser run there over ssh; nothing needs installing on them but the programs above.

### Your own settings

- **Jira:** copy `mods/jira/config.example.json` to `mods/jira/config.json` and fill in your
  Atlassian site, your project keys and, for each, the multirepo project it starts tasks in
  (`machine`: a Herdr machine name, or null for this computer; `root`: the project's folder).
- **Multirepo projects:** `cmd-shift-m`, then add a project (a folder whose children are git
  repos). `mr` keeps its list per machine.

## Update

An agent never overwrites a mod, so adding the layout again would install second copies. Ask:

> Update Herdr for Multirepo from <this repo's URL>: replace my
> layouts/herdr-t3.json and each of its mods with the bundle's, keep mods/jira/config.json, merge
> its keys.json again, then run herdr-app check on every mod.

## Credits

The T3 layout and `t3-*` mods are [herdr-t3](https://github.com/JinJieBeWater/herdr-t3) by
JinJieBeWater (Apache-2.0), changed as described above; `t3-panels` is new. `changes-multi` and
`wt-dialog` start from Herdr's shipped `changes` and `worktree` mods (Apache-2.0). The license is
in [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt). `walkthrough` is
[herdr-walkthrough](https://github.com/dmazlum/herdr-walkthrough) by dmazlum (MIT), extended
with pull-request sets and finished-generation toasts. `blueprint` is a fork of
[herdr-blueprint-app](https://github.com/chappse6/herdr-blueprint-app) by chappse6 (MIT), with
remote-machine support. Their licenses are in [`licenses/`](licenses/).
