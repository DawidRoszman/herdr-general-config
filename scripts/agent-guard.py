#!/usr/bin/env python3

from __future__ import annotations

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
WRAPPERS = {"exec", "command", "builtin", "nohup", "time", "sudo", "nice", "xargs", "npx", "bunx", "caffeinate"}
KEYWORDS = {"{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until"}
WRAPPER_VALUE_FLAGS = {"-u", "-g", "-n", "-I", "-P", "-L", "-s", "-E"}
ENV_VALUE_FLAGS = {"-u", "--unset", "-C", "--chdir"}
HC_VALUE_FLAGS = {"--name", "--cwd", "--on", "--label", "--parent", "--timeout"}
LOCAL = "local"
SUBAGENT_TOOLS = {"Agent", "Task", "Workflow"}
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
TEMPLATE_NAME = re.compile(r"^[\w.-]+$")
SEPARATING = set(";|&()")
REDIRECTING = set("<>&")
AS_TEXT = {char: chr(0xE000 + at) for at, char in enumerate(";|&()<>")}
FROM_TEXT = str.maketrans({mark: char for char, mark in AS_TEXT.items()})
WORD_START = " \t\n;|&("

@dataclass
class Started:
    programs: set = field(default_factory=set)
    placed: set = field(default_factory=set)
    hc_placed: set = field(default_factory=set)

def without_heredocs(text: str) -> str:
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
    return "\n".join(kept + body if waiting else kept)

def as_one_line(text: str) -> str:
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
    lexer = shlex.shlex(as_one_line(text), posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    lexer.commenters = ""
    commands, words, is_file_next = [], [], False
    for token in lexer:
        is_operator = bool(token) and set(token) <= SEPARATING | REDIRECTING
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

def note_shell(args: list, started: Started, machine=None) -> None:
    for at, arg in enumerate(args):
        if arg.startswith("-") and not arg.startswith("--") and "c" in arg[1:]:
            script = args[at + 1] if at + 1 < len(args) else ""
            note_text(script, started, machine)
            if re.search(r"\$[@*]", script):
                note_command(args[at + 3:], started, machine)
            return

def hc_machine(args: list, machine):
    at = 0
    while at < len(args) and args[at] != "--":
        if args[at] == "--on" and at + 1 < len(args):
            return args[at + 1]
        if args[at].startswith("--on="):
            return args[at].split("=", 1)[1]
        if args[at] in HC_VALUE_FLAGS:
            at += 2
        elif args[at].startswith("-"):
            at += 1
        else:
            break
    return machine

def note_hc(args: list, started: Started, machine=None) -> None:
    machine = hc_machine(args, machine)
    argv = after_options(args, HC_VALUE_FLAGS)
    if not argv:
        return
    started.hc_placed.add((argv[0], machine))
    if len(argv) == 1:
        note_text(argv[0], started, machine)
    else:
        note_command(argv, started, machine)

def note_command(words: list, started: Started, machine=None) -> None:
    while words and (ASSIGNMENT.match(words[0]) or words[0] in KEYWORDS):
        words = words[1:]
    if not words:
        return
    program, args = os.path.basename(words[0]), words[1:]
    started.programs.add(program)
    started.placed.add((program, machine))
    if program == "command" and args[:1] in (["-v"], ["-V"]):
        return
    if program in WRAPPERS:
        note_command(after_options(args, WRAPPER_VALUE_FLAGS), started, machine)
    elif program == "env":
        note_command(after_options(args, ENV_VALUE_FLAGS), started, machine)
    elif program in SHELLS:
        note_shell(args, started, machine)
    elif program == "eval":
        note_text(" ".join(args), started, machine)
    elif program == "hc" and args[:1] in (["run"], ["exec"]):
        note_hc(args[1:], started, machine)
    elif program == "direnv" and args[:1] == ["exec"]:
        note_command(args[2:], started, machine)
    elif "--" in args and any(os.path.basename(arg) == "profiles.py" for arg in args[:args.index("--")]):
        note_command(args[args.index("--") + 1:], started, machine)

def note_text(text: str, started: Started, machine=None) -> None:
    text = without_heredocs(text.replace("\\\n", ""))
    for inner in substitutions(text):
        note_text(inner, started, machine)
    for words in simple_commands(text):
        note_command(words, started, machine)

def started_by(command: str) -> Started:
    started = Started()
    note_text(command, started)
    return started

def template_command(path: Path) -> str:
    match = re.search(r"^command:\s*(.+)$", path.read_text(), re.MULTILINE)
    return match.group(1).strip() if match else ""

def named_anywhere(command: str, program: str) -> bool:
    return bool(re.search(rf"(^|[\s/'\"\[]){re.escape(program)}\b", command))

def placement_refusal(program: str, machine, rules: dict, agents: set) -> str | None:
    key = machine or LOCAL
    if program not in agents or key not in rules or program in rules[key]:
        return None
    allowed_on = sorted(name for name, allowed in rules.items() if program in allowed)
    where = "this computer" if key == LOCAL else key
    elsewhere = [name for name in allowed_on if name != LOCAL]
    hint = f"; start it there: hc run --on {elsewhere[0]} ... {program} ..." if elsewhere else ""
    return f"{program} may not run on {where} (allowed on: {', '.join(allowed_on) or 'no machine of this profile'}){hint}"

def programs_of(command: str, agents: set) -> set:
    try:
        return started_by(command).programs
    except Exception:
        return {program for program in agents if named_anywhere(command, program)}

def machine_refusal(command: str, rules: dict, agents: set, templates: Path = TEMPLATES) -> str | None:
    try:
        started = started_by(command)
    except Exception:
        started = Started(placed={(program, None) for program in agents if named_anywhere(command, program)})
    launches = set(started.placed)
    for name, machine in started.hc_placed:
        template = templates / f"{name}.md"
        if TEMPLATE_NAME.match(name) and template.is_file():
            try:
                launches |= {(program, machine) for program in programs_of(template_command(template), agents)}
            except (OSError, UnicodeDecodeError):
                return f"hc template '{name}' can't be read, so where its agent starts can't be checked"
    for program, machine in sorted(launches, key=lambda launch: (launch[0], launch[1] or "")):
        refusal = placement_refusal(program, machine, rules, agents)
        if refusal:
            return refusal
    return None

def profile_rules() -> tuple[dict, set, str]:
    sys.path.insert(0, str(PROFILES_MOD))
    import profiles

    config = profiles.load(profiles.app_home())
    name = profiles.current(config)["profile"]
    if not name:
        return {}, set(), ""
    return config.profiles[name]["agents"]["machines"], profiles.known_agents(config), f"in profile {name}"

def decide() -> int:
    event = json.load(sys.stdin)
    tool = event.get("tool_name", "Bash")
    command = event.get("tool_input", {}).get("command", "")
    try:
        rules, agents, where = profile_rules()
    except Exception as error:
        print(f"Blocked: the agent guard can't read the profiles ({error}). Fix profiles.json (profiles.py check).", file=sys.stderr)
        return BLOCK
    if not rules:
        return 0
    if tool in SUBAGENT_TOOLS:
        refusal = placement_refusal("claude", None, rules, agents)
        if refusal:
            print(f"Blocked: {tool} starts a Claude subagent on this computer, and {refusal} {where}.", file=sys.stderr)
            return BLOCK
        return 0
    refusal = machine_refusal(command, rules, agents)
    if refusal:
        print(f"Blocked: {refusal} {where}.", file=sys.stderr)
        return BLOCK
    return 0

def main() -> int:
    try:
        return decide()
    except Exception as error:
        print(f"Blocked: the agent guard failed ({type(error).__name__}) and can't clear this command. "
              "Check it with scripts/test_agent_guard.py.", file=sys.stderr)
        return BLOCK

if __name__ == "__main__":
    sys.exit(main())
