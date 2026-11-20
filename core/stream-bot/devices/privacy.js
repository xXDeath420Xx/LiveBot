/*
 * Stream bot devices in /privacy (called from core/stream-bot/privacy.js).
 *
 *   devicesExport(db, profileId, prefix) → { light_accounts: [...] }   provider, key hint, status and the device names the
 *                                                                       service returned; never the key itself
 *   devicesDelete(db, profileId, prefix) → { <prefix>light_accounts: n }  counted before the profile's ON DELETE CASCADE
 *
 * Light presets live in the profile's settings JSON (exported with the profile). The lights, Voicemeeter and Stream Deck
 * that CertiFried Studio reports are kept in settings.studio.devices without network addresses; their tokens stay on the PC.
 * Missing table (migration 461 not applied): empty export, nothing deleted.
 */
import { createLightAccounts } from './accounts.js';

export async function devicesExport(db, profileId, prefix = 'stream_bot_') {
    if (!db || !profileId) return {};
    try {
        const rows = await createLightAccounts({ db, prefix }).exportRows(profileId);
        return rows.length ? { light_accounts: rows } : {};
    } catch { return {}; }
}

export async function devicesDelete(db, profileId, prefix = 'stream_bot_') {
    if (!db || !profileId) return {};
    try {
        const [r] = await db.query(`DELETE FROM \`${prefix}light_accounts\` WHERE profile_id = ?`, [profileId]);
        return r.affectedRows ? { [`${prefix}light_accounts`]: r.affectedRows } : {};
    } catch { return {}; }
}

export default { devicesExport, devicesDelete };
