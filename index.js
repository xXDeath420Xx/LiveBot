const { Client, GatewayIntentBits, Collection, Partials, Events, EmbedBuilder } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const db = require('./utils/db');
const { getBrowser, closeBrowser } = require('./utils/browserManager');
const { checkTwitch, checkYouTube, checkKick, checkTikTok, checkTrovo } = require('./utils/api_checks');
const dashboard = require(path.join(__dirname, 'dashboard', 'server.js'));

// ... client and command handler setup ... (remains the same)

async function startupPurge() {
    console.log('[Purge] Starting cleanup of old state, messages, and roles...');
    try {
        const [guilds] = await db.execute('SELECT guild_id, announcement_channel_id, live_role_id FROM guilds');
        for (const guildSettings of guilds) {
            if (guildSettings.announcement_channel_id) {
                // ... message cleanup logic ... (remains the same)
            }
            if (guildSettings.live_role_id) {
                // ... role purge logic ... (remains the same)
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
        if (subs.length === 0) {
            await closeBrowser();
            return;
        }

        const liveChecks = await Promise.all(subs.map(async sub => {
             let apiResult, liveData = null;

             if (sub.platform === 'twitch') { apiResult = await checkTwitch(sub); }
             else if (sub.platform === 'kick') { apiResult = await checkKick(sub.username); } 
             else if (sub.platform === 'youtube') { apiResult = await checkYouTube(sub.platform_user_id); }
             else {
                const browser = await getBrowser();
                if (!browser) return { ...sub, isLive: false, liveData: null };
                if (sub.platform === 'tiktok') apiResult = await checkTikTok(browser, sub.username);
                else if (sub.platform === 'trovo') apiResult = await checkTrovo(browser, sub.username);
             }

             // ... data parsing logic ... (remains the same)
             
             return { ...sub, isLive:!!liveData, liveData };
        }));

        // ... announcement, role, and database update logic ... (remains the same)
        
    } catch(e){ console.error("[checkStreams] CRITICAL ERROR:", e); }
    finally { console.log(`[Check] Finished stream check @ ${new Date().toLocaleTimeString()}`); }
}

// ... client events and login ... (remains the same)