import db from '../utils/db.js';
import logger from '../utils/logger.js';

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get or create user economy profile
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {Object} config - Economy configuration
 * @returns {Promise<Object>} User economy data
 */
export async function getOrCreateUserEconomy(guildId, userId, config) {
    const [rows] = await db.execute(
        'SELECT id, guild_id, user_id, wallet, bank, bank_capacity, daily_streak, work_streak, last_daily, last_weekly, last_work, last_crime, last_rob, total_earned FROM user_economy WHERE guild_id = ? AND user_id = ?',
        [guildId, userId]
    );

    if (rows && rows.length > 0) {
        return rows[0];
    }

    // Create new economy profile and return the data directly (avoid duplicate SELECT)
    const startingBalance = config.starting_balance || 1000;
    const bankCapacity = startingBalance * 10;

    const [result] = await db.execute(
        `INSERT INTO user_economy (guild_id, user_id, wallet, bank, bank_capacity)
         VALUES (?, ?, ?, 0, ?)`,
        [guildId, userId, startingBalance, bankCapacity]
    );

    // Return constructed object instead of re-querying
    return {
        id: result.insertId,
        guild_id: guildId,
        user_id: userId,
        wallet: startingBalance,
        bank: 0,
        bank_capacity: bankCapacity,
        daily_streak: 0,
        work_streak: 0,
        last_daily: null,
        last_weekly: null,
        last_work: null,
        last_crime: null,
        last_rob: null,
        total_earned: 0
    };
}

/**
 * Get economy configuration for a guild
 * @param {string} guildId - Guild ID
 * @returns {Promise<Object>} Economy configuration
 */
export async function getEconomyConfig(guildId) {
    const [rows] = await db.execute(
        'SELECT guild_id, enabled, currency_name, currency_emoji, starting_balance, daily_amount, weekly_amount, work_min_amount, work_max_amount, work_cooldown, crime_min_amount, crime_max_amount, crime_success_rate, crime_fine_multiplier, rob_min_amount, rob_max_amount, rob_success_rate, rob_fine_amount, allow_gifting FROM economy_config WHERE guild_id = ?',
        [guildId]
    );

    if (rows && rows.length > 0) {
        return rows[0];
    }

    // Return default config
    return {
        enabled: true,
        currency_name: 'coins',
        currency_emoji: '💰',
        starting_balance: 1000,
        daily_amount: 500,
        weekly_amount: 3500,
        work_min_amount: 100,
        work_max_amount: 500,
        work_cooldown: 3600, // 1 hour in seconds
        crime_min_amount: 500,
        crime_max_amount: 2000,
        crime_success_rate: 0.5,
        crime_fine_multiplier: 1.5,
        rob_min_amount: 500,
        rob_max_amount: 5000,
        rob_success_rate: 0.4,
        rob_fine_amount: 1000,
        allow_gifting: true
    };
}

/**
 * Log a transaction
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {string} type - Transaction type
 * @param {number} amount - Amount
 * @param {number} balanceBefore - Balance before transaction
 * @param {number} balanceAfter - Balance after transaction
 * @param {string|null} description - Transaction description
 * @param {string|null} relatedUserId - Related user ID
 * @param {number|null} relatedItemId - Related item ID
 */
export async function logTransaction(
    guildId,
    userId,
    type,
    amount,
    balanceBefore,
    balanceAfter,
    description = null,
    relatedUserId = null,
    relatedItemId = null
) {
    await db.execute(
        `INSERT INTO economy_transactions (guild_id, user_id, transaction_type, amount, balance_before, balance_after, description, related_user_id, related_item_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [guildId, userId, type, amount, balanceBefore, balanceAfter, description, relatedUserId, relatedItemId]
    );
}

/**
 * Format money with currency emoji and name
 * @param {number} amount - Amount to format
 * @param {Object} config - Economy configuration
 * @returns {string} Formatted money string
 */
export function formatMoney(amount, config) {
    return `${config.currency_emoji} ${amount.toLocaleString()} ${config.currency_name}`;
}

// ============================================
// BALANCE OPERATIONS
// ============================================

/**
 * Get user balance
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @returns {Promise<Object>} User economy data
 */
export async function getBalance(guildId, userId) {
    const config = await getEconomyConfig(guildId);
    return await getOrCreateUserEconomy(guildId, userId, config);
}

/**
 * Add currency to user's wallet
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} amount - Amount to add
 * @param {string} reason - Reason for addition
 * @returns {Promise<Object>} Updated economy data
 */
export async function addCurrency(guildId, userId, amount, reason = 'Admin addition') {
    const config = await getEconomyConfig(guildId);
    const economy = await getOrCreateUserEconomy(guildId, userId, config);

    await db.execute(
        'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
        [amount, amount, guildId, userId]
    );

    await logTransaction(
        guildId,
        userId,
        'reward',
        amount,
        economy.wallet,
        economy.wallet + amount,
        reason
    );

    economy.wallet += amount;
    return economy;
}

/**
 * Remove currency from user's wallet
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} amount - Amount to remove
 * @param {string} reason - Reason for removal
 * @returns {Promise<Object>} Updated economy data
 */
export async function removeCurrency(guildId, userId, amount, reason = 'Admin removal') {
    const config = await getEconomyConfig(guildId);
    const economy = await getOrCreateUserEconomy(guildId, userId, config);

    const actualAmount = Math.min(amount, economy.wallet);

    await db.execute(
        'UPDATE user_economy SET wallet = wallet - ? WHERE guild_id = ? AND user_id = ?',
        [actualAmount, guildId, userId]
    );

    await logTransaction(
        guildId,
        userId,
        'fine',
        -actualAmount,
        economy.wallet,
        economy.wallet - actualAmount,
        reason
    );

    economy.wallet -= actualAmount;
    return economy;
}

/**
 * Transfer currency between users
 * @param {string} guildId - Guild ID
 * @param {string} senderId - Sender user ID
 * @param {string} receiverId - Receiver user ID
 * @param {number} amount - Amount to transfer
 * @returns {Promise<boolean>} Success status
 */
export async function transferCurrency(guildId, senderId, receiverId, amount) {
    const config = await getEconomyConfig(guildId);

    if (!config.allow_gifting) {
        throw new Error('Transfers are disabled in this server');
    }

    const senderEconomy = await getOrCreateUserEconomy(guildId, senderId, config);
    const receiverEconomy = await getOrCreateUserEconomy(guildId, receiverId, config);

    if (amount > senderEconomy.wallet) {
        throw new Error('Insufficient funds');
    }

    // Use transaction to ensure atomicity
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // Deduct from sender
        await connection.execute(
            'UPDATE user_economy SET wallet = wallet - ? WHERE guild_id = ? AND user_id = ?',
            [amount, guildId, senderId]
        );

        // Add to receiver
        await connection.execute(
            'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
            [amount, amount, guildId, receiverId]
        );

        await connection.commit();

        // Log transactions (outside of transaction)
        await logTransaction(
            guildId,
            senderId,
            'transfer',
            -amount,
            senderEconomy.wallet,
            senderEconomy.wallet - amount,
            `Transferred to user ${receiverId}`,
            receiverId
        );

        await logTransaction(
            guildId,
            receiverId,
            'transfer',
            amount,
            receiverEconomy.wallet,
            receiverEconomy.wallet + amount,
            `Received from user ${senderId}`,
            senderId
        );

        return true;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

// ============================================
// DAILY/WEEKLY REWARDS
// ============================================

/**
 * Claim daily reward
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Reward information
 */
export async function claimDaily(guildId, userId) {
    const config = await getEconomyConfig(guildId);
    const economy = await getOrCreateUserEconomy(guildId, userId, config);

    console.log(`[Economy Daily] ENTRY - userId: ${userId}, last_daily raw: ${economy.last_daily}, type: ${typeof economy.last_daily}`);

    // Check cooldown
    if (economy.last_daily) {
        // MySQL returns datetime in server timezone (PST), but JS Date() interprets it as local
        // We need to handle this properly
        let lastDaily;
        if (economy.last_daily instanceof Date) {
            lastDaily = economy.last_daily;
        } else {
            // If it's a string, parse it as UTC since MySQL stores in server time
            lastDaily = new Date(economy.last_daily);
        }

        const now = new Date();
        const timeDiff = now.getTime() - lastDaily.getTime();
        const hoursSince = timeDiff / (1000 * 60 * 60);

        console.log(`[Economy Daily] Debug - Now: ${now.toISOString()}, LastDaily: ${lastDaily.toISOString()}, Raw: ${economy.last_daily}, Hours since: ${hoursSince.toFixed(2)}`);

        if (hoursSince < 24) {
            const hoursLeft = Math.ceil(24 - hoursSince);
            console.log(`[Economy Daily] Debug - Hours left: ${hoursLeft}`);
            throw new Error(`Already claimed! Come back in ${hoursLeft} hours.`);
        }

        // Check if streak continues (within 48 hours)
        if (hoursSince <= 48) {
            await db.execute(
                'UPDATE user_economy SET daily_streak = daily_streak + 1 WHERE guild_id = ? AND user_id = ?',
                [guildId, userId]
            );
            economy.daily_streak += 1;
        } else {
            // Streak broken
            await db.execute(
                'UPDATE user_economy SET daily_streak = 1 WHERE guild_id = ? AND user_id = ?',
                [guildId, userId]
            );
            economy.daily_streak = 1;
        }
    } else {
        // First daily
        economy.daily_streak = 1;
    }

    // Calculate reward with streak bonus
    const baseAmount = config.daily_amount;
    const streakBonus = Math.min(economy.daily_streak * 50, 1000); // Max 1000 bonus
    const totalAmount = baseAmount + streakBonus;

    // Add to wallet
    await db.execute(
        'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ?, last_daily = NOW() WHERE guild_id = ? AND user_id = ?',
        [totalAmount, totalAmount, guildId, userId]
    );

    await logTransaction(
        guildId,
        userId,
        'daily',
        totalAmount,
        economy.wallet,
        economy.wallet + totalAmount,
        `Daily reward with ${economy.daily_streak}x streak`
    );

    return {
        totalAmount,
        baseAmount,
        streakBonus,
        streak: economy.daily_streak,
        newBalance: economy.wallet + totalAmount
    };
}

/**
 * Claim weekly reward
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Reward information
 */
export async function claimWeekly(guildId, userId) {
    const config = await getEconomyConfig(guildId);
    const economy = await getOrCreateUserEconomy(guildId, userId, config);

    // Check cooldown (7 days)
    if (economy.last_weekly) {
        const lastWeekly = new Date(economy.last_weekly);
        const now = new Date();
        const daysSince = (now.getTime() - lastWeekly.getTime()) / (1000 * 60 * 60 * 24);

        if (daysSince < 7) {
            const daysLeft = Math.ceil(7 - daysSince);
            throw new Error(`Already claimed! Come back in ${daysLeft} days.`);
        }
    }

    const amount = config.weekly_amount;

    await db.execute(
        'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ?, last_weekly = NOW() WHERE guild_id = ? AND user_id = ?',
        [amount, amount, guildId, userId]
    );

    await logTransaction(
        guildId,
        userId,
        'weekly',
        amount,
        economy.wallet,
        economy.wallet + amount,
        'Weekly reward'
    );

    return {
        amount,
        newBalance: economy.wallet + amount
    };
}

// ============================================
// WORK COMMAND
// ============================================

/**
 * Work for money
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Work result
 */
export async function work(guildId, userId) {
    const config = await getEconomyConfig(guildId);
    const economy = await getOrCreateUserEconomy(guildId, userId, config);

    // Check cooldown
    if (economy.last_work) {
        const lastWork = new Date(economy.last_work);
        const now = new Date();
        const secondsSince = (now.getTime() - lastWork.getTime()) / 1000;

        if (secondsSince < config.work_cooldown) {
            const secondsLeft = Math.ceil(config.work_cooldown - secondsSince);
            const minutesLeft = Math.ceil(secondsLeft / 60);
            throw new Error(`You're tired! Rest for ${minutesLeft} more minutes before working again.`);
        }
    }

    // Random work scenarios
    const jobs = [
        { name: 'Pizza Delivery', emoji: '🍕' },
        { name: 'Dog Walking', emoji: '🐕' },
        { name: 'Car Wash', emoji: '🚗' },
        { name: 'Lawn Mowing', emoji: '🌿' },
        { name: 'Grocery Bagging', emoji: '🛒' },
        { name: 'Package Delivery', emoji: '📦' },
        { name: 'Babysitting', emoji: '👶' },
        { name: 'Tutoring', emoji: '📚' }
    ];

    const job = jobs[Math.floor(Math.random() * jobs.length)];
    const amount = Math.floor(Math.random() * (config.work_max_amount - config.work_min_amount + 1)) + config.work_min_amount;

    // Work streak bonus
    const streakBonus = Math.min(economy.work_streak * 10, 500);
    const totalAmount = amount + streakBonus;

    await db.execute(
        'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ?, last_work = NOW(), work_streak = work_streak + 1 WHERE guild_id = ? AND user_id = ?',
        [totalAmount, totalAmount, guildId, userId]
    );

    await logTransaction(
        guildId,
        userId,
        'work',
        totalAmount,
        economy.wallet,
        economy.wallet + totalAmount,
        `Worked as ${job.name}`
    );

    return {
        job,
        totalAmount,
        baseAmount: amount,
        streakBonus,
        streak: economy.work_streak + 1,
        newBalance: economy.wallet + totalAmount
    };
}

// ============================================
// CRIME MECHANICS
// ============================================

/**
 * Commit a crime
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Crime result
 */
export async function commitCrime(guildId, userId) {
    const config = await getEconomyConfig(guildId);
    const economy = await getOrCreateUserEconomy(guildId, userId, config);

    // Check cooldown (30 minutes)
    if (economy.last_crime) {
        const lastCrime = new Date(economy.last_crime);
        const now = new Date();
        const minutesSince = (now.getTime() - lastCrime.getTime()) / (1000 * 60);

        if (minutesSince < 30) {
            const minutesLeft = Math.ceil(30 - minutesSince);
            throw new Error(`The heat is still on! Wait ${minutesLeft} more minutes before committing another crime.`);
        }
    }

    const success = Math.random() < config.crime_success_rate;

    const crimes = [
        { name: 'Robbed a bank', emoji: '🏦' },
        { name: 'Stole a car', emoji: '🚗' },
        { name: 'Pickpocketed someone', emoji: '👛' },
        { name: 'Sold contraband', emoji: '📦' },
        { name: 'Hacked a system', emoji: '💻' }
    ];

    const crime = crimes[Math.floor(Math.random() * crimes.length)];
    const amount = Math.floor(Math.random() * (config.crime_max_amount - config.crime_min_amount + 1)) + config.crime_min_amount;

    if (success) {
        await db.execute(
            'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ?, last_crime = NOW() WHERE guild_id = ? AND user_id = ?',
            [amount, amount, guildId, userId]
        );

        await logTransaction(
            guildId,
            userId,
            'crime',
            amount,
            economy.wallet,
            economy.wallet + amount,
            `Successfully ${crime.name.toLowerCase()}`
        );

        return {
            success: true,
            crime,
            amount,
            newBalance: economy.wallet + amount
        };
    } else {
        const fine = Math.floor(amount * config.crime_fine_multiplier);
        const actualFine = Math.min(fine, economy.wallet); // Can't take more than they have

        await db.execute(
            'UPDATE user_economy SET wallet = wallet - ?, last_crime = NOW() WHERE guild_id = ? AND user_id = ?',
            [actualFine, guildId, userId]
        );

        await logTransaction(
            guildId,
            userId,
            'fine',
            -actualFine,
            economy.wallet,
            economy.wallet - actualFine,
            `Caught trying to ${crime.name.toLowerCase()}`
        );

        return {
            success: false,
            crime,
            fine: actualFine,
            newBalance: economy.wallet - actualFine
        };
    }
}

/**
 * Rob another user
 * @param {string} guildId - Guild ID
 * @param {string} robberId - Robber user ID
 * @param {string} targetId - Target user ID
 * @returns {Promise<Object>} Rob result
 */
export async function robUser(guildId, robberId, targetId) {
    const config = await getEconomyConfig(guildId);
    const robberEconomy = await getOrCreateUserEconomy(guildId, robberId, config);
    const targetEconomy = await getOrCreateUserEconomy(guildId, targetId, config);

    // Check robber's cooldown
    if (robberEconomy.last_rob) {
        const lastRob = new Date(robberEconomy.last_rob);
        const now = new Date();
        const hoursSince = (now.getTime() - lastRob.getTime()) / (1000 * 60 * 60);

        if (hoursSince < 1) {
            const minutesLeft = Math.ceil((1 - hoursSince) * 60);
            throw new Error(`You need to wait ${minutesLeft} more minutes before robbing again!`);
        }
    }

    // Target must have at least 500 in wallet
    if (targetEconomy.wallet < 500) {
        throw new Error('Target doesn\'t have enough money in their wallet to rob! (Minimum: 500)');
    }

    const success = Math.random() < config.rob_success_rate;

    if (success) {
        const maxSteal = Math.min(targetEconomy.wallet, config.rob_max_amount);
        const minSteal = Math.min(config.rob_min_amount, maxSteal);
        const stolenAmount = Math.floor(Math.random() * (maxSteal - minSteal + 1)) + minSteal;

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            // Transfer money
            await connection.execute(
                'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ?, last_rob = NOW() WHERE guild_id = ? AND user_id = ?',
                [stolenAmount, stolenAmount, guildId, robberId]
            );

            await connection.execute(
                'UPDATE user_economy SET wallet = wallet - ? WHERE guild_id = ? AND user_id = ?',
                [stolenAmount, guildId, targetId]
            );

            await connection.commit();

            // Log transactions
            await logTransaction(
                guildId,
                robberId,
                'rob',
                stolenAmount,
                robberEconomy.wallet,
                robberEconomy.wallet + stolenAmount,
                `Successfully robbed user ${targetId}`,
                targetId
            );

            await logTransaction(
                guildId,
                targetId,
                'rob',
                -stolenAmount,
                targetEconomy.wallet,
                targetEconomy.wallet - stolenAmount,
                `Robbed by user ${robberId}`,
                robberId
            );

            return {
                success: true,
                stolenAmount,
                newBalance: robberEconomy.wallet + stolenAmount
            };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } else {
        const fine = config.rob_fine_amount;
        const actualFine = Math.min(fine, robberEconomy.wallet);

        await db.execute(
            'UPDATE user_economy SET wallet = wallet - ?, last_rob = NOW() WHERE guild_id = ? AND user_id = ?',
            [actualFine, guildId, robberId]
        );

        await logTransaction(
            guildId,
            robberId,
            'fine',
            -actualFine,
            robberEconomy.wallet,
            robberEconomy.wallet - actualFine,
            `Failed to rob user ${targetId}`,
            targetId
        );

        return {
            success: false,
            fine: actualFine,
            newBalance: robberEconomy.wallet - actualFine
        };
    }
}

// ============================================
// BANK OPERATIONS
// ============================================

/**
 * Deposit money into bank
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} amount - Amount to deposit
 * @returns {Promise<Object>} Result
 */
export async function deposit(guildId, userId, amount) {
    const config = await getEconomyConfig(guildId);
    const economy = await getOrCreateUserEconomy(guildId, userId, config);

    if (amount > economy.wallet) {
        throw new Error('Insufficient funds in wallet');
    }

    const spaceInBank = economy.bank_capacity - economy.bank;
    if (amount > spaceInBank) {
        throw new Error(`Your bank only has space for ${spaceInBank} more!`);
    }

    await db.execute(
        'UPDATE user_economy SET wallet = wallet - ?, bank = bank + ? WHERE guild_id = ? AND user_id = ?',
        [amount, amount, guildId, userId]
    );

    return {
        amount,
        newWallet: economy.wallet - amount,
        newBank: economy.bank + amount
    };
}

/**
 * Withdraw money from bank
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} amount - Amount to withdraw
 * @returns {Promise<Object>} Result
 */
export async function withdraw(guildId, userId, amount) {
    const config = await getEconomyConfig(guildId);
    const economy = await getOrCreateUserEconomy(guildId, userId, config);

    if (amount > economy.bank) {
        throw new Error('Insufficient funds in bank');
    }

    await db.execute(
        'UPDATE user_economy SET wallet = wallet + ?, bank = bank - ? WHERE guild_id = ? AND user_id = ?',
        [amount, amount, guildId, userId]
    );

    return {
        amount,
        newWallet: economy.wallet + amount,
        newBank: economy.bank - amount
    };
}

// ============================================
// LEADERBOARD & TRANSACTIONS
// ============================================

/**
 * Get economy leaderboard
 * @param {string} guildId - Guild ID
 * @param {number} limit - Number of users to return
 * @returns {Promise<Array>} Leaderboard entries
 */
export async function getLeaderboard(guildId, limit = 10) {
    const [rows] = await db.execute(
        `SELECT user_id, wallet, bank, (wallet + bank) as net_worth
         FROM user_economy
         WHERE guild_id = ?
         ORDER BY net_worth DESC
         LIMIT ?`,
        [guildId, limit]
    );

    return rows;
}

/**
 * Get user transactions
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} limit - Number of transactions to return
 * @returns {Promise<Array>} Transactions
 */
export async function getTransactions(guildId, userId, limit = 10) {
    const [rows] = await db.execute(
        `SELECT * FROM economy_transactions
         WHERE guild_id = ? AND user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [guildId, userId, limit]
    );

    return rows;
}

// ============================================
// EXPORTS
// ============================================

export default {
    getOrCreateUserEconomy,
    getEconomyConfig,
    logTransaction,
    formatMoney,
    getBalance,
    addCurrency,
    removeCurrency,
    transferCurrency,
    claimDaily,
    claimWeekly,
    work,
    commitCrime,
    robUser,
    deposit,
    withdraw,
    getLeaderboard,
    getTransactions
};
