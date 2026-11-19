import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import SuggestionManager from '../../core/suggestion-manager.js';
import { themeColor } from '../../core/guild-theme.js';
import {
    TagError, listTags, findTag, createTag, updateTag, deleteTag, assignTag, unassignTag,
    getTagsForSuggestion, getTagsForSuggestions,
} from '../../core/suggestion-tags.js';
import { formatTagList } from '../../core/suggestion-tag-helpers.js';
import {
    submitSuggestion, approveSuggestion, rejectSuggestion, isSuggestionStaff as isStaffFor, getSuggestionConfig,
} from '../../core/suggestion-review.js';

const STAFF_ONLY = 'You need **Manage Server** or the suggestions staff role to do that.';

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
        // With approval required it waits for staff (review card in the staff review channel) and is
        // only posted for voting once approved (core/suggestion-review.js).
        const { id: suggestionId, held } = await submitSuggestion({
            client: interaction.client,
            guild: interaction.guild,
            user: interaction.user,
            text: suggestion,
            anonymous,
            config,
        });

        await interaction.editReply({
            content: held
                ? `Your suggestion (#${suggestionId}) was sent to staff. It will be posted for voting once they approve it.`
                : `Your suggestion (#${suggestionId}) has been posted for voting.`
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

    const tags = await getTagsForSuggestion(suggestionId).catch((err) => {
        logger.warn('[Suggest] Could not load tags', { suggestionId, error: err.message });
        return [];
    });
    if (tags.length) {
        embed.addFields({ name: 'Tags', value: formatTagList(tags), inline: false });
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
    const tagInput = interaction.options.getString('tag');

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

    let tag = null;
    if (tagInput) {
        tag = await findTag(interaction.guild.id, tagInput);
        if (!tag) {
            await interaction.reply({ content: `No suggestion tag called **${tagInput}** in this server.`, ephemeral: true });
            return;
        }
        query += ' AND EXISTS (SELECT 1 FROM suggestion_tag_assignments a WHERE a.suggestion_id = suggestions.id AND a.tag_id = ?)';
        params.push(tag.id);
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

    const tagMap = await getTagsForSuggestions(suggestions.map(s => s.id)).catch((err) => {
        logger.warn('[Suggest] Could not load tags for list', { error: err.message });
        return new Map();
    });

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle(tag ? `Suggestions tagged ${tag.tag_name}` : 'Suggestions List')
        .setDescription(`Found ${suggestions.length} suggestion(s)`);

    for (const suggestion of suggestions) {
        const preview = suggestion.suggestion_text.length > 100
            ? suggestion.suggestion_text.substring(0, 100) + '...'
            : suggestion.suggestion_text;
        const rowTags = tagMap.get(Number(suggestion.id)) || [];

        embed.addFields({
            name: `#${suggestion.id} - ${manager.getStatusDisplay(suggestion.status)}`,
            value: `${preview}\nBy: ${suggestion.is_anonymous ? 'Anonymous' : `<@${suggestion.user_id}>`} | \ud83d\udc4d ${suggestion.upvotes} \ud83d\udc4e ${suggestion.downvotes}`
                + (rowTags.length ? `\nTags: ${formatTagList(rowTags)}` : ''),
            inline: false
        });
    }

    embed.setFooter({ text: 'Use /engage suggest view <id> to see full details' });

    await interaction.reply({ embeds: [embed] });
}

export async function handleApprove(interaction) {
    const config = await getSuggestionConfig(interaction.guild.id);
    if (!isStaffFor(interaction.member, config)) {
        await interaction.reply({ content: STAFF_ONLY, ephemeral: true });
        return;
    }

    const suggestionId = interaction.options.getInteger('id', true);
    const response = interaction.options.getString('response');

    await interaction.deferReply();

    // A held suggestion is posted for voting now.
    const result = await approveSuggestion({
        client: interaction.client, guild: interaction.guild, suggestionId, reviewerId: interaction.user.id, response,
    });
    await interaction.editReply({
        content: result.ok
            ? `Suggestion #${suggestionId} has been approved${result.posted ? ' and posted for voting' : ''}.`
            : result.error
    });
}

export async function handleReject(interaction) {
    const config = await getSuggestionConfig(interaction.guild.id);
    if (!isStaffFor(interaction.member, config)) {
        await interaction.reply({ content: STAFF_ONLY, ephemeral: true });
        return;
    }

    const suggestionId = interaction.options.getInteger('id', true);
    const reason = interaction.options.getString('reason', true);

    await interaction.deferReply();

    const result = await rejectSuggestion({
        client: interaction.client, guild: interaction.guild, suggestionId, reviewerId: interaction.user.id, reason,
    });
    await interaction.editReply({ content: result.ok ? `Suggestion #${suggestionId} has been rejected.` : result.error });
}

export async function handleImplement(interaction) {
    if (!isStaffFor(interaction.member, await getSuggestionConfig(interaction.guild.id))) {
        await interaction.reply({ content: STAFF_ONLY, ephemeral: true });
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
    if (!isStaffFor(interaction.member, await getSuggestionConfig(interaction.guild.id))) {
        await interaction.reply({ content: STAFF_ONLY, ephemeral: true });
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
        .setColor(themeColor(interaction.guildId, 'primary'))
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
    // Options left out keep what is saved (a dashboard choice, say). A new server gets the
    // old defaults: anonymous allowed, approval not required.
    const anonChoice = interaction.options.getBoolean('allow_anonymous');
    const approvalChoice = interaction.options.getBoolean('require_approval');

    await pool.execute(
        `INSERT INTO suggestion_config (guild_id, suggestions_channel_id, enabled, allow_anonymous, require_approval)
         VALUES (?, ?, TRUE, ?, ?)
         ON DUPLICATE KEY UPDATE
             suggestions_channel_id = VALUES(suggestions_channel_id),
             enabled = TRUE,
             allow_anonymous = IF(?, allow_anonymous, VALUES(allow_anonymous)),
             require_approval = IF(?, require_approval, VALUES(require_approval))`,
        [interaction.guild.id, channel.id, anonChoice ?? true, approvalChoice ?? false,
         anonChoice === null ? 1 : 0, approvalChoice === null ? 1 : 0]
    );
    const saved = await getSuggestionConfig(interaction.guild.id);
    const allowAnonymous = Boolean(Number(saved?.allow_anonymous));
    const requireApproval = Boolean(Number(saved?.require_approval));

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'success'))
        .setTitle('Suggestions System Configured')
        .setDescription('Suggestions system has been set up successfully!')
        .addFields(
            { name: 'Suggestions Channel', value: `${channel}`, inline: false },
            { name: 'Anonymous Allowed', value: allowAnonymous ? 'Yes' : 'No', inline: true },
            { name: 'Require Approval', value: requireApproval ? 'Yes' : 'No', inline: true },
            { name: 'Commands', value: '`/engage suggest submit` - Submit a suggestion\n`/engage suggest view <id>` - View a suggestion\n`/engage suggest list` - List suggestions\n`/engage suggest approve <id>` - Approve (Staff)\n`/engage suggest reject <id>` - Reject (Staff)\n`/engage suggest implement <id>` - Mark as implemented (Staff)\n`/engage suggest stats` - View statistics', inline: false },
            ...(requireApproval ? [{ name: 'Approval', value: saved?.staff_review_channel_id
                ? `New suggestions wait in <#${saved.staff_review_channel_id}> with Approve and Reject buttons, and are posted here once approved.`
                : 'New suggestions wait for staff and are posted here once approved. Set a staff review channel on the dashboard to get Approve and Reject buttons there.', inline: false }] : [])
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

// ── Tags ────────────────────────────────────────────────────────────────────────────────────

/** Staff = Manage Server, or the suggestions staff role (suggestion_config.approved_role_id). */
async function isSuggestionStaff(interaction) {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    const [rows] = await pool.execute('SELECT approved_role_id FROM suggestion_config WHERE guild_id = ?', [interaction.guild.id]);
    const roleId = rows[0]?.approved_role_id;
    return !!roleId && !!interaction.member?.roles?.cache?.has(roleId);
}

/** Re-render the Tags field on suggestion messages; best effort, never blocks the reply. */
function refreshEmbeds(interaction, suggestionIds) {
    const manager = new SuggestionManager(interaction.client);
    const ids = [...new Set(suggestionIds)].slice(0, 25);
    (async () => {
        for (const id of ids) await manager.refreshTags(interaction.guild, id);
    })().catch((err) => logger.warn('[Suggest] Tag refresh failed', { guildId: interaction.guildId, error: err.message }));
}

/** /engage suggest tag id:<n> tag:<name> [remove] — staff tag or untag a suggestion. */
export async function handleTag(interaction) {
    if (!(await isSuggestionStaff(interaction))) {
        await interaction.reply({ content: 'You need **Manage Server** or the suggestions staff role to tag suggestions.', ephemeral: true });
        return;
    }

    const suggestionId = interaction.options.getInteger('id', true);
    const tagInput = interaction.options.getString('tag', true);
    const remove = interaction.options.getBoolean('remove') || false;

    const tag = await findTag(interaction.guild.id, tagInput);
    if (!tag) {
        await interaction.reply({
            content: `No tag called **${tagInput}**. Admins can create one with \`/engage suggest tags action:Create\`.`,
            ephemeral: true
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });
    let changed;
    try {
        changed = remove
            ? await unassignTag(interaction.guild.id, suggestionId, tag.id)
            : await assignTag(interaction.guild.id, suggestionId, tag.id, interaction.user.id);
    } catch (err) {
        if (err instanceof TagError) {
            await interaction.editReply({ content: err.message });
            return;
        }
        throw err;
    }

    if (changed) refreshEmbeds(interaction, [suggestionId]);
    const label = formatTagList([tag]);
    let content;
    if (remove) {
        content = changed ? `Removed **${label}** from suggestion #${suggestionId}.` : `Suggestion #${suggestionId} was not tagged **${label}**.`;
    } else {
        content = changed ? `Tagged suggestion #${suggestionId} as **${label}**.` : `Suggestion #${suggestionId} already has **${label}**.`;
    }
    await interaction.editReply({ content });
}

/** /engage suggest tags action:<create|edit|delete|list> — manage the server's tag list. */
export async function handleTags(interaction) {
    const action = interaction.options.getString('action', true);

    if (action === 'list') {
        const tags = await listTags(interaction.guild.id);
        if (!tags.length) {
            await interaction.reply({ content: 'No suggestion tags yet. Admins can add one with `/engage suggest tags action:Create name:<tag>`.', ephemeral: true });
            return;
        }
        const lines = tags.map(t => `${t.tag_emoji ? `${t.tag_emoji} ` : ''}**${t.tag_name}** \`${t.tag_color || '#3498db'}\` — ${t.usage_count} suggestion(s)`);
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle('Suggestion tags')
            .setDescription(lines.join('\n').slice(0, 4000))
            .setFooter({ text: 'Filter with /engage suggest list tag:<name>' });
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: 'You need **Manage Server** permission to manage suggestion tags.', ephemeral: true });
        return;
    }

    const name = interaction.options.getString('name');
    const color = interaction.options.getString('color');
    const emoji = interaction.options.getString('emoji');
    const rename = interaction.options.getString('rename');
    if (!name) {
        await interaction.reply({ content: 'Give the tag **name**.', ephemeral: true });
        return;
    }

    try {
        if (action === 'create') {
            const tag = await createTag(interaction.guild.id, { name, color, emoji }, interaction.user.id);
            await interaction.reply({ content: `Created tag **${formatTagList([tag])}**. Staff can apply it with \`/engage suggest tag\`.`, ephemeral: true });
            return;
        }

        const tag = await findTag(interaction.guild.id, name);
        if (!tag) {
            await interaction.reply({ content: `No tag called **${name}**.`, ephemeral: true });
            return;
        }

        if (action === 'edit') {
            const affected = await updateTag(interaction.guild.id, tag.id, { name: rename, color, emoji: emoji ?? undefined });
            refreshEmbeds(interaction, affected);
            await interaction.reply({ content: `Tag **${tag.tag_name}** updated.`, ephemeral: true });
            return;
        }

        if (action === 'delete') {
            const affected = await deleteTag(interaction.guild.id, tag.id);
            refreshEmbeds(interaction, affected);
            await interaction.reply({ content: `Deleted tag **${tag.tag_name}** (removed from ${affected.length} suggestion(s)).`, ephemeral: true });
            return;
        }
    } catch (err) {
        if (err instanceof TagError) {
            await interaction.reply({ content: err.message, ephemeral: true });
            return;
        }
        throw err;
    }

    await interaction.reply({ content: 'Unknown action.', ephemeral: true });
}

/** Autocomplete for the `tag` / `name` options of the suggest group. */
export async function handleSuggestAutocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (!['tag', 'name'].includes(focused.name) || !interaction.guild) {
        await interaction.respond([]).catch(() => {});
        return;
    }
    const q = String(focused.value || '').toLowerCase();
    const tags = await listTags(interaction.guild.id).catch((err) => {
        logger.warn('[Suggest] Tag autocomplete failed', { guildId: interaction.guildId, error: err.message });
        return [];
    });
    const choices = tags
        .filter(t => t.tag_name.toLowerCase().includes(q))
        .slice(0, 25)
        .map(t => ({ name: `${t.tag_emoji ? `${t.tag_emoji} ` : ''}${t.tag_name}`.slice(0, 100), value: t.tag_name }));
    await interaction.respond(choices).catch(() => {});
}
