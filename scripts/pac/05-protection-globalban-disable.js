// Phases N, O, P — protection stack, global ban, disable minigames + starboard.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GUILD_ID, createPool, connectClient, getGuild, log } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'pac-state.json'), 'utf8'));

async function phaseN(ctx) {
    log('N', 'Enabling protection stack');
    const modLog = state.channels.modLog;

    // Anti-nuke
    await ctx.pool.execute(`
        INSERT INTO anti_nuke_config (guild_id, enabled, max_channel_deletes, max_role_deletes, max_kick_bans, action_on_trigger, alert_channel_id)
        VALUES (?, 1, 3, 3, 5, 'strip_roles', ?)
        ON DUPLICATE KEY UPDATE enabled=1, max_channel_deletes=VALUES(max_channel_deletes),
            max_role_deletes=VALUES(max_role_deletes), max_kick_bans=VALUES(max_kick_bans),
            action_on_trigger=VALUES(action_on_trigger), alert_channel_id=VALUES(alert_channel_id)
    `, [GUILD_ID, modLog]);

    // Raid detection
    await ctx.pool.execute(`
        INSERT INTO raid_detection_config (guild_id, enabled, join_threshold, join_timeframe_seconds, new_account_age_hours, new_account_ratio, action, alert_channel_id, mute_duration_minutes, purge_messages)
        VALUES (?, 1, 10, 30, 24, 0.50, 'mute', ?, 60, 1)
        ON DUPLICATE KEY UPDATE enabled=1, join_threshold=VALUES(join_threshold),
            join_timeframe_seconds=VALUES(join_timeframe_seconds), new_account_age_hours=VALUES(new_account_age_hours),
            new_account_ratio=VALUES(new_account_ratio), action=VALUES(action), alert_channel_id=VALUES(alert_channel_id),
            mute_duration_minutes=VALUES(mute_duration_minutes), purge_messages=VALUES(purge_messages)
    `, [GUILD_ID, modLog]);

    // Adaptive spam (anti-harassment / cross-channel spam)
    await ctx.pool.execute(`
        INSERT INTO adaptive_spam_config (guild_id, enabled, cross_channel_threshold, cross_channel_timeframe_minutes, deviation_multiplier, new_account_multiplier_7d, new_account_multiplier_24h, action, alert_channel_id)
        VALUES (?, 1, 5, 2, 3.00, 1.50, 2.00, 'delete+warn', ?)
        ON DUPLICATE KEY UPDATE enabled=1, cross_channel_threshold=VALUES(cross_channel_threshold),
            cross_channel_timeframe_minutes=VALUES(cross_channel_timeframe_minutes),
            deviation_multiplier=VALUES(deviation_multiplier),
            new_account_multiplier_7d=VALUES(new_account_multiplier_7d),
            new_account_multiplier_24h=VALUES(new_account_multiplier_24h),
            action=VALUES(action), alert_channel_id=VALUES(alert_channel_id)
    `, [GUILD_ID, modLog]);

    // Selfbot detection
    await ctx.pool.execute(`
        INSERT INTO selfbot_detection_config (guild_id, enabled, min_response_time_ms, message_burst_threshold, message_burst_window_ms, pattern_threshold, action, alert_channel_id, mute_duration_minutes, purge_messages)
        VALUES (?, 1, 300, 6, 2000, 4, 'mute', ?, 30, 1)
        ON DUPLICATE KEY UPDATE enabled=1, min_response_time_ms=VALUES(min_response_time_ms),
            message_burst_threshold=VALUES(message_burst_threshold), message_burst_window_ms=VALUES(message_burst_window_ms),
            pattern_threshold=VALUES(pattern_threshold), action=VALUES(action), alert_channel_id=VALUES(alert_channel_id),
            mute_duration_minutes=VALUES(mute_duration_minutes), purge_messages=VALUES(purge_messages)
    `, [GUILD_ID, modLog]).catch(async e => {
        // Schema may not have mute_duration_minutes/purge_messages; fall back to core columns.
        if (/Unknown column/i.test(e.message)) {
            await ctx.pool.execute(`
                INSERT INTO selfbot_detection_config (guild_id, enabled, min_response_time_ms, message_burst_threshold, message_burst_window_ms, pattern_threshold, action, alert_channel_id)
                VALUES (?, 1, 300, 6, 2000, 4, 'mute', ?)
                ON DUPLICATE KEY UPDATE enabled=1, action=VALUES(action), alert_channel_id=VALUES(alert_channel_id)
            `, [GUILD_ID, modLog]);
        } else throw e;
    });

    // Phishing detection
    await ctx.pool.execute(`
        INSERT INTO phishing_config (guild_id, enabled, action, mute_duration_minutes, alert_channel_id, log_detections, report_channel_id)
        VALUES (?, 1, 'delete', 60, ?, 1, ?)
        ON DUPLICATE KEY UPDATE enabled=1, action=VALUES(action),
            mute_duration_minutes=VALUES(mute_duration_minutes),
            alert_channel_id=VALUES(alert_channel_id), log_detections=1, report_channel_id=VALUES(report_channel_id)
    `, [GUILD_ID, modLog, modLog]);

    // Anti-discord-link (invite filter)
    await ctx.pool.execute(`
        INSERT INTO invite_filter_config (guild_id, enabled, use_whitelist, action, log_channel_id)
        VALUES (?, 1, 0, 'delete_warn', ?)
        ON DUPLICATE KEY UPDATE enabled=1, use_whitelist=0, action=VALUES(action), log_channel_id=VALUES(log_channel_id)
    `, [GUILD_ID, modLog]);

    log('N', 'protection stack enabled. alerts -> #mod-log');
}

async function phaseO(ctx) {
    log('O', 'Enabling global ban');
    await ctx.pool.execute(`
        INSERT INTO global_ban_config
            (guild_id, enabled, action_critical, action_high, action_medium, action_low, alert_channel_id, log_actions, check_on_join, check_on_message, auto_aggregate_opt_in)
        VALUES (?, 1, 'ban', 'ban', 'kick', 'alert', ?, 1, 1, 0, 1)
        ON DUPLICATE KEY UPDATE
            enabled = 1,
            action_critical = VALUES(action_critical),
            action_high = VALUES(action_high),
            action_medium = VALUES(action_medium),
            action_low = VALUES(action_low),
            alert_channel_id = VALUES(alert_channel_id),
            log_actions = 1, check_on_join = 1, check_on_message = 0, auto_aggregate_opt_in = 1
    `, [GUILD_ID, state.channels.modLog]);
    log('O', 'global ban enabled; check_on_join=1');
}

async function phaseP(ctx) {
    log('P', 'Disabling starboard and minigames');

    // Starboard — schema has no enabled flag; delete the row to effectively turn it off
    await ctx.pool.execute('DELETE FROM starboard_config WHERE guild_id = ?', [GUILD_ID]);
    log('P', 'starboard row cleared');

    // Disable minigame commands via guild_command_restrictions (allowed=0 short-circuits at dispatch)
    const disabledCommands = [
        'arcade',   // container for counting, trivia, lfg, musicquiz, hangman, cfx, servers
        'pokemon',
        'rpg',
        'fun',      // blanket disable of partygames / icebreakers / quotes / random stuff
    ];
    for (const cmd of disabledCommands) {
        await ctx.pool.execute(`
            INSERT INTO guild_command_restrictions (guild_id, command_name, allowed, admin_only)
            VALUES (?, ?, 0, 0)
            ON DUPLICATE KEY UPDATE allowed = 0, admin_only = 0
        `, [GUILD_ID, cmd]);
    }
    log('P', `minigames disabled: ${disabledCommands.join(', ')}`);
}

async function main() {
    const client = await connectClient();
    const pool = createPool();
    const guild = await getGuild(client);
    const ctx = { client, pool, guild };
    log('main', `logged in as ${client.user.tag}`);
    const phases = process.argv.slice(2).length ? process.argv.slice(2) : ['N', 'O', 'P'];
    const handlers = { N: phaseN, O: phaseO, P: phaseP };
    try {
        for (const p of phases) {
            const fn = handlers[p.toUpperCase()];
            if (!fn) { log('main', `unknown phase: ${p}`); continue; }
            await fn(ctx);
        }
    } finally {
        try { await client.destroy(); } catch (_) {}
        try { await pool.end(); } catch (_) {}
    }
}

main().catch(err => { console.error('FATAL', err?.stack || err); process.exit(1); });
