/**
 * CertiFried Extension - Bot Bridge
 * Provides integration between Discord/Twitch bot and the extension game
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { getPlayerMutex } from '../game/engine.js';
import { calculateBotBonuses } from '../game/bonus-resolver.js';
import { GAME, MARKET } from '../config/game-constants.js';

/**
 * Get or create a CFX player from bot user data
 * @param {object} botUser - Bot user data
 * @param {'discord' | 'twitch' | 'kick'} platform
 * @returns {Promise<object>} Player data
 */
export async function getOrCreatePlayer(botUser, platform) {
    const release = await getPlayerMutex(`${platform}:${botUser.id}`);

    try {
        // Check if player exists
        const [[existing]] = await pool.execute(
            `SELECT * FROM cfx_players WHERE platform = ? AND platform_user_id = ?`,
            [platform, botUser.id]
        );

        if (existing) {
            return existing;
        }

        // Create new player
        const displayName = botUser.displayName || botUser.username || botUser.id;
        const avatarUrl = botUser.avatar || botUser.avatarURL || null;

        const [result] = await pool.execute(
            `INSERT INTO cfx_players
             (platform, platform_user_id, display_name, avatar_url, facility_level, max_plots)
             VALUES (?, ?, ?, ?, 1, ?)`,
            [platform, botUser.id, displayName, avatarUrl, GAME.STARTING_PLOTS]
        );

        // Grant starter strains
        const [[starterStrain]] = await pool.execute(
            `SELECT id FROM cfx_strains WHERE rarity = 'common' AND is_starter = 1 LIMIT 1`
        );

        if (starterStrain) {
            await pool.execute(
                `INSERT INTO cfx_player_strains (player_id, strain_id, source)
                 VALUES (?, ?, 'starter')`,
                [result.insertId, starterStrain.id]
            );
        }

        // Fetch and return new player
        const [[newPlayer]] = await pool.execute(
            `SELECT * FROM cfx_players WHERE id = ?`,
            [result.insertId]
        );

        logger.info('[BotBridge] Created CFX player', {
            id: newPlayer.id,
            platform,
            displayName
        });

        return newPlayer;

    } finally {
        release();
    }
}

/**
 * Get CFX player by bot user
 * @param {string} platformUserId
 * @param {'discord' | 'twitch' | 'kick'} platform
 * @returns {Promise<object|null>}
 */
export async function getPlayer(platformUserId, platform) {
    const [[player]] = await pool.execute(
        `SELECT p.*, b.growth_speed_bonus, b.yield_bonus, b.xp_bonus, b.sell_price_bonus
         FROM cfx_players p
         LEFT JOIN cfx_player_bot_bonuses b ON p.id = b.player_id
         WHERE p.platform = ? AND p.platform_user_id = ?`,
        [platform, platformUserId]
    );
    return player || null;
}

/**
 * Reward currency to player (from bot commands, tokes, etc)
 * @param {string} platformUserId
 * @param {'discord' | 'twitch' | 'kick'} platform
 * @param {number} amount
 * @param {string} source - Reason for reward
 * @returns {Promise<{success: boolean, newBalance?: number, error?: string}>}
 */
export async function rewardCurrency(platformUserId, platform, amount, source = 'bot_reward') {
    const player = await getPlayer(platformUserId, platform);

    if (!player) {
        return { success: false, error: 'Player not found. Start playing at the extension first!' };
    }

    const release = await getPlayerMutex(player.id);

    try {
        await pool.execute(
            `UPDATE cfx_players SET currency = currency + ? WHERE id = ?`,
            [amount, player.id]
        );

        // Log transaction
        await pool.execute(
            `INSERT INTO cfx_transactions (player_id, type, amount, source, balance_after)
             VALUES (?, 'credit', ?, ?, (SELECT currency FROM cfx_players WHERE id = ?))`,
            [player.id, amount, source, player.id]
        );

        const [[updated]] = await pool.execute(
            `SELECT currency FROM cfx_players WHERE id = ?`,
            [player.id]
        );

        logger.debug('[BotBridge] Rewarded currency', {
            playerId: player.id,
            amount,
            source,
            newBalance: updated.currency
        });

        return { success: true, newBalance: updated.currency };

    } finally {
        release();
    }
}

/**
 * Reward XP to player
 * @param {string} platformUserId
 * @param {'discord' | 'twitch' | 'kick'} platform
 * @param {number} amount
 * @param {string} source
 * @returns {Promise<{success: boolean, leveledUp?: boolean, newLevel?: number, error?: string}>}
 */
export async function rewardXP(platformUserId, platform, amount, source = 'bot_reward') {
    const player = await getPlayer(platformUserId, platform);

    if (!player) {
        return { success: false, error: 'Player not found' };
    }

    const release = await getPlayerMutex(player.id);

    try {
        // Apply XP bonus from bot bonuses
        const bonus = player.xp_bonus || 0;
        const totalXP = Math.floor(amount * (1 + bonus));

        await pool.execute(
            `UPDATE cfx_players SET xp = xp + ? WHERE id = ?`,
            [totalXP, player.id]
        );

        // Check for level up
        const [[updated]] = await pool.execute(
            `SELECT xp, level FROM cfx_players WHERE id = ?`,
            [player.id]
        );

        const xpRequired = GAME.BASE_XP_PER_LEVEL * Math.pow(GAME.XP_SCALING_FACTOR, updated.level - 1);
        let leveledUp = false;
        let newLevel = updated.level;

        if (updated.xp >= xpRequired) {
            // Level up
            newLevel = updated.level + 1;
            await pool.execute(
                `UPDATE cfx_players SET level = ?, xp = xp - ? WHERE id = ?`,
                [newLevel, xpRequired, player.id]
            );
            leveledUp = true;

            logger.info('[BotBridge] Player leveled up', {
                playerId: player.id,
                newLevel
            });
        }

        return { success: true, leveledUp, newLevel };

    } finally {
        release();
    }
}

/**
 * Grant a strain to player
 * @param {string} platformUserId
 * @param {'discord' | 'twitch' | 'kick'} platform
 * @param {number} strainId
 * @param {string} source
 * @returns {Promise<{success: boolean, strainName?: string, error?: string}>}
 */
export async function grantStrain(platformUserId, platform, strainId, source = 'bot_reward') {
    const player = await getPlayer(platformUserId, platform);

    if (!player) {
        return { success: false, error: 'Player not found' };
    }

    // Check if already has strain
    const [[existing]] = await pool.execute(
        `SELECT id FROM cfx_player_strains WHERE player_id = ? AND strain_id = ?`,
        [player.id, strainId]
    );

    if (existing) {
        return { success: false, error: 'Player already has this strain' };
    }

    // Get strain info
    const [[strain]] = await pool.execute(
        `SELECT name FROM cfx_strains WHERE id = ?`,
        [strainId]
    );

    if (!strain) {
        return { success: false, error: 'Strain not found' };
    }

    await pool.execute(
        `INSERT INTO cfx_player_strains (player_id, strain_id, source)
         VALUES (?, ?, ?)`,
        [player.id, strainId, source]
    );

    logger.info('[BotBridge] Granted strain', {
        playerId: player.id,
        strainId,
        strainName: strain.name
    });

    return { success: true, strainName: strain.name };
}

/**
 * Add harvested product to player's inventory
 * @param {string} platformUserId
 * @param {'discord' | 'twitch' | 'kick'} platform
 * @param {number} strainId
 * @param {number} quantity
 * @param {number} quality
 * @param {string} source
 */
export async function addToInventory(platformUserId, platform, strainId, quantity, quality, source = 'bot_reward') {
    const player = await getPlayer(platformUserId, platform);

    if (!player) {
        return { success: false, error: 'Player not found' };
    }

    const [[existing]] = await pool.execute(
        `SELECT id FROM cfx_inventory
         WHERE player_id = ? AND strain_id = ? AND quality = ?`,
        [player.id, strainId, quality]
    );

    if (existing) {
        await pool.execute(
            `UPDATE cfx_inventory SET quantity = quantity + ? WHERE id = ?`,
            [quantity, existing.id]
        );
    } else {
        await pool.execute(
            `INSERT INTO cfx_inventory (player_id, strain_id, quantity, quality, source)
             VALUES (?, ?, ?, ?, ?)`,
            [player.id, strainId, quantity, quality, source]
        );
    }

    return { success: true };
}

/**
 * Sync bot stats to CFX bonuses
 * Called when bot stats update (daily command, streak, level up, etc)
 * @param {string} platformUserId
 * @param {'twitch'} platform
 * @param {object} botStats - { level, daily_streak, total_tokes, longest_streak }
 */
export async function syncBotBonuses(platformUserId, platform, botStats) {
    const player = await getPlayer(platformUserId, platform);

    if (!player) {
        return { success: false, error: 'Player not found' };
    }

    const bonuses = calculateBotBonuses(botStats);

    await pool.execute(
        `INSERT INTO cfx_player_bot_bonuses
         (player_id, bot_level, bot_lifetime_tokes, bot_current_streak, bot_best_streak,
          growth_speed_bonus, yield_bonus, xp_bonus, sell_price_bonus, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
          bot_level = VALUES(bot_level),
          bot_lifetime_tokes = VALUES(bot_lifetime_tokes),
          bot_current_streak = VALUES(bot_current_streak),
          bot_best_streak = VALUES(bot_best_streak),
          growth_speed_bonus = VALUES(growth_speed_bonus),
          yield_bonus = VALUES(yield_bonus),
          xp_bonus = VALUES(xp_bonus),
          sell_price_bonus = VALUES(sell_price_bonus),
          synced_at = NOW()`,
        [
            player.id,
            botStats.level || 1,
            botStats.total_tokes || 0,
            botStats.daily_streak || 0,
            botStats.longest_streak || 0,
            bonuses.growth_speed_bonus,
            bonuses.yield_bonus,
            bonuses.xp_bonus,
            bonuses.sell_price_bonus
        ]
    );

    return { success: true, bonuses };
}

/**
 * Get player stats for bot display
 * @param {string} platformUserId
 * @param {'discord' | 'twitch' | 'kick'} platform
 */
export async function getPlayerStats(platformUserId, platform) {
    const player = await getPlayer(platformUserId, platform);

    if (!player) {
        return null;
    }

    // Get additional stats
    const [[inventoryCount]] = await pool.execute(
        `SELECT COALESCE(SUM(quantity), 0) as total FROM cfx_inventory WHERE player_id = ?`,
        [player.id]
    );

    const [[plotCount]] = await pool.execute(
        `SELECT COUNT(*) as count FROM cfx_growing_plots WHERE player_id = ?`,
        [player.id]
    );

    const [[strainCount]] = await pool.execute(
        `SELECT COUNT(*) as count FROM cfx_player_strains WHERE player_id = ?`,
        [player.id]
    );

    return {
        level: player.level,
        xp: player.xp,
        currency: player.currency,
        premiumCurrency: player.premium_currency,
        prestigeLevel: player.prestige_level,
        facilityLevel: player.facility_level,
        maxPlots: player.max_plots,
        activePlots: plotCount.count,
        inventoryItems: inventoryCount.total,
        unlockedStrains: strainCount.count,
        bonuses: {
            growthSpeed: player.growth_speed_bonus || 0,
            yield: player.yield_bonus || 0,
            xp: player.xp_bonus || 0,
            sellPrice: player.sell_price_bonus || 0
        }
    };
}

export default {
    getOrCreatePlayer,
    getPlayer,
    rewardCurrency,
    rewardXP,
    grantStrain,
    addToInventory,
    syncBotBonuses,
    getPlayerStats
};
