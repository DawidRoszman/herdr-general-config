#!/usr/bin/env python3
"""accounts: which Claude Code account and gh user a terminal in a folder gets, or a running
agent uses, on this machine. Run by the status-accounts mod (as `python3 -c`, on any machine).

    account <folder>        {"folder", "claude": {email, org, configDir, kind}, "gh", "warning"?}
    process-account <pid>   {email, org, configDir, kind} of a running process

A folder's accounts come from a fresh login shell plus direnv's .envrc for that folder, as a new
terminal there gets them; a process's from its own CLAUDE_CONFIG_DIR. kind: work | personal | unknown.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


class AccountError(Exception):
    """A failure the status bar shows as it is."""


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default



# Mail providers whose accounts are personal; any other domain is taken as an organization's.
PERSONAL_DOMAINS = {"gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "yahoo.com"}
FRESH_ENV = ("HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TMPDIR")


def login_env() -> dict:
    """The environment a fresh login shell has (PATH and whatever the shell's files set), started
    from a near-empty environment so nothing leaks in from whoever started this process (an
    inherited CLAUDE_CONFIG_DIR would silently pick another account).
    HERDR_ACCOUNTS_ENV=inherit keeps this process's own environment instead (for tests)."""
    if os.environ.get("HERDR_ACCOUNTS_ENV") == "inherit":
        return dict(os.environ)
    shell = os.environ.get("SHELL") or "/bin/sh"
    fresh = {k: os.environ[k] for k in FRESH_ENV if k in os.environ}
    try:
        out = subprocess.run([shell, "-lic", "env -0"], capture_output=True, timeout=15, stdin=subprocess.DEVNULL, env=fresh).stdout
        env = dict(item.split("=", 1) for item in out.decode(errors="replace").split("\0") if "=" in item)
        return env if env.get("PATH") else dict(os.environ)
    except (OSError, subprocess.TimeoutExpired):
        return dict(os.environ)


def folder_env(folder: str, base: dict):
    """(environment, warning) of a shell in folder: the login environment plus direnv's .envrc
    for it, as a terminal there gets. A blocked or broken .envrc is a warning, never silent."""
    direnv = shutil.which("direnv", path=base.get("PATH"))
    if not direnv or os.environ.get("HERDR_ACCOUNTS_ENV") == "inherit":
        return base, ""
    try:
        r = subprocess.run([direnv, "exec", folder, "env", "-0"], capture_output=True, timeout=30, env=base, cwd=folder, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as error:
        return base, f"direnv didn't run for {folder}: {error}"
    if r.returncode != 0:
        why = r.stderr.decode(errors="replace").strip().splitlines()
        return base, f"direnv: {why[-1] if why else 'failed'} ({folder})"
    env = dict(item.split("=", 1) for item in r.stdout.decode(errors="replace").split("\0") if "=" in item)
    return (env if env.get("PATH") else base), ""


def claude_account(config_dir) -> dict:
    """Who a Claude Code with this CLAUDE_CONFIG_DIR (None: the default) is signed in as."""
    home = Path.home()
    config = Path(os.path.expanduser(config_dir)) / ".claude.json" if config_dir else home / ".claude.json"
    oauth = read_json(config, {}).get("oauthAccount") or {}
    email = oauth.get("emailAddress") or ""
    shown_dir = str(Path(os.path.expanduser(config_dir))).replace(str(home), "~", 1) if config_dir else "~/.claude"
    return {"email": email, "org": oauth.get("organizationName") or "", "configDir": shown_dir, "kind": account_kind(email)}


def account_kind(email: str) -> str:
    """personal (a public mail provider), work (an organization's domain) or unknown."""
    if not email or "@" not in email:
        return "unknown"
    return "personal" if email.split("@", 1)[1].lower() in PERSONAL_DOMAINS else "work"


def gh_login(env: dict) -> str:
    """The GitHub user gh acts as with this environment (GH_TOKEN, else gh's active account)."""
    gh = shutil.which("gh", path=env.get("PATH"))
    if not gh:
        return ""
    try:
        r = subprocess.run([gh, "api", "user", "--jq", ".login"], capture_output=True, text=True, timeout=10, env=env, stdin=subprocess.DEVNULL)
        return r.stdout.strip() if r.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def folder_accounts(folder: str) -> dict:
    """The accounts a terminal or chat started in folder uses: Claude Code's and gh's."""
    env, warning = folder_env(folder, login_env())
    return {"folder": folder, "claude": claude_account(env.get("CLAUDE_CONFIG_DIR")), "gh": gh_login(env),
            **({"warning": warning} if warning else {})}


def process_claude_account(pid: int) -> dict:
    """The Claude account of a running process, from its CLAUDE_CONFIG_DIR (an agent in a terminal)."""
    environ = Path(f"/proc/{pid}/environ")
    if environ.exists():
        pairs = dict(item.split("=", 1) for item in environ.read_bytes().decode(errors="replace").split("\0") if "=" in item)
        return claude_account(pairs.get("CLAUDE_CONFIG_DIR"))
    out = subprocess.run(["ps", "eww", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout
    if not out.strip():
        raise AccountError(f"No process {pid}.")
    found = [part.split("=", 1)[1] for part in out.split() if part.startswith("CLAUDE_CONFIG_DIR=")]
    return claude_account(found[-1] if found else None)



def main(argv: list) -> int:
    try:
        command, *args = argv or ["--help"]
        if command == "account":
            print(json.dumps(folder_accounts(os.path.realpath(os.path.expanduser(args[0])))))
        elif command == "process-account":
            print(json.dumps(process_claude_account(int(args[0]))))
        else:
            print(__doc__)
            return 0 if command in ("--help", "-h", "help") else 2
    except AccountError as error:
        print(f"accounts: {error}", file=sys.stderr)
        return 1
    except (IndexError, ValueError) as error:
        print(f"accounts: bad arguments ({error})", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
