import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * Workshop watcher selection: nothing from before the watcher existed, each item announced once as
 * new and once per real update, a publish is not mistaken for an update, and a burst is capped at
 * one message (10 embeds) with the rest summarised.
 */
const {
    selectWorkshopNotifications, workshopHash, cleanWorkshopText, formatFileSize,
    MAX_EMBEDS_PER_CHECK, MAX_UPDATES_PER_CHECK, UPDATE_GRACE_SECONDS,
} = await import('../core/steam-workshop-utils.js');

const SINCE = 1_800_000_000;
const item = (id, created, updated = created) => ({ publishedfileid: String(id), title: `Mod ${id}`, time_created: created, time_updated: updated });

test('items published before the watcher existed are ignored', () => {
    const r = selectWorkshopNotifications({ newest: [item(1, SINCE - 10), item(2, SINCE + 10)], sinceSec: SINCE });
    assert.deepEqual(r.fresh.map(f => f.item.publishedfileid), ['2']);
});

test('already-notified items are skipped', () => {
    const it = item(2, SINCE + 10);
    const r = selectWorkshopNotifications({ newest: [it], sinceSec: SINCE, seen: new Set([workshopHash('new', it)]) });
    assert.equal(r.fresh.length, 0);
});

test('a publish is not an update; a later change is, once per time_updated', () => {
    const justPublished = item(3, SINCE + 100, SINCE + 100 + UPDATE_GRACE_SECONDS - 1);
    const oldButUpdated = item(4, SINCE - 9999, SINCE + 500);
    const r = selectWorkshopNotifications({ updated: [justPublished, oldButUpdated], sinceSec: SINCE });
    assert.deepEqual(r.updates.map(u => u.item.publishedfileid), ['4']);

    const seen = new Set([workshopHash('upd', oldButUpdated)]);
    assert.equal(selectWorkshopNotifications({ updated: [oldButUpdated], sinceSec: SINCE, seen }).updates.length, 0);
    const updatedAgain = { ...oldButUpdated, time_updated: SINCE + 9000 };
    assert.equal(selectWorkshopNotifications({ updated: [updatedAgain], sinceSec: SINCE, seen }).updates.length, 1);
});

test('an item new this round is not also announced as updated', () => {
    const it = item(5, SINCE + 10, SINCE + 10 + UPDATE_GRACE_SECONDS * 2);
    const r = selectWorkshopNotifications({ newest: [it], updated: [it], sinceSec: SINCE });
    assert.equal(r.fresh.length, 1);
    assert.equal(r.updates.length, 0);
});

test('bursts are capped: new items first, updates fill the rest, overflow summarised', () => {
    const newest = Array.from({ length: 14 }, (_, i) => item(100 + i, SINCE + 1000 - i));
    const updated = Array.from({ length: 8 }, (_, i) => item(200 + i, SINCE - 5000, SINCE + 2000 - i));
    const r = selectWorkshopNotifications({ newest, updated, sinceSec: SINCE });
    assert.equal(r.fresh.length, MAX_EMBEDS_PER_CHECK);
    assert.equal(r.updates.length, 0);
    assert.equal(r.skipped.length, 4 + 8);
    // newest kept, chronological order
    assert.equal(r.fresh.at(-1).item.publishedfileid, '100');
    assert.ok(r.fresh[0].item.time_created <= r.fresh.at(-1).item.time_created);

    const few = selectWorkshopNotifications({ newest: newest.slice(0, 3), updated, sinceSec: SINCE });
    assert.equal(few.fresh.length, 3);
    assert.equal(few.updates.length, MAX_UPDATES_PER_CHECK);
    assert.equal(few.skipped.length, 8 - MAX_UPDATES_PER_CHECK);
    assert.ok(few.fresh.length + few.updates.length <= MAX_EMBEDS_PER_CHECK);
});

test('BBCode is stripped and text bounded', () => {
    const s = cleanWorkshopText('[h1]Hello[/h1] [b]bold[/b] [url=https://x.y]link[/url] [img]a.png[/img]\n\n\n\nmore', 200);
    assert.equal(s, 'Hello bold link \n\nmore');
    assert.equal(cleanWorkshopText('a'.repeat(500), 50).length, 50);
});

test('file sizes', () => {
    assert.equal(formatFileSize(739411), '722 KB');
    assert.equal(formatFileSize(119444427), '114 MB');
    assert.equal(formatFileSize(1536), '1.5 KB');
    assert.equal(formatFileSize(0), null);
    assert.equal(formatFileSize('x'), null);
});
