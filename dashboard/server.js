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
const { syncTwitchTeam } = require('../core/team-sync'); // Import syncTwitchTeam
const { checkStreams } = require('../core/stream-checker'); // Import checkStreams
const logger = require('../utils/logger'); // Import logger

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

    const checkSuperAdmin = (req, res, next) => {
        if (req.isAuthenticated() && req.user && req.user.isSuperAdmin) {
            return next();
        }
        if (req.path.startsWith('/api/')) {
            return res.status(403).json({ error: true, message: 'Forbidden: Super Admin access required.' });
        }
        res.status(403).render('error', { user: req.user, error: 'Forbidden: Super Admin access required.' });
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

    app.get('/status', (req, res) => {
        res.render('status', { user: req.user, isAuthenticated: req.isAuthenticated() });
    });

    // Add /donate route
    app.get('/donate', (req, res) => {
        res.render('donate', { user: req.user });
    });

    app.get('/super-admin', checkAuth, checkSuperAdmin, (req, res) => {
        res.render('super-admin', { user: req.user });
    });

    app.get('/manage/:guildId', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const botGuild = req.guildObject;
            const guildId = botGuild.id;
            const [[allSubscriptions], [guildSettingsResult], [channelSettingsResult], allRoles, allChannels, [rawTeamSubscriptions], [allStreamers]] = await Promise.all([
                db.execute(`SELECT sub.*, s.platform, s.username, s.discord_user_id, s.kick_username, s.streamer_id, s.platform_user_id, s.profile_image_url FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? ORDER BY s.username`, [guildId]),
                db.execute('SELECT * FROM guilds WHERE guild_id = ?', [guildId]),
                db.execute('SELECT * FROM channel_settings WHERE guild_id = ?', [guildId]),
                botGuild.roles.fetch(),
                botGuild.channels.fetch(),
                db.execute('SELECT * FROM twitch_teams WHERE guild_id = ?', [guildId]),
                db.execute('SELECT streamer_id, platform, username, kick_username, discord_user_id, platform_user_id, profile_image_url FROM streamers') // Fetch all streamers to link accounts
            ]);

            const allChannelsMap = new Map(allChannels.map(ch => [ch.id, ch.name]));
            const streamerIdToDataMap = new Map(allStreamers.map(s => [s.streamer_id, s]));

            const consolidatedStreamersMap = new Map(); // Key: discord_user_id or `s-${streamer_id}`
            const platformPriority = ['kick', 'twitch', 'youtube', 'tiktok', 'trovo'];

            // Process all subscriptions to build the consolidated view
            for (const sub of allSubscriptions) {
                const streamer = streamerIdToDataMap.get(sub.streamer_id);
                if (!streamer) continue; 

                const primaryKey = streamer.discord_user_id || `s-${streamer.streamer_id}`; // Use discord_user_id as primary key if available

                if (!consolidatedStreamersMap.has(primaryKey)) {
                    consolidatedStreamersMap.set(primaryKey, {
                        id: primaryKey,
                        discordUserId: streamer.discord_user_id,
                        platforms: new Map(), // Map<platform, streamer_object>
                        subscriptions: [] // Array of subscription objects
                    });
                }

                const consolidatedEntry = consolidatedStreamersMap.get(primaryKey);

                // Add platform info if not already present for this consolidated entry
                if (!consolidatedEntry.platforms.has(streamer.platform)) {
                    consolidatedEntry.platforms.set(streamer.platform, {
                        streamer_id: streamer.streamer_id,
                        platform: streamer.platform,
                        username: streamer.username,
                        platform_user_id: streamer.platform_user_id,
                        profile_image_url: streamer.profile_image_url,
                        kick_username: streamer.kick_username // Keep for potential linking display
                    });
                }

                // Add subscription info
                consolidatedEntry.subscriptions.push({
                    subscription_id: sub.subscription_id,
                    announcement_channel_id: sub.announcement_channel_id,
                    override_nickname: sub.override_nickname,
                    custom_message: sub.custom_message,
                    override_avatar_url: sub.override_avatar_url,
                    platform: streamer.platform, // Link subscription back to its platform
                    streamer_id: streamer.streamer_id, // Link subscription back to its streamer
                    team_subscription_id: sub.team_subscription_id,
                    privacy_setting: sub.privacy_setting,
                    summary_persistence: sub.summary_persistence
                });
            }

            // Convert platforms Map to array and determine primary username/avatar for each consolidated entry
            const consolidatedStreamers = Array.from(consolidatedStreamersMap.values()).map(entry => {
                entry.platforms = Array.from(entry.platforms.values()).sort((a, b) => {
                    return platformPriority.indexOf(a.platform) - platformPriority.indexOf(b.platform);
                });

                // Determine primary username and avatar based on sorted platforms
                entry.primaryUsername = entry.platforms[0]?.username || 'Unknown';
                entry.primaryAvatar = entry.platforms.find(p => p.profile_image_url)?.profile_image_url || getDefaultAvatar(0);

                // Group subscriptions by channel for easier display in the modal
                const subscriptionsByChannel = new Map();
                for (const sub of entry.subscriptions) {
                    const channelKey = sub.announcement_channel_id || 'default';
                    if (!subscriptionsByChannel.has(channelKey)) {
                        subscriptionsByChannel.set(channelKey, { channelId: sub.announcement_channel_id, channelName: allChannelsMap.get(sub.announcement_channel_id) || 'Server Default', subs: [] });
                    }
                    subscriptionsByChannel.get(channelKey).subs.push(sub);
                }
                entry.subscriptionsByChannel = Array.from(subscriptionsByChannel.values());

                return entry;
            });

            // Process team subscriptions (this logic remains largely separate as it's team-based)
            const teamSubscriptions = [];
            for (const teamSub of rawTeamSubscriptions) {
                const [rawMembers] = await db.execute(
                    `SELECT sub.subscription_id, sub.announcement_channel_id, sub.override_nickname, sub.custom_message, sub.override_avatar_url, s.streamer_id, s.platform, s.username, s.kick_username, s.discord_user_id
                     FROM subscriptions sub
                     JOIN streamers s ON sub.streamer_id = s.streamer_id
                     WHERE sub.guild_id = ? AND sub.team_subscription_id = ?`,
                    [guildId, teamSub.id]
                );

                const membersMap = new Map();
                for (const rawMember of rawMembers) {
                    const key = rawMember.discord_user_id || rawMember.streamer_id.toString();
                    if (!membersMap.has(key)) {
                        membersMap.set(key, {
                            discord_user_id: rawMember.discord_user_id,
                            twitch_username: null,
                            kick_username: null,
                            subscription_id: rawMember.platform === 'twitch' ? rawMember.subscription_id : null
                        });
                    }
                    const member = membersMap.get(key);
                    if (rawMember.platform === 'twitch') {
                        member.twitch_username = rawMember.username;
                        if (!member.subscription_id) member.subscription_id = rawMember.subscription_id;
                    }
                    if (rawMember.platform === 'kick') {
                        member.kick_username = rawMember.username;
                    }
                }
                teamSub.members = Array.from(membersMap.values());
                teamSubscriptions.push(teamSub);
            }

            res.render('manage', {
                guild: botGuild,
                consolidatedStreamers: consolidatedStreamers, // New consolidated data
                totalSubscriptions: allSubscriptions.length, 
                user: req.user,
                settings: guildSettingsResult[0] || {},
                channelSettings: channelSettingsResult,
                roles: allRoles.filter(r => !r.managed && r.name !== '@everyone'),
                channels: allChannels.filter(c => c.isTextBased()),
                teamSubscriptions: teamSubscriptions 
            });
        } catch (error) {
            console.error('[Dashboard GET Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error loading management page.' });
        }
    });

    app.post('/manage/:guildId/settings', checkAuth, checkGuildAdmin, async (req, res) => {
        const { channelId, roleId, privacy_setting, summary_persistence } = req.body;
        await db.execute(
            'INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id, privacy_setting, summary_persistence) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = ?, live_role_id = ?, privacy_setting = ?, summary_persistence = ?',
            [req.params.guildId, channelId || null, roleId || null, privacy_setting, summary_persistence, channelId || null, roleId || null, privacy_setting, summary_persistence]
        );
        res.redirect(`/manage/${req.params.guildId}?success=settings`);
    });

    app.post('/manage/:guildId/add', checkAuth, checkGuildAdmin, async (req, res) => {
        const { platform, username } = req.body;
        const { guildId } = req.params;
        let streamerInfo = { puid: null, dbUsername: null }; // Initialize with nulls
        let pfp = null; 

        try {
            if (platform === 'kick') {
                const u = await apiChecks.getKickUser(username); 
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

            const [teams] = await db.execute('SELECT id, announcement_channel_id FROM twitch_teams WHERE guild_id = ?', [guildId]);
            const teamChannelMap = new Map(teams.map(t => [t.announcement_channel_id, t.id]));

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
                const finalGuildId = guildId || null; 
                const finalStreamerId = streamer.streamer_id || null; 
                const finalChannelId = channelId || null; 
                const teamSubscriptionId = teamChannelMap.get(finalChannelId) || null;

                // Use INSERT IGNORE to prevent duplicate subscriptions for the same streamer in the same channel
                await db.execute(
                    'INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id, team_subscription_id) VALUES (?, ?, ?, ?)',
                    [finalGuildId, finalStreamerId, finalChannelId, teamSubscriptionId] 
                );
            }

            res.redirect(`/manage/${req.params.guildId}?success=add`);

        } catch (error) {
            console.error('[Dashboard Add Streamer Error]:', error);
            res.status(500).render('error', { user: req.user, error: 'An error occurred while adding the streamer.' });
        }
    });

    app.post('/manage/:guildId/subscribe-team', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { teamName, channelId } = req.body;
            const { guildId } = req.params;
            // Use INSERT IGNORE to prevent duplicate team subscriptions
            await db.execute('INSERT IGNORE INTO twitch_teams (guild_id, team_name, announcement_channel_id) VALUES (?, ?, ?)', [guildId, teamName, channelId]);
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
                const teamMembers = await apiChecks.getTwitchTeamMembers(teamSub.team_name);
                if (teamMembers && teamMembers.length > 0) {
                    // Get streamer_ids for all team members
                    const memberLogins = teamMembers.map(m => m.user_login);
                    const [streamerIds] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = \'twitch\' AND username IN (?)', [memberLogins]);
                    
                    if (streamerIds.length > 0) {
                        const idsToRemove = streamerIds.map(s => s.streamer_id);
                        // Remove subscriptions for these streamers in the specified channel
                        await db.execute('DELETE FROM subscriptions WHERE streamer_id IN (?) AND guild_id = ? AND announcement_channel_id = ?', [idsToRemove, guildId, teamSub.announcement_channel_id]);
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
            const { channelId, nickname, avatar_url_text, privacy_setting, summary_persistence } = req.body;
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
            const finalPrivacySetting = privacy_setting || null;
            const finalSummaryPersistence = summary_persistence || null;

            await db.execute(
                'INSERT INTO channel_settings (guild_id, channel_id, nickname, avatar_url, privacy_setting, summary_persistence) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), avatar_url = VALUES(avatar_url), privacy_setting = VALUES(privacy_setting), summary_persistence = VALUES(summary_persistence)',
                [guildId, channelId, finalNickname, finalAvatarUrl, finalPrivacySetting, finalSummaryPersistence]
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

    app.post('/manage/:guildId/edit-consolidated-streamer', checkAuth, checkGuildAdmin, upload.single('avatar'), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { consolidated_streamer_id, discord_user_id, platforms, subscriptions, new_platform, new_platform_username } = req.body;

            const [teams] = await db.execute('SELECT id, announcement_channel_id FROM twitch_teams WHERE guild_id = ?', [guildId]);
            const teamChannelMap = new Map(teams.map(t => [t.announcement_channel_id, t.id]));

            // 1. Handle adding a new platform
            if (new_platform && new_platform_username) {
                let streamerInfo = null;
                let pfp = null;

                if (new_platform === 'twitch') {
                    const u = await apiChecks.getTwitchUser(new_platform_username);
                    if (u) { streamerInfo = { puid: u.id, dbUsername: u.login }; pfp = u.profile_image_url; }
                } else if (new_platform === 'kick') {
                    const u = await apiChecks.getKickUser(new_platform_username);
                    if (u) { streamerInfo = { puid: u.id.toString(), dbUsername: u.user.username }; pfp = u.user.profile_pic; }
                } else if (new_platform === 'youtube') {
                    const c = await apiChecks.getYouTubeChannelId(new_platform_username);
                    if (c?.channelId) { streamerInfo = { puid: c.channelId, dbUsername: c.channelName || new_platform_username }; }
                } else if (['tiktok', 'trovo'].includes(new_platform)) {
                    streamerInfo = { puid: new_platform_username, dbUsername: new_platform_username };
                }

                if (streamerInfo && streamerInfo.puid) {
                    await db.execute(
                        'INSERT INTO streamers (platform, platform_user_id, username, profile_image_url, discord_user_id) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username), profile_image_url = VALUES(profile_image_url), discord_user_id = VALUES(discord_user_id)',
                        [new_platform, streamerInfo.puid, streamerInfo.dbUsername, pfp, discord_user_id || null]
                    );

                    const [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [new_platform, streamerInfo.puid]);
                    const newStreamerId = streamer?.streamer_id;

                    if (newStreamerId) {
                        const channelsToSubscribe = new Set();
                        if (subscriptions) {
                            for (const subId in subscriptions) {
                                channelsToSubscribe.add(subscriptions[subId].announcement_channel_id || null);
                            }
                        }

                        for (const channelId of channelsToSubscribe) {
                            const teamSubscriptionId = teamChannelMap.get(channelId) || null;
                            await db.execute(
                                'INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id, team_subscription_id) VALUES (?, ?, ?, ?)',
                                [guildId, newStreamerId, channelId, teamSubscriptionId]
                            );
                        }
                    } else {
                        logger.warn(`[Dashboard Edit] Could not find or create streamer ID for: ${new_platform_username} on ${new_platform}`);
                    }
                } else {
                    logger.warn(`[Dashboard Edit] Could not validate or find new platform user: ${new_platform_username} on ${new_platform}`);
                }
            }
    
            // 2. Update discord_user_id for all associated streamers
            if (discord_user_id !== undefined) {
                let streamerIdsToUpdateDiscord = [];
                if (consolidated_streamer_id.startsWith('s-')) {
                    streamerIdsToUpdateDiscord.push(consolidated_streamer_id.substring(2));
                } else {
                    const [associatedStreamers] = await db.execute('SELECT streamer_id FROM streamers WHERE discord_user_id = ?', [consolidated_streamer_id]);
                    streamerIdsToUpdateDiscord = associatedStreamers.map(s => s.streamer_id);
                }
    
                if (streamerIdsToUpdateDiscord.length > 0) {
                    const discordIdPlaceholders = streamerIdsToUpdateDiscord.map(() => '?').join(',');
                    await db.execute(
                        `UPDATE streamers SET discord_user_id = ? WHERE streamer_id IN (${discordIdPlaceholders})`,
                        [discord_user_id || null, ...streamerIdsToUpdateDiscord]
                    );
                }
            }
    
            // 3. Handle platform linking (e.g., Kick from Twitch)
            if (platforms) {
                for (const streamerId in platforms) {
                    const platformData = platforms[streamerId];
                    const kickUsername = platformData.kick_username ? platformData.kick_username.trim() : null;
    
                    if (platformData.platform === 'twitch' && kickUsername && kickUsername.length > 0) {
                        const [[existingKickStreamer]] = await db.execute('SELECT streamer_id, discord_user_id FROM streamers WHERE platform = \'kick\' AND username = ?', [kickUsername]);
                        let kickStreamerIdToUse = null;
    
                        if (existingKickStreamer) {
                            kickStreamerIdToUse = existingKickStreamer.streamer_id;
                            if (discord_user_id && !existingKickStreamer.discord_user_id) {
                                await db.execute('UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ?', [discord_user_id, existingKickStreamer.streamer_id]);
                            }
                        } else {
                            const kickUser = await apiChecks.getKickUser(kickUsername);
    
                            if (kickUser && kickUser.id) {
                                const kickPuid = kickUser.id.toString();
                                const kickDbUsername = kickUser.user?.username;
                                const kickPfp = kickUser.user?.profile_pic;
    
                                const [result] = await db.execute(
                                    'INSERT INTO streamers (platform, platform_user_id, username, profile_image_url, discord_user_id) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username), profile_image_url = VALUES(profile_image_url), discord_user_id = VALUES(discord_user_id)',
                                    ['kick', kickPuid, kickDbUsername, kickPfp, discord_user_id || null]
                                );
                                kickStreamerIdToUse = result.insertId;
                            }
                        }
    
                        if (kickStreamerIdToUse) {
                            const [twitchSubscriptions] = await db.execute('SELECT announcement_channel_id, team_subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?', [guildId, streamerId]);
                            for (const sub of twitchSubscriptions) {
                                await db.execute(
                                    'INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id, team_subscription_id) VALUES (?, ?, ?, ?)',
                                    [guildId, kickStreamerIdToUse, sub.announcement_channel_id, sub.team_subscription_id]
                                );
                            }
                        }
    
                        await db.execute('UPDATE streamers SET kick_username = ? WHERE streamer_id = ?', [null, streamerId]);
                    }
                }
            }
    
            // 4. Update individual subscriptions
            if (subscriptions) {
                for (const subscriptionId in subscriptions) {
                    const subData = subscriptions[subscriptionId];
                    let finalAvatarUrl = subData.override_avatar_url_text || null;
    
                    if (subData.reset_avatar === 'on') {
                        finalAvatarUrl = null;
                    }

                    const newChannelId = subData.announcement_channel_id || null;
                    const teamSubscriptionId = teamChannelMap.get(newChannelId) || null;
                    const privacySetting = subData.privacy_setting || null;
                    const summaryPersistence = subData.summary_persistence || null;
    
                    await db.execute(
                        'UPDATE subscriptions SET announcement_channel_id = ?, override_nickname = ?, custom_message = ?, override_avatar_url = ?, team_subscription_id = ?, privacy_setting = ?, summary_persistence = ? WHERE subscription_id = ? AND guild_id = ?',
                        [newChannelId, subData.override_nickname || null, subData.custom_message || null, finalAvatarUrl, teamSubscriptionId, privacySetting, summaryPersistence, subscriptionId, guildId]
                    );
                }
            }
    
            res.redirect(`/manage/${guildId}?success=edit`);
        } catch (error) {
            console.error('[Dashboard Edit Consolidated Streamer Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error saving changes for streamer.' });
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
                `${row.platform},${row.username},${row.discord_user_id || ''},${row.kick_username || ''},${row.announcement_channel_id || ''},""${row.custom_message || ''}""`
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

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="subscriptions-${guildId}.csv"`);
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

    // New route for team resync
    app.post('/manage/:guildId/resync-team', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const { teamSubscriptionId } = req.body;

        if (!teamSubscriptionId) {
            logger.warn(`[Dashboard] Manual team resync requested for guild ${guildId} but no teamSubscriptionId provided.`);
            return res.status(400).render('error', { user: req.user, error: 'Team Subscription ID is required for resync.' });
        }

        logger.info(`[Dashboard] Manual team resync requested for team ID ${teamSubscriptionId} in guild ${guildId}`);

        try {
            const result = await syncTwitchTeam(teamSubscriptionId, db, logger);
            if (result.success) {
                logger.info(`[Dashboard] Team resync successful for team ID ${teamSubscriptionId}. Triggering stream check.`);
                await checkStreams(client); // Trigger a stream check to update roles/announcements
                res.redirect(`/manage/${guildId}?success=team_resynced#teams-tab`);
            } else {
                logger.error(`[Dashboard] Team resync failed for team ID ${teamSubscriptionId}: ${result.message}`);
                res.status(500).render('error', { user: req.user, error: `Team resync failed: ${result.message}` });
            }
        } catch (error) {
            logger.error(`[Dashboard Resync Team Error] for team ID ${teamSubscriptionId} in guild ${guildId}:`, error);
            res.status(500).render('error', { user: req.user, error: 'An unexpected error occurred during team resync.' });
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
                game: a.stream_game || 'N/A',
                url: a.stream_url || '#'
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
                SELECT s.streamer_id, s.username, s.discord_user_id, s.profile_image_url, a.platform, a.stream_game, a.stream_url
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
                SELECT s.streamer_id, s.username, s.discord_user_id, s.profile_image_url, a.platform, a.stream_game, a.stream_url
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

    // API for Status Page
    app.get('/api/status-data', async (req, res) => {
        try {
            const [liveRows] = await db.execute(`
                SELECT s.streamer_id, s.username, s.discord_user_id, s.profile_image_url, a.platform, a.stream_game, a.stream_url
                FROM announcements a
                JOIN streamers s ON a.streamer_id = s.streamer_id
            `);
            const liveStreamers = await getFormattedLiveRows(liveRows);

            const [[{count: totalStreamers}]] = await db.execute('SELECT COUNT(DISTINCT streamer_id) as count FROM streamers');
            const [[{count: totalGuilds}]] = await db.execute('SELECT COUNT(DISTINCT guild_id) as count FROM guilds');
            const [[{count: totalAnnouncements}]] = await db.execute('SELECT COUNT(*) as count FROM announcements');

            const platformDistributionMap = new Map();
            for (const streamer of liveStreamers) {
                for (const platformInfo of streamer.live_platforms) {
                    const platform = platformInfo.platform;
                    platformDistributionMap.set(platform, (platformDistributionMap.get(platform) || 0) + 1);
                }
            }
            const platformDistribution = Array.from(platformDistributionMap.entries()).map(([platform, count]) => ({ platform, count }));

            // System Health (simplified for example)
            const appStatus = client && client.isReady() ? 'online' : 'offline';
            const appUptime = client && client.uptime ? `${Math.floor(client.uptime / 3600000)}h ${Math.floor((client.uptime % 3600000) / 60000)}m` : 'N/A';
            
            let dbStatus = 'offline';
            try {
                await db.execute('SELECT 1');
                dbStatus = 'ok';
            } catch (e) { /* dbStatus remains 'offline' */ }

            // Check Twitch API status
            let twitchApiStatus = 'error';
            try {
                // We check for a high-profile, stable account like 'twitch' to gauge API health.
                const twitchUser = await apiChecks.getTwitchUser('twitch');
                if (twitchUser && twitchUser.id) {
                    twitchApiStatus = 'ok';
                }
            } catch (e) {
                // The error is already logged by getTwitchUser, so we just ensure the status is 'error'.
                twitchApiStatus = 'error';
            }

            res.json({
                liveCount: liveStreamers.length,
                totalStreamers,
                totalGuilds,
                totalAnnouncements,
                liveStreamers,
                platformDistribution,
                app: { status: appStatus, uptime: appUptime },
                db: { status: dbStatus },
                api: { twitch: twitchApiStatus } // Add other APIs as needed
            });
        } catch (error) {
            console.error('[API status-data Error]', error);
            res.status(500).json({ error: true, message: 'Internal server error.' });
        }
    });

    app.get('/api/authenticated-logs', checkAuth, checkSuperAdmin, async (req, res) => {
        const logFilePath = path.join(__dirname, '..', 'logs', 'combined.log');
        try {
            if (fs.existsSync(logFilePath)) {
                const logs = await fs.promises.readFile(logFilePath, 'utf8');
                res.json({ success: true, logs });
            } else {
                res.json({ success: true, logs: 'Log file not found.' });
            }
        } catch (error) {
            console.error('[API authenticated-logs Error]', error);
            res.status(500).json({ success: false, error: 'Failed to read log file.', message: error.message });
        }
    });

    // Super Admin API Routes
    app.post('/api/admin/reinit-server', checkAuth, checkSuperAdmin, (req, res) => {
        console.log('[Super Admin] Server re-initialization requested.');
        res.json({ success: true, message: 'Server re-initialization initiated.' });
        // Give a small delay for the response to be sent before exiting
        setTimeout(() => {
            process.exit(0); // Exit to trigger restart by process manager (e.g., PM2)
        }, 1000);
    });

    app.post('/api/admin/reinit-bot', checkAuth, checkSuperAdmin, (req, res) => {
        console.log('[Super Admin] Bot re-initialization requested.');
        res.json({ success: true, message: 'Bot re-initialization initiated.' });
        // This will be caught by a listener in index.js to restart the bot process
        process.send({ type: 'restart-bot' });
    });

    app.post('/api/admin/reset-database', checkAuth, checkSuperAdmin, async (req, res) => {
        console.log('[Super Admin] Full database reset requested.');
        try {
            // List all tables to truncate. IMPORTANT: Ensure this list is accurate
            // and does not include tables you wish to preserve.
            const tablesToTruncate = [
                'announcements',
                'subscriptions',
                'streamers',
                'guilds',
                'channel_settings',
                'twitch_teams',
                'blacklisted_users' // Assuming this table exists for blacklist functionality
            ];

            for (const table of tablesToTruncate) {
                await db.execute(`TRUNCATE TABLE ${table}`);
            }
            console.log('[Super Admin] All bot-related database tables truncated.');
            res.json({ success: true, message: 'Database reset successfully. Bot will now re-initialize.' });
            setTimeout(() => {
                process.exit(0); // Exit to trigger restart and re-initialization
            }, 1000);
        } catch (error) {
            console.error('[Super Admin] Database reset failed:', error);
            res.status(500).json({ success: false, message: 'Failed to reset database.', error: error.message });
        }
    });

    app.get('/api/admin/blacklisted-users', checkAuth, checkSuperAdmin, async (req, res) => {
        try {
            // Fetch all necessary columns for display
            const [users] = await db.execute('SELECT id, platform, platform_user_id, username, discord_user_id FROM blacklisted_users');
            res.json(users);
        } catch (error) {
            console.error('[Super Admin] Failed to fetch blacklisted users:', error);
            res.status(500).json({ success: false, message: 'Failed to fetch blacklisted users.', error: error.message });
        }
    });

    app.post('/api/admin/blacklist-user', checkAuth, checkSuperAdmin, async (req, res) => {
        const { blacklistType, identifier, platform } = req.body;
        let finalPlatform, finalPlatformUserId, finalUsername, finalDiscordUserId = null;

        try {
            if (blacklistType === 'discord') {
                if (!identifier) {
                    return res.status(400).json({ success: false, message: 'Discord User ID is required.' });
                }
                finalPlatform = 'discord';
                finalPlatformUserId = identifier; // Use Discord ID as platform_user_id
                finalUsername = identifier; // Use Discord ID as username
                finalDiscordUserId = identifier;

                // Check if already blacklisted
                const [existing] = await db.execute('SELECT id FROM blacklisted_users WHERE platform = ? AND platform_user_id = ?', [finalPlatform, finalPlatformUserId]);
                if (existing.length > 0) {
                    return res.status(409).json({ success: false, message: `Discord user ${finalDiscordUserId} is already blacklisted.` });
                }

            } else if (blacklistType === 'platform') {
                if (!platform || !identifier) {
                    return res.status(400).json({ success: false, message: 'Platform and Username are required for platform blacklisting.' });
                }
                finalPlatform = platform;
                finalUsername = identifier;

                // Perform API lookup based on platform
                let streamerInfo = null;
                if (platform === 'twitch') {
                    const u = await apiChecks.getTwitchUser(identifier);
                    if (u) streamerInfo = { puid: u.id, dbUsername: u.login, discordUserId: null }; // Twitch API doesn't give discord_user_id
                } else if (platform === 'kick') {
                    const u = await apiChecks.getKickUser(identifier);
                    if (u) streamerInfo = { puid: u.id?.toString(), dbUsername: u.user?.username, discordUserId: null }; // Kick API doesn't give discord_user_id
                } else if (platform === 'youtube') {
                    const c = await apiChecks.getYouTubeChannelId(identifier);
                    if (c?.channelId) streamerInfo = { puid: c.channelId, dbUsername: c.channelName || identifier, discordUserId: null };
                }

                if (!streamerInfo || !streamerInfo.puid) {
                    return res.status(404).json({ success: false, message: `Could not find streamer "${identifier}" on ${platform}. Please check the username.` });
                }

                finalPlatformUserId = streamerInfo.puid;
                finalUsername = streamerInfo.dbUsername;

                // Try to find a linked Discord ID from our streamers table if available
                const [linkedStreamers] = await db.execute('SELECT discord_user_id FROM streamers WHERE platform = ? AND platform_user_id = ? AND discord_user_id IS NOT NULL', [finalPlatform, finalPlatformUserId]);
                if (linkedStreamers.length > 0) {
                    finalDiscordUserId = linkedStreamers[0].discord_user_id;
                }

                // Check if already blacklisted
                const [existing] = await db.execute('SELECT id FROM blacklisted_users WHERE platform = ? AND platform_user_id = ?', [finalPlatform, finalPlatformUserId]);
                if (existing.length > 0) {
                    return res.status(409).json({ success: false, message: `Streamer ${finalUsername} on ${finalPlatform} is already blacklisted.` });
                }

            } else {
                return res.status(400).json({ success: false, message: 'Invalid blacklist type provided.' });
            }

            // Insert into blacklisted_users table
            await db.execute(
                'INSERT INTO blacklisted_users (platform, platform_user_id, username, discord_user_id) VALUES (?, ?, ?, ?)',
                [finalPlatform, finalPlatformUserId, finalUsername, finalDiscordUserId]
            );

            logger.info(`[Super Admin] Blacklisted user: ${finalUsername} (${finalPlatform}, ID: ${finalPlatformUserId}, Discord: ${finalDiscordUserId || 'N/A'})`);
            res.json({ success: true, message: `User ${finalUsername} on ${finalPlatform} has been blacklisted.` });

        } catch (error) {
            logger.error('[Super Admin] Failed to blacklist user:', error);
            res.status(500).json({ success: false, message: 'Failed to blacklist user.', error: error.message });
        }
    });

    app.post('/api/admin/unblacklist-user', checkAuth, checkSuperAdmin, async (req, res) => {
        const { id } = req.body; // id from the blacklisted_users table
        if (!id) {
            return res.status(400).json({ success: false, message: 'Blacklist entry ID is required.' });
        }

        try {
            const [result] = await db.execute('DELETE FROM blacklisted_users WHERE id = ?', [id]);
            if (result.affectedRows === 0) {
                return res.status(404).json({ success: false, message: 'Blacklist entry not found.' });
            }
            logger.info(`[Super Admin] Unblacklisted user with ID: ${id}`);
            res.json({ success: true, message: 'User removed from blacklist.' });
        } catch (error) {
            logger.error('[Super Admin] Failed to unblacklist user:', error);
            res.status(500).json({ success: false, message: 'Failed to remove user from blacklist.', error: error.message });
        }
    });

    app.use((req, res) => {
        res.status(404).render('error', { user: req.user, error: 'Page Not Found' });
    });

    app.listen(port, () => logger.info(`[Dashboard] Web dashboard listening on port ${port}`));
}

module.exports = { start };