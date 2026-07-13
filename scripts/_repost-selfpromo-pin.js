import dotenv from 'dotenv';
dotenv.config();
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import mysql from 'mysql2/promise';
const { default: encryption } = await import('../utils/encryption.js');

const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', ['1486807000854823155']);
const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
await client.login(token);
await new Promise(r => client.once('ready', r));

const ch = await client.channels.fetch('1485705052260663446');

const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('📣 Self-Promo — How It Works')
    .setDescription(
        '**Drop your stream link below to get auto-tracked!**\n\n' +
        'When you post your Twitch, YouTube, Kick, or TikTok channel link here, the bot will automatically:\n\n' +
        '> 🔔 **Subscribe to your stream** — live notifications when you go live\n' +
        '> 📝 **Edit your announcement** when you go offline\n' +
        '> 💬 **DM you a confirmation** when your stream is tracked\n\n' +
        '**Supported platforms:** Twitch, YouTube, Kick, TikTok, Trovo, Facebook, Instagram\n\n' +
        '**How to use:**\n' +
        '1. Paste your stream URL\n' +
        '2. Your message will be auto-deleted after processing\n' +
        '3. You\'ll get a DM confirming your stream is tracked\n' +
        '4. That\'s it! Go live and your announcement appears automatically\n\n' +
        '*Only stream links are accepted — other messages will be removed.*'
    )
    .setFooter({ text: 'Powered by CertiFried' });

const msg = await ch.send({ embeds: [embed] });
await msg.pin();
console.log('Posted and PINNED: ' + msg.id);

// Clean pin system message
const sysMsgs = await ch.messages.fetch({ limit: 5 });
for (const [, m] of sysMsgs) {
    if (m.type === 6) await m.delete().catch(() => {});
}

// Verify
const pins = await ch.messages.fetchPinned();
console.log('Pins: ' + pins.size + ', ours pinned: ' + pins.has(msg.id));

client.destroy();
await pool.end();
