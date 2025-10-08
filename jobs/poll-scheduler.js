require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { EmbedBuilder } = require('discord.js');
const db = require('../utils/db');
const logger = require('../utils/logger');
const discordClient = require('../index'); // We need the client to fetch channels and messages

async function checkEndedPolls() {
    try {
        const endedPolls = await db.query('SELECT * FROM polls WHERE ends_at <= NOW() AND is_active = 1');

        for (const poll of endedPolls) {
            try {
                const channel = await discordClient.channels.fetch(poll.channel_id);
                if (!channel) continue;

                const message = await channel.messages.fetch(poll.message_id);
                if (!message) continue;

                const options = JSON.parse(poll.options);
                let results = [];
                let totalVotes = 0;

                for (let i = 0; i < options.length; i++) {
                    const reaction = message.reactions.cache.get(`${i + 1}️⃣`);
                    const count = reaction ? reaction.count - 1 : 0; // Subtract the bot's own reaction
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

                await message.edit({ embeds: [pollEmbed], components: [] }); // Remove buttons/reactions from ended poll

                await db.query('UPDATE polls SET is_active = 0 WHERE id = ?', [poll.id]);
                logger.info(`Poll #${poll.id} has ended and results have been announced.`);

            } catch (err) {
                if (err.code === 10008 || err.code === 10003) { // Unknown Message or Unknown Channel
                    logger.warn(`Message or Channel for Poll #${poll.id} not found. Deactivating poll.`);
                    await db.query('UPDATE polls SET is_active = 0 WHERE id = ?', [poll.id]);
                } else {
                    logger.error(`Error processing ended poll #${poll.id}: ${err.message}`);
                }
            }
        }
    } catch (error) {
        logger.error(`Error fetching ended polls: ${error.message}`);
    }
}

// Run the check every minute
checkEndedPolls();
setInterval(checkEndedPolls, 60000);