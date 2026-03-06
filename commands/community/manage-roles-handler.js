import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

export async function handleCreatePanel(interaction) {
    const reactionRoleManager = interaction.client.reactionRoleManager;
    if (!reactionRoleManager) {
        return await interaction.reply({ content: 'Reaction role manager is not initialized. Please contact the bot administrator.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const channel = interaction.options.getChannel('channel');
    const name = interaction.options.getString('name');
    const type = interaction.options.getString('type');
    const mode = interaction.options.getString('mode');
    const title = interaction.options.getString('title') || 'Role Selection';
    const description = interaction.options.getString('description') || 'Select your roles below!';
    const color = interaction.options.getString('color') || '#5865F2';

    if (!/^#[0-9A-F]{6}$/i.test(color)) {
        await interaction.editReply({ content: 'Invalid color format. Please use hex format (e.g., #5865F2).' });
        return;
    }

    await interaction.editReply({
        content: `Creating panel "${name}" in ${channel}!\n\n` +
            `**Type:** ${type}\n` +
            `**Mode:** ${mode}\n\n` +
            `The panel has been set up, but it has no roles yet.\n` +
            `Use \`/manage roles add-role\` to add roles to this panel.\n\n` +
            `**Note:** You'll need the message ID of the panel. I'll send it to you once you add the first role.`
    });

    const embedData = {
        title,
        description: description + '\n\n*No roles configured yet. Use `/manage roles add-role` to add roles.*',
        color
    };

    const result = await reactionRoleManager.createReactionPanel(
        interaction.guild.id,
        channel.id,
        name,
        mode,
        type,
        [],
        embedData
    );

    if (result) {
        await interaction.followUp({
            content: `Panel created successfully!\n\n` +
                `**Message ID:** \`${result.messageId}\`\n` +
                `**Panel ID:** ${result.panelId}\n\n` +
                `Use this message ID to add roles with \`/manage roles add-role\`.`,
            ephemeral: true
        });
    } else {
        await interaction.followUp({
            content: 'Failed to create panel. Please check my permissions and try again.',
            ephemeral: true
        });
    }
}

export async function handleAddRole(interaction) {
    const reactionRoleManager = interaction.client.reactionRoleManager;
    if (!reactionRoleManager) {
        return await interaction.reply({ content: 'Reaction role manager is not initialized. Please contact the bot administrator.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const messageId = interaction.options.getString('message-id');
    const role = interaction.options.getRole('role');
    const emoji = interaction.options.getString('emoji');
    const label = interaction.options.getString('label') || role.name;
    const description = interaction.options.getString('description');
    const style = interaction.options.getString('style') || 'primary';

    const panel = await reactionRoleManager.getPanelWithRoles(messageId);
    if (!panel) {
        await interaction.editReply({ content: 'Panel not found. Please check the message ID and try again.' });
        return;
    }

    if (panel.roles.some(r => r.role_id === role.id)) {
        await interaction.editReply({ content: 'This role is already in the panel.' });
        return;
    }

    const botMember = interaction.guild.members.cache.get(interaction.client.user.id);
    if (role.position >= botMember.roles.highest.position) {
        await interaction.editReply({ content: 'I cannot assign this role because it is higher than or equal to my highest role.' });
        return;
    }

    const result = await reactionRoleManager.addRoleToPanel(
        messageId,
        role.id,
        emoji,
        label,
        description
    );

    if (result.success) {
        await interaction.editReply({
            content: `Successfully added ${role} to the panel!\n\n` +
                `**Emoji:** ${emoji}\n` +
                `**Label:** ${label}`
        });

        if (panel.roles.length === 0) {
            const guild = global.botManager?.getGuildFromAnyClient(panel.guild_id) || interaction.client.guilds.cache.get(panel.guild_id);
            if (guild) {
                const channel = guild.channels.cache.get(panel.channel_id);
                if (channel && channel.isTextBased()) {
                    const message = await channel.messages.fetch(messageId).catch(() => null);
                    if (message && message.embeds[0]) {
                        const embed = EmbedBuilder.from(message.embeds[0]);
                        const desc = embed.data.description;
                        if (desc && desc.includes('No roles configured yet')) {
                            embed.setDescription(desc.replace('\n\n*No roles configured yet. Use `/manage roles add-role` to add roles.*', ''));
                            await message.edit({ embeds: [embed] }).catch(() => {});
                        }
                    }
                }
            }
        }
    } else {
        await interaction.editReply({ content: `Failed to add role: ${result.error}` });
    }
}

export async function handleRemoveRole(interaction) {
    const reactionRoleManager = interaction.client.reactionRoleManager;
    if (!reactionRoleManager) {
        return await interaction.reply({ content: 'Reaction role manager is not initialized. Please contact the bot administrator.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const messageId = interaction.options.getString('message-id');
    const role = interaction.options.getRole('role');

    const result = await reactionRoleManager.removeRoleFromPanel(messageId, role.id);

    if (result.success) {
        if (result.deleted) {
            await interaction.editReply({ content: `Removed ${role} from the panel. The panel was deleted because it had no roles left.` });
        } else {
            await interaction.editReply({ content: `Successfully removed ${role} from the panel!` });
        }
    } else {
        await interaction.editReply({ content: `Failed to remove role: ${result.error}` });
    }
}

export async function handleDeletePanel(interaction) {
    const reactionRoleManager = interaction.client.reactionRoleManager;
    if (!reactionRoleManager) {
        return await interaction.reply({ content: 'Reaction role manager is not initialized. Please contact the bot administrator.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const messageId = interaction.options.getString('message-id');

    const success = await reactionRoleManager.deletePanel(messageId);

    if (success) {
        await interaction.editReply({ content: 'Panel deleted successfully!' });
    } else {
        await interaction.editReply({ content: 'Failed to delete panel. Please check the message ID and try again.' });
    }
}

export async function handleListPanels(interaction) {
    const reactionRoleManager = interaction.client.reactionRoleManager;
    if (!reactionRoleManager) {
        return await interaction.reply({ content: 'Reaction role manager is not initialized. Please contact the bot administrator.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const panels = await reactionRoleManager.getPanels(interaction.guild.id);

    if (panels.length === 0) {
        await interaction.editReply({ content: 'No reaction role panels found in this server.' });
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle('Reaction Role Panels')
        .setColor('#5865F2')
        .setDescription(`Found ${panels.length} panel(s) in this server.`)
        .setTimestamp();

    for (const panel of panels.slice(0, 10)) {
        const channel = interaction.guild.channels.cache.get(panel.channel_id);
        const channelMention = channel ? `<#${panel.channel_id}>` : `Unknown Channel (${panel.channel_id})`;

        const [mappings] = await pool.execute(
            'SELECT COUNT(*) as count FROM reaction_role_mappings WHERE panel_id = ?',
            [panel.id]
        );
        const roleCount = mappings[0].count;

        embed.addFields({
            name: panel.title || `Panel ${panel.id}`,
            value: `**Channel:** ${channelMention}\n` +
                `**Type:** ${panel.type}\n` +
                `**Mode:** ${panel.mode}\n` +
                `**Roles:** ${roleCount}\n` +
                `**Message ID:** \`${panel.message_id}\``,
            inline: false
        });
    }

    if (panels.length > 10) {
        embed.setFooter({ text: `Showing 10 of ${panels.length} panels` });
    }

    await interaction.editReply({ embeds: [embed] });
}
