import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { generateWelcomeCard } from '../utils/welcomeCard.js';

class ReactionRoleManager {
  constructor(client) {
    this.client = client;
    logger.info('[ReactionRoleManager] Reaction role manager initialized');
  }

  async createReactionPanel(guildId, channelId, panelName, panelMode, interactionType, roles, embedData) {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) return null;

      const channel = guild.channels.cache.get(channelId);
      if (!channel || !channel.isTextBased()) return null;

      // Create embed
      const embed = new EmbedBuilder()
        .setColor(embedData?.color || '#5865F2')
        .setTitle(embedData?.title || 'Role Selection')
        .setDescription(embedData?.description || 'Select your roles below!');

      if (embedData?.thumbnail) embed.setThumbnail(embedData.thumbnail);
      if (embedData?.image) embed.setImage(embedData.image);

      let message;

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
      const [panelResult] = await pool.execute(
        `INSERT INTO reaction_role_panels
        (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [guildId, channelId, message.id, embedData?.title || panelName, embedData?.description || 'Select your roles below!', embedData?.color || '#5865F2', interactionType === 'select_menu' ? 'select_menu' : interactionType, panelMode]
      );

      const panelId = panelResult.insertId;

      // Save role mappings
      for (const role of roles) {
        const emojiId = role.emoji.includes(':') ? role.emoji.split(':')[2].replace('>', '') : role.emoji;
        await pool.execute(
          `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id)
          VALUES (?, ?, ?)`,
          [panelId, role.roleId, emojiId]
        );
      }

      logger.info(`[ReactionRoleManager] Created ${interactionType} panel: ${panelName}`, {
        guildId,
        panelId,
        messageId: message.id
      });

      return { panelId, messageId: message.id };
    } catch (error) {
      logger.error(`[ReactionRoleManager] Failed to create panel: ${error.message}`, { guildId });
      return null;
    }
  }

  buildButtonComponents(roles) {
    const rows = [];
    let currentRow = new ActionRowBuilder();
    let buttonsInRow = 0;

    for (const role of roles) {
      if (buttonsInRow >= 5) {
        rows.push(currentRow);
        currentRow = new ActionRowBuilder();
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

  buildSelectMenuComponents(roles, panelMode) {
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

    return [new ActionRowBuilder().addComponents(selectMenu)];
  }

  getButtonStyle(style) {
    const styles = {
      primary: ButtonStyle.Primary,
      secondary: ButtonStyle.Secondary,
      success: ButtonStyle.Success,
      danger: ButtonStyle.Danger
    };
    return styles[style] || ButtonStyle.Primary;
  }

  async handleButtonInteraction(interaction) {
    if (!interaction.customId.startsWith('rr_')) return false;

    try {
      logger.info(`[ReactionRoleManager] Button clicked: ${interaction.customId} by ${interaction.user.tag} in guild ${interaction.guildId}`);
      await interaction.deferReply({ flags: 64 });

      const roleId = interaction.customId.replace('rr_', '');
      const role = interaction.guild.roles.cache.get(roleId);

      if (!role) {
        await interaction.editReply('This role no longer exists.');
        return true;
      }

      // Get panel info
      const [panels] = await pool.execute(
        'SELECT * FROM reaction_role_panels WHERE message_id = ?',
        [interaction.message.id]
      );

      const panel = panels[0];
      if (!panel) {
        await interaction.editReply('This panel is not configured.');
        return true;
      }

      const member = interaction.member;
      if (!member || typeof member === 'string') return true;

      const hasRole = member.roles.cache.has(roleId);

      // Handle unique mode
      if (panel.panel_mode === 'unique' && !hasRole) {
        const [allMappings] = await pool.execute(
          'SELECT role_id FROM reaction_role_mappings WHERE panel_id = ?',
          [panel.id]
        );
        const rolesToRemove = allMappings.map(m => m.role_id).filter(id => id !== roleId);
        await member.roles.remove(rolesToRemove, 'Reaction Role: Unique mode').catch(() => {});
      }

      // Toggle role
      if (hasRole) {
        await member.roles.remove(role, 'Reaction Role: Button removed');
        await interaction.editReply(`Removed the **${role.name}** role!`);
      } else {
        await member.roles.add(role, 'Reaction Role: Button added');
        await interaction.editReply(`You now have the **${role.name}** role!`);
      }

      logger.info(`[ReactionRoleManager] ${member.user.tag} toggled role ${role.name}`, {
        guildId: interaction.guild.id,
        userId: member.user.id,
        roleId,
        action: hasRole ? 'removed' : 'added'
      });

      return true;
    } catch (error) {
      logger.error(`[ReactionRoleManager] Button interaction error: ${error.message}`);
      if (!interaction.replied) {
        await interaction.editReply('An error occurred. Please try again.').catch(() => {});
      }
      return true;
    }
  }

  async handleSelectMenuInteraction(interaction) {
    if (!interaction.customId.startsWith('rr_select')) return false;

    try {
      await interaction.deferReply({ flags: 64 });

      const selectedRoles = interaction.values;
      const [panels] = await pool.execute(
        'SELECT * FROM reaction_role_panels WHERE message_id = ?',
        [interaction.message.id]
      );

      const panel = panels[0];
      if (!panel) {
        await interaction.editReply('This panel is not configured.');
        return true;
      }

      // Get all roles in this panel
      const [allMappings] = await pool.execute(
        'SELECT role_id FROM reaction_role_mappings WHERE panel_id = ?',
        [panel.id]
      );

      const allRoleIds = allMappings.map(m => m.role_id);
      const member = interaction.member;
      if (!member || typeof member === 'string') return true;

      if (panel.panel_mode === 'unique') {
        // Unique mode: only one role at a time — remove others, add selected
        await member.roles.remove(allRoleIds, 'Reaction Role: Unique mode switch').catch(() => {});
        if (selectedRoles.length > 0) {
          await member.roles.add(selectedRoles[0], 'Reaction Role: Unique mode selected');
          const role = interaction.guild.roles.cache.get(selectedRoles[0]);
          const roleName = role ? role.name : 'Unknown';
          await interaction.editReply(`Switched to **${roleName}**!`);
        } else {
          await interaction.editReply('Removed all roles from this panel!');
        }
      } else {
        // Normal mode: additive — only add new roles, never remove
        const currentPanelRoles = allRoleIds.filter(id => member.roles.cache.has(id));
        const rolesToAdd = selectedRoles.filter(id => !currentPanelRoles.includes(id));

        if (rolesToAdd.length === 0) {
          await interaction.editReply('You already have all the selected roles!');
        } else {
          await member.roles.add(rolesToAdd, 'Reaction Role: Select menu added');
          const addedNames = rolesToAdd.map(id => {
            const role = interaction.guild.roles.cache.get(id);
            return role ? role.name : 'Unknown';
          });
          await interaction.editReply(`Added **${addedNames.join(', ')}** to your roles!`);
        }
      }

      logger.info(`[ReactionRoleManager] ${member.user.tag} selected ${selectedRoles.length} roles`, {
        guildId: interaction.guild.id,
        userId: member.user.id,
        roleCount: selectedRoles.length
      });

      return true;
    } catch (error) {
      logger.error(`[ReactionRoleManager] Select menu interaction error: ${error.message}`);
      if (!interaction.replied) {
        await interaction.editReply('An error occurred. Please try again.').catch(() => {});
      }
      return true;
    }
  }

  async addRoleToPanel(messageId, roleId, emoji, label, description) {
    try {
      const [panels] = await pool.execute(
        'SELECT * FROM reaction_role_panels WHERE message_id = ?',
        [messageId]
      );

      const panel = panels[0];
      if (!panel) return { success: false, error: 'Panel not found' };

      const emojiId = emoji.includes(':') ? emoji.split(':')[2].replace('>', '') : emoji;

      await pool.execute(
        `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji, label, description)
        VALUES (?, ?, ?, ?, ?)`,
        [panel.id, roleId, emojiId, label || 'Role', description || null]
      );

      // Update the message with new components
      const guild = this.client.guilds.cache.get(panel.guild_id);
      if (guild) {
        const channel = guild.channels.cache.get(panel.channel_id);
        if (channel && channel.isTextBased()) {
          const message = await channel.messages.fetch(messageId).catch(() => null);
          if (message) {
            const [mappings] = await pool.execute(
              'SELECT role_id, emoji, label, description FROM reaction_role_mappings WHERE panel_id = ?',
              [panel.id]
            );

            const roles = mappings.map(m => ({
              roleId: m.role_id,
              emoji: m.emoji,
              label: m.label || 'Role',
              description: m.description
            }));

            if (panel.interaction_type === 'button') {
              const components = this.buildButtonComponents(roles);
              await message.edit({ components }).catch(() => {});
            } else if (panel.interaction_type === 'select' || panel.interaction_type === 'select_menu') {
              const components = this.buildSelectMenuComponents(roles, panel.panel_mode);
              await message.edit({ components }).catch(() => {});
            } else if (panel.interaction_type === 'reaction') {
              await message.react(emoji).catch(() => {});
            }
          }
        }
      }

      logger.info(`[ReactionRoleManager] Added role ${roleId} to panel ${panel.id}`);
      return { success: true };
    } catch (error) {
      logger.error(`[ReactionRoleManager] Failed to add role: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async removeRoleFromPanel(messageId, roleId) {
    try {
      const [panels] = await pool.execute(
        'SELECT * FROM reaction_role_panels WHERE message_id = ?',
        [messageId]
      );

      const panel = panels[0];
      if (!panel) return { success: false, error: 'Panel not found' };

      await pool.execute(
        'DELETE FROM reaction_role_mappings WHERE panel_id = ? AND role_id = ?',
        [panel.id, roleId]
      );

      // Update the message with remaining components
      const guild = this.client.guilds.cache.get(panel.guild_id);
      if (guild) {
        const channel = guild.channels.cache.get(panel.channel_id);
        if (channel && channel.isTextBased()) {
          const message = await channel.messages.fetch(messageId).catch(() => null);
          if (message) {
            const [mappings] = await pool.execute(
              'SELECT role_id, emoji, label, description FROM reaction_role_mappings WHERE panel_id = ?',
              [panel.id]
            );

            if (mappings.length === 0) {
              await this.deletePanel(messageId);
              return { success: true, deleted: true };
            }

            const roles = mappings.map(m => ({
              roleId: m.role_id,
              emoji: m.emoji,
              label: m.label || 'Role',
              description: m.description
            }));

            if (panel.interaction_type === 'button') {
              const components = this.buildButtonComponents(roles);
              await message.edit({ components }).catch(() => {});
            } else if (panel.interaction_type === 'select' || panel.interaction_type === 'select_menu') {
              const components = this.buildSelectMenuComponents(roles, panel.panel_mode);
              await message.edit({ components }).catch(() => {});
            }
          }
        }
      }

      logger.info(`[ReactionRoleManager] Removed role ${roleId} from panel ${panel.id}`);
      return { success: true };
    } catch (error) {
      logger.error(`[ReactionRoleManager] Failed to remove role: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async deletePanel(messageId) {
    try {
      const [panels] = await pool.execute(
        'SELECT * FROM reaction_role_panels WHERE message_id = ?',
        [messageId]
      );

      const panel = panels[0];
      if (!panel) return false;

      // Delete mappings
      await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [panel.id]);

      // Delete panel
      await pool.execute('DELETE FROM reaction_role_panels WHERE id = ?', [panel.id]);

      // Delete message
      const guild = this.client.guilds.cache.get(panel.guild_id);
      if (guild) {
        const channel = guild.channels.cache.get(panel.channel_id);
        if (channel && channel.isTextBased()) {
          const message = await channel.messages.fetch(messageId).catch(() => null);
          if (message) await message.delete().catch(() => {});
        }
      }

      logger.info(`[ReactionRoleManager] Deleted panel ${panel.id}`, {
        guildId: panel.guild_id,
        panelId: panel.id
      });

      return true;
    } catch (error) {
      logger.error(`[ReactionRoleManager] Failed to delete panel: ${error.message}`);
      return false;
    }
  }

  async getPanels(guildId) {
    try {
      const [panels] = await pool.execute(
        'SELECT * FROM reaction_role_panels WHERE guild_id = ? ORDER BY id DESC',
        [guildId]
      );
      return panels;
    } catch (error) {
      logger.error(`[ReactionRoleManager] Failed to get panels: ${error.message}`);
      return [];
    }
  }

  async getPanelWithRoles(messageId) {
    try {
      const [panels] = await pool.execute(
        'SELECT * FROM reaction_role_panels WHERE message_id = ?',
        [messageId]
      );

      const panel = panels[0];
      if (!panel) return null;

      const [mappings] = await pool.execute(
        'SELECT role_id, emoji, label, description FROM reaction_role_mappings WHERE panel_id = ?',
        [panel.id]
      );

      return {
        ...panel,
        roles: mappings
      };
    } catch (error) {
      logger.error(`[ReactionRoleManager] Failed to get panel with roles: ${error.message}`);
      return null;
    }
  }

  async handleReactionAdd(reaction, user) {
    try {
      // Fetch partial data if needed
      if (reaction.partial) {
        try {
          await reaction.fetch();
        } catch {
          return;
        }
      }

      if (reaction.message.partial) {
        try {
          await reaction.message.fetch();
        } catch {
          return;
        }
      }

      const message = reaction.message;
      if (!message.guild) return;

      // Check if this message is a reaction role panel
      const [panels] = await pool.execute(
        'SELECT * FROM reaction_role_panels WHERE message_id = ? AND guild_id = ?',
        [message.id, message.guild.id]
      );

      if (panels.length === 0) return;

      const panel = panels[0];

      // Get the emoji identifier (works for both unicode and custom emojis)
      const emojiId = reaction.emoji.id || reaction.emoji.name;

      // Find the role mapping for this emoji
      const [mappings] = await pool.execute(
        'SELECT role_id FROM reaction_role_mappings WHERE panel_id = ? AND emoji_id = ?',
        [panel.id, emojiId]
      );

      if (mappings.length === 0) {
        // No mapping found for this emoji, remove the reaction
        await reaction.users.remove(user.id).catch(() => {});
        return;
      }

      const roleId = mappings[0].role_id;
      const role = message.guild.roles.cache.get(roleId);

      if (!role) {
        logger.warn(`[ReactionRoleManager] Role ${roleId} not found in guild ${message.guild.id}`);
        await reaction.users.remove(user.id).catch(() => {});
        return;
      }

      const member = await message.guild.members.fetch(user.id).catch(() => null);
      if (!member) return;

      const hasRole = member.roles.cache.has(roleId);

      // Handle unique mode (remove other roles from this panel)
      if (panel.panel_mode === 'unique' && !hasRole) {
        const [allMappings] = await pool.execute(
          'SELECT role_id FROM reaction_role_mappings WHERE panel_id = ?',
          [panel.id]
        );
        const rolesToRemove = allMappings.map(m => m.role_id).filter(id => id !== roleId);
        await member.roles.remove(rolesToRemove, 'Reaction Role: Unique mode').catch(() => {});
      }

      // Add the role
      if (!hasRole) {
        await member.roles.add(role, 'Reaction Role: Reaction added');
        logger.info(`[ReactionRoleManager] ${member.user.tag} added role ${role.name} via reaction`, {
          guildId: message.guild.id,
          userId: user.id,
          roleId
        });

        // Check if this is a verification role and send welcome message
        if (role.name.toLowerCase().includes('verified')) {
          await this.sendWelcomeMessage(message.guild, member);
        }
      }
    } catch (error) {
      logger.error(`[ReactionRoleManager] Error in handleReactionAdd: ${error.message}`, {
        error: error.stack
      });
    }
  }

  async sendWelcomeMessage(guild, member) {
    try {
      // Get welcome settings from database
      const [settings] = await pool.execute(
        'SELECT channel_id, message FROM welcome_settings WHERE guild_id = ?',
        [guild.id]
      );

      if (settings.length === 0 || !settings[0].channel_id) return;

      const channel = guild.channels.cache.get(settings[0].channel_id);
      if (!channel) return;

      // Generate welcome card image
      const welcomeCardBuffer = await generateWelcomeCard(member, guild.name);
      const attachment = new AttachmentBuilder(welcomeCardBuffer, { name: 'welcome.png' });

      // Find introductions channel for the embed
      const introChannel = guild.channels.cache.find(c => c.name.includes('introduction'));

      // Create welcome embed with the generated card as the image
      const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setImage('attachment://welcome.png')
        .addFields({
          name: '🌿 Get Started',
          value: `• Introduce yourself${introChannel ? ` in ${introChannel}` : ''}\n• Pick your growing style roles\n• Check out the grow channels\n• Share your grows!`,
          inline: false
        })
        .setFooter({ text: 'Happy growing! 🪴' })
        .setTimestamp();

      await channel.send({ embeds: [embed], files: [attachment] });

      logger.info(`[ReactionRoleManager] Sent welcome card for ${member.user.tag}`, {
        guildId: guild.id,
        channelId: channel.id
      });
    } catch (error) {
      logger.error(`[ReactionRoleManager] Error sending welcome message: ${error.message}`);
    }
  }

  async handleReactionRemove(reaction, user) {
    try {
      // Fetch partial data if needed
      if (reaction.partial) {
        try {
          await reaction.fetch();
        } catch {
          return;
        }
      }

      if (reaction.message.partial) {
        try {
          await reaction.message.fetch();
        } catch {
          return;
        }
      }

      const message = reaction.message;
      if (!message.guild) return;

      // Check if this message is a reaction role panel
      const [panels] = await pool.execute(
        'SELECT * FROM reaction_role_panels WHERE message_id = ? AND guild_id = ?',
        [message.id, message.guild.id]
      );

      if (panels.length === 0) return;

      const panel = panels[0];

      // Get the emoji identifier
      const emojiId = reaction.emoji.id || reaction.emoji.name;

      // Find the role mapping for this emoji
      const [mappings] = await pool.execute(
        'SELECT role_id FROM reaction_role_mappings WHERE panel_id = ? AND emoji_id = ?',
        [panel.id, emojiId]
      );

      if (mappings.length === 0) return;

      const roleId = mappings[0].role_id;
      const role = message.guild.roles.cache.get(roleId);

      if (!role) return;

      const member = await message.guild.members.fetch(user.id).catch(() => null);
      if (!member) return;

      const hasRole = member.roles.cache.has(roleId);

      // Remove the role
      if (hasRole) {
        await member.roles.remove(role, 'Reaction Role: Reaction removed');
        logger.info(`[ReactionRoleManager] ${member.user.tag} removed role ${role.name} via reaction`, {
          guildId: message.guild.id,
          userId: user.id,
          roleId
        });
      }
    } catch (error) {
      logger.error(`[ReactionRoleManager] Error in handleReactionRemove: ${error.message}`, {
        error: error.stack
      });
    }
  }
}

export default ReactionRoleManager;
