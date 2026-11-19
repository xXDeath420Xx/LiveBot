/**
 * "Highlight Message" context-menu command. Mods right-click a message in Discord
 * → Apps → Highlight Message. The bot re-posts a cleaned embed to the server's
 * configured highlight channel + records a row so the dashboard can list them.
 *
 * De-dup: one message can only be highlighted once per guild (UNIQUE key on
 * source_message_id). Re-use returns a "already highlighted" ephemeral reply.
 *
 * Config: set the destination channel via `/moderation highlight channel #name` (see
 * commands/community/highlight.js) OR via Dashboard → Logging later.
 */
import { ApplicationCommandType, ContextMenuCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const data = new ContextMenuCommandBuilder()
    .setName('Highlight Message')
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false);

async function execute(interaction) {
    const target = interaction.targetMessage;
    const guild  = interaction.guild;
    if (!guild || !target) {
        return interaction.reply({ content: 'This can only be used on a server message.', ephemeral: true });
    }

    // 1. Resolve the destination highlight channel.
    const [[cfg]] = await pool.execute(
        'SELECT highlight_channel_id FROM guild_settings WHERE guild_id = ?', [guild.id]);
    const dest = cfg?.highlight_channel_id ? guild.channels.cache.get(cfg.highlight_channel_id) : null;
    if (!dest) {
        return interaction.reply({
            content: 'No highlight channel set. An admin runs `/moderation highlight channel #name` first.',
            ephemeral: true,
        });
    }

    // 2. De-dup: already highlighted?
    const [[existing]] = await pool.execute(
        'SELECT feed_message_id, feed_channel_id FROM message_highlights WHERE guild_id = ? AND source_message_id = ?',
        [guild.id, target.id]);
    if (existing) {
        const link = existing.feed_message_id && existing.feed_channel_id
            ? `https://discord.com/channels/${guild.id}/${existing.feed_channel_id}/${existing.feed_message_id}`
            : null;
        return interaction.reply({
            content: `This message is already highlighted${link ? ` — ${link}` : '.'}`,
            ephemeral: true,
        });
    }

    // 3. Compose + post the highlight embed.
    const content = target.content?.slice(0, 2000) || '*(no text — see attachments)*';
    const attachmentUrls = target.attachments.map(a => a.url);
    const embed = new EmbedBuilder()
        .setColor(0xE2B23A)
        .setAuthor({
            name: target.author?.tag || 'Unknown',
            iconURL: target.author?.displayAvatarURL?.({ size: 64 }) || null,
        })
        .setDescription(content)
        .addFields(
            { name: 'Channel',     value: `<#${target.channelId}>`,                       inline: true },
            { name: 'Highlighted', value: `<@${interaction.user.id}>`,                    inline: true },
            { name: 'Jump',        value: `[Original message](${target.url})`,            inline: true },
        )
        .setTimestamp(target.createdAt);
    if (attachmentUrls[0] && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(attachmentUrls[0])) {
        embed.setImage(attachmentUrls[0]);
    }

    let posted;
    try {
        posted = await dest.send({ embeds: [embed] });
    } catch (err) {
        logger.warn(`[Highlights] post failed in ${guild.id}: ${err.message}`);
        return interaction.reply({ content: `Could not post to ${dest} — ${err.message}`, ephemeral: true });
    }

    // 4. Record the row (idempotent via UNIQUE key — if a race lost, we still succeeded).
    try {
        await pool.execute(
            `INSERT INTO message_highlights
              (guild_id, source_channel_id, source_message_id, author_id, author_tag,
               content_snapshot, attachment_urls, pinned_by_user_id, feed_message_id, feed_channel_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE feed_message_id = VALUES(feed_message_id), feed_channel_id = VALUES(feed_channel_id)`,
            [guild.id, target.channelId, target.id,
             target.author?.id || '0', target.author?.tag || null,
             content, JSON.stringify(attachmentUrls),
             interaction.user.id, posted.id, posted.channelId]);
    } catch (err) {
        logger.warn(`[Highlights] record failed in ${guild.id}: ${err.message}`);
    }

    return interaction.reply({ content: `Highlighted to ${dest}.`, ephemeral: true });
}

export { data, execute };
export default { category: 'context', data, execute };
