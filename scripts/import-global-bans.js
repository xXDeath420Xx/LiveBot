/**
 * Direct DB import for global ban entries from audit-import-ready.json
 * Mirrors the logic in super-admin.js POST /api/super-admin/global-ban/import
 *
 * Usage: node scripts/import-global-bans.js
 */

import dotenv from 'dotenv';
dotenv.config();

import pool from '../utils/db.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const importPath = join(__dirname, '..', 'audit-import-ready.json');

const REPORTER_ID = '365905620060340224'; // death420 (your Discord ID)

const validSeverities = ['critical', 'high', 'medium', 'low'];
const validCategories = ['phishing', 'scam', 'spam', 'raid', 'harassment', 'selfbot', 'mass_dm', 'impersonation', 'other'];
const userIdRegex = /^\d{17,20}$/;

async function main() {
    const data = JSON.parse(readFileSync(importPath, 'utf8'));
    const rows = data.rows;

    console.log(`Importing ${rows.length} entries into global_ban_entries...\n`);

    // Get existing active entries to skip duplicates
    const [existing] = await pool.execute('SELECT user_id FROM global_ban_entries WHERE active = 1');
    const existingIds = new Set(existing.map(e => e.user_id));
    console.log(`Existing active entries: ${existingIds.size}`);

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const userId = String(row.user_id || '').trim();

        if (!userId || !userIdRegex.test(userId)) {
            errors.push({ row: i + 1, user_id: userId, error: 'Invalid user_id' });
            continue;
        }

        if (existingIds.has(userId)) {
            skipped++;
            continue;
        }

        const severity = validSeverities.includes(row.severity) ? row.severity : 'medium';
        const category = validCategories.includes(row.category) ? row.category : 'other';
        const reason = row.reason || 'Imported from audit';
        const evidence = row.evidence ? JSON.stringify([row.evidence]) : null;

        try {
            await pool.execute(
                `INSERT INTO global_ban_entries (user_id, severity, category, reason, evidence, source, reporter_id, verified, active)
                 VALUES (?, ?, ?, ?, ?, 'manual_report', ?, 1, 1)`,
                [userId, severity, category, reason, evidence, row.reported_by_id || REPORTER_ID]
            );
            existingIds.add(userId);
            imported++;
        } catch (err) {
            if (err.code === 'ER_DUP_ENTRY') {
                skipped++;
            } else {
                errors.push({ row: i + 1, user_id: userId, error: err.message });
            }
        }
    }

    // Log the import action
    await pool.execute(
        `INSERT INTO global_ban_action_log (global_ban_entry_id, guild_id, user_id, action, performed_by, details)
         VALUES (NULL, 'system', ?, 'entry_created', ?, ?)`,
        [REPORTER_ID, REPORTER_ID, `CLI import: ${imported} imported, ${skipped} skipped, ${errors.length} errors`]
    );

    console.log(`\n=== Import Complete ===`);
    console.log(`  Imported: ${imported}`);
    console.log(`  Skipped (duplicates): ${skipped}`);
    console.log(`  Errors: ${errors.length}`);

    if (errors.length > 0) {
        console.log('\nErrors:');
        for (const e of errors) {
            console.log(`  Row ${e.row}: ${e.error} (${e.user_id})`);
        }
    }

    console.log('\nNote: Run "pm2 restart CertiFriedUtility" to refresh the in-memory ban cache.');
    await pool.end();
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
