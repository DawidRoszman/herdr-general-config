import assert from "node:assert/strict";
import { base64, signIn } from "./account.js";

for (const text of ["", "a", "ab", "abc", "jane@acme.example:tok-123_/+=", "zażółć:gęślą", "😀:x"]) {
  assert.equal(base64(text), Buffer.from(text, "utf8").toString("base64"), text);
}

const config = { site: "old.atlassian.net", email: "old@acme.example" };
const basic = (email, token) => `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
// exec as the mod and the script give it: answers by command, and records what was run.
const execWith = (answers, ran = []) => Object.assign(async (command, args) => {
  ran.push([command, ...args]);
  return { code: 0, stdout: "", stderr: "", ...answers[command] };
}, { ran });

// The profile's account wins, and its token comes resolved from profiles.py.
let exec = execWith({ python3: { stdout: JSON.stringify({ site: "acme.atlassian.net", email: "jane@acme.example", token: "tok" }) } });
let account = await signIn({ config, profile: "work", profilesPy: "/p/profiles.py", exec });
assert.deepEqual(exec.ran, [["python3", "/p/profiles.py", "account", "work", "jira"]]);
assert.equal(account.site, "acme.atlassian.net");
assert.equal(account.authorization, basic("jane@acme.example", "tok"));
assert.match(account.from, /profile work/);

// A profile without a Jira account (exit 3), or no profile: config.json's, with the token from ~/.profile.
exec = execWith({ python3: { code: 3, stderr: "profiles: profile personal has no jira account" }, sh: { stdout: "legacy-token\n" } });
account = await signIn({ config, profile: "personal", profilesPy: "/p/profiles.py", exec });
assert.equal(account.site, "old.atlassian.net");
assert.equal(account.authorization, basic("old@acme.example", "legacy-token"));
exec = execWith({ sh: { stdout: "legacy-token" } });
account = await signIn({ config, profile: null, profilesPy: "/p/profiles.py", exec });
assert.equal(exec.ran.length, 1, "no profile: profiles.py isn't asked");
assert.equal(account.authorization, basic("old@acme.example", "legacy-token"));

// Failures say what to fix, and a broken profile is not papered over by the old config.
await assert.rejects(signIn({ config, profile: "work", profilesPy: "/p", exec: execWith({ python3: { code: 1, stderr: "profiles: X is not set" } }) }), /Jira account of profile work: profiles: X is not set/);
await assert.rejects(signIn({ config, profile: "work", profilesPy: "/p", exec: execWith({ python3: { stdout: JSON.stringify({ site: "s", email: "e", token: null }) } }) }), /needs "token"/);
await assert.rejects(signIn({ config: {}, profile: "work", profilesPy: "/p", exec: execWith({ python3: { code: 3 } }) }), /give profile work an accounts\.jira/);
await assert.rejects(signIn({ config: { site: "s" }, profile: null, profilesPy: "/p", exec: execWith({}) }), /needs "email"/);
await assert.rejects(signIn({ config, profile: null, profilesPy: "/p", exec: execWith({ sh: { code: 3 } }) }), /ATLASSIAN_API_KEY is not set/);

console.log("account: ok");
