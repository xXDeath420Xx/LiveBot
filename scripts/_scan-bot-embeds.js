import dotenv from 'dotenv';
dotenv.config();
import { Client, GatewayIntentBits } from 'discord.js';
import mysql from 'mysql2/promise';
const { default: encryption } = await import('../utils/encryption.js');

// Titles/descriptions that indicate AUTOMATED embeds (not user-created)
const AUTO_TITLE_PATTERNS = [
    /^(🗑️|📝|🔧|🔨|🔊|👤|⚙️|🎭|📁)\s/,  // Log emojis
    /channel (deleted|created|updated)/i,
    /message (deleted|edited|bulk)/i,
    /member (joined|left|updated|banned|kicked|muted|warned)/i,
    /role (created|deleted|updated|added|removed)/i,
    /voice (joined|left|moved|update)/i,
    /server updated/i, /emoji/i, /invite (created|deleted)/i,
    /level up/i, /new record/i, /counting game/i,
    /stream (started|ended|went offline)/i, /is now live/i,
    /giveaway/i, /poll/i, /suggestion #/i,
    /birthday card/i, /happy birthday/i,
    /phishing/i, /spam/i, /raid/i, /nuke/i, /timeout/i,
    /achievement unlocked/i, /nickname/i,
    /welcome to/i, /set up to do in this/i,
    /^(Narvas|Pet Lands|Rebel Galaxy|Veil of Darkness|Electrician|Isonzo|Cozy Grove|Wave Gods)/, // Free games
    /free on (epic|steam|gog|prime)/i,
];

function isAutomated(embed) {
    const title = embed.title || '';
    const desc = embed.description || '';

    // Check title patterns
    for (const pattern of AUTO_TITLE_PATTERNS) {
        if (pattern.test(title) || pattern.test(desc)) return true;
    }

    // No title AND no description = probably automated
    if (!title && (!desc || desc.length < 20)) return true;

    // Very short messages are usually automated
    if (!title && desc && desc.length < 30 && !desc.includes('\n')) return true;

    return false;
}

// Channels that are clearly automated (logs, tickets, music, free-games)
function isAutomatedChannel(channelName) {
    const name = channelName.toLowerCase();
    return /log|ticket|music-control|free-game|automod|mod-log|voice-log|server-log|channel-log|role-log|member-log|message-log/.test(name);
}

async function main() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    });

    const [customBots] = await pool.execute('SELECT bot_id, bot_name, bot_token FROM custom_bots WHERE enabled = 1 AND approved = 1');
    const [mappings] = await pool.execute('SELECT guild_id, bot_id FROM guild_bot_mapping');
    const guildBotMap = {};
    for (const m of mappings) guildBotMap[m.guild_id] = m.bot_id;

    // Also get known automated channel IDs
    const [logChannels] = await pool.execute('SELECT DISTINCT log_channel_id FROM log_event_config WHERE log_channel_id IS NOT NULL').catch(() => [[]]);
    const [freeGameChannels] = await pool.execute('SELECT discord_channel_id FROM free_games_subscriptions').catch(() => [[]]);
    const [ticketChannels] = await pool.execute('SELECT panel_channel_id FROM ticket_panels').catch(() => [[]]);
    const [musicChannels] = await pool.execute('SELECT channel_id FROM music_panels').catch(() => [[]]);

    const autoChannelIds = new Set([
        ...logChannels.map(r => r.log_channel_id),
        ...freeGameChannels.map(r => r.discord_channel_id),
        ...ticketChannels.map(r => r.panel_channel_id),
        ...musicChannels.map(r => r.channel_id),
    ].filter(Boolean));

    const botsToScan = [];
    botsToScan.push({
        id: process.env.DISCORD_CLIENT_ID,
        name: 'CertiFried Utility (default)',
        token: process.env.BOT_TOKEN,
        guilds: null,
    });

    for (const bot of customBots) {
        const assignedGuilds = mappings.filter(m => m.bot_id === bot.bot_id).map(m => m.guild_id);
        if (assignedGuilds.length === 0) continue;
        try {
            const token = encryption.decrypt(JSON.parse(bot.bot_token));
            botsToScan.push({ id: bot.bot_id, name: bot.bot_name, token, guilds: assignedGuilds });
        } catch {}
    }

    console.log(`Scanning ${botsToScan.length} bots (filtered for user-created embeds only)...\n`);

    let totalInserted = 0;

    for (const botInfo of botsToScan) {
        const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

        try {
            await client.login(botInfo.token);
            await new Promise(r => client.once('ready', r));
            console.log(`[${botInfo.name}] ${client.user.tag}`);

            const guilds = botInfo.guilds
                ? botInfo.guilds.map(id => client.guilds.cache.get(id)).filter(Boolean)
                : client.guilds.cache.filter(g => !guildBotMap[g.id]).map(g => g);

            for (const guild of guilds) {
                try {
                    await guild.channels.fetch();
                    const textChannels = guild.channels.cache.filter(c => c.isTextBased() && (c.type === 0 || c.type === 5));

                    for (const [, channel] of textChannels) {
                        // Skip known automated channels
                        if (autoChannelIds.has(channel.id)) continue;
                        if (isAutomatedChannel(channel.name)) continue;

                        try {
                            const messages = await channel.messages.fetch({ limit: 50 });
                            const botEmbedMsgs = messages.filter(m =>
                                m.author.id === client.user.id &&
                                m.embeds.length > 0 &&
                                !m.interaction
                            );

                            for (const [, msg] of botEmbedMsgs) {
                                const embed = msg.embeds[0];
                                if (!embed) continue;
                                if (isAutomated(embed)) continue;

                                // Skip if it's a known panel
                                const [existing] = await pool.execute(
                                    'SELECT 1 FROM music_panels WHERE message_id = ? UNION SELECT 1 FROM reaction_role_panels WHERE message_id = ?',
                                    [msg.id, msg.id]
                                ).catch(() => [[]]);
                                if (existing.length > 0) continue;

                                // Skip duplicates
                                const [dup] = await pool.execute('SELECT 1 FROM custom_embeds WHERE message_id = ?', [msg.id]);
                                if (dup.length > 0) continue;

                                const hexColor = embed.color ? `#${embed.color.toString(16).padStart(6, '0')}` : null;

                                await pool.execute(
                                    `INSERT INTO custom_embeds (guild_id, channel_id, message_id, title, description, color, thumbnail_url, image_url, footer_text, author_name, author_icon_url, url, created_by)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                    [guild.id, channel.id, msg.id, embed.title || null, embed.description || null,
                                     hexColor, embed.thumbnail?.url || null, embed.image?.url || null,
                                     embed.footer?.text || null, embed.author?.name || null,
                                     embed.author?.iconURL || null, embed.url || null, client.user.id]
                                );
                                totalInserted++;
                                console.log(`  [${guild.name}] #${channel.name}: "${embed.title || embed.description?.substring(0, 40) || '(embed)'}" ✅`);
                            }
                        } catch {}
                    }
                } catch {}
            }
        } catch (e) {
            console.log(`[${botInfo.name}] Failed: ${e.message}`);
        }

        client.destroy();
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`Done: ${totalInserted} user-created embeds found and saved`);
    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
