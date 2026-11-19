/*
 * Right-click a user → Apps → User Info.
 *
 * The first context-menu command in the codebase. It loads through the same
 * `commands/<folder>/*.js` path as slash commands because `ContextMenuCommandBuilder` exposes
 * the same `data.name` / `data.toJSON()` shape the loader and the deploy scripts already use.
 * Dispatch happens in events/interactionCreate.js, alongside chat-input commands.
 *
 * Deliberately read-only and ephemeral: a right-click action that posts publicly or changes
 * something is far too easy to trigger by accident.
 */

import {
    ContextMenuCommandBuilder,
    ApplicationCommandType,
    ApplicationIntegrationType,
    InteractionContextType,
    EmbedBuilder,
} from 'discord.js';
import { themeColor } from '../../core/guild-theme.js';

export default {
    category: 'context',
    data: new ContextMenuCommandBuilder()
        .setName('User Info')
        .setType(ApplicationCommandType.User)
        // User-install enabled: right-click any user in any server (or in a
        // group DM) → Apps → User Info works even when CertiFried isn't present.
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const user = interaction.targetUser;
        const member = interaction.targetMember
            ?? await interaction.guild?.members.fetch(user.id).catch(() => null);

        const embed = new EmbedBuilder()
            .setColor(await themeColor(interaction.guild?.id).catch(() => 0x5865F2))
            .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ dynamic: true }) })
            .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
            .addFields(
                { name: 'User', value: `${user}`, inline: true },
                { name: 'ID', value: `\`${user.id}\``, inline: true },
                { name: 'Bot', value: user.bot ? 'Yes' : 'No', inline: true },
                {
                    name: 'Account created',
                    value: `<t:${Math.floor(user.createdTimestamp / 1000)}:D> (<t:${Math.floor(user.createdTimestamp / 1000)}:R>)`,
                    inline: false,
                },
            );

        if (member) {
            if (member.joinedTimestamp) {
                embed.addFields({
                    name: 'Joined server',
                    value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:D> (<t:${Math.floor(member.joinedTimestamp / 1000)}:R>)`,
                    inline: false,
                });
            }

            const roles = member.roles.cache
                .filter(r => r.id !== interaction.guild.id)
                .sort((a, b) => b.position - a.position)
                .map(r => `${r}`);

            if (roles.length) {
                // Embed fields cap at 1024 characters; a member with many roles overflows it.
                let value = '';
                let shown = 0;
                for (const r of roles) {
                    if (value.length + r.length + 2 > 980) break;
                    value += (value ? ', ' : '') + r;
                    shown++;
                }
                if (shown < roles.length) value += ` … +${roles.length - shown} more`;
                embed.addFields({ name: `Roles (${roles.length})`, value, inline: false });
            }

            if (member.premiumSinceTimestamp) {
                embed.addFields({
                    name: 'Boosting since',
                    value: `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:R>`,
                    inline: true,
                });
            }
        }

        await interaction.editReply({ embeds: [embed] });
    },
};
