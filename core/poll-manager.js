const db = require('../utils/db');
const logger = require('../utils/logger');
const { EmbedBuilder } = require('discord.js');

const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

async function checkPolls() {
    if (!global.client) return;
    try {
        const [activePolls] = await db.execute('SELECT * FROM polls WHERE is_active = 1 AND ends_at <= NOW()');
        if (activePolls.length === 0) return;

        logger.info(`[PollManager] Found ${activePolls.length} polls to end.`);
        for (const poll of activePolls) {
            await endPoll(poll);
        }
    } catch (error) {
        logger.error('[PollManager] Error checking for polls to end:', error);
    }
}

async function endPoll(poll) {
    const guild = global.client.guilds.cache.get(poll.guild_id);
    if (!guild) return;

    const channel = await guild.channels.fetch(poll.channel_id).catch(() => null);
    if (!channel) return;

    const message = await channel.messages.fetch(poll.message_id).catch(() => null);
    if (!message) return;

    const options = JSON.parse(poll.options);
    const results = [];
    let totalVotes = 0;

    for (let i = 0; i < options.length; i++) {
        const reaction = message.reactions.cache.get(numberEmojis[i]);
        const count = reaction ? reaction.count - 1 : 0; // Subtract the bot's own reaction
        results.push({ option: options[i], votes: count });
        totalVotes += count;
    }

    // Sort results from most to least votes
    results.sort((a, b) => b.votes - a.votes);

    const resultsDescription = results.map((res, i) => {
        const percentage = totalVotes > 0 ? ((res.votes / totalVotes) * 100).toFixed(1) : 0;
        return `${i === 0 ? '🏆 ' : ''}**${res.option}**: ${res.votes} votes (${percentage}%)`;
    }).join('\n');

    // Create results embed
    const resultEmbed = new EmbedBuilder()
        .setColor('#95A5A6')
        .setTitle(`Poll Results: ${poll.question}`)
        .setDescription(resultsDescription)
        .setFooter({ text: `Total Votes: ${totalVotes}` });
    
    await channel.send({ embeds: [resultEmbed], reply: { messageReference: message } });

    // Update original poll message
    const originalEmbed = EmbedBuilder.from(message.embeds[0])
        .setColor('#2C3E50')
        .setFields([]) // Clear old fields
        .setFooter({ text: 'Poll has ended.'});
    await message.edit({ embeds: [originalEmbed], components: [] });

    // Update database
    await db.execute('UPDATE polls SET is_active = 0 WHERE id = ?', [poll.id]);
}

module.exports = { checkPolls };