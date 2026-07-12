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

// OwO currency identity — separate from the guild's Economy currency.
export const CURRENCY_NAME = 'cowoncy';
export const CURRENCY_EMOJI = '💵';

const DAILY_BASE = 200;                  // upstream-aligned base
const DAILY_STREAK_STEP = 50;            // +50 per streak day
const DAILY_STREAK_CAP = 1000;           // max 1000 bonus
const DAILY_COOLDOWN_HOURS = 24;
const STREAK_GRACE_HOURS = 48;           // streak resets if user lapses past this

async function ensureRow(guildId, userId) {
    await pool.execute(
        `INSERT IGNORE INTO owo_cowoncy (guild_id, id, money, daily_streak) VALUES (?, ?, 0, 0)`,
        [guildId, userId]
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

export async function transferCowoncy(guildId, fromUserId, toUserId, amount) {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be > 0');
    if (fromUserId === toUserId) throw new Error('Cannot transfer to yourself');
    const spend = await trySpendCowoncy(guildId, fromUserId, amount, `transfer to ${toUserId}`);
    if (!spend.ok) throw new Error(`Insufficient cowoncy — have ${spend.balance}, need ${amount}`);
    await addCowoncy(guildId, toUserId, amount, `transfer from ${fromUserId}`);
    return { from: fromUserId, to: toUserId, amount };
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
};
