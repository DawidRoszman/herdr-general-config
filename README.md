# Herdr for Multirepo

A [Herdr](https://herdr.dev) desktop layout for working with many coding agents across several
machines, on GitHub pull requests and multirepo projects (one feature branch spread over several
sibling repositories). It builds on the [Herdr T3](https://github.com/JinJieBeWater/herdr-t3)
layout, whose file and mod names it keeps (`layouts/herdr-t3.json`, `t3-*`), and adds:

- **Pull requests** in a side panel, with a review tab per branch across every repo of a
  multirepo project: overview, files (GitHub-style diff), checks, commits, approve, request
  changes, merge, reviewers, GitHub stacks. In a review, `v` marks a file viewed and folds it,
  `y` copies the branch and `shift-y` the PR's URL; `b` in the list opens the PR on GitHub.
  `cmd-shift-g` opens the PR of the space you're in;
  a review tab reloads whenever you come back to it. Fix thread (`f`) sends a review thread to
  Claude in the branch's checkout, and Watch (`shift-w`) has it watch the open PRs.
- **Multirepo projects** (`mr`, `cmd-shift-m`): tasks are one branch across several repos,
  checked out together as worktrees; task spaces sit under their project's space in the sidebar.
  Stacked tasks are listed as a stack, each layer under the one it builds on; `y` copies a
  task's branch, `u` opens the pull popup for its repos.
- **Walkthrough** (`cmd-shift-k`, or `w` in a PR review): Claude explains a diff step by step,
  a PR or every linked PR of a multirepo branch read as one change.
- **Side panels** for Files, Changes (multirepo-aware) and Pull requests, toggled from the tab bar
  or `cmd-alt-f` / `cmd-alt-c` / `cmd-alt-p`, and a notification bell with a history. `cmd-alt-g` opens
  the focused pane's repo on GitHub, `cmd-alt-r` its folder in Finder. Changes shows All, Unstaged,
  Staged or Branch (the branch's work against its base); Files opens what it can't preview in the
  default app.
- **Inbox** with machine names on each card and `ctrl-1…9` to jump between its items.
- **Agents you can tell apart:** each is named after its branch or multirepo task. Pane headers
  carry a chip for the Claude Code account the agent really runs as (from its
  `CLAUDE_CONFIG_DIR`); Agents and Inbox show the chip only for an account that isn't the shown
  profile's.
- **Profiles** (the switch at the top of the sidebar, `ctrl-alt-tab`): a profile keeps one kind
  of work apart from another, say work and personal: its machines, folders, coordinator, agents
  and accounts. The sidebar shows one profile's spaces and agents at a time, and the status bar
  its accounts and usage. Make and edit them in the dialog the gear beside the switch opens
  ("Profiles" in the command palette), or in `profiles.json`. See "Your own settings".
- **A coordinator per profile, with a board:** a Claude chat that starts and tracks tasks from
  short orders, following the `CLAUDE.md` of its folder (`coordinators/example/CLAUDE.md` is one
  to start from). It keeps a `board.json` there, and in its space the side panel shows it: what
  needs you (decisions, and things to try that you tick off), each task's stage, PRs and tests,
  and the helper agents it started. `cmd-alt-b` hides and shows the board.
- **Checkouts from PRs:** `g` in a PR review or the PR list opens the branch's multirepo task or
  worktree in a space, making it when missing.
- **Claude as a chat** (`cmd-alt-n`, `cmd-shift-a`, or `cmd-enter` on a space in New tab; new
  workspaces open one): `t3-chat` draws a Claude Code session as T3 Code draws a thread, with
  Markdown, the work log and diffs, plans, approvals and Claude Code's questions, images (a click
  opens a lightbox; pasted ones show as thumbnails before sending), and T3's composer with `/`
  commands and `@` files. Claude Code itself runs in a terminal pane hidden behind the chat, so
  it stays a normal Herdr agent.
- **Jira** board (`cmd-shift-j`; in a coordinator's space it opens in the side panel) whose
  status columns drag into your own order, with a warning on issues whose status disagrees with
  their PRs and task branches. An issue's details start its task (`s`), go to the one it already
  has (`g`) and copy its branch (`y`); cards of started tasks show the coordinator board's stage.
  A **browser** pane shared with your agents (`cmd-shift-i`),
  **Blueprint** flowcharts, **worktree** dialogs, **port forwarding**, a **command palette**
  (`cmd-shift-p`).

`layouts/`, `mods/` and `keys.json` are exported from the maintainer's own Herdr config, so
changes to them are made there and exported again; issues and ideas are welcome here.

## Install

In Herdr, ask your agent:

> Read ~/.config/herdr-app/AGENTS.md, then add this layout: <this repo's URL>

It follows [`RECIPE.md`](RECIPE.md): copies `layouts/herdr-t3.json`, every mod, and the files
profiles and coordinators need (`profiles.example.json`, `coordinators/example/`, `scripts/`)
into your Herdr home, merges `keys.json` into yours (asking before it replaces a key you use)
and switches to the layout. Your own settings, theme and layouts stay as they are; `cmd-shift-l` switches back.

### What you need

| For | Program | On |
| --- | --- | --- |
| Pull requests, multirepo | `gh` (logged in), `git`, `python3` | every machine with projects |
| Coloured diffs (optional) | [`delta`](https://github.com/dandavison/delta) | this computer |
| Walkthrough | Claude Code (`claude`, logged in) | this computer |
| Jira | An [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens) as `ATLASSIAN_API_KEY=` in `~/.profile` | this computer |
| Browser | Chrome or Chromium, Node.js | each machine you browse from |

On Windows, install [Git for Windows](https://gitforwindows.org) with its `usr\bin` on `PATH`
(the mods run helper scripts with `sh`) and Python's `py` launcher.

Other machines: add them in Herdr (Settings → Machines, or `hc machine add`). The PR list, `mr`
and the browser run there over ssh; nothing needs installing on them but the programs above.

### Your own settings

- **Jira:** copy `mods/jira/config.example.json` to `mods/jira/config.json` and fill in your
  Atlassian site, the email of the account the API token belongs to, your project keys and, for
  each, the multirepo project it starts tasks in
  (`machine`: a Herdr machine name, or null for this computer; `root`: the project's folder; a
  list of them when it's checked out on several computers, the first starting tasks).
  `statusStages` names your statuses `todo`, `progress`, `review` or `testing`, for the warnings.
- **Claude usage (optional):** with one Claude Code account (`~/.claude`) the status bar needs
  nothing. With several, copy `mods/status-accounts/config.example.json` to `config.json` beside
  it and map each account to its Claude config dir, or null for `~/.claude`. Accounts are
  `work` or `personal` (a sign-in with a public mail provider's address is personal).
- **Profiles (optional):** without a `profiles.json` there is nothing to switch and nothing is
  hidden. To use them, copy `profiles.example.json` to `profiles.json` in your Herdr home and
  make it yours, or build them in the Profiles dialog. It holds names and account ids, never a
  secret: a secret is a reference, the name of a variable (`{"env": "JIRA_TOKEN"}`) or a command
  (`{"command": ["gh", "auth", "token"]}`). `python3 mods/t3-context/profiles.py check` says
  what is wrong with it. A space or an agent belongs to the first that answers: the profile it
  was started as (`HERDR_PROFILE`), its machine, its folder, its Claude account.
  `profiles.py run <profile> -- <command>` runs a command with that profile's accounts
  (coordinators start that way), and `profiles.py envrc <profile>` prints the lines for a
  folder's `.envrc`. `scripts/agent-guard.py` is a Claude Code hook that refuses the programs a
  profile forbids its agents to start; the file says how to add it.
- **Multirepo projects:** `cmd-shift-m`, then add a project (a folder whose children are git
  repos). `mr` keeps its list per machine.

## Update

An agent never overwrites a mod, so adding the layout again would install second copies. Ask:

> Update Herdr for Multirepo from <this repo's URL>: replace my
> layouts/herdr-t3.json and each of its mods with the bundle's, keep mods/jira/config.json, merge
> its keys.json again, then run herdr-app check on every mod.

## Credits

The T3 layout and `t3-*` mods are [herdr-t3](https://github.com/JinJieBeWater/herdr-t3) by
JinJieBeWater (Apache-2.0), changed as described above; `t3-panels` and `t3-chat` are new
(`t3-chat` copies the look of [T3 Code](https://github.com/pingdotgg/t3code)'s chat, MIT, T3 Tools Inc.;
none of its code is included). `changes-multi`, `t3-files` and
`wt-dialog` start from Herdr's shipped `changes`, `files` and `worktree` mods (Apache-2.0). The license is
in [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt). `walkthrough` is
[herdr-walkthrough](https://github.com/dmazlum/herdr-walkthrough) by dmazlum (MIT), extended
with pull-request sets and finished-generation toasts. `blueprint` is a fork of
[herdr-blueprint-app](https://github.com/chappse6/herdr-blueprint-app) by chappse6 (MIT), with
remote-machine support. Their licenses are in [`licenses/`](licenses/).
