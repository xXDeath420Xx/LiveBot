/*
 * Cannabis Community background work (settings on the Cannabis Community page):
 *
 *   Smoke circle turns ("Seconds per turn"): smoke_circles.expires_at holds the moment the current
 *   turn runs out. When it passes, the turn moves to the next person and the circle's channel is
 *   told. If a whole round goes by with nobody puffing or passing, the circle is ended so an
 *   abandoned circle does not post forever.
 *
 *   Leaderboard channel ("Leaderboard channel"): one toke leaderboard message is kept in that
 *   channel and edited when the standings change, rather than a new post every time.
 *
 * Clients are resolved per guild from global.botManager, so one schedule covers the main bot and
 * every custom bot.
 */
import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getCannabisSettings } from '../core/cannabis-settings.js';
import { themeColor } from '../core/guild-theme.js';

const TURN_CHECK_MS = 10_000;
const LEADERBOARD_MS = 10 * 60_000;
export const LEADERBOARD_TITLE = 'Server Toke Leaderboard';

let turnTimer = null;
let boardTimer = null;
let firstBoard = null;
let defaultClient = null;
let turnBusy = false;
let boardBusy = false;

// circleId -> { puffs: total_puffs at the last auto-pass, turn: the turn it handed to, misses: auto-passes in a row }
const idle = new Map();
// channelId -> messageId of our leaderboard post, and the description it last showed
const boards = new Map();

function clientFor(guildId) {
    const c = global.botManager?.getClientForGuild?.(guildId) || defaultClient;
    return c?.guilds?.cache?.has(guildId) ? c : null;
}

async function sendTo(client, channelId, payload) {
    const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) return null;
    return channel.send(payload).catch(err => {
        logger.warn(`[Cannabis] Could not post in ${channelId}: ${err.message}`);
        return null;
    });
}

/** Move every overdue turn along. Exported for tests. */
export async function checkTurns() {
    if (turnBusy) return;
    turnBusy = true;
    try {
        const [circles] = await pool.execute(
            `SELECT id, guild_id, channel_id, current_turn, total_puffs
               FROM smoke_circles
              WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()`
        );
        for (const circle of circles) {
            try { await advanceTurn(circle); } catch (err) {
                logger.error(`[Cannabis] Turn timeout failed for circle ${circle.id}: ${err.message}`);
            }
        }
        // Forget circles that are no longer active.
        if (idle.size) {
            const [active] = await pool.execute(`SELECT id FROM smoke_circles WHERE status = 'active'`);
            const live = new Set(active.map(r => Number(r.id)));
            for (const id of idle.keys()) if (!live.has(id)) idle.delete(id);
        }
    } catch (err) {
        logger.error(`[Cannabis] Turn check failed: ${err.message}`);
    } finally {
        turnBusy = false;
    }
}

async function advanceTurn(circle) {
    const [participants] = await pool.execute(
        'SELECT user_id FROM smoke_circle_participants WHERE circle_id = ? ORDER BY joined_at ASC, id ASC',
        [circle.id]
    );
    if (participants.length < 2) {
        // Nobody to pass to; the timer starts again when a second person joins.
        await pool.execute('UPDATE smoke_circles SET expires_at = NULL WHERE id = ?', [circle.id]);
        return;
    }

    const id = Number(circle.id);
    const puffs = Number(circle.total_puffs) || 0;
    const seen = idle.get(id);
    // A puff, or a /pass by hand since our last auto-pass, means people are still there.
    const misses = seen && seen.puffs === puffs && seen.turn === Number(circle.current_turn) ? seen.misses + 1 : 1;
    const client = clientFor(circle.guild_id);

    if (misses > participants.length) {
        // A full round of timeouts with no puff: the circle has been left.
        const [res] = await pool.execute(
            `UPDATE smoke_circles SET status = 'completed', ended_at = NOW(), expires_at = NULL
              WHERE id = ? AND status = 'active'`,
            [circle.id]
        );
        idle.delete(id);
        if (res.affectedRows && client) {
            await sendTo(client, circle.channel_id, { content: 'Nobody has puffed for a whole round, so the smoke circle has ended. Start a new one with `/smokecircle`.' });
        }
        return;
    }

    const settings = await getCannabisSettings(circle.guild_id);
    const turn = Number(circle.current_turn) || 0;
    const holder = participants[turn % participants.length]?.user_id;
    const nextTurn = (turn + 1) % participants.length;
    const next = participants[nextTurn].user_id;

    // Guarded on the turn we read, so a /pass that lands at the same moment wins.
    const [res] = await pool.execute(
        `UPDATE smoke_circles
            SET current_turn = ?, turn_puffs = 0, expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
          WHERE id = ? AND status = 'active' AND current_turn = ? AND expires_at <= NOW()`,
        [nextTurn, settings.circleTurnSeconds, circle.id, turn]
    );
    if (!res.affectedRows) return;
    idle.set(id, { puffs, misses, turn: nextTurn });

    if (client) {
        await sendTo(client, circle.channel_id, {
            content: `<@${holder}> held on to it for too long, so it passes to <@${next}>. You have ${settings.circleTurnSeconds} seconds to \`/puff\` or \`/pass\`.`,
            allowedMentions: { users: [next] },
        });
    }
}

/** Build the leaderboard description for a guild, or null when nobody has toked yet. */
export async function leaderboardText(guildId) {
    const [leaders] = await pool.execute(
        `SELECT user_id, total_tokes, level FROM toke_user_stats
          WHERE guild_id = ? ORDER BY total_tokes DESC, user_id ASC LIMIT 10`,
        [guildId]
    );
    if (!leaders.length) return null;
    return leaders.map((row, i) => {
        const place = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        return `${place} <@${row.user_id}> - **${Number(row.total_tokes).toLocaleString()}** tokes (Lvl ${row.level})`;
    }).join('\n');
}

/** Find our existing leaderboard post in a channel (cached id first, then the recent history). */
async function findBoard(client, channel) {
    const known = boards.get(channel.id);
    if (known?.messageId) {
        const msg = await channel.messages.fetch(known.messageId).catch(() => null);
        if (msg) return msg;
    }
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    return recent?.find(m => m.author?.id === client.user.id && m.embeds?.[0]?.title === LEADERBOARD_TITLE) || null;
}

/** Refresh one guild's leaderboard post. Exported for tests. */
export async function refreshLeaderboard(guildId, channelId) {
    const client = clientFor(guildId);
    if (!client) return 'no-client';
    const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.() || channel.guildId !== guildId) return 'no-channel';

    const text = await leaderboardText(guildId);
    const description = text || 'No tokes recorded in this server yet. Be the first with `/cannabis toke`.';
    const known = boards.get(channelId);
    if (known && known.description === description) return 'unchanged';

    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'success'))
        .setTitle(LEADERBOARD_TITLE)
        .setDescription(description)
        .setFooter({ text: 'Updates on its own as people toke' })
        .setTimestamp();

    const existing = await findBoard(client, channel);
    if (existing) {
        if (existing.embeds?.[0]?.description === description) {
            boards.set(channelId, { messageId: existing.id, description });
            return 'unchanged';
        }
        await existing.edit({ embeds: [embed], allowedMentions: { parse: [] } });
        boards.set(channelId, { messageId: existing.id, description });
        return 'edited';
    }
    const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    boards.set(channelId, { messageId: sent.id, description });
    return 'posted';
}

async function refreshAllLeaderboards() {
    if (boardBusy) return;
    boardBusy = true;
    try {
        const [rows] = await pool.execute(
            `SELECT guild_id FROM guild_feature_config
              WHERE feature_key = 'cannabis'
                AND JSON_UNQUOTE(JSON_EXTRACT(config, '$.leaderboard_channel_id')) REGEXP '^[0-9]{17,20}$'`
        );
        for (const { guild_id: guildId } of rows) {
            try {
                const settings = await getCannabisSettings(guildId);
                if (settings.leaderboardChannelId) await refreshLeaderboard(guildId, settings.leaderboardChannelId);
            } catch (err) {
                logger.warn(`[Cannabis] Leaderboard refresh failed for ${guildId}: ${err.message}`);
            }
        }
    } catch (err) {
        logger.error(`[Cannabis] Leaderboard pass failed: ${err.message}`);
    } finally {
        boardBusy = false;
    }
}

export function startCannabisScheduler(client) {
    if (turnTimer) return;
    defaultClient = client;
    turnTimer = setInterval(checkTurns, TURN_CHECK_MS);
    boardTimer = setInterval(refreshAllLeaderboards, LEADERBOARD_MS);
    // First leaderboard pass once custom bots have logged in.
    firstBoard = setTimeout(refreshAllLeaderboards, 90_000);
    logger.info('[Cannabis] Scheduler started (turn timeouts every 10s, leaderboards every 10 min)');
}

export function stopCannabisScheduler() {
    clearInterval(turnTimer);
    clearInterval(boardTimer);
    clearTimeout(firstBoard);
    turnTimer = boardTimer = firstBoard = null;
}

export default { startCannabisScheduler, stopCannabisScheduler };
