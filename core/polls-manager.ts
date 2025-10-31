import logger from '../utils/logger';
import db from '../utils/db';
import { Client, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ButtonInteraction, TextChannel, GuildMember } from 'discord.js';
import { RowDataPacket } from 'mysql2';

interface Poll extends RowDataPacket {
    id: number;
    guild_id: string;
    channel_id: string;
    message_id: string;
    creator_id: string;
    question: string;
    options: string;
    votes: string | null;
    allow_multiple: number;
    anonymous: number;
    status: string;
    ends_at: Date | null;
}

interface VoteRecord {
    [userId: string]: number[];
}

class PollsManager {
    private client: Client;
    private checkInterval: NodeJS.Timeout | null;

    constructor(client: Client) {
        this.client = client;
        this.checkInterval = null;
        logger.info('[PollsManager] Polls manager initialized');
    }

    startScheduler(): void {
        // Check every minute for polls that need to end
        this.checkInterval = setInterval(() => {
            this.checkExpiredPolls();
        }, 60 * 1000);

        logger.info('[PollsManager] Poll scheduler started (60s interval)');
    }

    stopScheduler(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            logger.info('[PollsManager] Poll scheduler stopped');
        }
    }

    async checkExpiredPolls(): Promise<void> {
        try {
            const [polls] = await db.execute<Poll[]>(
                'SELECT * FROM polls WHERE status = "active" AND ends_at IS NOT NULL AND ends_at <= NOW()'
            );

            if (polls.length === 0) return;

            logger.info(`[PollsManager] Found ${polls.length} expired polls`);

            for (const poll of polls) {
                await this.endPoll(poll.id, 'Poll duration expired');
            }
        } catch (error: any) {
            logger.error(`[PollsManager] Error checking expired polls: ${error.message}`);
        }
    }

    async createPoll(guildId: string, channelId: string, creatorId: string, question: string, options: string[], duration: number | null = null, allowMultiple: boolean = false, anonymous: boolean = false): Promise<{ pollId: number; messageId: string }> {
        try {
            if (options.length < 2 || options.length > 10) {
                throw new Error('Polls must have between 2 and 10 options');
            }

            const guild = this.client.guilds.cache.get(guildId);
            if (!guild) throw new Error('Guild not found');

            const channel = guild.channels.cache.get(channelId) as TextChannel;
            if (!channel) throw new Error('Channel not found');

            // Calculate end time
            const endsAt = duration ? new Date(Date.now() + duration * 1000) : null;

            // Create embed
            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('📊 ' + question)
                .setDescription(this.formatPollOptions(options, {}))
                .setFooter({
                    text: `Created by ${(await guild.members.fetch(creatorId)).user.tag}${endsAt ? ` • Ends ${Math.floor(endsAt.getTime() / 1000)}` : ''}`
                });

            if (allowMultiple) {
                embed.addFields({ name: 'ℹ️ Voting', value: 'You can select multiple options' });
            }

            if (anonymous) {
                embed.addFields({ name: '🕵️ Privacy', value: 'Votes are anonymous' });
            }

            // Create buttons
            const rows = this.createPollButtons(options);

            // Send poll message
            const message = await channel.send({ embeds: [embed], components: rows });

            // Save to database
            const [result] = await db.execute(`
                INSERT INTO polls (guild_id, channel_id, message_id, creator_id, question, options, allow_multiple, anonymous, ends_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                guildId,
                channelId,
                message.id,
                creatorId,
                question,
                JSON.stringify(options),
                allowMultiple ? 1 : 0,
                anonymous ? 1 : 0,
                endsAt
            ]);

            logger.info(`[PollsManager] Created poll "${question}" in guild ${guildId}`, {
                guildId,
                pollId: (result as any).insertId,
                optionCount: options.length
            });

            return { pollId: (result as any).insertId, messageId: message.id };
        } catch (error: any) {
            logger.error(`[PollsManager] Failed to create poll: ${error.message}`);
            throw error;
        }
    }

    createPollButtons(options: string[]): ActionRowBuilder<ButtonBuilder>[] {
        const rows: ActionRowBuilder<ButtonBuilder>[] = [];
        let currentRow = new ActionRowBuilder<ButtonBuilder>();
        let buttonsInRow = 0;

        const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

        for (let i = 0; i < options.length; i++) {
            if (buttonsInRow >= 5) {
                rows.push(currentRow);
                currentRow = new ActionRowBuilder<ButtonBuilder>();
                buttonsInRow = 0;
            }

            const button = new ButtonBuilder()
                .setCustomId(`poll_vote_${i}`)
                .setLabel(options[i])
                .setStyle(ButtonStyle.Primary)
                .setEmoji(emojis[i]);

            currentRow.addComponents(button);
            buttonsInRow++;
        }

        if (buttonsInRow > 0) rows.push(currentRow);
        return rows;
    }

    async handleVote(interaction: ButtonInteraction): Promise<boolean> {
        if (!interaction.customId.startsWith('poll_vote_')) return false;

        try {
            await interaction.deferReply({ ephemeral: true });

            const optionIndex = parseInt(interaction.customId.replace('poll_vote_', ''));

            const [[poll]] = await db.execute<Poll[]>(
                'SELECT * FROM polls WHERE message_id = ? AND status = "active"',
                [interaction.message.id]
            );

            if (!poll) {
                await interaction.editReply('❌ This poll is no longer active.');
                return true;
            }

            // Parse votes
            const votes: VoteRecord = poll.votes ? JSON.parse(poll.votes) : {};
            const userVotes = votes[interaction.user.id] || [];

            // Check if already voted for this option
            if (userVotes.includes(optionIndex)) {
                await interaction.editReply('❌ You have already voted for this option!');
                return true;
            }

            // Handle single vs multiple choice
            if (!poll.allow_multiple && userVotes.length > 0) {
                await interaction.editReply('❌ You have already voted! This poll allows only one choice.');
                return true;
            }

            // Add vote
            userVotes.push(optionIndex);
            votes[interaction.user.id] = userVotes;

            // Update database
            await db.execute(
                'UPDATE polls SET votes = ? WHERE id = ?',
                [JSON.stringify(votes), poll.id]
            );

            // Update poll display
            await this.updatePollDisplay(poll, votes);

            await interaction.editReply('✅ Your vote has been recorded!');

            logger.info(`[PollsManager] User ${interaction.user.tag} voted in poll ${poll.id}`, {
                guildId: poll.guild_id,
                pollId: poll.id,
                optionIndex
            });

            return true;
        } catch (error: any) {
            logger.error(`[PollsManager] Vote handling error: ${error.message}`);
            if (!interaction.replied) {
                await interaction.editReply('❌ An error occurred while processing your vote.').catch(() => {});
            }
            return true;
        }
    }

    async updatePollDisplay(poll: Poll, votes: VoteRecord): Promise<void> {
        try {
            const guild = this.client.guilds.cache.get(poll.guild_id);
            if (!guild) return;

            const channel = guild.channels.cache.get(poll.channel_id) as TextChannel;
            if (!channel) return;

            const message = await channel.messages.fetch(poll.message_id).catch(() => null);
            if (!message) return;

            const options: string[] = JSON.parse(poll.options);
            const voteCounts = this.calculateVoteCounts(options.length, votes);
            const totalVotes = Object.keys(votes).length;

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('📊 ' + poll.question)
                .setDescription(this.formatPollOptions(options, voteCounts, totalVotes, poll.anonymous === 1))
                .setFooter({ text: `${totalVotes} ${totalVotes === 1 ? 'vote' : 'votes'}` });

            await message.edit({ embeds: [embed] });
        } catch (error: any) {
            logger.error(`[PollsManager] Failed to update poll display: ${error.message}`);
        }
    }

    calculateVoteCounts(optionCount: number, votes: VoteRecord): number[] {
        const counts = Array(optionCount).fill(0);
        for (const userVotes of Object.values(votes)) {
            for (const index of userVotes) {
                if (index < optionCount) counts[index]++;
            }
        }
        return counts;
    }

    formatPollOptions(options: string[], voteCounts: number[] | Record<number, number> = {}, totalVotes: number = 0, anonymous: boolean = false): string {
        const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

        return options.map((option, i) => {
            const count = (voteCounts as any)[i] || 0;
            const percentage = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
            const bar = this.createProgressBar(percentage);

            return `${emojis[i]} **${option}**\n${bar} ${percentage}% (${count} ${count === 1 ? 'vote' : 'votes'})`;
        }).join('\n\n');
    }

    createProgressBar(percentage: number, length: number = 10): string {
        const filled = Math.round((percentage / 100) * length);
        const empty = length - filled;
        return '█'.repeat(filled) + '░'.repeat(empty);
    }

    async endPoll(pollId: number, reason: string = 'Manually ended'): Promise<boolean> {
        try {
            const [[poll]] = await db.execute<Poll[]>('SELECT * FROM polls WHERE id = ?', [pollId]);
            if (!poll || poll.status !== 'active') return false;

            // Mark as ended
            await db.execute('UPDATE polls SET status = "ended" WHERE id = ?', [pollId]);

            // Update final display
            const votes: VoteRecord = poll.votes ? JSON.parse(poll.votes) : {};
            await this.updatePollDisplay(poll, votes);

            // Post results
            const guild = this.client.guilds.cache.get(poll.guild_id);
            if (guild) {
                const channel = guild.channels.cache.get(poll.channel_id) as TextChannel;
                if (channel) {
                    const options: string[] = JSON.parse(poll.options);
                    const voteCounts = this.calculateVoteCounts(options.length, votes);
                    const totalVotes = Object.keys(votes).length;
                    const winnerIndex = voteCounts.indexOf(Math.max(...voteCounts));

                    const embed = new EmbedBuilder()
                        .setColor('#57F287')
                        .setTitle('📊 Poll Ended')
                        .setDescription(`**${poll.question}**\n\n🏆 **Winner:** ${options[winnerIndex]} (${voteCounts[winnerIndex]} votes)`)
                        .addFields({ name: 'Reason', value: reason })
                        .setTimestamp();

                    await channel.send({ embeds: [embed] });
                }
            }

            logger.info(`[PollsManager] Ended poll ${pollId}`, { pollId, reason });
            return true;
        } catch (error: any) {
            logger.error(`[PollsManager] Failed to end poll: ${error.message}`);
            return false;
        }
    }

    async getActivePoll(messageId: string): Promise<Poll | null> {
        try {
            const [[poll]] = await db.execute<Poll[]>(
                'SELECT * FROM polls WHERE message_id = ? AND status = "active"',
                [messageId]
            );
            return poll || null;
        } catch (error: any) {
            logger.error(`[PollsManager] Failed to get poll: ${error.message}`);
            return null;
        }
    }
}

export = PollsManager;
