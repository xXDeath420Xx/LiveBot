/**
 * Setup script for "the Forsaken Warriors" (guild 1469931133981687873)
 *
 * Replicates the full security stack currently configured for
 * "Welcome to The Pac!" (guild 1099732505243959407): anti-nuke, anti-raid,
 * anti-phishing, adaptive spam, selfbot detection, invite/link filter,
 * global-ban subscription, moderation logging, and full audit logging.
 *
 * What this script does:
 *   1. Hits Discord's REST API directly (no gateway connection — does not
 *      contest PM2's running bot session).
 *   2. Pre-flight: confirms bot is in the target guild and has ManageChannels
 *      + ManageRoles. Aborts cleanly otherwise.
 *   3. Finds or creates a `#mod-log` text channel (private; @everyone denied
 *      ViewChannel, bot allowed ViewChannel + SendMessages + EmbedLinks).
 *   4. Finds or creates a `Muted` role (no permissions; admin must apply
 *      per-channel SendMessages overwrites manually if mute-via-role behavior
 *      is desired).
 *   5. Upserts 9 config rows (anti_nuke, raid_detection, phishing,
 *      invite_filter, selfbot_detection, global_ban, moderation,
 *      adaptive_spam, logging) with the source guild's thresholds and
 *      actions, but with alert/log channels rewritten to the new mod-log
 *      channel and muted_role_id rewritten to the new Muted role.
 *   6. Copies all 32 log_event_config rows from the source guild, rewriting
 *      log_channel_id to the new mod-log channel.
 *   7. Prints a verification block and reminds the operator that managers'
 *      TTL caches take ~60s to expire; pm2 restart for instant pickup.
 *
 * Idempotent — safe to re-run. Channel/role lookups happen by name before
 * creation, and every DB write uses INSERT ... ON DUPLICATE KEY UPDATE.
 *
 * NOTE: Re-running rewrites alert_channel_id back to the discovered
 * mod-log channel. If you customize that field in the dashboard later,
 * don't re-run this script unless you want to revert to script defaults.
 *
 * Usage:
 *   node scripts/setup-guild-1469931133981687873.js
 *
 * Safe to run while PM2 is up — REST-only, no gateway session.
 */
import dotenv from 'dotenv';
dotenv.config();
import { REST, Routes, ChannelType, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';

const SOURCE_GUILD_ID = '1099732505243959407';
const TARGET_GUILD_ID = '1469931133981687873';
const MOD_LOG_NAME_RE = /^(mod-?log|moderator-?log|audit-?log|mod-actions|server-log)$/i;
const MUTED_ROLE_NAME_RE = /^muted$/i;

const ADMIN_BIT = PermissionFlagsBits.Administrator; // 0x8

function hr(label) {
    console.log(`\n═══ ${label} ${'═'.repeat(Math.max(0, 60 - label.length))}`);
}

async function fetchOne(sql, params) {
    const [rows] = await pool.execute(sql, params);
    return rows[0] || null;
}

async function fetchAll(sql, params) {
    const [rows] = await pool.execute(sql, params);
    return rows;
}

function computeMemberPermissions(botMember, roles, ownerId) {
    if (botMember.user?.id === ownerId) return ~0n; // owner has all
    let bits = 0n;
    for (const roleId of botMember.roles) {
        const r = roles.find(rr => rr.id === roleId);
        if (r) bits |= BigInt(r.permissions);
    }
    // The @everyone role permissions also apply.
    const everyone = roles.find(r => r.id === botMember.guild_id || r.name === '@everyone');
    if (everyone) bits |= BigInt(everyone.permissions);
    if ((bits & ADMIN_BIT) === ADMIN_BIT) return ~0n;
    return bits;
}

async function preflight(rest, botUserId) {
    // Fetch guild + roles + bot member in parallel.
    const [guild, roles, botMember] = await Promise.all([
        rest.get(Routes.guild(TARGET_GUILD_ID)),
        rest.get(Routes.guildRoles(TARGET_GUILD_ID)),
        rest.get(Routes.guildMember(TARGET_GUILD_ID, botUserId)),
    ]);

    botMember.guild_id = TARGET_GUILD_ID; // attach for permission compute
    const everyone = roles.find(r => r.id === TARGET_GUILD_ID); // @everyone has the guild's id
    if (everyone) botMember.roles = [...new Set([...botMember.roles, everyone.id])];

    const perms = computeMemberPermissions(botMember, roles, guild.owner_id);
    const need = [
        ['ManageChannels', PermissionFlagsBits.ManageChannels],
        ['ManageRoles', PermissionFlagsBits.ManageRoles],
        ['ViewAuditLog', PermissionFlagsBits.ViewAuditLog],
    ];
    const missing = need.filter(([, flag]) => (perms & flag) !== flag).map(([name]) => name);
    if (missing.length) {
        throw new Error(`Bot is missing required permissions in target guild: ${missing.join(', ')}`);
    }
    console.log(`  ✓ Bot has ManageChannels, ManageRoles, ViewAuditLog`);
    console.log(`  Target: ${guild.name} (${guild.id}) — owner ${guild.owner_id}`);
    return { guild, roles };
}

async function findOrCreateModLog(rest, botUserId) {
    const channels = await rest.get(Routes.guildChannels(TARGET_GUILD_ID));
    const existing = channels.find(
        c => c.type === ChannelType.GuildText && MOD_LOG_NAME_RE.test(c.name)
    );
    if (existing) {
        console.log(`  ↺ Reusing existing channel #${existing.name} (${existing.id})`);
        console.log(`    Verify its permissions match your intent — script did NOT retighten overwrites.`);
        return { id: existing.id, name: existing.name, created: false };
    }

    const created = await rest.post(Routes.guildChannels(TARGET_GUILD_ID), {
        body: {
            name: 'mod-log',
            type: ChannelType.GuildText,
            topic: 'Bot security alerts and audit log.',
            permission_overwrites: [
                {
                    id: TARGET_GUILD_ID, // @everyone role id
                    type: 0, // role
                    allow: '0',
                    deny: String(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages),
                },
                {
                    id: botUserId,
                    type: 1, // member
                    allow: String(
                        PermissionFlagsBits.ViewChannel |
                        PermissionFlagsBits.SendMessages |
                        PermissionFlagsBits.EmbedLinks |
                        PermissionFlagsBits.AttachFiles |
                        PermissionFlagsBits.ReadMessageHistory
                    ),
                    deny: '0',
                },
            ],
        },
        reason: 'CertiFried setup: dedicated security/audit log channel',
    });
    console.log(`  ✓ Created #${created.name} (${created.id}) — private to admins + bot`);
    return { id: created.id, name: created.name, created: true };
}

async function findOrCreateMutedRole(rest) {
    const roles = await rest.get(Routes.guildRoles(TARGET_GUILD_ID));
    const existing = roles.find(r => MUTED_ROLE_NAME_RE.test(r.name));
    if (existing) {
        console.log(`  ↺ Reusing existing role @${existing.name} (${existing.id})`);
        return { id: existing.id, name: existing.name, created: false };
    }

    const created = await rest.post(Routes.guildRoles(TARGET_GUILD_ID), {
        body: {
            name: 'Muted',
            color: 0x5C5C5C,
            hoist: false,
            mentionable: false,
            permissions: '0',
        },
        reason: 'CertiFried setup: muted-role placeholder for moderation_config',
    });
    console.log(`  ✓ Created @${created.name} (${created.id}) — NO channel overwrites applied`);
    return { id: created.id, name: created.name, created: true };
}

async function seedConfigs(alertChannelId, mutedRoleId) {
    // Read source enabled_events JSON for logging_config — verbatim copy.
    const srcLogging = await fetchOne(
        'SELECT enabled_events FROM logging_config WHERE guild_id = ?',
        [SOURCE_GUILD_ID]
    );
    const enabledEvents = srcLogging?.enabled_events ?? '[]';

    await pool.execute(
        `INSERT INTO anti_nuke_config
            (guild_id, enabled, max_channel_deletes, max_role_deletes, max_kick_bans, action_on_trigger, alert_channel_id)
         VALUES (?, 1, 3, 3, 5, 'strip_roles', ?)
         ON DUPLICATE KEY UPDATE
            enabled = VALUES(enabled),
            max_channel_deletes = VALUES(max_channel_deletes),
            max_role_deletes = VALUES(max_role_deletes),
            max_kick_bans = VALUES(max_kick_bans),
            action_on_trigger = VALUES(action_on_trigger),
            alert_channel_id = VALUES(alert_channel_id)`,
        [TARGET_GUILD_ID, alertChannelId]
    );
    console.log('  ✓ anti_nuke_config');

    await pool.execute(
        `INSERT INTO raid_detection_config
            (guild_id, enabled, join_threshold, join_timeframe_seconds,
             new_account_age_hours, new_account_ratio, action,
             alert_channel_id, mute_duration_minutes, purge_messages)
         VALUES (?, 1, 10, 30, 24, 0.50, 'mute', ?, 60, 1)
         ON DUPLICATE KEY UPDATE
            enabled = VALUES(enabled),
            join_threshold = VALUES(join_threshold),
            join_timeframe_seconds = VALUES(join_timeframe_seconds),
            new_account_age_hours = VALUES(new_account_age_hours),
            new_account_ratio = VALUES(new_account_ratio),
            action = VALUES(action),
            alert_channel_id = VALUES(alert_channel_id),
            mute_duration_minutes = VALUES(mute_duration_minutes),
            purge_messages = VALUES(purge_messages)`,
        [TARGET_GUILD_ID, alertChannelId]
    );
    console.log('  ✓ raid_detection_config');

    await pool.execute(
        `INSERT INTO phishing_config
            (guild_id, enabled, action, mute_duration_minutes,
             alert_channel_id, whitelist_domains, log_detections,
             exempt_channels, report_channel_id)
         VALUES (?, 1, 'delete', 60, ?, NULL, 1, NULL, ?)
         ON DUPLICATE KEY UPDATE
            enabled = VALUES(enabled),
            action = VALUES(action),
            mute_duration_minutes = VALUES(mute_duration_minutes),
            alert_channel_id = VALUES(alert_channel_id),
            whitelist_domains = VALUES(whitelist_domains),
            log_detections = VALUES(log_detections),
            exempt_channels = VALUES(exempt_channels),
            report_channel_id = VALUES(report_channel_id)`,
        [TARGET_GUILD_ID, alertChannelId, alertChannelId]
    );
    console.log('  ✓ phishing_config');

    await pool.execute(
        `INSERT INTO invite_filter_config
            (guild_id, enabled, use_whitelist, action, log_channel_id)
         VALUES (?, 1, 0, 'delete_warn', ?)
         ON DUPLICATE KEY UPDATE
            enabled = VALUES(enabled),
            use_whitelist = VALUES(use_whitelist),
            action = VALUES(action),
            log_channel_id = VALUES(log_channel_id)`,
        [TARGET_GUILD_ID, alertChannelId]
    );
    console.log('  ✓ invite_filter_config');

    await pool.execute(
        `INSERT INTO selfbot_detection_config
            (guild_id, enabled, min_response_time_ms, message_burst_threshold,
             message_burst_window_ms, pattern_threshold, action,
             alert_channel_id, exempt_roles)
         VALUES (?, 1, 300, 6, 2000, 4, 'mute', ?, NULL)
         ON DUPLICATE KEY UPDATE
            enabled = VALUES(enabled),
            min_response_time_ms = VALUES(min_response_time_ms),
            message_burst_threshold = VALUES(message_burst_threshold),
            message_burst_window_ms = VALUES(message_burst_window_ms),
            pattern_threshold = VALUES(pattern_threshold),
            action = VALUES(action),
            alert_channel_id = VALUES(alert_channel_id),
            exempt_roles = VALUES(exempt_roles)`,
        [TARGET_GUILD_ID, alertChannelId]
    );
    console.log('  ✓ selfbot_detection_config');

    await pool.execute(
        `INSERT INTO global_ban_config
            (guild_id, enabled, action_critical, action_high, action_medium, action_low,
             alert_channel_id, log_actions, check_on_join, check_on_message,
             auto_aggregate_opt_in, exempt_roles)
         VALUES (?, 1, 'ban', 'ban', 'kick', 'alert', ?, 1, 1, 0, 1, NULL)
         ON DUPLICATE KEY UPDATE
            enabled = VALUES(enabled),
            action_critical = VALUES(action_critical),
            action_high = VALUES(action_high),
            action_medium = VALUES(action_medium),
            action_low = VALUES(action_low),
            alert_channel_id = VALUES(alert_channel_id),
            log_actions = VALUES(log_actions),
            check_on_join = VALUES(check_on_join),
            check_on_message = VALUES(check_on_message),
            auto_aggregate_opt_in = VALUES(auto_aggregate_opt_in),
            exempt_roles = VALUES(exempt_roles)`,
        [TARGET_GUILD_ID, alertChannelId]
    );
    console.log('  ✓ global_ban_config');

    await pool.execute(
        `INSERT INTO moderation_config (guild_id, mod_log_channel_id, muted_role_id)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
            mod_log_channel_id = VALUES(mod_log_channel_id),
            muted_role_id = VALUES(muted_role_id)`,
        [TARGET_GUILD_ID, alertChannelId, mutedRoleId]
    );
    console.log('  ✓ moderation_config');

    await pool.execute(
        `INSERT INTO adaptive_spam_config
            (guild_id, enabled, cross_channel_threshold, cross_channel_timeframe_minutes,
             deviation_multiplier, new_account_multiplier_7d, new_account_multiplier_24h,
             action, alert_channel_id, exempt_channels)
         VALUES (?, 1, 5, 2, 3.00, 1.50, 2.00, 'delete+warn', ?, NULL)
         ON DUPLICATE KEY UPDATE
            enabled = VALUES(enabled),
            cross_channel_threshold = VALUES(cross_channel_threshold),
            cross_channel_timeframe_minutes = VALUES(cross_channel_timeframe_minutes),
            deviation_multiplier = VALUES(deviation_multiplier),
            new_account_multiplier_7d = VALUES(new_account_multiplier_7d),
            new_account_multiplier_24h = VALUES(new_account_multiplier_24h),
            action = VALUES(action),
            alert_channel_id = VALUES(alert_channel_id),
            exempt_channels = VALUES(exempt_channels)`,
        [TARGET_GUILD_ID, alertChannelId]
    );
    console.log('  ✓ adaptive_spam_config');

    await pool.execute(
        `INSERT INTO logging_config (guild_id, log_channel_id, enabled_events, enabled)
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
            log_channel_id = VALUES(log_channel_id),
            enabled_events = VALUES(enabled_events),
            enabled = VALUES(enabled)`,
        [TARGET_GUILD_ID, alertChannelId, enabledEvents]
    );
    console.log('  ✓ logging_config');

    const srcEvents = await fetchAll(
        'SELECT event_type, enabled, embed_color FROM log_event_config WHERE guild_id = ? ORDER BY event_type',
        [SOURCE_GUILD_ID]
    );
    let inserted = 0;
    for (const ev of srcEvents) {
        await pool.execute(
            `INSERT INTO log_event_config (guild_id, event_type, enabled, log_channel_id, embed_color)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                log_channel_id = VALUES(log_channel_id),
                embed_color = VALUES(embed_color)`,
            [TARGET_GUILD_ID, ev.event_type, ev.enabled, alertChannelId, ev.embed_color]
        );
        inserted++;
    }
    console.log(`  ✓ log_event_config — replayed ${inserted} per-event rows (all routed to mod-log)`);
}

async function verify(alertChannelId, mutedRoleId) {
    const tables = [
        'anti_nuke_config', 'raid_detection_config', 'phishing_config',
        'invite_filter_config', 'selfbot_detection_config', 'global_ban_config',
        'moderation_config', 'adaptive_spam_config', 'logging_config',
    ];
    for (const t of tables) {
        const row = await fetchOne(`SELECT COUNT(*) AS n FROM ${t} WHERE guild_id = ?`, [TARGET_GUILD_ID]);
        const n = row?.n ?? 0;
        console.log(`  ${n === 1 ? '✓' : '✗'} ${t.padEnd(28)} rows = ${n}`);
    }
    const evRow = await fetchOne(
        'SELECT COUNT(*) AS n FROM log_event_config WHERE guild_id = ?',
        [TARGET_GUILD_ID]
    );
    console.log(`  ${evRow?.n > 0 ? '✓' : '✗'} log_event_config            rows = ${evRow?.n ?? 0}`);

    const an = await fetchOne(
        'SELECT alert_channel_id FROM anti_nuke_config WHERE guild_id = ?',
        [TARGET_GUILD_ID]
    );
    console.log(`  ${an?.alert_channel_id === alertChannelId ? '✓' : '✗'} anti_nuke_config.alert_channel_id matches mod-log`);
    const mod = await fetchOne(
        'SELECT muted_role_id FROM moderation_config WHERE guild_id = ?',
        [TARGET_GUILD_ID]
    );
    console.log(`  ${mod?.muted_role_id === mutedRoleId ? '✓' : '✗'} moderation_config.muted_role_id matches Muted role`);
}

async function main() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error('DISCORD_TOKEN missing in env');

    const rest = new REST({ version: '10' }).setToken(token);

    // Resolve bot's own user id (no gateway needed).
    const me = await rest.get(Routes.user('@me'));
    console.log(`Authenticated as ${me.username}#${me.discriminator || ''} (${me.id})`);

    try {
        hr('PHASE 1 — PRE-FLIGHT');
        await preflight(rest, me.id);

        hr('PHASE 1b — DISCOVER OR CREATE INFRASTRUCTURE');
        const modLog = await findOrCreateModLog(rest, me.id);
        const mutedRole = await findOrCreateMutedRole(rest);

        hr('PHASE 2 — SEED CONFIG ROWS');
        await seedConfigs(modLog.id, mutedRole.id);

        hr('PHASE 3 — VERIFICATION');
        await verify(modLog.id, mutedRole.id);

        hr('SUMMARY');
        console.log(`  mod-log channel: ${modLog.id} (${modLog.created ? 'created' : 'reused'})`);
        console.log(`  Muted role:      ${mutedRole.id} (${mutedRole.created ? 'created' : 'reused'})`);
        console.log(`\n  Restart the bot for instant cache pickup, or wait ~60s for TTLs to expire:`);
        console.log(`     pm2 restart CertiFriedUtility`);
        if (mutedRole.created) {
            console.log(`\n  ⚠  Muted role exists but has NO channel-level SendMessages overwrites.`);
            console.log(`     If you want mute-via-role to silence users, apply overwrites manually`);
            console.log(`     (or use the bot's timeout-based mute commands instead).`);
        }
    } finally {
        try { await pool.end(); } catch (_) { /* ignore */ }
    }
}

main().catch(err => {
    console.error('\nFATAL:', err && err.stack ? err.stack : err);
    process.exit(1);
});
