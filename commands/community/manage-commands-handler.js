import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { invalidateCommandCache } from '../../core/custom-command-handler.js';

export async function handleCreate(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const name = interaction.options.getString('name').toLowerCase();
    const actionType = interaction.options.getString('action-type');
    const actionContent = interaction.options.getString('response-or-role-id');
    const requiredRoles = interaction.options.getString('required-roles')?.split(',').map(id => id.trim());
    const allowedChannels = interaction.options.getString('allowed-channels')?.split(',').map(id => id.trim());
    const guildId = interaction.guild.id;

    try {
        const [existing] = await pool.execute(
            'SELECT command_name FROM custom_commands WHERE guild_id = ? AND command_name = ?',
            [guildId, name]
        );

        if (existing.length > 0) {
            return await interaction.editReply('❌ A custom command with this name already exists. Use `/manage commands edit` to modify it.');
        }

        if (actionType === 'add_role' || actionType === 'remove_role') {
            const role = await interaction.guild.roles.fetch(actionContent).catch(() => null);
            if (!role) {
                return await interaction.editReply('❌ Invalid role ID provided. Please provide a valid role ID for role actions.');
            }
        }

        await pool.execute(
            `INSERT INTO custom_commands (guild_id, command_name, action_type, action_content, required_roles, allowed_channels)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                guildId,
                name,
                actionType,
                actionContent,
                JSON.stringify(requiredRoles || []),
                JSON.stringify(allowedChannels || [])
            ]
        );

        invalidateCommandCache(guildId, name);
        await interaction.editReply(`✅ Custom command \`${name}\` has been created successfully!\n\n**Note:** You need to restart the bot or re-register slash commands for this custom command to appear.`);

        logger.info(`[CustomCommands] Created custom command "${name}"`, {
            guildId,
            commandName: name,
            actionType,
            userId: interaction.user.id
        });

    } catch (error) {
        logger.error('[CustomCommands] Error creating custom command', {
            error: error.message,
            stack: error.stack,
            guildId,
            commandName: name
        });
        await interaction.editReply('❌ An error occurred while creating the custom command. Please try again.');
    }
}

export async function handleEdit(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const name = interaction.options.getString('name').toLowerCase();
    const actionType = interaction.options.getString('action-type');
    const actionContent = interaction.options.getString('response-or-role-id');
    const requiredRoles = interaction.options.getString('required-roles')?.split(',').map(id => id.trim());
    const allowedChannels = interaction.options.getString('allowed-channels')?.split(',').map(id => id.trim());
    const guildId = interaction.guild.id;

    try {
        const [existing] = await pool.execute(
            'SELECT command_name FROM custom_commands WHERE guild_id = ? AND command_name = ?',
            [guildId, name]
        );

        if (existing.length === 0) {
            return await interaction.editReply('❌ No custom command found with this name. Use `/manage commands create` to create it.');
        }

        if (actionType === 'add_role' || actionType === 'remove_role') {
            const role = await interaction.guild.roles.fetch(actionContent).catch(() => null);
            if (!role) {
                return await interaction.editReply('❌ Invalid role ID provided. Please provide a valid role ID for role actions.');
            }
        }

        await pool.execute(
            `UPDATE custom_commands
             SET action_type = ?, action_content = ?, required_roles = ?, allowed_channels = ?
             WHERE guild_id = ? AND command_name = ?`,
            [
                actionType,
                actionContent,
                JSON.stringify(requiredRoles || []),
                JSON.stringify(allowedChannels || []),
                guildId,
                name
            ]
        );

        invalidateCommandCache(guildId, name);
        await interaction.editReply(`✅ Custom command \`${name}\` has been updated successfully!`);

        logger.info(`[CustomCommands] Edited custom command "${name}"`, {
            guildId,
            commandName: name,
            actionType,
            userId: interaction.user.id
        });

    } catch (error) {
        logger.error('[CustomCommands] Error editing custom command', {
            error: error.message,
            stack: error.stack,
            guildId,
            commandName: name
        });
        await interaction.editReply('❌ An error occurred while editing the custom command. Please try again.');
    }
}

export async function handleDelete(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const name = interaction.options.getString('name').toLowerCase();
    const guildId = interaction.guild.id;

    try {
        const [result] = await pool.execute(
            'DELETE FROM custom_commands WHERE guild_id = ? AND command_name = ?',
            [guildId, name]
        );

        if (result.affectedRows > 0) {
            invalidateCommandCache(guildId, name);
            await interaction.editReply(`🗑️ Custom command \`${name}\` has been deleted.\n\n**Note:** You need to restart the bot or re-register slash commands to remove it from the command list.`);

            logger.info(`[CustomCommands] Deleted custom command "${name}"`, {
                guildId,
                commandName: name,
                userId: interaction.user.id
            });
        } else {
            await interaction.editReply(`❌ No custom command found with the name \`${name}\`.`);
        }

    } catch (error) {
        logger.error('[CustomCommands] Error deleting custom command', {
            error: error.message,
            stack: error.stack,
            guildId,
            commandName: name
        });
        await interaction.editReply('❌ An error occurred while deleting the custom command. Please try again.');
    }
}

export async function handleListCommands(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;

    try {
        const [commands] = await pool.execute(
            'SELECT command_name, action_type FROM custom_commands WHERE guild_id = ? ORDER BY command_name',
            [guildId]
        );

        if (commands.length === 0) {
            return await interaction.editReply('There are no custom commands configured for this server.');
        }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`Custom Commands for ${interaction.guild.name}`)
            .setDescription(
                commands.map(cmd => `\`${cmd.command_name}\` - *${cmd.action_type}*`).join('\n')
            )
            .setFooter({ text: `Total: ${commands.length} custom command(s)` })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        logger.error('[CustomCommands] Error listing custom commands', {
            error: error.message,
            stack: error.stack,
            guildId
        });
        await interaction.editReply('❌ An error occurred while listing custom commands. Please try again.');
    }
}
