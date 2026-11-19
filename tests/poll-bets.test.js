import test from 'node:test';
import assert from 'node:assert/strict';
import { pickWinner, settleBets, betError, HOUSE_RAKE } from '../core/poll-bet-math.js';

test('pickWinner: single leader, ties and no votes', () => {
    assert.equal(pickWinner([3, 5, 1]), 1);
    assert.equal(pickWinner([5, 5, 1]), null);
    assert.equal(pickWinner([0, 0]), null);
    assert.equal(pickWinner([]), null);
});

test('no winner refunds every stake', () => {
    const r = settleBets([{ id: 1, option_index: 0, bet_amount: 100 }, { id: 2, option_index: 1, bet_amount: 40 }], null);
    assert.equal(r.refunded, true);
    assert.deepEqual(r.outcomes.get(1), { status: 'refunded', payout: 100 });
    assert.deepEqual(r.outcomes.get(2), { status: 'refunded', payout: 40 });
    assert.equal(r.totalPaid, 140);
    assert.equal(r.houseProfit, 0);
});

test('nobody backed the winner: all lost to the house', () => {
    const r = settleBets([{ id: 1, option_index: 0, bet_amount: 100 }], 2);
    assert.deepEqual(r.outcomes.get(1), { status: 'lost', payout: 0 });
    assert.equal(r.houseProfit, 100);
});

test('winners split the pot pro rata after the rake; payouts never exceed the pot', () => {
    const bets = [
        { id: 'a', option_index: 0, bet_amount: 300 },
        { id: 'b', option_index: 0, bet_amount: 100 },
        { id: 'c', option_index: 1, bet_amount: 600 },
    ];
    const r = settleBets(bets, 0);
    const pool = 1000 - Math.floor(1000 * HOUSE_RAKE); // 950
    assert.deepEqual(r.outcomes.get('a'), { status: 'won', payout: Math.floor(pool * 0.75) });
    assert.deepEqual(r.outcomes.get('b'), { status: 'won', payout: Math.floor(pool * 0.25) });
    assert.deepEqual(r.outcomes.get('c'), { status: 'lost', payout: 0 });
    assert.ok(r.totalPaid <= pool);
    assert.equal(r.totalPaid + r.houseProfit, r.totalWagered);
});

test('a lone winner on a one-sided poll loses only the rake', () => {
    const r = settleBets([{ id: 1, option_index: 0, bet_amount: 1000 }], 0);
    assert.equal(r.outcomes.get(1).payout, 950);
});

test('betError validation', () => {
    const base = { optionCount: 3, minBet: 10, maxBet: 100 };
    assert.equal(betError({ ...base, optionIndex: 0, amount: 10 }), null);
    assert.match(betError({ ...base, optionIndex: 3, amount: 10 }), /between 1 and 3/);
    assert.match(betError({ ...base, optionIndex: -1, amount: 10 }), /between 1 and 3/);
    assert.match(betError({ ...base, optionIndex: 1, amount: 9 }), /between 10 and 100/);
    assert.match(betError({ ...base, optionIndex: 1, amount: 101 }), /between 10 and 100/);
    assert.match(betError({ ...base, optionIndex: 1, amount: 0 }), /whole number/);
});
