'use strict';
/*
 * Settings (plain JSON) and secrets (the device token, the OBS password, the Stream Deck pairing token, and one token per
 * paired light: dev:hue:<bridge id>, dev:nanoleaf:<id>).
 *
 *   createConfig({ dir, safeStorage, logger?, localKey? })
 *     get()                 a copy of the settings
 *     update(patch)         deep-merges and saves; returns the new settings
 *     replace(key, value)
 *     getSecret(name)       decrypted string, or null (missing, or cannot be decrypted: treated as not saved)
 *     hasSecret(name)
 *     setSecret(name, v)    v null/'' deletes it. Returns the scheme used: 'dpapi' | 'local' | 'memory' | 'deleted'
 *     secureStorageAvailable()  whether Windows' DPAPI works right now (tried once; never throws)
 *     storageMode()         'dpapi' (all saved with Windows' protection, or nothing saved), 'local' (some saved with the
 *                           fallback key), 'memory' (some kept for this run only)
 *     upgradeSecrets()      when DPAPI works: move every 'local' secret to DPAPI, check each round-trip, and delete the
 *                           local key once no secret uses it. Returns { moved, dropped, keyRemoved }
 *
 * How a secret is saved, in order:
 *   1. Electron safeStorage (DPAPI, CurrentUser).
 *   2. If DPAPI is unavailable or fails: AES-256-GCM with the local key (src/main/local-key.js).
 *   3. If even the key file cannot be written: memory only, for this run of the app.
 * Never in plain text. Nothing here throws because of DPAPI or the key: the app must always start.
 *
 * secrets.json: { name: { v: 2, scheme: 'dpapi' | 'local', data: base64 } }. Untagged base64 strings written by 0.2.0
 * are DPAPI and are still read. A secret is always read with the scheme it was saved with.
 * Writes go to a temp file first and are renamed into place, so a crash cannot leave half a file.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createLocalKey, sealLocal, openLocal } = require('./local-key');
const { SITE } = require('./site');

const DEFAULTS = Object.freeze({
    server: SITE,
    device: { id: null, name: null, pairedAt: null },
    obs: { enabled: true, host: '127.0.0.1', port: 4455 },
    sound: { outputDeviceId: 'default', masterVolume: 100, defaultMode: 'overlap', syncDashboard: true },
    hotkeys: [],
    app: { startWithWindows: false, startMinimised: true, theme: 'dark', checkUpdates: true },
    // Voice commands: microphone off until the person turns it on.
    voice: { enabled: false, inputDeviceId: 'default', mode: 'always', pttKey: 'F13', threshold: 0.7, phrases: [] },
    // VOD-safe music (only while song requests are on, 0.2.6): the music source's UUID, the optional record-without-music
    // choice, and the server's last word on song requests (null: not told yet, so the 0.2.5 behaviour, enforced, holds).
    music: { sourceUuid: null, recordWithoutMusic: false, prevRecTracks: null, kickMusic: 'unknown', songRequests: null },
    // Phase 5. Lights: no network search until the person chooses Find lights (enabled), then at every start. Known lights
    // (no tokens; those are secrets) and Hue bridges with their pinned certificate fingerprints.
    lights: { enabled: false, drivers: { govee: true, hue: true, lifx: true, nanoleaf: true, elgato: true, litra: true }, known: [], hue: { bridges: [] } },
    // Voicemeeter control: off until turned on; the DLL is loaded only then.
    voicemeeter: { enabled: false },
    // The Stream Deck plugin's local connection: off until turned on; 127.0.0.1 only.
    streamdeck: { enabled: false, port: 39720 },
});

const SECRET_NAMES = new Set(['deviceToken', 'obsPassword', 'streamdeckToken']);
// Phase 5: one secret per paired light (Hue bridge user, Nanoleaf token), named dev:<driver>:<id>.
const DEVICE_SECRET = /^dev:[a-z0-9-]{1,20}:[A-Za-z0-9._-]{1,80}$/;
const isSecretName = (n) => SECRET_NAMES.has(n) || DEVICE_SECRET.test(String(n));

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function merge(base, patch) {
    if (!isObj(patch)) return base;
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
    }
    return out;
}

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

/** The stored form of a secret: { scheme, data } (untagged 0.2.0 strings are DPAPI). */
function entryOf(raw) {
    if (typeof raw === 'string' && raw.length) return { scheme: 'dpapi', data: raw };
    if (isObj(raw) && raw.v === 2 && (raw.scheme === 'dpapi' || raw.scheme === 'local') && typeof raw.data === 'string' && raw.data.length) return { scheme: raw.scheme, data: raw.data };
    return null;
}

function createConfig({ dir, safeStorage, logger = null, localKey = null }) {
    fs.mkdirSync(dir, { recursive: true });
    const settingsFile = path.join(dir, 'settings.json');
    const secretsFile = path.join(dir, 'secrets.json');
    const key = localKey || createLocalKey({ dir, logger });
    let settings = merge(DEFAULTS, readJson(settingsFile, {}));
    let secrets = readJson(secretsFile, {});
    if (!isObj(secrets)) secrets = {};
    const memory = new Map();   // secrets that could not be saved at all: this run only
    const warned = new Set();
    let probe = null;

    const canEncrypt = () => {
        try { return !!safeStorage?.isEncryptionAvailable?.(); } catch { return false; }
    };
    function dpapiSeal(text) {
        if (!canEncrypt()) return null;
        try { return safeStorage.encryptString(String(text)).toString('base64'); } catch { return null; }
    }
    function dpapiOpen(b64) {
        if (!canEncrypt()) return null;
        try { return safeStorage.decryptString(Buffer.from(b64, 'base64')); } catch { return null; }
    }
    function localOpen(b64) {
        const k = key.load();
        if (!k) return null;
        try { return openLocal(k, b64); } catch { return null; }   // changed data or another key: not readable
    }
    function read(name) {
        const e = entryOf(secrets[name]);
        if (!e) return null;
        return e.scheme === 'dpapi' ? dpapiOpen(e.data) : localOpen(e.data);
    }
    function save() { writeJson(secretsFile, secrets); }
    const allNames = () => [...new Set([...SECRET_NAMES, ...Object.keys(secrets).filter(isSecretName)])];

    const api = {
        get: () => JSON.parse(JSON.stringify(settings)),
        update(patch) {
            settings = merge(settings, patch);
            writeJson(settingsFile, settings);
            return JSON.parse(JSON.stringify(settings));
        },
        replace(k, value) {
            settings = { ...settings, [k]: value };
            writeJson(settingsFile, settings);
            return JSON.parse(JSON.stringify(settings));
        },
        hasSecret(name) {
            if (memory.has(name)) return true;
            return api.getSecret(name) != null;   // saved but unreadable now counts as not saved
        },
        getSecret(name) {
            if (!isSecretName(name)) return null;
            if (memory.has(name)) return memory.get(name);
            if (!entryOf(secrets[name])) return null;
            const v = read(name);
            const e = entryOf(secrets[name]);
            if (v == null && !warned.has(`${name}:${e.data.slice(0, 24)}`)) {
                warned.add(`${name}:${e.data.slice(0, 24)}`);
                logger?.warn('A saved secret could not be read; it counts as not saved', { name, scheme: e.scheme });
            }
            return v;
        },
        setSecret(name, value) {
            if (!isSecretName(name)) throw new Error('unknown_secret');
            memory.delete(name);
            if (value == null || value === '') {
                delete secrets[name];
                save();
                return 'deleted';
            }
            const dp = dpapiSeal(value);
            if (dp) {
                secrets[name] = { v: 2, scheme: 'dpapi', data: dp };
                save();
                return 'dpapi';
            }
            const k = key.ensure();
            if (k) {
                secrets[name] = { v: 2, scheme: 'local', data: sealLocal(k, value) };
                save();
                logger?.info('Saved a secret with the local key because Windows secure storage is not working', { name });
                return 'local';
            }
            logger?.warn('Could not save a secret at all; keeping it in memory until the app closes', { name });
            memory.set(name, String(value));
            delete secrets[name];
            save();
            return 'memory';
        },
        secretsVolatile: () => memory.size > 0,
        secureStorageAvailable() {
            if (probe !== null) return probe;
            try { probe = canEncrypt() && safeStorage.encryptString('probe').length > 0; } catch { probe = false; }
            return probe;
        },
        storageMode() {
            if (memory.size) return 'memory';
            for (const n of allNames()) if (entryOf(secrets[n])?.scheme === 'local') return 'local';
            return 'dpapi';
        },
        upgradeSecrets() {
            const out = { moved: 0, dropped: 0, keyRemoved: false };
            if (!api.secureStorageAvailable()) return out;
            let changed = false;
            for (const n of allNames()) {
                const e = entryOf(secrets[n]);
                if (!e || e.scheme !== 'local') continue;
                const plain = localOpen(e.data);
                if (plain == null) {
                    // Cannot be opened (key missing or data changed): it is useless, and keeping it would pin the key.
                    delete secrets[n];
                    changed = true;
                    out.dropped++;
                    logger?.warn('Dropped a saved secret that could not be read during the move to Windows secure storage', { name: n });
                    continue;
                }
                const dp = dpapiSeal(plain);
                if (!dp || dpapiOpen(dp) !== plain) continue;          // round-trip failed: leave it on the local key
                secrets[n] = { v: 2, scheme: 'dpapi', data: dp };
                changed = true;
                out.moved++;
            }
            if (changed) save();
            const stillLocal = allNames().some((n) => entryOf(secrets[n])?.scheme === 'local');
            const onDisk = readJson(secretsFile, {});
            const diskLocal = [...new Set([...SECRET_NAMES, ...Object.keys(isObj(onDisk) ? onDisk : {}).filter(isSecretName)])].some((n) => entryOf(onDisk?.[n])?.scheme === 'local');
            if (!stillLocal && !diskLocal && key.exists()) {
                out.keyRemoved = key.remove();
                if (out.keyRemoved) logger?.info('Windows secure storage works again; secrets moved to it and the local key was deleted', { moved: out.moved });
            }
            return out;
        },
        paths: { settingsFile, secretsFile, keyFile: key.file },
    };
    return api;
}

module.exports = { createConfig, DEFAULTS, merge, entryOf, isSecretName };
