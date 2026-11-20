import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SCHEMA, TABLES, LEGACY_WEAPON_TYPE, LEGACY_TIER, buildSpeciesMap, mapGemCode, parseWeaponStat,
    REFRESH_TABLES, ACTIVITY_COLUMNS, parseCliArgs,
} from '../migrations/463_critters_schema.js';

test('refresh empties every player-state / per-guild table but never critter_meta', () => {
    assert.ok(TABLES.includes('meta'));
    assert.ok(!REFRESH_TABLES.includes('meta'));
    assert.equal(REFRESH_TABLES.length, TABLES.length - 1);
});

test('every go-live activity column exists in the schema as a time column', () => {
    for (const [t, c] of ACTIVITY_COLUMNS) {
        assert.ok(SCHEMA[t], t);
        assert.match(SCHEMA[t], new RegExp(`\\b${c} (DATETIME|TIMESTAMP)`), `${t}.${c}`);
    }
    for (const t of ['cooldowns', 'wallet', 'ledger', 'owned', 'weapons']) assert.ok(ACTIVITY_COLUMNS.some(([x]) => x === t), `${t} watched`);
});

test('direct-entry flags parse', () => {
    assert.deepEqual(parseCliArgs([]), { refresh: false, check: false, help: false, srcPrefix: '', dstPrefix: '', catalogPrefix: undefined, unknown: [] });
    const a = parseCliArgs(['--refresh', '--src-prefix=t_', '--dst-prefix=t_', '--catalog-prefix=']);
    assert.equal(a.refresh, true);
    assert.equal(a.srcPrefix, 't_');
    assert.equal(a.catalogPrefix, '');
    assert.equal(parseCliArgs(['--check']).check, true);
    assert.deepEqual(parseCliArgs(['--force']).unknown, ['--force']);
});
import { speciesByKey, speciesInTier } from '../core/critters/data/species.js';
import { gemById } from '../core/critters/data/gems.js';
import { weaponTypeById } from '../core/critters/data/weapons.js';
import { PRIVACY_DELETE_PLAN, PRIVACY_ANONYMISE_PLAN, PER_USER_TABLES } from '../core/critters/privacy.js';

/*
 * Migration 463's pure mapping rules and schema coverage (no database), plus the privacy table list.
 */

test('every critter table is created and named critter_*', () => {
    assert.ok(TABLES.length >= 30);
    for (const t of TABLES) assert.match(t, /^[a-z_]+$/);
    assert.ok(!TABLES.some(t => t.startsWith('owo')));
});

test('species map: same-tier mapping, deterministic, injective while the tier fits, unknown tiers flagged', () => {
    const tierOf = new Map([['a1', 'common'], ['a2', 'common'], ['a3', 'common'], ['b1', 'rare'], ['h1', 'hidden'], ['s1', 'special']]);
    const keys = ['a3', 'a1', 'a2', 'b1', 'h1', 's1', 'zz'];
    const m1 = buildSpeciesMap(keys, tierOf);
    const m2 = buildSpeciesMap([...keys].reverse(), tierOf);
    for (const k of keys) assert.equal(m1.get(k).key, m2.get(k).key, `deterministic ${k}`);
    const commons = ['a1', 'a2', 'a3'].map(k => m1.get(k).key);
    assert.equal(new Set(commons).size, 3, 'distinct within a tier');
    for (const k of commons) assert.equal(speciesByKey(k).tier, 'common');
    assert.equal(speciesByKey(m1.get('b1').key).tier, 'rare');
    assert.equal(speciesByKey(m1.get('h1').key).tier, 'fabled');
    assert.equal(speciesByKey(m1.get('s1').key).tier, 'epic');
    assert.equal(m1.get('zz').unknownTier, true);
    // With the catalog, the mapping does not depend on which species players own.
    const catalog = new Map([['common', [':a1:', ':a2:', ':a3:', ':a0:']]]);
    const withCat = buildSpeciesMap(['a2'], new Map([['a2', 'common']]), catalog);
    assert.equal(withCat.get('a2').key, speciesInTier('common')[2].key, 'a0 a1 a2 a3 -> a2 is index 2');
});

test('legacy conditional tiers fold into real tiers', () => {
    for (const [legacy, tier] of Object.entries(LEGACY_TIER)) assert.ok(speciesInTier(tier).length, `${legacy} -> ${tier}`);
});

test('gem codes map by tier letter and type, with an optional type text', () => {
    assert.deepEqual(mapGemCode('cgem1'), { gemId: 11, type: 'trail', tier: 1 });
    assert.deepEqual(mapGemCode('fgem4'), { gemId: 37, type: 'clover', tier: 7 });
    assert.equal(mapGemCode('egem3').gemId, 24);
    assert.equal(mapGemCode('lgem2').gemId, null, 'non-lootable type skipped');
    assert.equal(mapGemCode('xgem1').gemId, null);
    assert.equal(mapGemCode('ugem9', 'Lucky').gemId, 32, 'type text wins over the digit');
    for (const l of 'curemlf') for (const d of [1, 3, 4]) assert.ok(gemById(mapGemCode(`${l}gem${d}`).gemId));
});

test('weapon stat parsing and type mapping cover every legacy id', () => {
    assert.deepEqual(parseWeaponStat('Mythical 53 1').rank.id, 5);
    assert.equal(parseWeaponStat('Mythical 53 1').quality, 53);
    assert.equal(parseWeaponStat('Fabled 99 4').wear, 4);
    assert.equal(parseWeaponStat('junk').rank, null);
    for (let wid = 1; wid <= 22; wid++) assert.ok(weaponTypeById(LEGACY_WEAPON_TYPE[wid]), `wid ${wid}`);
});

test('privacy: every critter table holding a member id is in the delete or anonymise plan', () => {
    const memberCols = /\b(user_id|user1|user2|sender|receiver|last_winner)\b/;
    const planned = new Set([...PRIVACY_DELETE_PLAN, ...PRIVACY_ANONYMISE_PLAN].map(p => `${p.table}.${p.column}`));
    for (const [name, ddl] of Object.entries(SCHEMA)) {
        const cols = [...ddl.matchAll(/\b(user_id|user1|user2|sender|receiver|last_winner)\b\s+VARCHAR/g)].map(m => m[1]);
        if (/^\s*user_id VARCHAR|\buser_id VARCHAR/.test(ddl) && !cols.includes('user_id')) cols.push('user_id');
        for (const c of new Set(cols)) {
            if (name === 'duels' && c === 'sender') continue; // always one of user1 / user2, whose rows are deleted
            assert.ok(planned.has(`critter_${name}.${c}`), `critter_${name}.${c}`);
        }
        if (!memberCols.test(ddl)) assert.ok(!PER_USER_TABLES.includes(`critter_${name}`), `${name} has no member column`);
    }
    for (const p of PRIVACY_ANONYMISE_PLAN) assert.ok(new RegExp(`\\b${p.column} VARCHAR\\(20\\) NULL`).test(SCHEMA[p.table.replace('critter_', '')]), `${p.table}.${p.column} must be nullable`);
});
