/**
 * Phase 3: Diff Report
 * Compares validated data from phase 2 against current DB state.
 * Produces a structured report of all needed changes.
 *
 * Output: audit-validation-report.json
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pool from '../../utils/db.js';
import { generateDiff } from './lib/differ.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../..');

/**
 * Run phase 3: generate diff report between validated entries and DB.
 * @param {Array} validated - Validated entries from phase 2
 * @returns {Object} { report, outputPath }
 */
export async function runPhase3(validated) {
    console.log('\n=== Phase 3: Diff Report ===\n');

    // Fetch current DB state
    const [dbEntries] = await pool.execute(
        'SELECT id, user_id, username, severity, category, reason, evidence, source, reporter_id, reporter_name, active FROM global_ban_entries'
    );
    console.log(`Loaded ${dbEntries.length} entries from global_ban_entries`);

    // Generate diff
    const report = generateDiff(validated, dbEntries);

    // Print summary
    console.log('\nDiff Summary:');
    console.log(`  Updates needed:   ${report.summary.updates}`);
    console.log(`  New inserts:      ${report.summary.inserts}`);
    console.log(`  Orphans (DB only): ${report.summary.orphans}`);
    console.log(`  Flagged (bad ID):  ${report.summary.flagged}`);
    console.log(`  Unchanged:        ${report.summary.unchanged}`);

    // Print detailed changes
    if (report.updates.length > 0) {
        console.log('\nUpdates:');
        for (const u of report.updates.slice(0, 10)) {
            const fields = Object.keys(u.changes).join(', ');
            console.log(`  ${u.user_id}: ${fields}`);
        }
        if (report.updates.length > 10) {
            console.log(`  ... and ${report.updates.length - 10} more`);
        }
    }

    if (report.flagged.length > 0) {
        console.log('\nFlagged entries:');
        for (const f of report.flagged) {
            console.log(`  ${f.user_id}: ${f.flag_reason}${f.current_db ? ' (exists in DB)' : ''}`);
        }
    }

    if (report.orphans.length > 0) {
        console.log('\nOrphans (in DB, not in channel scrape):');
        for (const o of report.orphans) {
            console.log(`  ${o.user_id} (${o.username || 'no username'}) — source: ${o.source}`);
        }
    }

    // Write report
    const outputPath = join(PROJECT_ROOT, 'audit-validation-report.json');
    writeFileSync(outputPath, JSON.stringify({
        generated: new Date().toISOString(),
        ...report,
    }, null, 2));

    console.log(`\nPhase 3 complete — report written to ${outputPath}`);
    return { report, outputPath };
}
