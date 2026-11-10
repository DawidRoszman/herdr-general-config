import assert from "node:assert/strict";
import { machineProfiles, shownProfile, spaceContext, agentContext, offContext } from "./context.js";

const profiles = {
  work: { machines: ["work-box"] },
  personal: { machines: ["home-box", "laptop"] },
  client: { machines: [] },
};
const names = Object.keys(profiles);
const coordinators = { work: "s-coord-work", personal: "s-coord-personal", gone: "s-coord-gone" };

assert.deepEqual(machineProfiles(profiles), { "work-box": "work", "home-box": "personal", laptop: "personal" });
assert.deepEqual(machineProfiles({}), {});

assert.equal(shownProfile("personal", names), "personal");
assert.equal(shownProfile("gone", names), "work", "a profile that no longer exists: the first");
assert.equal(shownProfile(null, names), "work");
assert.equal(shownProfile("work", []), null);

const space = (id) => ({ id });
assert.equal(spaceContext({ space: space("s-coord-personal"), names, coordinators, matched: "work" }), "personal");
assert.equal(spaceContext({ space: space("s1"), names, coordinators, matched: "client" }), "client");
assert.equal(spaceContext({ space: space("s2"), names, coordinators, matched: null }), null);
assert.equal(spaceContext({ space: space("s3"), names, coordinators, matched: undefined }), null);
assert.equal(spaceContext({ space: space("s-coord-gone"), names, coordinators, matched: undefined }), null, "a removed profile's coordinator is a plain space");

assert.equal(agentContext({ matched: "work", spaceProfile: "personal" }), "work");
assert.equal(agentContext({ matched: null, spaceProfile: "personal" }), "personal");
assert.equal(agentContext({ matched: undefined, spaceProfile: null }), null);

assert.deepEqual(offContext({ a: "work", b: "personal", c: null, d: "client" }, "work"), ["b", "d"]);

console.log("context: ok");
