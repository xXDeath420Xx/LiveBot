/**
 * D&D Dice Parser
 * Parses dice notation like "2d6+3", "1d20", "4d6kh3", "8d6!"
 *
 * Supported formats:
 * - NdX: Roll N dice with X sides (e.g., 2d6)
 * - NdX+M: Add modifier M (e.g., 1d20+5)
 * - NdX-M: Subtract modifier M (e.g., 1d20-2)
 * - NdXkh#: Keep highest # dice (e.g., 4d6kh3)
 * - NdXkl#: Keep lowest # dice (e.g., 2d20kl1)
 * - NdX!: Exploding dice (e.g., 3d6!)
 */

// Standard D&D dice
export const VALID_DICE = [4, 6, 8, 10, 12, 20, 100];

/**
 * Parse a dice notation string
 * @param {string} notation - The dice notation (e.g., "2d6+3")
 * @returns {object} Parsed dice configuration
 */
export function parseDiceNotation(notation) {
    if (!notation || typeof notation !== 'string') {
        throw new Error('Invalid dice notation');
    }

    const cleanNotation = notation.toLowerCase().trim();

    // Pattern: NdX[kh#|kl#][!][+/-M]
    const regex = /^(\d+)d(\d+)(kh(\d+)|kl(\d+))?(!)?\s*([+-]\s*\d+)?$/;
    const match = cleanNotation.match(regex);

    if (!match) {
        throw new Error(`Invalid dice notation: ${notation}`);
    }

    const [, countStr, sidesStr, , keepHighStr, keepLowStr, exploding, modifierStr] = match;

    const count = parseInt(countStr);
    const sides = parseInt(sidesStr);
    const keepHighest = keepHighStr ? parseInt(keepHighStr) : null;
    const keepLowest = keepLowStr ? parseInt(keepLowStr) : null;
    const isExploding = exploding === '!';
    const modifier = modifierStr ? parseInt(modifierStr.replace(/\s/g, '')) : 0;

    // Validation
    if (count < 1 || count > 100) {
        throw new Error('Dice count must be between 1 and 100');
    }
    if (sides < 2 || sides > 100) {
        throw new Error('Dice sides must be between 2 and 100');
    }
    if (keepHighest && keepHighest > count) {
        throw new Error('Cannot keep more dice than rolled');
    }
    if (keepLowest && keepLowest > count) {
        throw new Error('Cannot keep more dice than rolled');
    }

    return {
        notation: cleanNotation,
        count,
        sides,
        keepHighest,
        keepLowest,
        isExploding,
        modifier
    };
}

/**
 * Roll a single die
 * @param {number} sides - Number of sides on the die
 * @returns {number} Roll result
 */
export function rollDie(sides) {
    return Math.floor(Math.random() * sides) + 1;
}

/**
 * Roll multiple dice
 * @param {number} count - Number of dice to roll
 * @param {number} sides - Number of sides per die
 * @param {boolean} exploding - If true, roll again on max value
 * @returns {number[]} Array of individual rolls
 */
export function rollDice(count, sides, exploding = false) {
    const rolls = [];

    for (let i = 0; i < count; i++) {
        let roll = rollDie(sides);
        rolls.push(roll);

        // Exploding dice: roll again on max (limit to prevent infinite loops)
        if (exploding && roll === sides && rolls.length < 100) {
            i--; // Roll another die
        }
    }

    return rolls;
}

/**
 * Execute a complete dice roll from notation
 * @param {string} notation - Dice notation string
 * @returns {object} Complete roll result
 */
export function executeRoll(notation) {
    const parsed = parseDiceNotation(notation);
    let rolls = rollDice(parsed.count, parsed.sides, parsed.isExploding);

    // Store original rolls
    const originalRolls = [...rolls];

    // Apply keep highest/lowest
    let keptRolls = rolls;
    let droppedRolls = [];

    if (parsed.keepHighest) {
        rolls.sort((a, b) => b - a);
        keptRolls = rolls.slice(0, parsed.keepHighest);
        droppedRolls = rolls.slice(parsed.keepHighest);
    } else if (parsed.keepLowest) {
        rolls.sort((a, b) => a - b);
        keptRolls = rolls.slice(0, parsed.keepLowest);
        droppedRolls = rolls.slice(parsed.keepLowest);
    }

    // Calculate total
    const diceTotal = keptRolls.reduce((sum, r) => sum + r, 0);
    const total = diceTotal + parsed.modifier;

    return {
        notation: parsed.notation,
        originalNotation: notation,
        count: parsed.count,
        sides: parsed.sides,
        rolls: originalRolls,
        keptRolls,
        droppedRolls,
        diceTotal,
        modifier: parsed.modifier,
        total,
        isExploding: parsed.isExploding,
        keepHighest: parsed.keepHighest,
        keepLowest: parsed.keepLowest
    };
}

/**
 * Format a roll result for display
 * @param {object} result - Roll result from executeRoll
 * @returns {string} Formatted string
 */
export function formatRollResult(result) {
    let rollsDisplay = result.keptRolls.join(' + ');

    if (result.droppedRolls.length > 0) {
        rollsDisplay += ` (~~${result.droppedRolls.join(', ')}~~)`;
    }

    let formula = `[${result.count}d${result.sides}]`;
    if (result.modifier !== 0) {
        formula += result.modifier > 0 ? ` + ${result.modifier}` : ` - ${Math.abs(result.modifier)}`;
    }

    return {
        formula,
        rollsDisplay,
        calculation: result.modifier !== 0
            ? `${result.diceTotal} ${result.modifier > 0 ? '+' : '-'} ${Math.abs(result.modifier)} = ${result.total}`
            : `${result.total}`,
        total: result.total
    };
}

/**
 * Get emoji for a specific die type
 * @param {number} sides - Die sides
 * @returns {string} Emoji
 */
export function getDieEmoji(sides) {
    const emojis = {
        4: '🔺',
        6: '🎲',
        8: '🔷',
        10: '🔟',
        12: '🔶',
        20: '⚔️',
        100: '💯'
    };
    return emojis[sides] || '🎲';
}

export default {
    parseDiceNotation,
    rollDie,
    rollDice,
    executeRoll,
    formatRollResult,
    getDieEmoji,
    VALID_DICE
};
