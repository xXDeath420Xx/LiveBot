/**
 * Updates global_ban_entries with corrected reasons and categories
 * from the audit-image-reasons.json review.
 *
 * Also updates audit-import-ready.json to stay in sync.
 *
 * Usage: node scripts/update-ban-reasons.js
 */

import dotenv from 'dotenv';
dotenv.config();

import pool from '../utils/db.js';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const reviewedPath = join(PROJECT_ROOT, 'audit-image-reasons.json');
const importReadyPath = join(PROJECT_ROOT, 'audit-import-ready.json');

async function main() {
    const reviewed = JSON.parse(readFileSync(reviewedPath, 'utf8'));
    const importData = JSON.parse(readFileSync(importReadyPath, 'utf8'));

    // Build lookup: user_id -> { reason, category } from reviewed entries
    // Use the LAST entry per user_id (most recent review takes precedence)
    const reviewedLookup = new Map();
    for (const entry of reviewed.entries) {
        reviewedLookup.set(entry.user_id, {
            reason: entry.reason,
            category: entry.category
        });
    }

    console.log(`Reviewed entries: ${reviewed.entries.length}`);
    console.log(`Unique user IDs with reviews: ${reviewedLookup.size}`);
    console.log(`Import-ready rows: ${importData.rows.length}\n`);

    // 1. Update audit-import-ready.json
    let importUpdated = 0;
    for (const row of importData.rows) {
        const review = reviewedLookup.get(row.user_id);
        if (review) {
            if (row.reason !== review.reason || row.category !== review.category) {
                row.reason = review.reason;
                row.category = review.category;
                importUpdated++;
            }
        }
    }
    writeFileSync(importReadyPath, JSON.stringify(importData, null, 2));
    console.log(`Updated ${importUpdated} rows in audit-import-ready.json`);

    // 2. Update database entries
    const validCategories = ['phishing', 'scam', 'spam', 'raid', 'harassment', 'selfbot', 'mass_dm', 'impersonation', 'other'];

    let dbUpdated = 0;
    let dbNotFound = 0;
    let dbErrors = 0;

    for (const [userId, review] of reviewedLookup) {
        const category = validCategories.includes(review.category) ? review.category : 'other';

        try {
            const [result] = await pool.execute(
                `UPDATE global_ban_entries
                 SET reason = ?, category = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = ? AND active = 1`,
                [review.reason, category, userId]
            );

            if (result.affectedRows > 0) {
                dbUpdated++;
            } else {
                dbNotFound++;
            }
        } catch (err) {
            console.error(`  Error updating ${userId}: ${err.message}`);
            dbErrors++;
        }
    }

    console.log(`\n=== Database Update Complete ===`);
    console.log(`  Updated: ${dbUpdated}`);
    console.log(`  Not found (not yet imported): ${dbNotFound}`);
    console.log(`  Errors: ${dbErrors}`);

    if (dbNotFound > 0) {
        console.log(`\n${dbNotFound} entries not in DB yet. Run "node scripts/import-global-bans.js" to import them first.`);
    }

    console.log('\nNote: Run "pm2 restart CertiFriedUtility" to refresh the in-memory ban cache.');
    await pool.end();
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
