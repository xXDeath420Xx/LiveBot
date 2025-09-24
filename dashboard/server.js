const express = require("express");
const expressSession = require("express-session");
const passport = require("passport");
require("./passport-setup");
const path = require("path");
const fs = require("fs");
const { pool: db } = require("../utils/db");
const { logAuditEvent } = require("../utils/audit-log.js");
const { PermissionsBitField, Collection, ChannelType } = require("discord.js");
const logger = require("../utils/logger");
const apiChecks = require("../utils/api_checks");
const initCycleTLS = require("cycletls");

function formatUptime(seconds) {
    const d = Math.floor(seconds / (3600*24));
    const h = Math.floor(seconds % (3600*24) / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);
    let parts = [];
    if (d > 0) parts.push(`${d} day${d > 1 ? 's' : ''}`);
    if (h > 0) parts.push(`${h} hour${h > 1 ? 's' : ''}`);
    if (m > 0) parts.push(`${m} minute${m > 1 ? 's' : ''}`);
    if (s > 0) parts.push(`${s} second${s > 1 ? 's' : ''}`);
    return parts.join(', ');
}

const dashboard = {
  client: null,
  getStatus: () => ({state: "UNKNOWN", message: "Status provider not registered."}),

  setClient(newClient) {
    this.client = newClient;
    logger.info("[Dashboard] Discord client set.");
  },

  start(botClient, statusGetter) {
    return new Promise((resolve, reject) => {
        if (botClient) this.client = botClient;
        if (statusGetter) this.getStatus = statusGetter;

        const app = express();
        const port = process.env.DASHBOARD_PORT || 3000;

        if (!process.env.SESSION_SECRET) {
            const err = new Error("SESSION_SECRET is not defined in the environment variables.");
            logger.error("[Dashboard] FATAL: SESSION_SECRET is not defined.", err);
            return reject(err);
        }

        app.use(expressSession({secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: {maxAge: 1000 * 60 * 60 * 24}}));
        app.use(passport.initialize());
        app.use(passport.session());
        app.use(express.json());
        app.use(express.urlencoded({extended: true}));
        app.use(express.static(path.join(__dirname, "public")));
        app.set("view engine", "ejs");
        app.set("views", path.join(__dirname, "views"));

        const isBotReady = (req, res, next) => {
            if (dashboard.client && dashboard.getStatus().state === "ONLINE") return next();
            res.status(503).render("status", {user: req.user, isAuthenticated: req.isAuthenticated(), botStatus: dashboard.getStatus(), statusData: null});
        };

        const checkAuth = (req, res, next) => {
            if (req.isAuthenticated()) return next();
            res.redirect("/login");
        };

        const checkGuildAdmin = async (req, res, next) => {
            if (!req.user || !req.user.guilds) return res.status(403).render("error", {user: req.user, error: "Authentication error."});
            const guild = req.user.guilds.find(g => g.id === req.params.guildId);
            if (!guild || !new PermissionsBitField(BigInt(guild.permissions)).has(PermissionsBitField.Flags.ManageGuild)) {
                return res.status(403).render("error", {user: req.user, error: "Permission denied. You must have 'Manage Server' permissions.", guild: {id: req.params.guildId}});
            }
            try {
                req.guildObject = await dashboard.client.guilds.fetch(req.params.guildId);
                next();
            } catch (e) {
                logger.error(`[Dashboard] Failed to fetch guild ${req.params.guildId} for admin check:`, e);
                res.status(404).render("error", {user: req.user, error: "Bot is not in this server, or the server does not exist.", guild: {id: req.params.guildId}});
            }
        };

        app.get("/", (req, res) => res.render("landing", {user: req.user, client_id: process.env.DISCORD_CLIENT_ID}));
        app.get("/donate", (req, res) => res.render("donate", {user: req.user}));
        app.get("/api/status", (req, res) => res.json(dashboard.getStatus()));

        // Restored server-side rendering for the status page
        app.get("/status", async (req, res) => {
            try {
                const [totalStreamersResult] = await db.execute("SELECT COUNT(DISTINCT streamer_id) as count FROM streamers");
                const [totalGuildsResult] = await db.execute("SELECT COUNT(DISTINCT guild_id) as count FROM guilds");
                const [totalAnnouncementsResult] = await db.execute("SELECT COUNT(*) as count FROM announcements");
                const [liveStreamersRaw] = await db.execute("SELECT a.platform, s.username, s.profile_image_url FROM announcements a JOIN streamers s ON a.streamer_id = s.streamer_id");

                const platformDistribution = liveStreamersRaw.reduce((acc, s) => {
                    acc[s.platform] = (acc[s.platform] || 0) + 1;
                    return acc;
                }, {});

                const statusData = {
                    liveCount: liveStreamersRaw.length,
                    totalStreamers: totalStreamersResult[0].count,
                    totalGuilds: totalGuildsResult[0].count,
                    totalAnnouncements: totalAnnouncementsResult[0].count,
                    liveStreamers: liveStreamersRaw.map(s => ({...s, avatar_url: s.profile_image_url || "/images/default-icon.png"})),
                    platformDistribution: Object.entries(platformDistribution).map(([platform, count]) => ({platform, count})),
                    app: {status: dashboard.getStatus().state, uptime: formatUptime(process.uptime())},
                    db: {status: "ok"},
                };

                res.render("status", {user: req.user, isAuthenticated: req.isAuthenticated(), botStatus: dashboard.getStatus(), statusData});

            } catch (error) {
                logger.error("[Dashboard] Error loading status page:", error);
                res.status(500).render("status", {user: req.user, isAuthenticated: req.isAuthenticated(), botStatus: dashboard.getStatus(), statusData: null, error: "Failed to load status data."});
            }
        });

        // This API endpoint is no longer needed for the status page
        // app.get("/api/status-data", ...);

        app.get("/api/authenticated-logs", checkAuth, async (req, res) => {
            const logFilePath = path.join(__dirname, "../combined.log");
            try {
                await fs.promises.access(logFilePath);
                const logs = await fs.promises.readFile(logFilePath, "utf8");
                res.json({logs});
            } catch (error) {
                logger.error("[Dashboard API] Error fetching logs:", error);
                res.status(500).json({error: "Failed to fetch logs."});
            }
        });

        app.get("/auth/discord", passport.authenticate("discord"));
        app.get("/auth/discord/callback", passport.authenticate("discord", {failureRedirect: "/login"}), (req, res) => res.redirect("/dashboard"));
        app.get("/login", (req, res) => res.render("login", {user: req.user, isAuthenticated: req.isAuthenticated()}));
        app.get("/logout", (req, res) => req.logout(() => res.redirect("/")));

        app.get("/dashboard", checkAuth, isBotReady, (req, res) => {
            const manageableGuilds = req.user.guilds.filter(g => 
                new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild) && dashboard.client?.guilds.cache.has(g.id)
            );
            res.render("dashboard", {user: req.user, isAuthenticated: req.isAuthenticated(), manageableGuilds});
        });

        app.post("/manage/:guildId/add", checkAuth, checkGuildAdmin, async (req, res) => {
            const {guildId} = req.params;
            let {platform, username, discord_user_id, announcement_channel_id} = req.body;
            if (!platform || !username) return res.redirect(`/manage/${guildId}?error=Missing platform or username.`);

            let cycleTLS = null;
            try {
                let streamerInfo = null;
                const [[existingStreamer]] = await db.execute("SELECT streamer_id, platform_user_id, username FROM streamers WHERE platform = ? AND username = ?", [platform, username]);

                if (existingStreamer) {
                    streamerInfo = {id: existingStreamer.streamer_id, puid: existingStreamer.platform_user_id, dbUsername: existingStreamer.username};
                } else {
                    if (platform === "twitch") {
                        const u = await apiChecks.getTwitchUser(username); if (u) streamerInfo = {puid: u.id, dbUsername: u.login};
                    } else if (platform === "kick") {
                        cycleTLS = await initCycleTLS({timeout: 60000});
                        const u = await apiChecks.getKickUser(cycleTLS, username); if (u) streamerInfo = {puid: u.id.toString(), dbUsername: u.user.username};
                    } else if (platform === "youtube") {
                        const channelId = await apiChecks.getYouTubeChannelId(username); if (channelId) streamerInfo = {puid: channelId, dbUsername: username};
                    } else if (["tiktok", "trovo"].includes(platform)) {
                        streamerInfo = {puid: username, dbUsername: username};
                    }
                    if (!streamerInfo) return res.redirect(`/manage/${guildId}?error=Streamer ${username} not found on ${platform}.`);
                }

                const correctedDiscordId = /^[0-9]+$/.test(discord_user_id) ? discord_user_id : null;
                let streamerId;
                if (existingStreamer) {
                    streamerId = existingStreamer.streamer_id;
                    await db.execute(`UPDATE streamers SET username=?, platform_user_id=? WHERE streamer_id = ?`, [streamerInfo.dbUsername, streamerInfo.puid, streamerId]);
                } else {
                    const [result] = await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, discord_user_id) VALUES (?, ?, ?, ?)`, [platform, streamerInfo.puid, streamerInfo.dbUsername, correctedDiscordId]);
                    streamerId = result.insertId;
                }

                const channelIds = Array.isArray(announcement_channel_id) ? announcement_channel_id : [announcement_channel_id];
                for (const chId of channelIds) {
                    const targetChannelId = chId || null;
                    const [[existingSubscription]] = await db.execute("SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ? AND announcement_channel_id <=> ?", [guildId, streamerId, targetChannelId]);
                    if (!existingSubscription) {
                        await db.execute(`INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)`, [guildId, streamerId, targetChannelId]);
                    }
                }
                res.redirect(`/manage/${guildId}?success=Streamer ${username} added/updated successfully.`);
            } catch (error) {
                logger.error(`[Dashboard] Error adding streamer for guild ${guildId}:`, error);
                res.redirect(`/manage/${guildId}?error=Failed to add streamer: ${error.message}`);
            } finally {
                if (cycleTLS) try { await cycleTLS.exit(); } catch (e) { logger.error("[Dashboard] Error exiting cycleTLS:", e); }
            }
        });

        app.post("/manage/:guildId/edit-subscription", checkAuth, checkGuildAdmin, async (req, res) => {
            const {guildId} = req.params;
            const {subscription_id, discord_user_id, kick_username, announcement_channel_id, override_nickname, custom_message, override_avatar_url} = req.body;
            if (!subscription_id) return res.redirect(`/manage/${guildId}?error=Missing subscription ID.`);

            try {
                const [[subscription]] = await db.execute("SELECT streamer_id FROM subscriptions WHERE subscription_id = ?", [subscription_id]);
                if (!subscription) return res.redirect(`/manage/${guildId}?error=Subscription not found.`);
                const streamerId = subscription.streamer_id;

                const correctedDiscordId = /^[0-9]+$/.test(discord_user_id) ? discord_user_id : null;
                await db.execute(`UPDATE streamers SET discord_user_id=?, kick_username=? WHERE streamer_id = ?`, [correctedDiscordId, kick_username || null, streamerId]);

                const targetChannelId = announcement_channel_id || null;
                const finalOverrideAvatarUrl = override_avatar_url === "reset" ? null : override_avatar_url;
                await db.execute(`UPDATE subscriptions SET announcement_channel_id=?, custom_message=?, override_nickname=?, override_avatar_url=? WHERE subscription_id = ?`, [targetChannelId, custom_message || null, override_nickname || null, finalOverrideAvatarUrl, subscription_id]);

                res.redirect(`/manage/${guildId}?success=Subscription updated successfully.`);
            } catch (error) {
                logger.error(`[Dashboard] Error editing subscription for guild ${guildId}:`, error);
                res.redirect(`/manage/${guildId}?error=Failed to update subscription: ${error.message}`);
            }
        });

        app.get("/manage/:guildId", checkAuth, isBotReady, checkGuildAdmin, async (req, res) => {
            try {
                const [guildSettings] = await db.execute("SELECT * FROM guilds WHERE guild_id = ?", [req.params.guildId]);
                const [subscribedChannelIdsRaw] = await db.execute("SELECT DISTINCT announcement_channel_id FROM subscriptions WHERE guild_id = ? AND announcement_channel_id IS NOT NULL", [req.params.guildId]);
                const [teamSubscribedChannelIdsRaw] = await db.execute("SELECT DISTINCT announcement_channel_id FROM twitch_teams WHERE guild_id = ? AND announcement_channel_id IS NOT NULL", [req.params.guildId]);
                const allSubscribedChannelIds = new Set([...subscribedChannelIdsRaw.map(r => r.announcement_channel_id), ...teamSubscribedChannelIdsRaw.map(r => r.announcement_channel_id)]);

                const channelsData = {};
                let roles = [];
                for (const channelId of allSubscribedChannelIds) {
                    const c = req.guildObject.channels.cache.get(channelId);
                    channelsData[channelId] = { id: channelId, name: c ? c.name : `Unknown Channel`, individualStreamers: [], teams: [] };
                }
                roles = [...req.guildObject.roles.cache.values()];
                const channels = [...req.guildObject.channels.cache.filter(c => c.type === ChannelType.GuildText).values()];

                const [teamSubscriptionsRaw] = await db.execute("SELECT * FROM twitch_teams WHERE guild_id = ?", [req.params.guildId]);
                const [subscribedStreamersRaw] = await db.execute("SELECT s.streamer_id, s.username, s.platform, s.profile_image_url, s.kick_username, sub.subscription_id, sub.announcement_channel_id, sub.discord_user_id, sub.override_nickname, sub.custom_message, sub.override_avatar_url FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ?", [req.params.guildId]);

                for (const streamerSub of subscribedStreamersRaw) {
                    const channelId = streamerSub.announcement_channel_id;
                    if (channelsData[channelId]) channelsData[channelId].individualStreamers.push(streamerSub);
                }

                for (const teamSub of teamSubscriptionsRaw) {
                    const channelId = teamSub.announcement_channel_id;
                    if (channelsData[channelId]) {
                        const [teamMembers] = await db.execute(`SELECT s.streamer_id, s.username, s.platform, s.profile_image_url FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? AND sub.announcement_channel_id = ? AND (s.platform = 'twitch' OR s.platform = 'kick')`, [req.params.guildId, channelId]);
                        channelsData[channelId].teams.push({ ...teamSub, members: teamMembers });
                    }
                }

                const [activeAnnouncements] = await db.execute("SELECT a.stream_title, a.platform, a.stream_thumbnail_url, s.username FROM announcements a JOIN streamers s ON a.streamer_id = s.streamer_id WHERE a.guild_id = ?", [req.params.guildId]);
                
                const totalSubscriptions = subscribedStreamersRaw.length;

                res.render("manage", {
                    user: req.user, isAuthenticated: req.isAuthenticated(), guild: req.guildObject, guildSettings: guildSettings[0] || {},
                    channels,
                    roles, commands: [...dashboard.client.commands.values()].map(c=>c.data),
                    analyticsData: { totalStreamers: subscribedStreamersRaw.length, activeAnnouncements: activeAnnouncements.length },
                    channelsData: Object.values(channelsData).filter(d => d.individualStreamers.length > 0 || d.teams.length > 0),
                    teamSubscriptions: teamSubscriptionsRaw,
                    subscribedStreamers: subscribedStreamersRaw,
                    activeAnnouncements,
                    totalSubscriptions
                });
            } catch (e) {
                logger.error(`[Dashboard] Error loading manage page for guild ${req.params.guildId}:`, e);
                res.status(500).render("error", {user: req.user, error: "Failed to load server management page."});
            }
        });

        app.get("/commands", isBotReady, (req, res) => res.render("commands", {user: req.user, isAuthenticated: req.isAuthenticated(), commands: [...dashboard.client.commands.values()].map(c=>c.data)}));
        app.get("/help", isBotReady, (req, res) => res.render("commands", {user: req.user, isAuthenticated: req.isAuthenticated(), commands: [...dashboard.client.commands.values()].map(c=>c.data)}));

        const server = app.listen(port, () => {
            logger.info(`[Dashboard] Web dashboard listening on port ${port}`);
            resolve();
        });

        server.on('error', (error) => {
            logger.error(`[Dashboard] Error starting web server:`, error);
            reject(error);
        });
    });
  }
};

module.exports = dashboard;