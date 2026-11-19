import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dealMoney, dealsRegion } from '../commands/fun/deals.js';
import { FEATURE_SPECS } from '../core/feature-config-spec.js';

// The Game Deals page's "Price region" (2026-11-19 accuracy audit): /deals used to ask IsThereAnyDeal for
// US prices and print "$" whatever the page said.

test('prices are shown in the currency IsThereAnyDeal returns', () => {
    assert.equal(dealMoney({ amount: 19.99, currency: 'USD' }), '$19.99');
    assert.equal(dealMoney({ amount: 5, currency: 'GBP' }), '£5.00');
    assert.match(dealMoney({ amount: 1500, currency: 'JPY' }), /¥1,500/);
    assert.equal(dealMoney({ amount: 3 }), '$3.00');
    assert.equal(dealMoney({ amount: 3, currency: 'bad' }), '$3.00');
});

test('no server means US prices', async () => {
    assert.equal(await dealsRegion(null), 'US');
});

test('every region the page offers is one /deals asks for', () => {
    const offered = FEATURE_SPECS.deals.fields.find((f) => f.key === 'region').options.map((o) => o.value);
    const src = fs.readFileSync(new URL('../commands/fun/deals.js', import.meta.url), 'utf8');
    const list = JSON.parse(src.match(/const DEAL_REGIONS = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
    assert.deepEqual([...offered].sort(), [...list].sort());
    assert.doesNotMatch(src, /country=US/);
});
