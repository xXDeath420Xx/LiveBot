"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkPolls = checkPolls;
exports.endPoll = endPoll;
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
const discord_js_1 = require("discord.js");
const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
async function checkPolls() {
    if (!global.client)
        return;
    try {
        const [activePolls] = await db_1.default.execute('SELECT * FROM polls WHERE is_active = 1 AND ends_at <= NOW()');
        if (activePolls.length === 0)
            return;
        logger_1.default.info(`Found ${activePolls.length} polls to end.`, { category: 'poll' });
        for (const poll of activePolls) {
            await endPoll(poll);
        }
    }
    catch (error) {
        logger_1.default.error('Error checking for polls to end.', { category: 'poll', error: error.stack });
    }
}
async function endPoll(poll) {
    const guildId = poll.guild_id;
    try {
        const guild = global.client.guilds.cache.get(guildId);
        if (!guild) {
            logger_1.default.warn(`Guild not found for poll ${poll.id}.`, { guildId, category: 'poll' });
            return;
        }
        const channel = await guild.channels.fetch(poll.channel_id).catch(() => null);
        if (!channel) {
            logger_1.default.warn(`Channel not found for poll ${poll.id}.`, { guildId, category: 'poll' });
            return;
        }
        const message = await channel.messages.fetch(poll.message_id).catch(() => null);
        if (!message) {
            logger_1.default.warn(`Message not found for poll ${poll.id}.`, { guildId, category: 'poll' });
            return;
        }
        const options = JSON.parse(poll.options);
        const results = [];
        let totalVotes = 0;
        for (let i = 0; i < options.length; i++) {
            const reaction = message.reactions.cache.get(numberEmojis[i]);
            const count = reaction ? reaction.count - 1 : 0; // Subtract the bot's own reaction
            results.push({ option: options[i], votes: count });
            totalVotes += count;
        }
        results.sort((a, b) => b.votes - a.votes);
        const resultsDescription = results.map((res, i) => {
            const percentage = totalVotes > 0 ? ((res.votes / totalVotes) * 100).toFixed(1) : '0';
            return `${i === 0 ? '🏆 ' : ''}**${res.option}**: ${res.votes} votes (${percentage}%)`;
        }).join('\n');
        const resultEmbed = new discord_js_1.EmbedBuilder()
            .setColor('#95A5A6')
            .setTitle(`Poll Results: ${poll.question}`)
            .setDescription(resultsDescription)
            .setFooter({ text: `Total Votes: ${totalVotes}` });
        await channel.send({ embeds: [resultEmbed], reply: { messageReference: message } });
        const originalEmbed = discord_js_1.EmbedBuilder.from(message.embeds[0])
            .setColor('#2C3E50')
            .setFields([])
            .setFooter({ text: 'Poll has ended.' });
        await message.edit({ embeds: [originalEmbed], components: [] });
        await db_1.default.execute('UPDATE polls SET is_active = 0 WHERE id = ?', [poll.id]);
        logger_1.default.info(`Ended poll ${poll.id}.`, { guildId, category: 'poll' });
    }
    catch (error) {
        logger_1.default.error(`Error ending poll ${poll.id}.`, { guildId, category: 'poll', error: error.stack });
    }
}
