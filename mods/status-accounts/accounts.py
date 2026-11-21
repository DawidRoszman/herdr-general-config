#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

class AccountError(Exception):
    pass

def read_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default

PERSONAL_DOMAINS = {"gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "yahoo.com"}
FRESH_ENV = ("HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TMPDIR")

def login_env() -> dict:
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
    home = Path.home()
    config = Path(os.path.expanduser(config_dir)) / ".claude.json" if config_dir else home / ".claude.json"
    oauth = read_json(config, {}).get("oauthAccount") or {}
    email = oauth.get("emailAddress") or ""
    shown_dir = str(Path(os.path.expanduser(config_dir))).replace(str(home), "~", 1) if config_dir else "~/.claude"
    return {"email": email, "org": oauth.get("organizationName") or "", "configDir": shown_dir, "kind": account_kind(email)}

def account_kind(email: str) -> str:
    if not email or "@" not in email:
        return "unknown"
    return "personal" if email.split("@", 1)[1].lower() in PERSONAL_DOMAINS else "work"

def gh_login(env: dict) -> str:
    gh = shutil.which("gh", path=env.get("PATH"))
    if not gh:
        return ""
    try:
        r = subprocess.run([gh, "api", "user", "--jq", ".login"], capture_output=True, text=True, timeout=10, env=env, stdin=subprocess.DEVNULL)
        return r.stdout.strip() if r.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""

def folder_accounts(folder: str) -> dict:
    env, warning = folder_env(folder, login_env())
    return {"folder": folder, "claude": claude_account(env.get("CLAUDE_CONFIG_DIR")), "gh": gh_login(env),
            "profile": env.get("HERDR_PROFILE", ""), **({"warning": warning} if warning else {})}

def process_environ(pid: int) -> dict:
    environ = Path(f"/proc/{pid}/environ")
    if environ.exists():
        return dict(item.split("=", 1) for item in environ.read_bytes().decode(errors="replace").split("\0") if "=" in item)
    out = subprocess.run(["ps", "eww", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout
    if not out.strip():
        raise AccountError(f"No process {pid}.")
    return dict(part.split("=", 1) for part in out.split() if "=" in part)

def process_claude_account(pid: int) -> dict:
    environ = process_environ(pid)
    return {**claude_account(environ.get("CLAUDE_CONFIG_DIR")), "profile": environ.get("HERDR_PROFILE", "")}

def main(argv: list) -> int:
    try:
        command, *args = argv or ["--help"]
        if command == "account":
            print(json.dumps(folder_accounts(os.path.realpath(os.path.expanduser(args[0])))))
        elif command == "process-account":
            print(json.dumps(process_claude_account(int(args[0]))))
        else:
            print(__doc__ or "")
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
