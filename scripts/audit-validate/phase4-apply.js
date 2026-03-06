/**
 * Phase 4: Apply Validated Changes
 * Reads the diff report and applies changes to the DB.
 *
 * Usage:
 *   node scripts/audit-validate/phase4-apply.js            # Dry run (preview)
 *   node scripts/audit-validate/phase4-apply.js --apply     # Apply changes
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pool from '../../utils/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../..');

const APPLY = process.argv.includes('--apply');

// Strip 4-byte UTF-8 characters (emojis) that the details column can't store
function sanitizeForLog(str) {
    return str.replace(/[\u{10000}-\u{10FFFF}]/gu, '?');
}

async function main() {
    console.log(`\n=== Phase 4: Apply Changes ${APPLY ? '(LIVE)' : '(DRY RUN)'} ===\n`);

    // Load report
    const reportPath = join(PROJECT_ROOT, 'audit-validation-report.json');
    let report;
    try {
        report = JSON.parse(readFileSync(reportPath, 'utf8'));
    } catch (err) {
        console.error(`Cannot read ${reportPath}: ${err.message}`);
        console.error('Run phases 1-3 first: node scripts/audit-validate/index.js');
        process.exit(1);
    }

    console.log('Report summary:');
    console.log(`  Updates:  ${report.summary.updates}`);
    console.log(`  Inserts:  ${report.summary.inserts}`);
    console.log(`  Flagged:  ${report.summary.flagged}`);
    console.log(`  Orphans:  ${report.summary.orphans}`);

    if (!APPLY) {
        console.log('\nDRY RUN — showing what would change:\n');
        printPreview(report);
        console.log('\nTo apply these changes, run:');
        console.log('  node scripts/audit-validate/phase4-apply.js --apply');
        await pool.end();
        return;
    }

    // Apply in a transaction
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        let updated = 0;
        let inserted = 0;
        let flaggedMarked = 0;

        // Apply updates
        for (const entry of report.updates) {
            const sets = [];
            const params = [];

            for (const [field, change] of Object.entries(entry.changes)) {
                sets.push(`${field} = ?`);
                params.push(change.new);
            }

            if (sets.length === 0) continue;

            params.push(entry.db_id);
            await conn.execute(
                `UPDATE global_ban_entries SET ${sets.join(', ')} WHERE id = ?`,
                params
            );

            // Log the update
            await conn.execute(
                `INSERT INTO global_ban_action_log (global_ban_entry_id, guild_id, user_id, action, performed_by, details)
                 VALUES (?, 'system', ?, 'entry_updated', 'audit_validate', ?)`,
                [entry.db_id, entry.user_id, sanitizeForLog(JSON.stringify(entry.changes))]
            );

            updated++;
        }

        // Apply inserts
        for (const entry of report.inserts) {
            const [result] = await conn.execute(
                `INSERT INTO global_ban_entries (user_id, username, severity, category, reason, evidence, source, verified, active)
                 VALUES (?, ?, ?, ?, ?, ?, 'manual_report', 1, 1)`,
                [
                    entry.user_id,
                    entry.username || null,
                    entry.severity || 'high',
                    entry.category || 'other',
                    entry.reason || 'Reported in audit channel',
                    entry.evidence || null,
                ]
            );

            await conn.execute(
                `INSERT INTO global_ban_action_log (global_ban_entry_id, guild_id, user_id, action, performed_by, details)
                 VALUES (?, 'system', ?, 'entry_created', 'audit_validate', ?)`,
                [result.insertId, entry.user_id, `New entry from audit validation`]
            );

            inserted++;
        }

        // Flag bad ID entries (don't auto-remove, just mark inactive)
        for (const entry of report.flagged) {
            if (entry.current_db) {
                await conn.execute(
                    `UPDATE global_ban_entries SET active = 0 WHERE user_id = ?`,
                    [entry.user_id]
                );

                await conn.execute(
                    `INSERT INTO global_ban_action_log (global_ban_entry_id, guild_id, user_id, action, performed_by, details)
                     VALUES (?, 'system', ?, 'entry_removed', 'audit_validate', ?)`,
                    [entry.current_db.id, entry.user_id, `Flagged: ${entry.flag_reason}`]
                );

                flaggedMarked++;
            }
        }

        // Deactivate orphan entries (in DB but not in any channel scrape)
        let orphansDeactivated = 0;
        for (const entry of report.orphans) {
            await conn.execute(
                `UPDATE global_ban_entries SET active = 0 WHERE id = ? AND active = 1`,
                [entry.db_id]
            );

            await conn.execute(
                `INSERT INTO global_ban_action_log (global_ban_entry_id, guild_id, user_id, action, performed_by, details)
                 VALUES (?, 'system', ?, 'entry_removed', 'audit_validate', ?)`,
                [entry.db_id, entry.user_id, `Orphan: in DB but not found in channel scrape`]
            );

            orphansDeactivated++;
        }

        await conn.commit();
        console.log(`\nChanges applied successfully:`);
        console.log(`  Updated: ${updated}`);
        console.log(`  Inserted: ${inserted}`);
        console.log(`  Flagged/deactivated: ${flaggedMarked}`);
        console.log(`  Orphans deactivated: ${orphansDeactivated}`);

    } catch (err) {
        await conn.rollback();
        console.error('Transaction failed, rolled back:', err.message);
        throw err;
    } finally {
        conn.release();
        await pool.end();
    }
}

function printPreview(report) {
    if (report.updates.length > 0) {
        console.log('UPDATES:');
        for (const u of report.updates) {
            console.log(`  [${u.user_id}]`);
            for (const [field, change] of Object.entries(u.changes)) {
                const oldVal = typeof change.old === 'string' && change.old.length > 60
                    ? change.old.slice(0, 57) + '...' : change.old;
                const newVal = typeof change.new === 'string' && change.new.length > 60
                    ? change.new.slice(0, 57) + '...' : change.new;
                console.log(`    ${field}: "${oldVal}" → "${newVal}"`);
            }
        }
    }

    if (report.inserts.length > 0) {
        console.log('\nINSERTS:');
        for (const i of report.inserts) {
            console.log(`  [${i.user_id}] ${i.username || '?'} — ${i.category}: ${(i.reason || '').slice(0, 60)}`);
        }
    }

    if (report.flagged.length > 0) {
        console.log('\nFLAGGED (will deactivate if in DB):');
        for (const f of report.flagged) {
            console.log(`  [${f.user_id}] ${f.flag_reason} ${f.current_db ? '← IN DB' : ''}`);
        }
    }

    if (report.orphans.length > 0) {
        console.log('\nORPHANS (in DB, not in scrape — no action taken):');
        for (const o of report.orphans) {
            console.log(`  [${o.user_id}] ${o.username || '?'} — source: ${o.source}`);
        }
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
