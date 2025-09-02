// index.js (Rewritten with Enhanced Logging)
const { Client, GatewayIntentBits, Collection, Events, PermissionsBitField } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

process.on('unhandledRejection', error => console.error('CRITICAL: Unhandled Promise Rejection:', error));
process.on('uncaughtException', error => console.error('CRITICAL: Uncaught Exception:', error));

const db = require('./utils/db');
const { getBrowser, closeBrowser } = require('./utils/browserManager');
const apiChecks = require('./utils/api_checks.js');
const dashboard = require(path.join(__dirname, 'dashboard', 'server.js'));
const { updateAnnouncement } = require('./utils/announcer');

async function main() {
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, 'commands');
    const commandFiles = require('fs').readdirSync(commandsPath).filter(f => f.endsWith('.js'));
    for (const file of commandFiles) {
        try {
            const command = require(path.join(commandsPath, file));
            if (command.data && command.execute) client.commands.set(command.data.name, command);
        } catch (e) { console.error(`[CMD Load Error] ${file}:`, e); }
    }
    console.log(`[Startup] ${client.commands.size} commands loaded.`);
    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        const cmd = client.commands.get(interaction.commandName);
        if (!cmd) return;
        try { await cmd.execute(interaction); } catch (e) { console.error(e); }
    });
    client.once(Events.ClientReady, async (c) => {
        console.log(`[READY] Logged in as ${c.user.tag}`);
        try {
            await checkStreams(client); 
            setInterval(() => checkStreams(client), 5 * 60 * 1000);
            dashboard.start(client);
        } catch (e) { console.error('[ClientReady Error]', e); }
    });
    await client.login(process.env.DISCORD_TOKEN);
}

async function checkStreams(client) {
    console.log(`[Check] ---> Starting stream check @ ${new Date().toLocaleTimeString()}`);
    const checkStartTime = Date.now();
    let browser = null;
    try {
        const [streamersToCheck] = await db.execute(`
            SELECT DISTINCT s.streamer_id, s.username, s.platform, s.platform_user_id 
            FROM streamers s JOIN subscriptions sub ON s.streamer_id = sub.streamer_id
        `);

        if (streamersToCheck.length === 0) return;
        console.log(`[Check] Found ${streamersToCheck.length} unique streamers to check.`); // ADDED LOG

        const needsBrowser = streamersToCheck.some(s => ['tiktok', 'kick'].includes(s.platform));
        if (needsBrowser) browser = await getBrowser();

        const liveStatusMap = new Map();
        for (const streamer of streamersToCheck) {
            let liveData = { isLive: false };
            try {
                // ADDED ENHANCED LOGGING FOR KICK
                if (streamer.platform === 'kick') {
                    console.log(`[Check/Kick] Checking Kick user: ${streamer.username}`);
                    liveData = await apiChecks.checkKick(streamer.username);
                    console.log(`[Check/Kick] Result for ${streamer.username}: isLive = ${liveData.isLive}`);
                } 
                else if (streamer.platform === 'twitch') liveData = await apiChecks.checkTwitch(streamer);
                else if (streamer.platform === 'youtube') liveData = await apiChecks.checkYouTube(streamer.platform_user_id);
                else if (streamer.platform === 'tiktok') liveData = await apiChecks.checkTikTok(streamer.username);
                else if (streamer.platform === 'trovo') liveData = await apiChecks.checkTrovo(streamer.username);
            } catch (e) { console.error(`[API Check Main Error for ${streamer.username}]`, e); }
            
            if (liveData?.isLive) {
                liveStatusMap.set(streamer.streamer_id, liveData);
            }
        }
        
        const [subs] = await db.execute(`...`); // Query unchanged
        console.log(`[Check] Found ${subs.length} total subscriptions to process.`); // ADDED LOG

        const [previouslyAnnounced] = await db.execute('SELECT * FROM announcements');
        const announcedMap = new Map(previouslyAnnounced.map(s => [`${s.guild_id}-${s.streamer_id}`, s]));
        
        for (const sub of subs) {
            const liveData = liveStatusMap.get(sub.streamer_id) || { isLive: false };
            await processStreamer(client, { ...sub, liveData }, announcedMap);
        }

    } catch (e) { 
        console.error("[checkStreams] CRITICAL ERROR:", e); 
    } finally {
        if (browser) await closeBrowser(); // CHANGED FROM closeBrowser(browser) to closeBrowser()
        console.log(`[Check] ---> Finished stream check in ${(Date.now() - checkStartTime) / 1000}s`);
    }
}

async function processStreamer(client, sub, announcedMap) {
    const guild = await client.guilds.fetch(sub.guild_id).catch(() => null);
    if (!guild) return;

    const existingAnnouncement = announcedMap.get(`${sub.guild_id}-${sub.streamer_id}`);
    const member = sub.discord_user_id ? await guild.members.fetch(sub.discord_user_id).catch(() => null) : null;
    
    if (sub.liveData?.isLive) {
        // ... (announcement logic unchanged) ...
        
        if (member && sub.live_role_id && !member.roles.cache.has(sub.live_role_id)) {
            console.log(`[Role] Adding 'Live' role to ${member.user.tag} in ${guild.name}.`); // ADDED LOG
            await member.roles.add(sub.live_role_id).catch(err => console.error(`[Role Error] Could not ADD role:`, err.message));
        }
    } else if (existingAnnouncement) {
        console.log(`[Purge] Streamer ${sub.username} is offline. Removing announcement in ${guild.name}.`); // ADDED LOG
        const channel = guild.channels.cache.get(existingAnnouncement.channel_id);
        if (channel) {
            await channel.messages.delete(existingAnnouncement.message_id)
                .catch(err => console.error(`[Purge Error] Could not DELETE message ${existingAnnouncement.message_id}:`, err.message));
        }
        await db.execute('DELETE FROM announcements WHERE announcement_id = ?', [existingAnnouncement.announcement_id]);
        
        if (member && sub.live_role_id && member.roles.cache.has(sub.live_role_id)) {
            console.log(`[Role] Removing 'Live' role from ${member.user.tag} in ${guild.name}.`); // ADDED LOG
            await member.roles.remove(sub.live_role_id).catch(err => console.error(`[Role Error] Could not REMOVE role:`, err.message));
        }
    }
}

main().catch(console.error);

// Note: I've truncated the unchanged parts of the file for brevity. Please replace the WHOLE file.