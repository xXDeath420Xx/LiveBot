import test from "node:test";
import assert from "node:assert/strict";

const { _test } = await import("../core/twitch-analytics-cron.js");
const { confirmUnfollows } = _test;

// Fake axios: ids in `still` are still following; ids in `boom` make the lookup fail.
const fake = (still, boom = []) => ({
    get: async (_url, { params }) => {
        if (boom.includes(params.user_id)) throw new Error("timeout");
        return { data: { data: still.includes(params.user_id) ? [{ user_id: params.user_id }] : [] } };
    },
});

test("an id that dropped out of the paged list but still follows is not an unfollow", async () => {
    const current = new Map();
    const removed = await confirmUnfollows(fake(["2"]), {}, "b", ["1", "2", "3"], current);
    assert.deepEqual(removed, ["1", "3"]);
    assert.ok(current.has("2"), "kept in the snapshot");
});

test("a failed lookup is never reported as an unfollow", async () => {
    const current = new Map();
    const removed = await confirmUnfollows(fake([], ["9"]), {}, "b", ["9"], current);
    assert.deepEqual(removed, []);
    assert.ok(current.has("9"), "re-checked next hour");
});
