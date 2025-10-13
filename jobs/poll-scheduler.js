const path = require("path");
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { EmbedBuilder } = require("discord.js");
const db = require('../utils/db');
const logger = require('../utils/logger');

async function checkEndedPolls(discordClient) {
    try {
        const [endedPolls] = await db.query('SELECT * FROM polls WHERE ends_at <= NOW() AND is_active = 1');

        for (const poll of endedPolls) {
            try {
                const channel = await discordClient.channels.fetch(poll.channel_id).catch(() => null);
                if (!channel) {
                    logger.warn(`[PollScheduler] Channel for Poll #${poll.id} not found. Deactivating.`);
                    await db.query('UPDATE polls SET is_active = 0 WHERE id = ?', [poll.id]);
                    continue;
                }

                const message = await channel.messages.fetch(poll.message_id).catch(() => null);
                if (!message) {
                    logger.warn(`[PollScheduler] Message for Poll #${poll.id} not found. Deactivating.`);
                    await db.query('UPDATE polls SET is_active = 0 WHERE id = ?', [poll.id]);
                    continue;
                }

                const options = JSON.parse(poll.options);
                let results = [];
                let totalVotes = 0;

                for (let i = 0; i < options.length; i++) {
                    const reaction = message.reactions.cache.get(`${i + 1}️⃣`);
                    const count = reaction ? reaction.count - 1 : 0; // Subtract bot's reaction
                    results.push({ option: options[i], votes: count });
                    totalVotes += count;
                }

                results.sort((a, b) => b.votes - a.votes);

                const resultsDescription = results.map((result, index) => {
                    const percentage = totalVotes > 0 ? ((result.votes / totalVotes) * 100).toFixed(2) : 0;
                    return `${index + 1}. ${result.option}: **${result.votes} votes** (${percentage}%)`;
                }).join('\n');

                const pollEmbed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle(`POLL ENDED: ${poll.question}`)
                    .setDescription(resultsDescription)
                    .setFooter({ text: `Total Votes: ${totalVotes}` })
                    .setTimestamp();

                await message.edit({ embeds: [pollEmbed], components: [] });
                await db.query('UPDATE polls SET is_active = 0 WHERE id = ?', [poll.id]);
                logger.info(`[PollScheduler] Poll #${poll.id} has ended.`);

            } catch (err) {
                logger.error(`[PollScheduler] Error processing ended poll #${poll.id}:`, { error: err });
                // Deactivate poll to prevent reprocessing
                await db.query('UPDATE polls SET is_active = 0 WHERE id = ?', [poll.id]);
            }
        }
    } catch (error) {
        logger.error(`[PollScheduler] Error fetching ended polls:`, { error });
    }
}

module.exports = function startPollScheduler(client) {
    // The logger is initialized in the main index.js file. DO NOT re-initialize it here.
    logger.info('[PollScheduler] Initializing scheduler.');

    checkEndedPolls(client);
    const intervalId = setInterval(() => checkEndedPolls(client), 60000);

    // Graceful shutdown is handled by the main process.

    return intervalId;
};