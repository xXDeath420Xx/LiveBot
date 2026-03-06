#!/usr/bin/env node
/**
 * One-time script: Clone two channels in Insomniac Crew (538201414367707137),
 * copy pinned messages and recent content, update all DB references, delete originals.
 *
 * Channels:
 *   870231634715213824 — has 1 subscription
 *   875775051885064223 — default announcement channel, 4 subscriptions + guild config
 *
 * Usage: node scripts/clone-channels-insomniac.js
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';
import { Client, GatewayIntentBits } from 'discord.js';

const GUILD_ID = '538201414367707137';
const CHANNELS_TO_CLONE = [
    '870231634715213824',
    '875775051885064223',
];

async function main() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    // Get Steve's token
    const [bots] = await pool.execute(
        'SELECT bot_id, bot_token FROM custom_bots WHERE bot_id IN (SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ?)',
        [GUILD_ID]
    );
    const bot = bots[0];
    console.log(`Using bot ${bot.bot_id}`);

    const encMod = await import('../utils/encryption.js');
    const encryption = encMod.default;
    let token;
    try {
        const parsed = JSON.parse(bot.bot_token);
        token = encryption.decrypt(parsed);
    } catch {
        token = bot.bot_token;
    }

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });

    await client.login(token);
    await new Promise(resolve => client.once('ready', resolve));
    console.log(`Logged in as ${client.user.tag}`);

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) { console.error('Guild not found'); process.exit(1); }

    const results = [];

    for (const oldChannelId of CHANNELS_TO_CLONE) {
        console.log(`\n--- Processing channel ${oldChannelId} ---`);

        const oldChannel = await guild.channels.fetch(oldChannelId).catch(() => null);
        if (!oldChannel) {
            console.error(`Channel ${oldChannelId} not found, skipping`);
            continue;
        }
        console.log(`Old channel: #${oldChannel.name} (pos: ${oldChannel.position}, parent: ${oldChannel.parentId})`);

        // Fetch pinned messages
        const pinnedMessages = await oldChannel.messages.fetchPinned().catch(() => null);
        console.log(`Pinned messages: ${pinnedMessages?.size || 0}`);

        // Fetch last 10 messages to check for any panels/embeds worth preserving
        const recentMessages = await oldChannel.messages.fetch({ limit: 10 }).catch(() => null);
        const messagesWithContent = recentMessages?.filter(m => m.embeds.length > 0 || m.components.length > 0 || m.content) || [];
        console.log(`Recent messages with content/embeds: ${messagesWithContent.size}`);

        // Clone the channel
        const newChannel = await oldChannel.clone({
            reason: 'Channel cleanup: recreating to clear old messages'
        });
        console.log(`New channel created: ${newChannel.id} (#${newChannel.name})`);

        await newChannel.setPosition(oldChannel.position).catch(() => {});

        // Copy pinned messages (in reverse order so oldest pin is first)
        const pinnedArray = pinnedMessages ? Array.from(pinnedMessages.values()).reverse() : [];
        for (const pin of pinnedArray) {
            const payload = {};
            if (pin.content) payload.content = pin.content;
            if (pin.embeds.length > 0) payload.embeds = pin.embeds;
            if (pin.components.length > 0) payload.components = pin.components;
            if (pin.attachments.size > 0) {
                payload.files = Array.from(pin.attachments.values()).map(a => ({
                    attachment: a.url,
                    name: a.name
                }));
            }

            if (Object.keys(payload).length > 0) {
                const newMsg = await newChannel.send(payload);
                await newMsg.pin().catch(() => {});
                console.log(`  Copied & pinned message (${pin.id})`);
            }
        }

        // Copy recent bot messages with embeds/components (panels, etc.) that weren't pinned
        const pinnedIds = new Set(pinnedArray.map(p => p.id));
        const botMessages = messagesWithContent.filter(m => m.author.bot && !pinnedIds.has(m.id));
        const botMsgArray = Array.from(botMessages.values()).reverse();
        for (const msg of botMsgArray) {
            const payload = {};
            if (msg.content) payload.content = msg.content;
            if (msg.embeds.length > 0) payload.embeds = msg.embeds;
            if (msg.components.length > 0) payload.components = msg.components;
            if (Object.keys(payload).length > 0) {
                await newChannel.send(payload);
                console.log(`  Copied bot message (${msg.id})`);
            }
        }

        // Update all DB references
        let dbUpdates = 0;

        // guilds table
        const [g1] = await pool.execute(
            'UPDATE guilds SET announcement_channel_id = ? WHERE guild_id = ? AND announcement_channel_id = ?',
            [newChannel.id, GUILD_ID, oldChannelId]
        );
        if (g1.affectedRows) { dbUpdates += g1.affectedRows; console.log(`  Updated guilds.announcement_channel_id`); }

        // guild_config table
        const [g2] = await pool.execute(
            'UPDATE guild_config SET announcement_channel_id = ? WHERE guild_id = ? AND announcement_channel_id = ?',
            [newChannel.id, GUILD_ID, oldChannelId]
        );
        if (g2.affectedRows) { dbUpdates += g2.affectedRows; console.log(`  Updated guild_config.announcement_channel_id`); }

        // subscriptions table
        const [g3] = await pool.execute(
            'UPDATE subscriptions SET announcement_channel_id = ? WHERE guild_id = ? AND announcement_channel_id = ?',
            [newChannel.id, GUILD_ID, oldChannelId]
        );
        if (g3.affectedRows) { dbUpdates += g3.affectedRows; console.log(`  Updated ${g3.affectedRows} subscription(s)`); }

        // live_announcements table
        const [g4] = await pool.execute(
            'UPDATE live_announcements SET channel_id = ? WHERE guild_id = ? AND channel_id = ?',
            [newChannel.id, GUILD_ID, oldChannelId]
        );
        if (g4.affectedRows) { dbUpdates += g4.affectedRows; console.log(`  Updated ${g4.affectedRows} live_announcement(s)`); }

        // welcome_settings
        const [g5] = await pool.execute(
            'UPDATE welcome_settings SET channel_id = ? WHERE guild_id = ? AND channel_id = ?',
            [newChannel.id, GUILD_ID, oldChannelId]
        );
        if (g5.affectedRows) { dbUpdates += g5.affectedRows; console.log(`  Updated welcome_settings`); }

        // log_config
        const [g6] = await pool.execute(
            'UPDATE log_config SET log_channel_id = ? WHERE guild_id = ? AND log_channel_id = ?',
            [newChannel.id, GUILD_ID, oldChannelId]
        );
        if (g6.affectedRows) { dbUpdates += g6.affectedRows; console.log(`  Updated log_config`); }

        // auto_delete_channels
        const [g7] = await pool.execute(
            'UPDATE auto_delete_channels SET channel_id = ? WHERE guild_id = ? AND channel_id = ?',
            [newChannel.id, GUILD_ID, oldChannelId]
        );
        if (g7.affectedRows) { dbUpdates += g7.affectedRows; console.log(`  Updated auto_delete_channels`); }

        // reaction_role_panels
        const [g8] = await pool.execute(
            'UPDATE reaction_role_panels SET channel_id = ? WHERE guild_id = ? AND channel_id = ?',
            [newChannel.id, GUILD_ID, oldChannelId]
        );
        if (g8.affectedRows) { dbUpdates += g8.affectedRows; console.log(`  Updated ${g8.affectedRows} reaction_role_panel(s)`); }

        console.log(`  Total DB updates: ${dbUpdates}`);

        // Delete old channel
        await oldChannel.delete('Channel cleanup: replaced with clean clone');
        console.log(`  Deleted old channel ${oldChannelId}`);

        results.push({
            old: oldChannelId,
            new: newChannel.id,
            name: newChannel.name,
            dbUpdates
        });
    }

    console.log('\n=== Summary ===');
    for (const r of results) {
        console.log(`#${r.name}: ${r.old} → ${r.new} (${r.dbUpdates} DB updates)`);
    }

    await pool.end();
    client.destroy();
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
