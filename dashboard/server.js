const express = require("express");
const session = require("express-session");
const passport = require("passport");
require("./passport-setup");
const path = require("path");
const fs = require("fs");
const db = require("../utils/db");
const multer = require("multer");
const Papa = require("papaparse");
const {exec} = require("child_process");
const pm2 = require("pm2");
const apiChecks = require("../utils/api_checks.js"); // Moved to top
const { startupCleanup } = require("../index.js"); // Import startupCleanup

const app = express();

// Initialize multer for file uploads in the global scope
const upload = multer({ dest: 'uploads/' });

const getDefaultAvatar = (discriminator) => {
    return `https://cdn.discordapp.com/embed/avatars/${discriminator % 5}.png`;
};

// The client and PermissionsBitField are now required parameters
function start(client, PermissionsBitField, startupCleanup) {
    if (!process.env.SESSION_SECRET) {
        console.error("[Dashboard] FATAL: SESSION_SECRET is not defined in the environment variables.");
        process.exit(1);
    }
    app.use(session({secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: {maxAge: 1000 * 60 * 60 * 24}}));
    app.use(passport.initialize());
    app.use(passport.session());
    app.use(express.json());
    app.use(express.urlencoded({extended: true}));
    app.use(express.static(path.join(__dirname, "public")));
    app.set("view engine", "ejs");
    app.set("views", path.join(__dirname, "views"));

    const checkAuth = (req, res, next) => {
        if (req.isAuthenticated()) {
            return next();
        }
        if (req.path.startsWith("/api/")) {
            return res.status(401).json({error: true, message: "Unauthorized"});
        }
        res.redirect("/login");
    };

    const checkGuildAdmin = (req, res, next) => {
        try {
            const isApiRequest = req.path.startsWith("/api/");
            if (!req.user || !req.user.guilds) {
                if (isApiRequest) {
                    return res.status(403).json({error: true, message: "Authentication error"});
                }
                return res.status(403).render("error", {user: req.user, error: "Authentication error."});
            }
            const guild = req.user.guilds.find(g => g.id === req.params.guildId);
            if (guild && new PermissionsBitField(BigInt(guild.permissions)).has(PermissionsBitField.Flags.ManageGuild) && client.guilds.cache.has(req.params.guildId)) {
                req.guildObject = client.guilds.cache.get(req.params.guildId);
                return next();
            }
            if (isApiRequest) {
                return res.status(403).json({error: true, message: "Permission denied."});
            }
            res.status(403).render("error", {user: req.user, error: "Permission denied."});
        } catch (e) {
            console.error("[checkGuildAdmin Middleware Error]", e);
            res.status(500).render("error", {user: req.user, error: "An internal error occurred."});
        }
    };

    // --- MAIN ROUTES ---
    app.get("/", (req, res) => res.render("landing", {user: req.user, client_id: process.env.DISCORD_CLIENT_ID}));
    app.get("/help", (req, res) => res.render("commands", {user: req.user}));
    app.get("/login", passport.authenticate("discord"));
    app.get("/auth/discord/callback", passport.authenticate("discord", {failureRedirect: "/"}), (req, res) => res.redirect("/dashboard"));
    app.get("/logout", (req, res) => {
        req.logout(() => {
            res.redirect("/");
        });
    });
    app.get("/status", (req, res) => res.render("status", {user: req.user, isAuthenticated: req.isAuthenticated()}));

    app.get("/dashboard", checkAuth, (req, res) => {
        const manageableGuilds = req.user.guilds.filter(g => new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild) && client.guilds.cache.has(g.id));
        res.render("dashboard", {manageableGuilds, user: req.user});
    });

    // --- FULL MANAGEMENT ROUTES (RESTORED ORIGINAL LOGIC) ---
    app.get("/manage/:guildId", checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const botGuild = req.guildObject;
            const guildId = botGuild.id;
            let [allSubscriptions] = await db.execute(`SELECT sub.*, s.platform, s.username, s.discord_user_id, s.kick_username, s.streamer_id, s.profile_image_url
                                                       FROM subscriptions sub
                                                                JOIN streamers s ON sub.streamer_id = s.streamer_id
                                                       WHERE sub.guild_id = ?
                                                       ORDER BY s.username`, [guildId]);
            const [[guildSettingsResult], [channelSettingsResult], allRoles, allChannels, [rawTeamSubscriptions], [allStreamers]] = await Promise.all([
                db.execute("SELECT * FROM guilds WHERE guild_id = ?", [guildId]),
                db.execute("SELECT * FROM channel_settings WHERE guild_id = ?", [guildId]),
                botGuild.roles.fetch(),
                botGuild.channels.fetch(),
                db.execute("SELECT * FROM twitch_teams WHERE guild_id = ?", [guildId]),
                db.execute("SELECT streamer_id, platform, username, kick_username, discord_user_id, profile_image_url FROM streamers")
            ]);

            // --- NEW: Cleanup duplicate subscriptions ---
            const subscriptionsToKeep = new Map(); // Key: `${channelId}-${userIdentifier}`, Value: best subscription object
            const subscriptionIdsToDelete = new Set();

            for (const sub of allSubscriptions) {
                const channelKey = sub.announcement_channel_id || "default";
                const userIdentifier = sub.discord_user_id || `${sub.platform}-${sub.streamer_id}`;
                const uniqueKey = `${channelKey}-${userIdentifier}`;

                if (!subscriptionsToKeep.has(uniqueKey)) {
                    subscriptionsToKeep.set(uniqueKey, sub);
                } else {
                    const existingSub = subscriptionsToKeep.get(uniqueKey);
                    // Prioritize keeping the one with a discord_user_id
                    if (sub.discord_user_id && !existingSub.discord_user_id) {
                        subscriptionIdsToDelete.add(existingSub.subscription_id);
                        subscriptionsToKeep.set(uniqueKey, sub);
                    } else if (!sub.discord_user_id && existingSub.discord_user_id) {
                        subscriptionIdsToDelete.add(sub.subscription_id);
                    } else {
                        // Both have discord_user_id or neither do, keep the one with the lower subscription_id (arbitrary but consistent)
                        if (sub.subscription_id < existingSub.subscription_id) {
                            subscriptionIdsToDelete.add(existingSub.subscription_id);
                            subscriptionsToKeep.set(uniqueKey, sub);
                        } else {
                            subscriptionIdsToDelete.add(sub.subscription_id);
                        }
                    }
                }
            }

            if (subscriptionIdsToDelete.size > 0) {
                console.warn(`[Dashboard] Cleaning up ${subscriptionIdsToDelete.size} duplicate subscriptions for guild ${guildId}. IDs: ${Array.from(subscriptionIdsToDelete).join(', ')}`);
                const idsToDelete = Array.from(subscriptionIdsToDelete);
                const placeholders = idsToDelete.map(() => '?').join(',');
                await db.execute(`DELETE FROM subscriptions WHERE subscription_id IN (${placeholders})`, idsToDelete);
                // Filter allSubscriptions to reflect the deletions for subsequent processing
                allSubscriptions = allSubscriptions.filter(sub => !subscriptionIdsToDelete.has(sub.subscription_id));
            }
            // --- END NEW: Cleanup duplicate subscriptions ---

            const channelsData = {};
            const allChannelsMap = new Map(allChannels.map(ch => [ch.id, ch.name]));
            const streamerIdToDataMap = new Map(allStreamers.map(s => [s.streamer_id, s]));

            // Build a map for linked accounts based on discord_user_id
            const discordLinkedAccountsMap = new Map();
            allStreamers.forEach(s => {
                if (s.discord_user_id) {
                    if (!discordLinkedAccountsMap.has(s.discord_user_id)) {
                        discordLinkedAccountsMap.set(s.discord_user_id, []);
                    }
                    discordLinkedAccountsMap.get(s.discord_user_id).push(s);
                }
            });

            // Initialize channelsData for all text-based channels and a 'default' entry
            allChannels.filter(c => c.isTextBased()).forEach(ch => {
                channelsData[ch.id] = {name: ch.name, individualStreamers: [], teams: []};
            });
            channelsData["default"] = {name: "Server Default", individualStreamers: [], teams: []};

            const teamSubscriptions = [];
            const processedSubscriptionIds = new Set(); // To avoid duplicating subscriptions in individual and team lists

            // --- Process team subscriptions first ---
            for (const teamSub of rawTeamSubscriptions) {
                const [rawMembers] = await db.execute(`SELECT sub.*, s.platform, s.username, s.discord_user_id, s.kick_username, s.streamer_id, s.profile_image_url
                                                       FROM subscriptions sub
                                                                JOIN streamers s ON sub.streamer_id = s.streamer_id
                                                       WHERE sub.guild_id = ?
                                                         AND sub.announcement_channel_id = ?
                                                         AND s.platform = 'twitch'`, [guildId, teamSub.announcement_channel_id]);

                const groupedTeamMembersMap = new Map(); // Key: userIdentifier, Value: userGroup object

                rawMembers.forEach(rawMember => {
                    const userIdentifier = rawMember.discord_user_id || `${rawMember.platform}-${rawMember.streamer_id}`;
                    let userGroup = groupedTeamMembersMap.get(userIdentifier);

                    if (!userGroup) {
                        userGroup = {
                            primaryDisplayName: null, // Will be set, prioritizing Twitch
                            primaryAvatarUrl: null,
                            discord_user_id: rawMember.discord_user_id,
                            linkedPlatforms: [], // Will store {platform, username} for all linked accounts for this user
                            subscriptions: [] // All subscriptions for this user in this *specific channel*
                        };
                        groupedTeamMembersMap.set(userIdentifier, userGroup);

                        // Populate linkedPlatforms for the entire user group
                        let allStreamerAccountsForThisUser = [];
                        if (rawMember.discord_user_id) {
                            allStreamerAccountsForThisUser = discordLinkedAccountsMap.get(rawMember.discord_user_id) || [];
                        } else {
                            allStreamerAccountsForThisUser.push(rawMember); // If no Discord ID, this rawMember is the only account
                        }

                        let twitchAccount = null;
                        allStreamerAccountsForThisUser.forEach(acc => {
                            if (!userGroup.linkedPlatforms.some(p => p.platform === acc.platform)) {
                                userGroup.linkedPlatforms.push({ platform: acc.platform, username: acc.username });
                            }
                            if (acc.platform === 'twitch') {
                                twitchAccount = acc;
                            }
                        });

                        if (twitchAccount) {
                            userGroup.primaryDisplayName = twitchAccount.username;
                            userGroup.primaryAvatarUrl = twitchAccount.profile_image_url;
                        } else if (userGroup.linkedPlatforms.length > 0) {
                            const firstPlatform = userGroup.linkedPlatforms[0];
                            const correspondingStreamer = allStreamerAccountsForThisUser.find(s => s.platform === firstPlatform.platform && s.username === firstPlatform.username);
                            userGroup.primaryDisplayName = firstPlatform.username;
                            userGroup.primaryAvatarUrl = correspondingStreamer ? correspondingStreamer.profile_image_url : null;
                        }
                    }
                    userGroup.subscriptions.push(rawMember); // Add the current rawMember (Twitch sub) to the userGroup's subscriptions
                    processedSubscriptionIds.add(rawMember.subscription_id); // Mark this specific Twitch sub as processed
                });

                teamSub.members = Array.from(groupedTeamMembersMap.values()); // Replace rawMembers with grouped userGroups
                teamSub.members.sort((a, b) => a.primaryDisplayName.localeCompare(b.primaryDisplayName)); // Sort for consistent display

                teamSubscriptions.push(teamSub);
                const targetChannelId = teamSub.announcement_channel_id || "default";
                if (!channelsData[targetChannelId]) {
                    channelsData[targetChannelId] = {name: allChannelsMap.get(targetChannelId) || "Unknown", individualStreamers: [], teams: []};
                }
                channelsData[targetChannelId].teams.push(teamSub);
            }

            // --- Process individual subscriptions, grouping by user ---
            // First, create a temporary map to group subscriptions by user identifier
            const groupedIndividualStreamersMap = new Map(); // Key: userIdentifier, Value: userGroup object

            for (const sub of allSubscriptions) {
                if (processedSubscriptionIds.has(sub.subscription_id)) continue; // Skip if already handled by a team

                const subChannelId = sub.announcement_channel_id || "default";
                if (!channelsData[subChannelId]) {
                    channelsData[subChannelId] = {name: allChannelsMap.get(subChannelId) || "Unknown", individualStreamers: [], teams: []};
                }

                // Determine a unique identifier for the person. Prioritize Discord ID.
                const userIdentifier = sub.discord_user_id || `${sub.platform}-${sub.streamer_id}`; // Unique identifier for the person
                let userGroup = groupedIndividualStreamersMap.get(userIdentifier);

                if (!userGroup) {
                    userGroup = {
                        primaryDisplayName: null, // Will be set, prioritizing Twitch
                        primaryAvatarUrl: null,
                        discord_user_id: sub.discord_user_id,
                        linkedPlatforms: [], // Will store {platform, username} for all linked accounts for this user
                        subscriptions: [] // All subscriptions for this user in this *specific channel*
                    };
                    groupedIndividualStreamersMap.set(userIdentifier, userGroup);

                    // Populate linkedPlatforms for the entire user group (all platforms linked to this Discord ID or streamer_id)
                    let allStreamerAccountsForThisUser = [];
                    if (sub.discord_user_id) {
                        allStreamerAccountsForThisUser = discordLinkedAccountsMap.get(sub.discord_user_id) || [];
                    } else {
                        // If no Discord ID, and it's a single streamer, just add itself
                        allStreamerAccountsForThisUser.push(sub); // Add the current subscription's streamer info
                    }

                    // Ensure unique platforms in linkedPlatforms and set primary display name/avatar
                    let twitchAccount = null;
                    allStreamerAccountsForThisUser.forEach(acc => {
                        if (!userGroup.linkedPlatforms.some(p => p.platform === acc.platform)) {
                            userGroup.linkedPlatforms.push({ platform: acc.platform, username: acc.username });
                        }
                        if (acc.platform === 'twitch') {
                            twitchAccount = acc;
                        }
                    });

                    // Set primary display name and avatar
                    if (twitchAccount) {
                        userGroup.primaryDisplayName = twitchAccount.username;
                        userGroup.primaryAvatarUrl = twitchAccount.profile_image_url;
                    } else if (userGroup.linkedPlatforms.length > 0) {
                        // If no Twitch, use the first linked platform's username as primary
                        const firstPlatform = userGroup.linkedPlatforms[0];
                        const correspondingStreamer = allStreamerAccountsForThisUser.find(s => s.platform === firstPlatform.platform && s.username === firstPlatform.username);
                        userGroup.primaryDisplayName = firstPlatform.username;
                        userGroup.primaryAvatarUrl = correspondingStreamer ? correspondingStreamer.profile_image_url : null;
                    }
                }

                // Add the current subscription to the user group's subscriptions for this channel
                userGroup.subscriptions.push(sub);
                processedSubscriptionIds.add(sub.subscription_id);
            }

            // Now, assign the grouped streamers to the correct channelsData entries
            groupedIndividualStreamersMap.forEach(userGroup => {
                // Assuming all subscriptions within a userGroup for a specific channel will have the same channelId
                const firstSubChannelId = userGroup.subscriptions[0].announcement_channel_id || "default";
                if (channelsData[firstSubChannelId]) {
                    channelsData[firstSubChannelId].individualStreamers.push(userGroup);
                }
            });

            // Sort individualStreamers within each channel for consistent display
            Object.values(channelsData).forEach(channel => {
                if (channel.individualStreamers) {
                    channel.individualStreamers.sort((a, b) => a.primaryDisplayName.localeCompare(b.primaryDisplayName));
                }
            });

            const filteredChannelsData = Object.fromEntries(Object.entries(channelsData).filter(([, data]) => data.individualStreamers.length > 0 || data.teams.length > 0));
            res.render("manage", {
                guild: botGuild, channelsData: filteredChannelsData,
                totalSubscriptions: allSubscriptions.length, user: req.user,
                settings: guildSettingsResult[0] || {}, channelSettings: channelSettingsResult,
                roles: allRoles.filter(r => !r.managed && r.name !== "@everyone"),
                channels: allChannels.filter(c => c.isTextBased()),
                teamSubscriptions
            });
        } catch (error) {
            console.error("[Dashboard GET Error]", error);
            res.status(500).render("error", {user: req.user, error: "An internal error occurred."});
        }
    });

    app.post("/manage/:guildId/settings", checkAuth, checkGuildAdmin, async (req, res) => {
        const {channelId, roleId} = req.body;
        await db.execute("INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = ?, live_role_id = ?", [req.params.guildId, channelId || null, roleId || null, channelId || null, roleId || null]);
        res.redirect(`/manage/${req.params.guildId}?success=settings`);
    });

    app.post("/manage/:guildId/add", checkAuth, checkGuildAdmin, async (req, res) => {
        const {platform, username, discord_user_id, announcement_channel_id} = req.body;
        let streamerInfo = {puid: null, dbUsername: null, pfp: null};
        try {
            if (platform === "twitch") {
                const u = await apiChecks.getTwitchUser(username);
                if (u) {
                    streamerInfo = {puid: u.id, dbUsername: u.login, pfp: u.profile_image_url};
                }
            } else if (platform === "youtube") {
                const c = await apiChecks.getYouTubeChannelId(username);
                if (c?.channelId) {
                    streamerInfo = {puid: c.channelId, dbUsername: c.channelName || username};
                }
            } else if (["tiktok", "trovo"].includes(platform)) {
                streamerInfo = {puid: username, dbUsername: username};
            }

            if (!streamerInfo.puid) {
                return res.status(400).render("error", {user: req.user, error: `Could not find streamer \"${username}\" on ${platform}.`});
            }

            await db.execute("INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, profile_image_url) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), discord_user_id=COALESCE(VALUES(discord_user_id), streamers.discord_user_id), profile_image_url=VALUES(profile_image_url)", [platform, streamerInfo.puid, streamerInfo.dbUsername, discord_user_id || null, streamerInfo.pfp]);
            const [[streamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?", [platform, streamerInfo.puid]);

            if (!streamer || !streamer.streamer_id) {
                return res.status(500).render("error", {user: req.user, error: "Failed to retrieve streamer ID."});
            }

            const ids = announcement_channel_id ? (Array.isArray(announcement_channel_id) ? announcement_channel_id : [announcement_channel_id]) : [""];
            for (const channelId of ids) {
                await db.execute("INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)", [req.params.guildId, streamer.streamer_id, channelId || null]);
            }
            res.redirect(`/manage/${req.params.guildId}?success=add`);
        } catch (error) {
            console.error("[Dashboard Add Streamer Error]:", error);
            res.status(500).render("error", {user: req.user, error: "An error occurred."});
        }
    });

    app.post("/manage/:guildId/subscribe-team", checkAuth, checkGuildAdmin, async (req, res) => {
        await db.execute("INSERT INTO twitch_teams (guild_id, team_name, announcement_channel_id) VALUES (?, ?, ?)", [req.params.guildId, req.body.teamName, req.body.channelId]);
        res.redirect(`/manage/${req.params.guildId}?success=team_added#teams-tab`);
    });

    app.post("/manage/:guildId/update-team", checkAuth, checkGuildAdmin, async (req, res) => {
        const {teamSubscriptionId, liveRoleId, webhookName, webhookAvatarUrl} = req.body;
        await db.execute("UPDATE twitch_teams SET live_role_id = ?, webhook_name = ?, webhook_avatar_url = ? WHERE id = ? AND guild_id = ?", [liveRoleId || null, webhookName || null, webhookAvatarUrl || null, teamSubscriptionId, req.params.guildId]);
        res.redirect(`/manage/${req.params.guildId}?success=team_updated#teams-tab`);
    });

    app.post("/manage/:guildId/removeteam", checkAuth, checkGuildAdmin, async (req, res) => {
        const {teamSubscriptionId} = req.body;
        const {guildId} = req.params;
        const [[teamSub]] = await db.execute("SELECT team_name, announcement_channel_id FROM twitch_teams WHERE id = ? AND guild_id = ?", [teamSubscriptionId, guildId]);
        if (teamSub) {
            const teamMembers = await apiChecks.getTwitchTeamMembers(teamSub.team_name);
            if (teamMembers?.length > 0) {
                const memberLogins = teamMembers.map(m => m.user_login);
                const [streamerIds] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = 'twitch' AND username IN (?)", [memberLogins]);
                if (streamerIds.length > 0) {
                    const idsToRemove = streamerIds.map(s => s.streamer_id);
                    await db.execute("DELETE FROM subscriptions WHERE guild_id = ? AND announcement_channel_id = ? AND streamer_id IN (?)", [guildId, teamSub.announcement_channel_id, idsToRemove]);
                }
            }
            await db.execute("DELETE FROM twitch_teams WHERE id = ? AND guild_id = ?", [teamSubscriptionId, guildId]);
        }
        res.redirect(`/manage/${req.params.guildId}?success=team_removed#teams-tab`);
    });

    app.post("/manage/:guildId/channel-appearance/save", checkAuth, checkGuildAdmin, upload.single("avatar"), async (req, res) => {
        const {channelId, nickname, avatar_url_text} = req.body;
        const finalNickname = (nickname?.toLowerCase() === "reset") ? null : nickname;
        const finalAvatarUrl = (avatar_url_text?.toLowerCase() === "reset" || avatar_url_text === "") ? null : avatar_url_text;
        await db.execute("INSERT INTO channel_settings (guild_id, channel_id, override_nickname, override_avatar_url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE override_nickname=VALUES(override_nickname), override_avatar_url=VALUES(override_avatar_url)", [req.params.guildId, channelId, finalNickname, finalAvatarUrl]);
        res.redirect(`/manage/${req.params.guildId}?success=appearance#appearance-tab`);
    });

    app.post("/manage/:guildId/remove-subscription", checkAuth, checkGuildAdmin, async (req, res) => {
        await db.execute("DELETE FROM subscriptions WHERE subscription_id = ? AND guild_id = ?", [req.body.subscription_id, req.params.guildId]);
        res.redirect(`/manage/${req.params.guildId}?success=remove`);
    });

    app.post("/manage/:guildId/edit-subscription", checkAuth, checkGuildAdmin, async (req, res) => {
        const {subscription_id, discord_user_id, kick_username, announcement_channel_id, override_nickname, custom_message, override_avatar_url_text, reset_avatar} = req.body;
        const [[sub]] = await db.execute("SELECT streamer_id, override_avatar_url FROM subscriptions WHERE subscription_id = ?", [subscription_id]);
        if (!sub) {
            return res.status(404).render("error", {user: req.user, error: "Subscription not found."});
        }

        // Fetch existing streamer data to conditionally update discord_user_id and kick_username
        const [[existingStreamer]] = await db.execute("SELECT discord_user_id, kick_username FROM streamers WHERE streamer_id = ?", [sub.streamer_id]);

        let newDiscordUserId = existingStreamer.discord_user_id;
        // Only update discord_user_id if the field was explicitly sent in the form
        if (req.body.hasOwnProperty('discord_user_id')) {
            newDiscordUserId = discord_user_id || null; // If sent and empty, set to null
        }

        let newKickUsername = existingStreamer.kick_username;
        // Only update kick_username if the field was explicitly sent in the form
        if (req.body.hasOwnProperty('kick_username')) {
            newKickUsername = kick_username || null; // If sent and empty, set to null
        }

        await db.execute("UPDATE streamers SET discord_user_id = ?, kick_username = ? WHERE streamer_id = ?", [newDiscordUserId, newKickUsername, sub.streamer_id]);

        let finalAvatarUrl = (reset_avatar === "true" || override_avatar_url_text?.toLowerCase() === "reset") ? null : (override_avatar_url_text || sub.override_avatar_url);

        await db.execute("UPDATE subscriptions SET announcement_channel_id = ?, override_nickname = ?, custom_message = ?, override_avatar_url = ? WHERE subscription_id = ?", [announcement_channel_id || null, override_nickname || null, custom_message || null, finalAvatarUrl, subscription_id]);
        res.redirect(`/manage/${req.params.guildId}?success=edit`);
    });

    app.get("/manage/:guildId/export", checkAuth, checkGuildAdmin, async (req, res) => {
        const [rows] = await db.execute(`SELECT s.platform, s.username, s.discord_user_id, s.kick_username, sub.announcement_channel_id, sub.custom_message
                                         FROM subscriptions sub
                                                  JOIN streamers s ON sub.streamer_id = s.streamer_id
                                         WHERE sub.guild_id = ?`, [req.params.guildId]);
        if (rows.length === 0) {
            return res.status(404).send("No subscriptions to export.");
        }
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename=\"subscriptions-${req.params.guildId}.csv\"`);
        res.send(Papa.unparse(rows));
    });

    app.post("/manage/:guildId/import-team", checkAuth, checkGuildAdmin, upload.single("csvfile"), async (req, res) => {
        if (!req.file) {
            return res.status(400).render("error", {user: req.user, error: "No CSV file uploaded."});
        }
        const csvData = fs.readFileSync(req.file.path, "utf8");
        fs.unlinkSync(req.file.path);
        const {data: rows} = Papa.parse(csvData, {header: true, skipEmptyLines: true});

        for (const row of rows) {
            if (!row.platform || !row.username) {
                continue;
            }
            // Determine platform_user_id based on platform, using username as fallback for now
            let platformUserId = row.username; // Default to username
            // For Twitch/YouTube, a proper platform_user_id (numerical ID) would ideally be fetched via API or provided in CSV
            // For now, using username to avoid unique key constraint violation

            let [[streamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?", [row.platform, platformUserId]);
            if (!streamer) {
                const [result] = await db.execute("INSERT INTO streamers (platform, username, platform_user_id) VALUES (?, ?, ?)", [row.platform, row.username, platformUserId]);
                streamer = {streamer_id: result.insertId};
            }
            await db.execute("INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)", [req.params.guildId, streamer.streamer_id, req.body.channelId]);
        }
        res.redirect(`/manage/${req.params.guildId}?success=import#csv-tab`);
    });

    // --- API ROUTES ---
    async function getFormattedLiveRows(rows) {
        const platformPriority = ["kick", "twitch", "youtube", "tiktok", "trovo"];
        const streamersMap = new Map(); // Key: userIdentifier, Value: array of live rows for this user

        for (const row of rows) {
            const userIdentifier = row.discord_user_id || `${row.platform}-${row.streamer_id}`;
            if (!streamersMap.has(userIdentifier)) {
                streamersMap.set(userIdentifier, []);
            }
            streamersMap.get(userIdentifier).push(row);
        }

        const formattedResult = [];
        for (const [userIdentifier, userLiveRows] of streamersMap.entries()) {
            userLiveRows.sort((a, b) => platformPriority.indexOf(a.platform) - platformPriority.indexOf(b.platform));

            let primaryDisplayName = userLiveRows[0].username; // Default to the first platform's username
            let primaryAvatarUrl = userLiveRows[0].profile_image_url;
            // let discordId = userLiveRows[0].discord_user_id; // Not directly used in the final object, but used for grouping

            // Prioritize Twitch for primary display name and avatar if available
            const twitchLiveRow = userLiveRows.find(r => r.platform === 'twitch');
            if (twitchLiveRow) {
                primaryDisplayName = twitchLiveRow.username;
                primaryAvatarUrl = twitchLiveRow.profile_image_url;
            }

            // Consolidate live platforms and games into a single text string
            let platformsInfo = [];
            const uniqueGames = new Set(userLiveRows.map(p => p.stream_game));

            if (uniqueGames.size === 1) {
                // All platforms playing the same game
                const commonGame = uniqueGames.values().next().value || "N/A";
                const platformNames = userLiveRows.map(p => {
                    let url = "#";
                    switch (p.platform) {
                        case "twitch": url = `https://www.twitch.tv/${p.username}`; break;
                        case "kick": url = `https://kick.com/${p.username}`; break;
                        case "youtube": url = `https://www.youtube.com/channel/${p.platform_user_id}`; break;
                        case "tiktok": url = `https://www.tiktok.com/@${p.username}`; break;
                        case "trovo": url = `https://trovo.live/s/${p.username}`; break;
                    }
                    return `<a href="${url}" target="_blank" class="text-decoration-none text-white" title="${p.platform}">${p.platform}</a>`;
                }).join(', ');
                platformsInfo.push(`${platformNames}: ${commonGame}`);
            } else {
                // Platforms playing different games
                userLiveRows.forEach(p => {
                    let url = "#";
                    switch (p.platform) {
                        case "twitch": url = `https://www.twitch.tv/${p.username}`; break;
                        case "kick": url = `https://kick.com/${p.username}`; break;
                        case "youtube": url = `https://www.youtube.com/channel/${p.platform_user_id}`; break;
                        case "tiktok": url = `https://www.tiktok.com/@${p.username}`; break;
                        case "trovo": url = `https://trovo.live/s/${p.username}`; break;
                    }
                    platformsInfo.push(
                        `<a href="${url}" target="_blank" class="text-decoration-none text-white" title="${p.platform}">${p.platform}: ${p.stream_game || "N/A"}</a>`
                    );
                });
            }
            const platformsText = platformsInfo.join(' | ');

            formattedResult.push({
                username: primaryDisplayName,
                avatar_url: primaryAvatarUrl || getDefaultAvatar(0),
                live_platforms_text: platformsText // Consolidated text for display
            });
        }
        return formattedResult;
    }

    app.get("/api/status-data", async (req, res) => {
        try {
            const [
                [[{totalStreamers}]],
                [[{totalGuilds}]],
                [[{totalAnnouncements}]],
                [platformDistribution],
                [liveRows]
            ] = await Promise.all([
                db.execute("SELECT COUNT(*) as totalStreamers FROM streamers"),
                db.execute("SELECT COUNT(DISTINCT guild_id) as totalGuilds FROM subscriptions"),
                db.execute("SELECT COUNT(*) as totalAnnouncements FROM announcements"),
                db.execute("SELECT platform, COUNT(*) as count FROM streamers WHERE platform IS NOT NULL AND platform != \"\" GROUP BY platform ORDER BY count DESC"),
                db.execute(`SELECT s.username, s.discord_user_id, s.profile_image_url, s.platform_user_id, a.platform, a.stream_game
                            FROM announcements a
                                     JOIN streamers s ON a.streamer_id = s.streamer_id
                            WHERE s.username IS NOT NULL
                              AND s.username != ''
                              AND a.platform IS NOT NULL
                              AND a.platform != ''`)
            ]);

            const formattedLiveStreamers = await getFormattedLiveRows(liveRows);

            const publicData = {
                liveCount: formattedLiveStreamers.length,
                liveStreamers: formattedLiveStreamers,
                totalStreamers: totalStreamers || 0,
                totalGuilds: totalGuilds || 0,
                totalAnnouncements: totalAnnouncements || 0,
                platformDistribution
            };

            if (req.isAuthenticated()) {
                const pm2DataPromise = new Promise((resolve) => {
                    pm2.describe("LiveBot", (err, procList) => {
                        if (err || !procList || procList.length === 0) {
                            return resolve({app: {status: "offline", uptime: "N/A", memory: "N/A"}});
                        }
                        const proc = procList[0];
                        const uptime = proc.pm2_env.pm_uptime ? new Date(Date.now() - proc.pm2_env.pm_uptime).toISOString().slice(11, 19) : "N/A";
                        resolve({app: {status: proc.pm2_env.status, uptime, memory: `${(proc.monit.memory / 1024 / 1024).toFixed(1)} MB`}});
                    });
                });
                const dbConnectionPromise = db.getConnection().then(c => {
                    c.release();
                    return {status: "ok"};
                }).catch(() => ({status: "error"}));
                const twitchApiPromise = apiChecks.getTwitchUser("twitch").then(u => ({status: u ? "ok" : "error"})).catch(() => ({status: "error"}));

                const [pm2Result, dbStatus, twitchStatus] = await Promise.all([pm2DataPromise, dbConnectionPromise, twitchApiPromise]);
                return res.json({...publicData, ...pm2Result, db: {status: dbStatus.status}, api: {twitch: twitchStatus.status}});
            }
            res.json(publicData);
        } catch (error) {
            console.error("[API status-data Error]", error);
            res.status(500).json({error: true, message: "Internal server error."});
        }
    });

    app.get("/api/authenticated-logs", checkAuth, async (req, res) => {
        pm2.connect(function(err) {
            if (err) {
                console.error("[PM2 Connect Error]", err);
                return res.status(500).json({ logs: "Could not connect to PM2 to fetch logs.", error: err.message });
            }
            pm2.describe("LiveBot", (err, procList) => {
                pm2.disconnect();
                if (err || !procList || procList.length === 0) {
                    console.error("[PM2 Describe Error]", err);
                    return res.status(500).json({ logs: "Could not find LiveBot process in PM2.", error: err ? err.message : "Process not found" });
                }
                const proc = procList[0];
                const logPath = proc.pm2_env.pm_out_log_path;
                if (!logPath) {
                    return res.status(500).json({ logs: "PM2 log path not found for LiveBot.", error: "Log path missing" });
                }

                const logCommand = `tail -n 100 \"${logPath}\"`;
                exec(logCommand, {maxBuffer: 1024 * 500}, (err, stdout, stderr) => {
                    if (err) {
                        return res.status(500).json({logs: `Failed to read logs from ${logPath}`, error: err.message});
                    }
                    res.json({logs: stdout, error: stderr || null});
                });
            });
        });
    });

    app.post("/api/reinit", checkAuth, (req, res) => {
        const MY_DISCORD_ID = "365905620060340224"; // Your Discord ID
        if (req.user.id !== MY_DISCORD_ID) {
            return res.status(403).json({ success: false, message: "Unauthorized: Only the bot owner can perform a full re-initialization." });
        }

        console.log("[Dashboard] Received request to re-initialize bot.");
        pm2.connect(function(err) {
            if (err) {
                console.error("[PM2 Connect Error]", err);
                return res.status(500).json({ success: false, message: "Could not connect to PM2." });
            }
            pm2.restart("LiveBot", (err, proc) => {
                pm2.disconnect();
                if (err) {
                    console.error("[PM2 Restart Error]", err);
                    return res.status(500).json({ success: false, message: "Failed to restart the bot process." });
                }
                console.log("[Dashboard] Bot process re-initialized successfully via PM2.");
                res.json({ success: true, message: "Bot is re-initializing." });
            });
        });
    });

    // New endpoint for server-only re-initialization
    app.post("/api/manage/:guildId/reinit-guild", checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        console.log(`[Dashboard] Received request to re-initialize guild ${guildId}.`);
        try {
            // The client instance is available in this scope from the start function
            await startupCleanup(client, guildId);
            res.json({ success: true, message: `Guild ${guildId} re-initialization triggered.` });
        } catch (error) {
            console.error(`[Dashboard Guild Reinit Error for ${guildId}]`, error);
            res.status(500).json({ success: false, message: "Failed to re-initialize guild." });
        }
    });

    app.get("/api/global-live-status", async (req, res) => {
        const [liveRows] = await db.execute(`SELECT s.username, s.discord_user_id, s.profile_image_url, s.platform_user_id, a.platform, a.stream_game
                                             FROM announcements a
                                                      JOIN streamers s ON a.streamer_id = s.streamer_id
                                             WHERE s.username IS NOT NULL
                                               AND s.username != ''`);
        const formatted = await getFormattedLiveRows(liveRows);
        const [[{totalStreamers}]] = await db.execute("SELECT COUNT(*) as totalStreamers FROM streamers");
        const [[{totalGuilds}]] = await db.execute("SELECT COUNT(DISTINCT guild_id) as totalGuilds FROM subscriptions");
        res.json({liveStreamers: formatted, liveCount: formatted.length, totalStreamers, totalGuilds});
    });

    app.get("/api/guilds/:guildId/livestatus", checkAuth, checkGuildAdmin, async (req, res) => {
        const [liveRows] = await db.execute(`SELECT s.username, s.discord_user_id, s.profile_image_url, s.platform_user_id, a.platform, a.stream_game
                                             FROM announcements a
                                                      JOIN streamers s ON a.streamer_id = s.streamer_id
                                             WHERE a.guild_id = ?
                                               AND s.username IS NOT NULL
                                               AND s.username != ''`, [req.params.guildId]);
        res.json(await getFormattedLiveRows(liveRows));
    });

    app.use((req, res) => {
        res.status(404).render('error', {user: req.user, error: 'Page Not Found'});
    });

    return app; // Return the app instead of listening
}

module.exports = {start};