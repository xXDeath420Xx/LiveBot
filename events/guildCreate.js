import { Events, REST, Routes } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { postOrientationMessage, findSuitableChannel } from '../core/orientation-manager.js';
import { logFeatureEvent } from '../core/feature-log.js';
import { notifyOwnerOfInstall } from '../utils/owner-install-notifier.js';
import { fitCustomBotCommands, MAX_SLASH_COMMANDS } from '../core/custom-bot-commands.js';
import { buildShortcutJson, shortcutNamesByGuild } from '../core/guild-shortcuts.js';
import { buildDeployJson } from '../core/command-mounts.js';
import { jellyfinGuildCommandData } from '../cf-jellyfin/cf-jellyfin-commands.js';

export default {
  name: Events.GuildCreate,
  async execute(guild) {
    const botTag = guild.client.botName || guild.client.user?.username || 'bot';
    logger.info(`[GuildCreate] ${botTag} joined guild: ${guild.name} (${guild.id}) — ${guild.memberCount} members`);

    // Classify this GuildCreate: Discord sends one per guild during the client
    // READY handshake, so the vast majority are "startup fill" of guilds we were
    // already in. The DB row from the prior session is the discriminator:
    //   - no prior row       -> true fresh install (first time this bot was ever here)
    //   - prior.left_at set  -> rejoin after a departure
    //   - prior row + null   -> startup/reconnect fill, suppress install DMs
    let previousLeftAt = null;
    let isNewInstall = false;
    try {
      const [[prior]] = await pool.execute('SELECT left_at FROM guilds WHERE guild_id = ?', [guild.id]);
      if (!prior) {
        isNewInstall = true;
      } else {
        previousLeftAt = prior.left_at || null;
      }
    } catch { /* classification is best-effort; on error default to suppress the DM */ }

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
      if (previousLeftAt) {
        const leftMs = new Date(previousLeftAt).getTime();
        void logFeatureEvent(() => (guild), 'system.rejoined', () => ({
          title: '🤖 Bot Rejoined Server',
          description: `**${botTag}** was added back to this server.`,
          fields: [
            ['Bot', guild.client.user ? `<@${guild.client.user.id}>` : botTag],
            ['Left', Number.isFinite(leftMs) ? `<t:${Math.floor(leftMs / 1000)}:R>` : null],
            ['Members', guild.memberCount],
          ],
        }));
      }
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

        const extras = jellyfinGuildCommandData(guild.id);
        const builtCommands = buildDeployJson(Array.from(guild.client.commands?.values() || []).filter(c => c.data?.toJSON));
        const base = fitCustomBotCommands(builtCommands, extras.length).commands;
        // Per-server shortcuts (core/guild-shortcuts.js), only into slots the real commands leave free.
        const names = (await shortcutNamesByGuild([guild.id]).catch(() => new Map())).get(guild.id) || [];
        const free = MAX_SLASH_COMMANDS - base.filter(c => (c.type ?? 1) === 1).length - extras.length;
        const commandData = [...base, ...extras, ...buildShortcutJson(builtCommands, names).slice(0, Math.max(0, free))];
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
        void logFeatureEvent(() => (guild), 'system.commandsFailed', () => ({
          title: '❌ Command Registration Failed',
          description: `**${botTag}** joined but could not register its slash commands here, so some commands may be missing.`,
          fields: [['Bot', botTag], ['Why', String(error.message || 'Unknown error').slice(0, 300)]],
          throttle: { key: 'cmds-fail:' + guild.id, ms: 6 * 3600e3 },
        }));
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

    // DM the bot owner with a full install summary ONLY for a true fresh install
    // or a rejoin after departure. GuildCreate also fires once per existing guild
    // during the client's READY handshake, so without this guard every pm2
    // restart would DM 40+ times.
    if (isNewInstall || previousLeftAt) {
      // Always via the default bot (so a branded custom bot entering a server
      // where the default isn't present still produces a notification).
      // Fire-and-forget so a DM failure never breaks the join flow.
      void notifyOwnerOfInstall(guild, { previousLeftAt });
    }
  }
};
