/**
 * Diagnose false-positive "live" role grant for Platy in guild 1475096615940521994.
 *
 * Read-only — runs the queries from
 * /home/death/.claude/plans/possible-certifried-issue-abundant-liskov.md and then
 * calls each linked streamer's platform isStreamerLive/getStreamDetails directly
 * (same code path as core/stream-manager.js processUniqueStreamer).
 *
 * Usage:
 *   node scripts/diagnose-platy-live-role.js
 */
import dotenv from 'dotenv';
dotenv.config({ path: '/home/death/CertiFriedUtility/.env' });

import pool from '../utils/db.js';
import * as twitchApi from '../utils/platforms/twitch.js';
import * as kickApi from '../utils/platforms/kick.js';
import * as facebookApi from '../utils/platforms/facebook.js';
import * as instagramApi from '../utils/platforms/instagram.js';
import * as youtubeApi from '../utils/platforms/youtube.js';
import * as tiktokApi from '../utils/platforms/tiktok.js';
import * as trovoApi from '../utils/platforms/trovo-api.js';

const GUILD_ID = '1475096615940521994';
const DISCORD_USER_ID = '391228386040610816';
const BOT_ID = '1478035213148754072';

const platformModules = {
    twitch: twitchApi,
    kick: kickApi,
    facebook: facebookApi,
    instagram: instagramApi,
    youtube: youtubeApi,
    tiktok: tiktokApi,
    trovo: trovoApi,
};

function section(title) {
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`  ${title}`);
    console.log('═'.repeat(72));
}

function printRows(rows) {
    if (!rows.length) {
        console.log('  (no rows)');
        return;
    }
    for (const row of rows) {
        console.log('  •', JSON.stringify(row));
    }
}

// ─── 1. Bot mapping ─────────────────────────────────────────
section(`1. guild_bot_mapping for guild ${GUILD_ID}`);
const [mapping] = await pool.execute(
    'SELECT * FROM guild_bot_mapping WHERE guild_id = ?',
    [GUILD_ID]
);
printRows(mapping);
const expectedBot = mapping.find(r => r.bot_id === BOT_ID);
if (!expectedBot) {
    console.log(`  ⚠  Custom bot ${BOT_ID} is NOT mapped to ${GUILD_ID}.`);
    console.log('     Either the user gave the wrong bot id, or guild is processed by the default bot.');
} else {
    console.log(`  ✓  Custom bot ${BOT_ID} owns this guild.`);
}

// ─── 2. Streamers linked to Platy ───────────────────────────
section(`2. streamers WHERE discord_user_id = ${DISCORD_USER_ID}`);
const [streamers] = await pool.execute(
    `SELECT streamer_id, discord_user_id, platform, username, profile_image_url
       FROM streamers
      WHERE discord_user_id = ?`,
    [DISCORD_USER_ID]
);
printRows(streamers);

// ─── 3. Subscriptions for this guild that point at Platy ────
section(`3. subscriptions for guild ${GUILD_ID} where streamer.discord_user_id = ${DISCORD_USER_ID}`);
const [subs] = await pool.execute(
    `SELECT sub.subscription_id, sub.guild_id, sub.live_role_id AS sub_role_id,
            sub.announcement_channel_id, sub.team_subscription_id,
            sub.delete_on_end, sub.edit_on_end,
            s.streamer_id, s.platform, s.username, s.discord_user_id
       FROM subscriptions sub
       JOIN streamers s ON sub.streamer_id = s.streamer_id
      WHERE sub.guild_id = ?
        AND s.discord_user_id = ?`,
    [GUILD_ID, DISCORD_USER_ID]
);
printRows(subs);

// ─── 4. Live announcements held for this guild ─────────────
section(`4. live_announcements for guild ${GUILD_ID}`);
const [liveAnns] = await pool.execute(
    `SELECT guild_id, platform, username, channel_id, message_id,
            delete_on_end, edit_on_end, offline_check_count, created_at
       FROM live_announcements
      WHERE guild_id = ?`,
    [GUILD_ID]
);
printRows(liveAnns);

// ─── 5. Guild defaults ─────────────────────────────────────
section(`5. guilds row for ${GUILD_ID}`);
const [guildRows] = await pool.execute(
    `SELECT guild_id, announcement_channel_id, live_role_id, use_webhook_persona
       FROM guilds WHERE guild_id = ?`,
    [GUILD_ID]
);
printRows(guildRows);

// ─── 6. Self-promo config ──────────────────────────────────
section(`6. self_promo_config for ${GUILD_ID}`);
try {
    const [spConf] = await pool.execute(
        'SELECT * FROM self_promo_config WHERE guild_id = ?',
        [GUILD_ID]
    );
    printRows(spConf);
} catch (e) {
    console.log(`  (table not present or error: ${e.message})`);
}

// ─── 7. Live API check for each linked streamer ────────────
section('7. Live API check for each streamer linked to Platy (uses same code path as bot)');
const apiResults = [];
for (const s of streamers) {
    const api = platformModules[s.platform];
    if (!api) {
        console.log(`  • ${s.platform}/${s.username}: no API module — skipping`);
        apiResults.push({ ...s, isLive: null, streamData: null, note: 'no api module' });
        continue;
    }
    let isLive = null;
    let streamData = null;
    let err = null;
    try {
        isLive = await api.isStreamerLive(s.username);
    } catch (e) {
        err = e.message;
    }
    if (isLive === true) {
        try {
            if (typeof api.getStreamDetails === 'function') {
                streamData = await api.getStreamDetails(s.username);
            }
        } catch (e) {
            err = (err ? err + '; ' : '') + e.message;
        }
    }
    const verdict = isLive === true && streamData
        ? 'LIVE_WITH_DATA  ← would grant role'
        : isLive === true
            ? 'LIVE_NO_DATA    ← isStreamerLive=true but getStreamDetails=null (would NOT grant role)'
            : isLive === false
                ? 'OFFLINE'
                : `UNKNOWN (${err || 'no result'})`;
    console.log(`  • ${s.platform}/${s.username} (streamer_id=${s.streamer_id}): ${verdict}`);
    if (streamData) {
        console.log(`      title: ${streamData.title}`);
        console.log(`      game:  ${streamData.game_name}`);
        console.log(`      viewers: ${streamData.viewer_count}`);
        console.log(`      started_at: ${streamData.started_at}`);
    }
    apiResults.push({ ...s, isLive, streamData, err });
}

// ─── 8. Conclusion ─────────────────────────────────────────
section('8. Diagnosis');
if (streamers.length === 0) {
    console.log('  → NO STREAMERS linked to discord_user_id ' + DISCORD_USER_ID + '.');
    console.log('    Role grant must be coming from somewhere else — widen the search.');
} else if (subs.length === 0) {
    console.log('  → Streamer rows exist for Platy, but NO subscription in this guild references them.');
    console.log('    The role should not be flipped on by stream-manager. Look elsewhere (team-sync, presence-based).');
} else {
    const liveOne = apiResults.find(r => r.isLive === true && r.streamData);
    if (liveOne) {
        console.log(`  → ROOT CAUSE: streamer "${liveOne.username}" (platform ${liveOne.platform}) is currently LIVE`);
        console.log(`    per the API and is linked to discord_user_id ${DISCORD_USER_ID}.`);
        console.log('    This is what is granting Platy the live role every cycle.');
        console.log('    Decide: is this username actually Platy\'s, or wrongly linked?');
        console.log(`    - If WRONGLY linked: UPDATE streamers SET discord_user_id = NULL WHERE streamer_id = ${liveOne.streamer_id};`);
        console.log('    - If correctly linked: this is not actually a bug, Platy IS live on that platform.');
    } else {
        const liveButNoData = apiResults.find(r => r.isLive === true && !r.streamData);
        if (liveButNoData) {
            console.log(`  → SUSPICIOUS: streamer "${liveButNoData.username}" (${liveButNoData.platform}) reports isLive=true`);
            console.log('    but getStreamDetails returned null. Per stream-manager.js:1086, role would NOT flip on.');
            console.log('    Check why getStreamDetails returns null — could be transient.');
        } else {
            console.log('  → All linked streamers report OFFLINE per the API right now.');
            console.log('    If Platy currently has the live role anyway, suspects:');
            console.log('      a) Stale platform cache (90s window) — fix in Phase 3.');
            console.log('      b) Competing bot session granting role outside PM2 (per feedback_competing_sessions.md).');
            console.log('      c) live_announcements row stuck causing announcement-side noise (role logic is independent though).');
        }
    }
    if (liveAnns.length) {
        const platyAnns = liveAnns.filter(a => streamers.some(s => s.username === a.username && s.platform === a.platform));
        if (platyAnns.length) {
            console.log(`\n  Note: ${platyAnns.length} live_announcements row(s) reference Platy's streamer username(s).`);
            for (const a of platyAnns) {
                console.log(`    - platform=${a.platform} username=${a.username} channel=${a.channel_id} message_id=${a.message_id} offline_check_count=${a.offline_check_count} created_at=${a.created_at}`);
            }
        }
    }
}

console.log('\nDone. Paste this output back to continue with Phase 2.');
await pool.end();
