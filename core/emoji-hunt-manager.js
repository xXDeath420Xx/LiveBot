/*
 * Emoji hunts (/arcade emojihunt).
 *
 * Staff start a hunt (or the scheduler starts one, if the server turned auto hunts on). Over the
 * hunt window the bot hides N copies of the target emoji by REACTING with it on random recent
 * member messages in the hunt channels. Members scroll back, spot the reaction and add the same
 * reaction; the first `finders_per_emoji` people on each spot claim it for points (plus optional
 * coins / XP). Results and a lifetime leaderboard are kept per server.
 *
 * Restart safety: everything lives in emoji_hunts (one row per guild — guild_id is UNIQUE, so the
 * row is the guild's current-or-last hunt and is reused). Spot schedule, placements and claims
 * are in emojis_json; jobs/bgames-scheduler.js places due spots and ends hunts on every tick, and
 * rebuilds the in-memory index of live spots from the DB, so nothing depends on a timer surviving.
 *
 * Concurrency: every change to emojis_json (a placement, a claim) re-reads the row with
 * SELECT … FOR UPDATE inside a transaction and applies its change to that fresh copy, so a claim
 * can never be lost to a concurrent placement or to another member's claim.
 *
 * Pure rules (emoji parsing, scheduling, claiming, standings) are in emoji-hunt-logic.js.
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';
import { getSettings, guildsWithConfig } from './bgames-settings.js';
import * as L from './emoji-hunt-logic.js';
import { clientFor, isOwningClient, payCoins, giveXP, formatCoins } from './bgames-rewards.js';

export const LIMITS = Object.freeze({
    minCount: 1, maxCount: 25,
    minDuration: 5, maxDuration: 24 * 60,
    maxFinders: 10,
    maxPoints: 10_000, maxCoins: 100_000, maxXp: 10_000,
    fetchPerChannel: 50,
});

const HUNT_COLS = `id, guild_id, channel_id, host_id, target_emoji, emojis_json, total_emojis, emojis_found, status,
    UNIX_TIMESTAMP(started_at) * 1000 AS started_ms, UNIX_TIMESTAMP(ends_at) * 1000 AS ends_ms,
    UNIX_TIMESTAMP(ended_at) * 1000 AS ended_ms, announce_channel_id, announce_message_id, hunt_channels,
    finders_per_emoji, points_per_find, coins_per_find, xp_per_find, max_age_minutes, trigger_type, hunt_count`;

/** messageId → guildId for placed spots that can still be claimed. Rebuilt from the DB each tick. */
const liveSpots = new Map();

function parseSpots(raw) {
    if (!raw) return [];
    try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(v) ? v : [];
    } catch (err) {
        logger.error('[EmojiHunt] Corrupt emojis_json', { error: err.message });
        return [];
    }
}

function parseIds(raw) {
    if (!raw) return [];
    try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(v) ? v.map(String) : [];
    } catch {
        return [];
    }
}

function indexHunt(hunt, spots = parseSpots(hunt.emojis_json)) {
    for (const [msg, gid] of liveSpots) if (gid === hunt.guild_id) liveSpots.delete(msg);
    if (hunt.status !== 'active') return;
    const finders = Number(hunt.finders_per_emoji) || 1;
    for (const s of spots) {
        if (L.isPlaced(s) && !s.gone && s.msg && s.claims.length < finders) liveSpots.set(s.msg, hunt.guild_id);
    }
}

export async function getHunt(guildId) {
    const [rows] = await pool.execute(`SELECT ${HUNT_COLS} FROM emoji_hunts WHERE guild_id = ?`, [guildId]);
    return rows[0] || null;
}

/** Channels the bot can actually hide spots in: visible, history readable, reactions allowed. */
function usableChannels(guild, ids) {
    const me = guild.members.me;
    const out = [];
    for (const id of ids) {
        const ch = guild.channels.cache.get(id);
        if (!ch || !ch.isTextBased?.() || !me) continue;
        const perms = ch.permissionsFor(me);
        if (perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions])) {
            out.push(ch);
        }
    }
    return out;
}

function clamp(n, lo, hi, dflt) {
    const v = Math.floor(Number(n));
    if (!Number.isFinite(v)) return dflt;
    return Math.max(lo, Math.min(hi, v));
}

/**
 * Start a hunt.
 * @returns {Promise<{ok:true, hunt:object}|{ok:false, error:string}>}
 */
export async function startHunt({
    guild, client, hostId = null, emoji = null, count = null, durationMinutes = null,
    channelIds = null, announceChannelId = null, trigger = 'manual', fallbackChannelId = null,
}) {
    const guildId = guild.id;
    const s = await getSettings('emojihunt', guildId);

    const target = L.parseEmoji(emoji || s.default_emoji);
    if (!target) return { ok: false, error: 'That is not an emoji I can hide. Use a normal emoji or a custom one from a server I am in.' };
    if (target.kind === 'custom' && !client.emojis.cache.has(target.id)) {
        return { ok: false, error: 'I can only react with custom emoji from servers I am in. Pick one from this server or a normal emoji.' };
    }

    const n = clamp(count ?? s.default_count, LIMITS.minCount, LIMITS.maxCount, 5);
    const minutes = clamp(durationMinutes ?? s.default_duration_minutes, LIMITS.minDuration, LIMITS.maxDuration, 30);
    const finders = clamp(s.finders_per_emoji, 1, LIMITS.maxFinders, 1);
    const points = clamp(s.points_per_find, 0, LIMITS.maxPoints, 10);
    const coins = clamp(s.coins_per_find, 0, LIMITS.maxCoins, 0);
    const xp = clamp(s.xp_per_find, 0, LIMITS.maxXp, 0);
    const maxAge = clamp(s.max_message_age_minutes, 10, 7 * 24 * 60, 1440);

    let wanted = channelIds?.length ? channelIds : s.hunt_channels;
    if (!wanted?.length && fallbackChannelId) wanted = [fallbackChannelId];
    const channels = usableChannels(guild, wanted || []);
    if (!channels.length) {
        return {
            ok: false,
            error: 'I have no channel to hide emoji in. I need **View Channel**, **Read Message History** and **Add Reactions** '
                + 'in the hunt channels (set them with `/arcade emojihunt config hunt-channels:`).',
        };
    }
    const announceId = announceChannelId || s.announce_channel_id || fallbackChannelId || channels[0].id;

    const spots = L.scheduleSpots(n, Date.now(), minutes * 60_000);
    const channelJson = JSON.stringify(channels.map(c => c.id));

    const conn = await pool.getConnection();
    let huntId;
    try {
        await conn.beginTransaction();
        const [[row]] = await conn.execute('SELECT id, status FROM emoji_hunts WHERE guild_id = ? FOR UPDATE', [guildId]);
        if (row && row.status === 'active') {
            await conn.rollback();
            return { ok: false, error: 'A hunt is already running here. End it with `/arcade emojihunt stop` first.' };
        }
        const values = [
            channels[0].id, hostId, target.value, JSON.stringify(spots), spots.length, minutes, minutes,
            announceId, channelJson, finders, points, coins, xp, maxAge, trigger,
        ];
        if (row) {
            huntId = row.id;
            await conn.execute(
                `UPDATE emoji_hunts SET channel_id = ?, host_id = ?, target_emoji = ?, emojis_json = ?, total_emojis = ?,
                        emojis_found = 0, status = 'active', active = 1, started_at = NOW(),
                        ends_at = NOW() + INTERVAL ? MINUTE, expires_at = NOW() + INTERVAL ? MINUTE,
                        announce_channel_id = ?, announce_message_id = NULL, hunt_channels = ?,
                        finders_per_emoji = ?, points_per_find = ?, coins_per_find = ?, xp_per_find = ?,
                        max_age_minutes = ?, trigger_type = ?, ended_at = NULL, hunt_count = hunt_count + 1
                  WHERE id = ?`,
                [...values, huntId]
            );
            // Per-hunt finds of the previous hunt; its totals are already in the leaderboard.
            await conn.execute('DELETE FROM emoji_hunt_participants WHERE hunt_id = ?', [huntId]);
        } else {
            const [res] = await conn.execute(
                `INSERT INTO emoji_hunts (guild_id, channel_id, host_id, target_emoji, emojis_json, total_emojis, emojis_found,
                        status, active, started_at, ends_at, expires_at, announce_channel_id, hunt_channels,
                        finders_per_emoji, points_per_find, coins_per_find, xp_per_find, max_age_minutes, trigger_type, hunt_count)
                 VALUES (?, ?, ?, ?, ?, ?, 0, 'active', 1, NOW(), NOW() + INTERVAL ? MINUTE, NOW() + INTERVAL ? MINUTE,
                         ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
                [guildId, ...values]
            );
            huntId = res.insertId;
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback().catch(() => {});
        if (err.code === 'ER_DUP_ENTRY') return { ok: false, error: 'A hunt was just started here by someone else.' };
        throw err;
    } finally {
        conn.release();
    }

    const hunt = await getHunt(guildId);
    logger.info('[EmojiHunt] Hunt started', { guildId, huntId, emoji: target.value, count: n, minutes, trigger });

    // Announce. A failure here must not undo the hunt — it is already running.
    try {
        const ch = guild.channels.cache.get(announceId);
        if (ch?.isTextBased?.()) {
            const embed = await startEmbed(guild, hunt, channels);
            const ping = s.ping_role_id ? `<@&${s.ping_role_id}>` : null;
            const msg = await ch.send({
                content: ping || undefined,
                embeds: [embed],
                allowedMentions: { roles: s.ping_role_id ? [s.ping_role_id] : [] },
            });
            await pool.execute('UPDATE emoji_hunts SET announce_message_id = ? WHERE id = ?', [msg.id, huntId]);
        }
    } catch (err) {
        logger.warn('[EmojiHunt] Could not post the start announcement', { guildId, channelId: announceId, error: err.message });
    }

    // Get the first spot out promptly instead of waiting for the next tick.
    placeDueSpots(guild, client).catch(err =>
        logger.error('[EmojiHunt] Initial placement failed', { guildId, error: err.message }));

    return { ok: true, hunt };
}

async function startEmbed(guild, hunt, channels) {
    const finders = Number(hunt.finders_per_emoji);
    const rewards = [`**${hunt.points_per_find}** hunt points`];
    if (hunt.coins_per_find > 0) rewards.push(await formatCoins(guild.id, hunt.coins_per_find));
    if (hunt.xp_per_find > 0) rewards.push(`**${hunt.xp_per_find}** XP`);
    const endsUnix = Math.floor(Number(hunt.ends_ms) / 1000);
    return new EmbedBuilder()
        .setColor(themeColor(guild.id, 'accent'))
        .setTitle(`${hunt.target_emoji} Emoji Hunt #${hunt.hunt_count} has begun!`)
        .setDescription(
            `I'm hiding **${hunt.total_emojis}** ${hunt.target_emoji} on recent messages in ${channels.map(c => `${c}`).join(', ')}.\n\n`
            + `**How to play:** scroll back through those channels, spot a message with a ${hunt.target_emoji} reaction from me, `
            + `and add the same reaction. The first ${finders === 1 ? 'person' : `**${finders}** people`} to find each one wins.\n\n`
            + `**Each find:** ${rewards.join(' + ')}`
        )
        .addFields({ name: 'Ends', value: `<t:${endsUnix}:R>`, inline: true })
        .setFooter({ text: 'They appear a few at a time — keep looking!' })
        .setTimestamp();
}

/**
 * Write spot changes onto the CURRENT emojis_json under a row lock.
 * `mutate(spots)` returns the new array (or null for "no change").
 */
async function updateSpots(guildId, mutate) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[row]] = await conn.execute(
            `SELECT id, status, emojis_json, finders_per_emoji FROM emoji_hunts WHERE guild_id = ? FOR UPDATE`, [guildId]);
        if (!row || row.status !== 'active') { await conn.rollback(); return null; }
        const next = mutate(parseSpots(row.emojis_json), row);
        if (!next) { await conn.rollback(); return null; }
        const found = L.summarise(next, Number(row.finders_per_emoji) || 1).found;
        await conn.execute('UPDATE emoji_hunts SET emojis_json = ?, emojis_found = ? WHERE id = ?',
            [JSON.stringify(next), found, row.id]);
        await conn.commit();
        return next;
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

/** Guilds with a placement pass in flight (the start command and the scheduler can overlap). */
const placing = new Set();

/** Hide every spot that is due. Called by the scheduler and right after a hunt starts. */
export async function placeDueSpots(guild, client) {
    if (placing.has(guild.id)) return;
    placing.add(guild.id);
    try {
        await placeDueSpotsLocked(guild, client);
    } finally {
        placing.delete(guild.id);
    }
}

async function placeDueSpotsLocked(guild, client) {
    const hunt = await getHunt(guild.id);
    if (!hunt || hunt.status !== 'active') return;
    const now = Date.now();
    const spots = parseSpots(hunt.emojis_json);
    const due = L.dueSpots(spots, now);
    if (!due.length) { indexHunt(hunt, spots); return; }

    const target = L.parseEmoji(hunt.target_emoji);
    const channels = usableChannels(guild, parseIds(hunt.hunt_channels));
    const used = new Set(spots.filter(s => s.msg).map(s => s.msg));
    const maxAgeMs = (Number(hunt.max_age_minutes) || 1440) * 60_000;
    const updates = new Map(); // spot index → patch
    let fatal = null;

    for (const spot of due) {
        let placed = null;
        const order = [...channels].sort(() => Math.random() - 0.5);
        for (const ch of order) {
            let msgs;
            try {
                msgs = await ch.messages.fetch({ limit: LIMITS.fetchPerChannel });
            } catch (err) {
                logger.warn('[EmojiHunt] Could not read channel history', { guildId: guild.id, channelId: ch.id, error: err.message });
                continue;
            }
            const candidates = [...msgs.values()].map(m => ({
                id: m.id,
                bot: !!m.author?.bot,
                system: !!m.system || !!m.webhookId,
                createdAt: m.createdTimestamp,
                hasTarget: m.reactions.cache.some(r => L.emojiMatches(target, r.emoji)),
                msg: m,
            }));
            // Try a few picks in this channel before moving on (a react can fail on a locked thread etc.).
            for (let attempt = 0; attempt < 3 && !placed; attempt++) {
                const pick = L.pickMessage(candidates, used, now, maxAgeMs);
                if (!pick) break;
                used.add(pick.id);
                try {
                    await pick.msg.react(L.reactArg(target));
                    placed = { ch: ch.id, msg: pick.id, placed: Date.now() };
                } catch (err) {
                    if (err.code === 10014) { fatal = 'The hunt emoji no longer exists (Unknown Emoji).'; break; }
                    logger.warn('[EmojiHunt] Reaction failed, trying another message', {
                        guildId: guild.id, channelId: ch.id, messageId: pick.id, code: err.code, error: err.message,
                    });
                }
            }
            if (placed || fatal) break;
        }
        if (fatal) break;
        if (placed) {
            used.add(placed.msg);
            updates.set(spot.i, placed);
        } else {
            // Nothing suitable right now (quiet channels). Try again in two minutes, unless that
            // would be too close to the end to be findable.
            const retryAt = now + 2 * 60_000;
            updates.set(spot.i, retryAt < Number(hunt.ends_ms) - 60_000 ? { at: retryAt } : { gone: true });
        }
    }

    if (updates.size) {
        const next = await updateSpots(guild.id, current => current.map(s => {
            const u = updates.get(s.i);
            return u && !L.isPlaced(s) && !s.gone ? { ...s, ...u } : s;
        }));
        if (next) {
            indexHunt({ ...hunt, status: 'active' }, next);
            const placedNow = [...updates.values()].filter(u => u.msg).length;
            if (placedNow) logger.info('[EmojiHunt] Spots hidden', { guildId: guild.id, count: placedNow });
        }
    }

    if (fatal) {
        logger.warn('[EmojiHunt] Ending hunt early', { guildId: guild.id, reason: fatal });
        await endHunt(guild, client, 'completed', fatal);
    }
}

/**
 * A reaction was added somewhere. Cheap for the 99.9% case: one Map lookup.
 * Called from events/emojiHuntReaction.js.
 */
export async function handleReactionAdd(reaction, user) {
    if (user.bot) return;
    const messageId = reaction.message?.id;
    const guildId = reaction.message?.guildId;
    if (!messageId || !guildId || liveSpots.get(messageId) !== guildId) return;
    if (!isOwningClient(reaction.client, guildId)) return;

    let claim = null;
    let hunt = null;
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[row]] = await conn.execute(`SELECT ${HUNT_COLS} FROM emoji_hunts WHERE guild_id = ? FOR UPDATE`, [guildId]);
        if (!row || row.status !== 'active' || !L.emojiMatches(row.target_emoji, reaction.emoji)) {
            await conn.rollback();
            return;
        }
        const spots = parseSpots(row.emojis_json);
        const spot = spots.find(s => s.msg === messageId && !s.gone);
        const finders = Number(row.finders_per_emoji) || 1;
        const res = spot ? L.claimSpot(spots, spot.i, user.id, Date.now(), finders) : { ok: false, reason: 'not_placed' };
        if (!res.ok) { await conn.rollback(); return; }

        const found = L.summarise(res.spots, finders).found;
        const points = Number(row.points_per_find) || 0;
        const coins = Number(row.coins_per_find) || 0;
        await conn.execute('UPDATE emoji_hunts SET emojis_json = ?, emojis_found = ? WHERE id = ?',
            [JSON.stringify(res.spots), found, row.id]);
        await conn.execute(
            `INSERT INTO emoji_hunt_participants (hunt_id, user_id, emojis_found, points, last_find_time, total_rewards, fastest_find_ms)
             VALUES (?, ?, 1, ?, NOW(), ?, ?)
             ON DUPLICATE KEY UPDATE emojis_found = emojis_found + 1, points = points + VALUES(points),
                 last_find_time = NOW(), total_rewards = total_rewards + VALUES(total_rewards),
                 fastest_find_ms = LEAST(COALESCE(fastest_find_ms, VALUES(fastest_find_ms)), VALUES(fastest_find_ms))`,
            [row.id, user.id, points, coins, Math.min(res.findMs, 2_147_483_647)]
        );
        await conn.execute(
            `INSERT INTO emoji_hunt_leaderboard (guild_id, user_id, total_finds, total_points, total_rewards_earned, fastest_find_ms, last_find_at)
             VALUES (?, ?, 1, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE total_finds = total_finds + 1, total_points = total_points + VALUES(total_points),
                 total_rewards_earned = total_rewards_earned + VALUES(total_rewards_earned),
                 fastest_find_ms = LEAST(COALESCE(fastest_find_ms, VALUES(fastest_find_ms)), VALUES(fastest_find_ms)),
                 last_find_at = NOW()`,
            [guildId, user.id, points, coins, Math.min(res.findMs, 2_147_483_647)]
        );
        await conn.commit();
        claim = res;
        hunt = { ...row, emojis_json: res.spots, emojis_found: found };
    } catch (err) {
        await conn.rollback().catch(() => {});
        logger.error('[EmojiHunt] Claim failed', { guildId, messageId, userId: user.id, error: err.message });
        return;
    } finally {
        conn.release();
    }

    const finders = Number(hunt.finders_per_emoji) || 1;
    const spots = hunt.emojis_json;
    indexHunt(hunt, spots);
    logger.info('[EmojiHunt] Spot claimed', { guildId, messageId, userId: user.id, findMs: claim.findMs });

    // Rewards are paid after the claim is committed; a payout failure is logged, never un-claims.
    const coins = Number(hunt.coins_per_find) || 0;
    const xp = Number(hunt.xp_per_find) || 0;
    if (coins > 0) {
        await payCoins(guildId, user.id, coins, `Emoji hunt #${hunt.hunt_count} find`)
            .catch(err => logger.error('[EmojiHunt] Coin reward failed', { guildId, userId: user.id, coins, error: err.message }));
    }
    if (xp > 0) {
        await giveXP(guildId, user.id, xp, 'emoji hunt')
            .catch(err => logger.error('[EmojiHunt] XP reward failed', { guildId, userId: user.id, xp, error: err.message }));
    }

    // Spot fully claimed: take the bot's own reaction off so nobody keeps clicking a found one.
    if (claim.fullyClaimed) {
        try {
            const msg = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
            const r = msg.reactions.cache.find(x => L.emojiMatches(hunt.target_emoji, x.emoji));
            await r?.users.remove(reaction.client.user.id);
        } catch (err) {
            logger.debug?.('[EmojiHunt] Could not remove my reaction from a found spot', { guildId, messageId, error: err.message });
        }
    }

    const sum = L.summarise(spots, finders);
    const left = sum.total - sum.found - sum.gone;
    const bits = [`+**${hunt.points_per_find}** pts`];
    if (coins > 0) bits.push(`+${await formatCoins(guildId, coins)}`);
    if (xp > 0) bits.push(`+**${xp}** XP`);
    try {
        await reaction.message.reply({
            content: `🎉 <@${user.id}> found a hidden ${hunt.target_emoji} in **${L.formatDuration(claim.findMs)}**! ${bits.join(' ')}`
                + (left > 0 ? ` — **${left}** still out there.` : ''),
            allowedMentions: { users: [user.id], repliedUser: false },
        });
    } catch (err) {
        logger.debug?.('[EmojiHunt] Could not post the find message', { guildId, messageId, error: err.message });
    }

    if (L.isComplete(spots, finders)) {
        const guild = reaction.client.guilds.cache.get(guildId);
        if (guild) {
            await endHunt(guild, reaction.client, 'completed', 'Every hidden emoji was found!')
                .catch(err => logger.error('[EmojiHunt] Ending a completed hunt failed', { guildId, error: err.message }));
        }
    }
}

/**
 * End the guild's active hunt and post results.
 * @param {'completed'|'expired'} status
 * @returns {Promise<object|null>} the final hunt row, or null if no hunt was active
 */
export async function endHunt(guild, client, status = 'completed', note = null) {
    const guildId = guild.id;
    let hunt;
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[row]] = await conn.execute(`SELECT ${HUNT_COLS} FROM emoji_hunts WHERE guild_id = ? FOR UPDATE`, [guildId]);
        if (!row || row.status !== 'active') { await conn.rollback(); return null; }
        await conn.execute(
            "UPDATE emoji_hunts SET status = ?, active = 0, ended_at = NOW() WHERE id = ?",
            [status === 'expired' ? 'expired' : 'completed', row.id]);
        await conn.execute(
            `UPDATE emoji_hunt_leaderboard l
               JOIN emoji_hunt_participants p ON p.hunt_id = ? AND p.user_id = l.user_id
                SET l.hunts_completed = l.hunts_completed + 1
              WHERE l.guild_id = ?`,
            [row.id, guildId]);
        await conn.commit();
        hunt = row;
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }

    for (const [msg, gid] of liveSpots) if (gid === guildId) liveSpots.delete(msg);
    const spots = parseSpots(hunt.emojis_json);
    const finders = Number(hunt.finders_per_emoji) || 1;
    logger.info('[EmojiHunt] Hunt ended', { guildId, huntId: hunt.id, status, found: L.summarise(spots, finders).found });

    const s = await getSettings('emojihunt', guildId);
    if (s.remove_unfound) {
        for (const spot of spots) {
            if (!L.isPlaced(spot) || spot.gone || spot.claims.length >= finders) continue;
            try {
                const ch = guild.channels.cache.get(spot.ch);
                const msg = await ch?.messages.fetch(spot.msg);
                const r = msg?.reactions.cache.find(x => L.emojiMatches(hunt.target_emoji, x.emoji));
                await r?.users.remove(client.user.id);
            } catch (err) {
                logger.debug?.('[EmojiHunt] Could not clean up an unfound spot', { guildId, messageId: spot.msg, error: err.message });
            }
        }
    }

    try {
        const ch = guild.channels.cache.get(hunt.announce_channel_id || hunt.channel_id);
        if (ch?.isTextBased?.()) {
            const embed = resultsEmbed(guild, hunt, spots, note);
            const payload = { embeds: [embed], allowedMentions: { parse: [] } };
            if (hunt.announce_message_id) {
                payload.reply = { messageReference: hunt.announce_message_id, failIfNotExists: false };
            }
            await ch.send(payload);
        }
    } catch (err) {
        logger.warn('[EmojiHunt] Could not post results', { guildId, error: err.message });
    }
    return hunt;
}

function resultsEmbed(guild, hunt, spots, note) {
    const finders = Number(hunt.finders_per_emoji) || 1;
    const sum = L.summarise(spots, finders);
    const table = L.standings(spots).slice(0, 10);
    const medals = ['🥇', '🥈', '🥉'];
    const lines = table.length
        ? table.map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.userId}> — **${r.finds}** found`
            + ` · ${r.finds * Number(hunt.points_per_find)} pts · fastest ${L.formatDuration(r.fastestMs)}`)
        : ['_Nobody found anything this time._'];
    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, sum.found ? 'success' : 'warning'))
        .setTitle(`${hunt.target_emoji} Emoji Hunt #${hunt.hunt_count} — results`)
        .setDescription(`${note ? `${note}\n\n` : ''}${lines.join('\n')}`)
        .addFields(
            { name: 'Found', value: `${sum.found}/${sum.total}`, inline: true },
            { name: 'Finds', value: String(sum.claims), inline: true },
        )
        .setFooter({ text: 'All-time standings: /arcade emojihunt leaderboard' })
        .setTimestamp();
    if (sum.found < sum.total && sum.placed > sum.found) {
        embed.addFields({ name: 'Never found', value: String(sum.placed - sum.found), inline: true });
    }
    return embed;
}

/** Status embed for /arcade emojihunt status. */
export function statusEmbed(guild, hunt) {
    const spots = parseSpots(hunt.emojis_json);
    const finders = Number(hunt.finders_per_emoji) || 1;
    const sum = L.summarise(spots, finders);
    const top = L.standings(spots).slice(0, 5);
    const channels = parseIds(hunt.hunt_channels).map(id => `<#${id}>`).join(', ') || `<#${hunt.channel_id}>`;
    const active = hunt.status === 'active';
    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, active ? 'accent' : 'info'))
        .setTitle(`${hunt.target_emoji} Emoji Hunt #${hunt.hunt_count} — ${active ? 'in progress' : 'finished'}`)
        .addFields(
            { name: 'Found', value: `${sum.found}/${sum.total}`, inline: true },
            { name: active ? 'Hidden right now' : 'Never found', value: String(active ? sum.hidden : Math.max(0, sum.placed - sum.found)), inline: true },
            { name: active ? 'Ends' : 'Ended', value: `<t:${Math.floor(Number(active ? hunt.ends_ms : (hunt.ended_ms || hunt.ends_ms)) / 1000)}:R>`, inline: true },
            { name: 'Where', value: channels.slice(0, 1024) },
        );
    if (active && sum.waiting) embed.addFields({ name: 'Still to appear', value: String(sum.waiting), inline: true });
    if (top.length) {
        embed.addFields({
            name: 'Top finders',
            value: top.map((r, i) => `${i + 1}. <@${r.userId}> — ${r.finds}`).join('\n'),
        });
    }
    return embed;
}

export async function leaderboard(guildId, limit = 10) {
    const [rows] = await pool.execute(
        `SELECT user_id, total_finds, total_points, fastest_find_ms, hunts_completed, total_rewards_earned
           FROM emoji_hunt_leaderboard WHERE guild_id = ?
          ORDER BY total_points DESC, total_finds DESC, fastest_find_ms ASC
          LIMIT ${Math.max(1, Math.min(25, Number(limit) || 10))}`,
        [guildId]
    );
    return rows;
}

/**
 * Load the live-spot index straight from the DB (no Discord needed), so claims work from the
 * first reaction after a restart instead of from the first scheduler tick.
 */
export async function rebuildIndex() {
    const [active] = await pool.execute(
        "SELECT guild_id, status, emojis_json, finders_per_emoji FROM emoji_hunts WHERE status = 'active'");
    for (const hunt of active) indexHunt(hunt);
    return liveSpots.size;
}

/**
 * Scheduler tick: place due spots, end hunts whose time is up, rebuild the live-spot index, and
 * start auto hunts that are due. `client` is the main bot; each guild is served by its own client.
 */
export async function tick(client, { autoHunts = true } = {}) {
    const [active] = await pool.execute(`SELECT ${HUNT_COLS} FROM emoji_hunts WHERE status = 'active'`);
    const activeGuilds = new Set();
    for (const hunt of active) {
        activeGuilds.add(hunt.guild_id);
        const c = clientFor(hunt.guild_id, client);
        const guild = c?.guilds.cache.get(hunt.guild_id);
        if (!guild) {
            // Usually the serving bot is still connecting — try next tick. A day past the end, the
            // bot has left the server: close the hunt quietly so it stops being scanned.
            if (Number(hunt.ends_ms) < Date.now() - 86_400_000) {
                await pool.execute(
                    "UPDATE emoji_hunts SET status = 'expired', active = 0, ended_at = NOW() WHERE id = ? AND status = 'active'", [hunt.id])
                    .catch(err => logger.error('[EmojiHunt] Could not close an orphaned hunt', { guildId: hunt.guild_id, error: err.message }));
                logger.warn('[EmojiHunt] Closed a hunt in a server no bot can see', { guildId: hunt.guild_id, huntId: hunt.id });
            }
            continue;
        }
        try {
            if (Number(hunt.ends_ms) <= Date.now()) {
                await endHunt(guild, c, 'expired', 'Time is up!');
            } else {
                await placeDueSpots(guild, c);
            }
        } catch (err) {
            logger.error('[EmojiHunt] Tick failed for guild', { guildId: hunt.guild_id, error: err.message });
        }
    }
    // Drop index entries for hunts that are no longer active (ended elsewhere, or by another process).
    for (const [msg, gid] of liveSpots) if (!activeGuilds.has(gid)) liveSpots.delete(msg);

    if (!autoHunts) return;
    let configs;
    try {
        configs = await guildsWithConfig('emojihunt');
    } catch (err) {
        logger.error('[EmojiHunt] Could not load auto-hunt configs', { error: err.message });
        return;
    }
    for (const { guildId, settings } of configs) {
        if (!settings.enabled || !settings.auto_enabled || activeGuilds.has(guildId)) continue;
        if (!settings.hunt_channels.length) continue;
        try {
            const [[row]] = await pool.execute(
                `SELECT status, UNIX_TIMESTAMP(COALESCE(ended_at, started_at)) * 1000 AS last_ms FROM emoji_hunts WHERE guild_id = ?`,
                [guildId]);
            const intervalMs = Math.max(1, Number(settings.auto_interval_hours) || 24) * 3_600_000;
            if (row && (row.status === 'active' || Date.now() - Number(row.last_ms) < intervalMs)) continue;
            const c = clientFor(guildId, client);
            const guild = c?.guilds.cache.get(guildId);
            if (!guild) continue;
            const res = await startHunt({ guild, client: c, trigger: 'auto' });
            if (!res.ok) logger.warn('[EmojiHunt] Auto hunt could not start', { guildId, reason: res.error });
        } catch (err) {
            logger.error('[EmojiHunt] Auto hunt failed', { guildId, error: err.message });
        }
    }
}
