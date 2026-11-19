'use strict';
/*
 * The fallback key for secrets when Windows' own protection (DPAPI, behind Electron safeStorage) does not work.
 *
 * DPAPI can refuse every request for days after some Windows updates, until the PC is restarted. Then Studio encrypts
 * the pairing token and the OBS password with AES-256-GCM under a random 32-byte key kept in <userData>\local-key.bin,
 * a file only the current Windows user may read (icacls). Against other programs running as the same user this is
 * about as strong as DPAPI CurrentUser; against someone who copies the disk offline it is weaker, because the key sits
 * next to the data instead of being tied to the Windows password. config.js moves every secret back to DPAPI and deletes
 * this file as soon as DPAPI works again.
 *
 *   createLocalKey({ dir, logger, restrict })
 *     load()     the key, or null when the file is missing or not exactly 32 bytes
 *     ensure()   load() or create it (atomic: written to a temp file, locked down, then hard-linked into place, so a
 *                half-written or world-readable key file never exists); null when it cannot be written
 *     remove()
 *     exists()
 *   sealLocal(key, text) → base64 of iv (12) + tag (16) + ciphertext
 *   openLocal(key, b64)  → text; throws when the data was changed or the key is wrong (GCM authentication)
 *   restrictToUser(file, { logger, execFileSync }) → true when icacls succeeded (Windows only; elsewhere chmod 600)
 *
 * Key bytes and secret values are never logged.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const KEY_FILE = 'local-key.bin';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function restrictToUser(file, { logger = null, execFileSync = childProcess.execFileSync, platform = process.platform, user = process.env.USERNAME } = {}) {
    if (platform !== 'win32') {
        try { fs.chmodSync(file, 0o600); return true; } catch { return false; }
    }
    try {
        if (!user) throw new Error('USERNAME is not set');
        // Arguments as an array: no shell, so nothing in the path or the user name is interpreted.
        execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
        return true;
    } catch (e) {
        logger?.warn?.('Could not limit the local key file to this Windows user; it keeps the folder\'s permissions', { error: e?.code || e?.message });
        return false;
    }
}

function createLocalKey({ dir, logger = null, restrict = (f) => restrictToUser(f, { logger }) }) {
    const file = path.join(dir, KEY_FILE);

    function load() {
        try {
            const b = fs.readFileSync(file);
            return b.length === KEY_BYTES ? b : null;
        } catch { return null; }
    }

    function ensure() {
        const have = load();
        if (have) return have;
        if (fs.existsSync(file)) {
            // Present but not a key (truncated or edited): secrets sealed with it cannot be opened anyway.
            logger?.warn?.('The local key file was damaged; making a new one');
            try { fs.rmSync(file, { force: true }); } catch { return null; }
        }
        const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(tmp, crypto.randomBytes(KEY_BYTES), { flag: 'wx', mode: 0o600 });
            restrict(tmp);
            try {
                fs.linkSync(tmp, file);                  // fails if another writer won: then use theirs
            } catch (e) {
                if (e.code !== 'EEXIST') throw e;
            }
            fs.rmSync(tmp, { force: true });
            return load();
        } catch (e) {
            try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
            logger?.warn?.('Could not write the local key file', { error: e?.code || e?.message });
            return null;
        }
    }

    return {
        file,
        load,
        ensure,
        exists: () => fs.existsSync(file),
        remove() { try { fs.rmSync(file, { force: true }); return !fs.existsSync(file); } catch { return false; } },
    };
}

function sealLocal(key, text) {
    const iv = crypto.randomBytes(IV_BYTES);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function openLocal(key, b64) {
    const buf = Buffer.from(String(b64), 'base64');
    if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('local secret too short');
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, IV_BYTES));
    d.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([d.update(buf.subarray(IV_BYTES + TAG_BYTES)), d.final()]).toString('utf8');
}

module.exports = { createLocalKey, sealLocal, openLocal, restrictToUser, KEY_FILE };
