import * as path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { EmbedBuilder, Client, TextChannel, Message, MessageReaction } from 'discord.js';
import db from '../utils/db';
import logger from '../utils/logger';

interface Poll {
    id: number;
    channel_id: string;
    message_id: string;
    question: string;
    options: string;
    ends_at: Date;
    is_active: number;
}

interface PollResult {
    option: string;
    votes: number;
}

async function checkEndedPolls(discordClient: Client): Promise<void> {
    try {
        const [endedPolls] = await db.query('SELECT * FROM polls WHERE ends_at <= NOW() AND is_active = 1') as [Poll[], any];

        for (const poll of endedPolls) {
            try {
                const channel = await discordClient.channels.fetch(poll.channel_id).catch(() => null) as TextChannel | null;
                if (!channel) {
                    logger.warn(`[PollScheduler] Channel for Poll #${poll.id} not found. Deactivating.`);
                    await db.query('UPDATE polls SET is_active = 0 WHERE id = ?', [poll.id]);
                    continue;
                }

                const message = await channel.messages.fetch(poll.message_id).catch(() => null) as Message | null;
                if (!message) {
                    logger.warn(`[PollScheduler] Message for Poll #${poll.id} not found. Deactivating.`);
                    await db.query('UPDATE polls SET is_active = 0 WHERE id = ?', [poll.id]);
                    continue;
                }

                const options: string[] = JSON.parse(poll.options);
                const results: PollResult[] = [];
                let totalVotes: number = 0;

                for (let i = 0; i < options.length; i++) {
                    const reaction: MessageReaction | undefined = message.reactions.cache.get(`${i + 1}️⃣`);
                    const count: number = reaction ? reaction.count - 1 : 0; // Subtract bot's reaction
                    results.push({ option: options[i]!, votes: count });
                    totalVotes += count;
                }

                results.sort((a: PollResult, b: PollResult) => b.votes - a.votes);

                const resultsDescription: string = results.map((result: PollResult, index: number) => {
                    const percentage: string | number = totalVotes > 0 ? ((result.votes / totalVotes) * 100).toFixed(2) : 0;
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
        logger.error(`[PollScheduler] Error fetching ended polls:`, { _error });
    }
}

export = function startPollScheduler(client: Client): NodeJS.Timeout {
    // The logger is initialized in the main index.js file. DO NOT re-initialize it here.
    logger.info('[PollScheduler] Initializing scheduler.');

    void checkEndedPolls(client);
    const intervalId: NodeJS.Timeout = setInterval(() => void checkEndedPolls(client), 60000);

    // Graceful shutdown is handled by the main process.

    return intervalId;
};