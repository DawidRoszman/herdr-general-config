import assert from "node:assert/strict";
import { secretText, secretOf, portableFolder, toDraft, newDraft, duplicateOf, toProfile, moved, takenMachines, errorLines } from "./draft.js";

const providers = {
  claude: { fields: { configDir: false } },
  github: { fields: { user: false } },
  jira: { fields: { site: false, email: false, token: true } },
};
const places = { appHome: "/home/jane/.config/herdr-app", home: "/home/jane" };
// A profile as profiles.py lists it: every key filled in.
const listed = {
  label: "Work", badge: "Acme", color: "ansi3", machines: ["work-box"], folders: ["~/work", "~/clients"],
  coordinator: { folder: "/home/jane/.config/herdr-app/coordinators/work" },
  agents: { reviewer: "codex", reviewerTemplate: "reviewer", forbidden: ["opencode"] },
  accounts: { claude: { configDir: "~/.claude-acme" }, jira: { site: "acme.atlassian.net", email: "j@acme.example", token: { env: "JIRA_TOKEN" } } },
};
// The same profile as profiles.json holds it.
const written = {
  label: "Work", badge: "Acme", color: "ansi3", machines: ["work-box"], folders: ["~/work", "~/clients"],
  coordinator: { folder: "coordinators/work" },
  agents: { reviewer: "codex", forbidden: ["opencode"] },
  accounts: { claude: { configDir: "~/.claude-acme" }, jira: { site: "acme.atlassian.net", email: "j@acme.example", token: { env: "JIRA_TOKEN" } } },
};

assert.equal(secretText({ env: "TOKEN" }), "TOKEN");
assert.equal(secretText({ command: ["pass", "show", "jira"] }), '["pass","show","jira"]');
assert.equal(secretText(null), "");
assert.deepEqual(secretOf(" TOKEN "), { env: "TOKEN" });
assert.deepEqual(secretOf('["pass", "show", "jira"]'), { command: ["pass", "show", "jira"] });
assert.equal(secretOf("  "), null);
assert.throws(() => secretOf("[pass"), /a command is a JSON list/);

assert.equal(portableFolder("/home/jane/.config/herdr-app/coordinators/work", places.appHome, places.home), "coordinators/work");
assert.equal(portableFolder("/home/jane/notes/coord", places.appHome, places.home), "~/notes/coord");
assert.equal(portableFolder("/srv/coord", places.appHome, places.home), "/srv/coord");

// Opening a profile and saving it untouched writes what the file had.
const draft = toDraft("work", listed, providers, places);
assert.deepEqual(draft.folders, ["~/work", "~/clients"]);
assert.equal(draft.accounts.jira.token, "JIRA_TOKEN");
assert.deepEqual(toProfile(draft, providers), written);

// A folder is kept as it is written, whatever is in its name; an emptied row is no folder.
const odd = toDraft("work", { ...listed, folders: ["~/clients/Acme, Inc", "~/a\tb"] }, providers, places);
assert.deepEqual(toProfile({ ...odd, label: "Renamed" }, providers).folders, ["~/clients/Acme, Inc", "~/a\tb"]);
assert.deepEqual(toProfile({ ...odd, folders: ["  ~/x ", "", "  "] }, providers).folders, ["~/x"]);
assert.equal("folders" in toProfile({ ...odd, folders: [""] }, providers), false);

// Only what is set is written; an account stays with its fields empty; the badge defaults to the label.
const bare = toDraft("personal", { label: "Personal", badge: "Personal", color: null, machines: [], folders: [], coordinator: null,
  agents: { reviewer: null, reviewerTemplate: null, forbidden: [] }, accounts: { claude: { configDir: null } } }, providers, places);
assert.equal(bare.badge, "");
assert.deepEqual(toProfile(bare, providers), { label: "Personal", accounts: { claude: { configDir: null } } });
assert.deepEqual(toProfile({ ...newDraft(), label: " Side " }, providers), { label: "Side" });
// The reviewer is an agent, or none: off writes nothing.
assert.deepEqual(toProfile({ ...draft, reviewer: "" }, providers).agents, { forbidden: ["opencode"] });
assert.deepEqual(toProfile({ ...newDraft(), label: "S", reviewer: "claude" }, providers).agents, { reviewer: "claude" });
assert.deepEqual(toProfile({ ...newDraft(), label: "S", accounts: { jira: { site: "s", email: "", token: "" } } }, providers).accounts,
  { jira: { site: "s", email: null, token: null } });

const copy = duplicateOf(draft);
assert.deepEqual([copy.isNew, copy.name, copy.label, copy.machines, copy.folders, copy.coordinatorFolder], [true, "", "Work copy", [], [], ""]);
assert.deepEqual(copy.accounts, draft.accounts);
copy.accounts.claude.configDir = "changed";
assert.equal(draft.accounts.claude.configDir, "~/.claude-acme", "a copy doesn't share its accounts");

assert.deepEqual(moved(["a", "b", "c"], "a", 1), ["b", "a", "c"]);
assert.deepEqual(moved(["a", "b", "c"], "c", -1), ["a", "c", "b"]);
assert.deepEqual(moved(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
assert.deepEqual(moved(["a", "b", "c"], "c", 1), ["a", "b", "c"]);

assert.deepEqual(takenMachines({ work: { label: "Work", machines: ["w"] }, personal: { label: "Personal", machines: ["p", "q"] } }, "work"), { p: "Personal", q: "Personal" });

assert.deepEqual(errorLines("profiles: profiles.work.label: needed, a text\nprofiles: profiles.work.machines: home-box is also in profile personal\n", "work"),
  ["label: needed, a text", "machines: home-box is also in profile personal"]);

console.log("draft: ok");
