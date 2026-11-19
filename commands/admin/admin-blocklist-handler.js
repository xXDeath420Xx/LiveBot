/**
 * /admin blocklist — operator control of the scam-image blocklist.
 *
 * This exists because the blocklist used to be three files on disk named in an array in
 * core/image-blocklist.js. Blocking a newly-seen scam image meant committing a binary and editing
 * source, so in practice the list had not changed since 2026-07-04 while the campaign kept rotating
 * its artwork — images reported by staff were only ever blocked if someone remembered to check one
 * in. Staff can now do it from the message itself.
 *
 * `add` takes a message LINK rather than an upload, because the image worth blocking is one that a
 * spammer has just posted. The scam message is usually deleted moments later, and Discord purges
 * the CDN when it goes, so the fingerprint has to be taken while the message still exists.
 */
import { EmbedBuilder, PermissionsBitField } from 'discord.js';
import { addBlockedImage, listBlockedImages, removeBlockedImage } from '../../core/image-blocklist.js';
import { themeColor } from '../../core/guild-theme.js';
import logger from '../../utils/logger.js';

const MESSAGE_LINK = /channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})/;

function requireAdmin(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        interaction.reply({ content: 'This command requires Administrator permission.', ephemeral: true });
        return false;
    }
    return true;
}

export async function handleAdd(interaction) {
    if (!requireAdmin(interaction)) return;
    await interaction.deferReply({ ephemeral: true });

    const link = interaction.options.getString('message', true).trim();
    const label = interaction.options.getString('label') || null;

    const parts = MESSAGE_LINK.exec(link);
    if (!parts) {
        return interaction.editReply(
            'That does not look like a message link. Right-click the scam message → **Copy Message Link** and paste it here.'
        );
    }
    const [, guildId, channelId, messageId] = parts;
    if (guildId !== interaction.guildId) {
        return interaction.editReply('That message is in a different server. You can only block images from this one.');
    }

    let message;
    try {
        const channel = await interaction.guild.channels.fetch(channelId);
        message = await channel.messages.fetch(messageId);
    } catch {
        return interaction.editReply(
            'I could not read that message — it may already be deleted, or I may not have access to that channel.\n'
            + 'Discord removes the image from its CDN as soon as the message goes, so the blocklist entry has to be taken '
            + 'while the message still exists.'
        );
    }

    const images = [...message.attachments.values()].filter(a => a.contentType?.startsWith('image/'));
    if (!images.length) return interaction.editReply('That message has no image attachments on it.');

    const added = [];
    const skipped = [];
    for (const att of images.slice(0, 4)) {
        const result = await addBlockedImage({
            guildId: interaction.guildId,
            url: att.url,
            label: label || `${att.name} (via ${interaction.user.tag})`,
            addedBy: interaction.user.id,
        });
        if (result.ok) added.push(`\`${att.name}\` — ${result.bitsSet}/64 bits of detail`);
        else skipped.push(`\`${att.name}\` — ${result.reason}`);
    }

    logger.info('[Blocklist] operator updated the scam-image blocklist', {
        guildId: interaction.guildId, userId: interaction.user.id,
        added: added.length, skipped: skipped.length, source: link,
    });

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, added.length ? 'success' : 'warning'))
        .setTitle(added.length ? 'Added to the scam-image blocklist' : 'Nothing was added')
        .setFooter({ text: 'Re-posts of these images are deleted on sight. 3 channels in 2 hours bans the poster.' });

    if (added.length) embed.addFields({ name: `Blocked (${added.length})`, value: added.join('\n').slice(0, 1024) });
    if (skipped.length) embed.addFields({ name: `Skipped (${skipped.length})`, value: skipped.join('\n').slice(0, 1024) });

    return interaction.editReply({ embeds: [embed] });
}

export async function handleList(interaction) {
    if (!requireAdmin(interaction)) return;
    await interaction.deferReply({ ephemeral: true });

    const rows = await listBlockedImages(interaction.guildId);
    if (!rows.length) return interaction.editReply('The blocklist is empty.');

    const fmt = r => `\`${String(r.id).padStart(3)}\` ${r.guild_id === '0' ? '[global] ' : ''}${r.label || '(no label)'}`;
    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle(`Scam-image blocklist — ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`)
        .setDescription(rows.map(fmt).join('\n').slice(0, 4000))
        .setFooter({ text: 'Global entries are shared with every server and cannot be removed here.' });

    return interaction.editReply({ embeds: [embed] });
}

export async function handleRemove(interaction) {
    if (!requireAdmin(interaction)) return;
    await interaction.deferReply({ ephemeral: true });

    const id = interaction.options.getInteger('id', true);
    const removed = await removeBlockedImage(id, interaction.guildId);
    if (!removed) {
        return interaction.editReply(
            `No entry \`${id}\` belonging to this server. Global entries (marked \`[global]\` in \`/admin blocklist list\`) `
            + 'are shared across every server and are not removable from here.'
        );
    }
    logger.info('[Blocklist] entry removed', { guildId: interaction.guildId, userId: interaction.user.id, entryId: id });
    return interaction.editReply(`Removed blocklist entry \`${id}\`.`);
}
