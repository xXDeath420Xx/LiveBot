import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/**
 * Suggestion Manager
 * Handles suggestion creation, voting, and status updates
 */
class SuggestionManager {
    constructor(client) {
        this.client = client;
    }

    /**
     * Create a new suggestion
     */
    async createSuggestion(guildId, userId, suggestionText, isAnonymous = false, config) {
        try {
            const status = config.require_approval ? 'pending' : 'approved';

            // Insert suggestion into database
            const [result] = await pool.execute(
                `INSERT INTO suggestions (guild_id, user_id, suggestion_text, is_anonymous, status)
                 VALUES (?, ?, ?, ?, ?)`,
                [guildId, userId, suggestionText, isAnonymous, status]
            );

            const suggestionId = result.insertId;

            // Update user stats
            await pool.execute(
                `INSERT INTO user_suggestion_stats (guild_id, user_id, total_suggestions)
                 VALUES (?, ?, 1)
                 ON DUPLICATE KEY UPDATE total_suggestions = total_suggestions + 1`,
                [guildId, userId]
            );

            return suggestionId;
        } catch (error) {
            logger.error('[SuggestionManager] Error creating suggestion:', error);
            throw error;
        }
    }

    /**
     * Post suggestion to channel
     */
    async postSuggestion(guild, channelId, suggestionId, suggestionText, user, isAnonymous, status) {
        try {
            const channel = await guild.channels.fetch(channelId);
            if (!channel) throw new Error('Suggestions channel not found');

            const embed = new EmbedBuilder()
                .setColor(this.getStatusColor(status))
                .setTitle(`Suggestion #${suggestionId}`)
                .setDescription(suggestionText)
                .addFields(
                    { name: 'Submitted By', value: isAnonymous ? 'Anonymous' : `${user}`, inline: true },
                    { name: 'Status', value: this.getStatusDisplay(status), inline: true },
                    { name: 'Date', value: new Date().toLocaleDateString(), inline: true }
                )
                .setFooter({ text: `Suggestion ID: ${suggestionId}` })
                .setTimestamp();

            const buttons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`suggestion_upvote_${suggestionId}`)
                        .setLabel('0')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('👍'),
                    new ButtonBuilder()
                        .setCustomId(`suggestion_downvote_${suggestionId}`)
                        .setLabel('0')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('👎')
                );

            let storedChannelId, storedMessageId;

            if (channel.type === ChannelType.GuildForum) {
                // Forum channel: create a thread (post) with the embed as starter message
                const statusTag = this.getForumTagByStatus(channel, status);
                const thread = await channel.threads.create({
                    name: `Suggestion #${suggestionId}: ${suggestionText.substring(0, 80)}`,
                    message: { embeds: [embed], components: [buttons] },
                    appliedTags: statusTag ? [statusTag.id] : []
                });
                // In forums, thread.id === starter message ID
                storedChannelId = thread.id;
                storedMessageId = thread.id;
            } else {
                // Regular text channel: send as message
                const message = await channel.send({ embeds: [embed], components: [buttons] });
                storedChannelId = channel.id;
                storedMessageId = message.id;
            }

            await pool.execute(
                'UPDATE suggestions SET message_id = ?, channel_id = ? WHERE id = ?',
                [storedMessageId, storedChannelId, suggestionId]
            );

            return { id: storedMessageId };
        } catch (error) {
            logger.error('[SuggestionManager] Error posting suggestion:', error);
            throw error;
        }
    }

    /**
     * Handle voting on a suggestion
     */
    async handleVote(suggestionId, userId, guildId, voteType) {
        try {
            // Get current vote
            const [existingVotes] = await pool.execute(
                'SELECT vote_type FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?',
                [suggestionId, userId]
            );

            const existingVote = existingVotes[0];

            if (existingVote && existingVote.vote_type === voteType) {
                // Remove vote
                await pool.execute(
                    'DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?',
                    [suggestionId, userId]
                );
                return { action: 'removed', voteType };
            } else {
                // Add or update vote
                await pool.execute(
                    `INSERT INTO suggestion_votes (suggestion_id, user_id, vote_type)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE vote_type = ?`,
                    [suggestionId, userId, voteType, voteType]
                );
                return { action: existingVote ? 'changed' : 'added', voteType };
            }
        } catch (error) {
            logger.error('[SuggestionManager] Error handling vote:', error);
            throw error;
        }
    }

    /**
     * Update vote counts on suggestion message
     */
    async updateVoteCounts(suggestionId) {
        try {
            // Get vote counts
            const [voteCounts] = await pool.execute(
                `SELECT
                    SUM(CASE WHEN vote_type = 'upvote' THEN 1 ELSE 0 END) as upvotes,
                    SUM(CASE WHEN vote_type = 'downvote' THEN 1 ELSE 0 END) as downvotes
                 FROM suggestion_votes
                 WHERE suggestion_id = ?`,
                [suggestionId]
            );

            const upvotes = voteCounts[0]?.upvotes || 0;
            const downvotes = voteCounts[0]?.downvotes || 0;

            // Update suggestion record
            await pool.execute(
                'UPDATE suggestions SET upvotes = ?, downvotes = ? WHERE id = ?',
                [upvotes, downvotes, suggestionId]
            );

            // Update user stats
            const [suggestions] = await pool.execute(
                'SELECT guild_id, user_id FROM suggestions WHERE id = ?',
                [suggestionId]
            );

            if (suggestions[0]) {
                await pool.execute(
                    `INSERT INTO user_suggestion_stats
                     (guild_id, user_id, total_upvotes_received, total_downvotes_received)
                     VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                         total_upvotes_received = ?,
                         total_downvotes_received = ?`,
                    [suggestions[0].guild_id, suggestions[0].user_id, upvotes, downvotes, upvotes, downvotes]
                );
            }

            return { upvotes, downvotes };
        } catch (error) {
            logger.error('[SuggestionManager] Error updating vote counts:', error);
            throw error;
        }
    }

    /**
     * Update suggestion message
     */
    async updateSuggestionMessage(guild, channelId, messageId, suggestionId, upvotes, downvotes) {
        try {
            const channel = await guild.channels.fetch(channelId);
            if (!channel) return;

            const message = await channel.messages.fetch(messageId);
            if (!message) return;

            const buttons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`suggestion_upvote_${suggestionId}`)
                        .setLabel(`${upvotes}`)
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('👍'),
                    new ButtonBuilder()
                        .setCustomId(`suggestion_downvote_${suggestionId}`)
                        .setLabel(`${downvotes}`)
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('👎')
                );

            await message.edit({ components: [buttons] });
        } catch (error) {
            logger.error('[SuggestionManager] Error updating message:', error);
        }
    }

    /**
     * Update suggestion status
     */
    async updateStatus(suggestionId, status, reviewerId, staffResponse = null) {
        try {
            await pool.execute(
                `UPDATE suggestions
                 SET status = ?, staff_response = ?, reviewed_by = ?, reviewed_at = NOW()
                 WHERE id = ?`,
                [status, staffResponse, reviewerId, suggestionId]
            );

            // Get suggestion details
            const [suggestions] = await pool.execute(
                'SELECT * FROM suggestions WHERE id = ?',
                [suggestionId]
            );

            const suggestion = suggestions[0];
            if (!suggestion) return null;

            // Update user reputation based on status
            let reputationChange = 0;
            let statField = null;

            switch (status) {
                case 'approved':
                    reputationChange = 5;
                    statField = 'approved_suggestions';
                    break;
                case 'rejected':
                    statField = 'rejected_suggestions';
                    break;
                case 'implemented':
                    reputationChange = 10;
                    statField = 'implemented_suggestions';
                    break;
            }

            if (statField) {
                await pool.execute(
                    `UPDATE user_suggestion_stats
                     SET ${statField} = ${statField} + 1,
                         reputation_score = reputation_score + ?
                     WHERE guild_id = ? AND user_id = ?`,
                    [reputationChange, suggestion.guild_id, suggestion.user_id]
                );
            }

            return suggestion;
        } catch (error) {
            logger.error('[SuggestionManager] Error updating status:', error);
            throw error;
        }
    }

    /**
     * Update suggestion message embed with new status
     */
    async updateSuggestionEmbed(guild, suggestion, newStatus, staffResponse = null) {
        try {
            if (!suggestion.message_id || !suggestion.channel_id) return;

            const channel = await guild.channels.fetch(suggestion.channel_id);
            if (!channel) return;

            const message = await channel.messages.fetch(suggestion.message_id);
            if (!message || !message.embeds[0]) return;

            const oldEmbed = message.embeds[0];
            const embed = EmbedBuilder.from(oldEmbed)
                .setColor(this.getStatusColor(newStatus))
                .spliceFields(1, 1, { name: 'Status', value: this.getStatusDisplay(newStatus), inline: true });

            if (staffResponse) {
                embed.addFields({ name: 'Staff Response', value: staffResponse, inline: false });
            }

            await message.edit({ embeds: [embed] });

            // Update forum thread tags if this is a forum post
            if (channel.isThread() && channel.parent?.type === ChannelType.GuildForum) {
                const statusTag = this.getForumTagByStatus(channel.parent, newStatus);
                if (statusTag) {
                    await channel.setAppliedTags([statusTag.id]).catch(() => {});
                }
            }
        } catch (error) {
            logger.error('[SuggestionManager] Error updating embed:', error);
        }
    }

    /**
     * Send notification to user
     */
    async notifyUser(client, userId, guildName, suggestionId, suggestionText, status, staffResponse = null) {
        try {
            const user = await client.users.fetch(userId);
            if (!user) return;

            const statusMessages = {
                approved: { title: 'Suggestion Approved!', color: '#00FF00', emoji: '✅' },
                rejected: { title: 'Suggestion Rejected', color: '#FF0000', emoji: '❌' },
                implemented: { title: 'Suggestion Implemented!', color: '#FFD700', emoji: '🚀' }
            };

            const statusInfo = statusMessages[status];
            if (!statusInfo) return;

            const embed = new EmbedBuilder()
                .setColor(statusInfo.color)
                .setTitle(`${statusInfo.emoji} ${statusInfo.title}`)
                .setDescription(`Your suggestion (#${suggestionId}) in **${guildName}** has been ${status}!`)
                .addFields({ name: 'Your Suggestion', value: suggestionText, inline: false });

            if (staffResponse) {
                embed.addFields({ name: status === 'rejected' ? 'Reason' : 'Staff Response', value: staffResponse, inline: false });
            }

            await user.send({ embeds: [embed] });
        } catch (error) {
            // User has DMs disabled or other error
            logger.debug('[SuggestionManager] Could not send DM to user:', error.message);
        }
    }

    /**
     * Get suggestion config
     */
    async getConfig(guildId) {
        try {
            const [configs] = await pool.execute(
                'SELECT * FROM suggestion_config WHERE guild_id = ?',
                [guildId]
            );
            return configs[0] || null;
        } catch (error) {
            logger.error('[SuggestionManager] Error getting config:', error);
            throw error;
        }
    }

    /**
     * Get status display text
     */
    getStatusDisplay(status) {
        const statuses = {
            'pending': 'Pending',
            'under_review': 'Under Review',
            'approved': 'Approved',
            'rejected': 'Rejected',
            'implemented': 'Implemented',
            'duplicate': 'Duplicate'
        };
        return statuses[status] || status;
    }

    /**
     * Get status color
     */
    getStatusColor(status) {
        const colors = {
            'pending': 0xFFA500,
            'under_review': 0x3498db,
            'approved': 0x00FF00,
            'rejected': 0xFF0000,
            'implemented': 0xFFD700,
            'duplicate': 0x95a5a6
        };
        return colors[status] || 0x3498db;
    }

    /**
     * Find a forum tag matching a suggestion status
     */
    getForumTagByStatus(forumChannel, status) {
        const statusToTag = {
            'pending': 'Pending',
            'under_review': 'Under Review',
            'approved': 'Approved',
            'rejected': 'Rejected',
            'implemented': 'Implemented',
            'duplicate': 'Duplicate'
        };
        const tagName = statusToTag[status];
        if (!tagName || !forumChannel.availableTags) return null;
        return forumChannel.availableTags.find(t => t.name === tagName) || null;
    }
}

export default SuggestionManager;
