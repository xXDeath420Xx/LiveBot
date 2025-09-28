import express from "express";
import expressSession from "express-session";
import passport from "passport";
import path from "path";
import * as fs from "fs";
import {Client, PermissionsBitField} from "discord.js";
import {logger} from "../utils/logger";
import * as apiChecks from "../utils/api_checks";
import initCycleTLS from "cycletls";

// Helper function to format uptime
function formatUptime(seconds: number) {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor(seconds % (3600 * 24) / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);

    let parts = [];
    if (d > 0) {
        parts.push(`${d} day${d === 1 ? "" : "s"}`);
    }
    if (h > 0) {
        parts.push(`${h} hour${h === 1 ? "" : "s"}`);
    }
    if (m > 0) {
        parts.push(`${m} minute${m === 1 ? "" : "s"}`);
    }
    if (s > 0) {
        parts.push(`${s} second${s === 1 ? "" : "s"}`);
    }

    return parts.join(', ');
}

const dashboard = {
    client: null,
    getStatus: () => ({state: "UNKNOWN", message: "Status provider not registered."}),

    setClient(newClient: Client|null) {
        this.client = newClient;
        logger.info("[Dashboard] Discord client set.");
    },

    start(botClient: Client|null, statusGetter: () => { state: string, message: string }) {
        return new Promise((resolve: any, reject: any) => {
            if (botClient) {
                this.client = botClient;
            }
            if (statusGetter) {
                this.getStatus = statusGetter;
            }

            const app = express();
            const port = process.env.DASHBOARD_PORT || 3000;

            if (!process.env.SESSION_SECRET) {
                logger.error("[Dashboard] FATAL: SESSION_SECRET is not defined.");
                return reject(new Error("SESSION_SECRET is not defined in the environment variables."));
            }

            app.use(expressSession({secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: {maxAge: 1000 * 60 * 60 * 24}}));
            app.use(passport.initialize());
            app.use(passport.session());
            app.use(express.json());
            app.use(express.urlencoded({extended: true}));
            app.use(express.static(path.join(__dirname, "public")));
            app.set("view engine", "ejs");
            app.set("views", path.join(__dirname, "views"));

            const isBotReady = (req: any, res: any, next: any) => {
                logger.debug(`[Dashboard Middleware] isBotReady check: client=${!!dashboard.client}, status=${dashboard.getStatus().state}`);
                if (dashboard.client && dashboard.getStatus().state === "ONLINE") {
                    return next();
                }
                return res.status(503).render("status", {user: req.user, isAuthenticated: req.isAuthenticated(), botStatus: dashboard.getStatus()});
            };

            const checkAuth = (req: any, res: any, next: any) => {
                if (req.isAuthenticated()) {
                    return next();
                }
                return res.redirect("/login");
            };

            const checkGuildAdmin = (req: any, res: any, next: any) => {
                logger.debug(`[Dashboard Middleware] checkGuildAdmin for guild ${req.params.guildId}: user=${!!req.user}, guilds=${req.user?.guilds?.length}, client=${!!dashboard.client}, client.guilds.cache.has=${dashboard.client?.guilds.cache.has(req.params.guildId)}`);
                if (!req.user || !req.user.guilds) {
                    return res.status(403).render("error", {user: req.user, error: "Authentication error."});
                }
                const guild = req.user.guilds.find((g: { id: string; }) => g.id === req.params.guildId);
                if (guild && new PermissionsBitField(BigInt(guild.permissions)).has(PermissionsBitField.Flags.ManageGuild) && dashboard.client?.guilds.cache.has(req.params.guildId)) {
                    req.guildObject = dashboard.client.guilds.cache.get(req.params.guildId);
                    return next();
                }
                return res.status(403).render("error", {user: req.user, error: "Permission denied."});
            };

            // --- ALL APP.GET AND APP.POST ROUTES GO HERE ---
            app.get("/", (req, res) => res.render("landing", {user: req.user, client_id: process.env.DISCORD_CLIENT_ID}));
            app.get("/donate", (req, res) => res.render("donate", {user: req.user}));
            app.get("/api/status", (req, res) => res.json(dashboard.getStatus()));

            // New /status route to render the status page
            app.get("/status", (req, res) => {
                res.render("status", {user: req.user, isAuthenticated: req.isAuthenticated(), botStatus: dashboard.getStatus()});
            });

            // API endpoint for status data (used by status.ejs client-side JS)
            app.get("/api/status-data", async (req, res) => {
                logger.debug("[Dashboard API] Received request for /api/status-data");
                try {
                    const [totalStreamersResult] = await db.execute("SELECT COUNT(DISTINCT streamer_id) as count FROM streamers");
                    const [totalGuildsResult] = await db.execute("SELECT COUNT(DISTINCT guild_id) as count FROM guilds");
                    const [totalAnnouncementsResult] = await db.execute("SELECT COUNT(*) as count FROM announcements");
                    const [liveStreamersRaw] = await db.execute(
                        "SELECT a.stream_title, a.platform, a.stream_thumbnail_url, s.username, s.profile_image_url FROM announcements a JOIN streamers s ON a.streamer_id = s.streamer_id"
                    );
                    const formattedUrl = (s: any) => {
                        let formattedUrl;
                        switch (s.platform) {
                            case "twitch":
                                formattedUrl = `https://twitch.tv/${s.username}`;
                                break;
                            case "kick":
                                formattedUrl = `https://kick.com/${s.username}`;
                                break;
                            default:
                                formattedUrl = "#";
                                break;
                        }
                        return formattedUrl;
                    };

                    const liveStreamers = liveStreamersRaw.map((s: { username: any; platform: any; profile_image_url: any; }) => ({
                        username: s.username,
                        platform: s.platform,
                        avatar_url: s.profile_image_url || "/images/default-icon.png",
                        live_platforms: [{
                            platform: s.platform,
                            url: formattedUrl(s),
                        }]
                    }));

                    const platformDistributionMap = new Map();
                    liveStreamersRaw.forEach((s: { platform: string | null; }) => {
                        const platform = s.platform;
                        platformDistributionMap.set(platform, (platformDistributionMap.get(platform) || 0) + 1);
                    });
                    const platformDistribution = Array.from(platformDistributionMap, ([platform, count]) => ({platform, count}));

                    const responseData = {
                        liveCount: liveStreamers.length,
                        totalStreamers: totalStreamersResult[0].count,
                        totalGuilds: totalGuildsResult[0].count,
                        totalAnnouncements: totalAnnouncementsResult[0].count,
                        liveStreamers: liveStreamers,
                        platformDistribution: platformDistribution,
                        app: {status: dashboard.getStatus().state, uptime: process.uptime()}, // Basic app status
                        db: {status: "ok"}, // Assume THE DB is ok if queries ran
                        api: {twitch: "ok", youtube: "ok", kick: "ok"} // Placeholder, actual checks would be more complex
                    };
                    logger.debug("[Dashboard API] Sending /api/status-data response:", {data: responseData});
                    res.json(responseData);

                } catch (error) {
                    logger.error("[Dashboard API] Error fetching status data:", error);
                    res.status(500).json({error: "Failed to fetch status data."});
                }
            });

            // API endpoint for authenticated logs
            app.get("/api/authenticated-logs", checkAuth, async (req, res) => {
                const logFilePath = path.join(__dirname, "../combined.log"); // Corrected log file path
                try {
                    // Check if the log file exists before attempting to read it
                    if (!fs.existsSync(logFilePath)) {
                        logger.warn(`[Dashboard API] Log file not found at: ${logFilePath}`);
                        return res.status(404).json({error: "Log file not found."});
                    }
                    const logs = await fs.promises.readFile(logFilePath, "utf8");
                    return res.json({logs});
                } catch (error) {
                    logger.error("[Dashboard API] Error fetching logs:", error);
                    return res.status(500).json({error: "Failed to fetch logs."});
                }
            });

            // Discord OAuth routes
            app.get("/auth/discord", passport.authenticate("discord"));
            app.get("/auth/discord/callback", passport.authenticate("discord", {failureRedirect: "/login"}), (req, res) => {
                res.redirect("/dashboard");
            });
            app.get("/login", (req, res) => res.render("login", {user: req.user, isAuthenticated: req.isAuthenticated()}));
            app.get("/logout", (req, res) => {
                req.logout(() => {
                    res.redirect("/");
                });
            });

            // Dashboard routes
            app.get("/dashboard", checkAuth, isBotReady, (req, res) => {
                const manageableGuilds = req.user?.guilds.filter((g: { permissions: string | number | bigint | boolean; id: string | number; }) =>
                    new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild) &&
                    dashboard.client?.guilds.cache.has(g.id) // Filter for guilds the bot is in
                );
                res.render("dashboard", {user: req.user, isAuthenticated: req.isAuthenticated(), manageableGuilds: manageableGuilds});
            });

            app.post("/manage/:guildId/add", checkAuth, checkGuildAdmin, async (req, res) => {
                const {guildId} = req.params;
                let {platform, username, discord_user_id: discordUserId, announcement_channel_id: announcementChannelId} = req.body;

                if (!platform || !username) {
                    return res.redirect(`/manage/${guildId}?error=Missing platform or username.`);
                }

                let cycleTLS = null;
                try {
                    let streamerInfo = null;
                    const [[existingStreamer]] = await db.execute("SELECT streamer_id, platform_user_id, username FROM streamers WHERE platform = ? AND username = ?", [platform, username]);

                    if (existingStreamer) {
                        streamerInfo = {id: existingStreamer.streamer_id, puid: existingStreamer.platform_user_id, dbUsername: existingStreamer.username};
                    } else {
                        // Perform API validation for new streamers
                        let u;
                        switch (platform) {
                            case "twitch":
                                u = await apiChecks.getTwitchUser(username);
                                if (u) {
                                    streamerInfo = {puid: u.id, dbUsername: u.login};
                                }
                                break;
                            case "kick":
                                cycleTLS = await initCycleTLS({timeout: 60000});
                                u = await apiChecks.getKickUser(cycleTLS, username);
                                if (u) {
                                    streamerInfo = {puid: u.id.toString(), dbUsername: u.user.username};
                                }
                                break;
                            case "youtube":
                                const channelId = await apiChecks.getYouTubeChannelId(username);
                                if (channelId) {
                                    streamerInfo = {puid: channelId, dbUsername: username};
                                }
                                break;
                            case "tiktok":
                            case "trovo":
                                // No reliable validation available
                                streamerInfo = {puid: username, dbUsername: username};
                                break;
                        }

                        if (!streamerInfo) {
                            return res.redirect(`/manage/${guildId}?error=Streamer ${username} not found on ${platform}.`);
                        }
                    }

                    // Ensure discord_user_id is valid if provided
                    const correctedDiscordId = /^[0-9]+$/.test(discordUserId) ? discordUserId : null;

                    let streamerId;
                    if (existingStreamer) {
                        streamerId = existingStreamer.streamer_id;
                        // Only update username and profile_image_url, DO NOT update discord_user_id here.
                        await db.execute(
                            `UPDATE streamers
                             SET username=?,
                                 platform_user_id=?
                             WHERE streamer_id = ?`,
                            [streamerInfo.dbUsername, streamerInfo.puid, streamerId]
                        );
                    } else {
                        const [result] = await db.execute(
                            `INSERT INTO streamers (platform, platform_user_id, username, discord_user_id)
                             VALUES (?, ?, ?, ?)`,
                            [platform, streamerInfo.puid, streamerInfo.dbUsername, correctedDiscordId]
                        );
                        streamerId = result.insertId;
                    }

                    // Handle multiple announcement channels
                    const channelIds = Array.isArray(announcementChannelId) ? announcementChannelId : [announcementChannelId];

                    for (const chId of channelIds) {
                        const targetChannelId = chId || null; // Use null for server default

                        // Check if subscription already exists
                        const [[existingSubscription]] = await db.execute(
                            "SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ? AND announcement_channel_id <=> ?",
                            [guildId, streamerId, targetChannelId]
                        );

                        if (!existingSubscription) {
                            await db.execute(
                                `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id)
                                 VALUES (?, ?, ?)`,
                                [guildId, streamerId, targetChannelId]
                            );
                        }
                    }

                    return res.redirect(`/manage/${guildId}?success=Streamer ${username} added/updated successfully.`);

                } catch (error) {
                    logger.error(`[Dashboard] Error adding streamer for guild ${guildId}:`, error);
                    return res.redirect(`/manage/${guildId}?error=Failed to add streamer: ${error.message}`);
                } finally {
                    if (cycleTLS) {
                        try {
                            await cycleTLS.exit();
                        } catch (e) {
                            logger.error("[Dashboard] Error exiting cycleTLS:", e);
                        }
                    }
                }
            });

            app.post("/manage/:guildId/edit-subscription", checkAuth, checkGuildAdmin, async (req, res) => {
                const {guildId} = req.params;
                const {
                    subscription_id: subscriptionId,
                    discord_user_id: discordUserId,
                    kick_username: kickUsername,
                    announcement_channel_id: announcementChannelId,
                    override_nickname: overrideNickname,
                    custom_message: customMessage,
                    override_avatar_url: overrideAvatarUrl
                } = req.body;

                if (!subscriptionId) {
                    return res.redirect(`/manage/${guildId}?error=Missing subscription ID.`);
                }

                try {
                    // Fetch the existing subscription to get streamer_id
                    const [[subscription]] = await db.execute("SELECT streamer_id FROM subscriptions WHERE subscription_id = ?", [subscriptionId]);
                    if (!subscription) {
                        return res.redirect(`/manage/${guildId}?error=Subscription not found.`);
                    }
                    const streamerId = subscription.streamer_id;

                    // Update streamer details (discord_user_id, kick_username)
                    // Ensure discord_user_id is valid if provided
                    const correctedDiscordId = /^[0-9]+$/.test(discordUserId) ? discordUserId : null;
                    await db.execute(
                        `UPDATE streamers
                         SET discord_user_id=?,
                             kick_username=?
                         WHERE streamer_id = ?`,
                        [correctedDiscordId, kickUsername || null, streamerId]
                    );

                    // Update subscription details
                    const targetChannelId = announcementChannelId || null; // Use null for server default
                    const finalOverrideAvatarUrl = overrideAvatarUrl === "reset" ? null : overrideAvatarUrl;

                    await db.execute(
                        `UPDATE subscriptions
                         SET announcement_channel_id=?,
                             custom_message=?,
                             override_nickname=?,
                             override_avatar_url=?
                         WHERE subscription_id = ?`,
                        [targetChannelId, customMessage || null, overrideNickname || null, finalOverrideAvatarUrl, subscriptionId]
                    );

                    res.redirect(`/manage/${guildId}?success=Subscription updated successfully.`);

                } catch (error) {
                    logger.error(`[Dashboard] Error editing subscription for guild ${guildId}:`, error);
                    res.redirect(`/manage/${guildId}?error=Failed to update subscription: ${error.message}`);
                }
            });

            app.get("/manage/:guildId", checkAuth, isBotReady, checkGuildAdmin, async (req, res) => {
                const [guildSettings] = await db.execute("SELECT * FROM guilds WHERE guild_id = ?", [req.params.guildId]);

                // Fetch all unique channel IDs that have subscriptions in this guild
                const [subscribedChannelIdsRaw] = await db.execute(
                    "SELECT DISTINCT announcement_channel_id FROM subscriptions WHERE guild_id = ? AND announcement_channel_id IS NOT NULL",
                    [req.params.guildId]
                );
                const [teamSubscribedChannelIdsRaw] = await db.execute(
                    "SELECT DISTINCT announcement_channel_id FROM twitch_teams WHERE guild_id = ? AND announcement_channel_id IS NOT NULL",
                    [req.params.guildId]
                );
                const allSubscribedChannelIds = new Set([
                    ...subscribedChannelIdsRaw.map((row: { announcement_channel_id: string; }) => row.announcement_channel_id),
                    ...teamSubscribedChannelIdsRaw.map((row: { announcement_channel_id: string; }) => row.announcement_channel_id)
                ]);

                // Initialize channelsData only with subscribed channels
                let channelsData = {};
                let roles;
                if (req.guildObject) {
                    try {
                        for (const channelId of allSubscribedChannelIds) {
                            const c = req.guildObject.channels.cache.get(channelId);
                            channelsData[channelId] = {
                                id: channelId,
                                name: c?.name ?? `Unknown Channel ID: ${channelId}`, // Use channel name if found, otherwise placeholder
                                individualStreamers: [],
                                teams: []
                            };
                        }
                        // Fetch all roles for the guild
                        roles = [...req.guildObject.roles.cache.values()];
                    } catch (e) {
                        logger.error(`[Dashboard] Error processing channels or roles for guild ${req.params.guildId}:`, e);
                    }
                }

                // Fetch team subscriptions for the guild
                const [teamSubscriptionsRaw] = await db.execute("SELECT * FROM twitch_teams WHERE guild_id = ?", [req.params.guildId]);

                // Fetch subscribed streamers for the guild
                const [subscribedStreamersRaw] = await db.execute(
                    "SELECT s.streamer_id, s.username, s.platform, s.profile_image_url, s.kick_username, sub.subscription_id, sub.announcement_channel_id, sub.discord_user_id, sub.override_nickname, sub.custom_message, sub.override_avatar_url FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ?",
                    [req.params.guildId]
                );

                // Populate individual streamers into channelsData
                for (const streamerSub of subscribedStreamersRaw) {
                    const channelId = streamerSub.announcement_channel_id;
                    if (channelsData[channelId]) {
                        channelsData[channelId].individualStreamers.push(streamerSub);
                    } else {
                        // This case should ideally not happen if allSubscribedChannelIds is correctly populated
                        logger.warn(`[Dashboard] Individual subscription found for unlisted channel ID ${channelId} in guild ${req.params.guildId}. This channel might be missing from allSubscribedChannelIds.`);
                    }
                }

                // Populate teams and their members into channelsData
                for (const teamSub of teamSubscriptionsRaw) {
                    const channelId = teamSub.announcement_channel_id;
                    if (channelsData[channelId]) {
                        // Fetch members for each team (both Twitch and linked Kick)
                        const [teamMembers] = await db.execute(
                            `SELECT s.streamer_id, s.username, s.platform, s.profile_image_url
                             FROM subscriptions sub
                                      JOIN streamers s ON sub.streamer_id = s.streamer_id
                             WHERE sub.guild_id = ?
                               AND sub.announcement_channel_id = ?
                               AND (s.platform = 'twitch' OR s.platform = 'kick')`,
                            [req.params.guildId, channelId]
                        );
                        channelsData[channelId].teams.push({
                            ...teamSub,
                            members: teamMembers // Attach members to the team
                        });
                    } else {
                        // This case should ideally not happen if allSubscribedChannelIds is correctly populated
                        logger.warn(`[Dashboard] Team subscription found for unlisted channel ID ${channelId} in guild ${req.params.guildId}. This channel might be missing from allSubscribedChannelIds.`);
                    }
                }

                // Filter out channels that have no streamers or teams after population
                const filteredChannelsData: [{ id: string, name: string, individualStreamers: [], teams: [] }] = {};
                let channelId: string;
                let data: { id: string, name: string, individualStreamers: [], teams: [] };
                for ([channelId, data] of Object.entries(channelsData)) {
                    if (data?.individualStreamers.length > 0 || data?.teams.length > 0) {
                        filteredChannelsData[channelId] = data;
                    }
                }

                // Calculate totalSubscriptions
                const totalSubscriptions = subscribedStreamersRaw.length + teamSubscriptionsRaw.reduce((acc: number, team: any) => acc + (team.members ? team.members.length : 0), 0);

                // Fetch active announcements for the guild
                const [activeAnnouncements] = await db.execute(
                    "SELECT a.stream_title, a.platform, a.stream_thumbnail_url, s.username FROM announcements a JOIN streamers s ON a.streamer_id = s.streamer_id WHERE a.guild_id = ?",
                    [req.params.guildId]
                );

                // Load bot commands dynamically
                const commands = [];
                if (dashboard.client && dashboard.client.commands) {
                    dashboard.client.commands.forEach((cmd: { data: { name: any; description: any; }; }) => {
                        commands.push({name: cmd.data.name, description: cmd.data.description});
                    });
                }

                // Calculate basic analytics
                const analyticsData = {
                    totalStreamers: subscribedStreamersRaw.length, // This might need adjustment if you count Kick streamers separately
                    totalSubscriptions: totalSubscriptions,
                    activeAnnouncements: activeAnnouncements.length,
                };

                res.render("manage", {
                    user: req.user,
                    isAuthenticated: req.isAuthenticated(),
                    guild: req.guildObject,
                    guildSettings: guildSettings[0] || {},
                    channels: [], // No longer needed as channelsData is structured
                    roles,
                    commands, // Pass commands
                    permissions: [], // Initialize permissions as an empty array to prevent TypeError
                    analyticsData, // Pass analytics data
                    teamSubscriptions: teamSubscriptionsRaw, // Pass raw team subscriptions
                    subscribedStreamers: subscribedStreamersRaw, // Pass raw subscribed streamers
                    activeAnnouncements, // Pass active announcements
                    channelsData: filteredChannelsData, // Pass the newly structured and filtered channelsData
                    totalSubscriptions // Pass totalSubscriptions
                });
            });

            app.get("/commands", isBotReady, (req, res) => { // Removed checkAuth
                // Load bot commands dynamically for the commands page as well
                const commands = [];
                if (dashboard.client && dashboard.client.commands) {
                    dashboard.client.commands.forEach(cmd => {
                        commands.push({name: cmd.data.name, description: cmd.data.description});
                    });
                }
                res.render("commands", {user: req.user, isAuthenticated: req.isAuthenticated(), commands: commands});
            });

            app.get("/help", isBotReady, (req, res) => { // Removed checkAuth
                // Load bot commands dynamically for the help page as well
                const commands = [];
                if (dashboard.client && dashboard.client.commands) {
                    dashboard.client.commands.forEach(cmd => {
                        commands.push({name: cmd.data.name, description: cmd.data.description});
                    });
                }
                res.render("commands", {user: req.user, isAuthenticated: req.isAuthenticated(), commands: commands});
            });

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

export {dashboard};
