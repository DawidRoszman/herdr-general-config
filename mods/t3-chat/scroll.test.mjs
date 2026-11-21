import assert from "node:assert/strict";
import { layout, maxTop, settle, wheel, resized, visibleRange, thumb, dragged, trackPressed } from "./scroll.js";

const heights = [100, 100, 100, 100, 100];
const content = layout(heights);
assert.deepEqual(content, { tops: [0, 100, 200, 300, 400], total: 500 });
assert.equal(maxTop(content, 200), 300);
assert.equal(maxTop(layout([50]), 200), 0);

assert.deepEqual(settle({ top: 0, follow: "end" }, content, 200), { top: 300, follow: "end" });
assert.deepEqual(settle({ top: 300, follow: "end" }, layout([...heights, 80]), 200), { top: 380, follow: "end" });

const read = wheel({ top: 300, follow: "end" }, 120, content, 200);
assert.deepEqual(read, { top: 180, follow: "free" });
assert.deepEqual(settle(read, layout([...heights, 500]), 200), { top: 180, follow: "free" });

assert.equal(wheel({ top: 300, follow: "end" }, 1, content, 200).follow, "free");

assert.deepEqual(wheel(read, -50, content, 200), { top: 230, follow: "free" });
assert.deepEqual(wheel(read, -500, content, 200), { top: 300, follow: "end" });

assert.equal(wheel({ top: 0, follow: "end" }, 30, layout([50]), 200).follow, "end");

assert.deepEqual(settle({ top: 280, follow: "free" }, layout([100, 100]), 150), { top: 50, follow: "free" });

assert.deepEqual(resized({ top: 180, follow: "free" }, 100, 40), { top: 220, follow: "free" });
assert.deepEqual(resized({ top: 180, follow: "free" }, 300, 40), { top: 180, follow: "free" });
assert.deepEqual(resized({ top: 300, follow: "end" }, 100, 40), { top: 300, follow: "end" });

assert.deepEqual(settle({ top: 300, follow: "anchor" }, content, 200, 4), { top: 400, follow: "anchor" });
assert.equal(maxTop(content, 200, 4), 400);
assert.deepEqual(settle({ top: 400, follow: "anchor" }, layout([...heights, 90]), 200, 4), { top: 400, follow: "anchor" });
assert.deepEqual(settle({ top: 400, follow: "anchor" }, layout([...heights, 90, 90]), 200, 4), { top: 480, follow: "end" });

assert.equal(wheel({ top: 400, follow: "anchor" }, 50, content, 200).follow, "free");

assert.deepEqual(visibleRange(content, heights, 180, 150, 0), { first: 1, end: 4 });
assert.deepEqual(visibleRange(content, heights, 0, 150, 400), { first: 0, end: 5 });
assert.deepEqual(visibleRange(layout([]), [], 0, 150), { first: 0, end: 0 });

assert.equal(thumb(0, 150, 200), null);
assert.deepEqual(thumb(300, 500, 200), { size: 80, offset: 120 });
assert.equal(thumb(0, 100000, 200).size, 24);
assert.deepEqual(dragged(300, -60, 500, 200), { top: 150, follow: "free" });
assert.deepEqual(dragged(150, 500, 500, 200), { top: 300, follow: "end" });
assert.deepEqual(dragged(150, -500, 500, 200), { top: 0, follow: "free" });
assert.deepEqual(trackPressed(100, 500, 200), { top: 150, follow: "free" });
assert.deepEqual(trackPressed(190, 500, 200), { top: 300, follow: "end" });

console.log("scroll.js ok");
