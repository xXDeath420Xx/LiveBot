const db = require('../utils/db');
const logger = require('../utils/logger');
const { EmbedBuilder } = require('discord.js');

async function checkGiveaways() {
    if (!global.client) return;
    try {
        const [activeGiveaways] = await db.execute('SELECT * FROM giveaways WHERE is_active = 1 AND ends_at <= NOW()');
        if (activeGiveaways.length === 0) return;

        logger.info(`[GiveawayManager] Found ${activeGiveaways.length} giveaways to end.`);
        for (const giveaway of activeGiveaways) {
            await endGiveaway(giveaway, false);
        }
    } catch (error) {
        logger.error('[GiveawayManager] Error checking for giveaways to end:', error);
    }
}

async function endGiveaway(giveaway, isReroll) {
    const guild = global.client.guilds.cache.get(giveaway.guild_id);
    if (!guild) return;

    const channel = await guild.channels.fetch(giveaway.channel_id).catch(() => null);
    if (!channel) return;

    const message = await channel.messages.fetch(giveaway.message_id).catch(() => null);
    if (!message) return;

    const reaction = message.reactions.cache.get('🎉');
    const users = await reaction.users.fetch();
    const entrants = users.filter(user => !user.bot);

    if (entrants.size === 0) {
        await channel.send(`The giveaway for **${giveaway.prize}** ended with no entries.`);
        await db.execute('UPDATE giveaways SET is_active = 0 WHERE id = ?', [giveaway.id]);
        return;
    }

    const winners = entrants.random(giveaway.winner_count);
    const winnerMentions = winners.map(u => u.toString()).join(', ');

    const resultMessage = isReroll 
        ? `A new winner has been drawn! Congratulations ${winnerMentions}!`
        : `Congratulations ${winnerMentions}! You won the **${giveaway.prize}**!`;

    await channel.send({ content: resultMessage, reply: { messageReference: message } });

    // Update the original giveaway embed
    const endedEmbed = EmbedBuilder.from(message.embeds[0])
        .setColor('#95A5A6')
        .setDescription(`Giveaway has ended.\n\n**Winner(s):** ${winnerMentions}`)
        .setFields([]); // Clear old fields
    await message.edit({ embeds: [endedEmbed], components: [] });

    // Update the database
    await db.execute('UPDATE giveaways SET is_active = 0, winners = ? WHERE id = ?', [JSON.stringify(winners.map(u => u.id)), giveaway.id]);
}

module.exports = { checkGiveaways, endGiveaway };