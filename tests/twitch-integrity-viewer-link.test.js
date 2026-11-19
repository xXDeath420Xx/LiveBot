import test from 'node:test';
import assert from 'node:assert/strict';
import { assessViewerLink, linkedMoves, linkStretches, pearson, viewerDips } from '../core/twitch-integrity-viewer-link.js';

const session = { startM: 0, endM: 400, open: false };

// Steady block in chat, it leaves at minute 100 and returns at minute 120, viewers following.
const blockTrack = (shift = 0) => Array.from({ length: 300 }, (_, m) => {
    const gone = m >= 100 + shift && m < 120 + shift;
    return { m, viewers: gone ? 9 : 120, listed: gone ? 1 : 100, other: 32 };
});

test('pearson is null when a side never changes', () => {
    assert.equal(pearson([1, 2, 3], [5, 5, 5]), null);
    assert.equal(Math.round(pearson([1, 2, 3], [2, 4, 6]) * 100) / 100, 1);
});

test('a block leaving and returning with the viewers meets the indicator', () => {
    const out = assessViewerLink(blockTrack(), [session]);
    assert.equal(out.met, true);
    assert.deepEqual(out.moves.map(x => x.direction), ['left', 'arrived']);
    assert.equal(out.moves[0].viewersFrom, 120);
    assert.equal(out.moves[0].viewersTo, 9);
});

test('accounts leaving while viewers hold is not a move: they were never counted', () => {
    const track = blockTrack().map(p => ({ ...p, viewers: 120 }));
    assert.deepEqual(linkedMoves(track, [session]), []);
    assert.equal(assessViewerLink(track, [session]).met, false);
});

test('everyone leaving chat at once is not a move: that is an outage or a raid out', () => {
    const track = blockTrack().map(p => (p.listed === 1 ? { ...p, other: 2 } : p));
    assert.deepEqual(linkedMoves(track, [session]), []);
});

test('moves in the first 30 minutes of a stream do not count', () => {
    assert.deepEqual(linkedMoves(blockTrack(-85), [session]).filter(x => x.m < 30), []);
});

test('moves near the end of a closed stream do not count', () => {
    assert.deepEqual(linkedMoves(blockTrack(), [{ startM: 0, endM: 105, open: false }]).filter(x => x.direction === 'left'), []);
});

test('a channel with no listed accounts is assessed and not met', () => {
    const track = Array.from({ length: 200 }, (_, m) => ({ m, viewers: 50 + m % 7, listed: 0, other: 40 }));
    const out = assessViewerLink(track, [session]);
    assert.equal(out.assessed, true);
    assert.equal(out.met, false);
    assert.equal(out.rListed, null);
});

test('too few minutes is not assessed', () => {
    assert.equal(assessViewerLink(blockTrack().slice(0, 60), [session]).met, null);
});

test('stretches split on long gaps and report the most common listed count', () => {
    const track = [...Array.from({ length: 10 }, (_, m) => ({ m, viewers: 70, listed: 49, other: 33 })),
                   ...Array.from({ length: 5 }, (_, i) => ({ m: 1000 + i, viewers: 120, listed: 100, other: 30 }))];
    const out = linkStretches(track);
    assert.deepEqual(out.map(s => [s.minutes, s.commonListed, s.commonMinutes]), [[10, 49, 10], [5, 100, 5]]);
});

test('a viewer dip must hold and come back', () => {
    const series = Array.from({ length: 120 }, (_, m) => ({ m, v: m >= 60 && m < 65 ? 8 : 116 }));
    const out = viewerDips(series, [session]);
    assert.equal(out.length, 1);
    assert.deepEqual([out[0].from, out[0].low, out[0].backTo], [116, 8, 116]);
});

test('a one-minute null reading is not a dip', () => {
    const series = Array.from({ length: 120 }, (_, m) => ({ m, v: m === 60 ? 0 : 116 }));
    assert.deepEqual(viewerDips(series, [session]), []);
});

test('a fall that never returns is not a dip', () => {
    const series = Array.from({ length: 120 }, (_, m) => ({ m, v: m >= 60 ? 8 : 116 }));
    assert.deepEqual(viewerDips(series, [session]), []);
});
