import test from 'node:test';
import assert from 'node:assert/strict';
import {
    retentionDays, parseRoleIdList, rolesToSave, partitionRestorable, describeSkipped,
} from '../core/sticky-roles-logic.js';

const G = '100000000000000001';
const r = (n) => `2000000000000000${String(n).padStart(2, '0')}`;

test('retention: default 30, clamped to 1..365', () => {
    assert.equal(retentionDays(null), 30);
    assert.equal(retentionDays(''), 30);
    assert.equal(retentionDays('abc'), 30);
    assert.equal(retentionDays(0), 30);
    assert.equal(retentionDays(7), 7);
    assert.equal(retentionDays('14'), 14);
    assert.equal(retentionDays(9999), 365);
});

test('role id lists: JSON, legacy comma lists, junk', () => {
    assert.deepEqual(parseRoleIdList(JSON.stringify([r(1), r(2)])), [r(1), r(2)]);
    assert.deepEqual(parseRoleIdList(`${r(1)}, ${r(2)},${r(1)}`), [r(1), r(2)], 'de-duplicated');
    assert.deepEqual(parseRoleIdList([r(3), 'nope', 12]), [r(3)]);
    assert.deepEqual(parseRoleIdList('[broken'), []);
    assert.deepEqual(parseRoleIdList(null), []);
    assert.deepEqual(parseRoleIdList('{"a":1}'), []);
});

test('saving skips @everyone, managed roles and the exclude list — but keeps roles above the bot', () => {
    const roles = [
        { id: G, managed: false },            // @everyone
        { id: r(1), managed: false },
        { id: r(2), managed: true },          // booster / bot role
        { id: r(3), managed: false },         // excluded
        { id: r(4), managed: false },         // above the bot today — decided at restore time
    ];
    assert.deepEqual(rolesToSave(roles, G, [r(3)]), [r(1), r(4)]);
    assert.deepEqual(rolesToSave([], G, []), []);
});

test('restoring gives back only what the bot may hand out, and says why the rest was skipped', () => {
    const roles = new Map([
        [r(1), { id: r(1), managed: false, editable: true }],
        [r(2), { id: r(2), managed: true, editable: true }],
        [r(3), { id: r(3), managed: false, editable: true }],
        [r(4), { id: r(4), managed: false, editable: false }],
        [r(5), { id: r(5), managed: false, editable: true }],
    ]);
    const { restore, skipped } = partitionRestorable([r(1), r(2), r(3), r(4), r(5), r(9), G, r(1)], {
        guildId: G,
        roles,
        memberRoleIds: new Set([r(5)]),
        excludeIds: [r(3)],
    });
    assert.deepEqual(restore, [r(1)]);
    assert.deepEqual(skipped, { missing: [r(9)], managed: [r(2)], excluded: [r(3)], tooHigh: [r(4)], already: [r(5)] });
    assert.equal(describeSkipped(skipped),
        "1 above the bot's highest role, 1 on the exclude list, 1 deleted since, 1 managed by an integration");
});

test('an exclude added after someone left still applies on their return', () => {
    const roles = new Map([[r(1), { id: r(1), managed: false, editable: true }]]);
    const { restore } = partitionRestorable([r(1)], { guildId: G, roles, excludeIds: [r(1)] });
    assert.deepEqual(restore, []);
});

test('nothing skipped → empty description (no noise in the log)', () => {
    assert.equal(describeSkipped({ missing: [], managed: [], excluded: [], tooHigh: [], already: [] }), '');
});
