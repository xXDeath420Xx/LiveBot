/**
 * CertiFried Extension - Bot Command Handlers
 * Provides ready-to-use command implementations for Discord/Twitch chat
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import {
    getOrCreatePlayer,
    getPlayer,
    rewardCurrency,
    rewardXP,
    getPlayerStats
} from './bridge.js';
import { formatCurrency } from './formatters.js';
import { GAME } from '../config/game-constants.js';

/**
 * Handle !cfx or /cfx command - shows player stats
 * @param {object} user - { id, username, displayName, avatar? }
 * @param {'discord' | 'twitch' | 'kick'} platform
 * @returns {Promise<string>} Response message
 */
export async function handleStatsCommand(user, platform) {
    const stats = await getPlayerStats(user.id, platform);

    if (!stats) {
        return `${user.displayName}, you haven't started playing CertiFried yet! Open the extension to begin.`;
    }

    const parts = [
        `Level ${stats.level}`,
        `${formatCurrency(stats.currency)} coins`,
        `${stats.activePlots}/${stats.maxPlots} plots active`,
        `${stats.unlockedStrains} strains unlocked`
    ];

    if (stats.prestigeLevel > 0) {
        parts.push(`Prestige ${stats.prestigeLevel}`);
    }

    return `${user.displayName}'s Garden: ${parts.join(' | ')}`;
}

/**
 * Handle daily reward for CFX
 * Usually triggered alongside bot's existing daily command
 * @param {object} user
 * @param {'discord' | 'twitch' | 'kick'} platform
 * @param {number} [bonusMultiplier=1] - From bot streak bonuses
 */
export async function handleDailyReward(user, platform, bonusMultiplier = 1) {
    // Get or create player
    const player = await getOrCreatePlayer(user, platform);

    // Check if already claimed today
    const [[lastDaily]] = await pool.execute(
        `SELECT claimed_at FROM cfx_daily_claims
         WHERE player_id = ? AND DATE(claimed_at) = CURDATE()`,
        [player.id]
    );

    if (lastDaily) {
        return {
            success: false,
            message: `${user.displayName}, you already claimed your CertiFried daily reward today!`
        };
    }

    // Calculate reward
    const baseReward = GAME.DAILY_REWARD_BASE;
    const levelBonus = player.level * GAME.DAILY_REWARD_PER_LEVEL;
    const totalReward = Math.floor((baseReward + levelBonus) * bonusMultiplier);

    // Give reward
    const result = await rewardCurrency(user.id, platform, totalReward, 'daily_reward');

    if (!result.success) {
        return {
            success: false,
            message: `${user.displayName}, failed to claim daily: ${result.error}`
        };
    }

    // Record claim
    await pool.execute(
        `INSERT INTO cfx_daily_claims (player_id, amount, bonus_multiplier)
         VALUES (?, ?, ?)`,
        [player.id, totalReward, bonusMultiplier]
    );

    // Also give XP
    await rewardXP(user.id, platform, 50, 'daily_reward');

    return {
        success: true,
        amount: totalReward,
        message: `${user.displayName} collected ${formatCurrency(totalReward)} coins from their garden! (New balance: ${formatCurrency(result.newBalance)})`
    };
}

/**
 * Handle !cfxleaderboard or /cfxleaderboard
 * @param {'level' | 'currency' | 'prestige'} type
 * @param {number} limit
 */
export async function handleLeaderboardCommand(type = 'level', limit = 10) {
    const orderBy = {
        level: 'level DESC, xp DESC',
        currency: 'currency DESC',
        prestige: 'prestige_level DESC, prestige_tokens DESC'
    }[type] || 'level DESC';

    const [players] = await pool.execute(
        `SELECT display_name, level, currency, prestige_level
         FROM cfx_players
         WHERE is_banned = 0
         ORDER BY ${orderBy}
         LIMIT ?`,
        [limit]
    );

    if (players.length === 0) {
        return 'No players yet! Be the first to start growing.';
    }

    const lines = players.map((p, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const stat = type === 'level' ? `Lv.${p.level}` :
                     type === 'currency' ? formatCurrency(p.currency) :
                     `P${p.prestige_level}`;
        return `${medal} ${p.display_name}: ${stat}`;
    });

    return `🌿 CertiFried ${type.charAt(0).toUpperCase() + type.slice(1)} Leaderboard:\n${lines.join('\n')}`;
}

/**
 * Handle !cfxmarket - show current market prices
 */
export async function handleMarketCommand() {
    const [prices] = await pool.execute(
        `SELECT s.name, p.current_price, p.change_24h
         FROM cfx_market_prices p
         JOIN cfx_strains s ON p.strain_id = s.id
         ORDER BY p.current_price DESC
         LIMIT 5`
    );

    if (prices.length === 0) {
        return 'Market prices not available yet.';
    }

    const lines = prices.map(p => {
        const change = p.change_24h > 0 ? `+${p.change_24h.toFixed(1)}%` :
                       p.change_24h < 0 ? `${p.change_24h.toFixed(1)}%` : '0%';
        return `${p.name}: ${formatCurrency(p.current_price)} (${change})`;
    });

    return `📈 CertiFried Market (Top 5):\n${lines.join('\n')}`;
}

/**
 * Handle quick sell command (sell from inventory via chat)
 * @param {object} user
 * @param {'discord' | 'twitch' | 'kick'} platform
 * @param {string} strainName - Partial strain name to sell
 * @param {number} [quantity=1]
 */
export async function handleQuickSellCommand(user, platform, strainName, quantity = 1) {
    const player = await getPlayer(user.id, platform);

    if (!player) {
        return `${user.displayName}, start playing CertiFried first!`;
    }

    // Find matching strain in inventory
    const [inventory] = await pool.execute(
        `SELECT i.*, s.name as strain_name, p.current_price
         FROM cfx_inventory i
         JOIN cfx_strains s ON i.strain_id = s.id
         LEFT JOIN cfx_market_prices p ON i.strain_id = p.strain_id
         WHERE i.player_id = ? AND LOWER(s.name) LIKE ?
         ORDER BY i.quality DESC
         LIMIT 1`,
        [player.id, `%${strainName.toLowerCase()}%`]
    );

    if (inventory.length === 0) {
        return `${user.displayName}, you don't have any "${strainName}" in your inventory.`;
    }

    const item = inventory[0];
    const sellQty = Math.min(quantity, item.quantity);
    const pricePerUnit = Math.floor(item.current_price * (0.5 + item.quality / 100 * 1.5));
    const totalPrice = pricePerUnit * sellQty;

    // Remove from inventory
    if (sellQty >= item.quantity) {
        await pool.execute(`DELETE FROM cfx_inventory WHERE id = ?`, [item.id]);
    } else {
        await pool.execute(
            `UPDATE cfx_inventory SET quantity = quantity - ? WHERE id = ?`,
            [sellQty, item.id]
        );
    }

    // Add currency
    await pool.execute(
        `UPDATE cfx_players SET currency = currency + ? WHERE id = ?`,
        [totalPrice, player.id]
    );

    return `${user.displayName} sold ${sellQty}x ${item.strain_name} (${item.quality}% quality) for ${formatCurrency(totalPrice)}!`;
}

/**
 * Admin command: Gift currency to player
 * @param {string} targetPlatformId
 * @param {'discord' | 'twitch' | 'kick'} platform
 * @param {number} amount
 * @param {string} reason
 */
export async function adminGiftCurrency(targetPlatformId, platform, amount, reason = 'admin_gift') {
    const result = await rewardCurrency(targetPlatformId, platform, amount, reason);

    if (!result.success) {
        return { success: false, message: result.error };
    }

    return {
        success: true,
        message: `Gifted ${formatCurrency(amount)} to player. New balance: ${formatCurrency(result.newBalance)}`
    };
}

/**
 * Admin command: Reset player (for testing)
 * @param {string} targetPlatformId
 * @param {'discord' | 'twitch' | 'kick'} platform
 */
export async function adminResetPlayer(targetPlatformId, platform) {
    const player = await getPlayer(targetPlatformId, platform);

    if (!player) {
        return { success: false, message: 'Player not found' };
    }

    // Reset player stats
    await pool.execute(
        `UPDATE cfx_players
         SET level = 1, xp = 0, currency = 0, premium_currency = 0,
             prestige_level = 0, prestige_tokens = 0, facility_level = 1, max_plots = ?
         WHERE id = ?`,
        [GAME.STARTING_PLOTS, player.id]
    );

    // Clear related data
    await pool.execute(`DELETE FROM cfx_growing_plots WHERE player_id = ?`, [player.id]);
    await pool.execute(`DELETE FROM cfx_inventory WHERE player_id = ?`, [player.id]);
    await pool.execute(`DELETE FROM cfx_player_quests WHERE player_id = ?`, [player.id]);
    await pool.execute(`DELETE FROM cfx_player_skills WHERE player_id = ?`, [player.id]);

    // Keep starter strain only
    await pool.execute(
        `DELETE FROM cfx_player_strains
         WHERE player_id = ? AND source != 'starter'`,
        [player.id]
    );

    logger.warn('[BotCommands] Admin reset player', { playerId: player.id });

    return { success: true, message: 'Player reset to initial state' };
}

export default {
    handleStatsCommand,
    handleDailyReward,
    handleLeaderboardCommand,
    handleMarketCommand,
    handleQuickSellCommand,
    adminGiftCurrency,
    adminResetPlayer
};
