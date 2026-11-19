import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_SPECS, defaultsFor } from '../core/feature-config-spec.js';
import { forPage } from '../dashboard/routes/api/features/feature-config.js';
import { castCooldownMs } from '../core/fishing-manager.js';
import { COOLDOWN_MS } from '../core/fishing-data.js';
import { DEFAULT_SETTINGS } from '../core/cah-manager.js';
import cah from '../commands/fun/cah.js';
import pokemon from '../commands/games/pokemon.js';

/*
 * Games pages accuracy pass (2026-11-19): the generated Games pages must offer what the bot reads.
 *   - CAH: defaults and ranges are core/cah-manager.js and the /cah start and /cah config set options.
 *   - Pokemon: the spawn chances are stored as a fraction (0.05 = 5 %); the page shows whole percent
 *     (field `scale`), and forPage() is what the feature-config API sends the page.
 *   - Fishing: "Seconds between casts" is what core/fishing-manager.js cast() waits (it used a fixed 3 s).
 */

const field = (spec, key) => FEATURE_SPECS[spec].fields.find((f) => f.key === key);
const opt = (json, path) => path.reduce((node, name) => (node.options || []).find((o) => o.name === name), json);

test('CAH page defaults and limits match /cah and core/cah-manager.js', () => {
    const json = (cah.data || cah.default?.data).toJSON();
    const start = opt(json, ['start']);
    const pairs = [
        ['default_points', opt(start, ['points']), DEFAULT_SETTINGS.pointsToWin],
        ['default_max_rounds', opt(start, ['rounds']), DEFAULT_SETTINGS.maxRounds],
        ['default_timeout_secs', opt(start, ['timeout_seconds']), DEFAULT_SETTINGS.timeoutSeconds],
        ['max_blank_cards', opt(json, ['config', 'set', 'max_blank_cards']), 5],
    ];
    for (const [key, option, def] of pairs) {
        const f = field('cah', key);
        assert.equal(f.min, option.min_value, `${key} min`);
        assert.equal(f.max, option.max_value, `${key} max`);
        assert.equal(f.default, def, `${key} default`);
    }
});

test('Pokemon spawn chances: stored as a fraction, shown and limited as percent', () => {
    const json = (pokemon.data || pokemon.default?.data).toJSON();
    for (const [key, optName, def] of [['min_spawn_rate', 'min_rate', 0.05], ['max_spawn_rate', 'max_rate', 0.25]]) {
        const f = field('pokemon', key);
        const o = opt(json, ['spawnconfig', optName]);
        assert.equal(f.scale, 100);
        assert.equal(f.min, Math.round(o.min_value * 100), `${key} min`);
        assert.equal(f.max, Math.round(o.max_value * 100), `${key} max`);
        assert.equal(defaultsFor('pokemon')[key], def, `${key} default is in stored units`);
    }
    // DECIMAL columns arrive as strings
    const shown = forPage('pokemon', { min_spawn_rate: '0.050', max_spawn_rate: '0.070', spawn_enabled: 1, pokemon_channel_id: null });
    assert.equal(shown.min_spawn_rate, 5);
    assert.equal(shown.max_spawn_rate, 7);
    assert.equal(shown.spawn_enabled, 1);
    assert.equal(shown.pokemon_channel_id, null);
    // features without a scaled field come back untouched (same object)
    const plain = { enabled: 1, cooldown_seconds: 5 };
    assert.equal(forPage('fishing', plain), plain);
});

test('Fishing: the page setting is the wait between casts', () => {
    assert.equal(field('fishing', 'cooldown_seconds').default * 1000, COOLDOWN_MS, 'unsaved servers keep the built-in wait');
    assert.equal(castCooldownMs(null), COOLDOWN_MS);
    assert.equal(castCooldownMs(undefined), COOLDOWN_MS);
    assert.equal(castCooldownMs(5), 5000);
    assert.equal(castCooldownMs('10'), 10000);
    assert.equal(castCooldownMs(0), 800, 'never under 0.8 s');
    assert.equal(castCooldownMs(5, { cdReduce: 200 }), 4800, 'a pet takes its cut');
    assert.equal(castCooldownMs(9999), 600000, 'capped at the page maximum');
});
