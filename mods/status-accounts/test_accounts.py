import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import accounts

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

assert set(accounts.process_claude_account(os.getpid())) == {"email", "org", "configDir", "kind", "profile"}

import subprocess
WAITING = [sys.executable, "-c", "import time; time.sleep(30)"]
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
