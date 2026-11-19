/**
 * Pure rules behind emoji hunts, loyalty points and community goals.
 * Dependency-free: `node --test tests/bgames-logic.test.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as hunt from '../core/emoji-hunt-logic.js';
import * as loyalty from '../core/loyalty-logic.js';
import * as goals from '../core/community-goal-logic.js';

// ── Emoji hunt ──────────────────────────────────────────────────────────────────────────────

test('parseEmoji accepts unicode and custom emoji, rejects text', () => {
    assert.deepEqual(hunt.parseEmoji('🥚'), { kind: 'unicode', value: '🥚' });
    assert.equal(hunt.parseEmoji('❤️').kind, 'unicode');
    assert.equal(hunt.parseEmoji('👍🏽').kind, 'unicode');
    assert.equal(hunt.parseEmoji('👨‍👩‍👧').kind, 'unicode');
    assert.equal(hunt.parseEmoji('1️⃣').kind, 'unicode');
    assert.equal(hunt.parseEmoji('🇺🇸').kind, 'unicode');
    const c = hunt.parseEmoji('<:pumpkin:123456789012345678>');
    assert.deepEqual(c, { kind: 'custom', value: '<:pumpkin:123456789012345678>', id: '123456789012345678', name: 'pumpkin', animated: false });
    assert.equal(hunt.parseEmoji('<a:spin:123456789012345678>').animated, true);
    for (const bad of ['', 'egg', '123', ':egg:', '<:x:1>', 'a🥚', '🥚 🥚', null]) {
        assert.equal(hunt.parseEmoji(bad), null, `rejects ${bad}`);
    }
});

test('emojiMatches compares custom by id and unicode ignoring variation selectors', () => {
    assert.ok(hunt.emojiMatches('❤️', { id: null, name: '❤' }));
    assert.ok(hunt.emojiMatches('❤', { id: null, name: '❤️' }));
    assert.ok(!hunt.emojiMatches('🥚', { id: null, name: '🐣' }));
    assert.ok(hunt.emojiMatches('<:egg:123456789012345678>', { id: '123456789012345678', name: 'renamed' }));
    assert.ok(!hunt.emojiMatches('<:egg:123456789012345678>', { id: null, name: 'egg' }));
    assert.ok(!hunt.emojiMatches('🥚', { id: '123456789012345678', name: '🥚' }));
    assert.equal(hunt.reactArg('<:egg:123456789012345678>'), '123456789012345678');
    assert.equal(hunt.reactArg('🥚'), '🥚');
});

test('scheduleSpots spreads spots across the first three quarters of the hunt', () => {
    const start = 1_000_000;
    const dur = 60 * 60_000;
    for (const r of [() => 0, () => 0.999, Math.random]) {
        const spots = hunt.scheduleSpots(6, start, dur, r);
        assert.equal(spots.length, 6);
        assert.deepEqual(spots.map(s => s.i), [0, 1, 2, 3, 4, 5]);
        for (const s of spots) {
            assert.ok(s.at >= start && s.at <= start + dur * 0.75, 'inside the window');
            assert.equal(s.placed, null);
            assert.deepEqual(s.claims, []);
        }
        for (let i = 1; i < spots.length; i++) assert.ok(spots[i].at >= spots[i - 1].at, 'ascending');
        assert.ok(spots[0].at - start <= 60_000, 'first spot within a minute');
    }
});

test('pickMessage skips bots, system messages, stale, used and already-reacted messages', () => {
    const now = 10_000_000;
    const c = [
        { id: 'a', bot: true, createdAt: now },
        { id: 'b', bot: false, system: true, createdAt: now },
        { id: 'c', bot: false, createdAt: now - 3 * 3_600_000 },
        { id: 'd', bot: false, createdAt: now, hasTarget: true },
        { id: 'e', bot: false, createdAt: now },
        { id: 'f', bot: false, createdAt: now - 1000 },
    ];
    const pick = hunt.pickMessage(c, new Set(['f']), now, 3_600_000, () => 0);
    assert.equal(pick.id, 'e');
    assert.equal(hunt.pickMessage(c, new Set(['e', 'f']), now, 3_600_000), null);
});

test('claimSpot: first finders win, no double claims, unplaced spots cannot be claimed', () => {
    let spots = hunt.scheduleSpots(2, 0, 600_000, () => 0);
    assert.equal(hunt.claimSpot(spots, 0, 'u1', 5).reason, 'not_placed');
    spots = spots.map(s => (s.i === 0 ? { ...s, placed: 1000, ch: 'c', msg: 'm' } : s));

    const r1 = hunt.claimSpot(spots, 0, 'u1', 4000, 2);
    assert.ok(r1.ok);
    assert.equal(r1.findMs, 3000);
    assert.equal(r1.fullyClaimed, false);
    assert.equal(spots[0].claims.length, 0, 'input not mutated');

    assert.equal(hunt.claimSpot(r1.spots, 0, 'u1', 5000, 2).reason, 'already_claimed');
    const r2 = hunt.claimSpot(r1.spots, 0, 'u2', 6000, 2);
    assert.ok(r2.ok && r2.fullyClaimed);
    assert.equal(hunt.claimSpot(r2.spots, 0, 'u3', 7000, 2).reason, 'full');

    const sum = hunt.summarise(r2.spots, 2);
    assert.deepEqual(sum, { total: 2, placed: 1, found: 1, claims: 2, gone: 0, waiting: 1, hidden: 0 });
    assert.equal(hunt.isComplete(r2.spots, 2), false);
    const done = r2.spots.map(s => (s.i === 1 ? { ...s, gone: true } : s));
    assert.equal(hunt.isComplete(done, 2), true);
});

test('hunt standings rank by finds, then fastest find', () => {
    const spots = [
        { i: 0, placed: 0, claims: [{ u: 'a', t: 5000 }, { u: 'b', t: 1000 }] },
        { i: 1, placed: 0, claims: [{ u: 'a', t: 9000 }] },
        { i: 2, placed: 0, claims: [{ u: 'c', t: 500 }] },
    ];
    const st = hunt.standings(spots);
    assert.deepEqual(st.map(s => s.userId), ['a', 'c', 'b']);
    assert.equal(st[0].finds, 2);
    assert.equal(st[0].fastestMs, 5000);
    assert.equal(hunt.dueSpots([{ placed: null, gone: false, at: 5 }, { placed: 1, at: 1 }], 10).length, 1);
    assert.equal(hunt.formatDuration(850), '850ms');
    assert.equal(hunt.formatDuration(65_000), '1m 05s');
});

// ── Loyalty ─────────────────────────────────────────────────────────────────────────────────

test('dayBefore crosses month and year boundaries', () => {
    assert.equal(loyalty.dayBefore('2026-03-01'), '2026-02-28');
    assert.equal(loyalty.dayBefore('2024-03-01'), '2024-02-29');
    assert.equal(loyalty.dayBefore('2026-01-01'), '2025-12-31');
});

test('computeDailyAward: active day, voice points and streak bonus', () => {
    const s = loyalty.LOYALTY_DEFAULTS;
    const first = loyalty.computeDailyAward({ messages: 5, voiceMinutes: 0, date: '2026-10-04', lastActiveDate: null, currentStreak: 0 }, s);
    assert.deepEqual(first, { active: true, points: 10, streak: 1, parts: { daily: 10, voice: 0, streak: 0 } });

    const cont = loyalty.computeDailyAward({ messages: 5, voiceMinutes: 45, date: '2026-10-05', lastActiveDate: '2026-10-04', currentStreak: 1 }, s);
    assert.equal(cont.streak, 2);
    assert.deepEqual(cont.parts, { daily: 10, voice: 4, streak: 2 });
    assert.equal(cont.points, 16);

    const broken = loyalty.computeDailyAward({ messages: 5, voiceMinutes: 0, date: '2026-10-05', lastActiveDate: '2026-10-02', currentStreak: 9 }, s);
    assert.equal(broken.streak, 1);
    assert.equal(broken.parts.streak, 0);

    const capped = loyalty.computeDailyAward({ messages: 50, voiceMinutes: 2000, date: '2026-10-05', lastActiveDate: '2026-10-04', currentStreak: 40 }, s);
    assert.equal(capped.parts.voice, 30);
    assert.equal(capped.parts.streak, 20);

    const quiet = loyalty.computeDailyAward({ messages: 1, voiceMinutes: 12, date: '2026-10-05', lastActiveDate: '2026-10-04', currentStreak: 3 }, s);
    assert.equal(quiet.active, false);
    assert.equal(quiet.streak, 3, 'an inactive day leaves the stored streak alone');
    assert.equal(quiet.points, 1, 'voice minutes still earn their points');

    const voiceOnly = loyalty.computeDailyAward({ messages: 0, voiceMinutes: 20, date: '2026-10-05', lastActiveDate: null, currentStreak: 0 }, s);
    assert.equal(voiceOnly.active, true);
    assert.equal(voiceOnly.points, 12);
});

test('liveStreak hides a streak that has lapsed', () => {
    assert.equal(loyalty.liveStreak(5, '2026-10-04', '2026-10-05'), 5);
    assert.equal(loyalty.liveStreak(5, '2026-10-05', '2026-10-05'), 5);
    assert.equal(loyalty.liveStreak(5, '2026-10-01', '2026-10-05'), 0);
    assert.equal(loyalty.liveStreak(0, null, '2026-10-05'), 0);
});

// ── Community goals ─────────────────────────────────────────────────────────────────────────

test('goal maths: percent, milestones, outcome, progress', () => {
    assert.equal(goals.percent(50, 200), 25);
    assert.equal(goals.percent(500, 200), 100);
    assert.equal(goals.percent(5, 0), 0);
    assert.equal(goals.newMilestone(0, 60, 100), 50);
    assert.equal(goals.newMilestone(50, 60, 100), null);
    assert.equal(goals.newMilestone(50, 99, 100), 75);
    assert.equal(goals.newMilestone(75, 100, 100), null, '100% is completion, not a milestone');
    assert.equal(goals.outcome({ current: 10, target: 10, endsAtMs: 5, nowMs: 10 }), 'completed');
    assert.equal(goals.outcome({ current: 9, target: 10, endsAtMs: 5, nowMs: 10 }), 'failed');
    assert.equal(goals.outcome({ current: 9, target: 10, endsAtMs: null, nowMs: 10 }), 'active');
    assert.equal(goals.progressFrom('messages', 1500, 300), 1200);
    assert.equal(goals.progressFrom('messages', 100, 300), 0);
    assert.equal(goals.progressFrom('members', 480, 470), 480);
    assert.ok(goals.progressBar(1, 4).endsWith('25%'));
});

test('parseReward keeps only sane values', () => {
    assert.deepEqual(goals.parseReward('{"coins":500,"xp":"20","role_id":"123456789012345678"}'), { coins: 500, xp: 20, role_id: '123456789012345678' });
    assert.deepEqual(goals.parseReward('nope'), { coins: 0, xp: 0, role_id: null });
    assert.deepEqual(goals.parseReward({ coins: -5, role_id: 'x' }), { coins: 0, xp: 0, role_id: null });
    assert.equal(goals.hasReward(goals.parseReward(null)), false);
    assert.equal(goals.hasReward({ coins: 1, xp: 0, role_id: null }), true);
});
