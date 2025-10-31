import {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits,
    ButtonInteraction,
    TextChannel,
    GuildMember,
    ChatInputCommandInteraction
} from 'discord.js';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import db from '../utils/db';
import logger from '../utils/logger';

// Interfaces
interface SuggestionConfig extends RowDataPacket {
    guild_id: string;
    enabled: boolean;
    suggestions_channel_id: string | null;
    allow_anonymous: boolean;
    require_approval: boolean;
}

interface Suggestion extends RowDataPacket {
    id: number;
    guild_id: string;
    user_id: string;
    suggestion_text: string;
    is_anonymous: boolean;
    status: 'pending' | 'under_review' | 'approved' | 'rejected' | 'implemented' | 'duplicate';
    message_id: string | null;
    channel_id: string | null;
    staff_response: string | null;
    reviewed_by: string | null;
    reviewed_at: Date | null;
    created_at: Date;
    upvotes: number;
    downvotes: number;
}

interface UserSuggestionStats extends RowDataPacket {
    guild_id: string;
    user_id: string;
    total_suggestions: number;
    approved_suggestions: number;
    rejected_suggestions: number;
    implemented_suggestions: number;
    reputation_score: number;
    total_upvotes_received: number;
    total_downvotes_received: number;
}

interface VoteCounts extends RowDataPacket {
    upvotes: number | null;
    downvotes: number | null;
}

interface SuggestionVote extends RowDataPacket {
    vote_type: 'upvote' | 'downvote';
}

// Main command
const data = new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('💡 Make a suggestion or manage suggestions')
    .addSubcommand(subcommand =>
        subcommand
            .setName('submit')
            .setDescription('Submit a new suggestion')
            .addStringOption(option =>
                option.setName('suggestion')
                    .setDescription('Your suggestion')
                    .setRequired(true)
                    .setMaxLength(1000))
            .addBooleanOption(option =>
                option.setName('anonymous')
                    .setDescription('Submit anonymously')
                    .setRequired(false)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('view')
            .setDescription('View a specific suggestion')
            .addIntegerOption(option =>
                option.setName('id')
                    .setDescription('Suggestion ID')
                    .setRequired(true)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('list')
            .setDescription('List suggestions')
            .addStringOption(option =>
                option.setName('status')
                    .setDescription('Filter by status')
                    .setRequired(false)
                    .addChoices(
                        { name: '⏳ Pending', value: 'pending' },
                        { name: '👁️ Under Review', value: 'under_review' },
                        { name: '✅ Approved', value: 'approved' },
                        { name: '❌ Rejected', value: 'rejected' },
                        { name: '🚀 Implemented', value: 'implemented' }
                    ))
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('Filter by user')
                    .setRequired(false)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('approve')
            .setDescription('Approve a suggestion (Staff only)')
            .addIntegerOption(option =>
                option.setName('id')
                    .setDescription('Suggestion ID')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('response')
                    .setDescription('Staff response/comment')
                    .setRequired(false)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('reject')
            .setDescription('Reject a suggestion (Staff only)')
            .addIntegerOption(option =>
                option.setName('id')
                    .setDescription('Suggestion ID')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('reason')
                    .setDescription('Reason for rejection')
                    .setRequired(true)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('implement')
            .setDescription('Mark suggestion as implemented (Staff only)')
            .addIntegerOption(option =>
                option.setName('id')
                    .setDescription('Suggestion ID')
                    .setRequired(true)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('stats')
            .setDescription('View suggestion statistics')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('User to view stats for')
                    .setRequired(false)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('setup')
            .setDescription('Setup suggestions system (Admin only)')
            .addChannelOption(option =>
                option.setName('channel')
                    .setDescription('Channel for suggestions')
                    .setRequired(true)));

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();

    try {
        switch (subcommand) {
            case 'submit':
                await handleSubmit(interaction);
                break;
            case 'view':
                await handleView(interaction);
                break;
            case 'list':
                await handleList(interaction);
                break;
            case 'approve':
                await handleApprove(interaction);
                break;
            case 'reject':
                await handleReject(interaction);
                break;
            case 'implement':
                await handleImplement(interaction);
                break;
            case 'stats':
                await handleStats(interaction);
                break;
            case 'setup':
                await handleSetup(interaction);
                break;
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorStack = error instanceof Error ? error.stack : undefined;

        logger.error('[Suggest] Command error:', { error: errorMessage, stack: errorStack });
        const responseMessage = '❌ An error occurred while processing your suggestion request.';

        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({ content: responseMessage });
        } else {
            await interaction.reply({ content: responseMessage, ephemeral: true });
        }
    }
}

async function handleSubmit(interaction: ChatInputCommandInteraction): Promise<void> {
    const suggestion = interaction.options.getString('suggestion', true);
    const anonymous = interaction.options.getBoolean('anonymous') || false;

    // Get config
    const [[config]] = await db.execute<SuggestionConfig[]>(
        'SELECT * FROM suggestion_config WHERE guild_id = ?',
        [interaction.guild!.id]
    );

    if (!config || !config.enabled) {
        await interaction.reply({
            content: '❌ Suggestions system is not enabled in this server. Ask an admin to set it up with `/suggest setup`.',
            ephemeral: true
        });
        return;
    }

    if (!config.suggestions_channel_id) {
        await interaction.reply({
            content: '❌ Suggestions channel is not configured. Ask an admin to set it up.',
            ephemeral: true
        });
        return;
    }

    if (anonymous && !config.allow_anonymous) {
        await interaction.reply({
            content: '❌ Anonymous suggestions are not allowed in this server.',
            ephemeral: true
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        // Create suggestion in database
        const [result] = await db.execute<ResultSetHeader>(
            `INSERT INTO suggestions (guild_id, user_id, suggestion_text, is_anonymous, status)
             VALUES (?, ?, ?, ?, ?)`,
            [interaction.guild!.id, interaction.user.id, suggestion, anonymous, config.require_approval ? 'pending' : 'approved']
        );

        const suggestionId = result.insertId;

        // Update user stats
        await db.execute(
            `INSERT INTO user_suggestion_stats (guild_id, user_id, total_suggestions)
             VALUES (?, ?, 1)
             ON DUPLICATE KEY UPDATE total_suggestions = total_suggestions + 1`,
            [interaction.guild!.id, interaction.user.id]
        );

        // Post to suggestions channel
        const channel = await interaction.guild!.channels.fetch(config.suggestions_channel_id) as TextChannel;

        const embed = new EmbedBuilder()
            .setColor('#3498db')
            .setTitle(`💡 Suggestion #${suggestionId}`)
            .setDescription(suggestion)
            .addFields(
                { name: '👤 Submitted By', value: anonymous ? '👻 Anonymous' : `${interaction.user}`, inline: true },
                { name: '📊 Status', value: config.require_approval ? '⏳ Pending Review' : '✅ Approved', inline: true },
                { name: '📅 Date', value: new Date().toLocaleDateString(), inline: true }
            )
            .setFooter({ text: `Suggestion ID: ${suggestionId}` })
            .setTimestamp();

        const buttons = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`suggest_upvote_${suggestionId}`)
                    .setLabel('👍 0')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`suggest_downvote_${suggestionId}`)
                    .setLabel('👎 0')
                    .setStyle(ButtonStyle.Danger)
            );

        const message = await channel.send({ embeds: [embed], components: [buttons] });

        // Update suggestion with message ID
        await db.execute(
            'UPDATE suggestions SET message_id = ?, channel_id = ? WHERE id = ?',
            [message.id, channel.id, suggestionId]
        );

        await interaction.editReply({
            content: `✅ Your suggestion (#${suggestionId}) has been submitted successfully!${config.require_approval ? ' It will be reviewed by staff.' : ''}`
        });

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorStack = error instanceof Error ? error.stack : undefined;

        logger.error('[Suggest] Submit _error:', { error: errorMessage, stack: errorStack });
        await interaction.editReply({
            content: '❌ Failed to submit suggestion. Please try again later.'
        });
    }
}

async function handleView(interaction: ChatInputCommandInteraction): Promise<void> {
    const suggestionId = interaction.options.getInteger('id', true);

    const [[suggestion]] = await db.execute<Suggestion[]>(
        'SELECT * FROM suggestions WHERE id = ? AND guild_id = ?',
        [suggestionId, interaction.guild!.id]
    );

    if (!suggestion) {
        await interaction.reply({
            content: '❌ Suggestion not found.',
            ephemeral: true
        });
        return;
    }

    // Get votes
    const [[voteCounts]] = await db.execute<VoteCounts[]>(
        `SELECT
            SUM(CASE WHEN vote_type = 'upvote' THEN 1 ELSE 0 END) as upvotes,
            SUM(CASE WHEN vote_type = 'downvote' THEN 1 ELSE 0 END) as downvotes
         FROM suggestion_votes
         WHERE suggestion_id = ?`,
        [suggestionId]
    );

    const upvotes = voteCounts?.upvotes || 0;
    const downvotes = voteCounts?.downvotes || 0;
    const netVotes = Number(upvotes) - Number(downvotes);

    const embed = new EmbedBuilder()
        .setColor(getStatusColor(suggestion.status))
        .setTitle(`💡 Suggestion #${suggestionId}`)
        .setDescription(suggestion.suggestion_text)
        .addFields(
            { name: '👤 Submitted By', value: suggestion.is_anonymous ? '👻 Anonymous' : `<@${suggestion.user_id}>`, inline: true },
            { name: '📊 Status', value: getStatusDisplay(suggestion.status), inline: true },
            { name: '📅 Date', value: new Date(suggestion.created_at).toLocaleDateString(), inline: true },
            { name: '👍 Upvotes', value: `${upvotes}`, inline: true },
            { name: '👎 Downvotes', value: `${downvotes}`, inline: true },
            { name: '📈 Net Votes', value: `${netVotes}`, inline: true }
        );

    if (suggestion.staff_response) {
        embed.addFields({ name: '💬 Staff Response', value: suggestion.staff_response, inline: false });
    }

    if (suggestion.reviewed_by) {
        embed.addFields({ name: '👨‍💼 Reviewed By', value: `<@${suggestion.reviewed_by}>`, inline: true });
    }

    embed.setFooter({ text: `Suggestion ID: ${suggestionId}` });
    embed.setTimestamp(new Date(suggestion.created_at));

    await interaction.reply({ embeds: [embed] });
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
    const status = interaction.options.getString('status');
    const user = interaction.options.getUser('user');

    let query = 'SELECT * FROM suggestions WHERE guild_id = ?';
    const params: (string | undefined)[] = [interaction.guild!.id];

    if (status) {
        query += ' AND status = ?';
        params.push(status);
    }

    if (user) {
        query += ' AND user_id = ?';
        params.push(user.id);
    }

    query += ' ORDER BY created_at DESC LIMIT 10';

    const [suggestions] = await db.execute<Suggestion[]>(query, params);

    if (suggestions.length === 0) {
        await interaction.reply({
            content: '❌ No suggestions found matching your criteria.',
            ephemeral: true
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#3498db')
        .setTitle('💡 Suggestions List')
        .setDescription(`Found ${suggestions.length} suggestion(s)`);

    for (const suggestion of suggestions) {
        const preview = suggestion.suggestion_text.length > 100
            ? suggestion.suggestion_text.substring(0, 100) + '...'
            : suggestion.suggestion_text;

        embed.addFields({
            name: `#${suggestion.id} - ${getStatusDisplay(suggestion.status)}`,
            value: `${preview}\nBy: ${suggestion.is_anonymous ? '👻 Anonymous' : `<@${suggestion.user_id}>`} | 👍 ${suggestion.upvotes} 👎 ${suggestion.downvotes}`,
            inline: false
        });
    }

    embed.setFooter({ text: 'Use /suggest view <id> to see full details' });

    await interaction.reply({ embeds: [embed] });
}

async function handleApprove(interaction: ChatInputCommandInteraction): Promise<void> {
    // Check permissions
    const member = interaction.member as GuildMember;
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
            content: '❌ You need Manage Server permission to approve suggestions.',
            ephemeral: true
        });
        return;
    }

    const suggestionId = interaction.options.getInteger('id', true);
    const response = interaction.options.getString('response');

    await interaction.deferReply();

    const [[suggestion]] = await db.execute<Suggestion[]>(
        'SELECT * FROM suggestions WHERE id = ? AND guild_id = ?',
        [suggestionId, interaction.guild!.id]
    );

    if (!suggestion) {
        await interaction.editReply({
            content: '❌ Suggestion not found.'
        });
        return;
    }

    // Update status
    await db.execute(
        `UPDATE suggestions
         SET status = 'approved', staff_response = ?, reviewed_by = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [response, interaction.user.id, suggestionId]
    );

    // Update user stats
    await db.execute(
        `UPDATE user_suggestion_stats
         SET approved_suggestions = approved_suggestions + 1,
             reputation_score = reputation_score + 5
         WHERE guild_id = ? AND user_id = ?`,
        [interaction.guild!.id, suggestion.user_id]
    );

    // Update message if exists
    if (suggestion.message_id && suggestion.channel_id) {
        try {
            const channel = await interaction.guild!.channels.fetch(suggestion.channel_id) as TextChannel;
            const message = await channel.messages.fetch(suggestion.message_id);

            const originalEmbed = message.embeds[0];
            const embed = originalEmbed ? EmbedBuilder.from(originalEmbed)
                .setColor('#00FF00')
                .spliceFields(1, 1, { name: '📊 Status', value: '✅ Approved', inline: true }) : null;

            if (!embed) {
                logger.error('[Suggest] Original embed not found');
                return;
            }

            if (response) {
                embed.addFields({ name: '💬 Staff Response', value: response, inline: false });
            }

            await message.edit({ embeds: [embed] });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error('[Suggest] Failed to update message:', { error: errorMessage });
        }
    }

    // Notify user
    if (!suggestion.is_anonymous) {
        try {
            const user = await interaction.client.users.fetch(suggestion.user_id);
            const dmEmbed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('✅ Suggestion Approved!')
                .setDescription(`Your suggestion (#${suggestionId}) in **${interaction.guild!.name}** has been approved!`)
                .addFields({ name: 'Your Suggestion', value: suggestion.suggestion_text, inline: false });

            if (response) {
                dmEmbed.addFields({ name: '💬 Staff Response', value: response, inline: false });
            }

            await user.send({ embeds: [dmEmbed] });
        } catch (error) {
            // User has DMs disabled
        }
    }

    await interaction.editReply({
        content: `✅ Suggestion #${suggestionId} has been approved!`
    });
}

async function handleReject(interaction: ChatInputCommandInteraction): Promise<void> {
    // Check permissions
    const member = interaction.member as GuildMember;
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
            content: '❌ You need Manage Server permission to reject suggestions.',
            ephemeral: true
        });
        return;
    }

    const suggestionId = interaction.options.getInteger('id', true);
    const reason = interaction.options.getString('reason', true);

    await interaction.deferReply();

    const [[suggestion]] = await db.execute<Suggestion[]>(
        'SELECT * FROM suggestions WHERE id = ? AND guild_id = ?',
        [suggestionId, interaction.guild!.id]
    );

    if (!suggestion) {
        await interaction.editReply({
            content: '❌ Suggestion not found.'
        });
        return;
    }

    // Update status
    await db.execute(
        `UPDATE suggestions
         SET status = 'rejected', staff_response = ?, reviewed_by = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [reason, interaction.user.id, suggestionId]
    );

    // Update user stats
    await db.execute(
        `UPDATE user_suggestion_stats
         SET rejected_suggestions = rejected_suggestions + 1
         WHERE guild_id = ? AND user_id = ?`,
        [interaction.guild!.id, suggestion.user_id]
    );

    // Update message if exists
    if (suggestion.message_id && suggestion.channel_id) {
        try {
            const channel = await interaction.guild!.channels.fetch(suggestion.channel_id) as TextChannel;
            const message = await channel.messages.fetch(suggestion.message_id);

            const originalEmbed = message.embeds[0];
            const embed = originalEmbed ? EmbedBuilder.from(originalEmbed)
                .setColor('#FF0000')
                .spliceFields(1, 1, { name: '📊 Status', value: '❌ Rejected', inline: true })
                .addFields({ name: '💬 Reason', value: reason, inline: false }) : null;

            if (!embed) {
                logger.error('[Suggest] Original embed not found');
                return;
            }

            await message.edit({ embeds: [embed] });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error('[Suggest] Failed to update message:', { error: errorMessage });
        }
    }

    // Notify user
    if (!suggestion.is_anonymous) {
        try {
            const user = await interaction.client.users.fetch(suggestion.user_id);
            const dmEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Suggestion Rejected')
                .setDescription(`Your suggestion (#${suggestionId}) in **${interaction.guild!.name}** has been rejected.`)
                .addFields(
                    { name: 'Your Suggestion', value: suggestion.suggestion_text, inline: false },
                    { name: '💬 Reason', value: reason, inline: false }
                );

            await user.send({ embeds: [dmEmbed] });
        } catch (error) {
            // User has DMs disabled
        }
    }

    await interaction.editReply({
        content: `❌ Suggestion #${suggestionId} has been rejected.`
    });
}

async function handleImplement(interaction: ChatInputCommandInteraction): Promise<void> {
    // Check permissions
    const member = interaction.member as GuildMember;
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
            content: '❌ You need Manage Server permission to mark suggestions as implemented.',
            ephemeral: true
        });
        return;
    }

    const suggestionId = interaction.options.getInteger('id', true);

    const [[suggestion]] = await db.execute<Suggestion[]>(
        'SELECT * FROM suggestions WHERE id = ? AND guild_id = ?',
        [suggestionId, interaction.guild!.id]
    );

    if (!suggestion) {
        await interaction.reply({
            content: '❌ Suggestion not found.',
            ephemeral: true
        });
        return;
    }

    // Update status
    await db.execute(
        `UPDATE suggestions
         SET status = 'implemented', reviewed_by = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [interaction.user.id, suggestionId]
    );

    // Update user stats
    await db.execute(
        `UPDATE user_suggestion_stats
         SET implemented_suggestions = implemented_suggestions + 1,
             reputation_score = reputation_score + 10
         WHERE guild_id = ? AND user_id = ?`,
        [interaction.guild!.id, suggestion.user_id]
    );

    // Update message if exists
    if (suggestion.message_id && suggestion.channel_id) {
        try {
            const channel = await interaction.guild!.channels.fetch(suggestion.channel_id) as TextChannel;
            const message = await channel.messages.fetch(suggestion.message_id);

            const originalEmbed = message.embeds[0];
            const embed = originalEmbed ? EmbedBuilder.from(originalEmbed)
                .setColor('#FFD700')
                .spliceFields(1, 1, { name: '📊 Status', value: '🚀 Implemented', inline: true }) : null;

            if (!embed) {
                logger.error('[Suggest] Original embed not found');
                return;
            }

            await message.edit({ embeds: [embed] });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error('[Suggest] Failed to update message:', { error: errorMessage });
        }
    }

    // Notify user
    if (!suggestion.is_anonymous) {
        try {
            const user = await interaction.client.users.fetch(suggestion.user_id);
            const dmEmbed = new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle('🚀 Suggestion Implemented!')
                .setDescription(`Your suggestion (#${suggestionId}) in **${interaction.guild!.name}** has been implemented!`)
                .addFields({ name: 'Your Suggestion', value: suggestion.suggestion_text, inline: false });

            await user.send({ embeds: [dmEmbed] });
        } catch (error) {
            // User has DMs disabled
        }
    }

    await interaction.reply({
        content: `🚀 Suggestion #${suggestionId} has been marked as implemented!`
    });
}

async function handleStats(interaction: ChatInputCommandInteraction): Promise<void> {
    const targetUser = interaction.options.getUser('user') || interaction.user;

    const [[stats]] = await db.execute<UserSuggestionStats[]>(
        'SELECT * FROM user_suggestion_stats WHERE guild_id = ? AND user_id = ?',
        [interaction.guild!.id, targetUser.id]
    );

    if (!stats || stats.total_suggestions === 0) {
        await interaction.reply({
            content: targetUser.id === interaction.user.id
                ? '❌ You haven\'t submitted any suggestions yet!'
                : `❌ ${targetUser.username} hasn't submitted any suggestions yet.`,
            ephemeral: true
        });
        return;
    }

    const approvalRate = Math.round((stats.approved_suggestions / stats.total_suggestions) * 100);

    const embed = new EmbedBuilder()
        .setColor('#3498db')
        .setTitle(`💡 Suggestion Statistics - ${targetUser.username}`)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
            { name: '📝 Total Suggestions', value: `${stats.total_suggestions}`, inline: true },
            { name: '✅ Approved', value: `${stats.approved_suggestions}`, inline: true },
            { name: '❌ Rejected', value: `${stats.rejected_suggestions}`, inline: true },
            { name: '🚀 Implemented', value: `${stats.implemented_suggestions}`, inline: true },
            { name: '📊 Approval Rate', value: `${approvalRate}%`, inline: true },
            { name: '⭐ Reputation', value: `${stats.reputation_score}`, inline: true },
            { name: '👍 Total Upvotes', value: `${stats.total_upvotes_received}`, inline: true },
            { name: '👎 Total Downvotes', value: `${stats.total_downvotes_received}`, inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

async function handleSetup(interaction: ChatInputCommandInteraction): Promise<void> {
    // Check permissions
    const member = interaction.member as GuildMember;
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
            content: '❌ You need Administrator permission to setup suggestions.',
            ephemeral: true
        });
        return;
    }

    const channel = interaction.options.getChannel('channel', true) as TextChannel;

    // Create or update config
    await db.execute(
        `INSERT INTO suggestion_config (guild_id, suggestions_channel_id, enabled)
         VALUES (?, ?, TRUE)
         ON DUPLICATE KEY UPDATE suggestions_channel_id = ?, enabled = TRUE`,
        [interaction.guild!.id, channel.id, channel.id]
    );

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Suggestions System Configured')
        .setDescription(`Suggestions system has been set up successfully!`)
        .addFields(
            { name: '📍 Suggestions Channel', value: `${channel}`, inline: false },
            { name: '📋 Commands', value: '`/suggest submit` - Submit a suggestion\n`/suggest view <id>` - View a suggestion\n`/suggest list` - List suggestions\n`/suggest approve <id>` - Approve (Staff)\n`/suggest reject <id>` - Reject (Staff)', inline: false }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

function getStatusDisplay(status: string): string {
    const statuses: Record<string, string> = {
        'pending': '⏳ Pending',
        'under_review': '👁️ Under Review',
        'approved': '✅ Approved',
        'rejected': '❌ Rejected',
        'implemented': '🚀 Implemented',
        'duplicate': '📋 Duplicate'
    };
    return statuses[status] || status;
}

function getStatusColor(status: string): number {
    const colors: Record<string, number> = {
        'pending': 0xFFA500,
        'under_review': 0x3498db,
        'approved': 0x00FF00,
        'rejected': 0xFF0000,
        'implemented': 0xFFD700,
        'duplicate': 0x95a5a6
    };
    return colors[status] || 0x3498db;
}

// Handle button interactions
async function handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith('suggest_')) return false;

    const parts = interaction.customId.split('_');
    const action = parts[0];
    const voteType = parts[1] ?? "unknown";
    const suggestionIdStr = parts[2];
    const suggestionId = parseInt(suggestionIdStr ?? "0");

    if (action !== 'suggest') return false;
    if (!voteType || !suggestionIdStr) return false;

    // Get current vote
    const [[existingVote]] = await db.execute<SuggestionVote[]>(
        'SELECT vote_type FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?',
        [suggestionId, interaction.user.id]
    );

    try {
        if (existingVote && existingVote.vote_type === voteType) {
            // Remove vote
            await db.execute(
                'DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?',
                [suggestionId, interaction.user.id]
            );

            await interaction.reply({
                content: `✅ Your ${voteType} has been removed.`,
                ephemeral: true
            });
        } else {
            // Add or update vote
            await db.execute(
                `INSERT INTO suggestion_votes (suggestion_id, user_id, vote_type)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE vote_type = ?`,
                [suggestionId, interaction.user.id, voteType, voteType]
            );

            await interaction.reply({
                content: `✅ Your ${voteType} has been recorded!`,
                ephemeral: true
            });
        }

        // Update vote counts
        const [[voteCounts]] = await db.execute<VoteCounts[]>(
            `SELECT
                SUM(CASE WHEN vote_type = 'upvote' THEN 1 ELSE 0 END) as upvotes,
                SUM(CASE WHEN vote_type = 'downvote' THEN 1 ELSE 0 END) as downvotes
             FROM suggestion_votes
             WHERE suggestion_id = ?`,
            [suggestionId]
        );

        const upvotes = voteCounts?.upvotes || 0;
        const downvotes = voteCounts?.downvotes || 0;

        await db.execute(
            'UPDATE suggestions SET upvotes = ?, downvotes = ? WHERE id = ?',
            [upvotes, downvotes, suggestionId]
        );

        // Update message buttons
        const buttons = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`suggest_upvote_${suggestionId}`)
                    .setLabel(`👍 ${upvotes}`)
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`suggest_downvote_${suggestionId}`)
                    .setLabel(`👎 ${downvotes}`)
                    .setStyle(ButtonStyle.Danger)
            );

        await interaction.message.edit({ components: [buttons] });

        // Update user stats
        const [[suggestion]] = await db.execute<Suggestion[]>(
            'SELECT user_id FROM suggestions WHERE id = ?',
            [suggestionId]
        );

        if (suggestion) {
            await db.execute(
                `UPDATE user_suggestion_stats
                 SET total_upvotes_received = ?,
                     total_downvotes_received = ?
                 WHERE guild_id = ? AND user_id = ?`,
                [upvotes, downvotes, interaction.guild!.id, suggestion.user_id]
            );
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error('[Suggest] Vote _error:', { error: errorMessage });
        await interaction.reply({
            content: '❌ Failed to record your vote. Please try again.',
            ephemeral: true
        });
    }

    return true;
}

// Export using CommonJS pattern
module.exports = {
    data,
    execute,
    handleButton,
    category: 'utility'
};