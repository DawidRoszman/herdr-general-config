import assert from "node:assert/strict";
import { parentOf } from "./path.js";

assert.equal(parentOf("/home/dev/work"), "/home/dev");
assert.equal(parentOf("/home/dev/work/"), "/home/dev");
assert.equal(parentOf("/home"), "/");
assert.equal(parentOf("/"), null);
assert.equal(parentOf("C:\\Users\\me"), "C:\\Users");
assert.equal(parentOf("C:\\Users"), "C:\\");
assert.equal(parentOf("C:\\"), null);
console.log("path.js ok");
