import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

export async function handleForumSuggestionSubmit(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const category = interaction.fields.getTextInputValue('suggestion_category');
        const title = interaction.fields.getTextInputValue('suggestion_title');
        const description = interaction.fields.getTextInputValue('suggestion_description');
        const benefit = interaction.fields.getTextInputValue('suggestion_benefit');

        const suggestionText = `${description}\n\n**Why this benefits the community:**\n${benefit}`;

        // Get suggestion config
        const [configs] = await pool.execute(
            'SELECT * FROM suggestion_config WHERE guild_id = ?',
            [interaction.guildId]
        );
        const config = configs[0];
        if (!config?.suggestions_channel_id) {
            return interaction.editReply({ content: 'Suggestions are not configured for this server.' });
        }

        const status = config.require_approval ? 'pending' : 'approved';

        // Insert into DB
        const [result] = await pool.execute(
            `INSERT INTO suggestions (guild_id, user_id, suggestion_text, is_anonymous, status)
             VALUES (?, ?, ?, 0, ?)`,
            [interaction.guildId, interaction.user.id, suggestionText, status]
        );
        const suggestionId = result.insertId;

        // Update user stats
        await pool.execute(
            `INSERT INTO user_suggestion_stats (guild_id, user_id, total_suggestions)
             VALUES (?, ?, 1)
             ON DUPLICATE KEY UPDATE total_suggestions = total_suggestions + 1`,
            [interaction.guildId, interaction.user.id]
        );

        // Build embed
        const embed = new EmbedBuilder()
            .setColor(status === 'pending' ? 0xFFA500 : 0x00FF00)
            .setTitle(`Suggestion #${suggestionId}: ${title}`)
            .setDescription(description)
            .addFields(
                { name: 'Category', value: category, inline: true },
                { name: 'Submitted By', value: `${interaction.user}`, inline: true },
                { name: 'Status', value: status === 'pending' ? '⏳ Pending' : '✅ Approved', inline: true },
                { name: 'Community Benefit', value: benefit, inline: false }
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

        // Post to forum
        const channel = await interaction.guild.channels.fetch(config.suggestions_channel_id);
        let storedChannelId, storedMessageId;

        if (channel.type === ChannelType.GuildForum) {
            const pendingTag = channel.availableTags?.find(t => t.name === 'Pending');
            const tags = pendingTag ? [pendingTag.id] : [];
            const thread = await channel.threads.create({
                name: `#${suggestionId}: ${title.substring(0, 90)}`,
                message: { embeds: [embed], components: [buttons] },
                appliedTags: tags
            });
            storedChannelId = thread.id;
            storedMessageId = thread.id;
        } else {
            const message = await channel.send({ embeds: [embed], components: [buttons] });
            storedChannelId = channel.id;
            storedMessageId = message.id;
        }

        await pool.execute(
            'UPDATE suggestions SET message_id = ?, channel_id = ? WHERE id = ?',
            [storedMessageId, storedChannelId, suggestionId]
        );

        await interaction.editReply({
            content: `Your suggestion has been submitted! (ID: #${suggestionId})${status === 'pending' ? ' It will be visible once approved by staff.' : ''}`
        });

        logger.info('[ForumSuggestion] Suggestion submitted via form', {
            suggestionId,
            userId: interaction.user.id,
            guildId: interaction.guildId
        });
    } catch (error) {
        logger.error('[ForumSuggestion] Error submitting suggestion', { error: error.message, stack: error.stack });
        const reply = interaction.deferred ? 'editReply' : 'reply';
        await interaction[reply]({ content: 'Failed to submit your suggestion. Please try again.', ephemeral: true }).catch(() => {});
    }
}

export async function handleForumBugReportSubmit(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const title = interaction.fields.getTextInputValue('bug_title');
        const trying = interaction.fields.getTextInputValue('bug_trying');
        const happened = interaction.fields.getTextInputValue('bug_happened');
        const steps = interaction.fields.getTextInputValue('bug_steps') || null;
        const severityRaw = interaction.fields.getTextInputValue('bug_severity').toLowerCase().trim();

        // Normalize severity
        const severityMap = { low: 'low', medium: 'medium', med: 'medium', high: 'high', critical: 'critical', crit: 'critical' };
        const priority = severityMap[severityRaw] || 'medium';

        // Insert into DB
        const [result] = await pool.execute(
            `INSERT INTO bug_reports (user_id, guild_id, username, title, trying_to_do, what_happened, steps_to_reproduce, status, priority)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
            [interaction.user.id, interaction.guildId, interaction.user.tag, title, trying, happened, steps, priority]
        );
        const bugId = result.insertId;

        // Build embed
        const priorityColors = { low: 0x2ECC71, medium: 0xF1C40F, high: 0xE67E22, critical: 0xE74C3C };
        const priorityEmoji = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };

        const embed = new EmbedBuilder()
            .setColor(priorityColors[priority] || 0xE74C3C)
            .setTitle(`Bug #${bugId}: ${title}`)
            .addFields(
                { name: 'Reported By', value: `${interaction.user}`, inline: true },
                { name: 'Status', value: '🟢 Open', inline: true },
                { name: 'Priority', value: `${priorityEmoji[priority]} ${priority.charAt(0).toUpperCase() + priority.slice(1)}`, inline: true },
                { name: 'What I Was Trying To Do', value: trying, inline: false },
                { name: 'What Happened Instead', value: happened, inline: false }
            )
            .setFooter({ text: `Bug Report ID: ${bugId}` })
            .setTimestamp();

        if (steps) {
            embed.addFields({ name: 'Steps to Reproduce', value: steps, inline: false });
        }

        // Post to forum
        const [configs] = await pool.execute(
            'SELECT bug_report_channel_id FROM suggestion_config WHERE guild_id = ?',
            [interaction.guildId]
        );
        const bugChannelId = configs[0]?.bug_report_channel_id;

        if (bugChannelId) {
            const channel = await interaction.guild.channels.fetch(bugChannelId).catch(() => null);
            if (channel?.type === ChannelType.GuildForum) {
                const openTag = channel.availableTags?.find(t => t.name === 'Open');
                const priorityTagName = { low: 'Low Priority', medium: 'Medium Priority', high: 'High Priority', critical: 'Critical' };
                const prioTag = channel.availableTags?.find(t => t.name === priorityTagName[priority]);
                const tags = [openTag?.id, prioTag?.id].filter(Boolean);

                const thread = await channel.threads.create({
                    name: `Bug #${bugId}: ${title.substring(0, 90)}`,
                    message: { embeds: [embed] },
                    appliedTags: tags
                });

                await pool.execute(
                    'UPDATE bug_reports SET screenshot_urls = ? WHERE id = ?',
                    [JSON.stringify({ thread_id: thread.id, channel_id: bugChannelId }), bugId]
                );
            } else if (channel) {
                await channel.send({ embeds: [embed] });
            }
        }

        await interaction.editReply({
            content: `Your bug report has been submitted! (ID: #${bugId}) Our team will investigate.`
        });

        logger.info('[ForumBugReport] Bug report submitted via form', {
            bugId,
            userId: interaction.user.id,
            priority,
            guildId: interaction.guildId
        });
    } catch (error) {
        logger.error('[ForumBugReport] Error submitting bug report', { error: error.message, stack: error.stack });
        const reply = interaction.deferred ? 'editReply' : 'reply';
        await interaction[reply]({ content: 'Failed to submit your bug report. Please try again.', ephemeral: true }).catch(() => {});
    }
}
