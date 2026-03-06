/**
 * One-time scan of existing guild members against the global ban list.
 * Uses the correct bot token per guild (main or custom).
 *
 * Actions follow the configured severity levels:
 *   critical=ban, high=kick, medium=alert, low=alert
 *
 * Usage:
 *   node scripts/scan-existing-members.js            # Dry run (shows what would happen)
 *   node scripts/scan-existing-members.js --apply     # Execute actions
 */

import { REST, Routes } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import dotenv from 'dotenv';
dotenv.config();

const APPLY = process.argv.includes('--apply');

// Action config matches global-ban-manager.js defaults
function getAction(severity, config) {
    switch (severity) {
        case 'critical': return config.action_critical || 'ban';
        case 'high': return config.action_high || 'kick';
        case 'medium': return config.action_medium || 'alert';
        case 'low': return config.action_low || 'alert';
        default: return 'alert';
    }
}

async function main() {
    console.log(`\n=== Scan Existing Members ${APPLY ? '(LIVE)' : '(DRY RUN)'} ===\n`);

    // Load ban list
    const [banEntries] = await pool.execute(
        'SELECT id, user_id, severity, category, reason FROM global_ban_entries WHERE active = 1'
    );
    const banMap = new Map(banEntries.map(e => [e.user_id, e]));
    console.log(`Loaded ${banMap.size} active global ban entries`);

    // Load enabled guild configs
    const [configs] = await pool.execute('SELECT * FROM global_ban_config WHERE enabled = 1');
    console.log(`Found ${configs.length} guilds with global bans enabled\n`);

    // Get bot tokens per guild
    const [mappings] = await pool.execute('SELECT bot_id, guild_id FROM guild_bot_mapping');
    const [customBots] = await pool.execute('SELECT bot_id, bot_name, bot_token FROM custom_bots');

    const botTokenMap = new Map();
    const botNameMap = new Map();
    for (const bot of customBots) {
        try {
            const token = encryption.decrypt(JSON.parse(bot.bot_token));
            botTokenMap.set(bot.bot_id, token);
            botNameMap.set(bot.bot_id, bot.bot_name);
        } catch (e) {
            console.error(`Failed to decrypt token for ${bot.bot_name}: ${e.message}`);
        }
    }

    const guildBotMap = new Map();
    for (const m of mappings) {
        guildBotMap.set(m.guild_id, m.bot_id);
    }

    const mainToken = process.env.DISCORD_TOKEN;
    const totalResults = { scanned: 0, matched: 0, actions: { ban: 0, kick: 0, alert: 0 }, errors: 0 };

    for (const config of configs) {
        const guildId = config.guild_id;
        const botId = guildBotMap.get(guildId);
        const token = botId ? botTokenMap.get(botId) : mainToken;
        const botName = botId ? (botNameMap.get(botId) || botId) : 'CertiFriedUtility (main)';

        if (!token) {
            console.log(`[${guildId}] No token available (bot: ${botName}) — skipping`);
            continue;
        }

        const rest = new REST({ version: '10' }).setToken(token);

        console.log(`[${guildId}] Scanning via ${botName}...`);

        try {
            // Fetch all members via pagination
            const members = await fetchAllMembers(rest, guildId);
            totalResults.scanned += members.length;

            // Check against ban list
            const matches = [];
            for (const member of members) {
                const ban = banMap.get(member.user.id);
                if (ban) {
                    const action = getAction(ban.severity, config);
                    matches.push({
                        userId: member.user.id,
                        username: member.user.username,
                        severity: ban.severity,
                        category: ban.category,
                        action,
                        banEntryId: ban.id,
                        reason: ban.reason,
                    });
                }
            }

            if (matches.length === 0) {
                console.log(`  ${members.length} members scanned — no matches`);
                continue;
            }

            console.log(`  ${members.length} members scanned — ${matches.length} MATCHES:`);

            for (const m of matches) {
                console.log(`    ${m.username} (${m.userId}) — ${m.severity}/${m.category} → ${m.action}`);
                totalResults.matched++;
                totalResults.actions[m.action] = (totalResults.actions[m.action] || 0) + 1;

                if (APPLY && m.action !== 'alert') {
                    try {
                        if (m.action === 'ban') {
                            await rest.put(Routes.guildBan(guildId, m.userId), {
                                body: { delete_message_seconds: 86400 },
                                reason: `Global Ban: ${m.category} (${m.severity})`,
                            });
                            console.log(`      ✓ Banned`);
                        } else if (m.action === 'kick') {
                            await rest.delete(Routes.guildMember(guildId, m.userId), {
                                reason: `Global Ban: ${m.category} (${m.severity})`,
                            });
                            console.log(`      ✓ Kicked`);
                        }

                        // Log the action
                        await pool.execute(
                            `INSERT INTO global_ban_action_log (global_ban_entry_id, guild_id, user_id, action, performed_by, details)
                             VALUES (?, ?, ?, ?, 'existing_member_scan', ?)`,
                            [m.banEntryId, guildId, m.userId, m.action, `Existing member scan: ${m.category} (${m.severity})`]
                        );
                    } catch (err) {
                        console.log(`      ✗ Failed: ${err.message}`);
                        totalResults.errors++;
                    }
                } else if (APPLY && m.action === 'alert') {
                    // Log alert-only actions
                    await pool.execute(
                        `INSERT INTO global_ban_action_log (global_ban_entry_id, guild_id, user_id, action, performed_by, details)
                         VALUES (?, ?, ?, 'alert', 'existing_member_scan', ?)`,
                        [m.banEntryId, guildId, m.userId, `Existing member scan alert: ${m.category} (${m.severity})`]
                    );
                }
            }
        } catch (err) {
            console.log(`  Error scanning guild: ${err.message}`);
            totalResults.errors++;
        }

        // Small delay between guilds to avoid rate limits
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log('\n=== Summary ===');
    console.log(`  Members scanned: ${totalResults.scanned}`);
    console.log(`  Matches found:   ${totalResults.matched}`);
    console.log(`  Actions: ban=${totalResults.actions.ban || 0}, kick=${totalResults.actions.kick || 0}, alert=${totalResults.actions.alert || 0}`);
    console.log(`  Errors: ${totalResults.errors}`);

    if (!APPLY && totalResults.matched > 0) {
        console.log('\nDRY RUN — no actions taken. Run with --apply to execute.');
    }

    await pool.end();
}

/**
 * Fetch all guild members via REST API pagination.
 */
async function fetchAllMembers(rest, guildId) {
    const allMembers = [];
    let after = '0';

    while (true) {
        const members = await rest.get(Routes.guildMembers(guildId), {
            query: new URLSearchParams({ limit: '1000', after }),
        });

        if (!members.length) break;

        // Skip bots
        allMembers.push(...members.filter(m => !m.user.bot));
        after = members[members.length - 1].user.id;

        if (members.length < 1000) break;
    }

    return allMembers;
}

main().catch(async err => {
    console.error('Fatal:', err);
    try { await pool.end(); } catch {}
    process.exit(1);
});
