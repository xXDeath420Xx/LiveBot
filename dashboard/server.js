const express = require('express');
const session = require('express-session');
const passport = require('passport');
require('./passport-setup');
const path = require('path');
const fs = require('fs');
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks.js');
const multer = require('multer');
const { PermissionsBitField } = require('discord.js');
const Papa = require('papaparse'); // Add PapaParse for CSV handling
const initCycleTLS = require('cycletls'); // Import initCycleTLS

const upload = multer({ dest: 'uploads/' });
const app = express();
const port = process.env.DASHBOARD_PORT || 3000;
let client;

// A helper function to get a default Discord avatar
const getDefaultAvatar = (discriminator) => {
    return `https://cdn.discordapp.com/embed/avatars/${discriminator % 5}.png`;
};

function start(botClient) {
    client = botClient;
    if (!process.env.SESSION_SECRET) {
        console.error("[Dashboard] FATAL: SESSION_SECRET is not defined in the environment variables.");
        process.exit(1);
    }
    app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 1000 * 60 * 60 * 24 }}));
    app.use(passport.initialize());
    app.use(passport.session());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use(express.static(path.join(__dirname, 'public')));

    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    const checkAuth = (req, res, next) => {
        if (req.isAuthenticated()) return next();
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: true, message: 'Unauthorized' });
        }
        res.redirect('/login');
    };

    const checkGuildAdmin = (req, res, next) => {
        try {
            const isApiRequest = req.path.startsWith('/api/');

            if (!req.user || !req.user.guilds) {
                if (isApiRequest) return res.status(403).json({ error: true, message: 'Authentication error. Please log in again.' });
                return res.status(403).render('error', { user: req.user, error: 'Authentication error. Please try logging in again.'});
            }

            const guild = req.user.guilds.find(g => g.id === req.params.guildId);
            if (guild && new PermissionsBitField(BigInt(guild.permissions)).has(PermissionsBitField.Flags.ManageGuild) && client.guilds.cache.has(req.params.guildId)) {
                req.guildObject = client.guilds.cache.get(req.params.guildId);
                return next();
            }

            if (isApiRequest) return res.status(403).json({ error: true, message: 'You do not have permissions for this server or the bot is not in it.' });
            res.status(403).render('error', { user: req.user, error: 'You do not have permissions for this server or the bot is not in it.'});
        } catch (e) {
            console.error('[checkGuildAdmin Middleware Error]', e);
            const isApiRequest = req.path.startsWith('/api/');
            if (isApiRequest) {
                return res.status(500).json({ error: true, message: 'An unexpected error occurred while checking permissions.' });
            }
            res.status(500).render('error', { user: req.user, error: 'An unexpected error occurred while checking permissions.'});
        }
    };

    // --- MAIN ROUTES ---
    app.get('/', (req, res) => res.render('landing', { user: req.user, client_id: process.env.DISCORD_CLIENT_ID }));
    app.get('/help', (req, res) => res.render('commands', { user: req.user }));
    app.get('/login', passport.authenticate('discord'));
    app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));
    app.get('/logout', (req, res) => { req.logout(() => { res.redirect('/'); }); });

    app.get('/dashboard', checkAuth, (req, res) => {
        const manageableGuilds = req.user.guilds.filter(g => new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild) && client.guilds.cache.has(g.id));
        res.render('dashboard', { manageableGuilds, user: req.user });
    });

    app.get('/manage/:guildId', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const botGuild = req.guildObject;
            const guildId = botGuild.id;
            const [[allSubscriptions], [guildSettingsResult], [channelSettingsResult], allRoles, allChannels, [rawTeamSubscriptions], [allStreamers]] = await Promise.all([
                db.execute(`SELECT sub.*, s.platform, s.username, s.discord_user_id, s.kick_username, s.streamer_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? ORDER BY s.username`, [guildId]),
                db.execute('SELECT * FROM guilds WHERE guild_id = ?', [guildId]),
                db.execute('SELECT * FROM channel_settings WHERE guild_id = ?', [guildId]),
                botGuild.roles.fetch(),
                botGuild.channels.fetch(),
                db.execute('SELECT * FROM twitch_teams WHERE guild_id = ?', [guildId]),
                db.execute('SELECT streamer_id, platform, username, kick_username, discord_user_id FROM streamers') // Fetch all streamers to link accounts
            ]);

            const channelsData = {};
            const allChannelsMap = new Map(allChannels.map(ch => [ch.id, ch.name]));

            // Map to link Twitch and Kick streamers by discord_user_id or kick_username
            const linkedStreamerMap = new Map(); // Key: streamer_id, Value: { twitch_streamer_id, kick_streamer_id, twitch_username, kick_username }
            const streamerIdToDataMap = new Map(allStreamers.map(s => [s.streamer_id, s]));

            allStreamers.forEach(s => {
                if (s.discord_user_id) {
                    const existing = linkedStreamerMap.get(`discord-${s.discord_user_id}`);
                    if (!existing) {
                        linkedStreamerMap.set(`discord-${s.discord_user_id}`, { [s.platform]: s.streamer_id, twitch_username: s.platform === 'twitch' ? s.username : null, kick_username: s.platform === 'kick' ? s.username : null });
                    } else {
                        existing[s.platform] = s.streamer_id;
                        if (s.platform === 'twitch') existing.twitch_username = s.username;
                        if (s.platform === 'kick') existing.kick_username = s.username;
                    }
                } else if (s.platform === 'twitch' && s.kick_username) {
                    const kickStreamer = allStreamers.find(ks => ks.platform === 'kick' && ks.username === s.kick_username);
                    if (kickStreamer) {
                        const existing = linkedStreamerMap.get(`twitch-kick-${s.streamer_id}`);
                        if (!existing) {
                            linkedStreamerMap.set(`twitch-kick-${s.streamer_id}`, { twitch: s.streamer_id, kick: kickStreamer.streamer_id, twitch_username: s.username, kick_username: kickStreamer.username });
                        } else {
                            existing.kick = kickStreamer.streamer_id;
                            existing.kick_username = kickStreamer.username;
                        }
                    }
                }
            });

            // Initialize channelsData with all possible channels (text-based) and a 'default' entry
            allChannels.filter(c => c.isTextBased()).forEach(ch => {
                channelsData[ch.id] = { name: ch.name, individualStreamers: [], teams: [] };
            });
            channelsData['default'] = { name: 'Server Default', individualStreamers: [], teams: [] };

            const teamSubscriptions = [];
            const processedStreamerSubscriptionKeys = new Set(); // To track streamer_id-channel_id pairs that have been processed (either in team or individual)

            // Process team subscriptions and their members
            for (const teamSub of rawTeamSubscriptions) {
                const [rawMembers] = await db.execute(
                    `SELECT sub.subscription_id, sub.announcement_channel_id, sub.override_nickname, sub.custom_message, sub.override_avatar_url, s.streamer_id, s.platform, s.username, s.kick_username, s.discord_user_id
                     FROM subscriptions sub
                     JOIN streamers s ON sub.streamer_id = s.streamer_id
                     WHERE sub.guild_id = ? AND sub.announcement_channel_id = ? AND s.platform = 'twitch'`,
                    [guildId, teamSub.announcement_channel_id]
                );

                const members = [];
                for (const rawMember of rawMembers) {
                    const memberData = {
                        subscription_id: rawMember.subscription_id,
                        announcement_channel_id: rawMember.announcement_channel_id,
                        override_nickname: rawMember.override_nickname,
                        custom_message: rawMember.custom_message,
                        override_avatar_url: rawMember.override_avatar_url,
                        twitch_username: rawMember.username,
                        discord_user_id: rawMember.discord_user_id
                    };
                    let kickUsername = rawMember.kick_username;

                    // Try to find linked Kick account if not directly specified or if discord_user_id links them
                    if (rawMember.discord_user_id) {
                        const linked = linkedStreamerMap.get(`discord-${rawMember.discord_user_id}`);
                        if (linked?.kick) { // If a Kick account is linked via discord_user_id
                            const kickStreamerData = streamerIdToDataMap.get(linked.kick);
                            if (kickStreamerData) kickUsername = kickStreamerData.username;
                        }
                    } else if (rawMember.platform === 'twitch' && rawMember.kick_username) {
                        // Fallback for older links without discord_user_id
                        const kickStreamer = allStreamers.find(s => s.platform === 'kick' && s.username === kickUsername);
                        if (kickStreamer) kickUsername = kickStreamer.username;
                    }
                    memberData.kick_username = kickUsername;
                    members.push(memberData);

                    // Mark this Twitch subscription and its linked Kick subscription as processed for this channel
                    processedStreamerSubscriptionKeys.add(`${rawMember.streamer_id}-${teamSub.announcement_channel_id}`);
                    if (kickUsername) { // If there's a linked Kick account, mark its subscription as processed too
                        const kickStreamer = allStreamers.find(s => s.platform === 'kick' && s.username === kickUsername);
                        if (kickStreamer) {
                            processedStreamerSubscriptionKeys.add(`${kickStreamer.streamer_id}-${teamSub.announcement_channel_id}`);
                        }
                    }
                }
                teamSub.members = members;
                teamSubscriptions.push(teamSub);

                const channelId = teamSub.announcement_channel_id;
                if (!channelsData[channelId]) {
                    channelsData[channelId] = { name: allChannelsMap.get(channelId) || 'Unknown Channel', individualStreamers: [], teams: [] };
                }
                channelsData[channelId].teams.push(teamSub);
            }

            // Process individual subscriptions, filtering out those already in teams
            for (const sub of allSubscriptions) {
                const subChannelId = sub.announcement_channel_id || 'default';
                const subscriptionKey = `${sub.streamer_id}-${subChannelId}`;

                // Check if this specific subscription (streamer_id + channel_id) has been processed by a team
                if (!processedStreamerSubscriptionKeys.has(subscriptionKey)) {
                    // Also check if this streamer's *linked* account is part of a team for this channel
                    let isLinkedToTeam = false;
                    if (sub.discord_user_id) {
                        const linked = linkedStreamerMap.get(`discord-${sub.discord_user_id}`);
                        if (linked) {
                            // Check if the linked Twitch or Kick streamer_id is part of a team for this channel
                            if (linked.twitch && processedStreamerSubscriptionKeys.has(`${linked.twitch}-${subChannelId}`)) isLinkedToTeam = true;
                            if (linked.kick && processedStreamerSubscriptionKeys.has(`${linked.kick}-${subChannelId}`)) isLinkedToTeam = true;
                        }
                    } else if (sub.platform === 'twitch' && sub.kick_username) {
                        const kickStreamer = allStreamers.find(s => s.platform === 'kick' && s.username === kickUsername);
                        if (kickStreamer && processedStreamerSubscriptionKeys.has(`${kickStreamer.streamer_id}-${subChannelId}`)) isLinkedToTeam = true;
                    } else if (sub.platform === 'kick' && sub.twitch_username) { // Assuming twitch_username might be stored for kick streamers
                        const twitchStreamer = allStreamers.find(s => s.platform === 'twitch' && s.username === sub.twitch_username);
                        if (twitchStreamer && processedStreamerSubscriptionKeys.has(`${twitchStreamer.streamer_id}-${subChannelId}`)) isLinkedToTeam = true;
                    }

                    if (!isLinkedToTeam) {
                        if (!channelsData[subChannelId]) {
                            channelsData[subChannelId] = { name: allChannelsMap.get(subChannelId) || 'Unknown Channel', individualStreamers: [], teams: [] };
                        }
                        channelsData[subChannelId].individualStreamers.push(sub);
                    }
                }
            }

            // Filter out channels that have no streamers or teams
            const filteredChannelsData = Object.fromEntries(
                Object.entries(channelsData).filter(([channelId, data]) =>
                    data.individualStreamers.length > 0 || data.teams.length > 0
                )
            );

            res.render('manage', {
                guild: botGuild,
                channelsData: filteredChannelsData, // Use filtered and structured data
                totalSubscriptions: allSubscriptions.length, // Total count of all subscriptions
                user: req.user,
                settings: guildSettingsResult[0] || {},
                channelSettings: channelSettingsResult,
                roles: allRoles.filter(r => !r.managed && r.name !== '@everyone'),
                channels: allChannels.filter(c => c.isTextBased()),
                teamSubscriptions: teamSubscriptions // Still pass this for the teams-tab partial
            });
        } catch (error) {
            console.error('[Dashboard GET Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error loading management page.' });
        }
    });

    app.post('/manage/:guildId/settings', checkAuth, checkGuildAdmin, async (req, res) => {
        const { channelId, roleId } = req.body;
        await db.execute('INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = ?, live_role_id = ?', [req.params.guildId, channelId || null, roleId || null, channelId || null, roleId || null]);
        res.redirect(`/manage/${req.params.guildId}?success=settings`);
    });

    app.post('/manage/:guildId/add', checkAuth, checkGuildAdmin, async (req, res) => {
        const { platform, username } = req.body;
        let streamerInfo = { puid: null, dbUsername: null }; // Initialize with nulls
        let pfp = null; 
        let cycleTLSInstance = null; // Declare cycleTLSInstance here

        try {
            if (platform === 'kick') {
                cycleTLSInstance = await initCycleTLS({ timeout: 60000 }); // Initialize cycleTLS for Kick
                const u = await apiChecks.getKickUser(cycleTLSInstance, username); 
                if (u) {
                    streamerInfo = { puid: u.id?.toString() || null, dbUsername: u.user?.username || null };
                    pfp = u.user?.profile_pic || null;
                }
            } else if (platform === 'twitch') {
                const u = await apiChecks.getTwitchUser(username);
                if (u) {
                    streamerInfo = { puid: u.id || null, dbUsername: u.login || null };
                    pfp = u.profile_image_url || null;
                }
            } else if (platform === 'youtube') {
                const c = await apiChecks.getYouTubeChannelId(username);
                if (c?.channelId) {
                    streamerInfo = { puid: c.channelId || null, dbUsername: c.channelName || username || null };
                }
            } else if (['tiktok', 'trovo'].includes(platform)) {
                // For these, username is often used as the primary identifier
                streamerInfo = { puid: username || null, dbUsername: username || null };
            }

            // If streamerInfo.puid is still null after platform-specific logic, it means the user was not found or an error occurred.
            if (!streamerInfo.puid) {
                return res.status(400).render('error', { user: req.user, error: `Could not find streamer "${username}" on ${platform}. Please check the username/ID.` });
            }

            // Ensure all parameters are explicitly null if they are undefined
            const finalPlatform = platform || null;
            const finalPuid = streamerInfo.puid || null;
            const finalDbUsername = streamerInfo.dbUsername || null;
            const finalPfp = pfp || null;

            // Insert or update streamer data
            await db.execute(
                'INSERT INTO streamers (platform, platform_user_id, username, profile_image_url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username), profile_image_url = VALUES(profile_image_url)',
                [finalPlatform, finalPuid, finalDbUsername, finalPfp]
            );

            const [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [finalPlatform, finalPuid]);

            // --- NEW CHECK HERE ---
            if (!streamer || typeof streamer.streamer_id === 'undefined' || streamer.streamer_id === null) {
                console.error('Streamer or streamer_id is invalid after SELECT:', streamer); // Added more context
                return res.status(500).render('error', { user: req.user, error: 'Failed to retrieve streamer ID after creation/update. Streamer might not have been properly saved or retrieved.' });
            }
            // --- END NEW CHECK ---

            // Handle announcement_channel_id from form (can be multiple)
            const announcementChannelIds = req.body.announcement_channel_id;
            let channelsToSubscribe = [];

            // Normalize to an array, handling undefined/null cases
            const ids = announcementChannelIds ? (Array.isArray(announcementChannelIds) ? announcementChannelIds : [announcementChannelIds]) : [];

            if (ids.length > 0) {
                const hasDefault = ids.includes('');
                // Get all actual (non-empty) channel IDs
                channelsToSubscribe = ids.filter(id => id && id !== '');

                if (hasDefault) {
                    // Add null to represent the default channel subscription
                    channelsToSubscribe.push(null);
                }
            }

            for (const channelId of channelsToSubscribe) {
                // Ensure all parameters are explicitly null if they are undefined right before the query
                const finalGuildId = req.params.guildId || null; 
                const finalStreamerId = streamer.streamer_id || null; 
                const finalChannelId = channelId || null; 

                await db.execute(
                    'INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)',
                    [finalGuildId, finalStreamerId, finalChannelId] // <-- This is line 183
                );
            }

            res.redirect(`/manage/${req.params.guildId}?success=add`);

        } catch (error) {
            console.error('[Dashboard Add Streamer Error]:', error);
            res.status(500).render('error', { user: req.user, error: 'An error occurred while adding the streamer.' });
        } finally {
            if (cycleTLSInstance) {
                try { await cycleTLSInstance.exit(); } catch (e) { console.error("Error exiting cycleTLS instance:", e); }
            }
        }
    });

    app.post('/manage/:guildId/subscribe-team', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { teamName, channelId } = req.body;
            const { guildId } = req.params;
            await db.execute('INSERT INTO twitch_teams (guild_id, team_name, announcement_channel_id) VALUES (?, ?, ?)', [guildId, teamName, channelId]);
            res.redirect(`/manage/${guildId}?success=team_added#teams-tab`);
        } catch (error) {
            console.error('[Dashboard Subscribe Team Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error subscribing to team.' });
        }
    });

    app.post('/manage/:guildId/update-team', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            let { teamSubscriptionId, liveRoleId, webhookName, webhookAvatarUrl } = req.body;
            let { guildId } = req.params;

            // Explicitly convert "undefined" string or empty string to null
            teamSubscriptionId = (teamSubscriptionId === "undefined" || teamSubscriptionId === "") ? null : teamSubscriptionId;
            liveRoleId = (liveRoleId === "undefined" || liveRoleId === "") ? null : liveRoleId;
            webhookName = (webhookName === "undefined" || webhookName === "") ? null : webhookName;
            webhookAvatarUrl = (webhookAvatarUrl === "undefined" || webhookAvatarUrl === "") ? null : webhookAvatarUrl;
            guildId = (guildId === "undefined" || guildId === "") ? null : guildId;

            await db.execute('UPDATE twitch_teams SET live_role_id = ?, webhook_name = ?, webhook_avatar_url = ? WHERE id = ? AND guild_id = ?', [
                liveRoleId,
                webhookName,
                webhookAvatarUrl,
                teamSubscriptionId,
                guildId
            ]);
            res.redirect(`/manage/${guildId}?success=team_updated#teams-tab`);
        } catch (error) {
            console.error('[Dashboard Update Team Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error updating team.' });
        }
    });

    app.post('/manage/:guildId/removeteam', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { teamSubscriptionId } = req.body;
            const { guildId } = req.params;

            // First, get the team details before deleting it
            const [[teamSub]] = await db.execute('SELECT team_name, announcement_channel_id FROM twitch_teams WHERE id = ? AND guild_id = ?', [teamSubscriptionId, guildId]);

            if (teamSub) {
                // Get team members from Twitch API
                const teamMembers = await apiChecks.getTwitchTeam(teamSub.team_name);
                if (teamMembers && teamMembers.length > 0) {
                    // Get streamer_ids for all team members
                    const memberLogins = teamMembers.map(m => m.user_login);
                    const [streamerIds] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = \'twitch\' AND username IN (?)', [memberLogins]);
                    
                    if (streamerIds.length > 0) {
                        const idsToRemove = streamerIds.map(s => s.streamer_id);
                        // Remove subscriptions for these streamers in the specified channel
                        await db.execute('DELETE FROM subscriptions WHERE guild_id = ? AND announcement_channel_id = ? AND streamer_id IN (?)', [guildId, teamSub.announcement_channel_id, idsToRemove]);
                    }
                }
                
                // Finally, remove the team subscription itself
                await db.execute('DELETE FROM twitch_teams WHERE id = ? AND guild_id = ?', [teamSubscriptionId, guildId]);
            }

            res.redirect(`/manage/${guildId}?success=team_removed#teams-tab`);
        } catch (error) {
            console.error('[Dashboard Remove Team Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error removing team subscription.' });
        }
    });

    app.post('/manage/:guildId/channel-appearance/save', checkAuth, checkGuildAdmin, upload.single('avatar'), async (req, res) => {
        try {
            const { channelId, nickname, avatar_url_text } = req.body;
            const { guildId } = req.params;

            const [[existing]] = await db.execute('SELECT avatar_url FROM channel_settings WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);

            let finalAvatarUrl = existing ? existing.avatar_url : null;
            if (avatar_url_text && avatar_url_text.toLowerCase() === 'reset') {
                finalAvatarUrl = null;
            } else if (req.file) {
                const newFilename = `${guildId}-${channelId}-${Date.now()}${path.extname(req.file.path)}`;
                const publicPath = path.join(__dirname, 'public', 'uploads', 'avatars');
                const newPath = path.join(publicPath, newFilename);
                if (!fs.existsSync(publicPath)) fs.mkdirSync(publicPath, { recursive: true });
                fs.renameSync(req.file.path, newPath);
                finalAvatarUrl = `/uploads/avatars/${newFilename}`;
            } else if (avatar_url_text) {
                finalAvatarUrl = avatar_url_text;
            }

            const finalNickname = (nickname && nickname.toLowerCase() === 'reset') ? null : nickname;

            await db.execute(
                'INSERT INTO channel_settings (guild_id, channel_id, nickname, avatar_url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), avatar_url = VALUES(avatar_url)',
                [guildId, channelId, finalNickname, finalAvatarUrl]
            );

            res.redirect(`/manage/${guildId}?success=appearance#appearance-tab`);
        } catch (error) {
            console.error('[Dashboard Channel Appearance Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error saving appearance settings.' });
        }
    });

    app.post('/manage/:guildId/remove-subscription', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { subscription_id } = req.body;
            const { guildId } = req.params;
            await db.execute('DELETE FROM subscriptions WHERE subscription_id = ? AND guild_id = ?', [subscription_id, guildId]);
            res.redirect(`/manage/${guildId}?success=remove`);
        } catch (error) {
            console.error('[Dashboard Remove Subscription Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error removing subscription.' });
        }
    });

    app.post('/manage/:guildId/edit-subscription', checkAuth, checkGuildAdmin, upload.single('avatar'), async (req, res) => {
        try {
            const {
                subscription_id,
                discord_user_id,
                kick_username,
                announcement_channel_id,
                override_nickname,
                custom_message,
                override_avatar_url_text,
                reset_avatar
            } = req.body;
            const guildId = req.params.guildId;

            const [[sub]] = await db.execute('SELECT streamer_id, override_avatar_url FROM subscriptions WHERE subscription_id = ? AND guild_id = ?', [subscription_id, guildId]);
            if (!sub) {
                return res.status(404).render('error', { user: req.user, error: 'Subscription not found.' });
            }
            const streamer_id = sub.streamer_id;

            let finalAvatarUrl = sub.override_avatar_url;
            if (reset_avatar === 'true' || (override_avatar_url_text && override_avatar_url_text.toLowerCase() === 'reset')) {
                finalAvatarUrl = null;
            } else if (req.file) {
                const newFilename = `${streamer_id}-${Date.now()}${path.extname(req.file.path)}`;
                const publicPath = path.join(__dirname, 'public', 'uploads', 'avatars');
                const newPath = path.join(publicPath, newFilename);
                if (!fs.existsSync(publicPath)) {
                    fs.mkdirSync(publicPath, { recursive: true });
                }
                fs.renameSync(req.file.path, newPath);
                finalAvatarUrl = `/uploads/avatars/${newFilename}`;
            } else if (override_avatar_url_text) {
                finalAvatarUrl = override_avatar_url_text;
            }

            await db.execute(
                'UPDATE streamers SET discord_user_id = ?, kick_username = ? WHERE streamer_id = ?',
                [discord_user_id || null, kick_username || null, streamer_id]
            );

            await db.execute(
                'UPDATE subscriptions SET announcement_channel_id = ?, override_nickname = ?, custom_message = ?, override_avatar_url = ? WHERE subscription_id = ?',
                [announcement_channel_id || null, override_nickname || null, custom_message || null, finalAvatarUrl, subscription_id]
            );

            res.redirect(`/manage/${guildId}?success=edit`);
        } catch (error) {
            console.error('[Dashboard Edit Subscription Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error saving changes.' });
        }
    });

    app.get('/manage/:guildId/export', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId } = req.params;
            const [rows] = await db.execute(`
                SELECT s.platform, s.username, s.discord_user_id, s.kick_username, sub.announcement_channel_id, sub.custom_message
                FROM subscriptions sub
                JOIN streamers s ON sub.streamer_id = s.streamer_id
                WHERE sub.guild_id = ?
            `, [guildId]);

            if (rows.length === 0) {
                return res.status(404).send('No subscriptions to export.');
            }

            const csvHeader = "Platform,Username,DiscordUserID,KickUsername,ChannelID,CustomMessage\n";
            const csvRows = rows.map(row => 
                `${row.platform},${row.username},${row.discord_user_id || ''},${row.kick_username || ''},${row.announcement_channel_id || ''},"${row.custom_message || ''}"`
            ).join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="subscriptions-${guildId}.csv"`);
            res.send(csvHeader + csvRows);
        } catch (error) {
            console.error('[Dashboard Export Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Could not export subscriptions.' });
        }
    });

    app.get('/manage/:guildId/export-teams', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId } = req.params;
            const { teamId } = req.query;
            const botGuild = req.guildObject;

            let query = 'SELECT tt.id, tt.team_name, tt.announcement_channel_id, tt.live_role_id, tt.webhook_name, tt.webhook_avatar_url FROM twitch_teams tt WHERE tt.guild_id = ?';
            const params = [guildId];

            if (teamId) {
                query += ' AND tt.id = ?';
                params.push(teamId);
            }

            const [teams] = await db.execute(query, params);

            if (teams.length === 0) {
                return res.status(404).send('No teams to export.');
            }

            const allRoles = await botGuild.roles.fetch();
            const rolesMap = new Map(allRoles.map(role => [role.id, role.name]));
            const allChannels = await botGuild.channels.fetch();
            const channelsMap = new Map(allChannels.map(ch => [ch.id, ch.name]));

            const csvHeader = "TeamName,AnnouncementChannel,LiveRole,WebhookName,WebhookAvatarUrl\n";
            const csvRows = teams.map(team => {
                const channelName = team.announcement_channel_id ? channelsMap.get(team.announcement_channel_id) || 'Unknown Channel' : '';
                const roleName = team.live_role_id ? rolesMap.get(team.live_role_id) || 'Unknown Role' : '';
                const webhookName = team.webhook_name || '';
                const webhookAvatarUrl = team.webhook_avatar_url || '';
                return `${team.team_name},#${channelName},${roleName},${webhookName},${webhookAvatarUrl}`;
            }).join('\n');

            const filename = teamId ? `team-${teams[0].team_name}-export.csv` : `teams-export-${guildId}.csv`;
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(csvHeader + csvRows);
        } catch (error) {
            console.error('[Dashboard Export Teams Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Could not export teams.' });
        }
    });

    app.post('/manage/:guildId/import-teams-csv', checkAuth, checkGuildAdmin, upload.single('csvfile'), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { defaultChannelId } = req.body;
            const botGuild = req.guildObject;

            if (!req.file) {
                return res.status(400).render('error', { user: req.user, error: 'No CSV file uploaded.' });
            }

            const csvData = fs.readFileSync(req.file.path, 'utf8');
            const parsed = Papa.parse(csvData, { header: true, skipEmptyLines: true });
            const teamsToImport = parsed.data;

            const allChannels = await botGuild.channels.fetch();
            const channelsMap = new Map(allChannels.map(ch => [ch.name.toLowerCase(), ch.id]));
            const allRoles = await botGuild.roles.fetch();
            const rolesMap = new Map(allRoles.map(role => [role.name.toLowerCase(), role.id]));

            for (const teamRow of teamsToImport) {
                const teamName = teamRow.TeamName;
                let announcementChannelId = null; // Start with null
                let liveRoleId = null;
                let webhookName = teamRow.WebhookName || null;
                let webhookAvatarUrl = teamRow.WebhookAvatarUrl || null;

                if (!teamName) continue; // Skip rows without a team name

                // 1. Try to get AnnouncementChannelId from CSV
                if (teamRow.AnnouncementChannelName) {
                    const channelName = teamRow.AnnouncementChannelName.replace(/^#/, '').toLowerCase();
                    if (channelsMap.has(channelName)) {
                        announcementChannelId = channelsMap.get(channelName);
                    }
                }

                // 2. If not found in CSV, try to get from default dropdown (if provided and not empty)
                if (!announcementChannelId && defaultChannelId) {
                    announcementChannelId = defaultChannelId;
                }

                // Resolve LiveRoleName from CSV, if provided
                if (teamRow.LiveRoleName) {
                    const roleName = teamRow.LiveRoleName.toLowerCase();
                    if (rolesMap.has(roleName)) {
                        liveRoleId = rolesMap.get(roleName);
                    }
                }

                // Insert or update the twitch_teams table
                await db.execute(
                    'INSERT INTO twitch_teams (guild_id, team_name, announcement_channel_id, live_role_id, webhook_name, webhook_avatar_url) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id), live_role_id = VALUES(live_role_id), webhook_name = VALUES(webhook_name), webhook_avatar_url = VALUES(webhook_avatar_url)',
                    [guildId, teamName, announcementChannelId, liveRoleId, webhookName, webhookAvatarUrl]
                );
            }

            fs.unlinkSync(req.file.path); // Clean up uploaded file
            res.redirect(`/manage/${guildId}?success=teams_imported#teams-tab`);
        } catch (error) {
            console.error('[Dashboard Import Teams CSV Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Failed to import teams from CSV.' });
        }
    });

    app.post('/manage/:guildId/import-team', checkAuth, checkGuildAdmin, upload.single('csvfile'), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { channelId } = req.body;

            if (!req.file) {
                return res.status(400).render('error', { user: req.user, error: 'No CSV file uploaded.' });
            }

            const csvData = fs.readFileSync(req.file.path, 'utf8');
            const rows = csvData.split('\n').slice(1); // Skip header

            const streamersInCsv = [];
            for (const row of rows) {
                if (!row) continue;
                const [platform, username, discord_user_id, kick_username] = row.split(',').map(s => s.trim());
                if (!platform || !username) continue;

                streamersInCsv.push(username.toLowerCase());

                let [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND username = ?', [platform, username]);
                if (!streamer) {
                    const [result] = await db.execute('INSERT INTO streamers (platform, username, discord_user_id, kick_username) VALUES (?, ?, ?, ?)', [platform, username, discord_user_id || null, kick_username || null]);
                    streamer = { streamer_id: result.insertId };
                } else {
                    await db.execute('UPDATE streamers SET discord_user_id = ?, kick_username = ? WHERE streamer_id = ?', [discord_user_id || null, kick_username || null, streamer.streamer_id]);
                }

                await db.execute(
                    'INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id)',
                    [guildId, streamer.streamer_id, channelId]
                );
            }

            const [existingSubs] = await db.execute('SELECT s.username FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? AND sub.announcement_channel_id = ?', [guildId, channelId]);
            for (const sub of existingSubs) {
                if (!streamersInCsv.includes(sub.username.toLowerCase())) {
                    await db.execute('DELETE sub FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? AND sub.announcement_channel_id = ? AND s.username = ?', [guildId, channelId, sub.username]);
                }
            }

            fs.unlinkSync(req.file.path); // Clean up uploaded file
            res.redirect(`/manage/${guildId}?success=import#csv-tab`);
        } catch (error) {
            console.error('[Dashboard Import Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Failed to sync from CSV.' });
        }
    });

    // --- API ROUTES ---

    // Helper function to process and format live streamer data
    async function getFormattedLiveRows(rows) {
        const platformPriority = ['kick', 'twitch', 'youtube', 'tiktok', 'trovo'];
        const streamersMap = new Map();

        // Group all announcements by a common ID (discord_user_id or username)
        for (const row of rows) {
            const key = row.discord_user_id || row.username.toLowerCase();
            if (!streamersMap.has(key)) {
                streamersMap.set(key, []);
            }
            streamersMap.get(key).push(row);
        }

        // Pre-fetch all associated accounts for users with a discord_user_id
        const discordUserIds = rows.map(r => r.discord_user_id).filter(id => id);
        const allAssociatedAccounts = new Map();
        if (discordUserIds.length > 0) {
            const [accounts] = await db.query(
                'SELECT discord_user_id, username, platform, profile_image_url FROM streamers WHERE discord_user_id IN (?)',
                [[...new Set(discordUserIds)]] // Use Set to get unique IDs
            );
            for (const acc of accounts) {
                if (!allAssociatedAccounts.has(acc.discord_user_id)) {
                    allAssociatedAccounts.set(acc.discord_user_id, []);
                }
                allAssociatedAccounts.get(acc.discord_user_id).push(acc);
            }
            // Sort accounts by priority for each user
            allAssociatedAccounts.forEach(userAccounts => {
                userAccounts.sort((a, b) => platformPriority.indexOf(a.platform) - platformPriority.indexOf(b.platform));
            });
        }

        const formattedResult = [];
        for (const userAnnouncements of streamersMap.values()) {
            // Sort the live announcements for a user based on platform priority
            userAnnouncements.sort((a, b) => {
                const priorityA = platformPriority.indexOf(a.platform);
                const priorityB = platformPriority.indexOf(b.platform);
                return priorityA - priorityB;
            });

            const primaryLiveAnnouncement = userAnnouncements[0];
            const discordId = primaryLiveAnnouncement.discord_user_id;

            let primaryIdentity = primaryLiveAnnouncement; // Default to the live one
            let bestAvatar = primaryLiveAnnouncement.profile_image_url;

            // If the user is linked via Discord, find their absolute primary account (e.g., Kick)
            const userAccounts = allAssociatedAccounts.get(discordId);
            if (userAccounts && userAccounts.length > 0) {
                primaryIdentity = userAccounts[0]; // This is the highest priority account overall
                bestAvatar = userAccounts.find(acc => acc.profile_image_url)?.profile_image_url || bestAvatar;
            }

            // Collect all unique platforms the user is live on
            const live_platforms = [...new Map(userAnnouncements.map(a => [a.platform, {
                platform: a.platform,
                game: a.stream_game || 'N/A'
            }])).values()];

            formattedResult.push({
                username: primaryIdentity.username, // Use username from primary overall account
                avatar_url: bestAvatar || getDefaultAvatar(0), // Use the best avatar we could find
                live_platforms: live_platforms,
            });
        }

        return formattedResult;
    }


    app.get('/api/global-live-status', async (req, res) => {
        try {
            // Select all live streamers from the announcements table
            const [liveRows] = await db.execute(`
                SELECT s.streamer_id, s.username, s.discord_user_id, s.profile_image_url, a.platform, a.stream_game
                FROM announcements a
                         JOIN streamers s ON a.streamer_id = s.streamer_id
            `);
            const formatted = await getFormattedLiveRows(liveRows);
            res.json(formatted);
        } catch (error) {
            console.error('[API global-live-status Error]', error);
            res.status(500).json({ error: true, message: 'Internal server error.' });
        }
    });

    app.get('/api/guilds/:guildId/livestatus', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            // Select live streamers based on announcements for THIS guild
            const [liveRows] = await db.execute(`
                SELECT s.streamer_id, s.username, s.discord_user_id, s.profile_image_url, a.platform, a.stream_game
                FROM announcements a
                         JOIN streamers s ON a.streamer_id = s.streamer_id
                WHERE a.guild_id = ?
            `, [guildId]);
            const formatted = await getFormattedLiveRows(liveRows);
            res.json(formatted);
        } catch (error) {
            console.error(`[API guild-livestatus Error for ${req.params.guildId}]`, error);
            res.status(500).json({ error: true, message: 'Internal server error.' });
        }
    });

    app.use((req, res) => {
        res.status(404).render('error', { user: req.user, error: 'Page Not Found' });
    });

    app.listen(port, () => console.log(`[Dashboard] Web dashboard listening on port ${port}`));
}

module.exports = { start };
