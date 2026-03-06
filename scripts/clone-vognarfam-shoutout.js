/**
 * Clone VognarFam shoutout channel (902709348139167784):
 * 1. Clone the channel (preserves name, topic, permissions, position)
 * 2. Update all subscriptions to point to new channel
 * 3. Update community_support_config shoutout_channel_id
 * 4. Delete old channel
 */
import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '902393911958470717';
const BOT_ID = '1476040458680406214';
const OLD_CHANNEL_ID = '902709348139167784';

async function run() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    if (!bots.length) { console.error('Bot not found'); process.exit(1); }
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });

    await client.login(token);
    await new Promise(r => client.once('ready', r));
    console.log(`Logged in as ${client.user.tag}`);

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) { console.error('Guild not found'); process.exit(1); }

    // Fetch old channel
    const oldChannel = await guild.channels.fetch(OLD_CHANNEL_ID);
    if (!oldChannel) { console.error('Old channel not found'); process.exit(1); }
    console.log(`Old channel: #${oldChannel.name} (pos: ${oldChannel.position}, parent: ${oldChannel.parentId})`);

    // Clone the channel
    const newChannel = await oldChannel.clone({
        reason: 'Shoutout channel cleanup: recreating clean channel for auto-shoutout system'
    });
    console.log(`New channel created: #${newChannel.name} (${newChannel.id})`);

    // Move to same position
    await newChannel.setPosition(oldChannel.position).catch(() => {});

    // Update all subscriptions pointing to old channel for this guild
    const [subResult] = await pool.execute(
        'UPDATE subscriptions SET announcement_channel_id = ? WHERE guild_id = ? AND announcement_channel_id = ?',
        [newChannel.id, GUILD_ID, OLD_CHANNEL_ID]
    );
    console.log(`Updated ${subResult.affectedRows} subscriptions -> ${newChannel.id}`);

    // Update community_support_config
    const [cscResult] = await pool.execute(
        'UPDATE community_support_config SET shoutout_channel_id = ? WHERE guild_id = ? AND shoutout_channel_id = ?',
        [newChannel.id, GUILD_ID, OLD_CHANNEL_ID]
    );
    console.log(`Updated ${cscResult.affectedRows} community_support_config row(s)`);

    // Update guild_config if it references this channel
    const [gcResult] = await pool.execute(
        'UPDATE guild_config SET announcement_channel_id = ? WHERE guild_id = ? AND announcement_channel_id = ?',
        [newChannel.id, GUILD_ID, OLD_CHANNEL_ID]
    );
    console.log(`Updated ${gcResult.affectedRows} guild_config row(s)`);

    // Delete old channel
    await oldChannel.delete('Shoutout channel cleanup: replaced with clean channel');
    console.log(`Deleted old channel: ${OLD_CHANNEL_ID}`);

    console.log('\n========================================');
    console.log('CHANNEL CLONE COMPLETE');
    console.log('========================================');
    console.log(`Old channel: ${OLD_CHANNEL_ID} (deleted)`);
    console.log(`New channel: #${newChannel.name} (${newChannel.id})`);
    console.log('All DB references updated.');
    console.log('Restart PM2 to pick up the new channel ID in caches.');

    client.destroy();
    await pool.end();
    process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
