"""Self-check for accounts.py: python3 -I test_accounts.py"""

import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import accounts  # noqa: E402

assert accounts.account_kind("me@gmail.com") == "personal"
assert accounts.account_kind("me@acme.io") == "work"
assert accounts.account_kind("") == "unknown"

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp).resolve()
    (tmp / ".claude.json").write_text(json.dumps({"oauthAccount": {"emailAddress": "me@gmail.com", "organizationName": "me"}}))
    (tmp / ".claude-acme").mkdir()
    (tmp / ".claude-acme" / ".claude.json").write_text(json.dumps({"oauthAccount": {"emailAddress": "me@corp.io", "organizationName": "Corp"}}))
    os.environ["HOME"] = str(tmp)
    assert accounts.claude_account(None) == {"email": "me@gmail.com", "org": "me", "configDir": "~/.claude", "kind": "personal"}
    work = accounts.claude_account(str(tmp / ".claude-acme"))
    assert (work["kind"], work["configDir"], work["org"]) == ("work", "~/.claude-acme", "Corp")
    assert accounts.claude_account(str(tmp / "missing"))["kind"] == "unknown"

# This very process: its CLAUDE_CONFIG_DIR (or the default) gives an account record.
assert set(accounts.process_claude_account(os.getpid())) == {"email", "org", "configDir", "kind", "profile"}

# A process started as a profile (profiles.py run, or a folder's .envrc) says so in its environment.
import subprocess  # noqa: E402
WAITING = [sys.executable, "-c", "import time; time.sleep(30)"]  # not a system binary: macOS hides those' environment
child = subprocess.Popen(WAITING, env={**os.environ, "HERDR_PROFILE": "client", "CLAUDE_CONFIG_DIR": str(tmp / ".claude-acme")})
try:
    started = accounts.process_claude_account(child.pid)
    assert (started["profile"], started["configDir"]) == ("client", "~/.claude-acme"), started
finally:
    child.kill()
plain = subprocess.Popen(WAITING, env={k: v for k, v in os.environ.items() if k != "HERDR_PROFILE"})
try:
    assert accounts.process_claude_account(plain.pid)["profile"] == ""
finally:
    plain.kill()
print("accounts.py ok")
