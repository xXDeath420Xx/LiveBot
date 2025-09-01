const { Client, GatewayIntentBits, Collection, Partials, Events, EmbedBuilder } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const db = require('./utils/db');
const { getBrowser, closeBrowser } = require('./utils/browserManager');
const { checkTwitch, checkYouTube, checkKick, checkTikTok, checkTrovo } = require('./utils/api_checks');
const dashboard = require(path.join(__dirname, 'dashboard', 'server.js'));

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers], partials: [Partials.GuildMember] });
client.commands = new Collection();
const commandFiles = require('fs').readdirSync(path.join(__dirname, 'commands')).filter(f => f.endsWith('.js'));
for (const file of commandFiles) { try { const cmd = require(path.join(__dirname, 'commands', file)); if (cmd.data && cmd.execute) client.commands.set(cmd.data.name, cmd); } catch (e) { console.error(`[CMD Load Error] ${file}:`, e); } }

async function startupPurge() {
    console.log('[Purge] Starting cleanup of old messages and roles...');
    // FIX: The line that deleted the announcements table on startup has been REMOVED to stop reposting spam.
    try {
        const [guilds] = await db.execute('SELECT guild_id, announcement_channel_id, live_role_id FROM guilds');
        for (const guildSettings of guilds) {
            // FIX: This section now fully cleans up the server on restart as requested.
            if (guildSettings.announcement_channel_id) {
                try {
                    const channel = await client.channels.fetch(guildSettings.announcement_channel_id);
                    if (channel?.isTextBased()) {
                        const messages = await channel.messages.fetch({ limit: 100 });
                        const toDelete = messages.filter(m => m.author.id === client.user.id);
                        if (toDelete.size > 0) { console.log(`[Purge] Deleting ${toDelete.size} old announcement message(s) from #${channel.name}.`); await channel.bulkDelete(toDelete, true).catch(() => {}); }
                    }
                } catch (e) { if (e.code !== 10003 && e.code !== 50001) console.error(`[Purge] Msg cleanup failed for Ch. ${guildSettings.announcement_channel_id}:`, e.message); }
            }
            // FIX: Forcefully remove the live role from ALL members in the guild on startup.
            if (guildSettings.live_role_id) {
                try {
                    const guild = await client.guilds.fetch(guildSettings.guild_id);
                    const role = await guild.roles.fetch(guildSettings.live_role_id);
                    if (role && role.members.size > 0) {
                        console.log(`[Purge] Force-clearing role @${role.name} from all ${role.members.size} members in ${guild.name}.`);
                        for (const member of role.members.values()) {
                             await member.roles.remove(role).catch(()=>{});
                        }
                    }
                } catch(e) { console.error(`[Purge] Role cleanup failed for G. ${guildSettings.guild_id}:`, e.message); }
            }
        }
        await db.execute('DELETE FROM announcements');
        console.log('[Purge] Internal announcement state cleared post-cleanup.');

    } catch (e) { console.error('[Purge] A critical error occurred:', e); }
    console.log('[Purge] Cleanup process finished.');
}

async function checkStreams() {
    console.log(`[Check] Starting stream check @ ${new Date().toLocaleTimeString()}`);
    try {
        const [subs] = await db.execute(`SELECT s.*, sub.guild_id, sub.custom_message, g.announcement_channel_id, g.live_role_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id=s.streamer_id LEFT JOIN guilds g ON sub.guild_id=g.guild_id WHERE g.announcement_channel_id IS NOT NULL`);
        if (subs.length === 0) return;

        const liveChecks = await Promise.all(subs.map(async sub => {
             let apiResult, liveData=null;
             if (sub.platform === 'twitch') { apiResult = await checkTwitch(sub); } 
             else {
                const browser = await getBrowser();
                if (!browser) { console.error(`[Check] Browser failed for ${sub.username}`); return { ...sub, isLive: false, liveData: null }; }
                if (sub.platform === 'youtube') apiResult = await checkYouTube(browser, sub.platform_user_id);
                else if (sub.platform === 'kick') apiResult = await checkKick(browser, sub.username);
                else if (sub.platform === 'tiktok') apiResult = await checkTikTok(browser, sub.username);
                else if (sub.platform === 'trovo') apiResult = await checkTrovo(browser, sub.username);
             }

             if (sub.platform === 'twitch' && apiResult?.[0]) { const d=apiResult[0]; liveData={username:d.user_name,url:`https://www.twitch.tv/${d.user_login}`,title:d.title,game:d.game_name,thumbnailUrl:d.thumbnail_url.replace('{width}','1280').replace('{height}','720')}; }
             else if (sub.platform === 'youtube' && apiResult?.is_live) { liveData={username:sub.username, ...apiResult}; }
             else if (sub.platform === 'kick' && apiResult?.livestream) { const d=apiResult; liveData={username:d.user.username,url:`https://kick.com/${d.user.username}`,title:d.livestream.session_title,game:d.livestream.categories?.[0]?.name,thumbnailUrl:d.livestream.thumbnail?.url}; }
             else if (sub.platform === 'tiktok' && apiResult?.is_live) { liveData={username:sub.username,url:`https://www.tiktok.com/@${sub.username}/live`,title:'Live on TikTok', game: 'N/A'}; }
             else if (sub.platform === 'trovo' && apiResult?.is_live) { liveData=apiResult; }
             return { ...sub, isLive:!!liveData, liveData };
        }));

        const [previouslyAnnounced] = await db.execute('SELECT * FROM announcements');
        const announcedUserMap = new Map(previouslyAnnounced.map(s => [`${s.guild_id}-${s.discord_user_id || `username:${s.username_key}`}`, s]));

        const liveGroup = new Map();
        liveChecks.forEach(s => { const k=`${s.guild_id}-${s.discord_user_id || `username:${s.username.toLowerCase()}`}`; if (!liveGroup.has(k)) liveGroup.set(k, { platforms: [], details: s }); if(s.isLive) liveGroup.get(k).platforms.push(s); });
        
        for (const [userKey, data] of liveGroup.entries()) {
            const existingAnnouncement = announcedUserMap.get(userKey);
            const { guild_id, discord_user_id, live_role_id, announcement_channel_id, custom_message } = data.details;
            let member;
            if (live_role_id && discord_user_id) { try { member = await client.guilds.cache.get(guild_id)?.members.fetch(discord_user_id); } catch {} }

            if (data.platforms.length > 0) {
                const primary = data.platforms[0];
                const newTitle = primary.liveData.title || "Live Stream";
                const newGame = primary.liveData.game || "N/A";
                
                const needsUpdate = !existingAnnouncement || existingAnnouncement.stream_title !== newTitle || existingAnnouncement.stream_game !== newGame;

                if (needsUpdate) {
                    const platformColors = { twitch: '#6441a5', youtube: '#ff0000', kick: '#52e252', default: '#36393f' };
                    const embed = new EmbedBuilder()
                        .setColor(platformColors[primary.platform] || platformColors.default)
                        .setAuthor({ name: `${primary.liveData.username} is now LIVE on ${primary.platform.charAt(0).toUpperCase() + primary.platform.slice(1)}!`, url: primary.liveData.url })
                        .setTitle(primary.liveData.title)
                        .setURL(primary.liveData.url)
                        .addFields({ name: 'Playing', value: newGame, inline: true })
                        .setTimestamp();
                    
                    if (primary.liveData.thumbnailUrl) { embed.setImage(`${primary.liveData.thumbnailUrl}?t=${Date.now()}`); }
                    if (data.platforms.length > 1) { const otherPlatforms = data.platforms.slice(1).map(p => `[${p.platform.charAt(0).toUpperCase() + p.platform.slice(1)}](${p.liveData.url})`).join(', '); embed.addFields({ name: 'Also streaming on', value: otherPlatforms, inline: true }); }

                    const messageContent = custom_message ? custom_message.replace(/{username}/g, primary.liveData.username).replace(/{url}/g, primary.liveData.url) : `${primary.liveData.username} is live!`;
                    
                    let message;
                    try {
                        const channel = await client.channels.fetch(announcement_channel_id);
                        if (!channel) continue;

                        if (existingAnnouncement) {
                            const existingMessage = await channel.messages.fetch(existingAnnouncement.message_id).catch(() => null);
                            if (existingMessage) {
                                message = await existingMessage.edit({ content: messageContent, embeds: [embed] });
                            } else {
                                message = await channel.send({ content: messageContent, embeds: [embed] });
                            }
                        } else {
                            message = await channel.send({ content: messageContent, embeds: [embed] });
                        }

                        if (message) {
                            await db.execute(`INSERT INTO announcements (guild_id,discord_user_id,username_key,message_id,channel_id,stream_title,stream_game) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE message_id=VALUES(message_id),stream_title=VALUES(stream_title),stream_game=VALUES(stream_game)`,[guild_id,discord_user_id,discord_user_id?null:primary.username.toLowerCase(),message.id,message.channel.id,newTitle,newGame]);
                        }
                    } catch (e) { console.error(`Failed to send/edit announcement in guild ${guild_id}:`, e.message); }
                }
                if (member && !member.roles.cache.has(live_role_id)) { await member.roles.add(live_role_id).catch(e=>console.error(`Role Add Err: ${e.message}`)); }
            } else if (existingAnnouncement) {
                console.log(`[Offline] ${data.details.username} is offline. Removing.`);
                try { const channel=await client.channels.fetch(existingAnnouncement.channel_id); await channel.messages.delete(existingAnnouncement.message_id); } catch(e){if(e.code!==10008)console.error(`Msg Del Err: ${e.message}`);}
                await db.execute('DELETE FROM announcements WHERE announcement_id = ?', [existingAnnouncement.announcement_id]);
                if (member && member.roles.cache.has(live_role_id)) { await member.roles.remove(live_role_id).catch(e=>console.error(`Role Rem Err: ${e.message}`));}
            }
        }
    } catch(e){ console.error("[checkStreams] CRITICAL ERROR:", e); }
    finally { if (process.uptime() > 300) { await closeBrowser(); } console.log(`[Check] Finished stream check @ ${new Date().toLocaleTimeString()}`); }
}

client.on(Events.InteractionCreate, async (i) => { if (!i.isChatInputCommand()) return; const cmd = client.commands.get(i.commandName); if (!cmd) return; try { await cmd.execute(i); } catch (e) { console.error(`[Interaction Err] ${i.commandName}:`, e); if (i.replied || i.deferred) { await i.followUp({ content: 'Error!', ephemeral: true }); } else { await i.reply({ content: 'Error!', ephemeral: true }); } } });

client.once(Events.ClientReady, async () => {
    console.log(`[READY] Logged in as ${client.user.tag} in ${client.guilds.cache.size} servers.`);
    
    setTimeout(async () => {
        await startupPurge();
        dashboard.start(client);
        checkStreams();
        setInterval(checkStreams, 5 * 60 * 1000);
        setInterval(async () => { await closeBrowser(); console.log("[Browser] Restarted browser instance for stability."); }, 60 * 60 * 1000);
    }, 15000);
});

client.login(process.env.DISCORD_TOKEN);