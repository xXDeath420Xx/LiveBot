const express = require("express");
const session = require("express-session");
const passport = require("passport");
require("./passport-setup");
const path = require("path");
const fs = require("fs");
const db = require("../utils/db");
const multer = require("multer");
const { exec } = require("child_process");
const pm2 = require("pm2");
const apiChecks = require("../utils/api_checks.js");
const logger = require("../utils/logger");
const { startupCleanup: botStartupCleanup } = require("../core/startup.js");
const { syncTwitchTeam } = require("../core/team-sync.js");
const { PermissionsBitField } = require("discord.js");
const initCycleTLS = require("cycletls");

const app = express();
const upload = multer({ dest: 'uploads/' });

// --- UTILITY FUNCTIONS ---
const getDefaultAvatar = (discriminator) => `https://cdn.discordapp.com/embed/avatars/${discriminator % 5}.png`;

function normalizeUsername(username) {
    if (!username) return '';
    return username.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/_/g, '');
}

function getPlatformUrl(streamer) {
    const username = streamer.kick_username || streamer.username;
    switch (streamer.platform) {
        case "twitch": return `https://www.twitch.tv/${username}`;
        case "kick": return `https://kick.com/${username}`;
        case "youtube": return `https://www.youtube.com/channel/${streamer.platform_user_id}`;
        case "tiktok": return `https://www.tiktok.com/@${username}`;
        case "trovo": return `https://trovo.live/s/${username}`;
        default: return "#";
    }
}

async function getFormattedLiveRows(rows) {
    const userGroups = new Map();
    for (const row of rows) {
        const key = row.discord_user_id || normalizeUsername(row.username);
        if (!key) continue;
        if (!userGroups.has(key)) {
            let primaryAccount = row;
            if (row.discord_user_id) {
                const allAccounts = await db.execute("SELECT * FROM streamers WHERE discord_user_id = ?", [row.discord_user_id]).then(res => res[0]);
                primaryAccount = allAccounts.find(a => a.platform === 'twitch') || allAccounts[0] || row;
            }
            userGroups.set(key, {
                username: primaryAccount.username,
                avatar_url: primaryAccount.profile_image_url || getDefaultAvatar(0),
                live_platforms: new Map()
            });
        }
        const group = userGroups.get(key);
        group.live_platforms.set(row.platform, { platform: row.platform, username: row.username, game: row.stream_game || "N/A", url: getPlatformUrl(row) });
    }
    return Array.from(userGroups.values()).map(group => {
        const live_platforms_array = Array.from(group.live_platforms.values());
        return { username: group.username, avatar_url: group.avatar_url, live_platforms: live_platforms_array };
    });
}

function start(clientInstance, discordPermissionsBitField) {
    const BOT_OWNER_ID = "365905620060340224";
    if (!process.env.SESSION_SECRET) {
        logger.error("[Dashboard] FATAL: SESSION_SECRET is not defined.");
        process.exit(1);
    }

    app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 1000 * 60 * 60 * 24 } }));
    app.use(passport.initialize());
    app.use(passport.session());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.static(path.join(__dirname, "public")));
    app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
    app.set("view engine", "ejs");
    app.set("views", path.join(__dirname, "views"));

    // --- MIDDLEWARE ---
    const checkAuth = (req, res, next) => {
        if (req.isAuthenticated()) return next();
        if (req.path.startsWith("/api/")) return res.status(401).json({ error: true, message: "Unauthorized" });
        res.redirect("/login");
    };

    const checkGuildAdmin = async (req, res, next) => {
        try {
            const guildId = req.params.guildId;
            if (req.user && req.user.id === BOT_OWNER_ID) {
                req.guildObject = clientInstance.guilds.cache.get(guildId);
                if (req.guildObject) return next();
                return res.status(404).render("error", { user: req.user, error: "Bot is not in this guild." });
            }
            if (!req.user || !req.user.guilds) {
                return res.status(403).render("error", { user: req.user, error: "Authentication error." });
            }
            const guild = req.user.guilds.find(g => g.id === guildId);
            if (guild && new discordPermissionsBitField(BigInt(guild.permissions)).has(discordPermissionsBitField.Flags.ManageGuild) && clientInstance.guilds.cache.has(guildId)) {
                req.guildObject = clientInstance.guilds.cache.get(guildId);
                if (req.guildObject) return next();
            }
            res.status(403).render("error", { user: req.user, error: "Permission denied." });
        } catch (e) {
            logger.error("[checkGuildAdmin Middleware Error]", { error: e });
            res.status(500).render("error", { user: req.user, error: "An internal error occurred." });
        }
    };

    const checkBotOwner = (req, res, next) => {
        if (req.user && req.user.id === BOT_OWNER_ID) return next();
        if (req.path.startsWith("/api/")) {
            return res.status(403).json({ error: true, message: "This action is restricted to the bot owner." });
        }
        res.status(403).render("error", { user: req.user, error: "This action is restricted to the bot owner." });
    };

    // --- MAIN ROUTES ---
    app.get("/", (req, res) => res.render("landing", { user: req.user, client_id: process.env.DISCORD_CLIENT_ID }));
    app.get("/help", (req, res) => res.render("commands", { user: req.user }));
    app.get("/status", (req, res) => res.render("status", { user: req.user, isAuthenticated: req.isAuthenticated() }));
    app.get("/donate", (req, res) => res.render("donate", { user: req.user }));
    app.get("/login", passport.authenticate("discord"));
    app.get("/auth/discord/callback", passport.authenticate("discord", { failureRedirect: "/" }), (req, res) => res.redirect("/dashboard"));
    app.get("/logout", (req, res) => { req.logout(() => res.redirect("/")); });

    app.get("/super-admin", checkAuth, checkBotOwner, (req, res) => {
        res.render("super-admin", { user: req.user });
    });

    app.get("/dashboard", checkAuth, (req, res) => {
        const manageableGuilds = (req.user.id === BOT_OWNER_ID)
            ? [...clientInstance.guilds.cache.values()]
            : req.user.guilds.filter(g => new discordPermissionsBitField(BigInt(g.permissions)).has(discordPermissionsBitField.Flags.ManageGuild) && clientInstance.guilds.cache.has(g.id));
        res.render("dashboard", { manageableGuilds, user: req.user });
    });

    // --- MANAGEMENT VIEW ROUTE ---
    app.get("/manage/:guildId", checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const botGuild = req.guildObject;
            const guildId = botGuild.id;
            const isBotOwner = req.user.id === BOT_OWNER_ID;

            const [subscriptionsResult, [[guildSettingsResult]], allRoles, allChannels, [rawTeamSubscriptions], [allStreamers]] = await Promise.all([
                db.execute(`SELECT sub.*, s.platform, s.username, s.discord_user_id, s.kick_username, s.streamer_id, s.profile_image_url FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ?`, [guildId]),
                db.execute("SELECT * FROM guilds WHERE guild_id = ?", [guildId]),
                botGuild.roles.fetch(),
                botGuild.channels.fetch(),
                db.execute("SELECT * FROM twitch_teams WHERE guild_id = ?", [guildId]),
                db.execute("SELECT streamer_id, platform, username, kick_username, discord_user_id, profile_image_url FROM streamers")
            ]);

            const allSubscriptions = subscriptionsResult[0];
            const channelsData = {};
            allChannels.filter(c => c.isTextBased()).forEach(ch => { channelsData[ch.id] = { name: ch.name, streamers: [] }; });
            channelsData["default"] = { name: "Server Default", streamers: [] };

            const userGroups = new Map();
            allSubscriptions.forEach(sub => {
                const streamer = allStreamers.find(s => s.streamer_id === sub.streamer_id);
                if (!streamer) return;

                const key = streamer.discord_user_id || normalizeUsername(streamer.username);
                if (!key) return;

                if (!userGroups.has(key)) {
                    const allPlatformsForUser = allStreamers.filter(s => (s.discord_user_id && s.discord_user_id === streamer.discord_user_id) || (normalizeUsername(s.username) === key));
                    const primaryAccount = allPlatformsForUser.find(p => p.platform === 'twitch') || allPlatformsForUser[0];

                    if (!primaryAccount) return;

                    userGroups.set(key, {
                        discord_user_id: primaryAccount.discord_user_id,
                        primaryDisplayName: primaryAccount.username,
                        primaryAvatarUrl: primaryAccount.profile_image_url,
                        linkedPlatforms: allPlatformsForUser.map(p => ({ platform: p.platform, username: p.username, url: getPlatformUrl(p) })).sort((a,b) => a.platform.localeCompare(b.platform)),
                        subscriptions: []
                    });
                }
                userGroups.get(key).subscriptions.push(sub);
            });

            userGroups.forEach(group => {
                const channelsForUser = new Set(group.subscriptions.map(s => s.announcement_channel_id || 'default'));
                channelsForUser.forEach(channelId => {
                    if (channelsData[channelId]) {
                        channelsData[channelId].streamers.push(group);
                    }
                });
            });

            Object.values(channelsData).forEach(ch => ch.streamers.sort((a, b) => a.primaryDisplayName.localeCompare(b.primaryDisplayName)));

            const teamSubscriptionsWithMembers = rawTeamSubscriptions.map(team => {
                const members = allSubscriptions
                    .filter(sub => sub.team_subscription_id === team.id)
                    .map(sub => allStreamers.find(s => s.streamer_id === sub.streamer_id))
                    .filter(Boolean);
                
                const memberUsers = [...new Map(members.map(item => [item.discord_user_id || normalizeUsername(item.username), item])).values()];

                return {
                    ...team,
                    members: memberUsers
                };
            });

            res.render("manage", {
                guild: botGuild,
                channelsData: Object.fromEntries(Object.entries(channelsData).filter(([, data]) => data.streamers.length > 0)),
                totalSubscriptions: userGroups.size,
                user: req.user,
                settings: guildSettingsResult[0] || {},
                roles: allRoles.filter(r => !r.managed && r.name !== "@everyone"),
                channels: allChannels.filter(c => c.isTextBased()),
                teamSubscriptions: teamSubscriptionsWithMembers,
                isBotOwner,
                manageableGuilds: isBotOwner ? [...clientInstance.guilds.cache.values()] : []
            });
        } catch (error) {
            logger.error("[Dashboard GET Error]", { error });
            res.status(500).render("error", { user: req.user, error: "An internal error occurred." });
        }
    });

    // --- ACTION & API ROUTES ---
    app.post("/manage/:guildId/settings", checkAuth, checkGuildAdmin, async (req, res) => {
        const { channelId, roleId } = req.body;
        await db.execute("INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = ?, live_role_id = ?", [req.params.guildId, channelId || null, roleId || null, channelId || null, roleId || null]);
        res.redirect(`/manage/${req.params.guildId}?success=settings`);
    });

    app.post("/manage/:guildId/add", checkAuth, checkGuildAdmin, async (req, res) => {
        const { platform, username, discord_user_id, announcement_channel_id } = req.body;
        let cycleTLS;
        try {
            cycleTLS = await initCycleTLS({ timeout: 15000 });
            let streamerInfo = { puid: null, dbUsername: null, pfp: null };
    
            if (platform === "twitch") {
                const u = await apiChecks.getTwitchUser(username);
                if (u) streamerInfo = { puid: u.id, dbUsername: u.login, pfp: u.profile_image_url };
            } else if (platform === "youtube") {
                const c = await apiChecks.getYouTubeChannelId(username);
                if (c?.channelId) streamerInfo = { puid: c.channelId, dbUsername: c.channelName || username };
            } else if (platform === "kick") {
                const u = await apiChecks.getKickUser(cycleTLS, username);
                if (u) streamerInfo = { puid: u.id.toString(), dbUsername: u.user.username, pfp: u.user.profile_pic };
            }
            if (!streamerInfo.puid) return res.status(400).render("error", { user: req.user, error: `Could not find streamer "${username}" on ${platform}.` });
    
            const potentialUsernames = [...new Set([username, streamerInfo.dbUsername].filter(Boolean).map(u => u.toLowerCase()))];
            if (potentialUsernames.length > 0) {
                const usernamePlaceholders = potentialUsernames.map(() => '?').join(',');
                
                let queryParams = [...potentialUsernames];
                let discordIdClause = '';
                if (discord_user_id) {
                    discordIdClause = 'OR discord_user_id = ?';
                    queryParams.push(discord_user_id);
                }
        
                const [existingAccounts] = await db.execute(`SELECT discord_user_id FROM streamers WHERE LOWER(username) IN (${usernamePlaceholders}) ${discordIdClause}`, queryParams);
                const canonicalDiscordId = discord_user_id || existingAccounts.find(a => a.discord_user_id)?.discord_user_id || null;
        
                await db.execute(
                    `INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, profile_image_url) VALUES (?, ?, ?, ?, ?) 
                     ON DUPLICATE KEY UPDATE 
                        username = VALUES(username), 
                        discord_user_id = COALESCE(streamers.discord_user_id, VALUES(discord_user_id)), 
                        profile_image_url = VALUES(profile_image_url)`,
                    [platform, streamerInfo.puid, streamerInfo.dbUsername, canonicalDiscordId, streamerInfo.pfp]
                );
            } else {
                await db.execute(
                    `INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, profile_image_url) VALUES (?, ?, ?, ?, ?) 
                     ON DUPLICATE KEY UPDATE 
                        username = VALUES(username), 
                        discord_user_id = COALESCE(streamers.discord_user_id, VALUES(discord_user_id)), 
                        profile_image_url = VALUES(profile_image_url)`,
                    [platform, streamerInfo.puid, streamerInfo.dbUsername, discord_user_id, streamerInfo.pfp]
                );
            }
    
            const [[streamer]] = await db.execute("SELECT streamer_id, discord_user_id FROM streamers WHERE platform = ? AND platform_user_id = ?", [platform, streamerInfo.puid]);
            if (!streamer) return res.status(500).render("error", { user: req.user, error: "Failed to retrieve streamer ID." });
    
            const ids = announcement_channel_id ? (Array.isArray(announcement_channel_id) ? announcement_channel_id : [""]) : [""];
            for (const channelId of ids) {
                await db.execute("INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)", [req.params.guildId, streamer.streamer_id, channelId || null]);
            }
    
            let kickUsername = null;
            if (platform !== 'kick') {
                try {
                    logger.info(`[Auto-Link] Checking for matching Kick account for ${username}`);
                    const kickUser = await apiChecks.getKickUser(cycleTLS, username);
                    if (kickUser && kickUser.user) {
                        kickUsername = kickUser.user.username;
                        logger.info(`[Auto-Link] Found matching Kick user: ${kickUsername}`);
                        
                        const finalDiscordId = streamer.discord_user_id;
    
                        await db.execute(
                            `INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, profile_image_url) VALUES (?, ?, ?, ?, ?) 
                             ON DUPLICATE KEY UPDATE 
                                username=VALUES(username), 
                                discord_user_id=COALESCE(streamers.discord_user_id, VALUES(discord_user_id)), 
                                profile_image_url=VALUES(profile_image_url)`,
                            ['kick', kickUser.id.toString(), kickUsername, finalDiscordId, kickUser.user.profile_pic]
                        );
                        const [[kickStreamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = 'kick' AND platform_user_id = ?", [kickUser.id.toString()]);
                        if (kickStreamer) {
                            for (const channelId of ids) {
                                await db.execute("INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)", [req.params.guildId, kickStreamer.streamer_id, channelId || null]);
                            }
                            logger.info(`[Auto-Link] Successfully linked and subscribed to Kick account ${kickUsername}.`);
                        }
                    }
                } catch (kickError) {
                    logger.error(`[Auto-Link] Error while searching for or adding Kick user for ${username}:`, kickError);
                }
            }
    
            const allRelatedUsernames = [...new Set([username, streamerInfo.dbUsername, kickUsername].filter(Boolean).map(u => u.toLowerCase()))];
            if (allRelatedUsernames.length > 0) {
                const allUsernamesPlaceholders = allRelatedUsernames.map(() => '?').join(',');
                const [allAccountsForUser] = await db.execute(`SELECT discord_user_id FROM streamers WHERE LOWER(username) IN (${allUsernamesPlaceholders})`, allRelatedUsernames);
                const ultimateDiscordId = streamer.discord_user_id || allAccountsForUser.find(a => a.discord_user_id)?.discord_user_id || null;
    
                if (ultimateDiscordId) {
                    await db.execute(
                        `UPDATE streamers SET discord_user_id = ? WHERE LOWER(username) IN (${allUsernamesPlaceholders}) AND (discord_user_id IS NULL OR discord_user_id != ?)`,
                        [ultimateDiscordId, ...allRelatedUsernames, ultimateDiscordId]
                    );
                }
            }
    
            res.redirect(`/manage/${req.params.guildId}?success=add`);
        } catch (error) {
            logger.error("[Dashboard Add Streamer Error]", { error });
            res.status(500).render("error", { user: req.user, error: `An error occurred: ${error.message}` });
        } finally {
            if (cycleTLS) await cycleTLS.exit().catch(logger.error);
        }
    });

    app.post("/manage/:guildId/remove-subscription", checkAuth, checkGuildAdmin, async (req, res) => {
        await db.execute("DELETE FROM subscriptions WHERE subscription_id = ? AND guild_id = ?", [req.body.subscription_id, req.params.guildId]);
        res.redirect(`/manage/${req.params.guildId}?success=remove`);
    });

    app.post("/manage/:guildId/subscribe-team", checkAuth, checkGuildAdmin, async (req, res) => {
        const { teamName, channelId } = req.body;
        const [result] = await db.execute("INSERT INTO twitch_teams (guild_id, team_name, announcement_channel_id) VALUES (?, ?, ?)", [req.params.guildId, teamName, channelId]);
        await syncTwitchTeam(result.insertId, db, apiChecks, logger);
        res.redirect(`/manage/${req.params.guildId}?success=team_added#v-pills-teams-tab`);
    });

    app.post("/manage/:guildId/removeteam", checkAuth, checkGuildAdmin, async (req, res) => {
        const { teamSubscriptionId } = req.body;
        await db.execute("DELETE FROM subscriptions WHERE team_subscription_id = ?", [teamSubscriptionId]);
        await db.execute("DELETE FROM twitch_teams WHERE id = ?", [teamSubscriptionId]);
        res.redirect(`/manage/${req.params.guildId}?success=team_removed#v-pills-teams-tab`);
    });

    app.post("/api/manage/:guildId/resync-team", checkAuth, checkGuildAdmin, async (req, res) => {
        const { teamId } = req.body;
        const result = await syncTwitchTeam(teamId, db, apiChecks, logger);
        res.status(result.success ? 200 : 500).json(result);
    });

    app.post("/api/copy-user", checkAuth, checkBotOwner, async (req, res) => {
        const { sourceGuildId, targetGuildId, discordUserId, normalizedUsername, targetChannelId } = req.body;
        if (!targetGuildId || !sourceGuildId || !targetChannelId) {
            return res.status(400).json({ success: false, message: "Source guild, target guild, and target channel must be specified." });
        }
        try {
            let userStreamerAccounts;
            if (discordUserId) {
                [userStreamerAccounts] = await db.execute("SELECT * FROM streamers WHERE discord_user_id = ?", [discordUserId]);
            } else {
                [userStreamerAccounts] = await db.execute("SELECT * FROM streamers WHERE ? IN (LOWER(username), LOWER(kick_username))", [normalizedUsername.toLowerCase()]);
            }
            if (!userStreamerAccounts || userStreamerAccounts.length === 0) {
                return res.status(404).json({ success: false, message: "No streamer accounts found for this user." });
            }
            const streamerIds = userStreamerAccounts.map(s => s.streamer_id);
            const placeholders = streamerIds.map(() => '?').join(',');
            const [sourceSubscriptions] = await db.execute(`SELECT DISTINCT streamer_id FROM subscriptions WHERE guild_id = ? AND streamer_id IN (${placeholders})`, [sourceGuildId, ...streamerIds]);
            if (sourceSubscriptions.length === 0) {
                return res.status(404).json({ success: false, message: "This user has no active subscriptions in the source server to copy." });
            }
            const finalChannelId = targetChannelId === 'default' ? null : targetChannelId;
            let copiedCount = 0;
            for (const sub of sourceSubscriptions) {
                const [result] = await db.execute("INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)", [targetGuildId, sub.streamer_id, finalChannelId]);
                if (result.affectedRows > 0) copiedCount++;
            }
            res.json({ success: true, message: `Successfully copied ${copiedCount} platform subscriptions.` });
        } catch (error) {
            logger.error("[SuperAdmin Copy User Error]", { error });
            res.status(500).json({ success: false, message: `An internal server error occurred: ${error.message}` });
        }
    });

    app.get("/api/guilds/:guildId/channels", checkAuth, checkBotOwner, async (req, res) => {
        const guild = clientInstance.guilds.cache.get(req.params.guildId);
        if (!guild) return res.status(404).json({ error: "Guild not found" });
        const channels = await guild.channels.fetch();
        const textChannels = channels.filter(c => c.isTextBased()).map(c => ({ id: c.id, name: c.name }));
        res.json(textChannels);
    });

    app.get("/api/status-data", async (req, res) => {
        try {
            const [ [[{totalStreamers}]], [[{totalGuilds}]], [[{totalAnnouncements}]], [platformDistribution], [liveRows] ] = await Promise.all([
                db.execute("SELECT COUNT(*) as totalStreamers FROM streamers"),
                db.execute("SELECT COUNT(DISTINCT guild_id) as totalGuilds FROM subscriptions"),
                db.execute("SELECT COUNT(*) as totalAnnouncements FROM announcements"),
                db.execute("SELECT platform, COUNT(*) as count FROM streamers WHERE platform IS NOT NULL AND platform != '' GROUP BY platform ORDER BY count DESC"),
                db.execute(`SELECT s.username, s.discord_user_id, s.profile_image_url, s.platform_user_id, s.streamer_id, a.platform, a.stream_game FROM announcements a JOIN streamers s ON a.streamer_id = s.streamer_id`)
            ]);

            const formattedLiveStreamers = await getFormattedLiveRows(liveRows);

            const publicData = {
                liveCount: formattedLiveStreamers.length,
                liveStreamers: formattedLiveStreamers,
                totalStreamers,
                totalGuilds,
                totalAnnouncements,
                platformDistribution
            };

            if (req.isAuthenticated() && req.user.id === BOT_OWNER_ID) {
                const pm2DataPromise = new Promise((resolve) => {
                    pm2.describe("LiveBot", (err, procList) => {
                        if (err || !procList || procList.length === 0) {
                            return resolve({ app: { status: "offline" } });
                        }
                        const proc = procList[0];
                        const uptime = proc.pm2_env.pm_uptime ? new Date(Date.now() - proc.pm2_env.pm_uptime).toISOString().slice(11, 19) : "N/A";
                        resolve({ app: { status: proc.pm2_env.status, uptime } });
                    });
                });
                const dbConnectionPromise = db.getConnection().then(c => { c.release(); return { status: "ok" }; }).catch(() => ({ status: "error" }));
                const twitchApiPromise = apiChecks.getTwitchUser("twitch").then(u => ({ status: u ? "ok" : "error" })).catch(() => ({ status: "error" }));

                const [pm2Result, dbStatus, twitchStatus] = await Promise.all([pm2DataPromise, dbConnectionPromise, twitchApiPromise]);
                return res.json({ ...publicData, ...pm2Result, db: dbStatus, api: { twitch: twitchStatus.status } });
            }

            res.json(publicData);
        } catch (error) {
            logger.error("[API status-data Error]", { error });
            res.status(500).json({ error: true, message: "Internal server error." });
        }
    });

    app.get("/api/guilds/:guildId/livestatus", checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const [liveRows] = await db.execute(`SELECT s.username, s.discord_user_id, s.profile_image_url, s.platform_user_id, a.platform, a.stream_game
                                                 FROM announcements a
                                                          JOIN streamers s ON a.streamer_id = s.streamer_id
                                                 WHERE a.guild_id = ?
                                                   AND s.username IS NOT NULL
                                                   AND s.username != ''`, [req.params.guildId]);
            res.json(await getFormattedLiveRows(liveRows));
        } catch (error) {
            logger.error(`[API livestatus Error for guild ${req.params.guildId}]`, { error });
            res.status(500).json({ error: true, message: "Internal server error." });
        }
    });

    app.get("/api/authenticated-logs", checkAuth, checkBotOwner, (req, res) => {
        pm2.describe("LiveBot", (err, list) => {
            if (err || !list || list.length === 0) {
                return res.status(500).json({ error: true, message: "Could not find the LiveBot process in PM2." });
            }
            const logPath = list[0].pm2_env.pm_out_log_path;
            exec(`tail -n 100 "${logPath}"`, { maxBuffer: 1024 * 500 }, (err, stdout, stderr) => {
                if (err) {
                    logger.error(`Failed to read log file at ${logPath}`, err);
                    return res.status(500).json({ logs: `Log file not found or unreadable at: ${logPath}`, error: "Failed to read logs." });
                }
                res.json({ logs: stdout, error: stderr || null });
            });
        });
    });

    app.post("/api/admin/reset-database", checkAuth, checkBotOwner, async (req, res) => {
        logger.warn(`[ADMIN] Database reset initiated by ${req.user.username}`);
        try {
            const dumpSql = fs.readFileSync(path.join(__dirname, '../dump.sql'), 'utf8');
            await db.query(dumpSql);
            logger.info("[ADMIN] Database has been successfully reset.");
            res.json({ success: true, message: "Database has been reset successfully." });
        } catch (error) {
            logger.error("[ADMIN] Database reset failed:", error);
            res.status(500).json({ success: false, message: `Database reset failed: ${error.message}` });
        }
    });

    app.post("/api/reinit", checkAuth, checkBotOwner, (req, res) => {
        try {
            logger.info("[Dashboard] Received request for global bot re-initialization.");
            pm2.restart("LiveBot", (err) => {
                if (err) {
                    logger.error("[PM2] Restart failed:", err);
                    // Note: This response might not be sent if the server is already down.
                    return res.status(500).json({ success: false, message: "Failed to send restart command to PM2." });
                }
                return res.json({ success: true, message: "Bot is re-initializing." });
            });
        } catch (e) {
            logger.error("[API Reinit] Synchronous error:", e);
            res.status(500).json({ success: false, message: `An internal server error occurred: ${e.message}` });
        }
    });

    app.post("/api/manage/:guildId/reinit-guild", checkAuth, checkGuildAdmin, async (req, res) => {
        logger.info(`[Dashboard] Received request to re-initialize guild ${req.params.guildId}.`);
        await botStartupCleanup(clientInstance, req.params.guildId);
        res.json({ success: true, message: "Guild re-initialization triggered." });
    });

    app.use((req, res) => {
        res.status(404).render('error', { user: req.user, error: 'Page Not Found' });
    });

    return app;
}

module.exports = { start };