'use strict';
/*
 * Secrets without DPAPI (0.2.1): the local AES-256-GCM key (src/main/local-key.js) and the schemes in config.js.
 *   - local round-trip; a changed byte fails GCM authentication → not paired, no crash
 *   - untagged 0.2.0 DPAPI strings still read; each secret read with its own scheme
 *   - when DPAPI works again: local secrets move to DPAPI, and the key is deleted only after every one moved
 *   - key file missing or damaged → not paired, nothing throws
 *   - icacls failing is not fatal; icacls is called with an argument array, no shell
 *   - nothing secret in the logs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConfig } = require('../src/main/config');
const { createLocalKey, sealLocal, openLocal, restrictToUser } = require('../src/main/local-key');
const { createLogger } = require('../src/main/logger');

const TOKEN = `sbd_${'K'.repeat(43)}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-sec-'));
const broken = () => ({ isEncryptionAvailable: () => false, encryptString: () => { throw new Error('Encryption is not available.'); }, decryptString: () => { throw new Error('Decryption is not available.'); } });
function dpapi({ failRoundTripFor = null } = {}) {
    return {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(`DP:${Buffer.from(s).toString('hex')}`),
        decryptString: (b) => {
            const t = b.toString();
            if (!t.startsWith('DP:')) throw new Error('bad');
            const v = Buffer.from(t.slice(3), 'hex').toString();
            return v === failRoundTripFor ? `${v}-corrupted` : v;
        },
    };
}
const keyFor = (dir, logger) => createLocalKey({ dir, logger, restrict: () => true });
const onDisk = (cfg) => JSON.parse(fs.readFileSync(cfg.paths.secretsFile, 'utf8'));

test('local scheme: round-trip, fresh IV each time, tagged on disk, survives a restart', () => {
    const dir = tmp();
    const cfg = createConfig({ dir, safeStorage: broken(), localKey: keyFor(dir) });
    assert.equal(cfg.setSecret('deviceToken', TOKEN), 'local');
    assert.equal(cfg.setSecret('obsPassword', 'obs-pw-1'), 'local');
    const d = onDisk(cfg);
    assert.deepEqual([d.deviceToken.v, d.deviceToken.scheme], [2, 'local']);
    const raw = fs.readFileSync(cfg.paths.secretsFile, 'utf8');
    assert.ok(!raw.includes(TOKEN) && !raw.includes('obs-pw-1'));
    assert.equal(fs.statSync(cfg.paths.keyFile).size, 32);
    const again = createConfig({ dir, safeStorage: broken(), localKey: keyFor(dir) });
    assert.equal(again.getSecret('deviceToken'), TOKEN);
    assert.equal(again.getSecret('obsPassword'), 'obs-pw-1');
    assert.equal(again.storageMode(), 'local');
    const k = keyFor(dir).load();
    assert.notEqual(sealLocal(k, 'x'), sealLocal(k, 'x'), 'random IV per secret');
    assert.equal(openLocal(k, sealLocal(k, 'hello')), 'hello');
});

test('tampering fails GCM authentication: not paired, no crash', () => {
    const dir = tmp();
    const cfg = createConfig({ dir, safeStorage: broken(), localKey: keyFor(dir) });
    cfg.setSecret('deviceToken', TOKEN);
    const d = onDisk(cfg);
    const b = Buffer.from(d.deviceToken.data, 'base64');
    b[b.length - 1] ^= 0x01;
    d.deviceToken.data = b.toString('base64');
    fs.writeFileSync(cfg.paths.secretsFile, JSON.stringify(d));
    const again = createConfig({ dir, safeStorage: broken(), localKey: keyFor(dir) });
    assert.doesNotThrow(() => again.getSecret('deviceToken'));
    assert.equal(again.getSecret('deviceToken'), null);
    assert.equal(again.hasSecret('deviceToken'), false);
    assert.throws(() => openLocal(keyFor(dir).load(), d.deviceToken.data), /auth|unable/i);
});

test('0.2.0 untagged DPAPI strings still read; each secret is read with its own scheme', () => {
    const dir = tmp();
    const ss = dpapi();
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ deviceToken: ss.encryptString(TOKEN).toString('base64') }));
    const cfg = createConfig({ dir, safeStorage: ss, localKey: keyFor(dir) });
    assert.equal(cfg.getSecret('deviceToken'), TOKEN, 'old format');
    // a local secret next to a DPAPI one, both readable while DPAPI works
    const k = keyFor(dir).ensure();
    const d = onDisk(cfg);
    d.obsPassword = { v: 2, scheme: 'local', data: sealLocal(k, 'pw-local') };
    fs.writeFileSync(cfg.paths.secretsFile, JSON.stringify(d));
    const mixed = createConfig({ dir, safeStorage: ss, localKey: keyFor(dir) });
    assert.equal(mixed.getSecret('deviceToken'), TOKEN);
    assert.equal(mixed.getSecret('obsPassword'), 'pw-local');
    // DPAPI breaks: the DPAPI one is unreadable (not paired), the local one still reads
    const noDp = createConfig({ dir, safeStorage: broken(), localKey: keyFor(dir) });
    assert.equal(noDp.getSecret('deviceToken'), null);
    assert.equal(noDp.getSecret('obsPassword'), 'pw-local');
});

test('upgrade: local secrets move to DPAPI; the key goes only after every one moved', () => {
    const dir = tmp();
    const first = createConfig({ dir, safeStorage: broken(), localKey: keyFor(dir) });
    first.setSecret('deviceToken', TOKEN);
    first.setSecret('obsPassword', 'obs-pw-2');
    assert.equal(first.upgradeSecrets().moved, 0, 'nothing happens while DPAPI is broken');
    assert.ok(fs.existsSync(first.paths.keyFile));

    // DPAPI back, but one secret fails its round-trip: it stays local and the key stays
    const partial = createConfig({ dir, safeStorage: dpapi({ failRoundTripFor: 'obs-pw-2' }), localKey: keyFor(dir) });
    assert.deepEqual(partial.upgradeSecrets(), { moved: 1, dropped: 0, keyRemoved: false });
    assert.equal(onDisk(partial).deviceToken.scheme, 'dpapi');
    assert.equal(onDisk(partial).obsPassword.scheme, 'local');
    assert.ok(fs.existsSync(partial.paths.keyFile), 'key kept while a secret still uses it');

    // next start, DPAPI fully working: the rest moves, then the key is deleted
    const ss = dpapi();
    const full = createConfig({ dir, safeStorage: ss, localKey: keyFor(dir) });
    assert.deepEqual(full.upgradeSecrets(), { moved: 1, dropped: 0, keyRemoved: true });
    assert.ok(!fs.existsSync(full.paths.keyFile));
    assert.equal(full.storageMode(), 'dpapi');
    const after = createConfig({ dir, safeStorage: ss, localKey: keyFor(dir) });
    assert.equal(after.getSecret('deviceToken'), TOKEN);
    assert.equal(after.getSecret('obsPassword'), 'obs-pw-2');
    // a leftover key with no local secrets is removed too
    keyFor(dir).ensure();
    assert.equal(createConfig({ dir, safeStorage: ss, localKey: keyFor(dir) }).upgradeSecrets().keyRemoved, true);
});

test('key file missing or damaged: not paired, nothing throws; saving makes a new key', () => {
    for (const damage of ['missing', 'short', 'garbage']) {
        const dir = tmp();
        const cfg = createConfig({ dir, safeStorage: broken(), localKey: keyFor(dir) });
        cfg.setSecret('deviceToken', TOKEN);
        if (damage === 'missing') fs.rmSync(cfg.paths.keyFile);
        else if (damage === 'short') fs.writeFileSync(cfg.paths.keyFile, Buffer.alloc(10));
        else fs.writeFileSync(cfg.paths.keyFile, Buffer.alloc(32, 7));   // right size, wrong key: GCM fails
        let again;
        assert.doesNotThrow(() => { again = createConfig({ dir, safeStorage: broken(), localKey: keyFor(dir) }); });
        assert.equal(again.hasSecret('deviceToken'), false, damage);
        assert.equal(again.setSecret('deviceToken', TOKEN), 'local', `${damage}: pairing again works`);
        assert.equal(createConfig({ dir, safeStorage: broken(), localKey: keyFor(dir) }).getSecret('deviceToken'), TOKEN);
    }
    // the key cannot be written at all (folder is a file): memory only, for this run
    const dir = tmp();
    const blocked = { file: path.join(dir, 'x'), load: () => null, ensure: () => null, exists: () => false, remove: () => true };
    const cfg = createConfig({ dir, safeStorage: broken(), localKey: blocked });
    assert.equal(cfg.setSecret('deviceToken', TOKEN), 'memory');
    assert.equal(cfg.getSecret('deviceToken'), TOKEN);
    assert.equal(cfg.storageMode(), 'memory');
});

test('icacls: argument array, no shell; a failure is logged and not fatal', () => {
    const calls = [];
    const file = path.join(tmp(), 'k.bin');
    fs.writeFileSync(file, 'x');
    assert.equal(restrictToUser(file, { platform: 'win32', user: 'Tester', execFileSync: (cmd, args, opts) => { calls.push({ cmd, args, shell: opts?.shell }); } }), true);
    assert.deepEqual(calls[0], { cmd: 'icacls', args: [file, '/inheritance:r', '/grant:r', 'Tester:F'], shell: undefined });
    const warnings = [];
    const ok = restrictToUser(file, { platform: 'win32', user: 'Tester', logger: { warn: (m, meta) => warnings.push([m, meta]) }, execFileSync: () => { const e = new Error('icacls exited 5'); e.code = 'EACCES'; throw e; } });
    assert.equal(ok, false);
    assert.equal(warnings.length, 1);
    // a failing icacls while creating the key: the key is still made and used
    const dir = tmp();
    const key = createLocalKey({ dir, restrict: (f) => restrictToUser(f, { platform: 'win32', user: 'T', execFileSync: () => { throw new Error('no icacls'); } }) });
    assert.equal(key.ensure().length, 32);
    const cfg = createConfig({ dir, safeStorage: broken(), localKey: key });
    assert.equal(cfg.setSecret('deviceToken', TOKEN), 'local');
    assert.equal(createConfig({ dir, safeStorage: broken() }).getSecret('deviceToken'), TOKEN);
    if (process.platform === 'win32') {
        // the real icacls on this PC, on a scratch file
        const real = path.join(tmp(), 'real.bin');
        fs.writeFileSync(real, 'x');
        assert.equal(restrictToUser(real, {}), true);
    }
});

test('logs never contain secret values or key bytes', () => {
    const dir = tmp();
    const log = createLogger({ dir: path.join(dir, 'logs') });
    const cfg = createConfig({ dir, safeStorage: broken(), localKey: keyFor(dir, log), logger: log });
    cfg.setSecret('deviceToken', TOKEN);
    cfg.setSecret('obsPassword', 'obs-pw-secret');
    fs.writeFileSync(cfg.paths.keyFile, Buffer.alloc(32, 9));
    const again = createConfig({ dir, safeStorage: broken(), localKey: keyFor(dir, log), logger: log });
    again.getSecret('deviceToken');
    const text = fs.readFileSync(log.file, 'utf8');
    const key = fs.readFileSync(again.paths.keyFile);
    for (const bad of [TOKEN, 'obs-pw-secret', key.toString('base64'), key.toString('hex')]) assert.ok(!text.includes(bad));
    assert.match(text, /local key/);
});
