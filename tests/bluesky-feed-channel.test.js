import test from "node:test";
import assert from "node:assert/strict";
import { resolveChannel } from "../core/bluesky-feed.js";

// A Bluesky feed posts only to a channel of its own server (the add routes take the channel id from
// the form, and the poster used to fetch it from the whole client).
function fakeClient(channels) {
    const map = new Map(channels.map((c) => [c.id, c]));
    return { channels: { cache: map, fetch: async (id) => { if (!map.has(id)) throw new Error("Unknown Channel"); return map.get(id); } } };
}

test("a channel of the feed server is used", async () => {
    const client = fakeClient([{ id: "100000000000000010", guildId: "1", type: 0, isTextBased: () => true }]);
    assert.equal((await resolveChannel(client, "100000000000000010", "1"))?.id, "100000000000000010");
});

test("a channel of another server is refused", async () => {
    const client = fakeClient([{ id: "100000000000000020", guildId: "2", type: 0, isTextBased: () => true }]);
    assert.equal(await resolveChannel(client, "100000000000000020", "1"), null);
});

test("an unknown channel gives null", async () => {
    const client = fakeClient([]);
    assert.equal(await resolveChannel(client, "100000000000000030", "1"), null);
});
