/*
 * Message threats — the Ban / Dismiss buttons on flagged-message and review-alert cards
 * (core/message-threats.js postCard). The member waits in name_filter_reviews (kind 'message'); the same
 * decision is on the dashboard's Message Threats page.
 *
 *   mthreat_ban:<userId>   ban (deletes their last hour of messages) — needs Ban Members
 *   mthreat_ok:<userId>    dismiss — needs a moderation permission or a bot-manager role
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { decideReviews } from '../../core/message-threats.js';
import { isManager } from '../../core/protection-exempt.js';

const EPHEMERAL = { flags: 64 };
const MOD_PERMS = [
    PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages,
];

export async function handleMessageThreatButton(interaction) {
    const [prefix, userId] = interaction.customId.split(':');
    if (!interaction.guild || !/^\d{15,25}$/.test(userId || '')) {
        return interaction.reply({ content: 'This card is no longer valid.', ...EPHEMERAL });
    }
    const member = interaction.member;
    const ban = prefix === 'mthreat_ban';
    const owner = interaction.guild.ownerId === interaction.user.id;
    if (ban && !owner && !member?.permissions?.has(PermissionFlagsBits.BanMembers)) {
        return interaction.reply({ content: 'You need the Ban Members permission to ban from this card.', ...EPHEMERAL });
    }
    if (!ban && !owner && !MOD_PERMS.some(p => member?.permissions?.has(p)) && !(await isManager(member))) {
        return interaction.reply({ content: 'You need a moderation permission (or a bot-manager role) to dismiss this.', ...EPHEMERAL });
    }
    await interaction.deferReply(EPHEMERAL);
    const out = await decideReviews(interaction.guild, [userId], ban ? 'ban' : 'dismiss', interaction.user.id);
    if (out.failed.length) return interaction.editReply(`Could not ban <@${userId}>: ${out.failed[0].why}`);

    const original = interaction.message?.embeds?.[0];
    if (original) {
        const embed = EmbedBuilder.from(original)
            .setColor(ban ? 0xC0392B : 0x57F287)
            .setFooter({ text: `${ban ? 'Banned' : 'Dismissed'} by ${interaction.user.tag}${original.footer?.text ? ` | ${original.footer.text}` : ''}`.slice(0, 2048) });
        await interaction.message.edit({ embeds: [embed], components: [] }).catch(() => {});
    }
    return interaction.editReply(ban ? `Banned <@${userId}> and deleted their last hour of messages.` : 'Dismissed. No action was taken against them.');
}

export default { handleMessageThreatButton };
