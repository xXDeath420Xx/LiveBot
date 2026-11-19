/*
 * Stream bot import data in /privacy export (migration 455). Delete needs nothing here: both tables hang off
 * stream_bot_profiles with ON DELETE CASCADE, so deleting the profile removes them.
 *
 *   importExport(db, profileId, prefix) → { imports: [rows], import_items: [rows] }
 * Called from core/stream-bot/privacy.js exportFor(). Rows carry no credentials (stripped at import time).
 */
export async function importExport(db, profileId, prefix = 'stream_bot_', rowLimit = 1000) {
    if (!db || !profileId || !/^[a-z0-9_]{1,30}$/.test(prefix)) return {};
    const n = Math.max(1, Number(rowLimit) || 1000);
    const out = {};
    try {
        const [imports] = await db.query(`SELECT id, sources, file_names, categories, summary, created_at FROM \`${prefix}imports\` WHERE profile_id = ? ORDER BY id DESC LIMIT ${n}`, [profileId]);
        if (imports.length) out.imports = imports;
        const [items] = await db.query(`SELECT source, kind, source_id, name, status, target_kind, target_ref, data, created_at, updated_at FROM \`${prefix}import_items\` WHERE profile_id = ? ORDER BY id LIMIT ${n}`, [profileId]);
        if (items.length) out.import_items = items;
    } catch { /* tables not created yet (migration 455) */ }
    return out;
}

export default { importExport };
