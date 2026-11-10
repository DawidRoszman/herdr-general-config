#!/usr/bin/env python3
"""Claude Code PreToolUse hook: keeps an agent from starting the programs its profile forbids.

    agent-guard.py                  forbids the profile's "agents.forbidden" (profiles.json): the
                                    profile is this process's, as `profiles.py current` says
    agent-guard.py --deny codex     forbids these programs instead (repeatable): for a machine
                                    without profiles.json, one that is a single profile's

Blocks a Bash command that runs a forbidden program: as a command of its own (first, or after a
pipe, &&, ; or a new line), behind env, exec, sh -c and the like, inside $( ), or through `hc run`,
by name or by an hc template whose command runs it (~/.config/herdr-core/templates/<name>.md).
The program's name in an argument (a message, a commit message, a pattern, a path) is not a run.
Exit 2 tells Claude Code to refuse the call and shows the reason to the agent.

A process of no profile is forbidden nothing. What stops the guard from deciding blocks: a
profiles.json that can't be read, an hc template the command starts that can't be read, an event
that isn't the hook's, any failure of its own. A guard that lets everything through when it is
broken is not one.
It is a rail for an agent that means well, not a sandbox: a heredoc fed to a shell or a script
file is not looked into.

In each Claude config dir's settings.json:
    "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "<this file>"}]}]}
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import sys
from dataclasses import dataclass, field
from pathlib import Path

TEMPLATES = Path.home() / ".config/herdr-core/templates"
PROFILES_MOD = Path(__file__).resolve().parent.parent / "mods/t3-context"
BLOCK = 2

SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "fish"}
# Programs that run the command given after their own options.
WRAPPERS = {"exec", "command", "builtin", "nohup", "time", "sudo", "nice", "xargs", "npx", "bunx", "caffeinate"}
KEYWORDS = {"{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until"}
# Options of those that take a value (sudo -u me, xargs -n 1, nice -n 5): the value is not the program.
WRAPPER_VALUE_FLAGS = {"-u", "-g", "-n", "-I", "-P", "-L", "-s", "-E"}
ENV_VALUE_FLAGS = {"-u", "--unset", "-C", "--chdir"}
HC_VALUE_FLAGS = {"--name", "--cwd", "--on", "--label", "--parent", "--timeout"}
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
TEMPLATE_NAME = re.compile(r"^[\w.-]+$")
SEPARATING = set(";|&()")
REDIRECTING = set("<>&")
# The shell's operator characters where they are quoted or escaped, so only text: kept apart from
# real operators through the tokenizer (which drops the quotes) as private-use characters.
AS_TEXT = {char: chr(0xE000 + at) for at, char in enumerate(";|&()<>")}
FROM_TEXT = str.maketrans({mark: char for char, mark in AS_TEXT.items()})
WORD_START = " \t\n;|&("


@dataclass
class Started:
    """What a command line starts."""
    programs: set = field(default_factory=set)  # the names of the programs it runs
    hc_targets: set = field(default_factory=set)  # what it gives `hc run` to start: a program, or a template's name


def without_heredocs(text: str) -> str:
    """The text without the bodies of its heredocs: they are input, not commands."""
    kept, body, waiting = [], [], []
    for line in text.split("\n"):
        if not waiting:
            kept.append(line)
            waiting = [found.group(2) for found in HEREDOC.finditer(line)]
        elif line.strip() == waiting[0]:
            waiting.pop(0)
            body = [] if not waiting else body
        else:
            body.append(line)
    # A "<<" that never met its end was no heredoc (a shift in some code): its lines are commands.
    return "\n".join(kept + body if waiting else kept)


def as_one_line(text: str) -> str:
    """The text as a tokenizer of words needs it: new lines outside quotes as ";", comments dropped,
    quoted or escaped operator characters marked as text (AS_TEXT), and the number of a redirection
    (2>file, 2>&1) left out, so it isn't taken for a word."""
    out, quote, at = [], None, 0
    while at < len(text):
        char = text[at]
        if char == "\\" and quote != "'" and at + 1 < len(text):
            out.append("\\" + AS_TEXT.get(text[at + 1], text[at + 1]))
            at += 2
            continue
        if quote:
            quote = None if char == quote else quote
            char = AS_TEXT.get(char, char)
        elif char in "'\"":
            quote = char
        elif char == "#" and (at == 0 or text[at - 1] in WORD_START):
            at = text.find("\n", at) if "\n" in text[at:] else len(text)
            continue
        elif char == "\n":
            char = " ; "
        elif char.isdigit() and (at == 0 or text[at - 1] in WORD_START):
            end = at
            while end < len(text) and text[end].isdigit():
                end += 1
            if text[end:end + 1] in ("<", ">"):
                at = end
                continue
        out.append(char)
        at += 1
    return "".join(out)


def substitutions(text: str) -> list:
    """The commands inside $( ) and backticks, outside single quotes: the shell runs them wherever they stand."""
    found, quote, at = [], None, 0
    while at < len(text):
        char = text[at]
        if char == "\\" and quote != "'":
            at += 2
            continue
        if quote == "'":
            quote = None if char == "'" else quote
        elif char == "'" and quote is None:
            quote = "'"
        elif char == '"':
            quote = None if quote == '"' else '"'
        elif text.startswith("$(", at):
            depth, end = 1, at + 2
            while end < len(text) and depth:
                depth += {"(": 1, ")": -1}.get(text[end], 0)
                end += 1
            found.append(text[at + 2:end - 1 if depth == 0 else end])
            at = end
            continue
        elif char == "`":
            end = text.find("`", at + 1)
            if end == -1:
                break
            found.append(text[at + 1:end])
            at = end
        at += 1
    return found


def simple_commands(text: str) -> list:
    """The text as lists of words, one per command between ; | & ( ) and new lines, redirections left out.
    Raises ValueError for what shlex can't read (an open quote)."""
    lexer = shlex.shlex(as_one_line(text), posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    lexer.commenters = ""
    commands, words, is_file_next = [], [], False
    for token in lexer:
        is_operator = bool(token) and set(token) <= SEPARATING | REDIRECTING  # "" is an empty quoted word
        if is_file_next and not is_operator:
            is_file_next = False
        elif is_operator and set(token) <= REDIRECTING and set(token) & set("<>"):
            is_file_next = True
        elif is_operator:
            commands.append(words)
            words = []
        else:
            words.append(token.translate(FROM_TEXT))
    return [command for command in [*commands, words] if command]


def after_options(args: list, value_flags=frozenset()) -> list:
    """args from the first one that is not an option (or follows --)."""
    at = 0
    while at < len(args):
        if args[at] == "--":
            return args[at + 1:]
        if args[at] in value_flags:
            at += 2
        elif args[at].startswith("-") or ASSIGNMENT.match(args[at]):
            at += 1
        else:
            break
    return args[at:]


def note_shell(args: list, started: Started) -> None:
    """sh -c '<commands>' [name [arguments]]: the commands, and the arguments when the commands run them ("$@")."""
    for at, arg in enumerate(args):
        if arg.startswith("-") and not arg.startswith("--") and "c" in arg[1:]:
            script = args[at + 1] if at + 1 < len(args) else ""
            note_text(script, started)
            if re.search(r"\$[@*]", script):
                note_command(args[at + 3:], started)
            return


def note_hc(args: list, started: Started) -> None:
    """hc run|exec [options] <program or template> [arguments], or one quoted string: a shell command."""
    argv = after_options(args, HC_VALUE_FLAGS)
    if not argv:
        return
    started.hc_targets.add(argv[0])
    if len(argv) == 1:
        note_text(argv[0], started)
    else:
        note_command(argv, started)


def note_command(words: list, started: Started) -> None:
    """One command's program, and what that program is given to run."""
    while words and (ASSIGNMENT.match(words[0]) or words[0] in KEYWORDS):
        words = words[1:]
    if not words:
        return
    program, args = os.path.basename(words[0]), words[1:]
    started.programs.add(program)
    if program == "command" and args[:1] in (["-v"], ["-V"]):
        return  # asks where a program is; runs nothing
    if program in WRAPPERS:
        note_command(after_options(args, WRAPPER_VALUE_FLAGS), started)
    elif program == "env":
        note_command(after_options(args, ENV_VALUE_FLAGS), started)
    elif program in SHELLS:
        note_shell(args, started)
    elif program == "eval":
        note_text(" ".join(args), started)
    elif program == "hc" and args[:1] in (["run"], ["exec"]):
        note_hc(args[1:], started)
    elif program == "direnv" and args[:1] == ["exec"]:
        note_command(args[2:], started)
    elif "--" in args and any(os.path.basename(arg) == "profiles.py" for arg in args[:args.index("--")]):
        note_command(args[args.index("--") + 1:], started)  # profiles.py run <profile> -- <command>


def note_text(text: str, started: Started) -> None:
    text = without_heredocs(text.replace("\\\n", ""))
    for inner in substitutions(text):
        note_text(inner, started)
    for words in simple_commands(text):
        note_command(words, started)


def started_by(command: str) -> Started:
    """What a Bash command starts. Raises ValueError when it can't be read."""
    started = Started()
    note_text(command, started)
    return started


def template_command(path: Path) -> str:
    match = re.search(r"^command:\s*(.+)$", path.read_text(), re.MULTILINE)
    return match.group(1).strip() if match else ""


def named_anywhere(command: str, program: str) -> bool:
    """The rule for a command that can't be read as the shell would: the program's name as a word, anywhere."""
    return bool(re.search(rf"(^|[\s/'\"\[]){re.escape(program)}\b", command))


def runs(command: str, program: str) -> bool:
    """Whether a command line runs the program; one that can't be read counts when it names it at all."""
    try:
        return program in started_by(command).programs
    except Exception:  # noqa: BLE001: an open quote (ValueError), or a fault in the reading itself
        return named_anywhere(command, program)


def template_refusal(template: Path, program: str) -> str | None:
    """Why starting this hc template is refused for the program; None when it doesn't run it."""
    try:
        command = template_command(template)
    except (OSError, UnicodeDecodeError):
        return f"hc template '{template.stem}' can't be read, so it can't be cleared of running {program}"
    return f"hc template '{template.stem}' runs {program}, which is not allowed" if runs(command, program) else None


def reason_to_block(command: str, program: str, templates: Path = TEMPLATES) -> str | None:
    try:
        started = started_by(command)
    except Exception:  # noqa: BLE001: as in runs
        return f"{program} is not allowed (this command can't be read, so its name anywhere counts)" if named_anywhere(command, program) else None
    if program in started.programs:
        return f"{program} is not allowed"
    for name in sorted(started.hc_targets):
        template = templates / f"{name}.md"
        if TEMPLATE_NAME.match(name) and template.is_file():
            refusal = template_refusal(template, program)
            if refusal:
                return refusal
    return None


def profile_forbidden() -> tuple[list[str], str]:
    """(programs, where the rule is from) for this process's profile; ([], "") when it has none."""
    sys.path.insert(0, str(PROFILES_MOD))
    import profiles  # the one implementation of which profile a process is in

    config = profiles.load(profiles.app_home())
    name = profiles.current(config)["profile"]
    return (config.profiles[name]["agents"]["forbidden"], f"in profile {name}") if name else ([], "")


def decide() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--deny", action="append", help="a program this Claude config must not start (default: the profile's)")
    args = parser.parse_args()
    command = json.load(sys.stdin).get("tool_input", {}).get("command", "")
    if args.deny:
        forbidden, where = args.deny, "from this account"
    else:
        try:
            forbidden, where = profile_forbidden()
        except Exception as error:  # noqa: BLE001: whatever stops the rule from being read must block, not pass
            print(f"Blocked: the agent guard can't read the profiles ({error}). Fix profiles.json (profiles.py check).", file=sys.stderr)
            return BLOCK
    for program in forbidden:
        reason = reason_to_block(command, program)
        if reason:
            print(f"Blocked: {reason} {where}. Use an agent CLI or template this profile allows.", file=sys.stderr)
            return BLOCK
    return 0


def main() -> int:
    try:
        return decide()
    except Exception as error:  # noqa: BLE001: a guard that fails must refuse, not let the command through
        print(f"Blocked: the agent guard failed ({type(error).__name__}) and can't clear this command. "
              "Check it with scripts/test_agent_guard.py.", file=sys.stderr)
        return BLOCK


if __name__ == "__main__":
    sys.exit(main())
