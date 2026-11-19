// Greenhouse Tycoon (cfx v2), phase 4: the economy with quests, Replant and decorations (sim/economy.js
// options meta, replant, decorate). The phase 2 bands (economy-sim.test.js) run with these options off and
// must not move; these tests check what the phase 4 additions do on top.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../../../services/cfx/sim/economy.js';
import { SOLD_DECORATIONS, replantBonus } from '../../../services/cfx/domain/meta.js';
import { SEASON_TIERS } from '../../../services/cfx/config/catalog.js';
import { REPLANT, SEASON } from '../../../services/cfx/config/game.js';

const run = (profile, days, opts = {}) => simulate({ profile, strategy: 'balanced', days, seed: 1, ...opts }).summary;
const META = { meta: true, decorate: true };

describe('phase 4 options leave the phase 2 economy alone', () => {
    test('with every option off the simulation is exactly the phase 2 one', () => {
        for (const p of ['casual', 'regular', 'heavy', 'idle']) {
            const a = simulate({ profile: p, strategy: 'balanced', days: 30, seed: 1 });
            const b = simulate({ profile: p, strategy: 'balanced', days: 30, seed: 1, meta: false, replant: null, decorate: false });
            assert.equal(JSON.stringify(a.summary), JSON.stringify(b.summary), p);
            assert.equal(a.summary.prestige, 0);
            assert.equal(a.summary.questIncome, 0);
        }
    });

    test('quests add a little, mostly early: at most 25 % at 30 days and 10 % at 90 days', () => {
        for (const p of ['casual', 'regular', 'heavy']) {
            for (const [days, cap] of [[30, 1.25], [90, 1.10]]) {
                const base = run(p, days).totalIncome;
                const meta = run(p, days, META).totalIncome;
                assert.ok(meta >= base, `${p} ${days}: quests never cost income`);
                assert.ok(meta <= base * cap, `${p} ${days}: ${meta} vs ${base}`);
            }
        }
        assert.equal(run('idle', 30, META).totalIncome, run('idle', 30).totalIncome, 'an idle player finishes no quests');
    });
});

describe('Replant', () => {
    test('a heavy player who replants when the tree is done replants every month or so, each cycle no slower', () => {
        const s = run('heavy', 180, { ...META, replant: { atLevel: REPLANT.MIN_LEVEL, whenTreeDone: true } });
        assert.ok(s.prestige >= 3, `replants: ${s.prestige}`);
        const days = s.replants.map(r => r.day);
        const cycles = days.map((d, i) => d - (i ? days[i - 1] : 0));
        for (let i = 1; i < cycles.length; i++) assert.ok(cycles[i] <= cycles[0] + 0.5, `cycle ${i + 1} (${cycles[i].toFixed(1)} d) is not slower than the first (${cycles[0].toFixed(1)} d)`);
        for (const r of s.replants) assert.ok(r.level >= REPLANT.MIN_LEVEL);
    });

    test('replanting resets the economy: no inflation over half a year, but not a ruin either', () => {
        const base = run('heavy', 180, META).totalIncome;
        const rp = run('heavy', 180, { ...META, replant: { atLevel: REPLANT.MIN_LEVEL, whenTreeDone: true } }).totalIncome;
        assert.ok(rp < base, 'a replanting player earns less cash than one who keeps the tree');
        assert.ok(rp > base * 0.5, `but keeps most of it: ${(rp / base).toFixed(2)}`);
        const reg = run('regular', 180, META).totalIncome;
        const regRp = run('regular', 180, { ...META, replant: { atLevel: REPLANT.MIN_LEVEL, whenTreeDone: true } }).totalIncome;
        assert.ok(regRp > reg * 0.75 && regRp <= reg, `regular: ${(regRp / reg).toFixed(2)}`);
    });

    test('the bonus makes later cycles faster when replanting at the minimum level', () => {
        const s = run('heavy', 90, { ...META, replant: { atLevel: REPLANT.MIN_LEVEL } });
        assert.ok(s.prestige >= 3);
        const d = s.replants.map(r => r.day);
        assert.ok(d[2] - d[1] < d[0], 'the third climb to level 25 is faster than the first');
        assert.deepEqual(replantBonus(s.prestige), replantBonus(Math.min(s.prestige, REPLANT.MAX_COUNTED)));
    });

    test('casual and regular players do not reach Replant in their first month', () => {
        for (const p of ['casual', 'regular']) assert.equal(run(p, 30, { ...META, replant: { atLevel: REPLANT.MIN_LEVEL } }).prestige, 0, p);
    });
});

describe('decorations and season rewards', () => {
    test('decorations are the sink after the upgrade tree: heavy players buy them all in months, not days', () => {
        const s = run('heavy', 180, META);
        assert.ok(s.treeDoneDay != null && s.treeDoneDay > 20, `tree done on day ${s.treeDoneDay}`);
        assert.equal(s.decorations, SOLD_DECORATIONS.length);
        assert.equal(s.decorSpend, SOLD_DECORATIONS.reduce((a, d) => a + d.price, 0));
        assert.ok(s.allDecorDay - s.treeDoneDay >= 60, `all bought ${(s.allDecorDay - s.treeDoneDay).toFixed(0)} days after the tree`);
        const h90 = run('heavy', 90, META);
        assert.ok(h90.decorations >= 3 && h90.decorations < SOLD_DECORATIONS.length, `90 days: ${h90.decorations}`);
        assert.equal(run('regular', 30, META).decorations, 0, 'regular players are still on the tree at day 30');
    });

    test('season cash rewards are small next to the economy (badges carry the weight)', () => {
        const casual30 = run('casual', SEASON.LENGTH_DAYS).totalIncome;
        const heavy30 = run('heavy', SEASON.LENGTH_DAYS).totalIncome;
        const top = Math.max(...SEASON_TIERS.map(t => t.cash));
        const least = Math.min(...SEASON_TIERS.map(t => t.cash));
        assert.ok(top <= heavy30 * 0.02, `champion ${top} vs heavy month ${heavy30}`);
        assert.ok(least <= casual30 * 0.025, `participation ${least} vs casual month ${casual30}`);
    });
});
