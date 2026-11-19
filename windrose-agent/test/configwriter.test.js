import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConfigWriter, validateMultipliers, ConfigError } from '../src/configwriter.js';

const stoppedDocker = { state: async () => ({ running: false, exists: true }) };
const runningDocker = { state: async () => ({ running: true, exists: true }) };

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'wr-cfg-'));
    await mkdir(path.join(root, 'R5'), { recursive: true });
    await writeFile(path.join(root, 'windrose_plus.json'), JSON.stringify({ multipliers: {}, rcon: { enabled: true } }));
    await writeFile(path.join(root, 'R5', 'ServerDescription.json'), JSON.stringify({
        ServerDescription_Persistent: { WorldIslandId: 'WORLD1' },
    }));
    await mkdir(path.join(root, 'R5/Saved/SaveProfiles/Default/RocksDB_v2/0.10.0/Worlds/WORLD1'), { recursive: true });
    return root;
}


async function seedWorldDescription(root) {
    const dir = path.join(root, 'R5/Saved/SaveProfiles/Default/RocksDB_v2/0.10.0/Worlds/WORLD1');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'WorldDescription.json'), JSON.stringify({
        Version: 1,
        WorldDescription: {
            islandId: 'WORLD1',
            WorldName: '',
            CreationTime: 6.3921827727379e+17,
            WorldPresetType: 'Medium',
            WorldSettings: {
                BoolParameters: { '{"TagName": "WDS.Parameter.Coop.SharedQuests"}': true },
                FloatParameters: { '{"TagName": "WDS.Parameter.MobHealthMultiplier"}': 1 },
                TagParameters: {},
            },
        },
    }));
}

test('rejects multipliers that are no-ops upstream', async () => {
    // These parse fine and do nothing; upstream disabled them because they can
    // corrupt or crash character saves. Accepting them would mislead the user.
    for (const key of ['stack_size', 'weight', 'inventory_size', 'crop_speed', 'points_per_level']) {
        assert.throws(() => validateMultipliers({ [key]: 2 }), ConfigError, `${key} should be rejected`);
    }
});

test('rejects out-of-range multipliers rather than clamping', () => {
    assert.throws(() => validateMultipliers({ loot: 999 }), /between/);
    assert.throws(() => validateMultipliers({ loot: 0 }), /between/);
});

test('treats craft_cost as the legacy alias for craft_efficiency', () => {
    const { values } = validateMultipliers({ craft_cost: 2 });
    assert.deepEqual(values, { craft_efficiency: 2 });
});

test('refuses to lower a ratcheted xp multiplier', () => {
    // Upstream refuses this because a shrunken reward curve can lock existing
    // characters out at next login.
    assert.throws(() => validateMultipliers({ xp: 2 }, { xp: 3 }), /ratcheted/);
});

test('warns that raising xp is one-way', () => {
    const { warnings } = validateMultipliers({ xp: 3 }, { xp: 1 });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ONE-WAY/);
});

test('refuses to write multipliers while the server is running', async () => {
    const root = await fixture();
    const cw = createConfigWriter({ serverFiles: root, docker: runningDocker });
    await assert.rejects(cw.setMultipliers({ loot: 2 }), /while the server is running/);
});

test('writes multipliers when stopped and reports the restart requirement', async () => {
    const root = await fixture();
    const cw = createConfigWriter({ serverFiles: root, docker: stoppedDocker });
    const out = await cw.setMultipliers({ loot: 2, xp: 3 });

    assert.deepEqual(out.multipliers, { loot: 2, xp: 3 });
    assert.match(out.note, /next start/);

    const onDisk = JSON.parse(await readFile(path.join(root, 'windrose_plus.json'), 'utf8'));
    assert.deepEqual(onDisk.multipliers, { loot: 2, xp: 3 });
    assert.equal(onDisk.rcon.enabled, true, 'must not clobber the rcon block');
});

test('world settings validate ranges and reject unknown keys', async () => {
    const root = await fixture();
    await seedWorldDescription(root);
    const cw = createConfigWriter({ serverFiles: root, docker: stoppedDocker });

    await assert.rejects(cw.setWorldSettings({ 'WDS.Parameter.ShipsDamageMultiplier': 4.0 }), /between 0.2 and 2.5/);
    await assert.rejects(cw.setWorldSettings({ 'WDS.Parameter.CombatDifficulty': 'Nightmare' }), /must be one of/);
    await assert.rejects(cw.setWorldSettings({ 'WDS.Parameter.Nonsense': 1 }), /unknown world setting/);
});

test('world settings are written in the game\'s real nested tag-key format', async () => {
    // The layout is undocumented and unobvious: nested under WorldDescription,
    // split into Bool/Float/Tag maps, keyed by a JSON object serialised into a
    // string WITH a space after the colon. A flat structure is silently ignored.
    const root = await fixture();
    await seedWorldDescription(root);
    const cw = createConfigWriter({ serverFiles: root, docker: stoppedDocker });

    const out = await cw.setWorldSettings({
        'WDS.Parameter.MobHealthMultiplier': 1.5,
        'WDS.Parameter.EasyExplore': true,
        'WDS.Parameter.CombatDifficulty': 'Hard',
    });
    assert.equal(out.presetType, 'Custom');

    const onDisk = JSON.parse(await readFile(out.path, 'utf8'));
    const ws = onDisk.WorldDescription.WorldSettings;

    assert.equal(ws.FloatParameters['{"TagName": "WDS.Parameter.MobHealthMultiplier"}'], 1.5);
    assert.equal(ws.BoolParameters['{"TagName": "WDS.Parameter.EasyExplore"}'], true);
    // Tag values append the choice to the tag path.
    assert.deepEqual(ws.TagParameters['{"TagName": "WDS.Parameter.CombatDifficulty"}'],
        { TagName: 'WDS.Parameter.CombatDifficulty.Hard' });

    assert.equal(onDisk.WorldDescription.WorldPresetType, 'Custom');
    // Fields the game owns must survive untouched.
    assert.equal(onDisk.WorldDescription.islandId, 'WORLD1');
    assert.equal(onDisk.WorldDescription.CreationTime, 6.3921827727379e+17);
    assert.equal(onDisk.Version, 1);
    // Pre-existing parameters we did not touch must be preserved.
    assert.equal(ws.BoolParameters['{"TagName": "WDS.Parameter.Coop.SharedQuests"}'], true);
});

test('refuses to edit world settings when the game has not written the file yet', async () => {
    const root = await fixture();
    const cw = createConfigWriter({ serverFiles: root, docker: stoppedDocker });
    await assert.rejects(cw.setWorldSettings({ 'WDS.Parameter.EasyExplore': true }), /written by the game/);
});

test('rcon changes do not require a stopped server', async () => {
    const root = await fixture();
    const cw = createConfigWriter({ serverFiles: root, docker: runningDocker });
    const out = await cw.setRcon({ enabled: false });
    assert.equal(out.rcon.enabled, false);
    assert.match(out.note, /no restart/);
});

test('never returns the rcon password', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'windrose_plus.json'), JSON.stringify({
        multipliers: {}, rcon: { enabled: true, password: 'super-secret' },
    }));
    const cw = createConfigWriter({ serverFiles: root, docker: stoppedDocker });
    const all = await cw.readAll();
    assert.equal(JSON.stringify(all).includes('super-secret'), false);
});
