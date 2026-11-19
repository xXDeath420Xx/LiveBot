'use strict';
/*
 * The app must always start, and keep the pairing, even when Windows secure storage (DPAPI, behind Electron
 * safeStorage) is broken. After some Windows updates DPAPI refuses every request until a restart;
 * safeStorage.isEncryptionAvailable() is then false, or encryptString/decryptString throw.
 *
 *  1. config.js with a broken safeStorage at start-up (secrets saved earlier with DPAPI cannot be read) and on save.
 *  2. The real Electron app launched twice with CF_STUDIO_FAKE_SAFESTORAGE=unavailable and =throws (a dev-only switch
 *     that swaps in a broken safeStorage): the first launch saves a token and an OBS password (dev-only env hooks,
 *     the same setSecret path as pairing and Settings), the second launch must still have both, with no banner and
 *     the quiet Settings line. Skipped when the Electron binary is not installed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createConfig } = require('../src/main/config');

const TOKEN = `sbd_${'S'.repeat(43)}`;
const NOTE = "Saved with a key stored in your Windows profile, because Windows' own password protection isn't working on this PC right now. It switches over automatically once it works again.";

const working = () => ({ isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`E:${s}`), decryptString: (b) => { const t = b.toString(); if (!t.startsWith('E:')) throw new Error('bad'); return t.slice(2); } });
const unavailable = () => ({ isEncryptionAvailable: () => false, encryptString: () => { throw new Error('Encryption is not available.'); }, decryptString: () => { throw new Error('Decryption is not available.'); } });
const throwing = () => ({ isEncryptionAvailable: () => true, encryptString: () => { throw new Error('Error while encrypting the text provided to safeStorage.encryptString.'); }, decryptString: () => { throw new Error('Error while decrypting'); } });

test('config: broken secure storage at start-up never throws; DPAPI-saved secrets read as missing; saving uses the local key', () => {
    for (const broken of [unavailable, throwing]) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-ss-'));
        createConfig({ dir, safeStorage: working() }).setSecret('deviceToken', TOKEN);    // saved on a good day
        let cfg;
        assert.doesNotThrow(() => { cfg = createConfig({ dir, safeStorage: broken() }); });
        assert.equal(cfg.secureStorageAvailable(), false);
        assert.equal(cfg.getSecret('deviceToken'), null);
        assert.equal(cfg.hasSecret('deviceToken'), false, 'unreadable counts as not paired, so the pairing form shows');
        assert.equal(cfg.setSecret('obsPassword', 'pw-123'), 'local');
        assert.equal(createConfig({ dir, safeStorage: broken() }).getSecret('obsPassword'), 'pw-123');
        assert.ok(!fs.readFileSync(cfg.paths.secretsFile, 'utf8').includes('pw-123'));
        assert.doesNotThrow(() => cfg.setSecret('obsPassword', null));
    }
    const ok = createConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-ss-')), safeStorage: working() });
    assert.equal(ok.secureStorageAvailable(), true);
});

let electronPath = null;
try { electronPath = require('electron'); if (!fs.existsSync(electronPath)) electronPath = null; } catch { electronPath = null; }

function launch(userData, mode, extraEnv = {}) {
    const smoke = path.join(userData, 'smoke.json');
    fs.rmSync(smoke, { force: true });
    const env = { ...process.env, CF_STUDIO_USER_DATA: userData, CF_STUDIO_FAKE_SAFESTORAGE: mode, CF_STUDIO_SMOKE: smoke, CF_STUDIO_CAPTURE_WAIT: '1500', ...extraEnv };
    delete env.ELECTRON_RUN_AS_NODE;
    return new Promise((resolve) => {
        const child = spawn(electronPath, [path.join(__dirname, '..')], { env, stdio: 'ignore' });
        const killer = setTimeout(() => child.kill(), 45000);
        child.on('exit', (code) => {
            clearTimeout(killer);
            const result = fs.existsSync(smoke) ? JSON.parse(fs.readFileSync(smoke, 'utf8')) : null;
            resolve({ code, result });
        });
    });
}

for (const mode of ['unavailable', 'throws']) {
    test(`safeStorage ${mode}: the app starts, and the pairing and OBS password persist across two launches`, { skip: !electronPath && 'electron binary not installed', timeout: 120000 }, async () => {
        const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-start-'));
        // a secrets.json from 0.2.0 that this PC can no longer decrypt, plus OBS switched off (nothing to connect to)
        fs.writeFileSync(path.join(userData, 'secrets.json'), JSON.stringify({ deviceToken: Buffer.from('v10 not decryptable').toString('base64') }));
        fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ obs: { enabled: false } }));
        try {
            const first = await launch(userData, mode, { CF_STUDIO_DEMO_TOKEN: TOKEN, CF_STUDIO_TEST_OBS_PASSWORD: 'fake-obs-pw' });
            assert.equal(first.code, 0, 'first launch: clean exit');
            assert.equal(first.result?.started, true);
            assert.deepEqual([first.result.paired, first.result.hasObsPassword, first.result.storageMode, first.result.keyFile], [true, true, 'local', true]);

            const second = await launch(userData, mode);     // no hooks: only what was saved
            assert.equal(second.code, 0, 'second launch: clean exit');
            const r = second.result;
            assert.equal(r.started, true);
            assert.equal(r.secureStorage, false);
            assert.equal(r.paired, true, 'pairing kept');
            assert.equal(r.hasObsPassword, true, 'OBS password kept');
            assert.equal(r.storageMode, 'local');
            assert.equal(r.banner, null, 'no banner');
            assert.equal(r.note, NOTE, 'the quiet line in Settings');
            assert.equal(r.pairShown, false);
            assert.equal(r.keySending, true, 'uiohook-napi loads inside Electron');
            const raw = fs.readFileSync(path.join(userData, 'secrets.json'), 'utf8');
            assert.ok(!raw.includes(TOKEN) && !raw.includes('fake-obs-pw'), 'nothing in plain text');
            const logText = fs.readFileSync(path.join(userData, 'logs', 'studio.log'), 'utf8');
            assert.ok(!logText.includes(TOKEN) && !logText.includes('fake-obs-pw'), 'nothing secret in the log');
            assert.doesNotMatch(logText, /could not start|start-up step failed/);
        } finally {
            fs.rmSync(userData, { recursive: true, force: true });
        }
    });
}
