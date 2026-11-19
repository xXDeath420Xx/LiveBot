import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Escalation rules (core/escalation-manager.js, register H-658): what counts towards "N infractions within
 * H hours", and the DM the member gets.
 *   - only warnings, timeouts, kicks and bans count; not Unmute / Unban, the ClearInfractions marker, or the
 *     raid / self-bot / spam detector rows
 *   - nothing before the member's last ClearInfractions row counts (clearinfractions wipes, then writes it)
 *   - the rows escalation itself records are the punishment, not another offence
 *   - the DM goes through the Moderation page's messages (on/off switch and wording), not its own embed
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-'));
process.env.LOG_DIR ||= tmp;
const { countTowardEscalation, ESCALATION_COUNTED_TYPES } = await import('../core/escalation-manager.js');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const HOUR = 3600_000;
let nextId = 1;
const row = (type, hoursAgo, reason = 'test') => ({ id: nextId++, type, reason, created_at: new Date(NOW - hoursAgo * HOUR) });

test('only warnings, timeouts, kicks and bans count', () => {
    assert.deepEqual([...ESCALATION_COUNTED_TYPES].sort(), ['Ban', 'Kick', 'Mute', 'Warn']);
    const rows = [
        row('Warn', 1), row('Mute', 1), row('Unmute', 1), row('Unban', 1),
        row('RaidDetection', 1), row('SelfbotDetection', 1), row('AdaptiveSpam', 1), row('AntiSpam', 1),
        row('Kick', 1),
    ];
    assert.equal(countTowardEscalation(rows, NOW - 24 * HOUR), 3);
});

test('nothing before the last clear counts, and the clear row itself is not an infraction', () => {
    // clearinfractions deletes the history, then records ClearInfractions; the next warning is the first again.
    const rows = [row('ClearInfractions', 2), row('Warn', 1)];
    assert.equal(countTowardEscalation(rows, NOW - 24 * HOUR), 1);
    // Rows that survived (or came back from a restore) before the clear are left out too.
    const older = [row('Warn', 5), row('Warn', 4), row('ClearInfractions', 3), row('Warn', 1)];
    assert.equal(countTowardEscalation(older, NOW - 24 * HOUR), 1);
    // Two clears: only the last one matters.
    const twice = [row('ClearInfractions', 6), row('Warn', 5), row('ClearInfractions', 4), row('Warn', 1), row('Mute', 0.5)];
    assert.equal(countTowardEscalation(twice, NOW - 24 * HOUR), 2);
});

test('the rows escalation records are not counted again', () => {
    const rows = [row('Warn', 3), row('Warn', 2), row('Warn', 1.5), row('Mute', 1.5, 'Automatic action: 3 infractions in 24 hours.'), row('Warn', 1)];
    // 4 warnings; the escalation timeout between them does not make it 5.
    assert.equal(countTowardEscalation(rows, NOW - 24 * HOUR), 4);
});

test('only the rule window counts', () => {
    const rows = [row('Warn', 30), row('Warn', 10), row('Warn', 1)];
    assert.equal(countTowardEscalation(rows, NOW - 24 * HOUR), 2);
    assert.equal(countTowardEscalation(rows, NOW - 48 * HOUR), 3);
    assert.equal(countTowardEscalation([], NOW), 0);
    assert.equal(countTowardEscalation(undefined, NOW), 0);
});

test('the escalation DM goes through the Moderation page messages', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'core', 'escalation-manager.js'), 'utf8');
    assert.match(src, /sendModerationDm\(guild, user, ESCALATION_DM_ACTION\[infractionType\]/);
    assert.doesNotMatch(src, /user\.send\(/, 'no DM of its own that ignores the switches');
    // The count comes from countTowardEscalation, not a COUNT(*) over every row type.
    assert.doesNotMatch(src, /SELECT COUNT\(\*\) as count FROM infractions/);
});
