/*
 * Shared reward plumbing for emoji hunts, community goals, loyalty redemptions and tournaments.
 *
 *   coins → the live economy wallet (user_economy) + an economy_transactions 'reward' row, the
 *           same path daily challenges and achievements pay through.
 *   XP    → the owning bot's leveling manager (user_levels, level maths included).
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getEconomyConfig, getOrCreateUserEconomy, logTransaction } from './economy-manager.js';

/** The bot client that serves `guildId` (custom bots own some guilds), else `fallback`. */
export function clientFor(guildId, fallback = null) {
    const bm = global.botManager;
    return bm?.getClientForGuild?.(guildId) || fallback || bm?.getDefaultClient?.() || null;
}

/**
 * True when `client` is the bot that should act for `guildId`. Guilds served by a custom bot may
 * also contain the main bot; both receive the same gateway events, so only one may react.
 */
export function isOwningClient(client, guildId) {
    const owner = global.botManager?.getClientForGuild?.(guildId);
    return !owner || owner === client;
}

/**
 * Credit coins to a member's wallet. Throws if the wallet update itself fails (callers decide
 * whether to retry/refund); a failed ledger insert after the credit is only logged.
 */
export async function payCoins(guildId, userId, amount, description) {
    const n = Math.floor(Number(amount));
    if (!(n > 0)) return 0;
    const config = await getEconomyConfig(guildId);
    const economy = await getOrCreateUserEconomy(guildId, userId, config);
    const before = Number(economy.wallet) || 0;
    await pool.execute(
        'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
        [n, n, guildId, userId]
    );
    try {
        await logTransaction(guildId, userId, 'reward', n, before, before + n, String(description).slice(0, 500));
    } catch (err) {
        logger.error('[BGamesRewards] Coins paid but ledger row failed', { guildId, userId, amount: n, error: err.message });
    }
    return n;
}

/** Add XP through the owning bot's leveling manager. Returns false (and logs) if it is unavailable. */
export async function giveXP(guildId, userId, amount, context = '') {
    const n = Math.floor(Number(amount));
    if (!(n > 0)) return false;
    const bm = global.botManager;
    const lm = bm?.getClientForGuild?.(guildId)?.levelingManager || bm?.getDefaultClient?.()?.levelingManager || null;
    if (!lm) {
        logger.error('[BGamesRewards] Leveling manager unavailable — XP not paid', { guildId, userId, amount: n, context });
        return false;
    }
    await lm.addXP(guildId, userId, n);
    return true;
}

/** "🪙 500 coins" in the guild's own currency. */
export async function formatCoins(guildId, amount) {
    try {
        const cfg = await getEconomyConfig(guildId);
        return `${cfg.currency_emoji || '💰'} ${Number(amount).toLocaleString()} ${cfg.currency_name || 'coins'}`;
    } catch (err) {
        logger.warn('[BGamesRewards] Could not read economy config for currency label', { guildId, error: err.message });
        return `${Number(amount).toLocaleString()} coins`;
    }
}
