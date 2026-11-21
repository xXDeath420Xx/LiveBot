// Throne price lookup rewrite (core/throne-price-logic.js): the query shape and insert-on-change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LATEST_PRICES_SQL, lastPriceMap, detectPriceChanges, pricesToRecord } from '../core/throne-price-logic.js';

test('the lookup takes one parameter and never uses the row-constructor IN form that scanned the whole history', () => {
    assert.equal((LATEST_PRICES_SQL.match(/\?/g) || []).length, 1);
    assert.doesNotMatch(LATEST_PRICES_SQL, /\(item_id,\s*recorded_at\)\s*IN/i);
    assert.doesNotMatch(LATEST_PRICES_SQL, /GROUP BY/i);
    assert.match(LATEST_PRICES_SQL, /FROM throne_seen_items si\s+WHERE si\.throne_username = \?/);
    assert.match(LATEST_PRICES_SQL, /ORDER BY p\.recorded_at DESC, p\.id DESC LIMIT 1/);
});

test('items with no recorded price are left out of the map', () => {
    const m = lastPriceMap([{ item_id: 'a', price_raw: 1500 }, { item_id: 'b', price_raw: null }, { item_id: 7, price_raw: 0 }]);
    assert.deepEqual([...m], [['a', 1500], ['7', 0]]);
});

test('a change is reported only against a known previous price', () => {
    const last = new Map([['a', 1000], ['b', 2000]]);
    const items = [
        { id: 'a', name: 'Lamp', priceRaw: 1500 },
        { id: 'b', name: 'Desk', priceRaw: 2000 },
        { id: 'c', name: 'New', priceRaw: 900 },
    ];
    const changes = detectPriceChanges(items, last);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].id, 'a');
    assert.equal(changes[0].oldPrice, 1000);
    assert.equal(changes[0].changePct, 50);
    assert.equal(changes[0].direction, 'up');
});

test('a drop is reported as down, and a previous price of 0 does not divide by zero', () => {
    const changes = detectPriceChanges([{ id: 'a', priceRaw: 500 }, { id: 'z', priceRaw: 300 }], new Map([['a', 1000], ['z', 0]]));
    assert.equal(changes[0].direction, 'down');
    assert.equal(changes[0].changePct, 50);
    assert.equal(changes[1].changePct, 100);
});

test('only new and changed prices get a history row', () => {
    const last = new Map([['a', 1000], ['b', 2000]]);
    const rows = pricesToRecord([
        { id: 'a', priceRaw: 1000 },     // unchanged: no row
        { id: 'b', priceRaw: 2100 },     // changed
        { id: 'c', priceRaw: 50 },       // never priced
        { id: 'd', priceRaw: NaN },      // unparseable: never written
    ], last);
    assert.deepEqual(rows.map(r => r.id), ['b', 'c']);
});

test('an unchanged wishlist writes nothing', () => {
    const items = [{ id: 'a', priceRaw: 1 }, { id: 'b', priceRaw: 2 }];
    assert.deepEqual(pricesToRecord(items, new Map([['a', 1], ['b', 2]])), []);
});
