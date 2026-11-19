'use strict';
/*
 * OBS setup (0.2.4; overlays 0.2.5 in obs-overlays.test.js): docks written into a COPY of an OBS config (fixture folders only, never the real OBS profile),
 * the CertiFried theme files and their install, and starter scenes against the mock obs-websocket server.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { iniGet, iniSet, locateDockConfig, readDocks, planDocks, addDocks, isObsRunning, findProfileIni, backupProfileIni } = require('../src/main/obs-docks');
const { THEME_FILES, validateTheme, installTheme, themeInstalled, planStarterScenes, createStarterScenes } = require('../src/main/obs-setup');
const { startMockObs } = require('./mock-obs');
const { createObs } = require('../src/main/obs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-obs-'));
const THEME_SRC = path.join(__dirname, '..', 'assets', 'obs-theme');
const DOCKS = [
    { title: 'CertiFried Activity', url: 'https://certifriedmultitool.com/stream/bot/dock/activity?key=sbk_x' },
    { title: 'CertiFried Controls', url: 'https://certifriedmultitool.com/stream/bot/dock/controls?key=sbk_x' },
    { title: 'CertiFried Chat', url: 'https://certifriedmultitool.com/stream/bot/dock/chat?key=sbk_x' },
];
// What OBS 31 writes, shortened; the person already has one dock of their own and an old CertiFried one.
const USER_INI = '[General]\r\nPretty=1\r\n\r\n[BasicWindow]\r\nDockState=AAAA\r\nExtraBrowserDocks=[{"title":"Their dock","url":"https://example.com/x","uuid":"{1111}"},{"title":"Old","url":"https://certifriedmultitool.com/stream/bot/dock/chat?key=sbk_old","uuid":"{2222}"}]\r\nSnappingEnabled=true\r\n\r\n[Audio]\r\nSampleRate=48000\r\n';

test('ini helpers keep everything else byte for byte (CRLF, BOM, other keys)', () => {
    assert.equal(iniGet(USER_INI, 'BasicWindow', 'SnappingEnabled'), 'true');
    assert.equal(iniGet(USER_INI, 'Audio', 'Nope'), null);
    const out = iniSet(USER_INI, 'BasicWindow', 'ExtraBrowserDocks', '[]');
    assert.equal(out, USER_INI.replace(/ExtraBrowserDocks=[^\r]*/, 'ExtraBrowserDocks=[]'));
    const added = iniSet('﻿[General]\nA=1\n', 'BasicWindow', 'ExtraBrowserDocks', '[1]');
    assert.equal(added, '﻿[General]\nA=1\n\n[BasicWindow]\nExtraBrowserDocks=[1]\n');
    const inSection = iniSet('[BasicWindow]\nA=1\n\n[Audio]\nB=2\n', 'BasicWindow', 'ExtraBrowserDocks', 'x');
    assert.equal(inSection, '[BasicWindow]\nA=1\nExtraBrowserDocks=x\n\n[Audio]\nB=2\n');
});

test('finds user.ini (OBS 31+), a moved config folder, or global.ini (OBS 30)', () => {
    const d31 = tmp();
    fs.writeFileSync(path.join(d31, 'global.ini'), '[General]\n');
    fs.writeFileSync(path.join(d31, 'user.ini'), USER_INI);
    assert.deepEqual(locateDockConfig(d31), { file: path.join(d31, 'user.ini'), kind: 'user.ini' });
    const moved = tmp();
    const elsewhere = tmp();
    fs.mkdirSync(path.join(elsewhere, 'obs-studio'));
    fs.writeFileSync(path.join(elsewhere, 'obs-studio', 'user.ini'), USER_INI);
    fs.writeFileSync(path.join(moved, 'global.ini'), `[Locations]\nConfiguration=${elsewhere}\n`);
    assert.equal(locateDockConfig(moved).file, path.join(elsewhere, 'obs-studio', 'user.ini'));
    const d30 = tmp();
    fs.writeFileSync(path.join(d30, 'global.ini'), '[BasicWindow]\nDockState=x\n');
    assert.deepEqual(locateDockConfig(d30), { file: path.join(d30, 'global.ini'), kind: 'global.ini' });
    assert.throws(() => locateDockConfig(tmp()), { code: 'not_found' });
});

test('docks: OBS running → refused and untouched; closed → backup, keep theirs, replace ours, valid JSON', () => {
    const dir = tmp();
    const file = path.join(dir, 'user.ini');
    fs.writeFileSync(file, USER_INI);
    assert.throws(() => addDocks({ dir, docks: DOCKS, running: true }), { code: 'obs_running' });
    assert.equal(fs.readFileSync(file, 'utf8'), USER_INI, 'not touched while OBS runs');
    assert.equal(fs.readdirSync(dir).length, 1, 'no backup either');
    const r = addDocks({ dir, docks: DOCKS, running: false, now: Date.parse('2026-11-19T13:00:00Z') });
    assert.deepEqual([r.kind, r.added, r.kept, r.replaced], ['user.ini', 3, 1, 1]);
    assert.equal(fs.readFileSync(path.join(dir, path.basename(r.backup)), 'utf8'), USER_INI, 'backup is the old file');
    const docks = readDocks(file);
    assert.deepEqual(docks.map((d) => d.title), ['Their dock', 'CertiFried Activity', 'CertiFried Controls', 'CertiFried Chat']);
    for (const d of docks.slice(1)) assert.match(d.uuid, /^\{[0-9a-f-]{36}\}$/);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('\r\nSnappingEnabled=true\r\n') && text.includes('[Audio]\r\nSampleRate=48000'), 'everything else kept');
    // a second run replaces again rather than piling up, with its own backup
    const r2 = addDocks({ dir, docks: DOCKS, running: false, now: Date.parse('2026-11-19T13:00:05Z') });
    assert.equal(readDocks(file).length, 4);
    assert.notEqual(r2.backup, r.backup);
    assert.throws(() => addDocks({ dir, docks: [{ title: 'x', url: 'https://evil.example/y' }], running: false }), { code: 'bad_params' });
    const bad = tmp();
    fs.writeFileSync(path.join(bad, 'user.ini'), '[BasicWindow]\nExtraBrowserDocks=[not json\n');
    assert.throws(() => addDocks({ dir: bad, docks: DOCKS, running: false }), { code: 'bad_format' });
    assert.equal(planDocks([], DOCKS).added, 3);
});

test('running OBS is detected from the process list; if the list cannot be read, it counts as running', () => {
    assert.equal(isObsRunning({ execFileSync: () => '"explorer.exe","1"\r\n"obs64.exe","4242","Console"\r\n' }), true);
    assert.equal(isObsRunning({ execFileSync: () => '"explorer.exe","1"\r\n"obs-browser-page.exe","2"\r\n' }), false);
    assert.equal(isObsRunning({ execFileSync: () => { throw new Error('no tasklist'); } }), true);
});

test('profile basic.ini found by its Name (folder names differ) and backed up', () => {
    const dir = tmp();
    for (const [folder, name] of [['Untitled', 'Default'], ['Gaming_2', 'Gaming']]) {
        fs.mkdirSync(path.join(dir, 'basic', 'profiles', folder), { recursive: true });
        fs.writeFileSync(path.join(dir, 'basic', 'profiles', folder, 'basic.ini'), `[General]\nName=${name}\n`);
    }
    assert.equal(findProfileIni(dir, 'Gaming'), path.join(dir, 'basic', 'profiles', 'Gaming_2', 'basic.ini'));
    assert.equal(findProfileIni(dir, 'Nope'), null);
    const b = backupProfileIni({ dir, profileName: 'Default', now: Date.parse('2026-11-19T13:00:00Z') });
    assert.match(b, /^basic\.ini\.certifried-backup-\d{8}-\d{6}$/);
    assert.equal(backupProfileIni({ dir, profileName: 'Nope' }), null);
});

test('theme: three valid OBS 30.2+ variant files; install copies, keeps a changed older copy, never switches', () => {
    const ids = {};
    for (const f of THEME_FILES) {
        const v = validateTheme(fs.readFileSync(path.join(THEME_SRC, f), 'utf8'));
        assert.ok(v.ok, `${f}: ${v.error}`);
        ids[v.id] = v;
    }
    assert.equal(ids['com.certifried.studio.Dark'].extends, 'com.obsproject.Yami');
    assert.equal(ids['com.certifried.studio.Light'].extends, 'com.obsproject.Yami.Light');
    assert.equal(ids['com.certifried.studio.Sand'].extends, 'com.certifried.studio.Light', 'a variant of our own variant');
    assert.equal(ids['com.certifried.studio.Dark'].dark, true);
    assert.equal(validateTheme('@OBSThemeMeta { name: \'x\'; }').ok, false);
    const themesDir = path.join(tmp(), 'themes');
    assert.equal(themeInstalled({ srcDir: THEME_SRC, themesDir }), false);
    const r = installTheme({ srcDir: THEME_SRC, themesDir });
    assert.deepEqual([r.copied.length, r.backups.length], [3, 0]);
    assert.equal(themeInstalled({ srcDir: THEME_SRC, themesDir }), true);
    fs.writeFileSync(path.join(themesDir, 'CertiFried.ovt'), 'edited by someone');
    const r2 = installTheme({ srcDir: THEME_SRC, themesDir, now: Date.parse('2026-11-19T13:00:00Z') });
    assert.equal(r2.backups.length, 1);
    assert.equal(fs.readFileSync(path.join(themesDir, r2.backups[0]), 'utf8'), 'edited by someone');
    assert.equal(themeInstalled({ srcDir: THEME_SRC, themesDir }), true);
});

test('starter scenes: only the ticked, missing ones; existing scenes and inputs left alone', async () => {
    const mock = await startMockObs();
    mock.state.scenes['Be Right Back'] = [];
    const obs = createObs({});
    obs.configure({ enabled: true, host: '127.0.0.1', port: mock.port });
    for (let i = 0; i < 100 && !obs.connected; i++) await new Promise((r) => setTimeout(r, 30));
    try {
        // the mock already has "Starting Soon"; "Be Right Back" is added here
        assert.deepEqual(planStarterScenes(Object.keys(mock.state.scenes)).map((s) => s.name), ['Stream Ending']);
        const countdownBefore = JSON.stringify(mock.state.scenes['Starting Soon']);
        const r = await createStarterScenes(obs, ['Stream Ending', 'Be Right Back', 'Starting Soon']);
        assert.deepEqual(r.created, ['Stream Ending'], 'existing scenes are left alone');
        assert.equal(mock.state.inputs['Stream Ending text'].kind, 'text_gdiplus_v3');
        assert.equal(mock.state.inputs['Stream Ending text'].settings.text, 'Thanks for watching');
        assert.deepEqual(mock.state.scenes['Stream Ending'].map((i) => i.source), ['Stream Ending text']);
        assert.equal(JSON.stringify(mock.state.scenes['Starting Soon']), countdownBefore, 'an existing scene is not changed');
        delete mock.state.scenes['Stream Ending'];
        assert.deepEqual((await createStarterScenes(obs, [])).created, [], 'nothing ticked, nothing made');
        assert.equal(mock.state.scenes['Stream Ending'], undefined);
        const off = createObs({});
        await assert.rejects(createStarterScenes(off, ['Starting Soon']), { code: 'obs_not_connected' });
    } finally { obs.stop(); await mock.close(); }
});
