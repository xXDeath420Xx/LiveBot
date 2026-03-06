/**
 * Scheduled Grow Tips
 * Posts daily grow tips to designated channels
 */

import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

// Track last tip posted per guild to avoid duplicates
const lastTipPosted = new Map();

// Category emojis
const categoryEmojis = {
    watering: '💧',
    nutrients: '🧪',
    environment: '🌡️',
    lighting: '💡',
    training: '✂️',
    harvest: '🌿',
    drying: '🍂',
    curing: '🫙',
    ph: '📊',
    genetics: '🧬'
};

// Category colors
const categoryColors = {
    watering: 0x3498DB,
    nutrients: 0x9B59B6,
    environment: 0xE74C3C,
    lighting: 0xF1C40F,
    training: 0x2ECC71,
    harvest: 0x1ABC9C,
    drying: 0xE67E22,
    curing: 0x95A5A6,
    ph: 0x34495E,
    genetics: 0xE91E63
};

export default {
    name: 'ready',
    once: true,
    async execute(client) {
        // Check every hour if it's time to post
        setInterval(() => checkAndPostTips(client), 60 * 60 * 1000);

        // Initial check after 5 minutes (let bot fully load)
        setTimeout(() => checkAndPostTips(client), 5 * 60 * 1000);

        logger.info('[GrowTips] Scheduled tips system initialized');
    }
};

async function checkAndPostTips(client) {
    const now = new Date();
    const hour = now.getUTCHours();

    // Post tips at 2PM UTC (adjust as needed)
    if (hour !== 14) return;

    // Check if we already posted today
    const today = now.toISOString().split('T')[0];

    for (const guild of client.guilds.cache.values()) {
        const lastPosted = lastTipPosted.get(guild.id);
        if (lastPosted === today) continue;

        try {
            await postDailyTip(guild);
            lastTipPosted.set(guild.id, today);
        } catch (error) {
            logger.error(`[GrowTips] Failed to post tip in ${guild.name}:`, error);
        }
    }
}

async function postDailyTip(guild) {
    // Find grow tips channel
    const tipChannel = guild.channels.cache.find(c =>
        c.name.includes('grow-tips') ||
        c.name.includes('daily-tips') ||
        c.name.includes('grow-help')
    );

    if (!tipChannel || !tipChannel.isTextBased()) return;

    // Get random tip from database
    const [tips] = await pool.execute(
        'SELECT * FROM grow_tips ORDER BY RAND() LIMIT 1'
    );

    if (tips.length === 0) return;

    const tip = tips[0];
    const emoji = categoryEmojis[tip.category] || '🌱';
    const color = categoryColors[tip.category] || 0x2ECC71;

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`${emoji} Daily Grow Tip: ${tip.title}`)
        .setDescription(tip.content)
        .addFields({
            name: 'Category',
            value: tip.category.charAt(0).toUpperCase() + tip.category.slice(1),
            inline: true
        })
        .setFooter({ text: 'Use /growtip to get a random tip anytime!' })
        .setTimestamp();

    await tipChannel.send({ embeds: [embed] });

    logger.info(`[GrowTips] Posted tip "${tip.title}" in ${guild.name}`);
}

// Export function to manually trigger a tip
export async function postTipNow(channel) {
    const [tips] = await pool.execute(
        'SELECT * FROM grow_tips ORDER BY RAND() LIMIT 1'
    );

    if (tips.length === 0) {
        return null;
    }

    const tip = tips[0];
    const emoji = categoryEmojis[tip.category] || '🌱';
    const color = categoryColors[tip.category] || 0x2ECC71;

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`${emoji} Grow Tip: ${tip.title}`)
        .setDescription(tip.content)
        .addFields({
            name: 'Category',
            value: tip.category.charAt(0).toUpperCase() + tip.category.slice(1),
            inline: true
        })
        .setTimestamp();

    return embed;
}
