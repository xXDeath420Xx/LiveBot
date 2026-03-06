/**
 * !lit / !blaze / !burn / !toke
 * Track tokes and display current count
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

/**
 * Calculate XP needed for next level
 */
function xpForLevel(level) {
    return Math.floor(100 * Math.pow(1.5, level - 1));
}

/**
 * Check if user leveled up and return new level
 */
function checkLevelUp(currentXp, currentLevel) {
    let level = currentLevel;
    let xpNeeded = xpForLevel(level);

    while (currentXp >= xpNeeded) {
        level++;
        xpNeeded = xpForLevel(level);
    }

    return level;
}

/**
 * Get level title based on level
 */
function getLevelTitle(level) {
    const titles = [
        { min: 1, title: 'Seedling' },
        { min: 5, title: 'Sprout' },
        { min: 10, title: 'Sapling' },
        { min: 20, title: 'Budding' },
        { min: 30, title: 'Flowering' },
        { min: 40, title: 'Mature' },
        { min: 50, title: 'Veteran' },
        { min: 75, title: 'Elder' },
        { min: 100, title: 'Legend' }
    ];

    for (let i = titles.length - 1; i >= 0; i--) {
        if (level >= titles[i].min) {
            return titles[i].title;
        }
    }
    return 'Seedling';
}

export async function litCommand(ctx) {
    const { profile, channelStats, username, reply, channel } = ctx;

    try {
        const now = new Date();
        const today = now.toISOString().split('T')[0];

        // Check if we need to reset daily tokes
        const resetDate = profile.tokes_reset_date;
        let todayTokes = profile.today_tokes || 0;

        if (!resetDate || resetDate !== today) {
            todayTokes = 0;
        }

        // Award XP (10 base + bonus for first toke of day)
        let xpGain = 10;
        if (todayTokes === 0) {
            xpGain += 25; // First toke bonus
        }

        // Update profile
        const newLifetimeTokes = (profile.lifetime_tokes || 0) + 1;
        const newTodayTokes = todayTokes + 1;
        const newXp = (profile.xp || 0) + xpGain;
        const newLevel = checkLevelUp(newXp, profile.level || 1);
        const leveledUp = newLevel > (profile.level || 1);

        await pool.execute(
            `UPDATE tokes_profiles SET
                lifetime_tokes = ?,
                today_tokes = ?,
                tokes_reset_date = ?,
                xp = ?,
                level = ?,
                last_active = NOW()
             WHERE id = ?`,
            [newLifetimeTokes, newTodayTokes, today, newXp, newLevel, profile.id]
        );

        // Update channel stats
        await pool.execute(
            `UPDATE tokes_channel_stats SET
                tokes = tokes + 1,
                display_name = ?,
                last_active = NOW()
             WHERE id = ?`,
            [username, channelStats.id]
        );

        // Build response
        let response = `${username} takes a toke! `;

        // Show milestone messages
        if (newLifetimeTokes === 1) {
            response += `First toke ever! Welcome to the circle! `;
        } else if (newLifetimeTokes === 100) {
            response += `100 lifetime tokes! You're on fire! `;
        } else if (newLifetimeTokes === 420) {
            response += `420 lifetime tokes! Nice! `;
        } else if (newLifetimeTokes === 1000) {
            response += `1000 tokes! Legendary! `;
        } else if (newLifetimeTokes % 1000 === 0) {
            response += `${newLifetimeTokes} tokes! Incredible! `;
        }

        response += `Total: ${newLifetimeTokes} | Today: ${newTodayTokes}`;

        // Level up message
        if (leveledUp) {
            const title = getLevelTitle(newLevel);
            response += ` | LEVEL UP! Now Lv.${newLevel} (${title})`;
        }

        reply(response);

    } catch (error) {
        logger.error('[LitCommand] Error', { error: error.message });
        reply(`${username}, something went wrong tracking your toke!`);
    }
}
