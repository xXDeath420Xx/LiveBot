/**
 * Global Ban Audit - Full Validation & Re-scrape
 * Orchestrates phases 1-3 of the audit validation pipeline.
 *
 * Phase 1: Fresh channel scrape with full content
 * Phase 2: Cross-reference & validate all entries
 * Phase 3: Generate diff report vs current DB
 *
 * Phase 4 (apply) is run separately:
 *   node scripts/audit-validate/phase4-apply.js [--apply]
 *
 * Usage:
 *   BOT_TOKEN="your_auditbot_token" node scripts/audit-validate/index.js
 */

import { REST } from 'discord.js';
import { runPhase1 } from './phase1-scrape.js';
import { runPhase2 } from './phase2-validate.js';
import { runPhase3 } from './phase3-report.js';
import pool from '../../utils/db.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error('Missing BOT_TOKEN environment variable');
    console.error('Usage: BOT_TOKEN="your_auditbot_token" node scripts/audit-validate/index.js');
    process.exit(1);
}

async function main() {
    console.log('Global Ban Audit — Full Validation Pipeline');
    console.log('=============================================\n');

    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

    // Phase 1: Scrape channels
    const { offenders } = await runPhase1(rest);

    // Phase 2: Validate & enrich
    const { validated } = await runPhase2(rest, offenders);

    // Phase 3: Diff against DB
    const { report } = await runPhase3(validated);

    // Summary
    console.log('\n=============================================');
    console.log('Pipeline complete. Review audit-validation-report.json');
    console.log('\nTo apply changes:');
    console.log('  node scripts/audit-validate/phase4-apply.js            # Dry run');
    console.log('  node scripts/audit-validate/phase4-apply.js --apply    # Apply');

    await pool.end();
}

main().catch(async err => {
    console.error('Fatal error:', err);
    try { await pool.end(); } catch {}
    process.exit(1);
});
