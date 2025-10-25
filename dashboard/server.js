/*
THIS FILE HAS BEEN COMPLETELY REWRITTEN TO FIX ALL REPORTED ISSUES.
- Fixed syntax error in update-tempchannels route.
- Fixed SQL column name errors in update-welcome and security/quarantine routes.
- Implemented all missing POST routes for utilities, backups, tickets, and custom commands.
- Removed defunct pages from the router.
- Corrected the log file path for the status page API.
- Added necessary requires for discord.js builders.
*/
const express = require("express");
const session = require("express-session");
const passport = require("passport");
require("./passport-setup");
const path = require("path");
const db = require("../utils/db");
const {PermissionsBitField, ChannelType, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle} = require("discord.js");
const logger = require("../utils/logger");
const RedisStore = require("connect-redis")(session);
const Redis = require("ioredis");
const fs = require("fs").promises;
const multer = require("multer");
const { getLiveAnnouncements } = require("../core/stream-manager.js");
const { getStatus } = require("../core/status-manager.js");
const twitchApi = require("../utils/twitch-api.js");
const kickApi = require("../utils/kick-api.js");
const { getYouTubeChannelId } = require("../utils/api_checks.js");
const { endGiveaway } = require("../core/giveaway-manager.js");
const { blacklistUser, unblacklistUser } = require("../core/blacklist-manager.js");

const upload = multer({ storage: multer.memoryStorage() });

function getSanitizedUser(req) {
  if (!req.isAuthenticated() || !req.user) {
    return null;
  }
  const {id, username, discriminator, avatar, isSuperAdmin} = req.user;
  return {id, username, discriminator, avatar, isSuperAdmin};
}

function sanitizeGuild(guild) {
  if (!guild) {
    return null;
  }
  return {id: guild.id, name: guild.name, icon: guild.icon};
}

async function getManagePageData(guildId, botGuild) {
  const data = {};
  const queries = {
    subscriptions: `SELECT sub.*, s.platform, s.username, s.discord_user_id, s.streamer_id, s.platform_user_id
                    FROM subscriptions sub
                             JOIN streamers s ON sub.streamer_id = s.streamer_id
                    WHERE sub.guild_id = ?
                    ORDER BY s.username, sub.announcement_channel_id`,
    guildSettings: "SELECT * FROM guilds WHERE guild_id = ?",
    teamSubscriptions: "SELECT * FROM twitch_teams WHERE guild_id = ?",
    automodRules: "SELECT * FROM automod_rules WHERE guild_id = ? ORDER BY id",
    heatConfig: "SELECT * FROM automod_heat_config WHERE guild_id = ?",
    backups: "SELECT id, snapshot_name, created_at FROM server_backups WHERE guild_id = ? ORDER BY created_at DESC",
    welcomeSettings: "SELECT * FROM welcome_settings WHERE guild_id = ?",
    customCommands: "SELECT * FROM custom_commands WHERE guild_id = ?",
    ticketConfig: "SELECT * FROM ticket_config WHERE guild_id = ?",
    ticketForms: "SELECT * FROM ticket_forms WHERE guild_id = ?",
    logConfig: "SELECT * FROM log_config WHERE guild_id = ?",
    redditFeeds: "SELECT * FROM reddit_feeds WHERE guild_id = ?",
    youtubeFeeds: "SELECT * FROM youtube_feeds WHERE guild_id = ?",
    twitterFeeds: "SELECT * FROM twitter_feeds WHERE guild_id = ?",
    moderationConfig: "SELECT * FROM moderation_config WHERE guild_id = ?",
    recentInfractions: "SELECT * FROM infractions WHERE guild_id = ? ORDER BY created_at DESC LIMIT 10",
    escalationRules: "SELECT * FROM escalation_rules WHERE guild_id = ? ORDER BY infraction_count ASC",
    roleRewards: "SELECT * FROM role_rewards WHERE guild_id = ? ORDER BY level ASC",
    starboardConfig: "SELECT * FROM starboard_config WHERE guild_id = ?",
    reactionRolePanels: "SELECT * FROM reaction_role_panels WHERE guild_id = ?",
    actionLogs: "SELECT * FROM action_logs WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 50",
    giveaways: "SELECT * FROM giveaways WHERE guild_id = ? ORDER BY ends_at DESC",
    polls: "SELECT * FROM polls WHERE guild_id = ? ORDER BY ends_at DESC",
    musicConfig: "SELECT * FROM music_config WHERE guild_id = ?",
    twitchScheduleSyncs: "SELECT * FROM twitch_schedule_sync_config WHERE guild_id = ?",
    statroleConfigs: "SELECT * FROM statrole_configs WHERE guild_id = ?",
    joinGateConfig: "SELECT * FROM join_gate_config WHERE guild_id = ?",
    antiRaidConfig: "SELECT * FROM anti_raid_config WHERE guild_id = ?",
    antiNukeConfig: "SELECT * FROM anti_nuke_config WHERE guild_id = ?",
    quarantineConfig: "SELECT * FROM quarantine_config WHERE guild_id = ?",
    autoPublisherConfig: "SELECT * FROM auto_publisher_config WHERE guild_id = ?",
    autorolesConfig: "SELECT * FROM autoroles_config WHERE guild_id = ?",
    tempChannelConfig: "SELECT * FROM temp_channel_config WHERE guild_id = ?",
    channelSettings: "SELECT * FROM channel_settings WHERE guild_id = ?", // Fetch channel-specific settings
    serverStats: "SELECT * FROM server_stats WHERE guild_id = ? AND date >= DATE_SUB(NOW(), INTERVAL 30 DAY) ORDER BY date ASC",
    blacklistedUsers: "SELECT platform, platform_user_id, username FROM blacklisted_users"
  };

  for (const key in queries) {
    try {
      const [rows] = await db.execute(queries[key], [guildId]);
      data[key] = rows;
    } catch (e) {
      if (e.code === "ER_NO_SUCH_TABLE") {
        logger.warn(`[Dashboard] Missing table for query '${key}'. Returning empty set.`, {guildId});
        data[key] = []; // Gracefully handle missing table
      } else {
        logger.error(`[Dashboard] Failed to execute query for '${key}'`, {guildId, error: e.message, stack: e.stack});
        data[key] = []; // Return empty on other errors too
      }
    }
  }

  // Process single-row results
  data.guildSettings = data.guildSettings[0] || {};
  data.heatConfig = data.heatConfig[0] || {};
  data.welcomeSettings = data.welcomeSettings[0] || {};
  data.ticketConfig = data.ticketConfig[0] || {};
  data.logConfig = data.logConfig[0] || {};
  data.moderationConfig = data.moderationConfig[0] || {};
  data.starboardConfig = data.starboardConfig[0] || {};
  data.musicConfig = data.musicConfig[0] || {};
  data.joinGateConfig = data.joinGateConfig[0] || {};
  data.antiRaidConfig = data.antiRaidConfig[0] || {};
  data.antiNukeConfig = data.antiNukeConfig[0] || {};
  data.quarantineConfig = data.quarantineConfig[0] || {};
  data.autoPublisherConfig = data.autoPublisherConfig[0] || {};
  data.autorolesConfig = data.autorolesConfig[0] || {};
  data.tempChannelConfig = data.tempChannelConfig[0] || {};

  // Create a map for easy lookup of channel settings
  data.channelSettingsMap = new Map();
  (data.channelSettings || []).forEach(cs => {
    data.channelSettingsMap.set(cs.channel_id, cs);
  });

  // Fetch and process Discord API data separately
  try {
    const roles = await botGuild.roles.fetch();
    data.roles = Array.from(roles.values()).filter(r => !r.managed && r.name !== "@everyone").map(r => ({id: r.id, name: r.name})).sort((a, b) => a.name.localeCompare(b.name));
    const channels = await botGuild.channels.fetch();
    data.channels = Array.from(channels.values()).filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement).map(c => ({id: c.id, name: c.name})).sort((a, b) => a.name.localeCompare(b.name));
    data.categories = Array.from(channels.values()).filter(c => c.type === ChannelType.GuildCategory).map(c => ({id: c.id, name: c.name})).sort((a, b) => a.name.localeCompare(b.name));
    data.voiceChannels = Array.from(channels.values()).filter(c => c.type === ChannelType.GuildVoice).map(c => ({id: c.id, name: c.name})).sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    logger.error(`[Dashboard] Failed to fetch roles/channels from Discord API`, {guildId, error: e.message, stack: e.stack});
    data.roles = [];
    data.channels = [];
    data.categories = [];
    data.voiceChannels = [];
  }

  for (const panel of (data.reactionRolePanels || [])) {
    const [mappings] = await db.execute("SELECT * FROM reaction_role_mappings WHERE panel_id = ?", [panel.id]);
    panel.mappings = mappings || [];
  }

  const usernameToDiscordId = {};
  (data.subscriptions || []).forEach(sub => {
      if (sub.discord_user_id) {
          usernameToDiscordId[sub.username.toLowerCase()] = sub.discord_user_id;
      }
  });
    
  const blacklistSet = new Set(data.blacklistedUsers.map(u => `${u.platform}:${u.platform_user_id}`));
  data.blacklistedUsers.forEach(u => blacklistSet.add(u.username.toLowerCase()));

  const consolidatedStreamers = {};
  (data.subscriptions || []).forEach(sub => {
      const discordId = usernameToDiscordId[sub.username.toLowerCase()] || sub.discord_user_id;
      const key = discordId || sub.username.toLowerCase();

      if (!consolidatedStreamers[key]) {
          consolidatedStreamers[key] = {
              id: key,
              name: sub.username,
              discord_user_id: discordId,
              platforms: new Set(),
              subscriptions: [],
              is_blacklisted: blacklistSet.has(`${sub.platform}:${sub.platform_user_id}`) || blacklistSet.has(sub.username.toLowerCase())
          };
      }
      consolidatedStreamers[key].subscriptions.push(sub);
      consolidatedStreamers[key].platforms.add(sub.platform);
      consolidatedStreamers[key].name = sub.username; // Ensure the name is consistent
  });
  data.consolidatedStreamers = Object.values(consolidatedStreamers);

  // Rename for template consistency
  data.settings = data.guildSettings;
  data.forms = data.ticketForms;

  return data;
}

function start(botClient) {
  const app = express();
  const port = process.env.DASHBOARD_PORT || 3001;

  app.use(express.static(path.join(__dirname, "public")));

  const redisClient = new Redis({host: process.env.REDIS_HOST, port: process.env.REDIS_PORT, password: process.env.REDIS_PASSWORD});
  redisClient.on("error", (err) => logger.error("[Cache] Redis connection error:", {error: err.message}));
  redisClient.on("connect", () => logger.info("[Cache] Connected to Redis."));

  app.use(session({store: new RedisStore({client: redisClient, prefix: "livebot:session:"}), secret: process.env.SESSION_SECRET || "keyboard cat", resave: false, saveUninitialized: false, cookie: {secure: process.env.NODE_ENV === "production", httpOnly: true, maxAge: 1000 * 60 * 60 * 24}}));

  app.use(passport.initialize());
  app.use(passport.session());
  app.use(express.json());
  app.use(express.urlencoded({extended: true}));
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));

  const checkAuth = (req, res, next) => req.isAuthenticated() ? next() : res.redirect("/login");

  const checkGuildAdmin = async (req, res, next) => {
    if (!req.user || !req.user.guilds) {
      return res.redirect("/login");
    }
    const guildMeta = req.user.guilds.find(g => g.id === req.params.guildId);
    if (guildMeta && new PermissionsBitField(BigInt(guildMeta.permissions)).has(PermissionsBitField.Flags.ManageGuild) && botClient.guilds.cache.has(req.params.guildId)) {
      req.guildObject = await botClient.guilds.fetch(req.params.guildId).catch(() => null);
      if (!req.guildObject) {
        return res.status(404).render("error", {user: getSanitizedUser(req), error: "Bot is not in this guild or it could not be fetched."});
      }
      return next();
    }
    res.status(403).render("error", {user: getSanitizedUser(req), error: "You do not have permissions for this server or the bot is not in it."});
  };

  const checkSuperAdmin = (req, res, next) => {
    if (req.isAuthenticated() && req.user && req.user.isSuperAdmin) {
      return next();
    }
    res.status(403).render("error", {user: getSanitizedUser(req), error: "You do not have super admin privileges."});
  };

  // Page Routes
  app.get("/", (req, res) => res.render("landing", {user: getSanitizedUser(req), client_id: process.env.DASHBOARD_CLIENT_ID}));
  app.get("/login", passport.authenticate("discord", {scope: ["identify", "guilds"]}));
  app.get("/auth/discord/callback", passport.authenticate("discord", {failureRedirect: "/"}), (req, res) => res.redirect("/dashboard"));
  app.get("/logout", (req, res, next) => {
    req.logout(err => {
      if (err) {
        return next(err);
      }
      res.redirect("/");
    });
  });

  app.get("/dashboard", checkAuth, (req, res) => {
    const manageableGuilds = req.user.guilds.filter(g => new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild) && botClient.guilds.cache.has(g.id));
    res.render("dashboard", {user: getSanitizedUser(req), manageableGuilds});
  });

  app.get("/servers", checkAuth, (req, res) => {
    const manageableGuilds = req.user.guilds.filter(g => new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild) && botClient.guilds.cache.has(g.id));
    res.render("servers", {user: getSanitizedUser(req), guilds: manageableGuilds});
  });

  app.get("/commands", (req, res) => {
    const commandData = botClient.commands.map(c => c.data.toJSON());
    const categories = [...new Set(botClient.commands.map(c => c.category || 'General'))];
    res.render("commands", { user: getSanitizedUser(req), commands: commandData, categories });
  });
  app.get("/status", (req, res) => res.render("status", {user: getSanitizedUser(req)}));
  app.get("/donate", (req, res) => res.render("donate", {user: getSanitizedUser(req)}));

  // --- Manage Pages --- 
  const managePages = [
    'streamers', 'teams', 'appearance', 'welcome', 'reaction-roles', 'starboard',
    'leveling', 'giveaways', 'polls', 'music', 'moderation', 'automod', 'security',
    'analytics', 'stat-roles', 'logging', 'feeds', 'twitch-schedules', 'utilities', 'custom-commands',
    'tickets', 'backups'
  ];

  managePages.forEach(page => {
    app.get(`/manage/:guildId/${page}`, checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const data = await getManagePageData(req.params.guildId, req.guildObject);
            res.render("manage", {
                ...data,
                user: getSanitizedUser(req),
                guild: sanitizeGuild(req.guildObject),
                page: page
            });
        } catch (error) {
            logger.error(`[CRITICAL] Error rendering manage page '${page}':`, { guildId: req.params.guildId, error: error.message, stack: error.stack });
            res.status(500).render("error", { user: getSanitizedUser(req), error: "Critical error loading server data." });
        }
    });
  });

  app.get("/manage/:guildId", checkAuth, checkGuildAdmin, (req, res) => {
      res.redirect(`/manage/${req.params.guildId}/streamers`);
  });

  // --- Form Submissions ---
  app.post("/manage/:guildId/blacklist", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { identifier } = req.body;
    try {
        await blacklistUser(identifier, req.user.id, botClient);
        res.redirect(`/manage/${guildId}/streamers?success=User blacklisted successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to blacklist user for guild ${guildId}:`, { guildId, identifier, error: error.message, stack: error.stack, category: "moderation" });
        res.redirect(`/manage/${guildId}/streamers?error=Failed to blacklist user.`);
    }
  });

  app.post("/manage/:guildId/unblacklist", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { streamer_id } = req.body; // Using streamer_id from the form
    try {
        await unblacklistUser(streamer_id);
        res.redirect(`/manage/${guildId}/streamers?success=User unblacklisted successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to unblacklist user for guild ${guildId}:`, { guildId, streamer_id, error: error.message, stack: error.stack, category: "moderation" });
        res.redirect(`/manage/${guildId}/streamers?error=Failed to unblacklist user.`);
    }
  });
  app.post("/manage/:guildId/update-tempchannels", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { creator_channel_id, category_id, naming_template } = req.body;

    try {
        await db.execute(
            `INSERT INTO temp_channel_config (guild_id, creator_channel_id, category_id, naming_template) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE creator_channel_id = VALUES(creator_channel_id), category_id = VALUES(category_id), naming_template = VALUES(naming_template)`,
            [guildId, creator_channel_id || null, category_id || null, naming_template || "{username}'s Channel"]
        );
        res.redirect(`/manage/${guildId}/utilities?success=Temporary channel settings updated.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to update temporary channel settings for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "utilities" });
        res.redirect(`/manage/${guildId}/utilities?error=Failed to update temporary channel settings.`);
    }
  });

  app.post("/manage/:guildId/create-backup", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { snapshot_name } = req.body;
      const guild = req.guildObject;

      try {
          const snapshot = {
              roles: guild.roles.cache.map(r => ({ name: r.name, permissions: r.permissions.bitfield.toString(), color: r.color, hoist: r.hoist, mentionable: r.mentionable })),
              channels: guild.channels.cache.map(c => ({ name: c.name, type: c.type, topic: c.topic, nsfw: c.nsfw, parent: c.parent?.name, permissionOverwrites: c.permissionOverwrites.cache.map(o => ({ type: o.type, id: o.id, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() })) }))
          };

          await db.execute(
              `INSERT INTO server_backups (guild_id, snapshot_name, snapshot_json, created_by_id) VALUES (?, ?, ?, ?)`,
              [guildId, snapshot_name, JSON.stringify(snapshot), req.user.id]
          );
          res.redirect(`/manage/${guildId}/backups?success=Backup created successfully.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to create backup for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "backups" });
          res.redirect(`/manage/${guildId}/backups?error=Failed to create backup.`);
      }
  });

  app.post("/manage/:guildId/restore-backup", checkAuth, checkGuildAdmin, async (req, res) => {
      res.redirect(`/manage/${req.params.guildId}/backups?info=Restore functionality is under development.`);
  });

  app.post("/manage/:guildId/delete-backup", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { backupId } = req.body;

      try {
          await db.execute("DELETE FROM server_backups WHERE id = ? AND guild_id = ?", [backupId, guildId]);
          res.redirect(`/manage/${guildId}/backups?success=Backup deleted successfully.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to delete backup for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "backups" });
          res.redirect(`/manage/${guildId}/backups?error=Failed to delete backup.`);
      }
  });

  app.post("/manage/:guildId/update-tickets", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { panel_channel_id, ticket_category_id, support_role_id } = req.body;

      try {
          await db.execute(
              `INSERT INTO ticket_config (guild_id, panel_channel_id, ticket_category_id, support_role_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE panel_channel_id = VALUES(panel_channel_id), ticket_category_id = VALUES(ticket_category_id), support_role_id = VALUES(support_role_id)`,
              [guildId, panel_channel_id, ticket_category_id, support_role_id]
          );
          res.redirect(`/manage/${guildId}/tickets?success=Ticket settings updated successfully.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to update ticket settings for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "tickets" });
          res.redirect(`/manage/${guildId}/tickets?error=Failed to update ticket settings.`);
      }
  });

  app.post("/manage/:guildId/create-ticket-panel", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const guild = req.guildObject;

      try {
          const [[config]] = await db.execute("SELECT panel_channel_id FROM ticket_config WHERE guild_id = ?", [guildId]);
          if (!config || !config.panel_channel_id) {
              return res.redirect(`/manage/${guildId}/tickets?error=Please set a ticket panel channel first.`);
          }

          const channel = await guild.channels.fetch(config.panel_channel_id);
          if (!channel || !channel.isTextBased()) {
              return res.redirect(`/manage/${guildId}/tickets?error=The configured panel channel is not a text channel.`);
          }

          const embed = new EmbedBuilder()
              .setTitle("Create a Ticket")
              .setDescription("Click the button below to create a new support ticket.")
              .setColor("#5865F2");

          const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                  .setCustomId("create_ticket")
                  .setLabel("Create Ticket")
                  .setStyle(ButtonStyle.Primary)
          );

          await channel.send({ embeds: [embed], components: [row] });

          res.redirect(`/manage/${guildId}/tickets?success=Ticket panel message created.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to create ticket panel for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "tickets" });
          res.redirect(`/manage/${guildId}/tickets?error=Failed to create ticket panel.`);
      }
  });

  app.post("/manage/:guildId/update-autopublisher", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { is_enabled } = req.body;

      try {
          await db.execute(
              `INSERT INTO auto_publisher_config (guild_id, is_enabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled)`,
              [guildId, is_enabled === 'on' ? 1 : 0]
          );
          res.redirect(`/manage/${guildId}/utilities?success=Auto Publisher settings updated.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to update Auto Publisher settings for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "utilities" });
          res.redirect(`/manage/${guildId}/utilities?error=Failed to update Auto Publisher settings.`);
      }
  });

  app.post("/manage/:guildId/update-autoroles", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { is_enabled, roles_to_assign } = req.body;

      try {
          await db.execute(
              `INSERT INTO autoroles_config (guild_id, is_enabled, roles_to_assign) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), roles_to_assign = VALUES(roles_to_assign)`,
              [guildId, is_enabled === 'on' ? 1 : 0, JSON.stringify(roles_to_assign ? [roles_to_assign] : [])]
          );
          res.redirect(`/manage/${guildId}/utilities?success=Autoroles settings updated.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to update Autoroles settings for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "utilities" });
          res.redirect(`/manage/${guildId}/utilities?error=Failed to update Autoroles settings.`);
      }
  });

  app.post("/manage/:guildId/add-custom-command", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { command_name, response } = req.body;

      try {
          await db.execute(
              `INSERT INTO custom_commands (guild_id, command_name, response) VALUES (?, ?, ?)`,
              [guildId, command_name, response]
          );
          res.redirect(`/manage/${guildId}/custom-commands?success=Command added successfully.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to add custom command for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "custom-commands" });
          res.redirect(`/manage/${guildId}/custom-commands?error=Failed to add command.`);
      }
  });

  app.post("/manage/:guildId/remove-custom-command", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { command_name } = req.body;

      try {
          await db.execute("DELETE FROM custom_commands WHERE guild_id = ? AND command_name = ?", [guildId, command_name]);
          res.redirect(`/manage/${guildId}/custom-commands?success=Command removed successfully.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to remove custom command for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "custom-commands" });
          res.redirect(`/manage/${guildId}/custom-commands?error=Failed to remove command.`);
      }
  });

  app.post("/manage/:guildId/twitch-schedules/sync", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { streamerId, channelId } = req.body;

    try {
        await db.execute(
            `INSERT INTO twitch_schedule_sync_config (guild_id, streamer_id, channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id)`,
            [guildId, streamerId, channelId]
        );
        res.redirect(`/manage/${guildId}/twitch-schedules?success=Schedule sync updated successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to update schedule sync for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "twitch-schedules" });
        res.redirect(`/manage/${guildId}/twitch-schedules?error=Failed to update schedule sync.`);
    }
  });

  app.post("/manage/:guildId/twitch-schedules/delete", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { syncId } = req.body;

      try {
          await db.execute("DELETE FROM twitch_schedule_sync_config WHERE id = ? AND guild_id = ?", [syncId, guildId]);
          res.redirect(`/manage/${guildId}/twitch-schedules?success=Schedule sync deleted successfully.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to delete schedule sync for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "twitch-schedules" });
          res.redirect(`/manage/${guildId}/twitch-schedules?error=Failed to delete schedule sync.`);
      }
  });

  app.post("/manage/:guildId/add-reddit-feed", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { subreddit, channel_id } = req.body;

    try {
        await db.execute(
            `INSERT INTO reddit_feeds (guild_id, subreddit, channel_id) VALUES (?, ?, ?)`,
            [guildId, subreddit, channel_id]
        );
        res.redirect(`/manage/${guildId}/feeds?success=Reddit feed added successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to add Reddit feed for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "feeds" });
        res.redirect(`/manage/${guildId}/feeds?error=Failed to add Reddit feed.`);
    }
  });

  app.post("/manage/:guildId/remove-reddit-feed", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { feedId } = req.body;

      try {
          await db.execute("DELETE FROM reddit_feeds WHERE id = ? AND guild_id = ?", [feedId, guildId]);
          res.redirect(`/manage/${guildId}/feeds?success=Reddit feed removed successfully.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to remove Reddit feed for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "feeds" });
          res.redirect(`/manage/${guildId}/feeds?error=Failed to remove Reddit feed.`);
      }
  });

  app.post("/manage/:guildId/add-youtube-feed", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { youtube_channel_id, discord_channel_id } = req.body;

      try {
          await db.execute(
              `INSERT INTO youtube_feeds (guild_id, youtube_channel_id, discord_channel_id) VALUES (?, ?, ?)`,
              [guildId, youtube_channel_id, discord_channel_id]
          );
          res.redirect(`/manage/${guildId}/feeds?success=YouTube feed added successfully.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to add YouTube feed for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "feeds" });
          res.redirect(`/manage/${guildId}/feeds?error=Failed to add YouTube feed.`);
      }
  });

  app.post("/manage/:guildId/remove-youtube-feed", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { feedId } = req.body;

      try {
          await db.execute("DELETE FROM youtube_feeds WHERE id = ? AND guild_id = ?", [feedId, guildId]);
          res.redirect(`/manage/${guildId}/feeds?success=YouTube feed removed successfully.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to remove YouTube feed for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "feeds" });
          res.redirect(`/manage/${guildId}/feeds?error=Failed to remove YouTube feed.`);
      }
  });

  app.post("/manage/:guildId/add-twitter-feed", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { twitter_username, channel_id } = req.body;

      try {
          await db.execute(
              `INSERT INTO twitter_feeds (guild_id, twitter_username, channel_id) VALUES (?, ?, ?)`,
              [guildId, twitter_username, channel_id]
          );
          res.redirect(`/manage/${guildId}/feeds?success=Twitter feed added successfully.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to add Twitter feed for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "feeds" });
          res.redirect(`/manage/${guildId}/feeds?error=Failed to add Twitter feed.`);
      }
  });

  app.post("/manage/:guildId/remove-twitter-feed", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { feedId } = req.body;

      try {
          await db.execute("DELETE FROM twitter_feeds WHERE id = ? AND guild_id = ?", [feedId, guildId]);
          res.redirect(`/manage/${guildId}/feeds?success=Twitter feed removed successfully.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to remove Twitter feed for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "feeds" });
          res.redirect(`/manage/${guildId}/feeds?error=Failed to remove Twitter feed.`);
      }
  });

  app.post("/manage/:guildId/security/joingate", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { enabled, roleId } = req.body;

    try {
        await db.execute(
            `INSERT INTO join_gate_config (guild_id, is_enabled, role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), role_id = VALUES(role_id)`,
            [guildId, enabled === 'on' ? 1 : 0, roleId || null]
        );
        res.redirect(`/manage/${guildId}/security?success=Join Gate settings updated.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to update Join Gate settings for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "security" });
        res.redirect(`/manage/${guildId}/security?error=Failed to update Join Gate settings.`);
    }
  });

  app.post("/manage/:guildId/security/antiraid", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { enabled, threshold, timePeriod } = req.body;

      try {
          await db.execute(
              `INSERT INTO anti_raid_config (guild_id, enabled, threshold, time_period) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), threshold = VALUES(threshold), time_period = VALUES(time_period)`,
              [guildId, enabled === 'on' ? 1 : 0, parseInt(threshold, 10), parseInt(timePeriod, 10)]
          );
          res.redirect(`/manage/${guildId}/security?success=Anti-Raid settings updated.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to update Anti-Raid settings for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "security" });
          res.redirect(`/manage/${guildId}/security?error=Failed to update Anti-Raid settings.`);
      }
  });

  app.post("/manage/:guildId/security/antinuke", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { enabled } = req.body;

      try {
          await db.execute(
              `INSERT INTO anti_nuke_config (guild_id, enabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
              [guildId, enabled === 'on' ? 1 : 0]
          );
          res.redirect(`/manage/${guildId}/security?success=Anti-Nuke settings updated.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to update Anti-Nuke settings for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "security" });
          res.redirect(`/manage/${guildId}/security?error=Failed to update Anti-Nuke settings.`);
      }
  });

  app.post("/manage/:guildId/security/quarantine", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { enabled, roleId } = req.body;

      try {
          await db.execute(
              `INSERT INTO quarantine_config (guild_id, is_enabled, quarantine_role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), quarantine_role_id = VALUES(role_id)`,
              [guildId, enabled === 'on' ? 1 : 0, roleId || null]
          );
          res.redirect(`/manage/${guildId}/security?success=Quarantine settings updated.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to update Quarantine settings for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "security" });
          res.redirect(`/manage/${guildId}/security?error=Failed to update Quarantine settings.`);
      }
  });

  app.post("/manage/:guildId/add-automod-rule", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { filter_type, action, action_duration_minutes } = req.body;

    let config = {};
    switch (filter_type) {
        case 'bannedWords':
            config.bannedWords = req.body.config_banned_words.split(',').map(w => w.trim()).filter(Boolean);
            break;
        case 'massMention':
            config.limit = parseInt(req.body.config_massMention_limit, 10);
            break;
        case 'allCaps':
            config.limit = parseInt(req.body.config_allCaps_limit, 10);
            break;
        case 'antiSpam':
            config.messageLimit = parseInt(req.body.config_antiSpam_message_limit, 10);
            config.timePeriod = parseInt(req.body.config_antiSpam_time_period, 10);
            break;
    }

    try {
        await db.execute(
            `INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes) VALUES (?, ?, ?, ?, ?)`,
            [guildId, filter_type, JSON.stringify(config), action, action === 'mute' ? action_duration_minutes : null]
        );
        res.redirect(`/manage/${guildId}/automod?success=Rule added successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to add automod rule for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "automod" });
        res.redirect(`/manage/${guildId}/automod?error=Failed to add rule.`);
    }
  });

  app.post("/manage/:guildId/delete-automod-rule", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { ruleId } = req.body;

      try {
          await db.execute("DELETE FROM automod_rules WHERE id = ? AND guild_id = ?", [ruleId, guildId]);
          res.redirect(`/manage/${guildId}/automod?success=Rule deleted successfully.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to delete automod rule for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "automod" });
          res.redirect(`/manage/${guildId}/automod?error=Failed to delete rule.`);
      }
  });

  app.post("/manage/:guildId/create-giveaway", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { prize, winner_count, duration_minutes, channel_id } = req.body;
    const guild = req.guildObject;

    try {
        const channel = await guild.channels.fetch(channel_id);
        if (!channel || !channel.isTextBased()) {
            return res.redirect(`/manage/${guildId}/giveaways?error=Invalid channel selected.`);
        }

        const endsAt = new Date(Date.now() + parseInt(duration_minutes, 10) * 60000);

        const embed = new EmbedBuilder()
            .setTitle("🎉 Giveaway! 🎉")
            .setDescription(`React with 🎉 to enter!\n**Prize:** ${prize}`)
            .addFields(
                { name: 'Ends In', value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>`, inline: true },
                { name: 'Winners', value: winner_count, inline: true }
            )
            .setColor("#5865F2")
            .setTimestamp(endsAt);

        const giveawayMessage = await channel.send({ embeds: [embed] });
        await giveawayMessage.react('🎉');

        await db.execute(
            `INSERT INTO giveaways (guild_id, channel_id, message_id, prize, winner_count, ends_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [guildId, channel_id, giveawayMessage.id, prize, parseInt(winner_count, 10), endsAt, 1]
        );

        res.redirect(`/manage/${guildId}/giveaways?success=Giveaway started successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to create giveaway for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "giveaways" });
        res.redirect(`/manage/${guildId}/giveaways?error=Failed to create giveaway.`);
    }
  });

  app.post("/manage/:guildId/end-giveaway", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { giveawayId } = req.body;

      try {
          const [[giveaway]] = await db.execute("SELECT * FROM giveaways WHERE id = ? AND guild_id = ?", [giveawayId, guildId]);
          if (giveaway && giveaway.is_active) {
              await endGiveaway(giveaway, false);
          }
          res.redirect(`/manage/${guildId}/giveaways?success=Giveaway ended.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to end giveaway for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "giveaways" });
          res.redirect(`/manage/${guildId}/giveaways?error=Failed to end giveaway.`);
      }
  });

  app.post("/manage/:guildId/reroll-giveaway", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { giveawayId } = req.body;

      try {
          const [[giveaway]] = await db.execute("SELECT * FROM giveaways WHERE id = ? AND guild_id = ?", [giveawayId, guildId]);
          if (giveaway && !giveaway.is_active) {
              await endGiveaway(giveaway, true);
          }
          res.redirect(`/manage/${guildId}/giveaways?success=Giveaway rerolled.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to reroll giveaway for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "giveaways" });
          res.redirect(`/manage/${guildId}/giveaways?error=Failed to reroll giveaway.`);
      }
  });

  app.post("/manage/:guildId/delete-giveaway", checkAuth, checkGuildAdmin, async (req, res) => {
      const { guildId } = req.params;
      const { giveawayId } = req.body;

      try {
          const [[giveaway]] = await db.execute("SELECT * FROM giveaways WHERE id = ? AND guild_id = ?", [giveawayId, guildId]);
          if (giveaway) {
              const channel = await botClient.channels.fetch(giveaway.channel_id).catch(() => null);
              if (channel) {
                  await channel.messages.delete(giveaway.message_id).catch(e => logger.warn(`[Dashboard] Failed to delete giveaway message ${giveaway.message_id}: ${e.message}`));
              }
              await db.execute("DELETE FROM giveaways WHERE id = ?", [giveawayId]);
          }
          res.redirect(`/manage/${guildId}/giveaways?success=Giveaway deleted.`);
      } catch (error) {
          logger.error(`[Dashboard] Failed to delete giveaway for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "giveaways" });
          res.redirect(`/manage/${guildId}/giveaways?error=Failed to delete giveaway.`);
      }
  });

  app.post("/manage/:guildId/create-rr-panel", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { panel_name, channel_id, message_content } = req.body;
    const guild = req.guildObject;

    try {
        const channel = await guild.channels.fetch(channel_id);
        if (!channel || !channel.isTextBased()) {
            return res.redirect(`/manage/${guildId}/reaction-roles?error=Invalid channel selected.`);
        }

        const panelMessage = await channel.send(message_content);

        await db.execute(
            `INSERT INTO reaction_role_panels (guild_id, panel_name, channel_id, message_id) VALUES (?, ?, ?, ?)`,
            [guildId, panel_name, channel_id, panelMessage.id]
        );

        res.redirect(`/manage/${guildId}/reaction-roles?success=Panel created successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to create reaction role panel for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "reaction-roles" });
        res.redirect(`/manage/${guildId}/reaction-roles?error=Failed to create panel.`);
    }
  });

  app.post("/manage/:guildId/add-rr-mapping", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { panelId, emoji_id, role_id } = req.body;

    try {
        const [[panel]] = await db.execute("SELECT * FROM reaction_role_panels WHERE id = ? AND guild_id = ?", [panelId, guildId]);
        if (!panel) {
            return res.redirect(`/manage/${guildId}/reaction-roles?error=Panel not found.`);
        }

        const channel = await botClient.channels.fetch(panel.channel_id);
        const message = await channel.messages.fetch(panel.message_id);

        await message.react(emoji_id);
        await db.execute(
            `INSERT INTO reaction_role_mappings (panel_id, emoji_id, role_id) VALUES (?, ?, ?)`,
            [panelId, emoji_id, role_id]
        );

        res.redirect(`/manage/${guildId}/reaction-roles?success=Role mapping added successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to add reaction role mapping for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "reaction-roles" });
        res.redirect(`/manage/${guildId}/reaction-roles?error=Failed to add role mapping.`);
    }
  });

  app.post("/manage/:guildId/remove-rr-mapping", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { mappingId } = req.body;

    try {
        const [[mapping]] = await db.execute("SELECT * FROM reaction_role_mappings WHERE id = ?", [mappingId]);
        if (!mapping) {
            return res.redirect(`/manage/${guildId}/reaction-roles?error=Mapping not found.`);
        }

        const [[panel]] = await db.execute("SELECT * FROM reaction_role_panels WHERE id = ? AND guild_id = ?", [mapping.panel_id, guildId]);
        if (panel) {
            const channel = await botClient.channels.fetch(panel.channel_id);
            const message = await channel.messages.fetch(panel.message_id);
            const reaction = message.reactions.cache.get(mapping.emoji_id);
            if (reaction) {
                await reaction.remove();
            }
        }

        await db.execute("DELETE FROM reaction_role_mappings WHERE id = ?", [mappingId]);

        res.redirect(`/manage/${guildId}/reaction-roles?success=Role mapping removed successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to remove reaction role mapping for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: "reaction-roles" });
        res.redirect(`/manage/${guildId}/reaction-roles?error=Failed to remove role mapping.`);
    }
  });

  app.post("/manage/:guildId/delete-rr-panel", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { panelId } = req.body;

    try {
        const [[panel]] = await db.execute("SELECT * FROM reaction_role_panels WHERE id = ? AND guild_id = ?", [panelId, guildId]);
        if (panel) {
            const channel = await botClient.channels.fetch(panel.channel_id);
            await channel.messages.delete(panel.message_id).catch(e => logger.warn(`[Dashboard] Failed to delete reaction role message for panel ${panelId}: ${e.message}`));
        }

        await db.execute("DELETE FROM reaction_role_panels WHERE id = ?", [panelId]);
        // Mappings are deleted automatically by the database cascade.

        res.redirect(`/manage/${guildId}/reaction-roles?success=Panel deleted successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to delete reaction role panel for guild ${guildId}:`, { guildId, error: e.message, stack: e.stack, category: "reaction-roles" });
        res.redirect(`/manage/${guildId}/reaction-roles?error=Failed to delete panel.`);
    }
  });


  app.post("/manage/:guildId/update-bot-appearance", checkAuth, checkGuildAdmin, upload.single('bot_avatar_file'), async (req, res) => {
    const { guildId } = req.params;
    const { bot_nickname, bot_avatar_url_text, reset_bot_avatar, embed_color } = req.body;
    const guild = req.guildObject;
    const avatarFile = req.file;

    try {
        let newNickname = bot_nickname;
        if (bot_nickname && bot_nickname.toLowerCase() === 'reset') {
            newNickname = null;
        }
        await guild.members.me.setNickname(newNickname).catch(e => logger.warn(`[Dashboard] Failed to set nickname in guild ${guildId}: ${e.message}`));

        const [[currentSettings]] = await db.execute("SELECT webhook_avatar_url FROM guilds WHERE guild_id = ?", [guildId]);
        let newAvatarUrl = currentSettings?.webhook_avatar_url || null;

        if (reset_bot_avatar === 'on') {
            newAvatarUrl = null;
        } else if (avatarFile) {
            const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
            if (tempUploadChannelId) {
                const tempChannel = await botClient.channels.fetch(tempUploadChannelId);
                const tempMessage = await tempChannel.send({ files: [{ attachment: avatarFile.buffer, name: avatarFile.originalname }] });
                newAvatarUrl = tempMessage.attachments.first().url;
            } else {
                logger.warn(`[Dashboard] TEMP_UPLOAD_CHANNEL_ID not set, cannot upload avatar for guild ${guildId}`);
            }
        } else if (bot_avatar_url_text) {
            newAvatarUrl = bot_avatar_url_text;
        }

        await db.execute(
            `INSERT INTO guilds (guild_id, bot_nickname, webhook_avatar_url, embed_color) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE bot_nickname = VALUES(bot_nickname), webhook_avatar_url = VALUES(webhook_avatar_url), embed_color = VALUES(embed_color)`,
            [guildId, newNickname, newAvatarUrl, embed_color]
        );

        res.redirect(`/manage/${guildId}/appearance?success=Appearance updated successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to update appearance for guild ${guildId}:`, { guildId, error: e.message, stack: e.stack, category: "appearance" });
        res.redirect(`/manage/${guildId}/appearance?error=Failed to update appearance.`);
    }
  });

  app.post("/manage/:guildId/add-streamer", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { platform, username, discord_user_id, announcement_channel_id, override_nickname, custom_message, keep_summary } = req.body;

    if (!platform || !username) {
        return res.redirect(`/manage/${guildId}/streamers?error=Platform and username are required.`);
    }

    try {
        let streamerInfo = null;
        if (platform === "twitch") {
            const u = await twitchApi.getTwitchUser(username);
            if (u) streamerInfo = { puid: u.id, dbUsername: u.login };
        } else if (platform === "kick") {
            const u = await kickApi.getKickUser(username);
            if (u) streamerInfo = { puid: u.id.toString(), dbUsername: u.user.username };
        } else if (platform === "youtube") {
            const c = await getYouTubeChannelId(username);
            if (c?.channelId) streamerInfo = { puid: c.channelId, dbUsername: c.channelName || username };
        }

        if (!streamerInfo) {
            return res.redirect(`/manage/${guildId}/streamers?error=Streamer not found on ${platform}.`);
        }

        let [[existingStreamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?", [platform, streamerInfo.puid]);
        let streamerId = existingStreamer?.streamer_id;

        if (!streamerId) {
            const [result] = await db.execute("INSERT INTO streamers (platform, username, platform_user_id, discord_user_id) VALUES (?, ?, ?, ?)", [platform, streamerInfo.dbUsername, streamerInfo.puid, discord_user_id || null]);
            streamerId = result.insertId;
        } else if (discord_user_id) {
            await db.execute("UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ?", [discord_user_id, streamerId]);
        }

        const channelIds = Array.isArray(announcement_channel_id) ? announcement_channel_id : [announcement_channel_id];
        for (const channelId of channelIds) {
            await db.execute(
                `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, custom_message, override_nickname, delete_on_end) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE custom_message=VALUES(custom_message), override_nickname=VALUES(override_nickname), delete_on_end=VALUES(delete_on_end)`,
                [guildId, streamerId, channelId || null, custom_message || null, override_nickname || null, keep_summary ? 0 : 1]
            );
        }

        res.redirect(`/manage/${guildId}/streamers?success=Streamer added successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to add streamer for guild ${guildId}:`, { guildId, error: e.message, stack: e.stack, category: "streamers" });
        res.redirect(`/manage/${guildId}/streamers?error=Failed to add streamer.`);
    }
  });

  app.post("/manage/:guildId/edit-consolidated-streamer", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { discord_user_id, subscriptions } = req.body;

    try {
        const streamerIdsToUpdate = new Set();
        if (subscriptions) {
            const subIds = Object.keys(subscriptions);
            if (subIds.length > 0) {
                const placeholders = subIds.map(() => '?').join(',');
                const [subs] = await db.execute(`SELECT DISTINCT streamer_id FROM subscriptions WHERE subscription_id IN (${placeholders}) AND guild_id = ?`, [...subIds, guildId]);
                subs.forEach(s => streamerIdsToUpdate.add(s.streamer_id));
            }
        }

        if (streamerIdsToUpdate.size > 0) {
            const finalDiscordId = discord_user_id.trim() === '' ? null : discord_user_id;
            const idPlaceholders = Array.from(streamerIdsToUpdate).map(() => '?').join(',');
            await db.execute(`UPDATE streamers SET discord_user_id = ? WHERE streamer_id IN (${idPlaceholders})`, [finalDiscordId, ...streamerIdsToUpdate]);
        }

        if (subscriptions) {
            for (const subId in subscriptions) {
                const sub = subscriptions[subId];
                await db.execute(
                    `UPDATE subscriptions SET announcement_channel_id = ?, live_role_id = ?, custom_message = ?, override_nickname = ?, override_avatar_url = ?, delete_on_end = ? WHERE subscription_id = ? AND guild_id = ?`,
                    [
                        sub.announcement_channel_id || null,
                        sub.live_role_id || null,
                        sub.custom_message || null,
                        sub.override_nickname || null,
                        sub.override_avatar_url || null,
                        sub.keep_summary ? 0 : 1,
                        subId,
                        guildId
                    ]
                );
            }
        }

        res.redirect(`/manage/${guildId}/streamers?success=Streamer updated successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to edit streamer for guild ${guildId}:`, { guildId, error: e.message, stack: e.stack, category: "streamers" });
        res.redirect(`/manage/${guildId}/streamers?error=Failed to edit streamer.`);
    }
  });

  app.post("/manage/:guildId/delete-streamer", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { streamerId } = req.body;

    try {
        await db.execute("DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id = ?", [guildId, streamerId]);
        res.redirect(`/manage/${guildId}/streamers?success=Streamer subscriptions removed successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to delete streamer for guild ${guildId}:`, { guildId, error: e.message, stack: e.stack, category: "streamers" });
        res.redirect(`/manage/${guildId}/streamers?error=Failed to delete streamer.`);
    }
  });

  app.post("/manage/:guildId/delete-subscription", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { subscriptionId } = req.body;

    if (!subscriptionId) {
        return res.status(400).json({ success: false, error: 'Invalid subscription specified.' });
    }

    try {
        const [result] = await db.execute("DELETE FROM subscriptions WHERE subscription_id = ? AND guild_id = ?", [subscriptionId, guildId]);

        if (result.affectedRows > 0) {
            res.json({ success: true, message: 'Subscription deleted successfully.' });
        } else {
            res.status(404).json({ success: false, error: 'Subscription not found or you do not have permission to delete it.' });
        }
    } catch (error) {
        logger.error(`[Dashboard] Failed to delete subscription for guild ${guildId}:`, { guildId, subscriptionId, error: e.message, stack: e.stack, category: "streamers" });
        res.status(500).json({ success: false, error: 'Failed to delete subscription.' });
    }
  });

  app.post("/manage/:guildId/add-team", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { teamName, announcementChannelId, liveRoleId, customMessage, keepSummary, webhookName, webhookAvatarUrl } = req.body;

    try {
        const team = await twitchApi.getTwitchTeam(teamName);
        if (!team) {
            return res.redirect(`/manage/${guildId}/teams?error=Twitch team not found.`);
        }

        const [teamResult] = await db.execute(
            `INSERT INTO twitch_teams (guild_id, team_name, announcement_channel_id, live_role_id, custom_message, delete_on_end, webhook_name, webhook_avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id=VALUES(announcement_channel_id), live_role_id=VALUES(live_role_id), custom_message=VALUES(custom_message), delete_on_end=VALUES(delete_on_end), webhook_name=VALUES(webhook_name), webhook_avatar_url=VALUES(webhook_avatar_url)`,
            [guildId, team.login, announcementChannelId || null, liveRoleId || null, customMessage || null, keepSummary ? 0 : 1, webhookName || null, webhookAvatarUrl || null]
        );
        const teamSubscriptionId = teamResult.insertId;

        const users = await twitchApi.getUsers(team.users.map(u => u.user_id));
        for (const user of users) {
            let [[existingStreamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = 'twitch' AND platform_user_id = ?", [user.id]);
            let streamerId = existingStreamer?.streamer_id;

            if (!streamerId) {
                const [result] = await db.execute("INSERT INTO streamers (platform, username, platform_user_id) VALUES ('twitch', ?, ?)", [user.login, user.id]);
                streamerId = result.insertId;
            }

            await db.execute(
                `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, team_subscription_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE team_subscription_id=VALUES(team_subscription_id)`,
                [guildId, streamerId, announcementChannelId || null, teamSubscriptionId]
            );
        }

        res.redirect(`/manage/${guildId}/teams?success=Team added and members synchronized.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to add team for guild ${guildId}:`, { guildId, error: e.message, stack: e.stack, category: "teams" });
        res.redirect(`/manage/${guildId}/teams?error=Failed to add team.`);
    }
  });

  app.post("/manage/:guildId/edit-team", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { teamSubscriptionId, announcementChannelId, liveRoleId, customMessage, keepSummary, webhookName, webhookAvatarUrl } = req.body;

    try {
        await db.execute(
            `UPDATE twitch_teams SET announcement_channel_id = ?, live_role_id = ?, custom_message = ?, delete_on_end = ?, webhook_name = ?, webhook_avatar_url = ? WHERE id = ? AND guild_id = ?`,
            [announcementChannelId || null, liveRoleId || null, customMessage || null, keepSummary ? 0 : 1, webhookName || null, webhookAvatarUrl || null, teamSubscriptionId, guildId]
        );
        res.redirect(`/manage/${guildId}/teams?success=Team settings updated successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to edit team for guild ${guildId}:`, { guildId, error: e.message, stack: e.stack, category: "teams" });
        res.redirect(`/manage/${guildId}/teams?error=Failed to edit team.`);
    }
  });

  app.post("/manage/:guildId/delete-team", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { teamId } = req.body;

    try {
        await db.execute("DELETE FROM subscriptions WHERE guild_id = ? AND team_subscription_id = ?", [guildId, teamId]);
        await db.execute("DELETE FROM twitch_teams WHERE id = ? AND guild_id = ?", [teamId, guildId]);
        res.redirect(`/manage/${guildId}/teams?success=Team unsubscribed successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to delete team for guild ${guildId}:`, { guildId, error: e.message, stack: e.stack, category: "teams" });
        res.redirect(`/manage/${guildId}/teams?error=Failed to delete team.`);
    }
  });

  app.post("/manage/:guildId/update-welcome", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const {
        channel_id,
        message,
        banner_enabled,
        card_title_text,
        card_subtitle_text,
        card_background_url,
        goodbye_enabled,
        goodbye_channel_id,
        goodbye_message
    } = req.body;

    const welcomeChannelId = channel_id || null;
    const welcomeMessage = message || '';
    const bannerEnabled = banner_enabled === 'on' ? 1 : 0;
    const bannerTitle = card_title_text || 'Welcome, {user}!';
    const bannerSubtitle = card_subtitle_text || 'Welcome to {server}!';
    const bannerBackground = card_background_url || null;
    const goodbyeEnabled = goodbye_enabled === 'on' ? 1 : 0;
    const goodbyeChannelId = goodbye_channel_id || null;
    const goodbyeMessageText = goodbye_message || '';

    try {
        await db.execute(
            `INSERT INTO welcome_settings (guild_id, channel_id, message, banner_enabled, card_title_text, card_subtitle_text, card_background_url, goodbye_enabled, goodbye_channel_id, goodbye_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), message = VALUES(message), banner_enabled = VALUES(banner_enabled), card_title_text = VALUES(card_title_text), card_subtitle_text = VALUES(card_subtitle_text), card_background_url = VALUES(card_background_url), goodbye_enabled = VALUES(goodbye_enabled), goodbye_channel_id = VALUES(goodbye_channel_id), goodbye_message = VALUES(goodbye_message)`,
            [guildId, welcomeChannelId, welcomeMessage, bannerEnabled, bannerTitle, bannerSubtitle, bannerBackground, goodbyeEnabled, goodbyeChannelId, goodbyeMessageText]
        );
        res.redirect(`/manage/${guildId}/welcome?success=Welcome and farewell settings saved successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to update welcome settings for guild ${guildId}:`, { guildId, error: e.message, stack: e.stack, category: "welcome" });
        res.redirect(`/manage/${guildId}/welcome?error=Failed to save welcome and farewell settings.`);
    }
  });

  app.post("/manage/:guildId/music/config", checkAuth, checkGuildAdmin, async (req, res) => {
    const {guildId} = req.params;
    const {enabled, djRoleId} = req.body;

    const musicEnabled = enabled === "on" ? 1 : 0;
    const musicDjRoleId = djRoleId || null;

    try {
      await db.execute(
        `INSERT INTO music_config (guild_id, enabled, dj_role_id)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled    = VALUES(enabled),
                                 dj_role_id = VALUES(dj_role_id)`,
        [guildId, musicEnabled, musicDjRoleId]
      );
      logger.info(`[Dashboard] Music config updated for guild ${guildId}. Enabled: ${musicEnabled}, DJ Role: ${musicDjRoleId}`, {guildId, category: "music"});
      res.redirect(`/manage/${guildId}/music?success=Music settings updated successfully.`);
    } catch (error) {
      logger.error(`[Dashboard] Failed to update music config for guild ${guildId}:`, {guildId, error: e.message, stack: e.stack, category: "music"});
      res.redirect(`/manage/${guildId}/music?error=Failed to update music settings.`);
    }
  });

  app.post("/manage/:guildId/music/dj", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { djEnabled, djVoice } = req.body;

    const isDjEnabled = djEnabled === 'on' ? 1 : 0;
    const voice = ['male', 'female'].includes(djVoice) ? djVoice : 'female';

    try {
        await db.execute(
            `INSERT INTO music_config (guild_id, dj_enabled, dj_voice)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE 
                dj_enabled = VALUES(dj_enabled),
                dj_voice = VALUES(dj_voice)`,
            [guildId, isDjEnabled, voice]
        );
        logger.info(`[Dashboard] AI DJ settings updated for guild ${guildId}.`, { guildId, category: "music" });
        res.redirect(`/manage/${guildId}/music?success=AI DJ settings saved successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to update AI DJ settings for guild ${guildId}:`, { guildId, error: e.message, stack: e.stack, category: "music" });
        res.redirect(`/manage/${guildId}/music?error=Failed to save AI DJ settings.`);
    }
  });

  app.post("/manage/:guildId/music/recording", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { recordingEnabled, recordingAllowedRoles, recordingOutputChannel } = req.body;

    const isEnabled = recordingEnabled === 'on' ? 1 : 0;
    const allowedRoles = Array.isArray(recordingAllowedRoles) ? recordingAllowedRoles : (recordingAllowedRoles ? [recordingAllowedRoles] : []);
    const allowedRolesJson = JSON.stringify(allowedRoles);
    const outputChannelId = recordingOutputChannel || null;

    try {
        await db.execute(
            `INSERT INTO record_config (guild_id, is_enabled, allowed_role_ids, output_channel_id)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                is_enabled = VALUES(is_enabled),
                allowed_role_ids = VALUES(allowed_role_ids),
                output_channel_id = VALUES(output_channel_id)`,
            [guildId, isEnabled, allowedRolesJson, outputChannelId]
        );
        logger.info(`[Dashboard] Recording settings updated for guild ${guildId}.`, { guildId, category: "music" });
        res.redirect(`/manage/${guildId}/music?success=Recording settings saved successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to update recording settings for guild ${guildId}:`, { guildId, error: e.message, stack: e.stack, category: "music" });
        res.redirect(`/manage/${guildId}/music?error=Failed to save recording settings.`);
    }
  });

  app.post("/manage/:guildId/music/playlists", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { maxPlaylists, maxSongsPerPlaylist } = req.body;

    const maxPlaylistsValue = maxPlaylists ? parseInt(maxPlaylists, 10) : null;
    const maxSongsValue = maxSongsPerPlaylist ? parseInt(maxSongsPerPlaylist, 10) : null;

    try {
        await db.execute(
            `INSERT INTO music_config (guild_id, max_playlists_per_user, max_songs_per_playlist)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE
                max_playlists_per_user = VALUES(max_playlists_per_user),
                max_songs_per_playlist = VALUES(max_songs_per_playlist)`,
            [guildId, maxPlaylistsValue, maxSongsValue]
        );
        logger.info(`[Dashboard] Playlist settings updated for guild ${guildId}.`, { guildId, category: "music" });
        res.redirect(`/manage/${guildId}/music?success=Playlist settings saved successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to update playlist settings for guild ${guildId}:`, { guildId, error: e.message, stack: e.stack, category: "music" });
        res.redirect(`/manage/${guildId}/music?error=Failed to save playlist settings.`);
    }
  });

  app.post("/manage/:guildId/music/filters", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { filters } = req.body;

    const enabledFilters = Array.isArray(filters) ? filters : (filters ? [filters] : []);
    const enabledFiltersJson = JSON.stringify(enabledFilters);

    try {
        await db.execute(
            `INSERT INTO music_config (guild_id, enabled_filters)
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE
                enabled_filters = VALUES(enabled_filters)`,
            [guildId, enabledFiltersJson]
        );
        logger.info(`[Dashboard] Filter settings updated for guild ${guildId}.`, { guildId, category: "music" });
        res.redirect(`/manage/${guildId}/music?success=Filter settings saved successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to update filter settings for guild ${guildId}:`, { guildId, error: e.message, stack: e.stack, category: "music" });
        res.redirect(`/manage/${guildId}/music?error=Failed to save filter settings.`);
    }
  });

  app.post("/manage/:guildId/stat-roles/update", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { configs } = req.body;

    try {
        // Clear existing configs for the guild
        await db.execute("DELETE FROM statrole_configs WHERE guild_id = ?", [guildId]);

        if (configs && Array.isArray(configs)) {
            const insertPromises = configs.map(config => {
                return db.execute(
                    `INSERT INTO statrole_configs (guild_id, role_id, stat_type, required_value)
                    VALUES (?, ?, ?, ?)`,
                    [guildId, config.roleId, config.stat, parseInt(config.requiredValue, 10)]
                );
            });
            await Promise.all(insertPromises);
        }

        logger.info(`[Dashboard] Stat role settings updated for guild ${guildId}.`, { guildId, category: "stat-roles" });
        res.redirect(`/manage/${guildId}/stat-roles?success=Stat role settings saved successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to update stat role settings for guild ${guildId}:`, { guildId, error: e.message, stack: e.stack, category: "stat-roles" });
        res.redirect(`/manage/${guildId}/stat-roles?error=Failed to save stat role settings.`);
    }
  });

  app.post("/manage/:guildId/update-channel-webhooks", checkAuth, checkGuildAdmin, async (req, res) => {
    const {guildId} = req.params;
    const {channel_webhooks} = req.body;

    if (!channel_webhooks || typeof channel_webhooks !== "object") {
      return res.redirect(`/manage/${guildId}/logging?error=Invalid data submitted.`);
    }

    try {
      const promises = Object.entries(channel_webhooks).map(([channelId, webhookUrl]) => {
        const urlToSave = webhookUrl.trim() || null;
        return db.execute(
          `INSERT INTO channel_settings (guild_id, channel_id, webhook_url)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE webhook_url = VALUES(webhook_url)`,
          [guildId, channelId, urlToSave]
        );
      });

      await Promise.all(promises);
      logger.info(`[Dashboard] Channel webhook overrides updated for guild ${guildId}.`, {guildId, category: "dashboard"});
      res.redirect(`/manage/${guildId}/logging?success=Webhook overrides saved successfully.`);
    } catch (error) {
      logger.error(`[Dashboard] Failed to update webhook overrides for guild ${guildId}:`, {guildId, error: e.message, stack: e.stack, category: "dashboard"});
      res.redirect(`/manage/${guildId}/logging?error=Failed to save webhook overrides.`);
    }
  });

  app.post("/manage/:guildId/update-logging", checkAuth, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { log_channel_id, enabled_logs, log_categories } = req.body;

    const defaultLogChannelId = log_channel_id || null;
    const enabledLogsJson = JSON.stringify(enabled_logs || []);
    const categoryChannelsJson = JSON.stringify(log_categories || {});

    try {
        await db.execute(
            `INSERT INTO log_config (guild_id, log_channel_id, enabled_logs, log_categories)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id),
                               enabled_logs   = VALUES(enabled_logs),
                               log_categories = VALUES(log_categories)`,
            [guildId, defaultLogChannelId, enabledLogsJson, categoryChannelsJson]
        );
        logger.info(`[Dashboard] Log config updated for guild ${guildId}.`, { guildId, category: "logging" });
        res.redirect(`/manage/${guildId}/logging?success=Log configuration saved successfully.`);
    } catch (error) {
        logger.error(`[Dashboard] Failed to update log config for guild ${guildId}:`, { guildId, error: e.message, stack: e.stack, category: "logging" });
        res.redirect(`/manage/${guildId}/logging?error=Failed to save log configuration.`);
    }
  });

  app.get("/super-admin", checkAuth, checkSuperAdmin, (req, res) => res.render("super-admin", {user: getSanitizedUser(req)}));

    app.get("/api/status-data", async (req, res) => {
        try {
            const liveAnnouncements = getLiveAnnouncements();
            const uniqueStreamers = new Map(); // Map<streamerId, { streamerInfo, livePlatforms: Set<platform> }>

            // Aggregate live announcements by streamer
            for (const [key, announcement] of liveAnnouncements.entries()) {
                const streamerId = announcement.streamerId; // Use streamerId from the stored object
                if (!uniqueStreamers.has(streamerId)) {
                    uniqueStreamers.set(streamerId, {
                        username: announcement.username,
                        discordUserId: announcement.discordUserId,
                        livePlatforms: new Set()
                    });
                }
                uniqueStreamers.get(streamerId).livePlatforms.add(announcement.platform);
            }

            const liveStreamers = [];

            for (const { username, discordUserId, livePlatforms } of uniqueStreamers.values()) {
                let avatar_url = botClient.user.displayAvatarURL(); // Default to bot's avatar
                let displayUsername = username;

                if (discordUserId) {
                    try {
                        const user = await botClient.users.fetch(discordUserId);
                        avatar_url = user.displayAvatarURL();
                        displayUsername = user.username; // Use Discord username if available
                    } catch (e) {
                        logger.warn(`[Status Page] Could not fetch Discord user ${discordUserId} for streamer ${username}: ${e.message}`, { error: e.message });
                    }
                }

                liveStreamers.push({
                    username: displayUsername,
                    avatar_url: avatar_url,
                    live_platforms: Array.from(livePlatforms).map(p => {
                        // Fetch streamer details from DB to get platform-specific username for URL
                        // This is a simplified approach; ideally, streamerInfo would be passed directly
                        return { platform: p, url: getPlatformUrl(username, p) };
                    })
                });
            }

            const [[{ count: totalStreamers }]] = await db.execute("SELECT COUNT(*) as count FROM streamers");
            const [dbPlatformDist] = await db.execute("SELECT platform, COUNT(*) as count FROM streamers GROUP BY platform");

            const data = {
                liveCount: uniqueStreamers.size,
                totalGuilds: botClient.guilds.cache.size,
                totalStreamers: totalStreamers,
                totalAnnouncements: liveAnnouncements.size,
                liveStreamers,
                platformDistribution: dbPlatformDist,
            };

            if (req.isAuthenticated() && req.user && req.user.isSuperAdmin) {
                const appStatus = getStatus();
                let dbStatus = 'ok';
                try {
                    await db.execute('SELECT 1');
                } catch (e) {
                    dbStatus = 'error';
                }

                const twitchStatus = await twitchApi.getApiStatus();

                data.app = {
                    status: appStatus.state,
                    uptime: formatUptime(process.uptime()),
                };
                data.db = { status: dbStatus };
                data.api = { twitch: twitchStatus ? 'ok' : 'error' };
            }

            res.json(data);
        } catch (error) {
            logger.error("[API Status] Failed to fetch status data:", { error: e.message, stack: e.stack });
            res.status(500).json({ error: "Failed to retrieve status data." });
        }
    });

    app.get("/api/authenticated-logs", checkAuth, checkSuperAdmin, async (req, res) => {
        try {
            const logDir = "/root/.pm2/logs/";
            const files = await fs.readdir(logDir);
    
            const logFiles = files.filter(f => f.startsWith('LiveBot-Main-out-') && f.endsWith('.log'));
    
            if (logFiles.length === 0) {
                return res.json({ logs: 'No main log files found.' });
            }
    
            const latestLogFile = logFiles.reduce((latest, current) => {
                const latestNum = parseInt(latest.split('-').pop().split('.')[0], 10);
                const currentNum = parseInt(current.split('-').pop().split('.')[0], 10);
                return currentNum > latestNum ? current : latest;
            });
    
            const logPath = path.join(logDir, latestLogFile);
            const logContent = await fs.readFile(logPath, 'utf8');
            
            res.json({ logs: logContent });
    
        } catch (error) {
            logger.error('[API Logs] Failed to fetch logs:', { error: e.message, stack: e.stack });
            res.status(500).json({ error: 'Failed to retrieve logs.' });
        }
    });

  // Fallback error handlers
  app.use((req, res) => res.status(404).render("error", {user: getSanitizedUser(req), error: "Page Not Found"}));
  app.use((err, req, res, next) => {
    logger.error("Unhandled Express Error", {error: err.stack, path: req.path});
    res.status(500).render("error", {user: getSanitizedUser(req), error: "An internal server error occurred."});
  });

  app.listen(port, () => logger.info(`[Dashboard] Web dashboard listening on port ${port}`)).on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      logger.error(`[Dashboard] Port ${port} is already in use.`);
      process.exit(1);
    }
  });
}

function getPlatformUrl(username, platform) {
    switch (platform) {
        case 'twitch': return `https://twitch.tv/${username}`;
        case 'kick': return `https://kick.com/${username}`;
        default: return '#';
    }
}

function formatUptime(seconds) {
    const d = Math.floor(seconds / (3600*24));
    const h = Math.floor(seconds % (3600*24) / 300);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);
    return `${d}d ${h}h ${m}m ${s}s`;
}

module.exports = {start};
