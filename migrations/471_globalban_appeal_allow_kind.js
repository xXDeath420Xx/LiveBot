/**
 * Migration 471: a narrower allowlist kind for global ban appeals accepted by one server (register H-802
 * follow-up, fix wave 6, 2026-11-20).
 *
 * A server moderator's approval of a global ban appeal (core/global-ban-manager.js approveAppealForServer)
 * used to put the person on that server's protection allowlist (kind 'user'), which exempts them from EVERY
 * CertiFried protection there: raids, phishing, name filters, spam and the rest. It now only stops the global
 * ban acting on them in that server: protection_allowlist kind 'globalban' (core/protection-exempt.js
 * allowGlobalBan / isGlobalBanAllowed). Same table, one more kind; shown and removable on the Protection
 * Settings page.
 *
 *   1. protection_allowlist.kind gains 'globalban' (only when missing).
 *   2. Rows that approval path created move from 'user' to 'globalban'. They are recognised by the note the
 *      path wrote ("Global ban appeal #<id> approved for this server") together with a matching
 *      global_ban_action_log 'appeal_server_allow' row for the same server and person. A 'user' row a
 *      moderator added for any other reason (another note, or no log row) is left alone.
 *
 * Safe to re-run: step 1 checks the enum, step 2 only finds rows still of kind 'user'.
 * Apply: `npm run migrate -- 471_globalban_appeal_allow_kind.js` (or import { up } and call up(pool)).
 */
async function enumValues(db) {
    const [rows] = await db.execute(
        `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'protection_allowlist' AND COLUMN_NAME = 'kind'`);
    if (!rows.length) return null;
    const m = String(rows[0].COLUMN_TYPE).match(/^enum\((.+)\)$/i);
    return m ? m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')) : null;
}

const literal = (values) => values.map(v => `'${v.replace(/'/g, "''")}'`).join(',');

export async function up(db) {
    const current = await enumValues(db);
    if (!current) throw new Error('protection_allowlist.kind column not found');
    if (!current.includes('globalban')) {
        await db.execute(`ALTER TABLE protection_allowlist MODIFY COLUMN kind ENUM(${literal([...current, 'globalban'])}) NOT NULL`);
    }

    const [logTable] = await db.execute(
        "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'global_ban_action_log'");
    if (!Number(logTable[0].n)) return { moved: 0 };
    const [rows] = await db.execute(
        `SELECT a.guild_id, a.target_id, a.added_by, a.note, a.added_at
           FROM protection_allowlist a
          WHERE a.kind = 'user'
            AND a.note LIKE 'Global ban appeal #% approved for this server'
            AND EXISTS (SELECT 1 FROM global_ban_action_log l
                         WHERE l.action = 'appeal_server_allow' AND l.guild_id COLLATE utf8mb4_unicode_ci = a.guild_id COLLATE utf8mb4_unicode_ci AND l.user_id COLLATE utf8mb4_unicode_ci = a.target_id COLLATE utf8mb4_unicode_ci)`);
    for (const r of rows) {
        await db.execute(
            `INSERT IGNORE INTO protection_allowlist (guild_id, kind, target_id, added_by, note, added_at)
             VALUES (?, 'globalban', ?, ?, ?, ?)`,
            [r.guild_id, r.target_id, r.added_by, r.note, r.added_at]);
        await db.execute(
            "DELETE FROM protection_allowlist WHERE guild_id = ? AND kind = 'user' AND target_id = ? AND note = ?",
            [r.guild_id, r.target_id, r.note]);
    }
    return { moved: rows.length };
}

export async function down(db) {
    // Moves the rows back to full allowlist entries, then drops the kind.
    const current = await enumValues(db);
    if (!current || !current.includes('globalban')) return;
    await db.execute(
        "INSERT IGNORE INTO protection_allowlist (guild_id, kind, target_id, added_by, note, added_at) SELECT guild_id, 'user', target_id, added_by, note, added_at FROM protection_allowlist WHERE kind = 'globalban'");
    await db.execute("DELETE FROM protection_allowlist WHERE kind = 'globalban'");
    await db.execute(`ALTER TABLE protection_allowlist MODIFY COLUMN kind ENUM(${literal(current.filter(v => v !== 'globalban'))}) NOT NULL`);
}
