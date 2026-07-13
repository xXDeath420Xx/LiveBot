import { Events, REST, Routes } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { postOrientationMessage, findSuitableChannel } from '../core/orientation-manager.js';

export default {
  name: Events.GuildCreate,
  async execute(guild) {
    const botTag = guild.client.botName || guild.client.user?.username || 'bot';
    logger.info(`[GuildCreate] ${botTag} joined guild: ${guild.name} (${guild.id}) — ${guild.memberCount} members`);

    try {
      await pool.execute(`
        INSERT INTO guilds (guild_id, guild_name, owner_id, icon_hash, member_count, last_seen)
        VALUES (?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          guild_name = VALUES(guild_name),
          owner_id = VALUES(owner_id),
          icon_hash = VALUES(icon_hash),
          member_count = VALUES(member_count),
          last_seen = NOW(),
          left_at = NULL
      `, [guild.id, guild.name, guild.ownerId, guild.icon, guild.memberCount]);
    } catch (error) {
      logger.error('[GuildCreate] Failed to upsert guild record', {
        error: error.message,
        guildId: guild.id
      });
    }

    // Custom-bot auto-deployment: when a non-default bot enters a guild,
    // push the full CertiFried command set to that guild immediately so the
    // owner doesn't have to invite the default bot or trigger a separate deploy.
    const isCustomBot = guild.client.isDefaultBot === false && guild.client.botId;
    if (isCustomBot) {
      const botId = guild.client.botId;
      try {
        // Ensure guild_bot_mapping reflects reality (idempotent)
        await pool.execute(
          `INSERT INTO guild_bot_mapping (guild_id, bot_id, assigned_at, assigned_by)
           VALUES (?, ?, NOW(), ?)
           ON DUPLICATE KEY UPDATE bot_id = VALUES(bot_id), assigned_at = NOW()`,
          [guild.id, botId, guild.ownerId]
        );

        const commandData = Array.from(guild.client.commands?.values() || []).map(c => c.data.toJSON());
        if (commandData.length > 0 && guild.client.token) {
          const rest = new REST().setToken(guild.client.token);
          await rest.put(
            Routes.applicationGuildCommands(botId, guild.id),
            { body: commandData }
          );
          logger.info(`[GuildCreate] Auto-deployed ${commandData.length} slash commands to ${guild.name} for custom bot ${botTag} (${botId})`);
        } else {
          logger.warn(`[GuildCreate] Custom bot ${botId} entered ${guild.id} but no commands available to deploy`);
        }
      } catch (error) {
        logger.error('[GuildCreate] Failed to auto-deploy commands for custom bot', {
          error: error.message,
          botId,
          guildId: guild.id
        });
      }
    }

    // Auto-post orientation message (skip YYZ Studio)
    if (guild.id !== '961514092848382043') {
      try {
        const channel = findSuitableChannel(guild);
        if (channel) {
          await postOrientationMessage(guild.client, guild.id, channel.id);
          logger.info(`[GuildCreate] Posted orientation message in ${guild.name} (#${channel.name})`);
        }
      } catch (error) {
        logger.error('[GuildCreate] Failed to post orientation message', {
          error: error.message,
          guildId: guild.id
        });
      }
    }
  }
};
