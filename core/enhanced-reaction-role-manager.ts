import logger from '../utils/logger';
import db from '../utils/db';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder, Client, ButtonInteraction, StringSelectMenuInteraction, Message, Guild, Role } from 'discord.js';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

interface RoleOption {
    roleId: string;
    emoji: string;
    label?: string;
    name?: string;
    description?: string;
    style?: string;
}

interface EmbedData {
    color?: string;
    title?: string;
    description?: string;
    thumbnail?: string;
    image?: string;
}

interface ReactionRolePanel extends RowDataPacket {
    id: number;
    guild_id: string;
    channel_id: string;
    message_id: string;
    panel_name: string;
    panel_mode: 'normal' | 'unique';
    interaction_type: 'button' | 'select_menu' | 'reaction';
}

interface ReactionRoleMapping extends RowDataPacket {
    role_id: string;
    emoji_id: string;
    description: string | null;
}

interface PanelCreationResult {
    panelId: number;
    messageId: string;
}

class EnhancedReactionRoleManager {
    private client: Client;

    constructor(client: Client) {
        this.client = client;
        logger.info('[EnhancedReactionRoleManager] Enhanced reaction role manager initialized');
    }

    async createReactionPanel(guildId: string, channelId: string, panelName: string, panelMode: 'normal' | 'unique', interactionType: 'button' | 'select_menu' | 'reaction', roles: RoleOption[], embedData: EmbedData): Promise<PanelCreationResult | null> {
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild) return null;

            const channel = guild.channels.cache.get(channelId);
            if (!channel || !channel.isTextBased()) return null;

            // Create embed
            const embed = new EmbedBuilder()
                .setColor((embedData?.color as any) || '#5865F2')
                .setTitle(embedData?.title || 'Role Selection')
                .setDescription(embedData?.description || 'Select your roles below!');

            if (embedData?.thumbnail) embed.setThumbnail(embedData.thumbnail);
            if (embedData?.image) embed.setImage(embedData.image);

            let message: Message;

            // Send message based on interaction type
            if (interactionType === 'button') {
                const components = this.buildButtonComponents(roles);
                message = await channel.send({ embeds: [embed], components });
            } else if (interactionType === 'select_menu') {
                const components = this.buildSelectMenuComponents(roles, panelMode);
                message = await channel.send({ embeds: [embed], components });
            } else {
                // Traditional reaction-based
                message = await channel.send({ embeds: [embed] });
                for (const role of roles) {
                    await message.react(role.emoji).catch(() => {});
                }
            }

            // Save panel to database
            const [panelResult] = await db.execute<ResultSetHeader>(`
                INSERT INTO reaction_role_panels
                (guild_id, channel_id, message_id, panel_name, panel_mode, interaction_type)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [guildId, channelId, message.id, panelName, panelMode, interactionType]);

            const panelId = panelResult.insertId;

            // Save role mappings
            for (const role of roles) {
                const emojiId = role.emoji.includes(':') ? role.emoji.split(':')[2].replace('>', '') : role.emoji;
                await db.execute(`
                    INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, description)
                    VALUES (?, ?, ?, ?)
                `, [panelId, role.roleId, emojiId, role.description || null]);
            }

            logger.info(`[EnhancedReactionRoleManager] Created ${interactionType} panel: ${panelName}`, {
                guildId,
                panelId,
                messageId: message.id
            });

            return { panelId, messageId: message.id };
        } catch (error: any) {
            logger.error(`[EnhancedReactionRoleManager] Failed to create panel: ${error.message}`, { guildId });
            return null;
        }
    }

    buildButtonComponents(roles: RoleOption[]): ActionRowBuilder<ButtonBuilder>[] {
        const rows: ActionRowBuilder<ButtonBuilder>[] = [];
        let currentRow = new ActionRowBuilder<ButtonBuilder>();
        let buttonsInRow = 0;

        for (const role of roles) {
            if (buttonsInRow >= 5) {
                rows.push(currentRow);
                currentRow = new ActionRowBuilder<ButtonBuilder>();
                buttonsInRow = 0;
            }

            const button = new ButtonBuilder()
                .setCustomId(`rr_${role.roleId}`)
                .setLabel(role.label || role.name || 'Role')
                .setStyle(this.getButtonStyle(role.style || 'primary'));

            if (role.emoji) {
                // Handle both custom and unicode emojis
                if (role.emoji.includes(':')) {
                    const emojiId = role.emoji.split(':')[2].replace('>', '');
                    button.setEmoji(emojiId);
                } else {
                    button.setEmoji(role.emoji);
                }
            }

            currentRow.addComponents(button);
            buttonsInRow++;

            if (rows.length >= 5) break; // Max 5 rows
        }

        if (buttonsInRow > 0) rows.push(currentRow);
        return rows;
    }

    buildSelectMenuComponents(roles: RoleOption[], panelMode: 'normal' | 'unique'): ActionRowBuilder<StringSelectMenuBuilder>[] {
        const options = roles.map(role => ({
            label: role.label || role.name || 'Role',
            value: role.roleId,
            description: role.description || `Get the ${role.name} role`,
            emoji: role.emoji || undefined
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('rr_select')
            .setPlaceholder('Choose your roles')
            .setMinValues(panelMode === 'unique' ? 1 : 0)
            .setMaxValues(panelMode === 'unique' ? 1 : options.length)
            .addOptions(options);

        return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)];
    }

    getButtonStyle(style: string): ButtonStyle {
        const styles: { [key: string]: ButtonStyle } = {
            primary: ButtonStyle.Primary,
            secondary: ButtonStyle.Secondary,
            success: ButtonStyle.Success,
            danger: ButtonStyle.Danger
        };
        return styles[style] || ButtonStyle.Primary;
    }

    async handleButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
        if (!interaction.customId.startsWith('rr_')) return false;

        try {
            await interaction.deferReply({ ephemeral: true });

            const roleId = interaction.customId.replace('rr_', '');
            const role = interaction.guild!.roles.cache.get(roleId);

            if (!role) {
                await interaction.editReply('❌ This role no longer exists.');
                return true;
            }

            // Get panel info
            const [[panel]] = await db.execute<ReactionRolePanel[]>(
                'SELECT * FROM reaction_role_panels WHERE message_id = ?',
                [interaction.message.id]
            );

            if (!panel) {
                await interaction.editReply('❌ This panel is not configured.');
                return true;
            }

            const member = interaction.member;
            if (!member || typeof member === 'string') return true;

            const hasRole = member.roles.cache.has(roleId);

            // Handle unique mode
            if (panel.panel_mode === 'unique' && !hasRole) {
                const [allMappings] = await db.execute<ReactionRoleMapping[]>(
                    'SELECT role_id FROM reaction_role_mappings WHERE panel_id = ?',
                    [panel.id]
                );
                const rolesToRemove = allMappings.map(m => m.role_id).filter(id => id !== roleId);
                await member.roles.remove(rolesToRemove, 'Reaction Role: Unique mode').catch(() => {});
            }

            // Toggle role
            if (hasRole) {
                await member.roles.remove(role, 'Reaction Role: Button removed');
                await interaction.editReply(`✅ Removed the **${role.name}** role!`);
            } else {
                await member.roles.add(role, 'Reaction Role: Button added');
                await interaction.editReply(`✅ You now have the **${role.name}** role!`);
            }

            logger.info(`[EnhancedReactionRoleManager] ${member.user.tag} toggled role ${role.name}`, {
                guildId: interaction.guild!.id,
                userId: member.user.id,
                roleId,
                action: hasRole ? 'removed' : 'added'
            });

            return true;
        } catch (error: any) {
            logger.error(`[EnhancedReactionRoleManager] Button interaction error: ${error.message}`);
            if (!interaction.replied) {
                await interaction.editReply('❌ An error occurred. Please try again.').catch(() => {});
            }
            return true;
        }
    }

    async handleSelectMenuInteraction(interaction: StringSelectMenuInteraction): Promise<boolean> {
        if (interaction.customId !== 'rr_select') return false;

        try {
            await interaction.deferReply({ ephemeral: true });

            const selectedRoles = interaction.values;
            const [[panel]] = await db.execute<ReactionRolePanel[]>(
                'SELECT * FROM reaction_role_panels WHERE message_id = ?',
                [interaction.message.id]
            );

            if (!panel) {
                await interaction.editReply('❌ This panel is not configured.');
                return true;
            }

            // Get all roles in this panel
            const [allMappings] = await db.execute<ReactionRoleMapping[]>(
                'SELECT role_id FROM reaction_role_mappings WHERE panel_id = ?',
                [panel.id]
            );

            const allRoleIds = allMappings.map(m => m.role_id);
            const member = interaction.member;
            if (!member || typeof member === 'string') return true;

            // Remove all panel roles first
            await member.roles.remove(allRoleIds, 'Reaction Role: Select menu update').catch(() => {});

            // Add selected roles
            if (selectedRoles.length > 0) {
                await member.roles.add(selectedRoles, 'Reaction Role: Select menu selected');
            }

            const roleNames = selectedRoles.map(id => {
                const role = interaction.guild!.roles.cache.get(id);
                return role ? role.name : 'Unknown';
            });

            if (selectedRoles.length === 0) {
                await interaction.editReply('✅ Removed all roles from this panel!');
            } else {
                await interaction.editReply(`✅ Updated your roles! You now have: **${roleNames.join(', ')}**`);
            }

            logger.info(`[EnhancedReactionRoleManager] ${member.user.tag} selected ${selectedRoles.length} roles`, {
                guildId: interaction.guild!.id,
                userId: member.user.id,
                roleCount: selectedRoles.length
            });

            return true;
        } catch (error: any) {
            logger.error(`[EnhancedReactionRoleManager] Select menu interaction error: ${error.message}`);
            if (!interaction.replied) {
                await interaction.editReply('❌ An error occurred. Please try again.').catch(() => {});
            }
            return true;
        }
    }

    async deletePanel(messageId: string): Promise<boolean> {
        try {
            const [[panel]] = await db.execute<ReactionRolePanel[]>(
                'SELECT * FROM reaction_role_panels WHERE message_id = ?',
                [messageId]
            );

            if (!panel) return false;

            // Delete mappings
            await db.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [panel.id]);

            // Delete panel
            await db.execute('DELETE FROM reaction_role_panels WHERE id = ?', [panel.id]);

            // Delete message
            const guild = this.client.guilds.cache.get(panel.guild_id);
            if (guild) {
                const channel = guild.channels.cache.get(panel.channel_id);
                if (channel && channel.isTextBased()) {
                    const message = await channel.messages.fetch(messageId).catch(() => null);
                    if (message) await message.delete().catch(() => {});
                }
            }

            logger.info(`[EnhancedReactionRoleManager] Deleted panel ${panel.id}`, {
                guildId: panel.guild_id,
                panelId: panel.id
            });

            return true;
        } catch (error: any) {
            logger.error(`[EnhancedReactionRoleManager] Failed to delete panel: ${error.message}`);
            return false;
        }
    }

    async getPanels(guildId: string): Promise<ReactionRolePanel[]> {
        try {
            const [panels] = await db.execute<ReactionRolePanel[]>(
                'SELECT * FROM reaction_role_panels WHERE guild_id = ? ORDER BY id DESC',
                [guildId]
            );
            return panels;
        } catch (error: any) {
            logger.error(`[EnhancedReactionRoleManager] Failed to get panels: ${error.message}`);
            return [];
        }
    }
}

export default EnhancedReactionRoleManager;
