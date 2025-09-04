const { Client, GatewayIntentBits, Collection, Events } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const initCycleTLS = require('cycletls');

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
        try { await cmd.execute(interaction); } catch (e) { console.error(`Interaction Error:`, e); }
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
    let cycleTLS = null;
    try {
        const [streamersToCheck] = await db.execute(`SELECT DISTINCT s.streamer_id, s.username, s.platform, s.platform_user_id FROM streamers s JOIN subscriptions sub ON s.streamer_id = sub.streamer_id`);
        if (streamersToCheck.length === 0) return;
        console.log(`[Check] Found ${streamersToCheck.length} unique streamers to check.`);
        
        const needsBrowser = streamersToCheck.some(s => s.platform === 'tiktok');
        if (needsBrowser) browser = await getBrowser();

        const kickStreamers = streamersToCheck.filter(s => s.platform === 'kick');
        if (kickStreamers.length > 0) cycleTLS = await initCycleTLS({ timeout: 60000 });
        
        const liveStatusMap = new Map();
        for (const streamer of streamersToCheck) {
            let liveData = { isLive: false };
            try {
                if (streamer.platform === 'kick') liveData = await apiChecks.checkKick(cycleTLS, streamer.username);
                else if (streamer.platform === 'twitch') liveData = await apiChecks.checkTwitch(streamer);
                else if (streamer.platform === 'youtube') liveData = await apiChecks.checkYouTube(streamer.platform_user_id);
                else if (streamer.platform === 'tiktok') liveData = await apiChecks.checkTikTok(streamer.username);
                else if (streamer.platform === 'trovo') liveData = await apiChecks.checkTrovo(streamer.username);
            } catch (e) { console.error(`[API Check Error for ${streamer.username}]`, e); }
            if (liveData?.isLive) liveStatusMap.set(streamer.streamer_id, liveData);
        }
        
        const [subs] = await db.execute(`SELECT sub.guild_id, sub.streamer_id, sub.custom_message, sub.announcement_channel_id as sub_channel_id, s.username, s.platform, s.discord_user_id, g.announcement_channel_id as guild_channel_id, g.live_role_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id LEFT JOIN guilds g ON sub.guild_id = g.guild_id`);
        console.log(`[Check] Found ${subs.length} total subscriptions to process.`);
        
        const [previouslyAnnounced] = await db.execute('SELECT * FROM announcements');
        const announcedMap = new Map(previouslyAnnounced.map(s => [`${s.guild_id}-${s.streamer_id}`, s]));
        
        for (const sub of subs) {
            const liveData = liveStatusMap.get(sub.streamer_id) || { isLive: false };
            await processStreamer(client, { ...sub, liveData }, announcedMap);
        }
    } catch (e) { console.error("[checkStreams] CRITICAL ERROR:", e); }
    finally {
        if (browser) await closeBrowser();
        if (cycleTLS) cycleTLS.exit();
        console.log(`[Check] ---> Finished stream check in ${(Date.now() - checkStartTime) / 1000}s`);
    }
}

async function processStreamer(client, sub, announcedMap) {
    const channelId = sub.sub_channel_id || sub.guild_channel_id;
    if (!channelId) return;

    const guild = await client.guilds.fetch(sub.guild_id).catch(() => null);
    if (!guild) return;

    const announcementKey = `${sub.guild_id}-${sub.streamer_id}`;
    const existingAnnouncement = announcedMap.get(announcementKey);
    const member = sub.discord_user_id ? await guild.members.fetch(sub.discord_user_id).catch(() => null) : null;
    
    if (sub.liveData?.isLive) {
        const sentMessage = await updateAnnouncement(client, [{ ...sub, liveData: sub.liveData, announcement_channel_id: channelId }], existingAnnouncement);
        if (sentMessage) {
            if (!existingAnnouncement) {
                await db.execute(`INSERT INTO announcements (guild_id, streamer_id, message_id, channel_id, stream_game, stream_title) VALUES (?, ?, ?, ?, ?, ?)`,[sub.guild_id, sub.streamer_id, sentMessage.id, sentMessage.channel.id, sub.liveData.game, sub.liveData.title]);
            } else {
                 await db.execute(`UPDATE announcements SET stream_game = ?, stream_title = ? WHERE announcement_id = ?`,[sub.liveData.game, sub.liveData.title, existingAnnouncement.announcement_id]);
            }
        }
        if (member && sub.live_role_id && !member.roles.cache.has(sub.live_role_id)) {
            await member.roles.add(sub.live_role_id).catch(err => {});
        }
    } else if (existingAnnouncement) {
        const channel = guild.channels.cache.get(existingAnnouncement.channel_id);
        if (channel) await channel.messages.delete(existingAnnouncement.message_id).catch(err => {});
        await db.execute('DELETE FROM announcements WHERE announcement_id = ?', [existingAnnouncement.announcement_id]);
        if (member && sub.live_role_id && member.roles.cache.has(sub.live_role_id)) {
            await member.roles.remove(sub.live_role_id).catch(err => {});
        }
    }
}
main().catch(console.error);