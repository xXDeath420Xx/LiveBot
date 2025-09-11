const express = require('express');
const session = require('express-session');
const passport = require('passport');
require('./passport-setup'); 
const path = require('path');
const fs = require('fs');
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks');
const initCycleTLS = require('cycletls');
const Papa = require('papaparse');
const multer = require('multer');
const { PermissionsBitField } = require('discord.js');
const { getBrowser, closeBrowser } = require('../utils/browserManager');

const addStreamerLogic = async () => ({ error: "This dashboard feature is currently under development." });
const importCsvLogic = async () => ({ error: "This dashboard feature is currently under development." });

const upload = multer({ dest: 'uploads/' });
const app = express();
const port = process.env.DASHBOARD_PORT || 3000;
let client;

function start(botClient) {
    client = botClient;
    if (!process.env.TEMP_UPLOAD_CHANNEL_ID) { console.warn('[Dashboard Init] TEMP_UPLOAD_CHANNEL_ID is not set.'); }
    app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 1000 * 60 * 60 * 24 }}));
    app.use(passport.initialize());
    app.use(passport.session());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    const checkAuth = (req, res, next) => { if (req.isAuthenticated()) return next(); res.redirect('/login'); };
    const checkGuildAdmin = (req, res, next) => {
        try {
            const guild = req.user.guilds.find(g => g.id === req.params.guildId);
            if (guild && new PermissionsBitField(BigInt(guild.permissions)).has(PermissionsBitField.Flags.ManageGuild) && client.guilds.cache.has(req.params.guildId)) {
                req.guildObject = client.guilds.cache.get(req.params.guildId);
                return next();
            }
            res.status(403).render('error', { user: req.user, error: 'You do not have permissions for this server or the bot is not in it.'});
        } catch (e) { console.error('[checkGuildAdmin Middleware Error]', e); res.status(500).render('error', { user: req.user, error: 'An unexpected error occurred while checking permissions.'}); }
    };
    const noCache = (req, res, next) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        next();
    };
    app.use(express.static(path.join(__dirname, 'public')));
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));
    app.get('/', (req, res) => res.render('landing', { user: req.user, client_id: process.env.DISCORD_CLIENT_ID }));
    app.get('/help', (req, res) => res.render('commands', { user: req.user, client_id: process.env.DISCORD_CLIENT_ID }));
    app.get('/login', passport.authenticate('discord'));
    app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));
    app.get('/logout', (req, res) => { req.logout(() => { res.redirect(process.env.DASHBOARD_URL || 'https://bot.certifriedannouncer.online'); }); });
    app.get('/dashboard', checkAuth, (req, res) => {
        const manageableGuilds = req.user.guilds.filter(g => new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild) && client.guilds.cache.has(g.id));
        res.render('dashboard', { manageableGuilds, user: req.user });
    });
    app.get('/manage/:guildId', checkAuth, checkGuildAdmin, noCache, async (req, res) => {
        try {
            const botGuild = req.guildObject;
            const guildId = botGuild.id;
            const [[subscriptions], [guildSettingsResult], [channelSettingsResult], allRoles, allChannels, [teamSubscriptions]] = await Promise.all([
                // *** UPDATED QUERY to fetch kick_username ***
                db.execute(`SELECT sub.*, s.platform, s.username, s.discord_user_id, s.kick_username, s.streamer_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? ORDER BY s.username`, [guildId]),
                db.execute('SELECT * FROM guilds WHERE guild_id = ?', [guildId]),
                db.execute('SELECT * FROM channel_settings WHERE guild_id = ?', [guildId]),
                botGuild.roles.fetch(),
                botGuild.channels.fetch(),
                db.execute('SELECT * FROM twitch_teams WHERE guild_id = ?', [guildId])
            ]);
            const channelsData = {};
            const allChannelsMap = new Map(allChannels.map(ch => [ch.id, ch.name]));
            for (const sub of subscriptions) {
                const channelId = sub.announcement_channel_id || 'default';
                if (!channelsData[channelId]) {
                    channelsData[channelId] = { name: channelId === 'default' ? 'Server Default' : allChannelsMap.get(channelId) || 'Unknown Channel', streamers: [], teams: [] };
                }
                channelsData[channelId].streamers.push(sub);
            }
            for (const teamSub of teamSubscriptions) {
                const channelId = teamSub.announcement_channel_id;
                 if (!channelsData[channelId]) {
                    channelsData[channelId] = { name: allChannelsMap.get(channelId) || 'Unknown Channel', streamers: [], teams: [] };
                }
                channelsData[channelId].teams.push(teamSub);
            }
            for(const channelId in channelsData){
                const streamerMap = new Map();
                for(const streamer of channelsData[channelId].streamers){
                     if (!streamerMap.has(streamer.streamer_id)) {
                        streamerMap.set(streamer.streamer_id, { ...streamer, subscriptions: [] });
                    }
                    streamerMap.get(streamer.streamer_id).subscriptions.push(streamer);
                }
                channelsData[channelId].streamers = Array.from(streamerMap.values());
            }
            res.render('manage', { 
                guild: botGuild,
                channelsData: channelsData,
                totalSubscriptions: subscriptions.length,
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
    app.get('/api/global-live-status', async(req, res) => {
        try {
            const [liveAnnouncements] = await db.execute(`SELECT s.username, s.profile_image_url, a.platform, a.stream_game, a.stream_thumbnail_url, sub.override_avatar_url FROM announcements a JOIN streamers s ON a.streamer_id = s.streamer_id LEFT JOIN subscriptions sub ON a.streamer_id = sub.streamer_id AND a.guild_id = sub.guild_id AND a.channel_id <=> sub.announcement_channel_id`);
            const groupedByName = {};
            for (const stream of liveAnnouncements) {
                const key = stream.username.toLowerCase();
                if (!groupedByName[key]) {
                    groupedByName[key] = { username: stream.username, potential_avatars: new Set(), live_platforms: [] };
                }
                if(stream.override_avatar_url) groupedByName[key].potential_avatars.add(stream.override_avatar_url);
                if(stream.profile_image_url) groupedByName[key].potential_avatars.add(stream.profile_image_url);
                if(stream.stream_thumbnail_url) groupedByName[key].potential_avatars.add(stream.stream_thumbnail_url);
                if (!groupedByName[key].live_platforms.some(p => p.platform === stream.platform)) {
                    groupedByName[key].live_platforms.push({ platform: stream.platform, game: stream.stream_game || 'N/A' });
                }
            }
            const uniqueStreamers = Object.values(groupedByName).map(streamer => {
                const bestAvatar = [...streamer.potential_avatars].find(url => url && !url.includes('restricted') && !url.includes('twitch-default-404')) || [...streamer.potential_avatars][0] || '/images/default-icon.png';
                return { username: streamer.username, avatar_url: bestAvatar, live_platforms: streamer.live_platforms };
            });
            const finalStreamers = uniqueStreamers.sort(() => 0.5 - Math.random()).slice(0, 5);
            res.json(finalStreamers);
        } catch (e) {
            console.error('[Global Live Status API Error]', e);
            res.status(500).json([]);
        }
    });
    app.get('/api/guilds/:guildId/livestatus', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const [liveAnnouncements] = await db.execute(`SELECT s.platform, s.username, s.profile_image_url, MAX(a.stream_game) as stream_game, MAX(a.stream_thumbnail_url) as stream_thumbnail_url, MAX(sub.override_avatar_url) as override_avatar_url FROM announcements a JOIN streamers s ON a.streamer_id = s.streamer_id LEFT JOIN subscriptions sub ON a.streamer_id = sub.streamer_id AND a.guild_id = sub.guild_id AND a.channel_id <=> sub.announcement_channel_id WHERE a.guild_id = ? GROUP BY s.streamer_id, s.platform, s.username, s.profile_image_url ORDER BY s.platform, s.username`, [req.params.guildId]);
            const enrichedStreamers = liveAnnouncements.map(streamer => ({ ...streamer, avatar_url: streamer.override_avatar_url || streamer.profile_image_url || streamer.stream_thumbnail_url || '/images/default-icon.png' }));
            res.json(enrichedStreamers);
        } catch (e) {
            console.error('[Live Status API Error]', e);
            res.status(500).json([]);
        }
    });
    app.post('/manage/:guildId/settings', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { channelId, roleId } = req.body;
            await db.execute('INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = ?, live_role_id = ?', [req.params.guildId, channelId || null, roleId || null, channelId || null, roleId || null]);
            res.redirect(`/manage/${req.params.guildId}?success=settings`);
        } catch (e) { console.error('[Dashboard Settings Save Error]', e); res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent('Failed to save settings.')}`); }
    });
    app.post('/manage/:guildId/channel-appearance/save', checkAuth, checkGuildAdmin, upload.single('avatar'), async (req, res) => {
        const { channelId, nickname, avatar_url_text } = req.body;
        const avatarFile = req.file;
        const guildId = req.params.guildId;
        if (!channelId) { return res.redirect(`/manage/${guildId}?error=${encodeURIComponent('You must select a channel to customize.')}`); }
        try {
            const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
            if ((avatarFile || avatar_url_text) && !tempUploadChannelId) { throw new Error("Avatar upload features are not configured."); }
            const guild = client.guilds.cache.get(guildId);
            if (!guild) throw new Error("Bot is not in this guild.");
            const channel = await guild.channels.fetch(channelId).catch(() => null);
            if (!channel || !channel.isTextBased()) throw new Error("Invalid or inaccessible channel selected.");
            let finalAvatarUrl = undefined;
            if (avatarFile) {
                try {
                    const tempChannel = await client.channels.fetch(tempUploadChannelId);
                    if (!tempChannel || !tempChannel.isTextBased()) { throw new Error("Temporary upload channel is not a text channel."); }
                    const tempMessage = await tempChannel.send({ files: [{ attachment: avatarFile.path, name: avatarFile.originalname }] });
                    finalAvatarUrl = tempMessage.attachments.first().url;
                } catch (uploadError) { console.error('[Dashboard Channel Customize] Error uploading avatar:', uploadError); throw new Error("Failed to upload custom avatar."); }
            } else if (avatar_url_text !== undefined) {
                 if (avatar_url_text.toLowerCase() === 'reset' || avatar_url_text === '') { finalAvatarUrl = null; } 
                 else if (!/^https?:\/\//.test(avatar_url_text)) { return res.redirect(`/manage/${guildId}?error=${encodeURIComponent('Invalid avatar URL.')}`); }
                 else { finalAvatarUrl = avatar_url_text; }
            }
            const updates = {};
            if (nickname !== undefined) { updates.override_nickname = nickname || null; }
            if (finalAvatarUrl !== undefined) { updates.override_avatar_url = finalAvatarUrl; }
            if (Object.keys(updates).length > 0) {
                const updateKeys = Object.keys(updates);
                const updateClauses = updateKeys.map(key => `${db.pool.escapeId(key)} = ?`).join(', ');
                const updateValues = updateKeys.map(key => updates[key]);
                await db.execute(`INSERT INTO channel_settings (channel_id, guild_id, ${updateKeys.map(key => db.pool.escapeId(key)).join(', ')}) VALUES (?, ?, ${updateKeys.map(() => '?').join(', ')}) ON DUPLICATE KEY UPDATE ${updateClauses}`, [channelId, guildId, ...updateValues, ...updateValues]);
            }
            res.redirect(`/manage/${req.params.guildId}?success=customization`);
        } catch (e) {
            console.error("[Dashboard Channel Customize Error]", e);
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent(`Customization failed: ${e.message}`)}`); 
        } finally {
            if (avatarFile?.path) fs.unlink(avatarFile.path, (err) => { if (err) console.error("Error deleting temp avatar file:", err); });
        }
    });
    app.post('/manage/:guildId/channel-appearance/delete', checkAuth, checkGuildAdmin, async(req, res) => {
        const { channelId } = req.body;
        try {
            if (!channelId) {
                throw new Error('Channel ID is required for deletion.');
            }
            const [result] = await db.execute('DELETE FROM channel_settings WHERE channel_id = ? AND guild_id = ?', [channelId, req.params.guildId]);
            
            if (result.affectedRows > 0) {
                res.redirect(`/manage/${req.params.guildId}?success=customization_reset`);
            } else {
                throw new Error('Could not find the customization to delete. It may have already been removed.');
            }
        } catch (e) {
            console.error('[Dashboard Channel Appearance Delete Error]', e);
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent(`Failed to reset channel customization: ${e.message}`)}`);
        }
    });
    app.post('/manage/:guildId/add', checkAuth, checkGuildAdmin, upload.single('avatar'), async (req, res) => {
        const { platform, username, discord_user_id, announcement_channel_id, override_nickname, custom_message } = req.body;
        let channelIds = Array.isArray(announcement_channel_id) ? announcement_channel_id : (announcement_channel_id ? [announcement_channel_id] : []);
        if (channelIds.length === 0) channelIds.push(null);
        const avatarFile = req.file;
        let finalAvatarUrl = null;
        let cycleTLS = null;
        let browser = null;
        try {
            const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
            if (avatarFile && !tempUploadChannelId) { throw new Error("Avatar upload features are not configured."); }
            if (avatarFile) {
                try {
                    const tempChannel = await client.channels.fetch(tempUploadChannelId);
                    if (!tempChannel || !tempChannel.isTextBased()) { throw new Error("Temporary upload channel is not a text channel."); }
                    const tempMessage = await tempChannel.send({ files: [{ attachment: avatarFile.path, name: avatarFile.originalname }] });
                    finalAvatarUrl = tempMessage.attachments.first().url;
                } catch (uploadError) { console.error('[Dashboard Add Streamer] Error uploading avatar:', uploadError); throw new Error("Failed to upload custom avatar."); }
            }
            let streamerInfo, profileImageUrl = null;
            if (platform === 'kick') cycleTLS = await initCycleTLS({ timeout: 60000 });
            if (['tiktok', 'youtube', 'trovo'].includes(platform)) browser = await getBrowser();
            if (platform === 'twitch') { const u = await apiChecks.getTwitchUser(username); if (u) { streamerInfo = { puid: u.id, dbUsername: u.login }; profileImageUrl = u.profile_image_url; } }
            else if (platform === 'kick' && cycleTLS) { const u = await apiChecks.getKickUser(cycleTLS, username); if (u) { streamerInfo = { puid: u.id.toString(), dbUsername: u.user.username }; profileImageUrl = u.user.profile_pic; } }
            else if (platform === 'youtube' && browser) { const c = await apiChecks.getYouTubeChannelId(username); if (c) streamerInfo = { puid: c, dbUsername: username }; }
            else { streamerInfo = { puid: username, dbUsername: username }; }
            if (!streamerInfo || !streamerInfo.puid) throw new Error(`User not found on ${platform}.`);
            await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, profile_image_url) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username), discord_user_id = VALUES(discord_user_id), profile_image_url = VALUES(profile_image_url)`, [platform, streamerInfo.puid, streamerInfo.dbUsername, discord_user_id || null, profileImageUrl]);
            const [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [platform, streamerInfo.puid]);
            for (const channelId of [...new Set(channelIds)]) {
                 await db.execute(`INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, override_nickname, override_avatar_url, custom_message) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id=VALUES(announcement_channel_id), override_nickname=VALUES(override_nickname), override_avatar_url=VALUES(override_avatar_url), custom_message=VALUES(custom_message)`, [req.params.guildId, streamer.streamer_id, channelId || null, override_nickname || null, finalAvatarUrl, custom_message || null]);
            }
            res.redirect(`/manage/${req.params.guildId}?success=add`);
        } catch (e) {
            console.error("[Dashboard Add Error]", e);
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent(`Failed to add streamer: ${e.message}`)}`); 
        } finally {
            if (cycleTLS) try { cycleTLS.exit(); } catch (e) {}
            if (browser) await closeBrowser();
            if (avatarFile?.path) fs.unlink(avatarFile.path, (err) => { if (err) console.error("Error deleting temp avatar file:", err); });
        }
    });
    
    // *** THIS ROUTE IS UPDATED to handle kick_username ***
    app.post('/manage/:guildId/edit-subscription', checkAuth, checkGuildAdmin, upload.single('avatar'), async (req, res) => {
        const { subscription_id, discord_user_id, kick_username, announcement_channel_id, override_nickname, custom_message, reset_avatar, override_avatar_url_text } = req.body;
        const avatarFile = req.file;
        try {
            const [[sub]] = await db.execute('SELECT streamer_id FROM subscriptions WHERE subscription_id = ? AND guild_id = ?', [subscription_id, req.params.guildId]);
            if (!sub) throw new Error("Invalid subscription or permission denied.");

            // Update the separate 'streamers' table with both discord ID and the new kick username
            await db.execute('UPDATE streamers SET discord_user_id = ?, kick_username = ? WHERE streamer_id = ?', [discord_user_id || null, kick_username || null, sub.streamer_id]);

            const updates = {};
            let finalAvatarUrl = undefined;
            if (avatarFile) {
                const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
                if (!tempUploadChannelId) throw new Error("Avatar upload feature is not configured.");
                const tempChannel = await client.channels.fetch(tempUploadChannelId);
                if (!tempChannel?.isTextBased()) throw new Error("Temporary upload channel is not valid.");
                const tempMessage = await tempChannel.send({ files: [{ attachment: avatarFile.path, name: avatarFile.originalname }] });
                finalAvatarUrl = tempMessage.attachments.first().url;
            } else if (reset_avatar === 'true') {
                finalAvatarUrl = null;
            } else if (override_avatar_url_text !== undefined) {
                const urlText = override_avatar_url_text.trim();
                if (urlText.toLowerCase() === 'reset' || urlText === '') {
                    finalAvatarUrl = null;
                } else if (!/^https?:\/\//.test(urlText)) {
                    return res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent('Invalid avatar URL.')}`);
                } else {
                    finalAvatarUrl = urlText;
                }
            }
            updates.announcement_channel_id = announcement_channel_id || null;
            updates.override_nickname = override_nickname || null;
            updates.custom_message = custom_message || null;
            if (finalAvatarUrl !== undefined) {
                updates.override_avatar_url = finalAvatarUrl;
            }
            const updateFields = Object.keys(updates);
            if (updateFields.length > 0) {
                const setClauses = updateFields.map(key => `${db.pool.escapeId(key)} = ?`).join(', ');
                const values = updateFields.map(key => updates[key]);
                values.push(subscription_id);
                await db.execute(`UPDATE subscriptions SET ${setClauses} WHERE subscription_id = ?`, values);
            }
            res.redirect(`/manage/${req.params.guildId}?success=edit`);
        } catch (e) {
            console.error('Edit Subscription Error:', e);
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent(`Failed to save settings: ${e.message}`)}`);
        } finally {
            if (avatarFile?.path) fs.unlink(avatarFile.path, (err) => { if (err) console.error("Error deleting temp avatar file:", err); });
        }
    });

    app.post('/manage/:guildId/remove-subscription', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { subscription_id } = req.body;
            if (!subscription_id) { throw new Error('Missing subscription ID.'); }
            await db.execute('DELETE FROM subscriptions WHERE subscription_id = ? AND guild_id = ?', [subscription_id, req.params.guildId]);
            res.redirect(`/manage/${req.params.guildId}?success=remove`);
        } catch (e) {
            console.error('[Dashboard Remove Sub Error]', e);
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent('Failed to remove subscription.')}`);
        }
    });
    app.post('/manage/:guildId/massadd', checkAuth, checkGuildAdmin, async (req, res) => {
        const { platform, usernames } = req.body;
        let cycleTLS = null, browser = null; 
        try {
            const usernamesArray = [...new Set(usernames.split(/\n|,+/).map(name => name.trim()).filter(Boolean))];
            if (usernamesArray.length === 0) throw new Error("No valid usernames provided.");
            cycleTLS = (platform === 'kick') ? await initCycleTLS({ timeout: 60000 }) : null;
            browser = (['tiktok', 'youtube', 'trovo'].includes(platform)) ? await getBrowser() : null;
            const result = await addStreamerLogic({ client, guildId: req.params.guildId, platform, usernames: usernamesArray, discordUserId: req.user.id, cycleTLS: cycleTLS, browser: browser });
            if (result.error) { throw new Error(result.error); }
            res.redirect(`/manage/${req.params.guildId}?success=massaction&report=${encodeURIComponent(result.summary || 'Mass add completed.')}`);
        } catch(e) { 
            console.error("[Dashboard Mass Add Error]", e); 
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent(`Mass add failed: ${e.message}`)}`); 
        } finally {
            if (cycleTLS) try { cycleTLS.exit() } catch (e) {}
            if (browser) await closeBrowser();
        }
    });
    app.post('/manage/:guildId/addteam', checkAuth, checkGuildAdmin, async (req, res) => {
        const { teamName, channelId } = req.body;
        const guildId = req.params.guildId;
        if (!teamName || !channelId) { return res.redirect(`/manage/${guildId}?error=${encodeURIComponent('Team name and channel are required.')}`); }
        
        let cycleTLS = null;
        let twitchAddedCount = 0;
        let kickAddedCount = 0;

        try {
            const teamMembers = await apiChecks.getTwitchTeamMembers(teamName);
            if (!teamMembers) throw new Error(`Could not find a Twitch Team named '${teamName}'.`);
            if (teamMembers.length === 0) throw new Error(`Twitch Team '${teamName}' has no members.`);
            
            cycleTLS = await initCycleTLS({ timeout: 60000 });

            for (const member of teamMembers) {
                await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, profile_image_url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), profile_image_url=VALUES(profile_image_url)`, ['twitch', member.user_id, member.user_login, member.profile_image_url || null]);
                const [[twitchStreamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', ['twitch', member.user_id]);
                const [twitchSubResult] = await db.execute(`INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE streamer_id=VALUES(streamer_id)`, [guildId, twitchStreamer.streamer_id, channelId]);
                if(twitchSubResult.affectedRows === 1) twitchAddedCount++;
                
                try {
                    const kickUser = await apiChecks.getKickUser(cycleTLS, member.user_login);
                    if (kickUser) {
                        await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, profile_image_url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), profile_image_url=VALUES(profile_image_url)`, ['kick', kickUser.id.toString(), kickUser.user.username, kickUser.user.profile_pic || null]);
                        const [[kickStreamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', ['kick', kickUser.id.toString()]);
                        const [kickSubResult] = await db.execute(`INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)`, [guildId, kickStreamer.streamer_id, channelId]);
                        if(kickSubResult.affectedRows === 1) kickAddedCount++;
                    }
                } catch (kickError) {
                    console.error(`[AddTeam] Error processing Kick cross-reference for '${member.user_login}':`, kickError);
                }
            }
            const report = `${twitchAddedCount} Twitch member(s) and ${kickAddedCount} matching Kick member(s) were processed for team '${teamName}'.`;
            res.redirect(`/manage/${guildId}?success=addteam&report=${encodeURIComponent(report)}`);
        } catch (e) {
            console.error("Dashboard Add Team Error:", e);
            res.redirect(`/manage/${guildId}?error=${encodeURIComponent(`Failed to add team: ${e.message}`)}`);
        } finally {
            if(cycleTLS) try { cycleTLS.exit(); } catch(e) {}
        }
    });
    app.post('/manage/:guildId/subscribe-team', checkAuth, checkGuildAdmin, async (req, res) => {
        const { teamName, channelId, live_role_id } = req.body;
        const guildId = req.params.guildId;
        try {
            if (!teamName || !channelId) throw new Error('Team name and channel ID are required.');
            
            await db.execute(
                `INSERT INTO twitch_teams (guild_id, announcement_channel_id, team_name, live_role_id) 
                 VALUES (?, ?, ?, ?) 
                 ON DUPLICATE KEY UPDATE team_name = VALUES(team_name), live_role_id = VALUES(live_role_id)`, 
                [guildId, channelId, teamName.toLowerCase(), live_role_id || null]
            );

            res.redirect(`/manage/${guildId}?success=teamsubscribed`);
        } catch (e) {
            console.error('[Dashboard Subscribe Team Error]', e);
            res.redirect(`/manage/${guildId}?error=${encodeURIComponent(`Failed to subscribe to team: ${e.message}`)}`);
        }
    });
    app.post('/manage/:guildId/unsubscribe-team', checkAuth, checkGuildAdmin, async (req, res) => {
        const { teamSubscriptionId } = req.body;
        const guildId = req.params.guildId;
        try {
            if (!teamSubscriptionId) throw new Error('Subscription ID is missing.');
            await db.execute('DELETE FROM twitch_teams WHERE id = ? AND guild_id = ?', [teamSubscriptionId, guildId]);
            res.redirect(`/manage/${guildId}?success=teamunsubscribed`);
        } catch (e) {
            console.error('[Dashboard Unsubscribe Team Error]', e);
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent(`Failed to unsubscribe from team: ${e.message}`)}`);
        }
    });
    app.post('/manage/:guildId/removeteam', checkAuth, checkGuildAdmin, async (req, res) => {
        const { teamSubscriptionId } = req.body; 
        const guildId = req.params.guildId;
        try {
            if (!teamSubscriptionId) throw new Error('Subscription ID is missing.');
            const [[teamSub]] = await db.execute('SELECT * FROM twitch_teams WHERE id = ? AND guild_id = ?', [teamSubscriptionId, guildId]);
            if (!teamSub) throw new Error('Team subscription not found or you do not have permission to remove it.');
            await db.execute('DELETE FROM twitch_teams WHERE id = ? AND guild_id = ?', [teamSubscriptionId, guildId]);
    
            const teamMembers = await apiChecks.getTwitchTeamMembers(teamSub.team_name);
            if (teamMembers && teamMembers.length > 0) {
                const memberUserIds = teamMembers.map(m => m.user_id);
                const placeholders = memberUserIds.map(() => '?').join(',');
                const [streamers] = await db.execute(`SELECT streamer_id FROM streamers WHERE platform = 'twitch' AND platform_user_id IN (${placeholders})`, [...memberUserIds]);
    
                if (streamers.length > 0) {
                    const streamerIdsToRemove = streamers.map(s => s.streamer_id);
                    const subPlaceholders = streamerIdsToRemove.map(() => '?').join(',');
                    
                    const [announcementsToPurge] = await db.execute(
                        `SELECT message_id, channel_id FROM announcements WHERE guild_id = ? AND channel_id = ? AND streamer_id IN (${subPlaceholders})`,
                        [guildId, teamSub.announcement_channel_id, ...streamerIdsToRemove]
                    );
    
                    if (announcementsToPurge.length > 0) {
                        const purgePromises = announcementsToPurge.map(ann => 
                            client.channels.fetch(ann.channel_id)
                                .then(channel => channel?.messages.delete(ann.message_id))
                                .catch(() => {})
                        );
                        await Promise.allSettled(purgePromises);
                    }
                    
                    await db.execute(`DELETE FROM subscriptions WHERE guild_id = ? AND announcement_channel_id = ? AND streamer_id IN (${subPlaceholders})`, [guildId, teamSub.announcement_channel_id, ...streamerIdsToRemove]);
                }
            }
            res.redirect(`/manage/${guildId}?success=removeteam`);
        } catch (e) {
            console.error('Dashboard Remove Team Error:', e);
            res.redirect(`/manage/${guildId}?error=${encodeURIComponent(`Failed to remove team members: ${e.message}`)}`);
        }
    });
    app.post('/manage/:guildId/clear', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            await db.execute('DELETE FROM subscriptions WHERE guild_id = ?', [req.params.guildId]);
            res.redirect(`/manage/${req.params.guildId}?success=clear`);
        } catch (e) {
            console.error('[Dashboard Clear Subscriptions Error]', e);
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent('Failed to clear subscriptions.')}`);
        }
    });
    app.get('/manage/:guildId/export', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const [subscriptions] = await db.execute(`SELECT s.platform, s.username, s.discord_user_id, sub.custom_message, sub.override_nickname, sub.override_avatar_url, sub.announcement_channel_id FROM streamers s JOIN subscriptions sub ON s.streamer_id = s.streamer_id WHERE sub.guild_id = ?`, [req.params.guildId]);
            if (subscriptions.length === 0) { return res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent('No streamers to export.')}`); }
            const csv = Papa.unparse(subscriptions, { header: true });
            res.header('Content-Type', 'text/csv');
            res.attachment(`streamers_export_${req.params.guildId}.csv`);
            res.send(csv);
        } catch (e) { console.error("[Dashboard Export Error]", e); res.status(500).send("Error generating CSV file."); }
    });
    app.post('/manage/:guildId/import', checkAuth, checkGuildAdmin, upload.single('csvfile'), async (req, res) => {
        let tempFilePath = null;
        let browser = null; 
        try {
            if (!req.file) throw new Error("No CSV file was uploaded.");
            tempFilePath = path.resolve(req.file.path);
            const csvFileContent = await fs.promises.readFile(tempFilePath, 'utf8');
            const { data, errors } = Papa.parse(csvFileContent, { header: true, skipEmptyLines: true });
            if (errors.length > 0) { throw new Error(`CSV parsing errors: ${errors.map(e => e.message).join(', ')}`); }
            browser = await getBrowser();
            const result = await importCsvLogic({ client, guildId: req.params.guildId, csvData: data, userId: req.user.id, browser: browser });
            if (result.error) { throw new Error(result.error); }
            res.redirect(`/manage/${req.params.guildId}?success=import&report=${encodeURIComponent(result.summary || 'CSV import completed.')}`);
        } catch (e) {
            console.error("Dashboard import failed:", e);
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent(`Import failed. Please try again or contact support.`)}`);
        } finally {
            if (browser) await closeBrowser(); 
            if (tempFilePath && fs.existsSync(tempFilePath)) { fs.unlink(tempFilePath, (err) => { if (err) console.error("Error deleting temp CSV file:", err); }); }
        }
    });
    app.post('/manage/:guildId/import-team', checkAuth, checkGuildAdmin, upload.single('csvfile'), async (req, res) => {
        const { channelId: targetChannelId } = req.body;
        const guildId = req.params.guildId;
        const file = req.file;
        if (!file) return res.redirect(`/manage/${guildId}?error=${encodeURIComponent('No CSV file was uploaded.')}`);
        if (!targetChannelId) return res.redirect(`/manage/${guildId}?error=${encodeURIComponent('You must select a channel to sync.')}`);
        const added = [], updated = [], failed = [], removed = [];
        let cycleTLS = null, browser = null;
        try {
            const fileContent = fs.readFileSync(file.path, 'utf8');
            const { data: rows } = Papa.parse(fileContent, { header: true, skipEmptyLines: true });
            if (!rows.length) throw new Error('CSV file is empty or invalid.');
            const [existingSubsInChannel] = await db.execute('SELECT s.streamer_id, s.username FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? AND sub.announcement_channel_id = ?', [guildId, targetChannelId]);
            const dbStreamerMap = new Map(existingSubsInChannel.map(sub => [sub.streamer_id, sub.username]));
            const csvStreamerIds = new Set();
            if (rows.some(r => r.platform === 'kick')) cycleTLS = await initCycleTLS();
            if (rows.some(r => ['tiktok', 'youtube', 'trovo'].includes(r.platform))) browser = await getBrowser();
            for (const row of rows) {
                const { platform, username, discord_user_id, custom_message, override_nickname, override_avatar_url } = row;
                if (!platform || !username) { failed.push(`(Skipped: missing platform/username)`); continue; }
                const correctedDiscordId = /^[0-9]+$/.test(discord_user_id) ? discord_user_id : null;
                try {
                    let streamerInfo = null;
                    const [[existingStreamer]] = await db.execute('SELECT streamer_id, platform_user_id FROM streamers WHERE platform = ? AND LOWER(username) = LOWER(?)', [platform, username]);
                    if (existingStreamer) {
                        streamerInfo = { id: existingStreamer.streamer_id, puid: existingStreamer.platform_user_id, dbUsername: username };
                    } else {
                        let apiResult;
                        if (platform === 'twitch') { apiResult = await apiChecks.getTwitchUser(username); if(apiResult) streamerInfo = { puid: apiResult.id, dbUsername: apiResult.login }; } 
                        else if (platform === 'kick' && cycleTLS) { apiResult = await apiChecks.getKickUser(cycleTLS, username); if(apiResult) streamerInfo = { puid: apiResult.id.toString(), dbUsername: apiResult.user.username }; }
                        else if (platform === 'youtube') { apiResult = await apiChecks.getYouTubeChannelId(username); if(apiResult) streamerInfo = { puid: apiResult, dbUsername: username }; }
                        else if (['tiktok', 'trovo'].includes(platform)) { streamerInfo = { puid: username, dbUsername: username }; }
                        if (!streamerInfo) { failed.push(`${username} (API Not Found)`); continue; }
                    }
                    const [result] = await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, discord_user_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), discord_user_id=VALUES(discord_user_id)`, [platform, streamerInfo.puid, streamerInfo.dbUsername, correctedDiscordId]);
                    const streamerId = result.insertId || streamerInfo.id;
                    csvStreamerIds.add(streamerId);
                    const [subResult] = await db.execute(`INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, custom_message, override_nickname, override_avatar_url) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE custom_message=VALUES(custom_message), override_nickname=VALUES(override_nickname), override_avatar_url=VALUES(override_avatar_url)`, [guildId, streamerId, targetChannelId, custom_message || null, override_nickname || null, override_avatar_url || null]);
                    subResult.affectedRows > 1 ? updated.push(username) : added.push(username);
                } catch (err) { console.error(`Team CSV Row Error for ${username}:`, err); failed.push(`${username} (Error)`); }
            }
            const idsToRemove = [];
            for (const [streamerId, streamerUsername] of dbStreamerMap.entries()) {
                if (!csvStreamerIds.has(streamerId)) { idsToRemove.push(streamerId); removed.push(streamerUsername); }
            }
            if (idsToRemove.length > 0) {
                const placeholders = idsToRemove.map(() => '?').join(',');
                await db.execute(`DELETE FROM subscriptions WHERE guild_id = ? AND announcement_channel_id = ? AND streamer_id IN (${placeholders})`, [guildId, targetChannelId, ...idsToRemove]);
            }
            const summary = `Added: ${added.length}, Updated: ${updated.length}, Removed: ${removed.length}, Failed: ${failed.length}.`;
            res.redirect(`/manage/${guildId}?success=teamsync&report=${encodeURIComponent(summary)}`);
        } catch (e) {
            console.error("Dashboard team import failed:", e);
            res.redirect(`/manage/${guildId}?error=${encodeURIComponent(`Team sync failed: ${e.message}`)}`);
        } finally {
            if (cycleTLS) try { cycleTLS.exit(); } catch(e){} 
            if (browser) await closeBrowser();
            if (file?.path) fs.unlink(file.path, (err) => { if (err) console.error("Error deleting temp CSV file:", err); });
        }
    });
    
    app.use((req, res) => {
        res.status(404).render('error', { user: req.user, error: 'Page Not Found' });
    });

    app.listen(port, () => console.log(`[Dashboard] Web dashboard listening on port ${port}`));
}

module.exports = { start };