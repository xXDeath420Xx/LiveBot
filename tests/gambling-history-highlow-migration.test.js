import test from 'node:test';
import assert from 'node:assert/strict';
import { up } from '../migrations/257_gambling_history_highlow.js';

/*
 * Migration 257 must only ever widen gambling_history.game_type: add 'highlow' (the value
 * /economy gamble highlow logs), keep every value already allowed, and do nothing on a re-run.
 */

function fakeDb(columnType) {
    const statements = [];
    return {
        statements,
        async execute(sql) {
            statements.push(sql);
            if (/information_schema\.COLUMNS/.test(sql)) {
                return [columnType === null ? [] : [{ type: columnType }]];
            }
            return [{ affectedRows: 0 }];
        }
    };
}

test('adds highlow to the live enum and keeps every existing value', async () => {
    const db = fakeDb("enum('coinflip','dice','slots','blackjack','roulette','crash')");
    await up(db);
    const alter = db.statements.find(s => s.startsWith('ALTER TABLE'));
    assert.ok(alter, 'expected an ALTER TABLE');
    for (const v of ['coinflip', 'dice', 'slots', 'blackjack', 'roulette', 'crash', 'highlow']) {
        assert.ok(alter.includes(`'${v}'`), `missing ${v}`);
    }
    assert.match(alter, /NOT NULL$/);
});

test('never narrows: values unknown to the migration survive', async () => {
    const db = fakeDb("enum('coinflip','dice','slots','blackjack','roulette','crash','poker')");
    await up(db);
    const alter = db.statements.find(s => s.startsWith('ALTER TABLE'));
    assert.ok(alter.includes("'poker'"));
    assert.ok(alter.includes("'highlow'"));
});

test('idempotent: no ALTER when highlow is already allowed or the table is absent', async () => {
    const done = fakeDb("enum('coinflip','dice','slots','blackjack','roulette','crash','highlow')");
    await up(done);
    assert.equal(done.statements.filter(s => s.startsWith('ALTER')).length, 0);

    const missing = fakeDb(null);
    await up(missing);
    assert.equal(missing.statements.filter(s => s.startsWith('ALTER')).length, 0);
});
