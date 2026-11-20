/*
 * Stream bot devices: the cloud light accounts table (migration 461, stream_bot_light_accounts) and the light presets kept
 * in the profile's settings JSON (`settings.lights.presets`; no secrets there).
 *
 *   createLightAccounts({ db, prefix = 'stream_bot_', encryption })
 *     .list(profileId)                      [{ provider, keyHint, status, lastError, devices[], devicesAt, createdAt }] (no key)
 *     .get(profileId, provider)             the same row with `key` decrypted (cloud.js only; never sent to a browser or logged)
 *     .save(profileId, provider, key)       insert or replace; status back to 'unchecked'
 *     .mark(profileId, provider, { status, lastError, devices })
 *     .remove(profileId, provider)          → removed (bool)
 *     .exportRows(profileId)                for /privacy: provider, hint, status, device names; never the key
 *
 * The key is encrypted with utils/encryption.js (AES-256-GCM) as the tip-feed tokens are; only its last 4 characters are kept
 * in clear, as a hint. Tested in tests/stream-bot-devices.test.js (throwaway tables from lightAccountsDdl()).
 */
import { CLOUD_PROVIDERS } from './catalog.js';

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function createLightAccounts({ db, prefix = 'stream_bot_', encryption = null } = {}) {
    if (!/^[a-z0-9_]{1,30}$/.test(prefix)) throw new Error('bad table prefix');
    const T = `\`${prefix}light_accounts\``;
    const q = async (sql, params = []) => (await db.query(sql, params))[0];
    const enc = (s) => (encryption ? JSON.stringify(encryption.encrypt(String(s))) : null);
    const dec = (s) => { if (!s || !encryption) return null; try { return encryption.decrypt(JSON.parse(s)); } catch { return null; } };
    const row = (r, withKey = false) => (r ? {
        provider: r.provider, keyHint: r.key_hint || null, status: r.status, lastError: r.last_error || null,
        devices: parse(r.devices, []), devicesAt: r.devices_at ? new Date(r.devices_at) : null, createdAt: r.created_at ? new Date(r.created_at) : null,
        ...(withKey ? { key: dec(r.key_enc) } : {}),
    } : null);
    const okProvider = (p) => CLOUD_PROVIDERS.includes(p);

    return {
        prefix,
        async list(profileId) {
            return (await q(`SELECT * FROM ${T} WHERE profile_id = ? ORDER BY provider`, [profileId])).map((r) => row(r));
        },
        async get(profileId, provider) {
            if (!okProvider(provider)) return null;
            return row((await q(`SELECT * FROM ${T} WHERE profile_id = ? AND provider = ?`, [profileId, provider]))[0], true);
        },
        async save(profileId, provider, key) {
            if (!okProvider(provider)) throw new Error('unknown provider');
            const k = String(key || '').trim();
            const sealed = enc(k);
            if (!sealed) throw new Error('encryption is not available');
            await q(`INSERT INTO ${T} (profile_id, provider, key_enc, key_hint, status, last_error, devices, devices_at) VALUES (?, ?, ?, ?, 'unchecked', NULL, NULL, NULL)
                     ON DUPLICATE KEY UPDATE key_enc = VALUES(key_enc), key_hint = VALUES(key_hint), status = 'unchecked', last_error = NULL, devices = NULL, devices_at = NULL`,
            [profileId, provider, sealed, k.slice(-4)]);
        },
        async mark(profileId, provider, { status, lastError, devices } = {}) {
            const sets = [], params = [];
            if (status !== undefined) { sets.push('status = ?'); params.push(String(status).slice(0, 16)); }
            if (lastError !== undefined) { sets.push('last_error = ?'); params.push(lastError ? String(lastError).slice(0, 200) : null); }
            if (devices !== undefined) { sets.push('devices = ?', 'devices_at = CURRENT_TIMESTAMP'); params.push(JSON.stringify(devices || []).slice(0, 2_000_000)); }
            if (!sets.length) return;
            await q(`UPDATE ${T} SET ${sets.join(', ')} WHERE profile_id = ? AND provider = ?`, [...params, profileId, provider]);
        },
        async remove(profileId, provider) {
            return (await q(`DELETE FROM ${T} WHERE profile_id = ? AND provider = ?`, [profileId, provider])).affectedRows > 0;
        },
        async exportRows(profileId) {
            return (await q(`SELECT provider, key_hint, status, last_error, devices, devices_at, created_at, updated_at FROM ${T} WHERE profile_id = ?`, [profileId]))
                .map((r) => ({ provider: r.provider, key_hint: r.key_hint, status: r.status, last_error: r.last_error,
                    devices: parse(r.devices, []).map((d) => ({ id: d.id, name: d.name, model: d.model || null })), devices_at: r.devices_at, created_at: r.created_at, updated_at: r.updated_at }));
        },
        async count(profileId) {
            return Number((await q(`SELECT COUNT(*) AS n FROM ${T} WHERE profile_id = ?`, [profileId]))[0].n);
        },
    };
}

export default { createLightAccounts };
