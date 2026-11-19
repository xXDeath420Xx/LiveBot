import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIniFiles, parseIni, IniError } from '../src/inifiles.js';

const stoppedDocker = { state: async () => ({ running: false }) };

const DEFAULT_INI = `; ============================================================
; WindrosePlus Server Configuration
; ============================================================
;
; All values shown are game defaults.
; ============================================================

[Server]
; Server network and admin settings

; WindrosePlus HTTP API port
http_port = 8780
; Game port (auto-detected if blank)
game_port =

; Enable RCON remote console
rcon_enabled = false

[Combat]
; Damage tuning
; Base melee damage
melee_damage = 1.5
`;

async function fixture() {
    const serverFiles = await mkdtemp(path.join(tmpdir(), 'wr-ini-'));
    await mkdir(path.join(serverFiles, 'config'), { recursive: true });
    await writeFile(path.join(serverFiles, 'config', 'windrose_plus.default.ini'), DEFAULT_INI);
    return serverFiles;
}

test('parses sections, keys, types and the preceding comment as description', () => {
    const secs = parseIni(DEFAULT_INI);
    assert.deepEqual(secs.map((s) => s.name), ['Server', 'Combat']);

    const httpPort = secs[0].keys.find((k) => k.key === 'http_port');
    assert.equal(httpPort.value, '8780');
    assert.equal(httpPort.type, 'int');
    // The comment line above a key is its documentation — the only thing that
    // makes 2,461 opaque identifiers navigable.
    assert.equal(httpPort.description, 'WindrosePlus HTTP API port');

    assert.equal(secs[0].keys.find((k) => k.key === 'rcon_enabled').type, 'bool');
    assert.equal(secs[0].keys.find((k) => k.key === 'game_port').type, 'empty');
    assert.equal(secs[1].keys.find((k) => k.key === 'melee_damage').type, 'float');
});

test('banner rules are not treated as documentation', () => {
    const secs = parseIni('; ============\n; Real doc\n[S]\n; ====\n; Key doc\nk = 1\n');
    assert.equal(secs[0].keys[0].description, 'Key doc');
});

test('describe merges defaults with current overrides', async () => {
    const root = await fixture();
    const ini = createIniFiles({ serverFiles: root, docker: stoppedDocker });

    let d = await ini.describe('general');
    let k = d.sections[1].keys[0];
    assert.equal(k.value, '1.5');
    assert.equal(k.overridden, false);

    await ini.setOverrides('general', { 'Combat.melee_damage': '3.0' });

    d = await ini.describe('general');
    k = d.sections[1].keys[0];
    assert.equal(k.value, '3.0');
    assert.equal(k.default, '1.5', 'the default must still be visible');
    assert.equal(k.overridden, true);
});

test('writes ONLY changed keys, never the whole file', async () => {
    // The rule that matters: writing all 2,461 keys would pin today's defaults
    // forever and silently defeat future game balance patches.
    const root = await fixture();
    const ini = createIniFiles({ serverFiles: root, docker: stoppedDocker });

    await ini.setOverrides('general', { 'Combat.melee_damage': '3.0' });
    const written = await readFile(path.join(root, 'windrose_plus.ini'), 'utf8');

    assert.match(written, /\[Combat\]/);
    assert.match(written, /melee_damage = 3\.0/);
    assert.equal(written.includes('http_port'), false, 'untouched keys must not be written');
    assert.equal(written.includes('rcon_enabled'), false);
});

test('setting a value back to its default clears the override', async () => {
    const root = await fixture();
    const ini = createIniFiles({ serverFiles: root, docker: stoppedDocker });

    await ini.setOverrides('general', { 'Combat.melee_damage': '3.0', 'Server.rcon_enabled': 'true' });
    let out = await ini.setOverrides('general', { 'Combat.melee_damage': '1.5' });

    assert.deepEqual(out.cleared, ['Combat.melee_damage']);
    const written = await readFile(path.join(root, 'windrose_plus.ini'), 'utf8');
    assert.equal(written.includes('melee_damage'), false);
    assert.match(written, /rcon_enabled = true/, 'other overrides survive');
});

test('clearing the last override removes the file rather than leaving it empty', async () => {
    const root = await fixture();
    const ini = createIniFiles({ serverFiles: root, docker: stoppedDocker });
    const target = path.join(root, 'windrose_plus.ini');

    await ini.setOverrides('general', { 'Combat.melee_damage': '3.0' });
    await stat(target); // exists
    await ini.setOverrides('general', { 'Combat.melee_damage': '1.5' });

    await assert.rejects(stat(target), 'on-disk state should match "stock"');
});

test('rejects unknown keys and INI-corrupting values', async () => {
    const root = await fixture();
    const ini = createIniFiles({ serverFiles: root, docker: stoppedDocker });

    await assert.rejects(ini.setOverrides('general', { 'Combat.not_real': '1' }), /unknown setting/);
    await assert.rejects(ini.setOverrides('general', { 'Combat.melee_damage': 'a\nb = c' }), /corrupt the INI/);
    await assert.rejects(ini.setOverrides('general', { 'Combat.melee_damage': '[Evil]' }), /corrupt the INI/);
    await assert.rejects(ini.describe('nope'), IniError);
});

test('search matches key names, sections and descriptions', async () => {
    const root = await fixture();
    const ini = createIniFiles({ serverFiles: root, docker: stoppedDocker });

    const byKey = await ini.search('melee');
    assert.equal(byKey.hits.length, 1);
    assert.equal(byKey.hits[0].key, 'melee_damage');

    // Descriptions are searchable, which is how you find something without
    // already knowing its identifier.
    const byDesc = await ini.search('remote console');
    assert.equal(byDesc.hits[0].key, 'rcon_enabled');

    await assert.rejects(ini.search('x'), /at least 2 characters/);
});

test('reset removes every override for a file', async () => {
    const root = await fixture();
    const ini = createIniFiles({ serverFiles: root, docker: stoppedDocker });

    await ini.setOverrides('general', { 'Combat.melee_damage': '3.0' });
    await ini.resetFile('general');

    const d = await ini.describe('general');
    assert.equal(d.sections[1].keys[0].overridden, false);
    assert.equal(d.sections[1].keys[0].value, '1.5');
});

test('summary counts keys and overrides per file', async () => {
    const root = await fixture();
    const ini = createIniFiles({ serverFiles: root, docker: stoppedDocker });
    await ini.setOverrides('general', { 'Combat.melee_damage': '3.0' });

    const s = await ini.summary();
    const general = s.files.find((f) => f.name === 'general');
    assert.equal(general.keyCount, 4);
    assert.equal(general.sectionCount, 2);
    assert.equal(general.overrideCount, 1);
    // Missing optional files are reported as empty, not fatal.
    assert.equal(s.files.find((f) => f.name === 'weapons').keyCount, 0);
});
