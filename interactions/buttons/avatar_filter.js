/*
 * `/avatarfilter cleanse mode:force` and `/avatarfilter import` — the confirm buttons. The pending entry
 * lives in the shared pending store of core/name-filters.js (rememberPending, kind 'avatar-cleanse' or
 * 'avatar-import') for 15 minutes; only the person who ran the command can press them.
 *
 *   avatarfilter_force:<token>   run a force avatar cleanse (core/avatar-protection.js startCleanse)
 *   avatarfilter_import:<token>  carry out a previewed import (the file is validated again as it is imported)
 *   avatarfilter_no:<token>      cancel
 */
import logger from '../../utils/logger.js';
import nf from '../../core/name-filters.js';
import ap from '../../core/avatar-protection.js';

const EPHEMERAL = { flags: 64 };

/** `avatarfilter_force:` */
export async function handleAvatarFilterForce(interaction) {
    const token = interaction.customId.split(':')[1];
    const entry = nf.peekPending(token);
    if (!entry || entry.kind !== 'avatar-cleanse' || entry.guildId !== interaction.guildId) {
        return interaction.update({ content: 'This has expired. Run the command again.', components: [] });
    }
    if (entry.actorId !== interaction.user.id) {
        return interaction.reply({ content: 'Only the person who ran the command can use these buttons.', ...EPHEMERAL });
    }
    nf.takePending(token);
    const out = ap.startCleanse(interaction.guild, { mode: 'force' }, interaction.user.id);
    return interaction.update({
        content: out.ok ? 'Force cleanse started. The result is posted to the server log and shown on the dashboard\'s Avatar Protection page.' : out.error,
        components: [],
    });
}

/** `avatarfilter_import:` — the same core/avatar-protection.js importProtected the dashboard uses. */
export async function handleAvatarFilterImport(interaction) {
    const token = interaction.customId.split(':')[1];
    const entry = nf.peekPending(token);
    if (!entry || entry.kind !== 'avatar-import' || entry.guildId !== interaction.guildId) {
        return interaction.update({ content: 'This has expired. Run the command again.', embeds: [], components: [] });
    }
    if (entry.actorId !== interaction.user.id) {
        return interaction.reply({ content: 'Only the person who ran the command can use these buttons.', ...EPHEMERAL });
    }
    nf.takePending(token);
    await interaction.update({ content: 'Importing…', components: [] });
    try {
        const out = await ap.importProtected(interaction.guild, entry.text, { apply: true }, interaction.user.id);
        if (!out.ok) return interaction.editReply({ content: out.error, embeds: [] });
        return interaction.editReply({
            content: `Imported ${out.added} image(s).${out.duplicates.length ? ` ${out.duplicates.length} already there.` : ''}`
                + `${out.rejected.length ? ` ${out.rejected.length} refused.` : ''}${out.overCap.length ? ` ${out.overCap.length} over the limit.` : ''}`
                + (out.added ? ' Members are being re-checked in the background; matches go to the review queue.' : ''),
            embeds: [],
        });
    } catch (err) {
        logger.error(`[AvatarProtection] import failed in ${interaction.guildId}: ${err.message}`);
        return interaction.editReply({ content: `Stopped part-way: ${err.message}`, embeds: [] });
    }
}

/** `avatarfilter_no:` */
export async function handleAvatarFilterCancel(interaction) {
    const token = interaction.customId.split(':')[1];
    const entry = nf.peekPending(token);
    if (entry && entry.actorId !== interaction.user.id) {
        return interaction.reply({ content: 'Only the person who ran the command can use these buttons.', ...EPHEMERAL });
    }
    nf.takePending(token);
    return interaction.update({ content: 'Cancelled. Nothing was changed and nobody was touched.', embeds: [], components: [] });
}
