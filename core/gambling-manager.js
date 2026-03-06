import db from '../utils/db.js';
import logger from '../utils/logger.js';
import { getOrCreateUserEconomy, getEconomyConfig, formatMoney, logTransaction } from './economy-manager.js';

// ============================================
// GAMBLING CONFIGURATION
// ============================================

/**
 * Get gambling configuration for a guild
 * @param {string} guildId - Guild ID
 * @returns {Promise<Object>} Gambling configuration
 */
export async function getGamblingConfig(guildId) {
    const [rows] = await db.execute(
        'SELECT * FROM gambling_config WHERE guild_id = ?',
        [guildId]
    );

    if (rows && rows.length > 0) {
        return rows[0];
    }

    // Return default config
    return {
        enabled: true,
        max_bet_amount: 10000,
        house_edge: 0.05, // 5% house edge
        cooldown_seconds: 5
    };
}

/**
 * Log a gambling result
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {string} gameType - Game type
 * @param {number} betAmount - Bet amount
 * @param {number} winAmount - Win amount
 * @param {string} result - Game result
 */
async function logGamble(guildId, userId, gameType, betAmount, winAmount, result) {
    await db.execute(
        `INSERT INTO gambling_history (guild_id, user_id, game_type, bet_amount, win_amount, result)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [guildId, userId, gameType, betAmount, winAmount, result]
    );
}

/**
 * Validate gambling bet
 * @param {Object} userEconomy - User economy data
 * @param {number} betAmount - Bet amount
 * @param {Object} config - Economy config
 * @param {Object} gamblingConfig - Gambling config
 * @throws {Error} If bet is invalid
 */
function validateBet(userEconomy, betAmount, config, gamblingConfig) {
    if (betAmount > userEconomy.wallet) {
        throw new Error(`You don't have enough ${config.currency_name}! You only have ${formatMoney(userEconomy.wallet, config)}.`);
    }

    if (betAmount > gamblingConfig.max_bet_amount) {
        throw new Error(`Maximum bet amount is ${formatMoney(gamblingConfig.max_bet_amount, config)}!`);
    }

    if (betAmount < 1) {
        throw new Error('Bet amount must be at least 1!');
    }
}

// ============================================
// COINFLIP
// ============================================

/**
 * Play coinflip game
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} betAmount - Bet amount
 * @param {string} userChoice - User's choice (heads or tails)
 * @returns {Promise<Object>} Game result
 */
export async function playCoinflip(guildId, userId, betAmount, userChoice) {
    const config = await getEconomyConfig(guildId);
    const gamblingConfig = await getGamblingConfig(guildId);
    const userEconomy = await getOrCreateUserEconomy(guildId, userId, config);

    if (!gamblingConfig.enabled) {
        throw new Error('Gambling is disabled in this server');
    }

    validateBet(userEconomy, betAmount, config, gamblingConfig);

    // Flip the coin
    const result = Math.random() < 0.5 ? 'heads' : 'tails';
    const won = result === userChoice.toLowerCase();
    const winAmount = won ? betAmount : 0;
    const netChange = won ? betAmount : -betAmount;

    // Update balance
    await db.execute(
        'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
        [netChange, won ? betAmount : 0, guildId, userId]
    );

    // Log gambling history
    await logGamble(guildId, userId, 'coinflip', betAmount, winAmount, result);

    // Log transaction
    await logTransaction(
        guildId,
        userId,
        'gamble',
        netChange,
        userEconomy.wallet,
        userEconomy.wallet + netChange,
        `Coinflip (${result}) - ${won ? 'Won' : 'Lost'}`
    );

    return {
        won,
        result,
        userChoice,
        betAmount,
        winAmount,
        netChange,
        newBalance: userEconomy.wallet + netChange
    };
}

// ============================================
// DICE
// ============================================

/**
 * Play dice game
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} betAmount - Bet amount
 * @param {number} prediction - Predicted total (2-12)
 * @returns {Promise<Object>} Game result
 */
export async function playDice(guildId, userId, betAmount, prediction) {
    const config = await getEconomyConfig(guildId);
    const gamblingConfig = await getGamblingConfig(guildId);
    const userEconomy = await getOrCreateUserEconomy(guildId, userId, config);

    if (!gamblingConfig.enabled) {
        throw new Error('Gambling is disabled in this server');
    }

    validateBet(userEconomy, betAmount, config, gamblingConfig);

    if (prediction < 2 || prediction > 12) {
        throw new Error('Prediction must be between 2 and 12');
    }

    // Roll two dice
    const dice1 = Math.floor(Math.random() * 6) + 1;
    const dice2 = Math.floor(Math.random() * 6) + 1;
    const total = dice1 + dice2;

    const won = total === prediction;
    const multiplier = won ? 5 : 0; // 5x multiplier for exact prediction
    const winAmount = won ? betAmount * multiplier : 0;
    const netChange = won ? winAmount : -betAmount;

    // Update balance
    await db.execute(
        'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
        [netChange, won ? winAmount : 0, guildId, userId]
    );

    // Log gambling history
    await logGamble(guildId, userId, 'dice', betAmount, winAmount, `${dice1}+${dice2}=${total}`);

    // Log transaction
    await logTransaction(
        guildId,
        userId,
        'gamble',
        netChange,
        userEconomy.wallet,
        userEconomy.wallet + netChange,
        `Dice (${total}) - ${won ? 'Won' : 'Lost'}`
    );

    return {
        won,
        dice1,
        dice2,
        total,
        prediction,
        multiplier,
        betAmount,
        winAmount,
        netChange,
        newBalance: userEconomy.wallet + netChange
    };
}

// ============================================
// SLOTS
// ============================================

/**
 * Play slots game
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} betAmount - Bet amount
 * @returns {Promise<Object>} Game result
 */
export async function playSlots(guildId, userId, betAmount) {
    const config = await getEconomyConfig(guildId);
    const gamblingConfig = await getGamblingConfig(guildId);
    const userEconomy = await getOrCreateUserEconomy(guildId, userId, config);

    if (!gamblingConfig.enabled) {
        throw new Error('Gambling is disabled in this server');
    }

    validateBet(userEconomy, betAmount, config, gamblingConfig);

    // Slot symbols with weights
    const symbols = ['🍒', '🍋', '🍊', '🍇', '🔔', '💎', '7️⃣'];
    const weights = [30, 25, 20, 15, 7, 2, 1]; // Higher numbers are more common

    function getRandomSymbol() {
        const totalWeight = weights.reduce((a, b) => a + b, 0);
        let random = Math.random() * totalWeight;

        for (let i = 0; i < symbols.length; i++) {
            random -= weights[i];
            if (random <= 0) {
                return symbols[i];
            }
        }
        return symbols[0];
    }

    const slot1 = getRandomSymbol();
    const slot2 = getRandomSymbol();
    const slot3 = getRandomSymbol();

    // Calculate winnings
    let multiplier = 0;
    let resultText = '';

    if (slot1 === slot2 && slot2 === slot3) {
        // All three match
        switch (slot1) {
            case '7️⃣':
                multiplier = 50;
                resultText = 'JACKPOT! Three 7s!';
                break;
            case '💎':
                multiplier = 20;
                resultText = 'DIAMONDS! Three in a row!';
                break;
            case '🔔':
                multiplier = 10;
                resultText = 'BELLS! Triple match!';
                break;
            default:
                multiplier = 5;
                resultText = 'Triple match!';
                break;
        }
    } else if (slot1 === slot2 || slot2 === slot3 || slot1 === slot3) {
        // Two match
        multiplier = 2;
        resultText = 'Two in a row!';
    } else {
        // No match
        multiplier = 0;
        resultText = 'No match';
    }

    const won = multiplier > 0;
    const winAmount = won ? betAmount * multiplier : 0;
    const netChange = won ? winAmount - betAmount : -betAmount;

    // Update balance
    await db.execute(
        'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
        [netChange, won ? winAmount : 0, guildId, userId]
    );

    // Log gambling history
    await logGamble(guildId, userId, 'slots', betAmount, winAmount, `${slot1}${slot2}${slot3}`);

    // Log transaction
    await logTransaction(
        guildId,
        userId,
        'gamble',
        netChange,
        userEconomy.wallet,
        userEconomy.wallet + netChange,
        `Slots (${slot1}${slot2}${slot3}) - ${won ? 'Won' : 'Lost'}`
    );

    return {
        won,
        slot1,
        slot2,
        slot3,
        multiplier,
        resultText,
        betAmount,
        winAmount,
        netChange,
        newBalance: userEconomy.wallet + netChange
    };
}

// ============================================
// BLACKJACK
// ============================================

/**
 * Play blackjack game
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} betAmount - Bet amount
 * @returns {Promise<Object>} Game result
 */
export async function playBlackjack(guildId, userId, betAmount) {
    const config = await getEconomyConfig(guildId);
    const gamblingConfig = await getGamblingConfig(guildId);
    const userEconomy = await getOrCreateUserEconomy(guildId, userId, config);

    if (!gamblingConfig.enabled) {
        throw new Error('Gambling is disabled in this server');
    }

    validateBet(userEconomy, betAmount, config, gamblingConfig);

    // Simple blackjack: draw two cards for player, two for dealer
    const cardValues = [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10, 11]; // 11 = Ace

    function drawCard() {
        return cardValues[Math.floor(Math.random() * cardValues.length)];
    }

    function calculateTotal(cards) {
        let total = cards.reduce((a, b) => a + b, 0);
        let aces = cards.filter(c => c === 11).length;

        // Convert aces from 11 to 1 if bust
        while (total > 21 && aces > 0) {
            total -= 10;
            aces--;
        }

        return total;
    }

    const playerCards = [drawCard(), drawCard()];
    const dealerCards = [drawCard(), drawCard()];

    const playerTotal = calculateTotal(playerCards);
    const dealerTotal = calculateTotal(dealerCards);

    // Determine winner
    let won = false;
    let multiplier = 0;
    let resultText = '';

    if (playerTotal === 21) {
        won = true;
        multiplier = 2.5;
        resultText = 'BLACKJACK! You win!';
    } else if (playerTotal > 21) {
        won = false;
        resultText = 'BUST! You lose!';
    } else if (dealerTotal > 21) {
        won = true;
        multiplier = 2;
        resultText = 'Dealer busts! You win!';
    } else if (playerTotal > dealerTotal) {
        won = true;
        multiplier = 2;
        resultText = 'You win!';
    } else if (playerTotal < dealerTotal) {
        won = false;
        resultText = 'Dealer wins! You lose!';
    } else {
        // Push (tie)
        won = true;
        multiplier = 1;
        resultText = 'Push! It\'s a tie!';
    }

    const winAmount = won ? Math.floor(betAmount * multiplier) : 0;
    const netChange = won ? winAmount - betAmount : -betAmount;

    // Update balance
    await db.execute(
        'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
        [netChange, won ? winAmount : 0, guildId, userId]
    );

    // Log gambling history
    await logGamble(guildId, userId, 'blackjack', betAmount, winAmount, `P:${playerTotal} D:${dealerTotal}`);

    // Log transaction
    await logTransaction(
        guildId,
        userId,
        'gamble',
        netChange,
        userEconomy.wallet,
        userEconomy.wallet + netChange,
        `Blackjack (${playerTotal} vs ${dealerTotal}) - ${won ? 'Won' : 'Lost'}`
    );

    return {
        won,
        playerCards,
        dealerCards,
        playerTotal,
        dealerTotal,
        multiplier,
        resultText,
        betAmount,
        winAmount,
        netChange,
        newBalance: userEconomy.wallet + netChange
    };
}

// ============================================
// ROULETTE
// ============================================

/**
 * Play roulette game
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} betAmount - Bet amount
 * @param {string} betType - Bet type (red, black, green, odd, even)
 * @returns {Promise<Object>} Game result
 */
export async function playRoulette(guildId, userId, betAmount, betType) {
    const config = await getEconomyConfig(guildId);
    const gamblingConfig = await getGamblingConfig(guildId);
    const userEconomy = await getOrCreateUserEconomy(guildId, userId, config);

    if (!gamblingConfig.enabled) {
        throw new Error('Gambling is disabled in this server');
    }

    validateBet(userEconomy, betAmount, config, gamblingConfig);

    // Spin the wheel (0-36, with 0 being green)
    const number = Math.floor(Math.random() * 37);
    const isRed = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36].includes(number);
    const isBlack = number !== 0 && !isRed;
    const isGreen = number === 0;
    const isOdd = number % 2 !== 0 && number !== 0;
    const isEven = number % 2 === 0 && number !== 0;

    // Determine if player won
    let won = false;
    let multiplier = 0;

    switch (betType.toLowerCase()) {
        case 'red':
            won = isRed;
            multiplier = 2;
            break;
        case 'black':
            won = isBlack;
            multiplier = 2;
            break;
        case 'green':
            won = isGreen;
            multiplier = 35;
            break;
        case 'odd':
            won = isOdd;
            multiplier = 2;
            break;
        case 'even':
            won = isEven;
            multiplier = 2;
            break;
        default:
            throw new Error('Invalid bet type. Choose: red, black, green, odd, or even');
    }

    const winAmount = won ? betAmount * multiplier : 0;
    const netChange = won ? winAmount - betAmount : -betAmount;

    // Update balance
    await db.execute(
        'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
        [netChange, won ? winAmount : 0, guildId, userId]
    );

    // Log gambling history
    await logGamble(guildId, userId, 'roulette', betAmount, winAmount, `${number} (${betType})`);

    // Log transaction
    await logTransaction(
        guildId,
        userId,
        'gamble',
        netChange,
        userEconomy.wallet,
        userEconomy.wallet + netChange,
        `Roulette (${number}) - ${won ? 'Won' : 'Lost'}`
    );

    const colorEmoji = isGreen ? '🟢' : isRed ? '🔴' : '⚫';
    const color = isGreen ? 'Green' : isRed ? 'Red' : 'Black';
    const oddEven = isOdd ? 'Odd' : isEven ? 'Even' : '';

    return {
        won,
        number,
        colorEmoji,
        color,
        oddEven,
        betType,
        multiplier,
        betAmount,
        winAmount,
        netChange,
        newBalance: userEconomy.wallet + netChange
    };
}

// ============================================
// HIGH/LOW
// ============================================

/**
 * Play high/low game
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} betAmount - Bet amount
 * @param {string} guess - Guess (high or low)
 * @returns {Promise<Object>} Game result
 */
export async function playHighLow(guildId, userId, betAmount, guess) {
    const config = await getEconomyConfig(guildId);
    const gamblingConfig = await getGamblingConfig(guildId);
    const userEconomy = await getOrCreateUserEconomy(guildId, userId, config);

    if (!gamblingConfig.enabled) {
        throw new Error('Gambling is disabled in this server');
    }

    validateBet(userEconomy, betAmount, config, gamblingConfig);

    // Roll a number between 1-100
    const number = Math.floor(Math.random() * 100) + 1;
    const isHigh = number > 50;
    const isLow = number <= 50;

    const won = (guess.toLowerCase() === 'high' && isHigh) || (guess.toLowerCase() === 'low' && isLow);
    const multiplier = won ? 1.9 : 0; // Slightly less than 2x for house edge
    const winAmount = won ? Math.floor(betAmount * multiplier) : 0;
    const netChange = won ? winAmount - betAmount : -betAmount;

    // Update balance
    await db.execute(
        'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
        [netChange, won ? winAmount : 0, guildId, userId]
    );

    // Log gambling history
    await logGamble(guildId, userId, 'highlow', betAmount, winAmount, `${number} (${guess})`);

    // Log transaction
    await logTransaction(
        guildId,
        userId,
        'gamble',
        netChange,
        userEconomy.wallet,
        userEconomy.wallet + netChange,
        `High/Low (${number}) - ${won ? 'Won' : 'Lost'}`
    );

    return {
        won,
        number,
        guess,
        actualResult: isHigh ? 'high' : 'low',
        multiplier,
        betAmount,
        winAmount,
        netChange,
        newBalance: userEconomy.wallet + netChange
    };
}

// ============================================
// GAMBLING STATS
// ============================================

/**
 * Get user gambling statistics
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Gambling statistics
 */
export async function getGamblingStats(guildId, userId) {
    const [rows] = await db.execute(
        `SELECT
            COUNT(*) as total_games,
            SUM(bet_amount) as total_bet,
            SUM(win_amount) as total_won,
            SUM(win_amount - bet_amount) as net_profit,
            game_type,
            COUNT(CASE WHEN win_amount > 0 THEN 1 END) as wins,
            COUNT(CASE WHEN win_amount = 0 THEN 1 END) as losses
         FROM gambling_history
         WHERE guild_id = ? AND user_id = ?
         GROUP BY game_type`,
        [guildId, userId]
    );

    return rows;
}

// ============================================
// EXPORTS
// ============================================

export default {
    getGamblingConfig,
    playCoinflip,
    playDice,
    playSlots,
    playBlackjack,
    playRoulette,
    playHighLow,
    getGamblingStats
};
