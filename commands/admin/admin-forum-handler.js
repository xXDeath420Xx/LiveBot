/*
 * /admin forum — per-forum-channel rules.
 *
 * Writes the rows that core/forum-manager.js applies on thread creation. Before this existed,
 * `forum_config` had no writer and no reader: the table was unreachable from anywhere.
 *
 * One row per forum channel, so different forums in the same server can have different rules.
 */

import { EmbedBuilder, ChannelType } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { invalidate as invalidateForumCache } from '../../core/forum-manager.js';

const ARCHIVE_LABELS = { 60: '1 hour', 1440: '1 day', 4320: '3 days', 10080: '1 week' };

export async function handleForum(interaction, subcommand) {
    await interaction.deferReply({ ephemeral: true });

    switch (subcommand) {
        case 'setup':   return setup(interaction);
        case 'disable': return disable(interaction);
        case 'list':    return list(interaction);
        default:
            return interaction.editReply(`Unknown subcommand \`${subcommand}\``);
    }
}

async function setup(interaction) {
    const forum = interaction.options.getChannel('forum');
    if (forum.type !== ChannelType.GuildForum) {
        return interaction.editReply(`${forum} is not a forum channel.`);
    }

    const requireTag = interaction.options.getBoolean('require-tag');
    const slowmode = interaction.options.getInteger('slowmode');
    const autoArchive = interaction.options.getInteger('auto-archive');
    const lockOnArchive = interaction.options.getBoolean('lock-on-archive');
    // Distinguish "not supplied" from "supplied empty": the latter clears the reaction.
    const reactionGiven = interaction.options.get('reaction') !== null;
    const reaction = (interaction.options.getString('reaction') || '').trim();

    if (requireTag && !(forum.availableTags || []).length) {
        return interaction.editReply(
            `${forum} has no tags defined, so requiring a tag would delete every post. ` +
            'Add tags to the forum first (Edit Channel → Tags).'
        );
    }

    // Validate the emoji by using it, rather than by pattern-matching — a custom emoji from
    // another server looks perfectly well-formed and still fails at react() time.
    if (reactionGiven && reaction) {
        const probe = await forum.guild.channels.cache
            .find(c => c.isTextBased() && c.permissionsFor(forum.guild.members.me)?.has('SendMessages'));
        if (!probe) {
            // No channel to test in — accept it and let the manager log a warning if it fails.
            logger.debug('[Forum] No probe channel available to validate reaction emoji');
        }
    }

    // Read first so an unsupplied option keeps its current value instead of being nulled.
    const [existing] = await pool.execute(
        'SELECT * FROM forum_config WHERE forum_channel_id = ? LIMIT 1', [forum.id]
    );
    const prev = existing[0] || {};

    // A forum set up for the first time without the option takes the server-wide default from the
    // dashboard (Forum channels page, feature-config 'forums').
    let lockDefault = 0;
    if (!existing.length && lockOnArchive === null) {
        try {
            const { getConfig } = await import('../../core/feature-config.js');
            const d = await getConfig('forums', interaction.guild.id);
            lockDefault = d && (d.auto_lock_on_archive === true || d.auto_lock_on_archive === 1 || d.auto_lock_on_archive === '1') ? 1 : 0;
        } catch { /* no defaults saved: off */ }
    }

    const row = {
        require_tag: requireTag ?? prev.require_tag ?? 0,
        default_slowmode: slowmode ?? prev.default_slowmode ?? 0,
        default_auto_archive: autoArchive ?? prev.default_auto_archive ?? 0,
        auto_lock_on_archive: lockOnArchive ?? prev.auto_lock_on_archive ?? lockDefault,
        default_reaction_emoji: reactionGiven ? (reaction || null) : (prev.default_reaction_emoji ?? null),
    };

    try {
        if (existing.length) {
            await pool.execute(
                `UPDATE forum_config SET require_tag = ?, default_slowmode = ?, default_auto_archive = ?,
                        auto_lock_on_archive = ?, default_reaction_emoji = ?, auto_create_enabled = 1
                  WHERE forum_channel_id = ?`,
                [row.require_tag ? 1 : 0, row.default_slowmode, row.default_auto_archive,
                 row.auto_lock_on_archive ? 1 : 0, row.default_reaction_emoji, forum.id]
            );
        } else {
            await pool.execute(
                `INSERT INTO forum_config
                    (guild_id, forum_channel_id, auto_create_enabled, require_tag, default_slowmode,
                     default_auto_archive, auto_lock_on_archive, default_reaction_emoji)
                 VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
                [interaction.guild.id, forum.id, row.require_tag ? 1 : 0, row.default_slowmode,
                 row.default_auto_archive, row.auto_lock_on_archive ? 1 : 0, row.default_reaction_emoji]
            );
        }
    } catch (err) {
        logger.error('[Forum] Could not save config', { error: err.message, forumId: forum.id });
        return interaction.editReply(`Could not save those rules: ${err.message}`);
    }

    invalidateForumCache(forum.id);

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`Forum rules set for #${forum.name}`)
        .setDescription('These apply to every new post from now on. Existing posts are untouched.')
        .addFields(
            { name: 'Tag required', value: row.require_tag ? 'Yes — untagged posts are removed' : 'No', inline: true },
            { name: 'Slowmode', value: row.default_slowmode ? `${row.default_slowmode}s` : 'None', inline: true },
            { name: 'Auto-archive', value: ARCHIVE_LABELS[row.default_auto_archive] || 'Discord default', inline: true },
            { name: 'Lock on archive', value: row.auto_lock_on_archive ? 'Yes' : 'No', inline: true },
            { name: 'Default reaction', value: row.default_reaction_emoji || 'None', inline: true },
        )
        .setFooter({ text: 'Manage every forum on the dashboard: Forum Channels' });

    return interaction.editReply({ embeds: [embed] });
}

async function disable(interaction) {
    const forum = interaction.options.getChannel('forum');
    const [r] = await pool.execute('DELETE FROM forum_config WHERE forum_channel_id = ? AND guild_id = ?',
        [forum.id, interaction.guild.id]);
    invalidateForumCache(forum.id);
    return interaction.editReply(
        r.affectedRows
            ? `Rules removed for ${forum}. New posts there are no longer touched.`
            : `${forum} had no rules configured.`
    );
}

async function list(interaction) {
    const [rows] = await pool.execute(
        'SELECT * FROM forum_config WHERE guild_id = ? ORDER BY id', [interaction.guild.id]
    );
    if (!rows.length) {
        return interaction.editReply(
            'No forum rules configured. Set some with `/admin forum setup forum:#your-forum`.'
        );
    }

    const lines = rows.map(r => {
        const bits = [];
        if (r.require_tag) bits.push('tag required');
        if (r.default_slowmode) bits.push(`${r.default_slowmode}s slowmode`);
        if (r.default_auto_archive) bits.push(`archive after ${ARCHIVE_LABELS[r.default_auto_archive] || r.default_auto_archive + 'm'}`);
        if (r.auto_lock_on_archive) bits.push('lock on archive');
        if (r.default_reaction_emoji) bits.push(`reacts ${r.default_reaction_emoji}`);
        return `<#${r.forum_channel_id}> — ${bits.length ? bits.join(', ') : 'no rules set'}`;
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`Forum rules — ${rows.length}`)
        .setDescription(lines.join('\n').slice(0, 4000));

    return interaction.editReply({ embeds: [embed] });
}

export default { handleForum };
