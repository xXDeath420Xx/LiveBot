import {
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
    PermissionFlagsBits,
} from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import configCache from '../../utils/configCache.js';

/**
 * May this member start a giveaway from the panel?
 *
 * Roles configured in `giveaway_host_roles` are the gate. Manage Server always
 * passes so an admin can never lock themselves out of their own panel. With no
 * roles configured we fall back to Manage Messages, which is the usual mod bar.
 */
export async function memberMayHostGiveaways(member) {
    if (!member) return false;
    if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;

    const roleIds = await configCache.get('giveaway_host_roles', member.guild.id, async () => {
        const [rows] = await pool.execute(
            'SELECT role_id FROM giveaway_host_roles WHERE guild_id = ?',
            [member.guild.id]
        );
        return rows.map(r => r.role_id);
    });

    if (!roleIds || roleIds.length === 0) {
        return member.permissions.has(PermissionFlagsBits.ManageMessages);
    }
    return roleIds.some(id => member.roles.cache.has(id));
}

export async function handleGiveawayCreateButton(interaction) {
    try {
        if (!await memberMayHostGiveaways(interaction.member)) {
            return interaction.reply({
                content: "You don't have permission to start giveaways here. Ask a moderator or admin to run it.",
                ephemeral: true,
            });
        }

        const modal = new ModalBuilder()
            .setCustomId('giveaway_create_modal')
            .setTitle('Start a giveaway')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('prize')
                        .setLabel('Prize')
                        .setPlaceholder('Nitro, a game key, a shoutout…')
                        .setStyle(TextInputStyle.Short)
                        .setMinLength(1).setMaxLength(256)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('winners')
                        .setLabel('Number of winners')
                        .setPlaceholder('1')
                        .setValue('1')
                        .setStyle(TextInputStyle.Short)
                        .setMaxLength(3)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('duration')
                        .setLabel('How long? (e.g. 30m, 12h, 3d, 1w)')
                        .setPlaceholder('24h')
                        .setStyle(TextInputStyle.Short)
                        .setMinLength(2).setMaxLength(32)
                        .setRequired(true)
                ),
            );

        await interaction.showModal(modal);
    } catch (err) {
        logger.error('[giveaway_create] error', { err: err.message, stack: err.stack });
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'Something went wrong opening the giveaway form.', ephemeral: true }).catch(() => {});
        }
    }
}

export default handleGiveawayCreateButton;
