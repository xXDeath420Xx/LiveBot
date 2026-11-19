import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeOffer, isEmptyOffer, involvesEconomy, parseOfferText, offerToText, describeOffer, toDashboardRow, MAX_CARDS,
} from '../core/trade-offer.js';

test('normalizeOffer cleans stored JSON', () => {
    assert.deepEqual(normalizeOffer('{"coins":"500","items":[{"id":3,"qty":2},{"id":3,"qty":1},{"id":-1,"qty":5}],"cards":[4,4,"x",9]}'),
        { coins: 500, items: [{ id: 3, qty: 3 }], cards: [4, 9] });
    assert.deepEqual(normalizeOffer('not json'), { coins: 0, items: [], cards: [] });
    assert.deepEqual(normalizeOffer(null), { coins: 0, items: [], cards: [] });
    assert.deepEqual(normalizeOffer({ coins: -5, items: [{ id: 2 }] }), { coins: 0, items: [{ id: 2, qty: 1 }], cards: [] });
});

test('empty / economy detection', () => {
    assert.equal(isEmptyOffer({}), true);
    assert.equal(isEmptyOffer({ cards: [1] }), false);
    assert.equal(involvesEconomy({ cards: [1] }, { cards: [2] }), false);
    assert.equal(involvesEconomy({ cards: [1] }, { coins: 10 }), true);
    assert.equal(involvesEconomy({ items: [{ id: 1, qty: 1 }] }, {}), true);
});

test('grammar: coins', () => {
    assert.deepEqual(parseOfferText('500').offer, { coins: 500, items: [], cards: [] });
    assert.deepEqual(parseOfferText('500 coins, 1.5k').offer.coins, 2000);
    assert.deepEqual(parseOfferText('1,500 coins').offer.coins, 1500);
    assert.deepEqual(parseOfferText('$250').offer.coins, 250);
    assert.deepEqual(parseOfferText('coins 75').offer.coins, 75);
    assert.deepEqual(parseOfferText('2m').offer.coins, 2_000_000);
});

test('grammar: items', () => {
    assert.deepEqual(parseOfferText('item 12').offer.items, [{ id: 12, qty: 1 }]);
    assert.deepEqual(parseOfferText('item 12 x3').offer.items, [{ id: 12, qty: 3 }]);
    assert.deepEqual(parseOfferText('#12x3').offer.items, [{ id: 12, qty: 3 }]);
    assert.deepEqual(parseOfferText('12x3').offer.items, [{ id: 12, qty: 3 }]);
    assert.deepEqual(parseOfferText('3x #12').offer.items, [{ id: 12, qty: 3 }]);
    assert.deepEqual(parseOfferText('2x item 7').offer.items, [{ id: 7, qty: 2 }]);
    assert.deepEqual(parseOfferText('item 5; item 5 x2').offer.items, [{ id: 5, qty: 3 }]);
});

test('grammar: cards, nothing, mixed, errors', () => {
    assert.deepEqual(parseOfferText('card 45, c46, card #47').offer.cards, [45, 46, 47]);
    assert.deepEqual(parseOfferText('nothing').offer, { coins: 0, items: [], cards: [] });
    assert.deepEqual(parseOfferText('').offer, { coins: 0, items: [], cards: [] });
    const mixed = parseOfferText('500 coins, item 12 x2\ncard 45');
    assert.deepEqual(mixed.offer, { coins: 500, items: [{ id: 12, qty: 2 }], cards: [45] });
    assert.equal(mixed.errors.length, 0);
    const bad = parseOfferText('my sword, 100');
    assert.equal(bad.errors.length, 1);
    assert.equal(bad.offer.coins, 100);
    const many = parseOfferText(Array.from({ length: MAX_CARDS + 1 }, (_, i) => `card ${i + 1}`).join(','));
    assert.ok(many.errors.some(e => /cards/.test(e)));
});

test('offerToText round-trips through the parser', () => {
    const offer = { coins: 1200, items: [{ id: 3, qty: 2 }, { id: 9, qty: 1 }], cards: [77] };
    const text = offerToText(offer);
    assert.equal(text, '1200 coins, item 3 x2, item 9, card 77');
    assert.deepEqual(parseOfferText(text).offer, normalizeOffer(offer));
    assert.equal(offerToText({}), 'nothing');
    assert.deepEqual(parseOfferText(offerToText({})).offer, { coins: 0, items: [], cards: [] });
});

test('describeOffer uses names when known', () => {
    const lines = describeOffer({ coins: 10, items: [{ id: 3, qty: 2 }], cards: [5, 6] }, {
        items: new Map([[3, { name: 'Sword', emoji: '⚔️' }]]),
        cards: new Map([[5, { name: 'Iron Warrior', rarity: 'rare', power: 70 }]]),
        money: n => `${n} gold`,
    });
    assert.deepEqual(lines, ['10 gold', '2x ⚔️ Sword (ID 3)', '🃏 Iron Warrior — rare, power 70 (Card #5)', '🃏 Card #6']);
});

test('toDashboardRow matches trading.ejs', () => {
    const row = toDashboardRow({
        id: 7, initiator_id: '1', recipient_id: '2', status: 'pending', awaiting_id: '2',
        initiator_offer: '{"coins":50,"items":[{"id":3,"qty":2}]}', recipient_offer: '{"cards":[9]}',
        created_at: 'c', updated_at: 'u', completed_at: null, expires_at: 'e',
    });
    assert.deepEqual(row, {
        trade_id: 7, initiator_id: '1', partner_id: '2',
        initiator_items: ['2x Item #3'], initiator_currency: 50,
        partner_items: ['Card #9'], partner_currency: 0,
        status: 'pending', awaiting_id: '2', created_at: 'c', updated_at: 'u', completed_at: null, expires_at: 'e',
    });
});
