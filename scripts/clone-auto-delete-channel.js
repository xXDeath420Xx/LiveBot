#!/usr/bin/env node
/**
 * One-time script: Clone an auto-delete channel, recreate the panel message,
 * update DB references, and delete the old channel.
 *
 * This is much faster than individually deleting thousands of messages.
 *
 * Usage: node scripts/clone-auto-delete-channel.js
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';

const GUILD_ID = '538201414367707137';
const OLD_CHANNEL_ID = '1300033933685035019';
const PANEL_MESSAGE_ID = '1469990442451079289';

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

    if (bots.length === 0) {
        console.error('No custom bot found for guild', GUILD_ID);
        process.exit(1);
    }

    const bot = bots[0];
    console.log(`Using bot ${bot.bot_id}`);

    // Decrypt token
    const encMod = await import('../utils/encryption.js');
    const encryption = encMod.default;
    let token;
    try {
        const parsed = JSON.parse(bot.bot_token);
        token = encryption.decrypt(parsed);
    } catch {
        token = bot.bot_token;
    }

    // Log in
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
    if (!guild) {
        console.error('Guild not found');
        process.exit(1);
    }

    // Fetch old channel
    const oldChannel = await guild.channels.fetch(OLD_CHANNEL_ID);
    if (!oldChannel) {
        console.error('Old channel not found');
        process.exit(1);
    }
    console.log(`Old channel: #${oldChannel.name} (pos: ${oldChannel.position}, parent: ${oldChannel.parentId})`);

    // Fetch the panel message we need to preserve
    const panelMessage = await oldChannel.messages.fetch(PANEL_MESSAGE_ID).catch(() => null);
    if (!panelMessage) {
        console.error('Panel message not found!');
        process.exit(1);
    }
    console.log(`Panel message found: ${panelMessage.embeds.length} embed(s), ${panelMessage.components.length} component row(s)`);

    // Clone the channel (preserves name, topic, permissions, nsfw, rate limit, etc.)
    const newChannel = await oldChannel.clone({
        reason: 'Auto-delete channel cleanup: recreating channel to clear old messages'
    });
    console.log(`New channel created: ${newChannel.id} (#${newChannel.name})`);

    // Move new channel to same position as old channel
    await newChannel.setPosition(oldChannel.position).catch(() => {});

    // Recreate the panel message in the new channel
    const messagePayload = {};
    if (panelMessage.content) messagePayload.content = panelMessage.content;
    if (panelMessage.embeds.length > 0) messagePayload.embeds = panelMessage.embeds;
    if (panelMessage.components.length > 0) messagePayload.components = panelMessage.components;

    const newPanelMessage = await newChannel.send(messagePayload);
    console.log(`Panel message recreated: ${newPanelMessage.id}`);

    // Update auto_delete_channels with new channel and message IDs
    await pool.execute(
        'UPDATE auto_delete_channels SET channel_id = ?, after_message_id = ? WHERE guild_id = ? AND channel_id = ?',
        [newChannel.id, newPanelMessage.id, GUILD_ID, OLD_CHANNEL_ID]
    );
    console.log('DB updated: auto_delete_channels');

    // Invalidate the messageCreate cache so it reloads on next event
    // (The bot process has its own cache, but it will reload on next restart)

    // Delete the old channel
    await oldChannel.delete('Auto-delete channel cleanup: old channel with thousands of messages');
    console.log(`Old channel ${OLD_CHANNEL_ID} deleted`);

    console.log('\n=== Summary ===');
    console.log(`Old channel: ${OLD_CHANNEL_ID} (deleted)`);
    console.log(`New channel: ${newChannel.id}`);
    console.log(`New panel message: ${newPanelMessage.id}`);
    console.log(`Auto-delete threshold updated to message ${newPanelMessage.id}`);

    await pool.end();
    client.destroy();
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
