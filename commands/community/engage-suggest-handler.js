import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import SuggestionManager from '../../core/suggestion-manager.js';

export async function handleSubmit(interaction) {
    const suggestion = interaction.options.getString('suggestion', true);
    const anonymous = interaction.options.getBoolean('anonymous') || false;

    const [configs] = await pool.execute(
        'SELECT * FROM suggestion_config WHERE guild_id = ?',
        [interaction.guild.id]
    );

    const config = configs[0];

    if (!config || !config.enabled) {
        await interaction.reply({
            content: 'Suggestions system is not enabled in this server. Ask an admin to set it up with `/engage suggest setup`.',
            ephemeral: true
        });
        return;
    }

    if (!config.suggestions_channel_id) {
        await interaction.reply({
            content: 'Suggestions channel is not configured. Ask an admin to set it up.',
            ephemeral: true
        });
        return;
    }

    if (anonymous && !config.allow_anonymous) {
        await interaction.reply({
            content: 'Anonymous suggestions are not allowed in this server.',
            ephemeral: true
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const manager = new SuggestionManager(interaction.client);

        const suggestionId = await manager.createSuggestion(
            interaction.guild.id,
            interaction.user.id,
            suggestion,
            anonymous,
            config
        );

        await manager.postSuggestion(
            interaction.guild,
            config.suggestions_channel_id,
            suggestionId,
            suggestion,
            interaction.user,
            anonymous,
            config.require_approval ? 'pending' : 'approved'
        );

        await interaction.editReply({
            content: `Your suggestion (#${suggestionId}) has been submitted successfully!${config.require_approval ? ' It will be reviewed by staff.' : ''}`
        });

    } catch (error) {
        logger.error('[Suggest] Submit error:', { error: error.message, stack: error.stack });
        await interaction.editReply({
            content: 'Failed to submit suggestion. Please try again later.'
        });
    }
}

export async function handleView(interaction) {
    const suggestionId = interaction.options.getInteger('id', true);

    const [suggestions] = await pool.execute(
        'SELECT * FROM suggestions WHERE id = ? AND guild_id = ?',
        [suggestionId, interaction.guild.id]
    );

    const suggestion = suggestions[0];

    if (!suggestion) {
        await interaction.reply({ content: 'Suggestion not found.', ephemeral: true });
        return;
    }

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
    const netVotes = Number(upvotes) - Number(downvotes);

    const manager = new SuggestionManager(interaction.client);

    const embed = new EmbedBuilder()
        .setColor(manager.getStatusColor(suggestion.status))
        .setTitle(`Suggestion #${suggestionId}`)
        .setDescription(suggestion.suggestion_text)
        .addFields(
            { name: 'Submitted By', value: suggestion.is_anonymous ? 'Anonymous' : `<@${suggestion.user_id}>`, inline: true },
            { name: 'Status', value: manager.getStatusDisplay(suggestion.status), inline: true },
            { name: 'Date', value: new Date(suggestion.created_at).toLocaleDateString(), inline: true },
            { name: 'Upvotes', value: `${upvotes}`, inline: true },
            { name: 'Downvotes', value: `${downvotes}`, inline: true },
            { name: 'Net Votes', value: `${netVotes}`, inline: true }
        );

    if (suggestion.staff_response) {
        embed.addFields({ name: 'Staff Response', value: suggestion.staff_response, inline: false });
    }

    if (suggestion.reviewed_by) {
        embed.addFields({ name: 'Reviewed By', value: `<@${suggestion.reviewed_by}>`, inline: true });
    }

    embed.setFooter({ text: `Suggestion ID: ${suggestionId}` });
    embed.setTimestamp(new Date(suggestion.created_at));

    await interaction.reply({ embeds: [embed] });
}

export async function handleList(interaction) {
    const status = interaction.options.getString('status');
    const user = interaction.options.getUser('user');

    let query = 'SELECT * FROM suggestions WHERE guild_id = ?';
    const params = [interaction.guild.id];

    if (status) {
        query += ' AND status = ?';
        params.push(status);
    }

    if (user) {
        query += ' AND user_id = ?';
        params.push(user.id);
    }

    query += ' ORDER BY created_at DESC LIMIT 10';

    const [suggestions] = await pool.execute(query, params);

    if (suggestions.length === 0) {
        await interaction.reply({
            content: 'No suggestions found matching your criteria.',
            ephemeral: true
        });
        return;
    }

    const manager = new SuggestionManager(interaction.client);

    const embed = new EmbedBuilder()
        .setColor('#3498db')
        .setTitle('Suggestions List')
        .setDescription(`Found ${suggestions.length} suggestion(s)`);

    for (const suggestion of suggestions) {
        const preview = suggestion.suggestion_text.length > 100
            ? suggestion.suggestion_text.substring(0, 100) + '...'
            : suggestion.suggestion_text;

        embed.addFields({
            name: `#${suggestion.id} - ${manager.getStatusDisplay(suggestion.status)}`,
            value: `${preview}\nBy: ${suggestion.is_anonymous ? 'Anonymous' : `<@${suggestion.user_id}>`} | \ud83d\udc4d ${suggestion.upvotes} \ud83d\udc4e ${suggestion.downvotes}`,
            inline: false
        });
    }

    embed.setFooter({ text: 'Use /engage suggest view <id> to see full details' });

    await interaction.reply({ embeds: [embed] });
}

export async function handleApprove(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
            content: 'You need Manage Server permission to approve suggestions.',
            ephemeral: true
        });
        return;
    }

    const suggestionId = interaction.options.getInteger('id', true);
    const response = interaction.options.getString('response');

    await interaction.deferReply();

    const [suggestions] = await pool.execute(
        'SELECT * FROM suggestions WHERE id = ? AND guild_id = ?',
        [suggestionId, interaction.guild.id]
    );

    const suggestion = suggestions[0];

    if (!suggestion) {
        await interaction.editReply({ content: 'Suggestion not found.' });
        return;
    }

    const manager = new SuggestionManager(interaction.client);

    await manager.updateStatus(suggestionId, 'approved', interaction.user.id, response);
    await manager.updateSuggestionEmbed(interaction.guild, suggestion, 'approved', response);

    if (!suggestion.is_anonymous) {
        await manager.notifyUser(
            interaction.client,
            suggestion.user_id,
            interaction.guild.name,
            suggestionId,
            suggestion.suggestion_text,
            'approved',
            response
        );
    }

    await interaction.editReply({ content: `Suggestion #${suggestionId} has been approved!` });
}

export async function handleReject(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
            content: 'You need Manage Server permission to reject suggestions.',
            ephemeral: true
        });
        return;
    }

    const suggestionId = interaction.options.getInteger('id', true);
    const reason = interaction.options.getString('reason', true);

    await interaction.deferReply();

    const [suggestions] = await pool.execute(
        'SELECT * FROM suggestions WHERE id = ? AND guild_id = ?',
        [suggestionId, interaction.guild.id]
    );

    const suggestion = suggestions[0];

    if (!suggestion) {
        await interaction.editReply({ content: 'Suggestion not found.' });
        return;
    }

    const manager = new SuggestionManager(interaction.client);

    await manager.updateStatus(suggestionId, 'rejected', interaction.user.id, reason);
    await manager.updateSuggestionEmbed(interaction.guild, suggestion, 'rejected', reason);

    if (!suggestion.is_anonymous) {
        await manager.notifyUser(
            interaction.client,
            suggestion.user_id,
            interaction.guild.name,
            suggestionId,
            suggestion.suggestion_text,
            'rejected',
            reason
        );
    }

    await interaction.editReply({ content: `Suggestion #${suggestionId} has been rejected.` });
}

export async function handleImplement(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
            content: 'You need Manage Server permission to mark suggestions as implemented.',
            ephemeral: true
        });
        return;
    }

    const suggestionId = interaction.options.getInteger('id', true);

    const [suggestions] = await pool.execute(
        'SELECT * FROM suggestions WHERE id = ? AND guild_id = ?',
        [suggestionId, interaction.guild.id]
    );

    const suggestion = suggestions[0];

    if (!suggestion) {
        await interaction.reply({ content: 'Suggestion not found.', ephemeral: true });
        return;
    }

    const manager = new SuggestionManager(interaction.client);

    await manager.updateStatus(suggestionId, 'implemented', interaction.user.id);
    await manager.updateSuggestionEmbed(interaction.guild, suggestion, 'implemented');

    if (!suggestion.is_anonymous) {
        await manager.notifyUser(
            interaction.client,
            suggestion.user_id,
            interaction.guild.name,
            suggestionId,
            suggestion.suggestion_text,
            'implemented'
        );
    }

    await interaction.reply({ content: `Suggestion #${suggestionId} has been marked as implemented!` });
}

export async function handleDuplicate(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
            content: 'You need Manage Server permission to mark suggestions as duplicate.',
            ephemeral: true
        });
        return;
    }

    const suggestionId = interaction.options.getInteger('id', true);
    const originalId = interaction.options.getInteger('original_id', true);

    const [suggestions] = await pool.execute(
        'SELECT * FROM suggestions WHERE id = ? AND guild_id = ?',
        [suggestionId, interaction.guild.id]
    );

    const suggestion = suggestions[0];

    if (!suggestion) {
        await interaction.reply({ content: 'Suggestion not found.', ephemeral: true });
        return;
    }

    const [originalSuggestions] = await pool.execute(
        'SELECT * FROM suggestions WHERE id = ? AND guild_id = ?',
        [originalId, interaction.guild.id]
    );

    if (originalSuggestions.length === 0) {
        await interaction.reply({
            content: `Original suggestion #${originalId} not found.`,
            ephemeral: true
        });
        return;
    }

    const manager = new SuggestionManager(interaction.client);
    const staffResponse = `Marked as duplicate of suggestion #${originalId}`;

    await manager.updateStatus(suggestionId, 'duplicate', interaction.user.id, staffResponse);
    await manager.updateSuggestionEmbed(interaction.guild, suggestion, 'duplicate', staffResponse);

    await interaction.reply({
        content: `Suggestion #${suggestionId} has been marked as a duplicate of #${originalId}.`
    });
}

export async function handleStats(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;

    const [stats] = await pool.execute(
        'SELECT * FROM user_suggestion_stats WHERE guild_id = ? AND user_id = ?',
        [interaction.guild.id, targetUser.id]
    );

    const userStats = stats[0];

    if (!userStats || userStats.total_suggestions === 0) {
        await interaction.reply({
            content: targetUser.id === interaction.user.id
                ? "You haven't submitted any suggestions yet!"
                : `${targetUser.username} hasn't submitted any suggestions yet.`,
            ephemeral: true
        });
        return;
    }

    const approvalRate = Math.round((userStats.approved_suggestions / userStats.total_suggestions) * 100);

    const embed = new EmbedBuilder()
        .setColor('#3498db')
        .setTitle(`Suggestion Statistics - ${targetUser.username}`)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
            { name: 'Total Suggestions', value: `${userStats.total_suggestions}`, inline: true },
            { name: 'Approved', value: `${userStats.approved_suggestions}`, inline: true },
            { name: 'Rejected', value: `${userStats.rejected_suggestions}`, inline: true },
            { name: 'Implemented', value: `${userStats.implemented_suggestions}`, inline: true },
            { name: 'Approval Rate', value: `${approvalRate}%`, inline: true },
            { name: 'Reputation', value: `${userStats.reputation_score}`, inline: true },
            { name: 'Total Upvotes', value: `${userStats.total_upvotes_received}`, inline: true },
            { name: 'Total Downvotes', value: `${userStats.total_downvotes_received}`, inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

export async function handleSetup(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
            content: 'You need Administrator permission to setup suggestions.',
            ephemeral: true
        });
        return;
    }

    const channel = interaction.options.getChannel('channel', true);
    const allowAnonymous = interaction.options.getBoolean('allow_anonymous') ?? true;
    const requireApproval = interaction.options.getBoolean('require_approval') ?? false;

    await pool.execute(
        `INSERT INTO suggestion_config (guild_id, suggestions_channel_id, enabled, allow_anonymous, require_approval)
         VALUES (?, ?, TRUE, ?, ?)
         ON DUPLICATE KEY UPDATE
             suggestions_channel_id = ?,
             enabled = TRUE,
             allow_anonymous = ?,
             require_approval = ?`,
        [interaction.guild.id, channel.id, allowAnonymous, requireApproval, channel.id, allowAnonymous, requireApproval]
    );

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('Suggestions System Configured')
        .setDescription('Suggestions system has been set up successfully!')
        .addFields(
            { name: 'Suggestions Channel', value: `${channel}`, inline: false },
            { name: 'Anonymous Allowed', value: allowAnonymous ? 'Yes' : 'No', inline: true },
            { name: 'Require Approval', value: requireApproval ? 'Yes' : 'No', inline: true },
            { name: 'Commands', value: '`/engage suggest submit` - Submit a suggestion\n`/engage suggest view <id>` - View a suggestion\n`/engage suggest list` - List suggestions\n`/engage suggest approve <id>` - Approve (Staff)\n`/engage suggest reject <id>` - Reject (Staff)\n`/engage suggest implement <id>` - Mark as implemented (Staff)\n`/engage suggest stats` - View statistics', inline: false }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}
