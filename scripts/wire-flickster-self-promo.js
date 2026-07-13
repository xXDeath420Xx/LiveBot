/**
 * Wire-up for Flickster's House:
 *   - Confirm channel 1502814404608004288 is #self-promo and post a how-it-works embed there.
 *   - Re-point self-promo announcements + streamer auto-track to 1501760277476278442.
 *   - Lock down 1501760277476278442 so @everyone can VIEW but cannot SEND (read-only).
 */
import dotenv from 'dotenv';
dotenv.config();
import {
    Client, GatewayIntentBits, PermissionFlagsBits, EmbedBuilder,
} from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1500965606659194982';
const BOT_ID = '1502798840124670133';
const SELF_PROMO_CH = '1502814404608004288';
const LIVE_ANNOUNCE_CH = '1501760277476278442';

async function main() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages] });
    await client.login(token);
    await new Promise(r => client.once('ready', r));
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.channels.fetch();
    const log = (m) => console.log(`[Wire] ${m}`);

    const selfPromoCh = guild.channels.cache.get(SELF_PROMO_CH);
    const liveCh = guild.channels.cache.get(LIVE_ANNOUNCE_CH);
    if (!selfPromoCh) { console.error(`Channel ${SELF_PROMO_CH} not found`); process.exit(1); }
    if (!liveCh) { console.error(`Channel ${LIVE_ANNOUNCE_CH} not found`); process.exit(1); }
    log(`self-promo channel: #${selfPromoCh.name} (${selfPromoCh.id})`);
    log(`live announce channel: #${liveCh.name} (${liveCh.id})`);

    // 1. Re-point DB configs to the new live announce channel
    await pool.execute(
        `UPDATE self_promo_config SET announcement_channel_id = ?, channel_id = ? WHERE guild_id = ?`,
        [LIVE_ANNOUNCE_CH, SELF_PROMO_CH, GUILD_ID]
    );
    log('updated self_promo_config (channel_id + announcement_channel_id)');

    await pool.execute(
        `UPDATE guild_streamer_auto_track SET announcement_channel_id = ? WHERE guild_id = ?`,
        [LIVE_ANNOUNCE_CH, GUILD_ID]
    );
    log('updated guild_streamer_auto_track.announcement_channel_id');

    await pool.execute(
        `UPDATE guilds SET announcement_channel_id = ? WHERE guild_id = ?`,
        [LIVE_ANNOUNCE_CH, GUILD_ID]
    );
    log('updated guilds.announcement_channel_id');

    // 2. Lock down the live announce channel — @everyone can view, only the bot can send
    await liveCh.permissionOverwrites.edit(guild.id, {
        ViewChannel: true, ReadMessageHistory: true,
        SendMessages: false, SendMessagesInThreads: false,
        CreatePublicThreads: false, CreatePrivateThreads: false, AddReactions: false,
    }, { reason: 'Lock down live announcements to bot-only posting' });
    await liveCh.permissionOverwrites.edit(client.user.id, {
        ViewChannel: true, SendMessages: true, EmbedLinks: true, MentionEveryone: true, ManageMessages: true,
    }, { reason: 'Bot must be able to post live announcements' });
    log(`locked down #${liveCh.name} — read-only for users, bot can post`);

    // 3. Post self-promo how-it-works embed
    const allowed = JSON.stringify(['twitch','kick','youtube','tiktok']);
    const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('📢 How Self-Promo Works')
        .setDescription([
            `Drop your **stream or social link** in this channel — the bot does the rest.`,
            ``,
            `**What you get:**`,
            `• Your link is added to the auto-tracker.`,
            `• When you go live, an announcement posts in <#${LIVE_ANNOUNCE_CH}>.`,
            `• Click **🔔 Stream Pings** in <#${guild.channels.cache.find(c => c.name === 'roles')?.id || ''}> to get pinged when streamers go live.`,
        ].join('\n'))
        .addFields(
            { name: '✅ Allowed platforms', value: 'Twitch · Kick · YouTube · TikTok', inline: false },
            { name: '🔗 What to post', value: 'Just paste the URL. Examples:\n`https://twitch.tv/yourname`\n`https://youtube.com/@yourchannel`\n`https://kick.com/yourname`\n`https://tiktok.com/@yourname`', inline: false },
            { name: '🚫 What gets removed', value: '• Random text without a link\n• Unsupported platforms\n• Duplicate posts (already tracked)', inline: false },
            { name: '🤖 DMs', value: 'The bot will DM you to confirm tracking. If you have DMs disabled, your post may still be tracked but you won\'t get the confirmation.', inline: false },
        )
        .setFooter({ text: 'Bot announces in #' + (liveCh?.name || 'live-announcements') + ' — that channel is read-only.' });

    // Try to find an existing self-promo embed pinned by us; if present, edit it instead of posting a new one
    const recent = await selfPromoCh.messages.fetch({ limit: 50 }).catch(() => null);
    const existing = recent?.find(m => m.author?.id === client.user.id && m.embeds?.[0]?.title === '📢 How Self-Promo Works');
    if (existing) {
        await existing.edit({ embeds: [embed] });
        log(`edited existing how-it-works embed (${existing.id})`);
    } else {
        const msg = await selfPromoCh.send({ embeds: [embed] });
        await msg.pin('Self-promo instructions').catch(() => {});
        log(`posted how-it-works embed (${msg.id})`);
    }

    log(`allowed_platforms in DB: ${allowed}`);
    client.destroy();
    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
