import test from 'node:test';
import assert from 'node:assert/strict';

// Auto purge "Daily at HH:MM" is in the server's time zone (Core settings stores an IANA name).
const { guildLocalTime } = await import('../jobs/purge-scheduler.js');

const at = new Date('2026-11-19T13:30:00Z');

test('IANA zones give the local time, daylight saving included', () => {
    assert.equal(guildLocalTime('Australia/Adelaide', at), '00:00');          // UTC+10:30 in November
    assert.equal(guildLocalTime('America/Los_Angeles', at), '05:30');         // PST
    assert.equal(guildLocalTime('America/New_York', new Date('2026-07-01T04:00:00Z')), '00:00'); // EDT
    assert.equal(guildLocalTime('Etc/GMT+12', at), '01:30');
});

test('UTC offsets, UTC, empty and unknown zones', () => {
    assert.equal(guildLocalTime('UTC+5:30', at), '19:00');
    assert.equal(guildLocalTime('UTC-7', at), '06:30');
    assert.equal(guildLocalTime('UTC', at), '13:30');
    assert.equal(guildLocalTime(null, at), '13:30');
    assert.equal(guildLocalTime('Not/AZone', at), '13:30');
});
