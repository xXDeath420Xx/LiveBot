/**
 * Setup script: YYZ Studio command restrictions + disable logging
 *
 * Locks down guild 961514092848382043 so only moderation, ticketing,
 * Steam Watcher, leveling, and rank cards remain accessible.
 *
 * - 15 commands disabled entirely (games, economy, music, cannabis, etc.)
 * - 13 commands restricted to moderators (ManageGuild)
 * - 2 commands open to everyone (level, rankcard)
 * - Logging disabled (HQ Guardian covers channel 1345462542713094185)
 *
 * Usage: node scripts/setup-yyz-restrictions.js
 */
import dotenv from 'dotenv';
dotenv.config();

import pool from '../utils/db.js';

const GUILD_ID = '961514092848382043';

// allowed=1, admin_only=1 → moderators only
const MOD_ONLY = { allowed: 1, admin_only: 1 };
// allowed=1, admin_only=0 → everyone
const EVERYONE = { allowed: 1, admin_only: 0 };
// allowed=0 → completely disabled
const DISABLED = { allowed: 0, admin_only: 0 };

const COMMANDS = {
    // ── Admin (mod-only) ──
    admin:        MOD_ONLY,
    alerts:       MOD_ONLY,
    community:    MOD_ONLY,
    integrations: MOD_ONLY,
    protection:   MOD_ONLY,
    support:      MOD_ONLY,
    systems:      MOD_ONLY,
    utilities:    MOD_ONLY,

    // ── Admin (disabled) ──
    shoutout:     DISABLED,

    // ── Community (everyone) ──
    level:        EVERYONE,
    rankcard:     EVERYONE,

    // ── Community (disabled) ──
    cannabis:     DISABLED,
    engage:       DISABLED,
    grow:         DISABLED,
    manage:       DISABLED,
    qotd:         DISABLED,
    schedule:     DISABLED,
    social:       DISABLED,

    // ── Economy / Fun / Games (disabled) ──
    economy:      DISABLED,
    fun:          DISABLED,
    arcade:       DISABLED,
    pokemon:      DISABLED,
    rpg:          DISABLED,

    // ── Info (mod-only) ──
    info:         MOD_ONLY,
    media:        MOD_ONLY,
    server:       MOD_ONLY,
    user:         MOD_ONLY,

    // ── Info (disabled) ──
    weather:      DISABLED,

    // ── Music (disabled) ──
    music:        DISABLED,

    // ── Tools (mod-only) ──
    help:         MOD_ONLY,
    ping:         MOD_ONLY,

    // ── Tools (disabled) ──
    notes:        DISABLED,
    selfcare:     DISABLED,
    tools:        DISABLED,
};

async function setup() {
    console.log(`\n=== YYZ Studio (${GUILD_ID}) — Command Restrictions ===\n`);

    // 1. Seed command restrictions
    const entries = Object.entries(COMMANDS);
    let disabled = 0, modOnly = 0, everyone = 0;

    for (const [name, opts] of entries) {
        await pool.execute(`
            INSERT INTO guild_command_restrictions (guild_id, command_name, allowed, admin_only)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE allowed = VALUES(allowed), admin_only = VALUES(admin_only)
        `, [GUILD_ID, name, opts.allowed, opts.admin_only]);

        if (!opts.allowed) disabled++;
        else if (opts.admin_only) modOnly++;
        else everyone++;
    }

    console.log(`Inserted ${entries.length} command restrictions:`);
    console.log(`  ${disabled} disabled, ${modOnly} mod-only, ${everyone} everyone\n`);

    // 2. Disable logging (HQ Guardian handles it in #📋︱all-logs)
    await pool.execute(`
        UPDATE logging_config SET enabled = 0 WHERE guild_id = ?
    `, [GUILD_ID]);
    console.log('Disabled bot logging (HQ Guardian covers #all-logs)\n');

    // Summary
    console.log('=== Summary ===');
    console.log('Disabled commands:');
    Object.entries(COMMANDS)
        .filter(([, o]) => !o.allowed)
        .forEach(([name]) => console.log(`  [x] /${name}`));

    console.log('\nMod-only commands:');
    Object.entries(COMMANDS)
        .filter(([, o]) => o.allowed && o.admin_only)
        .forEach(([name]) => console.log(`  [mod] /${name}`));

    console.log('\nEveryone commands:');
    Object.entries(COMMANDS)
        .filter(([, o]) => o.allowed && !o.admin_only)
        .forEach(([name]) => console.log(`  [all] /${name}`));

    console.log('\nRestart the bot to apply:');
    console.log('  pm2 restart CertiFriedUtility');

    await pool.end();
    process.exit(0);
}

setup().catch(err => {
    console.error('Setup failed:', err);
    process.exit(1);
});
