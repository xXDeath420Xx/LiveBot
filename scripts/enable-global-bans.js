/**
 * Enable global ban protection for guilds that have security systems enabled.
 *
 * SAFETY: The global ban system is REACTIVE only:
 * - check_on_join: checks when a banned user JOINS the guild
 * - check_on_message: checks when a banned user SENDS a message (critical/high only)
 * - NO retroactive scanning of existing members
 * - NO mass-banning of current members
 *
 * Default actions: critical=ban, high=kick, medium=alert, low=alert
 *
 * Usage:
 *   node scripts/enable-global-bans.js            # Dry run
 *   node scripts/enable-global-bans.js --apply     # Apply
 */

import pool from '../utils/db.js';

const APPLY = process.argv.includes('--apply');

// Safe defaults — conservative actions, no auto-aggregate
const DEFAULTS = {
    enabled: 1,
    action_critical: 'ban',
    action_high: 'kick',
    action_medium: 'alert',
    action_low: 'alert',
    log_actions: 1,
    check_on_join: 1,
    check_on_message: 1,
    auto_aggregate_opt_in: 0,
};

async function main() {
    console.log(`\n=== Enable Global Ban Protection ${APPLY ? '(LIVE)' : '(DRY RUN)'} ===\n`);

    // Gather all guilds with ANY security system enabled
    const securityTables = [
        { name: 'anti_nuke_config', col: 'enabled' },
        { name: 'automod_spam_config', col: 'enabled' },
        { name: 'phishing_config', col: 'enabled' },
        { name: 'adaptive_spam_config', col: 'enabled' },
        { name: 'raid_detection_config', col: 'enabled' },
        { name: 'raid_protection_config', col: 'enabled' },
        { name: 'anti_raid_config', col: 'is_enabled' },
        { name: 'automod_heat_config', col: 'is_enabled' },
        { name: 'quarantine_config', col: 'is_enabled' },
    ];

    const guildSystems = new Map();

    for (const t of securityTables) {
        try {
            const [rows] = await pool.execute(`SELECT guild_id FROM ${t.name} WHERE ${t.col} = 1`);
            for (const r of rows) {
                if (!guildSystems.has(r.guild_id)) guildSystems.set(r.guild_id, []);
                guildSystems.get(r.guild_id).push(t.name.replace('_config', ''));
            }
        } catch {
            // Table might not exist or have different schema
        }
    }

    // Get bot mappings for context
    const [mappings] = await pool.execute('SELECT bot_id, guild_id FROM guild_bot_mapping');
    const [bots] = await pool.execute('SELECT bot_id, bot_name FROM custom_bots');
    const botNameMap = new Map(bots.map(b => [b.bot_id, b.bot_name]));
    const guildBots = new Map();
    for (const m of mappings) {
        guildBots.set(m.guild_id, botNameMap.get(m.bot_id) || m.bot_id);
    }

    // Check which guilds already have global ban config
    const [existing] = await pool.execute('SELECT guild_id, enabled FROM global_ban_config');
    const existingMap = new Map(existing.map(e => [e.guild_id, e.enabled]));

    console.log(`Found ${guildSystems.size} guilds with security systems enabled\n`);

    const toEnable = [];
    const alreadyEnabled = [];
    const toUpdate = [];

    for (const [guildId, systems] of [...guildSystems.entries()].sort((a, b) => b.length - a.length)) {
        const botName = guildBots.get(guildId) || 'CertiFriedUtility (main)';
        const existingEnabled = existingMap.get(guildId);

        if (existingEnabled === 1) {
            alreadyEnabled.push({ guildId, botName, systems });
        } else if (existingEnabled === 0) {
            toUpdate.push({ guildId, botName, systems });
        } else {
            toEnable.push({ guildId, botName, systems });
        }
    }

    // Print plan
    if (toEnable.length > 0) {
        console.log('NEW — will insert global_ban_config:');
        for (const g of toEnable) {
            console.log(`  ${g.guildId} | ${g.botName} | ${g.systems.length} systems: ${g.systems.join(', ')}`);
        }
    }

    if (toUpdate.length > 0) {
        console.log('\nDISABLED — will re-enable:');
        for (const g of toUpdate) {
            console.log(`  ${g.guildId} | ${g.botName} | ${g.systems.length} systems: ${g.systems.join(', ')}`);
        }
    }

    if (alreadyEnabled.length > 0) {
        console.log('\nALREADY ENABLED — no action:');
        for (const g of alreadyEnabled) {
            console.log(`  ${g.guildId} | ${g.botName}`);
        }
    }

    console.log(`\nSummary: ${toEnable.length} new, ${toUpdate.length} re-enable, ${alreadyEnabled.length} already enabled`);
    console.log(`\nDefault actions: critical=ban, high=kick, medium=alert, low=alert`);
    console.log(`check_on_join=YES, check_on_message=YES (critical/high only), auto_aggregate=NO`);

    if (!APPLY) {
        console.log('\nDRY RUN — no changes made. Run with --apply to enable.');
        await pool.end();
        return;
    }

    // Apply
    let inserted = 0;
    let updated = 0;

    for (const g of toEnable) {
        await pool.execute(
            `INSERT INTO global_ban_config (guild_id, enabled, action_critical, action_high, action_medium, action_low, log_actions, check_on_join, check_on_message, auto_aggregate_opt_in)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [g.guildId, DEFAULTS.enabled, DEFAULTS.action_critical, DEFAULTS.action_high, DEFAULTS.action_medium, DEFAULTS.action_low, DEFAULTS.log_actions, DEFAULTS.check_on_join, DEFAULTS.check_on_message, DEFAULTS.auto_aggregate_opt_in]
        );
        inserted++;
    }

    for (const g of toUpdate) {
        await pool.execute(
            'UPDATE global_ban_config SET enabled = 1 WHERE guild_id = ?',
            [g.guildId]
        );
        updated++;
    }

    console.log(`\nApplied: ${inserted} inserted, ${updated} re-enabled`);
    await pool.end();
}

main().catch(async err => {
    console.error('Fatal:', err);
    try { await pool.end(); } catch {}
    process.exit(1);
});
