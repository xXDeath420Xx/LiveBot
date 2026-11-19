/*
 * Heists — /economy heist start|join|status|cancel|stats|leaderboard and the Join button.
 *
 * Lifecycle (all state in the DB, so a restart at any point resumes cleanly):
 *   recruiting   a member starts a heist on a target with their stake; others join with a stake
 *                until the join window (heists.starts_at) closes or the crew is full. Every stake
 *                leaves the wallet immediately and is held in escrow (ledger row type 'heist').
 *   inprogress   the resolver (jobs/economy-events-scheduler.js) claims a due heist with a guarded
 *                UPDATE, rolls once and stores the roll (heists.roll/success) BEFORE paying anyone,
 *                then settles each member in their own transaction guarded on
 *                heist_participants.settled = 0 — a restart mid-way re-uses the stored roll and
 *                only settles who is left.
 *   completed    success: each member gets stake x multiplier (heist_rewards, heist_results, heist_stats)
 *   failed       every stake is lost (heist_results, heist_stats)
 *   cancelled    fewer than 2 members when the window closed, or the host / an admin called it off
 *                while recruiting: every stake is refunded.
 *
 * Anti-abuse, in the style of crime/rob: one active heist per guild, a guild cooldown after each
 * resolved heist, a per-member cooldown after each heist they were in, per-target stake limits.
 * Refused entirely when the server's economy is switched off.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import db from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';
import {
    getEconomyConfig, getOrCreateUserEconomy, logTransaction, formatMoney,
    economyStatus, noteEarnings, ECONOMY_DISABLED_MESSAGE,
} from './economy-manager.js';
import {
    MIN_CREW, DEFAULT_CREW, MAX_CREW, DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES,
    GUILD_COOLDOWN_MINUTES, USER_COOLDOWN_MINUTES, getTarget, maxStake, successChance, payoutFor,
    stakeError, decideOutcome, clamp,
} from './heist-odds.js';

/** A refusal meant for the member (shown as-is), as opposed to an unexpected failure. */
export class HeistError extends Error {}

const HEIST_COLUMNS = `id, guild_id, channel_id, host_id, target_name, difficulty, min_bet, recommended_total,
    total_contribution, status, success, success_rate, payout_multiplier, roll, max_crew, message_id, cancel_reason,
    UNIX_TIMESTAMP(created_at) AS created_unix, UNIX_TIMESTAMP(starts_at) AS starts_unix,
    UNIX_TIMESTAMP(ended_at) AS ended_unix, (starts_at <= NOW()) AS window_closed`;

async function safeLog(...args) {
    try {
        await logTransaction(...args);
    } catch (error) {
        logger.error('[Heist] Failed to log economy transaction', { error: error.message, guildId: args[0], userId: args[1], amount: args[3] });
    }
}

async function assertEconomyOn(guildId) {
    if (await economyStatus(guildId) === 'disabled') throw new HeistError(ECONOMY_DISABLED_MESSAGE);
}

export async function getHeist(heistId) {
    const [rows] = await db.execute(`SELECT ${HEIST_COLUMNS} FROM heists WHERE id = ?`, [heistId]);
    return rows[0] || null;
}

export async function getActiveHeist(guildId) {
    const [rows] = await db.execute(
        `SELECT ${HEIST_COLUMNS} FROM heists WHERE guild_id = ? AND status IN ('recruiting','inprogress')
          ORDER BY id DESC LIMIT 1`,
        [guildId]
    );
    return rows[0] || null;
}

export async function getParticipants(heistId) {
    const [rows] = await db.execute(
        'SELECT id, heist_id, user_id, contribution, settled, payout FROM heist_participants WHERE heist_id = ? ORDER BY id',
        [heistId]
    );
    return rows.map(r => ({ ...r, contribution: Number(r.contribution) || 0 }));
}

/** Minutes until this member may join another heist (0 = free). */
export async function userCooldownLeft(guildId, userId) {
    const [[row]] = await db.execute(
        `SELECT TIMESTAMPDIFF(SECOND, MAX(h.ended_at), NOW()) AS ago
           FROM heist_participants p JOIN heists h ON h.id = p.heist_id
          WHERE h.guild_id = ? AND p.user_id = ? AND h.status IN ('completed','failed')`,
        [guildId, userId]
    );
    if (row?.ago === null || row?.ago === undefined) return 0;
    const left = USER_COOLDOWN_MINUTES * 60 - Number(row.ago);
    return left > 0 ? Math.ceil(left / 60) : 0;
}

/** Minutes until the guild may start another heist (0 = free). */
export async function guildCooldownLeft(guildId) {
    const [[row]] = await db.execute(
        `SELECT TIMESTAMPDIFF(SECOND, MAX(ended_at), NOW()) AS ago
           FROM heists WHERE guild_id = ? AND status IN ('completed','failed')`,
        [guildId]
    );
    if (row?.ago === null || row?.ago === undefined) return 0;
    const left = GUILD_COOLDOWN_MINUTES * 60 - Number(row.ago);
    return left > 0 ? Math.ceil(left / 60) : 0;
}

async function averageLevel(guildId, userIds) {
    if (!userIds.length) return 0;
    try {
        const [[row]] = await db.execute(
            `SELECT AVG(level) AS avg_level FROM user_levels WHERE guild_id = ? AND user_id IN (${userIds.map(() => '?').join(',')})`,
            [guildId, ...userIds]
        );
        // Members with no leveling row count as level 0.
        const known = Number(row?.avg_level) || 0;
        const [[cnt]] = await db.execute(
            `SELECT COUNT(*) AS n FROM user_levels WHERE guild_id = ? AND user_id IN (${userIds.map(() => '?').join(',')})`,
            [guildId, ...userIds]
        );
        return (known * (Number(cnt?.n) || 0)) / userIds.length;
    } catch (error) {
        logger.warn('[Heist] Could not read crew levels; using 0', { guildId, error: error.message });
        return 0;
    }
}

/** Current odds for a heist row and its crew. */
export async function currentChance(heist, participants) {
    const target = getTarget(heist.difficulty);
    if (!target) return 0;
    const total = participants.reduce((s, p) => s + p.contribution, 0);
    const avg = await averageLevel(heist.guild_id, participants.map(p => p.user_id));
    return successChance(target, participants.length, avg, total);
}

function targetFor(heist) {
    return getTarget(heist.difficulty) || getTarget('medium');
}

// ─────────────────────────────── start / join / cancel ───────────────────────────────

/**
 * Start a heist. The host joins with `stake`.
 * @returns {Promise<{heist:object, participants:object[]}>}
 */
export async function startHeist({ guildId, channelId, hostId, targetKey, stake, maxCrew, windowMinutes }) {
    await assertEconomyOn(guildId);
    const target = getTarget(targetKey);
    if (!target) throw new HeistError('Unknown heist target.');
    const err = stakeError(target, stake);
    if (err) throw new HeistError(err);

    const crew = clamp(Math.floor(Number(maxCrew) || DEFAULT_CREW), MIN_CREW, MAX_CREW);
    const window = clamp(Math.floor(Number(windowMinutes) || DEFAULT_WINDOW_MINUTES), 1, MAX_WINDOW_MINUTES);

    const guildWait = await guildCooldownLeft(guildId);
    if (guildWait > 0) throw new HeistError(`The city is still on high alert after the last heist. Try again in ${guildWait} minute${guildWait === 1 ? '' : 's'}.`);
    const userWait = await userCooldownLeft(guildId, hostId);
    if (userWait > 0) throw new HeistError(`You're laying low after your last heist. Wait ${userWait} more minute${userWait === 1 ? '' : 's'}.`);

    const config = await getEconomyConfig(guildId);
    await getOrCreateUserEconomy(guildId, hostId, config);

    let heistId;
    let walletBefore;
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        // One active heist per guild. FOR UPDATE also gap-locks the guild's range on idx_guild, so
        // two members starting at the same instant serialize here.
        const [active] = await conn.execute(
            `SELECT id FROM heists WHERE guild_id = ? AND status IN ('recruiting','inprogress') FOR UPDATE`,
            [guildId]
        );
        if (active.length) throw new HeistError('A heist is already being planned here — join it instead (`/economy heist status`).');

        const [walletRows] = await conn.execute(
            'SELECT wallet FROM user_economy WHERE guild_id = ? AND user_id = ? FOR UPDATE',
            [guildId, hostId]
        );
        walletBefore = Number(walletRows[0]?.wallet ?? 0);
        if (walletBefore < stake) {
            throw new HeistError(`You don't have enough ${config.currency_name} in your wallet for that stake (you have ${formatMoney(walletBefore, config)}).`);
        }

        const [ins] = await conn.execute(
            `INSERT INTO heists (guild_id, channel_id, host_id, target_name, difficulty, min_bet, recommended_total,
                                 total_contribution, status, starts_at, max_crew, payout_multiplier)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recruiting', DATE_ADD(NOW(), INTERVAL ? MINUTE), ?, ?)`,
            [guildId, channelId, hostId, target.name, target.key, target.minStake, target.recommendedTotal,
                stake, window, crew, target.multiplier]
        );
        heistId = ins.insertId;

        await conn.execute(
            'INSERT INTO heist_participants (heist_id, user_id, contribution) VALUES (?, ?, ?)',
            [heistId, hostId, stake]
        );
        const [debit] = await conn.execute(
            'UPDATE user_economy SET wallet = wallet - ? WHERE guild_id = ? AND user_id = ? AND wallet >= ?',
            [stake, guildId, hostId, stake]
        );
        if (debit.affectedRows === 0) throw new HeistError('Your wallet no longer covers that stake.');

        await conn.commit();
    } catch (error) {
        await conn.rollback();
        // Two members starting at the same instant: the gap lock above makes one of them deadlock.
        if (error?.code === 'ER_LOCK_DEADLOCK' || error?.code === 'ER_LOCK_WAIT_TIMEOUT') {
            throw new HeistError('Someone else just started a heist here — see `/economy heist status`.');
        }
        throw error;
    } finally {
        conn.release();
    }

    await safeLog(guildId, hostId, 'heist', -stake, walletBefore, walletBefore - stake,
        `Heist #${heistId} stake (${target.name}) — held in escrow`);
    logger.info('[Heist] Started', { guildId, heistId, hostId, target: target.key, stake, crew, window });

    return { heist: await getHeist(heistId), participants: await getParticipants(heistId) };
}

/**
 * Join a recruiting heist with a stake.
 * @returns {Promise<{heist:object, participants:object[]}>}
 */
export async function joinHeist({ guildId, heistId, userId, stake }) {
    await assertEconomyOn(guildId);
    const heist = await getHeist(heistId);
    if (!heist || heist.guild_id !== guildId) throw new HeistError('That heist no longer exists.');
    const target = targetFor(heist);
    const err = stakeError(target, stake);
    if (err) throw new HeistError(err);

    const userWait = await userCooldownLeft(guildId, userId);
    if (userWait > 0) throw new HeistError(`You're laying low after your last heist. Wait ${userWait} more minute${userWait === 1 ? '' : 's'}.`);

    const config = await getEconomyConfig(guildId);
    await getOrCreateUserEconomy(guildId, userId, config);

    let walletBefore;
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [[locked]] = await conn.execute(
            'SELECT status, max_crew, (starts_at > NOW()) AS open_window FROM heists WHERE id = ? AND guild_id = ? FOR UPDATE',
            [heistId, guildId]
        );
        if (!locked || locked.status !== 'recruiting' || !Number(locked.open_window)) {
            throw new HeistError('The crew for this heist has already left — you missed it.');
        }

        const [members] = await conn.execute('SELECT user_id FROM heist_participants WHERE heist_id = ?', [heistId]);
        if (members.some(m => m.user_id === userId)) throw new HeistError('You are already in this crew.');
        if (members.length >= Number(locked.max_crew)) throw new HeistError('This crew is full.');

        const [walletRows] = await conn.execute(
            'SELECT wallet FROM user_economy WHERE guild_id = ? AND user_id = ? FOR UPDATE',
            [guildId, userId]
        );
        walletBefore = Number(walletRows[0]?.wallet ?? 0);
        if (walletBefore < stake) {
            throw new HeistError(`You don't have enough ${config.currency_name} in your wallet for that stake (you have ${formatMoney(walletBefore, config)}).`);
        }

        await conn.execute(
            'INSERT INTO heist_participants (heist_id, user_id, contribution) VALUES (?, ?, ?)',
            [heistId, userId, stake]
        );
        const [debit] = await conn.execute(
            'UPDATE user_economy SET wallet = wallet - ? WHERE guild_id = ? AND user_id = ? AND wallet >= ?',
            [stake, guildId, userId, stake]
        );
        if (debit.affectedRows === 0) throw new HeistError('Your wallet no longer covers that stake.');
        await conn.execute(
            'UPDATE heists SET total_contribution = total_contribution + ? WHERE id = ?',
            [stake, heistId]
        );

        await conn.commit();
    } catch (error) {
        await conn.rollback();
        if (error?.code === 'ER_DUP_ENTRY') throw new HeistError('You are already in this crew.');
        throw error;
    } finally {
        conn.release();
    }

    await safeLog(guildId, userId, 'heist', -stake, walletBefore, walletBefore - stake,
        `Heist #${heistId} stake (${target.name}) — held in escrow`);
    logger.info('[Heist] Joined', { guildId, heistId, userId, stake });

    return { heist: await getHeist(heistId), participants: await getParticipants(heistId) };
}

/**
 * Call off a recruiting heist and refund every stake. Only the host or a member with Manage Server.
 */
export async function cancelHeist({ guildId, heistId, userId, isAdmin, reason = null }) {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [[locked]] = await conn.execute(
            'SELECT status, host_id FROM heists WHERE id = ? AND guild_id = ? FOR UPDATE',
            [heistId, guildId]
        );
        if (!locked) throw new HeistError('That heist no longer exists.');
        if (locked.status !== 'recruiting') throw new HeistError('Only a heist that is still recruiting can be called off.');
        if (locked.host_id !== userId && !isAdmin) throw new HeistError('Only the heist host or a server manager can call it off.');

        await conn.execute(
            `UPDATE heists SET status = 'cancelled', cancel_reason = ?, ended_at = NOW() WHERE id = ?`,
            [(reason || (locked.host_id === userId ? 'Called off by the host' : 'Called off by a server manager')).slice(0, 255), heistId]
        );
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }

    const heist = await getHeist(heistId);
    await refundParticipants(heist);
    logger.info('[Heist] Cancelled', { guildId, heistId, by: userId });
    return { heist, participants: await getParticipants(heistId) };
}

/** Refund every unsettled stake of a cancelled heist (idempotent). */
export async function refundParticipants(heist) {
    const participants = await getParticipants(heist.id);
    for (const p of participants) {
        if (Number(p.settled)) continue;
        let walletBefore = null;
        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            const [claim] = await conn.execute(
                'UPDATE heist_participants SET settled = 1, payout = contribution WHERE id = ? AND settled = 0',
                [p.id]
            );
            if (claim.affectedRows === 1) {
                const [w] = await conn.execute(
                    'SELECT wallet FROM user_economy WHERE guild_id = ? AND user_id = ? FOR UPDATE',
                    [heist.guild_id, p.user_id]
                );
                if (!w.length) {
                    await conn.execute(
                        'INSERT IGNORE INTO user_economy (guild_id, user_id, wallet, bank) VALUES (?, ?, 0, 0)',
                        [heist.guild_id, p.user_id]
                    );
                }
                walletBefore = Number(w[0]?.wallet ?? 0);
                await conn.execute(
                    'UPDATE user_economy SET wallet = wallet + ? WHERE guild_id = ? AND user_id = ?',
                    [p.contribution, heist.guild_id, p.user_id]
                );
            }
            await conn.commit();
        } catch (error) {
            await conn.rollback();
            logger.error('[Heist] Refund failed (will retry on the next sweep)', { heistId: heist.id, userId: p.user_id, error: error.message });
            continue;
        } finally {
            conn.release();
        }
        if (walletBefore !== null) {
            await safeLog(heist.guild_id, p.user_id, 'heist', p.contribution, walletBefore, walletBefore + p.contribution,
                `Heist #${heist.id} called off — stake refunded`);
        }
    }
}

// ─────────────────────────────── resolution ───────────────────────────────

async function settleParticipant(heist, p, success, multiplier) {
    const payout = success ? payoutFor(p.contribution, multiplier) : 0;
    const profit = payout - p.contribution;
    let walletBefore = null;
    let settled = false;

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [claim] = await conn.execute(
            'UPDATE heist_participants SET settled = 1, payout = ? WHERE id = ? AND settled = 0',
            [payout, p.id]
        );
        if (claim.affectedRows === 1) {
            settled = true;
            if (payout > 0) {
                const [w] = await conn.execute(
                    'SELECT wallet FROM user_economy WHERE guild_id = ? AND user_id = ? FOR UPDATE',
                    [heist.guild_id, p.user_id]
                );
                if (!w.length) {
                    await conn.execute(
                        'INSERT IGNORE INTO user_economy (guild_id, user_id, wallet, bank) VALUES (?, ?, 0, 0)',
                        [heist.guild_id, p.user_id]
                    );
                }
                walletBefore = Number(w[0]?.wallet ?? 0);
                await conn.execute(
                    'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
                    [payout, Math.max(0, profit), heist.guild_id, p.user_id]
                );
            }
            await conn.execute(
                `INSERT INTO heist_results (guild_id, user_id, bet_amount, payout, success, heist_id)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [heist.guild_id, p.user_id, p.contribution, payout, success ? 1 : 0, heist.id]
            );
            if (success) {
                await conn.execute(
                    'INSERT INTO heist_rewards (heist_id, user_id, contribution, payout) VALUES (?, ?, ?, ?)',
                    [heist.id, p.user_id, p.contribution, payout]
                );
            }
            await conn.execute(
                `INSERT INTO heist_stats (guild_id, user_id, heists_participated, heists_won, heists_lost,
                                          total_contributed, total_earned, biggest_win)
                 VALUES (?, ?, 1, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    heists_participated = heists_participated + 1,
                    heists_won = heists_won + VALUES(heists_won),
                    heists_lost = heists_lost + VALUES(heists_lost),
                    total_contributed = total_contributed + VALUES(total_contributed),
                    total_earned = total_earned + VALUES(total_earned),
                    biggest_win = GREATEST(biggest_win, VALUES(biggest_win))`,
                [heist.guild_id, p.user_id, success ? 1 : 0, success ? 0 : 1, p.contribution, payout, payout]
            );
        }
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }

    if (settled && payout > 0) {
        await safeLog(heist.guild_id, p.user_id, 'heist', payout, walletBefore, walletBefore + payout,
            `Heist #${heist.id} (${heist.target_name}) succeeded — stake x${multiplier}`);
        noteEarnings(heist.guild_id, p.user_id, profit);
    }
    return { settled, payout };
}

/**
 * Resolve one heist if it is due (or resume one that was claimed before a restart).
 * @returns {Promise<null|{heist:object, participants:object[], outcome:'completed'|'failed'|'cancelled'}>}
 */
export async function resolveHeist(heistId, client = null) {
    await db.execute(
        `UPDATE heists SET status = 'inprogress' WHERE id = ? AND status = 'recruiting' AND starts_at <= NOW()`,
        [heistId]
    );
    let heist = await getHeist(heistId);
    if (!heist) return null;

    if (heist.status === 'cancelled') {
        // A cancel that crashed before refunding everyone.
        await refundParticipants(heist);
        return null;
    }
    if (heist.status !== 'inprogress') return null;

    let participants = await getParticipants(heistId);

    if (heist.success === null && participants.length < MIN_CREW) {
        const [res] = await db.execute(
            `UPDATE heists SET status = 'cancelled', cancel_reason = ?, ended_at = NOW() WHERE id = ? AND status = 'inprogress'`,
            [`Not enough crew (needs at least ${MIN_CREW})`, heistId]
        );
        heist = await getHeist(heistId);
        await refundParticipants(heist);
        if (res.affectedRows === 1) await announceResult(heist, await getParticipants(heistId), 'cancelled', client);
        return { heist, participants: await getParticipants(heistId), outcome: 'cancelled' };
    }

    if (heist.success === null) {
        const target = targetFor(heist);
        const chance = await currentChance(heist, participants);
        const roll = Math.random();
        const success = decideOutcome(chance, roll);
        await db.execute(
            `UPDATE heists SET success = ?, success_rate = ?, roll = ?, payout_multiplier = COALESCE(payout_multiplier, ?)
              WHERE id = ? AND success IS NULL`,
            [success ? 1 : 0, chance, Math.round(roll * 100000) / 100000, target.multiplier, heistId]
        );
        heist = await getHeist(heistId);
    }

    const success = Number(heist.success) === 1;
    const multiplier = Number(heist.payout_multiplier) || targetFor(heist).multiplier;

    for (const p of participants) {
        if (Number(p.settled)) continue;
        try {
            await settleParticipant(heist, p, success, multiplier);
        } catch (error) {
            logger.error('[Heist] Settling a crew member failed (will retry on the next sweep)', {
                heistId, userId: p.user_id, error: error.message,
            });
            return null; // leave the heist 'inprogress' so the sweep resumes it
        }
    }

    const outcome = success ? 'completed' : 'failed';
    const [done] = await db.execute(
        `UPDATE heists SET status = ?, ended_at = NOW() WHERE id = ? AND status = 'inprogress'`,
        [outcome, heistId]
    );
    heist = await getHeist(heistId);
    participants = await getParticipants(heistId);
    if (done.affectedRows === 1) {
        logger.info('[Heist] Resolved', { guildId: heist.guild_id, heistId, outcome, crew: participants.length, chance: heist.success_rate });
        await announceResult(heist, participants, outcome, client);
    }
    return { heist, participants, outcome };
}

/** Heists the resolver must look at: due recruiting, claimed-but-unfinished, and unrefunded cancels. */
export async function listHeistsNeedingWork(limit = 50) {
    const [rows] = await db.execute(
        `SELECT id FROM heists
          WHERE (status = 'recruiting' AND starts_at <= NOW()) OR status = 'inprogress'
         UNION
         SELECT DISTINCT h.id FROM heists h JOIN heist_participants p ON p.heist_id = h.id
          WHERE h.status = 'cancelled' AND p.settled = 0
         LIMIT ${Math.max(1, Math.floor(limit))}`
    );
    return rows.map(r => r.id);
}

/** One resolver pass (jobs/economy-events-scheduler.js). */
export async function runHeistSweep() {
    let ids;
    try {
        ids = await listHeistsNeedingWork();
    } catch (error) {
        logger.error('[Heist] Could not read due heists', { error: error.message });
        return;
    }
    for (const id of ids) {
        try {
            await resolveHeist(id);
        } catch (error) {
            logger.error('[Heist] Resolve failed', { heistId: id, error: error.message });
        }
    }
}

// ─────────────────────────────── stats ───────────────────────────────

export async function getStats(guildId, userId) {
    const [[row]] = await db.execute(
        `SELECT heists_participated, heists_won, heists_lost, total_contributed, total_earned, biggest_win
           FROM heist_stats WHERE guild_id = ? AND user_id = ?`,
        [guildId, userId]
    );
    return row || null;
}

/** Best heisters by net profit (payouts minus stakes). */
export async function getLeaderboard(guildId, limit = 10) {
    const [rows] = await db.execute(
        `SELECT user_id, heists_participated, heists_won, heists_lost, total_contributed, total_earned, biggest_win,
                (total_earned - total_contributed) AS net_profit
           FROM heist_stats WHERE guild_id = ?
          ORDER BY net_profit DESC, heists_won DESC LIMIT ${Math.max(1, Math.min(25, Math.floor(limit)))}`,
        [guildId]
    );
    return rows;
}

// ─────────────────────────────── presentation ───────────────────────────────

/** Find a channel through whichever bot (default or custom) serves the guild. */
export function findChannel(guildId, channelId, client = null) {
    const candidates = [];
    if (client) candidates.push(client);
    const manager = global.botManager;
    if (manager?.getClientForGuild) {
        const c = manager.getClientForGuild(guildId);
        if (c) candidates.push(c);
    }
    if (manager?.clients) for (const [, c] of manager.clients) candidates.push(c);
    for (const c of candidates) {
        const guild = c?.guilds?.cache?.get(guildId);
        const channel = guild?.channels?.cache?.get(channelId);
        if (channel) return channel;
    }
    return null;
}

export function heistComponents(heist, open = true) {
    if (!open) return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`heist:join:${heist.id}`).setLabel('Join the crew').setEmoji('🦹').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`heist:cancel:${heist.id}`).setLabel('Call it off').setStyle(ButtonStyle.Secondary),
    )];
}

/** The recruiting / final embed for a heist. */
export async function heistEmbed(heist, participants, config = null) {
    config = config || await getEconomyConfig(heist.guild_id);
    const target = targetFor(heist);
    const pot = participants.reduce((s, p) => s + p.contribution, 0);
    const crewLines = participants.map(p => {
        let tail = '';
        if (Number(p.settled) && p.payout !== null && p.payout !== undefined) {
            tail = heist.status === 'cancelled' ? ' — refunded' : ` → ${formatMoney(Number(p.payout), config)}`;
        }
        return `<@${p.user_id}> — ${formatMoney(p.contribution, config)}${tail}`;
    });

    const embed = new EmbedBuilder()
        .setTitle(`${target.emoji} Heist: ${heist.target_name}`)
        .addFields(
            { name: 'Crew', value: `${participants.length}/${heist.max_crew}`, inline: true },
            { name: 'Pot', value: formatMoney(pot, config), inline: true },
            { name: 'Payout', value: `stake x${Number(heist.payout_multiplier) || target.multiplier}`, inline: true },
        );

    if (heist.status === 'recruiting') {
        const chance = await currentChance(heist, participants);
        embed.setColor(themeColor(heist.guild_id, 'warning'))
            .setDescription(`<@${heist.host_id}> is planning a job on the **${heist.target_name}** (${target.key}). `
                + `Put in a stake of ${formatMoney(target.minStake, config)}–${formatMoney(maxStake(target), config)} to join. `
                + 'Bigger, better-funded and higher-level crews have better odds. Success pays every member '
                + `their stake x${target.multiplier}; failure loses every stake.`)
            .addFields(
                { name: 'Current odds', value: `${Math.round(chance * 100)}%`, inline: true },
                { name: 'Crew leaves', value: `<t:${Number(heist.starts_unix)}:R>`, inline: true },
                { name: 'Members', value: crewLines.join('\n').slice(0, 1024) || '—' },
            )
            .setFooter({ text: `Heist #${heist.id} • join with the button or /economy heist join` });
    } else if (heist.status === 'inprogress') {
        embed.setColor(themeColor(heist.guild_id, 'warning'))
            .setDescription('🚨 The crew is on the move…')
            .addFields({ name: 'Members', value: crewLines.join('\n').slice(0, 1024) || '—' })
            .setFooter({ text: `Heist #${heist.id}` });
    } else if (heist.status === 'completed') {
        embed.setColor(themeColor(heist.guild_id, 'success'))
            .setDescription(`💰 **The crew pulled it off!** (${Math.round(Number(heist.success_rate) * 100)}% odds) Every member walks away with their stake x${Number(heist.payout_multiplier)}.`)
            .addFields({ name: 'Payouts', value: crewLines.join('\n').slice(0, 1024) || '—' })
            .setFooter({ text: `Heist #${heist.id}` });
    } else if (heist.status === 'failed') {
        embed.setColor(themeColor(heist.guild_id, 'danger'))
            .setDescription(`🚔 **Busted!** (${Math.round(Number(heist.success_rate) * 100)}% odds) The crew got caught and every stake is gone.`)
            .addFields({ name: 'Crew', value: crewLines.join('\n').slice(0, 1024) || '—' })
            .setFooter({ text: `Heist #${heist.id}` });
    } else {
        embed.setColor(themeColor(heist.guild_id, 'info'))
            .setDescription(`❌ Called off — ${heist.cancel_reason || 'cancelled'}. Every stake was refunded.`)
            .addFields({ name: 'Crew', value: crewLines.join('\n').slice(0, 1024) || '—' })
            .setFooter({ text: `Heist #${heist.id}` });
    }
    return embed;
}

/** Redraw the heist's own message (best effort). */
export async function refreshHeistMessage(heist, participants, client = null) {
    if (!heist?.message_id) return false;
    const channel = findChannel(heist.guild_id, heist.channel_id, client);
    if (!channel) return false;
    try {
        const message = await channel.messages.fetch(heist.message_id);
        await message.edit({
            embeds: [await heistEmbed(heist, participants)],
            components: heistComponents(heist, heist.status === 'recruiting'),
        });
        return true;
    } catch (error) {
        logger.warn('[Heist] Could not update the heist message', { heistId: heist.id, error: error.message });
        return false;
    }
}

async function announceResult(heist, participants, outcome, client) {
    await refreshHeistMessage(heist, participants, client);
    const channel = findChannel(heist.guild_id, heist.channel_id, client);
    if (!channel) return;
    try {
        const mentions = participants.map(p => `<@${p.user_id}>`).join(' ');
        await channel.send({
            content: outcome === 'cancelled' ? null : mentions.slice(0, 1900) || null,
            embeds: [await heistEmbed(heist, participants)],
            allowedMentions: { users: outcome === 'cancelled' ? [] : participants.map(p => p.user_id) },
        });
    } catch (error) {
        logger.warn('[Heist] Could not post the heist result', { heistId: heist.id, error: error.message });
    }
}

export async function setHeistMessage(heistId, messageId) {
    await db.execute('UPDATE heists SET message_id = ? WHERE id = ?', [messageId, heistId]);
}

export default {
    HeistError, getHeist, getActiveHeist, getParticipants, userCooldownLeft, guildCooldownLeft, currentChance,
    startHeist, joinHeist, cancelHeist, refundParticipants, resolveHeist, listHeistsNeedingWork, runHeistSweep,
    getStats, getLeaderboard, findChannel, heistComponents, heistEmbed, refreshHeistMessage, setHeistMessage,
};
