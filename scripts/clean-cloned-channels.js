#!/usr/bin/env node
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { Client, GatewayIntentBits } from 'discord.js';

const GUILD_ID = '538201414367707137';
const CHANNELS = ['1473618232760860713', '1473618263744184474'];

async function main() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    const [bots] = await pool.execute(
        'SELECT bot_id, bot_token FROM custom_bots WHERE bot_id IN (SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ?)',
        [GUILD_ID]
    );
    const encMod = await import('../utils/encryption.js');
    const encryption = encMod.default;
    let token;
    try { token = encryption.decrypt(JSON.parse(bots[0].bot_token)); } catch { token = bots[0].bot_token; }

    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
    await client.login(token);
    await new Promise(resolve => client.once('ready', resolve));
    console.log(`Logged in as ${client.user.tag}`);

    const guild = client.guilds.cache.get(GUILD_ID);

    for (const channelId of CHANNELS) {
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel) { console.log(`Channel ${channelId} not found`); continue; }

        const messages = await channel.messages.fetch({ limit: 100 });
        if (messages.size === 0) { console.log(`#${channel.name}: already empty`); continue; }

        const deleted = await channel.bulkDelete(messages, true).catch(() => null);
        console.log(`#${channel.name}: deleted ${deleted?.size || 0} messages`);
    }

    await pool.end();
    client.destroy();
    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
