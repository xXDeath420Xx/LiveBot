"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const path = __importStar(require("path"));
const dotenv = __importStar(require("dotenv"));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
async function checkEndedPolls(discordClient) {
    try {
        const [endedPolls] = await db_1.default.query('SELECT * FROM polls WHERE ends_at <= NOW() AND is_active = 1');
        for (const poll of endedPolls) {
            try {
                const channel = await discordClient.channels.fetch(poll.channel_id).catch(() => null);
                if (!channel) {
                    logger_1.default.warn(`[PollScheduler] Channel for Poll #${poll.id} not found. Deactivating.`);
                    await db_1.default.query('UPDATE polls SET is_active = 0 WHERE id = ?', [poll.id]);
                    continue;
                }
                const message = await channel.messages.fetch(poll.message_id).catch(() => null);
                if (!message) {
                    logger_1.default.warn(`[PollScheduler] Message for Poll #${poll.id} not found. Deactivating.`);
                    await db_1.default.query('UPDATE polls SET is_active = 0 WHERE id = ?', [poll.id]);
                    continue;
                }
                const options = JSON.parse(poll.options);
                const results = [];
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
                const pollEmbed = new discord_js_1.EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle(`POLL ENDED: ${poll.question}`)
                    .setDescription(resultsDescription)
                    .setFooter({ text: `Total Votes: ${totalVotes}` })
                    .setTimestamp();
                await message.edit({ embeds: [pollEmbed], components: [] });
                await db_1.default.query('UPDATE polls SET is_active = 0 WHERE id = ?', [poll.id]);
                logger_1.default.info(`[PollScheduler] Poll #${poll.id} has ended.`);
            }
            catch (err) {
                logger_1.default.error(`[PollScheduler] Error processing ended poll #${poll.id}:`, { error: err });
                // Deactivate poll to prevent reprocessing
                await db_1.default.query('UPDATE polls SET is_active = 0 WHERE id = ?', [poll.id]);
            }
        }
    }
    catch (error) {
        logger_1.default.error(`[PollScheduler] Error fetching ended polls:`, { error });
    }
}
module.exports = function startPollScheduler(client) {
    // The logger is initialized in the main index.js file. DO NOT re-initialize it here.
    logger_1.default.info('[PollScheduler] Initializing scheduler.');
    void checkEndedPolls(client);
    const intervalId = setInterval(() => void checkEndedPolls(client), 60000);
    // Graceful shutdown is handled by the main process.
    return intervalId;
};
