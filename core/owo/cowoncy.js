/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * OwO's own currency ("cowoncy") — completely independent of the guild's
 * Economy system. Uses the `owo_cowoncy (guild_id, id, money, daily,
 * daily_streak, ...)` table directly. Does NOT touch user_economy.
 *
 * This replaces an earlier design that bridged to core/economy-manager —
 * the two currencies are meant to be separate, with their own dailies,
 * balances, transfers, and cooldowns.
 */

import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { withTx, OwoUserError } from './tx.js';
import { bookAllowanceTx, lockLimitRowsTx, logTransferTx } from './give-limits.js';

// OwO currency identity — separate from the guild's Economy currency.
export const CURRENCY_NAME = 'cowoncy';
export const CURRENCY_EMOJI = '💵';

const DAILY_BASE = 200;                  // upstream-aligned base
const DAILY_STREAK_STEP = 50;            // +50 per streak day
const DAILY_STREAK_CAP = 1000;           // max 1000 bonus
const DAILY_COOLDOWN_HOURS = 24;
const STREAK_GRACE_HOURS = 48;           // streak resets if user lapses past this

/**
 * What a brand-new player starts with.
 *
 * Upstream OwO starts you at zero, which means a new player cannot do any of the things cowoncy is
 * for until they have ground out a few dailies — and in a server taking over from the real OwO, a
 * zero balance next to someone's carried-over 1.6 million reads as being robbed.
 *
 * `INSERT IGNORE` means this applies to NEW rows only. Nobody's existing balance is touched, and
 * nobody is topped up: quietly minting currency for players who already have some would devalue
 * what they earned.
 */
export const STARTING_COWONCY = 15_000;

async function ensureRow(guildId, userId) {
    await pool.execute(
        `INSERT IGNORE INTO owo_cowoncy (guild_id, id, money, daily_streak) VALUES (?, ?, ?, 0)`,
        [guildId, userId, STARTING_COWONCY]
    );
}

export async function getCowoncy(guildId, userId) {
    await ensureRow(guildId, userId);
    const [[row]] = await pool.execute(
        'SELECT money FROM owo_cowoncy WHERE guild_id = ? AND id = ?',
        [guildId, userId]
    );
    return Number(row?.money) || 0;
}

export async function addCowoncy(guildId, userId, amount, reason = '') {
    if (!amount) return;
    await ensureRow(guildId, userId);
    await pool.execute(
        'UPDATE owo_cowoncy SET money = GREATEST(0, money + ?) WHERE guild_id = ? AND id = ?',
        [amount, guildId, userId]
    );
    if (reason) logger.debug('[owo-cowoncy] credit', { guildId, userId, amount, reason });
}

export async function removeCowoncy(guildId, userId, amount, reason = '') {
    if (!amount) return;
    return addCowoncy(guildId, userId, -Math.abs(amount), reason);
}

/**
 * Atomic spend: fails (returns false) if user doesn't have enough.
 */
export async function trySpendCowoncy(guildId, userId, amount, reason = '') {
    const bal = await getCowoncy(guildId, userId);
    if (bal < amount) return { ok: false, balance: bal, missing: amount - bal };
    const [r] = await pool.execute(
        'UPDATE owo_cowoncy SET money = money - ? WHERE guild_id = ? AND id = ? AND money >= ?',
        [amount, guildId, userId, amount]
    );
    if (r.affectedRows === 0) return { ok: false, balance: bal, error: 'Insufficient funds (race)' };
    if (reason) logger.debug('[owo-cowoncy] debit', { guildId, userId, amount, reason });
    return { ok: true, balance: bal - amount };
}

// ── Transaction helpers (run inside core/owo/tx.js withTx) ───────────────────

/** Make sure a member has a cowoncy row (new rows start at STARTING_COWONCY), inside a transaction. */
export async function ensureRowTx(conn, guildId, userId) {
    await conn.execute(
        `INSERT IGNORE INTO owo_cowoncy (guild_id, id, money, daily_streak) VALUES (?, ?, ?, 0)`,
        [guildId, userId, STARTING_COWONCY]
    );
}

/**
 * Lock the cowoncy rows of one or more members (creating missing ones) in id order and return
 * their balances. Locking in a fixed order keeps two opposite transfers from deadlocking.
 * @returns {Promise<Map<string, number>>}
 */
export async function lockBalancesTx(conn, guildId, userIds) {
    const ids = [...new Set(userIds.map(String))].sort();
    for (const id of ids) await ensureRowTx(conn, guildId, id);
    const [rows] = await conn.execute(
        `SELECT id, money FROM owo_cowoncy WHERE guild_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`,
        [guildId, ...ids]
    );
    return new Map(rows.map(r => [String(r.id), Number(r.money) || 0]));
}

/** Guarded debit inside a transaction; throws OwoUserError when the balance can't cover it. */
export async function debitTx(conn, guildId, userId, amount, message = null) {
    if (!amount) return;
    await ensureRowTx(conn, guildId, userId);
    const [r] = await conn.execute(
        'UPDATE owo_cowoncy SET money = money - ? WHERE guild_id = ? AND id = ? AND money >= ?',
        [amount, guildId, userId, amount]
    );
    if (r.affectedRows !== 1) {
        throw new OwoUserError(message || "You don't have enough cowoncy! >:c", 'insufficient_funds');
    }
}

/** Credit inside a transaction (creates the row if needed). */
export async function creditTx(conn, guildId, userId, amount) {
    if (!amount) return;
    await ensureRowTx(conn, guildId, userId);
    await conn.execute(
        'UPDATE owo_cowoncy SET money = money + ? WHERE guild_id = ? AND id = ?',
        [amount, guildId, userId]
    );
}

/**
 * `owo give`: move cowoncy between two members as ONE transaction — balance check, upstream's
 * daily send/receive caps, debit, credit and the owo_transaction audit row all commit together or
 * not at all.
 *
 * Throws an Error whose message is safe to show the player (OwoUserError for rule failures such
 * as "not enough cowoncy" or a cap; a generic message for unexpected failures, which are logged).
 */
export async function transferCowoncy(guildId, fromUserId, toUserId, amount, { receiverName = null } = {}) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new OwoUserError('Amount must be a whole number above 0.');
    if (String(fromUserId) === String(toUserId)) throw new OwoUserError("You can't give cowoncy to yourself.");
    try {
        return await withTx(async (conn) => {
            const balances = await lockBalancesTx(conn, guildId, [fromUserId, toUserId]);
            const have = balances.get(String(fromUserId)) ?? 0;
            if (have < amount) {
                throw new OwoUserError(`You silly hooman! You don't have enough cowoncy — you have **${have.toLocaleString('en-US')}**.`, 'insufficient_funds');
            }
            await lockLimitRowsTx(conn, guildId, [fromUserId, toUserId]);
            await bookAllowanceTx(conn, guildId, fromUserId, 'send', amount);
            await bookAllowanceTx(conn, guildId, toUserId, 'receive', amount, { name: receiverName });
            await debitTx(conn, guildId, fromUserId, amount);
            await creditTx(conn, guildId, toUserId, amount);
            await logTransferTx(conn, guildId, fromUserId, toUserId, amount);
            return { from: fromUserId, to: toUserId, amount, senderBalance: have - amount };
        }, { label: 'give' });
    } catch (e) {
        if (e instanceof OwoUserError) throw e;
        logger.error('[owo-cowoncy] transfer failed', { guildId, fromUserId, toUserId, amount, err: e.message, code: e.code });
        throw new Error('The transfer failed — nothing was moved. Please try again in a moment.');
    }
}

/**
 * Claim OwO's daily cowoncy. Independent of Economy's /economy earn daily —
 * uses owo_cowoncy.daily as the cooldown timestamp and owo_cowoncy.daily_streak
 * for streak tracking.
 *
 * Returns:
 *   - success: { totalAmount, baseAmount, streakBonus, streak, newBalance }
 *   - cooldown: { cooldown: true, remainingHours, remainingMinutes, availableAt }
 */
export async function claimDailyCowoncy(guildId, userId) {
    await ensureRow(guildId, userId);

    const [[row]] = await pool.execute(
        'SELECT money, daily, daily_streak FROM owo_cowoncy WHERE guild_id = ? AND id = ?',
        [guildId, userId]
    );
    const now = Date.now();
    const last = row?.daily ? new Date(row.daily).getTime() : 0;

    if (last > 0) {
        const elapsedMs = now - last;
        const elapsedH = elapsedMs / (1000 * 60 * 60);
        if (elapsedH < DAILY_COOLDOWN_HOURS) {
            const remainingMs = DAILY_COOLDOWN_HOURS * 60 * 60 * 1000 - elapsedMs;
            const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
            const remainingMinutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
            return {
                cooldown: true,
                remainingHours,
                remainingMinutes,
                availableAt: new Date(last + DAILY_COOLDOWN_HOURS * 3600 * 1000),
            };
        }
    }

    // Compute streak: continues if last claim was within grace window, else resets.
    let streak = 1;
    if (last > 0) {
        const elapsedH = (now - last) / (1000 * 60 * 60);
        if (elapsedH <= STREAK_GRACE_HOURS) {
            streak = (Number(row?.daily_streak) || 0) + 1;
        }
    }

    const streakBonus = Math.min(streak * DAILY_STREAK_STEP, DAILY_STREAK_CAP);
    const totalAmount = DAILY_BASE + streakBonus;

    await pool.execute(
        `UPDATE owo_cowoncy
         SET money = money + ?, daily = FROM_UNIXTIME(? / 1000), daily_streak = ?
         WHERE guild_id = ? AND id = ?`,
        [totalAmount, now, streak, guildId, userId]
    );

    return {
        totalAmount,
        baseAmount: DAILY_BASE,
        streakBonus,
        streak,
        newBalance: (Number(row?.money) || 0) + totalAmount,
    };
}

// Currency meta for OwO — independent of Economy config. The shape
// returns both `name`/`emoji` (original cowoncy API) AND
// `currency_name`/`currency_emoji` (economy-manager config-like) so
// downstream formatMoney() calls keep working without edits.
export async function getCurrencyMeta(/* guildId */) {
    return {
        name: CURRENCY_NAME,
        emoji: CURRENCY_EMOJI,
        currency_name: CURRENCY_NAME,
        currency_emoji: CURRENCY_EMOJI,
    };
}

export default {
    CURRENCY_NAME, CURRENCY_EMOJI,
    getCowoncy, addCowoncy, removeCowoncy, trySpendCowoncy,
    transferCowoncy, claimDailyCowoncy, getCurrencyMeta,
    ensureRowTx, lockBalancesTx, debitTx, creditTx,
};
