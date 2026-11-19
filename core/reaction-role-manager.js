import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder } from 'discord.js';
import { generateWelcomeCard } from '../utils/welcomeCard.js';
import { accessibleAttachment, welcomeCardAltText } from '../utils/accessible-attachment.js';
import { themeColor } from './guild-theme.js';
import { capacityFor } from './reaction-role-bulk.js';

/**
 * Buttons into action rows: five to a row and five rows to a message, Discord's limits. Anything past
 * 25 is left off (the add paths refuse a 26th; this keeps an older over-full panel postable).
 */
export function chunkButtons(items, perRow = 5, maxRows = 5) {
  const rows = [];
  for (let i = 0; i < items.length && rows.length < maxRows; i += perRow) rows.push(items.slice(i, i + perRow));
  return rows;
}

/**
 * What a pick in a panel's dropdown does. The menu is reset after every pick, so each pick starts
 * from nothing selected, and it works like the buttons: a picked role the member does not have is
 * added, one they already have is removed. In one-role-at-a-time mode a new role also removes the
 * panel's other roles. Values that are not this panel's roles are ignored.
 * @returns {{ add: string[], remove: string[] }}
 */
export function planSelectToggle({ panelMode, panelRoleIds, heldRoleIds, selected }) {
  const panel = new Set(panelRoleIds);
  const held = new Set(heldRoleIds);
  const picked = [...new Set(selected)].filter(id => panel.has(id));
  if (panelMode === 'unique') {
    const pick = picked[0];
    if (!pick) return { add: [], remove: [] };
    if (held.has(pick)) return { add: [], remove: [pick] };
    return { add: [pick], remove: panelRoleIds.filter(id => id !== pick && held.has(id)) };
  }
  return {
    add: picked.filter(id => !held.has(id)),
    remove: picked.filter(id => held.has(id)),
  };
}

const VALID_BUTTON_STYLES = ['primary', 'secondary', 'success', 'danger'];
// Placeholder /manage roles create-panel puts in the panel description until the first role is added.
const NO_ROLES_PLACEHOLDER = '\n\n*No roles configured yet. Use `/manage roles add-role` to add roles.*';

/**
 * Every value reaction_role_mappings.emoji_id may hold for this emoji. The dashboard stores a
 * unicode emoji as-is and a custom one as its full `<:name:id>` token (core/reaction-role-bulk.js
 * keeps the pasted token verbatim); older rows written by createReactionPanel and setup scripts
 * hold the bare id. A reaction has to find its mapping whichever form the row used.
 */
function emojiIdCandidates(emoji) {
  if (!emoji) return [];
  if (emoji.id) {
    return [...new Set([emoji.id, `<:${emoji.name}:${emoji.id}>`, `<a:${emoji.name}:${emoji.id}>`])];
  }
  return emoji.name ? [emoji.name] : [];
}

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
      // Fields, when a rebuilt panel is carrying the original's own layout across. Discord caps at
      // 25 and rejects an empty name or value outright, so anything malformed is dropped rather than
      // failing the whole post.
      const fields = (embedData?.fields ?? [])
        .filter(f => f?.name && f?.value)
        .slice(0, 25)
        .map(f => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024) }));
      if (fields.length) embed.addFields(fields);

      let message;

      // Send message based on interaction type
      if (interactionType === 'button') {
        const components = this.buildButtonComponents(roles);
        message = await channel.send({ embeds: [embed], components });
      } else if (interactionType === 'select_menu') {
        // /manage roles create-panel posts with no roles yet; Discord rejects a select menu with
        // zero options, so the menu is only attached once there is something to pick.
        const components = roles.length ? this.buildSelectMenuComponents(roles, panelMode) : [];
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
    // Five buttons a row, five rows: more than 25 roles used to make a sixth row Discord rejects.
    return chunkButtons(roles).map(chunk => new ActionRowBuilder().addComponents(chunk.map(role => {
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
      return button;
    })));
  }

  buildSelectMenuComponents(roles, panelMode) {
    const options = roles.slice(0, 25).map(role => ({
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

      let roleId = interaction.customId.replace('rr_', '');
      let role = interaction.guild.roles.cache.get(roleId);

      // If the custom ID isn't a valid role snowflake, look up from DB mapping
      if (!role) {
        const [dbMapping] = await pool.execute(
          `SELECT rm.role_id FROM reaction_role_mappings rm
           JOIN reaction_role_panels rp ON rm.panel_id = rp.id
           WHERE rp.message_id = ? AND rm.emoji_id = ?`,
          [interaction.message.id, interaction.customId]
        );
        if (dbMapping.length > 0) {
          roleId = dbMapping[0].role_id;
          role = interaction.guild.roles.cache.get(roleId);
        }
      }

      if (!role) {
        await interaction.editReply('This role no longer exists.');
        return true;
      }

      const member = interaction.member;
      if (!member || typeof member === 'string') return true;

      const hasRole = member.roles.cache.has(roleId);

      // Get panel info (optional — rr_ buttons work without a DB panel)
      const [panels] = await pool.execute(
        'SELECT * FROM reaction_role_panels WHERE message_id = ?',
        [interaction.message.id]
      );

      const panel = panels[0];

      // Handle unique mode if panel exists and is configured for it
      if (panel?.panel_mode === 'unique' && !hasRole) {
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
        // Optional per-mapping level gate. Only enforced on the grant path —
        // opt-out is always allowed regardless of level.
        if (panel) {
          const [mappingRows] = await pool.execute(
            'SELECT min_level FROM reaction_role_mappings WHERE panel_id = ? AND role_id = ? LIMIT 1',
            [panel.id, roleId]
          );
          const minLevel = mappingRows[0]?.min_level || null;
          if (minLevel && minLevel > 0) {
            const lm = interaction.client?.levelingManager;
            const rank = lm ? await lm.getUserRank(interaction.guild.id, interaction.user.id) : null;
            const userLevel = rank?.level || 0;
            if (userLevel < minLevel) {
              await interaction.editReply(
                `🔒 You need to reach **level ${minLevel}** in this server before you can opt in here. You're currently **level ${userLevel}**.`
              );
              return true;
            }
          }
        }

        await member.roles.add(role, 'Reaction Role: Button added');

        // Optional follow-up: if the panel is configured with a redirect
        // channel, include a Link button so the user can jump there in one
        // click. Used by rules-verify panels to funnel users to #roles.
        const redirectChannelId = panel?.post_assign_redirect_channel_id;
        if (redirectChannelId) {
          const channel = interaction.guild.channels.cache.get(redirectChannelId);
          const linkLabel = channel ? `Go to #${channel.name}` : 'Continue';
          const linkButton = new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel(linkLabel)
            .setURL(`https://discord.com/channels/${interaction.guild.id}/${redirectChannelId}`)
            .setEmoji('🎭');
          await interaction.editReply({
            content: `You now have the **${role.name}** role!`,
            components: [new ActionRowBuilder().addComponents(linkButton)],
          });
        } else {
          await interaction.editReply(`You now have the **${role.name}** role!`);
        }
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

    // Answer by re-sending the message's own components: that resets the menu on the member's
    // screen, so the next pick starts from nothing selected (picks toggle, see planSelectToggle).
    // The result goes to them privately as a follow-up.
    let say;
    try {
      await interaction.update({ components: interaction.message.components });
      say = (content) => interaction.followUp({ content, flags: 64 });
    } catch {
      if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: 64 }).catch(() => {});
      say = (content) => interaction.editReply(content);
    }

    try {
      const selectedRoles = interaction.values;
      logger.info(`[ReactionRoleManager] Select menu: user=${interaction.user.tag} values=${JSON.stringify(selectedRoles)} msgId=${interaction.message.id}`, { category: 'reaction-roles' });

      const [panels] = await pool.execute(
        'SELECT * FROM reaction_role_panels WHERE message_id = ?',
        [interaction.message.id]
      );

      const panel = panels[0];
      if (!panel) {
        await say('This panel is not configured.');
        return true;
      }

      // Get all roles in this panel
      const [allMappings] = await pool.execute(
        'SELECT role_id, min_level FROM reaction_role_mappings WHERE panel_id = ?',
        [panel.id]
      );

      const allRoleIds = allMappings.map(m => m.role_id);
      const member = interaction.member;
      if (!member || typeof member === 'string') return true;

      const plan = planSelectToggle({
        panelMode: panel.panel_mode,
        panelRoleIds: allRoleIds,
        heldRoleIds: allRoleIds.filter(id => member.roles.cache.has(id)),
        selected: selectedRoles,
      });

      // The per-role level gate applies to taking a role here as it does on the buttons;
      // dropping a role is always allowed.
      const gated = [];
      if (plan.add.length) {
        const gates = new Map(allMappings.filter(m => m.min_level > 0).map(m => [m.role_id, m.min_level]));
        if (plan.add.some(id => gates.has(id))) {
          const lm = interaction.client?.levelingManager;
          const rank = lm ? await lm.getUserRank(interaction.guild.id, interaction.user.id) : null;
          const userLevel = rank?.level || 0;
          for (const id of [...plan.add]) {
            if ((gates.get(id) || 0) > userLevel) {
              gated.push({ id, level: gates.get(id) });
              plan.add.splice(plan.add.indexOf(id), 1);
            }
          }
          if (gated.length && panel.panel_mode === 'unique') plan.remove = []; // nothing to switch to
        }
      }

      const nameOf = (id) => interaction.guild.roles.cache.get(id)?.name || 'Unknown role';
      if (plan.remove.length) await member.roles.remove(plan.remove, 'Reaction Role: Select menu removed');
      if (plan.add.length) await member.roles.add(plan.add, 'Reaction Role: Select menu added');

      const lines = [];
      if (plan.add.length) lines.push(`Added **${plan.add.map(nameOf).join(', ')}**.`);
      if (plan.remove.length) lines.push(`Removed **${plan.remove.map(nameOf).join(', ')}**.`);
      for (const g of gated) lines.push(`You need to reach **level ${g.level}** for **${nameOf(g.id)}**.`);
      await say(lines.length ? lines.join('\n') : 'Nothing changed.');

      logger.info(`[ReactionRoleManager] ${member.user.tag} selected ${selectedRoles.length} roles`, {
        guildId: interaction.guild.id,
        userId: member.user.id,
        roleCount: selectedRoles.length
      });

      return true;
    } catch (error) {
      logger.error(`[ReactionRoleManager] Select menu interaction error: ${error.message}`);
      await say('An error occurred. Please try again.').catch(() => {});
      return true;
    }
  }

  /**
   * The form the dashboard stores in emoji_id: a unicode emoji as typed, a custom emoji as its full
   * `<:name:id>` token. A bare id or a `:name:` shortcode the Discord client didn't expand is
   * resolved against the server's own emoji so it ends up in that same form.
   */
  normaliseEmoji(input, guild) {
    const text = String(input ?? '').trim();
    if (!text) return null;
    const byId = /^\d{15,25}$/.test(text) ? guild?.emojis?.cache.get(text) : null;
    const shortcode = text.match(/^:(\w{2,32}):$/);
    const byName = shortcode ? guild?.emojis?.cache.find(e => e.name === shortcode[1]) : null;
    const custom = byId || byName;
    return custom ? custom.toString() : text;
  }

  /**
   * /manage roles add-role. Writes the mapping exactly like the dashboard's "add role" does
   * (emoji_id / label / button_style) and re-renders the live message through the same
   * refreshPanelMessage the dashboard uses, so a command-added role looks and behaves the same.
   */
  async addRoleToPanel(messageId, roleId, emoji, label, description, style = 'primary') {
    try {
      const [panels] = await pool.execute(
        'SELECT * FROM reaction_role_panels WHERE message_id = ?',
        [messageId]
      );

      const panel = panels[0];
      if (!panel) return { success: false, error: 'Panel not found' };

      // Same limit as the dashboard: 25 buttons or dropdown options, 20 reactions per message.
      const type = panel.interaction_type || 'reaction';
      const capacity = capacityFor(type);
      const [[{ used }]] = await pool.execute('SELECT COUNT(*) AS used FROM reaction_role_mappings WHERE panel_id = ?', [panel.id]);
      if (Number(used) >= capacity) {
        return { success: false, error: `This panel is full. Discord allows ${capacity} roles on a ${type.replace('_', ' ')} panel.` };
      }

      const guild = this.client.guilds.cache.get(panel.guild_id);
      const emojiId = this.normaliseEmoji(emoji, guild);

      // The create-panel placeholder lives in the stored description; the refresh below renders
      // from the row, so it has to go there rather than only from the posted message.
      if (panel.description && panel.description.includes(NO_ROLES_PLACEHOLDER)) {
        await pool.execute(
          'UPDATE reaction_role_panels SET description = ? WHERE id = ?',
          [panel.description.replace(NO_ROLES_PLACEHOLDER, ''), panel.id]
        );
      }

      // description = the select-menu option text (column from migration 265; NULL → "Get the X role").
      const [inserted] = await pool.execute(
        `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, button_style, description)
        VALUES (?, ?, ?, ?, ?, ?)`,
        [panel.id, roleId, emojiId, label || null,
         VALID_BUTTON_STYLES.includes(style) ? style : 'primary',
         description ? String(description).slice(0, 100) : null]
      );

      const liveMessage = await refreshPanelMessage({ guildId: panel.guild_id, panelId: panel.id, botClient: this.client });
      if (liveMessage === 'failed') {
        // Discord refused the re-rendered panel (usually an emoji it can't use). Don't keep a
        // mapping the message can't show.
        await pool.execute('DELETE FROM reaction_role_mappings WHERE id = ?', [inserted.insertId]);
        logger.warn(`[ReactionRoleManager] Rolled back mapping for role ${roleId} on panel ${panel.id}: panel refresh failed`, {
          guildId: panel.guild_id, emoji: emojiId
        });
        return { success: false, error: 'Discord rejected the updated panel. Check that the emoji is valid and that I can edit that message.' };
      }

      logger.info(`[ReactionRoleManager] Added role ${roleId} to panel ${panel.id} (live message: ${liveMessage})`);
      return { success: true, liveMessage };
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

      const [removed] = await pool.execute(
        'SELECT emoji_id FROM reaction_role_mappings WHERE panel_id = ? AND role_id = ?',
        [panel.id, roleId]
      );

      await pool.execute(
        'DELETE FROM reaction_role_mappings WHERE panel_id = ? AND role_id = ?',
        [panel.id, roleId]
      );

      const [mappings] = await pool.execute(
        'SELECT id FROM reaction_role_mappings WHERE panel_id = ?',
        [panel.id]
      );

      if (mappings.length === 0) {
        await this.deletePanel(messageId);
        return { success: true, deleted: true };
      }

      // Reaction panels: pull the bot's own reaction so the emoji stops inviting clicks (as the dashboard does).
      if ((panel.interaction_type || 'reaction') === 'reaction') {
        const gone = removed.map(m => m.emoji_id).filter(Boolean);
        const channel = gone.length ? await this.client.channels.fetch(panel.channel_id).catch(() => null) : null;
        const message = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;
        for (const reaction of message?.reactions.cache.values() ?? []) {
          if (!emojiIdCandidates(reaction.emoji).some(c => gone.includes(c))) continue;
          await reaction.remove()
            .catch(() => reaction.users.remove(this.client.user.id))
            .catch((err) => logger.warn(`[ReactionRoleManager] Could not clear reaction on panel ${panel.id}: ${err.message}`));
        }
      }

      const liveMessage = await refreshPanelMessage({ guildId: panel.guild_id, panelId: panel.id, botClient: this.client });

      logger.info(`[ReactionRoleManager] Removed role ${roleId} from panel ${panel.id} (live message: ${liveMessage})`);
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
        'SELECT role_id, emoji_id, label, button_style, description, min_level FROM reaction_role_mappings WHERE panel_id = ?',
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
      logger.info(`[ReactionRoleManager] Reaction: user=${user.tag} emoji="${emojiId}" emojiName="${reaction.emoji.name}" emojiId="${reaction.emoji.id}" panelId=${panel.id} msgId=${message.id}`, { category: 'reaction-roles' });

      // Find the role mapping for this emoji (bare id, full <:name:id> token, or unicode)
      const candidates = emojiIdCandidates(reaction.emoji);
      const [mappings] = await pool.execute(
        `SELECT role_id FROM reaction_role_mappings WHERE panel_id = ? AND emoji_id IN (${candidates.map(() => '?').join(', ') || 'NULL'})`,
        [panel.id, ...candidates]
      );
      logger.info(`[ReactionRoleManager] Emoji lookup: panel=${panel.id} emoji="${emojiId}" found=${mappings.length} roles=${mappings.map(m=>m.role_id).join(',')}`, { category: 'reaction-roles' });

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
        // Only for grow community guilds that have this feature explicitly configured
        const GROW_GUILDS = ['1452972683867459657', '1452698337152336067'];
        if (role.name.toLowerCase().includes('verified') && GROW_GUILDS.includes(message.guild.id)) {
          await this.sendGrowWelcomeMessage(message.guild, member);
        }
      }
    } catch (error) {
      logger.error(`[ReactionRoleManager] Error in handleReactionAdd: ${error.message}`, {
        error: error.stack
      });
    }
  }

  async sendGrowWelcomeMessage(guild, member) {
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
      const attachment = accessibleAttachment(welcomeCardBuffer, {
        name: 'welcome.png',
        description: welcomeCardAltText({
          username: member.displayName || member.user.username,
          guildName: guild.name,
          memberCount: guild.memberCount,
        }),
      });

      // Find introductions channel for the embed
      const introChannel = guild.channels.cache.find(c => c.name.includes('introduction'));

      // Create welcome embed with the generated card as the image
      const embed = new EmbedBuilder()
        .setColor(themeColor(member.guild?.id, 'success'))
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

      // Find the role mapping for this emoji (bare id, full <:name:id> token, or unicode)
      const candidates = emojiIdCandidates(reaction.emoji);
      const [mappings] = await pool.execute(
        `SELECT role_id FROM reaction_role_mappings WHERE panel_id = ? AND emoji_id IN (${candidates.map(() => '?').join(', ') || 'NULL'})`,
        [panel.id, ...candidates]
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

/**
 * Build the embed + components for a stored panel.
 *
 * Extracted verbatim from the dashboard's post endpoint so posting a panel and refreshing an
 * already-posted panel can never drift — an edited panel must render exactly like a fresh one.
 * The button customIds (`rr_<roleId>`) and the select customId (`rr_select`) are what
 * interactionCreate dispatches on, so they must not change.
 *
 * @returns {Promise<{embeds: any[], components: any[], reactionEmojis: string[]}>}
 */
export async function buildPanelMessage({ panel, mappings, guild }) {
    const embed = new EmbedBuilder()
        .setTitle(panel.panel_name)
        .setColor(panel.embed_color || '#a78bfa');

    if (panel.description) embed.setDescription(panel.description);
    if (panel.thumbnail_url) embed.setThumbnail(panel.thumbnail_url);
    if (panel.image_url) embed.setImage(panel.image_url);

    const interactionType = panel.interaction_type || 'reaction';
    const roles = [];
    let rolesText = '';
    for (const mapping of mappings) {
        const role = guild?.roles.cache.get(mapping.role_id)
            || await guild?.roles.fetch(mapping.role_id).catch(() => null);
        const roleName = role ? role.name : 'Unknown Role';
        roles.push({
            roleId: mapping.role_id,
            emoji: mapping.emoji_id || undefined,
            label: mapping.label || roleName,
            name: roleName,
            description: mapping.description || `Get the ${roleName} role`,
            style: mapping.button_style || 'primary'
        });
        rolesText += interactionType === 'reaction'
            ? `${mapping.emoji_id || '▪️'} — <@&${mapping.role_id}>\n`
            : `▪️ <@&${mapping.role_id}>\n`;
    }
    if (rolesText) embed.addFields({ name: 'Available Roles', value: rolesText, inline: false });

    const styleMap = { primary: 1, secondary: 2, success: 3, danger: 4 };
    const components = [];
    const reactionEmojis = [];

    if (interactionType === 'button') {
        // Five buttons a row, five rows. (The old loop stopped at the first button of the fifth
        // row, so a panel showed 21 of its 25 roles.)
        for (const chunk of chunkButtons(roles)) {
            components.push(new ActionRowBuilder().addComponents(chunk.map(role => {
                const btn = new ButtonBuilder()
                    .setCustomId(`rr_${role.roleId}`)
                    .setLabel(role.label)
                    .setStyle(styleMap[role.style] || ButtonStyle.Primary);
                if (role.emoji) {
                    try {
                        btn.setEmoji(role.emoji.includes(':') ? role.emoji.split(':')[2].replace('>', '') : role.emoji);
                    } catch { /* skip emoji if invalid */ }
                }
                return btn;
            })));
        }

    } else if (interactionType === 'select_menu' || interactionType === 'select') {
        const options = roles.slice(0, 25).map(r => {
            const opt = { label: r.label, value: r.roleId, description: r.description };
            if (r.emoji) opt.emoji = r.emoji;
            return opt;
        });
        // placeholder_text / max_selections are stored per panel; fall back to the original
        // hard-coded behaviour when they're unset so existing panels render unchanged.
        const cap = panel.panel_mode === 'unique'
            ? 1
            : Math.min(options.length, panel.max_selections > 0 ? panel.max_selections : options.length);
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('rr_select')
            .setPlaceholder(panel.placeholder_text || 'Choose your roles')
            .setMinValues(panel.panel_mode === 'unique' ? 1 : 0)
            .setMaxValues(Math.max(1, cap))
            .addOptions(options);
        components.push(new ActionRowBuilder().addComponents(selectMenu));

    } else {
        for (const mapping of mappings) {
            if (mapping.emoji_id) reactionEmojis.push(mapping.emoji_id);
        }
    }

    return { embeds: [embed], components, reactionEmojis };
}

/**
 * Re-render an already-posted panel's message from its current DB row.
 *
 * Edits the existing message rather than reposting, so the message id, pins, and any links to
 * it keep working. Lives here rather than in the dashboard because three call sites need it —
 * the panel PUT, adding mappings, and removing them — and each used to carry its own copy of
 * the component-building code. Those copies drifted: the mapping ones edited `components`
 * without `embeds`, leaving the embed's "Available Roles" list stale, and hard-coded the
 * select placeholder over the panel's own setting.
 *
 * @returns {Promise<'updated'|'not_posted'|'message_gone'|'no_mappings'|'failed'>}
 */
export async function refreshPanelMessage({ guildId, panelId, botClient }) {
    try {
        const [[panel]] = await pool.execute(
            'SELECT * FROM reaction_role_panels WHERE id = ? AND guild_id = ?', [panelId, guildId]);
        if (!panel) return 'failed';
        if (!panel.message_id || panel.message_id === 'PENDING') return 'not_posted';

        const [mappings] = await pool.execute(
            'SELECT * FROM reaction_role_mappings WHERE panel_id = ? ORDER BY id ASC', [panelId]);
        if (mappings.length === 0) return 'no_mappings';

        const channel = await botClient?.channels.fetch(panel.channel_id).catch(() => null);
        const message = channel ? await channel.messages.fetch(panel.message_id).catch(() => null) : null;
        if (!message) return 'message_gone';

        const guild = botClient?.guilds?.cache?.get(guildId);
        const { embeds, components, reactionEmojis } = await buildPanelMessage({ panel, mappings, guild });
        await message.edit({ embeds, components });

        // Reaction panels also need any newly added emoji present on the message.
        for (const emoji of reactionEmojis) {
            if (message.reactions.cache.some(r => r.emoji.name === emoji || r.emoji.id === emoji)) continue;
            await message.react(emoji).catch(() => {});
        }

        logger.info(`[Reaction Roles] Refreshed live message ${panel.message_id} for panel ${panelId}`);
        return 'updated';
    } catch (error) {
        logger.error(`[Reaction Roles] Live refresh failed for panel ${panelId}: ${error.message}`);
        return 'failed';
    }
}

/**
 * Post a stored panel to its channel and record the new message id.
 *
 * Shared by the dashboard's "Post to Discord" and "Repost" buttons so the two can't drift.
 * The DB write happens right after the send — a posted message the row doesn't know about is
 * a panel nobody can manage.
 *
 * @returns {Promise<{ok: true, message: object} | {ok: false, error: string}>}
 */
export async function postPanelMessage({ panel, mappings, botClient }) {
    if (!mappings?.length) {
        return { ok: false, error: 'No role mappings found. Add at least one role mapping before posting.' };
    }
    if (!botClient) return { ok: false, error: 'Bot client not available' };

    const channel = await botClient.channels.fetch(panel.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        return { ok: false, error: 'Channel not found, or I cannot see it' };
    }

    const guild = botClient.guilds.cache.get(panel.guild_id);
    const { embeds, components, reactionEmojis } = await buildPanelMessage({ panel, mappings, guild });

    const message = await channel.send({ embeds, components });

    await pool.execute('UPDATE reaction_role_panels SET message_id = ? WHERE id = ?', [message.id, panel.id]);

    for (const emoji of reactionEmojis) {
        await message.react(emoji).catch(err =>
            logger.warn(`[Reaction Roles] Failed to add reaction ${emoji}: ${err.message}`));
    }

    logger.info(`[Reaction Roles] Panel ${panel.id} posted to ${channel.id} as message ${message.id}`);
    return { ok: true, message };
}

export default ReactionRoleManager;
